// netlify/functions/audit-weekly.js
// 전문 에이전트 ⑧ — "감사역(Auditor)" 주간 채점 감사 예약 함수.
//
// 매주(KST 일요일 21:00, cron '0 12 * * 0' UTC) 채점 장부(agg/aggB/calib)를 읽어
// **규칙 기반**으로 감사 findings를 산출하고, 모델 연혁(chronicle)에 kind:'audit'로
// 추가한다. 채택(모델 변경)은 사람이 결정 — 이 함수는 관찰·제안만 기록한다.
//
// 감사 항목:
//   1) 전체: 적중률·중앙값 오차·평균 구간폭 (목표 95~98% 대비)
//   2) 약한 세그먼트: 용도별 적중률 하위(표본 충분한 것 중) — 개선 우선순위
//   3) 챔피언 vs 챌린저: 승격/탈락 체크포인트 판정
//      기준은 **비교 승률(headToHead — 정답에 더 가까웠던 비율)**이며 구간 적중률이 아니다.
//      (조기승격 비교 100건 62%+, 표준승격 300건 55%+, 조기탈락 200건 50%-)
//      + 폭 가드: 챌린저 평균 구간 폭이 챔피언의 WIDTH_GUARD_X배를 넘으면 승격 판정 보류.
//
// LLM 미사용(공개 로그에 헛소리 방지 — findings는 계산된 사실 + 템플릿 문구).
// 데이터가 얇으면(agg.n < MIN_AUDIT_N) 조용히 no-op. 주 1회 가드(중복 감사 방지).
// 수동 실행: GET /.netlify/functions/audit-weekly

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const MIN_AUDIT_N = 30;      // 최소 채점 표본 (이하면 감사 무의미 → no-op)
const SEG_MIN_N = 10;        // 세그먼트 감사 최소 표본
const TARGET_LO = 95, TARGET_HI = 98; // 구간 적중률 목표(%)
const WIDTH_GUARD_X = 2;     // 챌린저 평균 구간 폭이 챔피언의 몇 배를 넘으면 승격 판정 보류

async function openLedger(event) {
  const blobs = await import('@netlify/blobs');
  try { if (event && typeof blobs.connectLambda === 'function') blobs.connectLambda(event); } catch (e) { /* 자동 구성 */ }
  try { return blobs.getStore('ledger'); }
  catch (e) {
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token = process.env.NETLIFY_BLOBS_TOKEN;
    if (siteID && token) return blobs.getStore({ name: 'ledger', siteID, token });
    throw e;
  }
}

function daysSince(iso) {
  const t = iso ? new Date(iso).getTime() : NaN;
  return isNaN(t) ? Infinity : (Date.now() - t) / 86400000;
}

// 규칙 기반 감사 findings 산출 (계산된 사실만)
function buildAudit(agg, aggB, calib) {
  const n = agg.n || 0;
  const hitRate = n ? Math.round(agg.hit / n * 1000) / 10 : 0;
  const avgErr = n ? Math.round(agg.sumAbsErrPct / n * 10) / 10 : null;
  const avgWidth = agg.sumWidthPct ? Math.round(agg.sumWidthPct / n * 10) / 10 : null;

  // 약한 세그먼트: 용도별 적중률 하위 (표본 충분한 것 중), 목표 하한 미달 우선
  const segs = Object.entries(agg.byUsage || {})
    .filter(([, s]) => s && s.n >= SEG_MIN_N)
    .map(([usage, s]) => ({ usage, n: s.n, hitRate: Math.round(s.hit / s.n * 1000) / 10 }))
    .sort((a, b) => a.hitRate - b.hitRate);
  const weak = segs.filter(s => s.hitRate < TARGET_LO).slice(0, 3);

  // ── 챔피언 vs 챌린저 승격/탈락 체크포인트 (미리 고정된 기준만 — 수시 판정 금지) ──
  //
  // ⚠️ 여기서 쓰는 "승률"은 **비교 승률(headToHead)** = 같은 물건에서 챌린저 중앙값이
  //    챔피언보다 실제 낙찰가에 더 가까웠던 비율이다. 단순 구간 적중률이 아니다.
  //    (2026-07-29 교정: 기존 구현이 적중률로 판정해, 구간을 11배 넓혀 적중률만 높은
  //     챌린저를 승격 대상으로 올리고 있었다 — 창업자가 고정한 "비교 N건 시점 승률"의
  //     오구현이자, 헌장의 "넓혀서 맞히기 금지"와 정면 충돌.)
  //
  // 폭 가드: 적중률은 구간만 넓히면 얼마든지 올라간다. 그래서 챌린저 평균 구간 폭이
  //    챔피언의 WIDTH_GUARD_X배를 넘으면 **어떤 승격 판정도 내리지 않는다**(보류).
  //    "같은 적중률이면 폭이 좁을 것"이라는 고정 결정의 최소 집행 장치다.
  let challenger = null;
  if (aggB && aggB.n > 0) {
    const bHit = Math.round(aggB.hit / aggB.n * 1000) / 10;                 // 참고 지표(판정 아님)
    const h2h = aggB.headToHead || { n: 0, bWins: 0 };
    const bWinRate = h2h.n ? Math.round(h2h.bWins / h2h.n * 1000) / 10 : null; // ← 판정 기준
    const bWidth = aggB.sumWidthPct ? Math.round(aggB.sumWidthPct / aggB.n * 10) / 10 : null;
    const tooWide = avgWidth != null && bWidth != null && bWidth > avgWidth * WIDTH_GUARD_X;

    let verdict = 'observing', reason = '표본 축적 중 — 체크포인트 미도달';
    if (bWinRate == null) {
      reason = '비교 표본 없음 — 상대전적이 쌓여야 판정 가능';
    } else if (tooWide) {
      verdict = 'blocked_width';
      reason = `구간 폭 초과로 승격 판정 보류 — 챌린저 평균 폭 ${bWidth}%가 챔피언 ${avgWidth}%의 ${WIDTH_GUARD_X}배를 넘음(넓혀서 맞히기 방지). 비교 ${h2h.n}건 승률 ${bWinRate}%.`;
    } else if (h2h.n >= 100 && bWinRate >= 62) {
      verdict = 'early_promote';
      reason = `조기 승격 기준 도달(비교 100건+ 승률 62%+ · 현재 ${h2h.n}건 ${bWinRate}% · 평균 폭 ${bWidth}% vs 챔피언 ${avgWidth}%)`;
    } else if (h2h.n >= 300 && bWinRate >= 55) {
      verdict = 'standard_promote';
      reason = `표준 승격 기준 도달(비교 300건+ 승률 55%+ · 현재 ${h2h.n}건 ${bWinRate}%) — 세그먼트 붕괴 확인 후 사람이 결정`;
    } else if (h2h.n >= 200 && bWinRate <= 50) {
      verdict = 'early_drop';
      reason = `조기 탈락 기준(비교 200건+ 승률 50%- · 현재 ${h2h.n}건 ${bWinRate}%)`;
    }
    challenger = { n: aggB.n, hitRate: bHit, avgWidthPct: bWidth, headToHead: h2h, bWinRate, verdict, reason };
  }

  // 제안(템플릿) — 사실에 근거한 권고, 채택은 사람이
  const suggestions = [];
  if (hitRate < TARGET_LO) suggestions.push(`전체 적중률 ${hitRate}% < 목표 하한 ${TARGET_LO}% — 보정(구간 폭 w↑)이 수렴 중인지 확인.`);
  if (hitRate > TARGET_HI && avgWidth != null) suggestions.push(`전체 적중률 ${hitRate}% > 목표 상한 ${TARGET_HI}% — 구간이 넓을 수 있음(평균 폭 ${avgWidth}%), 폭 축소 여지.`);
  if (weak.length) suggestions.push(`약한 용도: ${weak.map(w => `${w.usage}(${w.hitRate}%/${w.n}건)`).join(', ')} — 세분화·표본 확충 우선.`);
  if (challenger && (challenger.verdict === 'early_promote' || challenger.verdict === 'standard_promote')) suggestions.push(`챌린저 승격 후보: ${challenger.reason}. 승격 결정은 사람이 chronicle에 기록.`);
  if (challenger && challenger.verdict === 'early_drop') suggestions.push(`챌린저 조기 탈락 신호: ${challenger.reason}. 새 챌린저 준비 검토.`);
  if (challenger && challenger.verdict === 'blocked_width') suggestions.push(`챌린저 승격 보류: ${challenger.reason} 적중률(${challenger.hitRate}%)이 높아 보여도 구간을 넓혀 얻은 것이므로 승격 근거가 되지 않는다 — 폭 축소가 선행되어야 함.`);
  if (!suggestions.length) suggestions.push('현재 지표는 목표 범위 내 — 특이 조치 불요, 표본 축적 지속.');

  return {
    at: new Date().toISOString(),
    overall: { n, hitRate, avgAbsErrPct: avgErr, avgWidthPct: avgWidth, target: `${TARGET_LO}~${TARGET_HI}%` },
    weakSegments: weak,
    challenger,
    suggestions,
  };
}

exports.handler = async (event) => {
  const store = await openLedger(event);
  const qs = (event && event.queryStringParameters) || {};
  try {
    const [agg, aggB, calib, chronicle] = await Promise.all([
      store.get('agg', { type: 'json' }),
      store.get('aggB', { type: 'json' }),
      store.get('calib', { type: 'json' }),
      store.get('chronicle', { type: 'json' }),
    ]);

    if (!agg || (agg.n || 0) < MIN_AUDIT_N) {
      await store.setJSON('_run/audit-weekly', { at: new Date().toISOString(), ok: true, skipped: 'insufficient_data', n: agg ? agg.n : 0 });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, skipped: true, note: `채점 표본 ${agg ? agg.n : 0}건 < ${MIN_AUDIT_N} — 감사 보류(데이터 축적 후).` }) };
    }

    const chron = Array.isArray(chronicle) ? chronicle : [];
    // 주 1회 가드 — 최근 6일 내 감사 항목이 있으면 스킵(수동 재실행 중복 방지)
    const lastAudit = [...chron].reverse().find(c => c.kind === 'audit');
    if (lastAudit && daysSince(lastAudit.at) < 6 && qs.force !== '1') {
      await store.setJSON('_run/audit-weekly', { at: new Date().toISOString(), ok: true, skipped: 'recent_audit' });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, skipped: true, note: '최근 6일 내 감사 존재 — 스킵(?force=1로 강제).' }) };
    }

    const audit = buildAudit(agg, aggB, calib);
    chron.push({
      kind: 'audit', at: audit.at,
      title: `주간 감사 — 적중률 ${audit.overall.hitRate}% (${audit.overall.n.toLocaleString()}건)${audit.challenger ? ` · 챌린저 ${audit.challenger.hitRate}%(${audit.challenger.verdict})` : ''}`,
      detail: audit,
    });
    while (chron.length > 500) chron.splice(1, 1); // genesis(0) 보존
    await store.setJSON('chronicle', chron);
    await store.setJSON('audit/latest', audit);
    await store.setJSON('_run/audit-weekly', { at: new Date().toISOString(), ok: true, hitRate: audit.overall.hitRate, verdict: audit.challenger ? audit.challenger.verdict : null });

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, audit }) };
  } catch (e) {
    try { await store.setJSON('_run/audit-weekly', { at: new Date().toISOString(), ok: false, error: e.message }); } catch (_) { /* 무시 */ }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

// fixture 검증용(런타임 미사용) — 승격 판정 규율은 test/promotion.test.js가 고정한다.
exports._test = { buildAudit, WIDTH_GUARD_X };
