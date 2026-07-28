// netlify/functions/mkt-backtest.js
// 시세 축 ⑤ 2단계 — 시세 nowcast walk-forward 백테스트(정합도 측정).
//
// 왜: 우리 시세 추정(market-est = 최근 실거래 ㎡당 분위수)이 "지금 시세를 얼마나 잘
//   맞히나"를 과거 데이터로 즉시 측정한다. 낙찰가 백테스트가 masking 과거로 학습곡선을
//   그렸듯, 여기선 collect-rtms가 쌓은 실거래로 nowcast 정합도를 잰다.
//
// 방법(시점 정직성/GR11 준수): 각 셀(시군구×주거유형)에서 as-of 월 M을 훑으며
//   ① 추정: M 이전 최근 W개월(apt/offi=6, rh/sh=12 — 라이브 market-est와 동일) 실거래
//      ㎡당의 분위수 [p25,p50,p75]로 밴드를 만든다. **M 이후 거래는 절대 안 씀.**
//   ② 채점: 바로 다음 달 M+1의 실거래 ㎡당 중앙값이 그 밴드 [p25,p75]에 들어갔나(hit),
//      중앙값 오차 %(|p50−실제중앙|/실제중앙), 개별 거래 커버리지(밴드 안 비율)를 잰다.
//   → 전체·유형별·as-of 월별로 집계. mkt/bt/* 격리(낙찰가 pred/agg/bt와 무관).
//
// ⚠️ 이건 "학습곡선"이 아니라 **nowcast 정합도 측정**이다 — market-est는 학습하는 모델이
//   아니라 고정 추정기(최근 거래 분위수)라, 시간이 지난다고 좋아지는 게 아니라 "지금 시세를
//   얼마나 정확히 잡나"를 재는 것. 낙찰가 성적표와 **별개 지표**("시세 추정 신뢰도").
//
// 실행: 일반 함수. mkt/rtms/* 블롭만 읽고 계산(외부 API 미호출). collect-rtms 수집 전이면
//   no-op. 결과 mkt/bt/summary, 하트비트 _run/mkt-backtest. ?debug=1 상세.

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const WIN = { apt: 6, offi: 6, rh: 12, sh: 12 }; // as-of 추정 창(개월) — market-est와 동일
const MIN_WINDOW_N = 5;   // 밴드 형성 최소 표본(창 내)
const MIN_NEXT_N = 1;     // 채점 최소 표본(M+1)
const BT_VERSION = 'mkt-v1-nowcast';

async function openLedger(event) {
  if (global.__FAKE_STORE__) return global.__FAKE_STORE__;
  const blobs = await import('@netlify/blobs');
  try { if (event && typeof blobs.connectLambda === 'function') blobs.connectLambda(event); } catch (e) { /* 자동 구성 */ }
  try {
    return blobs.getStore('ledger');
  } catch (e) {
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

function quantile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
function median(arr) { const s = arr.slice().sort((a, b) => a - b); return quantile(s, 0.5); }

// 거래 배열 → ㎡당 값 배열(만원). amt·area>0만.
function perM2List(trades) {
  const out = [];
  for (const t of trades || []) { if (t && t.amt > 0 && t.area > 0) out.push(t.amt / t.area); }
  return out;
}

// 이전 월 문자열(YYYYMM) — as-of 창 구성용
function prevYm(ym, k) {
  let y = +ym.slice(0, 4), m = +ym.slice(4, 6) - k;
  while (m < 1) { m += 12; y--; }
  return `${y}${String(m).padStart(2, '0')}`;
}
function nextYm(ym) {
  let y = +ym.slice(0, 4), m = +ym.slice(4, 6) + 1;
  if (m > 12) { m = 1; y++; }
  return `${y}${String(m).padStart(2, '0')}`;
}

// 한 셀(cellMonths: {ym:trades[]})을 walk-forward 채점 → 관측 배열
// kind로 창 폭 결정. 반환: [{ym(as-of), hit, errPct, coverage, nWin, nNext}]
function scoreCell(cellMonths, kind) {
  const win = WIN[kind] || 6;
  const months = Object.keys(cellMonths).sort(); // 오름차순
  const obs = [];
  for (const M of months) {
    const nx = nextYm(M);
    const nextTrades = cellMonths[nx];
    if (!nextTrades) continue; // 다음 달 정답 없음
    // as-of 창: [M-win+1 .. M]
    const winVals = [];
    for (let k = 0; k < win; k++) { const wm = prevYm(M, k); if (cellMonths[wm]) winVals.push(...perM2List(cellMonths[wm])); }
    if (winVals.length < MIN_WINDOW_N) continue;
    const nextVals = perM2List(nextTrades);
    if (nextVals.length < MIN_NEXT_N) continue;
    const s = winVals.slice().sort((a, b) => a - b);
    const p25 = quantile(s, 0.25), p50 = quantile(s, 0.5), p75 = quantile(s, 0.75);
    const actual = median(nextVals);
    const hit = actual >= p25 && actual <= p75 ? 1 : 0;
    const errPct = actual > 0 ? Math.abs(p50 - actual) / actual * 100 : null;
    const inBand = nextVals.filter(v => v >= p25 && v <= p75).length;
    obs.push({ ym: M, hit, errPct, coverage: nextVals.length ? inBand / nextVals.length : null, nWin: winVals.length, nNext: nextVals.length });
  }
  return obs;
}

function aggregate(allObs) {
  const acc = () => ({ n: 0, hit: 0, errs: [], covs: [] });
  const push = (a, o) => { a.n++; a.hit += o.hit; if (o.errPct != null) a.errs.push(o.errPct); if (o.coverage != null) a.covs.push(o.coverage); };
  const fin = a => ({
    n: a.n,
    hitRate: a.n ? Math.round(a.hit / a.n * 1000) / 10 : null,
    medErrPct: a.errs.length ? Math.round(median(a.errs) * 10) / 10 : null,
    avgCoverage: a.covs.length ? Math.round(a.covs.reduce((x, y) => x + y, 0) / a.covs.length * 1000) / 10 : null,
  });
  const overall = acc(), byKind = {}, byMonth = {};
  for (const o of allObs) {
    push(overall, o);
    (byKind[o.kind] = byKind[o.kind] || acc()) && push(byKind[o.kind], o);
    (byMonth[o.ym] = byMonth[o.ym] || acc()) && push(byMonth[o.ym], o);
  }
  const byKindOut = {}; for (const k of Object.keys(byKind)) byKindOut[k] = fin(byKind[k]);
  const byMonthOut = Object.keys(byMonth).sort().map(ym => ({ ym, ...fin(byMonth[ym]) }));
  return { overall: fin(overall), byKind: byKindOut, byMonth: byMonthOut };
}

exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  const store = await openLedger(event);
  try {
    const meta = await store.get('mkt/rtms/_meta', { type: 'json' });
    if (!meta || !meta.records) {
      await store.setJSON('_run/mkt-backtest', { at: new Date().toISOString(), ok: true, noData: true });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, status: 'empty', note: 'RTMS 실거래 미수집 — collect-rtms가 mkt/rtms/*를 채운 뒤 정합도가 산출됩니다.' }) };
    }
    // 셀-월 블롭 수집 (mkt/rtms/{lawd}_{kind}/{ym}) — _meta/_state 제외
    const listing = await store.list({ prefix: 'mkt/rtms/' });
    const keys = (listing && listing.blobs ? listing.blobs : []).map(b => b.key).filter(k => /^mkt\/rtms\/\d+_[a-z]+\/\d{6}$/.test(k));
    // cell → {ym: trades[]}
    const cells = {};
    await mapLimit(keys, 40, async key => {
      const m = key.match(/^mkt\/rtms\/(\d+_[a-z]+)\/(\d{6})$/);
      if (!m) return;
      const trades = await store.get(key, { type: 'json' });
      if (!Array.isArray(trades)) return;
      (cells[m[1]] = cells[m[1]] || {})[m[2]] = trades;
    });

    // 각 셀 walk-forward 채점
    const allObs = [];
    for (const cell of Object.keys(cells)) {
      const kind = cell.split('_')[1];
      for (const o of scoreCell(cells[cell], kind)) allObs.push({ ...o, kind, cell });
    }

    const agg = aggregate(allObs);
    const summary = {
      version: BT_VERSION, updatedAt: new Date().toISOString(),
      cells: Object.keys(cells).length, observations: allObs.length,
      ...agg,
      note: '시세 nowcast 정합도 — M 이전 거래로 밴드 추정 → M+1 실거래로 채점(시점 정직성). 낙찰가 성적표와 별개.',
    };
    await store.setJSON('mkt/bt/summary', summary);
    await store.setJSON('_run/mkt-backtest', { at: new Date().toISOString(), ok: true, observations: allObs.length, cells: summary.cells });

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: true, summary, ...(qs.debug === '1' ? { sampleObs: allObs.slice(0, 10) } : {}) }),
    };
  } catch (e) {
    try { await store.setJSON('_run/mkt-backtest', { at: new Date().toISOString(), ok: false, error: e.message }); } catch (_) { /* 무시 */ }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

exports._test = { perM2List, prevYm, nextYm, scoreCell, aggregate, quantile, median, WIN };
