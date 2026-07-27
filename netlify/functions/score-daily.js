// netlify/functions/score-daily.js
// 예측 장부 1단계 — "자동 채점" 예약 함수 (매일 KST 19:30, netlify.toml schedule)
//
// 최근 3일 개찰 결과(부동산·자동차·동산)를 조회해, 봉인된 예측(pred/*)과 대조한다.
//   - 구간 적중: lo ≤ 실제 낙찰가 ≤ hi
//   - 중앙값 오차: (mid - 낙찰가) / 낙찰가 — %와 원화 절대값 병기
//   - 가격대별(1억 미만/1~5억/5~10억/10억+) 분해 집계
// 채점 결과로 용도별 구간 폭 w를 보정한다(목표 적중률 95~98%):
//   표본 20건 이상에서 적중률 <95% → w +0.01 (최대 0.35) / >98% → w -0.005 (최소 0.06)
//   보정이 일어나면 학습 로그(log)에 기록 — 랜딩의 "모델이 학습하는 모습"의 원천.
//
// 수동 실행: GET /.netlify/functions/score-daily

const CORS = { 'Access-Control-Allow-Origin': '*' };
const TARGET_LO = 0.95, TARGET_HI = 0.98;

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

  try {
    // 최근 3일 개찰 결과 수집 — 전수 채점 보장: 자산군별로 마지막 페이지까지 수집한다.
    // (과거 버그: 자산군×2페이지=200건 상한이라, 개찰이 많은 3일 창에선 초과분이 영영 채점 안 돼
    //  "전수 채점" 문구와 어긋났다. numOfRows=1000으로 올려 대부분 자산군 1콜에 끝나고, batch<1000이면
    //  마지막 페이지로 종료. 자산군당 최대 6페이지(6000건) 안전 상한으로 실행시간 보호.)
    const start = ymd(new Date(kst().getTime() - 3 * 86400000));
    const end = ymd(kst());
    const MAX_PAGES = 6;
    const results = [];
    await Promise.all(['0001', '0002', '0003'].map(async cltrTypeCd => {
      for (let page = 1; page <= MAX_PAGES; page++) {
        let d = null;
        try {
          d = await fetchJson(`${base}/.netlify/functions/onbid-bidresults?cltrTypeCd=${cltrTypeCd}&numOfRows=1000&page=${page}&opbdDtStart=${start}&opbdDtEnd=${end}`);
        } catch (e) { break; }
        const batch = Array.isArray(d && d.results) ? d.results : [];
        results.push(...batch);
        if (batch.length < 1000) break; // 마지막 페이지
      }
    }));

    const agg = (await store.get('agg', { type: 'json' })) || {
      n: 0, hit: 0, sumAbsErrPct: 0,
      byTier: {}, byUsage: {}, daily: {},
      errBuckets: { le5: 0, le10: 0, le15: 0, le20: 0 }, byAsset: {}, // 랩 오차분포·자산군별 실측화
    };
    const calib = (await store.get('calib', { type: 'json' })) || { byUsage: {} };
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
    const log = (await store.get('log', { type: 'json' })) || [];
    const recent = (await store.get('recent', { type: 'json' })) || [];

    let graded = 0, noPred = 0, already = 0;
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

    for (const { r, key, scored, pred, predB, pick } of enriched) {
      if (scored) { already++; continue; }
      const scoredKey = `scored/${key}`;

      if (r.statCd !== '0010' || !(r.winAmt > 0)) {
        // 유찰은 다음 회차가 새 공매조건으로 다시 봉인되므로, 이 조건은 종결 처리
        if (r.statCd === '0011' || r.statCd === '0012') {
          tallyCurated(pick, r, false); // 주목 물건이 유찰/취소로 종결된 경우도 집계
          markers.push({ key: scoredKey, value: { outcome: r.statCd === '0011' ? 'fail' : 'cancel', at: new Date().toISOString() } });
        }
        continue;
      }
      if (!pred) { noPred++; continue; }

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
      agg.byUsage[usage] = agg.byUsage[usage] || { n: 0, hit: 0 };
      agg.byUsage[usage].n++; if (hit) agg.byUsage[usage].hit++;
      agg.daily[today] = agg.daily[today] || { n: 0, hit: 0 };
      agg.daily[today].n++; if (hit) agg.daily[today].hit++;
      // 랩 오차 분포(중앙값 오차 절대값의 누적 버킷) + 자산군별 적중률 실측화
      const aerr = Math.abs(errPct);
      agg.errBuckets = agg.errBuckets || { le5: 0, le10: 0, le15: 0, le20: 0 };
      if (aerr <= 5) agg.errBuckets.le5++;
      if (aerr <= 10) agg.errBuckets.le10++;
      if (aerr <= 15) agg.errBuckets.le15++;
      if (aerr <= 20) agg.errBuckets.le20++;
      const asset = pred.assetClass || '부동산';
      agg.byAsset = agg.byAsset || {};
      agg.byAsset[asset] = agg.byAsset[asset] || { n: 0, hit: 0 };
      agg.byAsset[asset].n++; if (hit) agg.byAsset[asset].hit++;

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
      graded++;
    }

    // ── 보정(calibration): 용도별 적중률로 구간 폭 w 조정 ──
    for (const [usage, s] of Object.entries(agg.byUsage)) {
      if (s.n < 20) continue;
      const rate = s.hit / s.n;
      const cur = calib.byUsage[usage] || { w: 0.18 };
      let next = cur.w;
      if (rate < TARGET_LO) next = Math.min(0.35, Math.round((cur.w + 0.01) * 1000) / 1000);
      else if (rate > TARGET_HI) next = Math.max(0.06, Math.round((cur.w - 0.005) * 1000) / 1000);
      if (next !== cur.w) {
        const hitRatePct = Math.round(rate * 1000) / 10;
        log.unshift({ at: new Date().toISOString(), usage, from: cur.w, to: next, n: s.n, hitRate: hitRatePct });
        calib.byUsage[usage] = { w: next, n: s.n };
        chronicle.push({
          kind: 'calib', at: new Date().toISOString(),
          title: `보정: ${usage} 구간 폭 ${cur.w} → ${next}`,
          detail: { usage, from: cur.w, to: next, basisN: s.n, hitRate: hitRatePct,
            reason: hitRatePct < 95 ? `적중률 ${hitRatePct}% < 목표 하한 95% → 구간 확대` : `적중률 ${hitRatePct}% > 목표 상한 98% → 구간 축소` },
        });
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

    const summary = { ok: true, fetched: results.length, graded, already, noPred, totals: { n: agg.n, hit: agg.hit }, challenger: { n: aggB.n, hit: aggB.hit, headToHead: aggB.headToHead } };
    // 하트비트 — 매 실행마다 마지막 성공 시각·채점건수 기록(자가진단이 신선도로 죽음 감지)
    await store.setJSON('_run/score-daily', { at: new Date().toISOString(), ok: true, graded, fetched: results.length, n: agg.n });
    console.log('[score-daily]', JSON.stringify(summary));
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(summary) };
  } catch (e) {
    console.log('[score-daily] 실패:', e.message);
    try { await store.setJSON('_run/score-daily', { at: new Date().toISOString(), ok: false, error: e.message }); } catch (_) { /* 하트비트 실패는 무시 */ }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
