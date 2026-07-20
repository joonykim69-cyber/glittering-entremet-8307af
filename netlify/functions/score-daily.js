// netlify/functions/score-daily.js
// 예측 장부 1단계 — "자동 채점" 예약 함수 (매일 KST 19:30, netlify.toml schedule)
//
// 최근 3일 개찰 결과(부동산·자동차·동산)를 조회해, 봉인된 예측(pred/*)과 대조한다.
//   - 구간 적중: lo ≤ 실제 낙찰가 ≤ hi
//   - 중앙값 오차: (mid - 낙찰가) / 낙찰가 — %와 원화 절대값 병기
//   - 가격대별(1억 미만/1~5억/5~10억/10억+) 분해 집계
// 채점 결과로 용도별 구간 폭 w를 보정한다(목표 적중률 95~98%):
//   표본 20건 이상에서 적중률 <95% → w +0.01 (최대 0.35) / >98% → w -0.005 (최소 0.06)
//   보정이 일어나면 학습 로그(log)에 기록 — 랜딩의 "모델이 학습하는 모습"의 원천.
//
// 수동 실행: GET /.netlify/functions/score-daily

const CORS = { 'Access-Control-Allow-Origin': '*' };
const TARGET_LO = 0.95, TARGET_HI = 0.98;

function kst() { return new Date(Date.now() + 9 * 3600 * 1000); }
function ymd(d) { return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`; }

function tierOf(winManwon) {
  if (winManwon < 10000) return 'lt1'; // 1억 미만
  if (winManwon < 50000) return 't1to5';
  if (winManwon < 100000) return 't5to10';
  return 'gte10';
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Lambda 호환(exports.handler) 함수에서는 Blobs 환경이 자동 구성되지 않아
// connectLambda(event)로 요청 이벤트의 Blobs 컨텍스트를 수동 연결해야 한다.
// (MissingBlobsEnvironmentError 대응 — 2026-07-19 프로덕션 첫 실행에서 확인)
async function openLedger(event) {
  const blobs = await import('@netlify/blobs');
  try { if (event && typeof blobs.connectLambda === 'function') blobs.connectLambda(event); } catch (e) { /* 신형 런타임은 자동 구성 */ }
  try {
    return blobs.getStore('ledger');
  } catch (e) {
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token = process.env.NETLIFY_BLOBS_TOKEN;
    if (siteID && token) return blobs.getStore({ name: 'ledger', siteID, token });
    throw e;
  }
}

exports.handler = async (event) => {
  const store = await openLedger(event);
  const base = process.env.URL || '';

  try {
    // 최근 3일 개찰 결과 수집 (자산군 3종 × 2페이지)
    const start = ymd(new Date(kst().getTime() - 3 * 86400000));
    const end = ymd(kst());
    const fetches = [];
    for (const cltrTypeCd of ['0001', '0002', '0003']) {
      for (const page of ['1', '2']) {
        fetches.push(fetchJson(`${base}/.netlify/functions/onbid-bidresults?cltrTypeCd=${cltrTypeCd}&numOfRows=100&page=${page}&opbdDtStart=${start}&opbdDtEnd=${end}`).catch(() => null));
      }
    }
    const responses = await Promise.all(fetches);
    const results = [];
    responses.forEach(d => { if (d && Array.isArray(d.results)) results.push(...d.results); });

    const agg = (await store.get('agg', { type: 'json' })) || {
      n: 0, hit: 0, sumAbsErrPct: 0,
      byTier: {}, byUsage: {}, daily: {},
    };
    const calib = (await store.get('calib', { type: 'json' })) || { byUsage: {} };
    // v0.5 챌린저(predb/*) 비교 집계 — 챔피언과 같은 물건에서만 채점되므로 공정 비교가 된다
    const aggB = (await store.get('aggB', { type: 'json' })) || { n: 0, hit: 0, sumAbsErrPct: 0, headToHead: { n: 0, bWins: 0 } };
    const log = (await store.get('log', { type: 'json' })) || [];
    const recent = (await store.get('recent', { type: 'json' })) || [];

    let graded = 0, noPred = 0, already = 0;
    const today = ymd(kst());

    for (const r of results) {
      if (!r.id || !r.pbctCdtnNo) continue;
      const scoredKey = `scored/${r.id}_${r.pbctCdtnNo}`;
      if (await store.get(scoredKey)) { already++; continue; }
      const pred = await store.get(`pred/${r.id}_${r.pbctCdtnNo}`, { type: 'json' });
      if (!pred) { noPred++; continue; }

      if (r.statCd !== '0010' || !(r.winAmt > 0)) {
        // 유찰은 다음 회차가 새 공매조건으로 다시 봉인되므로, 이 조건은 종결 처리
        if (r.statCd === '0011' || r.statCd === '0012') {
          await store.setJSON(scoredKey, { outcome: r.statCd === '0011' ? 'fail' : 'cancel', at: new Date().toISOString() });
        }
        continue;
      }

      const winMan = Math.round(r.winAmt / 10000); // 원 → 만원 (pred와 단위 통일)
      const hit = winMan >= pred.lo && winMan <= pred.hi;
      const errPct = Math.round((pred.mid - winMan) / winMan * 1000) / 10;
      const absErrMan = Math.abs(pred.mid - winMan);
      const tier = tierOf(winMan);
      const usage = pred.type || '기타';

      agg.n++; if (hit) agg.hit++;
      agg.sumAbsErrPct += Math.abs(errPct);
      agg.byTier[tier] = agg.byTier[tier] || { n: 0, hit: 0 };
      agg.byTier[tier].n++; if (hit) agg.byTier[tier].hit++;
      agg.byUsage[usage] = agg.byUsage[usage] || { n: 0, hit: 0 };
      agg.byUsage[usage].n++; if (hit) agg.byUsage[usage].hit++;
      agg.daily[today] = agg.daily[today] || { n: 0, hit: 0 };
      agg.daily[today].n++; if (hit) agg.daily[today].hit++;

      recent.unshift({
        id: r.id, title: pred.title || r.title || '', usage,
        win: winMan, lo: pred.lo, mid: pred.mid, hi: pred.hi,
        hit, errPct, absErrMan, tier, opbdDt: r.opbdDt || '', modelV: pred.modelV,
        scoredAt: new Date().toISOString(),
      });

      // ── v0.5 챌린저 채점 (있을 때만) — 같은 낙찰가로 구간 적중·오차를 병행 기록 ──
      const predB = await store.get(`predb/${r.id}_${r.pbctCdtnNo}`, { type: 'json' });
      let bCmp = null;
      if (predB && predB.lo) {
        const bHit = winMan >= predB.lo && winMan <= predB.hi;
        const bErrPct = Math.round((predB.mid - winMan) / winMan * 1000) / 10;
        aggB.n++; if (bHit) aggB.hit++;
        aggB.sumAbsErrPct += Math.abs(bErrPct);
        aggB.headToHead.n++;
        if (Math.abs(bErrPct) <= Math.abs(errPct)) aggB.headToHead.bWins++;
        bCmp = { hit: bHit, errPct: bErrPct, modelV: predB.modelV, cellKey: predB.cellKey };
      }

      await store.setJSON(scoredKey, { outcome: 'graded', hit, errPct, ...(bCmp ? { b: bCmp } : {}), at: new Date().toISOString() });
      graded++;
    }

    // ── 보정(calibration): 용도별 적중률로 구간 폭 w 조정 ──
    for (const [usage, s] of Object.entries(agg.byUsage)) {
      if (s.n < 20) continue;
      const rate = s.hit / s.n;
      const cur = calib.byUsage[usage] || { w: 0.18 };
      let next = cur.w;
      if (rate < TARGET_LO) next = Math.min(0.35, Math.round((cur.w + 0.01) * 1000) / 1000);
      else if (rate > TARGET_HI) next = Math.max(0.06, Math.round((cur.w - 0.005) * 1000) / 1000);
      if (next !== cur.w) {
        log.unshift({ at: new Date().toISOString(), usage, from: cur.w, to: next, n: s.n, hitRate: Math.round(rate * 1000) / 10 });
        calib.byUsage[usage] = { w: next, n: s.n };
      }
    }

    // 보존 한도
    while (recent.length > 50) recent.pop();
    while (log.length > 50) log.pop();
    const dailyKeys = Object.keys(agg.daily).sort();
    while (dailyKeys.length > 90) delete agg.daily[dailyKeys.shift()];
    agg.updatedAt = new Date().toISOString();

    aggB.updatedAt = new Date().toISOString();
    await Promise.all([
      store.setJSON('agg', agg),
      store.setJSON('aggB', aggB),
      store.setJSON('calib', calib),
      store.setJSON('log', log),
      store.setJSON('recent', recent),
    ]);

    const summary = { ok: true, fetched: results.length, graded, already, noPred, totals: { n: agg.n, hit: agg.hit }, challenger: { n: aggB.n, hit: aggB.hit, headToHead: aggB.headToHead } };
    console.log('[score-daily]', JSON.stringify(summary));
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(summary) };
  } catch (e) {
    console.log('[score-daily] 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
