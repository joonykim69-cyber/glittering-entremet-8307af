// netlify/functions/train-gb.js — 라이브 챌린저 v0.8의 일일 학습기
// (scheduled KST 20:40 = cron `40 11 * * *` UTC — collect-history(20:10)가 신규분을 갱신한 직후)
//
// 왜 있나 (2026-08-02, 창업자 결정 "라이브 챌린저를 변경 적용하세요"):
//   v0.8(GBDT)이 walk-forward 백테스트 3단계 × 3지표(적중률·오차·폭) 전승으로 라이브
//   챌린저에 채택됐다. v0.5는 셀 조회라 학습이 따로 없지만, v0.8은 **학습된 모델 아티팩트**가
//   있어야 봉인할 수 있다. predict-daily 안에서 학습하면 30초 한도를 나눠 쓰게 되므로
//   (봉인은 원장의 근간 — 학습 때문에 봉인이 죽는 구조는 만들지 않는다) 학습을 이 함수로
//   분리하고, predict-daily는 저장된 아티팩트를 읽기만 한다.
//
// 무엇을: hist/feat/* + hist/win/*(마스킹 분리 백필) + hist/_inc/*(증분, win 내장)를 전부 읽어
//   낙찰(0010) 표본으로 lib/v08.trainV08 학습 → `hist/_gb08` {enc, gb, n, trainedAt} 저장.
//   backtest·hist-stats와 같은 청크 병렬(mapLimit 40) 읽기라 30초 안에 끝난다
//   (hist-stats가 같은 방식으로 40만 건을 재빌드한다). 온비드 API 호출 0(쿼터 무관).
//
// GR11(시점 정직성): 학습 표본은 전부 이미 개찰이 끝난 과거 기록이다. 예측 시점(다음 날
//   봉인)보다 항상 과거이므로 미래 누수가 없다. 집계기(hist-stats)와 같은 지위로 win을
//   읽지만, 산출물(모델)은 lr 분위수 함수일 뿐이고 예측 입력에는 win이 없다.
//
// 실패 시: 아티팩트를 **덮어쓰지 않는다** — 반쪽 데이터로 학습한 모델을 저장하면 다음 날
//   봉인이 편향된 모델을 쓴다. 기존 아티팩트가 남아 predict-daily는 어제 모델로 계속 봉인하고,
//   하트비트 `_run/train-gb`에 실패가 남는다.

'use strict';

const { trainV08 } = require('./lib/v08.js');

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
// 읽기 예산 — 학습 자체가 실측 ~14초(12,000표본, prefix-sum 최적화 후)라, 읽기가 이걸
// 넘기면 30초 안에 못 끝난다. 학습을 시작하기 **전에** 판정해야 중간에 죽지 않는다.
const READ_BUDGET_MS = 10000;

async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) out.push(...await Promise.all(items.slice(i, i + limit).map(fn)));
  return out;
}

async function openLedger(event) {
  if (global.__FAKE_STORE__) return global.__FAKE_STORE__; // fixture 검증용
  const blobs = await import('@netlify/blobs');
  try { if (event && typeof blobs.connectLambda === 'function') blobs.connectLambda(event); } catch (e) { /* 신형 런타임 자동 구성 */ }
  try {
    return blobs.getStore('ledger');
  } catch (e) {
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token = process.env.NETLIFY_BLOBS_TOKEN;
    if (siteID && token) return blobs.getStore({ name: 'ledger', siteID, token });
    throw e;
  }
}

exports.handler = async (event) => {
  const store = await openLedger(event);
  const t0 = Date.now();
  try {
    const listing = await store.list({ prefix: 'hist/' });
    const allKeys = (listing && listing.blobs ? listing.blobs : []).map(b => b.key);
    // hist-stats와 같은 세 포맷: 구형 통짜 / 증분 롤링(win 내장) / 마스킹 분리(feat+win 조인).
    // hist/pvct·hist/_incpvct(수의계약 관측)는 학습 표본이 아니므로 정규식에 안 걸린다.
    const oldKeys = allKeys.filter(k => /^hist\/\d{8}_\d{8}\/\d+$/.test(k));
    const incKeys = allKeys.filter(k => /^hist\/_inc\/\d+$/.test(k));
    const featKeys = allKeys.filter(k => /^hist\/feat\/\d{8}_\d{8}\/\d+$/.test(k));

    const seen = new Set();
    const rows = [];
    const push = (r, win) => {
      if (!r || !r.id) return;
      const uid = `${r.id}_${r.cdtn}`;
      if (seen.has(uid)) return;
      seen.add(uid);
      const w = win || r; // 구형·증분은 레코드에 win 내장, 신형은 winMap에서 조인
      if (r.st !== '0010' || !(Number(w.lr) > 0) || !(Number(r.low) > 0)) return;
      rows.push({ type: r.type, usage: r.usage, round: r.round, low: r.low, apsl: r.apsl, lr: Number(w.lr), st: '0010' });
    };

    // 증분을 먼저(최신 우선 — id_cdtn 중복 시 최신 관측이 남도록 seen 순서로 보장)
    await mapLimit(incKeys.concat(oldKeys), 40, async (key) => {
      const arr = await store.get(key, { type: 'json' });
      const type = key.split('/').pop();
      if (Array.isArray(arr)) for (const r of arr) push({ ...r, type: r.type || type });
    });
    await mapLimit(featKeys, 40, async (key) => {
      if (Date.now() - t0 > READ_BUDGET_MS) return; // 예산 초과분은 아래에서 실패 처리
      const type = key.split('/').pop();
      const winKey = key.replace('/feat/', '/win/');
      const [feats, winMap] = await Promise.all([
        store.get(key, { type: 'json' }), store.get(winKey, { type: 'json' }),
      ]);
      if (!Array.isArray(feats) || !winMap) return;
      for (const f of feats) push({ ...f, type: f.type || type }, winMap[`${f.id}_${f.cdtn}`]);
    });

    // 시간을 넘겨 일부 창을 못 읽었으면 학습하지 않는다 — 반쪽 데이터로 학습한 모델을
    // 저장하면 다음 날 봉인 전체가 편향된다. 기존 아티팩트를 그대로 두는 쪽이 정직하다.
    if (Date.now() - t0 > READ_BUDGET_MS) {
      await store.setJSON('_run/train-gb', { at: new Date().toISOString(), ok: false, error: `읽기 예산 초과(${Date.now() - t0}ms) — 학습 미시작·아티팩트 미갱신`, rows: rows.length });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, reason: 'read_budget', rows: rows.length }) };
    }

    const model = trainV08(rows);
    if (!model) {
      // 표본 부족 — 지어내지 않는다. predict-daily는 아티팩트가 없으면 v0.5로 폴백한다.
      await store.setJSON('_run/train-gb', { at: new Date().toISOString(), ok: true, trained: false, rows: rows.length, note: '낙찰 표본 50건 미만 — 학습 생략' });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, trained: false, rows: rows.length }) };
    }

    const trainMs = Date.now() - t0;
    await store.setJSON('hist/_gb08', {
      enc: model.enc, gb: model.gb, n: model.n,
      totalRows: rows.length, modelV: 'v0.8-gbdt',
      trainedAt: new Date().toISOString(),
    });
    // 하트비트에 소요시간을 남긴다 — collect-history가 시간 벽에 조용히 죽었던 전례.
    await store.setJSON('_run/train-gb', { at: new Date().toISOString(), ok: true, trained: true, n: model.n, totalRows: rows.length, ms: trainMs });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, trained: true, n: model.n, totalRows: rows.length, ms: trainMs }) };
  } catch (e) {
    try { await store.setJSON('_run/train-gb', { at: new Date().toISOString(), ok: false, error: e.message }); } catch (_) { /* 무시 */ }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
