// netlify/functions/onbid-bidinfo.js
// "차세대 온비드 물건 입찰결과상세 조회서비스" 프록시 — 물건(부동산/동산/자동차)의
// 개찰 결과(낙찰/유찰/취소) 상세 정보를 공급. 낙찰가 예측 통계의 원천 데이터.
//
// 대상 서비스: 한국자산관리공사_차세대 온비드 물건 입찰결과상세 조회서비스
// Base URL: https://apis.data.go.kr/B010003/OnbidCltrBidRsltDtlSrvc2
// 오퍼레이션: GET /getCltrBidRsltDtl2 (물건 입찰결과상세 조회)
// — 2026-07-19 사용자 활용신청 승인 페이지에서 확인된 값 (일일 트래픽 1000)
//
// ⚠️ 응답 필드명은 아직 미확정 — 첫 실 응답을 ?debug=1로 확인 후 mapRound()의
//    필드 후보(특히 낙찰금액)를 확정할 것. 요청 파라미터도 cltrMngNo 외에
//    추가 필수값이 있으면 debug의 오류 메시지로 드러남.
//
// Netlify 환경변수 (모든 deploy context에 동일 값으로!):
//   ONBID_BIDINFO_API_URL = 물건상세 입찰정보 서비스 Base URL
//   ONBID_BIDINFO_API_OP  = (선택) 오퍼레이션 경로 오버라이드
//   ONBID_SERVICE_KEY     = 기존 것 재사용

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// 승인 페이지에서 확인된 Base URL을 기본값으로 — env는 오버라이드 용도로만
const ONBID_BIDINFO_API_URL = process.env.ONBID_BIDINFO_API_URL || 'https://apis.data.go.kr/B010003/OnbidCltrBidRsltDtlSrvc2';
const ONBID_BIDINFO_OPERATION = process.env.ONBID_BIDINFO_API_OP || '/getCltrBidRsltDtl2';

// pbctStatCd → 표시명 (부동산 목록 Swagger의 코드표 재사용)
const STAT_NAMES = {
  '0001': '입찰준비중', '0002': '입찰진행중', '0003': '입찰마감', '0006': '개찰중',
  '0009': '수의계약가능', '0010': '낙찰', '0011': '유찰', '0012': '취소',
};

function parseAmt(v) {
  const n = parseInt(String(v ?? '').replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 회차 1건 매핑 — 입찰결과목록 실 응답(2026-07-19)으로 확정된 동일 계열 필드 사용:
// scfbAmt(낙찰금액), apslPrcCtrsScfbPrcRto(감정가 대비 낙찰가율), cltrOpbdDt(개찰일시),
// vldBddrNope(유효 입찰자 수), pbctNsq(회차)
function mapRound(r, idx) {
  const statCd = r.pbctStatCd != null ? String(r.pbctStatCd).padStart(4, '0') : '';
  return {
    round: Number(r.pbctNsq ?? r.pbctSn ?? idx + 1) || idx + 1,
    lowstAmt: parseAmt(r.lowstBidPrcIndctCont ?? r.lowstBidPrc),
    bidStart: r.cltrBidBgngDt || '',
    bidEnd: r.cltrBidEndDt || '',
    opbdDt: r.cltrOpbdDt || '',
    statCd,
    statNm: r.pbctStatNm || STAT_NAMES[statCd] || '',
    winAmt: parseAmt(r.scfbAmt),
    winRate: Number(r.apslPrcCtrsScfbPrcRto) || 0,
    bidderCnt: Number(r.vldBddrNope) || 0,
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
  if (!qs.cltrMngNo) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: { message: 'cltrMngNo가 필요합니다.' } }) };
  }

  const params = new URLSearchParams({
    serviceKey,
    pageNo: '1',
    numOfRows: '30',
    resultType: 'json',
    cltrMngNo: qs.cltrMngNo,
  });
  if (qs.pbctCdtnNo) params.set('pbctCdtnNo', qs.pbctCdtnNo);

  const upstreamUrl = `${ONBID_BIDINFO_API_URL}${ONBID_BIDINFO_OPERATION}?${params.toString().replace(serviceKey, '***').replace(encodeURIComponent(serviceKey), '***')}`;

  try {
    const r = await fetch(`${ONBID_BIDINFO_API_URL}${ONBID_BIDINFO_OPERATION}?${params.toString()}`);
    const bodyText = await r.text();
    console.log('[onbid-bidinfo] request:', upstreamUrl);
    console.log('[onbid-bidinfo] upstream status:', r.status, '| body(첫 1000자):', bodyText.slice(0, 1000));

    let raw;
    try {
      raw = JSON.parse(bodyText);
    } catch (e) {
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({
          error: { message: '온비드 입찰정보 API가 JSON이 아닌 응답을 반환했습니다 — ?debug=1로 원본을 확인하세요.' },
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
          error: { message: `온비드 입찰정보 API 오류: ${header.resultCode} ${header.resultMsg || ''}` },
          ...(qs.debug ? { debug: { upstreamUrl, rawSnippet: bodyText.slice(0, 800) } } : {}),
        }),
      };
    }

    const itemsRaw = env?.body?.items?.item || [];
    const list = Array.isArray(itemsRaw) ? itemsRaw : [itemsRaw];
    const rounds = list.filter(Boolean).map(mapRound).sort((a, b) => a.round - b.round);

    const debug = qs.debug ? { header: header ?? '(header 없음)', upstreamUrl, rawSnippet: bodyText.slice(0, 2000) } : undefined;

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rounds, totalCount: env?.body?.totalCount ?? rounds.length, ...(debug ? { debug } : {}) }),
    };
  } catch (e) {
    console.log('[onbid-bidinfo] fetch 실패:', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: { message: 'Proxy error: ' + e.message } }) };
  }
};
