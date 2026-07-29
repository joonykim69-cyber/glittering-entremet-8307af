// netlify/functions/alert-daily.js
// 관심물건 마감 알림 발송 — scheduled(KST 08:00 = cron '0 23 * * *').
//
// 왜: 공매는 마감일 비즈니스다. 관심물건의 개찰이 다가오면 알려주는 것이 사용자가
//   이 서비스를 다시 찾을 이유이자, 우리가 한 가장 기본적인 약속이다.
//
// 동작: 구독(sub/*)을 훑어 오늘 보낼 대상을 lib/alerts.planSends로 계산(D-3/D-1/당일) →
//   Resend API로 발송 → 발송 마커(alertsent/*)를 남겨 **같은 물건·같은 단계는 두 번
//   보내지 않는다**(중복 발송은 신뢰 훼손).
//
// 정직성:
//   - RESEND_API_KEY가 없으면 **보낸 척하지 않는다** — 계산만 하고 `pending`으로 보고,
//     마커도 남기지 않아 키가 설정되는 즉시 정상 발송된다.
//   - 발송 실패한 건도 마커를 남기지 않는다(다음 실행에서 재시도).
// 하트비트 `_run/alert-daily`. `?dry=1` 계산만, `?debug=1` 상세.

'use strict';

const alerts = require('./lib/alerts.js');

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const SEND_CAP = 200;          // 한 실행 발송 상한(폭주·비용 가드)

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

// Resend 발송 어댑터 — 키가 없으면 보내지 않고 그 사실을 그대로 돌려준다.
async function sendEmail({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { sent: false, reason: 'no_key' };
  // 발신 주소: 도메인 인증이 끝난 주소를 ALERT_FROM에 넣는다.
  // (미설정 시 Resend 테스트 주소 — 계정 소유자 본인에게만 전달되므로 실서비스 전 반드시 교체)
  const from = process.env.ALERT_FROM || '신호등옥션 <onboarding@resend.dev>';
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { sent: false, reason: `http_${r.status}`, detail: body.slice(0, 200) };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: 'network', detail: String(e.message || e).slice(0, 200) };
  }
}

exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  const dry = qs.dry === '1';
  const store = await openLedger(event);
  const siteUrl = process.env.URL || 'https://sucessbid.netlify.app';

  try {
    // 구독 수집
    const listing = await store.list({ prefix: 'sub/' });
    const keys = (listing && listing.blobs ? listing.blobs : []).map(b => b.key).filter(k => /^sub\/[A-Za-z0-9_-]+$/.test(k));
    const subs = [];
    for (const k of keys) {
      const s = await store.get(k, { type: 'json' });
      if (s && s.email && !s.unsubscribedAt) subs.push(s);
    }

    // 오늘 보낼 계획(멱등 — 이미 보낸 단계는 제외)
    const isSent = async key => !!(await store.get(key, { type: 'json' }));
    const plans = await alerts.planSends(subs, { isSent });

    let sent = 0, failed = 0, pending = 0;
    const detail = [];
    for (const plan of plans.slice(0, SEND_CAP)) {
      const unsubUrl = `${siteUrl}/.netlify/functions/subscribe?token=${encodeURIComponent(plan.token)}&unsubscribe=1`;
      const mail = alerts.renderEmail(plan, { siteUrl, unsubUrl });
      if (dry) { pending += plan.items.length; detail.push({ to: plan.email.replace(/^(.).*(@)/, '$1***$2'), subject: mail.subject, items: plan.items.length, dry: true }); continue; }
      const res = await sendEmail({ to: plan.email, subject: mail.subject, html: mail.html, text: mail.text });
      if (res.sent) {
        // 발송 성공한 건만 마커 기록 — 실패분은 다음 실행에서 재시도된다
        for (const it of plan.items) await store.setJSON(it.sentKey, { at: new Date().toISOString(), stage: it.stage });
        sent += plan.items.length;
      } else if (res.reason === 'no_key') {
        pending += plan.items.length;                    // 키 없음 — 보낸 척하지 않음
      } else {
        failed += plan.items.length;
        detail.push({ error: res.reason, detail: res.detail });
      }
    }

    const summary = {
      ok: true, dry,
      subscriptions: subs.length, plans: plans.length,
      sent, failed, pending,
      note: pending && !process.env.RESEND_API_KEY
        ? 'RESEND_API_KEY 미설정 — 발송 대상만 계산했습니다(보낸 것으로 처리하지 않음). 키를 넣으면 다음 실행부터 실제 발송됩니다.'
        : undefined,
    };
    if (!dry) await store.setJSON('_run/alert-daily', { at: new Date().toISOString(), ok: true, sent, failed, pending, subs: subs.length });
    return { statusCode: 200, headers: CORS, body: JSON.stringify(qs.debug === '1' ? { ...summary, detail } : summary) };
  } catch (e) {
    try { await store.setJSON('_run/alert-daily', { at: new Date().toISOString(), ok: false, error: e.message }); } catch (_) { /* 무시 */ }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

exports._test = { sendEmail };
