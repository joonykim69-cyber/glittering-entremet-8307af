// netlify/functions/collect-rtms.js
// 시세 축 ⑤ 1단계 — RTMS 실거래 데이터 레이어(수집기).
//
// 왜: 시세 nowcast 봉인·채점(⑤)은 "T 이전 실거래로 시세 밴드를 추정 → T 이후 실거래로
//   채점"하는 walk-forward가 핵심인데, RTMS 실거래는 지금까지 온디맨드 조회(rtms-svc)만
//   있고 Blobs에 쌓이는 게 없었다. 낙찰가 엔진의 collect-backfill이 11만 건을 쌓아둔 덕에
//   백테스트가 즉시 됐던 것처럼, 시세도 먼저 과거 실거래를 저장해야 백테스트가 성립한다.
//
// 무엇을: 주거 4종(apt/offi/rh/sh) × 대상 시군구 × 최근 N개월의 실거래를 rtms-svc로 수집해
//   Blobs `mkt/rtms/{lawd}_{kind}/{ym}` = [{amt,area,dd,fl,dong,bt,nm}] 로 저장.
//   ⚠️ 낙찰가 마스킹(feat/win 분리)과 달리 여기선 마스킹이 없다 — 실거래가는 "과거 거래"의
//   정당한 입력이며(숨길 낙찰가가 없음), 시점 정직성(GR11)은 소비 측(백테스트)이 as-of
//   월로 필터링해 보장한다(T 이후 거래는 예측 입력에서 제외, 채점에만 사용).
//
// 실행 모델: collect-backfill과 동일 — 일반 함수(30초), 시간예산(~22초)만큼 작업목록을
//   훑고 커서(작업 인덱스)를 즉시 저장(중간에 죽어도 소실 0). netlify.toml 임시 스케줄이
//   자가 구동, 커서가 끝에 도달하면 no-op. ?status=1 진행조회 / ?reset=1&confirm=1 초기화.
//
// 커서 mkt/rtms/_state {idx}, 진행 mkt/rtms/_meta {records, cellMonths, oldest, newest, done},
// 하트비트 _run/collect-rtms. 대상 시군구는 **전국 253곳** 기본(env MKT_RTMS_LAWD로 좁힐 수 있음).

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const TIME_BUDGET_MS = 22000;
const CONCURRENCY = 5;

// 주거 4종 — rtms-svc svc 별칭(레지스트리 확정). market-est가 쓰는 것과 동일 유형.
const RESI = [
  { k: 'apt', svc: 'apt_trade_dev' },
  { k: 'offi', svc: 'offi_trade' },
  { k: 'rh', svc: 'rh_trade' },
  { k: 'sh', svc: 'sh_trade' },
];

// 대상 시군구(법정동 앞 5자리) — **전국 253곳** (2026-07-31 창업자 지시로 서울 25구에서 확장).
//
// 왜 넓혔나: 랜딩 차익(margin) 트랙이 0건이었는데 원인이 여기였다. 시세 밴드는 수집한 지역에만
// 생기고(서울 25구 × 주거 4종 = 정확히 100셀), 공매 주거 재고는 대부분 서울 밖이다
// (실측: 안성·당진·파주·경산·제주·목포·구미…). 밴드가 없으면 차익을 계산할 수 없고, 큐레이션은
// 계산 못 하는 물건을 랜딩에 올리지 않는다(근거 없으면 안 내놓는다) → 트랙이 통째로 비었다.
//
// 목록은 lib/lawd.js를 단일 출처로 삼는다(세종처럼 별칭이 겹치는 항목이 있어 중복 제거).
// env MKT_RTMS_LAWD(콤마)로 좁힐 수도 있다 — 쿼터 문제로 단계적 수집이 필요할 때.
const { LAWD } = require('./lib/lawd');
const ALL_LAWDS = [...new Set(Object.values(LAWD).flatMap(m => Object.values(m)))];
const LAWDS = (process.env.MKT_RTMS_LAWD || ALL_LAWDS.join(',')).split(',').map(s => s.trim()).filter(Boolean);
const MONTHS_BACK = Math.max(1, Math.min(60, parseInt(process.env.MKT_RTMS_MONTHS || '24', 10)));

// 수집 범위 지문. 커서(idx)는 **작업목록 배열의 인덱스**라 목록이 바뀌면 의미를 잃는다 —
// 서울 25구(2,400건)에서 전국(24,288건)으로 넓히면 같은 idx가 전혀 다른 작업을 가리키고,
// 그대로 이어받으면 앞쪽 달의 새 지역이 **영영 수집되지 않는다**. 범위가 바뀌면 처음부터
// 다시 훑는다(백테스트가 bt/_state.range 불일치를 다루는 방식과 같다). 이미 받은 셀은
// 같은 값으로 덮어써질 뿐이라 손실이 없다.
const SCOPE = require('crypto').createHash('sha1')
  .update(`${[...LAWDS].sort().join(',')}|${MONTHS_BACK}`).digest('hex').slice(0, 12);

// 같은 작업에서 연속 실패가 이만큼 쌓이면 그 하나를 건너뛴다(영구 정지 방지).
const MAX_STUCK = 3;

function num(v) { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; }

// rtms-svc 원시 아이템 → 압축 실거래(만원·㎡). market-est의 필드 매핑과 동일 규칙.
function mapTrade(x) {
  const area = parseFloat(x.excluUseAr || x.dealArea || x.buildingAr || x.totalFloorAr || '') || 0;
  const amt = num(x.dealAmount); // 만원
  if (!(amt > 0 && area > 0)) return null;
  return {
    amt, area,
    dd: num(x.dealDay) || 0,
    fl: num(x.floor) || 0,
    dong: x.umdNm || '',
    bt: num(x.buildYear) || 0,
    nm: x.aptNm || x.offiNm || x.mhouseNm || x.bldgNm || '',
  };
}

// 최근 N개월(YYYYMM) — 최신 먼저. KST 기준.
function recentMonths(n) {
  const out = [];
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  let y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;
  for (let i = 0; i < n; i++) { out.push(`${y}${String(m).padStart(2, '0')}`); m--; if (m < 1) { m = 12; y--; } }
  return out;
}

// 작업목록: 월(최신→과거) × 시군구 × 주거유형. 커서는 이 배열의 인덱스.
function buildWorklist(months, lawds) {
  const w = [];
  for (const ym of months) for (const lawd of lawds) for (const r of RESI) w.push({ ym, lawd, k: r.k, svc: r.svc });
  return w;
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function openLedger(event) {
  if (global.__FAKE_STORE__) return global.__FAKE_STORE__; // 테스트 주입 훅(다른 예약 함수와 동일)
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
  const qs = (event && event.queryStringParameters) || {};
  const store = await openLedger(event);
  const base = process.env.URL || '';

  const months = recentMonths(MONTHS_BACK);
  const work = buildWorklist(months, LAWDS);
  const newest = months[0], oldest = months[months.length - 1];

  try {
    let state = (await store.get('mkt/rtms/_state', { type: 'json' })) || null;
    let meta = (await store.get('mkt/rtms/_meta', { type: 'json' })) ||
      { records: 0, cellMonths: 0, oldest, newest, done: false, total: work.length };

    if (qs.status === '1') {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, state: state || { idx: 0 }, meta, total: work.length, lawds: LAWDS.length, months: MONTHS_BACK, scope: SCOPE }) };
    }
    if (qs.reset === '1' && qs.confirm === '1') { state = null; meta = { records: 0, cellMonths: 0, oldest, newest, done: false, total: work.length }; }

    // 수집 범위가 바뀌었으면 커서를 버리고 처음부터 — 이어받으면 새 지역이 영영 안 채워진다.
    let rescoped = false;
    if (state && state.scope !== SCOPE) {
      rescoped = true;
      state = null;
      meta = { records: 0, cellMonths: 0, oldest, newest, done: false, total: work.length, rescopedAt: new Date().toISOString() };
    }
    if (!state) state = { idx: 0, scope: SCOPE, stuck: 0 };
    let idx = state.idx || 0;
    let stuck = state.stuck || 0;
    let lastError = null, skipped = 0;

    // 작업목록 길이가 바뀌면(대상 확장 등) 이미 idx가 끝을 넘었을 수 있음 → done 처리
    if (idx >= work.length) {
      meta.done = true; meta.updatedAt = new Date().toISOString();
      await store.setJSON('mkt/rtms/_meta', meta);
      await store.setJSON('_run/collect-rtms', { at: new Date().toISOString(), ok: true, done: true, records: meta.records });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, done: true, meta, note: 'RTMS 수집 완료 — 더 수집할 셀-월이 없습니다.' }) };
    }

    const t0 = Date.now();
    let processed = 0, added = 0, cells = 0;
    while (idx < work.length && Date.now() - t0 < TIME_BUDGET_MS) {
      const chunk = work.slice(idx, idx + CONCURRENCY);
      const results = await Promise.all(chunk.map(async (job) => {
        try {
          const d = await fetchJson(`${base}/.netlify/functions/rtms-svc?svc=${job.svc}&lawdCd=${job.lawd}&dealYmd=${job.ym}&numOfRows=1000`);
          const items = Array.isArray(d && d.items) ? d.items : [];
          const trades = items.map(mapTrade).filter(Boolean);
          if (trades.length) await store.setJSON(`mkt/rtms/${job.lawd}_${job.k}/${job.ym}`, trades);
          return { n: trades.length, ok: true };
        } catch (e) { return { n: 0, ok: false, err: e.message }; }
      }));

      // **실패는 "거래 없음"과 다르다.** 예전엔 둘 다 0으로 접어 커서를 전진시켰는데, 그러면
      // 호출이 실패한 셀은 영영 수집되지 않는다(전국 확장으로 호출이 10배가 되면서 일일 쿼터
      // 소진이 현실적인 위험이 됐다 — 쿼터가 끊기면 남은 호출이 전부 실패하고, 조용히 넘기면
      // 그날 이후 구간이 통째로 빈다). 그래서 **실패 지점 앞까지만 전진하고 이번 실행을 멈춘다.**
      const firstFail = results.findIndex(r => !r.ok);
      const upto = firstFail >= 0 ? firstFail : results.length;
      for (let i = 0; i < upto; i++) { if (results[i].n > 0) { added += results[i].n; cells++; } }
      processed += upto;
      idx += upto;

      if (firstFail >= 0) {
        lastError = results[firstFail].err;
        stuck++;
        // 다만 한 셀이 계속 깨지면(코드 오류 등) 영구 정지하므로, 몇 번 재시도한 뒤엔 건너뛴다.
        if (stuck >= MAX_STUCK) { idx += 1; stuck = 0; skipped++; }
        await store.setJSON('mkt/rtms/_state', { idx, scope: SCOPE, stuck });
        break;
      }
      stuck = 0;
      await store.setJSON('mkt/rtms/_state', { idx, scope: SCOPE, stuck }); // 청크마다 커서 저장 — 소실 0
    }

    meta.records += added;
    meta.cellMonths += cells;
    const done = idx >= work.length;
    meta.done = done;
    meta.idx = idx;
    meta.total = work.length;
    meta.lawds = LAWDS.length;
    meta.scope = SCOPE;
    if (skipped) meta.skipped = (meta.skipped || 0) + skipped;   // 건너뛴 셀은 조용히 사라지지 않는다
    if (lastError) meta.lastError = lastError; else delete meta.lastError;
    meta.updatedAt = new Date().toISOString();
    await store.setJSON('mkt/rtms/_meta', meta);
    await store.setJSON('_run/collect-rtms', {
      at: new Date().toISOString(), ok: true, done, records: meta.records, addedThisRun: added,
      idx, total: work.length, ...(rescoped ? { rescoped: true } : {}),
      ...(lastError ? { lastError } : {}), ...(skipped ? { skipped } : {}),
    });

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        ok: true, done, idx, total: work.length, processedThisRun: processed, addedThisRun: added, cellsThisRun: cells,
        ...(rescoped ? { rescoped: true, note0: '수집 범위가 바뀌어 커서를 초기화했습니다.' } : {}),
        ...(lastError ? { lastError } : {}), ...(skipped ? { skipped } : {}), meta,
        note: done ? `RTMS 수집 완료 — 전국 ${LAWDS.length}개 시군구 × 주거 4종 × 최근 ${MONTHS_BACK}개월(총 ${meta.records.toLocaleString()}건).`
          : `진행 중 — 작업 ${idx}/${work.length}. 다음 실행이 이어서 수집합니다.${lastError ? ' (직전 호출 실패 — 그 지점부터 재시도합니다)' : ''}`,
      }),
    };
  } catch (e) {
    try { await store.setJSON('_run/collect-rtms', { at: new Date().toISOString(), ok: false, error: e.message }); } catch (_) { /* 무시 */ }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

// 테스트용 순수 함수 노출 (온비드/RTMS API 미호출)
exports._test = { mapTrade, recentMonths, buildWorklist, RESI, ALL_LAWDS, LAWDS, SCOPE, MAX_STUCK };
