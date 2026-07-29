// netlify/functions/backtest.js
// 과거 학습 4단계 — "walk-forward 백테스트 하니스" (3단계 성장 곡선 + 모델 비교).
//
// 목적: 마스킹 수집한 1~6월 개찰 이력으로, 엔진이 "학습할수록 좋아지는지"를
//   훔쳐보기 0의 정직한 시험으로 측정한다. 확장 창(expanding window):
//     1단계: 1월 학습 → 2·3월 예측·채점
//     2단계: 1~3월 학습 → 4·5월 예측·채점
//     3단계: 1~5월 학습 → 6월 예측·채점
//   각 단계는 미래 블록을 예측하므로 자기/미래 낙찰가 누수 0.
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
// 실행: 일반 함수(30초). 단계당 2페이즈(train 셀 빌드 → score)로 나눠 재개(bt/_state).
//   BT_VERSION이 바뀌면 자동 초기화·재실행. backfill 완료 전 no-op, 3단계 완료 후 no-op.
//   ?status=1 진행 조회 / ?reset=1&confirm=1 초기화.

const GB = require('./lib/gbtree'); // 차세대 v0.8 — 순수 JS 분위수 그래디언트 부스팅

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const MIN_N = 20;              // 챌린저 셀 자격 최소 표본 (라이브와 동일)
const BT_VERSION = 'v5-nobasis'; // 모델/방식 변경 시 올려 자동 재실행 (v5: 최저가 0 → noBasis 스킵)
// v0.8 성능 가드 — 100k행 census를 30초 함수 안에서 학습하려면 서브샘플·트리수 제한 필요.
const V08_NMAX = 12000;                                     // 학습 표본 상한(초과 시 균등 서브샘플)
const V08_OPTS = { nTrees: 40, maxDepth: 3, minLeaf: 30, lr: 0.15 };

const STAGES = [
  { key: 's1', vlabel: '1개월 학습 (1월)', testLabel: '2·3월', train: ['20260101', '20260131'], test: ['20260201', '20260331'] },
  { key: 's2', vlabel: '3개월 학습 (1~3월)', testLabel: '4·5월', train: ['20260101', '20260331'], test: ['20260401', '20260531'] },
  { key: 's3', vlabel: '5개월 학습 (1~5월)', testLabel: '6월', train: ['20260101', '20260531'], test: ['20260601', '20260630'] },
];

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

// train 레코드 → 셀. lr(최저가 대비 낙찰가율)과 wr(감정가 대비 낙찰가율) 분위수 둘 다. 낙찰(0010)만.
// L4(저가율 조건) 셀도 같은 패스에서 함께 집계 — v0.5는 L3~L0만, v0.7은 L4부터 조회.
function buildCells(records) {
  const acc = {};
  for (const r of records) {
    if (r.st !== '0010' || !(r.win > 0)) continue;
    for (const k of keysForV07(r.type, r.usage, roundBucket(r.round), tierOf(r.low), discBand(r.low, r.apsl))) {
      const c = acc[k] || (acc[k] = { lr: [], wr: [] });
      if (r.lr > 0) c.lr.push(r.lr);
      if (r.wr > 0) c.wr.push(r.wr);
    }
  }
  const cells = {};
  for (const [k, c] of Object.entries(acc)) {
    if (c.lr.length < 3) continue;
    c.lr.sort((a, b) => a - b); c.wr.sort((a, b) => a - b);
    cells[k] = { n: c.lr.length, lr: quantiles(c.lr), wr: c.wr.length >= 3 ? quantiles(c.wr) : null };
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
    if (qs.status === '1') {
      const [state, summary] = await Promise.all([store.get('bt/_state', { type: 'json' }), store.get('bt/summary', { type: 'json' })]);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, version: BT_VERSION, state: state || null, summary: summary || null }) };
    }
    if (qs.reset === '1' && qs.confirm === '1') {
      await store.setJSON('bt/_state', { stageIdx: 0, phase: 'train', version: BT_VERSION });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, note: '백테스트 상태 초기화됨.' }) };
    }

    const bf = await store.get('hist/_bfmeta', { type: 'json' });
    if (!bf || !bf.done) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, waiting: true, note: '백필(1~6월 수집) 완료 후 백테스트가 시작됩니다.', backfill: bf || null }) };
    }

    let state = await store.get('bt/_state', { type: 'json' });
    if (state && state.version !== BT_VERSION) state = null; // 모델 버전 바뀌면 처음부터 재실행
    if (!state) { state = { stageIdx: 0, phase: 'train', version: BT_VERSION }; await store.setJSON('bt/_state', state); }
    if (state.stageIdx >= STAGES.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, done: true, version: BT_VERSION, note: '3단계 백테스트 완료.' }) };
    }

    const listing = await store.list({ prefix: 'hist/feat/' });
    const featKeys = (listing && listing.blobs ? listing.blobs : []).map(b => b.key).filter(k => /^hist\/feat\/\d{8}_\d{8}\/\d+$/.test(k));
    const stage = STAGES[state.stageIdx];

    if (state.phase === 'train') {
      const trainRecs = await loadRange(store, featKeys, stage.train[0], stage.train[1]);
      const cells = buildCells(trainRecs);          // v05/v07용 셀
      const gb08 = trainV08(trainRecs);             // v0.8 GBDT 학습(표본 부족·서브샘플 내장, 없으면 null)
      // art = {cells, gb08} — 두 단계(train/score) 사이 재개를 위해 blob에 저장.
      await store.setJSON(`bt/_traincells_${stage.key}`, { cells, gb08, trainN: trainRecs.length, cellCount: Object.keys(cells).length, gb08N: gb08 ? gb08.n : 0 });
      await store.setJSON('bt/_state', { stageIdx: state.stageIdx, phase: 'score', version: BT_VERSION });
      await store.setJSON('_run/backtest', { at: new Date().toISOString(), ok: true, stage: stage.key, phase: 'trained', trainN: trainRecs.length, cells: Object.keys(cells).length, gb08N: gb08 ? gb08.n : 0 });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, stage: stage.key, phase: 'trained', trainRecords: trainRecs.length, cellCount: Object.keys(cells).length, gb08N: gb08 ? gb08.n : 0, note: '다음 실행에서 테스트 블록을 채점합니다.' }) };
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
    summary.stages = (summary.version === BT_VERSION && Array.isArray(summary.stages)) ? summary.stages.filter(s => s.key !== stage.key) : [];
    summary.stages.push(result);
    summary.stages.sort((a, b) => a.key.localeCompare(b.key));
    summary.version = BT_VERSION;
    summary.method = 'walk-forward (확장 창) · 낙찰가 마스킹 · bt/* 격리';
    summary.models = Object.fromEntries(MODELS.map(m => [m.key, m.label]));
    const nextIdx = state.stageIdx + 1;
    summary.done = nextIdx >= STAGES.length;
    summary.updatedAt = new Date().toISOString();
    await store.setJSON('bt/summary', summary);
    await store.setJSON('bt/_state', { stageIdx: nextIdx, phase: 'train', version: BT_VERSION });
    const hb = { at: new Date().toISOString(), ok: true, stage: stage.key, phase: 'scored', done: summary.done };
    for (const m of MODELS) hb[m.key] = perModel[m.key].hitRate;
    await store.setJSON('_run/backtest', hb);

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, stage: stage.key, phase: 'scored', result, allDone: summary.done }) };
  } catch (e) {
    try { await store.setJSON('_run/backtest', { at: new Date().toISOString(), ok: false, error: e.message }); } catch (_) { /* 무시 */ }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
