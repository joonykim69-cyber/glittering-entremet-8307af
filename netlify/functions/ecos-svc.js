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
// baseRate(한국은행 기준금리) 722Y001/0101000/M — 실호출 확정(2026-07-21).
// cd91/tb3y: 817Y002는 "시장금리(일별)"이라 월(M) 조회 시 INFO-200(데이터 없음). 월간 시장금리 표(721Y001 등)의
//   정확한 item 코드 재확인 전까지 기본 노출에서 제외 — 필요 시 env ECOS_SERIES_CD91/TB3Y="STAT,ITEM,CYCLE"로 활성.
const SERIES = {
  baseRate: { name: '한국은행 기준금리', stat: '722Y001', item: '0101000', cycle: 'M' },
  cd91: { name: 'CD(91일) 금리', stat: '817Y002', item: '010502000', cycle: 'D' },
  tb3y: { name: '국고채(3년) 금리', stat: '817Y002', item: '010200000', cycle: 'D' },
};
// 기본 노출 시리즈(?series= 미지정 시). cd91/tb3y는 817Y002 일별 표(cycle D)로 시도 —
// 코드가 맞으면 자동 표시, INFO-200이면 macro 에이전트가 조용히 드롭(무해). ECOS_DEFAULT_SERIES로 교정.
const DEFAULT_SERIES = (process.env.ECOS_DEFAULT_SERIES || 'baseRate,cd91,tb3y').split(',').map(s => s.trim()).filter(Boolean);

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
// 시점 문자열(YYYYMM 또는 YYYYMMDD)을 UTC ms로
function parseTime(t) {
  t = String(t);
  return Date.UTC(+t.slice(0, 4), (+t.slice(4, 6) || 1) - 1, +t.slice(6, 8) || 1);
}
// 주기별 조회 시간범위 + 요청 행수. D(일별)는 YYYYMMDD 최근 ~400일, M(월별)은 YYYYMM 최근 14개월.
function rangeFor(cycle) {
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  if (cycle === 'D') {
    const ymd = d => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    return { start: ymd(new Date(now.getTime() - 400 * 86400000)), end: ymd(now), rows: 500 };
  }
  const { start, end } = monthRange(14);
  return { start, end, rows: 20 };
}

async function fetchSeries(key, apiKey, debug) {
  const def = seriesDef(key);
  if (!def) return null;
  const cycle = def.cycle || 'M';
  const { start, end, rows: rowCnt } = rangeFor(cycle);
  const url = `https://ecos.bok.or.kr/api/StatisticSearch/${apiKey}/json/kr/1/${rowCnt}/${def.stat}/${cycle}/${start}/${end}/${def.item}`;
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
    // 전월/전년 대비 기준점 — 월별은 직전월·12개월전, 일별은 ~30일전·~365일전 이하의 마지막 관측
    let prevRow, yoyRow;
    if (cycle === 'D') {
      const lastT = parseTime(last.TIME);
      const rev = [...clean].reverse();
      prevRow = rev.find(x => parseTime(x.TIME) <= lastT - 30 * 86400000) || null;
      yoyRow = rev.find(x => parseTime(x.TIME) <= lastT - 365 * 86400000) || clean[0];
    } else {
      prevRow = clean.length >= 2 ? clean[clean.length - 2] : null;
      yoyRow = clean.find(x => String(x.TIME) === shiftYm(last.TIME, -12)) || clean[0];
    }
    const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
    return {
      key, name: def.name, unit: last.UNIT_NAME || '%',
      latest: { time: last.TIME, value: num(last.DATA_VALUE) },
      prev: prevRow ? { time: prevRow.TIME, value: num(prevRow.DATA_VALUE) } : null,
      yoy: yoyRow ? { time: yoyRow.TIME, value: num(yoyRow.DATA_VALUE) } : null,
      changePp: prevRow ? Math.round((num(last.DATA_VALUE) - num(prevRow.DATA_VALUE)) * 100) / 100 : null,
      yoyPp: yoyRow ? Math.round((num(last.DATA_VALUE) - num(yoyRow.DATA_VALUE)) * 100) / 100 : null,
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
  const want = qs.series ? String(qs.series).split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_SERIES;

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
