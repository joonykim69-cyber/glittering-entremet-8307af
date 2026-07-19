// netlify/functions/onbid-mvast-search.js
// 온비드(캠코) "동산" 물건목록 조회 API 프록시 — 차량/기계장비/유가증권 등 동산 물건용
//
// 부동산 프록시(onbid-search.js)와 동일한 패턴. 대상 서비스는
// "한국자산관리공사_차세대 온비드 동산 물건목록 조회서비스" 계열
// (서비스 코드 OnbidMvast…, 사용자 data.go.kr 활용신청 승인 완료).
//
// ⚠️ 아직 미확정(첫 실 응답으로 확인 필요):
//  - 오퍼레이션 경로: 부동산(getRlstCltrList2) 패턴에서 유추한 기본값
//    '/getMvastCltrList2'를 쓰되, 다르면 ONBID_MVAST_API_OP 환경변수로 교체 (코드 재배포 불필요)
//  - 응답 필드명: 부동산과 동일 계열(cltrMngNo/onbidCltrNm/…)로 가정하고 tolerant 매핑.
//    ?debug=1 로 원본 응답 첫 800자를 확인한 뒤 필드 매핑을 다듬을 것.
//
// 필요 환경변수 (Netlify 대시보드):
//  - ONBID_SERVICE_KEY  : 기존 것 재사용 (data.go.kr 계정 공통 키)
//  - ONBID_MVAST_API_URL: 동산 물건목록 서비스 Base URL
//    (예: https://apis.data.go.kr/B010003/OnbidMvastListSrvc2 — 승인 페이지의 End Point 복사)
//  - ONBID_MVAST_API_OP : (선택) 오퍼레이션 경로가 기본값과 다를 때만

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const ONBID_MVAST_API_URL = process.env.ONBID_MVAST_API_URL;
const ONBID_MVAST_OPERATION = process.env.ONBID_MVAST_API_OP || '/getMvastCltrList2';

// 재산유형코드 — 부동산 프록시와 동일한 전체 코드셋 요청 (동산 서비스가 무시하면 무해)
const ALL_PRPT_DIV_CD = '0002,0003,0004,0005,0006,0007,0008,0010,0011,0013';

function fmtManwon(won) {
  const n = Number(won);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n / 10000);
}

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

// 동산 용도분류 → 프론트엔드 버킷 (bidcast-list.html의 type 칩과 일치해야 함)
const TYPE_KEYWORDS = [
  ['차량', ['승용', '승합', '화물', '차량', '자동차', '버스', '트럭', '특수차', '이륜', '오토바이', '지게차', '덤프']],
  ['기계장비', ['기계', '장비', '설비', '공작', '선반', '프레스', '사출', '중장비', '크레인']],
  ['유가증권', ['주식', '증권', '출자', '회원권', '채권', '수익권', '지분']],
  ['선박항공', ['선박', '요트', '어선', '항공', '헬기']],
];
function normalizeType(sclsCtgrNm) {
  const s = sclsCtgrNm || '';
  for (const [bucket, keywords] of TYPE_KEYWORDS) {
    if (keywords.some(k => s.includes(k))) return bucket;
  }
  return '기타동산';
}

const TYPE_ICONS = { 차량: '🚗', 기계장비: '⚙️', 유가증권: '📈', 선박항공: '🚢', 기타동산: '📦' };

function mapMvastItem(raw, idx) {
  const apprWon = Number(raw.apslEvlAmt) || 0;
  const minWonParsed = parseInt(String(raw.lowstBidPrcIndctCont || '').replace(/[^0-9]/g, ''), 10);
  const minWon = Number.isFinite(minWonParsed) && minWonParsed > 0 ? minWonParsed : apprWon;
  const failCount = Number(raw.usbdNft ?? 0) || 0;

  const type = normalizeType(raw.cltrUsgSclsCtgrNm || raw.cltrUsgMclsCtgrNm || raw.cltrNm);
  const address = [raw.lctnSdnm, raw.lctnSggnm, raw.lctnEmdNm].filter(Boolean).join(' ');
  let photo = /^https?:\/\//.test(raw.thnlImgUrlAdr || '') ? raw.thnlImgUrlAdr : '';
  if (photo) photo = photo.replace('downloadImageKind=THNL_NM', 'downloadImageKind=IMGE_NM');

  return {
    id: raw.cltrMngNo || `mvast-${idx}`,
    pbctCdtnNo: raw.pbctCdtnNo != null ? String(raw.pbctCdtnNo) : '',
    caseNo: raw.cltrMngNo && raw.pbctCdtnNo != null ? `${raw.cltrMngNo}-${raw.pbctCdtnNo}` : (raw.cltrMngNo || '-'),
    title: raw.onbidCltrNm || raw.cltrNm || '(물건명 미상)',
    address,
    court: raw.orgNm || raw.rqstOrgNm || '',
    region: normalizeRegion(raw.lctnSdnm),
    type,
    appr: fmtManwon(apprWon),
    min: fmtManwon(minWon),
    fail: failCount,
    status: raw.pbctStatCd === '0010' ? '낙찰' : '진행',
    tags: failCount > 0 ? ['#재매각'] : ['#신건'],
    views: 0,
    thumb: TYPE_ICONS[type] || '📦',
    photo,
    bidStart: raw.cltrBidBgngDt || '',
    bidEnd: raw.cltrBidEndDt || '',
    assetClass: '동산', // 프론트엔드에서 부동산 항목과 구분용
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: { message: 'Method not allowed' } }) };
  }

  const serviceKey = process.env.ONBID_SERVICE_KEY;
  if (!serviceKey) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: { message: 'Server service key not configured (ONBID_SERVICE_KEY)' } }) };
  }
  if (!ONBID_MVAST_API_URL) {
    // 아직 환경변수 미설정 — 명확한 501로 프론트엔드가 조용히 폴백하도록
    return {
      statusCode: 501,
      headers: CORS,
      body: JSON.stringify({ error: { message: 'ONBID_MVAST_API_URL not configured — data.go.kr 동산 물건목록 서비스의 End Point를 Netlify 환경변수에 설정하세요.' } }),
    };
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
  const upstreamUrl = `${ONBID_MVAST_API_URL}${ONBID_MVAST_OPERATION}?${queryString.replace(serviceKey, '***').replace(encodeURIComponent(serviceKey), '***')}`;
  try {
    const r = await fetch(`${ONBID_MVAST_API_URL}${ONBID_MVAST_OPERATION}?${queryString}`);
    const bodyText = await r.text();
    console.log('[onbid-mvast-search] request:', upstreamUrl);
    console.log('[onbid-mvast-search] upstream status:', r.status, '| body(첫 1000자):', bodyText.slice(0, 1000));

    let raw;
    try {
      raw = JSON.parse(bodyText);
    } catch (parseErr) {
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({ error: { message: '온비드 동산 API가 JSON이 아닌 응답을 반환했습니다 — ?debug=1로 원본을 확인하세요.' }, ...(qs.debug ? { debug: { upstreamUrl, rawSnippet: bodyText.slice(0, 800) } } : {}) }),
      };
    }

    const env = raw?.response ?? raw;
    const header = env?.header;
    if (header && header.resultCode && header.resultCode !== '00') {
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({ error: { message: `온비드 동산 API 오류: ${header.resultCode} ${header.resultMsg || ''}` }, ...(qs.debug ? { debug: { upstreamUrl, rawSnippet: bodyText.slice(0, 800) } } : {}) }),
      };
    }

    const itemsRaw = env?.body?.items?.item || [];
    const list = Array.isArray(itemsRaw) ? itemsRaw : [itemsRaw];
    const seen = new Set();
    const items = list.map(mapMvastItem).filter(it => {
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
    console.log('[onbid-mvast-search] fetch 자체 실패:', e.message);
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: { message: 'Proxy error: ' + e.message } }),
    };
  }
};
