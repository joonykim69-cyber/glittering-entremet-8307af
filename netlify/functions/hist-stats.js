// netlify/functions/hist-stats.js
// 예측 엔진 v0.5 준비 — 수집된 개찰 이력(hist/*)의 "다차원 통계 조회 API".
//
// collect-history가 쌓는 레코드를 자산군×용도×회차×가격대 셀로 집계해
// 낙찰가율 분위수(p10~p90)와 유찰율을 돌려준다. 표본이 부족한 셀은
// 상위 셀로 백오프(L3 풀조합 → L2 회차까지 → L1 용도까지 → L0 자산군만).
// v0.5 봉인 엔진과 "유사 사례 근거 제시" UI가 공용으로 쓰는 데이터 레이어.
//
// 사용법:
//   GET /.netlify/functions/hist-stats                         → 데이터셋 요약(_meta/_cells 상태)
//   GET /.netlify/functions/hist-stats?type=0001&usage=근린생활시설&round=2&tier=t1to5
//       → 백오프 조회: {level, key, n, lr:{p10..p90}, wr:{...}, failRate}
//   ?minN=20  백오프 판정 최소 표본 수(기본 20)
//   ?rebuild=1  캐시(_cells) 강제 재빌드
//
// 집계는 hist/_cells에 캐시되고 hist/_meta.updatedAt이 바뀌면 재빌드된다.
// 데이터가 아직 없으면 status:'empty'를 정직하게 반환한다(숫자 안 지어냄).

const CORS = { 'Access-Control-Allow-Origin': '*' };
const MIN_N_DEFAULT = 20;

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

// 가격대: 최저입찰가(원) 기준 — score-daily의 tier 체계와 동일 구분
function tierOf(lowWon) {
  const man = lowWon / 10000;
  if (man < 10000) return 'lt1';
  if (man < 50000) return 't1to5';
  if (man < 100000) return 't5to10';
  return 'gte10';
}
function roundBucket(n) { return (Number(n) || 1) >= 4 ? '4+' : String(Math.max(1, Number(n) || 1)); }

function quantiles(sorted) {
  const q = p => {
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return Math.round((sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)) * 10) / 10;
  };
  return { p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9) };
}

// 4레벨 셀 키 — 낮은 레벨일수록 넓은 백오프 대상
function keysFor(type, usage, rb, tier) {
  return [
    `L3|${type}|${usage}|${rb}|${tier}`,
    `L2|${type}|${usage}|${rb}`,
    `L1|${type}|${usage}`,
    `L0|${type}`,
  ];
}

// 청크 병렬 — 수십만 건(창 블롭 수백 개) 조회를 순차로 하면 30초 한도를 넘으므로 병렬화.
async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) out.push(...await Promise.all(items.slice(i, i + limit).map(fn)));
  return out;
}

async function buildCells(store, force) {
  // 데이터 원천 두 갈래: 구형 collect-history(hist/_meta) + 신형 마스킹 백필(hist/_bfmeta).
  const [meta, bfmeta] = await Promise.all([
    store.get('hist/_meta', { type: 'json' }),
    store.get('hist/_bfmeta', { type: 'json' }),
  ]);
  const records = (meta?.records || 0) + (bfmeta?.records || 0);
  if (!records) return null; // 수집 전
  const srcTag = `${meta?.updatedAt || ''}|${bfmeta?.updatedAt || ''}`;
  const cached = force ? null : await store.get('hist/_cells', { type: 'json' });
  if (cached && cached.srcUpdatedAt === srcTag) return cached;

  const listing = await store.list({ prefix: 'hist/' });
  const allKeys = (listing && listing.blobs ? listing.blobs : []).map(b => b.key);
  // 구형 통짜 포맷(win 포함): hist/{start}_{end}/{type}
  const oldKeys = allKeys.filter(k => /^hist\/\d{8}_\d{8}\/\d+$/.test(k));
  // 신형 마스킹 분리 포맷: hist/feat/{start}_{end}/{type} (+ 짝 hist/win/…)
  const featKeys = allKeys.filter(k => /^hist\/feat\/\d{8}_\d{8}\/\d+$/.test(k));

  const seen = new Set();
  const acc = {}; // key → { lr:[], wr:[], win:0, fail:0 }
  let total = 0;

  // 표본 1건 반영 — addSample은 await가 없어 병렬 콜백 사이에서도 원자적(seen/acc 안전).
  const addSample = (type, r) => {
    if (!r || !r.id) return;
    total++;
    const uid = `${r.id}_${r.cdtn}`;
    if (seen.has(uid)) return;
    seen.add(uid);
    const usage = String(r.usage || r.usageM || '기타').trim() || '기타';
    const rb = roundBucket(r.round);
    const tier = tierOf(Number(r.low) || 0);
    const isWin = r.st === '0010' && Number(r.win) > 0;
    for (const k of keysFor(type, usage, rb, tier)) {
      const cell = acc[k] || (acc[k] = { lr: [], wr: [], win: 0, fail: 0 });
      if (isWin) {
        cell.win++;
        if (Number(r.lr) > 0) cell.lr.push(Number(r.lr));
        if (Number(r.wr) > 0) cell.wr.push(Number(r.wr));
      } else if (r.st === '0011') cell.fail++;
    }
  };

  // 구형 통짜 포맷 (레코드에 win 내장)
  await mapLimit(oldKeys, 40, async key => {
    const arr = await store.get(key, { type: 'json' });
    if (!Array.isArray(arr)) return;
    const type = key.split('/')[2] || '';
    for (const r of arr) addSample(type, r);
  });

  // 신형 마스킹 분리 — feat(개찰 전)와 win(개찰 결과)을 id_cdtn으로 조인해 표본 복원.
  // 집계기는 통계 산출 주체라 win을 읽어도 되지만(모집단 분포), 예측 모듈은 win에 접근 못 함.
  await mapLimit(featKeys, 30, async fkey => {
    const parts = fkey.split('/'); // ['hist','feat',W,T]
    const w = parts[2], type = parts[3];
    const [feat, winMap] = await Promise.all([
      store.get(fkey, { type: 'json' }),
      store.get(`hist/win/${w}/${type}`, { type: 'json' }),
    ]);
    if (!Array.isArray(feat)) return;
    const wm = winMap || {};
    for (const f of feat) {
      const wv = wm[`${f.id}_${f.cdtn}`] || {};
      addSample(type, { id: f.id, cdtn: f.cdtn, usage: f.usage, usageM: f.usageM, round: f.round, low: f.low, st: f.st, win: wv.win || 0, wr: wv.wr || 0, lr: wv.lr || 0 });
    }
  });

  const cells = {};
  for (const [k, c] of Object.entries(acc)) {
    const n = c.win;
    if (n < 3) continue; // 분위수가 무의미한 극소 표본 셀은 저장하지 않음
    c.lr.sort((a, b) => a - b); c.wr.sort((a, b) => a - b);
    cells[k] = {
      n,
      failRate: (c.win + c.fail) > 0 ? Math.round(c.fail / (c.win + c.fail) * 1000) / 10 : null,
      lr: c.lr.length >= 3 ? quantiles(c.lr) : null, // 최저가 대비 낙찰가율 %
      wr: c.wr.length >= 3 ? quantiles(c.wr) : null, // 감정가 대비 낙찰가율 %
    };
  }

  const out = {
    builtAt: new Date().toISOString(),
    srcUpdatedAt: srcTag,
    scannedRecords: total,
    uniqueConditions: seen.size,
    records: seen.size, // 자가진단 카드가 읽는 필드(고유 물건 표본 수)
    cellCount: Object.keys(cells).length,
    cells,
  };
  await store.setJSON('hist/_cells', out);
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const qs = (event && event.queryStringParameters) || {};
  try {
    const store = await openLedger(event);
    const data = await buildCells(store, qs.rebuild === '1');
    if (!data) {
      return {
        statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'empty', note: '학습 데이터가 아직 수집되지 않았습니다 — collect-backfill(1~6월 마스킹 census) 진행 후 사용 가능합니다.', records: 0 }),
      };
    }

    // 조회 파라미터가 없으면 데이터셋 요약만
    if (!qs.type && !qs.usage) {
      const { cells, ...summary } = data;
      return {
        statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' },
        body: JSON.stringify({ status: 'ok', ...summary }),
      };
    }

    const type = String(qs.type || '0001').replace(/[^0-9]/g, '').slice(0, 4) || '0001';
    const usage = String(qs.usage || '기타').trim().slice(0, 40);
    const rb = roundBucket(qs.round);
    const tier = ['lt1', 't1to5', 't5to10', 'gte10'].includes(qs.tier) ? qs.tier : tierOf((Number(qs.lowMan) || 0) * 10000);
    const minN = Math.max(3, Number(qs.minN) || MIN_N_DEFAULT);

    for (const k of keysFor(type, usage, rb, tier)) {
      const cell = data.cells[k];
      if (cell && cell.n >= minN && cell.lr) {
        return {
          statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' },
          body: JSON.stringify({ status: 'ok', level: k.split('|')[0], key: k, minN, ...cell, builtAt: data.builtAt }),
        };
      }
    }
    return {
      statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' },
      body: JSON.stringify({ status: 'no_basis', note: `표본 ${minN}건 이상인 셀이 없습니다 — 백필이 더 쌓이면 좁은 조합도 조회 가능해집니다.`, tried: keysFor(type, usage, rb, tier), builtAt: data.builtAt }),
    };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: { message: e.message } }) };
  }
};
