// test/calibration.test.js — 보정(calibration)이 "증거로만" 움직이는가.
//
// 왜 이 테스트가 생겼나 (2026-07-30, 프로덕션 scoreboard 실측):
//   구간 폭 w가 7일간 기계장비 0.18→0.27, 차량 0.18→0.24로 올라갔는데 적중률은 각각
//   17.9%→33.3%, 70.4%→**39.5%**(악화)였다. 로그를 보니 세 가지가 겹쳐 있었다.
//     ① 채점 0건인 날에도 w가 올랐다 (07-30: runs.score.graded=0인데 세 용도 전부 상승)
//     ② 같은 날 20~30초 간격으로 두 번 올랐다 (07-28 10:31:06/10:31:28, 07-29 10:34:02/10:34:30)
//     ③ 누적 적중률로 판단해, 과거 실패가 영원히 w를 상한까지 밀어 올렸다
//   그리고 근본 원인은 따로 있었다 — recent 20건 중 **19건이 한 방향**(실제가 예측보다 높음,
//   평균 −39.5%)이었다. 폭이 좁아서 놓친 게 아니라 **중심이 치우쳐서** 놓친 것이고,
//   이때 구간을 대칭으로 넓히는 것은 헌장 Golden Rule 4(넓혀서 맞히기 금지)를 엔진이
//   매일 자동으로 저지르는 것이다.
//
// 이 테스트가 지키는 것:
//   ① 새로 채점한 게 없으면 w는 움직이지 않는다
//   ② 같은 날 두 번 실행해도 한 번만 움직인다
//   ③ 판단은 누적이 아니라 최근 창으로 한다
//   ④ **빗나감이 한쪽으로 쏠리면 넓히지 않고 편향으로 진단한다**
//   ⑤ 정상적으로 좁은 구간(양쪽으로 골고루 빗나감)은 여전히 넓힌다 — 레버를 죽인 게 아니다
//   ⑥ 적중률이 목표 상한을 넘으면 좁힌다 (기존 동작 보존)
//   ⑦ 봉인된 예측은 보정이 어떻게 되든 불변
//   ⑧ resetCalib는 confirm 없이는 실행되지 않는다
//   ⑨ **편향이면 중심(k)을 옮긴다** — 폭이 아니라 중심이 처방이라면, 진단만 하고 끝내지 않는다
//   ⑩ 창업자 지시 1회 초기화가 정확히 한 번만 일어난다

'use strict';

const { t, eq, done, makeStore, mockFetch, fnPath } = require('./_harness');

const SD = fnPath('score-daily.js');
const run = (store, qs) => {
  delete require.cache[require.resolve(SD)];
  global.__FAKE_STORE__ = store;
  return require(SD).handler({ httpMethod: 'GET', queryStringParameters: qs || {} });
};

// 개찰 결과 한 건 만들기. win(만원) · pred 구간은 seed()에서 심는다.
const opbd = (d) => `${d}`;
function result(id, winMan, dt) {
  return { id, pbctCdtnNo: '1', statCd: '0010', winAmt: winMan * 10000, opbdDt: dt };
}

// 봉인 예측을 심는다. 구간 [lo,hi], 중앙 mid.
async function seal(store, id, { lo, mid, hi, type }) {
  await store.setJSON(`pred/${id}_1`, {
    id, pbctCdtnNo: '1', type, lo, mid, hi, modelV: 'v0.1', assetClass: '동산',
    source: 'onbid', sealedAt: '2026-07-01T00:00:00.000Z',
  });
}

(async () => {
  const today = (() => { const d = new Date(Date.now() + 9 * 3600 * 1000);
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`; })();

  // ══ ④⑤ 편향 vs 진짜 폭 문제 ══
  // 같은 적중률(0%)·같은 표본에서, 빗나간 **방향**만 다른 두 용도를 함께 채점한다.
  //   편향용도: 20건 전부 실제가 hi 위 (한 방향 쏠림 100%)  → 넓히면 안 된다
  //   대칭용도: 10건은 hi 위, 10건은 lo 아래 (쏠림 50%)      → 넓혀야 한다
  {
    const store = makeStore();
    const results = [];
    for (let i = 0; i < 20; i++) {
      const id = `BIAS${i}`;
      await seal(store, id, { lo: 90, mid: 100, hi: 110, type: '편향용도' });
      results.push(result(id, 300, opbd(today))); // 실제 300 > hi 110 → 전부 'over'
    }
    for (let i = 0; i < 20; i++) {
      const id = `SYM${i}`;
      await seal(store, id, { lo: 90, mid: 100, hi: 110, type: '대칭용도' });
      results.push(result(id, i < 10 ? 300 : 20, opbd(today))); // 절반은 위, 절반은 아래
    }
    mockFetch([[/onbid-bidresults/, { results }]]);
    await run(store);

    const calib = await store.get('calib');
    eq('④ 편향(한 방향 100%)은 폭을 넓히지 않는다', calib.byUsage['편향용도'].w, 0.18);
    t('④ 대신 편향으로 진단한다', !!calib.byUsage['편향용도'].bias, JSON.stringify(calib.byUsage['편향용도']));
    eq('④ 편향 방향은 low(우리가 낮게 봄)', calib.byUsage['편향용도'].bias.dir, 'low');
    eq('④ 쏠림 비율 100%', calib.byUsage['편향용도'].bias.skewPct, 100);

    eq('⑤ 양쪽으로 고르게 빗나가면 넓힌다(레버는 살아 있다)', calib.byUsage['대칭용도'].w, 0.19);

    const chron = (await store.get('chronicle')) || [];
    // 폭을 넓히지 않았다는 사실 + 대신 무엇을 했는지가 반드시 기록에 남아야 한다.
    // (표본·데드밴드에 따라 'center'로 옮기거나, 아직 못 옮기면 'bias'로 진단만 남긴다.)
    t('④ 넓히지 않은 이유가 기록에 남는다', chron.some(c => c.kind === 'bias' || c.kind === 'center'),
      JSON.stringify(chron.map(c => c.kind)));
    t('⑤ 넓힌 것도 기록에 남는다', chron.some(c => c.kind === 'calib' && /대칭용도/.test(c.title)));

    // ══ ② 같은 날 재실행해도 두 번 움직이지 않는다 ══
    mockFetch([[/onbid-bidresults/, { results }]]); // 같은 결과(전부 already 처리됨)
    await run(store);
    const calib2 = await store.get('calib');
    eq('② 같은 날 재실행해도 폭은 그대로', calib2.byUsage['대칭용도'].w, 0.19);
    eq('② 편향 용도도 그대로', calib2.byUsage['편향용도'].w, 0.18);

    // ══ ⑦ 봉인 불변 ══
    const p = await store.get('pred/SYM0_1');
    eq('⑦ 보정이 어떻게 되든 봉인된 구간은 불변', [p.lo, p.mid, p.hi], [90, 100, 110]);
  }

  // ══ ① 새로 채점한 게 없으면 w는 움직이지 않는다 ══
  // 실측 07-30 재현: 채점 대상이 하나도 없는 날에도 w가 올랐던 결함.
  {
    const store = makeStore();
    // 이미 최근 창이 차 있고 적중률이 낮은 상태를 직접 심는다
    await store.setJSON('agg', { n: 30, hit: 3, sumAbsErrPct: 0, byTier: {}, daily: {},
      byUsage: { '기계장비': { n: 30, hit: 3, recent: Array.from({ length: 30 }, (_, i) => (i % 10 === 0 ? 1 : (i % 2 ? 2 : 3))) } } });
    await store.setJSON('calib', { v: 'v2-center', byUsage: { '기계장비': { w: 0.27, n: 30 } } });

    mockFetch([[/onbid-bidresults/, { results: [] }]]); // 개찰 결과 0건
    const res = await run(store);
    const body = JSON.parse(res.body);
    eq('① 채점 0건', body.graded, 0);
    eq('① 채점이 0건이면 폭은 그대로', (await store.get('calib')).byUsage['기계장비'].w, 0.27);
  }

  // ══ ③ 판단은 누적이 아니라 최근 창으로 한다 ══
  // 누적으로 보면 처참(1000건 중 50건 적중 = 5%)하지만, 최근 창은 목표 상한을 넘는 경우.
  // 옛 구현은 누적을 보고 계속 넓혔을 것이고, 새 구현은 최근을 보고 **좁혀야** 한다.
  {
    const store = makeStore();
    const recent = Array.from({ length: 50 }, () => 1); // 최근 50건 전부 적중(100% > 98%)
    await store.setJSON('agg', { n: 1000, hit: 50, sumAbsErrPct: 0, byTier: {}, daily: {},
      byUsage: { '차량': { n: 1000, hit: 50, recent } } });
    await store.setJSON('calib', { v: 'v2-center', byUsage: { '차량': { w: 0.24, n: 1000 } } });
    await seal(store, 'X1', { lo: 90, mid: 100, hi: 110, type: '차량' });

    mockFetch([[/onbid-bidresults/, { results: [result('X1', 100, opbd(today))] }]]);
    await run(store);
    const c = (await store.get('calib')).byUsage['차량'];
    t('③ 누적이 5%여도 최근 창이 좋으면 넓히지 않는다', c.w <= 0.24, JSON.stringify(c));
    eq('⑥ 최근 창이 목표 상한을 넘으면 좁힌다', c.w, 0.235);
  }

  // ══ 최근 창이 아직 안 찼으면 조정하지 않는다 ══
  {
    const store = makeStore();
    await seal(store, 'Y1', { lo: 90, mid: 100, hi: 110, type: '신규용도' });
    mockFetch([[/onbid-bidresults/, { results: [result('Y1', 500, opbd(today))] }]]);
    await run(store);
    const c = (await store.get('calib')).byUsage['신규용도'];
    t('표본 1건으로는 보정하지 않는다', !c, JSON.stringify(c));
  }

  // ══ 프로덕션 실측 재현 (2026-07-30 scoreboard) ══
  // 2차 검증: 합성 케이스가 아니라 **실제로 폭주가 일어난 상태**를 그대로 심고, 새 규칙이
  // 그 상태에서 w를 올리지 않는지 본다. 값은 전부 실측에서 가져왔다.
  //   기계장비 w=0.27 · 최근 적중률 33.3% · recent 20건 중 19건이 "실제가 예측보다 높음"
  //   (scoreboard.recent의 errPct 부호: 19건 음수 / 1건 양수, 평균 −39.5%)
  {
    const store = makeStore();
    // 실측 부호 분포 그대로: 적중 12건 + over 19건 + under 1건 (총 32건, 적중률 37.5%)
    const recent = [
      ...Array.from({ length: 12 }, () => 1),
      ...Array.from({ length: 19 }, () => 2),
      3,
    ];
    await store.setJSON('agg', { n: 36, hit: 12, sumAbsErrPct: 0, byTier: {}, daily: {},
      byUsage: { '기계장비': { n: 36, hit: 12, recent } } });
    await store.setJSON('calib', { v: 'v2-center', byUsage: { '기계장비': { w: 0.27, n: 36 } } });
    await seal(store, 'P1', { lo: 20, mid: 18, hi: 27, type: '기계장비' }); // 실측 물건(음향랙)

    mockFetch([[/onbid-bidresults/, { results: [result('P1', 32, opbd(today))] }]]); // 실낙찰 32만
    await run(store);

    const c = (await store.get('calib')).byUsage['기계장비'];
    eq('실측 재현: 적중률 33%대여도 폭이 오르지 않는다', c.w, 0.27);
    t('실측 재현: 편향으로 진단됨', !!c.bias && c.bias.dir === 'low', JSON.stringify(c));
    t('실측 재현: 쏠림 70% 이상', c.bias.skewPct >= 70, String(c.bias.skewPct));
    // 옛 규칙이었다면 이 상태에서 w는 0.28로 올랐다(그리고 매일 상한 0.35까지).
    t('실측 재현: 상한 0.35로 기어가지 않는다', c.w < 0.35);
  }

  // ══ ⑨ 편향이면 중심(k)을 옮긴다 ══
  // ④가 "넓히지 않는다"까지였다면, 여기는 "그럼 무엇을 하는가"다. 실제가 예측의 2배로
  // 나오는 상황을 심고, k가 그 방향으로(과보정 없이) 이동하는지 본다.
  {
    const store = makeStore();
    const results = [];
    for (let i = 0; i < 24; i++) {
      const id = `C${i}`;
      await seal(store, id, { lo: 90, mid: 100, hi: 110, type: '저평가용도' });
      results.push(result(id, 200, opbd(today))); // 실제 200 = 예측 중앙값의 2배
    }
    mockFetch([[/onbid-bidresults/, { results }]]);
    await run(store);

    const c = (await store.get('calib')).byUsage['저평가용도'];
    eq('⑨ 폭은 그대로 둔다', c.w, 0.18);
    t('⑨ 중심 k가 위로 이동', c.k > 1, JSON.stringify(c));
    // 비율 중앙값 2.0 → 제곱근만큼(√2 ≈ 1.414) 이동한다(과보정 방지)
    eq('⑨ 한 번에 다 옮기지 않고 제곱근만큼', c.k, 1.414);
    const chron = (await store.get('chronicle')) || [];
    t('⑨ 중심 이동이 기록에 남는다', chron.some(x => x.kind === 'center' && /중심 보정/.test(x.title)),
      JSON.stringify(chron.map(x => x.kind)));

    // k가 봉인에 실제로 적용되는지 — predict-daily 쪽 계약
    // 앵커에 곱하므로 mid는 k배가 되고 **폭 비율은 변하지 않는다**(GR4).
    const c2 = (await store.get('calib')).byUsage['저평가용도'];
    t('⑨ k 상·하한 안에 머문다', c2.k >= 0.4 && c2.k <= 3.0, String(c2.k));
  }

  // ══ ⑨-b 중심 보정이 봉인에 반영되고, 폭은 넓어지지 않는다 ══
  // predict-daily가 k를 앵커에 곱하는지 직접 확인한다. k=2면 mid·lo·hi가 모두 2배가 되고
  // (lo는 최저가 바닥에 걸리지 않는 한), **hi/lo 비율은 그대로**여야 한다.
  {
    const mk = async (k) => {
      const st = makeStore();
      global.__FAKE_STORE__ = st;
      if (k !== 1) await st.setJSON('calib', { v: 'v2-center', byUsage: { '아파트': { w: 0.18, k } } });
      const d = new Date(Date.now() + 9 * 3600 * 1000);
      const ymd = x => `${x.getUTCFullYear()}${String(x.getUTCMonth() + 1).padStart(2, '0')}${String(x.getUTCDate()).padStart(2, '0')}`;
      mockFetch([
        [/onbid-search/, { items: [{ id: 'K1', pbctCdtnNo: '1', title: 'x', appr: 10000, min: 200,
          usage: '아파트', type: '아파트', bidEnd: ymd(new Date(d.getTime() + 86400000)) + '1700',
          failCount: 0, round: 1, assetClass: '부동산' }] }],
        [/onbid-mvast-search/, { items: [] }], [/onbid-vhcl-search/, { items: [] }],
        [/onbid-svc\?svc=stat_usg/, { items: [{ clsCdNm: '아파트', scfbAmtRto1: 80, scfbAmtRto2: 95 }] }],
        [/hist-stats/, { status: 'empty' }],
      ]);
      delete require.cache[require.resolve(fnPath('predict-daily.js'))];
      await require(fnPath('predict-daily.js')).handler({ queryStringParameters: {} });
      return st.get('pred/K1_1');
    };
    const base = await mk(1), moved = await mk(2);
    // 앵커 = [감정가 10000×0.80, 최저가 200×0.95] = [8000, 190] → mid = 4095
    eq('⑨-b k=1이면 기존 공식과 동일(중심)', base.mid, 4095);
    eq('⑨-b k=2면 중심이 정확히 2배', moved.mid, base.mid * 2);
    eq('⑨-b hi도 2배', moved.hi, base.hi * 2);
    // **중심만 옮기고 넓히지 않았다**는 증거 — 상단 폭 비율(hi/mid)이 그대로다.
    // (lo는 "낙찰가 ≥ 최저가"라는 실제 제약이 바닥으로 걸릴 수 있어 비율 비교 대상이 아니다.)
    const r1 = base.hi / base.mid, r2 = moved.hi / moved.mid;
    t('⑨-b 구간 폭 비율 불변(넓히지 않았다)', Math.abs(r1 - r2) < 1e-6, `${r1} vs ${r2}`);
    eq('⑨-b 봉인 레코드에 k 기록', moved.k, 2);
  }

  // ══ ⑩ 창업자 지시 1회 초기화 ══
  {
    const store = makeStore();
    // 버전 태그가 없는 = 옛 규칙이 부풀려 놓은 상태
    await store.setJSON('calib', { byUsage: { '기계장비': { w: 0.27, n: 36 }, '차량': { w: 0.24, n: 76 } } });
    mockFetch([[/onbid-bidresults/, { results: [] }]]);
    await run(store);

    const c = await store.get('calib');
    eq('⑩ 부풀려진 폭이 비워짐', c.byUsage, {});
    eq('⑩ 되돌린 값을 감사 추적용으로 보존', c.resetFrom['기계장비'].w, 0.27);
    eq('⑩ 스키마 버전 태그', c.v, 'v2-center');
    const chron = (await store.get('chronicle')) || [];
    t('⑩ 초기화 사실이 연혁에 남는다', chron.some(x => x.kind === 'calib-reset'), JSON.stringify(chron.map(x => x.kind)));

    // 두 번째 실행에서는 다시 초기화되지 않는다(1회만)
    await store.setJSON('calib', { ...(await store.get('calib')), byUsage: { '차량': { w: 0.19, k: 1.2 } } });
    mockFetch([[/onbid-bidresults/, { results: [] }]]);
    await run(store);
    eq('⑩ 재실행 시 다시 초기화되지 않는다', (await store.get('calib')).byUsage['차량'].w, 0.19);
  }

  // ══ ⑪ 자산군별 채점 진단 (부동산 1건 미스터리를 데이터로 가른다) ══
  // 실측에서 채점 152건 중 부동산이 1건뿐이었다. 원인 후보가 둘인데 지금은 구분이 안 된다:
  //   (a) 부동산 개찰 결과 자체가 적게 온다        → fetched가 작다
  //   (b) 결과는 오는데 봉인을 못 찾는다(조인 실패) → fetched는 큰데 noPred가 크다
  // 추측으로 고치지 않기 위해 먼저 재는 계측이다. 여기서는 (b) 상황을 만들어 확인한다.
  {
    const store = makeStore();
    await seal(store, 'RE1', { lo: 90, mid: 100, hi: 110, type: '아파트' });
    // 부동산(0001)은 5건 오는데 봉인은 1건뿐 → noPred 4 / graded 1
    // 동산(0003)은 2건 오고 봉인 없음 → noPred 2
    const byT = {
      '0001': [result('RE1', 100, opbd(today)), result('RE2', 100, opbd(today)), result('RE3', 100, opbd(today)),
               result('RE4', 100, opbd(today)), result('RE5', 100, opbd(today))],
      '0003': [result('MV1', 50, opbd(today)), result('MV2', 50, opbd(today))],
    };
    mockFetch([[/onbid-bidresults/, (u) => {
      const m = u.match(/cltrTypeCd=(\d+)/);
      return { results: byT[m && m[1]] || [] };
    }]]);
    const res = await run(store);
    const b = JSON.parse(res.body);
    t('⑪ 자산군별 진단이 응답에 있다', !!b.byType, res.body);
    eq('⑪ 부동산 개찰 결과 건수', b.byType['0001'].fetched, 5);
    eq('⑪ 부동산 채점 건수', b.byType['0001'].graded, 1);
    eq('⑪ 부동산 봉인 못 찾음(조인 실패 후보)', b.byType['0001'].noPred, 4);
    eq('⑪ 동산은 전부 봉인 없음', b.byType['0003'].noPred, 2);
    const hb = await store.get('_run/score-daily');
    t('⑪ 하트비트에도 남는다(다음 날 바로 확인 가능)', !!(hb && hb.byType && hb.byType['0001']), JSON.stringify(hb));
  }

  // ══ ⑧ resetCalib 안전장치 ══
  {
    const store = makeStore();
    await store.setJSON('calib', { v: 'v2-center', byUsage: { '차량': { w: 0.24 } } });
    const bad = await run(store, { resetCalib: '1' });
    eq('⑧ confirm 없으면 거부', bad.statusCode, 400);
    eq('⑧ 거부되면 값도 그대로', (await store.get('calib')).byUsage['차량'].w, 0.24);

    const ok = await run(store, { resetCalib: '1', confirm: '1' });
    eq('⑧ confirm=1이면 초기화', ok.statusCode, 200);
    eq('⑧ 보정값이 비워짐', (await store.get('calib')).byUsage, {});
    eq('⑧ 되돌린 값을 남겨 둔다(감사 추적)', (await store.get('calib')).resetFrom['차량'].w, 0.24);
  }

  delete global.__FAKE_STORE__;
  done('calibration (보정은 증거로만 움직인다 · 편향이면 넓히지 않는다)');
})().catch(e => { console.log('THROW', e); process.exit(1); });
