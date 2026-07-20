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
  mvast_dtl:        { name: '동산 물건상세',              code: 'OnbidMvastDtlSrvc2',        op: '/getMvastDtlInf2',        confirmed: true }, // 승인 페이지 확정 2026-07-20, 필수 cltrMngNo+pbctCdtnNo
  vhcl_list:        { name: '차량 물건목록',              code: 'OnbidCarListSrvc2',         op: '/getCarCltrList2',      confirmed: true }, // _health ok (431건)
  vhcl_dtl:         { name: '차량 물건상세',              code: 'OnbidCarDtlSrvc2',          op: '/getCarDtlInf2',        confirmed: true }, // 승인 페이지 확정 2026-07-20, 필수 cltrMngNo+pbctCdtnNo
  scrt_dtl:         { name: '유가증권 상세정보',          code: 'OnbidScrtDtlSrvc2',         op: '/getScrtDtlInf2' },
  cltr_bidrslt_list:{ name: '물건 입찰결과목록',          code: 'OnbidCltrBidRsltListSrvc2', op: '/getCltrBidRsltList2',    confirmed: true },
  cltr_bidrslt_dtl: { name: '물건 입찰결과상세',          code: 'OnbidCltrBidRsltDtlSrvc2',  op: '/getCltrBidRsltDtl2',     confirmed: true },
  // 물건상세 입찰정보 — 승인 페이지 확정(2026-07-20): End Point OnbidCltrBidDtlSrvc2 / op getCltrBidinf2 (op에 소문자 inf 주의).
  // 필수 cltrMngNo+pbctCdtnNo. 부동산·동산·차량 공통. 응답: 이전입찰내역/이전입찰결과/**유찰누적횟수**/공고관리번호/공고명/
  // 제한경정입찰·평가배점·평가항목·평가기간/공동·대리입찰 가능여부/전자보증서/입찰제한정보/입찰관련제출서류/**회차별입찰정보**.
  // → 예측 엔진의 실제 회차(round) 확정·보증금 실측화 소스. (data 15157251)
  // ✅ 실호출 확정(2026-07-20): OnbidCltrBidDtlSrvc2 / getCltrBidInf2 (op 대문자 I — 스크린샷 소문자 판독 오류였음).
  //    필수 cltrMngNo+pbctCdtnNo. 응답 핵심: pbancMngNo(공고관리번호 — onbidPbancNo→pbancMngNo 연결고리!),
  //    pbctNsq(공매차수)/usbdNft(유찰횟수), pbctTdpsCont(보증금="최저입찰가격*10%"), cseqBidInfClgList(회차별 최저입찰가 리스트),
  //    prcnBidClgList(직전 유찰이력: cltrOpbdDt/pbctStatNm/lowstBidPrcIndctCont/scfbAmt). → 예측 엔진 실제 회차·보증금 실측 소스.
  cltr_dtl_bidinf:  { name: '물건상세 입찰정보',          code: 'OnbidCltrBidDtlSrvc2',      op: '/getCltrBidInf2',         confirmed: true },
  // 공고상세 계열 — 필수 입력은 **공고관리번호 pbancMngNo**(물건관리번호 cltrMngNo 아님 — 물건목록 응답의 공고번호로 조회).
  // pbanc_dtl 승인 페이지 확정(2026-07-20): End Point OnbidPbancDtlInfSrvc2 / op getPbancDtlInf2 (유추 코드명에 Inf 누락됐었음).
  // 응답에 **공고문 전문·공고취소사유·참가수수료** → 권리분석/매각조건 텍스트 피처 핵심 소스.
  // pbanc_dtl_cltr 승인 페이지 확정(2026-07-20): End Point OnbidPbancCltrDtlSrvc2 / op getPbancCltrInf2 (유추 Dtl/Cltr 순서 틀렸었음).
  // 필수 pbancMngNo. 응답: 공고에 속한 물건 목록 — 재산유형/처분방식/용도/물건명/**유찰횟수**/일괄입찰여부/물건주소/
  // **회차·공매차수**/입찰시작·종료일시/**감정평가금액·최저입찰가격**. → 공고번호 1개로 그 공고 전 물건·회차 일괄 획득.
  // ⚠️ 실호출 검증(2026-07-20): OnbidPbancDtlInfSrvc2/getPbancDtlInf2 → "Unexpected errors"(Base URL 재확정 필요). ?_base= 탐색 중.
  pbanc_dtl:        { name: '공고상세',                   code: 'OnbidPbancDtlInfSrvc2',     op: '/getPbancDtlInf2' },      // data 15157218, 필수 pbancMngNo
  // ✅ 실호출 검증(2026-07-20): OnbidPbancCltrDtlSrvc2/getPbancCltrInf2 → resultCode 03 NODATA = 엔드포인트 정확.
  //    단 필수 pbancMngNo가 물건데이터의 onbidPbancNo(예 662306)와 형식이 다름(샘플 202406-21411-00) — 공고번호 매핑 필요.
  pbanc_dtl_cltr:   { name: '공고상세 물건정보',          code: 'OnbidPbancCltrDtlSrvc2',    op: '/getPbancCltrInf2',       confirmed: true }, // data 15157220, 필수 pbancMngNo
  // 공고상세 입찰정보 — 승인 페이지 스크린샷 확정(2026-07-20): End Point OnbidPbancBidDtlSrvc2 / op getPbancBidInf2 (유추 코드명 순서가 틀렸었음).
  // 필수 pbancMngNo. 응답: 공동입찰가능여부/대리입찰가능여부/전자보증서제출/보증금대체서류/제출서류/입찰일정및장소/제안서평가항목.
  pbanc_dtl_bidinf: { name: '공고상세 입찰정보',          code: 'OnbidPbancBidDtlSrvc2',     op: '/getPbancBidInf2',        confirmed: true },
  pbanc_bidrslt_list:{ name: '공고 입찰결과목록',         code: 'OnbidPbancBidRsltListSrvc2',op: '/getPbancBidRsltList2',   confirmed: true },
  pbanc_bidrslt_dtl:{ name: '공고 입찰결과상세',          code: 'OnbidPbancBidRsltDtlSrvc2', op: '/getPbancBidRsltDtl2',    confirmed: true },
  stat_usg:         { name: '용도별 입찰 통계',           code: 'OnbidUsgBidStatsSrvc',      op: '/getKamcoCltrUsgStats', confirmed: true }, // 상세기능 확인. 파라미터: statsTypeCd(0041 압류/0044 국유/0045 수탁·유입/0046 공유), inqPerd(YYYY|YYYYMM|YYYY-Q)
  stat_rgn:         { name: '지역별 입찰 통계(캠코)',     code: 'OnbidClarBidStatsSrvc',     op: '/getKamcoCltrClarStats', confirmed: true }, // 상세기능 확인. statsTypeCd(0021 압류/0024 국유/0025 수탁·유입/0026 공유), inqPerd
  stat_rgn_org:     { name: '지역별 입찰 통계(이용기관)', code: 'OnbidClarBidStatsSrvc',     op: '/getOrgCltrClarStats',   confirmed: true }, // 상세기능 확인. inqPerd만 필요
  // 코드/주소 — 승인 페이지 확정(2026-07-20): End Point OnbidCodeSrvc, op 2종.
  //   기본 op getOnbidUsgCodeInfo(용도 코드 조회, param upCtgrId 상위카테고리ID).
  //   주소 조회는 getOnbidDtlAddrInfo(param sdnm/sggnm/emdNm) — ?op=/getOnbidDtlAddrInfo 또는 ONBID_SVC_CODE_ADDR_OP로 전환.
  //   용도: 법정동코드 자동화 → 주변 실거래 군 단위 커버리지 확장.
  code_addr:        { name: '코드 및 주소 조회',          code: 'OnbidCodeSrvc',             op: '/getOnbidUsgCodeInfo',    confirmed: true },
  rank_intrst:      { name: '순위물건목록 관심물건순위',  code: 'OnbidItrsCltrRnkClgSrvc',   op: '/getItrsCltrRnkClg',    confirmed: true }, // _health 경로 유효
  rank_rdcrt:       { name: '순위물건목록 저감률순위',    code: 'Onbid50PctDecrCltrSrvc',    op: '/get50PctDecrCltr',     confirmed: true }, // _health 경로 유효
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

// 실측 기반 판정 (2026-07-19 _health 첫 실행으로 확인):
//  - 존재하지 않는 서비스 경로 → HTTP 500 + "Unexpected errors" (data.go.kr 게이트웨이)
//  - 주소는 맞고 필수 파라미터 누락 → HTTP 200 + {"result":{"resultCode":"11","resultMsg":"NO_MANDATORY_REQUEST_PARAMETERS_ERROR"}}
function classify(httpStatus, bodyText) {
  const t = bodyText || '';
  if (/NO_OPENAPI_SERVICE|API not found/i.test(t) || httpStatus === 404) return 'endpoint_missing';
  if (httpStatus === 500 && /Unexpected errors/i.test(t)) return 'endpoint_missing';
  if (/NO_MANDATORY_REQUEST_PARAMETERS|INVALID_REQUEST_PARAMETER|WRONG.*PARAM|필수.*(파라미터|항목)/i.test(t)) return 'endpoint_ok_params_needed';
  if (/SERVICE_KEY|UNREGISTERED|LIMITED_NUMBER|DEADLINE/i.test(t)) return 'key_error';
  try {
    const j = JSON.parse(t);
    const env = j?.response ?? j;
    if (env?.header?.resultCode === '00') return 'ok';
    // 오류 시 {"result":{resultCode,resultMsg}} 형태의 별도 래퍼도 관측됨
    if (j?.result?.resultCode && j.result.resultCode !== '00') return 'upstream_error';
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
  // endpoint 탐색용 임시 오버라이드 — ?_op=/getXxx, ?_base=OnbidXxxSrvc2 (또는 전체 URL).
  // 정확한 End Point를 못 찾은 서비스를 재배포 없이 여러 후보로 시험하기 위한 디버깅 스위치.
  const opOv = qs._op; delete qs._op;
  const baseOv = qs._base; delete qs._base;

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
        const { httpStatus, bodyText } = await callSvc(svc, { pvctTrgtYn: 'N', dspsMthodCd: '0001', bidDivCd: '0001', prptDivCd: '0002,0003,0004,0005,0006,0007,0008,0010,0011,0013' }, serviceKey);
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

  const effBase = baseOv ? (/^https?:\/\//.test(baseOv) ? baseOv : (B + baseOv)) : svc.base;
  const effOp = opOv ? (opOv.startsWith('/') ? opOv : '/' + opOv) : svc.op;

  const params = new URLSearchParams({ serviceKey, resultType: 'json', pageNo: qs.page || qs.pageNo || '1', numOfRows: qs.numOfRows || '20' });
  for (const [k, v] of Object.entries(qs)) {
    if (!['page', 'pageNo', 'numOfRows'].includes(k)) params.set(k, v);
  }
  const upstreamUrl = `${effBase}${effOp}?${params.toString().replace(serviceKey, '***').replace(encodeURIComponent(serviceKey), '***')}`;

  try {
    const r = await fetch(`${effBase}${effOp}?${params.toString()}`);
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
