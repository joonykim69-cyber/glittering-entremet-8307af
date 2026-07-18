// netlify/functions/onbid-detail.js
// "온비드 부동산 물건상세 조회 서비스" 프록시 — bidcast-detail.html의 상세 항목
// (물건명·지목·면적·감정평가·임대차·등기사항·사진 등) 실 데이터 공급용.
//
// 신청된 서비스: 한국자산관리공사_차세대 온비드 부동산 물건상세 조회서비스
// Base URL: https://apis.data.go.kr/B010003/OnbidRlstDtlSrvc2
// 오퍼레이션: GET /getRlstDtlInf2 (부동산 물건상세정보 조회)
// 아래 요청 파라미터는 2026-07-18, data.go.kr 활용신청 상세기능정보에서 확인된 값입니다.
//
// 응답 필드명은 첫 실 응답 확인 후 mapDetail()에 매핑 예정 — 그 전까지는
// 원본을 그대로 전달하고 ?debug=1로 브라우저에서 구조를 확인할 수 있습니다.
//
// Netlify 환경변수:
//   ONBID_DETAIL_API_URL = https://apis.data.go.kr/B010003/OnbidRlstDtlSrvc2
//   ONBID_SERVICE_KEY    = (목록 서비스와 동일한 인증키 — 이미 설정됨)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const ONBID_DETAIL_API_URL = process.env.ONBID_DETAIL_API_URL;
const ONBID_DETAIL_OPERATION = '/getRlstDtlInf2';

// 실 응답 확인 후 필드 매핑을 채울 자리 — 현재는 원본 전달.
// 활용가이드에 언급된 응답 항목: 물건관리번호, 물건명, 지목, 면적,
// 공고공지사항, 일괄입찰물건, 감정평가정보, 임대차정보,
// 등기사항증명서주요정보목록, 사진URL, 동영상URL, 위치도URL,
// 지번PNU코드, 도로명PNU코드
function mapDetail(raw) {
  return { raw };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: { message: 'Method not allowed' } }) };
  }

  const serviceKey = process.env.ONBID_SERVICE_KEY;
  if (!serviceKey || !ONBID_DETAIL_API_URL) {
    return {
      statusCode: 501,
      headers: CORS,
      body: JSON.stringify({ error: { message: '물건상세 API 미연동 — Netlify 환경변수에 ONBID_DETAIL_API_URL을 설정하세요.' } }),
    };
  }

  const qs = event.queryStringParameters || {};
  if (!qs.cltrMngNo || !qs.pbctCdtnNo) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: { message: 'cltrMngNo와 pbctCdtnNo가 모두 필요합니다.' } }) };
  }

  const params = new URLSearchParams({
    serviceKey,
    pageNo: '1',
    numOfRows: '10',
    resultType: 'json',
    cltrMngNo: qs.cltrMngNo,
    pbctCdtnNo: qs.pbctCdtnNo,
  });
  const upstreamUrl = `${ONBID_DETAIL_API_URL}${ONBID_DETAIL_OPERATION}?${params.toString().replace(serviceKey, '***').replace(encodeURIComponent(serviceKey), '***')}`;

  try {
    const r = await fetch(`${ONBID_DETAIL_API_URL}${ONBID_DETAIL_OPERATION}?${params.toString()}`);
    const bodyText = await r.text();
    console.log('[onbid-detail] request:', upstreamUrl);
    console.log('[onbid-detail] upstream status:', r.status, '| body(첫 1000자):', bodyText.slice(0, 1000));

    let raw;
    try {
      raw = JSON.parse(bodyText);
    } catch (e) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: { message: '온비드 상세 API가 JSON이 아닌 응답을 반환했습니다.' } }) };
    }

    // 목록 API와 동일 패턴: {response:{header,body}} 또는 최상위 {header,body}
    const env = raw?.response ?? raw;
    const header = env?.header;
    if (header && header.resultCode && header.resultCode !== '00') {
      console.log('[onbid-detail] 온비드 API 오류 코드:', header.resultCode, header.resultMsg);
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: { message: `온비드 상세 API 오류: ${header.resultCode} ${header.resultMsg || ''}` } }) };
    }

    const detail = mapDetail(env?.body ?? env);
    const debug = qs.debug ? {
      upstreamUrl,
      rawSnippet: bodyText.slice(0, 2000),
    } : undefined;

    console.log('[onbid-detail] 정상 응답 — cltrMngNo:', qs.cltrMngNo);
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ detail, ...(debug ? { debug } : {}) }),
    };
  } catch (e) {
    console.log('[onbid-detail] fetch 실패:', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: { message: 'Proxy error: ' + e.message } }) };
  }
};
