// test/quota.test.js — API 일일 호출 예산 가드.
// 지키려는 것: 대량 수집기가 사용자 화면 몫(reserve)을 절대 침범하지 않고,
//   예산이 떨어지면 **반쪽 데이터를 남기지 않고** 커서를 그대로 둔 채 중단한다.

'use strict';

const { t, eq, done, makeStore, mockFetch, fnPath } = require('./_harness');
const quota = require(fnPath('lib/quota.js'));

// ── 순수 로직 ──
eq('kstDay UTC 15시 = 다음 날 KST', quota.kstDay(Date.UTC(2026, 6, 28, 15, 30)), '20260729');
eq('kstDay UTC 14시 = 같은 날 KST', quota.kstDay(Date.UTC(2026, 6, 28, 14, 59)), '20260728');
eq('quotaKey 형식', quota.quotaKey('onbid', '20260729'), '_quota/onbid/20260729');

(async () => {
  // ── bulk 티어: reserve 만큼은 남긴다 ──
  let store = makeStore();
  let b = await quota.openBudget(store, { service: 'onbid', tier: 'bulk', cap: 100, reserve: 30 });
  eq('bulk 상한 = cap − reserve', b.limit, 70);
  let taken = 0;
  while (b.take(1)) taken++;
  eq('bulk는 70회까지만', taken, 70);
  t('예산 소진 시 stopped 표시', b.stopped === true);
  eq('remaining 0', b.remaining(), 0);

  // ── critical 티어: 막지 않는다 ──
  store = makeStore();
  b = await quota.openBudget(store, { service: 'onbid', tier: 'critical', cap: 100, reserve: 30 });
  eq('critical 상한 = cap 전체', b.limit, 100);
  b.note(40);
  t('critical note는 막지 않음', b.stopped === false && b.used === 40);

  // ── 누적: 앞선 실행이 쓴 양을 이어받는다 ──
  store = makeStore();
  b = await quota.openBudget(store, { store, tier: 'bulk', cap: 100, reserve: 30 });
  for (let i = 0; i < 50; i++) b.take(1);
  await b.flush();
  const rec = await store.get('_quota/onbid/' + quota.kstDay());
  eq('flush가 카운터 저장', rec && rec.n, 50);

  const b2 = await quota.openBudget(store, { tier: 'bulk', cap: 100, reserve: 30 });
  eq('두 번째 실행이 사용량 이어받음', b2.used, 50);
  let more = 0;
  while (b2.take(1)) more++;
  eq('남은 예산만큼만 추가 사용', more, 20);

  // ── 동시 실행: 서로의 사용량을 지우지 않는다 ──
  store = makeStore();
  const x = await quota.openBudget(store, { tier: 'bulk', cap: 1000, reserve: 0 });
  const y = await quota.openBudget(store, { tier: 'bulk', cap: 1000, reserve: 0 });
  for (let i = 0; i < 10; i++) x.take(1);
  for (let i = 0; i < 7; i++) y.take(1);
  await x.flush(); await y.flush();
  const rec2 = await store.get('_quota/onbid/' + quota.kstDay());
  eq('겹쳐 돌아도 합산(10+7)', rec2.n, 17);

  // ── readUsage ──
  const u = await quota.readUsage(store, 'onbid');
  eq('readUsage used', u.used, 17);
  t('readUsage가 집계 범위를 정직하게 밝힘', /사용자 화면의 직접 조회는 포함되지 않습니다/.test(u.note));

  // ══ collect-history: 예산이 떨어지면 커서를 전진시키지 않는다 ══
  // 백필 모드에서 창 하나를 다 못 채우면 그 창을 버리고 커서를 그대로 둬야 한다.
  process.env.ONBID_DAILY_QUOTA = '10';
  process.env.ONBID_LIVE_RESERVE = '6';   // bulk 상한 4회 = 창 하나(3자산군×페이지)를 못 채움
  process.env.URL = 'https://example.test';
  process.env.HIST_TARGET_DAYS = '365';

  store = makeStore();
  global.__FAKE_STORE__ = store;
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: 'X' + i, pbctCdtnNo: '1', statCd: '0010', apslAmt: 1e8, lowstAmt: 7e7, winAmt: 8e7, opbdDt: '20260720' }));
  mockFetch([[/onbid-bidresults/, { results: rows }]]);

  const ch = require(fnPath('collect-history.js'));
  const before = (await store.get('hist/_state')) || null;
  const res = await ch.handler({ queryStringParameters: {} });
  const body = JSON.parse(res.body);
  t('예산 부족이어도 500이 아님', res.statusCode === 200, res.statusCode);
  t('예산 소진 사실을 응답에 밝힘', /API 예산/.test(body.note || ''), body.note);

  const stateAfter = await store.get('hist/_state');
  const winKeys = store.keys('hist/2');
  t('반쪽 창을 저장하지 않음', winKeys.length === 0, winKeys.join(','));
  t('커서가 앞으로 나가지 않음(다음 실행이 이 창부터 다시)',
    !before || stateAfter.cursorEnd === before.cursorEnd || winKeys.length === 0);

  const hb = await store.get('_run/collect-history');
  t('하트비트에 quotaStopped 기록', hb && hb.quotaStopped === true, JSON.stringify(hb));

  // ══ collect-backfill: 창 도중에 예산이 떨어져도 반쪽 창을 남기지 않는다 ══
  // 예산 4회, 자산군마다 2페이지 필요(1000행 응답) → 두 번째 자산군 중간에 소진된다.
  // 이때 첫 자산군까지 저장하고 커서를 넘기면 나머지 자산군이 영영 수집되지 않는다.
  process.env.HIST_BF_START = '20250101';
  process.env.HIST_BF_END = '20260630';
  const bigRows = Array.from({ length: 1000 }, (_, i) => ({ id: 'B' + i, pbctCdtnNo: '1', statCd: '0010', apslAmt: 1e8, lowstAmt: 7e7, winAmt: 8e7, opbdDt: '20260625' }));
  const store3 = makeStore();
  global.__FAKE_STORE__ = store3;
  mockFetch([[/onbid-bidresults/, { results: bigRows }]]);
  const bf = require(fnPath('collect-backfill.js'));
  const rb = await bf.handler({ queryStringParameters: {} });
  const bb = JSON.parse(rb.body);
  t('백필도 예산 부족 시 200(실패 아님)', rb.statusCode === 200, rb.statusCode);
  t('백필 반쪽 창 미저장', store3.keys('hist/feat/').length === 0, store3.keys('hist/feat/').join(','));
  t('백필 커서 미전진', !(await store3.get('hist/_bfstate')) || (await store3.get('hist/_bfstate')).cursorEnd === '20260630');
  t('백필도 예산 소진을 응답에 밝힘', /API 예산/.test(bb.note || ''), bb.note);

  // ══ 예산이 넉넉하면 정상 수집 ══
  process.env.ONBID_DAILY_QUOTA = '1000';
  process.env.ONBID_LIVE_RESERVE = '250';
  delete require.cache[require.resolve(fnPath('collect-backfill.js'))];
  delete require.cache[require.resolve(fnPath('lib/quota.js'))];
  const store4 = makeStore();
  global.__FAKE_STORE__ = store4;
  mockFetch([[/onbid-bidresults/, { results: rows }]]);
  const bf2 = require(fnPath('collect-backfill.js'));
  await bf2.handler({ queryStringParameters: {} });
  t('예산이 있으면 정상 수집(창 저장)', store4.keys('hist/feat/').length > 0, store4.keys('hist/feat/').length);
  t('예산이 있으면 커서 전진', (await store4.get('hist/_bfstate')).cursorEnd < '20260630');
  const q4 = await store4.get('_quota/onbid/' + quota.kstDay());
  t('수집 사용량이 카운터에 기록', q4 && q4.n > 0, JSON.stringify(q4));

  delete global.__FAKE_STORE__;
  done('quota (API 예산 가드)');
})().catch(e => { console.log('THROW', e); process.exit(1); });
