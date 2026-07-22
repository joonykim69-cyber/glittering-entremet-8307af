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
      errBuckets: { le5: 0, le10: 0, le15: 0, le20: 0 }, byAsset: {}, // 랩 오차분포·자산군별 실측화
    };
    const calib = (await store.get('calib', { type: 'json' })) || { byUsage: {} };
    // v0.5 챌린저(predb/*) 비교 집계 — 챔피언과 같은 물건에서만 채점되므로 공정 비교가 된다
    const aggB = (await store.get('aggB', { type: 'json' })) || { n: 0, hit: 0, sumAbsErrPct: 0, headToHead: { n: 0, bWins: 0 } };
    // 모델 연혁 장부(chronicle) — "초기값 → 변경 → 결과"를 순차 기록하는 추가 전용 로그.
    // 봉인 장부처럼 과거 항목은 수정하지 않고 뒤에 붙이기만 한다.
    const chronicle = (await store.get('chronicle', { type: 'json' })) || [];
    if (chronicle.length === 0) {
      chronicle.push({
        kind: 'genesis', at: '2026-07-19T07:00:00+09:00',
        title: '모델 v0.1 가동 — 예측 봉인 시작',
        detail: {
          modelV: 'v0.1',
          formula: '앵커1 = 감정가 × 용도별 낙찰가율(rto1), 앵커2 = 최저가 × rto2, 중앙값 = 앵커 평균, 구간 = [낮은 앵커×(1-w) ~ 높은 앵커×(1+w)]',
          w0: 0.18, wRange: '0.06 ~ 0.35',
          wRule: '용도별 표본 20건 이상에서 적중률 95% 미만이면 w +0.01, 98% 초과면 w -0.005',
          statSrc: '캠코 압류재산 용도별 낙찰가율 공식 통계 (봉인 레코드에 기간 병기)',
          target: '구간 적중률 95~98% + 중앙값 오차 %·원화 병기',
          principle: '봉인 후 수정 불가 · 전수 채점 · 실측치만 공개',
        },
      });
    }
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
      // 구간 폭(낙찰가 대비 %) — "넓게 질러서 맞히기" 방지: 적중률은 폭과 함께 봐야 한다 (승격 기준)
      const widthPct = Math.round((pred.hi - pred.lo) / winMan * 1000) / 10;
      const absErrMan = Math.abs(pred.mid - winMan);
      const tier = tierOf(winMan);
      const usage = pred.type || '기타';

      agg.n++; if (hit) agg.hit++;
      agg.sumAbsErrPct += Math.abs(errPct);
      agg.sumWidthPct = (agg.sumWidthPct || 0) + widthPct;
      agg.byTier[tier] = agg.byTier[tier] || { n: 0, hit: 0 };
      agg.byTier[tier].n++; if (hit) agg.byTier[tier].hit++;
      agg.byUsage[usage] = agg.byUsage[usage] || { n: 0, hit: 0 };
      agg.byUsage[usage].n++; if (hit) agg.byUsage[usage].hit++;
      agg.daily[today] = agg.daily[today] || { n: 0, hit: 0 };
      agg.daily[today].n++; if (hit) agg.daily[today].hit++;
      // 랩 오차 분포(중앙값 오차 절대값의 누적 버킷) + 자산군별 적중률 실측화
      const aerr = Math.abs(errPct);
      agg.errBuckets = agg.errBuckets || { le5: 0, le10: 0, le15: 0, le20: 0 };
      if (aerr <= 5) agg.errBuckets.le5++;
      if (aerr <= 10) agg.errBuckets.le10++;
      if (aerr <= 15) agg.errBuckets.le15++;
      if (aerr <= 20) agg.errBuckets.le20++;
      const asset = pred.assetClass || '부동산';
      agg.byAsset = agg.byAsset || {};
      agg.byAsset[asset] = agg.byAsset[asset] || { n: 0, hit: 0 };
      agg.byAsset[asset].n++; if (hit) agg.byAsset[asset].hit++;

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
        aggB.sumWidthPct = (aggB.sumWidthPct || 0) + Math.round((predB.hi - predB.lo) / winMan * 1000) / 10;
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
        const hitRatePct = Math.round(rate * 1000) / 10;
        log.unshift({ at: new Date().toISOString(), usage, from: cur.w, to: next, n: s.n, hitRate: hitRatePct });
        calib.byUsage[usage] = { w: next, n: s.n };
        chronicle.push({
          kind: 'calib', at: new Date().toISOString(),
          title: `보정: ${usage} 구간 폭 ${cur.w} → ${next}`,
          detail: { usage, from: cur.w, to: next, basisN: s.n, hitRate: hitRatePct,
            reason: hitRatePct < 95 ? `적중률 ${hitRatePct}% < 목표 하한 95% → 구간 확대` : `적중률 ${hitRatePct}% > 목표 상한 98% → 구간 축소` },
        });
      }
    }

    // 보존 한도
    while (recent.length > 50) recent.pop();
    while (log.length > 50) log.pop();
    const dailyKeys = Object.keys(agg.daily).sort();
    while (dailyKeys.length > 90) delete agg.daily[dailyKeys.shift()];
    agg.updatedAt = new Date().toISOString();

    if (graded > 0) {
      chronicle.push({
        kind: 'daily', at: new Date().toISOString(),
        title: `채점 ${graded}건 — 누적 적중률 ${agg.n ? Math.round(agg.hit / agg.n * 1000) / 10 : 0}%`,
        detail: {
          gradedToday: graded, cumN: agg.n, cumHit: agg.hit,
          cumHitRate: agg.n ? Math.round(agg.hit / agg.n * 1000) / 10 : 0,
          cumAvgAbsErrPct: agg.n ? Math.round(agg.sumAbsErrPct / agg.n * 10) / 10 : 0,
          ...(aggB.n ? { challenger: { cumN: aggB.n, cumHitRate: Math.round(aggB.hit / aggB.n * 1000) / 10, headToHead: aggB.headToHead } } : {}),
        },
      });
    }
    while (chronicle.length > 500) chronicle.splice(1, 1); // genesis(0번)는 보존

    aggB.updatedAt = new Date().toISOString();
    await Promise.all([
      store.setJSON('chronicle', chronicle),
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
