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
// 모델 비교(2026-07-23): 같은 물건을 두 모델로 나란히 채점한다.
//   v0.5 = 최저가 × 낙찰가율 분위수(p10~p90) — 단일 앵커(기존).
//   v0.6 = 감정가·최저가 두 앵커 중심 + 밴드 p05~p95(넓힘). 챔피언식 두 축 결합으로
//          중심을 안정화하고, 목표 커버리지(95~98%)에 가깝게 밴드를 넓힌 개선안.
//   어느 쪽이 더 정확한지(적중률↑·오차↓, 폭은 함께 감시)를 백테스트로 판정 → 승격 근거.
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

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const MIN_N = 20;              // 챌린저 셀 자격 최소 표본 (라이브와 동일)
const BT_VERSION = 'v2-twoanchor'; // 모델/방식 변경 시 올려 자동 재실행

const STAGES = [
  { key: 's1', vlabel: '1개월 학습 (1월)', testLabel: '2·3월', train: ['20260101', '20260131'], test: ['20260201', '20260331'] },
  { key: 's2', vlabel: '3개월 학습 (1~3월)', testLabel: '4·5월', train: ['20260101', '20260331'], test: ['20260401', '20260531'] },
  { key: 's3', vlabel: '5개월 학습 (1~5월)', testLabel: '6월', train: ['20260101', '20260531'], test: ['20260601', '20260630'] },
];

async function openLedger(event) {
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
function keysFor(type, usage, rb, tier) {
  return [`L3|${type}|${usage}|${rb}|${tier}`, `L2|${type}|${usage}|${rb}`, `L1|${type}|${usage}`, `L0|${type}`];
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
function buildCells(records) {
  const acc = {};
  for (const r of records) {
    if (r.st !== '0010' || !(r.win > 0)) continue;
    for (const k of keysFor(r.type, r.usage, roundBucket(r.round), tierOf(r.low))) {
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

function findCell(cells, item) {
  for (const k of keysFor(item.type, item.usage, roundBucket(item.round), tierOf(item.low))) {
    const c = cells[k];
    if (c && c.n >= MIN_N && c.lr) return c;
  }
  return null;
}

// v0.5 — 단일 앵커: [최저가×lr.p10, 최저가×lr.p90], 중심 최저가×lr.p50. 입력에 win 없음.
function predictV05(cells, item) {
  const c = findCell(cells, item);
  if (!c) return null;
  const lo = Math.round(item.low * c.lr.p10 / 100);
  const mid = Math.round(item.low * c.lr.p50 / 100);
  let hi = Math.round(item.low * c.lr.p90 / 100);
  if (hi <= lo) hi = Math.round(lo * 1.05);
  return { lo, mid, hi };
}

// v0.6 — 두 앵커 중심(감정가·최저가) + 밴드 p05~p95(넓힘). 밴드 모양은 최저가 분위수에서,
// 중심은 두 앵커 평균에서. 낙찰가 ≥ 최저가 제약으로 하한을 최저가로 바닥 처리. 입력에 win 없음.
function predictV06(cells, item) {
  const c = findCell(cells, item);
  if (!c) return null;
  const a1 = item.low * c.lr.p50 / 100;                            // 최저가 앵커
  const a2 = (item.apsl > 0 && c.wr && c.wr.p50 > 0) ? item.apsl * c.wr.p50 / 100 : null; // 감정가 앵커
  const mid = a2 ? (a1 + a2) / 2 : a1;
  // 밴드: 최저가 분위수 p05~p95의 상대 형상을 두 앵커 중심에 재적용(비대칭 보존)
  const relLo = c.lr.p50 > 0 ? c.lr.p05 / c.lr.p50 : 0.85;
  const relHi = c.lr.p50 > 0 ? c.lr.p95 / c.lr.p50 : 1.25;
  let lo = Math.round(Math.max(item.low, mid * relLo));            // 낙찰 ≥ 최저 제약
  let hi = Math.round(mid * relHi);
  if (hi <= lo) hi = Math.round(lo * 1.05);
  return { lo, mid: Math.round(mid), hi };
}

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
      const cells = buildCells(trainRecs);
      await store.setJSON(`bt/_traincells_${stage.key}`, { cells, trainN: trainRecs.length, cellCount: Object.keys(cells).length });
      await store.setJSON('bt/_state', { stageIdx: state.stageIdx, phase: 'score', version: BT_VERSION });
      await store.setJSON('_run/backtest', { at: new Date().toISOString(), ok: true, stage: stage.key, phase: 'trained', trainN: trainRecs.length, cells: Object.keys(cells).length });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, stage: stage.key, phase: 'trained', trainRecords: trainRecs.length, cellCount: Object.keys(cells).length, note: '다음 실행에서 테스트 블록을 채점합니다.' }) };
    }

    // score — 두 모델 병행 채점 (예측 입력엔 개찰 전 값만)
    const tc = (await store.get(`bt/_traincells_${stage.key}`, { type: 'json' })) || { cells: {} };
    const cells = tc.cells || {};
    const testRecs = await loadRange(store, featKeys, stage.test[0], stage.test[1]);
    const sold = testRecs.filter(r => r.st === '0010' && r.win > 0);

    const a05 = newAcc(), a06 = newAcc();
    for (const item of sold) {
      const feat = { type: item.type, usage: item.usage, round: item.round, low: item.low, apsl: item.apsl }; // win 없음
      grade(predictV05(cells, feat), item.win, a05);
      grade(predictV06(cells, feat), item.win, a06);
    }

    const result = {
      key: stage.key, vlabel: stage.vlabel, testLabel: stage.testLabel,
      trainRange: stage.train.join('~'), testRange: stage.test.join('~'),
      trainRecords: tc.trainN || 0, trainCells: tc.cellCount || Object.keys(cells).length,
      testSold: sold.length,
      v05: finalize(a05, sold.length),
      v06: finalize(a06, sold.length),
      // 하위호환: 기존 랩이 읽던 최상위 필드는 v0.5 값으로 유지
      n: a05.n, coverage: sold.length ? Math.round(a05.n / sold.length * 1000) / 10 : 0,
      hitRate: a05.n ? Math.round(a05.hit / a05.n * 1000) / 10 : null,
      avgAbsErrPct: a05.n ? Math.round(a05.sumErr / a05.n * 10) / 10 : null,
      avgWidthPct: a05.n ? Math.round(a05.sumWidth / a05.n * 10) / 10 : null,
      builtAt: new Date().toISOString(),
    };
    await store.setJSON(`bt/${stage.key}`, result);

    const summary = (await store.get('bt/summary', { type: 'json' })) || {};
    summary.stages = (summary.version === BT_VERSION && Array.isArray(summary.stages)) ? summary.stages.filter(s => s.key !== stage.key) : [];
    summary.stages.push(result);
    summary.stages.sort((a, b) => a.key.localeCompare(b.key));
    summary.version = BT_VERSION;
    summary.method = 'walk-forward (확장 창) · 낙찰가 마스킹 · bt/* 격리';
    summary.models = { v05: '최저가 × 낙찰가율 분위수(p10~p90)', v06: '감정가·최저가 두 앵커 중심 + 밴드 p05~p95' };
    const nextIdx = state.stageIdx + 1;
    summary.done = nextIdx >= STAGES.length;
    summary.updatedAt = new Date().toISOString();
    await store.setJSON('bt/summary', summary);
    await store.setJSON('bt/_state', { stageIdx: nextIdx, phase: 'train', version: BT_VERSION });
    await store.setJSON('_run/backtest', { at: new Date().toISOString(), ok: true, stage: stage.key, phase: 'scored', v05: result.v05.hitRate, v06: result.v06.hitRate, done: summary.done });

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, stage: stage.key, phase: 'scored', result, allDone: summary.done }) };
  } catch (e) {
    try { await store.setJSON('_run/backtest', { at: new Date().toISOString(), ok: false, error: e.message }); } catch (_) { /* 무시 */ }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
