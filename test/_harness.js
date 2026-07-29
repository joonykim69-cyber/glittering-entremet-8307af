// test/_harness.js — 이 리포의 최소 테스트 하니스 (의존성 0, Node 내장만).
//
// 왜 프레임워크를 안 쓰나: 이 사이트는 빌드도 번들러도 없는 정적 HTML + 서버리스 함수다.
//   테스트 때문에 jest/vitest와 그 트랜스파일 체인을 들여오면 저장소의 성격이 바뀐다.
//   필요한 건 "회귀를 잡는 안전망"이지 러너의 기능이 아니므로 40줄로 충분하다.
//
// 제공:
//   t(name, cond, extra)  단언 — 실패해도 계속 진행하고 마지막에 합계를 낸다
//   eq(name, got, want)   값 비교(JSON 동치)
//   done(label)           결과 출력 + 실패 시 exit 1
//   makeStore()           Netlify Blobs 대역(메모리) — global.__FAKE_STORE__에 꽂아 쓴다
//   mockFetch(routes)     fetch 목킹. routes = [[정규식, 응답객체|함수], ...]
//   fnPath(name)          netlify/functions/<name> 절대 경로

'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const fnPath = name => path.join(ROOT, 'netlify', 'functions', name);
const repoPath = (...p) => path.join(ROOT, ...p);

let total = 0, failed = 0;
const failures = [];

function t(name, cond, extra) {
  total++;
  if (!cond) {
    failed++;
    failures.push(name + (extra != null ? ` — ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : ''));
  }
}

function eq(name, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  t(name, a === b, a === b ? undefined : `got ${a}, want ${b}`);
}

function done(label) {
  for (const f of failures) console.log('  FAIL:', f);
  console.log(`${failed ? '✗' : '✓'} ${label}: ${total - failed}/${total}`);
  process.exit(failed ? 1 : 0);
}

// Netlify Blobs 대역 — 깊은 복사로 저장해 테스트가 저장된 객체를 몰래 바꾸지 못하게 한다
// (실제 Blobs는 직렬화되므로 참조 공유가 없다. 대역이 그것보다 관대하면 버그를 놓친다).
function makeStore(initial) {
  const m = new Map();
  const clone = v => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
  const store = {
    _m: m,
    async get(k) { return m.has(k) ? clone(m.get(k)) : null; },
    async setJSON(k, v) { m.set(k, clone(v)); },
    async set(k, v) { m.set(k, clone(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix } = {}) {
      const blobs = [];
      for (const k of m.keys()) if (!prefix || k.startsWith(prefix)) blobs.push({ key: k });
      return { blobs };
    },
    // 테스트에서 초기 상태를 심을 때 쓰는 동기 헬퍼
    seed(k, v) { m.set(k, clone(v)); return store; },
    keys(prefix) { return [...m.keys()].filter(k => !prefix || k.startsWith(prefix)); },
  };
  if (initial) for (const [k, v] of Object.entries(initial)) store.seed(k, v);
  return store;
}

/**
 * fetch 목킹. routes = [[RegExp, body|fn(url)], ...] — 첫 매칭 사용.
 * 매칭 실패는 예외가 아니라 404로 돌려준다(호출자의 degrade 경로를 그대로 시험하기 위해).
 * 반환값 .calls 에 호출된 URL이 순서대로 쌓인다(호출 횟수 단언용).
 */
function mockFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    const u = String(url);
    calls.push(u);
    for (const [re, body] of routes) {
      if (!re.test(u)) continue;
      const payload = typeof body === 'function' ? body(u) : body;
      return { ok: true, status: 200, async json() { return payload; }, async text() { return JSON.stringify(payload); } };
    }
    return { ok: false, status: 404, async json() { return {}; }, async text() { return ''; } };
  };
  fn.calls = calls;
  global.fetch = fn;
  return fn;
}

module.exports = { t, eq, done, makeStore, mockFetch, fnPath, repoPath, ROOT };
