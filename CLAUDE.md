# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

A static site deployed on Netlify for **신호등옥션 (구 낙찰예보/BidCast, 2026-07-19 리브랜딩)** — an Onbid public-auction price-prediction service. There is a minimal root package.json **only for Netlify Functions dependencies** (`@netlify/blobs` — the prediction-ledger store); the site itself has no build step, no test suite, and no linter. Each page is a single self-contained HTML file with all CSS and JavaScript inlined — keep it that way when editing; do not introduce bundlers, frameworks, or external JS files. (The repo previously also hosted the K-Map Linker/K-Buddy travel apps; those files were removed 2026-07-17.)

## Files

### Serverless functions

- `netlify/functions/claude.js` — Serverless proxy for the Anthropic Messages API, used by `bidcast-bot.html`'s free-text chat. Forces the model allowlist and clamps `max_tokens`; the key lives only in the `ANTHROPIC_API_KEY` env var.
- `netlify/functions/onbid-search.js` — Serverless proxy for the 온비드(Onbid/KAMCO) auction-listing API, feeding `bidcast-list.html`. End Point is confirmed (`https://apis.data.go.kr/B010003/OnbidRlstListSrvc2`); see the BidCast real-data section below — **the exact operation path and response field names are still unconfirmed**.
- `netlify/functions/onbid-detail.js` — Serverless proxy for the "온비드 부동산 물건상세 조회 서비스" (Base URL `https://apis.data.go.kr/B010003/OnbidRlstDtlSrvc2`, operation `GET /getRlstDtlInf2`, looked up by `cltrMngNo`+`pbctCdtnNo`). `ONBID_DETAIL_API_URL` is set in Netlify and `mapDetail()` is field-mapped against a live response (2026-07-18). Returns a clean 501 when the env var is unset. `bidcast-detail.html` calls this function asynchronously for live items and gracefully falls back to the sessionStorage snapshot on any failure.
- `netlify/functions/onbid-calendar.js` — Weekday bid-count aggregator for the landing page's calendar preview: queries the 부동산 list API once per weekday (Mon–Fri, `bidPrdYmdStart`=`bidPrdYmdEnd`=day, `numOfRows=1`) and returns each day's `totalCount`. KST-aware; rolls to next week on weekends; 10-min CDN cache header.
- `netlify/functions/onbid-mvast-search.js` — Proxy for the 온비드 **동산** (movable assets: 차량/기계장비/유가증권 등) 물건목록 조회서비스, mirroring `onbid-search.js`. **Pending env var**: `ONBID_MVAST_API_URL` (Base URL from the approved data.go.kr service page; returns clean 501 until set). Operation path defaults to `/getMvastCltrList2` (inferred from the 부동산 naming pattern — override via `ONBID_MVAST_API_OP` if wrong; verify with `?debug=1`). Response mapping is tolerant/assumed-analogous to 부동산 and marks items with `assetClass:'동산'`.
- `netlify/functions/onbid-bidinfo.js` — Proxy for the "차세대 온비드 물건 입찰결과상세 조회서비스" (Base URL `https://apis.data.go.kr/B010003/OnbidCltrBidRsltDtlSrvc2`, op `GET /getCltrBidRsltDtl2` — **both confirmed from the user's approval page 2026-07-19**, 부동산·동산·자동차 커버, daily quota 1000): per-item 개찰 결과(낙찰/유찰/취소) 상세. **Pending env var** `ONBID_BIDINFO_API_URL`; response field names (esp. the `winAmt` 낙찰금액 candidates in `mapRound()`) are unconfirmed until first `?debug=1`. `bidcast-detail.html` calls it for live items and swaps the 입찰 이력 timeline to real rounds on success (snapshot kept on any failure).
- `netlify/functions/onbid-bidresults.js` — Proxy for the "차세대 온비드 물건 입찰결과목록 조회서비스" (Base URL `https://apis.data.go.kr/B010003/OnbidCltrBidRsltListSrvc2`, op `/getCltrBidRsltList2` — path verified via `_health`; request params confirmed from the data.go.kr 미리보기 spec 2026-07-19: `cltrTypeCd` 0001부동산/0002자동차/0003동산 is the key mandatory param, plus `opbdDtStart/End` 개찰일, `exctStatCd` 0003=개찰완료, `pbancYmdStart/End`, `onbidPbancNm`, `orgNm`). Defaults: 부동산+개찰완료+최근 90일; `resultCode 03 NODATA` returns an empty 200, not an error. Supports `?stats=1` returning `{count, avgWinRate, median…}` over 낙찰 rows — the intended feed for upgrading the 규칙 기반 예시 predictions to real 낙찰가율 statistics. **Response field names (esp. 낙찰금액) still unconfirmed** — check `?debug=1` on first data response.
- `netlify/functions/onbid-vhcl-search.js` — Proxy for the 온비드 **차량** 물건목록 조회서비스 (부동산·동산과 별개의 세 번째 자산군). Base URL/op are pattern-inferred defaults (`OnbidVhclListSrvc2` / `/getVhclCltrList2`) — **unverified**; override via `ONBID_VHCL_API_URL`/`ONBID_VHCL_API_OP` if `_health` says the guess is wrong. Items are marked `assetClass:'자동차'`, `type:'차량'`. Merged into `bidcast-list.html` as a third parallel source.
- `netlify/functions/onbid-svc.js` — **Registry proxy for ALL ~27 approved data.go.kr services** (the user's account has 36 approvals, 2026-07-14). `?svc=_list` shows the registry, `?svc=_health` pings every service (numOfRows=2) and classifies each as `ok` / `endpoint_ok_params_needed` / `endpoint_missing` / `key_error` — pattern-inferred Base URLs/ops are corrected per-service via `ONBID_SVC_<ALIAS>_URL`/`_OP` env vars (no redeploy needed). `?svc=<alias>` proxies any registered service with raw passthrough (`items`/`totalCount`/`body`). Use this to onboard new services: run `_health`, fix `endpoint_missing` aliases with the End Point from the approval page, then build dedicated mapped proxies/UI as needed.
- `netlify/functions/rtms-svc.js` — **국토교통부 실거래가(RTMS) 승인 서비스 10종 레지스트리 프록시** (시세 추정 축의 데이터 계층, 승인 2026-07-19: 아파트 매매상세/전월세/분양권, 오피스텔·연립다세대·단독다가구 매매, 단독다가구 전월세, 토지·상업업무용·공장창고 매매). Base `https://apis.data.go.kr/1613000/RTMSDataSvc<유형>`, op `/getRTMSDataSvc<유형>` — 10종 중 9종은 승인 페이지로 확정(2026-07-19), land_trade(토지 매매)만 패턴 유추(`?svc=_health`로 판정, `RTMS_SVC_<ALIAS>_URL/_OP`로 교정). 공통 필수 파라미터 `LAWD_CD`(법정동 앞 5자리)+`DEAL_YMD`(YYYYMM); 응답이 **XML뿐**이라 프록시가 `<item>`을 JSON으로 변환해 반환(1시간 CDN 캐시). 인증키는 `ONBID_SERVICE_KEY` 재사용(같은 data.go.kr 계정; 분리 필요 시 `RTMS_SERVICE_KEY`). 용도: 물건 주변 실거래 표시→현재 시세 추정→(추후) 부동산원 지수 기반 시나리오·수익 시뮬레이션.
- `netlify/functions/onbid-mvast-detail.js` — Proxy for the 온비드 동산 물건상세 조회서비스 (`ONBID_MVAST_DETAIL_API_URL`, likely `https://apis.data.go.kr/B010003/OnbidMvastDtlSrvc2`; op default `/getMvastDtlInf2`, override via `ONBID_MVAST_DETAIL_API_OP`). Clean 501 until the env var is set. `bidcast-detail.html` routes live items with `assetClass:'동산'` here instead of `onbid-detail`.
- `netlify/functions/predict-daily.js` — **예측 장부(Prediction Ledger) 봉인** scheduled function (KST 07:00 via netlify.toml cron `0 22 * * *` UTC; manual GET works too). Collects items closing within 오늘~+2일 (부동산+동산+차량), computes an interval [lo, mid, hi] from 캠코 용도별 낙찰가율 (앵커: 감정가×rto1, 최저가×rto2; width w from `calib`, default ±18%), and seals it into Netlify Blobs store `ledger` under `pred/{cltrMngNo}_{pbctCdtnNo}`. **Sealed predictions are never overwritten** — that immutability is the trust story. Items with no statistical basis are skipped (`noBasis`), not guessed.
- **모델 승격 검증 기준 (2026-07-20 사용자 확정)**: 절차 = 동일 물건 병행 봉인·개찰 전 봉인·동일 채점·전수 기록(자동). 판정 = 미리 고정된 3단계 체크포인트만 사용(수시 판정 금지 — 우연에 속는 것 방지): ① 조기 승격: 비교 100건 시점 승률 62% 이상 ② 표준 승격: 300건 시점 승률 55% 이상 + 세그먼트 붕괴 없음(어떤 용도·가격대도 챔피언 대비 적중률 10%p 이상 하락 금지) + 같은 적중률이면 평균 구간 폭이 좁을 것 ③ 조기 탈락: 200건 시점 승률 50% 이하. 승격/탈락 결정은 사람이 하고 chronicle에 기록. 보조 지표 avgWidthPct(낙찰가 대비 평균 구간 폭 %)를 agg/aggB에 누적 — "넓게 질러서 맞히기" 방지. 참고: 셀 통계 자격 minN=20, 보정 발동 20건과는 별개의 문턱.
- **챔피언/챌린저 이중 봉인 (2026-07-19 준비 완료)**: predict-daily는 hist/_cells가 존재하면 같은 물건에 v0.5 챌린저 예측(`predb/{id}_{cdtn}`, 최저가×lr 분위수 p10/p50/p90, 백오프 L3→L0·표본 20+, 회차≈유찰수+1 근사)을 병행 봉인. score-daily가 같은 낙찰가로 둘 다 채점해 `aggB`(적중률·오차·상대전적 headToHead)에 집계, scoreboard가 `challenger`로 노출. 학습 데이터가 없으면 챌린저는 조용히 생략 — 백필이 쌓이는 순간 자동으로 경쟁 시작.
- `netlify/functions/score-daily.js` — **자동 채점** scheduled function (KST 19:30, cron `30 10 * * *` UTC). Fetches last-3-days 개찰 결과 (3 asset classes × 2 pages via onbid-bidresults), joins with sealed predictions, grades 구간 적중 (lo≤낙찰가≤hi) + 중앙값 오차(%·만원), aggregates into `agg` (overall/가격대별/용도별/일별), and **calibrates** per-usage interval width w toward 95–98% hit rate (changes appended to `log` — the "모델이 학습하는 모습" feed). `scored/*` markers prevent double-grading; 유찰(0011)/취소(0012) conditions are closed out without grading.
- `netlify/functions/collect-history.js` — **예측 엔진 0단계: 학습 데이터 수집기** scheduled function (KST 20:10, cron `10 11 * * *` UTC; 수동 GET 지원, `?windows=N`). 온비드 입찰결과목록(3자산군)의 과거 개찰 이력을 7일 창 단위로 과거로 백필(기본 365일, `HIST_TARGET_DAYS`)한 뒤 신규분을 매일 증분 유지. Blobs `hist/{start}_{end}/{cltrTypeCd}`에 압축 레코드(낙찰 0010+유찰 0011만: 용도/회차/감정가/최저가/낙찰가/낙찰가율/입찰자수/개찰일), 커서는 `hist/_state`, 집계는 `hist/_meta`. 실행당 최대 6창×3자산군×5페이지로 일일 쿼터(1000) 내 유지. **v0.5 다차원 통계 엔진(용도×회차×가격대 분위수)과 "유사 사례 근거 제시"의 데이터셋** — 증분 창은 겹칠 수 있어 소비 측에서 `id_cdtn` 중복 제거 필요.
- `netlify/functions/agents.js` — **전문 에이전트 라우터 (A단계: expert/region/competition)**. POST {agent, item 스냅샷} → 서버가 봉인 예측(pred/predb)·캠코 용도/지역 통계·hist-stats 셀을 수집해 "확인된 데이터" 블록으로 직렬화 → claude.js 프록시(Haiku, max 700토큰) 호출 → Blobs `agent/{agent}/{id}_{cdtn}` 영구 캐시(물건·조건당 1회 생성). 시스템 프롬프트가 "데이터에 없는 사실 생성 금지·구간으로만·보장 표현 금지·특정 입찰가 추천 금지"를 강제, 역할별 면책 자동 부착. `bidcast-detail.html` 기본정보 탭의 "AI 전문가 분석" 섹션(라이브 물건 전용)이 호출. 설계 의도·로스터·원칙은 "전문 에이전트 시스템" 메모 참조.
- `netlify/functions/hist-stats.js` — **v0.5 다차원 통계 조회 API**: collect-history가 쌓은 hist/* 레코드를 자산군×용도×회차×가격대 4레벨 셀로 집계(hist/_cells 캐시, _meta.updatedAt 변경 시 재빌드)해 낙찰가율 분위수(p10~p90, 최저가 대비 lr/감정가 대비 wr)와 유찰율을 반환. `?type=&usage=&round=&tier=`(또는 lowMan) 백오프 조회(L3→L0, minN 기본 20), `?rebuild=1` 강제 재빌드, 데이터 없으면 `status:'empty'`. **v0.5 봉인 엔진과 "유사 사례 근거" UI의 공용 데이터 레이어** — 파라미터 없이 호출하면 데이터셋 요약.
- `netlify/functions/scoreboard.js` — Public GET returning the ledger scoreboard: `summary{n,hitRate,avgAbsErrPct}`, byTier/byUsage/daily, calib, learningLog, recent 20 graded examples, sealDays. 5-min CDN cache. This feeds the landing "살아있는 성적표" and the 랩 page (실측 — 예시 없음). **지표 체계: 구간 적중률(주력, 목표 95~98%) + 중앙값 오차 %·원화 병기 + 가격대별 분해** — point-accuracy claims like "99% 정확" are deliberately NOT made (사용자와 합의된 정직성 원칙, 2026-07-19).
- `netlify.toml` — Points Netlify at `netlify/functions` with the esbuild bundler; declares the two ledger cron schedules. Also 302-redirects `/` to `/bidcast.html` with `force = true` (Netlify serves an existing file over a redirect without it).

### 신호등옥션 (BidCast)

A 15-page static prototype (`bidcast*.html`) for an Onbid auction winning-bid prediction service, benchmarking `yoiddang.co.kr`'s information architecture. Every page ships with **all example data clearly labeled** (예시 데이터 chips) — there is no backend and "login" is a client-side demo only. The only persistence is `localStorage` (keys `bidcast:likes`, `bidcast:recent`, `bidcast:alerts`), shared between the list, detail, and my-page files for the 관심물건/최근 본 물건/알림 demo features.

- `bidcast.html` — Landing page. Hero, 3-step onboarding widget (`#onboarding`), asset-type quick search, example AI-forecast cards, mini accuracy/calendar previews, mock-bid simulation, insight teaser.
- `bidcast-list.html` — Product search: 6 mode tabs (경매검색/예정물건/신건/인기물건/인기검색/매각결과), court/region/price/fail-count/type filters, and an **AI report modal** (기본정보/종합분석/권리분석/적정가 분석 tabs) that blurs the recommended-bid figures until the demo login completes.
- `bidcast-detail.html` — Item detail page, reached from `bidcast-list.html` card titles via `?id=N`. Resolution order: demo id (1–9) → `DETAILS`; live id (cltrMngNo) → a `sessionStorage` snapshot (`bidcast:detail`) that the list page's `stashDetail()` writes on click, rendering real basic facts + photo immediately, then **asynchronously calls `/.netlify/functions/onbid-detail`** to enrich the page with 기본정보/감정평가/임대차 등 상세 데이터 (API 미연동 시 스냅샷 유지, 칩이 연동 상태 표시); otherwise falls back to item 1. Sections: photo hero + key facts, AI forecast card (blur-locked until demo login, same pattern as the report modal), 기본정보 table, 입찰 이력 timeline, 권리분석 요약, stylized location mock, 유사 물건 cards (same-type first).
- `bidcast-my.html` — 마이페이지: 관심물건 (hearts saved from list/detail via `bidcast:likes`), 추천 물건 (liked items' type/court/price를 규칙 기반 매칭하여 SUMMARY 내 유사 물건 추천 — "규칙 기반 추천 · 예시 데이터" 명시, 추천 이유 태그 표시, 매칭 점수 노출), 최근 본 물건 (recorded on detail-page views via `bidcast:recent`, capped at 12), and demo alert toggles (`bidcast:alerts`). Own `SUMMARY` dataset keyed by the shared demo ids; liked ids not in `SUMMARY` (e.g. from live data) are silently skipped. Linked from every page's footer 바로가기 column.
- `bidcast-lab.html` — Full accuracy-disclosure page (error-range distribution, per-asset-type accuracy, 3-model cross-verification explainer, monthly trend).
- `bidcast-calendar.html` — Full bidding calendar (weekday/monthly bid-count breakdown) plus a deadline-ordered 다가오는 입찰 물건 list whose rows link to `bidcast-detail.html?id=N` (own `SCHEDULE` dataset, ids match the shared demo ids).
- `bidcast-compare.html` — 비교함: side-by-side comparison of 2–3 items picked via three `<select>` slots or `?ids=1,7,5`. Own `ITEMS` dataset (shared demo ids). Highlights the unique lowest min-bid/appraisal ratio with a "할인폭 최대" chip (suppressed on ties), and blurs the AI forecast rows until the shared demo login. Entered from the list page's filter bar, the detail page's 유사물건 header (prefilled with current+similar ids), and the calendar's 바로가기 row.
- `bidcast-map.html` — Stylized map mockup (CSS grid background + absolutely-positioned pins) — **no real map API key**; do not wire one in without asking.
- `bidcast-bot.html` — "예보봇" chat: preset Q&A answers are canned (instant, no API cost); free-text input calls the shared `/.netlify/functions/claude` proxy (system prompt scopes it to Onbid/공매 topics and, when `?item=N` context is present, injects that item's facts) with a graceful fallback to a canned response on any failure (function not deployed, key not configured, API error, network error) — same degrade-gracefully pattern as `onbid-search.js`. All user input and live API output render through `appendMsg()`, which HTML-escapes and converts newlines to `<br>`; only hardcoded trusted strings (presets, the context chip) go through `appendMsgHTML()` unescaped. Accepts `?item=N` (shared demo ids) to open with an item-context chip and an item-specific greeting; entered from the detail page's AI card.
- `bidcast-simulator.html` — 입찰 시뮬레이터: five sliders (감정가/입찰가율/시세/LTV/금리) drive a real-time financial calc (낙찰가, 대출액, 취득세·경비 가정 1.5%+300만, 실투자금, 월이자, 안전마진, ROI) plus a rule-based briefing (explicitly labeled 규칙 기반, not AI). Scenarios save to `localStorage` (`bidcast:sims`, capped 10) with restore/delete. Prefill via `?appr=&ratio=&id=&title=` from the detail page's 모의 입찰해보기 CTA. Also includes 모의 경매 대전: rolls 3 random competitor bids (65–108% of 감정가, uniform) against the current 나의 입찰가 (최고가 wins), explicitly labeled as a random simulation rather than an AI prediction; win/loss record persists to `localStorage` (`bidcast:battle`). The engine was ported from a user-supplied HTML after review — its yoiddang CSS hotlinks, fake AI-agent branding, and fabricated stats were removed in the port.
- `bidcast-insight.html` — 부동산소식 + 전문가컬럼 merged into one page (kind tabs → category chips → article-detail modal).
- `bidcast-category.html` — Region/type/court 3-axis SEO template; hub view with no query params, leaf view via `?axis=region|type|court&value=...`.
- `bidcast-partner.html` — CPA partner-program landing with a revenue slider simulator and an accordion FAQ.
- `bidcast-pricing.html` — 요금제: 무료/프로(19,900원/월)/프리미엄(49,900원/월) 3단 카드, 월간·연간 토글 (연간 2개월 무료), 14항목 기능 비교표, FAQ 6문. "예시 요금제" disclosure. 모든 CTA는 공용 auth modal로 연결.
- `bidcast-support.html` — 8-tab support hub (공지/이벤트/FAQ/1:1문의/자유게시판/가이드/언론기사/제휴문의); tabs are addressable via URL hash (`bidcast-support.html#faq`).

## 전문 에이전트 시스템 (2026-07-20 사용자 승인 — 설계 의도 메모)

**왜 만들었나**: 사용자의 창업 취지는 "사용자가 스스로 공매 전문가로 성장하는 도구". 이를 위해 ① 여러 전문 분야의 분석을 사용자에게 근거로 제시하고 ② 그 분석을 수치 피처로 만들어 예측 정밀도를 높이려는 목적. 사용자가 직접 요청한 4분야(법률/부동산/뉴스·정보/지역) + Claude가 예측 기여도 기준으로 추가 제안해 승인받은 4종(경쟁 강도/매각조건 리스크/거시 금리/감사역) = 총 8종 로스터.

**절대 원칙 (수정 시에도 유지)**: 에이전트의 정성 분석은 **봉인된 예측을 직접 수정하지 않는다**. 반영 경로는 두 가지뿐 — (a) 사용자에게 근거로 표시, (b) 수치 피처화 → 챌린저 모델 → 봉인·채점 검증 통과 후 반영. 팩트가 없으면 생성하지 않고, 모든 출력에 역할별 면책 부착(특히 권리분석: 법률 자문 아님 — 변호사법 리스크로 명칭도 "권리분석 도우미" 사용).

**아키텍처**: `netlify/functions/agents.js` 라우터 1개에 에이전트 레지스트리(역할별 시스템 프롬프트 + 컨텍스트 빌더). 클라이언트가 물건 스냅샷을 POST → 서버가 봉인 예측(pred/predb)·캠코 통계·hist-stats 셀 등 실데이터를 추가 수집 → claude.js 프록시(Haiku) 호출 → Blobs `agent/{agent}/{id}_{cdtn}` 캐시(물건·조건당 1회 생성, 비용 통제).

**로스터·단계**: A(구현됨 2026-07-20) ①부동산 전문가(종합분석) ②지역 전문가(지역 브리핑) ⑤경쟁 강도(유찰·관심순위·유찰율 근거) / B ③권리분석 도우미(공고상세 연동 시 강화) / C ④뉴스(RSS 크론)+⑦거시 금리 워처(ECOS 키 필요) / D ⑥매각조건 리스크(공고 본문 텍스트 피처, 공고상세 End Point 필요) / E ⑧감사역(주간 채점 감사→chronicle에 개선 제안 기록, 채택은 사람이 결정).

## 보류 중인 작업 (사용자 지시로 연기 — 2026-07-19)

- **주변 실거래/시세 추정 기능 마무리** — 사용자가 "나중에 적용"으로 보류. 현재 상태: `rtms-svc.js` 10종 전부 `_health` ok 확인, `bidcast-detail.html`에 "주변 실거래" 섹션 배포됨(조건 미충족 시 자동 숨김이라 무해). 남은 일: ① 군 단위 법정동코드 확장(현재 수도권·광역시 전체+주요 시 181건만), ② 섹션 실물건 표시 검증(사용자 물건 2021-09579-010에서 미표시 — 용도 매핑 보강 PR #27 이후 재검증 안 됨), ③ 시뮬레이터 "예상 시세" 슬라이더에 추정치 자동 주입, ④ 부동산원 가격지수 연동(활용신청 필요) → 6개월~3년 보수/기준/낙관 시나리오 밴드, ⑤ 시세 추정 봉인·채점 루프 편입.
- **AI 리포트 모달 실물화** — 리포트 페이지 정리는 사용자가 다시 이야기할 때까지 보류. 합의된 순서: 적정가 분석 탭→봉인 엔진 연결, 기본정보·감정평가 탭→상세 API, 종합분석→claude.js 생성, 권리분석은 데이터 없어 예시 유지.
- **랩 페이지 실측화** — score-daily 채점 데이터가 며칠 쌓인 뒤 진행.
- **목록 회차(공매조건) 정렬 개선** — 사용자 물건 2022-0100-002855에서 감정가(2.6억)<최저가(3.7억) 표시: 온비드가 같은 물건을 회차별 행으로 반환하는데 dedupe가 첫 행을 취해 가격 조합이 어긋날 수 있음. 최신 공매조건 우선 선택으로 교정 필요 (사용자 지시로 연기).

## API 연동 대기 기능 (기능 ← 필요 API 매핑, 2026-07-20 정리)

각 기능이 어떤 API/키를 기다리는지의 역방향 색인. 연동되는 즉시 해당 기능을 진행할 것.

**① 온비드 endpoint_missing — 승인 페이지 End Point 스크린샷만 있으면 즉시 등록** (`ONBID_SVC_<ALIAS>_URL` 설정, 재배포 불필요):
- **공고상세 3종**(pbanc_dtl/pbanc_dtl_cltr/pbanc_dtl_bidinf) ← 최우선. 잠금 해제되는 기능: 권리분석 도우미 강화(공고 유의사항 팩트), 매각조건 리스크 에이전트(D단계, 명도책임·점유·일괄매각 텍스트 피처), 리포트 공고 원문 탭, LLM 텍스트 피처(엔진 4단계)
- 물건상세 입찰정보(cltr_dtl_bidinf) ← 보증금율·입찰방식 상세 (상세 페이지 보증금 "통상 10% 가정" 실측화)
- 코드/주소 조회(code_addr) ← 법정동코드 자동화 (주변 실거래의 군 단위 커버리지 확장 대체 수단)
- 유가증권 상세(scrt_dtl), 정부재산 4종(gov_*), 수탁(trust_nbiz), 국유입찰대상(ntnl_bidtrgt) ← 물건 커버리지 확장 (낮은 우선순위)

**② 연동됐지만 검증 대기** (외부 절차 불필요, 배포 환경 `?debug=1` 첫 응답만 필요):
- 차량 물건상세(vhcl_dtl / OnbidCarDtlSrvc2): 경로 유효 확인됨, 필드 매핑 미착수 ← 차량 상세 페이지 연식·주행거리 표시
- 동산 물건상세(onbid-mvast-detail) op 경로: 첫 동산 상세 호출로 검증

**③ 외부 키/신청 필요** (사용자 발급 절차):
- **한국은행 ECOS API 키** ← 거시·금리 워처 에이전트(⑦): 기준금리·대출금리 국면 피처 + 인사이트 브리핑
- **네이버 뉴스 검색 API 키**(무료) ← 뉴스 에이전트(④)의 지역·물건 키워드 뉴스. RSS 수집 크론은 키 없이 선행 가능
- **한국부동산원 R-ONE 가격지수** 활용신청 ← 시세 6개월~3년 보수/기준/낙관 시나리오 밴드 (시세 축 4단계)
- (보류) 지도 API 키(카카오/네이버) ← 실지도. Leaflet+OSM 무키 대안 있음. onbid.co.kr 키 도용 금지
- (보류·상용) 중고차 시세 DB(엔카 등) ← 차량 시세 근거. 공공 대안 검토 선행

**④ 확보 완료, 기능 보류 중**: RTMS 실거래가 10종 (전부 _health ok) ← 시세 축 재개 시 "보류 중인 작업" 참조

## Development commands

There is nothing to build or test. To work locally:

```bash
# Static pages: open the HTML file directly, or serve the repo root
python3 -m http.server 8000

# To exercise the serverless functions locally (requires Netlify CLI):
ANTHROPIC_API_KEY=sk-... ONBID_SERVICE_KEY=... ONBID_API_URL=https://apis.data.go.kr/... netlify dev
```

Deployment happens through Netlify on push (the initial commit was created via Netlify). All secrets/endpoints are configured in the Netlify dashboard, never in code: `ANTHROPIC_API_KEY`, `ONBID_SERVICE_KEY`, `ONBID_API_URL`, `ONBID_DETAIL_API_URL` (set), and `ONBID_MVAST_API_URL`, `ONBID_MVAST_DETAIL_API_URL` (+ optional `ONBID_MVAST_API_OP`/`ONBID_MVAST_DETAIL_API_OP` operation-path overrides) for the 동산 services (pending).

## Architecture

### Claude API calls

`netlify/functions/claude.js` exists so the Anthropic key stays server-side: it accepts a POST with a Messages API payload, forces the model to `claude-haiku-4-5-20251001` (allowlist) and clamps `max_tokens` to ≤1500, then forwards to `api.anthropic.com` with CORS headers. Any new or modified AI feature must call this proxy, never the Anthropic API directly from client code.

### bidcast-list.html search engine

`ITEMS` (`let`, not `const`) starts as a hardcoded example array (region/court/type/price/fail-count/tags) and is replaced in place by `loadRealItems()` on page load if `/.netlify/functions/onbid-search` returns usable data; on any failure (function not deployed, key not configured, API error, network error) it silently keeps the example array and updates the `#dataSourceChip` label to say so — the page must never break or show empty state just because live data isn't wired up yet. `applyFilters()` combines the active mode tab, active type chips, free-text query, and the five `<select>` filters, then calls `renderList()`. The AI report modal (`openReport(id)`) renders four tabs from `grade()`/`renderReport()`; the "advice" figures live inside `.rp-blur-wrap.locked`, which CSS-blurs until `userLoggedIn` flips true via the shared demo auth flow.

### onbid-search.js — real-data integration status

`netlify/functions/onbid-search.js` proxies data.go.kr's `한국자산관리공사_차세대 온비드 부동산 물건목록 조회서비스` v1.0.0 (Base URL `https://apis.data.go.kr/B010003/OnbidRlstListSrvc2`, operation `GET /getRlstCltrList2`), mirroring `claude.js`'s pattern (env-var key, CORS, clear 500 if unconfigured).

**Fully confirmed 2026-07-16** against the service's own Swagger spec (the user supplied the full data.go.kr page HTML, which has the swagger.json inlined) — request params, response field names, and code tables are all verified, not guessed:
- Required params: `serviceKey`, `pageNo`, `numOfRows`, `resultType` (must be `json`), `prptDivCd` (재산유형코드, comma-separated; `onbid-search.js` defaults to all 10 codes via `ALL_PRPT_DIV_CD` unless the caller passes one), `pvctTrgtYn` (수의계약가능여부 Y/N; defaults to `N`).
- Response item fields wired into `mapOnbidItem()`: `cltrMngNo`/`pbctCdtnNo` (identifiers), `onbidCltrNm` (title), `lctnSdnm`/`lctnSggnm`/`lctnEmdNm` (address, joined — there's no single full-address field), `orgNm` (announcing agency), `cltrUsgSclsCtgrNm` (usage sub-category, used for type bucketing), `apslEvlAmt` (appraisal amount), `lowstBidPrcIndctCont` (min bid price — a **string** that may read "비공개" instead of a number, so it's regex-parsed with a fallback to the appraisal amount), `usbdNft` (fail count), `pbctStatCd` (bid status code — `0010` = 낙찰, everything else maps to 진행), `thnlImgUrlAdr` (real thumbnail photo URL — passed through as `photo` after an http(s)-prefix check; `bidcast-list.html` renders it over the emoji `thumb` and falls back to the emoji via `onerror` when the image is missing or fails to load), `cltrBidBgngDt`/`cltrBidEndDt` (bid period, yyyyMMddHHmm strings — passed through as `bidStart`/`bidEnd`). Request also passes through `bidPrdYmdStart`/`bidPrdYmdEnd` (yyyyMMdd bid-period search window, Swagger-confirmed) — used by `onbid-calendar.js`.
- **Verified against live traffic 2026-07-17:** this API does **NOT** use data.go.kr's usual `{ response: { header, body } }` envelope — `header`/`body` sit at the **top level**. The parser resolves `raw.response ?? raw` to accept both. Also required-in-practice params `dspsMthodCd` (0001=매각) and `bidDivCd` (0001=인터넷) are sent by default (the Swagger marks them optional but the 활용가이드 request table marks them 필수). The same item recurs as one row per 공매조건(회차); the proxy dedupes by `cltrMngNo`, keeping the first row. A `?debug=1` query flag makes the function include the effective params and the raw upstream body's first 800 chars in its response — used for live debugging since the Netlify free plan hides preview function logs.
- Optional passthrough params wired: `lctnSdnm` (region — the function maps the front-end's short names 서울/경기/... to the full 시도명 the API expects) and `onbidCltrNm` (keyword). `bidcast-list.html` re-queries the API when the region select or search box changes while in live mode (450ms debounce on typing, stale responses discarded via a sequence counter); a re-query failure keeps the current list, and only the *initial* load falls back to demo data. The front-end's `type` filter (아파트/토지/상가/차량/...) is **not** forwarded upstream — there's no confirmed usage-category code table, so type bucketing happens entirely in `mapOnbidItem()`'s `normalizeType()` after the fact, and `bidcast-list.html`'s `applyFilters()` does the actual bucket filtering client-side.

**동산 (movable assets) integration — 목록 LIVE (2026-07-19):** `onbid-mvast-search.js` proxies the 동산 물건목록 service — Base URL `https://apis.data.go.kr/B010003/OnbidMvastListSrvc2`, operation `/getMvastCltrList2` **verified against a live response** (the pattern-inferred guess was correct; ~3,200 items). Response fields are the same family as 부동산 (`cltrMngNo`/`onbidCltrNm`/`cltrUsgSclsCtgrNm`/`apslEvlAmt`/`cltrBidBgngDt|EndDt`/`thnlImgUrlAdr`…), plus 동산-specific ones (`prptDivNm` e.g. 불용품, `bidDivNm` 전자입찰). **Some 동산 items legitimately have `apslEvlAmt`=0** (e.g. school 불용품) — `bidcast-list.html`'s `fmtWon()` renders 0 as "미공개". Env vars must be identical across ALL deploy contexts (a wrong Deploy-Previews-only value cost a debugging round — production had List, previews had Dtl). `bidcast-list.html`'s `loadRealItems()` fetches 부동산+동산 in parallel via `Promise.allSettled` and merges — a 동산 failure never breaks the 부동산 list; the `#dataSourceChip` says which sources are live. The 동산 **상세** proxy (`onbid-mvast-detail.js`, op guess `/getMvastDtlInf2`) is wired but its operation path is **not yet verified** — check `?debug=1` on first use from a 동산 detail page.

**Detail API live:** the "온비드 부동산 물건상세 조회 서비스" (`/getRlstDtlInf2`) is proxied via `onbid-detail.js`, field-mapped against a live response (2026-07-18), and called asynchronously from `bidcast-detail.html` for live items (동산 items route to `onbid-mvast-detail`). `bidcast-list.html`'s AI report modal still uses generated/example detail data, not live per-item detail.

**Landing page (`bidcast.html`) live wiring:** the 3 AI-forecast cards load real items from `onbid-search` (photo-first, one unit per building via a `buildingKey` heuristic, `numOfRows=60` to survive 회차 dedupe) with the prediction block explicitly labeled 규칙 기반 예시; the weekly calendar preview loads real per-day counts from `onbid-calendar`. Both keep the hardcoded example markup as fallback and update their 예시 chips to 실시간 labels only on success.

**Also worth noting:** the demo `ITEMS` array's `court` field (e.g. "서울중앙지방법원") implies court-run judicial auctions (법원경매), but Onbid is KAMCO-run public auctions (공매) — real items populate `court` from `orgNm`/`rqstOrgNm` (공고기관명, e.g. 코리아신탁주식회사), which won't be district-court names. `bidcast-list.html` handles this by rebuilding the 기관 filter dropdown (`rebuildCourtOptions()`) from whatever dataset is active, so the options always match the data.

### Shared auth modal pattern

Every `bidcast-*.html` page repeats the same self-contained auth modal (`#authOverlay`, `openAuth()/closeAuth()/snsFlow()/finishAuth()/logoutDemo()`) rather than importing a shared component, per the single-file convention. It is a **pure front-end demo**: any SNS button or email code instantly "logs in" and swaps the nav-right buttons for a `.nav-user` badge — there is no real OAuth, email delivery, or session storage. Keep new pages consistent with this pattern rather than inventing a new auth UI.

## Conventions

- Comments and UI copy are in Korean; preserve that.
- Section banners in the big HTML files use box-drawing/`═` comment dividers — follow that style when adding sections.
- Styling is plain CSS with custom properties defined in `:root` per file; reuse the existing variables rather than hardcoding colors.
- **BidCast palette** ("night pedestrian-signal"): light neutral background (`--bg:#F6FAF7`), green accent (`--green:#00A86B`) for go/primary actions, red (`--red:#E5484D`) reserved for warnings — always paired with an icon/label, never color alone. All 15 `bidcast*.html` pages share this token set and a standardized 7-item top nav (물건검색/지도/카테고리/적중률/캘린더/인사이트/예보봇); keep new BidCast pages' nav and footer in sync with the others rather than drifting.
- **디자인 시스템 v2 (2026-07-19, 클로드 디자인 병합)**: `bidcast.html`(랜딩)은 클로드 디자인 시안을 그대로 채택한 새 레이아웃(히어로 칸반 목업, STOP/READY/GO, 파란 파이널 CTA 밴드). 공통 요소는 **타이포 Nunito(제목)/Poppins+Noto Sans KR(본문, Google Fonts)** 와 **가로형 3도트 신호등 로고**(#EB763C/#FFC000/#27A857) — 나머지 14페이지에는 `</head>` 직전의 "디자인 시스템 v2 공통 오버라이드" `<style>` 블록으로 전파되어 있음(마크업 무변경, `.logo-mark` CSS 오버라이드). 새 페이지를 만들면 이 블록을 같이 넣을 것. 디자인 원본은 claude.ai/design 프로젝트 "웹서비스 랜딩 페이지 디자인".
- Every BidCast data point that isn't wired to a real API must carry a visible "예시 데이터" disclosure — this is a hard requirement from the legal-risk notes in the original product memo, not just a style choice.
