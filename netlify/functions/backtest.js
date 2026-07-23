// netlify/functions/backtest.js
// 과거 학습 4단계 — "walk-forward 백테스트 하니스" (3단계 성장 곡선).
//
// 목적: 마스킹 수집한 1~6월 개찰 이력으로, 엔진이 "학습할수록 좋아지는지"를
//   훔쳐보기 0의 정직한 시험으로 측정한다. 확장 창(expanding window):
//     1단계: 1월 학습 → 2·3월 예측·채점
//     2단계: 1~3월 학습 → 4·5월 예측·채점
//     3단계: 1~5월 학습 → 6월 예측·채점
//   각 단계는 미래 블록을 예측하므로 자기/미래 낙찰가 누수 0. 학습 데이터가
//   1→3→5개월로 늘며 적중률·오차·구간폭·커버리지가 어떻게 변하는지 = 성장 곡선.
//
// 마스킹 보장: 예측은 **train 범위 셀(과거)** 과 물건의 **최저가(low)** 만 사용.
//   테스트 물건의 낙찰가는 채점 시점에만 hist/win에서 꺼내며, 예측 함수에 절대
//   들어가지 않는다(예측 입력 객체에 win 필드 없음).
//
// 라이브 불변: 결과는 bt/* 네임스페이스에만 쓴다(pred/predb/agg/scoreboard 무관).
//
// 실행: 일반 함수(30초). 단계당 2페이즈(train 셀 빌드 → score)로 나눠 시간예산
//   안에서 재개(bt/_state {stageIdx, phase}). netlify.toml 임시 스케줄이 자가 구동,
//   backfill(hist/_bfmeta.done) 완료 전엔 no-op. 전 단계 완료 시 no-op.
//   ?status=1 진행 조회 / ?reset=1&confirm=1 초기화.

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const MIN_N = 20; // 챌린저 셀 자격 최소 표본 (라이브와 동일)

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
  return { p10: q(0.1), p50: q(0.5), p90: q(0.9) };
}

// 창 블롭 키에서 {wstart,wend} 파싱 후 [start,end]와 겹치는지
function overlaps(key, start, end) {
  const m = key.match(/(\d{8})_(\d{8})\//);
  if (!m) return false;
  return !(m[2] < start || m[1] > end);
}

// 특정 기간의 (feat⋈win) 조인 레코드 로드 — 예측/집계 공용. opbd로 기간 필터·id_cdtn 중복제거.
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
      recs.push({ type, id: f.id, cdtn: f.cdtn, usage: String(f.usage || f.usageM || '기타').trim() || '기타',
        round: f.round, low: Number(f.low) || 0, st: f.st, win: Number(wv.win) || 0, lr: Number(wv.lr) || 0 });
    }
  });
  return recs;
}

// train 레코드 → 챌린저 셀(최저가 대비 낙찰가율 lr 분위수). 낙찰(0010)만.
function buildCells(records) {
  const acc = {};
  for (const r of records) {
    if (r.st !== '0010' || !(r.win > 0) || !(r.lr > 0)) continue;
    for (const k of keysFor(r.type, r.usage, roundBucket(r.round), tierOf(r.low))) {
      (acc[k] || (acc[k] = [])).push(r.lr);
    }
  }
  const cells = {};
  for (const [k, arr] of Object.entries(acc)) {
    if (arr.length < 3) continue;
    arr.sort((a, b) => a - b);
    cells[k] = { n: arr.length, lr: quantiles(arr) };
  }
  return cells;
}

// 챌린저 예측 — **입력에 win 없음**. 셀 백오프(n≥MIN_N)로 [lo,mid,hi] (원). 근거 없으면 null.
function predictChallenger(cells, item) {
  for (const k of keysFor(item.type, item.usage, roundBucket(item.round), tierOf(item.low))) {
    const c = cells[k];
    if (c && c.n >= MIN_N && c.lr) {
      const lo = Math.round(item.low * c.lr.p10 / 100);
      const mid = Math.round(item.low * c.lr.p50 / 100);
      let hi = Math.round(item.low * c.lr.p90 / 100);
      if (hi <= lo) hi = Math.round(lo * 1.05);
      return { lo, mid, hi, cellKey: k, cellN: c.n };
    }
  }
  return null;
}

exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  const store = await openLedger(event);

  try {
    if (qs.status === '1') {
      const [state, summary] = await Promise.all([store.get('bt/_state', { type: 'json' }), store.get('bt/summary', { type: 'json' })]);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, state: state || null, summary: summary || null }) };
    }
    if (qs.reset === '1' && qs.confirm === '1') {
      await store.setJSON('bt/_state', { stageIdx: 0, phase: 'train' });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, note: '백테스트 상태 초기화됨.' }) };
    }

    // backfill 완료 전엔 대기 (학습 데이터가 있어야 백테스트 가능)
    const bf = await store.get('hist/_bfmeta', { type: 'json' });
    if (!bf || !bf.done) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, waiting: true, note: '백필(1~6월 수집) 완료 후 백테스트가 시작됩니다.', backfill: bf || null }) };
    }

    let state = (await store.get('bt/_state', { type: 'json' })) || { stageIdx: 0, phase: 'train' };
    if (state.stageIdx >= STAGES.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, done: true, note: '3단계 백테스트 완료.' }) };
    }

    const listing = await store.list({ prefix: 'hist/feat/' });
    const featKeys = (listing && listing.blobs ? listing.blobs : []).map(b => b.key).filter(k => /^hist\/feat\/\d{8}_\d{8}\/\d+$/.test(k));
    const stage = STAGES[state.stageIdx];

    if (state.phase === 'train') {
      // 페이즈1: train 범위로 챌린저 셀 빌드 → 임시 저장 (시간예산 보호를 위해 score와 분리)
      const trainRecs = await loadRange(store, featKeys, stage.train[0], stage.train[1]);
      const cells = buildCells(trainRecs);
      await store.setJSON(`bt/_traincells_${stage.key}`, { cells, trainN: trainRecs.length, cellCount: Object.keys(cells).length });
      await store.setJSON('bt/_state', { stageIdx: state.stageIdx, phase: 'score' });
      await store.setJSON('_run/backtest', { at: new Date().toISOString(), ok: true, stage: stage.key, phase: 'trained', trainN: trainRecs.length, cells: Object.keys(cells).length });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, stage: stage.key, phase: 'trained', trainRecords: trainRecs.length, cellCount: Object.keys(cells).length, note: '다음 실행에서 테스트 블록을 채점합니다.' }) };
    }

    // 페이즈2: test 범위 물건을 예측·채점 (walk-forward — 예측은 train 셀만, 낙찰가는 채점에만)
    const tc = (await store.get(`bt/_traincells_${stage.key}`, { type: 'json' })) || { cells: {} };
    const cells = tc.cells || {};
    const testRecs = await loadRange(store, featKeys, stage.test[0], stage.test[1]);
    const sold = testRecs.filter(r => r.st === '0010' && r.win > 0);

    let n = 0, hit = 0, sumAbsErrPct = 0, sumWidthPct = 0;
    for (const item of sold) {
      // 예측 입력: win 없는 사본만 전달 (마스킹 — 예측 함수는 낙찰가를 볼 수 없다)
      const pred = predictChallenger(cells, { type: item.type, usage: item.usage, round: item.round, low: item.low });
      if (!pred) continue; // 근거 없는 셀 → 예측 안 함(정직성)
      const win = item.win; // 채점 시점에만 낙찰가 사용
      n++;
      if (win >= pred.lo && win <= pred.hi) hit++;
      sumAbsErrPct += Math.abs((pred.mid - win) / win * 100);
      sumWidthPct += (pred.hi - pred.lo) / win * 100;
    }

    const result = {
      key: stage.key, vlabel: stage.vlabel, testLabel: stage.testLabel,
      trainRange: stage.train.join('~'), testRange: stage.test.join('~'),
      trainRecords: tc.trainN || 0, trainCells: tc.cellCount || Object.keys(cells).length,
      testSold: sold.length,          // 테스트 블록 낙찰 건수
      n,                              // 예측·채점된 건수 (근거 있는 셀)
      coverage: sold.length ? Math.round(n / sold.length * 1000) / 10 : 0, // 커버리지 % (학습할수록 증가)
      hit, hitRate: n ? Math.round(hit / n * 1000) / 10 : null,
      avgAbsErrPct: n ? Math.round(sumAbsErrPct / n * 10) / 10 : null,
      avgWidthPct: n ? Math.round(sumWidthPct / n * 10) / 10 : null,
      builtAt: new Date().toISOString(),
    };
    await store.setJSON(`bt/${stage.key}`, result);

    // summary 갱신 + 다음 단계로
    const summary = (await store.get('bt/summary', { type: 'json' })) || { stages: [], method: 'walk-forward (확장 창) · 낙찰가 마스킹 · bt/* 격리', model: 'v0.5 챌린저(최저가 대비 낙찰가율 분위수)' };
    summary.stages = summary.stages.filter(s => s.key !== stage.key);
    summary.stages.push(result);
    summary.stages.sort((a, b) => a.key.localeCompare(b.key));
    const nextIdx = state.stageIdx + 1;
    summary.done = nextIdx >= STAGES.length;
    summary.updatedAt = new Date().toISOString();
    await store.setJSON('bt/summary', summary);
    await store.setJSON('bt/_state', { stageIdx: nextIdx, phase: 'train' });
    await store.setJSON('_run/backtest', { at: new Date().toISOString(), ok: true, stage: stage.key, phase: 'scored', n, hitRate: result.hitRate, done: summary.done });

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, stage: stage.key, phase: 'scored', result, allDone: summary.done }) };
  } catch (e) {
    try { await store.setJSON('_run/backtest', { at: new Date().toISOString(), ok: false, error: e.message }); } catch (_) { /* 무시 */ }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
