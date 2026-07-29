// mkt-backtest fixture — 순수함수 + GR11(밴드가 M+1을 안 봄) + 핸들러(fake store). API 미호출.
const F = __dirname + '/../netlify/functions/mkt-backtest.js';

function makeStore(){
  const m=new Map();
  return { _m:m,
    async get(k){ return m.has(k)?JSON.parse(JSON.stringify(m.get(k))):null; },
    async setJSON(k,v){ m.set(k, JSON.parse(JSON.stringify(v))); },
    set(k,v){ m.set(k, JSON.parse(JSON.stringify(v))); },
    async list({prefix}){ const b=[]; for(const k of m.keys()) if(k.startsWith(prefix)) b.push({key:k}); return {blobs:b}; },
  };
}
let n=0,bad=0; const t=(k,c,x)=>{n++;if(!c){bad++;console.log('FAIL:',k,x!=null?x:'');}};
// ㎡당 v를 내는 거래 배열 생성(면적 100 고정 → amt=v*100)
const tr=(...vals)=>vals.map(v=>({amt:v*100,area:100}));

const mod=require(F); const T=mod._test;

// ── 순수 함수 ──
t('perM2List: amt/area', JSON.stringify(T.perM2List([{amt:100000,area:100},{amt:0,area:50},{amt:60000,area:60}]))==='[1000,1000]');
t('prevYm 월경계', T.prevYm('202601',1)==='202512' && T.prevYm('202603',6)==='202509');
t('nextYm 월경계', T.nextYm('202612')==='202701' && T.nextYm('202606')==='202607');

// ── scoreCell walk-forward + GR11 ──
// 안정장: 6개월 ~1000(스프레드 900~1100), M+1도 ~1000 → hit=1
const stable={};
for(const ym of ['202601','202602','202603','202604','202605','202606','202607'])
  stable[ym]=tr(900,950,1000,1050,1100);
let obs=T.scoreCell(stable,'apt');
t('안정장 관측 생성됨', obs.length>=1, 'obs='+obs.length);
t('안정장 밴드 적중(hit=1)', obs.every(o=>o.hit===1));
t('안정장 오차 작음(<10%)', obs.every(o=>o.errPct<10));

// GR11: M=202606 창은 [202601..202606]만. 202607이 2000으로 점프해도 밴드는 ~1000 유지 → 밴드가 미래를 안 봄
const jump=Object.assign({},stable); jump['202607']=tr(2000,2000,2000);
obs=T.scoreCell(jump,'apt');
const oJun=obs.find(o=>o.ym==='202606');
t('GR11: M+1 점프여도 as-of 밴드는 과거 기반(적중 실패)', oJun && oJun.hit===0, oJun&&JSON.stringify(oJun));
t('GR11: 점프 오차 큼(~50%, 밴드 미래 미참조 증거)', oJun && oJun.errPct>=45, oJun&&oJun.errPct);
// 창 값이 과거만 쓰였는지: nWin은 6개월×5건=30
t('as-of 창 과거만(nWin=30)', oJun && oJun.nWin===30, oJun&&oJun.nWin);

// 표본 부족 셀: 창에 4건뿐이면 스킵
const sparse={'202605':tr(1000,1000),'202606':tr(1000,1000),'202607':tr(1000)};
t('표본<5 스킵', T.scoreCell(sparse,'apt').length===0);

// rh는 창 12개월
t('WIN rh=12·apt=6', T.WIN.rh===12 && T.WIN.apt===6);

// ── aggregate ──
const agg=T.aggregate([
  {ym:'202601',kind:'apt',hit:1,errPct:2,coverage:0.5},
  {ym:'202601',kind:'apt',hit:0,errPct:8,coverage:0.3},
  {ym:'202602',kind:'offi',hit:1,errPct:4,coverage:0.6},
]);
t('agg overall n=3', agg.overall.n===3);
t('agg hitRate=66.7', agg.overall.hitRate===66.7, agg.overall.hitRate);
t('agg byKind apt·offi', agg.byKind.apt.n===2 && agg.byKind.offi.n===1);
t('agg byMonth 정렬', agg.byMonth[0].ym==='202601' && agg.byMonth.length===2);

// ── 핸들러: 데이터 없음 → no-op ──
(async()=>{
  let store=makeStore(); global.__FAKE_STORE__=store;
  let r=await mod.handler({queryStringParameters:{}}); let b=JSON.parse(r.body);
  t('데이터 없으면 status empty', b.status==='empty');
  const hb0=await store.get('_run/mkt-backtest'); t('no-data 하트비트', hb0&&hb0.noData===true);

  // ── 핸들러: 셀 채워 실행 ──
  store=makeStore(); global.__FAKE_STORE__=store;
  store.set('mkt/rtms/_meta',{records:100});
  // 2개 셀 × 7개월 안정장
  for(const cell of ['11680_apt','11110_offi'])
    for(const ym of ['202601','202602','202603','202604','202605','202606','202607'])
      store.set(`mkt/rtms/${cell}/${ym}`, tr(900,950,1000,1050,1100));
  r=await mod.handler({queryStringParameters:{debug:'1'}}); b=JSON.parse(r.body);
  t('핸들러 성공', b.ok===true);
  t('summary 저장', b.summary&&b.summary.observations>0, b.summary&&b.summary.observations);
  const sum=await store.get('mkt/bt/summary');
  t('summary blob 기록', sum&&sum.version==='mkt-v1-nowcast');
  t('byKind apt·offi 둘 다', sum.byKind.apt&&sum.byKind.offi);
  t('안정장 전체 적중률 높음', sum.overall.hitRate>=90, sum.overall.hitRate);
  const hb=await store.get('_run/mkt-backtest'); t('실행 하트비트', hb&&hb.ok===true&&hb.observations>0);
  // _meta/_state 키는 셀로 오인 안 됨
  store.set('mkt/rtms/_state',{idx:5});
  r=await mod.handler({queryStringParameters:{}}); b=JSON.parse(r.body);
  t('_meta/_state는 셀 아님(정규식 필터)', b.summary.cells===2, b.summary&&b.summary.cells);

  delete global.__FAKE_STORE__;
  console.log(`\n[mkt-backtest fixture] ${n-bad}/${n} pass  (overall hit=${sum.overall.hitRate}%, medErr=${sum.overall.medErrPct}%, obs=${sum.observations})`);
  process.exit(bad?1:0);
})().catch(e=>{console.log('THROW',e);process.exit(1);});
