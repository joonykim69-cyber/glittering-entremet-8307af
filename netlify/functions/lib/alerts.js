// netlify/functions/lib/alerts.js
// 관심물건 마감 알림 — "누구에게 무엇을 언제 보낼지"를 정하는 순수 계산부.
//
// 왜: 공매는 마감일 비즈니스인데 지금까지 사용자가 돌아올 고리가 없었다(알림 토글은 데모).
//   관심물건의 개찰이 다가오면 알려주는 것이 이 서비스의 가장 기본적인 약속이다.
//
// 설계 원칙:
//   - **로그인 없이 이메일 구독만**(창업자 결정 2026-07-29) — 개인정보 최소 수집.
//   - 같은 물건·같은 단계는 **한 번만** 보낸다(발송 마커로 멱등 — 중복 발송은 신뢰 훼손).
//   - 발송 대상 계산은 여기(순수 함수)에, 실제 전송은 호출자(alert-daily)에 둔다.
//   - 마감이 지났거나 날짜를 모르는 물건은 대상에서 제외(추측 금지).

'use strict';

// 알림 단계 — 마감까지 남은 '달력일' 기준. 3일 전 / 1일 전 / 당일.
const STAGES = [
  { key: 'd3', dday: 3, label: '3일 전' },
  { key: 'd1', dday: 1, label: '내일 마감' },
  { key: 'd0', dday: 0, label: '오늘 마감' },
];

// KST 기준 오늘(YYYYMMDD 정수)
function kstToday(now) {
  const d = new Date((now == null ? Date.now() : now) + 9 * 3600 * 1000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

// bidEnd(yyyyMMddHHmm 등) → 달력일 기준 D-day. 파싱 불가면 null.
function ddayOf(bidEnd, now) {
  const t = String(bidEnd || '').replace(/[^0-9]/g, '').slice(0, 8);
  if (t.length !== 8) return null;
  const y = +t.slice(0, 4), m = +t.slice(4, 6), d = +t.slice(6, 8);
  if (!y || !m || !d) return null;
  const end = Date.UTC(y, m - 1, d);
  const nd = kstToday(now);
  const today = Date.UTC(Math.floor(nd / 10000), Math.floor(nd / 100) % 100 - 1, nd % 100);
  return Math.round((end - today) / 86400000);
}

// 이 물건이 오늘 보내야 할 단계인지 — 아니면 null
function stageFor(bidEnd, now) {
  const dd = ddayOf(bidEnd, now);
  if (dd == null || dd < 0) return null;               // 마감 지남·불명 → 제외
  const s = STAGES.find(x => x.dday === dd);
  return s ? s.key : null;
}

const sentKey = (token, item, stage) => `alertsent/${token}/${item.id}_${item.cdtn || ''}_${stage}`;

// 구독 목록 → 오늘 보낼 발송 계획.
//   subs: [{ token, email, items:[{id,cdtn,title,bidEnd,min,...}], unsubscribedAt? }]
//   isSent(key) → boolean (이미 보냈는지; 호출자가 Blobs로 판정)
// 반환: [{ token, email, items:[{...item, stage, dday}] }] — 보낼 게 없는 구독은 제외
async function planSends(subs, { now, isSent } = {}) {
  const out = [];
  for (const sub of (subs || [])) {
    if (!sub || !sub.email || sub.unsubscribedAt) continue;   // 수신거부·불완전 구독 제외
    const due = [];
    for (const it of (sub.items || [])) {
      if (!it || !it.id) continue;
      const stage = stageFor(it.bidEnd, now);
      if (!stage) continue;
      const key = sentKey(sub.token, it, stage);
      // eslint-disable-next-line no-await-in-loop
      if (isSent && await isSent(key)) continue;             // 멱등 — 같은 단계 재발송 금지
      due.push({ ...it, stage, dday: ddayOf(it.bidEnd, now), sentKey: key });
    }
    if (due.length) {
      // 마감 임박 순
      due.sort((a, b) => a.dday - b.dday);
      out.push({ token: sub.token, email: sub.email, items: due });
    }
  }
  return out;
}

// ── 이메일 본문 ────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}
function fmtMan(man) {
  const n = Number(man) || 0;
  if (!n) return '미공개';
  return n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + '억' : n.toLocaleString() + '만';
}
const STAGE_LABEL = { d3: '3일 뒤 마감', d1: '내일 마감', d0: '오늘 마감' };

// 알림 메일 — 사실만 담는다(예측 단정·수익 표현 금지). 수신거부 링크 필수.
function renderEmail(plan, { siteUrl = '', unsubUrl = '' } = {}) {
  const soonest = plan.items[0];
  const subject = plan.items.length === 1
    ? `[신호등옥션] ${STAGE_LABEL[soonest.stage]} — ${String(soonest.title || '관심물건').slice(0, 40)}`
    : `[신호등옥션] 관심물건 ${plan.items.length}건 마감 임박 (가장 빠른 건: ${STAGE_LABEL[soonest.stage]})`;

  const rows = plan.items.map(it => {
    const link = it.id ? `${siteUrl}/bidcast-detail.html?id=${encodeURIComponent(it.id)}` : siteUrl;
    return `<tr>
      <td style="padding:12px 0;border-bottom:1px solid #E1EAE4;">
        <div style="font-size:12px;font-weight:700;color:#00744B;">${esc(STAGE_LABEL[it.stage])}</div>
        <div style="font-size:15px;font-weight:800;margin:4px 0;"><a href="${esc(link)}" style="color:#10201A;text-decoration:none;">${esc(it.title || '관심물건')}</a></div>
        <div style="font-size:13px;color:#55655D;">최저입찰가 ${esc(fmtMan(it.min))}${it.type ? ' · ' + esc(it.type) : ''}</div>
      </td>
    </tr>`;
  }).join('');

  const html = `<div style="font-family:-apple-system,'Malgun Gothic',sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#10201A;">
    <div style="font-size:18px;font-weight:900;">🚦 신호등옥션</div>
    <p style="font-size:14px;color:#55655D;line-height:1.7;margin:14px 0 18px;">
      관심물건으로 담아두신 물건의 <b>입찰 마감이 다가왔습니다</b>. 입찰 전에 공고문과 공매재산명세서 원문을 꼭 확인하세요.
    </p>
    <table style="width:100%;border-collapse:collapse;">${rows}</table>
    <p style="font-size:12px;color:#697A70;line-height:1.7;margin-top:20px;">
      이 메일은 회원님이 직접 신청하신 관심물건 마감 알림입니다. 예상 낙찰가는 통계적 참고자료이며 <b>입찰 결과나 수익을 보장하지 않습니다</b>.
    </p>
    <p style="font-size:12px;color:#697A70;margin-top:14px;">
      <a href="${esc(unsubUrl)}" style="color:#697A70;">알림 수신 거부</a>
    </p>
  </div>`;

  const text = `[신호등옥션] 관심물건 마감 알림\n\n`
    + plan.items.map(it => `- ${STAGE_LABEL[it.stage]} · ${it.title || '관심물건'} (최저 ${fmtMan(it.min)})`).join('\n')
    + `\n\n입찰 전 공고문·공매재산명세서 원문을 확인하세요. 예상 낙찰가는 참고자료이며 결과를 보장하지 않습니다.\n수신 거부: ${unsubUrl}\n`;

  return { subject, html, text };
}

module.exports = { STAGES, kstToday, ddayOf, stageFor, planSends, renderEmail, sentKey, fmtMan };
