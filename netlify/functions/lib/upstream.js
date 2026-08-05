// netlify/functions/lib/upstream.js
// data.go.kr 상위 응답의 **실패**를 판정한다 — '데이터 없음'과 구별하기 위해.
//
// 왜 필요한가 (2026-08-05 실장애):
//   포털 게이트웨이는 인증·쿼터·IP 오류를 **문서화된 봉투가 아닌 다른 봉투**로 돌려준다:
//     {"OpenAPI_ServiceResponse":{"cmmMsgHeader":{
//        "errMsg":"SERVICE_KEY_IS_NOT_REGISTERED_ERROR",
//        "returnAuthMsg":"등록되지 않은 서비스키","returnReasonCode":"30"}}}
//   우리 프록시는 `header.resultCode`만 검사했기 때문에 이 응답이 **모든 오류 분기를 통과**해
//   `HTTP 200 + 빈 배열`이 됐다. 그러자 수집기는 그것을 '개찰 없음'으로 받아들여 빈 창을
//   저장하고 커서를 전진시켰다 — 실패와 무데이터를 구분하지 못한 것이 근본 원인이다.
//   (collect-rtms에는 이미 "실패는 '거래 없음'과 다르다" 방어가 있었는데 이쪽엔 없었다.)
//
// 판정은 **원문 텍스트**로 한다 — 온비드는 JSON, RTMS는 XML이라 파싱 결과의 모양이 다르지만
// 게이트웨이 오류는 양쪽에 같은 태그·키 이름으로 실린다.
//
// ⚠️ 오탐 방지: 토큰만 보지 않고 **게이트웨이 봉투가 있을 때만** 실패로 본다. 정상 응답이
//   우연히 같은 단어를 담고 있어도(요청 파라미터 에코 등) 실패로 뒤집히지 않게 하기 위함이다.
'use strict';

// 키·쿼터·기간 만료 — 사람이 손을 대야 풀리는 치명 오류(onbid-svc/rtms-svc의 classify와 같은 규칙)
const FATAL_RE = /SERVICE_KEY|UNREGISTERED|LIMITED_NUMBER|DEADLINE|EXCEEDS/i;
// 게이트웨이 오류 봉투 (JSON·XML 공통)
const GATEWAY_RE = /OpenAPI_ServiceResponse|cmmMsgHeader/i;

// JSON("k":"v")·XML(<k>v</k>) 양쪽에서 필드 하나를 뽑는다.
function pick(text, name) {
  const j = new RegExp('"' + name + '"\\s*:\\s*"([^"]*)"', 'i').exec(text);
  if (j) return j[1];
  const x = new RegExp('<' + name + '>([^<]*)</' + name + '>', 'i').exec(text);
  return x ? x[1].trim() : '';
}

/**
 * 상위 응답이 '실패'인지 판정한다.
 * @returns {null | {verdict:'key_error'|'gateway_error', code:string, msg:string}}
 *   null이면 실패가 아니다(정상 또는 '데이터 없음' — 그 구분은 호출자의 resultCode 로직이 한다).
 */
function upstreamFailure(bodyText) {
  const t = String(bodyText || '');
  if (!GATEWAY_RE.test(t)) return null;
  const err = pick(t, 'errMsg');
  const auth = pick(t, 'returnAuthMsg');
  const code = pick(t, 'returnReasonCode');
  const verdict = FATAL_RE.test(err) || FATAL_RE.test(t) ? 'key_error' : 'gateway_error';
  const msg = [err, auth && `(${auth})`, code && `코드 ${code}`].filter(Boolean).join(' ') || '상위 게이트웨이 오류';
  return { verdict, code, msg };
}

module.exports = { upstreamFailure, FATAL_RE, GATEWAY_RE };
