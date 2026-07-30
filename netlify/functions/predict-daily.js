// netlify/functions/predict-daily.js
// 예측 장부 1단계 — "예측 봉인" 예약 함수 (매일 KST 07:00, netlify.toml schedule)
//
// 마감 임박(오늘~+2일) 물건을 전수 조회해 각 물건의 예상 낙찰가 구간 [lo, mid, hi]를
// 산출하고 Netlify Blobs에 기록한다. 이미 봉인된 예측은 절대 덮어쓰지 않는다 —
// "개찰 전에 기록했고 사후에 고치지 않았다"가 이 장부의 신뢰 근거다.
//
// 구간 산출(model v0.1 — 통계 기반 규칙):
//   앵커1 = 감정가 × (캠코 용도별 감정가 대비 낙찰가율 rto1)
//   앵커2 = 최저입찰가 × (캠코 최저가 대비 낙찰가율 rto2)
//   mid = 앵커 평균, 폭 w = 용도별 보정 계수(calib, 초기 ±18%) →
//   lo = max(최저입찰가, min(앵커)×(1-w)) , hi = max(앵커)×(1+w)
//   w는 score-daily가 구간 적중률 95% 목표로 자동 보정(calibration)한다.
//
// 수동 실행: GET /.netlify/functions/predict-daily (테스트·백필용, 동작 동일)

const { fromOnbid, selectItem, RESIDENTIAL } = require('./lib/curation');
const { lawdOf } = require('./lib/lawd');
const quota = require('./lib/quota.js');

const CORS = { 'Access-Control-Allow-Origin': '*' };
const MODEL_V = 'v0.1';
const DEFAULT_W = 0.18;
const CURATED_MAX = 24; // "오늘의 주목 물건" 저장 상한
// 결과 예보(낙찰 확률·입찰자 수)의 최소 표본. 낙찰가 셀 문턱(20)과 **별개**다 —
// 분모가 다르기 때문(가격은 낙찰 건만, 확률은 낙찰+유찰, 입찰자는 입찰자 수가 기록된 낙찰 건만).
const OUTCOME_MIN_N = 30; // 확률을 %로 말하려면 이 정도는 있어야 한다
const BIDDER_MIN_N = 20;
// 1회 실행 봉인 상한 — 함수 실행시간 보호용. 기존 800에서 상향(전수 봉인 보장, 2026-07-29).
// 상한에 걸리면 마감 임박 순으로 우선 봉인한다. 환경변수로 조정 가능(SEAL_CAP).
const SEAL_CAP = Math.max(100, Math.min(5000, parseInt(process.env.SEAL_CAP || '2500', 10) || 2500));

// 청크 병렬 — 수천 건의 Blob 조회/저장을 순차로 하면 실행시간 한도를 넘는다(score-daily 선례).
async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) out.push(...await Promise.all(items.slice(i, i + limit).map(fn)));
  return out;
}

// 공통 팩트(온비드) → 실측 이력 셀 백오프 조회 (L3→L0, 표본 20+). 큐레이션 컨텍스트용.
// 셀 키는 온비드 이력 기준 typeCd라 온비드 소스 전용 — 새 소스는 자기 셀 네임스페이스를 쓴다.
function cellFor(cellsData, f) {
  if (!cellsData || !cellsData.cells) return null;
  const typeCd = f.assetClass === '동산' ? '0003' : f.assetClass === '자동차' ? '0002' : '0001';
  const rbN = f.round > 0 ? f.round : (f.failCount + 1);
  const rb = rbN >= 4 ? '4+' : String(rbN);
  const tier = f.low < 10000 ? 'lt1' : f.low < 50000 ? 't1to5' : f.low < 100000 ? 't5to10' : 'gte10';
  for (const ck of [`L3|${typeCd}|${f.usage}|${rb}|${tier}`, `L2|${typeCd}|${f.usage}|${rb}`, `L1|${typeCd}|${f.usage}`, `L0|${typeCd}`]) {
    const cell = cellsData.cells[ck];
    if (cell && cell.n >= 20 && cell.lr) return cell;
  }
  return null;
}

// 물건 type → 캠코 통계 용도 분류(clsCdNm) — bidcast.html의 STAT_BUCKET과 동일 체계
const STAT_BUCKET = {
  '아파트': '아파트', '단독주택': '단독주택/다가구', '연립다세대': '연립주택/다세대/빌라',
  '오피스텔': '기타주거용건물', '토지': '토지', '농지임야': '임야',
  '상가': '근린생활시설', '사무실': '비주거용건물', '공장창고': '산업용및용도복합용건물등',
};

function kst() { return new Date(Date.now() + 9 * 3600 * 1000); }
// 봉인 시점 기준 마감까지 남은 일수(달력일). bidEnd는 yyyyMMddHHmm.
function leadDaysOf(bidEnd) {
  const b = String(bidEnd || '').slice(0, 8);
  if (!/^\d{8}$/.test(b)) return null;
  const end = Date.UTC(+b.slice(0, 4), +b.slice(4, 6) - 1, +b.slice(6, 8));
  const n = kst();
  const today = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
  return Math.max(0, Math.round((end - today) / 86400000));
}
function ymd(d) { return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`; }

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url.split('?')[0]}`);
  return r.json();
}

// 캠코 용도별 낙찰가율 통계 로드 (연→분기→전분기→전년 폴백)
async function loadUsgStats(base) {
  const now = kst();
  const y = now.getUTCFullYear(), q = Math.ceil((now.getUTCMonth() + 1) / 3);
  const tries = [String(y), `${y}-${q}`, ...(q > 1 ? [`${y}-${q - 1}`] : []), String(y - 1)];
  for (const perd of tries) {
    try {
      const d = await fetchJson(`${base}/.netlify/functions/onbid-svc?svc=stat_usg&statsTypeCd=0041&inqPerd=${encodeURIComponent(perd)}`);
      if (Array.isArray(d.items) && d.items.length) {
        const m = {};
        d.items.forEach(r => { m[String(r.clsCdNm || '').trim()] = r; });
        return { map: m, perd };
      }
    } catch (e) { /* 다음 기간 */ }
  }
  return null;
}

// Lambda 호환(exports.handler) 함수에서는 Blobs 환경이 자동 구성되지 않아
// connectLambda(event)로 요청 이벤트의 Blobs 컨텍스트를 수동 연결해야 한다.
// (MissingBlobsEnvironmentError 대응 — 2026-07-19 프로덕션 첫 실행에서 확인)
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

exports.handler = async (event) => {
  const store = await openLedger(event);
  const base = process.env.URL || '';
  const qs = (event && event.queryStringParameters) || {};

  try {
    const stats = await loadUsgStats(base);
    const calib = (await store.get('calib', { type: 'json' })) || { byUsage: {} };
    // v0.5 챌린저 준비 — collect-history가 만든 실측 이력 셀(hist/_cells).
    // 데이터가 없으면 null → 챌린저 봉인은 조용히 생략된다 (챔피언 v0.1만 봉인).
    const cellsData = (await store.get('hist/_cells', { type: 'json' })) || null;

    // 마감 임박 물건 수집: 부동산 + 동산 + 차량 (입찰기간 검색 창: 오늘~+2일)
    // 수집 상한(사용자 지정 2026-07-22): 부동산 700(일반 500 + 토지 200 — 토지는 온비드에서
    // 부동산 목록의 한 유형이라 같은 엔드포인트로 함께 수집) · 동산 50 · 차량 50.
    // ── 봉인 창 (2026-07-29 창업자 승인으로 +2일 → +14일 확대) ──
    // 표본은 늘지 않는다 — 모든 물건은 마감이 다가오며 이 창을 통과하고, 봉인은 물건당 1회
    // 멱등이기 때문이다. 넓히는 이유는 **사용자가 물건을 보는 시점에 예측이 있게** 하기 위해서다.
    // (D-10에 검색·큐레이션으로 들어온 사용자는 지금까지 AI 구간을 볼 수 없었다.)
    //
    // 대가는 정직하게 진다: 개찰에서 먼 시점의 예측은 더 어렵다(회차·최저가가 아직 바뀔 수 있다).
    // 그래서 봉인 레코드에 **leadDays**(봉인일 → 마감일 간격)를 함께 남겨, 채점 때
    // "D-1 예측과 D-14 예측 중 어느 쪽이 정확한가"를 분리해 볼 수 있게 한다.
    const SEAL_WINDOW_DAYS = Math.max(1, Math.min(60, parseInt(process.env.SEAL_WINDOW_DAYS || '14', 10) || 14));
    const start = ymd(kst());
    const end = ymd(new Date(kst().getTime() + SEAL_WINDOW_DAYS * 86400000));
    const q = `bidPrdYmdStart=${start}&bidPrdYmdEnd=${end}`;
    // ── 전수 봉인 보장: 마지막 페이지까지 수집 (2026-07-29) ──
    // 기존엔 자산군별 **단일 페이지**(부동산 700·동산 50·차량 50)만 조회해, 창 안에 물건이
    // 그보다 많은 날에는 초과분이 **영영 봉인되지 않았다**(다음 날엔 창이 이동하므로 재기회 없음).
    // 봉인은 물건당 1회(멱등)라 창을 넓혀도 표본이 늘지 않는다 — 실제 병목은 이 페이지 상한이었다.
    // score-daily 전수 채점 수정과 같은 패턴: numOfRows=1000, batch<1000이면 종료, 안전 상한 유지.
    const PAGE = 1000, MAX_PAGES = 5; // 자산군당 최대 5,000건(일일 쿼터 여유 내)
    // 봉인은 원장의 근간이라 예산으로 **막지 않는다**('critical' 티어) — 다만 사용량은 똑같이
    // 기록해, 대량 수집기(collect-*)가 남은 예산을 계산할 때 이 호출까지 반영되게 한다.
    const budget = await quota.openBudget(store, { service: 'onbid', tier: 'critical' });
    async function collectAll(fn) {
      const out = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        let d;
        budget.note(1);
        try { d = await fetchJson(`${base}/.netlify/functions/${fn}?numOfRows=${PAGE}&page=${page}&${q}`); }
        catch (e) { break; } // 한 자산군 실패는 전체를 막지 않는다
        const batch = Array.isArray(d && d.items) ? d.items : [];
        out.push(...batch);
        if (batch.length < PAGE) break; // 마지막 페이지
      }
      return out;
    }
    const settled = await Promise.allSettled([
      collectAll('onbid-search'),
      collectAll('onbid-mvast-search'),
      collectAll('onbid-vhcl-search'),
    ]);
    const items = [];
    settled.forEach(s => {
      if (s.status === 'fulfilled' && Array.isArray(s.value)) items.push(...s.value);
    });

    // noBasisB = 챌린저를 봉인하지 못한 건수(셀 없음 또는 L0뿐) — 스킵이 조용히 사라지지 않게 센다
    let sealed = 0, skipped = 0, noBasis = 0, sealedB = 0, noBasisB = 0;
    const predMap = {}; // key → {lo,mid,hi} : 이번 실행에서 봉인한 챔피언 예측(큐레이션 저평가 여력 판단용)
    const endLimit = end + '2359';
    const startLimit = start + '0000';
    // ── 창 필터는 **양쪽**을 본다 (2026-07-30 교정) ──
    // 이전엔 상한(`<= endLimit`)만 검사해 **마감이 이미 지난 물건이 그대로 통과**했다.
    // 평소엔 onbid-search를 창으로 질의하니 드러나지 않지만, 2차 방어선이 방어를 안 하고
    // 있었던 것이고 실제로 세 가지가 걸린다:
    //   ① 정렬이 bidEnd 오름차순이라 **지난 물건이 맨 앞으로 와 SEAL_CAP을 먼저 먹는다** —
    //      정작 임박한 물건이 밀려나고, 밀려난 물건은 다음 날 창이 이동해 영영 봉인되지 않는다.
    //   ② 개찰이 끝난 물건을 봉인하면 결과가 이미 공개됐을 수 있다 → **GR11(시점 정직성) 위반**.
    //      게다가 봉인은 불변이라 사후에 되돌릴 수도 없다.
    //   ③ 상위 API가 창 밖 행을 섞어 주면(회차별 행 반환 등 전례 있음) 그대로 새어 들어온다.
    // 날짜 단위로만 본다 — 시각까지 따지면 07:00 실행이 당일 마감 물건을 놓칠 수 있고,
    // 그건 정확히 우리가 막으려는 유실이다.
    // (검증: 시계를 +180일로 돌린 회귀 — 그때 지난 물건 2,370건이 전부 통과했다.)
    let expired = 0;
    const targets = items
      .filter(it => {
        if (!(it.min > 0) || !it.pbctCdtnNo) return false;
        if (!it.bidEnd) return true; // 마감 정보가 없으면 판정 불가 — 상위 질의 창을 신뢰
        const b = String(it.bidEnd);
        if (b < startLimit) { expired++; return false; }
        return b <= endLimit;
      })
      .sort((a, b) => String(a.bidEnd || '').localeCompare(String(b.bidEnd || '')))
      .slice(0, SEAL_CAP);

    // ── 기존 봉인 여부를 **청크 병렬로 선조회** (2026-07-29) ──
    // 상한을 올리면서 순차 await를 그대로 두면 실행시간을 넘겨 봉인이 통째로 실패한다
    // (score-daily가 같은 이유로 502를 냈던 선례). 조회/저장만 병렬화하고 **봉인 공식은 불변**.
    const existsMap = new Map();
    await mapLimit(targets, 40, async it => {
      const key = `pred/${it.id}_${it.pbctCdtnNo}`;
      try { existsMap.set(key, !!(await store.get(key))); } catch (e) { existsMap.set(key, true); } // 조회 실패 시 안전측(재봉인 안 함)
    });
    const writes = []; // {key, val} — 계산 후 한꺼번에 병렬 저장

    for (const it of targets) {
      const key = `pred/${it.id}_${it.pbctCdtnNo}`;
      const exists = existsMap.get(key);
      if (exists) { skipped++; continue; } // 봉인 불변 원칙

      const st = stats && (stats.map[STAT_BUCKET[it.type]] || stats.map['전체']);
      const anchors = [];
      if (st) {
        if (it.appr > 0 && Number(st.scfbAmtRto1) > 0) anchors.push(it.appr * Number(st.scfbAmtRto1) / 100);
        if (it.min > 0 && Number(st.scfbAmtRto2) > 0) anchors.push(it.min * Number(st.scfbAmtRto2) / 100);
      }
      if (!anchors.length) { noBasis++; continue; } // 통계 근거 없으면 예측하지 않는다 (정직성)

      // ── 실측 이력 셀 1회 조회 — 챔피언의 "결과 예보"(Q0·Q1)와 챌린저가 함께 쓴다 ──
      // 회차는 온비드 공매차수(pbctNsq, it.round) 실측 우선, 없을 때만 유찰수+1 근사.
      let cell = null, cellKey = '', cellRbN = 0, cellRoundReal = false;
      if (cellsData && cellsData.cells) {
        const typeCd = it.assetClass === '동산' ? '0003' : it.assetClass === '자동차' ? '0002' : '0001';
        const usage = String(it.usage || it.type || '기타').trim() || '기타';
        cellRoundReal = Number(it.round) > 0;
        cellRbN = cellRoundReal ? Number(it.round) : ((Number(it.fail) || 0) + 1);
        const rb = cellRbN >= 4 ? '4+' : String(cellRbN);
        const tier = it.min < 10000 ? 'lt1' : it.min < 50000 ? 't1to5' : it.min < 100000 ? 't5to10' : 'gte10';
        for (const ck of [`L3|${typeCd}|${usage}|${rb}|${tier}`, `L2|${typeCd}|${usage}|${rb}`, `L1|${typeCd}|${usage}`, `L0|${typeCd}`]) {
          const c = cellsData.cells[ck];
          if (c && c.n >= 20 && c.lr) { cell = c; cellKey = ck; break; }
        }
      }

      // ── 결과 예보: "이번 회차에 팔릴까"(soldProb) + "몇 명과 붙나"(bidders) ──
      // 낙찰가와 같은 규율로 **같은 순간에 봉인**하고 개찰 후 채점받는다.
      // 근거 셀이 없거나 표본이 모자라면 만들지 않는다(null → 화면도 비운다).
      const soldProb = (cell && cell.soldRate != null && (cell.outcomeN || 0) >= OUTCOME_MIN_N) ? cell.soldRate : null;
      const bidders = (cell && cell.bidders && (cell.bidN || 0) >= BIDDER_MIN_N)
        ? { lo: Math.max(1, Math.round(cell.bidders.p10)), mid: Math.round(cell.bidders.p50), hi: Math.round(cell.bidders.p90) }
        : null;
      if (bidders && bidders.hi <= bidders.lo) bidders.hi = bidders.lo + 1;

      const cal = calib.byUsage[it.type] || {};
      const w = cal.w || DEFAULT_W;
      // ── 중심 보정 계수 k (2026-07-30 신설) ──
      // 캠코 용도별 낙찰가율은 압류재산 부동산 기준이라, 그대로 동산·차량에 쓰면 앵커가
      // 체계적으로 낮게 잡힌다(실측: 최근 20건 중 19건이 "실제가 예측보다 높음", 평균 −39.5%).
      // 이때 필요한 것은 구간 확대가 아니라 **중심 이동**이다. score-daily가 채점 결과에서
      // 실제/예측 비율의 중앙값을 재어 k를 조정하고, 여기서 두 앵커에 함께 곱한다 —
      // 앵커에 곱하므로 mid·lo·hi가 같은 비율로 움직이고 **구간 폭은 넓어지지 않는다**(GR4).
      // k가 없으면 1(무보정)이라 기존 봉인 공식과 완전히 동일하다.
      const k = cal.k || 1;
      const anc = anchors.map(v => v * k);
      const mid = Math.round(anc.reduce((s, v) => s + v, 0) / anc.length);
      const lo = Math.round(Math.max(it.min, Math.min(...anc) * (1 - w)));
      let hi = Math.round(Math.max(...anc) * (1 + w));
      if (hi <= lo) hi = Math.round(lo * 1.05);

      writes.push({ key, val: {
        id: it.id, pbctCdtnNo: it.pbctCdtnNo, title: it.title, type: it.type,
        // 소스(시장) — 지금은 온비드 하나뿐이지만 봉인 시점에 남겨야 나중에 소스별로
        // 성적을 나눌 수 있다(자산군 분리와 같은 논리 — 섞으면 둘 다 오도한다).
        source: 'onbid',
        assetClass: it.assetClass || '부동산',
        appr: it.appr, min: it.min, // 만원
        lo, mid, hi,                // 만원
        w, k, statBucket: st ? String(st.clsCdNm).trim() : '',
        statPerd: stats ? stats.perd : '',
        round: Number(it.round) || 0, fail: Number(it.fail) || 0, // 공매차수·유찰수 실측(회차별 채점·분석용)
        bidEnd: it.bidEnd || '', modelV: MODEL_V,
        leadDays: leadDaysOf(it.bidEnd), // 봉인일 → 마감일 간격(일). 먼 예측일수록 어렵다는 걸 채점에서 분리해 본다.
        // 결과 예보(2026-07-29) — 근거 없으면 null. 있으면 채점 대상이다.
        soldProb, bidders,
        outcomeCell: (soldProb != null || bidders) ? cellKey : '',
        outcomeN: cell ? (cell.outcomeN || 0) : 0,
        bidN: cell ? (cell.bidN || 0) : 0,
        sealedAt: new Date().toISOString(),
      } });
      predMap[key] = { lo, mid, hi };
      sealed++;

      // ── v0.5 챌린저 봉인 (predb/*) — 같은 물건을 실측 이력 분위수로 병행 예측 ──
      // 셀 조회는 hist-stats와 동일한 백오프(L3→L0, 표본 20+).
      // 회차는 온비드 공매차수(pbctNsq, it.round) 실측을 우선 사용하고, 없을 때만 유찰수+1로 근사한다.
      //
      // ⚠️ L0(자산군만) 셀로는 **가격 구간을 봉인하지 않는다** (2026-07-30).
      //    실측 채점에서 L0의 평균 구간 폭이 334.8%로 L1(88.6%)·L3(93.5%)의 3.6배였다
      //    (scoreboard.challenger.byLevel). L0은 용도를 못 찾아 자산군 전체로 물러선 셀이라
      //    "중고 오븐"과 "폐기물 2,376점"이 한 칸에 섞인다 — 분위수가 벌어지는 게 당연하고,
      //    그렇게 넓힌 구간으로 맞히는 것은 헌장 GR4가 금지한 바로 그 방식이다. 근거가 그
      //    정도뿐이면 **예측하지 않는다**(GR6 — 근거 없으면 미산출).
      //    낙찰 확률·입찰자 수는 비율이라 폭 문제와 무관하므로 L0 셀에서도 계속 쓴다.
      if (cell && !cellKey.startsWith('L0|')) {
        const bLo = Math.round(it.min * cell.lr.p10 / 100);
        const bMid = Math.round(it.min * cell.lr.p50 / 100);
        let bHi = Math.round(it.min * cell.lr.p90 / 100);
        if (bHi <= bLo) bHi = Math.round(bLo * 1.05);
        writes.push({ key: `predb/${it.id}_${it.pbctCdtnNo}`, val: {
          id: it.id, pbctCdtnNo: it.pbctCdtnNo, type: it.type,
          lo: bLo, mid: bMid, hi: bHi, // 만원
          cellKey, cellN: cell.n, modelV: 'v0.5-cells',
          round: cellRbN, roundReal: cellRoundReal, // 회차(pbctNsq 실측 여부 — 근사면 false)
          sealedAt: new Date().toISOString(),
        } });
        sealedB++;
      } else {
        noBasisB++;
      }
    }

    // 계산이 끝난 봉인을 청크 병렬로 일괄 저장(공식·내용 불변, I/O만 배치화)
    await mapLimit(writes, 40, async w => { await store.setJSON(w.key, w.val); });

    // ── 큐레이션 패스 — "오늘의 주목 물건" (봉인 로직과 분리·소스 중립 엔진) ──
    // 같은 마감 임박 물건을 소스 중립 공통 팩트로 바꿔 기회 점수를 매기고 상위 N건을 저장한다.
    // 추가 온비드 호출 0(이미 가져온 items 재사용). 봉인 예측(predMap)·실측 셀(cellFor)을 근거로.
    // ── 시세 밴드 선적재 (2026-07-29) ──
    // 차익 트랙은 "시세 × 면적 − 예상 낙찰가"라 시세가 필요한데, 물건마다 market-est를 부르면
    // 수천 번의 외부 호출이 된다. mkt-seal-daily가 이미 **셀 단위로 봉인해 둔 밴드**를 읽으면
    // 외부 API 호출 0으로 끝난다(Blobs만 조회). 이번 달 봉인이 없으면 지난달로 한 번 물러난다.
    const bandMap = {};
    try {
      const ymNow = `${kst().getUTCFullYear()}${String(kst().getUTCMonth() + 1).padStart(2, '0')}`;
      const prev = new Date(Date.UTC(kst().getUTCFullYear(), kst().getUTCMonth() - 1, 1));
      const ymPrev = `${prev.getUTCFullYear()}${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
      const bl = await store.list({ prefix: 'mkt/seal/' });
      const bKeys = (bl && bl.blobs ? bl.blobs : []).map(b => b.key)
        .filter(k => k.endsWith(`/${ymNow}`) || k.endsWith(`/${ymPrev}`));
      await mapLimit(bKeys, 40, async k => {
        const m = k.match(/^mkt\/seal\/(\d+_[a-z]+)\/(\d{6})$/);
        if (!m) return;
        const v = await store.get(k, { type: 'json' });
        if (!v || !(v.lo > 0)) return;
        // 이번 달 봉인이 지난달보다 우선
        if (!bandMap[m[1]] || m[2] === ymNow) bandMap[m[1]] = v;
      });
    } catch (e) { /* 시세 밴드 없으면 차익 트랙만 비고 나머지는 정상 동작 */ }

    const curated = [];
    for (const it of targets) {
      const f = fromOnbid(it);
      const kind = RESIDENTIAL[f.type];
      const lawd = kind ? lawdOf(f.region) : '';
      const res = selectItem(f, {
        pred: predMap[`pred/${it.id}_${it.pbctCdtnNo}`] || null,
        band: (kind && lawd) ? (bandMap[`${lawd}_${kind}`] || null) : null,
        cell: cellFor(cellsData, f),
        nowKst: kst(),
      });
      if (!res) continue;
      const p = predMap[`pred/${it.id}_${it.pbctCdtnNo}`] || null;
      curated.push({
        id: f.id, cdtn: f.cdtn, title: it.title, type: f.type, assetClass: f.assetClass,
        source: f.source || 'onbid',
        region: f.region, apsl: f.apsl, low: f.low, area: f.area,
        failCount: f.failCount, round: f.round, bidEnd: f.bidEnd,
        photo: it.photo || '', track: res.track, score: res.score,
        reasons: res.reasons, flags: res.flags,
        ...(res.margin ? { margin: res.margin } : {}),
        ...(res.category ? { category: res.category } : {}),
        pred: p, // {lo,mid,hi,soldProb,bidders} 만원 (없으면 null)
      });
    }
    // 트랙별로 나눠 각자의 잣대로 정렬한다(한 점수로 줄 세우지 않는다).
    //   margin  차익률 높은 순 · demand 낙찰률 높은 순 · closing 마감 임박 순 · trust 마감 임박 순
    const byTrack = { margin: [], demand: [], closing: [], trust: [] };
    for (const c of curated) (byTrack[c.track] || byTrack.demand).push(c);
    const byEnd = (a, b) => String(a.bidEnd || '').localeCompare(String(b.bidEnd || ''));
    byTrack.margin.sort((a, b) => b.score - a.score);
    byTrack.demand.sort((a, b) => b.score - a.score || byEnd(a, b));
    byTrack.closing.sort(byEnd);
    byTrack.trust.sort(byEnd);
    const TRACK_MAX = 8; // 트랙당 저장 상한 (랜딩은 3건씩만 보여주고 나머지는 "더 보기")
    const tracks = {
      margin: byTrack.margin.slice(0, TRACK_MAX),
      demand: byTrack.demand.slice(0, TRACK_MAX),
      closing: byTrack.closing.slice(0, TRACK_MAX),
      trust: byTrack.trust.slice(0, TRACK_MAX),
    };
    const curatedTop = [...tracks.margin, ...tracks.demand, ...tracks.closing, ...tracks.trust].slice(0, CURATED_MAX);
    await store.setJSON('curated/latest', {
      at: new Date().toISOString(), window: { start, end }, v: 2,
      scanned: targets.length, scored: curated.length, count: curatedTop.length,
      bands: Object.keys(bandMap).length,
      tracks,
      items: curatedTop, // 하위호환 — 구형 클라이언트가 읽던 평면 목록
    });
    // 큐레이션 사후 채점(3단계)용 개별 픽 마커 — curated/latest는 매일 덮어써지므로,
    // "이 물건을 주목 물건으로 뽑았다"는 사실을 물건별로 보존해야 개찰 후 score-daily가
    // 조인해 채점할 수 있다. 같은 물건이 다음 날 재큐레이션되면 갱신(멱등). 추가 온비드 호출 0.
    await Promise.all(curatedTop.map(c => store.setJSON(`curated/pick/${c.id}_${c.cdtn}`, {
      score: c.score, track: c.track, source: c.source || 'onbid', assetClass: c.assetClass, type: c.type, region: c.region,
      apsl: c.apsl, low: c.low, reasons: (c.reasons || []).map(x => x.tag), at: new Date().toISOString(),
    })));

    // 챌린저 봉인이 처음 시작된 날을 모델 연혁(chronicle)에 1회 기록
    if (sealedB > 0) {
      const chronicle = (await store.get('chronicle', { type: 'json' })) || [];
      if (!chronicle.some(c => c.kind === 'model' && c.detail && c.detail.modelV === 'v0.5-cells')) {
        chronicle.push({
          kind: 'model', at: new Date().toISOString(),
          title: `챌린저 v0.5 봉인 시작 — 오늘 ${sealedB}건 병행 봉인`,
          detail: {
            modelV: 'v0.5-cells',
            formula: '구간 = 최저가 × 실측 이력 낙찰가율 분위수(p10/p50/p90), 셀 = 자산군×용도×회차×가격대(백오프 L3→L0, 표본 20건 이상)',
            note: '챔피언 v0.1과 같은 물건을 병행 봉인·채점하여 상대전적으로 승격을 판단한다.',
          },
        });
        await store.setJSON('chronicle', chronicle);
      }
    }

    // 일자별 봉인 카운트 (성적표의 "오늘 예측 N건 봉인" 표시용)
    const meta = (await store.get('meta', { type: 'json' })) || { sealDays: {} };
    const today = ymd(kst());
    meta.sealDays[today] = (meta.sealDays[today] || 0) + sealed;
    const days = Object.keys(meta.sealDays).sort();
    while (days.length > 60) delete meta.sealDays[days.shift()];
    meta.lastSealAt = new Date().toISOString();
    await store.setJSON('meta', meta);

    const summary = { ok: true, scanned: items.length, targets: targets.length, expired, sealed, sealedB, noBasisB, skipped, noBasis, curated: curatedTop.length, statPerd: stats ? stats.perd : null, ...(qs.debug ? { window: { start, end } } : {}) };
    // 하트비트 — 매 실행마다 마지막 성공 시각·처리건수 기록(자가진단이 신선도로 죽음 감지)
    await budget.flush();
    await store.setJSON('_run/predict-daily', { at: new Date().toISOString(), ok: true, sealed, sealedB, noBasisB, curated: curatedTop.length, targets: targets.length, expired, noBasis });
    console.log('[predict-daily]', JSON.stringify(summary));
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(summary) };
  } catch (e) {
    console.log('[predict-daily] 실패:', e.message);
    try { await store.setJSON('_run/predict-daily', { at: new Date().toISOString(), ok: false, error: e.message }); } catch (_) { /* 하트비트 실패는 무시 */ }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
