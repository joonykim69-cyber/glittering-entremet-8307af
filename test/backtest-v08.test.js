// backtest v0.8 통합 fixture — 합성 hist/feat+win으로 walk-forward 하니스에 v0.8이
// 등록·학습·채점되는지 + GR11(예측 feat에 win 없음) + 인코딩 검증. (onbid API 미호출)
const BT=__dirname + '/../netlify/functions/backtest.js';

function makeStore(){
  const m=new Map();
  return { _m:m,
    async get(k){ return m.has(k)?JSON.parse(JSON.stringify(m.get(k))):null; },
    async setJSON(k,v){ m.set(k, JSON.parse(JSON.stringify(v))); },
    set(k,v){ m.set(k, JSON.parse(JSON.stringify(v))); },
    async list({prefix}){ const b=[]; for(const k of m.keys()) if(k.startsWith(prefix)) b.push({key:k}); return {blobs:b}; },
  };
}
function rng(seed){ return function(){ seed=(seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff; }; }

// 학습 가능한 lr 신호: usage/round/저가율에 따라 lr(최저가 대비 낙찰가율)이 달라지고 이분산.
// 창(window) 키로 저장: hist/feat/{start}_{end}/{type} + hist/win/{...}
function seedWindow(store, start, end, seed, count){
  const r=rng(seed); const usages=['아파트','상가','토지','오피스텔'];
  const feat=[], win={};
  for(let i=0;i<count;i++){
    const id=start+'-'+i, cd='1', uid=id+'_'+cd;
    const u=usages[Math.floor(r()*usages.length)];
    const round=1+Math.floor(r()*4);
    const apsl=100000000+Math.floor(r()*300000000);
    const low=Math.round(apsl*(0.4+r()*0.5)); // 저가율 0.4~0.9
    const disc=low/apsl;
    // 참 lr(최저가 대비): 용도·회차·저가율 의존 + 이분산 노이즈
    const base=105 + (u==='상가'?15:u==='토지'?-8:0) + (round-1)*4 + (disc<0.6?12:0);
    const spread=6 + (u==='상가'?10:0);
    const lr=Math.max(80, base + (r()*2-1)*spread);
    const day=String(1+Math.floor(r()*27)).padStart(2,'0');
    feat.push({id, cdtn:cd, usage:u, usageM:u, round, apsl, low, st:'0010', opbd:start.slice(0,6)+day});
    win[uid]={ win:Math.round(low*lr/100), wr:0, lr:Math.round(lr*10)/10 };
  }
  store.set(`hist/feat/${start}_${end}/0001`, feat);
  store.set(`hist/win/${start}_${end}/0001`, win);
}

let n=0,bad=0; const t=(k,c,x)=>{n++;if(!c){bad++;console.log('FAIL:',k,x!=null?x:'');}};

(async()=>{
  const store=makeStore(); global.__FAKE_STORE__=store;
  store.set('hist/_bfmeta',{done:true, records:9999});
  // 1단계: train=1월(20260101~20260131), test=2·3월. 창을 그 범위에 채움.
  seedWindow(store,'20260101','20260131', 11, 900); // 학습
  seedWindow(store,'20260201','20260228', 22, 500); // 테스트(2월)
  seedWindow(store,'20260301','20260331', 33, 500); // 테스트(3월)

  delete require.cache[require.resolve(BT)];
  delete require.cache[require.resolve(__dirname + '/../netlify/functions/lib/gbtree.js')];
  const bt=require(BT);
  const T=bt._test;

  // 단위: 인코딩 차원 = 3(type)+12(usage)+1(other)+4(num) = 20
  const enc=T.buildEncoderV08([{usage:'아파트'},{usage:'상가'}], 12);
  const vec=T.encodeV08({type:'0001',usage:'아파트',round:2,low:2e8,apsl:3e8}, enc);
  t('인코딩 차원 = 3+용도+1+4', vec.length===(3+enc.usages.length+1+4), 'len='+vec.length+' usages='+enc.usages.length);
  t('자산군 원핫', vec[0]===1&&vec[1]===0&&vec[2]===0);

  // GR11: predictV08은 win/lr을 안 봄 — feat에 win 넣어도 결과 동일
  const sold=[]; { const r=rng(5); for(let i=0;i<400;i++){ const u=['아파트','상가','토지'][i%3]; const apsl=2e8; const low=Math.round(apsl*(0.5+r()*0.4)); const lr=105+(u==='상가'?15:0)+(r()*2-1)*6; sold.push({st:'0010',usage:u,type:'0001',round:1+i%4,apsl,low,lr:Math.round(lr*10)/10}); } }
  const model=T.trainV08(sold);
  t('trainV08 학습됨', model&&model.gb&&model.n>=50);
  const base=T.predictV08(model,{type:'0001',usage:'상가',round:1,low:1e8,apsl:2e8});
  const withWin=T.predictV08(model,{type:'0001',usage:'상가',round:1,low:1e8,apsl:2e8,win:9e9,lr:999});
  t('GR11: predictV08 win 무시', base&&withWin&&base.lo===withWin.lo&&base.hi===withWin.hi);
  t('예측 밴드 단조·양수', base.lo>0&&base.lo<=base.mid&&base.mid<=base.hi);

  // 수집 범위 자동 추종: 창 키(1·2·3월)에서 단계가 파생된다 — STAGES 하드코딩 없음
  let r=await bt.handler({queryStringParameters:{status:'1'}}); let b=JSON.parse(r.body);
  t('범위 자동 파생(3개월)', b.plan && b.plan.months===3 && b.plan.range==='202601~202603', JSON.stringify(b.plan));
  t('달이 3개면 단계는 2개(없는 시험 블록을 만들지 않음)', b.plan.stages.length===2, JSON.stringify(b.plan.stages));

  // 통합: 학습은 달 단위 누적(한 실행 = 한 달) → trained → score
  let guard=0, trainedB=null;
  do { r=await bt.handler({queryStringParameters:{}}); b=JSON.parse(r.body); if(b.phase==='trained') trainedB=b; } while(b.phase==='training' && ++guard<10);
  t('s1 train 단계', trainedB && trainedB.phase==='trained' && trainedB.gb08N>0, JSON.stringify({phase:b.phase,gb08N:b.gb08N}));
  t('학습이 달 단위로 누적됨(누적 레코드 = 1월 900건)', trainedB && trainedB.trainRecords===900, trainedB&&trainedB.trainRecords);
  r=await bt.handler({queryStringParameters:{}}); b=JSON.parse(r.body); // s1 score
  t('s1 score 단계', b.phase==='scored');
  const s1=await store.get('bt/s1');
  t('v08 채점됨(models.v08)', s1&&s1.models&&s1.models.v08&&s1.models.v08.n>0, JSON.stringify(s1&&s1.models&&s1.models.v08));
  t('v05·v07·v08 3모델 병행', s1.models.v05&&s1.models.v07&&s1.models.v08);
  t('v08 적중률·폭 수치', typeof s1.models.v08.hitRate==='number'&&typeof s1.models.v08.avgWidthPct==='number');

  // summary.models 라벨에 v08
  const sum=await store.get('bt/summary');
  t('summary.models에 v08 라벨', sum&&sum.models&&/GBDT/.test(sum.models.v08||''));

  // 정적: BT_VERSION 범프 + require gbtree + GR11 feat(win 없음)
  const src=require('fs').readFileSync(BT,'utf8');
  t('BT_VERSION 범프(v6-autorange — 수집 범위 자동 추종 반영)', src.includes("BT_VERSION = 'v6-autorange'"));
  t('lib/gbtree require', src.includes("require('./lib/gbtree')"));
  t('score feat win 없음(GR11)', /const feat = \{ type: item\.type, usage: item\.usage, round: item\.round, low: item\.low, apsl: item\.apsl \};/.test(src));
  t('성능 가드(서브샘플·트리수)', src.includes('V08_NMAX = 12000')&&src.includes('nTrees: 40'));

  delete global.__FAKE_STORE__;
  console.log(`[bt v08 fixture] ${n-bad}/${n} pass  (v08 s1: n=${s1&&s1.models&&s1.models.v08&&s1.models.v08.n}, hit=${s1&&s1.models&&s1.models.v08&&s1.models.v08.hitRate}%, width=${s1&&s1.models&&s1.models.v08&&s1.models.v08.avgWidthPct}% | v05 hit=${s1&&s1.models&&s1.models.v05&&s1.models.v05.hitRate}%)`);
  process.exit(bad?1:0);
})().catch(e=>{console.log('THROW',e);process.exit(1);});
