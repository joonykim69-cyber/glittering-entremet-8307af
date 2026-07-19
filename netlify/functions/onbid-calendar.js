// netlify/functions/onbid-calendar.js
// 이번 주(월~금) 일자별 입찰 진행 물건 수 집계 — bidcast.html 캘린더 미리보기의 실 데이터 소스
//
// 동작: 온비드 부동산 물건목록 API(getRlstCltrList2)를 일자별로
// bidPrdYmdStart=bidPrdYmdEnd=해당일 + numOfRows=1 로 호출해 totalCount만 읽는다
// (Swagger 확인 파라미터: bidPrdYmdStart/bidPrdYmdEnd, yyyyMMdd).
// 5개 요청을 병렬 실행하므로 페이지당 upstream 5회 — 프로토타입 트래픽 수준에서 허용 범위.
//
// ⚠️ 이 API는 부동산만 집계한다. 동산 목록 API(onbid-mvast-search.js)가 연동되면
// 동일 방식으로 합산하도록 확장할 것.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const ONBID_API_URL = process.env.ONBID_API_URL;
const ONBID_OPERATION = '/getRlstCltrList2';
const ALL_PRPT_DIV_CD = '0002,0003,0004,0005,0006,0007,0008,0010,0011,0013';

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// KST(UTC+9) 기준 오늘 — Netlify 함수는 UTC로 돌므로 보정 필수
function todayKST() {
  return new Date(Date.now() + 9 * 3600 * 1000);
}

async function countForDay(serviceKey, dayYmd) {
  const params = new URLSearchParams({
    serviceKey,
    pageNo: '1',
    numOfRows: '1',
    resultType: 'json',
    pvctTrgtYn: 'N',
    dspsMthodCd: '0001',
    bidDivCd: '0001',
    bidPrdYmdStart: dayYmd,
    bidPrdYmdEnd: dayYmd,
  });
  const url = `${ONBID_API_URL}${ONBID_OPERATION}?${params.toString()}&prptDivCd=${ALL_PRPT_DIV_CD}`;
  const r = await fetch(url);
  const raw = JSON.parse(await r.text());
  const env = raw?.response ?? raw;
  const header = env?.header;
  if (header && header.resultCode && header.resultCode !== '00') {
    throw new Error(`온비드 API 오류: ${header.resultCode}`);
  }
  return Number(env?.body?.totalCount) || 0;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: { message: 'Method not allowed' } }) };
  }

  const serviceKey = process.env.ONBID_SERVICE_KEY;
  if (!serviceKey || !ONBID_API_URL) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: { message: 'ONBID_SERVICE_KEY / ONBID_API_URL not configured' } }),
    };
  }

  try {
    // 이번 주 월~금 (오늘이 주말이면 다음 주 월~금)
    const now = todayKST();
    const dow = now.getUTCDay(); // KST 보정된 시각의 UTC 요일 = KST 요일
    let monOffset = 1 - dow; // 월요일까지의 오프셋
    if (dow === 0) monOffset = 1;       // 일요일 → 내일(월)
    else if (dow === 6) monOffset = 2;  // 토요일 → 모레(월)
    const days = [];
    for (let i = 0; i < 5; i++) {
      const d = new Date(now.getTime() + (monOffset + i) * 86400000);
      days.push({ ymd: ymd(d), dow: ['일', '월', '화', '수', '목', '금', '토'][d.getUTCDay()] });
    }

    const counts = await Promise.all(days.map(d => countForDay(serviceKey, d.ymd)));
    const result = days.map((d, i) => ({ ...d, count: counts[i] }));

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' },
      body: JSON.stringify({ days: result, scope: '부동산', generatedAt: new Date().toISOString() }),
    };
  } catch (e) {
    console.log('[onbid-calendar] 집계 실패:', e.message);
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: { message: 'Calendar aggregation failed: ' + e.message } }),
    };
  }
};
