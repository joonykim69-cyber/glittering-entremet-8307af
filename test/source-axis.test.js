// test/source-axis.test.js — 다중 소스(AIOS)로 갈 때 깨지면 안 되는 것들.
//
// 왜 지금 고정하나(2026-07-29 창업자 계획 확정):
//   "지금 공매 사이트를 하나의 모듈로 보고 법원경매·신탁공매를 같은 형식의 섹션으로 추가한다."
//   소스가 하나뿐인 지금은 이 규율이 눈에 띄지 않지만, **지금 세워 두지 않으면 소스를 붙일 때
//   전 페이지를 다시 짜야 한다.** 설계 근거는 002_AIOS_DESIGN_HANDOFF.md.
//
// 지키는 것:
//   ① 소스 축이 화면에 존재하고, 준비 중인 시장을 숨기지 않는다(빈 화면 대신 이유를 말한다)
//   ② 물건을 보여주는 화면은 어디서든 소스 배지를 단다
//   ③ **소스에 색을 쓰지 않는다** — 색은 판단 신호(🟢🟡🔴)에 예약돼 있다
//   ④ 소스가 봉인 → 채점 → 성적표까지 전파된다(합치면 둘 다 오도한다 — byAsset과 같은 논리)
//   ⑤ 공용 CSS가 인라인 <style> **다음에** 링크된다(오버라이드 순서) + 중복 블록이 사라졌다

'use strict';

const fs = require('fs');
const { t, eq, done, makeStore, mockFetch, fnPath, repoPath } = require('./_harness');

const css = fs.readFileSync(repoPath('bidcast.css'), 'utf8');
const landing = fs.readFileSync(repoPath('bidcast.html'), 'utf8');
const list = fs.readFileSync(repoPath('bidcast-list.html'), 'utf8');
const detail = fs.readFileSync(repoPath('bidcast-detail.html'), 'utf8');
const pages = fs.readdirSync(repoPath('.')).filter(f => /^bidcast.*\.html$/.test(f));

// ── ① 소스 축 ──
t('① 축 컴포넌트가 공용 CSS에 정의됨', /\.src-axis\{/.test(css) && /\.src-tab\{/.test(css));
t('① 랜딩에 소스 축', /class="src-axis"/.test(landing));
t('① 물건검색에 소스 축', /class="src-axis"/.test(list));
t('① 세 시장이 모두 축에 있음', ['공매(온비드)', '법원경매', '신탁공매'].every(s => landing.includes(s)));
t('① 준비 중인 시장은 비활성으로 표시', /aria-disabled="true"[\s\S]{0,120}준비 중/.test(landing));
t('① 준비 중을 눌러도 빈 화면이 아니라 이유를 말함', /function srcSoon\(name\)/.test(landing)
  && /같은 화면에 섞으면 판단을 오도합니다/.test(landing));
t('① 성적도 시장별로 공개한다고 약속', /성적도 <b>시장별로 따로<\/b> 공개/.test(landing));
t('① 접근성 역할 부여', /role="tablist"/.test(landing) && /role="tab"/.test(landing));

// ── ② 소스 배지 ──
t('② 배지 컴포넌트 정의', /\.src-badge\{/.test(css));
t('② 물건검색 카드에 배지', /item-kind"><span class="src-badge">/.test(list));
t('② 물건검색 목록형에도 배지', /item-row-kind"><span class="src-badge">/.test(list));
t('② 랜딩 큐레이션 카드에 배지', /cur-chips"><span class="src-badge">/.test(landing));
t('② 랜딩 히어로 픽에도 배지', /cur-hero-kick"><span class="src-badge"/.test(landing));
t('② 상세 히어로에 배지', /<span class="src-badge">🏛 공매\(온비드\)<\/span>/.test(detail));

// ── ③ 색 규율 — 소스는 아이콘·라벨로만 ──
// .src-tab / .src-badge 정의 안에 판단 신호 색(초록·빨강·주황·보라)이 들어가면 안 된다.
{
  const block = css.slice(css.indexOf('.src-axis{'), css.indexOf('@media (max-width:520px)'));
  const banned = /#00A86B|#EB763C|#E5484D|#6B5CE7|--green|--red|--yellow/i;
  t('③ 소스 컴포넌트에 판단 신호 색 미사용', !banned.test(block), block.match(banned) && block.match(banned)[0]);
  t('③ 왜 그런지 CSS에 근거를 남김', /소스에 색을 쓰지 않는다/.test(css));
}

// ── ⑤ 공용 CSS 로드 순서·중복 제거 ──
for (const f of pages) {
  const s = fs.readFileSync(repoPath(f), 'utf8');
  const link = s.indexOf('href="/bidcast.css"');
  t(`⑤ ${f}: 공용 CSS 링크`, link > 0);
  // 인라인 <style>이 먼저, 링크가 나중이어야 오버라이드가 유지된다
  t(`⑤ ${f}: 인라인 style 다음에 링크`, link > s.lastIndexOf('</style>', link) && s.lastIndexOf('</style>', link) > 0);
  t(`⑤ ${f}: 중복 v2 블록 제거`, !s.includes('디자인 시스템 v2 공통 오버라이드'));
}
t('⑤ v2 오버라이드가 공용 CSS로 옮겨짐', /디자인 시스템 v2 공통 오버라이드/.test(css));
t('⑤ 파일이 없어도 페이지가 깨지지 않음을 문서화', /이 파일이 없어도 레이아웃은 깨지지 않고/.test(css));
t('⑤ JS는 계속 인라인(외부 JS 금지 관례 유지)', /JS는 계속 인라인/.test(css));

// ── ④ 소스가 봉인 → 채점 → 성적표까지 전파되는가 ──
(async () => {
  const store = makeStore();
  global.__FAKE_STORE__ = store;
  process.env.URL = 'https://example.test';
  process.env.SEAL_WINDOW_DAYS = '14';

  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const ymd = d => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const bidEnd = ymd(new Date(kst.getTime() + 2 * 86400000)) + '1700';

  mockFetch([
    [/onbid-search/, { items: [{ id: 'S1', pbctCdtnNo: '1', title: '물건', appr: 10000, min: 7000,
      usage: '아파트', type: '아파트', bidEnd, failCount: 0, round: 1, assetClass: '부동산' }] }],
    [/onbid-mvast-search/, { items: [] }],
    [/onbid-vhcl-search/, { items: [] }],
    [/onbid-svc\?svc=stat_usg/, { items: [{ clsCdNm: '아파트', scfbAmtRto1: 80, scfbAmtRto2: 95 }] }],
    [/hist-stats/, { status: 'empty' }],
  ]);
  await require(fnPath('predict-daily.js')).handler({ queryStringParameters: {} });
  const p = await store.get('pred/S1_1');
  eq('④ 봉인 레코드에 source 기록', p && p.source, 'onbid');

  // 채점 → agg.bySource
  mockFetch([[/onbid-bidresults/, { results: [{ id: 'S1', pbctCdtnNo: '1', statCd: '0010', winAmt: 75000000, opbdDt: '20260728' }] }]]);
  await require(fnPath('score-daily.js')).handler({ queryStringParameters: {} });
  const agg = await store.get('agg');
  t('④ 채점이 소스별로 집계', !!(agg.bySource && agg.bySource.onbid), JSON.stringify(agg.bySource));
  eq('④ 소스별 표본', agg.bySource.onbid.n, 1);

  // scoreboard 노출
  delete require.cache[require.resolve(fnPath('scoreboard.js'))];
  const res = await require(fnPath('scoreboard.js')).handler({ httpMethod: 'GET', queryStringParameters: {} });
  const body = JSON.parse(res.body);
  t('④ scoreboard가 bySource 노출', !!(body.bySource && body.bySource.onbid), JSON.stringify(body.bySource));
  eq('④ 소스별 적중률 파생', body.bySource.onbid.hitRate, 100);
  t('④ 합산 요약도 함께 유지', body.summary && body.summary.n === 1);

  // 코드에 "합치면 오도한다"는 근거가 남아 있는가 (규율은 주석으로도 전달된다)
  const sd = fs.readFileSync(repoPath('netlify/functions/score-daily.js'), 'utf8');
  t("④ 소스 분리 이유를 코드에 남김", /합치면 둘 다 오도하기 때문이다/.test(sd));

  delete global.__FAKE_STORE__;
  done('source-axis (다중 소스 껍데기 · 공용 CSS)');
})().catch(e => { console.log('THROW', e); process.exit(1); });
