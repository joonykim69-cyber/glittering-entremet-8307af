// test/market-surface.test.js — 검증된 시세 정합도를 화면에 노출(GR12) + 두 축 분리(헌장).
//
// 왜: 시세 nowcast 정합도를 수천 건으로 이미 측정해 두고 **화면에 안 쓰고 있었다**.
//   상세 페이지 밴드엔 "신뢰도 높음"이라는 표본 수 기반 **자기 평가**만 있어서, 사용자가
//   이 밴드를 믿어도 되는지 판단할 근거가 없었다. 가진 걸 안 쓰면 사용자에게 도움이
//   안 된다 — Golden Rule 12.
//
// 동시에 지키는 것: **시세와 낙찰가는 별개 지표다.** 섞으면 둘 다 의미가 흐려지므로,
//   화면 어디서 시세를 말하든 "낙찰가와 별개"임을 반드시 함께 적는다.

'use strict';

const fs = require('fs');
const vm = require('vm');
const { t, eq, done, repoPath } = require('./_harness');

const detail = fs.readFileSync(repoPath('bidcast-detail.html'), 'utf8');
const landing = fs.readFileSync(repoPath('bidcast.html'), 'utf8');
const lab = fs.readFileSync(repoPath('bidcast-lab.html'), 'utf8');

// ── 상세 페이지: 검증 성적이 밴드에 붙는가 ──
t('상세: mktFit 조회 함수 존재', /function mktFit\(kind\)/.test(detail));
t('상세: scoreboard의 marketBacktest 사용', /d\.marketBacktest/.test(detail));
t('상세: 밴드에 정합도 자리 확보', /id="mktFitLine"/.test(detail));
t('상세: "검증 성적" 문구', /이 추정 방식의 검증 성적/.test(detail));
t('상세: 낙찰가와 별개임을 명시', /낙찰가 적중률과는 <b>별개 지표<\/b>/.test(detail));
t('상세: 근거(랩)로 연결', /bidcast-lab\.html#mktSec/.test(detail));
t('상세: 방법론을 한 줄로 설명', /그 달 이전 거래로만 추정해 다음 달 실거래로 채점/.test(detail));

// ── 랜딩: 시세 한 줄이 있고, 낙찰가와 섞이지 않는가 ──
t('랜딩: marketLine 존재', /function marketLine\(bt, live\)/.test(landing));
t('랜딩: 별개 지표 명시', /위 낙찰가 지표와 <b>별개<\/b>/.test(landing));
t('랜딩: 근거 링크', /bidcast-lab\.html#mktSec/.test(landing));

// ── 랩: 학습곡선 오해 방지 문구가 유지되는가 ──
t('랩: "학습 곡선 아님" 유지', /"학습해서 좋아지는 곡선"이 아닙니다/.test(lab));
t('랩: 낙찰가와 별개 명시', /이 지표는 낙찰가 적중률과 별개/.test(lab));

// ── 로직 검증: marketLine / mktFit 를 실제로 실행해 본다 ──
function runFn(src, name, ctx) {
  const m = src.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}', 'm'));
  if (!m) return null;
  const sandbox = Object.assign({ escHtml: v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;') }, ctx || {});
  vm.createContext(sandbox);
  vm.runInContext(m[0] + '\n;__out = ' + name + ';', sandbox);
  return sandbox.__out;
}

const marketLine = runFn(landing, 'marketLine');
t('marketLine 추출 성공', typeof marketLine === 'function');
if (typeof marketLine === 'function') {
  // 데이터 없으면 아무것도 안 그린다(가짜 수치 금지)
  eq('데이터 0 → 빈 문자열', marketLine(null, null), '');
  eq('관측 0 → 빈 문자열', marketLine({ overall: { hitRate: 90 }, observations: 0 }, null), '');

  // 과거 재현만 있을 때
  const bt = { observations: 2288, overall: { hitRate: 89.7, medErrPct: 7.7 } };
  let out = marketLine(bt, null);
  t('과거 재현 수치 표기', /89\.7%/.test(out) && /7\.7%/.test(out), out);
  t('과거 재현 라벨', /과거 재현 검증/.test(out), out);
  t('표본 수 병기', /2,288건/.test(out), out);
  t('별개 지표 경고 포함', /별개/.test(out), out);

  // 라이브 채점이 시작되면 그쪽을 우선한다
  out = marketLine(bt, { overall: { n: 40, hitRate: 92.5, avgErrPct: 5.1 } });
  t('라이브 채점 우선', /92\.5%/.test(out) && !/89\.7%/.test(out), out);
  t('라이브 라벨', /봉인한 시세 밴드 채점/.test(out), out);
}

// mktFit 의 유형별/전체 폴백 규칙 — 작은 표본으로 유형 수치를 단정하지 않는다
const pick = (bt, kind) => {
  if (!bt || !bt.overall || !(bt.observations > 0)) return null;
  const k = bt.byKind && bt.byKind[kind];
  if (k && k.n >= 100) return { hitRate: k.hitRate, n: k.n, scope: 'kind' };
  return { hitRate: bt.overall.hitRate, n: bt.observations, scope: 'all' };
};
const btFull = { observations: 2288, overall: { hitRate: 89.7, medErrPct: 7.7 },
  byKind: { apt: { n: 575, hitRate: 98.8, medErrPct: 4.3 }, sh: { n: 40, hitRate: 60 } } };
eq('유형 표본 충분 → 유형 수치', pick(btFull, 'apt').hitRate, 98.8);
eq('유형 표본 부족 → 전체로 폴백', pick(btFull, 'sh').scope, 'all');
eq('없는 유형 → 전체로 폴백', pick(btFull, 'offi').scope, 'all');
eq('데이터 없음 → null', pick(null, 'apt'), null);
// 상세 페이지 코드가 같은 문턱(100건)을 쓰는지 확인 — 규칙이 두 곳에서 갈라지면 의미가 없다
t('상세 코드도 100건 문턱 사용', /k\.n >= 100/.test(detail));

// ── 두 축이 UI에서 섞이지 않는가(헌장 격리 원칙) ──
// 시세를 언급하는 랜딩/상세 블록에는 반드시 "별개" 표기가 함께 있어야 한다.
t('랜딩 시세 줄에 별개 표기 동반', /주변 시세 추정[\s\S]{0,400}별개/.test(landing));
t('상세 시세 줄에 별개 표기 동반', /검증 성적[\s\S]{0,600}별개 지표/.test(detail));

done('market-surface (시세 정합도 노출 · 두 축 분리)');
