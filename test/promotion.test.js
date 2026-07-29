// test/promotion.test.js — 챌린저 승격 판정(audit-weekly) + 근거 없으면 예측 안 함(sim/backtest).
//
// 지키려는 것(둘 다 헌장 규율이고, 둘 다 실제로 깨져 있었다 — 2026-07-29 교정):
//   ① **승격은 "비교 승률(headToHead)"로 판정한다** — 구간 적중률이 아니다.
//      적중률은 구간만 넓히면 얼마든지 올라가므로, 그걸로 승격시키면 헌장이 금지한
//      "넓혀서 맞히기"를 감사역이 승인하게 된다.
//   ② **폭 가드** — 챌린저 평균 폭이 챔피언의 2배를 넘으면 어떤 승격도 내리지 않는다.
//   ③ **최저가가 없으면 예측하지 않는다** — 최저가×분위수 모델은 최저가 0에서 [0,0,0]을
//      내놓는데, 그건 예측이 아니라 근거 없음이다. 빗나감으로 집계하면 성적이 왜곡된다.

'use strict';

const { t, eq, done, fnPath } = require('./_harness');

const audit = require(fnPath('audit-weekly.js'));
const sim = require(fnPath('sim-live.js'));
const bt = require(fnPath('backtest.js'));

const A = audit._test || {};
const buildAudit = A.buildAudit;

// 챔피언: 107건 48.6% 적중, 평균 폭 24% (프로덕션 실측 형태)
const champ = () => ({ n: 107, hit: 52, sumAbsErrPct: 3841, sumWidthPct: 2568, byUsage: {} });
// 챌린저: 적중률은 높지만(89.6%) 폭이 11배(275%)이고 상대전적은 지고 있다(47.9%)
const chalWide = (n, bWins) => ({ n, hit: Math.round(n * 0.896), sumWidthPct: 275.3 * n, headToHead: { n, bWins } });
// 폭이 챔피언 수준인 건강한 챌린저
const chalTight = (n, bWins) => ({ n, hit: Math.round(n * 0.6), sumWidthPct: 30 * n, headToHead: { n, bWins } });

if (!buildAudit) {
  t('audit-weekly가 buildAudit을 검증용으로 노출해야 함', false, 'exports._test.buildAudit 없음');
  done('promotion (승격 판정 · noBasis)');
}

// ── ① 프로덕션 재현: 적중률 89.6%인데 상대전적 47.9% → 승격 아님 ──
let r = buildAudit(champ(), chalWide(120, 57), { byUsage: {} });
let c = r.challenger;
t('① 적중률 89.6%라도 승격시키지 않음', c.verdict !== 'early_promote', JSON.stringify(c));
eq('① 폭 초과로 판정 보류', c.verdict, 'blocked_width');
t('① 보류 사유에 폭을 명시', /폭/.test(c.reason), c.reason);
t('① 참고용 적중률은 계속 노출(90%)', c.hitRate === 90, c.hitRate);
t('① 판정 기준은 비교 승률', c.bWinRate === 47.5, c.bWinRate);

// ── ② 폭이 정상이면 비교 승률로 정상 판정 ──
r = buildAudit(champ(), chalTight(120, 80), { byUsage: {} });  // 승률 66.7%
eq('② 폭 정상 + 비교 100건 + 승률 62%↑ → 조기 승격', r.challenger.verdict, 'early_promote');

r = buildAudit(champ(), chalTight(120, 60), { byUsage: {} });  // 승률 50%
eq('② 승률 미달이면 관찰 유지', r.challenger.verdict, 'observing');

r = buildAudit(champ(), chalTight(220, 100), { byUsage: {} }); // 220건 45.5%
eq('② 비교 200건 + 승률 50%↓ → 조기 탈락', r.challenger.verdict, 'early_drop');

r = buildAudit(champ(), chalTight(320, 180), { byUsage: {} }); // 320건 56.3%
eq('② 비교 300건 + 승률 55%↑ → 표준 승격', r.challenger.verdict, 'standard_promote');

// 표본이 적으면 어떤 판정도 안 낸다
r = buildAudit(champ(), chalTight(48, 23), { byUsage: {} });
eq('② 체크포인트 미도달이면 관찰', r.challenger.verdict, 'observing');

// 상대전적이 아예 없으면 판정 불가
r = buildAudit(champ(), { n: 50, hit: 45, sumWidthPct: 1500, headToHead: { n: 0, bWins: 0 } }, { byUsage: {} });
eq('② 비교 표본 0이면 판정 안 함', r.challenger.verdict, 'observing');
t('② 그 사유를 밝힘', /상대전적/.test(r.challenger.reason), r.challenger.reason);

// 승격 후보일 때만 제안에 올린다
r = buildAudit(champ(), chalWide(120, 57), { byUsage: {} });
t('① 보류 사유가 제안 목록에 남음', r.suggestions.some(s => /승격 보류/.test(s)), JSON.stringify(r.suggestions));
t('① "적중률이 높아 보여도" 경고 포함', r.suggestions.some(s => /넓혀|구간을 넓혀/.test(s)), JSON.stringify(r.suggestions));

// ── ③ 최저가 0 → 예측하지 않는다 (sim-live) ──
const cells = { 'L3|0003|냉난방기|1|lt1': { n: 50, lr: { p10: 80, p50: 100, p90: 140 } },
                'L0|0003': { n: 200, lr: { p10: 50, p50: 120, p90: 300 } } };
const P = sim._test.predictOne;
eq('③ 최저가 0 → null(noBasis)', P(cells, { type: '0003', usage: '냉난방기', round: 1, low: 0 }), null);
eq('③ 최저가 음수 → null', P(cells, { type: '0003', usage: '냉난방기', round: 1, low: -5 }), null);
eq('③ 최저가 없음 → null', P(cells, { type: '0003', usage: '냉난방기', round: 1 }), null);
const ok = P(cells, { type: '0003', usage: '냉난방기', round: 1, low: 1000000 });
t('③ 최저가 있으면 정상 예측', ok && ok.lo === 800000 && ok.mid === 1000000, JSON.stringify(ok));

// ── ③ backtest v0.8도 같은 규율 ──
const V8 = bt._test.predictV08;
eq('③ v0.8도 최저가 0이면 예측 안 함', V8({ gb: {}, enc: {} }, { low: 0, type: '0003', usage: 'x', round: 1, apsl: 0 }), null);

done('promotion (승격 판정 · noBasis)');
