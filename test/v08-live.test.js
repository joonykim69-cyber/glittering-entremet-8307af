// test/v08-live.test.js — 라이브 챌린저 v0.5 → v0.8 교체 (2026-08-02 창업자 결정)
//
// 배경: v0.8(GBDT)이 walk-forward 백테스트 3단계 × 3지표(적중률·오차·폭) 전승.
//   폭이 **좁아지며** 이겼으므로 GR4(넓혀서 맞히기 금지) 위반이 아니다.
//
// 지키는 것:
//   ① 학습(train-gb)은 과거 개찰 기록만 쓰고, 반쪽 데이터로는 아티팩트를 갱신하지 않는다
//   ② 봉인(predict-daily)은 아티팩트를 읽기만 한다 — 있으면 v0.8, 없으면 v0.5 폴백
//   ③ 챔피언 봉인 공식·봉인 불변성은 그대로다
//   ④ 채점(score-daily)은 모델별로 성적을 가른다 — 섞으면 승격 체크포인트가 오염된다
//   ⑤ 교체는 연혁(chronicle)에 남는다

'use strict';

const { t, eq, done, repoPath } = require('./_harness');
const TG = repoPath('netlify/functions/train-gb.js');
const PD = repoPath('netlify/functions/predict-daily.js');
const SD = repoPath('netlify/functions/score-daily.js');
const V08 = require(repoPath('netlify/functions/lib/v08.js'));

function makeStore() {
  const m = new Map();
  return { _m: m,
    async get(k) { return m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : null; },
    async setJSON(k, v) { m.set(k, JSON.parse(JSON.stringify(v))); },
    set(k, v) { m.set(k, JSON.parse(JSON.stringify(v))); },
    async list(o) { const p = (o && o.prefix) || ''; return { blobs: [...m.keys()].filter(k => k.startsWith(p)).map(k => ({ key: k })) }; },
  };
}
const fresh = (p) => { delete require.cache[require.resolve(p)]; return require(p); };
process.env.URL = 'http://test.local'; // 없으면 fetch가 상대 URL로 즉시 죽는다(collect-history의 교훈)

(async () => {
  // ── lib/v08: GR11 — 예측 입력의 win/lr은 무시된다 ──
  {
    const rows = [];
    for (let i = 0; i < 300; i++) {
      rows.push({ st: '0010', type: '0001', usage: '아파트', round: 1 + (i % 4), low: 8000 + i * 10, apsl: 10000 + i * 10, lr: 95 + (i % 20) });
    }
    const model = V08.trainV08(rows);
    t('lib: 학습 성공', !!model && model.n === 300);
    const a = V08.predictV08(model, { type: '0001', usage: '아파트', round: 2, low: 9000, apsl: 11000 });
    const b = V08.predictV08(model, { type: '0001', usage: '아파트', round: 2, low: 9000, apsl: 11000, win: 999999, lr: 500 });
    t('lib: 예측 [lo≤mid≤hi]', a && a.lo <= a.mid && a.mid <= a.hi);
    eq('lib: GR11 — win/lr을 넣어도 결과 동일', JSON.stringify(b), JSON.stringify(a));
    t('lib: 표본 50 미만이면 학습 안 함', V08.trainV08(rows.slice(0, 30)) === null);
  }

  // ── ① train-gb: 세 포맷을 합쳐 학습하고 아티팩트를 저장한다 ──
  const store = makeStore();
  global.__FAKE_STORE__ = store;
  {
    // 마스킹 분리 백필(feat+win) + 증분(win 내장) 두 포맷을 심는다
    const feats = [], winMap = {};
    for (let i = 0; i < 200; i++) {
      feats.push({ id: 'F' + i, cdtn: '1', st: '0010', usage: '아파트', round: 1 + (i % 3), low: 9000 + i * 5, apsl: 12000 + i * 5, opbd: '20250301' });
      winMap['F' + i + '_1'] = { win: 10000, wr: 90, lr: 100 + (i % 15), bd: 2 };
    }
    store.set('hist/feat/20250101_20250107/0001', feats);
    store.set('hist/win/20250101_20250107/0001', winMap);
    const inc = [];
    for (let i = 0; i < 100; i++) inc.push({ id: 'I' + i, cdtn: '1', st: '0010', usage: '차량', round: 1, low: 300 + i, apsl: 400 + i, lr: 110 + (i % 10), win: 1, wr: 1, bd: 1 });
    store.set('hist/_inc/0002', inc);
    // 수의계약 관측은 학습 표본이 아니다 — 섞이면 안 된다
    store.set('hist/_incpvct/0001', [{ id: 'PV1', cdtn: '1', st: '0009', usage: '아파트', round: 9, low: 100, apsl: 1000, lr: 0 }]);

    const r = JSON.parse((await fresh(TG).handler({})).body);
    t('① 학습 성공', r.ok === true && r.trained === true, JSON.stringify(r));
    eq('① 표본 = feat 200 + inc 100 (수의계약 제외)', r.totalRows, 300);
    const art = await store.get('hist/_gb08');
    t('① 아티팩트 저장', !!art && !!art.gb && art.modelV === 'v0.8-gbdt');
    const hb = await store.get('_run/train-gb');
    t('① 하트비트(소요시간 포함)', hb && hb.ok === true && typeof hb.ms === 'number');
  }

  // ── ② predict-daily: 아티팩트가 있으면 v0.8로 봉인한다 ──
  {
    // 봉인 대상 물건 목킹 (KST 오늘 마감)
    const kst = new Date(Date.now() + 9 * 3600 * 1000);
    const ymd = `${kst.getUTCFullYear()}${String(kst.getUTCMonth() + 1).padStart(2, '0')}${String(kst.getUTCDate()).padStart(2, '0')}`;
    global.fetch = async (url) => {
      if (url.includes('onbid-svc')) return { ok: true, json: async () => ({ items: [{ clsCdNm: '아파트', scfbAmtRto1: 85, scfbAmtRto2: 105 }] }) };
      if (!url.includes('/onbid-search')) return { ok: true, json: async () => ({ items: [], totalCount: 0 }) }; // 동산·차량은 비움
      const items = [{ id: 'LIVE1', pbctCdtnNo: '9', title: 'T', type: '아파트', usage: '아파트', assetClass: '부동산',
        appr: 12000, min: 9000, fail: 1, round: 2, bidEnd: ymd + '1700' }];
      return { ok: true, json: async () => ({ items, totalCount: 1 }) };
    };
    const r = JSON.parse((await fresh(PD).handler({})).body);
    t('② 챔피언 봉인', r.sealed === 1, JSON.stringify(r));
    eq('② 챌린저 봉인(v0.8)', r.sealedB, 1);
    const pb = await store.get('predb/LIVE1_9');
    eq('② predb.modelV', pb && pb.modelV, 'v0.8-gbdt');
    t('② 학습 표본 수를 봉인에 남김', pb && pb.gbN > 0);
    t('② [lo≤mid≤hi]', pb && pb.lo <= pb.mid && pb.mid <= pb.hi);
    // 챔피언 공식 불변 — 앵커 수식 그대로인지 (85%·105% 통계로 손계산 대조)
    const pred = await store.get('pred/LIVE1_9');
    const anc = [12000 * 0.85, 9000 * 1.05];
    eq('③ 챔피언 mid = 앵커 평균(공식 불변)', pred && pred.mid, Math.round((anc[0] + anc[1]) / 2));
    // 봉인 불변 — 재실행해도 덮어쓰지 않는다
    const before = JSON.stringify(pb);
    await fresh(PD).handler({});
    eq('③ 재실행에도 챌린저 봉인 불변', JSON.stringify(await store.get('predb/LIVE1_9')), before);
  }

  // ── ②-폴백: 아티팩트가 없으면 v0.5 셀로 봉인한다 ──
  {
    const s2 = makeStore(); global.__FAKE_STORE__ = s2;
    s2.set('hist/_cells', { cells: { 'L1|0001|아파트': { n: 40, lr: { p10: 90, p50: 100, p90: 115 } } } });
    const kst = new Date(Date.now() + 9 * 3600 * 1000);
    const ymd = `${kst.getUTCFullYear()}${String(kst.getUTCMonth() + 1).padStart(2, '0')}${String(kst.getUTCDate()).padStart(2, '0')}`;
    global.fetch = async (url) => {
      if (url.includes('onbid-svc')) return { ok: true, json: async () => ({ items: [{ clsCdNm: '아파트', scfbAmtRto1: 85, scfbAmtRto2: 105 }] }) };
      if (!url.includes('/onbid-search')) return { ok: true, json: async () => ({ items: [], totalCount: 0 }) };
      return { ok: true, json: async () => ({ items: [{ id: 'FB1', pbctCdtnNo: '9', title: 'T', type: '아파트', usage: '아파트', assetClass: '부동산', appr: 12000, min: 9000, fail: 1, round: 2, bidEnd: ymd + '1700' }], totalCount: 1 }) };
    };
    await fresh(PD).handler({});
    const pb = await s2.get('predb/FB1_9');
    eq('②-폴백 아티팩트 없으면 v0.5', pb && pb.modelV, 'v0.5-cells');
  }

  // ── ④ score-daily: 모델 전환 시 아카이브 + 0부터 재시작, 늦은 v0.5는 아카이브로 ──
  {
    const s3 = makeStore(); global.__FAKE_STORE__ = s3;
    // 기존 v0.5 공식 비교 기록(142건이라 치자)
    s3.set('aggB', { modelV: 'v0.5-cells', n: 142, hit: 118, sumAbsErrPct: 4487, sumWidthPct: 29252, headToHead: { n: 142, bWins: 89 }, byLevel: {}, roundReal: { real: 125, approx: 0 } });
    s3.set('agg', { n: 0, hit: 0, byTier: {}, byUsage: {}, daily: {}, byAsset: {}, byLead: {}, errBuckets: {} });
    // 챔피언 봉인 2건 + 챌린저: 하나는 v0.8, 하나는 구모델 v0.5(교체 전 봉인분의 늦은 개찰)
    const mk = (id) => ({ id, pbctCdtnNo: '1', title: 'T', type: '아파트', usage: '아파트', assetClass: '부동산',
      appr: 12000, min: 9000, lo: 8000, mid: 9500, hi: 11000, w: 0.18, statBucket: '아파트', round: 2, fail: 1, bidEnd: '209912310000', modelV: 'v0.1', sealedAt: 'x' });
    s3.set('pred/W1_1', mk('W1'));
    s3.set('pred/W2_1', mk('W2'));
    s3.set('predb/W1_1', { id: 'W1', pbctCdtnNo: '1', lo: 9000, mid: 9800, hi: 10800, modelV: 'v0.8-gbdt', gbN: 300, roundReal: true });
    s3.set('predb/W2_1', { id: 'W2', pbctCdtnNo: '1', lo: 8800, mid: 9600, hi: 10500, modelV: 'v0.5-cells', cellKey: 'L1|0001|아파트', roundReal: true });
    global.fetch = async (url) => {
      const u = new URL(url); const cd = u.searchParams.get('cltrTypeCd');
      const rows = cd === '0001' ? [
        { id: 'W1', pbctCdtnNo: '1', statCd: '0010', winAmt: 100000000, winRate: 100, lowstRate: 111, apslAmt: 120000000, lowstAmt: 90000000, usage: '아파트', round: 2, opbdDt: '20260801', bidderCnt: 2 },
        { id: 'W2', pbctCdtnNo: '1', statCd: '0010', winAmt: 100000000, winRate: 100, lowstRate: 111, apslAmt: 120000000, lowstAmt: 90000000, usage: '아파트', round: 2, opbdDt: '20260801', bidderCnt: 2 },
      ] : [];
      return { ok: true, json: async () => ({ results: rows, totalCount: rows.length }) };
    };
    const r = JSON.parse((await fresh(SD).handler({})).body);
    t('④ 채점 2건', r.graded === 2, JSON.stringify(r).slice(0, 160));
    const aggB = await s3.get('aggB');
    eq('④ 공식 비교 = v0.8 이름표', aggB.modelV, 'v0.8-gbdt');
    eq('④ v0.8 0부터 재시작 — 이번 1건만', aggB.n, 1);
    t('④ 상대전적도 재시작', aggB.headToHead.n === 1);
    const arc = await s3.get('aggB_archive_v0.5-cells');
    t('④ v0.5 기록은 아카이브에 보관', !!arc && arc.modelV === 'v0.5-cells');
    eq('④ 늦은 v0.5 개찰은 아카이브에 누적 (142+1)', arc.n, 143);
    // 재실행 — scored 마커로 이중 집계 없음 + 아카이브 재리셋 없음
    await fresh(SD).handler({});
    eq('④ 재실행 이중 집계 0', (await s3.get('aggB')).n, 1);
    eq('④ 아카이브도 그대로', (await s3.get('aggB_archive_v0.5-cells')).n, 143);
    // ⑤ 교체가 연혁에 남는다
    const ch = await s3.get('chronicle');
    t('⑤ chronicle에 비교 재시작 기록', Array.isArray(ch) && ch.some(c => c.kind === 'model' && /재시작/.test(c.title || '')));
    t('⑤ 이전 성적을 detail에 보존', ch.some(c => c.detail && c.detail.prev && c.detail.prev.n === 142));
  }

  delete global.__FAKE_STORE__; delete global.fetch;
  done('라이브 챌린저 v0.8 (학습·봉인·폴백·모델별 채점 분리·연혁)');
})().catch(e => { console.log('THROW', e); process.exit(1); });
