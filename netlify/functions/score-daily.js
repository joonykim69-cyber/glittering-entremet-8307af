// netlify/functions/score-daily.js
// 예측 장부 1단계 — "자동 채점" 예약 함수 (매일 KST 19:30, netlify.toml schedule)
//
// 최근 3일 개찰 결과(부동산·자동차·동산)를 조회해, 봉인된 예측(pred/*)과 대조한다.
//   - 구간 적중: lo ≤ 실제 낙찰가 ≤ hi
//   - 중앙값 오차: (mid - 낙찰가) / 낙찰가 — %와 원화 절대값 병기
//   - 가격대별(1억 미만/1~5억/5~10억/10억+) 분해 집계
// 채점 결과로 용도별 구간 폭 w를 보정한다(목표 적중률 95~98%). 2026-07-30 교정 후 규칙:
//   - **새로 채점한 물건이 있을 때만**, 그리고 **하루 한 번만** 발동한다.
//   - 판단 근거는 누적이 아니라 **용도별 최근 50건 창**(과거 실패가 영원히 w를 밀어 올리지 않게).
//   - 최근 창 적중률 >98% → w -0.005(최소 0.06) / <95% → w +0.01(최대 0.35)
//   - 단, **빗나감이 한쪽으로 70% 이상 쏠렸으면 폭을 넓히지 않는다** — 폭이 아니라 중심 문제이며,
//     이때 넓히는 것은 헌장 GR4(넓혀서 맞히기 금지) 위반이다.
//   - 그 경우 대신 **중심 보정 k**를 옮긴다: 실제/예측 비율의 중앙값만큼(과보정 방지로 제곱근
//     만큼만) 앵커를 이동. 앵커에 곱하므로 구간 폭은 그대로다. 상·하한 0.4~3.0, 데드밴드 ±10%.
//   보정·편향·중심 이동은 학습 로그(log)와 chronicle에 남는다 — "모델이 학습하는 모습"의 원천.
//
// 수동 실행: GET /.netlify/functions/score-daily
// 보정값 초기화(수동 전용): GET /.netlify/functions/score-daily?resetCalib=1&confirm=1

const CORS = { 'Access-Control-Allow-Origin': '*' };
const quota = require('./lib/quota.js');
const TARGET_LO = 0.95, TARGET_HI = 0.98;
// 보정 파라미터 (2026-07-30 교정 — 아래 보정 블록의 주석에 근거를 적어 두었다)
const W_MAX = 0.35;          // 구간 폭 상한
const RECENT_MAX = 50;       // 용도별 "최근 창" 길이 — 보정은 누적이 아니라 이 창으로 판단한다
const CALIB_MIN_N = 20;      // 창이 이만큼 차기 전에는 조정하지 않는다
const BIAS_SKEW_PCT = 70;    // 빗나감의 이 %가 한쪽이면 "폭 문제 아님(편향)"으로 본다
const BIAS_MIN_MISS = 10;    // 편향을 말하려면 빗나간 표본이 최소 이만큼은 있어야 한다
// 중심 보정(k) — 편향일 때 폭 대신 당기는 레버
const K_MIN = 0.4, K_MAX = 3.0;   // 폭주 방지 상·하한
const CENTER_DEADBAND = 0.10;     // 실제/예측 비율이 ±10% 안이면 잡음으로 보고 건드리지 않는다
// 보정 스키마·규칙 버전. 이 값이 저장된 것과 다르면 보정값을 1회 초기화한다(아래 참조).
const CALIB_V = 'v2-center';

function kst() { return new Date(Date.now() + 9 * 3600 * 1000); }
function ymd(d) { return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`; }

function tierOf(winManwon) {
  if (winManwon < 10000) return 'lt1'; // 1억 미만
  if (winManwon < 50000) return 't1to5';
  if (winManwon < 100000) return 't5to10';
  return 'gte10';
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
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

  // ── 보정값 초기화 (수동 전용 — 자동 실행 없음) ──
  // 위 버그로 부풀려진 w는 **증거가 아니라 산물**이다(채점 0건인 날에도 오른 값). 그렇다고
  // 코드가 임의로 되돌리면 그것도 사람 몰래 모델을 바꾸는 것이라, 창업자가 URL로 한 번
  // 눌러야 실행된다(헌장: 채택은 사람이 한다). 봉인된 예측은 건드리지 않는다 — 불변.
  //   GET /.netlify/functions/score-daily?resetCalib=1&confirm=1
  if (qs.resetCalib === '1') {
    if (qs.confirm !== '1') {
      return { statusCode: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, need: 'confirm=1', note: '용도별 구간 폭 w와 중심 보정 k를 기본값(0.18 / 1.0)으로 되돌립니다. 봉인된 예측은 변경되지 않습니다.' }) };
    }
    const before = (await store.get('calib', { type: 'json' })) || { byUsage: {} };
    await store.setJSON('calib', { v: CALIB_V, byUsage: {}, resetAt: new Date().toISOString(), resetFrom: before.byUsage || {} });
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, reset: true, from: before.byUsage || {} }) };
  }

  // ── 실행 겹침 방지 (2026-07-30) ──
  // 프로덕션 로그에서 이 함수가 **같은 날 20~30초 간격으로 두 번** 도는 것이 확인됐다
  // (07-28 10:31:06/10:31:28, 07-29 10:34:02/10:34:30 — Netlify가 마무리 직전 실패를
  // 재시도한 것으로 보인다). 그런데 저장 순서가 `agg` → `scored/*` 마커라, 두 실행이
  // 겹치면 이렇게 된다:
  //     A: agg₀ 읽음 → … → agg_A 저장 → 마커_A 저장
  //     B:        agg₀ 읽음(A 미저장 시점) → … → agg_B 저장  ← A의 집계를 덮어씀
  // **마커는 남고 집계만 사라진다.** 다음 실행은 마커를 보고 `already`로 건너뛰므로
  // 그 물건들의 채점은 영구 소실된다 — scoreboard `n`이 185일간 0으로 굳었던 그
  // 실패 양상과 정확히 같다(그때는 마커를 루프 중에 쓴 것이 원인이었다).
  //
  // Blobs에는 진짜 뮤텍스가 없으므로 완전한 상호배제는 불가능하다. 다만 관측된 간격이
  // 25초라 **check-and-set + 짧은 TTL**로 충분히 닫힌다. 함수가 타임아웃으로 죽으면
  // finally가 안 돌지만, 그때는 TTL이 알아서 풀어 준다(그게 맞는 동작이다 —
  // 죽은 실행이 잡은 락을 즉시 놓아 주면 재시도가 다시 겹친다).
  const LOCK_KEY = '_lock/score-daily';
  const LOCK_TTL_MS = 5 * 60 * 1000;
  const held = await store.get(LOCK_KEY, { type: 'json' }).catch(() => null);
  if (held && held.at && Date.now() - new Date(held.at).getTime() < LOCK_TTL_MS) {
    const body = { ok: true, skipped: 'locked', lockedAt: held.at,
      note: '다른 실행이 진행 중이라 건너뜁니다 — 겹쳐 돌면 집계를 서로 덮어씁니다.' };
    console.log('[score-daily]', JSON.stringify(body));
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  }
  await store.setJSON(LOCK_KEY, { at: new Date().toISOString() });

  try {
    // 최근 3일 개찰 결과 수집 — 전수 채점 보장: 자산군별로 마지막 페이지까지 수집한다.
    // (과거 버그: 자산군×2페이지=200건 상한이라, 개찰이 많은 3일 창에선 초과분이 영영 채점 안 돼
    //  "전수 채점" 문구와 어긋났다. numOfRows=1000으로 올려 대부분 자산군 1콜에 끝나고, batch<1000이면
    //  마지막 페이지로 종료. 자산군당 최대 6페이지(6000건) 안전 상한으로 실행시간 보호.)
    const start = ymd(new Date(kst().getTime() - 3 * 86400000));
    const end = ymd(kst());
    const MAX_PAGES = 6;
    const results = [];
    // 채점도 원장의 근간이라 예산으로 막지 않는다('critical') — 사용량만 기록해
    // 대량 수집기가 남은 예산을 계산할 때 반영되게 한다.
    const budget = await quota.openBudget(store, { service: 'onbid', tier: 'critical' });
    await Promise.all(['0001', '0002', '0003'].map(async cltrTypeCd => {
      for (let page = 1; page <= MAX_PAGES; page++) {
        let d = null;
        budget.note(1);
        try {
          d = await fetchJson(`${base}/.netlify/functions/onbid-bidresults?cltrTypeCd=${cltrTypeCd}&numOfRows=1000&page=${page}&opbdDtStart=${start}&opbdDtEnd=${end}`);
        } catch (e) { break; }
        const batch = Array.isArray(d && d.results) ? d.results : [];
        // 어느 자산군에서 온 결과인지 표시해 둔다 — 아래 진단(byType)의 근거.
        for (const b of batch) b._t = cltrTypeCd;
        results.push(...batch);
        if (batch.length < 1000) break; // 마지막 페이지
      }
    }));

    const agg = (await store.get('agg', { type: 'json' })) || {
      n: 0, hit: 0, sumAbsErrPct: 0,
      byTier: {}, byUsage: {}, daily: {},
      errBuckets: { le5: 0, le10: 0, le15: 0, le20: 0 }, byAsset: {}, // 랩 오차분포·자산군별 실측화
    };
    let calib = (await store.get('calib', { type: 'json' })) || { byUsage: {} };
    // v0.5 챌린저(predb/*) 비교 집계 — 챔피언과 같은 물건에서만 채점되므로 공정 비교가 된다
    const aggB = (await store.get('aggB', { type: 'json' })) || { n: 0, hit: 0, sumAbsErrPct: 0, headToHead: { n: 0, bWins: 0 } };
    // 관측 계측(2026-07-27): 챌린저 폭 원인 진단용 — 백오프 레벨별(L0~L3) 건수·적중·폭 누적 +
    // 회차 실측(pbctNsq) vs 근사(유찰+1) 비율. 폭 335% 진단의 "어느 레벨에서 오나"를 데이터로 노출.
    aggB.byLevel = aggB.byLevel || {};
    aggB.roundReal = aggB.roundReal || { real: 0, approx: 0 };
    // 모델 연혁 장부(chronicle) — "초기값 → 변경 → 결과"를 순차 기록하는 추가 전용 로그.
    // 봉인 장부처럼 과거 항목은 수정하지 않고 뒤에 붙이기만 한다.
    const chronicle = (await store.get('chronicle', { type: 'json' })) || [];
    if (chronicle.length === 0) {
      chronicle.push({
        kind: 'genesis', at: '2026-07-19T07:00:00+09:00',
        title: '모델 v0.1 가동 — 예측 봉인 시작',
        detail: {
          modelV: 'v0.1',
          formula: '앵커1 = 감정가 × 용도별 낙찰가율(rto1), 앵커2 = 최저가 × rto2, 중앙값 = 앵커 평균, 구간 = [낮은 앵커×(1-w) ~ 높은 앵커×(1+w)]',
          w0: 0.18, wRange: '0.06 ~ 0.35',
          wRule: '용도별 표본 20건 이상에서 적중률 95% 미만이면 w +0.01, 98% 초과면 w -0.005',
          statSrc: '캠코 압류재산 용도별 낙찰가율 공식 통계 (봉인 레코드에 기간 병기)',
          target: '구간 적중률 95~98% + 중앙값 오차 %·원화 병기',
          principle: '봉인 후 수정 불가 · 전수 채점 · 실측치만 공개',
        },
      });
    }

    // ── 1회 초기화 (2026-07-30 창업자 지시: "되돌려주세요") ──
    // 옛 규칙이 증거 없이 부풀린 w(기계장비 0.27·차량 0.24·기타동산 0.23)는 측정값이 아니라
    // 버그의 산물이므로 기본값에서 다시 시작한다. 코드가 제멋대로 모델을 바꾸는 것이 아니라
    // **사람이 지시한 1회 마이그레이션**이며, 버전 태그로 딱 한 번만 실행되고 되돌린 값은
    // resetFrom에 남겨 감사 추적이 가능하다. **봉인된 예측은 건드리지 않는다 — 불변.**
    if (calib.v !== CALIB_V) {
      const from = calib.byUsage || {};
      calib = { v: CALIB_V, byUsage: {}, resetAt: new Date().toISOString(), resetFrom: from,
        resetReason: '증거 없이 누적된 구간 폭을 기본값으로 되돌림 + 중심 보정(k) 도입 (창업자 지시)' };
      if (Object.keys(from).length) {
        chronicle.push({ kind: 'calib-reset', at: new Date().toISOString(),
          title: `보정값 초기화 — 구간 폭을 기본값(0.18)으로 되돌림`,
          detail: { from, reason: '이전 보정 규칙이 채점 없이도 매 실행 폭을 넓혀 온 것이 확인되어(2026-07-30), 그 산물을 버리고 다시 시작한다. 이제 편향일 때는 폭 대신 중심(k)을 옮긴다.' } });
      }
    }

    const log = (await store.get('log', { type: 'json' })) || [];
    const recent = (await store.get('recent', { type: 'json' })) || [];

    let graded = 0, noPred = 0, already = 0, noWin = 0;
    // ── 자산군별 채점 진단 (2026-07-30 신설) ──
    // 실측에서 채점 152건 중 부동산이 1건뿐이었다. 원인이 둘 중 무엇인지 데이터로 가른다:
    //   (a) 부동산 개찰 결과 자체가 적게 온다        → fetched가 작다
    //   (b) 결과는 오는데 봉인을 못 찾는다(조인 실패) → fetched는 큰데 noPred가 크다
    // (b)라면 유력한 원인은 목록 프록시의 회차 중복 제거다 — 온비드는 같은 물건을
    // 공매조건(회차)별 행으로 주는데 우리는 **첫 행만** 남긴다. 부동산은 유찰이 반복돼
    // 회차가 8개까지 가므로, 첫 행의 pbctCdtnNo가 실제 개찰 회차와 어긋날 수 있다.
    // 추측으로 고치지 않고 먼저 잰다.
    const byType = {};
    const bump = (t, k) => { const o = byType[t] = byType[t] || { fetched: 0, graded: 0, noPred: 0, already: 0, noWin: 0 }; o[k]++; };
    const today = ymd(kst());
    // scored/* 마커는 루프 중이 아니라 agg 저장과 "같은 마지막 배치"에서 기록한다.
    // (과거 버그: 루프 중 마커를 쓰고 마지막 agg 저장 전에 함수가 죽으면, 그 물건들은
    //  다음 실행에서 already 스킵되어 채점이 영구 소실됐다 → n이 0에 고정. 마커 기록을
    //  최종 배치로 미루면, 중간 실패 시 마커가 하나도 안 남아 다음 실행이 온전히 재처리한다.)
    const markers = [];

    // ── Blob 조회 병렬화(타임아웃 방지) ──
    // 개찰 결과별 scored/pred/predb를 청크 병렬로 선조회한 뒤 채점. 순차 조회(600건×3)는
    // Netlify 함수 실행시간 제한을 넘겨 502가 났음 — 읽기를 병렬화해 완주하도록 개선.
    const mapLimit = async (items, limit, fn) => {
      const out = [];
      for (let i = 0; i < items.length; i += limit) out.push(...await Promise.all(items.slice(i, i + limit).map(fn)));
      return out;
    };
    // 큐레이션 사후 채점(3단계): predict-daily가 남긴 curated/pick/* 를 같은 배치에서 조인해,
    // "주목 물건으로 뽑은 것이 개찰 후 어땠나"를 봉인 채점과 같은 멱등 마커(scored/*)로 1회 집계.
    const curatedAgg = (await store.get('curatedAgg', { type: 'json' })) || {
      n: 0, sold: 0, failed: 0, canceled: 0, sumWinRate: 0, bandHit: 0, byAsset: {},
    };
    const enriched = await mapLimit(results.filter(r => r.id && r.pbctCdtnNo), 40, async r => {
      const key = `${r.id}_${r.pbctCdtnNo}`;
      const [scored, pred, predB, pick] = await Promise.all([
        store.get(`scored/${key}`),
        store.get(`pred/${key}`, { type: 'json' }),
        store.get(`predb/${key}`, { type: 'json' }),
        store.get(`curated/pick/${key}`, { type: 'json' }),
      ]);
      return { r, key, scored: !!scored, pred, predB, pick };
    });

    // 큐레이션 픽의 개찰 결과를 1회 집계 (pred 유무와 무관하게 pick이 있으면 추적).
    // 봉인 채점과 같은 !scored 블록에서만 호출되므로 정확히 1회만 반영된다.
    const tallyCurated = (pick, r, bandHit) => {
      if (!pick) return;
      const asset = pick.assetClass || '부동산';
      curatedAgg.byAsset[asset] = curatedAgg.byAsset[asset] || { n: 0, sold: 0, sumWinRate: 0 };
      curatedAgg.n++; curatedAgg.byAsset[asset].n++;
      if (r.statCd === '0010' && r.winAmt > 0) {
        curatedAgg.sold++; curatedAgg.byAsset[asset].sold++;
        const apsl = Number(pick.apsl) || 0; // 만원
        if (apsl > 0) {
          const wr = (r.winAmt / 10000) / apsl; // 낙찰가율(낙찰가/감정가)
          curatedAgg.sumWinRate += wr; curatedAgg.byAsset[asset].sumWinRate += wr;
        }
        if (bandHit) curatedAgg.bandHit++;
      } else if (r.statCd === '0011') curatedAgg.failed++;
      else if (r.statCd === '0012') curatedAgg.canceled++;
    };

    // 실행 **내** 중복 제거 — scored/* 마커는 루프 시작 전에 한 번 읽으므로, 같은 물건이
    // 이번 응답에 두 번 들어오면 두 번 채점된다(마커는 아직 안 쓰였으니 걸러지지 않는다).
    // 자산군 필터가 있어 지금은 겹치지 않지만, 페이지 경계에서 상위 API가 같은 행을 다시
    // 주는 일은 실제로 있다(collect-history도 같은 이유로 소비 측 id_cdtn 중복 제거를 한다).
    // 겹치면 agg가 조용히 부풀고 사후에 알 방법이 없으므로 여기서 막는다.
    const seenInRun = new Set();

    // ── 결과 예보 채점 (2026-07-29) ──
    // "이번에 팔릴까"(확률)와 "몇 명과 붙나"(구간)는 낙찰가와 성격이 달라 따로 잰다.
    //  · 확률은 맞다/틀리다가 없다 → **보정(calibration)**으로 잰다: "70%라고 말한 물건들 중
    //    실제로 몇 %가 팔렸나". 10% 구간(decile) 버킷 + Brier score(낮을수록 좋음).
    //  · 확률은 낙찰(0010)·유찰(0011) 둘 다에서 해소된다. **취소(0012)는 제외** — 공매가
    //    열리지 않았으므로 "팔릴까"의 답이 아니다(넣으면 유찰로 오분류된다).
    //  · 입찰자 수는 낙찰된 경우에만 채점한다(유찰엔 유효 입찰자가 없다).
    const outAgg = agg.outcome = agg.outcome || { sold: { n: 0, sumBrier: 0, buckets: {} }, bidders: { n: 0, hit: 0, sumAbsErr: 0 } };
    const tallyOutcome = (pred, sold, bidderCnt) => {
      if (!pred) return;
      if (pred.soldProb != null) {
        const p = Math.max(0, Math.min(1, pred.soldProb / 100)), y = sold ? 1 : 0;
        outAgg.sold.n++;
        outAgg.sold.sumBrier += (p - y) * (p - y);
        const b = String(Math.min(9, Math.floor(p * 10))); // 0.0~0.1 → '0' … 0.9~1.0 → '9'
        const bk = outAgg.sold.buckets[b] = outAgg.sold.buckets[b] || { n: 0, sold: 0, sumP: 0 };
        bk.n++; if (y) bk.sold++; bk.sumP += p * 100;
      }
      if (sold && pred.bidders && bidderCnt > 0) {
        outAgg.bidders.n++;
        if (bidderCnt >= pred.bidders.lo && bidderCnt <= pred.bidders.hi) outAgg.bidders.hit++;
        outAgg.bidders.sumAbsErr += Math.abs(pred.bidders.mid - bidderCnt);
      }
    };

    for (const { r, key, scored, pred, predB, pick } of enriched) {
      if (scored) { already++; bump(r._t || '?', 'already'); continue; }
      if (seenInRun.has(key)) { already++; bump(r._t || '?', 'already'); continue; }
      seenInRun.add(key);
      const scoredKey = `scored/${key}`;

      if (r.statCd !== '0010' || !(r.winAmt > 0)) {
        // ⚠️ "낙찰(0010)인데 금액이 없다" = 상위 API의 낙찰금액 필드(scfbAmt)가 바뀌었거나
        //    비어 있다는 뜻이다. 마커를 쓰지 않고 넘어가므로 필드가 복구되면 다시 채점된다
        //    (영구 소실 없음 — 그 설계는 맞다). 다만 **세지 않으면 보이지 않는다**:
        //    graded만 0으로 떨어지고 이유는 어디에도 안 남는다. 이 프로젝트가 n:0으로
        //    185일을 보낸 것이 정확히 그런 침묵이었다. 그래서 이름을 붙여 노출한다.
        if (r.statCd === '0010') { noWin++; bump(r._t || '?', 'noWin'); }
        // 유찰은 다음 회차가 새 공매조건으로 다시 봉인되므로, 이 조건은 종결 처리
        if (r.statCd === '0011' || r.statCd === '0012') {
          if (r.statCd === '0011') tallyOutcome(pred, false, 0); // 유찰 = "안 팔림"으로 확률 해소(취소는 제외)
          tallyCurated(pick, r, false); // 주목 물건이 유찰/취소로 종결된 경우도 집계
          markers.push({ key: scoredKey, value: { outcome: r.statCd === '0011' ? 'fail' : 'cancel', at: new Date().toISOString() } });
        }
        continue;
      }
      if (!pred) { noPred++; bump(r._t || '?', 'noPred'); continue; }

      tallyOutcome(pred, true, Number(r.bidderCnt) || 0); // 낙찰 = "팔림" + 실제 유효 입찰자 수
      const winMan = Math.round(r.winAmt / 10000); // 원 → 만원 (pred와 단위 통일)
      const hit = winMan >= pred.lo && winMan <= pred.hi;
      const errPct = Math.round((pred.mid - winMan) / winMan * 1000) / 10;
      // 구간 폭(낙찰가 대비 %) — "넓게 질러서 맞히기" 방지: 적중률은 폭과 함께 봐야 한다 (승격 기준)
      const widthPct = Math.round((pred.hi - pred.lo) / winMan * 1000) / 10;
      const absErrMan = Math.abs(pred.mid - winMan);
      const tier = tierOf(winMan);
      const usage = pred.type || '기타';

      agg.n++; if (hit) agg.hit++;
      agg.sumAbsErrPct += Math.abs(errPct);
      agg.sumWidthPct = (agg.sumWidthPct || 0) + widthPct;
      agg.byTier[tier] = agg.byTier[tier] || { n: 0, hit: 0 };
      agg.byTier[tier].n++; if (hit) agg.byTier[tier].hit++;
      // 빗나갔다면 **어느 쪽으로** 빗나갔는지 함께 남긴다 — 보정의 핵심 입력.
      // 구간이 좁아서 놓친 것과 중심이 치우쳐서 놓친 것은 처방이 정반대다(폭 확대 vs 중심 이동).
      const missDir = hit ? 0 : (winMan > pred.hi ? 2 : 3); // 1=적중 2=우리가 낮게 봄 3=높게 봄
      const us = agg.byUsage[usage] = agg.byUsage[usage] || { n: 0, hit: 0 };
      us.n++; if (hit) us.hit++;
      // 최근 창(누적이 아니라) — 과거 실패가 영원히 남아 보정을 상한까지 밀어 올리는 것을 막는다
      us.recent = us.recent || [];
      us.recent.push(hit ? 1 : missDir);
      while (us.recent.length > RECENT_MAX) us.recent.shift();
      // 중심 보정의 입력 — 실제/예측 비율. 이 값의 중앙값이 1에서 얼마나 떨어져 있는지가
      // "중심이 얼마나 치우쳤는가"이고, 그 역수만큼 앵커를 옮기면 편향이 사라진다.
      us.recentR = us.recentR || [];
      if (pred.mid > 0) us.recentR.push(Math.round(winMan / pred.mid * 1000) / 1000);
      while (us.recentR.length > RECENT_MAX) us.recentR.shift();
      agg.daily[today] = agg.daily[today] || { n: 0, hit: 0 };
      agg.daily[today].n++; if (hit) agg.daily[today].hit++;
      // 랩 오차 분포(중앙값 오차 절대값의 누적 버킷) + 자산군별 적중률 실측화
      const aerr = Math.abs(errPct);
      agg.errBuckets = agg.errBuckets || { le5: 0, le10: 0, le15: 0, le20: 0 };
      if (aerr <= 5) agg.errBuckets.le5++;
      if (aerr <= 10) agg.errBuckets.le10++;
      if (aerr <= 15) agg.errBuckets.le15++;
      if (aerr <= 20) agg.errBuckets.le20++;
      // 예측 시점(leadDays)별 집계 — 봉인 창을 +2일에서 +14일로 넓혔으므로(2026-07-29),
      // "개찰 직전 예측"과 "2주 전 예측"이 한 숫자에 섞이면 성적의 의미가 흐려진다.
      // 먼 예측이 더 어려운 건 당연하니, 숨기지 말고 나눠서 보여준다(자산군 분리와 같은 논리).
      const ld = pred.leadDays;
      if (ld != null && ld >= 0) {
        const lb = ld <= 1 ? 'd0_1' : ld <= 3 ? 'd2_3' : ld <= 7 ? 'd4_7' : 'd8plus';
        agg.byLead = agg.byLead || {};
        const lc = agg.byLead[lb] = agg.byLead[lb] || { n: 0, hit: 0, sumAbsErrPct: 0 };
        lc.n++; if (hit) lc.hit++; lc.sumAbsErrPct += aerr;
      }

      // 자산군별 집계 — 적중률만이 아니라 **오차·구간폭까지** 함께 쌓는다(2026-07-29).
      // 전체 하나의 숫자(예: 48.6%)는 표본 구성이 자산군에 쏠리면 사용자를 오도한다:
      // 실제로 부동산은 오차 1~5%로 잘 맞는데 표본의 99%가 동산이라 전체가 나빠 보였다.
      // 자산군별로 나눠 보여주는 게 더 정직하면서 동시에 더 쓸모있다(헌장 Appendix C 2026-07-29).
      const asset = pred.assetClass || '부동산';
      agg.byAsset = agg.byAsset || {};
      // 소스(시장)별 성적 — 법원경매·신탁공매가 붙으면 이 분리가 필수가 된다.
      // 합치면 둘 다 오도하기 때문이다(자산군 분리와 같은 논리, 헌장 §14).
      const src = pred.source || 'onbid';
      agg.bySource = agg.bySource || {};
      const sb = agg.bySource[src] = agg.bySource[src] || { n: 0, hit: 0, sumAbsErrPct: 0 };
      sb.n++; if (hit) sb.hit++; sb.sumAbsErrPct += aerr;

      const ab = agg.byAsset[asset] = agg.byAsset[asset] || { n: 0, hit: 0 };
      ab.n++; if (hit) ab.hit++;
      ab.sumAbsErrPct = (ab.sumAbsErrPct || 0) + aerr;
      ab.sumWidthPct = (ab.sumWidthPct || 0) + widthPct;

      recent.unshift({
        id: r.id, title: pred.title || r.title || '', usage,
        win: winMan, lo: pred.lo, mid: pred.mid, hi: pred.hi,
        hit, errPct, absErrMan, tier, opbdDt: r.opbdDt || '', modelV: pred.modelV,
        scoredAt: new Date().toISOString(),
      });

      // ── v0.5 챌린저 채점 (있을 때만) — 같은 낙찰가로 구간 적중·오차를 병행 기록 (predB는 위에서 병렬 선조회) ──
      let bCmp = null;
      if (predB && predB.lo) {
        const bHit = winMan >= predB.lo && winMan <= predB.hi;
        const bErrPct = Math.round((predB.mid - winMan) / winMan * 1000) / 10;
        const bWidthPct = Math.round((predB.hi - predB.lo) / winMan * 1000) / 10;
        aggB.n++; if (bHit) aggB.hit++;
        aggB.sumAbsErrPct += Math.abs(bErrPct);
        aggB.sumWidthPct = (aggB.sumWidthPct || 0) + bWidthPct;
        aggB.headToHead.n++;
        if (Math.abs(bErrPct) <= Math.abs(errPct)) aggB.headToHead.bWins++;
        // 관측: 백오프 레벨별(폭 원인 진단) + 회차 실측/근사 비율
        const lvl = String(predB.cellKey || '').split('|')[0] || '?';
        const lc = aggB.byLevel[lvl] || (aggB.byLevel[lvl] = { n: 0, hit: 0, sumWidthPct: 0 });
        lc.n++; if (bHit) lc.hit++; lc.sumWidthPct += bWidthPct;
        if (predB.roundReal) aggB.roundReal.real++; else aggB.roundReal.approx++;
        bCmp = { hit: bHit, errPct: bErrPct, modelV: predB.modelV, cellKey: predB.cellKey };
      }

      tallyCurated(pick, r, hit); // 주목 물건이 낙찰로 종결 — 낙찰/낙찰가율/구간 적중 집계
      markers.push({ key: scoredKey, value: { outcome: 'graded', hit, errPct, ...(bCmp ? { b: bCmp } : {}), at: new Date().toISOString() } });
      graded++; bump(r._t || '?', 'graded');
    }

    // ── 보정(calibration): 최근 창의 적중률 + **빗나간 방향**으로 구간 폭 w 조정 ──
    //
    // ⚠️ 2026-07-30 교정 — 실측(scoreboard)에서 드러난 결함 넷을 함께 고쳤다.
    //   ① **증거 없이 발동했다** — 이 루프가 graded 가드 밖에 있어, 새로 채점한 물건이 0건인
    //      날에도 매 실행 w가 +0.01씩 올랐다(07-30 실측: graded:0인데 세 용도 전부 상승).
    //   ② **하루 두 번 발동했다** — 같은 날 20~30초 간격 재실행이 각각 한 번씩 올렸다
    //      (07-28 10:31:06 / 10:31:28, 07-29 10:34:02 / 10:34:30 — n·적중률이 동일한 중복 기록).
    //   ③ **누적 적중률로 판단했다** — 과거 실패가 영원히 남아 w를 상한 0.35까지 밀어 올린다.
    //   ④ 그리고 가장 중요한 것 — **빗나간 방향이 한쪽으로 쏠려도 넓히기만 했다.**
    //
    // ④가 핵심이다. 구간을 대칭으로 넓혀도 치우친 쪽 절반은 애초에 답이 없는 자리에 버려진다.
    // 실측 7일간 기계장비 w를 0.18→0.27로 50% 넓혔는데 적중률은 17.9%→33.3%에 그쳤고,
    // 차량은 오히려 70.4%→39.5%로 떨어졌다. 같은 시점 recent 20건 중 19건이 "실제가 예측보다
    // 높음"(평균 −39.5%) 한 방향이었다 — 폭 문제가 아니라 **중심의 계통 편향**이라는 뜻이다.
    // 이 상태에서 폭을 계속 넓히는 것은 헌장 Golden Rule 4(넓혀서 맞히기 금지)를 엔진이
    // 매일 자동으로 위반하는 것이다. 그래서 편향이 잡히면 **넓히지 않고 진단만 기록한다.**
    const calibDay = ymd(kst());
    if (graded > 0 && calib.lastDay !== calibDay) {
      calib.lastDay = calibDay;
      for (const [usage, s] of Object.entries(agg.byUsage)) {
        const win = s.recent || [];
        if (win.length < CALIB_MIN_N) continue; // 최근 창이 찰 때까지 조정하지 않는다
        const cnt = v => win.reduce((a, x) => a + (x === v ? 1 : 0), 0);
        const hits = cnt(1), over = cnt(2), under = cnt(3), misses = over + under;
        const rate = hits / win.length;
        const hitRatePct = Math.round(rate * 1000) / 10;
        const cur = calib.byUsage[usage] || { w: 0.18 };

        // 편향 판정 — 빗나감이 한쪽으로 쏠려 있으면 폭 문제가 아니다.
        // dir 'low' = 우리 예측이 실제보다 낮다(실제가 hi 위로 나감).
        const skewPct = misses ? Math.round(Math.max(over, under) / misses * 100) : 0;
        const biased = misses >= BIAS_MIN_MISS && skewPct >= BIAS_SKEW_PCT;
        const dir = over >= under ? 'low' : 'high';

        // ── 두 개의 레버, 진단에 맞는 것만 당긴다 ──
        //   편향(빗나감이 한쪽으로 쏠림) → **중심 이동(k)**. 폭은 그대로 둔다.
        //   대칭으로 빗나감(구간이 정말 좁음) → **폭 확대(w)**. 기존 레버.
        // 옛 구현은 레버가 하나뿐이라 편향에도 폭을 넓혔고, 그래서 7일을 넓히고도 못 맞혔다.
        let nextW = cur.w, nextK = cur.k || 1;
        let centerNote = null;

        if (rate > TARGET_HI) {
          nextW = Math.max(0.06, Math.round((cur.w - 0.005) * 1000) / 1000);
        } else if (rate < TARGET_LO) {
          if (biased) {
            // 실제/예측 비율의 중앙값 — 1.6이면 우리가 실제의 62%만 부른다는 뜻이다.
            const rs = (s.recentR || []).slice().sort((a, b) => a - b);
            const med = rs.length ? (rs.length % 2 ? rs[(rs.length - 1) / 2] : (rs[rs.length / 2 - 1] + rs[rs.length / 2]) / 2) : 1;
            // 한 번에 med만큼 다 옮기면 과보정으로 진동한다 → 제곱근만큼(절반) 옮긴다.
            // 데드밴드(±10%) 안이면 잡음이므로 건드리지 않는다. 상·하한으로 폭주도 막는다.
            if (rs.length >= CALIB_MIN_N && Math.abs(med - 1) >= CENTER_DEADBAND) {
              const cand = Math.round(Math.min(K_MAX, Math.max(K_MIN, nextK * Math.sqrt(med))) * 1000) / 1000;
              if (cand !== nextK) { centerNote = { from: nextK, to: cand, med }; nextK = cand; }
            }
          } else {
            nextW = Math.min(W_MAX, Math.round((cur.w + 0.01) * 1000) / 1000);
          }
        }

        const hadBias = !!(cur.bias && cur.bias.dir === dir);
        calib.byUsage[usage] = { w: nextW, k: nextK, n: win.length,
          ...(biased ? { bias: { dir, skewPct, misses, hitRate: hitRatePct, at: new Date().toISOString() } } : {}) };

        if (nextW !== cur.w) {
          log.unshift({ at: new Date().toISOString(), usage, from: cur.w, to: nextW, n: win.length, hitRate: hitRatePct });
          chronicle.push({
            kind: 'calib', at: new Date().toISOString(),
            title: `보정: ${usage} 구간 폭 ${cur.w} → ${nextW}`,
            detail: { usage, from: cur.w, to: nextW, basisN: win.length, hitRate: hitRatePct, window: `최근 ${win.length}건`,
              reason: rate < TARGET_LO ? `최근 ${win.length}건 적중률 ${hitRatePct}% < 목표 하한 95% · 빗나감이 양쪽으로 고름 → 구간 확대`
                                       : `최근 ${win.length}건 적중률 ${hitRatePct}% > 목표 상한 98% → 구간 축소` },
          });
        }
        if (centerNote) {
          // 폭이 아니라 중심을 옮겼다는 사실을 학습 로그에도 남긴다(같은 피드에 두 레버가 함께 보이게).
          log.unshift({ at: new Date().toISOString(), usage, kFrom: centerNote.from, kTo: centerNote.to,
            n: win.length, hitRate: hitRatePct, ratioMed: centerNote.med });
          chronicle.push({
            kind: 'center', at: new Date().toISOString(),
            title: `중심 보정: ${usage} ${centerNote.from} → ${centerNote.to}배 (${dir === 'low' ? '예측이 낮았음' : '예측이 높았음'})`,
            detail: { usage, from: centerNote.from, to: centerNote.to, ratioMed: centerNote.med,
              basisN: win.length, hitRate: hitRatePct, skewPct, misses,
              reason: `빗나감의 ${skewPct}%가 한쪽이라 폭이 아니라 중심을 옮긴다. 실제/예측 비율 중앙값 ${centerNote.med} → 과보정 방지를 위해 제곱근만큼만 이동.` },
          });
        } else if (biased && !hadBias) {
          // 편향은 잡았지만 데드밴드 안이거나 표본이 모자라 아직 옮기지 않은 경우 —
          // 넓히지 **않은** 이유를 남긴다(아무 일도 안 한 게 아니라 진단한 것이다).
          chronicle.push({
            kind: 'bias', at: new Date().toISOString(),
            title: `편향 진단: ${usage} — 빗나감의 ${skewPct}%가 ${dir === 'low' ? '예측보다 높은 쪽' : '예측보다 낮은 쪽'}`,
            detail: { usage, dir, skewPct, misses, basisN: win.length, hitRate: hitRatePct, w: cur.w, k: nextK,
              reason: '빗나감이 한쪽으로 쏠려 있어 구간 확대를 멈춘다 — 처방은 폭이 아니라 중심이다(GR4 넓혀서 맞히기 금지).' },
          });
        }
      }
    }

    // 보존 한도
    while (recent.length > 50) recent.pop();
    while (log.length > 50) log.pop();
    const dailyKeys = Object.keys(agg.daily).sort();
    while (dailyKeys.length > 90) delete agg.daily[dailyKeys.shift()];
    agg.updatedAt = new Date().toISOString();

    if (graded > 0) {
      chronicle.push({
        kind: 'daily', at: new Date().toISOString(),
        title: `채점 ${graded}건 — 누적 적중률 ${agg.n ? Math.round(agg.hit / agg.n * 1000) / 10 : 0}%`,
        detail: {
          gradedToday: graded, cumN: agg.n, cumHit: agg.hit,
          cumHitRate: agg.n ? Math.round(agg.hit / agg.n * 1000) / 10 : 0,
          cumAvgAbsErrPct: agg.n ? Math.round(agg.sumAbsErrPct / agg.n * 10) / 10 : 0,
          ...(aggB.n ? { challenger: { cumN: aggB.n, cumHitRate: Math.round(aggB.hit / aggB.n * 1000) / 10, headToHead: aggB.headToHead } } : {}),
        },
      });
    }
    while (chronicle.length > 500) chronicle.splice(1, 1); // genesis(0번)는 보존

    aggB.updatedAt = new Date().toISOString();
    curatedAgg.updatedAt = new Date().toISOString();
    // 집계를 먼저 저장(채점 결과의 실체) → 그 다음 scored/* 마커를 배치로 기록.
    // 이 순서라야 마커가 남았다는 것이 "그 물건은 이미 agg에 반영됐다"를 보장한다.
    // curatedAgg도 같은 배치에 포함 — 큐레이션 집계와 봉인 채점이 원자적으로 함께 커밋된다.
    await Promise.all([
      store.setJSON('chronicle', chronicle),
      store.setJSON('agg', agg),
      store.setJSON('aggB', aggB),
      store.setJSON('calib', calib),
      store.setJSON('log', log),
      store.setJSON('recent', recent),
      store.setJSON('curatedAgg', curatedAgg),
    ]);
    await mapLimit(markers, 40, m => store.setJSON(m.key, m.value));

    for (const r of results) bump(r._t || '?', 'fetched');
    const summary = { ok: true, fetched: results.length, graded, already, noPred, noWin, byType, totals: { n: agg.n, hit: agg.hit }, challenger: { n: aggB.n, hit: aggB.hit, headToHead: aggB.headToHead } };
    // 하트비트 — 매 실행마다 마지막 성공 시각·채점건수 기록(자가진단이 신선도로 죽음 감지)
    await budget.flush();
    await store.setJSON('_run/score-daily', { at: new Date().toISOString(), ok: true, graded, fetched: results.length, n: agg.n, noWin, byType });
    console.log('[score-daily]', JSON.stringify(summary));
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(summary) };
  } catch (e) {
    console.log('[score-daily] 실패:', e.message);
    try { await store.setJSON('_run/score-daily', { at: new Date().toISOString(), ok: false, error: e.message }); } catch (_) { /* 하트비트 실패는 무시 */ }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  } finally {
    // 정상·예외 모두 놓아 준다. 이 함수는 마지막 배치에서만 쓰므로 중간에 죽었다면
    // 아무것도 저장되지 않았고, 곧바로 재시도해도 안전하다.
    try { await store.setJSON(LOCK_KEY, { at: null, releasedAt: new Date().toISOString() }); } catch (_) { /* TTL이 처리 */ }
  }
};
