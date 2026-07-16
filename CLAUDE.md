# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

A static site deployed on Netlify hosting two unrelated projects: **K-Map Linker / K-Buddy** (Korea-travel web apps) and **낙찰예보 (BidCast)** (an Onbid public-auction price-prediction prototype). There is no package.json, no build step, no test suite, and no linter. Each page is a single self-contained HTML file with all CSS and JavaScript inlined — keep it that way when editing; do not introduce bundlers, frameworks, or external JS files.

## Files

### K-Map Linker / K-Buddy

- `index.html` — Marketing/landing page for K-Map Linker (sections: hero, features, how, drama, reviews, download).
- `kmaplinker_web.html` — The main mobile-web app prototype. A vanilla-JS SPA with five tabs: Address, Subway, Discover, Drama Route, Travelers.
- `kbuddy.html` — K-Buddy, a fully offline mobile web app (views: address, food, travelers, drama). Views are static `<section class="view">` blocks toggled with the `is-active` class; no fetch calls at all.
- `netlify/functions/claude.js` — Serverless proxy for the Anthropic Messages API.
- `netlify/functions/onbid-search.js` — Serverless proxy for the 온비드(Onbid/KAMCO) auction-listing API, feeding `bidcast-list.html`. End Point is confirmed (`https://apis.data.go.kr/B010003/OnbidRlstListSrvc2`); see the BidCast real-data section below — **the exact operation path and response field names are still unconfirmed**.
- `netlify.toml` — Points Netlify at `netlify/functions` with the esbuild bundler.

### 낙찰예보 (BidCast)

An 11-page static prototype (`bidcast*.html`) for an Onbid auction winning-bid prediction service, benchmarking `yoiddang.co.kr`'s information architecture. Every page ships with **all example data clearly labeled** (예시 데이터 chips) — there is no backend, no real Onbid API call, and no persistence; "login" and "search" are client-side demos only.

- `bidcast.html` — Landing page. Hero, 3-step onboarding widget (`#onboarding`), asset-type quick search, example AI-forecast cards, mini accuracy/calendar previews, mock-bid simulation, insight teaser.
- `bidcast-list.html` — Product search: 6 mode tabs (경매검색/예정물건/신건/인기물건/인기검색/매각결과), court/region/price/fail-count/type filters, and an **AI report modal** (기본정보/종합분석/권리분석/적정가 분석 tabs) that blurs the recommended-bid figures until the demo login completes.
- `bidcast-detail.html` — Item detail page, reached from `bidcast-list.html` card titles via `?id=N`. Self-contained `DETAILS` demo dataset (ids match the list page's `ITEMS`); unknown/missing id falls back to item 1. Sections: photo hero + key facts, AI forecast card (blur-locked until demo login, same pattern as the report modal), 기본정보 table, 입찰 이력 timeline, 권리분석 요약, stylized location mock, 유사 물건 cards (same-type first). Intended to consume the separate "온비드 부동산 물건상세 조회 서비스" API later (`cltrMngNo`+`pbctCdtnNo`).
- `bidcast-lab.html` — Full accuracy-disclosure page (error-range distribution, per-asset-type accuracy, 3-model cross-verification explainer, monthly trend).
- `bidcast-calendar.html` — Full bidding calendar (weekday/monthly bid-count breakdown).
- `bidcast-map.html` — Stylized map mockup (CSS grid background + absolutely-positioned pins) — **no real map API key**; do not wire one in without asking.
- `bidcast-bot.html` — "예보봇" chat demo: preset Q&A plus a canned fallback response for free-text input.
- `bidcast-insight.html` — 부동산소식 + 전문가컬럼 merged into one page (kind tabs → category chips → article-detail modal).
- `bidcast-category.html` — Region/type/court 3-axis SEO template; hub view with no query params, leaf view via `?axis=region|type|court&value=...`.
- `bidcast-partner.html` — CPA partner-program landing with a revenue slider simulator and an accordion FAQ.
- `bidcast-support.html` — 8-tab support hub (공지/이벤트/FAQ/1:1문의/자유게시판/가이드/언론기사/제휴문의); tabs are addressable via URL hash (`bidcast-support.html#faq`).

## Development commands

There is nothing to build or test. To work locally:

```bash
# Static pages: open the HTML file directly, or serve the repo root
python3 -m http.server 8000

# To exercise the serverless functions locally (requires Netlify CLI):
ANTHROPIC_API_KEY=sk-... ONBID_SERVICE_KEY=... ONBID_API_URL=https://apis.data.go.kr/... netlify dev
```

Deployment happens through Netlify on push (the initial commit was created via Netlify). `ANTHROPIC_API_KEY`, `ONBID_SERVICE_KEY`, and `ONBID_API_URL` are configured in the Netlify dashboard, never in code.

## Architecture

### kmaplinker_web.html render engine

The app uses a hand-rolled mini-framework defined near the middle of the file:

- A single global `state` object; `setState(updates)` merges updates and triggers a full re-render.
- `h(tag, attrs, inner)` creates DOM elements (attrs starting with `on` become event listeners, `style` objects are assigned).
- `render()` rebuilds the active tab's content into `#tabContent`; each tab has its own render function (search for `── ADDRESS TAB ──`, `── SUBWAY TAB ──`, etc.).

Data is layered: an embedded offline `PLACE_DB` is checked first, then the Kakao Local API (`searchKakao`), then Claude as the AI fallback. Voice input uses the Web Speech API (`startVoiceRecognition`). UI strings go through `t(key)` with per-language tables in `T` — add new user-facing strings there, not inline.

### Claude API calls

`netlify/functions/claude.js` exists so the Anthropic key stays server-side: it accepts a POST with a Messages API payload, forces the model to `claude-haiku-4-5-20251001` (allowlist) and clamps `max_tokens` to ≤1500, then forwards to `api.anthropic.com` with CORS headers.

**Known inconsistency:** `kmaplinker_web.html`'s `callClaude()` still calls `api.anthropic.com` directly using a client-side `ANTHROPIC_KEY` constant (currently the placeholder `'YOUR_ANTHROPIC_API_KEY'`, next to a hardcoded `KAKAO_KEY`). Any new or modified AI feature should call the proxy at `/.netlify/functions/claude` instead of the Anthropic API directly, and migrating `callClaude()` to the proxy is the intended direction.

### bidcast-list.html search engine

`ITEMS` (`let`, not `const`) starts as a hardcoded example array (region/court/type/price/fail-count/tags) and is replaced in place by `loadRealItems()` on page load if `/.netlify/functions/onbid-search` returns usable data; on any failure (function not deployed, key not configured, API error, network error) it silently keeps the example array and updates the `#dataSourceChip` label to say so — the page must never break or show empty state just because live data isn't wired up yet. `applyFilters()` combines the active mode tab, active type chips, free-text query, and the five `<select>` filters, then calls `renderList()`. The AI report modal (`openReport(id)`) renders four tabs from `grade()`/`renderReport()`; the "advice" figures live inside `.rp-blur-wrap.locked`, which CSS-blurs until `userLoggedIn` flips true via the shared demo auth flow.

### onbid-search.js — real-data integration status

`netlify/functions/onbid-search.js` proxies data.go.kr's `한국자산관리공사_차세대 온비드 부동산 물건목록 조회서비스` v1.0.0 (Base URL `https://apis.data.go.kr/B010003/OnbidRlstListSrvc2`, operation `GET /getRlstCltrList2`), mirroring `claude.js`'s pattern (env-var key, CORS, clear 500 if unconfigured).

**Fully confirmed 2026-07-16** against the service's own Swagger spec (the user supplied the full data.go.kr page HTML, which has the swagger.json inlined) — request params, response field names, and code tables are all verified, not guessed:
- Required params: `serviceKey`, `pageNo`, `numOfRows`, `resultType` (must be `json`), `prptDivCd` (재산유형코드, comma-separated; `onbid-search.js` defaults to all 10 codes via `ALL_PRPT_DIV_CD` unless the caller passes one), `pvctTrgtYn` (수의계약가능여부 Y/N; defaults to `N`).
- Response item fields wired into `mapOnbidItem()`: `cltrMngNo`/`pbctCdtnNo` (identifiers), `onbidCltrNm` (title), `lctnSdnm`/`lctnSggnm`/`lctnEmdNm` (address, joined — there's no single full-address field), `orgNm` (announcing agency), `cltrUsgSclsCtgrNm` (usage sub-category, used for type bucketing), `apslEvlAmt` (appraisal amount), `lowstBidPrcIndctCont` (min bid price — a **string** that may read "비공개" instead of a number, so it's regex-parsed with a fallback to the appraisal amount), `usbdNft` (fail count), `pbctStatCd` (bid status code — `0010` = 낙찰, everything else maps to 진행), `thnlImgUrlAdr` (real thumbnail photo URL — passed through as `photo` after an http(s)-prefix check; `bidcast-list.html` renders it over the emoji `thumb` and falls back to the emoji via `onerror` when the image is missing or fails to load).
- Optional passthrough params wired: `lctnSdnm` (region) and `onbidCltrNm` (keyword). The front-end's `type` filter (아파트/토지/상가/차량/...) is **not** forwarded upstream — there's no confirmed usage-category code table, so type bucketing happens entirely in `mapOnbidItem()`'s `normalizeType()` after the fact, and `bidcast-list.html`'s `applyFilters()` does the actual bucket filtering client-side.

**Known scope limit (not a bug):** this API only covers 부동산 (real estate). It can populate the 아파트/토지/상가 buckets but will never return 차량/기계장비/유가증권 — those need a separate Onbid "동산" API that hasn't been requested or integrated. Items from those categories simply won't appear from live data until that's added.

**Still not integrated:** a separate "온비드 부동산 물건상세 조회 서비스" exists (referenced in this service's own description, looked up via `cltrMngNo`+`pbctCdtnNo`) for per-item detail — `bidcast-list.html`'s AI report modal still uses generated/example detail data, not live per-item detail.

**Also worth noting:** the demo `ITEMS` array's `court` field (e.g. "서울중앙지방법원") implies court-run judicial auctions (법원경매), but Onbid is KAMCO-run public auctions (공매) — real items populate `court` from `orgNm`/`rqstOrgNm` (공고기관명), which won't be district-court names. If this distinction matters for copy/labeling, it's worth revisiting once live data is flowing.

### Shared auth modal pattern

Every `bidcast-*.html` page repeats the same self-contained auth modal (`#authOverlay`, `openAuth()/closeAuth()/snsFlow()/finishAuth()/logoutDemo()`) rather than importing a shared component, per the single-file convention. It is a **pure front-end demo**: any SNS button or email code instantly "logs in" and swaps the nav-right buttons for a `.nav-user` badge — there is no real OAuth, email delivery, or session storage. Keep new pages consistent with this pattern rather than inventing a new auth UI.

## Conventions

- Comments and some UI copy are in Korean; the apps themselves are multilingual (language tables in each file). Preserve both.
- Section banners in the big HTML files use box-drawing/`═` comment dividers — follow that style when adding sections.
- Styling is plain CSS with custom properties defined in `:root` per file (each app has its own palette); reuse the existing variables rather than hardcoding colors.
- The mobile apps are built mobile-first with a fixed max-width shell (`max-width: 420–440px`) centered on desktop.
- **BidCast palette** ("night pedestrian-signal"): light neutral background (`--bg:#F6FAF7`), green accent (`--green:#00A86B`) for go/primary actions, red (`--red:#E5484D`) reserved for warnings — always paired with an icon/label, never color alone. All 11 `bidcast-*.html` pages share this token set and a standardized 7-item top nav (물건검색/지도/카테고리/적중률/캘린더/인사이트/예보봇); keep new BidCast pages' nav and footer in sync with the others rather than drifting.
- Every BidCast data point that isn't wired to a real API must carry a visible "예시 데이터" disclosure — this is a hard requirement from the legal-risk notes in the original product memo, not just a style choice.
