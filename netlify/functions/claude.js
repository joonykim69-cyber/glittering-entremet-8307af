// netlify/functions/claude.js
// K-Map Linker — Claude API 프록시
// 앱에는 키가 없고, 키는 Netlify 환경변수 ANTHROPIC_API_KEY 에만 존재합니다.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS,
      body: JSON.stringify({ error: { message: 'Method not allowed' } }),
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: { message: 'Server API key not configured (ANTHROPIC_API_KEY)' } }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: { message: 'Invalid JSON body' } }),
    };
  }

  if (!payload.max_tokens || payload.max_tokens > 1500) {
    payload.max_tokens = 1000;
  }
  const ALLOWED = ['claude-haiku-4-5-20251001'];
  if (!ALLOWED.includes(payload.model)) {
    payload.model = 'claude-haiku-4-5-20251001';
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    return {
      statusCode: r.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: { message: 'Proxy error: ' + e.message } }),
    };
  }
};
