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
// ⚠️ base URL이 없으면 fetch가 상대 URL로 즉시 예외를 내고, collect-history는 그걸
// catch로 삼켜 빈 결과로 통과한다 — 이 파일의 옛 단언들은 **실제로 fetch를 한 번도 타지 않은 채**
// 통과하고 있었다(2026-08-02 발견). 실호출 경로를 실제로 밟게 하려면 반드시 세워야 한다.
process.env.URL = 'http://test.local';
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
      // 수의계약가능(0009) — 실제 부동산 개찰의 18.7%가 이 상태다. 학습 표본에 섞이면 안 된다.
      for(let i=0;i<3;i++) results.push({ id:cd+'-pv'+i, pbctCdtnNo:'1', statCd:'0009', winAmt:0, apslAmt:200000000, lowstAmt:70000000, usage:'오피스텔', round:9, opbdDt:'20260726' });
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
  t('정적: 증분 고정키 쓰기', chSrc.includes('`hist/_inc/${p.cltrTypeCd}`'));
  t('정적: 날짜 이동 증분키 제거', !chSrc.includes('await store.setJSON(`hist/${start}_${end}/${cltrTypeCd}`, rows)'));
  t('정적: hist-stats incKeys 스캔', hsSrc.includes("/^hist\\/_inc\\/\\d+$/")&&hsSrc.includes('oldKeys.concat(incKeys)'));

  // ── 수의계약(0009) 관측 축 — 학습 표본과 물리 분리 (2026-08-01) ──
  // 부동산 개찰의 18.7%가 이 상태인데 지금까지 통째로 버려서 채널을 측정할 수 없었다.
  // 다만 hist/_inc(학습 표본)에 섞으면 hist-stats 셀 표본과 backtest coverage가 함께 흔들린다 —
  // 관측을 늘리려다 진행 중인 모델 비교를 흔드는 건 맞바꿀 게 아니라 별도 키에 담는다.
  {
    const keys=[...store._m.keys()];
    const inc=keys.filter(k=>/^hist\/_inc\/\d+$/.test(k));
    const pv=keys.filter(k=>/^hist\/_incpvct\/\d+$/.test(k));
    t('수의계약 별도 키 생성', pv.length>0, pv.join(','));
    if(pv.length){
      const rows=await store.get(pv[0]);
      t('수의계약 키에 0009만', Array.isArray(rows)&&rows.length>0&&rows.every(r=>r.st==='0009'), JSON.stringify((rows||[]).map(r=>r.st)));
    }
    if(inc.length){
      const rows=await store.get(inc[0]);
      t('학습 표본에 0009 미혼입', Array.isArray(rows)&&rows.every(r=>r.st!=='0009'), JSON.stringify((rows||[]).map(r=>r.st)));
    }
    // 새 키가 hist-stats의 기존 스캔 정규식에 걸리면 셀이 오염된다 — 구조적으로 막혔는지 확인.
    const oldRe=/^hist\/\d{8}_\d{8}\/\d+$/, incRe=/^hist\/_inc\/\d+$/, featRe=/^hist\/feat\/\d{8}_\d{8}\/\d+$/;
    const probes=['hist/_incpvct/0001','hist/pvct/20250101_20250107/0001'];
    t('새 키가 hist-stats 스캔에 안 걸림',
      probes.every(k=>!oldRe.test(k)&&!incRe.test(k)&&!featRe.test(k)));
    // 백필 쪽도 같은 규율인지 정적 확인(수집 경로가 둘이라 한쪽만 고치면 반쪽이 된다)
    const bfSrc=require('fs').readFileSync(__dirname+'/../netlify/functions/collect-backfill.js','utf8');
    t('정적: 백필도 0009를 hist/pvct로 분리', bfSrc.includes('hist/pvct/')&&bfSrc.includes("PVCT_ST = '0009'"));
    t('정적: 백필 학습 표본은 0010/0011만', bfSrc.includes("r.statCd !== '0010' && r.statCd !== '0011'"));
  }

  // ── 증분 경로가 30초 벽을 넘지 않는가 (2026-08-02 복구) ──
  // 이 함수는 하트비트도 hist/_meta도 한 번도 남기지 못한 채 죽어 있었다. 조기 반환 경로가
  // 없으므로 "마지막 쓰기 전에 죽는다"는 뜻이고, 원인은 자산군 3개 × 5페이지를 **순차**로
  // 도는 구조였다. 느린 응답을 심어 그 실패를 재현하고, 고친 뒤엔 하트비트가 남는지 본다.
  {
    const s3 = makeStore(); global.__FAKE_STORE__ = s3;
    s3.set('hist/_state', { cursorEnd: '20200101' });   // 백필 완료 상태 → 증분 경로
    let calls = 0, maxConcurrent = 0, inflight = 0;
    global.fetch = async (url) => {
      calls++; inflight++; maxConcurrent = Math.max(maxConcurrent, inflight);
      await new Promise(r => setTimeout(r, 120));       // 느린 상위 API
      inflight--;
      const u = new URL(url), cd = u.searchParams.get('cltrTypeCd');
      const rows = Array.from({ length: 5 }, (_, i) => ({
        id: cd + '-t' + i, pbctCdtnNo: '1', statCd: '0010', winAmt: 1e8, winRate: 100, lowstRate: 110,
        apslAmt: 1.2e8, lowstAmt: 9e7, usage: '아파트', round: 1, opbdDt: '20260731', bidderCnt: 2 }));
      return { ok: true, json: async () => ({ results: rows }) };
    };
    delete require.cache[require.resolve(CH)];
    const t0 = Date.now();
    const r3 = await require(CH).handler({ queryStringParameters: {} });
    const ms = Date.now() - t0;
    t('증분: 200 응답', r3.statusCode === 200, r3.statusCode);
    // 핵심 — 죽지 않고 **하트비트가 남는다**. 이게 없어서 아무도 죽음을 몰랐다.
    const hb = await s3.get('_run/collect-history');
    t('증분: 하트비트 기록됨', !!hb && hb.ok === true, JSON.stringify(hb));
    t('증분: 소요시간을 하트비트에 남긴다', hb && typeof hb.incMs === 'number', hb && hb.incMs);
    // hist/_meta도 함께 — 이게 비어 있던 것이 죽음의 증거였다(hist-stats 캐시 태그 가운데 칸).
    const mt = await s3.get('hist/_meta');
    t('증분: hist/_meta 기록됨', !!mt && !!mt.updatedAt, JSON.stringify(mt));
    // 자산군 3개가 **병렬**로 나가야 순차 15콜의 벽을 피한다.
    t('증분: 자산군 병렬 수집', maxConcurrent >= 2, `최대 동시 ${maxConcurrent}`);
    // **페이지도 병렬이어야 한다** — 부동산 7일 창이 실측 8,711건(9페이지)이라 페이지를 순차로
    // 돌면 9 × 3.2초 ≈ 29초로 벽을 넘는다. totalCount로 페이지 수를 먼저 알아내는 게 핵심.
    t('증분: totalCount로 페이지 수 산출', /Math\.ceil\(total \/ INC_ROWS\)/.test(chSrc));
    t('증분: 남은 페이지 병렬 조회', /INC_CONC/.test(chSrc) && /Promise\.all\(chunk\.map/.test(chSrc));
    t('증분: 30초 안에 끝난다', ms < 25000, ms + 'ms');
    // 페이지 크기 — 100이면 부동산 7일치(약 6,000건)를 500건까지밖에 못 본다.
    t('증분: 페이지 1000행', /numOfRows=\$\{INC_ROWS\}/.test(chSrc) && /INC_ROWS = 1000/.test(chSrc));
    t('증분: 시간 예산 가드', /INC_BUDGET_MS/.test(chSrc) && /incTimeHit = true/.test(chSrc));
    // 반쪽은 여전히 덮어쓰지 않는다(어제치를 잃지 않는다) — 다만 그 사실을 기록한다.
    t('증분: 반쪽이면 스킵하고 기록', /if \(p\.partial\) \{ incSkipped\.push/.test(chSrc));
  }

  // ── 실측 재생: 전수 수집되는가 (2026-08-02) ──
  // 프로덕션 측정값을 그대로 심는다 — totalCount 부동산 8,711 / 자동차 220 / 동산 868.
  // 옛 구조(100행×5페이지 순차)는 부동산을 500건(5.7%)만 가져왔고 42초가 걸려 죽었다.
  {
    const s4 = makeStore(); global.__FAKE_STORE__ = s4;
    s4.set('hist/_state', { cursorEnd: '20200101' });
    const TOTAL = { '0001': 8711, '0002': 220, '0003': 868 };
    global.fetch = async (url) => {
      const u = new URL(url), cd = u.searchParams.get('cltrTypeCd');
      const n = +u.searchParams.get('numOfRows'), pg = +u.searchParams.get('page');
      const total = TOTAL[cd] || 0;
      const cnt = Math.max(0, Math.min(n, total - (pg - 1) * n));
      const rows = Array.from({ length: cnt }, (_, k) => ({
        id: cd + '-' + pg + '-' + k, pbctCdtnNo: '1', statCd: '0010', winAmt: 1e8, winRate: 100,
        lowstRate: 110, apslAmt: 1.2e8, lowstAmt: 9e7, usage: '아파트', round: 1, opbdDt: '20260731', bidderCnt: 2 }));
      return { ok: true, json: async () => ({ results: rows, totalCount: total }) };
    };
    delete require.cache[require.resolve(CH)];
    await require(CH).handler({ queryStringParameters: {} });
    const re = await s4.get('hist/_inc/0001');
    const car = await s4.get('hist/_inc/0002');
    const mv = await s4.get('hist/_inc/0003');
    t('전수: 부동산 8,711건 모두 수집', (re&&re.length)===8711, re&&re.length);
    t('전수: 자동차 220건', (car&&car.length)===220, car&&car.length);
    t('전수: 동산 868건', (mv&&mv.length)===868, mv&&mv.length);
    const hb4 = await s4.get('_run/collect-history');
    t('전수: 스킵 없음', hb4 && !hb4.incSkipped, JSON.stringify(hb4 && hb4.incSkipped));
  }

  delete global.__FAKE_STORE__; delete global.fetch;
  console.log(`[fixture] ${n-bad}/${n} pass`);
  process.exit(bad?1:0);
})().catch(e=>{console.log('THROW',e);process.exit(1);});
