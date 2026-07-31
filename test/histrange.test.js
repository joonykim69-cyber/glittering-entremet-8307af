// test/histrange.test.js — 백테스트·모의 라이브가 **수집 범위를 자동으로 따라가는가**.
//
// 지키려는 규율:
//   ① 범위는 코드가 아니라 **디스크에 있는 창**이 정한다 — 수집이 넓어지면 사람 개입 없이 따라간다.
//   ② 넓어지면 **처음부터 다시** 돈다 — 옛 커서를 이어받으면 앞쪽 달이 영영 재생되지 않고,
//      학습량이 다른 결과가 한 곡선/한 표에 섞인다.
//   ③ 반쪽 달은 쓰지 않는다 — 일부만 수집된 달을 한 달처럼 채점하면 그 성적이 거짓이 된다.
//   ④ GR11(시점 정직성) — 누적 학습기로 바꿔도 현재 달의 데이터가 그 달의 예측에 새지 않는다.
//   ⑤ 실행당 작업량이 일정하다 — 범위가 18개월이 되어도 한 실행은 한 달치 창만 읽는다.
//      (이게 깨지면 함수가 30초 한도를 넘어 백테스트가 조용히 멈춘다 — 예전 사고와 같은 양상.)

'use strict';

const fs = require('fs');
const { t, eq, done, fnPath } = require('./_harness');
const HR = require(fnPath('lib/histrange.js'));

// ── ① 월 유틸 · 온전한 달 추출 ──
eq('addMonths 연도 넘김', HR.nextMonth('202512'), '202601');
eq('prevMonth 연도 넘김', HR.prevMonth('202601'), '202512');
eq('lastDayOf 윤년 2월', HR.lastDayOf('202402'), '20240229');
eq('lastDayOf 평년 2월', HR.lastDayOf('202502'), '20250228');
eq('prevMonthLastDay', HR.prevMonthLastDay('202603'), '20260228');
eq('enumMonths', HR.enumMonths('202511', '202602'), ['202511', '202512', '202601', '202602']);

const wk = (s, e, ty) => `hist/feat/${s}_${e}/${ty || '0001'}`;
eq('창 키 → 온전한 달(정확히 맞는 경계)',
  HR.monthsFromKeys([wk('20260101', '20260131'), wk('20260201', '20260228')]).months,
  ['202601', '202602']);
eq('반쪽 첫 달 버림(20250206부터 수집)',
  HR.monthsFromKeys([wk('20250206', '20250212'), wk('20250301', '20250331')]).months,
  ['202503']);
eq('반쪽 끝 달 버림(20260615에서 끊김)',
  HR.monthsFromKeys([wk('20260501', '20260507'), wk('20260609', '20260615')]).months,
  ['202605']);
eq('창이 없으면 빈 목록', HR.monthsFromKeys([]).months, []);
eq('온전한 달 0개면 빈 목록', HR.monthsFromKeys([wk('20260105', '20260111')]).months, []);

// ── ② 단계 계획 — N=6이면 기존(1월/1~3월/1~5월 학습)과 정확히 같아야 한다 ──
// 여기가 어긋나면 이번 변경이 "범위 추종"이 아니라 "설계 변경"이 된다.
const m6 = HR.enumMonths('202601', '202606');
const p6 = HR.planStages(m6);
eq('N=6 단계 수', p6.length, 3);
eq('N=6 s1 = 1월 학습 → 2·3월 시험', [p6[0].trainMonths, p6[0].testMonths], [['202601'], ['202602', '202603']]);
eq('N=6 s2 = 1~3월 학습 → 4·5월 시험', [p6[1].trainMonths, p6[1].testMonths], [['202601', '202602', '202603'], ['202604', '202605']]);
eq('N=6 s3 = 1~5월 학습 → 6월 시험', [p6[2].trainMonths.length, p6[2].testMonths], [5, ['202606']]);
eq('N=6 s3 날짜 경계', p6[2].test, ['20260601', '20260630']);

// 2025까지 넓어지면(18개월) 같은 비율로 함께 늘어난다
const m18 = HR.enumMonths('202501', '202606');
const p18 = HR.planStages(m18);
eq('N=18 학습 개월 수 3·9·15', p18.map(s => s.trainMonths.length), [3, 9, 15]);
eq('N=18 시험 블록은 절단점 직후 2개월', p18.map(s => s.testMonths), [['202504', '202505'], ['202510', '202511'], ['202604', '202605']]);
t('N=18 시험 블록이 학습 구간보다 뒤(미래 예측)', p18.every(s => s.testMonths[0] > s.trainMonths[s.trainMonths.length - 1]));
t('N=18 라벨에 연도 포함(다년 범위에서 "1월"은 모호)', /2025\.01/.test(p18[0].vlabel), p18[0].vlabel);

// 달이 적으면 단계를 줄인다(없는 시험 블록을 만들지 않는다)
eq('N=3 → 2단계', HR.planStages(HR.enumMonths('202601', '202603')).length, 2);
eq('N=2 → 1단계', HR.planStages(HR.enumMonths('202601', '202602')).length, 1);
eq('N=1 → 0단계', HR.planStages(['202601']).length, 0);
eq('N=0 → 0단계', HR.planStages([]).length, 0);
for (const n of [2, 3, 4, 5, 6, 7, 9, 12, 18, 24, 36]) {
  const ms = HR.enumMonths('202501', HR.addMonths('202501', n - 1));
  const st = HR.planStages(ms);
  t(`N=${n}: 학습이 단계마다 실제로 늘어난다`, st.every((s, i) => i === 0 || s.trainMonths.length > st[i - 1].trainMonths.length), JSON.stringify(st.map(s => s.trainMonths.length)));
  t(`N=${n}: 모든 단계에 시험 블록이 있다`, st.every(s => s.testMonths.length > 0));
  t(`N=${n}: 시험 블록이 범위를 벗어나지 않는다`, st.every(s => s.testMonths[s.testMonths.length - 1] <= ms[ms.length - 1]));
}

// ── ③ 저수지 표집: n은 전수, 표본은 상한 ──
{
  const a = { n: 0, s: [] };
  for (let i = 1; i <= 5000; i++) HR.reservoirPush(a, i, 100);
  eq('reservoir n은 전수 유지', a.n, 5000);
  eq('reservoir 표본은 상한', a.s.length, 100);
  t('reservoir 표본이 앞쪽에만 쏠리지 않음', a.s.filter(v => v > 2500).length >= 20, JSON.stringify(a.s.filter(v => v > 2500).length));
  const b = { n: 0, s: [] };
  for (let i = 1; i <= 5000; i++) HR.reservoirPush(b, i, 100);
  eq('reservoir 결정적(같은 입력 = 같은 표본)', b.s, a.s);
}

// ═══ 통합: 프로덕션과 같은 모양(주 단위 창)으로 범위 확장을 재현 ═══
function makeStore() {
  const m = new Map();
  const store = {
    _m: m, reads: 0, featReads: 0,
    async get(k) { store.reads++; if (/^hist\/(feat|win)\//.test(k)) store.featReads++; return m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : null; },
    async setJSON(k, v) { m.set(k, JSON.parse(JSON.stringify(v))); },
    set(k, v) { m.set(k, JSON.parse(JSON.stringify(v))); },
    async list({ prefix }) { const blobs = []; for (const k of m.keys()) if (k.startsWith(prefix)) blobs.push({ key: k }); return { blobs }; },
  };
  return store;
}
function rng(seed) { return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }; }
// [fromYm, toYm]을 주 단위 창으로 채운다(collect-backfill과 같은 모양).
// lrOf(ym)로 달마다 낙찰가율을 다르게 줄 수 있다 — GR11 오염 검사용.
function seedMonths(store, fromYm, toYm, lrOf) {
  const r = rng(7); let id = 0;
  for (const ym of HR.enumMonths(fromYm, toYm)) {
    const last = +HR.lastDayOf(ym).slice(6);
    for (let d = 1; d <= last; d += 7) {
      const s = ym + String(d).padStart(2, '0');
      const e = ym + String(Math.min(d + 6, last)).padStart(2, '0');
      const feat = [], win = {};
      for (let i = 0; i < 12; i++) {
        id++; const cd = '1', uid = id + '_' + cd;
        const lr = lrOf(ym, r);
        feat.push({ id: String(id), cdtn: cd, usage: '아파트', usageM: '아파트', round: 1, low: 300000000, apsl: 350000000, st: '0010', opbd: s });
        win[uid] = { win: Math.round(300000000 * lr / 100), lr: Math.round(lr * 10) / 10, wr: 0 };
      }
      store.set(`hist/feat/${s}_${e}/0001`, feat);
      store.set(`hist/win/${s}_${e}/0001`, win);
    }
  }
  store.set('hist/_bfmeta', { done: true, records: id });
}

(async () => {
  // ── 모의 라이브: 6개월로 완주 → 2025 수집분이 붙으면 스스로 다시 돈다 ──
  const SIM = fnPath('sim-live.js');
  delete require.cache[require.resolve(SIM)];
  const store = makeStore(); global.__FAKE_STORE__ = store;
  // 정상 구간은 lr 105~115%. 마지막 달(202606)만 lr 900%로 오염시켜 GR11을 행동으로 검사한다:
  // 그 달의 데이터가 그 달 예측에 새면 900%를 맞히게 되고, 새지 않으면 전부 빗나가야 한다.
  seedMonths(store, '202601', '202606', (ym, r) => (ym === '202606' ? 900 : 105 + r() * 10));
  const sim = require(SIM);

  let maxFeatReads = 0, runs = 0, b;
  for (let i = 0; i < 30; i++) {
    store.featReads = 0;
    const r = await sim.handler({ queryStringParameters: {} });
    b = JSON.parse(r.body); runs++;
    maxFeatReads = Math.max(maxFeatReads, store.featReads);
    if (b.done) break;
  }
  const sum6 = await store.get('bt/sim/summary');
  t('6개월 수집 → 5개월 재생 완주', sum6 && sum6.months.length === 5 && sum6.done === true, JSON.stringify(sum6 && sum6.months.map(m => m.ym)));
  eq('재생 구간이 창 키에서 파생됨', sum6.range, '202602~202606');
  eq('학습 출발점도 창 키에서 파생됨', sum6.trainFrom, '202601');

  // GR11 행동 검사 — 오염된 달의 적중률이 0이어야 한다(그 달 데이터를 안 봤다는 뜻)
  const jun = sum6.months.find(m => m.ym === '202606');
  const may = sum6.months.find(m => m.ym === '202605');
  t('GR11: 오염된 달(202606)을 못 맞힘 = 그 달 데이터가 예측에 안 샘', jun && jun.hitRate === 0, JSON.stringify(jun));
  t('정상 달(202605)은 잘 맞힘 = 누적 학습 자체는 작동', may && may.hitRate > 50, JSON.stringify(may));

  // 실행당 작업량이 일정한가 — 한 달치 창(주 단위 5개 × feat/win)만 읽어야 한다
  t('실행당 창 읽기가 한 달치로 제한됨', maxFeatReads <= 14, 'maxFeatReads=' + maxFeatReads);

  // ── 범위 확장: 2025년 7~12월이 추가로 수집됨 ──
  const before = { months: sum6.months.length, range: sum6.range };
  seedMonths(store, '202507', '202512', (ym, r) => 105 + r() * 10);

  let r2 = await sim.handler({ queryStringParameters: { status: '1' } });
  let st2 = JSON.parse(r2.body);
  eq('범위 확장이 즉시 계획에 반영됨', st2.plan.range, '202508~202606');
  eq('학습 출발점도 앞당겨짐', st2.plan.trainFrom, '202507');

  store.featReads = 0;
  r2 = await sim.handler({ queryStringParameters: {} }); const first = JSON.parse(r2.body);
  t('확장 직후 첫 실행이 done으로 끝나지 않는다(다시 돈다)', !first.done, JSON.stringify(first).slice(0, 160));
  t('확장 직후에도 한 실행 = 한 달', store.featReads <= 14, 'featReads=' + store.featReads);

  let guard = 0;
  do { const rr = await sim.handler({ queryStringParameters: {} }); b = JSON.parse(rr.body); } while (!b.done && ++guard < 60);
  const sum18 = await store.get('bt/sim/summary');
  t('확장 후 재생 월 수가 늘어남', sum18.months.length === 11, `${before.months} → ${sum18.months.length}`);
  eq('확장 후 재생 구간', sum18.range, '202508~202606');
  t('옛 범위 결과가 섞여 있지 않음', sum18.months.every(m => m.ym >= '202508'), JSON.stringify(sum18.months.map(m => m.ym)));
  t('per-item 기록도 새 범위로 교체됨', (await store.get('bt/sim/records')).every(x => x.ym >= '202508'));

  // ── 백테스트: 같은 확장에서 단계가 늘어난다 ──
  const BT = fnPath('backtest.js');
  delete require.cache[require.resolve(BT)];
  delete require.cache[require.resolve(fnPath('lib/gbtree.js'))];
  const store2 = makeStore(); global.__FAKE_STORE__ = store2;
  seedMonths(store2, '202601', '202606', (ym, rr) => 105 + rr() * 10);
  const bt = require(BT);

  let g = 0, maxFR = 0;
  do { store2.featReads = 0; const rr = await bt.handler({ queryStringParameters: {} }); b = JSON.parse(rr.body); maxFR = Math.max(maxFR, store2.featReads); } while (!b.done && ++g < 40);
  const bs6 = await store2.get('bt/summary');
  eq('6개월 → 3단계 완주', bs6.stages.map(s => s.vlabel.slice(0, 1)), ['1', '3', '5']);
  eq('요약에 어느 범위로 돌렸는지 기록', bs6.range, '202601~202606');
  t('백테스트도 실행당 작업량 제한(학습은 달 단위, 시험은 최대 2개월)', maxFR <= 30, 'maxFeatReads=' + maxFR);

  seedMonths(store2, '202507', '202512', (ym, rr) => 105 + rr() * 10);
  let rs = await bt.handler({ queryStringParameters: { status: '1' } });
  const plan2 = JSON.parse(rs.body).plan;
  const trainN = s => +/^(\d+)개월/.exec(s)[1];
  eq('확장 후 단계 계획이 늘어남(12개월 → 2·6·10개월 학습)', plan2.stages.map(s => trainN(s.train)), [2, 6, 10]);
  rs = await bt.handler({ queryStringParameters: {} });
  t('확장 직후 백테스트도 다시 돈다', !JSON.parse(rs.body).done, JSON.parse(rs.body).note);
  g = 0;
  do { const rr = await bt.handler({ queryStringParameters: {} }); b = JSON.parse(rr.body); } while (!b.done && ++g < 60);
  const bs11 = await store2.get('bt/summary');
  eq('확장 후 요약 범위 갱신', bs11.range, '202507~202606');
  t('확장 후 학습량이 실제로 늘어남(5개월 → 10개월)', trainN(bs11.stages[2].vlabel) === 10, bs11.stages.map(s => s.vlabel));
  t('옛 범위 단계가 남아 섞이지 않음', bs11.stages.every(s => s.trainRange.startsWith('2025')), JSON.stringify(bs11.stages.map(s => s.trainRange)));

  // ── 소스 규율 ──
  const simSrc = fs.readFileSync(SIM, 'utf8');
  const btSrc = fs.readFileSync(BT, 'utf8');
  t('sim-live에 하드코딩 기본 재생 구간이 없다', !/SIM_START_YM \|\| '2\d{5}'/.test(simSrc) && !/SIM_END_YM \|\| '2\d{5}'/.test(simSrc));
  t('backtest에 하드코딩 STAGES 배열이 없다', !/const STAGES = \[/.test(btSrc));
  t('둘 다 lib/histrange 사용', simSrc.includes("require('./lib/histrange')") && btSrc.includes("require('./lib/histrange')"));
  t('범위 변경 시 상태 초기화(sim)', /state\.range !== rangeKey/.test(simSrc));
  t('범위 변경 시 상태 초기화(backtest)', /state\.range !== rangeKey/.test(btSrc));

  delete global.__FAKE_STORE__;
  done('histrange (수집 범위 자동 추종)');
})().catch(e => { console.log('THROW', e); process.exit(1); });
