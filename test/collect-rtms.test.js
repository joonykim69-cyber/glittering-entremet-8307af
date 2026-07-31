// collect-rtms fixture — 순수 함수 + 핸들러(fake store + mocked fetch) 검증. RTMS API 미호출.
const F = __dirname + '/../netlify/functions/collect-rtms.js';

function makeStore(){
  const m=new Map();
  return { _m:m,
    async get(k){ return m.has(k)?JSON.parse(JSON.stringify(m.get(k))):null; },
    async setJSON(k,v){ m.set(k, JSON.parse(JSON.stringify(v))); },
    set(k,v){ m.set(k, JSON.parse(JSON.stringify(v))); },
  };
}
let n=0,bad=0; const t=(k,c,x)=>{n++;if(!c){bad++;console.log('FAIL:',k,x!=null?x:'');}};

(async()=>{
  // 소규모 대상으로 작업목록을 작게 만든다(테스트 속도) — env로 축소.
  process.env.MKT_RTMS_LAWD='11680,11110'; // 강남·종로 2개
  process.env.MKT_RTMS_MONTHS='3';         // 3개월
  delete require.cache[require.resolve(F)];
  const mod=require(F); const T=mod._test;

  // ── 순수 함수 ──
  // mapTrade: amt·area 있으면 압축, 없으면 null
  t('mapTrade 정상', (()=>{const r=T.mapTrade({dealAmount:'120,000',excluUseAr:'84.99',dealDay:'5',floor:'10',umdNm:'대치동',buildYear:'2005',aptNm:'은마'}); return r&&r.amt===120000&&Math.abs(r.area-84.99)<0.01&&r.dong==='대치동'&&r.nm==='은마';})());
  t('mapTrade 금액0 → null', T.mapTrade({dealAmount:'0',excluUseAr:'80'})===null);
  t('mapTrade 면적0 → null', T.mapTrade({dealAmount:'50000',excluUseAr:''})===null);
  t('mapTrade offi 이름 폴백', T.mapTrade({dealAmount:'30000',excluUseAr:'30',offiNm:'오피스텔A'}).nm==='오피스텔A');

  // recentMonths: 최신 먼저, 개수, 형식
  const ms=T.recentMonths(3);
  t('recentMonths 개수', ms.length===3);
  t('recentMonths 최신먼저(내림차순)', ms[0]>ms[1]&&ms[1]>ms[2]);
  t('recentMonths YYYYMM 형식', ms.every(x=>/^\d{6}$/.test(x)));
  // 연말 경계: 12→1월로 넘어가며 연도 감소
  const around=T.recentMonths(4);
  t('recentMonths 월 경계 정상(중복 없음)', new Set(around).size===4);

  // buildWorklist: 월×시군구×4종
  const wl=T.buildWorklist(['202606','202605'], ['11680','11110']);
  t('buildWorklist 크기 = 월×구×4', wl.length===2*2*4);
  t('buildWorklist 항목 필드', wl[0].ym&&wl[0].lawd&&wl[0].k&&wl[0].svc);
  t('buildWorklist 월 우선(최신 먼저)', wl[0].ym==='202606'&&wl[wl.length-1].ym==='202605');

  // ── 핸들러: fake store + mocked fetch ──
  const store=makeStore(); global.__FAKE_STORE__=store; store.set('hist/_bfmeta',{done:true});
  process.env.URL='http://test.local';
  // 각 rtms-svc 호출은 lawd·kind·ym에 따라 2건씩 반환(빈 셀도 일부)
  let fetchCalls=0;
  global.fetch=async(url)=>{
    fetchCalls++;
    const u=new URL(url);
    const svc=u.searchParams.get('svc'), lawd=u.searchParams.get('lawdCd'), ymd=u.searchParams.get('dealYmd');
    // sh(단독)만 빈 응답으로 → 빈 셀 저장 안 됨 검증
    const empty = svc==='sh_trade';
    const items = empty?[]:[
      {dealAmount:'100000',excluUseAr:'84.9',dealDay:'3',floor:'5',umdNm:'동',buildYear:'2000',aptNm:'A'},
      {dealAmount:'0',excluUseAr:'80'}, // 걸러짐
      {dealAmount:'90000',excluUseAr:'59.8',dealDay:'12',floor:'2',umdNm:'동',buildYear:'2010',aptNm:'B'},
    ];
    return { ok:true, json:async()=>({ svc, items, totalCount:items.length }) };
  };

  // 시간예산이 크므로 한 번에 다 처리될 수도 있음 — 작업목록이 작으니(2구×4종×3월=24) OK
  const ev={queryStringParameters:{}};
  let r=await mod.handler(ev); let b=JSON.parse(r.body);
  t('핸들러 성공', b.ok===true);
  // 저장 키: 유효 셀(apt/offi/rh)만, sh는 빈 응답이라 미저장
  const keys=[...store._m.keys()].filter(k=>k.startsWith('mkt/rtms/')&&!k.startsWith('mkt/rtms/_'));
  t('빈 셀(sh) 미저장', keys.every(k=>!/_sh\//.test(k)), keys.filter(k=>/_sh\//.test(k)).join(','));
  t('유효 셀 저장됨(apt/offi/rh)', keys.some(k=>/_apt\//.test(k))&&keys.some(k=>/_offi\//.test(k))&&keys.some(k=>/_rh\//.test(k)));
  // 저장된 셀의 값: 금액0 걸러 2건
  const sampleKey=keys.find(k=>/_apt\//.test(k)); const sample=await store.get(sampleKey);
  t('압축 실거래 2건(금액0 제외)', Array.isArray(sample)&&sample.length===2, sample&&sample.length);
  t('압축 스키마', sample[0].amt>0&&sample[0].area>0&&'dd'in sample[0]&&'nm'in sample[0]);
  // 메타·커서·하트비트
  const meta=await store.get('mkt/rtms/_meta'); const stt=await store.get('mkt/rtms/_state'); const hb=await store.get('_run/collect-rtms');
  t('메타 records>0', meta&&meta.records>0, meta&&meta.records);
  t('done=true(작업 다 처리)', meta.done===true&&b.done===true);
  t('커서 idx=작업목록 끝', stt.idx===24, stt&&stt.idx);
  t('하트비트 기록', hb&&hb.ok===true&&hb.done===true);

  // 재실행 → 이미 done(idx≥끝)이라 no-op, fetch 추가 호출 0
  const before=fetchCalls;
  r=await mod.handler(ev); b=JSON.parse(r.body);
  t('재실행 no-op(done)', b.done===true);
  t('재실행 시 fetch 0(idx 끝)', fetchCalls===before, `+${fetchCalls-before}`);

  // reset → 커서 초기화 후 재수집 가능
  r=await mod.handler({queryStringParameters:{reset:'1',confirm:'1'}}); b=JSON.parse(r.body);
  t('reset 후 재수집됨', b.ok===true&&b.addedThisRun>0);

  // status=1 → 수집 안 함
  const fc2=fetchCalls;
  r=await mod.handler({queryStringParameters:{status:'1'}}); b=JSON.parse(r.body);
  t('status=1 조회만(fetch 0)', fetchCalls===fc2&&b.meta!=null);

  // ── 전국 확장 (2026-07-31) ──
  // 랜딩 차익 트랙이 0건이던 원인이 "시세 밴드가 서울에만 있음"이라 대상을 전국으로 넓혔다.
  t('전국 목록은 lib/lawd 단일 출처', Array.isArray(T.ALL_LAWDS)&&T.ALL_LAWDS.length>200, T.ALL_LAWDS&&T.ALL_LAWDS.length);
  t('전국 목록에 중복 없음', new Set(T.ALL_LAWDS).size===T.ALL_LAWDS.length);
  t('전국 목록이 서울 25구를 포함', ['11110','11680','11740'].every(c=>T.ALL_LAWDS.includes(c)));
  t('전국 목록이 서울 밖도 포함(안성·당진·경산)', ['41550','44270','47290'].every(c=>T.ALL_LAWDS.includes(c)));
  t('env로 좁히면 그 목록만', T.LAWDS.length===2, T.LAWDS.join(','));

  // ── 실패는 "거래 없음"과 다르다 ──
  // 전국 확장으로 호출이 10배가 되면 일일 쿼터 소진이 현실적 위험이다. 실패한 셀을 조용히
  // 넘기면(예전 동작) 그 지점 이후가 통째로 비는데, meta.done은 true가 되어 "완료"라고 말한다.
  const s2=makeStore(); global.__FAKE_STORE__=s2;
  let failMode=true;
  global.fetch=async(url)=>{
    const u=new URL(url); const svc=u.searchParams.get('svc');
    if (failMode && svc==='rh_trade') throw new Error('HTTP 429'); // 쿼터 소진 흉내
    const items=[{dealAmount:'100000',excluUseAr:'84.9',dealDay:'3',floor:'5',umdNm:'동',buildYear:'2000',aptNm:'A'}];
    return { ok:true, json:async()=>({ svc, items, totalCount:items.length }) };
  };
  // 작업 순서는 월×구×(apt,offi,rh,sh) → 인덱스 2가 첫 rh(실패 지점)
  r=await mod.handler(ev); b=JSON.parse(r.body);
  let st=await s2.get('mkt/rtms/_state');
  t('실패 지점 앞까지만 전진(건너뛰지 않음)', st.idx===2, st&&st.idx);
  t('실패를 보고한다', !!b.lastError, b.lastError);
  t('실패했으면 done 아님', b.done!==true);
  // 같은 지점에서 계속 실패하면 MAX_STUCK 뒤에 한 칸 건너뛴다(영구 정지 방지) — 단, 조용히는 아니다
  for (let i=0;i<T.MAX_STUCK-1;i++) { r=await mod.handler(ev); }
  b=JSON.parse(r.body); st=await s2.get('mkt/rtms/_state');
  t('반복 실패 시 한 칸 건너뜀', st.idx===3, st&&st.idx);
  t('건너뛴 셀을 기록한다', b.skipped>0||(b.meta&&b.meta.skipped>0), JSON.stringify(b.skipped));
  // 실패가 걷히면 이어서 정상 수집
  failMode=false;
  r=await mod.handler(ev); b=JSON.parse(r.body);
  t('실패 해소 후 이어서 수집', b.addedThisRun>0&&!b.lastError, b.addedThisRun);

  // ── 수집 범위가 바뀌면 커서를 버린다 ──
  // 커서는 작업목록 배열의 인덱스라, 서울 25구(2,400) → 전국(24,288)으로 넓히면 같은 idx가
  // 전혀 다른 작업을 가리킨다. 이어받으면 앞쪽 달의 새 지역이 영영 수집되지 않는다.
  const beforeScope=(await s2.get('mkt/rtms/_state')).scope;
  process.env.MKT_RTMS_LAWD='11680,11110,41550'; // 안성 추가 = 범위 확장
  delete require.cache[require.resolve(F)];
  const mod2=require(F);
  t('범위가 바뀌면 지문도 바뀐다', mod2._test.SCOPE!==beforeScope);
  r=await mod2.handler(ev); b=JSON.parse(r.body);
  st=await s2.get('mkt/rtms/_state');
  t('범위 변경 시 커서 초기화 보고', b.rescoped===true);
  t('범위 변경 시 처음부터 재수집', st.idx>0&&st.scope===mod2._test.SCOPE&&b.meta.records>0);
  t('범위 변경 시 meta도 새로 시작', b.meta.rescopedAt!=null);
  // 같은 범위로 다시 돌리면 초기화하지 않는다(매 실행 리셋은 영원히 안 끝난다는 뜻)
  const idxAfter=st.idx;
  r=await mod2.handler(ev); b=JSON.parse(r.body);
  st=await s2.get('mkt/rtms/_state');
  t('같은 범위면 초기화 없이 이어감', b.rescoped!==true&&st.idx>=idxAfter, `${idxAfter}→${st.idx}`);

  delete global.__FAKE_STORE__; delete global.fetch;
  console.log(`\n[collect-rtms fixture] ${n-bad}/${n} pass  (records=${meta.records}, cells=${meta.cellMonths}, 전국=${T.ALL_LAWDS.length}곳)`);
  process.exit(bad?1:0);
})().catch(e=>{console.log('THROW',e);process.exit(1);});
