// netlify/functions/onbid-search.js
// 온비드(캠코) 부동산 물건목록 조회 API 프록시 — bidcast-list.html의 실 데이터 연동용
//
// 신청된 서비스: 한국자산관리공사_차세대 온비드 부동산 물건목록 조회서비스 v1.0.0
// Base URL: https://apis.data.go.kr/B010003/OnbidRlstListSrvc2
// 오퍼레이션: GET /getRlstCltrList2 (부동산 물건목록 정보조회)
// 아래 요청/응답 필드명은 2026-07-16, 사용자가 확보한 이 서비스의 Swagger 명세
// (data.go.kr 활용신청 상세 페이지에 내장된 swagger.json)로 전부 확인된 값입니다.
//
// ⚠️ 범위 제한: 이 API는 "부동산"만 다룹니다. 프론트엔드(bidcast-list.html)의
// 6개 타입 버킷 중 아파트/토지/상가만 이 API로 채워질 수 있고, 차량/기계장비/
// 유가증권은 다른 온비드 API(동산 계열)가 필요합니다 — 아직 미연동.
//
// data.go.kr API는 공통적으로:
//  - 인증키 파라미터명: serviceKey
//  - 페이지네이션: pageNo, numOfRows
//  - 응답 포맷: { response: { header:{resultCode,resultMsg}, body:{items:{item:[...]}, totalCount} } }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// ONBID_API_URL은 Base URL만 담는다 (예: https://apis.data.go.kr/B010003/OnbidRlstListSrvc2).
// 오퍼레이션 경로는 Swagger로 확인되어 코드에 고정.
const ONBID_API_URL = process.env.ONBID_API_URL;
const ONBID_OPERATION = '/getRlstCltrList2';

// 필수 파라미터 prptDivCd(재산유형코드, 복수는 쉼표 구분) — Swagger 확인된 전체 코드값.
// 특정 유형으로 좁히지 않는 한 전체를 요청해서 폭넓게 가져온다.
// 0002:공유재산 0003:금융권담보재산 0004:불용품 0005:기타일반재산 0006:유입재산
// 0007:압류재산 0008:수탁재산 0010:국유재산 0011:공공개발재산 0013:파산자산
const ALL_PRPT_DIV_CD = '0002,0003,0004,0005,0006,0007,0008,0010,0011,0013';

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
function normalizeRegion(sdnm) {
  return REGION_ALIASES[sdnm] || sdnm || '';
}

// 이 API는 부동산만 다루므로 응답의 cltrUsgSclsCtgrNm(용도소분류명, 예: 아파트/
// 연립주택/임야/전/답/대지/근린생활시설 등)을 프론트엔드 6개 버킷 중 부동산 관련
// 3개(아파트/토지/상가)로 키워드 매칭한다. 차량/기계장비/유가증권은 이 API로는
// 절대 나오지 않으므로 항상 '기타'로 떨어짐 — 다른 온비드 API 연동 전까지는 정상.
const TYPE_KEYWORDS = [
  ['아파트', ['아파트', '연립주택', '다세대']],
  ['토지', ['토지', '임야', '전', '답', '대지', '잡종지', '과수원', '목장용지']],
  ['상가', ['상가', '점포', '근린', '건물', '주택', '오피스텔', '공장', '창고']],
];
function normalizeType(sclsCtgrNm) {
  const s = sclsCtgrNm || '';
  for (const [bucket, keywords] of TYPE_KEYWORDS) {
    if (keywords.some(k => s.includes(k))) return bucket;
  }
  return '기타';
}

const TYPE_ICONS = { 아파트: '🏢', 토지: '🏞️', 상가: '🏬', 차량: '🚗', 기계장비: '🏭', 유가증권: '📈', 기타: '📦' };

// pbctStatCd(입찰결과구분코드): 0001 입찰준비중, 0002 입찰진행중, 0003 입찰마감,
// 0006 개찰중, 0009 수의계약가능, 0010 낙찰, 0011 유찰, 0012 취소.
// 프론트엔드는 '진행'/'낙찰' 두 가지만 구분하므로 0010만 낙찰로 매핑.
function mapOnbidItem(raw, idx) {
  const apprWon = Number(raw.apslEvlAmt) || 0;
  // lowstBidPrcIndctCont는 문자열(공개 시 금액, 비공개 시 "비공개" 등 텍스트)일 수 있어 숫자만 추출.
  const minWonParsed = parseInt(String(raw.lowstBidPrcIndctCont || '').replace(/[^0-9]/g, ''), 10);
  const minWon = Number.isFinite(minWonParsed) && minWonParsed > 0 ? minWonParsed : apprWon;
  const failCount = Number(raw.usbdNft ?? 0) || 0;

  const type = normalizeType(raw.cltrUsgSclsCtgrNm || raw.cltrUsgMclsCtgrNm);
  const address = [raw.lctnSdnm, raw.lctnSggnm, raw.lctnEmdNm].filter(Boolean).join(' ');
  // thnlImgUrlAdr(물건 썸네일 이미지 URL) — http(s) URL일 때만 통과 (HTML 삽입 안전장치)
  // downloadImageKind=THNL_NM(저해상도 썸네일) → IMGE_NM(원본 고해상도)으로 교체 시도.
  // IMGE_NM이 유효하지 않으면 img.onerror 폴백으로 이모지가 표시됨.
  let photo = /^https?:\/\//.test(raw.thnlImgUrlAdr || '') ? raw.thnlImgUrlAdr : '';
  if (photo) photo = photo.replace('downloadImageKind=THNL_NM', 'downloadImageKind=IMGE_NM');

  return {
    id: raw.cltrMngNo || idx,
    pbctCdtnNo: raw.pbctCdtnNo != null ? String(raw.pbctCdtnNo) : '',
    caseNo: raw.cltrMngNo && raw.pbctCdtnNo != null ? `${raw.cltrMngNo}-${raw.pbctCdtnNo}` : (raw.cltrMngNo || '-'),
    title: raw.onbidCltrNm || '(물건명 미상)',
    address,
    court: raw.orgNm || raw.rqstOrgNm || '',
    region: normalizeRegion(raw.lctnSdnm),
    type,
    usage: raw.cltrUsgSclsCtgrNm || raw.cltrUsgMclsCtgrNm || '', // 세부 용도 원문 — 상세 페이지의 실거래 서비스 매핑에 사용

    appr: fmtManwon(apprWon),
    min: fmtManwon(minWon),
    fail: failCount,
    round: Number(raw.pbctNsq) || 0, // 공매차수(회차) 실측 — 예측 엔진 회차 셀 매칭에 사용(없으면 0 → 소비 측이 유찰수+1로 근사)
    status: raw.pbctStatCd === '0010' ? '낙찰' : '진행',
    tags: failCount > 0 ? ['#재매각'] : ['#신건'],
    views: 0, // 온비드 API에 조회수 필드 없음 — 프론트엔드 표시용 기본값
    thumb: TYPE_ICONS[type] || '📦',
    photo, // 실사 썸네일 URL (없으면 빈 문자열 → 프론트엔드가 thumb 아이콘으로 폴백)
    // 입찰 기간 (Swagger 확인 필드, yyyyMMddHHmm 문자열) — 캘린더 집계·마감임박 표시용
    bidStart: raw.cltrBidBgngDt || '',
    bidEnd: raw.cltrBidEndDt || '',
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
      body: JSON.stringify({ error: { message: 'ONBID_API_URL not configured — data.go.kr에서 발급받은 Base URL을 Netlify 환경변수에 설정하세요.' } }),
    };
  }

  const qs = event.queryStringParameters || {};
  const pageNo = qs.page || '1';
  const numOfRows = qs.numOfRows || '20';

  const params = new URLSearchParams({
    serviceKey,
    pageNo,
    numOfRows,
    resultType: 'json',
    pvctTrgtYn: qs.pvctTrgtYn || 'N',
    // data.go.kr 활용신청 상세기능정보의 요청 파라미터 표에서는 이 둘도 "필수"로 표기됨
    // (Swagger의 required:false와 상충) — 누락 시 에러 대신 0건을 반환할 수 있어 기본값을 채운다.
    dspsMthodCd: qs.dspsMthodCd || '0001', // 처분방식: 0001 매각
    bidDivCd: qs.bidDivCd || '0001',       // 입찰구분: 0001 인터넷
  });
  // 프론트엔드 필터는 짧은 표기(서울/경기/...)를 쓰지만 온비드 lctnSdnm은
  // 전체 시도명(서울특별시/경기도/...)을 기대함 — 역방향 매핑 후 전달.
  const REGION_FULL = {
    '서울': '서울특별시', '경기': '경기도', '인천': '인천광역시', '부산': '부산광역시',
    '대구': '대구광역시', '광주': '광주광역시', '대전': '대전광역시', '울산': '울산광역시', '세종': '세종특별자치시',
  };
  if (qs.region) params.set('lctnSdnm', REGION_FULL[qs.region] || qs.region);
  if (qs.keyword) params.set('onbidCltrNm', qs.keyword);
  // 입찰기간 검색 (Swagger 확인 파라미터, yyyyMMdd) — onbid-calendar.js의 일자별 집계에 사용
  if (qs.bidPrdYmdStart) params.set('bidPrdYmdStart', qs.bidPrdYmdStart.replace(/[^0-9]/g, ''));
  if (qs.bidPrdYmdEnd) params.set('bidPrdYmdEnd', qs.bidPrdYmdEnd.replace(/[^0-9]/g, ''));
  // prptDivCd는 URLSearchParams에 넣지 않고 쉼표를 인코딩(%2C)하지 않은 원문 그대로 붙인다 —
  // data.go.kr 계열 API 중 인코딩된 쉼표를 복수값 구분자로 인식하지 못하는 경우가 있음.
  const prptDivCd = (qs.prptDivCd || ALL_PRPT_DIV_CD).replace(/[^0-9,]/g, '');
  // qs.type(아파트/토지/상가 등)은 API의 용도분류 코드값을 몰라 상류로 전달하지
  // 않는다 — mapOnbidItem()의 normalizeType()으로 응답을 받은 뒤 정규화하고,
  // 실제 버킷 필터링은 프론트엔드의 applyFilters()가 클라이언트 사이드에서 처리.

  const queryString = `${params.toString()}&prptDivCd=${prptDivCd}`;
  const upstreamUrl = `${ONBID_API_URL}${ONBID_OPERATION}?${queryString.replace(serviceKey, '***').replace(encodeURIComponent(serviceKey), '***')}`;
  try {
    const r = await fetch(`${ONBID_API_URL}${ONBID_OPERATION}?${queryString}`);
    const bodyText = await r.text();
    console.log('[onbid-search] request:', upstreamUrl);
    console.log('[onbid-search] upstream status:', r.status, '| body(첫 1000자):', bodyText.slice(0, 1000));

    let raw;
    try {
      raw = JSON.parse(bodyText);
    } catch (parseErr) {
      // resultType=json을 요청했지만 XML/HTML 등 비-JSON 응답이 온 경우 — 위 로그의 body로 원인 확인
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({ error: { message: '온비드 API가 JSON이 아닌 응답을 반환했습니다 — Netlify Functions 로그에서 원본 응답을 확인하세요.' } }),
      };
    }

    // 실 응답 확인 결과(2026-07-17), 이 차세대 API는 data.go.kr 공통 규격과 달리
    // {response:{header,body}} 래퍼 없이 {header, body}가 최상위에 온다.
    // 혹시 모를 규격 변경에 대비해 두 형태 모두 허용.
    const env = raw?.response ?? raw;
    const header = env?.header;
    if (header && header.resultCode && header.resultCode !== '00') {
      console.log('[onbid-search] 온비드 API 오류 코드:', header.resultCode, header.resultMsg);
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({ error: { message: `온비드 API 오류: ${header.resultCode} ${header.resultMsg || ''}` } }),
      };
    }

    const itemsRaw = env?.body?.items?.item || [];
    const list = Array.isArray(itemsRaw) ? itemsRaw : [itemsRaw];
    // 온비드는 같은 물건을 공매조건(회차)별로 별도 행으로 반환한다 —
    // cltrMngNo 기준 첫 행만 남겨 같은 물건 카드가 반복 표시되는 것을 방지.
    const seen = new Set();
    const items = list.map(mapOnbidItem).filter(it => {
      const k = String(it.id);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const totalCount = env?.body?.totalCount ?? items.length;
    console.log('[onbid-search] 정상 응답 — 매핑된 물건 수:', items.length, '/ totalCount:', totalCount);

    // ?debug=1일 때만 온비드 원본 응답 일부와 실제 요청 파라미터를 응답에 포함 —
    // Netlify 대시보드 함수 로그 접근이 막혀있는 환경에서 브라우저로 바로 원인 확인용.
    const debug = qs.debug ? {
      header: header ?? '(response.header 없음 — rawSnippet에서 실제 구조 확인)',
      prptDivCd, pvctTrgtYn: params.get('pvctTrgtYn'),
      dspsMthodCd: params.get('dspsMthodCd'), bidDivCd: params.get('bidDivCd'),
      upstreamUrl,
      rawSnippet: bodyText.slice(0, 800),
    } : undefined;

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, totalCount, pageNo: Number(pageNo), numOfRows: Number(numOfRows), ...(debug ? { debug } : {}) }),
    };
  } catch (e) {
    console.log('[onbid-search] fetch 자체 실패:', e.message);
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: { message: 'Proxy error: ' + e.message } }),
    };
  }
};
