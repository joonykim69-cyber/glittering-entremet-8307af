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
    // 관심물건 마감 이메일 알림 — 이 자가진단의 사각지대였다(2026-07-31).
    // alert-daily는 예약 함수라 HTTP로 찔러볼 수 없어서(403), 키가 들어갔는지 확인할 방법이
    // 아예 없었다. 발송 여부는 scoreboard `runs.alert` 하트비트로 함께 본다.
    { key: 'resend', label: '관심물건 마감 이메일 알림', envs: ['RESEND_API_KEY'], stage: 'ready' },
  ];

  // ALERT_FROM은 "보내지느냐"가 아니라 "누구에게 닿느냐"를 가른다 — 그래서 configured에 넣지
  // 않는다(넣으면 키만 있는 상태가 '미설정'으로 보이는데, 그 상태에서도 발송은 된다).
  // 대신 어느 상태인지 말로 알려준다. 이 구분이 중요한 이유: 키만 있으면 Resend 테스트
  // 주소로 나가 **계정 소유자에게만** 배달되는데, 보내고 있다고 착각하기 가장 쉬운 상태다.
  const fromSet = has('ALERT_FROM');
  const resendNote = (key) => key
    ? (fromSet
      ? '자체 도메인 발신 — 구독자 전원에게 발송됩니다.'
      : 'ALERT_FROM 미설정 → Resend 테스트 주소로 발송되어 **계정 소유자에게만** 배달됩니다. 단독 테스트에는 충분하지만, 다른 사용자에게 보내려면 자체 도메인 인증(SPF/DKIM) 후 ALERT_FROM 설정이 필요합니다.')
    : 'RESEND_API_KEY 미설정 — alert-daily가 보낸 척하지 않고 pending으로 보고하며 발송 마커도 남기지 않습니다(키를 넣는 즉시 정상 발송).';

  const integrations = defs.map(d => ({
    key: d.key,
    label: d.label,
    configured: has(...d.envs),
    envs: d.envs,
    stage: d.stage,
    ...(d.key === 'resend'
      ? { note: resendNote(has('RESEND_API_KEY')), senderVerified: fromSet, deliversTo: fromSet ? 'all' : 'account_owner_only' }
      : d.note ? { note: d.note } : {}),
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
