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

// 2026-07-18 실 응답 기준 확인된 필드명으로 매핑.
// body.items.item[0] 구조. 토지면적/건물면적/층수/건축년도는 이 API에 없음.
function mapDetail(body) {
  const arr = body?.items?.item;
  const d = Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
  if (!d) return { raw: body };

  // 입찰 일시: YYYYMMDDHHMI(12자리) → "YYYY.MM.DD HH:MM" (2099 초과면 미정)
  function fmtDt(s) {
    const t = String(s || '');
    if (t.length < 12 || Number(t.slice(0, 4)) > 2099) return '';
    return `${t.slice(0,4)}.${t.slice(4,6)}.${t.slice(6,8)} ${t.slice(8,10)}:${t.slice(10,12)}`;
  }
  const bgng = fmtDt(d.cltrBidBgngDt), end = fmtDt(d.cltrBidEndDt);

  return {
    title: d.onbidCltrNm || '',
    prptDivNm: d.prptDivNm || '',
    usageLcls: d.cltrUsgLclsCtgrNm || '',
    usageMcls: d.cltrUsgMclsCtgrNm || '',
    usageScls: d.cltrUsgSclsCtgrNm || '',
    disposeMethod: d.dspsMthodNm || '매각',
    bidDiv: d.bidDivNm || '',
    bidMethod: d.bidMthodNm || '',
    competeMethod: d.cptnMthodNm || '',
    apslEvlAmt: Number(d.apslEvlAmt) || 0,
    lowstBidAmt: parseInt(String(d.lowstBidPrcIndctCont || '').replace(/[^0-9]/g, ''), 10) || 0,
    usbdNft: Number(d.usbdNft) || 0,
    period: bgng && end ? `${bgng} ~ ${end}` : '',
    ltnoPnu: d.ltnoPnu || '',
    roadAddrPnu: d.roadAddrPnu || '',
    roadAddr: d.cltrRadr || '', // 도로명 주소 (카카오 지오코딩용 — 예 "경기도 평택시 송탄로 89, 201호 (장당동)")
    lotAddr: d.zadrNm || '',    // 지번 주소 (예 "경기도 평택시 장당동 483-6 201호")
    leasInfList: Array.isArray(d.leasInfList) ? d.leasInfList : [],
    rgstPrmrInfList: Array.isArray(d.rgstPrmrInfList) ? d.rgstPrmrInfList : [],
    ocpyRelList: Array.isArray(d.ocpyRelList) ? d.ocpyRelList : [],
    dtbtRqrMtrsList: Array.isArray(d.dtbtRqrMtrsList) ? d.dtbtRqrMtrsList : [],
    raw: body,
  };
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
      console.log('[onbid-detail] JSON 파싱 실패 — 원본:', bodyText.slice(0, 500));
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({
          error: { message: '온비드 상세 API가 JSON이 아닌 응답을 반환했습니다.' },
          ...(qs.debug ? { rawBody: bodyText.slice(0, 2000), upstreamStatus: r.status } : {}),
        }),
      };
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
