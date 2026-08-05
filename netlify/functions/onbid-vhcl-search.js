// netlify/functions/onbid-vhcl-search.js
// 온비드(캠코) "차량" 물건목록 조회 API 프록시 — 자동차 공매물건용 (부동산·동산과 별개 서비스)
//
// 대상 서비스: 한국자산관리공사_차세대 온비드 차량 물건목록 조회서비스 (활용신청 승인 완료)
//
// Base URL: https://apis.data.go.kr/B010003/OnbidCarListSrvc2
// — 2026-07-19 사용자 승인 페이지에서 확인 (차량 = "Car"). 오퍼레이션 경로는
// Mvast 패턴 유추 기본값 /getCarCltrList2 — 첫 실 응답(?debug=1)으로 검증:
//   ONBID_VHCL_API_URL = Base URL 오버라이드
//   ONBID_VHCL_API_OP  = 오퍼레이션 경로 오버라이드
//   ONBID_SERVICE_KEY  = 기존 것 재사용

const { normalizeServiceKey } = require('./lib/servicekey.js'); // Encoding/Decoding 키 모두 허용

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const ONBID_VHCL_API_URL = process.env.ONBID_VHCL_API_URL || 'https://apis.data.go.kr/B010003/OnbidCarListSrvc2';
const ONBID_VHCL_OPERATION = process.env.ONBID_VHCL_API_OP || '/getCarCltrList2';

const ALL_PRPT_DIV_CD = '0002,0003,0004,0005,0006,0007,0008,0010,0011,0013';

function fmtManwon(won) {
  const n = Number(won);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n / 10000);
}

const REGION_ALIASES = {
  '서울특별시': '서울', '서울시': '서울', '경기도': '경기', '인천광역시': '인천',
  '부산광역시': '부산', '대구광역시': '대구', '광주광역시': '광주', '대전광역시': '대전',
  '울산광역시': '울산', '세종특별자치시': '세종',
};

function mapVhclItem(raw, idx) {
  const apprWon = Number(raw.apslEvlAmt) || 0;
  const minWonParsed = parseInt(String(raw.lowstBidPrcIndctCont || '').replace(/[^0-9]/g, ''), 10);
  const minWon = Number.isFinite(minWonParsed) && minWonParsed > 0 ? minWonParsed : apprWon;
  const failCount = Number(raw.usbdNft ?? 0) || 0;
  const address = [raw.lctnSdnm, raw.lctnSggnm, raw.lctnEmdNm].filter(Boolean).join(' ');
  let photo = /^https?:\/\//.test(raw.thnlImgUrlAdr || '') ? raw.thnlImgUrlAdr : '';
  if (photo) photo = photo.replace('downloadImageKind=THNL_NM', 'downloadImageKind=IMGE_NM');

  return {
    id: raw.cltrMngNo || `vhcl-${idx}`,
    pbctCdtnNo: raw.pbctCdtnNo != null ? String(raw.pbctCdtnNo) : '',
    caseNo: raw.cltrMngNo && raw.pbctCdtnNo != null ? `${raw.cltrMngNo}-${raw.pbctCdtnNo}` : (raw.cltrMngNo || '-'),
    title: raw.onbidCltrNm || raw.cltrNm || '(물건명 미상)',
    address,
    court: raw.orgNm || raw.rqstOrgNm || '',
    region: REGION_ALIASES[raw.lctnSdnm] || raw.lctnSdnm || '',
    type: '차량', // 이 서비스는 차량 전용 — 버킷 고정
    appr: fmtManwon(apprWon),
    min: fmtManwon(minWon),
    fail: failCount,
    round: Number(raw.pbctNsq) || 0, // 공매차수(회차) 실측 — 예측 엔진 회차 셀 매칭용(없으면 0 → 유찰수+1 근사)
    status: raw.pbctStatCd === '0010' ? '낙찰' : '진행',
    tags: failCount > 0 ? ['#재매각'] : ['#신건'],
    views: 0,
    thumb: '🚗',
    photo,
    bidStart: raw.cltrBidBgngDt || '',
    bidEnd: raw.cltrBidEndDt || '',
    assetClass: '자동차',
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: { message: 'Method not allowed' } }) };
  }

  const serviceKey = normalizeServiceKey(process.env.ONBID_SERVICE_KEY);
  if (!serviceKey) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: { message: 'Server service key not configured (ONBID_SERVICE_KEY)' } }) };
  }

  const qs = event.queryStringParameters || {};
  const params = new URLSearchParams({
    serviceKey,
    pageNo: qs.page || '1',
    numOfRows: qs.numOfRows || '20',
    resultType: 'json',
    pvctTrgtYn: qs.pvctTrgtYn || 'N',
    dspsMthodCd: qs.dspsMthodCd || '0001',
    bidDivCd: qs.bidDivCd || '0001',
  });
  const REGION_FULL = {
    '서울': '서울특별시', '경기': '경기도', '인천': '인천광역시', '부산': '부산광역시',
    '대구': '대구광역시', '광주': '광주광역시', '대전': '대전광역시', '울산': '울산광역시', '세종': '세종특별자치시',
  };
  if (qs.region) params.set('lctnSdnm', REGION_FULL[qs.region] || qs.region);
  if (qs.keyword) params.set('onbidCltrNm', qs.keyword);
  if (qs.bidPrdYmdStart) params.set('bidPrdYmdStart', qs.bidPrdYmdStart.replace(/[^0-9]/g, ''));
  if (qs.bidPrdYmdEnd) params.set('bidPrdYmdEnd', qs.bidPrdYmdEnd.replace(/[^0-9]/g, ''));
  const prptDivCd = (qs.prptDivCd || ALL_PRPT_DIV_CD).replace(/[^0-9,]/g, '');

  const queryString = `${params.toString()}&prptDivCd=${prptDivCd}`;
  const upstreamUrl = `${ONBID_VHCL_API_URL}${ONBID_VHCL_OPERATION}?${queryString.replace(serviceKey, '***').replace(encodeURIComponent(serviceKey), '***')}`;

  try {
    const r = await fetch(`${ONBID_VHCL_API_URL}${ONBID_VHCL_OPERATION}?${queryString}`);
    const bodyText = await r.text();
    console.log('[onbid-vhcl-search] request:', upstreamUrl);
    console.log('[onbid-vhcl-search] upstream status:', r.status, '| body(첫 1000자):', bodyText.slice(0, 1000));

    let raw;
    try {
      raw = JSON.parse(bodyText);
    } catch (parseErr) {
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({ error: { message: '온비드 차량 API가 JSON이 아닌 응답을 반환했습니다 — ?debug=1로 원본을 확인하세요.' }, ...(qs.debug ? { debug: { upstreamUrl, rawSnippet: bodyText.slice(0, 800) } } : {}) }),
      };
    }

    const env = raw?.response ?? raw;
    const header = env?.header;
    if (header && header.resultCode && header.resultCode !== '00') {
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({ error: { message: `온비드 차량 API 오류: ${header.resultCode} ${header.resultMsg || ''}` }, ...(qs.debug ? { debug: { upstreamUrl, rawSnippet: bodyText.slice(0, 800) } } : {}) }),
      };
    }

    const itemsRaw = env?.body?.items?.item || [];
    const list = Array.isArray(itemsRaw) ? itemsRaw : [itemsRaw];
    const seen = new Set();
    const items = list.filter(Boolean).map(mapVhclItem).filter(it => {
      const k = String(it.id);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const totalCount = env?.body?.totalCount ?? items.length;

    const debug = qs.debug ? { header: header ?? '(header 없음)', upstreamUrl, rawSnippet: bodyText.slice(0, 800) } : undefined;

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, totalCount, ...(debug ? { debug } : {}) }),
    };
  } catch (e) {
    console.log('[onbid-vhcl-search] fetch 자체 실패:', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: { message: 'Proxy error: ' + e.message } }) };
  }
};
