// netlify/functions/lib/servicekey.js
// data.go.kr 인증키 정규화 — Encoding/Decoding 어느 형태를 넣어도 동작하게 한다.
//
// 왜 필요한가 (2026-08-05 실장애):
//   포털은 같은 인증키를 두 형태로 보여 준다 — '인증키 발급현황' 화면은 **Encoding**
//   (`%2B`·`%2F`·`%3D`), 활용신청 상세는 Encoding/Decoding(`+`·`/`·`=`)을 함께.
//   우리 프록시는 10곳 전부 URLSearchParams로 쿼리를 만들어 값을 **자동 인코딩**하므로
//   필요한 것은 Decoding 형태다. 그런데 사람이 가장 먼저 마주치는 화면이 Encoding이라,
//   그 값을 그대로 넣으면 이중 인코딩(`%2B` → `%252B`)되어 상위가
//   `SERVICE_KEY_IS_NOT_REGISTERED_ERROR`(코드 30)로 거부한다.
//   이 오류는 '키가 만료·중지됐다'와 **증상이 완전히 같아서** 원인 판별을 어렵게 만든다.
//
// 판정 근거:
//   data.go.kr 인증키는 base64 문자셋(A-Za-z0-9+/=) 또는 hex라 `%`가 들어갈 수 없다.
//   따라서 `%XX` 패턴이 보이면 Encoding 형태로 단정할 수 있다(오판 위험 0).
//
// 규율: 정규화는 **읽는 순간 한 번만** 한다. 각 함수는 정규화된 값을 그대로
//   URLSearchParams에 넣고, 인코딩은 URLSearchParams가 한 번만 수행한다.
'use strict';

const PCT = /%[0-9A-Fa-f]{2}/;
const MAX_DECODE = 3; // 이중 인코딩까지는 풀되, 한없이 풀지 않는다

function normalizeServiceKey(raw) {
  if (raw == null) return raw;
  let k = String(raw).trim(); // 복붙 시 따라붙는 앞뒤 공백·개행 제거
  for (let i = 0; i < MAX_DECODE && PCT.test(k); i++) {
    let dec;
    try {
      dec = decodeURIComponent(k);
    } catch (e) {
      break; // 깨진 %XX 시퀀스 — 원문을 그대로 두고 상위가 판단하게 한다
    }
    if (dec === k) break;
    k = dec;
  }
  return k;
}

module.exports = { normalizeServiceKey };
