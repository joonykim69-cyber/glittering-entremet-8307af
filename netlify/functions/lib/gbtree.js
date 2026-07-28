// netlify/functions/lib/gbtree.js
// 차세대 모델(v0.8) 코어 — 순수 JS "분위수 그래디언트 부스팅 회귀 트리".
//
// 왜 순수 JS인가: 사이트·서버리스 함수는 네이티브 의존성 금지(단일 파일·no build).
// LightGBM(파이썬/네이티브) 대신 JS로 구현해 기존 모델 레지스트리·백테스트 하니스에
// 그대로 얹고, Node fixture로 "정말 학습하는가"를 검증한다. 결과는 bt/* 격리.
//
// 방식(sklearn GradientBoostingRegressor(loss='quantile', alpha=τ)와 동일 골격):
//   F0 = y의 τ-분위수(상수)
//   반복 m회: 잔차 r=y-F, 음의 그래디언트 g_i = (r_i>0? τ : τ-1) 에 회귀트리를 적합
//     (분산감소 분할) → 각 잎을 그 잎에 속한 잔차의 τ-분위수로 재라벨(line search)
//     → F += lr·tree
//   예측 = F0 + lr·Σ tree(x)
// 세 분위수(p10/p50/p90)를 각각 학습해 [lo,mid,hi] 구간을 만든다.
//
// 시점 정직성(Golden Rule 11): 이 라이브러리는 넘겨받은 (X,y)만 쓴다 — 학습 데이터가
// 예측 시점 이전인지(누수 차단)는 호출자(백테스트/모의 라이브)가 walk-forward로 보장.

'use strict';

function quantileSorted(sorted, tau) {
  const nn = sorted.length;
  if (nn === 0) return 0;
  if (nn === 1) return sorted[0];
  const idx = (nn - 1) * tau, lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
function quantile(arr, tau) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return quantileSorted(s, tau);
}

// 회귀 트리 1그루 — target(=음의 그래디언트)의 분산감소 분할, maxDepth·minLeaf 제한.
// 분할 후보는 각 피처의 후보 임계값(중복 제거한 값들의 중점 표본).
function fitTree(X, target, idxs, feats, maxDepth, minLeaf) {
  function mean(ix) { let s = 0; for (const i of ix) s += target[i]; return s / ix.length; }
  function sse(ix) { const m = mean(ix); let s = 0; for (const i of ix) { const d = target[i] - m; s += d * d; } return s; }

  function build(ix, depth) {
    const node = { leaf: true, value: mean(ix), n: ix.length };
    if (depth >= maxDepth || ix.length < 2 * minLeaf) return node;
    const parentSse = sse(ix);
    let best = null;
    for (const f of feats) {
      // 후보 임계값: 이 노드 표본의 f값 정렬 후 인접 중점(최대 32개 후보로 다운샘플)
      const vals = ix.map(i => X[i][f]);
      const uniq = Array.from(new Set(vals)).sort((a, b) => a - b);
      if (uniq.length < 2) continue;
      const step = Math.max(1, Math.floor((uniq.length - 1) / 32));
      for (let k = 0; k < uniq.length - 1; k += step) {
        const thr = (uniq[k] + uniq[k + 1]) / 2;
        const L = [], R = [];
        for (const i of ix) (X[i][f] <= thr ? L : R).push(i);
        if (L.length < minLeaf || R.length < minLeaf) continue;
        const gain = parentSse - sse(L) - sse(R);
        if (!best || gain > best.gain) best = { gain, f, thr, L, R };
      }
    }
    if (!best || best.gain <= 1e-12) return node;
    return { leaf: false, f: best.f, thr: best.thr, left: build(best.L, depth + 1), right: build(best.R, depth + 1) };
  }
  return build(idxs, 0);
}

// 잎 재라벨 — 각 잎에 도달한 표본들의 잔차 r의 τ-분위수로 잎값 교체(분위수 보정).
function relabelLeaves(node, X, resid, idxs, tau) {
  if (node.leaf) { node.value = quantile(idxs.map(i => resid[i]), tau); return; }
  const L = [], R = [];
  for (const i of idxs) (X[i][node.f] <= node.thr ? L : R).push(i);
  relabelLeaves(node.left, X, resid, L, tau);
  relabelLeaves(node.right, X, resid, R, tau);
}
function treePredict(node, x) {
  while (!node.leaf) node = (x[node.f] <= node.thr ? node.left : node.right);
  return node.value;
}

// 한 분위수 τ의 GBM 학습. X: number[][], y: number[]. feats: 사용할 피처 인덱스 배열.
function trainQuantileGBM(X, y, tau, opts) {
  opts = opts || {};
  const nTrees = opts.nTrees || 60, maxDepth = opts.maxDepth || 3, minLeaf = opts.minLeaf || 10, lr = opts.lr || 0.1;
  const n = X.length;
  const feats = opts.feats || (X[0] ? X[0].map((_, j) => j) : []);
  const F0 = quantile(y, tau);
  const F = new Array(n).fill(F0);
  const trees = [];
  const allIdx = []; for (let i = 0; i < n; i++) allIdx.push(i);
  for (let m = 0; m < nTrees; m++) {
    const g = new Array(n), r = new Array(n);
    for (let i = 0; i < n; i++) { r[i] = y[i] - F[i]; g[i] = r[i] > 0 ? tau : (tau - 1); }
    const tree = fitTree(X, g, allIdx, feats, maxDepth, minLeaf);
    relabelLeaves(tree, X, r, allIdx, tau); // 잎값 = 잔차의 τ-분위수
    for (let i = 0; i < n; i++) F[i] += lr * treePredict(tree, X[i]);
    trees.push(tree);
  }
  return { F0, lr, tau, trees };
}
function predictGBM(model, x) {
  let v = model.F0;
  for (const t of model.trees) v += model.lr * treePredict(t, x);
  return v;
}

// 세 분위수 동시 학습 → 예측 시 [lo,mid,hi] (단조 보정: lo≤mid≤hi 강제).
function trainQuantileBands(X, y, opts) {
  return {
    lo: trainQuantileGBM(X, y, (opts && opts.qlo) || 0.1, opts),
    mid: trainQuantileGBM(X, y, 0.5, opts),
    hi: trainQuantileGBM(X, y, (opts && opts.qhi) || 0.9, opts),
  };
}
function predictBands(bands, x) {
  let lo = predictGBM(bands.lo, x), mid = predictGBM(bands.mid, x), hi = predictGBM(bands.hi, x);
  // 분위수 교차 방지(단조 보정)
  mid = Math.max(mid, lo); hi = Math.max(hi, mid);
  return { lo, mid, hi };
}

module.exports = { quantile, trainQuantileGBM, predictGBM, trainQuantileBands, predictBands, _fitTree: fitTree };
