// netlify/functions/collect-backfill.js
// 과거 학습 프로젝트 2단계 — "1~6월 전수 수집 + 낙찰가 마스킹" 백필기.
//
// 목적: 2026년 1~6월 온비드 개찰결과(부동산·차량·동산)를 전수(census)로 수집하되,
//   **낙찰가(win)와 그 파생 비율(wr/lr)을 물리적으로 분리 저장**해 예측 모듈이
//   특정 물건의 낙찰가에 절대 접근하지 못하게 한다(사용자 확정 마스킹 원칙).
//
//   hist/feat/{start}_{end}/{type} = 개찰 전 피처 배열 — { id, cdtn, round, usage,
//       usageM, apsl(감정가), low(최저가), st(결과코드), opbd(개찰일), carYr? }
//       ⚠️ 낙찰가·낙찰가율 없음. 예측 모듈은 이 네임스페이스만 읽는다.
//   hist/win/{start}_{end}/{type}  = { "id_cdtn": { win(낙찰가), wr, lr, bd(입찰자수) } }
//       ⚠️ 개찰 결과(정답). 통계 집계기(hist-stats)와 백테스트 채점기만 읽는다.
//       예측 모듈은 이 파일을 require조차 하지 않는다(코드 리뷰로 차단 검증).
//
// 실행 모델: 일반 함수(30초 한도)라 한 번에 시간예산(~22초)만큼만 수집하고 커서를
//   창(window)마다 즉시 저장 → 다음 실행이 이어받는다(중간에 죽어도 소실 0).
//   netlify.toml의 임시 스케줄이 몇 분마다 자가 구동하며, 커서가 목표 시작일에
//   도달하면 즉시 no-op. 수동 GET도 동일 동작(진행 상황 JSON 반환).
//   ?status=1 = 수집 없이 진행 상황만 / ?reset=1&confirm=1 = 커서 초기화.
//
// 커서 hist/_bfstate {cursorEnd}, 진행 hist/_bfmeta {records, windows, oldest, newest, done}
// 쿼터: **lib/quota.js 예산 가드('bulk' 티어)** 아래에서만 호출한다. data.go.kr 온비드 일일
//   한도(1,000)에서 사용자 화면 몫(ONBID_LIVE_RESERVE)을 뺀 만큼이 이 수집기의 상한이며,
//   예산이 떨어지면 실패가 아니라 **커서를 남기고 깨끗하게 중단**한다(다음 날 이어서 수집).

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const quota = require('./lib/quota.js');
const WINDOW_DAYS = 7;
const MAX_PAGES = 15;             // 창×자산군당 최대 페이지 (numOfRows=1000 census)
const TIME_BUDGET_MS = 22000;     // 30초 함수 한도 안전 예산
// 수집 목표 구간. 2026-07-27 창업자 지시로 2025까지 확장(BF_START 20260101→20250101).
// 기존 프로덕션 커서(2026 완료 시점 = 20251231)가 그대로 2025로 이어지므로 2026분은 재수집 안 함
// (창 블롭 키가 달라 덮어쓰기도 없음). 수집 중 hist/_bfmeta.done이 false가 되어 sim-live/backtest는
// 2025 완료까지 일시 no-op → 완료 시 자동 재개(그때 sim-live env를 2025로 넓혀 더 긴 곡선 재생).
const BF_START = (process.env.HIST_BF_START || '20250101').replace(/[^0-9]/g, '');
const BF_END = (process.env.HIST_BF_END || '20260630').replace(/[^0-9]/g, '');

function ymd(d) { return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`; }
function addDays(yyyymmdd, n) {
  const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)));
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}
const maxStr = (a, b) => (a >= b ? a : b);

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Lambda 호환 함수는 Blobs 자동 구성이 안 되므로 connectLambda로 수동 연결 (다른 예약 함수와 동일 패턴)
async function openLedger(event) {
  if (global.__FAKE_STORE__) return global.__FAKE_STORE__;
  const blobs = await import('@netlify/blobs');
  try { if (event && typeof blobs.connectLambda === 'function') blobs.connectLambda(event); } catch (e) { /* 신형 런타임은 자동 구성 */ }
  try {
    return blobs.getStore('ledger');
  } catch (e) {
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token = process.env.NETLIFY_BLOBS_TOKEN;
    if (siteID && token) return blobs.getStore({ name: 'ledger', siteID, token });
    throw e;
  }
}

// 수의계약가능(0009) — 학습 표본이 아니라 **별도 관측 축**.
// 왜 따로 담나: 부동산 개찰 이벤트의 18.7%가 이 상태로 빠지는데(자동차·동산은 1% 미만)
// 지금까지 수집기가 통째로 버려서 이 채널을 **영원히 측정할 수 없는 상태**였다(2026-08-01 발견).
// 그렇다고 hist/feat에 섞으면 진행 중인 모델 비교(backtest·sim-live)의 coverage 분모와
// hist-stats 셀 표본 수가 함께 흔들린다 — 관측을 늘리려다 성적을 흔드는 건 맞바꿀 게 아니다.
// 그래서 `hist/pvct/*`에 따로 쌓고, 학습·채점 경로는 한 줄도 건드리지 않는다.
const PVCT_ST = '0009';

// onbid-bidresults 결과 1건 → 마스킹 분리: feat(개찰 전) / win(개찰 결과)
// 낙찰(0010)·유찰(0011)만 학습 표본. win엔 낙찰가/비율/입찰자수만, feat엔 나머지.
function splitRecord(r) {
  const feat = {
    id: r.id, cdtn: r.pbctCdtnNo, round: r.round || 0,
    usage: r.usage || '', usageM: r.usageM || '',
    apsl: r.apslAmt || 0, low: r.lowstAmt || 0,
    st: r.statCd, opbd: String(r.opbdDt || '').slice(0, 8),
    ...(r.car && r.car.year ? { carYr: r.car.year } : {}),
  };
  const win = { win: r.winAmt || 0, wr: r.winRate || 0, lr: r.lowstRate || 0, bd: r.bidderCnt || 0 };
  return { feat, win, key: `${r.id}_${r.pbctCdtnNo}` };
}

// 한 창×자산군을 페이지 끝까지 census 수집 → { feat[], winMap, calls, budgetHit }
// budget.take()가 false면 **호출하지 않고 즉시 멈춘다** — 사용자 화면 몫을 침범하지 않기 위해.
async function censusWindow(base, type, start, end, budget) {
  const feat = [], winMap = {}, pvct = [];
  let calls = 0, budgetHit = false, fetchFail = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (budget && !budget.take(1)) { budgetHit = true; break; }
    let d = null;
    try {
      d = await fetchJson(`${base}/.netlify/functions/onbid-bidresults?cltrTypeCd=${type}&numOfRows=1000&page=${page}&opbdDtStart=${start}&opbdDtEnd=${end}`);
    } catch (e) {
      // 실패는 '개찰 없음'과 다르다 — 여기서 빈 결과로 접으면 호출자가 빈 창을 저장하고
      // 커서를 전진시켜, 백필이 과거로만 가는 특성상 그 구간이 영영 비게 된다.
      fetchFail = e.message;
      break;
    }
    calls++;
    const batch = Array.isArray(d && d.results) ? d.results : [];
    for (const r of batch) {
      if (r.statCd === PVCT_ST) { pvct.push(splitRecord(r).feat); continue; } // 별도 축(위 주석)
      if (r.statCd !== '0010' && r.statCd !== '0011') continue;
      const s = splitRecord(r);
      feat.push(s.feat);
      winMap[s.key] = s.win;
    }
    if (batch.length < 1000) break; // 마지막 페이지
  }
  return { feat, winMap, pvct, calls, budgetHit, fetchFail };
}

exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  const store = await openLedger(event);
  const base = process.env.URL || '';

  try {
    let state = (await store.get('hist/_bfstate', { type: 'json' })) || null;
    let meta = (await store.get('hist/_bfmeta', { type: 'json' })) ||
      { records: 0, featRecords: 0, windows: 0, oldest: '', newest: BF_END, done: false, range: `${BF_START}~${BF_END}` };

    // 진행 상황만 조회 (수집 안 함)
    if (qs.status === '1') {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, state: state || { cursorEnd: BF_END }, meta }) };
    }
    if (qs.reset === '1' && qs.confirm === '1') { state = null; meta = { records: 0, featRecords: 0, windows: 0, oldest: '', newest: BF_END, done: false, range: `${BF_START}~${BF_END}` }; }
    if (!state) state = { cursorEnd: BF_END };
    let cursorEnd = state.cursorEnd;

    // 이미 목표 시작일까지 완료된 상태면 즉시 no-op (스케줄이 계속 불러도 무해)
    if (cursorEnd < BF_START) {
      meta.done = true;
      await store.setJSON('_run/collect-backfill', { at: new Date().toISOString(), ok: true, done: true, records: meta.records });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, done: true, meta, note: '백필 완료 — 더 수집할 창이 없습니다.' }) };
    }

    // 일일 API 예산('bulk' 티어) — 사용자 화면 몫을 남기고 남은 만큼만 수집한다.
    const budget = await quota.openBudget(store, { service: 'onbid', tier: 'bulk' });

    const t0 = Date.now();
    const didWindows = [];
    let totalCalls = 0, budgetStopped = false;
    let fetchStopped = null; // 상위 호출 실패로 창을 버리고 멈춘 사유 — 예산 소진과 구분해 기록한다
    while (cursorEnd >= BF_START) {
      const start = maxStr(addDays(cursorEnd, -(WINDOW_DAYS - 1)), BF_START);
      // 창 하나를 온전히 끝낼 여유가 없으면 아예 시작하지 않는다 — 반쪽 창을 저장하고
      // 커서를 넘기면 그 창의 나머지가 **영영 수집되지 않기 때문**(전수 보장 원칙).
      if (budget.remaining() < 3) { budgetStopped = true; break; }

      const pending = [];
      let winRows = 0, aborted = false;
      for (const type of ['0001', '0002', '0003']) {
        const { feat, winMap, pvct, calls, budgetHit, fetchFail } = await censusWindow(base, type, start, cursorEnd, budget);
        // 상위 실패 — 예산 소진과 똑같이 이 창을 통째로 버린다(저장·커서 전진 없음).
        if (fetchFail) { fetchStopped = fetchFail; aborted = true; break; }
        totalCalls += calls;
        if (budgetHit) { aborted = true; break; }   // 예산 소진 — 이 창은 통째로 버린다
        pending.push({ type, feat, winMap, pvct });
        winRows += Object.keys(winMap).length;
      }
      // 커서 미전진 → 다음 실행이 이 창부터 다시. 예산 소진과 상위 실패를 섞어 적지 않는다.
      if (aborted) { if (!fetchStopped) budgetStopped = true; break; }

      for (const p of pending) {
        // 물리 분리 저장 — feat(낙찰가 없음) / win(낙찰가만)
        await store.setJSON(`hist/feat/${start}_${cursorEnd}/${p.type}`, p.feat);
        await store.setJSON(`hist/win/${start}_${cursorEnd}/${p.type}`, p.winMap);
        // 수의계약가능은 비어 있으면 저장하지 않는다(자동차·동산은 1% 미만이라 대개 빈다).
        if (p.pvct && p.pvct.length) {
          await store.setJSON(`hist/pvct/${start}_${cursorEnd}/${p.type}`, p.pvct);
          meta.pvctRecords = (meta.pvctRecords || 0) + p.pvct.length;
        }
        meta.records += p.feat.length;
        meta.featRecords += p.feat.length;
      }
      meta.windows += 1;
      if (!meta.oldest || start < meta.oldest) meta.oldest = start;
      didWindows.push({ window: `${start}~${cursorEnd}`, winRows });
      cursorEnd = addDays(start, -1);
      // 창마다 커서 즉시 저장 — 중간에 죽어도 다음 실행이 이어받아 소실 0
      await store.setJSON('hist/_bfstate', { cursorEnd });
      await budget.flush();
      if (Date.now() - t0 > TIME_BUDGET_MS) break; // 시간 예산 소진 → 다음 실행으로
    }
    await budget.flush();

    const done = cursorEnd < BF_START;
    meta.done = done;
    meta.cursorEnd = cursorEnd;
    // range/newest는 meta가 처음 만들어질 때 한 번만 쓰여, 목표 구간을 넓혀도(2026→2025)
    // 옛 값이 그대로 남아 있었다 — scoreboard가 2025를 수집하는 중에도 "20260101~20260630"을
    // 보여주고 있었다. 매 실행 현재 목표로 덮어써 진행 상황이 거짓말하지 않게 한다.
    meta.range = `${BF_START}~${BF_END}`;
    meta.newest = BF_END;
    meta.updatedAt = new Date().toISOString();
    await store.setJSON('hist/_bfmeta', meta);
    await store.setJSON('_run/collect-backfill', { at: new Date().toISOString(), ok: true, done, records: meta.records, windowsThisRun: didWindows.length, quotaStopped: budgetStopped, ...(fetchStopped ? { fetchStopped } : {}) });

    // 수집이 끝나면(done) hist-stats 셀을 재빌드해 수집한 1~6월 통계를 즉시 반영 —
    // 라이브 챌린저(predb)가 hist/_cells를 읽으므로 이 rebuild로 "학습 즉시 반영"이 성립.
    // (완료 run에서 1회만 발화; 이후 스케줄은 상단 no-op으로 빠져 재발화 안 함. best-effort.)
    if (done) {
      try { await fetch(`${base}/.netlify/functions/hist-stats?rebuild=1`); } catch (_) { /* 재빌드 실패는 다음 조회 때 자동 재시도 */ }
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true, done, cursorEnd, calls: totalCalls,
        windowsThisRun: didWindows, meta,
        quota: budget.summary(),
        ...(fetchStopped ? { fetchStopped } : {}),
        note: done
          ? `백필 완료 — ${BF_START}~${BF_END} 전수 수집됨(총 ${meta.records.toLocaleString()}건).`
          : fetchStopped
            ? `상위 API 호출이 실패해 중단했습니다(${fetchStopped}) — 실패는 '개찰 없음'과 다르므로 빈 창을 저장하지 않았고 커서(${cursorEnd})도 그대로입니다.`
            : budgetStopped
            ? `오늘의 API 예산(사용자 화면 몫 제외 ${budget.limit}회)을 다 써서 중단했습니다 — 커서(${cursorEnd})는 그대로이며 내일 이어서 수집합니다.`
            : `진행 중 — 다음 실행은 ${cursorEnd} 이전 창부터 이어서 수집합니다.`,
      }),
    };
  } catch (e) {
    try { await store.setJSON('_run/collect-backfill', { at: new Date().toISOString(), ok: false, error: e.message }); } catch (_) { /* 무시 */ }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
