// netlify/functions/onbid-svc.js
// 온비드 승인 서비스 "전체 레지스트리" 통합 프록시 — 사용자가 data.go.kr에서 승인받은
// 36개 서비스 중 아직 전용 프록시가 없는 것들을 한꺼번에 등록해 두는 데이터 접근 계층.
//
// 사용법:
//   /.netlify/functions/onbid-svc?svc=<alias>&<원본 API 파라미터…>   → 해당 서비스 프록시 (원본 응답 구조 유지)
//   /.netlify/functions/onbid-svc?svc=_list                          → 레지스트리 목록 (upstream 호출 없음)
//   /.netlify/functions/onbid-svc?svc=_health                        → 전 서비스 일괄 상태점검
//
// Base URL/오퍼레이션은 차세대 명명 패턴(확정 사례: Rlst목록/상세, Mvast목록, CltrBidRsltDtl)
// 에서 유추한 기본값이며, 서비스별 환경변수로 재배포 없이 교체 가능:
//   ONBID_SVC_<ALIAS 대문자>_URL = Base URL 오버라이드 (승인 페이지의 End Point)
//   ONBID_SVC_<ALIAS 대문자>_OP  = 오퍼레이션 경로 오버라이드
// (_health 결과에서 endpoint_missing으로 나온 alias만 교정하면 됨)
//
// _health의 판정 기준 (data.go.kr 공통 동작):
//   - JSON resultCode 00        → ok (완전 정상)
//   - INVALID_REQUEST_PARAMETER → endpoint_ok_params_needed (주소는 맞음, 필수 파라미터만 추가하면 됨)
//   - NO_OPENAPI_SERVICE / API not found → endpoint_missing (Base URL 또는 op 추정이 틀림 — env로 교정)
//   - SERVICE_KEY 관련           → key_error

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const B = 'https://apis.data.go.kr/B010003/';

// confirmed:true = 실 응답으로 검증된 값. 나머지는 패턴 유추 — _health로 확인.
const REGISTRY = {
  rlst_list:        { name: '부동산 물건목록',            code: 'OnbidRlstListSrvc2',        op: '/getRlstCltrList2',       confirmed: true },
  rlst_dtl:         { name: '부동산 물건상세',            code: 'OnbidRlstDtlSrvc2',         op: '/getRlstDtlInf2',         confirmed: true },
  mvast_list:       { name: '동산 물건목록',              code: 'OnbidMvastListSrvc2',       op: '/getMvastCltrList2',      confirmed: true },
  mvast_dtl:        { name: '동산 물건상세',              code: 'OnbidMvastDtlSrvc2',        op: '/getMvastDtlInf2' },
  vhcl_list:        { name: '차량 물건목록',              code: 'OnbidVhclListSrvc2',        op: '/getVhclCltrList2' },
  vhcl_dtl:         { name: '차량 물건상세',              code: 'OnbidVhclDtlSrvc2',         op: '/getVhclDtlInf2' },
  scrt_dtl:         { name: '유가증권 상세정보',          code: 'OnbidScrtDtlSrvc2',         op: '/getScrtDtlInf2' },
  cltr_bidrslt_list:{ name: '물건 입찰결과목록',          code: 'OnbidCltrBidRsltListSrvc2', op: '/getCltrBidRsltList2' },
  cltr_bidrslt_dtl: { name: '물건 입찰결과상세',          code: 'OnbidCltrBidRsltDtlSrvc2',  op: '/getCltrBidRsltDtl2',     confirmed: true },
  cltr_dtl_bidinf:  { name: '물건상세 입찰정보',          code: 'OnbidCltrDtlBidInfSrvc2',   op: '/getCltrDtlBidInf2' },
  pbanc_dtl:        { name: '공고상세',                   code: 'OnbidPbancDtlSrvc2',        op: '/getPbancDtlInf2' },
  pbanc_dtl_cltr:   { name: '공고상세 물건정보',          code: 'OnbidPbancDtlCltrSrvc2',    op: '/getPbancDtlCltrInf2' },
  pbanc_dtl_bidinf: { name: '공고상세 입찰정보',          code: 'OnbidPbancDtlBidInfSrvc2',  op: '/getPbancDtlBidInf2' },
  pbanc_bidrslt_list:{ name: '공고 입찰결과목록',         code: 'OnbidPbancBidRsltListSrvc2',op: '/getPbancBidRsltList2' },
  pbanc_bidrslt_dtl:{ name: '공고 입찰결과상세',          code: 'OnbidPbancBidRsltDtlSrvc2', op: '/getPbancBidRsltDtl2' },
  stat_usg:         { name: '용도별 입찰 통계',           code: 'OnbidUsgBidStatSrvc2',      op: '/getUsgBidStat2' },
  stat_rgn:         { name: '지역별 입찰 통계',           code: 'OnbidRgnBidStatSrvc2',      op: '/getRgnBidStat2' },
  code_addr:        { name: '코드 및 주소 조회',          code: 'OnbidCodeAddrSrvc2',        op: '/getOnbidCode2' },
  rank_intrst:      { name: '순위물건목록 관심물건순위',  code: 'OnbidRankIntrstCltrSrvc2',  op: '/getRankIntrstCltrList2' },
  rank_rdcrt:       { name: '순위물건목록 저감률순위',    code: 'OnbidRankRdcrtSrvc2',       op: '/getRankRdcrtList2' },
  rank_inqcnt:      { name: '순위물건목록 조회수 순위',   code: 'OnbidRankInqcntSrvc2',      op: '/getRankInqcntList2', disabled: '데이터포털에서 서비스 중지 상태' },
  gov_ntnl:         { name: '정부재산목록 국유일반재산',  code: 'OnbidGovNtnlPrptSrvc2',     op: '/getGovNtnlPrptList2' },
  gov_shrd:         { name: '정부재산목록 공유일반재산',  code: 'OnbidGovShrdPrptSrvc2',     op: '/getGovShrdPrptList2' },
  gov_jpn:          { name: '정부재산목록 친일귀속재산',  code: 'OnbidGovJpnPrptSrvc2',      op: '/getGovJpnPrptList2' },
  gov_unusd:        { name: '정부재산목록 불용품',        code: 'OnbidGovUnusdPrptSrvc2',    op: '/getGovUnusdPrptList2' },
  trust_nbiz:       { name: '수탁 비업무용 자산 매각정보', code: 'OnbidTrustNbizAsstSrvc2',   op: '/getTrustNbizAsstList2' },
  ntnl_bidtrgt:     { name: '국유일반재산 입찰대상물건내역', code: 'OnbidNtnlBidTrgtSrvc2',   op: '/getNtnlBidTrgtList2' },
};

function resolve(alias) {
  const def = REGISTRY[alias];
  if (!def) return null;
  const envKey = alias.toUpperCase();
  return {
    ...def,
    base: process.env[`ONBID_SVC_${envKey}_URL`] || (B + def.code),
    op: process.env[`ONBID_SVC_${envKey}_OP`] || def.op,
    overridden: !!process.env[`ONBID_SVC_${envKey}_URL`],
  };
}

function classify(httpStatus, bodyText) {
  const t = bodyText || '';
  if (/NO_OPENAPI_SERVICE|API not found|SERVICE ERROR/i.test(t) || httpStatus === 404) return 'endpoint_missing';
  if (/INVALID_REQUEST_PARAMETER|WRONG.*PARAM|필수.*(파라미터|항목)/i.test(t)) return 'endpoint_ok_params_needed';
  if (/SERVICE_KEY|UNREGISTERED|LIMITED_NUMBER|DEADLINE/i.test(t)) return 'key_error';
  try {
    const j = JSON.parse(t);
    const env = j?.response ?? j;
    if (env?.header?.resultCode === '00') return 'ok';
    return 'upstream_error';
  } catch { return 'unknown_response'; }
}

async function callSvc(svc, extraParams, serviceKey) {
  const params = new URLSearchParams({ serviceKey, resultType: 'json', pageNo: '1', numOfRows: '2' });
  for (const [k, v] of Object.entries(extraParams)) params.set(k, v);
  const url = `${svc.base}${svc.op}?${params.toString()}`;
  const r = await fetch(url);
  const bodyText = await r.text();
  return { httpStatus: r.status, bodyText };
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

  const qs = { ...(event.queryStringParameters || {}) };
  const alias = qs.svc;
  delete qs.svc;
  const debug = qs.debug; delete qs.debug;

  // ── 레지스트리 목록 ──
  if (alias === '_list') {
    const list = Object.entries(REGISTRY).map(([k, v]) => {
      const r = resolve(k);
      return { svc: k, name: v.name, base: r.base, op: r.op, confirmed: !!v.confirmed, disabled: v.disabled || false, overridden: r.overridden };
    });
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ services: list }) };
  }

  // ── 일괄 상태점검 ──
  if (alias === '_health') {
    const aliases = Object.keys(REGISTRY).filter(k => !REGISTRY[k].disabled);
    const results = await Promise.all(aliases.map(async k => {
      const svc = resolve(k);
      try {
        const { httpStatus, bodyText } = await callSvc(svc, {}, serviceKey);
        const verdict = classify(httpStatus, bodyText);
        let totalCount;
        try { const j = JSON.parse(bodyText); totalCount = (j?.response ?? j)?.body?.totalCount; } catch {}
        return {
          svc: k, name: svc.name, base: svc.base, op: svc.op, confirmed: !!svc.confirmed, overridden: svc.overridden,
          verdict, httpStatus,
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
      body: JSON.stringify({ summary, guide: 'verdict가 endpoint_missing인 서비스만 승인 페이지의 End Point를 ONBID_SVC_<SVC대문자>_URL 환경변수로 설정하면 됩니다. endpoint_ok_params_needed는 주소가 맞다는 뜻(필수 파라미터만 채우면 사용 가능).', results }, null, 2),
    };
  }

  // ── 개별 서비스 프록시 ──
  const svc = alias ? resolve(alias) : null;
  if (!svc) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: { message: `svc 파라미터가 필요합니다. 사용 가능: _list, _health, ${Object.keys(REGISTRY).join(', ')}` } }) };
  }
  if (svc.disabled) {
    return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: { message: `${svc.name}: ${svc.disabled}` } }) };
  }

  const params = new URLSearchParams({ serviceKey, resultType: 'json', pageNo: qs.page || qs.pageNo || '1', numOfRows: qs.numOfRows || '20' });
  for (const [k, v] of Object.entries(qs)) {
    if (!['page', 'pageNo', 'numOfRows'].includes(k)) params.set(k, v);
  }
  const upstreamUrl = `${svc.base}${svc.op}?${params.toString().replace(serviceKey, '***').replace(encodeURIComponent(serviceKey), '***')}`;

  try {
    const r = await fetch(`${svc.base}${svc.op}?${params.toString()}`);
    const bodyText = await r.text();
    console.log(`[onbid-svc:${alias}] status:`, r.status, '| body(첫 500자):', bodyText.slice(0, 500));

    let raw;
    try { raw = JSON.parse(bodyText); }
    catch {
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({ error: { message: `${svc.name} API가 JSON이 아닌 응답을 반환했습니다.`, verdict: classify(r.status, bodyText) }, ...(debug ? { debug: { upstreamUrl, rawSnippet: bodyText.slice(0, 800) } } : {}) }),
      };
    }

    const env = raw?.response ?? raw;
    const header = env?.header;
    if (header && header.resultCode && header.resultCode !== '00') {
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({ error: { message: `${svc.name} API 오류: ${header.resultCode} ${header.resultMsg || ''}` }, ...(debug ? { debug: { upstreamUrl, rawSnippet: bodyText.slice(0, 800) } } : {}) }),
      };
    }

    const itemsRaw = env?.body?.items?.item;
    const items = itemsRaw == null ? [] : (Array.isArray(itemsRaw) ? itemsRaw : [itemsRaw]);
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ svc: alias, name: svc.name, items, totalCount: env?.body?.totalCount ?? items.length, body: env?.body ?? null, ...(debug ? { debug: { upstreamUrl, rawSnippet: bodyText.slice(0, 1500) } } : {}) }),
    };
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: { message: 'Proxy error: ' + e.message } }) };
  }
};
