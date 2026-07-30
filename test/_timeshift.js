// test/_timeshift.js — 시계를 앞으로 돌려 "지금은 통과하지만 날짜가 지나면 조용히
// 무의미해지는" 픽스처를 잡는 preload.
//
// 왜 필요한가 (2026-07-30):
//   alerts.test.js가 bidEnd를 고정 날짜로 심어 두었다가 그 날이 지나자 물건이
//   "마감 지남"으로 걸러져 plans:0이 되고, 단언이 **실패도 아니고 그냥 무의미**해졌다.
//   더 나쁜 건 그 다음이다 — 같은 방식으로 시계를 +180일 돌렸더니 predict-daily가
//   **마감이 6개월 지난 물건 2,370건을 전부 봉인 대상으로 통과**시켰다. 테스트의
//   시한폭탄을 찾다가 프로덕션 버그(창 필터에 하한이 없음)를 찾은 것이다.
//
// 즉 이 스윕은 "테스트 위생"이 아니라 **시점 관련 로직 전반의 회귀 안전망**이다.
//   npm test          → 마지막에 +400일 스윕 1회 (test/run.js)
//   TIME_SHIFT_DAYS=N node -r test/_timeshift.js test/foo.test.js  → 개별 확인
const SHIFT = Number(process.env.TIME_SHIFT_DAYS || 0) * 86400000;
if (SHIFT) {
  const R = Date;
  const now = () => R.now() + SHIFT;
  class D extends R {
    constructor(...a) { if (a.length === 0) super(now()); else super(...a); }
    static now() { return now(); }
  }
  D.parse = R.parse; D.UTC = R.UTC;
  global.Date = D;
}
