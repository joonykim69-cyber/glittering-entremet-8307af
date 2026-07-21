// netlify/functions/integrations-status.js
// 외부 연동 키 설정 여부 자가진단 — 키를 Netlify 환경변수에 넣었을 때 실제로 활성화됐는지
// 사용자가 바로 확인하는 용도. **시크릿 값은 절대 반환하지 않고, 설정 여부(boolean)만** 노출한다.
// (환경변수 존재 여부는 클라이언트 코드로도 이미 드러나므로 정보 노출 위험 없음.)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const has = (...names) => names.every(n => {
  const v = process.env[n];
  return typeof v === 'string' && v.trim().length > 0;
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: { message: 'Method not allowed' } }) };
  }

  // 각 연동: 필요한 환경변수 + 켜졌을 때 활성화되는 기능 + 상태
  //   ready   = 코드 준비 완료, 키만 넣으면 즉시 활성
  //   pending = 키를 넣어도 별도 코드 작업이 더 필요(에이전트/축 미구현)
  const defs = [
    { key: 'anthropic', label: 'Claude AI (예보봇·전문가 에이전트)', envs: ['ANTHROPIC_API_KEY'], stage: 'ready' },
    { key: 'onbid', label: '온비드 물건 목록·상세·개찰결과', envs: ['ONBID_SERVICE_KEY'], stage: 'ready' },
    { key: 'naverNews', label: '뉴스·정보 에이전트', envs: ['NAVER_CLIENT_ID', 'NAVER_CLIENT_SECRET'], stage: 'ready' },
    { key: 'kakaoMap', label: '상세 페이지 실지도', envs: ['KAKAO_MAP_KEY'], stage: 'ready' },
    { key: 'ecos', label: '거시·금리 워처 에이전트', envs: ['ECOS_API_KEY'], stage: 'ready' },
    { key: 'rone', label: '부동산원 주택가격지수(지역 전문가 에이전트)', envs: ['RONE_API_KEY'], stage: 'ready', note: 'RONE_STATBL_ID(통계표 ID)도 설정 필요 — rone-svc?list=아파트 로 조회' },
  ];

  const integrations = defs.map(d => ({
    key: d.key,
    label: d.label,
    configured: has(...d.envs),
    envs: d.envs,
    stage: d.stage,
    ...(d.note ? { note: d.note } : {}),
  }));

  const activeNow = integrations.filter(i => i.configured && i.stage === 'ready').map(i => i.key);
  const readyWaiting = integrations.filter(i => !i.configured && i.stage === 'ready').map(i => i.key);

  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      integrations,
      summary: {
        activeNow,                 // 지금 켜져 동작 중인 연동
        readyWaiting,              // 코드는 준비됨 · 키만 넣으면 즉시 활성
        checkedAt: new Date().toISOString(),
      },
    }),
  };
};
