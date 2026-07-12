# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

A static site deployed on Netlify for **K-Map Linker / K-Buddy**, a set of Korea-travel web apps. There is no package.json, no build step, no test suite, and no linter. Each page is a single self-contained HTML file with all CSS and JavaScript inlined — keep it that way when editing; do not introduce bundlers, frameworks, or external JS files.

## Files

- `index.html` — Marketing/landing page for K-Map Linker (sections: hero, features, how, drama, reviews, download).
- `kmaplinker_web.html` — The main mobile-web app prototype. A vanilla-JS SPA with five tabs: Address, Subway, Discover, Drama Route, Travelers.
- `kbuddy.html` — K-Buddy, a fully offline mobile web app (views: address, food, travelers, drama). Views are static `<section class="view">` blocks toggled with the `is-active` class; no fetch calls at all.
- `netlify/functions/claude.js` — Serverless proxy for the Anthropic Messages API.
- `netlify.toml` — Points Netlify at `netlify/functions` with the esbuild bundler.

## Development commands

There is nothing to build or test. To work locally:

```bash
# Static pages: open the HTML file directly, or serve the repo root
python3 -m http.server 8000

# To exercise the serverless function locally (requires Netlify CLI):
ANTHROPIC_API_KEY=sk-... netlify dev
```

Deployment happens through Netlify on push (the initial commit was created via Netlify). The `ANTHROPIC_API_KEY` environment variable is configured in the Netlify dashboard, never in code.

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

## Conventions

- Comments and some UI copy are in Korean; the apps themselves are multilingual (language tables in each file). Preserve both.
- Section banners in the big HTML files use box-drawing/`═` comment dividers — follow that style when adding sections.
- Styling is plain CSS with custom properties defined in `:root` per file (each app has its own palette); reuse the existing variables rather than hardcoding colors.
- The mobile apps are built mobile-first with a fixed max-width shell (`max-width: 420–440px`) centered on desktop.
