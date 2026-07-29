// test/by-asset.test.js — 자산군별 성적 분리(집계 → API → 화면).
//
// 왜 이 규율을 고정하나: 합산 숫자 하나는 표본이 한 자산군에 쏠리면 **정직한데도 오도한다**.
//   실측(2026-07-29): 채점 107건 중 부동산 1건 / 동산 64 / 자동차 42 → 전체 48.6%.
//   그런데 sim 실측으로 부동산은 오차 1~5%로 잘 맞는다. 부동산 사용자가 48.6%를 보면
//   "못 맞히는 서비스"로 읽는다 — 정직성이 유용성을 깎아먹는 지점.
//   그래서 자산군별로 나눠 보여주는 것이 **더 정직하면서 동시에 더 쓸모있다**.
//
// 지키는 것:
//   ① 채점기가 자산군별 오차·구간폭까지 누적한다(적중률만으로는 난이도 차이가 안 보인다)
//   ② scoreboard가 자산군별 파생 지표를 계산해 내보낸다
//   ③ 감사역이 표본 쏠림과 약한 자산군을 짚는다
//   ④ 화면(랩·랜딩)이 합산 수치를 "합산"이라 밝히고 자산군별을 함께 보여준다

'use strict';

const fs = require('fs');
const { t, eq, done, makeStore, mockFetch, fnPath, repoPath } = require('./_harness');

const audit = require(fnPath('audit-weekly.js'));
const { buildAudit } = audit._test;

// ── ③ 감사역: 표본 쏠림과 약한 자산군 ──
// 프로덕션 실측 구성 그대로 (동산 64 / 자동차 42 / 부동산 1)
const agg = {
  n: 107, hit: 52, sumAbsErrPct: 35.9 * 107, sumWidthPct: 24 * 107,
  byUsage: { '기계장비': { n: 32, hit: 9 } },
  byAsset: {
    '동산': { n: 64, hit: 25, sumAbsErrPct: 45 * 64, sumWidthPct: 28 * 64 },
    '자동차': { n: 42, hit: 26, sumAbsErrPct: 22 * 42, sumWidthPct: 19 * 42 },
    '부동산': { n: 1, hit: 1, sumAbsErrPct: 3.7, sumWidthPct: 41 },
  },
};
let r = buildAudit(agg, null, { byUsage: {} });

eq('③ 자산군 3종 집계', r.byAsset.length, 3);
eq('③ 표본 많은 순 정렬', r.byAsset.map(a => a.asset), ['동산', '자동차', '부동산']);
eq('③ 자산군별 적중률', r.byAsset.find(a => a.asset === '자동차').hitRate, 61.9);
eq('③ 자산군별 오차', r.byAsset.find(a => a.asset === '자동차').avgAbsErrPct, 22);
eq('③ 자산군별 폭', r.byAsset.find(a => a.asset === '자동차').avgWidthPct, 19);

// 쏠림 없음(동산 64/107 = 60% < 70%)이라 dominant는 안 잡혀야 한다
eq('③ 60% 점유는 쏠림 아님', r.dominantAsset, null);
t('③ 약한 자산군을 짚음', r.suggestions.some(s => /가장 약한 자산군.*동산/.test(s)), JSON.stringify(r.suggestions));

// 한 자산군이 70% 이상이면 "합산은 사실상 그 자산군 성적"이라고 경고
const skewed = { ...agg, byAsset: { '동산': { n: 100, hit: 40, sumAbsErrPct: 4500, sumWidthPct: 2800 }, '부동산': { n: 7, hit: 6, sumAbsErrPct: 25, sumWidthPct: 280 } } };
r = buildAudit(skewed, null, { byUsage: {} });
t('③ 쏠림 감지', r.dominantAsset && r.dominantAsset.asset === '동산', JSON.stringify(r.dominantAsset));
t('③ 합산이 오도임을 명시', r.suggestions.some(s => /사실상 동산 성적/.test(s)), JSON.stringify(r.suggestions));

// 자산군이 하나뿐이면 쏠림 경고 무의미
r = buildAudit({ ...agg, byAsset: { '동산': { n: 107, hit: 52 } } }, null, { byUsage: {} });
eq('③ 자산군 1종이면 쏠림 경고 없음', r.dominantAsset, null);

// 오차·폭은 2026-07-29 이후 채점분에만 있다 — 없는 수치를 "null%"로 찍지 않는다(GR6)
r = buildAudit({ ...agg, byAsset: { '동산': { n: 64, hit: 25 }, '자동차': { n: 42, hit: 26 } } }, null, { byUsage: {} });
const wk = r.suggestions.find(x => /가장 약한 자산군/.test(x));
t('③ 구데이터: null% 미출력', !/null/.test(wk), wk);
t('③ 구데이터에서도 적중률·표본은 표기', /39\.1% \/ 64건/.test(wk), wk);

(async () => {
  // ── ① 채점기가 자산군별 오차·폭을 누적하는가 ──
  const store = makeStore();
  global.__FAKE_STORE__ = store;
  process.env.URL = 'https://example.test';

  const pred = (id, asset) => ({ id, pbctCdtnNo: '1', title: `물건${id}`, type: '아파트', assetClass: asset, lo: 900, mid: 1000, hi: 1100, w: 0.18, modelV: 'v0.1' });
  store.seed('pred/R1_1', pred('R1', '부동산'));
  store.seed('pred/M1_1', pred('M1', '동산'));
  const results = [
    { id: 'R1', pbctCdtnNo: '1', statCd: '0010', winAmt: 1000 * 10000, opbdDt: '20260728' },   // 적중, 오차 0
    { id: 'M1', pbctCdtnNo: '1', statCd: '0010', winAmt: 2000 * 10000, opbdDt: '20260728' },   // 빗나감, 오차 50%
  ];
  mockFetch([[/onbid-bidresults/, { results }]]);

  const score = require(fnPath('score-daily.js'));
  await score.handler({ queryStringParameters: {} });
  const a = await store.get('agg');
  t('① 자산군별로 분리 집계', a.byAsset && a.byAsset['부동산'] && a.byAsset['동산'], JSON.stringify(a.byAsset));
  eq('① 부동산 적중', a.byAsset['부동산'].hit, 1);
  eq('① 동산 빗나감', a.byAsset['동산'].hit, 0);
  t('① 자산군별 오차 누적', a.byAsset['부동산'].sumAbsErrPct === 0 && a.byAsset['동산'].sumAbsErrPct === 50, JSON.stringify(a.byAsset));
  t('① 자산군별 폭 누적', a.byAsset['부동산'].sumWidthPct > 0 && a.byAsset['동산'].sumWidthPct > 0, JSON.stringify(a.byAsset));
  // 같은 물건이 응답에 여러 번 들어와도 한 번만 집계된다(자산군 3회 조회에 동일 행이 실려 왔음)
  eq('① 실행 내 중복 집계 0 (2건만 채점)', a.n, 2);

  // ── ② scoreboard가 파생 지표까지 내보내는가 ──
  delete require.cache[require.resolve(fnPath('scoreboard.js'))];
  const sb = require(fnPath('scoreboard.js'));
  const res = await sb.handler({ httpMethod: 'GET', queryStringParameters: {} });
  const body = JSON.parse(res.body);
  const ba = body.byAsset || {};
  t('② byAsset 노출', !!ba['부동산'], JSON.stringify(ba));
  eq('② 적중률 파생', ba['부동산'].hitRate, 100);
  eq('② 오차 파생', ba['동산'].avgAbsErrPct, 50);
  t('② 폭 파생', ba['동산'].avgWidthPct != null, JSON.stringify(ba['동산']));
  t('② 합산 요약도 함께 유지', body.summary && body.summary.n === 2, JSON.stringify(body.summary));

  delete global.__FAKE_STORE__;

  // ── ④ 화면이 합산을 "합산"이라 밝히고 자산군별을 함께 보여주는가 ──
  const lab = fs.readFileSync(repoPath('bidcast-lab.html'), 'utf8');
  t('④ 랩: 합산임을 표기', /전 자산군 합산/.test(lab));
  t('④ 랩: 자산군별 오차·폭 렌더', /오차 \$\{s\.avgAbsErrPct\}%|오차 \${s\.avgAbsErrPct}/.test(lab) || lab.includes('`오차 ${s.avgAbsErrPct}%`'));
  t('④ 랩: 표본 부족 자산군 구분', /표본 부족 — 참고만/.test(lab));
  t('④ 랩: 난이도 차이를 설명', /예측 난이도가 근본적으로 다릅니다/.test(lab));
  t('④ 랩: 판정 기준이 상대전적임을 명시', /판정은 <b>상대전적<\/b>/.test(lab));

  const landing = fs.readFileSync(repoPath('bidcast.html'), 'utf8');
  t('④ 랜딩: 합산임을 표기', /전 자산군 합산/.test(landing));
  t('④ 랜딩: 자산군별 한 줄', /function assetLine\(/.test(landing));
  t('④ 랜딩: 표본 부족 처리', /표본 부족|\(부족\)/.test(landing));
  t('④ 랜딩: 랩으로 연결', /bidcast-lab\.html#assetAccGrid/.test(landing));

  done('by-asset (자산군별 성적 분리)');
})().catch(e => { console.log('THROW', e); process.exit(1); });
