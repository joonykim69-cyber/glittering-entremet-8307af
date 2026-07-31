// netlify/functions/sim-live.js
// 예측 엔진 — "모의 라이브 학습장" (2026-07-27 착수, 헌장 Golden Rule 11 준수).
//
// 목적: 마스킹 수집한 과거를 "그 시점부터 라이브인 것처럼" 월 단위로 재생하며,
//   각 물건을 개찰 전 값만으로 예측 → 개찰 후 채점하고 **per-item 기록**을 남긴다.
//   이 per-item 기록이 마이페이지 "엔진 학습 관제실"의 리플레이·과녁을 진짜
//   데이터로 채운다(백테스트는 3단계 집계뿐이라 점 하나하나가 없었다).
//
// ── Golden Rule 11 (시점 정직성 / No Look-Ahead) — 코드 구조로 강제 ──
//   대상 월 M을 예측할 때 학습 셀은 M 시작 이전(opbd < M-01) 데이터로만 만든다.
//   예측 함수 predictOne(cells, feat)의 feat엔 개찰 전 값(type/usage/round/low)만 있고
//   win/lr 필드가 아예 없다 → 미래(낙찰가)를 훔쳐볼 경로가 구조적으로 없다.
//   낙찰가는 채점 시점에만 레코드에서 꺼낸다. 결과는 bt/sim/* 에만 쓴다(라이브 원장 무관).
//
// 실행: 일반 함수(30초). 월당 1회 호출로 끝내고 커서(bt/sim/_state)로 재개.
//   ?status=1 진행 조회 / ?reset=1&confirm=1 초기화. backfill 완료 전 no-op.
//
// 재생 구간은 수집 범위를 따라간다(2026-07-31): 예전엔 env(SIM_TRAIN_FROM/START_YM/END_YM)
//   기본값이 2026년 1~6월이라, collect-backfill이 2025년까지 넓혀도 사람이 env를 바꿔 주기
//   전엔 6개월만 재생했다. 이제 `hist/feat/*` 창 키에서 온전한 달을 읽어 **첫 달을 학습
//   출발점, 그다음 달부터 마지막 달까지를 재생 구간**으로 잡는다. env는 그대로 두되 이제
//   기본값이 아니라 **덮어쓰기**로만 작동한다(특정 구간만 다시 보고 싶을 때).
//
// 한 실행 = 한 달, 학습은 누적: 예전엔 매 실행이 학습 구간 전체를 다시 읽었다. 범위가
//   18개월이 되면 마지막 달 하나를 재생하려고 17개월치 창 블롭을 읽어야 해 시간 한도를
//   넘는다. 이제 학습 셀을 누적기(`bt/sim/_acc`)에 이어 담고, 채점이 끝난 달을 **그 자리에서**
//   누적기에 접어 넣는다(이미 읽은 레코드를 재사용 — 추가 읽기 0). GR11은 그대로 보장된다:
//   누적기에는 항상 현재 달보다 **이전** 달만 들어 있다.

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const HR = require('./lib/histrange'); // 수집 범위 → 온전한 달
const MIN_N = 20;                 // 챌린저 셀 자격 최소 표본 (라이브·백테스트와 동일)
const SIM_VERSION = 'sim-v0.5-3'; // 방식 변경 시 올려 자동 재실행 (v3: 수집 범위 자동 추종 + 누적 학습)
const REC_PER_MONTH = 60;         // 월별 보존 per-item 샘플 상한(과녁 점 대표성 + 블롭 크기 억제)
const ACC_CELL_CAP = 1500;        // 셀당 보존 표본 상한(분위수는 이미 수렴, 누적 블롭 크기 억제)

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
function tierOf(lowWon) { const m = lowWon / 10000; return m < 10000 ? 'lt1' : m < 50000 ? 't1to5' : m < 100000 ? 't5to10' : 'gte10'; }
function roundBucket(n) { return (Number(n) || 1) >= 4 ? '4+' : String(Math.max(1, Number(n) || 1)); }
function keysFor(type, usage, rb, tier) {
  return [`L3|${type}|${usage}|${rb}|${tier}`, `L2|${type}|${usage}|${rb}`, `L1|${type}|${usage}`, `L0|${type}`];
}
function quantiles(sorted) {
  const q = p => { const idx = (sorted.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx); return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo); };
  return { p10: q(0.1), p50: q(0.5), p90: q(0.9) };
}
function overlaps(key, start, end) { const m = key.match(/(\d{8})_(\d{8})\//); return m ? !(m[2] < start || m[1] > end) : false; }

// 월 유틸 (YYYYMM) — 백테스트와 같은 구현을 쓴다(lib/histrange).
const firstDay = HR.firstDayOf, lastDay = HR.lastDayOf, prevMonthLastDay = HR.prevMonthLastDay, enumMonths = HR.enumMonths;

// (feat⋈win) 조인 로드 — opbd 기간 필터·id_cdtn 중복제거. win은 싣되 예측엔 안 넘긴다.
async function loadRange(store, featKeys, start, end) {
  const relevant = featKeys.filter(k => overlaps(k, start, end));
  const seen = new Set(); const recs = [];
  await mapLimit(relevant, 30, async fkey => {
    const parts = fkey.split('/'); const w = parts[2], type = parts[3];
    const [feat, winMap] = await Promise.all([store.get(fkey, { type: 'json' }), store.get(`hist/win/${w}/${type}`, { type: 'json' })]);
    if (!Array.isArray(feat)) return;
    const wm = winMap || {};
    for (const f of feat) {
      const opbd = String(f.opbd || '').slice(0, 8);
      if (opbd < start || opbd > end) continue;
      const uid = `${f.id}_${f.cdtn}`; if (seen.has(uid)) continue; seen.add(uid);
      const wv = wm[uid] || {};
      recs.push({
        type, id: f.id, cdtn: f.cdtn, usage: String(f.usage || f.usageM || '기타').trim() || '기타',
        round: f.round, low: Number(f.low) || 0, apsl: Number(f.apsl) || 0, st: f.st,
        win: Number(wv.win) || 0, lr: Number(wv.lr) || 0, opbd,
      });
    }
  });
  return recs;
}

// 학습 셀 = 최저가 대비 낙찰가율(lr) 분위수. 낙찰(0010)만. (M 이전 데이터로만 호출됨)
//
// 누적 구조: 재생이 한 달 나아갈 때마다 그 달을 여기에 접어 넣는다. 매번 전 구간을 다시
// 읽지 않으므로 재생 구간이 길어져도 실행당 작업량이 일정하다. 셀당 표본은 상한을 두되
// n(관측 수)은 전수를 유지해 MIN_N 자격 판정은 진짜 관측 수로 한다.
function newAccumulator(range) { return { version: SIM_VERSION, range, through: null, records: 0, cells: {} }; }
function foldMonth(acc, records) {
  acc.records = (acc.records || 0) + records.length;
  for (const r of records) {
    if (r.st !== '0010' || !(r.lr > 0)) continue;
    for (const k of keysFor(r.type, r.usage, roundBucket(r.round), tierOf(r.low))) {
      HR.reservoirPush(acc.cells[k] || (acc.cells[k] = { n: 0, s: [] }), r.lr, ACC_CELL_CAP);
    }
  }
  return acc;
}
function cellsFromAcc(acc) {
  const cells = {};
  for (const [k, a] of Object.entries(acc.cells || {})) {
    if (!a.s || a.s.length < 3) continue;
    const s = a.s.slice().sort((x, y) => x - y);
    cells[k] = { n: a.n, lr: quantiles(s) };
  }
  return cells;
}
function buildCells(records) { return cellsFromAcc(foldMonth(newAccumulator(''), records)); }

// ── 예측: 개찰 전 값만 받는다 (win 없음 — 미래 차단) ──
// feat = {type, usage, round, low}. 낙찰가·lr는 인자에 존재하지 않는다.
function predictOne(cells, feat) {
  // 최저가가 없으면 예측하지 않는다(null = noBasis). 이 모델은 "최저가 × 낙찰가율 분위수"라
  // 최저가가 0이면 [0,0,0]을 내놓는데, 그건 예측이 아니라 근거 없음이다. 그걸 빗나감으로
  // 집계하면 성적이 왜곡된다 — 챔피언의 noBasis 규율과 같은 처리(2026-07-29 교정).
  if (!(Number(feat.low) > 0)) return null;
  for (const k of keysFor(feat.type, feat.usage, roundBucket(feat.round), tierOf(feat.low))) {
    const c = cells[k];
    if (c && c.n >= MIN_N && c.lr) {
      const lo = Math.round(feat.low * c.lr.p10 / 100);
      const mid = Math.round(feat.low * c.lr.p50 / 100);
      let hi = Math.round(feat.low * c.lr.p90 / 100);
      if (hi <= lo) hi = Math.round(lo * 1.05);
      return { lo, mid, hi, level: k.split('|')[0] };
    }
  }
  return null;
}

function downsample(arr, k) { if (arr.length <= k) return arr; const step = arr.length / k, out = []; for (let i = 0; i < k; i++) out.push(arr[Math.floor(i * step)]); return out; }

// exports._test 로 순수 로직 검증(런타임 미사용)
exports._test = { keysFor, buildCells, predictOne, enumMonths, prevMonthLastDay };

exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  const store = await openLedger(event);

  try {
    // 재생 구간은 **디스크에 실제로 있는 창**에서 읽는다(메타는 낡을 수 있다).
    // env는 덮어쓰기로만 — 기본값을 코드에 박아 두면 수집이 넓어져도 따라가지 못한다.
    const listing = await store.list({ prefix: 'hist/feat/' });
    const featKeys = (listing && listing.blobs ? listing.blobs : []).map(b => b.key).filter(k => /^hist\/feat\/\d{8}_\d{8}\/\d+$/.test(k));
    const avail = HR.monthsFromKeys(featKeys).months;
    const TRAIN_FROM = process.env.SIM_TRAIN_FROM || avail[0] || '';
    const START_YM = process.env.SIM_START_YM || (avail[1] || '');        // 첫 달은 학습 출발점
    const END_YM = process.env.SIM_END_YM || (avail[avail.length - 1] || '');
    const months = (TRAIN_FROM && START_YM && END_YM) ? enumMonths(START_YM, END_YM) : [];
    const rangeKey = `${TRAIN_FROM}|${START_YM}~${END_YM}`;
    const plan = { trainFrom: TRAIN_FROM, range: `${START_YM}~${END_YM}`, months: months.length, dataMonths: avail.length };

    if (qs.status === '1') {
      const [state, summary] = await Promise.all([store.get('bt/sim/_state', { type: 'json' }), store.get('bt/sim/summary', { type: 'json' })]);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, version: SIM_VERSION, plan, months, state: state || null, summary: summary || null }) };
    }
    if (qs.reset === '1' && qs.confirm === '1') {
      await Promise.all([
        store.setJSON('bt/sim/_state', { i: 0, version: SIM_VERSION, range: rangeKey }),
        store.setJSON('bt/sim/summary', { version: SIM_VERSION, months: [], cum: null }),
        store.setJSON('bt/sim/records', []),
        store.setJSON('bt/sim/_acc', newAccumulator(rangeKey)),
      ]);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, plan, note: '모의 라이브 상태 초기화됨.' }) };
    }

    const bf = await store.get('hist/_bfmeta', { type: 'json' });
    if (!bf || !bf.done) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, waiting: true, note: '백필(과거 마스킹 수집) 완료 후 모의 라이브가 시작됩니다.', backfill: bf || null }) };
    }
    if (!months.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, waiting: true, plan, note: '온전한 달이 2개 미만이라 재생할 구간이 없습니다.' }) };
    }

    let state = await store.get('bt/sim/_state', { type: 'json' });
    // 방식이 바뀌었거나 **수집 범위가 넓어졌으면** 처음부터 — 옛 커서(i)를 이어받으면
    // 새 구간의 엉뚱한 달을 가리켜 앞쪽 달이 영영 재생되지 않는다.
    if (state && (state.version !== SIM_VERSION || state.range !== rangeKey)) state = null;
    if (!state) { state = { i: 0, version: SIM_VERSION, range: rangeKey }; await store.setJSON('bt/sim/_state', state); }
    if (state.i >= months.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, done: true, version: SIM_VERSION, plan, note: '모의 라이브 재생 완료.' }) };
    }

    const ym = months[state.i];
    // 누적 학습기 — 이 달보다 **이전** 달만 들어 있어야 한다(GR11). 범위·방식이 바뀌면 새로.
    let acc = await store.get('bt/sim/_acc', { type: 'json' });
    if (!acc || acc.version !== SIM_VERSION || acc.range !== rangeKey) acc = newAccumulator(rangeKey);
    const needThrough = HR.prevMonth(ym);
    if (acc.through !== needThrough) {
      // 아직 학습이 이 달 직전까지 차지 않았다 → 부족한 달을 하나만 읽어 접어 넣고 끝낸다.
      // (첫 실행의 출발점 TRAIN_FROM부터 한 달씩. 한 실행 = 한 달이라 시간 한도를 넘지 않는다.)
      if (acc.through && acc.through > needThrough) acc = newAccumulator(rangeKey); // 앞섰다 → 다시 쌓는다
      const addYm = acc.through ? HR.nextMonth(acc.through) : TRAIN_FROM;
      const recs = await loadRange(store, featKeys, firstDay(addYm), lastDay(addYm));
      foldMonth(acc, recs);
      acc.through = addYm;
      await store.setJSON('bt/sim/_acc', acc);
      await store.setJSON('_run/sim-live', { at: new Date().toISOString(), ok: true, phase: 'training', ym: addYm, through: acc.through });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, phase: 'training', ym: addYm, monthRecords: recs.length, until: needThrough, note: `학습 누적 중 — ${needThrough}까지 채운 뒤 ${ym} 재생을 시작합니다.` }) };
    }

    const cells = cellsFromAcc(acc);
    const testRecs = await loadRange(store, featKeys, firstDay(ym), lastDay(ym));
    const sold = testRecs.filter(r => r.st === '0010' && r.win > 0);

    let n = 0, hit = 0, sumErr = 0, sumWidth = 0, noBasis = 0;
    const recs = [];
    for (const item of sold) {
      const feat = { type: item.type, usage: item.usage, round: item.round, low: item.low }; // win 없음(GR11)
      const pred = predictOne(cells, feat);
      // 예측 못 한 건은 조용히 사라지지 않게 센다 — 커버리지가 성적만큼 중요한 지표다
      // (근거 없어 안 낸 것과 내서 틀린 것은 다른 문제이므로 분리해 기록한다).
      if (!pred) { noBasis++; continue; }
      const win = item.win; // 채점 시점에만 꺼냄
      const isHit = win >= pred.lo && win <= pred.hi;
      const errPct = Math.round((pred.mid - win) / win * 1000) / 10;
      const widthPct = Math.round((pred.hi - pred.lo) / win * 1000) / 10;
      n++; if (isHit) hit++; sumErr += Math.abs(errPct); sumWidth += widthPct;
      recs.push({ ym, usage: item.usage, low: item.low, lo: pred.lo, mid: pred.mid, hi: pred.hi, win, hit: isHit, errPct, level: pred.level });
    }

    const monthResult = {
      ym, trainN: acc.records, testSold: sold.length, n, noBasis,
      coverage: sold.length ? Math.round(n / sold.length * 1000) / 10 : null,
      hitRate: n ? Math.round(hit / n * 1000) / 10 : null,
      avgAbsErrPct: n ? Math.round(sumErr / n * 10) / 10 : null,
      avgWidthPct: n ? Math.round(sumWidth / n * 10) / 10 : null,
    };

    // 요약 누적 (같은 방식이면 이어붙이고, 이번 월은 교체)
    const summary = (await store.get('bt/sim/summary', { type: 'json' })) || {};
    // 방식이나 수집 범위가 달라진 옛 곡선은 버린다 — 학습량이 다른 달을 한 곡선에 이어
    // 붙이면 "재생할수록 좋아진다"는 그림이 서로 다른 시험의 조각이 된다.
    summary.months = (summary.version === SIM_VERSION && summary.rangeKey === rangeKey && Array.isArray(summary.months)) ? summary.months.filter(m => m.ym !== ym) : [];
    summary.months.push(monthResult);
    summary.months.sort((a, b) => a.ym.localeCompare(b.ym));
    // 누적 적중률(재생이 진행될수록 오르는 곡선) — 월별 n·hit 재구성
    let cn = 0, ch = 0, ce = 0, cw = 0, cnW = 0;
    summary.months.forEach(m => { if (m.n) { cn += m.n; ch += Math.round(m.hitRate / 100 * m.n); if (m.avgAbsErrPct != null) { ce += m.avgAbsErrPct * m.n; } if (m.avgWidthPct != null) { cw += m.avgWidthPct * m.n; cnW += m.n; } m.cumHitRate = Math.round(ch / cn * 1000) / 10; } });
    summary.cum = cn ? { n: cn, hitRate: Math.round(ch / cn * 1000) / 10, avgAbsErrPct: Math.round(ce / cn * 10) / 10, avgWidthPct: cnW ? Math.round(cw / cnW * 10) / 10 : null } : null;
    summary.version = SIM_VERSION;
    summary.method = '월 단위 확장 walk-forward · 낙찰가 마스킹 · 시점 정직성(GR11) · bt/sim 격리';
    summary.trainFrom = TRAIN_FROM; summary.range = `${START_YM}~${END_YM}`; summary.rangeKey = rangeKey;

    // per-item 레코드 — 월별 상한 내로 다운샘플해 누적(과녁 점: 초기 월 vs 후기 월 대표성 유지)
    const allRecs = (await store.get('bt/sim/records', { type: 'json' })) || [];
    const kept = allRecs.filter(r => r.ym !== ym).concat(downsample(recs, REC_PER_MONTH));
    kept.sort((a, b) => a.ym.localeCompare(b.ym));

    // 채점이 끝난 이 달을 **그 자리에서** 학습 누적기에 접어 넣는다 — 이미 읽은 레코드를
    // 재사용하므로 추가 읽기 0이고, 다음 달 재생은 곧바로 채점부터 시작한다.
    // GR11: 접어 넣는 시점이 채점 **뒤**라, 이 달의 예측에는 이 달 데이터가 쓰이지 않았다.
    foldMonth(acc, testRecs);
    acc.through = ym;

    const nextI = state.i + 1;
    summary.done = nextI >= months.length; summary.updatedAt = new Date().toISOString();
    await Promise.all([
      store.setJSON('bt/sim/summary', summary),
      store.setJSON('bt/sim/records', kept),
      store.setJSON('bt/sim/_acc', acc),
      store.setJSON('bt/sim/_state', { i: nextI, version: SIM_VERSION, range: rangeKey }),
      store.setJSON('_run/sim-live', { at: new Date().toISOString(), ok: true, ym, n, hitRate: monthResult.hitRate, done: summary.done }),
    ]);

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, ym, month: monthResult, cum: summary.cum, allDone: summary.done }) };
  } catch (e) {
    try { await store.setJSON('_run/sim-live', { at: new Date().toISOString(), ok: false, error: e.message }); } catch (_) { /* 무시 */ }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
