// netlify/functions/onbid-detail.js
// "온비드 부동산 물건상세 조회 서비스" 프록시 스캐폴드 — bidcast-detail.html의 상세 항목
// (입찰이력·면적·입찰기간·권리 관련 원문 등) 실 데이터 공급용.
//
// ⚠️ 아직 미완성 (의도된 상태):
// 이 서비스는 data.go.kr에서 별도 활용신청이 필요하며(물건목록 조회서비스와 다른 서비스),
// 신청 전이라 End Point·오퍼레이션 경로·응답 필드명이 모두 미확인입니다.
// 목록 서비스(OnbidRlstListSrvc2)의 설명문에서 확인된 것: 조회 키는
// 물건관리번호(cltrMngNo) + 공매조건번호(pbctCdtnNo) 두 개를 함께 넘긴다는 것뿐.
//
// 완성 절차 (목록 서비스 때와 동일한 방식):
// 1. data.go.kr에서 "차세대 온비드 부동산 물건상세 조회 서비스" 활용신청
// 2. 승인 후 상세 페이지의 Swagger에서 End Point·오퍼레이션·응답 모델 확인
// 3. Netlify 환경변수 ONBID_DETAIL_API_URL(Base URL)·ONBID_DETAIL_OPERATION(경로) 설정
// 4. 실 응답(?debug=1)을 보고 아래 mapDetail()에 필드 매핑 작성
// 5. bidcast-detail.html에서 이 함수를 호출해 스냅샷 렌더링을 실 상세로 교체
//
// 환경변수 미설정 시 명확한 501을 반환하므로 배포되어 있어도 무해합니다.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const ONBID_DETAIL_API_URL = process.env.ONBID_DETAIL_API_URL;
const ONBID_DETAIL_OPERATION = process.env.ONBID_DETAIL_OPERATION || '';

// TODO(스키마 확인 후 작성): 실 응답 필드 → 프론트엔드 소비 형태 매핑.
// 스키마 확인 전에는 원본을 그대로 담아 debug로만 노출한다.
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
      body: JSON.stringify({ error: { message: '물건상세 API 미연동 — data.go.kr에서 상세 조회 서비스 신청 후 ONBID_DETAIL_API_URL을 설정하세요.' } }),
    };
  }

  const qs = event.queryStringParameters || {};
  if (!qs.cltrMngNo || !qs.pbctCdtnNo) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: { message: 'cltrMngNo와 pbctCdtnNo가 모두 필요합니다.' } }) };
  }

  const params = new URLSearchParams({
    serviceKey,
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

    // 목록 API에서 확인된 패턴: response 래퍼가 있을 수도, 최상위 header/body일 수도 있음
    const env = raw?.response ?? raw;
    const header = env?.header;
    if (header && header.resultCode && header.resultCode !== '00') {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: { message: `온비드 상세 API 오류: ${header.resultCode} ${header.resultMsg || ''}` } }) };
    }

    const detail = mapDetail(env?.body ?? env);
    const debug = qs.debug ? { upstreamUrl, rawSnippet: bodyText.slice(0, 800) } : undefined;
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
