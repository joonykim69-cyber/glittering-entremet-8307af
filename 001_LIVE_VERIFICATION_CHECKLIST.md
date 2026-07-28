# 라이브 검증 체크리스트 (001)

> **왜 이 문서인가**: 개발환경 egress 정책이 배포 도메인(`sucessbid.netlify.app`)을 403 차단해,
> 여러 기능이 **구현·fixture 통과했지만 실호출은 미검증**인 상태로 남아 있습니다(헌장 이중 검증 원칙의
> 2차 = 실데이터 검증). 이 문서는 창업자가 프로덕션에서 **한 번에 훑어** 확인/버그 발견을 하도록
> 각 항목의 **확인 방법 · 정상 신호 · 실패 신호(degrade)** 를 정리합니다.
>
> - Base: `https://sucessbid.netlify.app`
> - 함수 호출: `https://sucessbid.netlify.app/.netlify/functions/<이름>?...`
> - 대부분 함수는 실패 시 **조용히 degrade**(예시 유지·섹션 숨김)하므로, "안 깨졌다"가 곧 "검증됨"은 아닙니다 — 아래 정상 신호를 눈으로 확인해야 합니다.
> - 마지막 갱신: 2026-07-28

---

## A. 온비드 공고 계열 — 실호출 미검증 (CLAUDE.md ②-b)

레지스트리 프록시 `onbid-svc`로 확인. `?svc=_health`가 전체 상태를, `?svc=<alias>&...`가 실응답을 반환.

- [ ] **전체 헬스** — `/.netlify/functions/onbid-svc?svc=_health`
  - 정상: 각 서비스가 `ok` / `endpoint_ok_params_needed`. 실패: `endpoint_missing`(Base URL 교정 필요) / `key_error`.
- [ ] **공고상세 입찰정보 `pbanc_dtl_bidinf`** — `?svc=pbanc_dtl_bidinf&pbancMngNo=<실공고번호>&debug=1`
  - pbancMngNo는 `cltr_dtl_bidinf` 응답에서 획득. 정상: 입찰정보 필드 반환. 실패: NODATA/에러 → op·Base 재확정.
- [ ] **코드/주소 `code_addr`** — `?svc=code_addr&debug=1` (용도코드/주소 조회)
- [ ] **동산 물건상세 `mvast_dtl`** — `?svc=mvast_dtl&cltrMngNo=<동산물건>&pbctCdtnNo=<>&debug=1`
- [ ] **차량 물건상세 `vhcl_dtl`** — `?svc=vhcl_dtl&cltrMngNo=<차량물건>&pbctCdtnNo=<>&debug=1`
  - 위 3종은 응답 필드명 확인 후 전용 매핑 프록시/UI 다듬기 (현재 주력 아님).

---

## B. 예측·채점 엔진

- [ ] **onbid-bidresults 낙찰금액 필드** — `/.netlify/functions/onbid-bidresults?cltrTypeCd=0001&stats=1&debug=1`
  - 코드는 낙찰금액을 `scfbAmt`로 매핑(주석 "2026-07-19 실 응답 확정")해 `winAmt`로 정규화. `debug=1`로 실응답에 `scfbAmt`(또는 다른 낙찰금액 필드)가 값을 갖는지 확인.
  - 정상: `stats.avgWinRate` 등이 0이 아닌 실수. 실패: winAmt가 0/미매핑 → 자동 채점이 조용히 스킵(오채점 위험 0, 수동 입력 degrade).
- [ ] **예언자 여정 자동 채점 `autoScoreLive`** — 마이페이지 `#prophet`에서 라이브 봉인(live+cltrMngNo) 후 "🎯 온비드 개찰 결과로 자동 채점" 클릭
  - 정상: 낙찰 행 조인→낙찰가 만원 환산→hit/errPct 채점. 실패: "개찰 완료된 라이브 봉인 못 찾음" → 수동 입력 유지.
- [ ] **봉인 예측 조회** — `/.netlify/functions/scoreboard?pred=<cltrMngNo>_<pbctCdtnNo>`
  - predict-daily가 봉인한 물건이어야 lo/hi 반환. 없으면 null(온디맨드 예측은 미구현).

---

## C. 외부 연동 (키는 설정됨 — 실동작·코드 확인만)

- [ ] **카카오맵 렌더** — 라이브 물건 상세(`bidcast-detail.html?id=<cltrMngNo>`)에서 "📍 지도 보기" 클릭 → F12 콘솔 `[map]` 로그
  - 정상: 지도 SDK 로드 + 주소 지오코딩 성공(핀 표시). 실패: 목업 유지 → 콘솔에서 도메인 미등록/키 오류/주소 실패 판별. **카카오 콘솔 플랫폼 Web에 `sucessbid.netlify.app` 등록 필수.**
- [ ] **카카오맵 지도검색 페이지** — `bidcast-map.html` (카카오 실패 시 Leaflet+OSM 자동 폴백)
- [ ] **ECOS CD·국고채 시리즈 코드** — `/.netlify/functions/ecos-svc?series=cd91,tb3y&debug=1`
  - 정상: 각 시리즈 최근값+추세. 실패: `INFO-200`(item 코드 오류) → `ECOS_SERIES_CD91`/`_TB3Y` env 교정. (기준금리 baseRate는 실호출 확정됨.)
- [ ] **RONE 지역 매칭** — `/.netlify/functions/rone-svc?region=부산&debug=1`
  - 정상: 소재 시도 매칭 시계열(`regionMatched:true`) 또는 전국 폴백. `RONE_STATBL_ID`(월 지역별 아파트 매매지수 통계표)는 Netlify env에 설정·확정됨(값은 CLAUDE.md 참조).
- [ ] **네이버 뉴스** — `bidcast-insight.html` 부동산소식 탭 / `/.netlify/functions/naver-news?query=부동산&debug=1`
  - 정상: 실뉴스 카드. 실패: 501 → 예시 유지(키 미설정 degrade).

---

## D. 시세 축 (market-est / RTMS)

- [ ] **market-est 실물건 밴드** — `/.netlify/functions/market-est?lawd=<시군구코드>&kind=apt&months=6&debug=1`
  - 정상: ㎡당 p25/p50/p75 + 표본수 + 신뢰도 등급. 표본 3건 미만이면 `status:'insufficient'`(정직 degrade).
  - **재검증 대상**: 물건 `2021-09579-010`에서 "주변 실거래" 미표시 이슈(용도 매핑 보강 PR #27 이후 라이브 재검증 안 됨).
- [ ] **RTMS 파서** — `/.netlify/functions/rtms-svc?svc=apt_trade_dev&lawdCd=<5자리>&dealYmd=202606&debug=1` (svc 별칭: apt_trade_dev·apt_rent·offi_trade·rh_trade·sh_trade·land_trade·nrg_trade·indu_trade)
  - 정상: `<item>`이 JSON 필드(aptNm/dealAmount/excluUseAr 등)로 파싱. 실패: `{item:"<원시XML>"}` 통짜(2026-07-26 파서 버그 — 이미 수정, 실호출로 재확인).
- [ ] **상세 페이지 시세 밴드 표시** — 주거 4종(아파트/오피스텔/연립다세대/단독) 라이브 물건 상세의 "주변 실거래" 섹션
  - 정상: ㎡당 p25~p75 밴드 + 신뢰도 배지 + AI 예상 구간 병기. `insufficient`면 범위 숨기고 거래만.
- [ ] **마진 위젯** — 상세 시세 카드에서 전용면적 입력 시 명목 마진 계산 + 유찰 3회↑/큰 마진 경고 표시 확인.
- [ ] **시세 시나리오 밴드(아파트)** — 아파트 물건 상세의 시세 카드 아래 "보유 기간별 예상 시세 시나리오"(6개월/1년/3년 × 보수/기준/낙관).
  - 정상: 부동산원 지수 연율 가정값 명시 + 표 렌더. 실패/비아파트/rone 무응답: 조용히 생략(degrade) — 정상 동작.

### D-2. 시세 봉인·채점 루프 ⑤ (2026-07-28 신규 — #151~#154)

순서대로 확인하면 파이프라인 전체가 검증됩니다(수집 → 정합도 → 봉인·채점 → 공개).

- [ ] **① RTMS 수집 진행** — `/.netlify/functions/collect-rtms?status=1`
  - 정상: `meta.records`가 실행마다 증가, `state.idx`가 `total`로 접근, 완료 시 `done:true`(서울 25구 × 주거 4종 × 24개월 ≈ 2,400 셀-월).
  - 참고: 임시 스케줄 `*/20`으로 자가 구동. **완료되면 netlify.toml에서 이 스케줄 제거**(커서 도달 후엔 no-op이라 무해).
- [ ] **② nowcast 정합도(백테스트)** — `/.netlify/functions/mkt-backtest?debug=1`
  - 정상: `summary.observations>0` + `overall.hitRate`/`medErrPct`. 수집 전이면 `status:'empty'`(정상 no-op).
- [ ] **③ 라이브 봉인·채점** — `/.netlify/functions/mkt-seal-daily?dry=1` (먼저 dry로 계산만 확인 → 이후 스케줄이 실제 봉인)
  - 정상: `sealed`(이번 달 새 봉인) + `noBasis`(표본 부족으로 미봉인) + `pending`(정답 대기). 재실행 시 `skippedExisting` 증가 = **봉인 불변 동작 확인**.
  - 채점은 봉인한 달의 **다음 달 실거래가 도착해야** 시작됩니다(첫 채점까지 최대 1~2개월 — 정상).
- [ ] **④ 랩 노출** — `bidcast-lab.html`의 "시세 추정 신뢰도" 섹션(`#mktSec`)
  - 정상: 실측이 생기면 섹션이 나타나고 봉인 성적/과거 정합도 표시. **실측 전에는 섹션이 안 보이는 게 정상**(가짜 수치 금지).
  - 확인 포인트: 낙찰가 적중률과 **별개 지표**임이 문구로 드러나는지, 백테스트에 "학습곡선 아님" 주석이 있는지.
- [ ] **⑤ scoreboard 필드** — `/.netlify/functions/scoreboard`
  - 정상: `marketData`(수집 진행)·`market`(봉인 채점, 표본 전엔 null)·`marketBacktest`(정합도)·`runs.mktSeal`/`runs.mktBacktest` 하트비트.

---

## E. 문서 파싱 (doc-extract)

- [ ] **실 온비드 PDF 추출** — 라이브 물건 상세 관련문서 행의 "📖 AI 정리" 클릭
  - 정상(텍스트형): 임대차/인수조건 등 항목 정리. 스캔본: "원문 열람" 정직 안내(OCR 날조 안 함). HWP: "PDF 아님" 안내.
  - 실측 사례: 서현동 보람코아(텍스트형 성공), 등촌동(스캔본). 기관별 혼재 → 여러 물건으로 표본 확인.
  - egress 차단으로 실 온비드 PDF는 미검증 — 실클릭으로 다운로드→%PDF 매직→파싱 경로 확인.

---

## F. 차세대 모델 (데이터 대기 — 별개 트랙)

- [ ] **GBDT v0.5 vs v0.8 백테스트** — 2025 백필 완료 후 자동 실행(#147 크론). `/.netlify/functions/scoreboard`의 `backtest`/`bt/summary`에서 `models.v08` vs `models.v05` 3단계 적중률·오차·폭 비교.
  - v0.8이 이기면 라이브 챌린저 채택 검토, 지면 v0.6·v0.7처럼 기각. **비교 확인 후 backtest 크론(`*/6`) 제거.**
- [ ] **2025 백필 진행** — `/.netlify/functions/collect-backfill?status=1` (records·oldest·newest·done). 완료(`done:true`) 시 sim-live 2025 확장·크론 제거.

---

## G. SEO (2026-07-28 신규 — #148)

- [ ] **sitemap/robots 접근** — `https://sucessbid.netlify.app/sitemap.xml` · `/robots.txt` 200 응답 확인.
- [ ] **Google Search Console 등록** — 사이트 등록 후 `sitemap.xml` 제출. category leaf(지역 17·유형 10)가 색인되는지 수주 후 확인.
- [ ] **canonical 검증** — 임의 페이지 소스에서 `<link rel="canonical">`이 자기 URL인지, category leaf(`?axis=region&value=...`)에서 쿼리 포함 canonical로 갱신되는지 확인.

---

### 검증 결과 기록법 (헌장 이중 검증 원칙)
확인한 항목은 `[x]`로 체크하고, **실패/버그 발견 시 CLAUDE.md의 해당 메모를 "미검증"→"확인됨" 또는 "버그: …"로 갱신**하세요. 스크린샷 확정 ≠ 작동 확정 — 정상 신호를 눈으로 본 것만 검증으로 칩니다.
