// test/predict-seal.test.js — 예측 봉인(predict-daily).
//
// 지키려는 것(전부 헌장 규율):
//   ① **전수 봉인** — 창 안 물건이 한 페이지를 넘어도 마지막 페이지까지 봉인한다.
//      (봉인은 물건당 1회 멱등이고 다음 날엔 창이 이동하므로, 놓친 물건은 영영 기회가 없다.)
//   ② **봉인 불변** — 재실행해도 기존 봉인을 덮어쓰지 않는다(재봉인 0).
//   ③ **공식 불변** — mid/lo/hi 수식이 리팩터로 바뀌지 않았다(수치 대조).
//   ④ 상한(SEAL_CAP)에 걸리면 **마감 임박 순**으로 먼저 봉인한다.

'use strict';

const { t, eq, done, makeStore, mockFetch, fnPath } = require('./_harness');

process.env.URL = 'https://example.test';
process.env.SEAL_CAP = '2500';

// 3자산군 × 여러 페이지. 부동산은 2,300건(1000/1000/300) — 과거 단일 페이지 구현이면 유실됐을 양.
const RE = 2300, MV = 40, VH = 30;
function mkItems(prefix, n, from) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${from + i}`, pbctCdtnNo: '0001',
    title: `${prefix} 물건 ${from + i}`,
    appr: 10000, min: 7000,   // 만원 단위(온비드 매핑과 동일)
    usage: '아파트', type: '아파트',
    // 앞쪽 600건은 오늘(30일) 마감, 나머지는 내일(31일) 마감.
    // 상한이 걸리면 **오늘 마감분이 먼저** 봉인돼야 한다(내일 것은 내일 기회가 있다).
    bidEnd: (i < 600 ? '20260730' : '20260731') + '1700',
    failCount: 0, round: 1,
  }));
}
function page(list, url) {
  const p = Number((url.match(/[?&]page=(\d+)/) || [])[1] || 1);
  return { items: list.slice((p - 1) * 1000, p * 1000) };
}
const realItems = mkItems('R', RE, 1), mvItems = mkItems('M', MV, 1), vhItems = mkItems('V', VH, 1);

const routes = [
  [/onbid-search/, u => page(realItems, u)],
  [/onbid-mvast-search/, u => page(mvItems, u)],
  [/onbid-vhcl-search/, u => page(vhItems, u)],
  // 캠코 용도별 낙찰가율 통계(감정가 대비 rto1·최저가 대비 rto2) — 봉인의 유일한 근거.
  [/onbid-svc\?svc=stat_usg/, { items: [{ clsCdNm: '아파트', scfbAmtRto1: 80, scfbAmtRto2: 95 }] }],
  [/hist-stats/, { status: 'empty' }],              // 챌린저 학습 데이터 없음 → 챌린저 생략
];

(async () => {
  const store = makeStore();
  global.__FAKE_STORE__ = store;
  const fetchMock = mockFetch(routes);
  const mod = require(fnPath('predict-daily.js'));

  const r = await mod.handler({ queryStringParameters: {} });
  const b = JSON.parse(r.body);
  t('200 응답', r.statusCode === 200, r.statusCode);

  const preds = store.keys('pred/');
  // ① 전수 봉인
  eq('① 전 자산군 전수 봉인', preds.length, RE + MV + VH);
  t('① 마지막 페이지(3쪽)의 물건도 봉인됨', preds.includes('pred/R2300_0001'), preds.length);
  t('① 과거 단일 페이지 구현이면 유실됐을 1,300건 포착', preds.length - 1000 - MV - VH === 1300);
  // 페이지네이션이 실제로 돌았는지(부동산 3페이지 + 동산 1 + 차량 1)
  const searchCalls = fetchMock.calls.filter(u => /onbid-search\?/.test(u));
  eq('① 부동산 3페이지 조회', searchCalls.length, 3);

  // ③ 공식 불변 — 감정가 10,000만 / 최저가 7,000만, rto1=80·rto2=95, 기본 폭 w=0.18
  //    앵커 = [10000×0.80, 7000×0.95] = [8000, 6650]
  //    mid = 평균 7325 / lo = max(최저가 7000, 6650×0.82=5453) = 7000 / hi = 8000×1.18 = 9440
  //    이 수치가 바뀌면 봉인 공식이 바뀐 것이다(리팩터가 손대면 안 되는 지점).
  const p = await store.get('pred/R1_0001');
  eq('③ mid = 앵커 평균', p.mid, 7325);
  eq('③ lo = max(최저가, 최소앵커×(1−w))', p.lo, 7000);
  eq('③ hi = 최대앵커×(1+w)', p.hi, 9440);
  t('③ lo ≤ mid ≤ hi', p.lo <= p.mid && p.mid <= p.hi, JSON.stringify(p));
  eq('③ 적용된 구간 폭 w', p.w, 0.18);
  t('③ 봉인 시각·모델 버전 기록', !!p.sealedAt && p.modelV === 'v0.1', JSON.stringify(p));
  t('③ 통계 근거(용도 버킷) 기록', p.statBucket === '아파트', p.statBucket);

  // ② 봉인 불변 — 같은 날 재실행
  const before = JSON.stringify(await store.get('pred/R1_0001'));
  mockFetch(routes);
  const r2 = await mod.handler({ queryStringParameters: {} });
  const b2 = JSON.parse(r2.body);
  eq('② 재실행 시 신규 봉인 0', b2.sealed, 0);
  eq('② 재실행 후에도 봉인 수 동일', store.keys('pred/').length, RE + MV + VH);
  eq('② 기존 봉인 내용 불변', JSON.stringify(await store.get('pred/R1_0001')), before);

  // ④ 상한 — SEAL_CAP을 낮추면 마감 임박 순으로 잘린다
  delete require.cache[require.resolve(fnPath('predict-daily.js'))];
  process.env.SEAL_CAP = '500';
  const store2 = makeStore();
  global.__FAKE_STORE__ = store2;
  mockFetch(routes);
  const mod2 = require(fnPath('predict-daily.js'));
  await mod2.handler({ queryStringParameters: {} });
  const capped = store2.keys('pred/');
  eq('④ 상한만큼만 봉인', capped.length, 500);
  // 마감이 이른(20260730) 물건만 살아남아야 한다 — 늦은(20260731) 물건이 섞이면
  // 정렬 없이 잘린 것이고, 그 경우 오늘 개찰되는 물건이 영영 봉인되지 않는다.
  const ends = [];
  for (const k of capped) ends.push((await store2.get(k)).bidEnd);
  const late = ends.filter(e => e >= '202607311700').length;
  eq('④ 상한에 걸려도 마감 임박 순 우선(늦은 물건 0건)', late, 0);

  // 하트비트
  const hb = await store2.get('_run/predict-daily');
  t('하트비트 기록(ok·sealed)', hb && hb.ok === true && hb.sealed === 500, JSON.stringify(hb));

  // API 사용량이 예산 카운터에 기록됐는지(critical 티어 — 막지는 않되 집계는 한다)
  const quota = require(fnPath('lib/quota.js'));
  const usage = await quota.readUsage(store2, 'onbid');
  t('critical 호출도 예산 카운터에 집계', usage.used > 0, usage.used);

  delete global.__FAKE_STORE__;
  done('predict-seal (봉인 전수·불변·공식)');
})().catch(e => { console.log('THROW', e); process.exit(1); });
