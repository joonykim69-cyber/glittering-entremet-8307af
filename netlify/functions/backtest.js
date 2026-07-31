// netlify/functions/backtest.js
// 과거 학습 4단계 — "walk-forward 백테스트 하니스" (3단계 성장 곡선 + 모델 비교).
//
// 목적: 마스킹 수집한 개찰 이력으로, 엔진이 "학습할수록 좋아지는지"를
//   훔쳐보기 0의 정직한 시험으로 측정한다. 확장 창(expanding window)으로
//   학습 구간을 늘려 가며 그 **직후** 달을 예측·채점한다(자기/미래 낙찰가 누수 0).
//
// 단계는 수집 범위를 따라간다(2026-07-31): 예전엔 STAGES가 2026년 1~6월로 하드코딩돼
//   있어, collect-backfill이 2025년까지 범위를 넓혀도 이 하니스는 6개월만 돌았다. 이제
//   `hist/feat/*` 창 키에서 온전한 달을 읽어 lib/histrange가 단계를 만든다 — 절단점이
//   N의 1/6·1/2·5/6이라 **N=6이면 기존과 정확히 같은 1월/1~3월/1~5월 학습**이고,
//   범위가 18개월로 늘면 3·9·15개월 학습으로 자동으로 함께 늘어난다.
//
// 한 실행 = 한 달: 학습 구간이 길어지면 한 번에 수십 MB의 창 블롭을 읽게 되어 30초
//   한도를 넘는다. 그래서 학습은 **달 단위로 누적**한다(`bt/_acc`) — 단계들의 학습 구간이
//   서로 포함 관계(m1..c1 ⊂ m1..c2 ⊂ m1..c3)라, 누적기를 이어 쓰면 각 실행은 새로 늘어난
//   한 달만 읽으면 된다. 범위가 아무리 길어져도 실행당 작업량은 일정하다.
//
// 모델 비교 — 레지스트리 구조(2026-07-26, AIOS 모듈 원칙): 아래 MODELS 배열에 후보를
//   등록하면 같은 물건을 모든 모델로 나란히 채점한다. 새 모델 추가 = 등록 한 줄 + BT_VERSION 범프.
//   v0.5 = 최저가 × 낙찰가율 분위수(p10~p90) — 단일 앵커(기존 챌린저, 기준선).
//   v0.6 = 두 앵커 중심 + 밴드 p05~p95(넓힘) — **기각(2026-07-23)**: 적중률 상승이 밴드
//          1.7배 확대의 결과였고 오차 악화("넓혀서 맞히기" 금지 위반). 레지스트리에서 제외.
//   v0.7 = v0.5와 같은 공식(폭 확대 없음)에 **저가율(최저가/감정가) 조건 셀(L4)** 을 최상위에
//          추가 — 같은 회차라도 유찰 깎임 깊이·신탁(최저가≥감정가) 여부로 낙찰가율 분포가
//          달라지는 것을 셀 세분화로 흡수하려 한 시도.
//          **기각(2026-07-26 실데이터 백테스트)**: 저가율이 실데이터에선 이미 회차·가격대와
//          상관되어(유찰→최저가 깎임), L4 분리는 새 신호를 더하지 못하고 표본만 얇게 쪼개
//          분위수 노이즈를 키웠다 — 3단계 모두 적중률 0.6~1.3%p 하락. v0.5 유지. L4 관련
//          코드(discBand/keysForV07)는 차기 모델 설계 참고용으로 남겨두되 MODELS 비교 기록은
//          bt/summary에 보존(랩 페이지 정직한 열화 기록).
//
// 마스킹 보장: 예측은 **train 범위 셀(과거)** 과 물건의 **개찰 전 값(최저가·감정가)** 만
//   사용. 테스트 물건의 낙찰가는 채점 시점에만 hist/win에서 꺼내며, 예측 함수 입력에
//   win 필드가 없다(코드 구조로 훔쳐보기 차단).
//
// 라이브 불변: 결과는 bt/* 네임스페이스에만 쓴다(pred/predb/agg/scoreboard 무관).
//
// 실행: 일반 함수(30초). 학습은 달 단위 누적(한 실행 = 한 달), 그 뒤 score 1회로 재개(bt/_state).
//   BT_VERSION이나 **수집 범위**가 바뀌면 자동 초기화·재실행. backfill 완료 전 no-op, 완료 후 no-op.
//   ?status=1 진행 조회(파생된 범위·단계 계획 포함) / ?reset=1&confirm=1 초기화.

const GB = require('./lib/gbtree'); // 차세대 v0.8 — 순수 JS 분위수 그래디언트 부스팅
const HR = require('./lib/histrange'); // 수집 범위 → 온전한 달 → 단계 계획

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const MIN_N = 20;              // 챌린저 셀 자격 최소 표본 (라이브와 동일)
const BT_VERSION = 'v6-autorange'; // 모델/방식 변경 시 올려 자동 재실행 (v6: 수집 범위 자동 추종 + 달 단위 누적 학습)
// v0.8 성능 가드 — 100k행 census를 30초 함수 안에서 학습하려면 서브샘플·트리수 제한 필요.
const V08_NMAX = 12000;                                     // 학습 표본 상한(초과 시 균등 서브샘플)
const V08_OPTS = { nTrees: 40, maxDepth: 3, minLeaf: 30, lr: 0.15 };
// 셀당 보존 표본 상한 — 누적기가 수십 MB로 불어나면 매 실행의 읽기·쓰기가 시간 한도를 먹는다.
// n(관측 수)은 전수를 유지하므로 MIN_N 자격 판정은 표본이 아니라 진짜 관측 수로 한다.
const ACC_CELL_CAP = 1500;
const TEST_MONTHS = 2;         // 단계당 시험 블록 상한(개월) — N=6이면 기존 계획과 동일

async function openLedger(event) {
  if (global.__FAKE_STORE__) return global.__FAKE_STORE__; // fixture 검증용(런타임 미사용)
  const blobs = await import('@netlify/blobs');
  try { if (event && typeof blobs.connectLambda === 'function') blobs.connectLambda(event); } catch (e) { /* 자동 구성 */ }
  try { return blobs.getStore('ledger'); }
  catch (e) {
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token = process.env.NETLIFY_BLOBS_TOKEN;
    if (siteID && token) return blobs.getStore({ name: 'ledger', siteID, token });
    throw e;
  }
}

async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) out.push(...await Promise.all(items.slice(i, i + limit).map(fn)));
  return out;
}

function tierOf(lowWon) {
  const man = lowWon / 10000;
  if (man < 10000) return 'lt1';
  if (man < 50000) return 't1to5';
  if (man < 100000) return 't5to10';
  return 'gte10';
}
function roundBucket(n) { return (Number(n) || 1) >= 4 ? '4+' : String(Math.max(1, Number(n) || 1)); }
// 저가율 밴드(개찰 전 값만: 최저가/감정가) — 유찰 깎임 깊이·신탁(최저가≥감정가) 구분.
// 온비드 체감 단계(100%/80%/64%/…)에 맞춘 경계. 감정가 미공개(0)는 'na'로 별도 셀.
function discBand(low, apsl) {
  if (!(apsl > 0) || !(low > 0)) return 'na';
  const r = low / apsl;
  if (r >= 0.95) return 'd100'; // 신건 또는 신탁(최저가≥감정가 포함)
  if (r >= 0.75) return 'd80';
  if (r >= 0.55) return 'd64';
  return 'dlt55';
}
function keysFor(type, usage, rb, tier) {
  return [`L3|${type}|${usage}|${rb}|${tier}`, `L2|${type}|${usage}|${rb}`, `L1|${type}|${usage}`, `L0|${type}`];
}
// v0.7 체인: 저가율 조건 셀(L4)을 최상위에 추가 — 미달 시 v0.5 체인으로 백오프.
function keysForV07(type, usage, rb, tier, disc) {
  return [`L4|${type}|${usage}|${rb}|${disc}`, ...keysFor(type, usage, rb, tier)];
}
function quantiles(sorted) {
  const q = p => { const idx = (sorted.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx); return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo); };
  return { p05: q(0.05), p10: q(0.1), p50: q(0.5), p90: q(0.9), p95: q(0.95) };
}

function overlaps(key, start, end) {
  const m = key.match(/(\d{8})_(\d{8})\//);
  if (!m) return false;
  return !(m[2] < start || m[1] > end);
}

// (feat⋈win) 조인 레코드 로드 — opbd로 기간 필터·id_cdtn 중복제거. 개찰 전 값(low/apsl)과
// 결과값(win/lr/wr)을 함께 싣지만, 예측 함수엔 개찰 전 값만 전달한다(아래 score 참조).
async function loadRange(store, featKeys, start, end) {
  const relevant = featKeys.filter(k => overlaps(k, start, end));
  const seen = new Set();
  const recs = [];
  await mapLimit(relevant, 30, async fkey => {
    const parts = fkey.split('/'); const w = parts[2], type = parts[3];
    const [feat, winMap] = await Promise.all([
      store.get(fkey, { type: 'json' }),
      store.get(`hist/win/${w}/${type}`, { type: 'json' }),
    ]);
    if (!Array.isArray(feat)) return;
    const wm = winMap || {};
    for (const f of feat) {
      const opbd = String(f.opbd || '').slice(0, 8);
      if (opbd < start || opbd > end) continue;
      const uid = `${f.id}_${f.cdtn}`;
      if (seen.has(uid)) continue; seen.add(uid);
      const wv = wm[uid] || {};
      recs.push({
        type, id: f.id, cdtn: f.cdtn, usage: String(f.usage || f.usageM || '기타').trim() || '기타',
        round: f.round, low: Number(f.low) || 0, apsl: Number(f.apsl) || 0, st: f.st,
        win: Number(wv.win) || 0, lr: Number(wv.lr) || 0, wr: Number(wv.wr) || 0,
      });
    }
  });
  return recs;
}

// ── 달 단위 누적 학습기 ──
// 한 달치 레코드를 누적기에 접어 넣는다(낙찰 0010만). 단계들의 학습 구간이 포함 관계라
// 누적기를 이어 쓰면 각 실행은 새로 늘어난 한 달만 읽으면 된다 — 범위가 길어져도 실행당
// 작업량이 일정하다. L4(저가율 조건) 셀도 같은 패스에서 모은다(v0.7 비교 기록 유지).
// wr(감정가 대비 낙찰가율)은 **어떤 모델도 읽지 않아** 모으지 않는다(누적기 절반 절약).
function foldMonth(acc, records) {
  for (const r of records) {
    if (r.st !== '0010' || !(r.win > 0)) continue;
    if (r.lr > 0) {
      for (const k of keysForV07(r.type, r.usage, roundBucket(r.round), tierOf(r.low), discBand(r.low, r.apsl))) {
        HR.reservoirPush(acc.cells[k] || (acc.cells[k] = { n: 0, s: [] }), r.lr, ACC_CELL_CAP);
      }
      // v0.8 GBDT용 원본 행 저수지 — 어차피 V08_NMAX로 서브샘플되므로 그만큼만 들고 다닌다.
      if (r.low > 0) HR.reservoirPush(acc.v08, { type: r.type, usage: r.usage, round: r.round, low: r.low, apsl: r.apsl, lr: r.lr, st: '0010' }, V08_NMAX);
    }
  }
  acc.records += records.length;
  return acc;
}
function newAccumulator(range) { return { version: BT_VERSION, range, through: null, records: 0, cells: {}, v08: { n: 0, s: [] } }; }
// 누적기 → 셀(분위수). n은 전수 관측 수, 분위수는 보존 표본에서 — 상한을 넘긴 큰 셀에서도
// p10/p50/p90은 사실상 같은 값이 나온다(표본 1,500이면 분위수는 이미 수렴).
function cellsFromAcc(acc) {
  const cells = {};
  for (const [k, a] of Object.entries(acc.cells || {})) {
    if (!a.s || a.s.length < 3) continue;
    const s = a.s.slice().sort((x, y) => x - y);
    cells[k] = { n: a.n, lr: quantiles(s) };
  }
  return cells;
}

function findCellByKeys(cells, keys) {
  for (const k of keys) {
    const c = cells[k];
    if (c && c.n >= MIN_N && c.lr) return c;
  }
  return null;
}

// 공통 예측 공식(폭 확대 없음): [최저가×lr.p10, 최저가×lr.p90], 중심 최저가×lr.p50.
// 모델 차이는 "어느 셀을 먼저 찾느냐"(키 체인)뿐 — 밴드를 넓혀 적중률을 사는 길을 구조로 막는다.
function predictFromChain(cells, item, keys) {
  // 최저가가 없으면 예측하지 않는다(null = noBasis) — 최저가×분위수 모델이라 0이면
  // [0,0,0]이 나오는데 그건 예측이 아니라 근거 없음이다(2026-07-29 교정, sim-live와 동일).
  if (!(Number(item.low) > 0)) return null;
  const c = findCellByKeys(cells, keys);
  if (!c) return null;
  const lo = Math.round(item.low * c.lr.p10 / 100);
  const mid = Math.round(item.low * c.lr.p50 / 100);
  let hi = Math.round(item.low * c.lr.p90 / 100);
  if (hi <= lo) hi = Math.round(lo * 1.05);
  return { lo, mid, hi };
}

// ── v0.8 (GBDT) — 피처 인코딩 + 학습/예측 ──
// 예측 대상은 v0.5와 동일하게 낙찰가율 lr(최저가 대비 %) — [lo,mid,hi]는 it.low로 환산해 apples-to-apples.
// 피처: 자산군 원핫(3) + 용도 top-12 원핫 + other(13) + 회차·최저가log·감정가log·저가율(4).
function buildEncoderV08(sold, K) {
  const cnt = {};
  for (const r of sold) cnt[r.usage] = (cnt[r.usage] || 0) + 1;
  const usages = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]).slice(0, K || 12);
  return { usages };
}
function encodeV08(rec, enc) {
  const v = [rec.type === '0001' ? 1 : 0, rec.type === '0002' ? 1 : 0, rec.type === '0003' ? 1 : 0];
  let matched = 0;
  for (const u of enc.usages) { const m = (String(rec.usage) === u) ? 1 : 0; v.push(m); matched |= m; }
  v.push(matched ? 0 : 1); // other
  const low = Number(rec.low) || 0, apsl = Number(rec.apsl) || 0, round = Number(rec.round) || 1;
  v.push(Math.min(round, 10));                               // 회차(상한)
  v.push(low > 0 ? Math.log10(low) : 0);                     // 최저가 로그
  v.push(apsl > 0 ? Math.log10(apsl) : 0);                   // 감정가 로그
  v.push(apsl > 0 ? Math.max(0, Math.min(2, low / apsl)) : 0); // 저가율(최저가/감정가)
  return v;
}
// 학습: 낙찰(0010)·lr>0만. 서브샘플로 성능 가드. win/lr을 x에 안 넣음(y=lr만 목표).
function trainV08(records) {
  let sold = records.filter(r => r.st === '0010' && r.lr > 0 && r.low > 0);
  if (sold.length < 50) return null; // 표본 부족 → v0.8 해당 스테이지 생략
  if (sold.length > V08_NMAX) { const step = sold.length / V08_NMAX, s = []; for (let i = 0; i < V08_NMAX; i++) s.push(sold[Math.floor(i * step)]); sold = s; }
  const enc = buildEncoderV08(sold, 12);
  const X = sold.map(r => encodeV08(r, enc)), y = sold.map(r => r.lr);
  return { enc, gb: GB.trainQuantileBands(X, y, V08_OPTS), n: sold.length };
}
// 예측: it엔 개찰 전 값만(win 없음 — GR11). lr 분위수 → it.low로 환산.
function predictV08(model, it) {
  if (!model || !model.gb) return null;
  if (!(Number(it.low) > 0)) return null;   // 최저가 없으면 예측 안 함(v0.5와 동일 규율)
  const b = GB.predictBands(model.gb, encodeV08(it, model.enc)); // lr 분위수
  const lo = Math.round(it.low * b.lo / 100), mid = Math.round(it.low * b.mid / 100);
  let hi = Math.round(it.low * b.hi / 100);
  if (hi <= lo) hi = Math.round(lo * 1.05);
  return { lo, mid, hi };
}

// ═══ 모델 레지스트리 — 새 후보는 여기 등록 한 줄 + BT_VERSION 범프 ═══
// predict(art, item)의 item엔 개찰 전 값만 들어온다(win 없음 — 마스킹 구조 보장).
// art = { cells(v05/v07용), gb08(v08 학습 결과) } — train 단계에서 함께 만든다.
// (v0.6 두앵커+광폭 밴드는 2026-07-23 기각 — Golden Rule "넓혀서 맞히기 금지" 위반으로 제외.)
const MODELS = [
  {
    key: 'v05', label: '최저가 × 낙찰가율 분위수(p10~p90) — 기준선',
    predict: (art, it) => predictFromChain(art.cells || {}, it, keysFor(it.type, it.usage, roundBucket(it.round), tierOf(it.low))),
  },
  {
    key: 'v07', label: 'v0.5 + 저가율(최저가/감정가) 조건 셀 L4 — 폭 불변·중심 정밀화',
    predict: (art, it) => predictFromChain(art.cells || {}, it, keysForV07(it.type, it.usage, roundBucket(it.round), tierOf(it.low), discBand(it.low, it.apsl))),
  },
  {
    key: 'v08', label: 'GBDT 분위수 부스팅 — 피처 상호작용·연속값·이분산 학습(순수 JS)',
    predict: (art, it) => predictV08(art.gb08, it),
  },
];

exports._test = { encodeV08, trainV08, predictV08, buildEncoderV08 }; // fixture 검증용

function newAcc() { return { n: 0, hit: 0, sumErr: 0, sumWidth: 0 }; }
function grade(pred, win, acc) {
  if (!pred) return;
  acc.n++;
  if (win >= pred.lo && win <= pred.hi) acc.hit++;
  acc.sumErr += Math.abs((pred.mid - win) / win * 100);
  acc.sumWidth += (pred.hi - pred.lo) / win * 100;
}
function finalize(acc, testSold) {
  return {
    n: acc.n,
    coverage: testSold ? Math.round(acc.n / testSold * 1000) / 10 : 0,
    hitRate: acc.n ? Math.round(acc.hit / acc.n * 1000) / 10 : null,
    avgAbsErrPct: acc.n ? Math.round(acc.sumErr / acc.n * 10) / 10 : null,
    avgWidthPct: acc.n ? Math.round(acc.sumWidth / acc.n * 10) / 10 : null,
  };
}

exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  const store = await openLedger(event);

  try {
    // 수집 범위는 **디스크에 실제로 있는 창**에서 읽는다(메타는 낡을 수 있다).
    const listing = await store.list({ prefix: 'hist/feat/' });
    const featKeys = (listing && listing.blobs ? listing.blobs : []).map(b => b.key).filter(k => /^hist\/feat\/\d{8}_\d{8}\/\d+$/.test(k));
    const { months, dataStart, dataEnd } = HR.monthsFromKeys(featKeys);
    const STAGES = HR.planStages(months, { testMonths: TEST_MONTHS });
    const rangeKey = months.length ? `${months[0]}~${months[months.length - 1]}` : '';
    const plan = { range: rangeKey, months: months.length, dataStart, dataEnd, stages: STAGES.map(s => ({ key: s.key, train: s.vlabel, test: s.testLabel })) };

    if (qs.status === '1') {
      const [state, summary] = await Promise.all([store.get('bt/_state', { type: 'json' }), store.get('bt/summary', { type: 'json' })]);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, version: BT_VERSION, plan, state: state || null, summary: summary || null }) };
    }
    if (qs.reset === '1' && qs.confirm === '1') {
      await Promise.all([
        store.setJSON('bt/_state', { stageIdx: 0, phase: 'train', version: BT_VERSION, range: rangeKey }),
        store.setJSON('bt/_acc', newAccumulator(rangeKey)),
      ]);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, plan, note: '백테스트 상태 초기화됨.' }) };
    }

    const bf = await store.get('hist/_bfmeta', { type: 'json' });
    if (!bf || !bf.done) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, waiting: true, note: '백필(과거 마스킹 수집) 완료 후 백테스트가 시작됩니다.', backfill: bf || null }) };
    }
    if (!STAGES.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, waiting: true, plan, note: '온전한 달이 2개 미만이라 walk-forward 단계를 만들 수 없습니다.' }) };
    }

    let state = await store.get('bt/_state', { type: 'json' });
    // 모델 버전이 바뀌었거나 **수집 범위가 넓어졌으면** 처음부터 다시 — 옛 상태를 이어받으면
    // 단계 인덱스가 새 계획과 어긋나 엉뚱한 달을 채점하게 된다.
    if (state && (state.version !== BT_VERSION || state.range !== rangeKey)) state = null;
    if (!state) { state = { stageIdx: 0, phase: 'train', version: BT_VERSION, range: rangeKey }; await store.setJSON('bt/_state', state); }
    if (state.stageIdx >= STAGES.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, done: true, version: BT_VERSION, plan, note: `${STAGES.length}단계 백테스트 완료.` }) };
    }

    const stage = STAGES[state.stageIdx];

    if (state.phase === 'train') {
      // 누적기는 단계를 가로질러 이어진다(학습 구간이 포함 관계이므로). 범위·버전이 바뀌면 새로 시작.
      let acc = await store.get('bt/_acc', { type: 'json' });
      if (!acc || acc.version !== BT_VERSION || acc.range !== rangeKey) acc = newAccumulator(rangeKey);
      const lastTrain = stage.trainMonths[stage.trainMonths.length - 1];
      const nextYm = acc.through ? HR.nextMonth(acc.through) : stage.trainMonths[0];

      if (nextYm <= lastTrain) {
        // 한 실행 = 한 달. 아직 학습할 달이 남았으면 그 달만 읽어 접어 넣고 끝낸다.
        const recs = await loadRange(store, featKeys, HR.firstDayOf(nextYm), HR.lastDayOf(nextYm));
        foldMonth(acc, recs);
        acc.through = nextYm;
        await store.setJSON('bt/_acc', acc);
        await store.setJSON('_run/backtest', { at: new Date().toISOString(), ok: true, stage: stage.key, phase: 'training', ym: nextYm, through: acc.through, accRecords: acc.records });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, stage: stage.key, phase: 'training', ym: nextYm, monthRecords: recs.length, accRecords: acc.records, until: lastTrain, note: `학습 누적 중 — ${lastTrain}까지 달마다 한 번씩 이어서 읽습니다.` }) };
      }

      // 학습 구간이 다 찼다 → 셀·GBDT를 만들어 이번 단계의 학습 산출물로 봉인
      const cells = cellsFromAcc(acc);               // v05/v07용 셀
      const gb08 = trainV08(acc.v08.s || []);        // v0.8 GBDT 학습(표본 부족 시 null)
      await store.setJSON(`bt/_traincells_${stage.key}`, { cells, gb08, trainN: acc.records, cellCount: Object.keys(cells).length, gb08N: gb08 ? gb08.n : 0 });
      await store.setJSON('bt/_state', { stageIdx: state.stageIdx, phase: 'score', version: BT_VERSION, range: rangeKey });
      await store.setJSON('_run/backtest', { at: new Date().toISOString(), ok: true, stage: stage.key, phase: 'trained', trainN: acc.records, cells: Object.keys(cells).length, gb08N: gb08 ? gb08.n : 0 });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, stage: stage.key, phase: 'trained', trainRecords: acc.records, cellCount: Object.keys(cells).length, gb08N: gb08 ? gb08.n : 0, note: '다음 실행에서 테스트 블록을 채점합니다.' }) };
    }

    // score — 레지스트리의 모든 모델 병행 채점 (예측 입력엔 개찰 전 값만). art={cells,gb08}.
    const art = (await store.get(`bt/_traincells_${stage.key}`, { type: 'json' })) || { cells: {}, gb08: null };
    const cells = art.cells || {};
    const testRecs = await loadRange(store, featKeys, stage.test[0], stage.test[1]);
    const sold = testRecs.filter(r => r.st === '0010' && r.win > 0);

    const accs = {};
    for (const m of MODELS) accs[m.key] = newAcc();
    for (const item of sold) {
      const feat = { type: item.type, usage: item.usage, round: item.round, low: item.low, apsl: item.apsl }; // win 없음
      for (const m of MODELS) grade(m.predict(art, feat), item.win, accs[m.key]);
    }
    const perModel = {};
    for (const m of MODELS) perModel[m.key] = finalize(accs[m.key], sold.length);

    const base = accs[MODELS[0].key]; // 기준선(첫 모델) — 하위호환 최상위 필드용
    const result = {
      key: stage.key, vlabel: stage.vlabel, testLabel: stage.testLabel,
      trainRange: stage.train.join('~'), testRange: stage.test.join('~'),
      trainRecords: art.trainN || 0, trainCells: art.cellCount || Object.keys(cells).length,
      testSold: sold.length,
      models: perModel,
      // 하위호환: 기존 랩이 읽던 최상위 필드는 기준선(v0.5) 값으로 유지
      n: base.n, coverage: sold.length ? Math.round(base.n / sold.length * 1000) / 10 : 0,
      hitRate: base.n ? Math.round(base.hit / base.n * 1000) / 10 : null,
      avgAbsErrPct: base.n ? Math.round(base.sumErr / base.n * 10) / 10 : null,
      avgWidthPct: base.n ? Math.round(base.sumWidth / base.n * 10) / 10 : null,
      builtAt: new Date().toISOString(),
    };
    await store.setJSON(`bt/${stage.key}`, result);

    const summary = (await store.get('bt/summary', { type: 'json' })) || {};
    // 버전이나 수집 범위가 달라진 옛 요약은 버린다 — 다른 범위로 낸 단계와 섞이면
    // 표에 나란히 놓인 세 줄이 서로 다른 시험이 되어 "학습할수록"이라는 비교가 깨진다.
    summary.stages = (summary.version === BT_VERSION && summary.range === rangeKey && Array.isArray(summary.stages)) ? summary.stages.filter(s => s.key !== stage.key) : [];
    summary.stages.push(result);
    summary.stages.sort((a, b) => a.key.localeCompare(b.key));
    summary.version = BT_VERSION;
    summary.method = 'walk-forward (확장 창) · 낙찰가 마스킹 · bt/* 격리';
    summary.models = Object.fromEntries(MODELS.map(m => [m.key, m.label]));
    summary.range = rangeKey;          // 어느 수집 범위로 돌린 결과인지 — 범위가 늘면 이 값이 바뀐다
    summary.dataMonths = months.length;
    const nextIdx = state.stageIdx + 1;
    summary.done = nextIdx >= STAGES.length;
    summary.updatedAt = new Date().toISOString();
    await store.setJSON('bt/summary', summary);
    await store.setJSON('bt/_state', { stageIdx: nextIdx, phase: 'train', version: BT_VERSION, range: rangeKey });
    const hb = { at: new Date().toISOString(), ok: true, stage: stage.key, phase: 'scored', done: summary.done };
    for (const m of MODELS) hb[m.key] = perModel[m.key].hitRate;
    await store.setJSON('_run/backtest', hb);

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, stage: stage.key, phase: 'scored', result, allDone: summary.done }) };
  } catch (e) {
    try { await store.setJSON('_run/backtest', { at: new Date().toISOString(), ok: false, error: e.message }); } catch (_) { /* 무시 */ }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
