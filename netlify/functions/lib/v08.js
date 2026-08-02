// netlify/functions/lib/v08.js — v0.8 GBDT 모델의 인코딩·학습·예측 (단일 출처)
//
// 왜 lib로 뺐나 (2026-08-02, 라이브 챌린저 v0.5 → v0.8 교체 — 창업자 결정):
//   이 코드는 backtest.js 안에 있었다. 백테스트에서 v0.8이 3단계 × 3지표(적중률·오차·폭)
//   전승하면서 라이브 챌린저로 채택됐고, 이제 세 곳(백테스트·일일 학습기 train-gb·봉인
//   predict-daily)이 같은 인코딩을 써야 한다 — 복사하면 어긋나는 순간 백테스트 성적과
//   라이브 성적이 다른 모델 얘기가 된다. 함수 본문은 backtest.js에 있던 것 그대로다
//   (백테스트 검증을 통과한 코드를 옮기기만 하고 수정하지 않는다).
//
// GR11(시점 정직성): 이 라이브러리는 넘겨받은 X, y만 쓴다. 학습 데이터가 과거뿐인지,
//   예측 입력에 미래가 없는지는 호출자가 보장한다(trainV08은 y=lr만 목표로 쓰고
//   predictV08의 it에는 win 필드 자체가 없다).

'use strict';

const GB = require('./gbtree.js');

const V08_NMAX = 12000;                                     // 학습 표본 상한(초과 시 균등 서브샘플)
const V08_OPTS = { nTrees: 40, maxDepth: 3, minLeaf: 30, lr: 0.15 };

// 피처: 자산군 원핫(3) + 용도 top-12 원핫 + other(13) + 회차·최저가log·감정가log·저가율(4).
function buildEncoderV08(sold, K) {
  const cnt = {};
  for (const r of sold) cnt[r.usage] = (cnt[r.usage] || 0) + 1;
  const usages = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]).slice(0, K || 12);
  return { usages };
}

function encodeV08(rec, enc) {
  const v = [rec.type === '0001' ? 1 : 0, rec.type === '0002' ? 1 : 0, rec.type === '0003' ? 1 : 0];
  let matched = 0;
  for (const u of enc.usages) { const m = (String(rec.usage) === u) ? 1 : 0; v.push(m); matched |= m; }
  v.push(matched ? 0 : 1); // other
  const low = Number(rec.low) || 0, apsl = Number(rec.apsl) || 0, round = Number(rec.round) || 1;
  v.push(Math.min(round, 10));                               // 회차(상한)
  v.push(low > 0 ? Math.log10(low) : 0);                     // 최저가 로그
  v.push(apsl > 0 ? Math.log10(apsl) : 0);                   // 감정가 로그
  v.push(apsl > 0 ? Math.max(0, Math.min(2, low / apsl)) : 0); // 저가율(최저가/감정가)
  return v;
}

// 학습: 낙찰(0010)·lr>0만. 서브샘플로 성능 가드. win/lr을 x에 안 넣음(y=lr만 목표).
function trainV08(records) {
  let sold = records.filter(r => r.st === '0010' && r.lr > 0 && r.low > 0);
  if (sold.length < 50) return null; // 표본 부족 → 학습하지 않는다(근거 없으면 미산출)
  if (sold.length > V08_NMAX) { const step = sold.length / V08_NMAX, s = []; for (let i = 0; i < V08_NMAX; i++) s.push(sold[Math.floor(i * step)]); sold = s; }
  const enc = buildEncoderV08(sold, 12);
  const X = sold.map(r => encodeV08(r, enc)), y = sold.map(r => r.lr);
  return { enc, gb: GB.trainQuantileBands(X, y, V08_OPTS), n: sold.length };
}

// 예측: it엔 개찰 전 값만(win 없음 — GR11). lr 분위수 → it.low로 환산.
function predictV08(model, it) {
  if (!model || !model.gb) return null;
  if (!(Number(it.low) > 0)) return null;   // 최저가 없으면 예측 안 함(v0.5와 동일 규율)
  const b = GB.predictBands(model.gb, encodeV08(it, model.enc)); // lr 분위수
  const lo = Math.round(it.low * b.lo / 100), mid = Math.round(it.low * b.mid / 100);
  let hi = Math.round(it.low * b.hi / 100);
  if (hi <= lo) hi = Math.round(lo * 1.05);
  return { lo, mid, hi };
}

module.exports = { buildEncoderV08, encodeV08, trainV08, predictV08, V08_NMAX, V08_OPTS };
