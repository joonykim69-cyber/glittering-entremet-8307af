// netlify/functions/scoreboard.js
// 예측 장부 성적표 API — 랜딩·랩 페이지의 "살아있는 성적표" 데이터 공급.
// 집계(agg)·보정 계수(calib)·학습 로그(log)·최근 채점 사례(recent)·봉인 카운트(meta)를
// 한 번에 반환한다. 모두 predict-daily/score-daily가 쌓은 실측 데이터 — 예시 없음.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const quota = require('./lib/quota.js');

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
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: { message: 'Method not allowed' } }) };
  }

  try {
    const store = await openLedger(event);
    const qs = event.queryStringParameters || {};
    // 봉인 예측 단건 조회 — 나 vs AI 채점에서 사용 (봉인본 그대로 반환, 수정 불가)
    if (qs.pred) {
      const key = 'pred/' + String(qs.pred).replace(/[^0-9A-Za-z\-_]/g, '');
      const pred = await store.get(key, { type: 'json' });
      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
        body: JSON.stringify({ pred: pred || null }),
      };
    }
    const chronicleStored = await store.get('chronicle', { type: 'json' });
    const [agg, calib, log, recent, meta, aggB, runPredict, runScore, runCollect] = await Promise.all([
      store.get('agg', { type: 'json' }),
      store.get('calib', { type: 'json' }),
      store.get('log', { type: 'json' }),
      store.get('recent', { type: 'json' }),
      store.get('meta', { type: 'json' }),
      store.get('aggB', { type: 'json' }),
      store.get('_run/predict-daily', { type: 'json' }),
      store.get('_run/score-daily', { type: 'json' }),
      store.get('_run/collect-history', { type: 'json' }),
    ]);
    // 과거 백필(1~6월 마스킹 census) 진행 + walk-forward 백테스트 성장 곡선
    const [bfMeta, runBackfill, btSummary, runBacktest, curatedAgg, simSummary, simRecords, runSim] = await Promise.all([
      store.get('hist/_bfmeta', { type: 'json' }),
      store.get('_run/collect-backfill', { type: 'json' }),
      store.get('bt/summary', { type: 'json' }),
      store.get('_run/backtest', { type: 'json' }),
      store.get('curatedAgg', { type: 'json' }),
      store.get('bt/sim/summary', { type: 'json' }),   // 모의 라이브 재생 요약(월별 학습곡선)
      store.get('bt/sim/records', { type: 'json' }),   // 모의 라이브 per-item 기록(관제실 과녁 점)
      store.get('_run/sim-live', { type: 'json' }),
    ]);
    // 시세 축(⑤) — 낙찰가 원장과 별개 지표("시세 추정 신뢰도"). 미수집이면 전부 null → 랩 섹션 숨김.
    const [mktAgg, mktBt, runMktSeal, runMktBt, mktMeta] = await Promise.all([
      store.get('mkt/agg', { type: 'json' }),          // 라이브 밴드 봉인·채점 집계(3단계)
      store.get('mkt/bt/summary', { type: 'json' }),   // nowcast walk-forward 정합도(2단계)
      store.get('_run/mkt-seal-daily', { type: 'json' }),
      store.get('_run/mkt-backtest', { type: 'json' }),
      store.get('mkt/rtms/_meta', { type: 'json' }),   // RTMS 수집 진행(1단계)
    ]);
    // 관심물건 마감 이메일 알림 하트비트 — 예약 함수라 HTTP로 찔러볼 수 없어(403) 발송이
    // 실제로 되고 있는지 볼 방법이 없었다. 다른 예약 함수와 같은 규율로 노출한다.
    const runAlert = await store.get('_run/alert-daily', { type: 'json' }).catch(() => null);
    // 외부 API 일일 호출 예산 사용량(온비드) — 수집기가 사용자 화면 몫을 침범하지 않는지 관측용.
    const apiQuota = await quota.readUsage(store, 'onbid').catch(() => null);

    const n = agg?.n || 0;
    const summary = n ? {
      n,
      hit: agg.hit,
      hitRate: Math.round(agg.hit / n * 1000) / 10,          // 구간 적중률 %
      avgAbsErrPct: Math.round(agg.sumAbsErrPct / n * 10) / 10, // 중앙값 평균 절대 오차 %
      avgWidthPct: agg.sumWidthPct ? Math.round(agg.sumWidthPct / n * 10) / 10 : null, // 평균 구간 폭 % (낙찰가 대비)
    } : { n: 0 };

    // 큐레이션 사후 성적(3단계) — "주목 물건으로 뽑은 것이 개찰 후 어땠나"의 실측.
    // 투자 수익 주장이 아니라 선별 신호의 사후 부합도: 낙찰률·평균 낙찰가율(저평가 신호 검증)·
    // AI 예상 구간 적중. 표본 없으면 null → 랩/랜딩은 섹션 숨김(degrade).
    const cn = curatedAgg?.n || 0;
    const curatedScore = cn ? {
      n: cn, sold: curatedAgg.sold || 0, failed: curatedAgg.failed || 0, canceled: curatedAgg.canceled || 0,
      soldRate: Math.round((curatedAgg.sold || 0) / cn * 1000) / 10,                          // 개찰 종결 중 낙찰 비율
      avgWinRate: curatedAgg.sold ? Math.round(curatedAgg.sumWinRate / curatedAgg.sold * 1000) / 10 : null, // 낙찰 물건 평균 낙찰가율(낙찰가/감정가) %
      bandHitRate: curatedAgg.sold ? Math.round((curatedAgg.bandHit || 0) / curatedAgg.sold * 1000) / 10 : null, // 낙찰 물건 중 AI 예상 구간 적중 %
      byAsset: curatedAgg.byAsset || {},
      updatedAt: curatedAgg.updatedAt || null,
    } : { n: 0 };

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
      body: JSON.stringify({
        summary,
        byTier: agg?.byTier || {},
        byUsage: agg?.byUsage || {},
        // 예측 시점별 성적 — 봉인 창 확대(+14일)의 대가를 정직하게 드러낸다.
        // 개찰 직전 예측이 먼 예측보다 정확한 게 정상이며, 그 차이를 숨기지 않는다.
        byLead: Object.fromEntries(Object.entries(agg?.byLead || {}).map(([k, v]) => [k, {
          n: v.n, hit: v.hit,
          hitRate: v.n ? Math.round(v.hit / v.n * 1000) / 10 : null,
          avgAbsErrPct: v.sumAbsErrPct != null && v.n ? Math.round(v.sumAbsErrPct / v.n * 10) / 10 : null,
        }])),
        // 자산군별 성적 — 적중률·오차·구간폭을 함께 낸다(2026-07-29).
        // ⚠️ summary의 단일 수치는 **전 자산군 합산**이라 표본 구성에 좌우된다.
        //   화면에서는 이 byAsset을 주(主)로 쓰고, summary는 "합산"임을 밝혀 함께 보여줄 것.
        byAsset: Object.fromEntries(Object.entries(agg?.byAsset || {}).map(([k, s]) => [k, {
          n: s.n, hit: s.hit,
          hitRate: s.n ? Math.round(s.hit / s.n * 1000) / 10 : null,
          avgAbsErrPct: s.sumAbsErrPct != null && s.n ? Math.round(s.sumAbsErrPct / s.n * 10) / 10 : null,
          avgWidthPct: s.sumWidthPct != null && s.n ? Math.round(s.sumWidthPct / s.n * 10) / 10 : null,
        }])),
        // 결과 예보 성적(2026-07-29) — "이번에 팔릴까"(확률)와 "몇 명과 붙나"(구간).
        // 확률은 적중률로 잴 수 없어 **보정**으로 잰다: "70%라 말한 것들이 실제로 몇 % 팔렸나".
        // 낙찰가 적중률과 **별개 지표**이므로 화면에서도 문구를 분리할 것.
        outcome: (() => {
          const o = agg?.outcome;
          if (!o) return null;
          const s = o.sold || {}, b = o.bidders || {};
          const buckets = Object.entries(s.buckets || {})
            .map(([k, v]) => ({
              band: `${Number(k) * 10}~${Number(k) * 10 + 10}%`,
              n: v.n,
              predAvg: v.n ? Math.round(v.sumP / v.n * 10) / 10 : null,  // 우리가 말한 평균 확률
              actual: v.n ? Math.round(v.sold / v.n * 1000) / 10 : null, // 실제로 팔린 비율
            }))
            .sort((x, y) => parseInt(x.band, 10) - parseInt(y.band, 10));
          return {
            sold: s.n ? { n: s.n, brier: Math.round(s.sumBrier / s.n * 1000) / 1000, buckets } : null,
            bidders: b.n ? {
              n: b.n, hit: b.hit,
              hitRate: Math.round(b.hit / b.n * 1000) / 10,
              avgAbsErr: Math.round(b.sumAbsErr / b.n * 10) / 10, // 평균 몇 명 빗나갔나
            } : null,
          };
        })(),
        // 소스(시장)별 성적 — 다중 소스(AIOS) 대비. 지금은 onbid 하나지만 구조를 먼저 세운다.
        // 합산 수치는 화면에서 "합산"임을 반드시 밝힐 것(byAsset과 같은 규율).
        bySource: Object.fromEntries(Object.entries(agg?.bySource || {}).map(([k, v]) => [k, {
          n: v.n, hit: v.hit,
          hitRate: v.n ? Math.round(v.hit / v.n * 1000) / 10 : null,
          avgAbsErrPct: v.sumAbsErrPct != null && v.n ? Math.round(v.sumAbsErrPct / v.n * 10) / 10 : null,
        }])),
        curatedScore,                          // 큐레이션 사후 성적(3단계) — 랩 "큐레이션 성적" 섹션
        // 오차 범위별 누적 비율(중앙값 오차 기준) — 랩 오차분포 실측화. 표본 없으면 null.
        errDist: (n && agg?.errBuckets) ? {
          n,
          le5: Math.round((agg.errBuckets.le5 || 0) / n * 1000) / 10,
          le10: Math.round((agg.errBuckets.le10 || 0) / n * 1000) / 10,
          le15: Math.round((agg.errBuckets.le15 || 0) / n * 1000) / 10,
          le20: Math.round((agg.errBuckets.le20 || 0) / n * 1000) / 10,
        } : null,
        daily: agg?.daily || {},
        calib: calib?.byUsage || {},
        learningLog: log || [],
        recent: (recent || []).slice(0, 20),
        sealDays: meta?.sealDays || {},
        lastSealAt: meta?.lastSealAt || null,
        updatedAt: agg?.updatedAt || null,
        // 예약 함수 하트비트 — 자가진단이 마지막 실행 시각·성공여부로 "조용한 죽음"을 감지.
        // 값이 null이면 아직 한 번도 실행 기록이 없다는 뜻(배포 직후 등).
        runs: {
          predict: runPredict || null,
          score: runScore || null,
          collect: runCollect || null,
          backfill: runBackfill || null,
          backtest: runBacktest || null,
          sim: runSim || null,
          mktSeal: runMktSeal || null,
          mktBacktest: runMktBt || null,
          // {at, ok, sent, pending, failed, subs} — pending은 RESEND_API_KEY 미설정으로 보내지
          // 않은 건수다(보낸 척하지 않으며 마커도 남기지 않아 키를 넣는 즉시 발송된다).
          alert: runAlert || null,
        },
        // 외부 API 일일 호출 예산(온비드). used는 **예약 함수가 쏜 호출만** 집계한다 —
        // 사용자 화면의 직접 조회는 포함되지 않으므로, reserve는 측정값이 아니라
        // "사용자용으로 비워 두는 몫"이다(자세한 설명은 apiQuota.note).
        apiQuota: apiQuota || null,
        // ── 시세 축(⑤) — 낙찰가 성적표와 **별개 지표**. UI에서 절대 섞지 말 것.
        //   market: 라이브 밴드 봉인·채점(결과 전 봉인·불변) {overall:{n,hitRate,avgErrPct,avgCoverage},byKind,byMonth}
        //   marketBacktest: 과거 nowcast 정합도(walk-forward, "학습곡선" 아님)
        //   marketData: RTMS 수집 진행 {records,cellMonths,done}
        market: (mktAgg && mktAgg.overall && mktAgg.overall.n) ? mktAgg : null,
        marketBacktest: (mktBt && mktBt.observations) ? mktBt : null,
        marketData: mktMeta ? { records: mktMeta.records || 0, cellMonths: mktMeta.cellMonths || 0, done: !!mktMeta.done } : null,
        // 1~6월 마스킹 백필 진행: {records, windows, oldest, newest, done, cursorEnd}. 미시작이면 null.
        backfill: bfMeta || null,
        // walk-forward 백테스트 성장 곡선: {stages:[{vlabel,testLabel,n,coverage,hitRate,avgAbsErrPct,avgWidthPct}], done}. 미시작이면 null.
        backtest: btSummary || null,
        // 모의 라이브 재생(GR11): 월별 학습곡선 {months:[{ym,hitRate,cumHitRate,avgWidthPct...}],cum,done}. 미시작이면 null.
        sim: simSummary || null,
        // 모의 라이브 per-item 기록(관제실 과녁 점): [{ym,lo,mid,hi,win,hit,errPct,level}]. 최대 240건.
        simRecords: Array.isArray(simRecords) ? simRecords.slice(0, 240) : null,
        modelV: 'v0.1',
        // v0.5 챌린저 비교 성적 (predb 채점분) — 데이터 없으면 n:0
        challenger: (aggB && aggB.n) ? {
          modelV: 'v0.5-cells', n: aggB.n, hit: aggB.hit,
          hitRate: Math.round(aggB.hit / aggB.n * 1000) / 10,
          avgAbsErrPct: Math.round(aggB.sumAbsErrPct / aggB.n * 10) / 10,
          avgWidthPct: aggB.sumWidthPct ? Math.round(aggB.sumWidthPct / aggB.n * 10) / 10 : null,
          headToHead: aggB.headToHead || { n: 0, bWins: 0 },
          // 폭 원인 진단: 백오프 레벨별(L0~L3) n·hit·평균폭 + 회차 실측/근사 비율(2026-07-27 계측)
          byLevel: aggB.byLevel ? Object.fromEntries(Object.entries(aggB.byLevel).map(function (e) {
            var k = e[0], v = e[1];
            return [k, { n: v.n, hit: v.hit, hitRate: v.n ? Math.round(v.hit / v.n * 1000) / 10 : null, avgWidthPct: v.n ? Math.round(v.sumWidthPct / v.n * 10) / 10 : null }];
          })) : {},
          roundReal: aggB.roundReal || { real: 0, approx: 0 },
        } : { n: 0 },
        target: { hitRateLo: 95, hitRateHi: 98 },
        // 모델 연혁 — 초기값·변경·결과의 순차 기록 (첫 채점 전에는 도입 항목을 합성해 표시)
        chronicle: (chronicleStored && chronicleStored.length) ? chronicleStored.slice(-200) : [{
          kind: 'genesis', at: '2026-07-19T07:00:00+09:00',
          title: '모델 v0.1 가동 — 예측 봉인 시작',
          detail: {
            modelV: 'v0.1',
            formula: '앵커1 = 감정가 × 용도별 낙찰가율(rto1), 앵커2 = 최저가 × rto2, 중앙값 = 앵커 평균, 구간 = [낮은 앵커×(1-w) ~ 높은 앵커×(1+w)]',
            w0: 0.18, wRange: '0.06 ~ 0.35',
            wRule: '용도별 표본 20건 이상에서 적중률 95% 미만이면 w +0.01, 98% 초과면 w -0.005',
            statSrc: '캠코 압류재산 용도별 낙찰가율 공식 통계',
            target: '구간 적중률 95~98% + 중앙값 오차 %·원화 병기',
            principle: '봉인 후 수정 불가 · 전수 채점 · 실측치만 공개',
          },
        }],
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: { message: e.message } }) };
  }
};
