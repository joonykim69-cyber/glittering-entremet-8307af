#!/usr/bin/env node
// test/selfcheck.js — **돌고 있는 제품**을 열어 본다. (2026-08-02 창업자 지적으로 신설)
//
// 왜 생겼나: 그동안 검증은 "방금 만든 코드"에만 걸려 있었다. 라이브 산출물을 열어 보는 절차가
//   없어서, 창업자가 화면을 보내 줘야 문제가 드러났다 — 신탁 트랙의 SM3도, 모델 연혁 나래비도,
//   손목시계에 붙은 LTV도 전부 **이미 배포돼 돌고 있던 것**이었다. 셋 중 둘은 `curated` 출력
//   한 번만 열어 봤으면 잡혔다(자산군 분포가 자동차 15·동산 1·**부동산 0**이었다).
//
// 무엇을 하나: 프로덕션 공개 엔드포인트를 읽어 **"말이 안 되는 상태"** 를 찾는다.
//   테스트가 아니라 **점검**이다 — 실패해도 CI를 막지 않고, 사람이 봐야 할 것을 목록으로 낸다.
//   (npm test는 코드가 규율을 지키는지 보고, 이건 제품이 지금 제정신인지 본다.)
//
// 실행: npm run selfcheck   [BASE=https://... 로 대상 변경]

'use strict';

const BASE = process.env.BASE || 'https://sucessbid.netlify.app';
const findings = [];
const add = (sev, where, what, detail) => findings.push({ sev, where, what, detail });

async function get(path) {
  const r = await fetch(`${BASE}/.netlify/functions/${path}`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
const hours = (t) => t ? (Date.now() - new Date(t).getTime()) / 3600000 : Infinity;

(async () => {
  let sb = null, cur = null, hs = null;
  try { sb = await get('scoreboard'); } catch (e) { add('🔴', 'scoreboard', '조회 실패', e.message); }
  try { cur = await get('curated'); } catch (e) { add('🟡', 'curated', '조회 실패', e.message); }
  try { hs = await get('hist-stats'); } catch (e) { add('🟡', 'hist-stats', '조회 실패', e.message); }

  // ── ① 예약 함수가 살아 있는가 ──
  // 하트비트가 **없는 것**이 가장 위험하다 — ok:false는 보이지만 없는 건 "확인 불가"로 묻힌다.
  // collect-history가 정확히 그렇게 죽어 있었다(2026-08-02).
  const EXPECT = { predict: 30, score: 30, collect: 30, mktSeal: 30, alert: 30, trainGb: 30 };
  for (const [k, maxH] of Object.entries(EXPECT)) {
    const r = sb && sb.runs && sb.runs[k];
    if (!r) add('🔴', `runs.${k}`, '하트비트 없음 — 한 번도 끝까지 못 갔거나 실행되지 않음');
    else if (r.ok === false) add('🔴', `runs.${k}`, '마지막 실행 실패', r.error);
    else if (hours(r.at) > maxH) add('🟡', `runs.${k}`, `${Math.round(hours(r.at))}시간째 갱신 없음`);
  }
  // 실행시간이 함수 한도(30초)에 가까워지면 곧 조용히 죽는다 — 죽기 전에 보이게.
  const cms = sb && sb.runs && sb.runs.collect && sb.runs.collect.incMs;
  if (cms > 20000) add('🟡', 'runs.collect', `증분 수집 ${Math.round(cms / 1000)}초 — 30초 한도에 근접`);
  const skipped = sb && sb.runs && sb.runs.collect && sb.runs.collect.incSkipped;
  if (skipped && skipped.length) add('🟡', 'runs.collect', '반쪽이라 갱신 못 한 자산군', skipped.join(','));

  // ── ② 랜딩에 무엇이 올라가 있는가 ──
  // 부동산 공매 서비스인데 부동산이 0건이면 그것만으로 이상 신호다(실제로 그랬다).
  if (cur && cur.status !== 'empty') {
    const items = cur.items || [];
    const byAc = {};
    items.forEach(x => { byAc[x.assetClass] = (byAc[x.assetClass] || 0) + 1; });
    const re = byAc['부동산'] || 0;
    if (!items.length) add('🟡', 'curated', '주목 물건 0건');
    else if (!re) add('🔴', 'curated', '부동산이 0건 — 부동산 공매 서비스의 랜딩', JSON.stringify(byAc));
    else if (re / items.length < 0.15) add('🟡', 'curated', `부동산 비중 ${Math.round(re / items.length * 100)}%`, JSON.stringify(byAc));
    // 트랙이 통째로 비면 이유가 있어야 한다(밴드 부족·문턱 등) — 조용히 비어 있으면 안 된다.
    const tr = cur.tracks || {};
    Object.entries(tr).forEach(([k, v]) => { if (!(v || []).length) add('🟡', `curated.${k}`, '트랙 비어 있음'); });
    // 트랙 이름과 내용이 어긋나는가 — "신탁"에 차량이 들어가 있던 사고의 재발 방지.
    const trust = tr.trust || [];
    const badTrust = trust.filter(x => x.assetClass && x.assetClass !== '부동산');
    if (badTrust.length) add('🔴', 'curated.trust', '신탁 트랙에 부동산이 아닌 물건', badTrust.map(x => x.assetClass).join(','));
  }

  // ── ③ 성적표가 말이 되는가 ──
  if (sb && sb.summary) {
    const s = sb.summary;
    if (s.n > 0 && s.avgWidthPct > 0 && s.hitRate > 90 && s.avgWidthPct > 150) {
      add('🟡', 'summary', '넓혀서 맞히는 모양 — 적중률↑ 폭↑', `적중 ${s.hitRate}% / 폭 ${s.avgWidthPct}%`);
    }
    // 자산군 하나가 표본을 독식하면 합산 수치가 다른 자산군 사용자를 오도한다(헌장 14절).
    const ba = sb.byAsset || {};
    const tot = Object.values(ba).reduce((a, b) => a + (b.n || 0), 0);
    Object.entries(ba).forEach(([k, v]) => {
      if (tot > 0 && (v.n || 0) / tot > 0.7) add('🟡', 'byAsset', `${k}이 표본의 ${Math.round(v.n / tot * 100)}% — 합산 수치는 사실상 이 자산군 성적`);
    });
  }
  // 챌린저가 폭으로 이기고 있으면 승격 판정이 오염된다(GR4).
  const ch = sb && sb.challenger;
  if (ch && ch.n > 0 && sb.summary && sb.summary.avgWidthPct > 0) {
    const x = ch.avgWidthPct / sb.summary.avgWidthPct;
    if (x > 2) add('🟡', 'challenger', `구간 폭이 챔피언의 ${x.toFixed(1)}배 — 승격 보류 대상`);
  }
  // v0.8 승격 판정점 트립와이어 — 100/200/300건은 **사람이 판정하는** 고정 체크포인트(헌장 14절).
  // 도달을 놓치면 판정 없이 표본만 쌓이므로, 도달한 뒤에는 판정이 끝날 때까지 계속 알린다
  // (판정 결과로 모델이 승격·기각되면 aggB가 바뀌어 자연히 사라진다).
  if (ch && ch.modelV === 'v0.8-gbdt' && ch.headToHead && ch.headToHead.n >= 100) {
    const n = ch.headToHead.n;
    const point = n >= 300 ? '표준 승격(300건·55%+·세그먼트 붕괴 없음)' : n >= 200 ? '조기 탈락(200건·50% 이하면 탈락)' : '조기 승격(100건·62%+)';
    const rate = Math.round(ch.headToHead.bWins / n * 1000) / 10;
    add('🟡', 'challenger', `판정점 도달 — 비교 ${n}건 · 상대전적 ${rate}% · ${point} 기준으로 창업자 판정 차례`, `폭 배수 가드(2배) 함께 확인`);
  }

  // ── ④ 학습 데이터가 신선한가 ──
  if (hs && hs.status === 'ok') {
    // hist-stats 캐시 태그의 가운데 칸이 비면 collect-history가 끝까지 못 간 것이다.
    const tag = String(hs.srcUpdatedAt || '');
    if (/\|\|/.test(tag)) add('🔴', 'hist-stats', 'hist/_meta 없음 — 증분 수집기가 완주하지 못함', tag);
    if (hours(hs.builtAt) > 48) add('🟡', 'hist-stats', `셀이 ${Math.round(hours(hs.builtAt) / 24)}일째 재빌드 안 됨`);
  }

  // v0.8 학습 실패는 봉인을 멈추지 않는다(어제 모델로 계속) — 그래서 더 조용히 낡는다.
  const tg = sb && sb.runs && sb.runs.trainGb;
  if (tg && tg.ok === false) add('🟡', 'runs.trainGb', 'v0.8 학습 실패 — 어제 아티팩트로 봉인 중', tg.error);

  // ── ⑤ 예산 ──
  const q = sb && sb.apiQuota;
  if (q && q.cap > 0 && q.used / q.cap > 0.8) add('🟡', 'apiQuota', `온비드 예산 ${q.used}/${q.cap} 사용`);

  // ── 출력 ──
  const red = findings.filter(f => f.sev === '🔴');
  console.log(`\n제품 자가점검 — ${BASE}`);
  console.log('─'.repeat(64));
  if (!findings.length) console.log('이상 없음.');
  for (const f of findings) {
    console.log(`${f.sev} ${f.where.padEnd(18)} ${f.what}${f.detail ? '  · ' + f.detail : ''}`);
  }
  console.log('─'.repeat(64));
  console.log(`${findings.length}건 (🔴 ${red.length} · 🟡 ${findings.length - red.length})`);
  // 점검이지 테스트가 아니다 — 종료 코드로 CI를 막지 않는다.
  process.exit(0);
})().catch(e => { console.log('자가점검 실패:', e.message); process.exit(0); });
