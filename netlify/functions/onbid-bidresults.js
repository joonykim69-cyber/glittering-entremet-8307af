// netlify/functions/onbid-bidresults.js
// "차세대 온비드 물건 입찰결과 조회서비스"(목록) 프록시 — 낙찰/유찰/취소로 끝난
// 물건들의 개찰 결과 목록을 공급. 평균 낙찰가율 등 예측 통계 집계의 핵심 원천.
//
// 대상 서비스: 한국자산관리공사_차세대 온비드 물건 입찰결과목록 조회서비스
// Base URL https://apis.data.go.kr/B010003/OnbidCltrBidRsltListSrvc2 + /getCltrBidRsltList2
// — 2026-07-19 _health 일괄 점검에서 경로 실존 확인(NO_MANDATORY_PARAMS 응답).
//
// ⚠️ 남은 미확정: 필수 요청 파라미터 구성과 응답 필드명(특히 낙찰금액) —
//   ?debug=1 첫 실 응답으로 확정할 것. 기본 파라미터는 목록 계열 공통값을 채워둠.
//
// Netlify 환경변수 (모든 deploy context에 동일 값으로!):
//   ONBID_BIDRSLT_API_URL = 물건 입찰결과 조회서비스(목록) Base URL
//   ONBID_BIDRSLT_API_OP  = (선택) 오퍼레이션 경로 오버라이드
//   ONBID_SERVICE_KEY     = 기존 것 재사용

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// 2026-07-19 _health 점검으로 Base URL·op 존재 확인 (NO_MANDATORY_PARAMS 응답 = 경로 유효)
const ONBID_BIDRSLT_API_URL = process.env.ONBID_BIDRSLT_API_URL || 'https://apis.data.go.kr/B010003/OnbidCltrBidRsltListSrvc2';
const ONBID_BIDRSLT_OPERATION = process.env.ONBID_BIDRSLT_API_OP || '/getCltrBidRsltList2';

function parseAmt(v) {
  const n = parseInt(String(v ?? '').replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 결과 1건 tolerant 매핑 — 실 응답 확인 후 필드 확정
function mapResult(r) {
  const apslAmt = parseAmt(r.apslEvlAmt);
  const lowstAmt = parseAmt(r.lowstBidPrcIndctCont ?? r.lowstBidPrc ?? r.lowstBidAmt);
  const winAmt = parseAmt(r.nsmtAmt ?? r.sucsbidAmt ?? r.opbdMaxAmt ?? r.bidWinAmt ?? r.cntrctAmt);
  return {
    id: r.cltrMngNo || '',
    pbctCdtnNo: r.pbctCdtnNo != null ? String(r.pbctCdtnNo) : '',
    title: r.onbidCltrNm || r.cltrNm || '',
    usage: r.cltrUsgSclsCtgrNm || r.cltrUsgMclsCtgrNm || '',
    address: [r.lctnSdnm, r.lctnSggnm, r.lctnEmdNm].filter(Boolean).join(' '),
    apslAmt,       // 감정가 (원)
    lowstAmt,      // 최저입찰가 (원)
    winAmt,        // 낙찰금액 (원, 0=미확정/유찰)
    // 낙찰가율(%): 감정가 대비 — 통계 집계의 기준값
    winRate: winAmt > 0 && apslAmt > 0 ? Math.round(winAmt / apslAmt * 1000) / 10 : 0,
    statCd: r.pbctStatCd != null ? String(r.pbctStatCd).padStart(4, '0') : '',
    statNm: r.pbctStatNm || '',
    opbdDt: r.opbdDtm || r.cltrBidEndDt || '', // 개찰(마감) 일시
    usbdNft: Number(r.usbdNft) || 0,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: { message: 'Method not allowed' } }) };
  }

  const serviceKey = process.env.ONBID_SERVICE_KEY;
  if (!serviceKey) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: { message: 'ONBID_SERVICE_KEY not configured' } }) };
  }

  const qs = event.queryStringParameters || {};
  const params = new URLSearchParams({
    serviceKey,
    pageNo: qs.page || '1',
    numOfRows: qs.numOfRows || '50',
    resultType: 'json',
    // 목록 계열 공통 필수 후보 — NO_MANDATORY_PARAMS 응답 대응 (실 응답으로 확정 예정)
    pvctTrgtYn: qs.pvctTrgtYn || 'N',
    dspsMthodCd: qs.dspsMthodCd || '0001',
    bidDivCd: qs.bidDivCd || '0001',
  });
  const prptDivCdDefault = '0002,0003,0004,0005,0006,0007,0008,0010,0011,0013';
  // 검색 조건 passthrough — 실제 지원 파라미터는 승인 페이지/debug로 확인 후 조정
  for (const k of ['cltrMngNo', 'prptDivCd', 'lctnSdnm', 'bidPrdYmdStart', 'bidPrdYmdEnd', 'opbdYmdStart', 'opbdYmdEnd']) {
    if (qs[k]) params.set(k, qs[k]);
  }

  const prptDivCd = (qs.prptDivCd || prptDivCdDefault).replace(/[^0-9,]/g, '');
  const queryString = `${params.toString()}&prptDivCd=${prptDivCd}`;
  const upstreamUrl = `${ONBID_BIDRSLT_API_URL}${ONBID_BIDRSLT_OPERATION}?${queryString.replace(serviceKey, '***').replace(encodeURIComponent(serviceKey), '***')}`;

  try {
    const r = await fetch(`${ONBID_BIDRSLT_API_URL}${ONBID_BIDRSLT_OPERATION}?${queryString}`);
    const bodyText = await r.text();
    console.log('[onbid-bidresults] request:', upstreamUrl);
    console.log('[onbid-bidresults] upstream status:', r.status, '| body(첫 1000자):', bodyText.slice(0, 1000));

    let raw;
    try {
      raw = JSON.parse(bodyText);
    } catch (e) {
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({
          error: { message: '온비드 입찰결과 API가 JSON이 아닌 응답을 반환했습니다 — ?debug=1로 원본을 확인하세요.' },
          ...(qs.debug ? { debug: { upstreamUrl, rawSnippet: bodyText.slice(0, 800), upstreamStatus: r.status } } : {}),
        }),
      };
    }

    const env = raw?.response ?? raw;
    const header = env?.header;
    if (header && header.resultCode && header.resultCode !== '00') {
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({
          error: { message: `온비드 입찰결과 API 오류: ${header.resultCode} ${header.resultMsg || ''}` },
          ...(qs.debug ? { debug: { upstreamUrl, rawSnippet: bodyText.slice(0, 800) } } : {}),
        }),
      };
    }

    const itemsRaw = env?.body?.items?.item || [];
    const list = Array.isArray(itemsRaw) ? itemsRaw : [itemsRaw];
    const results = list.filter(Boolean).map(mapResult);

    // ?stats=1: 낙찰 건만 골라 낙찰가율 통계 요약 (예측 카드가 바로 쓸 수 있는 형태)
    let stats;
    if (qs.stats) {
      const sold = results.filter(x => x.winRate > 0);
      if (sold.length) {
        const rates = sold.map(x => x.winRate).sort((a, b) => a - b);
        const avg = Math.round(rates.reduce((s, v) => s + v, 0) / rates.length * 10) / 10;
        stats = { count: sold.length, avgWinRate: avg, minWinRate: rates[0], maxWinRate: rates[rates.length - 1], medianWinRate: rates[Math.floor(rates.length / 2)] };
      } else {
        stats = { count: 0 };
      }
    }

    const debug = qs.debug ? { header: header ?? '(header 없음)', upstreamUrl, rawSnippet: bodyText.slice(0, 2000) } : undefined;

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' },
      body: JSON.stringify({ results, totalCount: env?.body?.totalCount ?? results.length, ...(stats ? { stats } : {}), ...(debug ? { debug } : {}) }),
    };
  } catch (e) {
    console.log('[onbid-bidresults] fetch 실패:', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: { message: 'Proxy error: ' + e.message } }) };
  }
};
