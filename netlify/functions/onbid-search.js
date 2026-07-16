// netlify/functions/onbid-search.js
// 온비드(캠코) 공매물건 조회 API 프록시 — bidcast-list.html의 실 데이터 연동용
//
// ⚠️ 연동 전 확인 필요 (README 참고):
// 신청된 서비스: 한국자산관리공사_차세대 온비드 부동산 물건목록 조회서비스
// End Point: https://apis.data.go.kr/B010003/OnbidRlstListSrvc2 (확인됨, 2026-07-16)
// data.go.kr은 자동화된 요청을 차단하고 있어(403) 이 파일 작성 시점에
// 오퍼레이션 경로와 정확한 응답 필드명은 직접 확인하지 못했습니다. 아래
// mapOnbidItem()의 필드명은 이 서비스 계열에서 일반적으로 쓰이는 필드명
// 기준의 최선 추정치입니다. 서비스 상세 페이지의 "활용신청 상세기능정보"
// 또는 첨부된 OpenAPI활용가이드 문서로 진짜 오퍼레이션명·응답 샘플을
// 확인하고, 아래 mapOnbidItem() 필드명을 맞춰 넣어야 합니다.
//
// data.go.kr API는 공통적으로:
//  - 인증키 파라미터명: serviceKey (URL-Decoding 키를 그대로 사용해야 하는 경우가 많음)
//  - 페이지네이션: pageNo, numOfRows
//  - 응답 포맷: type=json 지정 시 { response: { header:{resultCode,resultMsg}, body:{items:{item:[...]}, totalCount} } }
// 이 세 가지는 data.go.kr 전 서비스 공통 규격이라 신뢰도가 높습니다.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// 확인된 End Point: https://apis.data.go.kr/B010003/OnbidRlstListSrvc2
// (차세대 온비드 부동산 물건목록 조회서비스). 오퍼레이션 경로(예: /getOnbidRlstList)가
// 이 URL 뒤에 더 붙어야 할 수 있음 — 활용신청 상세기능정보에서 확인 필요.
// 코드 재배포 없이 바꿀 수 있도록 환경변수로 뺴둠.
const ONBID_API_URL = process.env.ONBID_API_URL;

function fmtManwon(won) {
  const n = Number(won);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n / 10000);
}

// 주소 앞 시/도 전체 명칭을 프론트엔드 필터 옵션(서울/경기/인천/부산/대구)의
// 짧은 표기와 맞춘다 — 안 맞으면 지역 필터가 항상 0건을 반환하게 됨.
const REGION_ALIASES = {
  '서울특별시': '서울', '서울시': '서울',
  '경기도': '경기',
  '인천광역시': '인천',
  '부산광역시': '부산',
  '대구광역시': '대구',
  '광주광역시': '광주',
  '대전광역시': '대전',
  '울산광역시': '울산',
  '세종특별자치시': '세종',
};
function normalizeRegion(fullAddress) {
  const first = (fullAddress || '').split(' ')[0] || '';
  return REGION_ALIASES[first] || first;
}

// 실제 온비드 자산분류(CTGR_FULL_NM)는 "다세대주택","임야","전답","특수차량" 등
// 프론트엔드의 6개 버킷(아파트/토지/상가/차량/기계장비/유가증권)보다 훨씬 세분화되어
// 있을 가능성이 높음 — 키워드 매칭으로 대략 버킷팅. 실 데이터로 카테고리 값을
// 확인한 뒤 정교화 필요 (매칭 안 되면 '기타'로 떨어져 필터에서 안 보일 수 있음).
const TYPE_KEYWORDS = [
  ['아파트', ['아파트']],
  ['토지', ['토지', '임야', '전답', '대지', '잡종지']],
  ['상가', ['상가', '점포', '근린', '건물', '주택', '오피스텔']],
  ['차량', ['차량', '자동차', '화물', '승용', '특수차']],
  ['기계장비', ['기계', '장비', '설비', '기구']],
  ['유가증권', ['증권', '주식', '회원권', '채권']],
];
function normalizeType(raw) {
  const s = raw || '';
  for (const [bucket, keywords] of TYPE_KEYWORDS) {
    if (keywords.some(k => s.includes(k))) return bucket;
  }
  return '기타';
}

const TYPE_ICONS = { 아파트:'🏢', 토지:'🏞️', 상가:'🏬', 차량:'🚗', 기계장비:'🏭', 유가증권:'📈', 기타:'📦' };

// ⚠️ 아래 필드명(CLTR_MNMT_NO 등)은 확인 전 추정치입니다.
// 실 응답을 받으면 이 함수만 고치면 됩니다 — 프론트엔드(bidcast-list.html)는
// 이 함수가 반환하는 정규화된 형태(id/type/region/court/title/... )만 소비합니다.
function mapOnbidItem(raw, idx) {
  const apprWon = raw.APSL_ASES_AVG_AMT ?? raw.APRSL_ASES_AMT ?? raw.AAPR_AMT ?? 0;
  const minWon = raw.MIN_BID_PRC ?? raw.MIN_BID_PRC_AMT ?? apprWon;
  const failCount = Number(raw.PBCT_CNT ?? raw.USCBD_CNT ?? 0) || 0;

  const type = normalizeType(raw.CTGR_FULL_NM || raw.GOODS_NM);

  return {
    id: raw.CLTR_MNMT_NO || raw.PLNM_NO || idx,
    caseNo: raw.PLNM_NO || raw.CLTR_MNMT_NO || '-',
    title: raw.CLTR_NM || raw.GOODS_NM || '(물건명 미상)',
    address: raw.LDNM_ADRS || raw.NMRD_ADRS || '',
    court: raw.ORG_NM || raw.DPSL_MTH_NM || '',
    region: normalizeRegion(raw.LDNM_ADRS || raw.NMRD_ADRS),
    type,
    appr: fmtManwon(apprWon),
    min: fmtManwon(minWon),
    fail: failCount,
    status: raw.PBCT_CLS_DTM && new Date(raw.PBCT_CLS_DTM) < new Date() ? '낙찰' : '진행',
    tags: failCount > 0 ? ['#재매각'] : ['#신건'],
    views: 0, // 온비드 API에 조회수 필드 없음 — 프론트엔드 표시용 기본값
    thumb: TYPE_ICONS[type] || '📦',
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: CORS,
      body: JSON.stringify({ error: { message: 'Method not allowed' } }),
    };
  }

  const serviceKey = process.env.ONBID_SERVICE_KEY;
  if (!serviceKey) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: { message: 'Server service key not configured (ONBID_SERVICE_KEY)' } }),
    };
  }
  if (!ONBID_API_URL) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: { message: 'ONBID_API_URL not configured — data.go.kr에서 발급받은 정확한 End Point를 Netlify 환경변수에 설정하세요.' } }),
    };
  }

  const qs = event.queryStringParameters || {};
  const pageNo = qs.page || '1';
  const numOfRows = qs.numOfRows || '20';

  const params = new URLSearchParams({
    serviceKey,
    pageNo,
    numOfRows,
    type: 'json',
  });
  // TODO(확인 필요): 실제 API의 지역/자산유형 검색 파라미터명으로 교체
  if (qs.region) params.set('LDNM_ADRS', qs.region);
  if (qs.type) params.set('CTGR_FULL_NM', qs.type);
  if (qs.keyword) params.set('CLTR_NM', qs.keyword);

  try {
    const r = await fetch(`${ONBID_API_URL}?${params.toString()}`);
    const raw = await r.json();

    const header = raw?.response?.header;
    if (header && header.resultCode && header.resultCode !== '00') {
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({ error: { message: `온비드 API 오류: ${header.resultCode} ${header.resultMsg || ''}` } }),
      };
    }

    const itemsRaw = raw?.response?.body?.items?.item || [];
    const list = Array.isArray(itemsRaw) ? itemsRaw : [itemsRaw];
    const items = list.map(mapOnbidItem);
    const totalCount = raw?.response?.body?.totalCount ?? items.length;

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, totalCount, pageNo: Number(pageNo), numOfRows: Number(numOfRows) }),
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: { message: 'Proxy error: ' + e.message } }),
    };
  }
};
