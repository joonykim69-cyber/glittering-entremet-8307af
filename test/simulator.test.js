// test/simulator.test.js — 시뮬레이터가 자산군에 맞는 가정을 쓰는가 (2026-08-02 교정)
//
// 왜 생겼나: 창업자가 저장된 시나리오 화면을 보고 "결과를 정확히 feedback하고 있는게 맞는지"
//   물었다. 확인해 보니 **자산군 분기가 전혀 없어서** 모든 물건에 경락잔금대출(LTV)과
//   취득세 1.5% + 명도비 300만원이 똑같이 적용되고 있었다. 실제 저장분에 이런 게 찍혔다:
//
//     "파텍필립 아쿠아넛 트래블타임 스틸 시계 (5164) — 감정가 1억 1,000만원 ·
//      입찰가율 82% · LTV 90%   →   마진 545만원 · 수익률 40.8% · 실자금 1,337만원"
//
//   손목시계를 담보로 8,118만원을 빌리고, 시계에 명도비 300만원을 쓴다는 계산이다.
//   실자금이 약 6.8배 축소되고 수익률이 그만큼 부풀려진다.
//
// 지키는 것:
//   ① 부동산 계산은 **한 자리도 바뀌지 않는다**(기존 시나리오의 숫자가 달라지면 안 된다)
//   ② 동산·차량은 대출 0 · 취득세 0 · 이자 0 · 실자금 = 낙찰가
//   ③ 모르는 값을 지어내지 않는다(동산 부대비용 요율을 모르므로 0으로 두고 화면에 밝힌다)
//   ④ 옛 시나리오(ac 없음)는 제목으로 추정하되 사용자가 고칠 수 있어야 한다

'use strict';

const fs = require('fs');
const { t, eq, done, repoPath } = require('./_harness');

const html = fs.readFileSync(repoPath('bidcast-simulator.html'), 'utf8');

// 계산부만 떼어내 실행한다 — 슬라이더는 스텁으로 대신한다.
// 마커 줄의 남은 텍스트까지 삼키면 주석이 코드가 되어 깨진다 — 줄 끝까지 건너뛴다.
const src = html.match(/\/\/ SIM-CALC-START[^\n]*\n([\s\S]*?)\/\/ SIM-CALC-END/);
t('계산 블록 추출', !!src);
const vals = { sAppr: 11000, sRatio: 82, sMarket: 12000, sLtv: 90, sRate: 4.5 };
const stub = `const $ = id => ({ value: VALS[id], textContent: '', style: {}, classList: { toggle(){}, add(){}, remove(){} } });
  const document = { querySelectorAll: () => [], getElementById: () => null };
  const render = () => {};`;
const make = () => new Function('VALS', `${stub}\n${src[1]}\nreturn { calc, setAsset, guessAsset, isRe };`)(vals);

// ── ① 부동산 — 기존 계산이 그대로여야 한다 ──
// 창업자 화면의 평택 근린생활시설: 감정가 2억 3,500 · 입찰가율 60% · LTV 70%
//   낙찰가 14,100 · 대출 9,870 · 비용 14,100×1.5%+300=511.5→512 · 실자금 4,742
{
  const m = make();
  const V = { sAppr: 23500, sRatio: 60, sMarket: 25500, sLtv: 70, sRate: 4.5 };
  const mod = new Function('VALS', `${stub}\n${src[1]}\nreturn { calc, setAsset };`)(V);
  mod.setAsset('부동산', { silent: true });
  const r = mod.calc();
  eq('① 부동산 낙찰가', r.bid, 14100);
  eq('① 부동산 대출액', r.loan, 9870);
  eq('① 부동산 취득세·경비', r.tax, Math.round(14100 * 0.015 + 300));
  eq('① 부동산 실자금 (화면값 4,742와 일치)', r.capital, 4742);
  eq('① 부동산 마진', r.margin, 25500 - (14100 + 512));
  t('① 부동산 수익률 229%대 유지', Math.abs(r.roi - 229.6) < 0.6, r.roi);
  t('① 부동산은 월 이자가 있다', r.monthly > 0);
}

// ── ② 동산·차량 — 대출·취득세가 성립하지 않는다 ──
// 창업자 화면의 파텍필립 시계: 감정가 1억 1,000 · 입찰가율 82% · (옛 화면은 LTV 90%)
{
  const m = make();
  m.setAsset('동산', { silent: true });
  const r = m.calc();
  eq('② 낙찰가는 동일', r.bid, 9020);
  eq('② 대출 없음', r.loan, 0);
  eq('② 취득세·명도비 없음', r.tax, 0);
  eq('② 월 이자 없음', r.monthly, 0);
  eq('② 실자금 = 낙찰가 전액', r.capital, 9020);
  // 옛 화면은 실자금 1,337만원 · 수익률 40.8%였다. 같은 마진에서 수익률이 제자리를 찾는다.
  t('② 옛 실자금(1,337)이 아니다', r.capital !== 1337);
  const oldRoi = r.margin / 1337 * 100;
  t('② 수익률이 옛 표시보다 크게 낮아진다', r.roi < oldRoi / 5, `${r.roi.toFixed(1)}% vs ${oldRoi.toFixed(1)}%`);
  eq('② 마진은 시세 기준이라 그대로', r.margin, 12000 - 9020);
  eq('② 자산군이 결과에 실린다', r.asset, '동산');
}

// ── ③ 자산군 추정 (옛 시나리오·구형 링크 폴백) ──
{
  const m = make();
  ['파텍필립 아쿠아넛 트래블타임 스틸 시계 (5164)', '에르메스 와니 켈리 컷 다이아 클러치',
   '금목걸이 등 금제품', '현대 그랜드 스타렉스 2497cc', '골프회원권'].forEach(x =>
    eq(`③ 동산 추정: ${x.slice(0, 12)}`, m.guessAsset(x), '동산'));
  ['경기도 평택시 장당동 483-6 205호 근린생활시설', '서울 강남구 대치동 아파트 84.9㎡',
   '충청남도 공주시 우성면 오동리 산 22-1 임야'].forEach(x =>
    eq(`③ 부동산 추정: ${x.slice(0, 12)}`, m.guessAsset(x), '부동산'));
  eq('③ 빈 제목은 부동산(기본)', m.guessAsset(''), '부동산');
}

// ── ④ 화면 — 숨은 가정을 꺼내 보여주고, 모르는 값은 지어내지 않는다 ──
t('④ 자산군 선택 UI 존재', /class="ac-seg"/.test(html) && /setAsset\('동산'\)/.test(html));
t('④ 동산이면 LTV·금리 슬라이더를 감춘다', /\['ctlLtv', 'ctlRate'\][\s\S]{0,160}display = isRe\(\)/.test(html));
t('④ 동산이면 대출·이자 행을 감춘다', /\['rowLoan', 'rowInterest'\][\s\S]{0,160}display = isRe\(\)/.test(html));
t('④ 적용되지 않음을 화면에 밝힌다', /경락잔금대출과 취득세·명도비 가정이 적용되지 않습니다/.test(html));
t('④ 부대비용을 지어내지 않는다', /공고 원문을 확인하세요/.test(html));
t('④ 동산 시세는 우리가 산정하지 않음을 밝힌다', /동산·차량 시세는 우리가 산정하지 않으니/.test(html));
t('④ 저장 시나리오에 자산군을 남긴다', /ac: r\.asset/.test(html));
t('④ 카드가 동산에 LTV를 표시하지 않는다', /동산·차량 \(전액 현금\)/.test(html));
t('④ 불러오기 시 자산군 복원', /setAsset\(s\.ac \|\| guessAsset\(s\.title\)/.test(html));
t('④ 상세 페이지가 자산군을 넘긴다',
  /&ac=\$\{encodeURIComponent\(\(liveItem && liveItem\.assetClass\) \|\| '부동산'\)\}/
    .test(fs.readFileSync(repoPath('bidcast-detail.html'), 'utf8')));

// ── ⑤ 아이콘 — 🏁는 일부 환경에서 렌더링되지 않아 ▩로 깨졌다(창업자 화면) ──
eq('⑤ 깨지던 체커기 이모지 제거', (html.match(/🏁/g) || []).length, 0);
t('⑤ 제품 내 다른 채점 동선과 같은 아이콘(🎯)', /🎯 개찰 채점/.test(html) && /🎯 나 vs AI/.test(html));

done('시뮬레이터 (자산군별 가정 · 아이콘)');
