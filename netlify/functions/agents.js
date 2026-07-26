// netlify/functions/agents.js
// 전문 에이전트 라우터 — 부동산 전문가(expert) / 지역 전문가(region) / 경쟁 강도(competition) /
//   권리분석 도우미(rights, B단계) / 매각조건 리스크(sale_risk, D단계) / 뉴스·정보(news, C단계).
//   rights·sale_risk는 needsPbanc:true → 공고 계열(cltr_dtl_bidinf→pbanc_dtl) 체이닝으로 공고종류·취소사유·회차·보증금 팩트 수집.
//   news는 needsNews:true → naver-news 프록시로 소재 시군구 부동산 뉴스 수집(NAVER 키 미설정 시 뉴스 없음으로 degrade).
//
// 설계 의도(CLAUDE.md "전문 에이전트 시스템" 메모 참조):
//   - 에이전트 분석은 봉인 예측을 절대 직접 수정하지 않는다. 사용자 근거 표시 +
//     (추후) 수치 피처화 → 챌린저 검증 경유만 허용.
//   - 팩트가 없으면 생성하지 않는다: 서버가 실데이터(봉인 예측·캠코 통계·hist 셀)를
//     수집해 프롬프트에 주입하고, "주어진 데이터에 없는 사실을 만들지 말라"를 강제한다.
//   - 비용 통제: 물건·조건·에이전트당 1회 생성 후 Blobs 캐시(agent/{agent}/{id}_{cdtn}).
//
// 사용법: POST { agent: 'expert'|'region'|'competition'|'rights'|'sale_risk'|'news',
//               item: { id, pbctCdtnNo, title, usage, type, appr(만원), min(만원), fail, address, assetClass } }
// 응답:   { agent, cached, analysis, facts, disclaimer, generatedAt }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

async function openLedger(event) {
  const blobs = await import('@netlify/blobs');
  try { if (event && typeof blobs.connectLambda === 'function') blobs.connectLambda(event); } catch (e) { /* 신형 런타임은 자동 구성 */ }
  try {
    return blobs.getStore('ledger');
  } catch (e) {
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token = process.env.NETLIFY_BLOBS_TOKEN;
    if (siteID && token) return blobs.getStore({ name: 'ledger', siteID, token });
    throw e;
  }
}

function fmtMan(man) {
  if (!(man > 0)) return '미공개';
  if (man >= 10000) return (man / 10000).toFixed(man % 10000 === 0 ? 0 : 1) + '억원';
  return Math.round(man).toLocaleString() + '만원';
}
const clean = (v, n) => String(v == null ? '' : v).replace(/[<>]/g, '').slice(0, n);

async function fetchJson(url, opts) {
  try {
    const r = await fetch(url, opts);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

// ── 동산 품목 카테고리 감지(물건명·용도 키워드) + 시세 확인 채널(2026-07-26 창업자 승인) ──
// 원칙: 시세 "숫자"는 절대 생성하지 않는다. 대신 입찰자가 어차피 찾아볼 확인 채널을 짚어주고,
// "채널에서 확인한 시세 − (최저가+부대비용)" 프레임으로 스스로 여력을 판단하게 안내한다.
const MV_CATS = [
  { key: 'watch',   name: '명품시계',        re: /시계|롤렉스|오메가|파텍|브레게|까르띠에|브라이틀링|태그호이어|IWC|튜더|파네라이|오데마|바쉐론/i,
    ch: '구구스·바이버(국내 실거래가)·크로노24(해외 호가)·시계 전문 거래소에서 모델명·레퍼런스 번호로 검색 / 재판매: 위탁(수수료 차감) 또는 시계 커뮤니티 직거래',
    pts: '감정평가서(관련문서)의 부속품 내역에서 보증서(개런티카드)·박스 유무 확인(보증서 유무로 재판매가가 큰 폭 차이), 보증서 스탬핑 연식, 보관기관에 공람 신청 후 실견(무브먼트 작동·베젤/유리 흠집·밴드 절단 여부 — 정식센터 수리비는 큰 감가 요인), 현상태 인도 원칙, 가품 판명 시 환불·배상 조항은 공고문에서 확인' },
  { key: 'luxury',  name: '명품잡화',        re: /핸드백|가방|루이비통|샤넬|에르메스|구찌|프라다|디올|명품/i,
    ch: '구구스·필웨이·크림(KREAM) 등 중고 명품 플랫폼에서 모델명 검색',
    pts: '정품 보증 자료 유무, 사용감·수선 이력, 구성품(더스트백·보증서) — 실견 필수' },
  { key: 'gold',    name: '귀금속·보석',      re: /금괴|골드바|순금|귀금속|다이아|보석|반지|목걸이|팔찌/i,
    ch: '한국금거래소 고시가(금·은 시세)·종로 귀금속상가 감정',
    pts: '중량·순도(감정서 기준), 감정서 발급기관 — 보석은 감정 등급에 따라 가치 차이 큼' },
  { key: 'golf',    name: '골프회원권',       re: /골프.*회원권|컨트리클럽|CC\s*회원권|회원권.*골프/i,
    ch: '에이스회원권·동아회원권 등 회원권 거래소 시세표에서 해당 골프장 검색',
    pts: '명의개서 절차·비용, 입회금 반환 조건, 골프장 운영 상태(회생·워크아웃 여부)' },
  { key: 'condo',   name: '콘도·리조트 회원권', re: /콘도|리조트.*회원권|휘트니스.*회원권/i,
    ch: '회원권 거래소 시세표에서 해당 리조트 검색',
    pts: '연회비·관리비 체납 승계 여부, 이용 조건(성수기 배정), 운영사 재무 상태' },
  { key: 'art',     name: '골동품·미술품',     re: /골동품|미술품|그림|회화|도자기|서화|공예품|조각/i,
    ch: '서울옥션·케이옥션 과거 낙찰 기록 검색, 전문 감정기관 의뢰',
    pts: '진위 감정이 가치의 대부분 — 감정서 유무·발급기관, 작가·작품 이력, 보존 상태' },
  { key: 'elec',    name: '전자기기·가전',     re: /노트북|컴퓨터|TV|텔레비전|냉장고|가전|휴대폰|스마트폰|카메라|모니터/i,
    ch: '당근마켓·번개장터·중고나라에서 동일 모델 검색',
    pts: '작동 여부 확인 불가 전제(보관품), 연식 대비 감가 큼, 수량물이면 일괄 인수·운반 계획' },
  { key: 'machine', name: '기계장비',         re: /기계|장비|선반|밀링|프레스|CNC|지게차|굴착기|중장비|공작/i,
    ch: '중고 기계 거래 플랫폼·업계 딜러 견적 문의',
    pts: '작동·정비 이력 확인 불가 전제, 해체·운반·설치 비용이 큼(견적 선확인), 설치 장소 확보' },
  { key: 'stock',   name: '유가증권·지분',     re: /주식|지분|출자|증권|채권/i,
    ch: '비상장 주식은 증권플러스 비상장 등에서 거래 여부 확인(비거래 종목은 가치평가 자체가 난제)',
    pts: '발행사 재무 상태·계속기업 여부, 양도 제한 조건, 환금성(매수자 존재 여부)' },
];
function detectMvCategory(title, usage) {
  const s = `${title || ''} ${usage || ''}`;
  for (const c of MV_CATS) if (c.re.test(s)) return c;
  return { key: 'etc', name: '일반 동산', ch: '당근마켓·중고나라 등 중고 플랫폼에서 동일 품명 검색', pts: '상태·수량 실견 확인, 보관비·운반비, 인도 방법' };
}

// 물건 type → 캠코 통계 용도 분류 (bidcast.html STAT_BUCKET과 동일 체계)
const STAT_BUCKET = {
  '아파트': '아파트', '단독주택': '단독주택/다가구', '연립다세대': '연립주택/다세대/빌라',
  '오피스텔': '기타주거용건물', '토지': '토지', '농지임야': '임야',
  '상가': '근린생활시설', '사무실': '비주거용건물', '공장창고': '산업용및용도복합용건물등',
};

// ── 공고 계열 체이닝: 물건 → cltr_dtl_bidinf(pbancMngNo·보증금·입찰조건) → pbanc_dtl(공고종류·취소사유·회차) ──
// 권리분석 도우미(rights)·매각조건 리스크(sale_risk) 전용. 라이브 물건에서만 유효(둘 다 없으면 null).
async function gatherPbanc(base, it) {
  const enc = encodeURIComponent;
  const bi = await fetchJson(`${base}/.netlify/functions/onbid-svc?svc=cltr_dtl_bidinf&cltrMngNo=${enc(it.id)}&pbctCdtnNo=${enc(it.pbctCdtnNo)}`);
  const b = bi && Array.isArray(bi.items) ? bi.items[0] : null;
  if (!b) return null;
  const pbancMngNo = b.pbancMngNo || '';
  let p = null;
  if (pbancMngNo) {
    const pd = await fetchJson(`${base}/.netlify/functions/onbid-svc?svc=pbanc_dtl&pbancMngNo=${enc(pbancMngNo)}`);
    p = pd && Array.isArray(pd.items) ? pd.items[0] : null;
  }
  return { b, p, pbancMngNo };
}

// ── 지역 뉴스 수집(news 에이전트 전용): 물건 소재 시군구 + 부동산 키워드로 네이버 뉴스 검색 ──
async function gatherNews(base, it) {
  const parts = String(it.address || '').split(/\s+/).filter(Boolean);
  const sgg = parts[1] || parts[0] || ''; // 시군구(없으면 시도)
  if (!sgg) return null;
  const query = `${sgg} 부동산`;
  const d = await fetchJson(`${base}/.netlify/functions/naver-news?query=${encodeURIComponent(query)}&display=5&sort=date`);
  if (!d || !Array.isArray(d.items) || !d.items.length) return null;
  return { query, items: d.items.slice(0, 5) };
}

// ── 거시·금리 수집(macro 에이전트 전용): 한국은행 ECOS 기준금리·시장금리 최근값+추세 ──
async function gatherMacro(base) {
  const d = await fetchJson(`${base}/.netlify/functions/ecos-svc`);
  if (!d || !Array.isArray(d.series)) return null;
  const ok = d.series.filter(s => s && !s.error && s.latest && s.latest.value != null);
  return ok.length ? { series: ok } : null;
}

// ── 부동산원 주택가격지수 수집(region 에이전트 전용): R-ONE 최근값+3/6/12개월 변동 ──
async function gatherRone(base, sido) {
  // 물건 소재 시도를 넘겨 지역별 지수(예 부산 물건 → 부산 아파트 매매가격지수)를 받는다.
  // 지역 미매칭이면 rone-svc가 전국으로 폴백. 시도 미상이면 파라미터 없이(env 기본=전국) 호출.
  const q = sido ? `?region=${encodeURIComponent(sido)}` : '';
  const d = await fetchJson(`${base}/.netlify/functions/rone-svc${q}`);
  if (!d || d.status !== 'ok' || !d.latest) return null;
  return d;
}

// ── 공용 팩트 수집: 봉인 예측(pred/predb) + 캠코 용도/지역 통계 + hist 셀 (+ 에이전트별 공고/뉴스/거시) ──
async function gatherFacts(store, base, it, agent) {
  const predKey = `${it.id}_${it.pbctCdtnNo}`;
  const typeCd = it.assetClass === '동산' ? '0003' : it.assetClass === '자동차' ? '0002' : '0001';
  const sido = String(it.address || '').split(/\s+/)[0] || '';

  const now = new Date(Date.now() + 9 * 3600 * 1000);
  const y = now.getUTCFullYear(), q = Math.ceil((now.getUTCMonth() + 1) / 3);
  const perds = [String(y), `${y}-${q}`, ...(q > 1 ? [`${y}-${q - 1}`] : []), String(y - 1)];

  const [pred, predB, cell, pbanc, news, macro, rone] = await Promise.all([
    store.get(`pred/${predKey}`, { type: 'json' }),
    store.get(`predb/${predKey}`, { type: 'json' }),
    fetchJson(`${base}/.netlify/functions/hist-stats?type=${typeCd}&usage=${encodeURIComponent(it.usage || it.type || '기타')}&round=${(Number(it.fail) || 0) + 1}&lowMan=${Number(it.min) || 0}`),
    agent && agent.needsPbanc ? gatherPbanc(base, it) : Promise.resolve(null),
    agent && agent.needsNews ? gatherNews(base, it) : Promise.resolve(null),
    agent && agent.needsMacro ? gatherMacro(base) : Promise.resolve(null),
    agent && agent.needsRone ? gatherRone(base, sido) : Promise.resolve(null),
  ]);

  let usg = null, rgn = null;
  for (const perd of perds) {
    if (!usg) {
      const d = await fetchJson(`${base}/.netlify/functions/onbid-svc?svc=stat_usg&statsTypeCd=0041&inqPerd=${encodeURIComponent(perd)}`);
      if (d && Array.isArray(d.items) && d.items.length) {
        const bucket = STAT_BUCKET[it.type] || null;
        usg = { perd, row: d.items.find(r => String(r.clsCdNm || '').trim() === bucket) || d.items.find(r => String(r.clsCdNm || '').trim() === '전체') || null };
        const dr = await fetchJson(`${base}/.netlify/functions/onbid-svc?svc=stat_rgn&statsTypeCd=0021&inqPerd=${encodeURIComponent(perd)}`);
        if (dr && Array.isArray(dr.items)) {
          rgn = { perd, row: dr.items.find(r => String(r.clsCdNm || '').trim().startsWith(sido.slice(0, 2))) || null };
        }
        break;
      }
    }
  }

  return { pred: pred || null, predB: predB || null, cell: cell && cell.status === 'ok' ? cell : null, usg, rgn, sido, pbanc: pbanc || null, news: news || null, macro: macro || null, rone: rone || null };
}

// 팩트를 프롬프트용 텍스트로 직렬화 — 없는 항목은 "없음"으로 명시해 창작을 차단
function factsText(it, f) {
  const L = [];
  if (it.extra) L.push(`클라이언트 확인 정보(상세 API): ${clean(it.extra, 500)}`);
  L.push(`물건: ${clean(it.title, 80)} / 용도: ${clean(it.usage || it.type, 40)} / 소재지: ${clean(it.address, 60) || '미상'}`);
  L.push(`감정가: ${fmtMan(Number(it.appr))} / 최저입찰가: ${fmtMan(Number(it.min))} / 유찰: ${Number(it.fail) || 0}회`);
  // 동산·차량: 품목 카테고리 감지 + 시세 확인 채널·확인 포인트 주입(시세 숫자는 채널 확인으로만 — 생성 금지)
  if (it.assetClass === '동산') {
    const cat = detectMvCategory(it.title, it.usage || it.type);
    L.push(`품목 카테고리(물건명 기반 감지): ${cat.name}`);
    L.push(`시세 확인 채널(참고): ${cat.ch}`);
    L.push(`품목 확인 포인트: ${cat.pts}`);
  } else if (it.assetClass === '자동차' || it.type === '차량') {
    L.push(`시세 확인 채널(참고): 엔카·KB차차차·헤이딜러 등에서 동일 차종·연식 검색`);
    L.push(`차량 확인 포인트: 압류·저당 승계 및 체납 과태료 여부(공고문 확인), 주행거리·사고이력 미표기 전제, 보관소 실차 확인, 이전등록비·취득세 부대비용`);
  }
  // 유찰 진단 카드(클라이언트, 규칙 기반)와 겹치는 에이전트에 한해 요약 주입 — 결론 반복 방지용 참고 자료.
  if (it.failDiag) L.push(`[참고] 사용자가 이미 화면에서 본 "유찰 진단" 요약(규칙 기반, 반복 금지 — 아래 사실을 근거로 이 위에 새로운 관점만 추가하세요): ${clean(it.failDiag, 300)}`);
  L.push(f.pred
    ? `봉인된 AI 예측(v0.1, 개찰 전 봉인·수정불가): 구간 ${fmtMan(f.pred.lo)} ~ ${fmtMan(f.pred.hi)} (중앙값 ${fmtMan(f.pred.mid)}), 근거: 캠코 ${clean(f.pred.statBucket, 30)} 낙찰가율 통계(${clean(f.pred.statPerd, 20)})`
    : '봉인된 AI 예측: 없음');
  if (f.predB) L.push(`챌린저 예측(v0.5 실측 분위수): ${fmtMan(f.predB.lo)} ~ ${fmtMan(f.predB.hi)} (표본 ${f.predB.cellN}건, 셀 ${clean(f.predB.cellKey, 60)})`);
  L.push(f.usg && f.usg.row
    ? `캠코 용도별 통계(${f.usg.perd}, ${clean(f.usg.row.clsCdNm, 30).trim()}): 낙찰 ${Number(f.usg.row.mtSumCnt) || 0}건, 감정가 대비 낙찰가율 ${f.usg.row.scfbAmtRto1 || '?'}%, 최저가 대비 ${f.usg.row.scfbAmtRto2 || '?'}%, 낙찰률 ${f.usg.row.scbrt || '?'}%, 경쟁률 ${clean(f.usg.row.compRate, 12) || '?'}`
    : '캠코 용도별 통계: 없음');
  L.push(f.rgn && f.rgn.row
    ? `캠코 지역 통계(${f.rgn.perd}, ${clean(f.rgn.row.clsCdNm, 20).trim()}): 낙찰 ${Number(f.rgn.row.mtSumCnt) || 0}건, 감정가 대비 낙찰가율 ${f.rgn.row.scfbAmtRto1 || '?'}%, 낙찰률 ${f.rgn.row.scbrt || '?'}%, 경쟁률 ${clean(f.rgn.row.compRate, 12) || '?'}`
    : `캠코 지역 통계: 없음 (소재지 ${clean(f.sido, 12) || '미상'})`);
  L.push(f.cell
    ? `실측 이력 셀(${clean(f.cell.key, 60)}, 표본 ${f.cell.n}건): 최저가 대비 낙찰가율 p10 ${f.cell.lr.p10}% / 중앙값 ${f.cell.lr.p50}% / p90 ${f.cell.lr.p90}%${f.cell.failRate != null ? `, 유찰율 ${f.cell.failRate}%` : ''}`
    : '실측 이력 셀: 아직 없음 (학습 데이터 축적 중)');
  // 공고·매각조건 정보 (rights·sale_risk 전용, 라이브 물건만) — 없으면 항목 자체를 넣지 않아 창작 유도를 피함
  if (f.pbanc) {
    const b = f.pbanc.b || {}, p = f.pbanc.p || {};
    const yn = v => v === 'Y' ? '가능' : v === 'N' ? '불가' : '미상';
    L.push(`공고관리번호: ${clean(f.pbanc.pbancMngNo, 30) || '미상'}`);
    L.push(`보증금 조건: ${clean(b.pbctTdpsCont, 40) || '미상'} / 대금납부: ${clean(b.pmtnPayMtdCont, 20) || '미상'} ${clean(b.pcmtPayTermCont, 30) || ''} / 공동입찰 ${yn(b.collBidPsblYn)} · 대리입찰 ${yn(b.subtBidPsblYn)} · 2회이상입찰 ${yn(b.twtnGthrBidPsblYn)}`);
    if (p) {
      L.push(`공고종류: ${clean(p.pbancKindNm, 20) || '미상'}${p.pbancRtrcnRsnCont ? ` / 공고취소사유: ${clean(p.pbancRtrcnRsnCont, 120)}` : ' / 공고취소사유: 없음'} / 공고회차: ${clean(p.pbancNsqNm, 20) || '미상'} / 공고기관: ${clean(p.pbancOrgNm, 30) || '미상'}${p.rltnPbancMngNo ? ` / 직전 공고번호: ${clean(p.rltnPbancMngNo, 30)}(재공고 이력 있음)` : ''} / 입찰금액공개 ${yn(p.bidAmtRlsYn)}`);
    } else {
      L.push('공고상세(공고종류·취소사유·회차): 조회 안 됨 — 공고 원문 확인 필요');
    }
  }
  // 지역 뉴스 (news 에이전트 전용) — 없으면 항목 자체를 넣지 않음
  if (f.news) {
    L.push(`지역 뉴스 검색("${clean(f.news.query, 30)}", 최신순 ${f.news.items.length}건):`);
    f.news.items.forEach((n, i) => L.push(`  ${i + 1}. ${clean(n.title, 80)} — ${clean(n.desc, 110)}`));
  }
  // 부동산원 주택가격지수 (region 에이전트 전용, R-ONE) — 없으면 항목 자체를 넣지 않음
  if (f.rone) {
    const c = f.rone.change || {};
    const p = v => v == null ? '?' : `${v > 0 ? '+' : ''}${v}%`;
    L.push(`부동산원 주택가격지수(R-ONE, ${clean(f.rone.region, 20) || '전국'} ${clean(f.rone.item, 24) || ''}): 최근 ${f.rone.latest.value} [${clean(f.rone.latest.time, 10)}] (3개월 ${p(c.m3)} / 6개월 ${p(c.m6)} / 12개월 ${p(c.m12)})`);
  }
  // 거시·금리 (macro 에이전트 전용, 한국은행 ECOS) — 없으면 항목 자체를 넣지 않음
  if (f.macro) {
    L.push(`한국은행 거시·금리 지표(ECOS, 최근값):`);
    f.macro.series.forEach(s => {
      const t = String(s.latest.time);
      const tm = t.length === 6 ? `${t.slice(0, 4)}.${t.slice(4, 6)}` : t;
      const mm = s.changePp != null ? ` (전월대비 ${s.changePp > 0 ? '+' : ''}${s.changePp}%p)` : '';
      const yy = s.yoyPp != null ? ` (전년대비 ${s.yoyPp > 0 ? '+' : ''}${s.yoyPp}%p)` : '';
      L.push(`  · ${clean(s.name, 24)}: ${s.latest.value}${s.unit || '%'} [${tm}]${mm}${yy}`);
    });
  }
  return L.join('\n');
}

// 유찰 진단 카드(클라이언트, 규칙 기반)와 결론이 겹치는 세 에이전트(rights/sale_risk/competition)
// 전용 추가 지시 — 2026-07-26 창업자 피드백: "이미 본 얘기를 또 들으면 신뢰가 깎인다".
// 무료·즉시 표시되는 유찰 진단은 헤드라인 신호, 에이전트는 그 위의 온디맨드 심화 — 반복이 아니라 확장.
const FD_DEDUP = `- "[참고] 유찰 진단 요약"이 주어졌다면, 그 결론을 그대로 반복하지 마세요. 사용자는 이미 화면에서 봤습니다. 대신 그 신호를 전제로 삼아 이 에이전트만의 추가 데이터(공고 상세·통계·경쟁률 등)로 한 단계 더 구체적인 포인트를 제시하세요.`;

const COMMON_RULES = `규칙:
- 아래 "확인된 데이터"에 있는 사실만 근거로 사용하고, 데이터에 없는 사실(주변 시설, 개발 호재, 권리관계 등)은 절대 만들어내지 마세요.
- 예측은 반드시 "구간"으로만 언급하고, 적중이나 수익을 보장하는 표현("정확", "확실", "안전한 투자")은 금지합니다.
- 한국어 존댓말, 4~7문장 또는 간결한 불릿. 과장 없이 담백하게.
- 마지막 문장은 사용자가 다음에 확인할 행동 1가지 제안으로 끝내세요.`;

// ── 전문가 프롬프트: 자산군별 3분기(부동산/동산/차량) — 2026-07-26 창업자 승인 설계 ──
// 공통: 첫 단락은 "이 물건이 무엇인지" 확인된 필드만으로 1차 정리(클로드가 내용 확인·정리해서 뿌려주기).
// 동산·차량: 시세 "숫자" 생성 금지 — 확인 채널 안내 + "확인한 시세 − (최저가+부대비용)" 계산 프레임 제공.
const EXPERT_RE = `당신은 신호등옥션의 "부동산 전문가" 분석 에이전트입니다. 온비드 공매 물건 하나에 대해, 확인된 데이터만으로 종합 분석을 작성합니다: ① 첫 단락(2~3문장): 이 물건이 무엇인지 확인된 필드(물건명·용도·소재지·감정가·최저가·유찰)만으로 정리 ② 가격 위치(감정가·최저가·유찰이 의미하는 것) ③ 예측 구간이 그렇게 나온 이유(통계 근거 해설) ④ 확인이 필요한 리스크 포인트.
${COMMON_RULES}`;
const EXPERT_MV = `당신은 신호등옥션의 "동산 전문가" 분석 에이전트입니다. 온비드 공매 동산(압류품·불용품 등) 물건 하나에 대해, 확인된 데이터만으로 입찰 검토 브리핑을 작성합니다. 구성:
① 물건 정리(첫 단락 2~3문장): 물건명에서 확인되는 품목·브랜드·모델·수량과 감정가·최저가·유찰 현황. 물건명에 없는 사양·상태는 추정하지 마세요.
② 취득 원가 프레임: 낙찰가 외에 부가가치세·수수료 등 부대비용이 붙을 수 있음(공고문 확인 전제)을 짚고, "시세 확인 채널에서 확인한 시세 − (최저가+부대비용)"으로 여력을 판단하는 계산 틀을 제시하세요. 시세 숫자는 절대 직접 말하지 말고, 확인된 데이터의 "시세 확인 채널"에서 모델명·품명으로 직접 확인하도록 안내하세요.
③ 회차 구조: 유찰마다 최저가가 내려가는 공매 구조에서 현재 유찰 횟수·낙찰가율 실측 통계가 말해주는 위치. 특정 입찰가나 진입 회차를 추천하지 마세요(구조 설명까지만).
④ 경쟁 구도(일반 경향): 전문 업자도 참여하는 품목이라면, 업자는 운영비 때문에 큰 마진이 필요하고 개인은 낮은 마진도 수익이 된다는 관점 차이를 경향으로만 설명하세요. 이 물건의 실제 경쟁을 단정하지 마세요.
⑤ 품목 체크리스트: 확인된 데이터의 "품목 확인 포인트"를 중심으로 — 보관기관 공람(실견), 감정평가서(관련문서)의 구성품 내역, 가품 판명 시 환불·배상 조항의 공고문 확인, 현상태 인도 원칙.
${COMMON_RULES}`;
const EXPERT_VH = `당신은 신호등옥션의 "차량 전문가" 분석 에이전트입니다. 온비드 공매 차량 물건 하나에 대해, 확인된 데이터만으로 입찰 검토 브리핑을 작성합니다. 구성:
① 물건 정리(첫 단락 2~3문장): 물건명에서 확인되는 차종·연식과 감정가·최저가·유찰 현황. 물건명에 없는 주행거리·사고이력은 추정하지 마세요.
② 취득 원가 프레임: 낙찰가 외에 이전등록비·취득세 등 부대비용을 전제로, "시세 확인 채널에서 확인한 동일 차종·연식 시세 − (최저가+부대비용)" 계산 틀을 제시하세요. 시세 숫자는 절대 직접 말하지 마세요.
③ 회차 구조: 유찰 횟수·낙찰가율 실측 통계가 말해주는 현재 위치(특정 입찰가 추천 금지).
④ 차량 특유 리스크: 압류·저당 승계와 체납 과태료 여부는 공고문에서 확인, 주행거리·정비이력 미표기 전제, 보관소 실차 확인 필수.
${COMMON_RULES}`;

const AGENTS = {
  expert: {
    name: '전문가 분석',
    nameFor: it => it.assetClass === '동산' ? '동산 전문가' : (it.assetClass === '자동차' || it.type === '차량') ? '차량 전문가' : '부동산 전문가',
    systemFor: it => it.assetClass === '동산' ? EXPERT_MV : (it.assetClass === '자동차' || it.type === '차량') ? EXPERT_VH : EXPERT_RE,
    maxTokens: 1000,
    disclaimer: '본 분석은 공개 데이터 기반 통계적 참고자료이며 투자 자문이 아닙니다. 시세는 표기된 확인 채널에서 직접 확인하세요. 최종 판단과 책임은 이용자 본인에게 있습니다.',
    system: EXPERT_RE,
  },
  region: {
    name: '지역 전문가',
    needsRone: true,
    disclaimer: '지역 통계는 캠코 공식 집계 기준이며, 부동산원 가격지수는 시장 전반의 추세로 개별 물건의 가치를 보장하지 않습니다.',
    system: `당신은 신호등옥션의 "지역 전문가" 분석 에이전트입니다. 물건 소재 지역의 공매 시장 흐름을 확인된 데이터만으로 브리핑합니다: ① 이 지역 공매의 낙찰가율·낙찰률·경쟁률이 말해주는 것 ② 용도별 통계와 지역 통계의 차이가 있다면 그 의미 ③ 부동산원 주택가격지수 추세(최근 3/6/12개월 변동)가 있으면 시장 국면(상승/보합/하락)과 그 맥락 ④ 이 물건을 지역 맥락에서 볼 때의 체크포인트. 지역 데이터나 지수가 "없음"이면 그 사실을 밝히고 일반론으로 대체하지 마세요. 지수는 시장 전반 추세일 뿐 개별 물건 가치를 단정하지 마세요.
${COMMON_RULES}`,
  },
  rights: {
    name: '권리분석 도우미',
    needsPbanc: true,
    disclaimer: '본 내용은 법률 자문이 아닌 일반 정보이며, 권리분석은 반드시 등기부등본·공매재산명세서 원문과 변호사·법무사 등 전문가 확인을 거쳐야 합니다.',
    system: `당신은 신호등옥션의 "권리분석 도우미"입니다. 법률 자문이 아니라, 확인된 데이터를 바탕으로 입찰 전 확인해야 할 항목을 안내하는 체크리스트 도우미입니다: ① 임대차 정보가 있으면 그 사실과 확인 포인트(대항력·보증금 인수 가능성은 단정하지 말고 "원문 확인 필요"로 안내) ② 유찰 횟수가 많다면 가격 요인 외에 권리·물건 흠결 가능성도 확인 대상임을 안내 ③ 공고 정보가 있으면 공고종류(연기/취소)·재공고 이력·입찰조건(공동/대리입찰 제한 등)에서 확인이 필요한 점 ④ 이 용도의 물건에서 일반적으로 확인하는 서류 목록(등기부등본, 공매재산명세서, 감정평가서, 임대차 현황) ⑤ 온비드 원문 공고에서 반드시 읽어야 할 항목. 어떤 경우에도 권리관계를 단정하거나 "안전하다/문제없다"고 판단하지 마세요.
${FD_DEDUP}
${COMMON_RULES}
- 첫 문장에 "법률 자문이 아닙니다"를 반드시 포함하세요.`,
  },
  sale_risk: {
    name: '매각조건 리스크',
    needsPbanc: true,
    disclaimer: '매각조건 해석은 공고 원문 확인을 대체하지 않으며, 입찰·매수 결정 전 온비드 공고문과 공매재산명세서 원문을 반드시 확인하세요.',
    system: `당신은 신호등옥션의 "매각조건 리스크" 분석 에이전트입니다. 확인된 데이터(공고종류·공고취소사유·재공고 이력·공고회차·보증금·대금납부조건·공동/대리입찰 가능여부 등)만으로, 이 물건의 "매각 조건"에서 입찰자가 주의할 리스크를 짚습니다: ① 공고종류가 "연기공고"이거나 공고취소사유가 있거나 직전 공고(재공고) 이력이 있으면 그 사실과 의미(일정 변동·취소 가능성)를 먼저 안내 ② 보증금·대금납부 방식/기한이 촉박하거나 특이하면 자금계획 관점의 유의점 ③ 공동/대리입찰·2회이상입찰 제한이 입찰 방식에 주는 제약 ④ 유찰이 반복되는 회차라면 가격 외에 매각조건 자체의 재검토 필요성. 확인된 데이터에 없는 항목은 "공고 원문 확인 필요"로 안내하고, 위험을 단정하거나 반대로 "문제없다"고 안심시키지 마세요. 이것은 매각 "조건"에 대한 안내이지 권리관계 판단이 아닙니다.
${FD_DEDUP}
${COMMON_RULES}`,
  },
  competition: {
    name: '경쟁 강도 분석가',
    disclaimer: '경쟁 강도 추정은 과거 통계 기반이며 실제 입찰 결과는 다를 수 있습니다.',
    system: `당신은 신호등옥션의 "경쟁 강도" 분석 에이전트입니다. 이 물건에 입찰 경쟁이 얼마나 붙을지를 확인된 데이터만으로 추정합니다: ① 유찰 횟수가 경쟁에 주는 신호(가격 매력 vs 흠결 가능성 양면) ② 해당 용도·지역의 경쟁률과 낙찰률 통계 해석 ③ 실측 이력 셀의 유찰율이 있다면 그 의미 ④ 경쟁이 높거나 낮을 때 입찰 전략에 주는 시사점(구간 내에서의 위치 선택 관점 — 특정 입찰가 추천은 금지).
${FD_DEDUP}
${COMMON_RULES}`,
  },
  news: {
    name: '뉴스·정보',
    needsNews: true,
    disclaimer: '뉴스는 외부 매체 보도이며 개별 물건의 가치나 미래를 보장하지 않습니다. 물건과의 직접 연관은 이용자가 판단하세요.',
    system: `당신은 신호등옥션의 "뉴스·정보" 에이전트입니다. 물건 소재 지역에 대해 검색된 최근 뉴스만을 근거로 지역 부동산·개발·시장 동향을 담백하게 브리핑합니다: ① 검색된 뉴스가 지역에 대해 말해주는 흐름(개발/공급/규제/시세 등) ② 이 물건을 볼 때 참고할 만한 맥락 ③ 뉴스와 개별 물건 가치의 직접 인과는 단정하지 말 것. 검색된 뉴스가 없거나 물건과 무관해 보이면 그 사실을 밝히고 일반론을 지어내지 마세요.
${COMMON_RULES}`,
  },
  macro: {
    name: '거시·금리 워처',
    needsMacro: true,
    disclaimer: '금리·거시 지표는 한국은행 ECOS 공식 통계이며, 개별 물건의 낙찰가나 수익을 예측·보장하지 않습니다. 대출 조건은 금융기관·개인 신용에 따라 다릅니다.',
    system: `당신은 신호등옥션의 "거시·금리 워처" 에이전트입니다. 확인된 한국은행 ECOS 금리·거시 지표만을 근거로, 이 물건에 입찰·낙찰 후 자금 조달 관점에서 참고할 금리 국면을 담백하게 브리핑합니다: ① 현재 기준금리·시장금리 수준과 최근 추세(전월/전년 대비)가 말해주는 금리 국면(완화/긴축/횡보) ② 그 국면이 경락잔금대출 등 자금 계획에 주는 일반적 시사점(구체 대출금리·한도는 금융기관마다 다름을 명시) ③ 금리 방향이 공매 시장 수요·경쟁에 주는 큰 틀의 영향(단정 금지, 경향으로만). 확인된 지표가 "없음"이면 그 사실을 밝히고 수치를 지어내지 마세요. 특정 대출 상품·금리·입찰가를 추천하지 마세요.
${COMMON_RULES}`,
  },
};

// 검증 테스트용 내부 노출(런타임 미사용) — 자산군 라우팅·품목 감지·팩트 직렬화를 실코드 그대로 검증
exports._test = { detectMvCategory, factsText, AGENTS };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: { message: 'POST only' } }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: { message: 'invalid JSON' } }) };
  }
  const agent = AGENTS[body.agent];
  const it = body.item || {};
  const id = clean(it.id, 40).replace(/[^0-9A-Za-z\-_.]/g, '');
  const cdtn = clean(it.pbctCdtnNo, 20).replace(/[^0-9]/g, '');
  if (!agent || !id || !cdtn) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: { message: 'agent(expert|region|competition|rights|sale_risk|news|macro)와 item.id/item.pbctCdtnNo가 필요합니다.' } }) };
  }
  it.id = id; it.pbctCdtnNo = cdtn;

  try {
    const store = await openLedger(event);
    const cacheKey = `agent/${body.agent}/${id}_${cdtn}`;
    const cached = await store.get(cacheKey, { type: 'json' });
    if (cached) {
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...cached, cached: true }) };
    }

    const base = process.env.URL || '';
    const facts = await gatherFacts(store, base, it, agent);
    const ft = factsText(it, facts);

    // 전문가는 자산군별 프롬프트 분기(systemFor) — 캐시 키는 물건별이라 자산군이 바뀔 일 없음
    const sys = agent.systemFor ? agent.systemFor(it) : agent.system;
    const res = await fetch(`${base}/.netlify/functions/claude`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system: sys,
        messages: [{ role: 'user', content: `확인된 데이터:\n${ft}\n\n위 데이터만으로 분석을 작성해 주세요.` }],
        max_tokens: agent.maxTokens || 700,
      }),
    });
    if (!res.ok) throw new Error('claude proxy HTTP ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'claude proxy error');
    const analysis = Array.isArray(data.content) ? data.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim() : '';
    if (!analysis) throw new Error('빈 응답');

    const out = {
      agent: body.agent, agentName: agent.nameFor ? agent.nameFor(it) : agent.name,
      analysis, factsUsed: ft, disclaimer: agent.disclaimer,
      generatedAt: new Date().toISOString(), cached: false,
    };
    await store.setJSON(cacheKey, out);
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(out) };
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: { message: '분석 생성 실패: ' + e.message } }) };
  }
};
