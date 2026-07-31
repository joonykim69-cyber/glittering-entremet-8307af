// netlify/functions/lib/histrange.js
// 수집된 학습 데이터의 **실제 범위**를 읽어 백테스트 단계·모의 라이브 재생 월을 만든다.
//
// 왜 필요한가: backtest.js의 STAGES와 sim-live.js의 재생 월이 2026년 1~6월로 **하드코딩**돼
//   있었다. 그래서 collect-backfill이 2025년까지 범위를 넓혀도 두 하니스는 6개월만 돌았고,
//   넓힌 데이터를 쓰려면 사람이 코드·env를 고쳐야 했다 — 수집이 끝났는지 지켜보다가
//   손으로 따라가는 구조는 언젠가 잊힌다(실제로 2025 확장 지시 후 나흘째 그 상태였다).
//   여기서는 `hist/feat/{start}_{end}/{type}` 창 키에서 범위를 직접 읽는다. 메타(`hist/_bfmeta`)가
//   아니라 **디스크에 실제로 있는 창**을 근거로 삼는 이유는, 메타는 초기화 시점 값이 남아
//   낡을 수 있기 때문이다(실제로 `_bfmeta.range`가 2025 수집 중에도 2026을 가리키고 있었다).
//
// 반쪽 달은 버린다: 창 경계가 달 경계와 어긋나면(예: 20250206부터 수집됨) 그 달은 일부만
//   있는데, 그걸 한 달처럼 채점하면 그 달의 성적이 거짓이 된다. 온전한 달만 쓴다.

'use strict';

const ym = s => String(s || '').slice(0, 6);

function addMonths(m, n) {
  let y = +m.slice(0, 4), mm = +m.slice(4, 6) - 1 + n;
  y += Math.floor(mm / 12); mm = ((mm % 12) + 12) % 12;
  return `${y}${String(mm + 1).padStart(2, '0')}`;
}
const nextMonth = m => addMonths(m, 1);
const prevMonth = m => addMonths(m, -1);
const firstDayOf = m => m + '01';
function lastDayOf(m) {
  const y = +m.slice(0, 4), mm = +m.slice(4, 6);
  return m + String(new Date(Date.UTC(y, mm, 0)).getUTCDate()).padStart(2, '0');
}
const prevMonthLastDay = m => lastDayOf(prevMonth(m));
function enumMonths(a, b) { const out = []; let c = a; while (c <= b) { out.push(c); c = nextMonth(c); } return out; }
const ymLabel = m => `${m.slice(0, 4)}.${m.slice(4, 6)}`;
const rangeLabel = ms => (ms.length ? (ms.length === 1 ? ymLabel(ms[0]) : `${ymLabel(ms[0])}~${ymLabel(ms[ms.length - 1])}`) : '');

// 창 키 목록 → 온전한 달 목록. keys = ['hist/feat/20250101_20250107/0001', ...]
function monthsFromKeys(keys) {
  let lo = null, hi = null;
  for (const k of keys || []) {
    const m = /(\d{8})_(\d{8})/.exec(k);
    if (!m) continue;
    if (lo === null || m[1] < lo) lo = m[1];
    if (hi === null || m[2] > hi) hi = m[2];
  }
  if (!lo || !hi) return { months: [], dataStart: null, dataEnd: null };
  const firstFull = lo.slice(6) === '01' ? ym(lo) : nextMonth(ym(lo));   // 반쪽 첫 달 버림
  const lastFull = hi === lastDayOf(ym(hi)) ? ym(hi) : prevMonth(ym(hi)); // 반쪽 끝 달 버림
  return { months: firstFull <= lastFull ? enumMonths(firstFull, lastFull) : [], dataStart: lo, dataEnd: hi };
}

// 확장 창(expanding window) walk-forward 단계 계획.
//   단계 수 S = min(3, N-1) — 달이 적으면 단계를 줄인다(없는 시험 블록을 만들지 않는다).
//   학습 절단점은 N의 1/6·1/2·5/6 지점 — **N=6이면 1·3·5**가 되어 기존(1월/1~3월/1~5월
//   학습)과 정확히 같다. 범위가 넓어지면 같은 비율로 함께 늘어난다.
//   시험 블록은 절단점 **직후 최대 testMonths개월**로 제한한다. 전 구간을 시험하면 한 번의
//   실행이 수개월치 블롭을 읽어야 해 함수 시간 한도를 넘고, 적중률 추정에는 두 달이면
//   표본이 충분하다(현재 단계당 n≈2,000~3,500).
function planStages(months, opts) {
  const N = (months || []).length;
  const testMonths = (opts && opts.testMonths) || 2;
  const S = Math.min((opts && opts.maxStages) || 3, N - 1);
  if (S < 1) return [];
  const fr = S === 3 ? [1 / 6, 1 / 2, 5 / 6] : S === 2 ? [1 / 3, 2 / 3] : [1 / 2];
  const cuts = [];
  fr.forEach((f, i) => {
    let c = Math.round(N * f);
    c = Math.max(c, (cuts[i - 1] || 0) + 1); // 엄격 증가(학습이 실제로 늘어나야 한다)
    c = Math.min(c, N - (S - i));            // 뒤 단계들이 쓸 달을 남긴다
    cuts.push(c);
  });
  return cuts.map((c, i) => {
    const train = months.slice(0, c);
    const bound = Math.min(c + testMonths, i + 1 < cuts.length ? cuts[i + 1] : N);
    const test = months.slice(c, bound);
    return {
      key: `s${i + 1}`,
      trainMonths: train, testMonths: test,
      vlabel: `${train.length}개월 학습 (${rangeLabel(train)})`,
      testLabel: rangeLabel(test),
      train: [firstDayOf(train[0]), lastDayOf(train[train.length - 1])],
      test: [firstDayOf(test[0]), lastDayOf(test[test.length - 1])],
    };
  }).filter(s => s.testMonths.length > 0);
}

// ── 결정적 저수지 표집 ──
// 누적 학습 표본을 전수로 들고 다니면 블롭이 수십 MB로 불어 매 실행의 읽기·쓰기가
// 함수 시간 한도를 먹는다. 분위수는 수천 표본이면 사실상 수렴하므로 상한을 두되,
// **n(관측 수)은 전수를 유지**해 셀 자격(MIN_N) 판정은 표본이 아니라 진짜 관측 수로 한다.
// 시드 없는 난수를 쓰면 같은 입력에 다른 결과가 나와 재현이 깨지므로 해시로 결정한다.
function hashRand(i) {
  let x = (i * 2654435761) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 2246822519); x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}
function reservoirPush(a, v, cap) {
  a.n = (a.n || 0) + 1;
  if (!a.s) a.s = [];
  if (a.s.length < cap) { a.s.push(v); return; }
  const j = Math.floor(hashRand(a.n) * a.n);
  if (j < cap) a.s[j] = v;
}

module.exports = {
  ym, addMonths, nextMonth, prevMonth, firstDayOf, lastDayOf, prevMonthLastDay,
  enumMonths, ymLabel, rangeLabel, monthsFromKeys, planStages, hashRand, reservoirPush,
};
