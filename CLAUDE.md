# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

A static site deployed on Netlify for **낙찰예보 (BidCast)** — an Onbid public-auction price-prediction service. There is no package.json, no build step, no test suite, and no linter. Each page is a single self-contained HTML file with all CSS and JavaScript inlined — keep it that way when editing; do not introduce bundlers, frameworks, or external JS files. (The repo previously also hosted the K-Map Linker/K-Buddy travel apps; those files were removed 2026-07-17.)

## Files

### Serverless functions

- `netlify/functions/claude.js` — Serverless proxy for the Anthropic Messages API, used by `bidcast-bot.html`'s free-text chat. Forces the model allowlist and clamps `max_tokens`; the key lives only in the `ANTHROPIC_API_KEY` env var.
- `netlify/functions/onbid-search.js` — Serverless proxy for the 온비드(Onbid/KAMCO) auction-listing API, feeding `bidcast-list.html`. End Point is confirmed (`https://apis.data.go.kr/B010003/OnbidRlstListSrvc2`); see the BidCast real-data section below — **the exact operation path and response field names are still unconfirmed**.
- `netlify/functions/onbid-detail.js` — Serverless proxy for the "온비드 부동산 물건상세 조회 서비스" (Base URL `https://apis.data.go.kr/B010003/OnbidRlstDtlSrvc2`, operation `GET /getRlstDtlInf2`, looked up by `cltrMngNo`+`pbctCdtnNo`). `ONBID_DETAIL_API_URL` is set in Netlify and `mapDetail()` is field-mapped against a live response (2026-07-18). Returns a clean 501 when the env var is unset. `bidcast-detail.html` calls this function asynchronously for live items and gracefully falls back to the sessionStorage snapshot on any failure.
- `netlify/functions/onbid-calendar.js` — Weekday bid-count aggregator for the landing page's calendar preview: queries the 부동산 list API once per weekday (Mon–Fri, `bidPrdYmdStart`=`bidPrdYmdEnd`=day, `numOfRows=1`) and returns each day's `totalCount`. KST-aware; rolls to next week on weekends; 10-min CDN cache header.
- `netlify/functions/onbid-mvast-search.js` — Proxy for the 온비드 **동산** (movable assets: 차량/기계장비/유가증권 등) 물건목록 조회서비스, mirroring `onbid-search.js`. **Pending env var**: `ONBID_MVAST_API_URL` (Base URL from the approved data.go.kr service page; returns clean 501 until set). Operation path defaults to `/getMvastCltrList2` (inferred from the 부동산 naming pattern — override via `ONBID_MVAST_API_OP` if wrong; verify with `?debug=1`). Response mapping is tolerant/assumed-analogous to 부동산 and marks items with `assetClass:'동산'`.
- `netlify/functions/onbid-mvast-detail.js` — Proxy for the 온비드 동산 물건상세 조회서비스 (`ONBID_MVAST_DETAIL_API_URL`, likely `https://apis.data.go.kr/B010003/OnbidMvastDtlSrvc2`; op default `/getMvastDtlInf2`, override via `ONBID_MVAST_DETAIL_API_OP`). Clean 501 until the env var is set. `bidcast-detail.html` routes live items with `assetClass:'동산'` here instead of `onbid-detail`.
- `netlify.toml` — Points Netlify at `netlify/functions` with the esbuild bundler. Also 302-redirects `/` to `/bidcast.html` with `force = true` (Netlify serves an existing file over a redirect without it).

### 낙찰예보 (BidCast)

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

**동산 (movable assets) integration — wired, pending env vars:** `onbid-mvast-search.js`/`onbid-mvast-detail.js` proxy the 동산 물건목록/물건상세 services (approved on data.go.kr). Until `ONBID_MVAST_API_URL`/`ONBID_MVAST_DETAIL_API_URL` are set in Netlify, they return 501 and the site behaves exactly as before (부동산-only). `bidcast-list.html`'s `loadRealItems()` fetches 부동산+동산 in parallel via `Promise.allSettled` and merges — a 동산 failure never breaks the 부동산 list; the `#dataSourceChip` says which sources are live. After setting the env vars, verify the guessed operation paths and response field names via `?debug=1` and adjust `ONBID_MVAST_API_OP`/mapping as needed.

**Detail API live:** the "온비드 부동산 물건상세 조회 서비스" (`/getRlstDtlInf2`) is proxied via `onbid-detail.js`, field-mapped against a live response (2026-07-18), and called asynchronously from `bidcast-detail.html` for live items (동산 items route to `onbid-mvast-detail`). `bidcast-list.html`'s AI report modal still uses generated/example detail data, not live per-item detail.

**Landing page (`bidcast.html`) live wiring:** the 3 AI-forecast cards load real items from `onbid-search` (photo-first, one unit per building via a `buildingKey` heuristic, `numOfRows=60` to survive 회차 dedupe) with the prediction block explicitly labeled 규칙 기반 예시; the weekly calendar preview loads real per-day counts from `onbid-calendar`. Both keep the hardcoded example markup as fallback and update their 예시 chips to 실시간 labels only on success.

**Also worth noting:** the demo `ITEMS` array's `court` field (e.g. "서울중앙지방법원") implies court-run judicial auctions (법원경매), but Onbid is KAMCO-run public auctions (공매) — real items populate `court` from `orgNm`/`rqstOrgNm` (공고기관명, e.g. 코리아신탁주식회사), which won't be district-court names. `bidcast-list.html` handles this by rebuilding the 기관 filter dropdown (`rebuildCourtOptions()`) from whatever dataset is active, so the options always match the data.

### Shared auth modal pattern

Every `bidcast-*.html` page repeats the same self-contained auth modal (`#authOverlay`, `openAuth()/closeAuth()/snsFlow()/finishAuth()/logoutDemo()`) rather than importing a shared component, per the single-file convention. It is a **pure front-end demo**: any SNS button or email code instantly "logs in" and swaps the nav-right buttons for a `.nav-user` badge — there is no real OAuth, email delivery, or session storage. Keep new pages consistent with this pattern rather than inventing a new auth UI.

## Conventions

- Comments and UI copy are in Korean; preserve that.
- Section banners in the big HTML files use box-drawing/`═` comment dividers — follow that style when adding sections.
- Styling is plain CSS with custom properties defined in `:root` per file; reuse the existing variables rather than hardcoding colors.
- **BidCast palette** ("night pedestrian-signal"): light neutral background (`--bg:#F6FAF7`), green accent (`--green:#00A86B`) for go/primary actions, red (`--red:#E5484D`) reserved for warnings — always paired with an icon/label, never color alone. All 14 `bidcast-*.html` pages share this token set and a standardized 7-item top nav (물건검색/지도/카테고리/적중률/캘린더/인사이트/예보봇); keep new BidCast pages' nav and footer in sync with the others rather than drifting.
- Every BidCast data point that isn't wired to a real API must carry a visible "예시 데이터" disclosure — this is a hard requirement from the legal-risk notes in the original product memo, not just a style choice.
