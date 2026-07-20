// netlify/functions/naver-news.js
// 네이버 뉴스 검색 API 프록시 — 뉴스 에이전트(C단계)의 데이터 소스.
//
// 물건 소재 지역·키워드로 최근 뉴스를 검색해 제목/요약/링크를 정리해 반환한다.
// 인증키(Client ID/Secret)는 서버에만 두고 클라이언트에 노출하지 않는다(claude.js와 동일 패턴).
// 키 미설정 시 clean 501 → 뉴스 에이전트는 "뉴스 데이터 없음"으로 안내(degrade-gracefully).
//
// Netlify 환경변수:
//   NAVER_CLIENT_ID / NAVER_CLIENT_SECRET  (네이버 개발자센터 "검색" API 앱의 인증 정보)
//
// 사용법: GET /.netlify/functions/naver-news?query=평택 부동산&display=5&sort=date

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// 네이버 검색 응답의 <b> 강조 태그·HTML 엔티티를 제거해 순수 텍스트로
function stripHtml(s) {
  return String(s || '')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const CID = process.env.NAVER_CLIENT_ID;
  const CSEC = process.env.NAVER_CLIENT_SECRET;
  if (!CID || !CSEC) {
    return {
      statusCode: 501,
      headers: CORS,
      body: JSON.stringify({ error: { message: '네이버 뉴스 API 미연동 — Netlify 환경변수 NAVER_CLIENT_ID/NAVER_CLIENT_SECRET을 설정하세요.' } }),
    };
  }

  const qs = event.queryStringParameters || {};
  const query = String(qs.query || '').trim();
  if (!query) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: { message: 'query 파라미터가 필요합니다.' } }) };
  }
  const display = Math.min(Math.max(Number(qs.display) || 5, 1), 10);
  const sort = qs.sort === 'sim' ? 'sim' : 'date'; // 기본 최신순

  try {
    const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(query)}&display=${display}&sort=${sort}`;
    const r = await fetch(url, { headers: { 'X-Naver-Client-Id': CID, 'X-Naver-Client-Secret': CSEC } });
    const bodyText = await r.text();
    if (!r.ok) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: { message: `네이버 API 오류 HTTP ${r.status}` }, ...(qs.debug ? { snippet: bodyText.slice(0, 300) } : {}) }) };
    }
    let raw;
    try { raw = JSON.parse(bodyText); } catch { return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: { message: '네이버 API가 JSON이 아닌 응답을 반환했습니다.' } }) }; }
    const items = (Array.isArray(raw.items) ? raw.items : []).map(x => ({
      title: stripHtml(x.title),
      desc: stripHtml(x.description),
      link: x.originallink || x.link || '',
      date: x.pubDate || '',
    })).filter(x => x.title);
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=1800' },
      body: JSON.stringify({ query, total: raw.total || items.length, items }),
    };
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: { message: 'Proxy error: ' + e.message } }) };
  }
};
