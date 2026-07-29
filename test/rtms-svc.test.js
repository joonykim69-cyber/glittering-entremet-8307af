// rtms-svc XML 파서 회귀 테스트 — 실제 프로덕션 rawSnippet 구조(2026-07-26 실호출)로 검증
const path = require('path');
const REPO = '/home/user/glittering-entremet-8307af';
let fail = 0;
const ok = (c, m) => { if (!c) { console.error('❌', m); fail++; } else console.log('✓', m); };

// 실호출 rawSnippet에서 재구성한 실제 응답 구조 (필드명·값 형식 동일)
const XML = `<?xml version="1.0" encoding="utf-8" standalone="yes"?><response><header><resultCode>000</resultCode><resultMsg>OK</resultMsg></header><body><items><item><aptDong> </aptDong><aptNm>노블루티움</aptNm><aptSeq>11680-463</aptSeq><bonbun>0794</bonbun><bubun>0024</bubun><buildYear>2003</buildYear><buyerGbn>개인</buyerGbn><cdealDay> </cdealDay><cdealType> </cdealType><dealAmount>119,900</dealAmount><dealDay>20</dealDay><dealMonth>5</dealMonth><dealYear>2026</dealYear><dealingGbn>중개거래</dealingGbn><estateAgentSggNm>서울 강남구</estateAgentSggNm><excluUseAr>81.85</excluUseAr><floor>3</floor><jibun>794-24</jibun><landCd>1</landCd><landLeaseholdGbn>N</landLeaseholdGbn><rgstDate> </rgstDate><roadNm>도곡로19길</roadNm><sggCd>11680</sggCd><slerGbn>개인</slerGbn><umdCd>10100</umdCd><umdNm>역삼동</umdNm></item><item><aptDong> </aptDong><aptNm>삼성동중앙하이츠빌리지</aptNm><aptSeq>11680-507</aptSeq><buildYear>2004</buildYear><dealAmount>256,000</dealAmount><dealDay>30</dealDay><dealMonth>5</dealMonth><dealYear>2026</dealYear><excluUseAr>59.98</excluUseAr><floor>19</floor><umdNm>삼성동</umdNm></item></items><totalCount>453</totalCount><pageNo>1</pageNo><numOfRows>3</numOfRows></body></response>`;

process.env.ONBID_SERVICE_KEY = 'test-key';
global.fetch = async () => ({ ok: true, status: 200, text: async () => XML });

const fn = require(path.join(REPO, 'netlify/functions/rtms-svc'));

(async () => {
  const res = await fn.handler({ httpMethod: 'GET', queryStringParameters: { svc: 'apt_trade_dev', lawdCd: '11680', dealYmd: '202605' } });
  const j = JSON.parse(res.body);
  ok(res.statusCode === 200, 'HTTP 200');
  ok(Array.isArray(j.items) && j.items.length === 2, `items 2건 (실제 ${j.items && j.items.length})`);
  const it = j.items[0] || {};
  ok(!('item' in it), '통짜 {item:"<원시XML>"} 버그 재발 없음');
  ok(it.aptNm === '노블루티움', `aptNm 파싱: ${it.aptNm}`);
  ok(it.dealAmount === '119,900', `dealAmount 파싱: ${it.dealAmount}`);
  ok(it.excluUseAr === '81.85', `excluUseAr 파싱: ${it.excluUseAr}`);
  ok(it.dealYear === '2026' && it.dealMonth === '5', '거래 연월 파싱');
  ok(it.umdNm === '역삼동', 'umdNm 파싱');
  ok(j.items[1].aptNm === '삼성동중앙하이츠빌리지', '2번째 item 독립 파싱');
  ok(j.totalCount === 453, `totalCount ${j.totalCount}`);

  // market-est 매핑까지 체인: 이 items가 mapTrade를 통과하는지
  const me = require(path.join(REPO, 'netlify/functions/market-est'));
  process.env.URL = 'http://x';
  global.fetch = async (url) => {
    if (String(url).includes('rtms-svc')) return { ok: true, status: 200, json: async () => j };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const r = JSON.parse((await me.handler({ queryStringParameters: { kind: 'apt', lawd: '11680', months: '6' } })).body);
  ok(r.sample.rawN === 12, `market-est rawN=12 (2건×6개월, 실제 ${r.sample.rawN})`);
  ok(r.status === 'ok' && r.perM2 && r.perM2.p50 > 0, `market-est 통계 생성: p50=${r.perM2 && r.perM2.p50}만원/㎡`);
  ok(r.trades[0].built > 0, '건축년도 포함');

  console.log(fail ? `\n❌ ${fail} FAIL` : '\n✅ ALL PASS');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
