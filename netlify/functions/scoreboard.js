// netlify/functions/scoreboard.js
// 예측 장부 성적표 API — 랜딩·랩 페이지의 "살아있는 성적표" 데이터 공급.
// 집계(agg)·보정 계수(calib)·학습 로그(log)·최근 채점 사례(recent)·봉인 카운트(meta)를
// 한 번에 반환한다. 모두 predict-daily/score-daily가 쌓은 실측 데이터 — 예시 없음.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

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
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: { message: 'Method not allowed' } }) };
  }

  try {
    const store = await openLedger(event);
    const [agg, calib, log, recent, meta] = await Promise.all([
      store.get('agg', { type: 'json' }),
      store.get('calib', { type: 'json' }),
      store.get('log', { type: 'json' }),
      store.get('recent', { type: 'json' }),
      store.get('meta', { type: 'json' }),
    ]);

    const n = agg?.n || 0;
    const summary = n ? {
      n,
      hit: agg.hit,
      hitRate: Math.round(agg.hit / n * 1000) / 10,          // 구간 적중률 %
      avgAbsErrPct: Math.round(agg.sumAbsErrPct / n * 10) / 10, // 중앙값 평균 절대 오차 %
    } : { n: 0 };

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
      body: JSON.stringify({
        summary,
        byTier: agg?.byTier || {},
        byUsage: agg?.byUsage || {},
        daily: agg?.daily || {},
        calib: calib?.byUsage || {},
        learningLog: log || [],
        recent: (recent || []).slice(0, 20),
        sealDays: meta?.sealDays || {},
        lastSealAt: meta?.lastSealAt || null,
        updatedAt: agg?.updatedAt || null,
        modelV: 'v0.1',
        target: { hitRateLo: 95, hitRateHi: 98 },
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: { message: e.message } }) };
  }
};
