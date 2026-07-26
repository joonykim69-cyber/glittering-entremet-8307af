// netlify/functions/curated.js
// 공개 GET — "오늘의 주목 물건" 큐레이션 목록(curated/latest)을 반환한다.
// predict-daily가 매일 07:00 KST 봉인과 같은 실행에서 산출·저장한 것을 그대로 노출.
// 데이터가 없으면(첫 실행 전) status:'empty' — 랜딩은 예시 유지 또는 섹션 숨김으로 degrade.
// 30분 CDN 캐시(하루 1회 갱신이라 신선도 충분).

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

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

exports.handler = async (event) => {
  try {
    const store = await openLedger(event);
    const data = await store.get('curated/latest', { type: 'json' });
    if (!data || !Array.isArray(data.items) || !data.items.length) {
      return { statusCode: 200, headers: { ...CORS, 'Cache-Control': 'no-store' }, body: JSON.stringify({ status: 'empty', note: '아직 큐레이션이 없습니다(첫 봉인 실행 대기).' }) };
    }
    return { statusCode: 200, headers: { ...CORS, 'Cache-Control': 'public, max-age=1800' }, body: JSON.stringify({ status: 'ok', ...data }) };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ status: 'error', error: e.message }) };
  }
};
