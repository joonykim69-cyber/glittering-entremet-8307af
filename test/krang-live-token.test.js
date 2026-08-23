// test/krang-live-token.test.js — K-rang(별개 앱) Gemini Live 임시 토큰 발급 프록시.
//
// 이 함수가 깨지면 안 되는 규율:
//  ① 원 API 키(GEMINI_API_KEY)는 어떤 응답에도 실려 나가지 않는다 — 이 함수의 존재
//     이유 자체가 "키를 브라우저에 주지 않기 위해"다.
//  ② 키 미설정이면 보낸 척하지 않고 clean 501 (클라이언트가 기본 모드로 degrade).
//  ③ 상위(구글) 오류는 실패로 정직하게 전달한다 — 200 + 빈 토큰 같은 애매한 성공 금지.
//  ④ 토큰 응답은 no-store — 1회용 토큰이 CDN·브라우저 캐시에 남으면 안 된다.

'use strict';

const { t, eq, done } = require('./_harness');

const FAKE_KEY = 'AIza-FAKE-KEY-do-not-leak';
const origFetch = global.fetch;
const origKey = process.env.GEMINI_API_KEY;
const origModel = process.env.GEMINI_LIVE_MODEL;

delete require.cache[require.resolve('../netlify/functions/krang-live-token.js')];
const fn = require('../netlify/functions/krang-live-token.js');

function get(){ return fn.handler({ httpMethod: 'GET' }); }

(async () => {
  // ── ② 키 미설정 → clean 501 ──
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_KEY;
  let res = await get();
  eq('키 미설정 → 501', res.statusCode, 501);
  t('키 미설정 → no-store', /no-store/.test(res.headers['Cache-Control'] || ''));

  // ── 정상 발급 ──
  process.env.GEMINI_API_KEY = FAKE_KEY;
  process.env.GEMINI_LIVE_MODEL = 'models/test-live-model'; // models/ 접두 정규화 확인
  let captured = null;
  global.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, json: async () => ({ name: 'auth_tokens/abc123' }) };
  };
  res = await get();
  eq('정상 발급 → 200', res.statusCode, 200);
  const body = JSON.parse(res.body);
  eq('토큰 반환', body.token, 'auth_tokens/abc123');
  eq('모델 반환(models/ 접두 제거)', body.model, 'test-live-model');
  t('업스트림 = v1alpha auth_tokens', /generativelanguage\.googleapis\.com\/v1alpha\/auth_tokens$/.test(captured.url));
  t('키는 헤더로만 전달', captured.opts.headers['x-goog-api-key'] === FAKE_KEY && captured.url.indexOf(FAKE_KEY) < 0);
  const sent = JSON.parse(captured.opts.body);
  eq('1회용 토큰', sent.uses, 1);
  t('만료 시각 지정', !!sent.expireTime && !!sent.newSessionExpireTime);
  // ① 키 유출 0 — 응답 본문·헤더 어디에도 원 키가 없다
  t('응답에 원 키 유출 0', JSON.stringify(res).indexOf(FAKE_KEY) < 0);
  t('토큰 응답 no-store', /no-store/.test(res.headers['Cache-Control'] || ''));

  // ── ③ 상위 오류는 정직하게 실패로 ──
  global.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'quota exceeded' } }) });
  res = await get();
  eq('상위 429 → 429 전달', res.statusCode, 429);
  t('오류 메시지 전달', /quota exceeded/.test(res.body));
  t('오류 응답에도 키 유출 0', res.body.indexOf(FAKE_KEY) < 0);

  // 상위가 200인데 토큰이 없으면 성공으로 위장하지 않는다
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  res = await get();
  t('200 + 토큰 없음 → 실패(502)', res.statusCode === 502);

  // 네트워크 예외 → 502
  global.fetch = async () => { throw new Error('boom'); };
  res = await get();
  eq('네트워크 예외 → 502', res.statusCode, 502);

  // POST 거부(발급은 GET 전용 — 임의 바디로 파라미터를 조작할 표면을 열지 않는다)
  res = await fn.handler({ httpMethod: 'POST' });
  eq('POST → 405', res.statusCode, 405);

  // 원복
  global.fetch = origFetch;
  if (origKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = origKey;
  if (origModel === undefined) delete process.env.GEMINI_LIVE_MODEL; else process.env.GEMINI_LIVE_MODEL = origModel;

  done('krang-live-token (Gemini Live 임시 토큰 — 키 유출 0·정직한 실패)');
})();
