// netlify/functions/rtms-svc.js
// 국토교통부 실거래가(RTMS) 승인 서비스 10종 통합 레지스트리 프록시 — 시세 추정 축의 데이터 접근 계층.
// onbid-svc.js와 같은 방식: 패턴 유추 기본값 + _health 일괄 판정 + env 오버라이드.
//
// 사용법:
//   /.netlify/functions/rtms-svc?svc=<alias>&lawdCd=11110&dealYmd=202606&…  → 해당 서비스 프록시
//   /.netlify/functions/rtms-svc?svc=_list                                  → 레지스트리 목록
//   /.netlify/functions/rtms-svc?svc=_health                                → 전 서비스 일괄 상태점검
//
// 이 계열의 공통 필수 파라미터 (아파트 매매 상세 승인 페이지에서 확정, 2026-07-19):
//   LAWD_CD  = 법정동코드 앞 5자리 (시군구), DEAL_YMD = 계약년월(YYYYMM)
//   (프론트 편의상 lawdCd/dealYmd 소문자도 받아서 변환)
// 응답 데이터포맷은 XML — 이 프록시가 <item> 블록을 JSON으로 변환해 돌려준다.
//
// Base URL은 확정 사례(RTMSDataSvcAptTradeDev)의 명명 패턴에서 유추한 기본값이며,
// 서비스별 환경변수로 재배포 없이 교체 가능:
//   RTMS_SVC_<ALIAS 대문자>_URL / RTMS_SVC_<ALIAS 대문자>_OP
// 인증키는 같은 data.go.kr 계정이므로 ONBID_SERVICE_KEY 재사용 (다르면 RTMS_SERVICE_KEY로 분리).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const B = 'https://apis.data.go.kr/1613000/';

// confirmed:true = 승인 페이지에서 End Point·오퍼레이션·파라미터가 확인된 값.
const REGISTRY = {
  apt_trade_dev: { name: '아파트 매매 실거래가 상세',        code: 'RTMSDataSvcAptTradeDev', op: '/getRTMSDataSvcAptTradeDev', confirmed: true },
  apt_rent:      { name: '아파트 전월세 실거래가',           code: 'RTMSDataSvcAptRent',     op: '/getRTMSDataSvcAptRent', confirmed: true },
  apt_silv:      { name: '아파트 분양권전매 실거래가',       code: 'RTMSDataSvcSilvTrade',   op: '/getRTMSDataSvcSilvTrade' },
  offi_trade:    { name: '오피스텔 매매 실거래가',           code: 'RTMSDataSvcOffiTrade',   op: '/getRTMSDataSvcOffiTrade' },
  rh_trade:      { name: '연립다세대 매매 실거래가',         code: 'RTMSDataSvcRHTrade',     op: '/getRTMSDataSvcRHTrade', confirmed: true },
  sh_trade:      { name: '단독/다가구 매매 실거래가',        code: 'RTMSDataSvcSHTrade',     op: '/getRTMSDataSvcSHTrade', confirmed: true },
  sh_rent:       { name: '단독/다가구 전월세 실거래가',      code: 'RTMSDataSvcSHRent',      op: '/getRTMSDataSvcSHRent' },
  land_trade:    { name: '토지 매매 실거래가',               code: 'RTMSDataSvcLandTrade',   op: '/getRTMSDataSvcLandTrade' },
  nrg_trade:     { name: '상업업무용 부동산 매매 실거래가',  code: 'RTMSDataSvcNrgTrade',    op: '/getRTMSDataSvcNrgTrade', confirmed: true },
  indu_trade:    { name: '공장·창고 등 부동산 매매 실거래가', code: 'RTMSDataSvcInduTrade',   op: '/getRTMSDataSvcInduTrade' },
};

function resolve(alias) {
  const def = REGISTRY[alias];
  if (!def) return null;
  const envKey = alias.toUpperCase();
  return {
    ...def,
    base: process.env[`RTMS_SVC_${envKey}_URL`] || (B + def.code),
    op: process.env[`RTMS_SVC_${envKey}_OP`] || def.op,
    overridden: !!process.env[`RTMS_SVC_${envKey}_URL`],
  };
}

// ── XML 유틸 — 이 API 계열은 resultType=json을 지원하지 않고 항상 XML을 반환한다 ──
function xmlText(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .trim();
}
function xmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? xmlText(m[1]) : undefined;
}
function xmlItems(xml) {
  const out = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const b of blocks) {
    const obj = {};
    const fields = b.match(/<([A-Za-z_][\w]*)>([\s\S]*?)<\/\1>/g) || [];
    for (const f of fields) {
      const m = f.match(/<([A-Za-z_][\w]*)>([\s\S]*?)<\/\1>/);
      if (m) obj[m[1]] = xmlText(m[2]);
    }
    out.push(obj);
  }
  return out;
}

// data.go.kr 게이트웨이 오류는 <OpenAPI_ServiceResponse><cmmMsgHeader> XML로 온다.
function classify(httpStatus, bodyText) {
  const t = bodyText || '';
  if (/NO_OPENAPI_SERVICE|API not found/i.test(t) || httpStatus === 404) return 'endpoint_missing';
  if (httpStatus === 500 && /Unexpected errors/i.test(t)) return 'endpoint_missing';
  if (/SERVICE_KEY|UNREGISTERED|LIMITED_NUMBER|DEADLINE/i.test(t)) return 'key_error';
  if (/NO_MANDATORY_REQUEST_PARAMETERS|INVALID_REQUEST_PARAMETER|WRONG.*PARAM/i.test(t)) return 'endpoint_ok_params_needed';
  const rc = xmlTag(t, 'resultCode');
  if (rc === '00' || rc === '000') return 'ok';
  if (rc) return 'upstream_error';
  return 'unknown_response';
}

// 직전 '완결된' 계약월(KST 기준 전전월 — 실거래 신고는 계약 후 30일 이내라 전월은 미완결일 수 있음)
function recentDealYmd() {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  kst.setUTCDate(1);
  kst.setUTCMonth(kst.getUTCMonth() - 2);
  return `${kst.getUTCFullYear()}${String(kst.getUTCMonth() + 1).padStart(2, '0')}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: { message: 'Method not allowed' } }) };
  }

  const serviceKey = process.env.RTMS_SERVICE_KEY || process.env.ONBID_SERVICE_KEY;
  if (!serviceKey) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: { message: 'RTMS_SERVICE_KEY/ONBID_SERVICE_KEY not configured' } }) };
  }

  const qs = { ...(event.queryStringParameters || {}) };
  const alias = qs.svc;
  delete qs.svc;
  const debug = qs.debug; delete qs.debug;

  // ── 레지스트리 목록 ──
  if (alias === '_list') {
    const list = Object.entries(REGISTRY).map(([k, v]) => {
      const r = resolve(k);
      return { svc: k, name: v.name, base: r.base, op: r.op, confirmed: !!v.confirmed, overridden: r.overridden };
    });
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ services: list }) };
  }

  // ── 일괄 상태점검 — 종로구(11110)·전전월로 2건씩 핑 ──
  if (alias === '_health') {
    const dealYmd = recentDealYmd();
    const results = await Promise.all(Object.keys(REGISTRY).map(async k => {
      const svc = resolve(k);
      try {
        const params = new URLSearchParams({ serviceKey, LAWD_CD: '11110', DEAL_YMD: dealYmd, pageNo: '1', numOfRows: '2' });
        const r = await fetch(`${svc.base}${svc.op}?${params.toString()}`);
        const bodyText = await r.text();
        const verdict = classify(r.status, bodyText);
        const totalCount = xmlTag(bodyText, 'totalCount');
        return {
          svc: k, name: svc.name, base: svc.base, op: svc.op, confirmed: !!svc.confirmed, overridden: svc.overridden,
          verdict, httpStatus: r.status,
          ...(totalCount != null ? { totalCount } : {}),
          ...(verdict !== 'ok' ? { snippet: bodyText.slice(0, 220) } : {}),
        };
      } catch (e) {
        return { svc: k, name: svc.name, base: svc.base, op: svc.op, verdict: 'fetch_failed', error: e.message };
      }
    }));
    const summary = results.reduce((acc, r) => { acc[r.verdict] = (acc[r.verdict] || 0) + 1; return acc; }, {});
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dealYmd, summary, guide: 'endpoint_missing인 서비스만 승인 페이지의 End Point를 RTMS_SVC_<SVC대문자>_URL 환경변수로 교정하면 됩니다.', results }, null, 2),
    };
  }

  // ── 개별 서비스 프록시 ──
  const svc = alias ? resolve(alias) : null;
  if (!svc) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: { message: `svc 파라미터가 필요합니다. 사용 가능: _list, _health, ${Object.keys(REGISTRY).join(', ')}` } }) };
  }

  const lawdCd = qs.lawdCd || qs.LAWD_CD;
  const dealYmd = qs.dealYmd || qs.DEAL_YMD;
  if (!lawdCd || !dealYmd) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: { message: 'lawdCd(법정동코드 앞 5자리)와 dealYmd(YYYYMM)가 필요합니다.' } }) };
  }
  const params = new URLSearchParams({
    serviceKey,
    LAWD_CD: String(lawdCd).slice(0, 5),
    DEAL_YMD: String(dealYmd).replace(/[^0-9]/g, '').slice(0, 6),
    pageNo: qs.page || qs.pageNo || '1',
    numOfRows: qs.numOfRows || '100',
  });
  const upstreamUrl = `${svc.base}${svc.op}?${params.toString().replace(serviceKey, '***').replace(encodeURIComponent(serviceKey), '***')}`;

  try {
    const r = await fetch(`${svc.base}${svc.op}?${params.toString()}`);
    const bodyText = await r.text();
    console.log(`[rtms-svc:${alias}] status:`, r.status, '| body(첫 400자):', bodyText.slice(0, 400));

    const rc = xmlTag(bodyText, 'resultCode');
    if (!(rc === '00' || rc === '000')) {
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({
          error: { message: `${svc.name} API 오류: ${rc || 'no resultCode'} ${xmlTag(bodyText, 'resultMsg') || xmlTag(bodyText, 'returnAuthMsg') || ''}`.trim(), verdict: classify(r.status, bodyText) },
          ...(debug ? { debug: { upstreamUrl, rawSnippet: bodyText.slice(0, 800) } } : {}),
        }),
      };
    }

    const items = xmlItems(bodyText);
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
      body: JSON.stringify({
        svc: alias, name: svc.name, items,
        totalCount: Number(xmlTag(bodyText, 'totalCount') ?? items.length),
        pageNo: Number(xmlTag(bodyText, 'pageNo') ?? 1),
        numOfRows: Number(xmlTag(bodyText, 'numOfRows') ?? items.length),
        ...(debug ? { debug: { upstreamUrl, rawSnippet: bodyText.slice(0, 1500) } } : {}),
      }),
    };
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: { message: 'Proxy error: ' + e.message } }) };
  }
};
