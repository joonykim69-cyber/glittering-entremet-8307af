// score-daily A(전수 채점)+B(폭 관측) fixture — 실 응답 구조 재현 fetch 목킹 + 페이크 스토어.
const path=__dirname + '/../netlify/functions/score-daily.js';

function makeStore(){
  const m=new Map();
  return { _m:m,
    async get(k){ return m.has(k)?JSON.parse(JSON.stringify(m.get(k))):null; },
    async setJSON(k,v){ m.set(k, JSON.parse(JSON.stringify(v))); },
    set(k,v){ m.set(k,v); },
    async list(){ return {blobs:[]}; },
  };
}
// onbid-bidresults 응답 형태: {results:[{id,pbctCdtnNo,statCd,winAmt,opbdDt,...}], totalCount}
function makeResults(prefix, count){
  const arr=[];
  for(let i=0;i<count;i++) arr.push({ id:prefix+'-'+i, pbctCdtnNo:'1', statCd:'0010', winAmt:300000000, opbdDt:'20260726', usage:'아파트', title:'물건'+i });
  return arr;
}

let n=0,bad=0;const t=(k,c)=>{n++;if(!c){bad++;console.log('FAIL:',k);}};

(async()=>{
  const store=makeStore(); global.__FAKE_STORE__=store;

  // A 검증: 자산군당 1200건(개찰) 존재 — page1=1000, page2=200(<1000 종료). 과거 200 상한이면 절대 못 잡음.
  // 부동산(0001)만 다량, 나머지는 소량으로.
  const perAssetPages={
    '0001':[makeResults('re-p1',1000), makeResults('re-p2',200)],
    '0002':[makeResults('ve-p1',3)],
    '0003':[makeResults('mv-p1',2)],
  };
  let fetchCalls=0;
  global.fetch=async(url)=>{
    fetchCalls++;
    const u=new URL(url,'http://x');
    const cd=u.searchParams.get('cltrTypeCd'); const page=Number(u.searchParams.get('page'))||1;
    if(u.pathname.includes('onbid-bidresults')){
      const pages=perAssetPages[cd]||[]; const batch=pages[page-1]||[];
      return { ok:true, json:async()=>({results:batch, totalCount: pages.reduce((s,p)=>s+p.length,0)}) };
    }
    // loadUsgStats(onbid-svc) 등 그 외 호출은 빈 응답
    return { ok:true, json:async()=>({items:[]}) };
  };

  // 봉인 예측(pred) + 챌린저(predb)를 물건들에 심어 채점되게. 부동산 첫 5건에 pred/predb.
  // predb.cellKey 레벨별로 다르게 + roundReal 섞기.
  const levels=['L3|0001|아파트|1|gte10','L1|0001|아파트','L0|0001','L0|0001','L2|0001|아파트|1'];
  for(let i=0;i<5;i++){
    const key='re-p1-'+i+'_1';
    store.set('pred/'+key, { id:'re-p1-'+i, pbctCdtnNo:'1', title:'물건'+i, type:'아파트', assetClass:'부동산', lo:28000, mid:30000, hi:33000, modelV:'v0.1' });
    store.set('predb/'+key, { id:'re-p1-'+i, pbctCdtnNo:'1', type:'아파트', lo:29000, mid:30500, hi:32000, cellKey:levels[i], roundReal:(i%2===0), modelV:'v0.5-cells' });
  }

  const mod=require(path);
  const r=await mod.handler({ httpMethod:'GET', queryStringParameters:{} });
  const b=JSON.parse(r.body);
  t('핸들러 성공', r.statusCode===200 && b.ok);

  // A: 전수 수집 — 부동산 1200건이 다 fetched(과거 200 상한이면 fetched<results, graded 5 불가능은 아니나 수집 자체를 검증)
  t('A 전수 수집(1205건 이상 fetched)', b.fetched>=1205); // 1200 부동산 + 3 차량 + 2 동산
  t('A 채점 5건(pred 있는 것만)', b.graded===5);
  // 부동산 page2까지 갔는지 = fetch가 자산군별로 페이지네이션 (0001은 2콜, 0002/0003은 1콜씩 → bidresults 4콜 + usg통계 몇 콜)
  t('A 부동산 2페이지 수집(page2 200건 포함)', b.fetched===1205);

  // B: aggB 관측
  const aggB=await store.get('aggB');
  t('B aggB.byLevel 존재', aggB && aggB.byLevel && Object.keys(aggB.byLevel).length>=1);
  t('B L0 2건 집계', aggB.byLevel['L0'] && aggB.byLevel['L0'].n===2);
  t('B L3/L1/L2 각 1건', aggB.byLevel['L3'].n===1 && aggB.byLevel['L1'].n===1 && aggB.byLevel['L2'].n===1);
  t('B byLevel 폭 누적', typeof aggB.byLevel['L0'].sumWidthPct==='number' && aggB.byLevel['L0'].sumWidthPct>0);
  t('B roundReal 실측3/근사2', aggB.roundReal.real===3 && aggB.roundReal.approx===2); // i=0,2,4 real
  t('B headToHead 집계', aggB.headToHead.n===5);

  // 정적: 200 상한 제거 + numOfRows=1000 페이지네이션
  const src=require('fs').readFileSync(path,'utf8');
  t('정적: 200 상한 제거', !src.includes("numOfRows=100&page="));
  t('정적: numOfRows=1000 페이지네이션', src.includes('numOfRows=1000&page=')&&src.includes('batch.length < 1000'));
  t('정적: byLevel/roundReal 배선', src.includes('aggB.byLevel[lvl]')&&src.includes('predB.roundReal'));

  // scoreboard 노출 정적
  const sb=require('fs').readFileSync(__dirname + '/../netlify/functions/scoreboard.js','utf8');
  t('scoreboard byLevel/roundReal 노출', sb.includes('byLevel: aggB.byLevel')&&sb.includes('roundReal: aggB.roundReal'));

  delete global.__FAKE_STORE__; delete global.fetch;
  console.log(`[fixture] ${n-bad}/${n} pass`);
  process.exit(bad?1:0);
})().catch(e=>{console.log('THROW',e);process.exit(1);});
