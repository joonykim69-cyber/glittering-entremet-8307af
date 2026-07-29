// gbtree.js fixture — "정말 학습하는가"를 합성 데이터로 증명.
// 설계: x0∈{0,1,2}(범주), x1∈[0,1](수치). y = 100 + 30*x0 + 20*x1 + noise,
//   noise ~ Uniform(-w,w), w = 10 + 10*x0 (이분산: x0 클수록 분포 넓음).
// 검증: ① 중앙값 학습(MAE 작음) ② 보정(p10에 ~10%, p90에 ~90% 미만) ③ 상수 baseline
//   대비 pinball loss 우위 ④ 이분산 포착(폭이 x0=2 > x0=0) ⑤ 단조 lo≤mid≤hi.
const G = require(__dirname + '/../netlify/functions/lib/gbtree.js');

function rng(seed){ return function(){ seed=(seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff; }; }
function gen(n, seed){
  const r=rng(seed), X=[], y=[];
  for(let i=0;i<n;i++){
    const x0=Math.floor(r()*3), x1=r();
    const w=10+10*x0;
    const noise=(r()*2-1)*w;
    X.push([x0, x1]);
    y.push(100 + 30*x0 + 20*x1 + noise);
  }
  return {X,y};
}
function pinball(yTrue, pred, tau){ const d=yTrue-pred; return d>=0 ? tau*d : (tau-1)*d; }

let n=0,bad=0; const t=(k,c,extra)=>{n++;if(!c){bad++;console.log('FAIL:',k, extra!=null?extra:'');}};

const tr=gen(2000, 7), te=gen(1000, 99);
const opts={ nTrees:80, maxDepth:3, minLeaf:20, lr:0.15 };
const t0=Date.now();
const bands=G.trainQuantileBands(tr.X, tr.y, opts);
const trainMs=Date.now()-t0;

// 예측
const preds=te.X.map(x=>G.predictBands(bands, x));

// ① 중앙값 MAE (참 중앙값 = 100+30x0+20x1) 작아야
let mae=0; for(let i=0;i<te.X.length;i++){ const trueMid=100+30*te.X[i][0]+20*te.X[i][1]; mae+=Math.abs(preds[i].mid-trueMid); }
mae/=te.X.length;
t('① 중앙값 학습(MAE<8)', mae<8, 'mae='+mae.toFixed(2));

// ② 보정: p10 미만 비율 ~0.1, p90 미만 ~0.9 (±0.06 허용)
let bLo=0,bHi=0; for(let i=0;i<te.X.length;i++){ if(te.y[i]<=preds[i].lo)bLo++; if(te.y[i]<=preds[i].hi)bHi++; }
bLo/=te.X.length; bHi/=te.X.length;
t('② p10 보정(0.04~0.16)', bLo>=0.04&&bLo<=0.16, 'covLo='+bLo.toFixed(3));
t('② p90 보정(0.84~0.96)', bHi>=0.84&&bHi<=0.96, 'covHi='+bHi.toFixed(3));

// ③ 상수 baseline 대비 pinball loss 우위 (조건부 신호를 학습했다는 증거)
function pinballAvg(tau, predFn){ let s=0; for(let i=0;i<te.X.length;i++) s+=pinball(te.y[i], predFn(i), tau); return s/te.X.length; }
const gMid=G.quantile(tr.y, 0.5), gLo=G.quantile(tr.y,0.1), gHi=G.quantile(tr.y,0.9);
t('③ p50 GBM < 상수', pinballAvg(0.5, i=>preds[i].mid) < pinballAvg(0.5, ()=>gMid)*0.85);
t('③ p10 GBM < 상수', pinballAvg(0.1, i=>preds[i].lo) < pinballAvg(0.1, ()=>gLo)*0.9);
t('③ p90 GBM < 상수', pinballAvg(0.9, i=>preds[i].hi) < pinballAvg(0.9, ()=>gHi)*0.9);

// ④ 이분산 포착: x0=2 그룹 평균 폭 > x0=0 그룹 평균 폭
function avgWidth(x0){ let s=0,c=0; for(let i=0;i<te.X.length;i++) if(te.X[i][0]===x0){ s+=(preds[i].hi-preds[i].lo); c++; } return s/c; }
const w0=avgWidth(0), w2=avgWidth(2);
t('④ 이분산 포착(폭 x0=2 > x0=0, 1.5배+)', w2 > w0*1.5, `w0=${w0.toFixed(1)} w2=${w2.toFixed(1)}`);

// ⑤ 단조성 lo≤mid≤hi 항상
let mono=true; for(const p of preds) if(!(p.lo<=p.mid+1e-9 && p.mid<=p.hi+1e-9)) mono=false;
t('⑤ 단조 lo≤mid≤hi', mono);

// ⑥ 성능: 2000행×80트리 학습이 합리적 시간
t('⑥ 학습 시간(<8s)', trainMs<8000, trainMs+'ms');

// ⑦ 빈 입력/단일 표본 견고성(크래시 없음)
try { const b2=G.trainQuantileBands([[0,0]],[100],opts); const p=G.predictBands(b2,[0,0]); t('⑦ 단일표본 견고', typeof p.mid==='number'); }
catch(e){ t('⑦ 단일표본 견고', false, e.message); }

console.log(`[gbtree fixture] ${n-bad}/${n} pass  (train ${trainMs}ms, mid MAE ${mae.toFixed(2)}, cov ${bLo.toFixed(2)}/${bHi.toFixed(2)}, width x0=0:${w0.toFixed(1)} x0=2:${w2.toFixed(1)})`);
process.exit(bad?1:0);
