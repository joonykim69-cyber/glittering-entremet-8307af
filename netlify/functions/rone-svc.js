// netlify/functions/rone-svc.js
// 한국부동산원 부동산통계정보(R-ONE) OpenAPI 프록시 — 주택가격지수 등 부동산원 통계의
// 최근값+추세(3/6/12개월 변동)를 반환. 시세 시나리오 밴드(보수/기준/낙관)의 지수 데이터원.
//
// 인증키: Netlify 환경변수 RONE_API_KEY (부동산원 R-ONE 활용신청 승인 후 발급). 미설정 시 clean 501.
//   **키는 코드/리포에 넣지 않는다.**
//
// R-ONE OpenAPI:
//   통계자료: https://www.reb.or.kr/r-one/openapi/SttsApiTblData.do?KEY=&Type=json&STATBL_ID=&DTACYCLE_CD=&...
//   통계표목록: https://www.reb.or.kr/r-one/openapi/SttsApiTbl.do (?list= 로 노출)
// STATBL_ID(통계표 ID)·ITM_ID·CLS_ID는 계정/통계표마다 달라 env로 지정한다(?debug=1로 확인 후 교정):
//   RONE_STATBL_ID(필수, 기본 미설정 시 안내), RONE_DTACYCLE_CD(기본 MM), RONE_ITM_ID, RONE_CLS_ID.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};
const BASE = 'https://www.reb.or.kr/r-one/openapi';

function num(v) { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; }

// 시도명(예 "충청북도"/"서울특별시")을 R-ONE 지역 라벨 약칭(예 "충북"/"서울")으로 정규화.
function shortSido(s) {
  s = String(s || '').trim();
  const M = { '충청북': '충북', '충청남': '충남', '전라북': '전북', '전라남': '전남', '경상북': '경북', '경상남': '경남' };
  for (const k of Object.keys(M)) { if (s.startsWith(k)) return M[k]; }
  return s.slice(0, 2); // 서울/부산/대구/인천/광주/대전/울산/세종/경기/강원/제주 등은 앞 2글자
}

// R-ONE 응답은 [{head:[...]},{row:[...]}] 형태(다른 통계 API와 유사). row 배열만 추출.
function extractRows(raw, svcKey) {
  const node = raw && raw[svcKey];
  if (!Array.isArray(node)) return [];
  for (const part of node) {
    if (part && Array.isArray(part.row)) return part.row;
  }
  return [];
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: { message: 'Method not allowed' } }) };
  }
  const apiKey = process.env.RONE_API_KEY;
  if (!apiKey) {
    return { statusCode: 501, headers: CORS, body: JSON.stringify({ error: { message: '한국부동산원 R-ONE API 미연동 — Netlify 환경변수 RONE_API_KEY를 설정하세요.' } }) };
  }
  const qs = event.queryStringParameters || {};
  const debug = !!qs.debug;

  try {
    // ?list=검색어 → 통계표 목록(STATBL_ID 찾기용)
    if (qs.list != null) {
      const url = `${BASE}/SttsApiTbl.do?KEY=${apiKey}&Type=json&pIndex=1&pSize=100${qs.list ? `&STATBL_NM=${encodeURIComponent(qs.list)}` : ''}`;
      const r = await fetch(url); const t = await r.text();
      let raw; try { raw = JSON.parse(t); } catch (e) { return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: { message: 'R-ONE 목록이 JSON이 아님' }, ...(debug ? { snippet: t.slice(0, 400) } : {}) }) }; }
      if (raw.RESULT) return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: { message: `R-ONE: ${raw.RESULT.CODE} ${raw.RESULT.MESSAGE}` }, ...(debug ? { url: url.replace(apiKey, '***') } : {}) }) };
      const rows = extractRows(raw, 'SttsApiTbl');
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ tables: rows.map(x => ({ id: x.STATBL_ID, name: x.STATBL_NM, cycle: x.DTACYCLE_CD })).slice(0, 100), ...(debug ? { url: url.replace(apiKey, '***') } : {}) }) };
    }

    const statbl = qs.statbl || process.env.RONE_STATBL_ID;
    if (!statbl) {
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'no_table', message: 'RONE_STATBL_ID(통계표 ID) 미설정 — ?list=아파트 로 통계표를 찾아 env RONE_STATBL_ID에 설정하세요.' }) };
    }
    const cycle = qs.cycle || process.env.RONE_DTACYCLE_CD || 'MM';
    // 최근 시간창 — R-ONE은 오래된 시점부터 반환하므로 최근 범위를 지정(안 하면 1987년 데이터만 긁힘).
    const now = new Date(Date.now() + 9 * 3600 * 1000);
    const ym = d => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const startT = qs.start || process.env.RONE_START_WRTTIME || (cycle === 'MM' ? ym(new Date(Date.UTC(now.getUTCFullYear() - 3, now.getUTCMonth(), 1))) : String(now.getUTCFullYear() - 4));
    const endT = qs.end || process.env.RONE_END_WRTTIME || (cycle === 'MM' ? ym(now) : String(now.getUTCFullYear()));
    const params = new URLSearchParams({ KEY: apiKey, Type: 'json', pIndex: '1', pSize: qs.pSize || '500', STATBL_ID: statbl, DTACYCLE_CD: cycle, START_WRTTIME: startT, END_WRTTIME: endT });
    // ?region=<시도>: 소재지 시도의 시계열을 라벨 매칭으로 선택(동적 지역화). 지정 시 지역 필터(cls/grp)를
    // 비워 전 지역 시계열을 받은 뒤 라벨로 고른다(없으면 전국 폴백).
    const regionQ = qs.region ? String(qs.region).trim() : '';
    const itm = qs.itm || process.env.RONE_ITM_ID; if (itm) params.set('ITM_ID', itm);
    const cls = qs.cls || (regionQ ? '' : process.env.RONE_CLS_ID); if (cls) params.set('CLS_ID', cls);
    // GRP_ID: 지역 차원(예 GRP_NM "동구"/"전국"). 다차원 표(지역×용도)를 하나로 좁히는 핵심 필터.
    const grp = qs.grp || (regionQ ? '' : process.env.RONE_GRP_ID); if (grp) params.set('GRP_ID', grp);
    const url = `${BASE}/SttsApiTblData.do?${params.toString()}`;

    const r = await fetch(url); const t = await r.text();
    let raw; try { raw = JSON.parse(t); } catch (e) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: { message: 'R-ONE 응답이 JSON이 아님 — ?debug=1로 확인' }, ...(debug ? { snippet: t.slice(0, 500), url: url.replace(apiKey, '***') } : {}) }) };
    }
    if (raw.RESULT) return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: { message: `R-ONE: ${raw.RESULT.CODE} ${raw.RESULT.MESSAGE}` }, ...(debug ? { url: url.replace(apiKey, '***') } : {}) }) };

    const rawRows = extractRows(raw, 'SttsApiTblData');
    // 분류 키: 시점/값 외의 *_ID·*_NM 필드 조합(다차원 테이블에서 하나의 시계열을 식별)
    const clsKeyOf = x => Object.keys(x).filter(k => /(_ID|_NM|_FULLNM)$/.test(k) && !/WRTTIME/.test(k) && k !== 'STATBL_ID' && k !== 'DTACYCLE_CD').sort().map(k => `${k}=${x[k]}`).join('|');
    const clsLabelOf = x => Object.keys(x).filter(k => /_NM$/.test(k) && !/WRTTIME/.test(k) && k !== 'UI_NM').map(k => x[k]).filter(Boolean).join(' · ');
    // 각 시계열을 식별하는 *_ID 필드(GRP_ID/CLS_ID/ITM_ID 등) — multi_series 시 사용자가 바로 env에 넣을 값.
    const idsOf = x => { const o = {}; Object.keys(x).forEach(k => { if (/_ID$/.test(k) && !/WRTTIME/.test(k) && k !== 'STATBL_ID') o[k] = x[k]; }); return o; };
    const all = rawRows
      .map(x => ({ time: String(x.WRTTIME_IDTFR_ID || x.WRTTIME_DESC || ''), value: num(x.DTA_VAL), key: clsKeyOf(x), label: clsLabelOf(x), unit: x.UI_NM || '', ids: idsOf(x) }))
      .filter(x => x.time && x.value != null);

    if (!all.length) {
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'empty', statbl, ...(debug ? { url: url.replace(apiKey, '***'), snippet: t.slice(0, 500) } : {}) }) };
    }

    // 분류(시계열)별 그룹핑
    const groups = new Map();
    for (const x of all) { if (!groups.has(x.key)) groups.set(x.key, { key: x.key, label: x.label, unit: x.unit, ids: x.ids, rows: [] }); groups.get(x.key).rows.push(x); }

    // 시계열 → 추세 응답 빌더 (region 매칭·단일 시계열 공용)
    const trendBody = (g, extra) => {
      const rows2 = g.rows.slice().sort((a, b) => a.time.localeCompare(b.time));
      const last = rows2[rows2.length - 1];
      const at = k => { const r2 = rows2[rows2.length - 1 - k]; return r2 ? r2.value : null; };
      const chg = prev => prev != null && prev !== 0 ? Math.round((last.value - prev) / prev * 1000) / 10 : null;
      return JSON.stringify({
        status: 'ok', statbl, cycle, region: g.label, item: g.label, unit: g.unit,
        latest: { time: last.time, value: last.value },
        change: { m3: chg(at(3)), m6: chg(at(6)), m12: chg(at(12)) },
        points: rows2.slice(-13).map(p => ({ time: p.time, value: p.value })),
        ...extra,
        ...(debug ? { url: url.replace(apiKey, '***'), rows: rows2.length } : {}),
      });
    };

    // ?region 지정: 소재 시도 라벨과 매칭되는 시계열 선택(없으면 전국 폴백 → 그래도 없으면 첫 시계열).
    if (regionQ) {
      const want = shortSido(regionQ);
      const gs = [...groups.values()];
      const g = gs.find(x => (x.label || '').includes(want)) || gs.find(x => (x.label || '').includes('전국')) || gs[0];
      if (g) {
        const matched = (g.label || '').includes(want);
        return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=21600' }, body: trendBody(g, { matchedRegion: want, regionMatched: matched }) };
      }
    }

    // 다차원인데 필터가 없어 시계열이 여럿이면 모호 → multi로 반환(사용자/코드가 GRP/CLS/ITM 지정)
    if (groups.size > 1 && !cls && !itm && !grp) {
      // 각 시계열의 라벨 + 바로 env에 넣을 식별 ID(GRP_ID/CLS_ID/ITM_ID)를 함께 노출 → 자가 설정 가능.
      const list = [...groups.values()].map(g => ({ label: g.label, points: g.rows.length, ids: g.ids })).slice(0, 40);
      return {
        statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'multi_series', statbl, cycle,
          message: `이 통계표는 다차원(${groups.size}개 시계열)입니다. 원하는 시계열의 ids를 골라 RONE_GRP_ID(지역)/RONE_CLS_ID(용도)/RONE_ITM_ID(지표)에 설정하세요. 예: 전국 아파트 매매가격지수 시계열의 ids를 그대로 env에 넣으면 단일 시계열로 좁혀집니다.`,
          series: list,
          ...(debug ? { url: url.replace(apiKey, '***'), rawFirst: rawRows[0] || null, fieldKeys: rawRows[0] ? Object.keys(rawRows[0]) : [] } : {}),
        }),
      };
    }

    // 단일 시계열(또는 필터로 하나로 좁혀짐) → 시간순 정렬 후 추세 계산
    const rows = (groups.size === 1 ? [...groups.values()][0].rows : all).sort((a, b) => a.time.localeCompare(b.time));
    const last = rows[rows.length - 1];
    const at = k => { const r2 = rows[rows.length - 1 - k]; return r2 ? r2.value : null; };
    const chg = prev => prev != null && prev !== 0 ? Math.round((last.value - prev) / prev * 1000) / 10 : null;

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=21600' },
      body: JSON.stringify({
        status: 'ok', statbl, cycle, region: last.label, item: last.label, unit: last.unit,
        latest: { time: last.time, value: last.value },
        change: { m3: chg(at(3)), m6: chg(at(6)), m12: chg(at(12)) }, // %
        points: rows.slice(-13).map(p => ({ time: p.time, value: p.value })),
        ...(debug ? { url: url.replace(apiKey, '***'), rows: rows.length, rawFirst: rawRows[0] || null, fieldKeys: rawRows[0] ? Object.keys(rawRows[0]) : [] } : {}),
      }),
    };
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: { message: 'R-ONE proxy error: ' + e.message } }) };
  }
};
