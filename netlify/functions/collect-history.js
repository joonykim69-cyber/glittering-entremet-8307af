// netlify/functions/collect-history.js
// 예측 엔진 0단계 — 과거 개찰 이력 "학습 데이터 수집기" (매일 KST 20:10 예약 + 수동 GET)
//
// 목적: 온비드 입찰결과목록(3자산군)의 과거 개찰 이력을 Blobs에 축적해
//   v0.5 다차원 통계 엔진(용도×유찰회차×가격대 분위수)과 "유사 사례 근거 제시"의
//   학습 데이터셋을 만든다. 개찰 이력은 소급 수집이 가능하므로 백필 방식:
//   오늘부터 7일 창(window) 단위로 과거로 거슬러 내려가며, 실행당 기본 6개 창
//   (약 42일치)씩 수집해 며칠에 걸쳐 1년치(HIST_TARGET_DAYS, 기본 365일)를 채운다.
//
// 저장 구조 (store 'ledger'):
//   hist/_state                     { cursorEnd: 'yyyymmdd' }  ← 다음 실행이 이어받을 창 끝 날짜
//   hist/{start}_{end}/{cltrTypeCd} 압축 레코드 배열 (낙찰 0010 + 유찰 0011만, 취소 제외)
//   hist/_meta                      { records, windows, oldest, newest, updatedAt }
//
// 레코드 필드(학습에 필요한 것만): id, cdtn, round(회차), usage/usageM(용도),
//   apsl(감정가 원), low(최저가 원), win(낙찰가 원), wr(감정가 대비 낙찰가율 %),
//   lr(최저가 대비 %), bd(유효 입찰자수), st(결과코드), opbd(개찰일 yyyymmdd),
//   car(차량이면 연식만)
//
// 쿼터: 이 API의 일일 트래픽 1000건. 실행당 최대 6창×3자산군×5페이지 = 90콜 이내이며,
//   **lib/quota.js 예산 가드('bulk' 티어)** 아래에서만 호출한다 — 사용자 화면 몫
//   (ONBID_LIVE_RESERVE)을 남기고, 예산이 떨어지면 커서를 남긴 채 깨끗하게 중단한다.
// 수동 실행: GET /.netlify/functions/collect-history  (?windows=N 으로 창 수 조절)
// 커서 리셋: ?reset=1&confirm=1 (처음부터 다시 수집 — 기존 창 데이터는 덮어씀)

const CORS = { 'Access-Control-Allow-Origin': '*' };
const quota = require('./lib/quota.js');
const WINDOW_DAYS = 7;
const MAX_PAGES = 5;      // 백필 창×자산군당 최대 페이지 (100행/페이지)
// ── 증분 경로 (2026-08-02 복구) ──
// 이 함수는 **하트비트도 hist/_meta도 한 번도 남기지 못한 채** 조용히 죽어 있었다.
// 조기 반환 경로가 없으므로 마지막 두 쓰기에 도달하기 전에 죽는다는 뜻이고, 원인은
// 자산군 3개 × 최대 5페이지를 **순차**로 도는 구조다 — 15번의 순차 HTTP가 우리 프록시를
// 거쳐 data.go.kr까지 갔다 오면 30초 함수 한도에 정확히 부딪힌다.
// (score-daily·predict-daily가 같은 이유로 502를 냈고 같은 방식으로 살아났다.)
//   ① 페이지 크기 100 → 1000: 부동산 7일치가 약 6,000건인데 100×5면 500건까지밖에 못 봤다.
//   ② 자산군 3개를 병렬로.
//   ③ 시간 예산을 두고 넘으면 그 자산군만 접는다 — **끝까지 못 갔어도 하트비트는 남긴다.**
const INC_ROWS = 1000;
const INC_PAGES = 12;         // 1000×12 (실측: 부동산 7일 창 8,711건 = 9페이지)
const INC_CONC = 4;           // 페이지 동시 조회 수
const INC_BUDGET_MS = 20000;  // 30초 함수에서 마지막 쓰기 몫으로 10초를 남긴다

// 한 자산군의 7일 창을 수집한다. **첫 페이지로 totalCount를 받아 필요한 페이지 수를 알아낸 뒤
// 나머지를 병렬로** 가져온다 — 페이지를 순차로 돌면 부동산 9페이지 × 3.2초 ≈ 29초로 벽을 넘는다.
// (실측 2026-08-02: 상위 호출 0.82~6.48초, 평균 3.2초 / 부동산 8,711건·자동차 220·동산 868)
async function collectIncOne(base, cltrTypeCd, start, end, budget, t0) {
  const rows = [], pvctRows = [];
  const url = (page) => `${base}/.netlify/functions/onbid-bidresults?cltrTypeCd=${cltrTypeCd}&numOfRows=${INC_ROWS}&page=${page}&opbdDtStart=${start}&opbdDtEnd=${end}`;
  const push = (batch) => {
    rows.push(...batch.filter(x => x.statCd === '0010' || x.statCd === '0011').map(toRecord));
    // 수의계약가능(0009)은 **별도 키**에 담는다 — 부동산 개찰의 18.7%가 이 상태인데 지금까지
    // 버려서 채널 자체를 측정할 수 없었다. hist/_inc(학습 표본)에 섞으면 셀 표본이 흔들린다.
    pvctRows.push(...batch.filter(x => x.statCd === '0009').map(toRecord));
  };
  const over = () => Date.now() - t0 > INC_BUDGET_MS;

  if (!budget.take(1)) return { cltrTypeCd, rows, pvctRows, partial: true, reason: 'quota' };
  let first;
  try { first = await fetchJson(url(1)); } catch (e) { return { cltrTypeCd, rows, pvctRows, partial: true, reason: 'fetch' }; }
  const batch1 = Array.isArray(first && first.results) ? first.results : [];
  push(batch1);
  const total = Number(first && first.totalCount) || batch1.length;
  const pages = Math.min(INC_PAGES, Math.max(1, Math.ceil(total / INC_ROWS)));
  if (pages <= 1) return { cltrTypeCd, rows, pvctRows, partial: false, pages: 1, total };

  // 남은 페이지를 병렬로(동시 INC_CONC). 하나라도 못 받으면 **반쪽이므로 덮어쓰지 않는다.**
  let partial = pages > INC_PAGES ? true : false;
  const nums = [];
  for (let i = 2; i <= pages; i++) nums.push(i);
  for (let i = 0; i < nums.length; i += INC_CONC) {
    if (over()) { partial = true; break; }
    const chunk = nums.slice(i, i + INC_CONC).filter(() => budget.take(1) || (partial = true, false));
    if (!chunk.length) break;
    const got = await Promise.all(chunk.map(async (pg) => {
      try { const d = await fetchJson(url(pg)); return Array.isArray(d && d.results) ? d.results : []; }
      catch (e) { partial = true; return null; }
    }));
    for (const b of got) { if (b === null) continue; push(b); }
  }
  return { cltrTypeCd, rows, pvctRows, partial, pages, total };
}
const DEFAULT_WINDOWS = 6;

function kst() { return new Date(Date.now() + 9 * 3600 * 1000); }
function ymd(d) { return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`; }
function addDays(yyyymmdd, n) {
  const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)));
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Lambda 호환 함수는 Blobs 자동 구성이 안 되므로 connectLambda로 수동 연결 (score-daily와 동일 패턴)
async function openLedger(event) {
  if (global.__FAKE_STORE__) return global.__FAKE_STORE__; // fixture 검증용(런타임 미사용)
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

// onbid-bidresults의 매핑 결과에서 학습에 필요한 필드만 압축
function toRecord(r) {
  return {
    id: r.id, cdtn: r.pbctCdtnNo, round: r.round || 0,
    usage: r.usage || '', usageM: r.usageM || '',
    apsl: r.apslAmt || 0, low: r.lowstAmt || 0, win: r.winAmt || 0,
    wr: r.winRate || 0, lr: r.lowstRate || 0, bd: r.bidderCnt || 0,
    st: r.statCd, opbd: String(r.opbdDt || '').slice(0, 8),
    ...(r.car && r.car.year ? { carYr: r.car.year } : {}),
  };
}

exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  const store = await openLedger(event);
  const base = process.env.URL || '';
  const targetDays = Number(process.env.HIST_TARGET_DAYS) || 365;
  const windowsPerRun = Math.min(Math.max(Number(qs.windows) || DEFAULT_WINDOWS, 1), 12);

  try {
    let state = (await store.get('hist/_state', { type: 'json' })) || null;
    if (qs.reset === '1' && qs.confirm === '1') state = null;
    if (!state) state = { cursorEnd: ymd(kst()) };

    const oldestTarget = addDays(ymd(kst()), -targetDays);
    const runWindows = [];
    let cursorEnd = state.cursorEnd;
    // 일일 API 예산('bulk' 티어) — 사용자 화면 몫을 침범하지 않는 선에서만 수집.
    const budget = await quota.openBudget(store, { service: 'onbid', tier: 'bulk' });
    let budgetStopped = false;
    let fetchStopped = null; // 상위 호출 실패로 창을 버리고 멈춘 사유(빈 창 저장·커서 전진 금지)

    // 백필이 끝난 뒤에는 최근 7일 창을 매일 다시 수집해 신규 개찰분을 증분 유지한다.
    // **고정 키(hist/_inc/{type})로 매일 덮어쓴다**(2026-07-27 하우스키핑 수정): 과거엔 창 키가 매일
    // 이동해(hist/{start}_{end}/{type}) 6일씩 겹치는 블롭이 무한 누적되고 meta.records가 팽창했다.
    // 고정 키 롤링이면 자산군당 블롭 1개만 유지되고 hist-stats가 id_cdtn 중복제거로 백필과 조인한다.
    let incRows = 0, incPvct = 0, incMs = 0, incTimeHit = false;
    const incSkipped = [];
    const backfillDone = cursorEnd <= oldestTarget;
    if (backfillDone) {
      const end = ymd(kst());
      const start = addDays(end, -(WINDOW_DAYS - 1));
      const t0 = Date.now();
      // 자산군 3개도 병렬 — 자동차·동산은 각 1페이지라 부동산과 같이 흐르면 사실상 공짜다.
      const parts = await Promise.all(['0001', '0002', '0003']
        .map(cd => collectIncOne(base, cd, start, end, budget, t0)));
      for (const p of parts) {
        if (p.reason === 'quota') budgetStopped = true;
        // 반쪽 수집분으로 기존 증분 스냅샷을 덮어쓰지 않는다 — 덮어쓰면 어제치까지 잃는다.
        if (p.partial) { incSkipped.push(p.cltrTypeCd); continue; }
        await store.setJSON(`hist/_inc/${p.cltrTypeCd}`, p.rows); // 고정 키 덮어쓰기(누적 아님)
        await store.setJSON(`hist/_incpvct/${p.cltrTypeCd}`, p.pvctRows); // 수의계약 관측(같은 규율)
        incRows += p.rows.length;
        incPvct += p.pvctRows.length;
        runWindows.push({ window: `_inc(${start}~${end})`, type: p.cltrTypeCd, rows: p.rows.length });
      }
      if (incSkipped.length) incTimeHit = true;
      incMs = Date.now() - t0;
    }

    for (let w = 0; !backfillDone && w < windowsPerRun; w++) {
      if (cursorEnd <= oldestTarget) break; // 목표 기간까지 백필 완료
      // 창 하나를 온전히 끝낼 여유가 없으면 시작하지 않는다 — 반쪽 창을 저장하고 커서를
      // 넘기면 그 창의 나머지가 영영 수집되지 않는다(전수 보장 원칙).
      if (budget.remaining() < 3) { budgetStopped = true; break; }
      const start = addDays(cursorEnd, -(WINDOW_DAYS - 1));
      const winStart = start < oldestTarget ? oldestTarget : start;

      const pending = [];
      let aborted = false;
      let failed = null; // 상위 호출 실패 — '개찰 없음'과 절대 같지 않다
      for (const cltrTypeCd of ['0001', '0002', '0003']) {
        const rows = [];
        for (let page = 1; page <= MAX_PAGES; page++) {
          if (!budget.take(1)) { aborted = true; break; }
          let d = null;
          try {
            d = await fetchJson(`${base}/.netlify/functions/onbid-bidresults?cltrTypeCd=${cltrTypeCd}&numOfRows=100&page=${page}&opbdDtStart=${winStart}&opbdDtEnd=${cursorEnd}`);
          } catch (e) {
            // 실패를 '데이터 없음'으로 접으면 빈 창을 저장하고 커서가 지나가 버린다.
            // 백필은 과거로만 가므로 그 구간은 **다시 오지 않는다**(2026-08-05 인증키 장애에서
            // 실제로 6창 42일치가 이렇게 비었다). collect-rtms와 같은 규율로 멈춘다.
            failed = e.message;
            break;
          }
          const batch = Array.isArray(d && d.results) ? d.results : [];
          // 낙찰(0010)·유찰(0011)만 학습 표본으로 저장 — 취소(0012) 등은 제외
          rows.push(...batch.filter(x => x.statCd === '0010' || x.statCd === '0011').map(toRecord));
          if (batch.length < 100) break;
        }
        if (aborted || failed) break;            // 예산 소진·상위 실패 — 이 창은 통째로 버린다
        pending.push({ cltrTypeCd, rows });
      }
      if (aborted) { budgetStopped = true; break; } // 커서 미전진 → 다음 실행이 이 창부터 다시
      // 실패도 같다 — 저장하지 않고, 커서를 전진시키지 않고, 이번 실행을 끝낸다.
      // 조용히 사라지지 않도록 실패 사유를 하트비트에 남긴다.
      if (failed) { fetchStopped = failed; break; }

      for (const p of pending) {
        await store.setJSON(`hist/${winStart}_${cursorEnd}/${p.cltrTypeCd}`, p.rows);
        runWindows.push({ window: `${winStart}~${cursorEnd}`, type: p.cltrTypeCd, rows: p.rows.length });
      }
      cursorEnd = addDays(winStart, -1);
    }

    await budget.flush();
    await store.setJSON('hist/_state', { cursorEnd });

    // 메타 갱신. 증분(고정 키 덮어쓰기)은 누적하지 않고 incRecords에 교체 기록(팽창 방지).
    // 과거 백필 창(비-증분, 새 창을 계속 만드는 경로)만 records에 누적.
    const meta = (await store.get('hist/_meta', { type: 'json' })) || { records: 0, windows: 0, oldest: '', newest: '' };
    const added = runWindows.reduce((s, w) => s + w.rows, 0); // 이번 실행 수집 건수(표시·하트비트용)
    if (backfillDone) {
      meta.incRecords = incRows; // 증분 롤링 스냅샷 최신 건수(누적 아님)
    } else {
      const backfillWins = runWindows.filter(w => !String(w.window).startsWith('_inc'));
      meta.records += backfillWins.reduce((s, w) => s + w.rows, 0);
      meta.windows += backfillWins.length;
      const starts = backfillWins.map(w => w.window.slice(0, 8));
      if (starts.length) {
        const oldest = starts.sort()[0];
        if (!meta.oldest || oldest < meta.oldest) meta.oldest = oldest;
      }
    }
    if (!meta.newest) meta.newest = state.cursorEnd;
    meta.updatedAt = new Date().toISOString();
    await store.setJSON('hist/_meta', meta);

    const doneBackfill = cursorEnd <= oldestTarget;
    // 하트비트 — 매 실행마다 마지막 성공 시각·수집건수·커서 기록(자가진단이 신선도로 죽음 감지).
    // **실행시간(incMs)을 함께 남긴다** — 이 함수는 시간 한도에 부딪혀 조용히 죽었는데,
    // 하트비트에 소요시간이 없으면 "다시 벽에 가까워지고 있다"를 아무도 못 본다.
    // incSkipped는 반쪽이라 덮어쓰지 않은 자산군이다(조용히 사라지는 스킵은 없다).
    await store.setJSON('_run/collect-history', {
      at: new Date().toISOString(), ok: true, added, windows: runWindows.length, cursorEnd,
      backfillComplete: doneBackfill, quotaStopped: budgetStopped,
      ...(fetchStopped ? { fetchStopped } : {}),
      incRows, incPvct, incMs, ...(incTimeHit ? { incTimeHit: true } : {}),
      ...(incSkipped.length ? { incSkipped } : {}),
    });
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        addedRecords: added,
        collected: runWindows,
        nextCursorEnd: cursorEnd,
        backfillComplete: doneBackfill,
        meta,
        quota: budget.summary(),
        ...(fetchStopped ? { fetchStopped } : {}),
        note: fetchStopped
          ? `상위 API 호출이 실패해 중단했습니다(${fetchStopped}) — 실패는 '개찰 없음'과 다르므로 빈 창을 저장하지 않았고 커서(${cursorEnd})도 그대로입니다. 원인 해소 후 다음 실행이 이 창부터 다시 수집합니다.`
          : budgetStopped
          ? `오늘의 API 예산(사용자 화면 몫 제외 ${budget.limit}회)을 다 써서 중단했습니다 — 커서(${cursorEnd})는 그대로이며 내일 이어서 수집합니다.`
          : doneBackfill
          ? `백필 완료 — 목표 ${targetDays}일치 수집됨. 이후 실행은 증분 유지용.`
          : `백필 진행 중 — 다음 실행은 ${cursorEnd} 이전 창부터 이어서 수집합니다.`,
      }),
    };
  } catch (e) {
    try { await store.setJSON('_run/collect-history', { at: new Date().toISOString(), ok: false, error: e.message }); } catch (_) { /* 하트비트 실패는 무시 */ }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: { message: e.message } }) };
  }
};
