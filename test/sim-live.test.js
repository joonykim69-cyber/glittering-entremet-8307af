// sim-live.js fixture — GR11 준수 · 월 walk-forward · per-item 기록 · 재개.
// 실 응답 구조를 재현한 합성 hist/feat + hist/win 으로 핸들러를 끝까지 돌린다.
const path=__dirname + '/../netlify/functions/sim-live.js';

function makeStore(){
  const m=new Map();
  return { _m:m,
    async get(k){ return m.has(k)?JSON.parse(JSON.stringify(m.get(k))):null; },
    async setJSON(k,v){ m.set(k, JSON.parse(JSON.stringify(v))); },
    set(k,v){ m.set(k, v); },
    async list({prefix}){ const blobs=[]; for(const k of m.keys()) if(k.startsWith(prefix)) blobs.push({key:k}); return {blobs}; },
  };
}

// 합성 데이터: 1~6월, 아파트, round1, 최저가 3억. lr 105~115% (개찰가율).
function seed(store){
  const months=['202601','202602','202603','202604','202605','202606'];
  const feat=[], win={}; let id=0; let s=42; const rnd=()=>{s=(s*9301+49297)%233280;return s/233280;};
  months.forEach(ym=>{ for(let i=0;i<40;i++){ id++; const cd='1'; const uid=id+'_'+cd;
    const day=String(1+Math.floor(rnd()*27)).padStart(2,'0');
    feat.push({id:String(id),cdtn:cd,usage:'아파트',usageM:'아파트',round:1,low:300000000,apsl:350000000,st:'0010',opbd:ym+day});
    const lr=105+rnd()*10; win[uid]={win:Math.round(300000000*lr/100),lr:Math.round(lr*10)/10,wr:0};
  }});
  store.set('hist/feat/20260101_20260630/0001', feat);
  store.set('hist/win/20260101_20260630/0001', win);
  store.set('hist/_bfmeta', {done:true, records:240});
}

let n=0,bad=0; const t=(k,c)=>{n++;if(!c){bad++;console.log('FAIL:',k);}};

(async()=>{
  // 문법/로드
  delete require.cache[require.resolve(path)];
  const store=makeStore(); global.__FAKE_STORE__=store;
  const mod=require(path); const T=mod._test;

  // 단위: 월 유틸 (2026 비윤년 → 2월 28일)
  t('enumMonths 5개', JSON.stringify(T.enumMonths('202602','202606'))===JSON.stringify(['202602','202603','202604','202605','202606']));
  t('prevMonthLastDay(202603)=20260228', T.prevMonthLastDay('202603')==='20260228');
  t('prevMonthLastDay(202601)=20251231', T.prevMonthLastDay('202601')==='20251231');

  // GR11 구조: predictOne이 win을 무시(feat에 win 넣어도 결과 동일)
  const cells={ ['L0|0001']:{n:30, lr:{p10:106,p50:110,p90:114}} };
  const base=T.predictOne(cells,{type:'0001',usage:'x',round:1,low:100000});
  const withWin=T.predictOne(cells,{type:'0001',usage:'x',round:1,low:100000,win:999999999,lr:200});
  t('predictOne win 무시(GR11)', base && withWin && base.lo===withWin.lo && base.hi===withWin.hi);
  t('predictOne 밴드 = low×분위수', base.lo===Math.round(100000*106/100) && base.hi===Math.round(100000*114/100));

  // waiting 가드: 백필 미완이면 no-op
  const s2=makeStore(); s2.set('hist/_bfmeta',{done:false}); global.__FAKE_STORE__=s2;
  let r=await mod.handler({queryStringParameters:{}}); let b=JSON.parse(r.body);
  t('백필 미완 → waiting', b.ok&&b.waiting);

  // 전체 재생: 월당 1회 호출, 5개월 → done
  seed(store); global.__FAKE_STORE__=store;
  let calls=0, lastYm=null;
  for(let i=0;i<7;i++){ r=await mod.handler({queryStringParameters:{}}); b=JSON.parse(r.body);
    if(b.done){ break; } if(b.ym){ calls++; lastYm=b.ym; } }
  t('월당 1회씩 5개월 처리', calls===5);
  t('마지막 월 202606', lastYm==='202606');
  r=await mod.handler({queryStringParameters:{}}); b=JSON.parse(r.body);
  t('완료 후 done:true', b.done===true);

  // 산출물 검증
  const summary=await store.get('bt/sim/summary'); const records=await store.get('bt/sim/records');
  t('summary.months 5개', summary && summary.months && summary.months.length===5);
  t('각 월 hitRate 존재', summary.months.every(m=>typeof m.hitRate==='number'));
  t('cumHitRate 존재(재생 곡선)', summary.months.every(m=>typeof m.cumHitRate==='number'));
  t('cum 누적 표본>0', summary.cum && summary.cum.n>0);
  t('hitRate 합리적(50~100%)', summary.cum.hitRate>=50 && summary.cum.hitRate<=100);
  t('per-item records 존재', Array.isArray(records) && records.length>0);
  t('records 여러 월 포함(과녁 초기/후기)', new Set(records.map(x=>x.ym)).size>=2);
  t('records 필드(hit/errPct/level)', records.every(x=>typeof x.hit==='boolean'&&typeof x.errPct==='number'&&x.level));

  // status 조회
  r=await mod.handler({queryStringParameters:{status:'1'}}); b=JSON.parse(r.body);
  t('status 조회', b.ok && b.summary && b.summary.done===true);

  // reset
  r=await mod.handler({queryStringParameters:{reset:'1',confirm:'1'}}); b=JSON.parse(r.body);
  t('reset', b.ok && /초기화/.test(b.note));

  // 정적: 예측 feat에 win 없음(소스 구조 강제) + bt/sim 격리 + 하트비트
  const srcTxt=require('fs').readFileSync(path,'utf8');
  t('소스: 예측 feat에 win 없음', /const feat = \{ type: item\.type, usage: item\.usage, round: item\.round, low: item\.low \};/.test(srcTxt));
  t('소스: bt/sim 격리(라이브 원장 무관)', srcTxt.includes("'bt/sim/summary'") && !srcTxt.includes("setJSON('pred/") && !srcTxt.includes("setJSON('agg'"));
  t('소스: 하트비트 _run/sim-live', srcTxt.includes("'_run/sim-live'"));

  delete global.__FAKE_STORE__;
  console.log(`[fixture] ${n-bad}/${n} pass`);
  process.exit(bad?1:0);
})().catch(e=>{console.log('THROW',e);process.exit(1);});
