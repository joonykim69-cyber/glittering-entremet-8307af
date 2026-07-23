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
// 쿼터: 6개월 census ≈ 250콜(부동산 ~1000/일 → 창당 페이지 수), data.go.kr 일일 1000 내.

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const WINDOW_DAYS = 7;
const MAX_PAGES = 15;             // 창×자산군당 최대 페이지 (numOfRows=1000 census)
const TIME_BUDGET_MS = 22000;     // 30초 함수 한도 안전 예산
const BF_START = (process.env.HIST_BF_START || '20260101').replace(/[^0-9]/g, '');
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

// 한 창×자산군을 페이지 끝까지 census 수집 → { feat[], winMap, calls }
async function censusWindow(base, type, start, end) {
  const feat = [], winMap = {};
  let calls = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let d = null;
    try {
      d = await fetchJson(`${base}/.netlify/functions/onbid-bidresults?cltrTypeCd=${type}&numOfRows=1000&page=${page}&opbdDtStart=${start}&opbdDtEnd=${end}`);
    } catch (e) { break; }
    calls++;
    const batch = Array.isArray(d && d.results) ? d.results : [];
    for (const r of batch) {
      if (r.statCd !== '0010' && r.statCd !== '0011') continue;
      const s = splitRecord(r);
      feat.push(s.feat);
      winMap[s.key] = s.win;
    }
    if (batch.length < 1000) break; // 마지막 페이지
  }
  return { feat, winMap, calls };
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

    const t0 = Date.now();
    const didWindows = [];
    let totalCalls = 0;
    while (cursorEnd >= BF_START) {
      const start = maxStr(addDays(cursorEnd, -(WINDOW_DAYS - 1)), BF_START);
      let winRows = 0;
      for (const type of ['0001', '0002', '0003']) {
        const { feat, winMap, calls } = await censusWindow(base, type, start, cursorEnd);
        totalCalls += calls;
        // 물리 분리 저장 — feat(낙찰가 없음) / win(낙찰가만)
        await store.setJSON(`hist/feat/${start}_${cursorEnd}/${type}`, feat);
        await store.setJSON(`hist/win/${start}_${cursorEnd}/${type}`, winMap);
        meta.records += feat.length;
        meta.featRecords += feat.length;
        winRows += Object.keys(winMap).length;
      }
      meta.windows += 1;
      if (!meta.oldest || start < meta.oldest) meta.oldest = start;
      didWindows.push({ window: `${start}~${cursorEnd}`, winRows });
      cursorEnd = addDays(start, -1);
      // 창마다 커서 즉시 저장 — 중간에 죽어도 다음 실행이 이어받아 소실 0
      await store.setJSON('hist/_bfstate', { cursorEnd });
      if (Date.now() - t0 > TIME_BUDGET_MS) break; // 시간 예산 소진 → 다음 실행으로
    }

    const done = cursorEnd < BF_START;
    meta.done = done;
    meta.cursorEnd = cursorEnd;
    meta.updatedAt = new Date().toISOString();
    await store.setJSON('hist/_bfmeta', meta);
    await store.setJSON('_run/collect-backfill', { at: new Date().toISOString(), ok: true, done, records: meta.records, windowsThisRun: didWindows.length });

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
        note: done
          ? `백필 완료 — ${BF_START}~${BF_END} 전수 수집됨(총 ${meta.records.toLocaleString()}건).`
          : `진행 중 — 다음 실행은 ${cursorEnd} 이전 창부터 이어서 수집합니다.`,
      }),
    };
  } catch (e) {
    try { await store.setJSON('_run/collect-backfill', { at: new Date().toISOString(), ok: false, error: e.message }); } catch (_) { /* 무시 */ }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
