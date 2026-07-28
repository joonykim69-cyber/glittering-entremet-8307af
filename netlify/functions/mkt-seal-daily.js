// netlify/functions/mkt-seal-daily.js
// 시세 축 ⑤ 3단계 — 라이브 시세 밴드 봉인·채점(예측 장부의 시세판).
//
// 왜: 2단계(mkt-backtest)는 과거로 정합도를 "재현"한 것이고, 이건 **앞으로의 성적**을
//   낙찰가 원장과 똑같은 규율로 남긴다 — 결과가 나오기 전에 봉인하고, 나중에 실측으로
//   채점하며, 봉인은 절대 고치지 않는다(불변). 그게 우리가 신뢰를 주장하는 방식.
//
// 매 실행(1일 1회):
//   ① 봉인 — 각 셀(시군구×주거유형)의 "이번 달 기준 현재 시세 밴드"를 계산해
//      `mkt/seal/{cell}/{ym}`에 저장. **이미 있으면 절대 덮어쓰지 않는다**(불변).
//      밴드는 as-of ym 이전 W개월(apt/offi=6·rh/sh=12) 실거래 ㎡당 분위수 [p25,p50,p75].
//      표본 부족(<MIN_N)이면 봉인하지 않는다 — 근거 없는 추정은 남기지 않는다(찍지 않기).
//   ② 채점 — 봉인 후 그 다음 달 실거래가 도착한 봉인들을 채점: 실제 ㎡당 중앙값이
//      밴드에 들었나(hit)·중앙값 오차%·커버리지. 결과는 봉인 블롭에 `result`로 덧붙이고
//      (봉인값 lo/mid/hi는 그대로 — 채점이 봉인을 수정하지 않는다) `mkt/agg`에 집계.
//      **멱등**: 이미 result가 있는 봉인은 건너뛴다(이중 집계 구조적 차단).
//
// 저장소 격리: mkt/seal/*, mkt/agg — 낙찰가 원장(pred/predb/agg/scored)과 완전 별개.
// 하트비트 `_run/mkt-seal-daily`. 외부 API 미호출(collect-rtms가 채운 블롭만 읽음).
// ?dry=1 봉인·채점 없이 계산 결과만 / ?debug=1 상세.

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const WIN = { apt: 6, offi: 6, rh: 12, sh: 12 }; // market-est·mkt-backtest와 동일 창
const MIN_N = 5;            // 봉인 최소 표본(창 내) — 미달이면 봉인 안 함
const MIN_ACTUAL_N = 1;     // 채점 최소 표본(다음 달)
const SEAL_VERSION = 'mkt-seal-v1';

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
function perM2List(trades) {
  const out = [];
  for (const t of trades || []) { if (t && t.amt > 0 && t.area > 0) out.push(t.amt / t.area); }
  return out;
}
function prevYm(ym, k) { let y = +ym.slice(0, 4), m = +ym.slice(4, 6) - k; while (m < 1) { m += 12; y--; } return `${y}${String(m).padStart(2, '0')}`; }
function nextYm(ym) { let y = +ym.slice(0, 4), m = +ym.slice(4, 6) + 1; if (m > 12) { m = 1; y++; } return `${y}${String(m).padStart(2, '0')}`; }
function kstYm() { const d = new Date(Date.now() + 9 * 3600 * 1000); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }

// as-of ym 기준 밴드 — ym 포함 이전 W개월 실거래만 사용(미래 미참조).
function bandFor(cellMonths, kind, ym) {
  const win = WIN[kind] || 6;
  const vals = [];
  for (let k = 0; k < win; k++) { const wm = prevYm(ym, k); if (cellMonths[wm]) vals.push(...perM2List(cellMonths[wm])); }
  if (vals.length < MIN_N) return null; // 근거 부족 → 봉인 안 함
  const s = vals.slice().sort((a, b) => a - b);
  const r1 = v => Math.round(v * 10) / 10;
  return { lo: r1(quantile(s, 0.25)), mid: r1(quantile(s, 0.5)), hi: r1(quantile(s, 0.75)), n: vals.length };
}

// 봉인 1건 채점 — 실제(다음 달) 거래로. 봉인값은 수정하지 않고 result만 만든다.
function gradeSeal(seal, actualTrades) {
  const vals = perM2List(actualTrades);
  if (vals.length < MIN_ACTUAL_N) return null;
  const actual = median(vals);
  if (!(actual > 0)) return null;
  const inBand = vals.filter(v => v >= seal.lo && v <= seal.hi).length;
  return {
    actual: Math.round(actual * 10) / 10,
    n: vals.length,
    hit: actual >= seal.lo && actual <= seal.hi ? 1 : 0,
    errPct: Math.round(Math.abs(seal.mid - actual) / actual * 1000) / 10,
    coverage: Math.round(inBand / vals.length * 1000) / 10,
    gradedAt: new Date().toISOString(),
  };
}

function emptyAgg() { return { n: 0, hit: 0, errSum: 0, covSum: 0, byKind: {}, byMonth: {} }; }
function tally(agg, kind, ym, res) {
  const bump = a => { a.n++; a.hit += res.hit; a.errSum += res.errPct; a.covSum += res.coverage; };
  bump(agg);
  bump(agg.byKind[kind] = agg.byKind[kind] || { n: 0, hit: 0, errSum: 0, covSum: 0 });
  bump(agg.byMonth[ym] = agg.byMonth[ym] || { n: 0, hit: 0, errSum: 0, covSum: 0 });
}
function fin(a) {
  return a && a.n ? { n: a.n, hitRate: Math.round(a.hit / a.n * 1000) / 10, avgErrPct: Math.round(a.errSum / a.n * 10) / 10, avgCoverage: Math.round(a.covSum / a.n * 10) / 10 } : { n: 0, hitRate: null, avgErrPct: null, avgCoverage: null };
}

exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  const dry = qs.dry === '1';
  const store = await openLedger(event);
  try {
    const meta = await store.get('mkt/rtms/_meta', { type: 'json' });
    if (!meta || !meta.records) {
      await store.setJSON('_run/mkt-seal-daily', { at: new Date().toISOString(), ok: true, noData: true });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, status: 'empty', note: 'RTMS 실거래 미수집 — collect-rtms가 채운 뒤 봉인이 시작됩니다.' }) };
    }

    // 셀-월 실거래 적재
    const listing = await store.list({ prefix: 'mkt/rtms/' });
    const keys = (listing && listing.blobs ? listing.blobs : []).map(b => b.key).filter(k => /^mkt\/rtms\/\d+_[a-z]+\/\d{6}$/.test(k));
    const cells = {};
    await mapLimit(keys, 40, async key => {
      const m = key.match(/^mkt\/rtms\/(\d+_[a-z]+)\/(\d{6})$/);
      if (!m) return;
      const trades = await store.get(key, { type: 'json' });
      if (Array.isArray(trades)) (cells[m[1]] = cells[m[1]] || {})[m[2]] = trades;
    });

    const nowYm = kstYm();
    let sealed = 0, skippedExisting = 0, noBasis = 0, graded = 0, alreadyGraded = 0, pending = 0;
    const agg = (await store.get('mkt/agg', { type: 'json' })) || null;
    const acc = emptyAgg();
    // 기존 집계는 누적이 아니라 매 실행 전체 재계산(봉인 블롭이 진실의 원천 — 이중집계 원천 차단)
    const cellNames = Object.keys(cells);

    for (const cell of cellNames) {
      const kind = cell.split('_')[1];
      const months = cells[cell];

      // ① 이번 달 봉인 (불변 — 이미 있으면 손대지 않음)
      const sealKey = `mkt/seal/${cell}/${nowYm}`;
      const existing = await store.get(sealKey, { type: 'json' });
      if (existing) { skippedExisting++; }
      else {
        const band = bandFor(months, kind, nowYm);
        if (!band) noBasis++;
        else if (!dry) {
          await store.setJSON(sealKey, { v: SEAL_VERSION, cell, kind, ym: nowYm, ...band, sealedAt: new Date().toISOString() });
          sealed++;
        } else sealed++;
      }
    }

    // ② 채점 — 봉인 목록을 훑어 "다음 달 실거래가 도착한" 것만
    const sealListing = await store.list({ prefix: 'mkt/seal/' });
    const sealKeys = (sealListing && sealListing.blobs ? sealListing.blobs : []).map(b => b.key).filter(k => /^mkt\/seal\/\d+_[a-z]+\/\d{6}$/.test(k));
    await mapLimit(sealKeys, 30, async key => {
      const m = key.match(/^mkt\/seal\/(\d+_[a-z]+)\/(\d{6})$/);
      if (!m) return;
      const cell = m[1], ym = m[2];
      const seal = await store.get(key, { type: 'json' });
      if (!seal) return;
      if (seal.result) { alreadyGraded++; tally(acc, seal.kind || cell.split('_')[1], ym, seal.result); return; } // 멱등 — 재채점 없음
      const actual = (cells[cell] || {})[nextYm(ym)];
      if (!actual) { pending++; return; } // 아직 정답 미도착
      const res = gradeSeal(seal, actual);
      if (!res) { pending++; return; }
      if (!dry) await store.setJSON(key, { ...seal, result: res }); // 봉인값 lo/mid/hi 불변, result만 덧붙임
      graded++;
      tally(acc, seal.kind || cell.split('_')[1], ym, res);
    });

    const byKind = {}; for (const k of Object.keys(acc.byKind)) byKind[k] = fin(acc.byKind[k]);
    const byMonth = Object.keys(acc.byMonth).sort().map(ym => ({ ym, ...fin(acc.byMonth[ym]) }));
    const summary = {
      v: SEAL_VERSION, updatedAt: new Date().toISOString(),
      overall: fin(acc), byKind, byMonth,
      cells: cellNames.length, sealsPending: pending,
      note: '시세 밴드를 결과 전에 봉인하고 이후 실거래로 채점 — 봉인은 수정하지 않음. 낙찰가 성적표와 별개 지표.',
    };
    if (!dry) await store.setJSON('mkt/agg', summary);
    await store.setJSON('_run/mkt-seal-daily', { at: new Date().toISOString(), ok: true, sealed, graded, pending });

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        ok: true, dry, ym: nowYm, sealed, skippedExisting, noBasis, graded, alreadyGraded, pending,
        summary, ...(qs.debug === '1' ? { prevAggN: agg && agg.overall ? agg.overall.n : null } : {}),
      }),
    };
  } catch (e) {
    try { await store.setJSON('_run/mkt-seal-daily', { at: new Date().toISOString(), ok: false, error: e.message }); } catch (_) { /* 무시 */ }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

exports._test = { bandFor, gradeSeal, prevYm, nextYm, perM2List, tally, fin, emptyAgg, WIN, MIN_N };
