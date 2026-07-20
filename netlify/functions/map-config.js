// netlify/functions/map-config.js
// 카카오맵 JavaScript 앱키를 클라이언트에 전달하는 설정 프록시.
//
// 카카오 JS 앱키는 "클라이언트 공개용" 키다(실제 보호는 카카오 개발자 콘솔의
// 플랫폼 도메인 화이트리스트로 이뤄짐 — 등록되지 않은 도메인에서는 로드 자체가 거부됨).
// 그래도 다른 시크릿들과 동일하게 Netlify 환경변수(KAKAO_MAP_KEY)로만 관리하고
// 코드/리포지토리에는 넣지 않는다. 미설정 시 빈 값을 반환 → 상세 페이지는
// 기존 CSS 지도 목업을 그대로 유지한다(degrade-gracefully).
//
// ⚠️ onbid.co.kr 등 타사의 카카오 키를 도용하지 않는다(약관 위반·법적 리스크,
//    애초에 도메인 불일치로 작동하지도 않음). 반드시 사용자 명의로 발급한 키만 사용.
//
// 설정:
//   Netlify 환경변수 KAKAO_MAP_KEY = 카카오 개발자 콘솔의 JavaScript 키
//   카카오 개발자 콘솔 → 앱 → 플랫폼 → Web → 사이트 도메인에 배포 도메인 등록

const CORS = { 'Access-Control-Allow-Origin': '*' };

exports.handler = async () => {
  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' },
    body: JSON.stringify({ kakaoKey: process.env.KAKAO_MAP_KEY || '' }),
  };
};
