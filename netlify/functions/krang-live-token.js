// netlify/functions/krang-live-token.js
// K-rang(케이랑, krang.html — BidCast와 별개 앱) 실시간 통역 모드용
// Gemini Live API 임시 토큰(ephemeral token) 발급 프록시.
//
// 왜 필요한가: Live API는 브라우저가 구글 서버에 WebSocket으로 직결하는 구조라
// 서버 중계가 필요 없지만, 원 API 키를 브라우저에 주면 노출된다. 그래서 이
// 함수가 GEMINI_API_KEY(서버 환경변수에만 존재)로 **1회용·단기 만료** 토큰을
// 만들어 주고, 브라우저는 그 토큰으로만 접속한다 — 구글이 클라이언트 접속용으로
// 제공하는 공식 방식(AuthTokenService.CreateToken, v1alpha).
//
// 반환: { token: "auth_tokens/…", model, expireTime } — 원 키는 절대 반환하지 않는다.
// GEMINI_API_KEY 미설정 시 clean 501 → 클라이언트는 기본(비실시간) 모드로 degrade.
// 모델은 GEMINI_LIVE_MODEL 환경변수로 교체 가능(재배포 불필요) — Live 모델명은
// 프리뷰 주기로 바뀌므로 코드에 못 박지 않는다.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const DEFAULT_LIVE_MODEL = 'gemini-live-2.5-flash-preview';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: { message: 'Method not allowed' } }) };
  }

  // 변수명 후보를 순서대로 탐색 — UI에서 변수 하나가 꼬인 경우(빈 값 저장 등)를
  // 새 이름으로 우회할 수 있게 하고, 실패 시 무엇이 보이는지 정확히 알려준다.
  const CAND = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_KEY'];
  let apiKey = '', keyVar = '';
  for (const n of CAND) {
    const v = (process.env[n] || '').trim();
    if (v) { apiKey = v; keyVar = n; break; }
  }
  if (!apiKey) {
    const present = CAND.filter((n) => process.env[n] !== undefined);
    return {
      statusCode: 501,
      headers: { ...CORS, 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: { message: present.length
        ? present.join(',') + ' 변수는 있으나 값이 비어 있음 — Netlify에서 값을 다시 붙여넣고 재배포'
        : 'GEMINI_API_KEY not configured (함수에 변수가 안 보임 — GEMINI_KEY라는 새 이름으로 만들어도 됩니다)' } }),
    };
  }

  const model = (process.env.GEMINI_LIVE_MODEL || DEFAULT_LIVE_MODEL).replace(/^models\//, '');
  const now = Date.now();
  // 토큰 수명: 세션 시작은 2분 안에, 세션 자체는 30분까지(Live 세션 상한과 별개).
  const body = {
    uses: 1,
    expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
    newSessionExpireTime: new Date(now + 2 * 60 * 1000).toISOString(),
  };

  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1alpha/auth_tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.name) {
      const msg = (data && data.error && data.error.message) || ('upstream HTTP ' + r.status);
      return {
        statusCode: r.status >= 400 && r.status < 600 ? r.status : 502,
        headers: { ...CORS, 'Cache-Control': 'no-store' },
        body: JSON.stringify({ error: { message: msg } }),
      };
    }
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ token: data.name, model: model, keyVar: keyVar, expireTime: body.newSessionExpireTime }),
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers: { ...CORS, 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: { message: 'Proxy error: ' + e.message } }),
    };
  }
};
