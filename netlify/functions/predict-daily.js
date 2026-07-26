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

const { fromOnbid, scoreOpportunity } = require('./lib/curation');

const CORS = { 'Access-Control-Allow-Origin': '*' };
const MODEL_V = 'v0.1';
const DEFAULT_W = 0.18;
const CURATED_MAX = 24; // "오늘의 주목 물건" 저장 상한

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
    const start = ymd(kst());
    const end = ymd(new Date(kst().getTime() + 2 * 86400000));
    const q = `bidPrdYmdStart=${start}&bidPrdYmdEnd=${end}`;
    const settled = await Promise.allSettled([
      fetchJson(`${base}/.netlify/functions/onbid-search?numOfRows=700&${q}`),
      fetchJson(`${base}/.netlify/functions/onbid-mvast-search?numOfRows=50&${q}`),
      fetchJson(`${base}/.netlify/functions/onbid-vhcl-search?numOfRows=50&${q}`),
    ]);
    const items = [];
    settled.forEach(s => {
      if (s.status === 'fulfilled' && Array.isArray(s.value.items)) items.push(...s.value.items);
    });

    let sealed = 0, skipped = 0, noBasis = 0, sealedB = 0;
    const predMap = {}; // key → {lo,mid,hi} : 이번 실행에서 봉인한 챔피언 예측(큐레이션 저평가 여력 판단용)
    const endLimit = end + '2359';
    const targets = items
      .filter(it => it.min > 0 && it.pbctCdtnNo && (!it.bidEnd || String(it.bidEnd) <= endLimit))
      .slice(0, 800); // 1회 실행 상한 = 부동산 700 + 동산 50 + 차량 50 (전수 봉인 보장·실행시간 보호)

    for (const it of targets) {
      const key = `pred/${it.id}_${it.pbctCdtnNo}`;
      const exists = await store.get(key);
      if (exists) { skipped++; continue; } // 봉인 불변 원칙

      const st = stats && (stats.map[STAT_BUCKET[it.type]] || stats.map['전체']);
      const anchors = [];
      if (st) {
        if (it.appr > 0 && Number(st.scfbAmtRto1) > 0) anchors.push(it.appr * Number(st.scfbAmtRto1) / 100);
        if (it.min > 0 && Number(st.scfbAmtRto2) > 0) anchors.push(it.min * Number(st.scfbAmtRto2) / 100);
      }
      if (!anchors.length) { noBasis++; continue; } // 통계 근거 없으면 예측하지 않는다 (정직성)

      const w = (calib.byUsage[it.type] && calib.byUsage[it.type].w) || DEFAULT_W;
      const mid = Math.round(anchors.reduce((s, v) => s + v, 0) / anchors.length);
      const lo = Math.round(Math.max(it.min, Math.min(...anchors) * (1 - w)));
      let hi = Math.round(Math.max(...anchors) * (1 + w));
      if (hi <= lo) hi = Math.round(lo * 1.05);

      await store.setJSON(key, {
        id: it.id, pbctCdtnNo: it.pbctCdtnNo, title: it.title, type: it.type,
        assetClass: it.assetClass || '부동산',
        appr: it.appr, min: it.min, // 만원
        lo, mid, hi,                // 만원
        w, statBucket: st ? String(st.clsCdNm).trim() : '',
        statPerd: stats ? stats.perd : '',
        round: Number(it.round) || 0, fail: Number(it.fail) || 0, // 공매차수·유찰수 실측(회차별 채점·분석용)
        bidEnd: it.bidEnd || '', modelV: MODEL_V,
        sealedAt: new Date().toISOString(),
      });
      predMap[key] = { lo, mid, hi };
      sealed++;

      // ── v0.5 챌린저 봉인 (predb/*) — 같은 물건을 실측 이력 분위수로 병행 예측 ──
      // 셀 조회는 hist-stats와 동일한 백오프(L3→L0, 표본 20+).
      // 회차는 온비드 공매차수(pbctNsq, it.round) 실측을 우선 사용하고, 없을 때만 유찰수+1로 근사한다.
      if (cellsData && cellsData.cells) {
        const typeCd = it.assetClass === '동산' ? '0003' : it.assetClass === '자동차' ? '0002' : '0001';
        const usage = String(it.usage || it.type || '기타').trim() || '기타';
        const roundReal = Number(it.round) > 0;
        const rbN = roundReal ? Number(it.round) : ((Number(it.fail) || 0) + 1);
        const rb = rbN >= 4 ? '4+' : String(rbN);
        const tier = it.min < 10000 ? 'lt1' : it.min < 50000 ? 't1to5' : it.min < 100000 ? 't5to10' : 'gte10';
        for (const ck of [`L3|${typeCd}|${usage}|${rb}|${tier}`, `L2|${typeCd}|${usage}|${rb}`, `L1|${typeCd}|${usage}`, `L0|${typeCd}`]) {
          const cell = cellsData.cells[ck];
          if (cell && cell.n >= 20 && cell.lr) {
            const bLo = Math.round(it.min * cell.lr.p10 / 100);
            const bMid = Math.round(it.min * cell.lr.p50 / 100);
            let bHi = Math.round(it.min * cell.lr.p90 / 100);
            if (bHi <= bLo) bHi = Math.round(bLo * 1.05);
            await store.setJSON(`predb/${it.id}_${it.pbctCdtnNo}`, {
              id: it.id, pbctCdtnNo: it.pbctCdtnNo, type: it.type,
              lo: bLo, mid: bMid, hi: bHi, // 만원
              cellKey: ck, cellN: cell.n, modelV: 'v0.5-cells',
              round: rbN, roundReal, // 회차(pbctNsq 실측 여부 roundReal로 표시 — 근사면 false)
              sealedAt: new Date().toISOString(),
            });
            sealedB++;
            break;
          }
        }
      }
    }

    // ── 큐레이션 패스 — "오늘의 주목 물건" (봉인 로직과 분리·소스 중립 엔진) ──
    // 같은 마감 임박 물건을 소스 중립 공통 팩트로 바꿔 기회 점수를 매기고 상위 N건을 저장한다.
    // 추가 온비드 호출 0(이미 가져온 items 재사용). 봉인 예측(predMap)·실측 셀(cellFor)을 근거로.
    const curated = [];
    for (const it of targets) {
      const f = fromOnbid(it);
      const res = scoreOpportunity(f, { pred: predMap[`pred/${it.id}_${it.pbctCdtnNo}`] || null, cell: cellFor(cellsData, f), nowKst: kst() });
      if (!res) continue;
      const p = predMap[`pred/${it.id}_${it.pbctCdtnNo}`] || null;
      curated.push({
        id: f.id, cdtn: f.cdtn, title: it.title, type: f.type, assetClass: f.assetClass,
        region: f.region, apsl: f.apsl, low: f.low, failCount: f.failCount, round: f.round, bidEnd: f.bidEnd,
        photo: it.photo || '', score: res.score, reasons: res.reasons, flags: res.flags,
        pred: p, // {lo,mid,hi} 만원 (없으면 null)
      });
    }
    curated.sort((a, b) => b.score - a.score);
    const curatedTop = curated.slice(0, CURATED_MAX);
    await store.setJSON('curated/latest', {
      at: new Date().toISOString(), window: { start, end },
      scanned: targets.length, scored: curated.length, count: curatedTop.length,
      items: curatedTop,
    });

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

    const summary = { ok: true, scanned: items.length, targets: targets.length, sealed, sealedB, skipped, noBasis, curated: curatedTop.length, statPerd: stats ? stats.perd : null, ...(qs.debug ? { window: { start, end } } : {}) };
    // 하트비트 — 매 실행마다 마지막 성공 시각·처리건수 기록(자가진단이 신선도로 죽음 감지)
    await store.setJSON('_run/predict-daily', { at: new Date().toISOString(), ok: true, sealed, sealedB, curated: curatedTop.length, targets: targets.length, noBasis });
    console.log('[predict-daily]', JSON.stringify(summary));
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(summary) };
  } catch (e) {
    console.log('[predict-daily] 실패:', e.message);
    try { await store.setJSON('_run/predict-daily', { at: new Date().toISOString(), ok: false, error: e.message }); } catch (_) { /* 하트비트 실패는 무시 */ }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
