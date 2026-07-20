// netlify/functions/onbid-mvast-detail.js
// "온비드 동산 물건상세 조회 서비스" 프록시 — 동산(차량/기계장비 등) 물건의 상세 항목용
//
// 대상 서비스: 한국자산관리공사_차세대 온비드 동산 물건상세 조회서비스
// (Base URL 예: https://apis.data.go.kr/B010003/OnbidMvastDtlSrvc2 —
//  사용자가 data.go.kr 활용신청 승인을 받은 서비스, 승인 페이지의 End Point를 환경변수로 설정)
//
// ✅ End Point/오퍼레이션 승인 페이지 확정(2026-07-20): Base OnbidMvastDtlSrvc2 / op '/getMvastDtlInf2',
//    필수 입력 cltrMngNo(물건관리번호)+pbctCdtnNo(공매조건번호). 다른 경우만 ONBID_MVAST_DETAIL_API_OP로 교체.
// 응답 필드는 부동산 상세와 동일 계열로 가정한 tolerant 매핑 + raw 동봉.
// 첫 실 응답을 ?debug=1로 확인한 뒤 매핑을 다듬을 것.
//
// Netlify 환경변수:
//   ONBID_MVAST_DETAIL_API_URL = 동산 물건상세 서비스 Base URL
//   ONBID_MVAST_DETAIL_API_OP  = (선택) 오퍼레이션 경로 오버라이드
//   ONBID_SERVICE_KEY          = 기존 것 재사용

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const ONBID_MVAST_DETAIL_API_URL = process.env.ONBID_MVAST_DETAIL_API_URL;
const ONBID_MVAST_DETAIL_OPERATION = process.env.ONBID_MVAST_DETAIL_API_OP || '/getMvastDtlInf2';

function mapDetail(body) {
  const arr = body?.items?.item;
  const d = Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
  if (!d) return { raw: body };

  function fmtDt(s) {
    const t = String(s || '');
    if (t.length < 12 || Number(t.slice(0, 4)) > 2099) return '';
    return `${t.slice(0,4)}.${t.slice(4,6)}.${t.slice(6,8)} ${t.slice(8,10)}:${t.slice(10,12)}`;
  }
  const bgng = fmtDt(d.cltrBidBgngDt), end = fmtDt(d.cltrBidEndDt);

  return {
    title: d.onbidCltrNm || d.cltrNm || '',
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
  if (!serviceKey || !ONBID_MVAST_DETAIL_API_URL) {
    return {
      statusCode: 501,
      headers: CORS,
      body: JSON.stringify({ error: { message: '동산 물건상세 API 미연동 — Netlify 환경변수에 ONBID_MVAST_DETAIL_API_URL을 설정하세요.' } }),
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
  const upstreamUrl = `${ONBID_MVAST_DETAIL_API_URL}${ONBID_MVAST_DETAIL_OPERATION}?${params.toString().replace(serviceKey, '***').replace(encodeURIComponent(serviceKey), '***')}`;

  try {
    const r = await fetch(`${ONBID_MVAST_DETAIL_API_URL}${ONBID_MVAST_DETAIL_OPERATION}?${params.toString()}`);
    const bodyText = await r.text();
    console.log('[onbid-mvast-detail] request:', upstreamUrl);
    console.log('[onbid-mvast-detail] upstream status:', r.status, '| body(첫 1000자):', bodyText.slice(0, 1000));

    let raw;
    try {
      raw = JSON.parse(bodyText);
    } catch (e) {
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({
          error: { message: '온비드 동산 상세 API가 JSON이 아닌 응답을 반환했습니다.' },
          ...(qs.debug ? { rawBody: bodyText.slice(0, 2000), upstreamStatus: r.status } : {}),
        }),
      };
    }

    const env = raw?.response ?? raw;
    const header = env?.header;
    if (header && header.resultCode && header.resultCode !== '00') {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: { message: `온비드 동산 상세 API 오류: ${header.resultCode} ${header.resultMsg || ''}` } }) };
    }

    const detail = mapDetail(env?.body ?? env);
    const debug = qs.debug ? { upstreamUrl, rawSnippet: bodyText.slice(0, 2000) } : undefined;

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ detail, ...(debug ? { debug } : {}) }),
    };
  } catch (e) {
    console.log('[onbid-mvast-detail] fetch 실패:', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: { message: 'Proxy error: ' + e.message } }) };
  }
};
