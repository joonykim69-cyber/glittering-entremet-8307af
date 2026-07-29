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
const MAX_PAGES = 5;      // 창×자산군당 최대 페이지 (100행/페이지)
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

    // 백필이 끝난 뒤에는 최근 7일 창을 매일 다시 수집해 신규 개찰분을 증분 유지한다.
    // **고정 키(hist/_inc/{type})로 매일 덮어쓴다**(2026-07-27 하우스키핑 수정): 과거엔 창 키가 매일
    // 이동해(hist/{start}_{end}/{type}) 6일씩 겹치는 블롭이 무한 누적되고 meta.records가 팽창했다.
    // 고정 키 롤링이면 자산군당 블롭 1개만 유지되고 hist-stats가 id_cdtn 중복제거로 백필과 조인한다.
    let incRows = 0;
    const backfillDone = cursorEnd <= oldestTarget;
    if (backfillDone) {
      const end = ymd(kst());
      const start = addDays(end, -(WINDOW_DAYS - 1));
      for (const cltrTypeCd of ['0001', '0002', '0003']) {
        const rows = [];
        let partial = false;
        for (let page = 1; page <= MAX_PAGES; page++) {
          if (!budget.take(1)) { partial = true; budgetStopped = true; break; }
          let d = null;
          try {
            d = await fetchJson(`${base}/.netlify/functions/onbid-bidresults?cltrTypeCd=${cltrTypeCd}&numOfRows=100&page=${page}&opbdDtStart=${start}&opbdDtEnd=${end}`);
          } catch (e) { break; }
          const batch = Array.isArray(d && d.results) ? d.results : [];
          rows.push(...batch.filter(x => x.statCd === '0010' || x.statCd === '0011').map(toRecord));
          if (batch.length < 100) break;
        }
        // 반쪽 수집분으로 기존 증분 스냅샷을 덮어쓰지 않는다 — 덮어쓰면 어제치까지 잃는다.
        if (partial) break;
        await store.setJSON(`hist/_inc/${cltrTypeCd}`, rows); // 고정 키 덮어쓰기(누적 아님)
        incRows += rows.length;
        runWindows.push({ window: `_inc(${start}~${end})`, type: cltrTypeCd, rows: rows.length });
      }
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
      for (const cltrTypeCd of ['0001', '0002', '0003']) {
        const rows = [];
        for (let page = 1; page <= MAX_PAGES; page++) {
          if (!budget.take(1)) { aborted = true; break; }
          let d = null;
          try {
            d = await fetchJson(`${base}/.netlify/functions/onbid-bidresults?cltrTypeCd=${cltrTypeCd}&numOfRows=100&page=${page}&opbdDtStart=${winStart}&opbdDtEnd=${cursorEnd}`);
          } catch (e) { break; }
          const batch = Array.isArray(d && d.results) ? d.results : [];
          // 낙찰(0010)·유찰(0011)만 학습 표본으로 저장 — 취소(0012) 등은 제외
          rows.push(...batch.filter(x => x.statCd === '0010' || x.statCd === '0011').map(toRecord));
          if (batch.length < 100) break;
        }
        if (aborted) break;                      // 예산 소진 — 이 창은 통째로 버린다
        pending.push({ cltrTypeCd, rows });
      }
      if (aborted) { budgetStopped = true; break; } // 커서 미전진 → 다음 실행이 이 창부터 다시

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
    // 하트비트 — 매 실행마다 마지막 성공 시각·수집건수·커서 기록(자가진단이 신선도로 죽음 감지)
    await store.setJSON('_run/collect-history', { at: new Date().toISOString(), ok: true, added, windows: runWindows.length, cursorEnd, backfillComplete: doneBackfill, quotaStopped: budgetStopped });
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
        note: budgetStopped
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
