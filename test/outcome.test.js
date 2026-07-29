// test/outcome.test.js — 결과 예보("이번에 팔릴까" · "몇 명과 붙나")도 봉인·채점 규율을 지키는가.
//
// 왜 만들었나(2026-07-29):
//   유찰 8회 물건에 "예상 낙찰가 1.2억"만 보여주면서 **"이번에도 안 팔릴 가능성이 높다"는
//   말은 하지 않는** 것이 지금까지의 상태였다. 사용자의 첫 질문("이번에 팔리긴 하나")에
//   답하지 않고 두 번째 질문(얼마에)부터 답한 셈이다. 입찰자 수(bd)는 11만 건 넘게 수집해
//   두고 소비처가 0이었다.
//
// 지키는 것:
//   ① 두 숫자 모두 낙찰가와 **같은 순간에 봉인**되고, 근거 셀이 없으면 만들지 않는다(null)
//   ② 봉인 불변 — 재실행이 기존 값을 덮어쓰지 않는다
//   ③ 확률은 적중률이 아니라 **보정**으로 채점한다(70%라 말한 것들이 실제 몇 % 팔렸나)
//   ④ 취소(0012)는 확률 해소에서 제외 — 공매가 열리지 않았으므로 "유찰"이 아니다
//   ⑤ 입찰자 수는 낙찰 회차에서만 채점(유찰엔 유효 입찰자가 없다)
//   ⑥ 이중 집계 0

'use strict';

const { t, eq, done, makeStore, mockFetch, fnPath } = require('./_harness');

const OPBD = '20260728';
const mkResult = (id, statCd, winAmt, bidderCnt) => ({
  id, pbctCdtnNo: '1', statCd, winAmt, bidderCnt, opbdDt: OPBD,
});

// 봉인 레코드 — soldProb/bidders를 가진 것과 안 가진 것을 섞는다
const mkPred = (id, extra) => ({
  id, pbctCdtnNo: '1', title: `물건${id}`, type: '아파트', assetClass: '부동산',
  appr: 10000, min: 7000, lo: 7000, mid: 8000, hi: 9000, w: 0.18,
  statBucket: '아파트', round: 2, fail: 1, modelV: 'v0.1', leadDays: 3,
  sealedAt: '2026-07-25T22:00:00.000Z', ...extra,
});

(async () => {
  // ══ A. 봉인 — hist 셀에서 결과 예보가 만들어지는가 ══
  {
    const store = makeStore();
    global.__FAKE_STORE__ = store;
    process.env.URL = 'https://example.test';
    process.env.SEAL_WINDOW_DAYS = '14';

    const kst = new Date(Date.now() + 9 * 3600 * 1000);
    const ymd = d => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    const bidEnd = ymd(new Date(kst.getTime() + 2 * 86400000)) + '1700';
    const item = (id, usage) => ({ id, pbctCdtnNo: '1', title: `물건${id}`, appr: 10000, min: 7000,
      usage, type: '아파트', bidEnd, failCount: 1, round: 2, assetClass: '부동산' });

    // 셀 3종: 근거 충분 / 결과 표본만 부족 / 입찰자 표본만 부족
    await store.setJSON('hist/_bfmeta', { records: 5000, updatedAt: '2026-07-28T00:00:00Z' });
    await store.setJSON('hist/_cells', {
      srcUpdatedAt: 'x', cells: {
        'L1|0001|충분': { n: 100, outcomeN: 200, soldRate: 62.5, failRate: 37.5,
          lr: { p10: 100, p50: 112, p90: 130 }, bidN: 80, bidders: { p10: 2, p50: 5, p90: 11 } },
        'L1|0001|결과부족': { n: 100, outcomeN: 12, soldRate: 75, failRate: 25,
          lr: { p10: 100, p50: 112, p90: 130 }, bidN: 80, bidders: { p10: 2, p50: 5, p90: 11 } },
        'L1|0001|입찰부족': { n: 100, outcomeN: 200, soldRate: 62.5, failRate: 37.5,
          lr: { p10: 100, p50: 112, p90: 130 }, bidN: 8, bidders: { p10: 2, p50: 5, p90: 11 } },
        'L1|0001|셀없음': { n: 5, outcomeN: 200, soldRate: 99, lr: null, bidN: 0, bidders: null },
      },
    });

    mockFetch([
      [/onbid-search/, { items: [item('A', '충분'), item('B', '결과부족'), item('C', '입찰부족'), item('D', '셀없음')] }],
      [/onbid-mvast-search/, { items: [] }],
      [/onbid-vhcl-search/, { items: [] }],
      [/onbid-svc\?svc=stat_usg/, { items: [{ clsCdNm: '아파트', scfbAmtRto1: 80, scfbAmtRto2: 95 }] }],
      [/hist-stats/, { status: 'ok' }],
    ]);

    const mod = require(fnPath('predict-daily.js'));
    await mod.handler({ queryStringParameters: {} });

    const A = await store.get('pred/A_1'), B = await store.get('pred/B_1'),
          C = await store.get('pred/C_1'), D = await store.get('pred/D_1');

    eq('① 근거 충분 → 낙찰 확률 봉인', A && A.soldProb, 62.5);
    eq('① 근거 충분 → 입찰자 구간 봉인(p10/p50/p90)', A && A.bidders, { lo: 2, mid: 5, hi: 11 });
    eq('① 결과 표본 부족(12<30) → 확률 미산출', B && B.soldProb, null);
    t('① 결과 표본 부족이어도 입찰자는 별도 판정', B && !!B.bidders, 'bidders도 같이 죽음');
    eq('① 입찰자 표본 부족(8<20) → 입찰자 미산출', C && C.bidders, null);
    t('① 입찰자 부족이어도 확률은 살아 있음', C && C.soldProb === 62.5);
    eq('① 낙찰가 셀 자체가 없으면 둘 다 없음', [D && D.soldProb, D && D.bidders], [null, null]);
    t('① 낙찰가 봉인은 결과 예보와 무관하게 항상 만들어짐', !!(A.lo > 0 && D.lo > 0));
    eq('① 근거 셀 키를 함께 남김(사후 검증용)', A && A.outcomeCell, 'L1|0001|충분');

    // 봉인 공식 불변 — 결과 예보 추가가 가격 봉인을 건드리지 않았는가
    eq('① 가격 봉인 공식 불변 (mid)', A.mid, 7325);
    eq('① 가격 봉인 공식 불변 (lo/hi)', [A.lo, A.hi], [7000, 9440]);

    // ② 봉인 불변 — 셀이 바뀌어도 재실행이 덮어쓰지 않는다
    delete require.cache[require.resolve(fnPath('predict-daily.js'))];
    const cells = await store.get('hist/_cells');
    cells.cells['L1|0001|충분'].soldRate = 5; // 통계가 급변했다고 가정
    cells.cells['L1|0001|충분'].bidders = { p10: 90, p50: 95, p90: 99 };
    await store.setJSON('hist/_cells', cells);
    mockFetch([
      [/onbid-search/, { items: [item('A', '충분')] }],
      [/onbid-mvast-search/, { items: [] }],
      [/onbid-vhcl-search/, { items: [] }],
      [/onbid-svc\?svc=stat_usg/, { items: [{ clsCdNm: '아파트', scfbAmtRto1: 80, scfbAmtRto2: 95 }] }],
      [/hist-stats/, { status: 'ok' }],
    ]);
    const mod2 = require(fnPath('predict-daily.js'));
    await mod2.handler({ queryStringParameters: {} });
    const A2 = await store.get('pred/A_1');
    eq('② 재실행해도 봉인된 확률 불변', A2.soldProb, 62.5);
    eq('② 재실행해도 봉인된 입찰자 구간 불변', A2.bidders, { lo: 2, mid: 5, hi: 11 });

    delete global.__FAKE_STORE__;
    delete require.cache[require.resolve(fnPath('predict-daily.js'))];
  }

  // ══ B. 채점 — 확률은 보정으로, 입찰자는 구간 적중으로 ══
  {
    const store = makeStore();
    global.__FAKE_STORE__ = store;
    process.env.URL = 'https://example.test';

    // 80%라 말한 5건 중 4건 낙찰(=보정 잘 맞음), 20%라 말한 5건 중 1건 낙찰
    const preds = [];
    for (let i = 1; i <= 5; i++) preds.push(mkPred('H' + i, { soldProb: 82, bidders: { lo: 2, mid: 5, hi: 9 } }));
    for (let i = 1; i <= 5; i++) preds.push(mkPred('L' + i, { soldProb: 24, bidders: { lo: 1, mid: 2, hi: 4 } }));
    preds.push(mkPred('X1', {})); // 결과 예보 없는 봉인 — 채점 대상 아님
    preds.push(mkPred('CN', { soldProb: 90, bidders: { lo: 1, mid: 2, hi: 3 } })); // 취소될 물건
    for (const p of preds) await store.setJSON(`pred/${p.id}_1`, p);

    const results = [
      mkResult('H1', '0010', 80000000, 6),  // 낙찰 · 입찰자 6명(구간 2~9 안)
      mkResult('H2', '0010', 80000000, 12), // 낙찰 · 12명(구간 밖)
      mkResult('H3', '0010', 80000000, 4),
      mkResult('H4', '0010', 80000000, 5),
      mkResult('H5', '0011', 0, 0),         // 유찰
      mkResult('L1', '0010', 80000000, 1),
      mkResult('L2', '0011', 0, 0),
      mkResult('L3', '0011', 0, 0),
      mkResult('L4', '0011', 0, 0),
      mkResult('L5', '0011', 0, 0),
      mkResult('X1', '0010', 80000000, 3),  // 예보 없음 — outcome 집계에 안 들어가야
      mkResult('CN', '0012', 0, 0),         // 취소 — 확률 해소 대상 아님
    ];

    mockFetch([[/onbid-bidresults/, { results }]]);

    const sd = require(fnPath('score-daily.js'));
    await sd.handler({ queryStringParameters: {} });

    const agg = await store.get('agg');
    const o = agg.outcome;
    eq('③ 확률 해소 표본 = 낙찰+유찰 10건 (예보 없음·취소 제외)', o.sold.n, 10);
    eq('③ 상위 밴드(82%) 버킷 n=5', o.sold.buckets['8'].n, 5);
    eq('③ 상위 밴드 실제 낙찰 4건', o.sold.buckets['8'].sold, 4);
    eq('③ 하위 밴드(24%) 버킷 n=5', o.sold.buckets['2'].n, 5);
    eq('③ 하위 밴드 실제 낙찰 1건', o.sold.buckets['2'].sold, 1);
    t('③ Brier 누적(낮을수록 좋음)이 계산됨', o.sold.sumBrier > 0 && o.sold.sumBrier < 10, o.sold.sumBrier);

    eq('④ 취소는 확률 해소에서 제외', !!o.sold.buckets['9'], false);

    eq('⑤ 입찰자 채점은 낙찰 5건만 (H1~H4 + L1)', o.bidders.n, 5);
    eq('⑤ 구간 적중 4건 (H2의 12명만 빗나감)', o.bidders.hit, 4);
    t('⑤ 평균 오차(명)가 계산됨', o.bidders.sumAbsErr > 0);

    // ⑥ 재실행 이중 집계 0
    delete require.cache[require.resolve(fnPath('score-daily.js'))];
    mockFetch([[/onbid-bidresults/, { results }]]);
    const sd2 = require(fnPath('score-daily.js'));
    await sd2.handler({ queryStringParameters: {} });
    const agg2 = await store.get('agg');
    eq('⑥ 재실행해도 확률 표본 그대로', agg2.outcome.sold.n, 10);
    eq('⑥ 재실행해도 입찰자 표본 그대로', agg2.outcome.bidders.n, 5);

    // scoreboard 노출 형태
    delete require.cache[require.resolve(fnPath('scoreboard.js'))];
    const sb = require(fnPath('scoreboard.js'));
    const res = await sb.handler({ httpMethod: 'GET', queryStringParameters: {} });
    const body = JSON.parse(res.body);
    t('⑦ scoreboard가 outcome 노출', !!body.outcome);
    eq('⑦ 확률 보정 표본', body.outcome.sold.n, 10);
    t('⑦ 버킷에 "우리가 말한 값 vs 실제" 둘 다 있음',
      body.outcome.sold.buckets.every(b => b.predAvg != null && b.actual != null));
    const hi = body.outcome.sold.buckets.find(b => b.band === '80~90%');
    eq('⑦ 80~90% 밴드: 말한 82% vs 실제 80%', [hi.predAvg, hi.actual], [82, 80]);
    eq('⑦ 입찰자 적중률', body.outcome.bidders.hitRate, 80);
    t('⑦ Brier 파생', typeof body.outcome.sold.brier === 'number');

    delete global.__FAKE_STORE__;
  }

  // ══ C. 화면 — 근거 없으면 수치를 만들지 않는가 ══
  {
    const fs = require('fs');
    const { repoPath } = require('./_harness');
    const html = fs.readFileSync(repoPath('bidcast-detail.html'), 'utf8');
    t('⑧ Q0 묶음 존재하고 Q1보다 앞', html.indexOf('data-q="0"') > 0 && html.indexOf('data-q="0"') < html.indexOf('data-q="1"'));
    t('⑧ 낙찰 가능성 섹션', /id="sec-sold"/.test(html));
    t('⑧ 봉인값만 사용(자체 계산 없음)', /p\.soldProb!=null/.test(html));
    t('⑧ 표본 부족은 "계산하지 않았습니다"로 정직 표기', /낙찰 가능성을 계산하지 않았습니다/.test(html));
    t('⑧ 확률은 적중률이 아니라 보정으로 채점됨을 명시', /적중\/불적중이 아니라 보정으로 측정/.test(html));
    t('⑧ 낙찰가 적중률과 별개 지표임을 명시', /낙찰가 적중률과는 별개 지표/.test(html));
    t('⑧ 유찰 시 다음 회차 안내(기다림도 선택지)', /기다리는 것도 선택지/.test(html));
    t('⑧ 입찰자 수는 Q1 안에', /id="aiBidders"/.test(html) && html.indexOf('id="aiBidders"') > html.indexOf('data-q="1"'));
    t('⑧ 특정 입찰가 권유 금지 문구', /특정 입찰가를 권하지 않습니다/.test(html));
    t('⑧ 준비도 헤드라인에 확률만 얹고 등급은 안 바꿈', /판정을 바꾸지 않고\*\* 헤드라인에만/.test(html));

    // 랩 공개 — 채점하는 숫자는 근거를 공개한다
    const lab = fs.readFileSync(repoPath('bidcast-lab.html'), 'utf8');
    t('⑨ 랩에 결과 예보 섹션', /id="outcomeSec"/.test(lab) && /function renderOutcome\(d\)/.test(lab));
    t('⑨ 표본 없으면 섹션 미표시(degrade)', /if \(!o \|\| \(!o\.sold && !o\.bidders\)\) return;/.test(lab));
    t('⑨ 보정표에 "말한 값 vs 실제" 둘 다', /우리가 말한 평균[\s\S]{0,120}실제로 팔린 비율/.test(lab));
    t('⑨ 작은 표본 밴드는 구분 표기', /표본 부족/.test(lab) && /b\.n < 10/.test(lab));
    t('⑨ 취소 제외 이유를 화면에서 밝힘', /열리지 않은 공매는 "안 팔린 것"이 아니기 때문/.test(lab));
    t('⑨ Brier 해석 기준 제시(0.25 근처)', /0\.25 근처/.test(lab));
    t('⑨ 렌더 배선', /renderOutcome\(d\);/.test(lab.slice(lab.indexOf('renderMarket(d);') - 200)));
  }

  done('outcome (결과 예보 봉인·보정 채점)');
})().catch(e => { console.log('THROW', e); process.exit(1); });
