// netlify/functions/subscribe.js
// 관심물건 마감 알림 구독 — **로그인 없이 이메일만**(창업자 결정 2026-07-29).
//
// 왜 이렇게: 풀 회원 시스템은 개인정보 DB 운영 책임과 고정비를 만든다. 지금 필요한 건
//   "마감이 다가오면 알려준다"는 리텐션 고리 하나뿐이므로, 이메일 + 관심물건 목록만
//   최소 수집하고 토큰 URL로 관리·수신거부할 수 있게 한다(헌장의 단계적 접근).
//
// 개인정보 최소화:
//   - 저장 항목 = 이메일, 관심물건(공개 물건정보), 구독 시각. 그 외 아무것도 받지 않는다.
//   - 이메일 원문은 구독 레코드에만 두고, 조회 키는 **해시**로 만든다(열거 방지).
//   - 수신거부 시 이메일을 즉시 지우고 마커만 남긴다(재구독 시 새 토큰).
//
// 엔드포인트:
//   POST {email, items[]}          → 구독 생성/갱신, { token }
//   POST {token, items[]}          → 관심물건 동기화(이메일 재입력 없이)
//   GET  ?token=...                → 구독 조회(이메일 마스킹)
//   GET  ?token=...&unsubscribe=1  → 수신거부(원클릭 — 메일 링크용)

'use strict';

const crypto = require('crypto');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};
const MAX_ITEMS = 50;          // 구독당 관심물건 상한(폭주 방지)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function openLedger(event) {
  if (global.__FAKE_STORE__) return global.__FAKE_STORE__;
  const blobs = await import('@netlify/blobs');
  try { if (event && typeof blobs.connectLambda === 'function') blobs.connectLambda(event); } catch (e) { /* 자동 구성 */ }
  try {
    return blobs.getStore('ledger');
  } catch (e) {
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token = process.env.NETLIFY_BLOBS_TOKEN;
    if (siteID && token) return blobs.getStore({ name: 'ledger', siteID, token });
    throw e;
  }
}

const emailKey = e => 'subidx/' + crypto.createHash('sha256').update(String(e).trim().toLowerCase()).digest('hex').slice(0, 32);
const newToken = () => crypto.randomBytes(24).toString('base64url');
const maskEmail = e => String(e || '').replace(/^(.)(.*)(@.*)$/, (_, a, b, c) => a + '*'.repeat(Math.max(1, b.length)) + c);

// 클라이언트가 보낸 관심물건에서 **필요한 필드만** 추린다(불필요한 데이터 저장 금지).
function sanitizeItems(items) {
  const out = [];
  for (const it of (Array.isArray(items) ? items : []).slice(0, MAX_ITEMS)) {
    if (!it || it.id == null) continue;
    out.push({
      id: String(it.id).slice(0, 40),
      cdtn: it.cdtn != null ? String(it.cdtn).slice(0, 20) : '',
      title: String(it.title || '').slice(0, 120),
      bidEnd: String(it.bidEnd || '').replace(/[^0-9]/g, '').slice(0, 12),
      min: Number(it.min) || 0,
      type: String(it.type || '').slice(0, 20),
    });
  }
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const qs = (event && event.queryStringParameters) || {};
  const store = await openLedger(event);

  try {
    // ── 수신거부 (메일 링크 원클릭) ──
    if (event.httpMethod === 'GET' && qs.unsubscribe === '1') {
      const token = String(qs.token || '');
      const sub = token ? await store.get(`sub/${token}`, { type: 'json' }) : null;
      if (!sub) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: { message: '구독을 찾을 수 없습니다(이미 해지되었을 수 있습니다).' } }) };
      // 이메일은 즉시 삭제하고 해지 사실만 남긴다
      await store.setJSON(`sub/${token}`, { token, items: [], unsubscribedAt: new Date().toISOString() });
      if (sub.email) { try { await store.setJSON(emailKey(sub.email), { token: null, unsubscribedAt: new Date().toISOString() }); } catch (e) { /* 무시 */ } }
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' },
        body: '<meta charset="utf-8"><div style="font-family:sans-serif;max-width:520px;margin:60px auto;text-align:center"><h2>알림 수신이 해지되었습니다</h2><p style="color:#55655D">등록하신 이메일 주소는 삭제되었습니다. 다시 받고 싶으시면 마이페이지에서 언제든 새로 신청하실 수 있습니다.</p><p><a href="/bidcast-my.html" style="color:#00744B;font-weight:700">마이페이지로</a></p></div>' };
    }

    // ── 구독 조회 ──
    if (event.httpMethod === 'GET') {
      const token = String(qs.token || '');
      const sub = token ? await store.get(`sub/${token}`, { type: 'json' }) : null;
      if (!sub || sub.unsubscribedAt) return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'none' }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'ok', email: maskEmail(sub.email), count: (sub.items || []).length, createdAt: sub.createdAt }) };
    }

    if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: { message: 'GET/POST only' } }) };

    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: { message: '잘못된 요청 형식' } }) }; }
    const items = sanitizeItems(body.items);

    // ── 토큰으로 관심물건만 동기화(이메일 재입력 없이) ──
    if (body.token) {
      const token = String(body.token);
      const sub = await store.get(`sub/${token}`, { type: 'json' });
      if (!sub || sub.unsubscribedAt) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: { message: '구독을 찾을 수 없습니다.' } }) };
      await store.setJSON(`sub/${token}`, { ...sub, items, updatedAt: new Date().toISOString() });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'ok', token, count: items.length }) };
    }

    // ── 신규/재구독 ──
    const email = String(body.email || '').trim();
    if (!EMAIL_RE.test(email) || email.length > 190) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: { message: '올바른 이메일 주소를 입력해 주세요.' } }) };
    }
    const idxKey = emailKey(email);
    const idx = await store.get(idxKey, { type: 'json' });
    let token = idx && idx.token ? idx.token : null;
    if (token) {
      const existing = await store.get(`sub/${token}`, { type: 'json' });
      if (!existing || existing.unsubscribedAt) token = null; // 해지된 구독은 새 토큰으로
    }
    if (!token) token = newToken();

    const now = new Date().toISOString();
    const prev = await store.get(`sub/${token}`, { type: 'json' });
    await store.setJSON(`sub/${token}`, {
      token, email, items,
      createdAt: (prev && prev.createdAt) || now,
      updatedAt: now,
    });
    await store.setJSON(idxKey, { token, at: now });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'ok', token, count: items.length, email: maskEmail(email) }) };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: { message: e.message } }) };
  }
};

exports._test = { sanitizeItems, maskEmail, emailKey, EMAIL_RE };
