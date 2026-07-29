// 보강 C fixture — 증분 고정 키(hist/_inc) 롤링 + hist-stats 소비 + meta 팽창 방지.
const CH=__dirname + '/../netlify/functions/collect-history.js';
const HS=__dirname + '/../netlify/functions/hist-stats.js';

function makeStore(){
  const m=new Map();
  return { _m:m,
    async get(k){ return m.has(k)?JSON.parse(JSON.stringify(m.get(k))):null; },
    async setJSON(k,v){ m.set(k, JSON.parse(JSON.stringify(v))); },
    set(k,v){ m.set(k, JSON.parse(JSON.stringify(v))); },
    async list({prefix}){ const blobs=[]; for(const k of m.keys()) if(k.startsWith(prefix)) blobs.push({key:k}); return {blobs}; },
  };
}
let n=0,bad=0;const t=(k,c)=>{n++;if(!c){bad++;console.log('FAIL:',k);}};

(async()=>{
  // ── collect-history 증분 경로: 고정 키 쓰기 + meta.incRecords(누적 X) ──
  const store=makeStore(); global.__FAKE_STORE__=store;
  // backfillDone 되게: cursorEnd(과거) <= oldestTarget(오늘-365). 아주 옛날로.
  store.set('hist/_state', { cursorEnd:'20200101' });
  store.set('hist/_meta', { records:112649, windows:100, oldest:'20260101', newest:'20260630' });
  // onbid-bidresults 응답 목킹: 자산군별 개찰 5건
  global.fetch=async(url)=>{
    const u=new URL(url,'http://x');
    if(u.pathname.includes('onbid-bidresults')){
      const cd=u.searchParams.get('cltrTypeCd');
      const results=[]; for(let i=0;i<5;i++) results.push({ id:cd+'-'+i, pbctCdtnNo:'1', statCd:'0010', winAmt:300000000, winRate:100, lowstRate:110, apslAmt:350000000, lowstAmt:270000000, usage:'아파트', round:1, opbdDt:'20260726', bidderCnt:2 });
      return { ok:true, json:async()=>({results, totalCount:5}) };
    }
    return { ok:true, json:async()=>({}) };
  };
  delete require.cache[require.resolve(CH)];
  const ch=require(CH);
  const beforeRecords=(await store.get('hist/_meta')).records;
  let r=await ch.handler({ httpMethod:'GET', queryStringParameters:{} }); let b=JSON.parse(r.body);
  t('collect-history 증분 성공', b && b.backfillComplete===true);
  // 고정 키 3개만 생김(자산군별), 날짜 키는 안 생김
  const keys=[...store._m.keys()];
  t('고정 키 hist/_inc/{type} 생성', keys.includes('hist/_inc/0001')&&keys.includes('hist/_inc/0002')&&keys.includes('hist/_inc/0003'));
  t('날짜 이동 키 미생성(누적 방지)', !keys.some(k=>/^hist\/\d{8}_\d{8}\/\d+$/.test(k)));
  const meta1=await store.get('hist/_meta');
  t('meta.records 불변(팽창 방지)', meta1.records===beforeRecords);
  t('meta.incRecords 교체 기록', meta1.incRecords===15); // 3자산군×5
  // 두 번째 실행 → 여전히 고정 키(덮어쓰기), records 여전히 불변, incRecords 교체
  r=await ch.handler({ httpMethod:'GET', queryStringParameters:{} });
  const meta2=await store.get('hist/_meta');
  const keys2=[...store._m.keys()].filter(k=>k.startsWith('hist/_inc/'));
  t('재실행도 고정 키 3개 유지(누적 0)', keys2.length===3);
  t('재실행 meta.records 여전히 불변', meta2.records===beforeRecords);

  // ── hist-stats가 hist/_inc/{type}를 셀에 반영하는지 ──
  delete require.cache[require.resolve(HS)];
  const hs=require(HS);
  // 아파트 gte10? low 270000000 → /10000=27000 → gte10. round1. 5건×3자산군이지만 usage 동일.
  // 셀 자격 minN 낮춰 조회.
  r=await hs.handler({ httpMethod:'GET', queryStringParameters:{ type:'0001', usage:'아파트', round:'1', tier:'gte10', minN:'3' } });
  b=JSON.parse(r.body);
  t('hist-stats가 증분 데이터로 셀 산출', b.status==='ok' && b.n>=3 && b.lr && typeof b.lr.p50==='number');

  // 정적: 배선
  const chSrc=require('fs').readFileSync(CH,'utf8'), hsSrc=require('fs').readFileSync(HS,'utf8');
  t('정적: 증분 고정키 쓰기', chSrc.includes('`hist/_inc/${cltrTypeCd}`'));
  t('정적: 날짜 이동 증분키 제거', !chSrc.includes('await store.setJSON(`hist/${start}_${end}/${cltrTypeCd}`, rows)'));
  t('정적: hist-stats incKeys 스캔', hsSrc.includes("/^hist\\/_inc\\/\\d+$/")&&hsSrc.includes('oldKeys.concat(incKeys)'));

  delete global.__FAKE_STORE__; delete global.fetch;
  console.log(`[fixture] ${n-bad}/${n} pass`);
  process.exit(bad?1:0);
})().catch(e=>{console.log('THROW',e);process.exit(1);});
