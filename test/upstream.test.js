// test/upstream.test.js — 상위 게이트웨이 실패를 '데이터 없음'과 구별한다.
// 지키려는 것: 인증·쿼터 실패로 상위가 응답을 못 줄 때 수집기가 **빈 창을 저장하고
//   커서를 전진시키지 않는다**. 백필은 과거로만 가므로 한 번 지나간 구간은 다시 오지 않는다
//   (2026-08-05 인증키 장애에서 실제로 6창 42일치가 이렇게 비었다).
// 그리고 그 반대도 지킨다 — **진짜로 개찰이 없는 창은 여전히 저장하고 전진한다.**

'use strict';

const fs = require('fs');
const path = require('path');
const { t, eq, done, fnPath } = require('./_harness');
const { upstreamFailure } = require(fnPath('lib/upstream.js'));

// 실제 관측된 게이트웨이 응답(2026-08-05 프로덕션 원문)
const GATEWAY_JSON = JSON.stringify({
  OpenAPI_ServiceResponse: {
    cmmMsgHeader: {
      errMsg: 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR',
      returnAuthMsg: '등록되지 않은 서비스키',
      returnReasonCode: '30',
    },
  },
});
const GATEWAY_XML = '<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</errMsg>'
  + '<returnAuthMsg>등록되지 않은 서비스키</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>';
const OK_JSON = JSON.stringify({ response: { header: { resultCode: '00' }, body: { items: { item: [] }, totalCount: 0 } } });
const NODATA_JSON = JSON.stringify({ response: { header: { resultCode: '03', resultMsg: 'NODATA_ERROR' }, body: {} } });

// ── ① 판정 ──
const g = upstreamFailure(GATEWAY_JSON);
t('게이트웨이 JSON → 실패로 판정', !!g);
eq('  verdict', g && g.verdict, 'key_error');
eq('  code', g && g.code, '30');
t('  msg에 원인이 담긴다', g && /SERVICE_KEY_IS_NOT_REGISTERED/.test(g.msg), g && g.msg);
t('게이트웨이 XML(RTMS)도 판정', (upstreamFailure(GATEWAY_XML) || {}).verdict === 'key_error');

// ⚠️ 여기가 이 모듈의 위험 지점 — 실패가 아닌 것을 실패로 뒤집으면 정상 수집이 멈춘다.
t('정상 응답은 실패 아님', upstreamFailure(OK_JSON) === null);
t("NODATA(03)는 실패 아님 — '데이터 없음'이다", upstreamFailure(NODATA_JSON) === null);
t('빈 문자열·null 안전', upstreamFailure('') === null && upstreamFailure(null) === null);
t('게이트웨이 봉투 없이 단어만 있으면 실패 아님(오탐 방지)',
  upstreamFailure('{"note":"serviceKey echoed","results":[]}') === null);
t('쿼터 초과도 key_error 계열로 잡힌다',
  (upstreamFailure('{"cmmMsgHeader":{"errMsg":"LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR"}}') || {}).verdict === 'key_error');

// ── ② 구조 규율 — 상위를 파싱하는 프록시는 전부 이 판정을 거친다 ──
const FN_DIR = path.dirname(fnPath('lib/upstream.js')).replace(/[\\/]lib$/, '');
const parsers = fs.readdirSync(FN_DIR)
  .filter(f => f.endsWith('.js'))
  .map(f => ({ f, src: fs.readFileSync(path.join(FN_DIR, f), 'utf8') }))
  // 상위(data.go.kr)를 직접 호출해 본문을 읽는 프록시만 대상
  .filter(x => /apis\.data\.go\.kr|ONBID_API_URL|ONBID_.*_API_URL/.test(x.src) && /await r\.text\(\)/.test(x.src));

t('상위 파싱 프록시가 7개 이상 발견됨', parsers.length >= 7, parsers.length);
for (const { f, src } of parsers) {
  // 대부분은 upstreamFailure()로 판정한다. rtms-svc만 예외인데, XML 경로가 resultCode가
  // 없으면 이미 오류로 떨어지는(fail-closed) 구조라 게이트웨이 응답이 '데이터 없음'으로
  // 새어 나가지 않는다 — 대신 판정 규칙(FATAL_RE)은 같은 모듈에서 가져온다.
  t(`${f} — 게이트웨이 실패가 '데이터 없음'으로 새지 않는다`,
    /upstreamFailure\(/.test(src) || /FATAL_RE/.test(src));
  t(`${f} — 판정 규칙을 공용 모듈에서 가져온다`, /require\('\.\/lib\/upstream\.js'\)/.test(src));
}

// ── ③ 수집기: 실패 vs 무데이터 ──
function makeStore() {
  const m = new Map();
  return {
    _m: m,
    async get(k) { return m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : null; },
    async setJSON(k, v) { m.set(k, JSON.parse(JSON.stringify(v))); },
    set(k, v) { m.set(k, JSON.parse(JSON.stringify(v))); },
    async list({ prefix }) { const blobs = []; for (const k of m.keys()) if (k.startsWith(prefix)) blobs.push({ key: k }); return { blobs }; },
  };
}
// base URL이 없으면 fetch가 상대 URL로 즉시 던져 실호출 경로를 밟지 못한다(2026-08-02 교훈).
process.env.URL = 'http://test.local';

const CH = fnPath('collect-history.js');
const CB = fnPath('collect-backfill.js');
// ⚠️ 커서를 날짜로 박으면 시한폭탄이 된다 — collect-history의 백필 모드 판정은
// `cursorEnd <= 오늘-365`이므로, 고정 날짜는 언젠가 증분 모드로 넘어가 단언이 조용히
// 무의미해진다(시계 +400일 스윕이 실제로 잡았다). 실제 시계로 계산한다.
const todayKST = () => {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
};
const CUR = todayKST();
const winKeys = s => [...s._m.keys()].filter(k => /^hist\/\d{8}_\d{8}\//.test(k));
const featKeys = s => [...s._m.keys()].filter(k => /^hist\/feat\/\d{8}_\d{8}\//.test(k));

(async () => {
  // ③-a collect-history — 상위 실패(프록시 502)
  let store = makeStore();
  global.__FAKE_STORE__ = store;
  store.set('hist/_state', { cursorEnd: CUR }); // 백필 모드(오늘 커서 — 항상 성립)
  global.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
  delete require.cache[require.resolve(CH)];
  let r = await require(CH).handler({ httpMethod: 'GET', queryStringParameters: {} });
  let b = JSON.parse(r.body);

  eq('[history/실패] 창을 하나도 저장하지 않음', winKeys(store).length, 0);
  eq('[history/실패] 커서 전진 없음', (await store.get('hist/_state')).cursorEnd, CUR);
  const hb = await store.get('_run/collect-history');
  t('[history/실패] 하트비트에 사유 기록(조용히 사라지지 않는다)', !!(hb && hb.fetchStopped), JSON.stringify(hb && hb.fetchStopped));
  t('[history/실패] 응답 note가 실패를 설명', /실패/.test(b.note || ''), b.note);

  // ③-b collect-history — 진짜로 개찰이 없는 창(정상 동작이 죽지 않았는지)
  store = makeStore();
  global.__FAKE_STORE__ = store;
  store.set('hist/_state', { cursorEnd: CUR });
  global.fetch = async () => ({ ok: true, json: async () => ({ results: [], totalCount: 0 }) });
  delete require.cache[require.resolve(CH)];
  r = await require(CH).handler({ httpMethod: 'GET', queryStringParameters: { windows: '1' } });

  t('[history/무데이터] 빈 창이라도 저장한다', winKeys(store).length > 0, winKeys(store).length);
  t('[history/무데이터] 커서가 전진한다', (await store.get('hist/_state')).cursorEnd < CUR);
  t('[history/무데이터] fetchStopped 없음', !(await store.get('_run/collect-history')).fetchStopped);

  // ③-c collect-backfill — 상위 실패
  store = makeStore();
  global.__FAKE_STORE__ = store;
  store.set('hist/_bfstate', { cursorEnd: '20260630' });
  global.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
  delete require.cache[require.resolve(CB)];
  r = await require(CB).handler({ queryStringParameters: {} });
  b = JSON.parse(r.body);

  eq('[backfill/실패] 창을 하나도 저장하지 않음', featKeys(store).length, 0);
  eq('[backfill/실패] 커서 전진 없음', (await store.get('hist/_bfstate')).cursorEnd, '20260630');
  t('[backfill/실패] 하트비트에 사유 기록', !!(await store.get('_run/collect-backfill')).fetchStopped);
  t('[backfill/실패] 예산 소진으로 오인하지 않음', !/예산/.test(b.note || ''), b.note);

  // ③-d collect-backfill — 무데이터 창은 정상 저장·전진
  store = makeStore();
  global.__FAKE_STORE__ = store;
  store.set('hist/_bfstate', { cursorEnd: '20260630' });
  global.fetch = async () => ({ ok: true, json: async () => ({ results: [], totalCount: 0 }) });
  delete require.cache[require.resolve(CB)];
  await require(CB).handler({ queryStringParameters: {} });

  t('[backfill/무데이터] 창 저장됨', featKeys(store).length > 0, featKeys(store).length);
  t('[backfill/무데이터] 커서 전진', (await store.get('hist/_bfstate')).cursorEnd < '20260630');

  // ── ④ 모든 함수 모듈이 실제로 로드된다 ──
  // 문법 검사(node --check)는 require 누락을 잡지 못한다. 실제로 이 작업 중
  // onbid-svc/rtms-svc가 FATAL_RE를 require 없이 쓰고 있었고(런타임 ReferenceError로
  // _health가 통째로 죽을 상태였다) 문법 검사는 멀쩡히 통과했다.
  global.fetch = async () => ({ ok: true, json: async () => ({}), text: async () => '{}' });
  for (const f of fs.readdirSync(FN_DIR).filter(x => x.endsWith('.js'))) {
    let loaded = true, err = '';
    try { require(path.join(FN_DIR, f)); } catch (e) { loaded = false; err = e.message; }
    t(`${f} — 모듈이 로드된다`, loaded, err);
  }

  delete global.__FAKE_STORE__;
  done('upstream (상위 실패와 데이터 없음의 구별)');
})().catch(e => { console.log('THROW', e); process.exit(1); });
