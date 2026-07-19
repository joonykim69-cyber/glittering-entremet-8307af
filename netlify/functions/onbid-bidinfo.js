// netlify/functions/onbid-bidinfo.js
// "차세대 온비드 물건상세 입찰정보 조회서비스" 프록시 — 회차별 입찰정보(최저입찰가
// 변동, 입찰기간, 유찰/낙찰 결과, 낙찰금액)를 공급. 낙찰가 예측 통계의 원천 데이터.
//
// 대상 서비스: 한국자산관리공사_차세대 온비드 물건상세 입찰정보 조회서비스
// (data.go.kr 데이터셋 15157251 — 승인 페이지의 End Point를 환경변수로 설정)
//
// ⚠️ 미확정(첫 실 응답으로 검증 필요 — 동산 목록 때와 동일한 절차):
//  - Base URL: ONBID_BIDINFO_API_URL 환경변수 (미설정 시 깨끗한 501)
//  - 오퍼레이션 경로: 차세대 명명 패턴에서 유추한 '/getDtlBidInf2' 기본값,
//    다르면 ONBID_BIDINFO_API_OP로 교체 (재배포 불필요). "API not found"가 나오면
//    ?debug=1의 rawSnippet으로 확인 후 환경변수만 수정하면 됨.
//  - 응답 필드명: 목록/상세 서비스와 동일 계열로 가정한 tolerant 매핑.
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

const ONBID_BIDINFO_API_URL = process.env.ONBID_BIDINFO_API_URL;
const ONBID_BIDINFO_OPERATION = process.env.ONBID_BIDINFO_API_OP || '/getDtlBidInf2';

// pbctStatCd → 표시명 (부동산 목록 Swagger의 코드표 재사용)
const STAT_NAMES = {
  '0001': '입찰준비중', '0002': '입찰진행중', '0003': '입찰마감', '0006': '개찰중',
  '0009': '수의계약가능', '0010': '낙찰', '0011': '유찰', '0012': '취소',
};

function parseAmt(v) {
  const n = parseInt(String(v ?? '').replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 회차 1건 tolerant 매핑 — 필드명 후보를 순서대로 시도, 원본은 debug로 확인
function mapRound(r, idx) {
  const statCd = r.pbctStatCd != null ? String(r.pbctStatCd).padStart(4, '0') : '';
  return {
    round: Number(r.pbctNsq ?? r.pbctSn ?? r.nsq ?? idx + 1) || idx + 1,
    lowstAmt: parseAmt(r.lowstBidPrcIndctCont ?? r.lowstBidPrc ?? r.lowstBidAmt),
    bidStart: r.cltrBidBgngDt || r.pbctBgngDtm || '',
    bidEnd: r.cltrBidEndDt || r.pbctClsDtm || '',
    statCd,
    statNm: r.pbctStatNm || STAT_NAMES[statCd] || '',
    // 낙찰금액 후보 — 실 응답 확인 후 확정할 것 (없으면 0)
    winAmt: parseAmt(r.nsmtAmt ?? r.sucsbidAmt ?? r.opbdMaxAmt ?? r.bidWinAmt),
    bidderCnt: Number(r.bidPrsnCnt ?? r.opbdPrsnCnt) || 0,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: { message: 'Method not allowed' } }) };
  }

  const serviceKey = process.env.ONBID_SERVICE_KEY;
  if (!serviceKey || !ONBID_BIDINFO_API_URL) {
    return {
      statusCode: 501,
      headers: CORS,
      body: JSON.stringify({ error: { message: '입찰정보 API 미연동 — Netlify 환경변수에 ONBID_BIDINFO_API_URL을 설정하세요 (data.go.kr 데이터셋 15157251의 End Point).' } }),
    };
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
