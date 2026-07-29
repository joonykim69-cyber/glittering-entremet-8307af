// test/decision-flow.test.js — 화면이 "숫자 나열"이 아니라 "질문의 순서"인가.
//
// 왜 이 규율을 고정하나(2026-07-29 창업자 지적):
//   상세 한 장에 숫자가 25종 넘게 흩어져 있는데 결론 문장이 하나도 없어, 사용자가
//   "그래서 뭐? 어떻게 하라는 건데?"에 도달했다. 원인은 화면이 **엔진을 만든 순서**로
//   자랐기 때문이다(엔진 하나 = 카드 하나). 헌장은 2026-07-26에 미션을
//   "Prediction은 수단, Decision이 목적"으로 재정의했는데 화면은 Prediction만 나열했다.
//
// 지키는 것:
//   ① 분석 블록이 사용자 질문 순서(Q1 얼마에 → Q2 싼가 → Q3 왜 유찰 → Q4 확인)로 놓임
//   ② 내용 없는 질문 묶음은 제목째 숨김 — 빈 질문이야말로 "그래서 뭐?"의 원인
//   ③ 판단 준비도는 **투자 조언이 아니라 데이터 상태 진술** (좋다/나쁘다 금지)
//   ④ 근거를 태그로 전부 분해 — 마법 숫자 금지
//   ⑤ 성적표는 결정 흐름 밖 각주로, 표본 부족이면 수치를 말하지 않음

'use strict';

const fs = require('fs');
const { t, eq, done, repoPath } = require('./_harness');

const html = fs.readFileSync(repoPath('bidcast-detail.html'), 'utf8');

// ── ① 질문 순서 ──
const qIdx = n => html.indexOf(`data-q="${n}"`);
t('① Q1~Q4 묶음이 모두 존재', [1, 2, 3, 4].every(n => qIdx(n) > 0));
t('① 질문이 순서대로 놓임', qIdx(1) < qIdx(2) && qIdx(2) < qIdx(3) && qIdx(3) < qIdx(4));
// 제목은 사용자가 던지는 말 그대로. **Q번호는 화면에 내지 않는다**(내부 data-q로만 존재) —
// 창업자 지시 2026-07-29: "Q0,1,2,3,4 어디에 해당되는지는 당신과 나만 알면 된다".
t('① 제목이 사용자 질문 그대로', ['이번 회차에 팔릴까', '얼마에 살 수 있나', '그게 싼 건가', '왜 아직 안 팔렸나', '그럼 뭘 확인해야 하나']
  .every(q => html.includes(`<div class="q-head"><b>${q}</b></div>`)));
t('① 화면에 Q번호 배지 없음', !/class="q-no"/.test(html) && !/>Q[0-4]</.test(html));
t('① 사이드바 탭도 사용자 어휘', !/>Q[0-4] /.test(html));

// 섹션이 올바른 질문에 속하는가 (예측·경쟁 → Q1, 시세 → Q2, 유찰 → Q3, 전문가 → Q4)
const at = id => html.indexOf(`id="${id}"`);
t('① 예측·경쟁평가가 Q1에', qIdx(1) < at('sec-ai') && at('sec-eval') < qIdx(2));
t('① 시세·인근통계가 Q2에', qIdx(2) < at('sec-rtms') && at('sec-rgnstats') < qIdx(3));
t('① 유찰 진단이 Q3에', qIdx(3) < at('sec-failDiag') && at('sec-failDiag') < qIdx(4));
t('① 전문가·유사물건이 Q4에', qIdx(4) < at('sec-agents') && qIdx(4) < at('sec-sim'));
t('① 경쟁평가가 시세보다 앞(엔진 순서 아님 — 질문 순서)', at('sec-eval') < at('sec-rtms'));

// 두 블록 분리(온비드 사실 / 우리 분석)는 헌장 원칙 — 재배열이 이걸 깨지 않았는가
t('① 온비드 사실 블록이 분석 블록보다 앞', at('sec-onbid') < at('sec-analysis'));
t('① 임대차·입찰내역은 사실 블록에 유지', at('sec-tenancy') < at('sec-analysis') && at('sec-hist') < at('sec-analysis'));
t('① Q3가 사실 블록으로 되돌아가는 링크 제공', /함께 볼 온비드 사실[\s\S]{0,200}sec-tenancy/.test(html));

// 끊긴 앵커 금지 — sec-info는 2026-07-26에 제거된 섹션이다
t('① 존재하지 않는 sec-info로 보내지 않음', !/sbGo\('sec-info'\)/.test(html) && !/'sec-info'/.test(html));

// ── ② 빈 질문 묶음 숨김 ──
t('② syncQGroups 존재', /function syncQGroups\(\)/.test(html));
t('② 보이는 섹션이 하나도 없으면 묶음을 숨김', /some\(s=>s\.style\.display!=='none'\)/.test(html));
t('② 비동기 표시를 관찰로 잡음(호출부 누락 방지)', /new MutationObserver/.test(html));

// ── ③④ 판단 준비도 엔진 실행 ──
const m = html.match(/\/\/ RD-ENGINE-START[\s\S]*?\/\/ RD-ENGINE-END/);
if (!m) { console.log('RD-ENGINE 블록 추출 실패'); process.exit(1); }
// strict 모드에선 직접 eval이 자체 스코프를 가지므로 함수를 값으로 꺼내 온다
const computeReadiness = eval(m[0] + '\n computeReadiness');

const base = { sealed: true, appr: 10000, min: 7000, fail: 0, mkt: 'ok', mktSupported: true, tenancy: 0 };
const tagsOf = r => r.tags.map(x => x.t).join(' | ');

// 🟢 모든 재료가 갖춰지고 경고 없음
const green = computeReadiness(base);
eq('③ 재료 충분 + 경고 없음 → go', green.level, 'go');
t('③ go일 때 "경고 신호 없음" 명시', /경고 신호 없음/.test(tagsOf(green)));
eq('③ go일 때 다음 확인 없음', green.next.length, 0);

// 🔴 봉인 예측 없음 = 우리 핵심 숫자가 없다
const noSeal = computeReadiness({ ...base, sealed: false });
eq('③ 봉인 없음 → stop', noSeal.level, 'stop');
t('③ 봉인 없음을 근거로 밝힘', /봉인 전/.test(tagsOf(noSeal)));

// 🔴 감정가 미공개 = 싼지 비싼지 판단 불가
const noAppr = computeReadiness({ ...base, appr: 0 });
eq('③ 감정가 미공개 → stop', noAppr.level, 'stop');

// 🔴 충분히 깎였는데도 반복 유찰 = 가격 외 요인 신호
const deepFail = computeReadiness({ ...base, fail: 8, min: 3000 });
eq('③ 유찰 8회 + 저가율 30% → stop', deepFail.level, 'stop');
t('③ 유찰 횟수·저가율을 수치로 근거 제시', /유찰 8회 · 최저가가 감정가의 30%/.test(tagsOf(deepFail)));

// 🟡 유찰이 있지만 아직 가격으로 설명 가능한 구간
const midFail = computeReadiness({ ...base, fail: 3 });
eq('③ 유찰 3회 → warn', midFail.level, 'warn');
t('③ warn은 유찰 진단으로 안내', midFail.next.some(n => n.id === 'sec-failDiag'));

// 🟡 신탁·특수 매각 (최저가 ≥ 감정가) — 할인 물건이 아니다
const trust = computeReadiness({ ...base, min: 12000 });
eq('③ 최저가 ≥ 감정가 → warn', trust.level, 'warn');
t('③ 신탁 구조를 근거로 밝힘', /신탁·특수 매각/.test(tagsOf(trust)));

// 🟡 시세 근거 부족 — 지원 자산군인지에 따라 문구가 달라야 한다
const thin = computeReadiness({ ...base, mkt: 'insufficient' });
eq('③ 시세 표본 부족 → warn', thin.level, 'warn');
t('③ 주거는 "표본 부족"', /주변 시세 표본 부족/.test(tagsOf(thin)));
const mv = computeReadiness({ ...base, mkt: 'insufficient', mktSupported: false });
t('③ 동산·차량은 "자동 확인 불가"(표본 부족이 아님)', /시세 자동 확인 불가/.test(tagsOf(mv)));
t('③ 동산·차량은 거래 채널 직접 확인으로 안내', mv.next.some(n => /거래 채널에서 직접 확인/.test(n.label)));

// 🟡 임대차 존재 = 인수 대상 확인 필요
const lease = computeReadiness({ ...base, tenancy: 2 });
eq('③ 임대차 2건 → warn', lease.level, 'warn');
t('③ 임대차 건수를 수치로 제시', /임대차·점유 정보 2건/.test(tagsOf(lease)));

// stop이 warn을 이긴다(가장 강한 신호가 헤드라인)
eq('③ stop + warn 동시 → stop', computeReadiness({ ...base, sealed: false, fail: 3 }).level, 'stop');

// ── ③ 투자 조언 금지: 좋다/나쁘다·사라/사지마라를 말하지 않는가 ──
const allText = [green, noSeal, deepFail, trust, thin, mv, lease]
  .flatMap(r => r.tags.map(x => x.t).concat(r.next.map(n => n.label))).join(' ');
t('③ 추천·조언 표현 없음', !/(추천|입찰하세요|사세요|매수|유망|기회|수익)/.test(allText), allText.slice(0, 200));
t('③ 좋다/나쁘다 단정 없음', !/(좋은 물건|나쁜 물건|우량|위험한 물건)/.test(allText));
t('③ 화면 문구도 "좋고 나쁨이 아님"을 명시', /물건의 좋고 나쁨이 아니라/.test(html));
t('③ 배지 3단계가 판단 준비도 어휘', /🟢 판단 가능/.test(html) && /🟡 확인 필요/.test(html) && /🔴 판단 보류/.test(html));

// ── ④ 근거 분해 ──
t('④ 모든 판정이 근거 태그를 동반', [noSeal, deepFail, trust, thin, lease].every(r => r.tags.length > 0));
t('④ 태그에 심각도 등급 부여', [...noSeal.tags, ...trust.tags].every(x => ['ok', 'warn', 'stop'].includes(x.l)));
t('④ 숨겨진 섹션으로 안내하지 않음', /style\.display!=='none'/.test(html.slice(html.indexOf('function renderReadiness'))));
t('④ 예시 물건에는 준비도를 매기지 않음', /if\(!isLive\|\|!window\.__rd\.sealedKnown\)/.test(html));

// ── ⑤ 성적표는 각주로, 표본 부족이면 침묵 ──
t('⑤ aiFit 존재', /function aiFit\(assetClass\)/.test(html));
t('⑤ 자산군별 성적 사용(합산 아님)', /d\.byAsset&&d\.byAsset\[assetClass\]/.test(html));
t('⑤ 표본 20건 미만이면 수치 미표기', /a\.n>=20/.test(html));
t('⑤ 봉인 있을 때만 성적 각주', /if\(p\)\{[\s\S]{0,400}aiFit\(ac\)/.test(html));
t('⑤ 자산군 난이도 차이를 문구로 밝힘', /자산군마다 난이도가 달라 합산이 아니라/.test(html));
t('⑤ scoreboard fetch를 시세 각주와 공유(페이지당 1회)', (html.match(/window\.__mktFitP/g) || []).length >= 4);

// ── ⑥ 화면은 결론만, 엔진 내부는 접는다 (창업자 지시 2026-07-29) ──
// "굳이 사용자에게 알려줄 필요가 있다면 접었다 폈다 할 수 있게 — 저렇게 다 나열할 필요가 없어요"
t('⑥ 접기 UI 존재', /\.more>summary\{/.test(html) && /<details class="more">/.test(html));
t('⑥ 통계 출처·모델 버전은 접힘 안', /이 예측은 어떻게 만들어졌나[\s\S]{0,400}modelV/.test(html));
t('⑥ 검증 성적도 접힘 안(aiFitInline)', /aiFitInline/.test(html));
t('⑥ 준비도 설명도 접힘', /<details class="more rd-note">/.test(html));
t('⑥ "다음 확인"은 최대 3개', /\.slice\(0,3\)/.test(html));

done('decision-flow (질문의 순서 · 판단 준비도)');
