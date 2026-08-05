// test/sold-chip.test.js — 목록·캘린더 카드의 "낙찰 가능성" 칩.
// 지키려는 것:
//   ① 화면에 뜨는 숫자는 **봉인 장부에서만** 온다(클라이언트가 셀 통계로 다시 계산하지 않는다).
//      다시 계산하면 그건 채점받지 않는 숫자다 — "화면에 뜨는 숫자 = 채점받는 숫자" 규율.
//   ② 상세 Q0·목록·캘린더 **세 화면의 판정이 같다**. 단일 파일 자기완결 관례상 사본이
//      생기므로, 갈라지면 같은 물건을 두 화면이 다르게 말하게 된다(lawd.js 사본과 같은 처지).
//   ③ 근거가 없으면 아무것도 그리지 않는다(빈 칩·추측 금지).

'use strict';

const fs = require('fs');
const { t, eq, done, fnPath, repoPath } = require('./_harness');

const LIST = fs.readFileSync(repoPath('bidcast-list.html'), 'utf8');
const CAL = fs.readFileSync(repoPath('bidcast-calendar.html'), 'utf8');
const DETAIL = fs.readFileSync(repoPath('bidcast-detail.html'), 'utf8');
const CSS = fs.readFileSync(repoPath('bidcast.css'), 'utf8');

// ── ① 세 화면의 판정 함수를 소스에서 추출해 실제로 실행한다 ──
function grabFn(src, name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) return null;
  const end = src.indexOf('\n}', i);
  return end < 0 ? null : src.slice(i, end + 2);
}
const listFn = grabFn(LIST, 'soldTone');
const calFn = grabFn(CAL, 'soldToneC');
t('목록에 판정 함수 존재', !!listFn);
t('캘린더에 판정 함수 존재', !!calFn);

// 상세는 renderOutcome 안의 인라인 삼항식이라 식을 그대로 뽑아 실행한다.
const detailExpr = (DETAIL.match(/const tone=bl!=null\s*\n?\s*\?\(([\s\S]*?)\);\n/) || [])[0];
t('상세 Q0에 판정식 존재', !!detailExpr);

const toneList = new Function(`${listFn}; return soldTone;`)();
const toneCal = new Function(`${calFn}; return soldToneC;`)();
const toneDetail = new Function('v', 'bl', `${detailExpr} return tone;`);

// 기준선(bl)이 있는 경우와 없는 경우(옛 봉인 하위호환) 모두 훑는다.
const GRID = [];
for (const bl of [null, 1.6, 2.6, 44.5, 72.6]) {
  for (const v of [0, 0.5, 1.5, 1.6, 2, 3.2, 3.3, 20, 34, 35, 44.5, 59, 60, 89, 100]) GRID.push([v, bl]);
}
let mismatch = 0;
for (const [v, bl] of GRID) {
  const a = toneList(v, bl)[0], b = toneCal(v, bl)[0], c = toneDetail(v, bl)[0];
  if (!(a === b && b === c)) { mismatch++; if (mismatch <= 3) console.log('  ↳ 불일치 v=' + v + ' bl=' + bl, a, b, c); }
}
eq(`세 화면 판정 동치 (${GRID.length}조합)`, mismatch, 0);

// 판정 자체가 의도대로인지 — 기준선 대비가 핵심이다.
// 부동산 기준선 1.6%에서 2%는 '평균 수준'이어야 하고, 자동차 기준선 72.6%에서 2%는 '이하'여야 한다.
eq('부동산 2% (기준선 1.6) → 평균 이상 아님', toneList(2, 1.6)[1], '유형 평균 수준');
eq('부동산 4% (기준선 1.6) → 평균 이상', toneList(4, 1.6)[1], '유형 평균 이상');
eq('자동차 2% (기준선 72.6) → 평균 이하', toneList(2, 72.6)[1], '유형 평균 이하');
t('같은 2%가 자산군에 따라 다르게 읽힌다', toneList(2, 1.6)[0] !== toneList(2, 72.6)[0]);

// ── ② 봉인 값만 쓴다 ──
for (const [name, src] of [['목록', LIST], ['캘린더', CAL]]) {
  t(`${name} — 봉인 장부를 일괄 조회한다`, /scoreboard\?preds=/.test(src));
  t(`${name} — soldProb를 클라이언트가 계산하지 않는다`, !/soldRate/.test(src));
  t(`${name} — 봉인이 없으면 칩을 그리지 않는다`, /soldProb == null\) return ''|soldProb == null\) return ""/.test(src));
  t(`${name} — 조회 실패는 조용히 degrade(가짜 수치 금지)`, /\.catch\(\(\) => \{ \/\* [^*]*\*\/ \}\)/.test(src));
}

// ── ③ 빈 슬롯이 자리를 차지하지 않는다 ──
t('공용 CSS에 칩 컴포넌트', /\.sold-chip\{/.test(CSS));
t('빈 슬롯은 접힌다', /\.sold-slot:empty\{display:none\}/.test(CSS));

// ── ④ scoreboard 일괄 조회 ──
(async () => {
  const store = (() => {
    const m = new Map();
    return {
      _m: m,
      async get(k) { return m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : null; },
      async setJSON(k, v) { m.set(k, JSON.parse(JSON.stringify(v))); },
      set(k, v) { m.set(k, JSON.parse(JSON.stringify(v))); },
      async list({ prefix }) { const blobs = []; for (const k of m.keys()) if (k.startsWith(prefix)) blobs.push({ key: k }); return { blobs }; },
    };
  })();
  global.__FAKE_STORE__ = store;
  store.set('pred/A-1_0001', { lo: 100, mid: 120, hi: 140, soldProb: 3.2, soldBaseline: 1.6, outcomeN: 88, k: 1.1 });
  store.set('pred/B-2_0001', { lo: 200, mid: 220, hi: 240, soldProb: null, soldBaseline: 1.6, outcomeN: 0 });

  delete require.cache[require.resolve(fnPath('scoreboard.js'))];
  const sb = require(fnPath('scoreboard.js'));
  const r = await sb.handler({ httpMethod: 'GET', queryStringParameters: { preds: 'A-1_0001,B-2_0001,C-3_0001' } });
  const d = JSON.parse(r.body);

  eq('일괄 조회 200', r.statusCode, 200);
  t('봉인 있는 건 반환', !!d.preds['A-1_0001']);
  eq('  soldProb', d.preds['A-1_0001'].soldProb, 3.2);
  eq('  soldBaseline', d.preds['A-1_0001'].soldBaseline, 1.6);
  eq('  outcomeN', d.preds['A-1_0001'].outcomeN, 88);
  t('근거 부족(soldProb null)도 그대로 전달 — 지어내지 않는다', d.preds['B-2_0001'].soldProb === null);
  t('봉인 없는 키는 null', d.preds['C-3_0001'] === null);
  // 봉인 원본을 통째로 흘리지 않는다(응답 표면 최소화)
  t('가격 봉인값은 포함하지 않는다', !('lo' in d.preds['A-1_0001']) && !('mid' in d.preds['A-1_0001']));

  // 상한 — 카드가 아무리 많아도 한 번에 60건까지만
  const many = Array.from({ length: 120 }, (_, i) => `X-${i}_0001`).join(',');
  const r2 = await sb.handler({ httpMethod: 'GET', queryStringParameters: { preds: many } });
  eq('요청 상한 60건', Object.keys(JSON.parse(r2.body).preds).length, 60);

  // 주입 방어 — 키에 경로 문자가 섞여도 블롭 경로를 벗어나지 않는다
  const r3 = await sb.handler({ httpMethod: 'GET', queryStringParameters: { preds: '../../agg' } });
  const k3 = Object.keys(JSON.parse(r3.body).preds);
  t('경로 문자는 제거된다', k3.every(k => !k.includes('/') && !k.includes('.')), JSON.stringify(k3));

  delete global.__FAKE_STORE__;
  done('sold-chip (목록·캘린더 낙찰 가능성 칩)');
})().catch(e => { console.log('THROW', e); process.exit(1); });
