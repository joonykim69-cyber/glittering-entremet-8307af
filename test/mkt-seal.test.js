// mkt-seal-daily fixture — 봉인 불변·멱등 채점·근거없으면 미봉인 검증. 외부 API 미호출.
const F = __dirname + '/../netlify/functions/mkt-seal-daily.js';

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
const tr=(...vals)=>vals.map(v=>({amt:v*100,area:100})); // ㎡당 v

const mod=require(F); const T=mod._test;

// ── 순수 함수 ──
const months={};
for(const ym of ['202601','202602','202603','202604','202605','202606']) months[ym]=tr(900,950,1000,1050,1100);
const band=T.bandFor(months,'apt','202606');
t('bandFor 밴드 생성', band&&band.lo>0&&band.lo<=band.mid&&band.mid<=band.hi, JSON.stringify(band));
t('bandFor 창 6개월×5건=30', band.n===30, band&&band.n);
t('bandFor 미래 미참조(as-of)', (()=>{const m2=Object.assign({},months); m2['202607']=tr(5000,5000,5000); const b2=T.bandFor(m2,'apt','202606'); return b2.mid===band.mid;})());
t('표본<5면 미봉인(null)', T.bandFor({'202606':tr(1000,1000)},'apt','202606')===null);
t('rh는 12개월 창', T.WIN.rh===12);

// gradeSeal
const seal={lo:950,mid:1000,hi:1050};
let g=T.gradeSeal(seal, tr(980,1000,1020));
t('gradeSeal 적중', g&&g.hit===1&&g.errPct===0, JSON.stringify(g));
g=T.gradeSeal(seal, tr(2000,2000));
t('gradeSeal 빗나감', g&&g.hit===0&&g.errPct===50, JSON.stringify(g));
t('gradeSeal 커버리지', T.gradeSeal(seal,tr(1000,5000)).coverage===50);
t('gradeSeal 표본0 → null', T.gradeSeal(seal,[])===null);

(async()=>{
  // ── 데이터 없음 ──
  let store=makeStore(); global.__FAKE_STORE__=store;
  let r=await mod.handler({queryStringParameters:{}}); let b=JSON.parse(r.body);
  t('데이터 없으면 empty', b.status==='empty');

  // ── 봉인 + 채점 ──
  store=makeStore(); global.__FAKE_STORE__=store;
  store.set('mkt/rtms/_meta',{records:100});
  const nowYm=(()=>{const d=new Date(Date.now()+9*3600*1000);return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}`;})();
  const pm=k=>{let y=+nowYm.slice(0,4),m=+nowYm.slice(4,6)-k;while(m<1){m+=12;y--;}return `${y}${String(m).padStart(2,'0')}`;};
  // 셀A: 최근 6개월 데이터 → 봉인 가능
  for(let k=0;k<6;k++) store.set(`mkt/rtms/11680_apt/${pm(k)}`, tr(900,950,1000,1050,1100));
  // 셀B: 표본 부족(2건) → 미봉인
  store.set(`mkt/rtms/11110_offi/${pm(0)}`, tr(1000,1000));

  r=await mod.handler({queryStringParameters:{}}); b=JSON.parse(r.body);
  t('핸들러 성공', b.ok===true);
  t('셀A 봉인됨', b.sealed===1, 'sealed='+b.sealed);
  t('셀B 근거부족 미봉인', b.noBasis===1, 'noBasis='+b.noBasis);
  const sealA=await store.get(`mkt/seal/11680_apt/${nowYm}`);
  t('봉인 블롭 기록', sealA&&sealA.lo>0&&sealA.v==='mkt-seal-v1');
  t('미봉인 셀은 블롭 없음', (await store.get(`mkt/seal/11110_offi/${nowYm}`))===null);
  t('아직 정답 없어 pending', b.pending>=1, 'pending='+b.pending);

  // ── 봉인 불변: 실거래가 바뀌어도 재실행이 덮어쓰지 않음 ──
  const before=JSON.stringify(sealA);
  for(let k=0;k<6;k++) store.set(`mkt/rtms/11680_apt/${pm(k)}`, tr(5000,5000,5000,5000,5000)); // 시세 급변
  r=await mod.handler({queryStringParameters:{}}); b=JSON.parse(r.body);
  const sealA2=await store.get(`mkt/seal/11680_apt/${nowYm}`);
  t('★ 봉인 불변(재실행 덮어쓰기 없음)', JSON.stringify(sealA2)===before, sealA2&&sealA2.mid);
  t('기존 봉인 skip 카운트', b.skippedExisting===1, b.skippedExisting);

  // ── 채점: 과거 봉인 + 다음달 실거래 도착 ──
  store=makeStore(); global.__FAKE_STORE__=store;
  store.set('mkt/rtms/_meta',{records:100});
  store.set('mkt/seal/11680_apt/202601',{v:'mkt-seal-v1',cell:'11680_apt',kind:'apt',ym:'202601',lo:950,mid:1000,hi:1050,n:30,sealedAt:'x'});
  store.set('mkt/rtms/11680_apt/202602', tr(1000,1010,990)); // 정답 도착 → 적중
  r=await mod.handler({queryStringParameters:{}}); b=JSON.parse(r.body);
  t('채점 1건', b.graded===1, 'graded='+b.graded);
  const scored=await store.get('mkt/seal/11680_apt/202601');
  t('result 덧붙음', scored&&scored.result&&scored.result.hit===1);
  t('★ 채점이 봉인값 안 건드림', scored.lo===950&&scored.mid===1000&&scored.hi===1050);
  t('agg 집계', b.summary.overall.n===1&&b.summary.overall.hitRate===100, JSON.stringify(b.summary.overall));

  // ── 멱등: 재실행해도 이중 집계 없음 ──
  r=await mod.handler({queryStringParameters:{}}); b=JSON.parse(r.body);
  t('★ 재실행 이중집계 0(n 그대로)', b.summary.overall.n===1, b.summary.overall.n);
  t('재채점 없음(alreadyGraded)', b.graded===0&&b.alreadyGraded===1, `g=${b.graded} a=${b.alreadyGraded}`);

  // ── dry=1: 쓰지 않음 ──
  store=makeStore(); global.__FAKE_STORE__=store;
  store.set('mkt/rtms/_meta',{records:100});
  for(let k=0;k<6;k++) store.set(`mkt/rtms/11680_apt/${pm(k)}`, tr(900,1000,1100,950,1050));
  r=await mod.handler({queryStringParameters:{dry:'1'}}); b=JSON.parse(r.body);
  t('dry=1 봉인 블롭 미기록', (await store.get(`mkt/seal/11680_apt/${nowYm}`))===null);
  t('dry=1 agg 미기록', (await store.get('mkt/agg'))===null);
  const hb=await store.get('_run/mkt-seal-daily'); t('하트비트 기록', hb&&hb.ok===true);

  delete global.__FAKE_STORE__;
  console.log(`\n[mkt-seal fixture] ${n-bad}/${n} pass`);
  process.exit(bad?1:0);
})().catch(e=>{console.log('THROW',e);process.exit(1);});
