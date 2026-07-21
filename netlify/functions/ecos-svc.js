// netlify/functions/ecos-svc.js
// 한국은행 ECOS Open API 프록시 — 거시·금리 워처 에이전트(⑦)의 데이터 소스.
// 기준금리·시장금리 등 핵심 거시 시계열의 "최근값 + 추세(전월/전년 대비)"를 반환한다.
//
// 인증키: Netlify 환경변수 ECOS_API_KEY (한국은행 ECOS MyPage 발급). 미설정 시 clean 501 →
//   거시 에이전트가 "거시 데이터 없음"으로 degrade-gracefully. **키는 코드/리포에 넣지 않는다.**
//
// ECOS StatisticSearch 포맷:
//   https://ecos.bok.or.kr/api/StatisticSearch/{KEY}/json/kr/{start}/{end}/{STAT}/{CYCLE}/{T1}/{T2}/{ITEM}
// 시리즈 코드는 env로 교정 가능(ECOS_SERIES_<KEY>="STAT,ITEM,CYCLE"). 첫 호출은 ?debug=1로 원본 확인.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// 기본 시리즈 레지스트리 (STAT_CODE, ITEM_CODE, CYCLE). env ECOS_SERIES_<KEY>로 덮어쓰기 가능.
// baseRate(한국은행 기준금리)는 널리 쓰이는 722Y001/0101000/M. 나머지는 실호출(?debug=1)로 검증 후 교정 대상.
const SERIES = {
  baseRate: { name: '한국은행 기준금리', stat: '722Y001', item: '0101000', cycle: 'M' },
  cd91: { name: 'CD(91일) 금리', stat: '817Y002', item: '010502000', cycle: 'M' },
  tb3y: { name: '국고채(3년) 금리', stat: '817Y002', item: '010200000', cycle: 'M' },
};

function seriesDef(key) {
  const ov = process.env[`ECOS_SERIES_${key.toUpperCase()}`];
  if (ov) {
    const [stat, item, cycle] = String(ov).split(',').map(s => s.trim());
    if (stat && item) return { name: SERIES[key] ? SERIES[key].name : key, stat, item, cycle: cycle || 'M' };
  }
  return SERIES[key] || null;
}

// 월주기 기준 최근 N개월 시간범위 (YYYYMM)
function monthRange(n) {
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  const end = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const s = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (n - 1), 1));
  const start = `${s.getUTCFullYear()}${String(s.getUTCMonth() + 1).padStart(2, '0')}`;
  return { start, end };
}

async function fetchSeries(key, apiKey, debug) {
  const def = seriesDef(key);
  if (!def) return null;
  const cycle = def.cycle || 'M';
  const { start, end } = cycle === 'M' ? monthRange(14) : monthRange(14);
  const url = `https://ecos.bok.or.kr/api/StatisticSearch/${apiKey}/json/kr/1/20/${def.stat}/${cycle}/${start}/${end}/${def.item}`;
  try {
    const r = await fetch(url);
    const text = await r.text();
    let raw;
    try { raw = JSON.parse(text); } catch (e) { return { key, name: def.name, error: 'non-JSON', ...(debug ? { snippet: text.slice(0, 300) } : {}) }; }
    if (raw.RESULT) return { key, name: def.name, error: `${raw.RESULT.CODE} ${raw.RESULT.MESSAGE}`, ...(debug ? { url: url.replace(apiKey, '***') } : {}) };
    const rows = raw.StatisticSearch && Array.isArray(raw.StatisticSearch.row) ? raw.StatisticSearch.row : [];
    if (!rows.length) return { key, name: def.name, error: 'NODATA' };
    const clean = rows.filter(x => x.DATA_VALUE != null && x.DATA_VALUE !== '').sort((a, b) => String(a.TIME).localeCompare(String(b.TIME)));
    if (!clean.length) return { key, name: def.name, error: 'NODATA' };
    const last = clean[clean.length - 1];
    const prevM = clean.length >= 2 ? clean[clean.length - 2] : null; // 직전 주기
    const yoy = clean.find(x => String(x.TIME) === shiftYm(last.TIME, -12)) || clean[0]; // 12개월 전(없으면 최초)
    const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
    return {
      key, name: def.name, unit: last.UNIT_NAME || '%',
      latest: { time: last.TIME, value: num(last.DATA_VALUE) },
      prev: prevM ? { time: prevM.TIME, value: num(prevM.DATA_VALUE) } : null,
      yoy: yoy ? { time: yoy.TIME, value: num(yoy.DATA_VALUE) } : null,
      changePp: prevM ? Math.round((num(last.DATA_VALUE) - num(prevM.DATA_VALUE)) * 100) / 100 : null,
      yoyPp: yoy ? Math.round((num(last.DATA_VALUE) - num(yoy.DATA_VALUE)) * 100) / 100 : null,
      ...(debug ? { url: url.replace(apiKey, '***'), rows: clean.length } : {}),
    };
  } catch (e) {
    return { key, name: def.name, error: e.message };
  }
}

function shiftYm(ym, months) {
  const y = parseInt(String(ym).slice(0, 4), 10), m = parseInt(String(ym).slice(4, 6), 10);
  const d = new Date(Date.UTC(y, m - 1 + months, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: { message: 'Method not allowed' } }) };
  }
  const apiKey = process.env.ECOS_API_KEY;
  if (!apiKey) {
    return { statusCode: 501, headers: CORS, body: JSON.stringify({ error: { message: '한국은행 ECOS API 미연동 — Netlify 환경변수 ECOS_API_KEY를 설정하세요.' } }) };
  }
  const qs = event.queryStringParameters || {};
  const debug = !!qs.debug;
  const want = qs.series ? String(qs.series).split(',').map(s => s.trim()).filter(Boolean) : Object.keys(SERIES);

  try {
    const out = await Promise.all(want.map(k => fetchSeries(k, apiKey, debug)));
    const series = out.filter(Boolean);
    const ok = series.filter(s => s && !s.error);
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=21600' }, // 6h
      body: JSON.stringify({ series, okCount: ok.length, checkedAt: new Date().toISOString() }),
    };
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: { message: 'ECOS proxy error: ' + e.message } }) };
  }
};
