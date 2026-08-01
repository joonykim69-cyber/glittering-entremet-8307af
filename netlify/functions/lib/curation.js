// netlify/functions/lib/curation.js
// 큐레이션 엔진 v2 — "랜딩에 올릴 물건"을 고른다. (2026-07-29 창업자 승인 재설계)
//
// ── 왜 v1을 버렸나 ──
// v1은 76점 만점 중 52점(68%)이 "싸 보이는가"(저가율 34 + 유찰 18)였다. 그런데 상세 페이지는
// 정확히 그 조합(감정가 64% 이하 + 3회 이상 유찰)에 **"이만한 명목 마진에도 안 팔린 건 숨은
// 인수 부담의 시장 신호"** 라고 빨간 경고를 붙인다. 즉 랜딩이 1등으로 데려온 물건에 상세가
// 경고를 띄우는 구조였다. 같은 서비스가 반대말을 하고 있었다.
//
// ── v2의 3단 구조 ──
//   1단 필터  실제 입찰 수요가 있는 분류만 후보로 (주거 4종 / 명품·회원권·보석·골동품 / 차량)
//   2단 배제  접근하기 어려운 것 분리 (신탁 → 별도 트랙, 낙찰률 낮음 → 제외)
//   3단 순위  트랙별로 다른 잣대 — 성격이 다른 것을 한 점수로 뭉치면 v1의 모순이 재발한다
//
// ── 트랙 ──
//   margin   차익 여지 — 시세 밴드 × 면적 − 예상 낙찰가 − 취득비용. **주거 4종만**(시세 밴드가
//            그 4종만 존재). 보수 시나리오(낮은 시세 p25 × 높은 낙찰가 hi)로만 계산한다.
//   demand   잘 팔리는 품목 — 명품시계·명품잡화·귀금속·골프/콘도 회원권·골동품·차량.
//            **차익을 말하지 않는다** — 이 품목들의 시세는 우리가 가진 데이터가 아니다
//            (구구스·크로노24 스크래핑은 하지 않기로 한 영역). 품목·최저가·낙찰률만 말한다.
//   closing  마감 임박 — 위 둘 중 하나에 들면서 개찰이 코앞인 것.
//   trust    신탁·특수매각 — 최저가 ≥ 감정가가 정상이라 "할인 폭" 축이 성립하지 않는다.
//            같은 목록에 섞으면 정렬이 의미를 잃으므로 분리한다(랜딩에서는 하단·접힘).
//
// ── 정직성 (헌장 §6·§12, Golden Rule 6) ──
// 점수는 투자 추천이 아니다. 근거를 태그로 분해해 돌려주고, 데이터가 없으면 만들지 않는다.
// "확실히 돈이 된다"는 표현은 화면에 쓸 수 없다(보장 표현 금지) — 표시는 소비 측 몫이지만
// 엔진도 tag 문자열에 보장 어휘를 넣지 않는다.
//
// ── 소스 중립 (AIOS 대비 · 헌장 §5) ──
// 공통 팩트만 읽는다. 새 소스(법원경매·신탁·NPL)는 어댑터 하나만 추가하면 된다.
//   { source, id, cdtn, assetClass, type, usage, title, region,
//     apsl, low,          // 감정가 · 최저가 (만원)
//     area,               // 온비드 목록의 건물면적 ㎡ (없으면 0 — margin 트랙 제외)
//                         // ⚠️ **전용면적인지 연면적인지 미확정**(2026-07-30 점검). 아래 참조.
//     failCount, round, bidEnd }

// ── 1단 필터: 실제 입찰 수요가 있는 분류 ──
// 주거 4종 = 시세 밴드(market-est apt/offi/rh/sh)가 지원하는 범위와 정확히 같다.
// 즉 **우리가 "돈 얘기"를 할 수 있는 유일한 부동산 범위**다.
const RESIDENTIAL = { '아파트': 'apt', '오피스텔': 'offi', '연립다세대': 'rh', '단독주택': 'sh' };

// 동산 품목 — 실제 입찰 참여 의향이 몰리는 분류(창업자 지정 2026-07-29).
// 정규식은 agents.js의 MV_CATS와 같은 계열이되, 큐레이션은 **화이트리스트**로만 쓴다
// (랜딩은 '고른 것'을 보여주는 자리라 재현율보다 정밀도가 중요하다 — 애매하면 뺀다).
const MV_DEMAND = [
  { key: 'watch', name: '명품시계', re: /시계|롤렉스|오메가|파텍|브레게|까르띠에|브라이틀링|태그호이어|IWC|튜더|파네라이|오데마|바쉐론/i },
  { key: 'luxury', name: '명품잡화', re: /핸드백|가방|루이비통|샤넬|에르메스|구찌|프라다|디올|명품/i },
  { key: 'gold', name: '귀금속·보석', re: /금괴|골드바|순금|귀금속|다이아|보석|반지|목걸이|팔찌/i },
  { key: 'golf', name: '골프회원권', re: /골프.*회원권|컨트리클럽|CC\s*회원권|회원권.*골프/i },
  { key: 'condo', name: '콘도·리조트 회원권', re: /콘도|리조트.*회원권/i },
  { key: 'art', name: '골동품·미술품', re: /골동|미술품|도자기|서화|고미술|회화|조각품/i },
];
function mvDemandCat(title, usage) {
  const s = `${title || ''} ${usage || ''}`;
  return MV_DEMAND.find(c => c.re.test(s)) || null;
}

// ── 2단 배제 문턱 ──
// **낙찰률이 본 지표이고 유찰 횟수는 그것을 못 구할 때의 대리 지표다**(창업자 결정 2026-07-29):
// 유찰 3회여도 그 조건에서 잘 팔리면 접근 가능한 물건이고, 유찰 1회여도 안 팔리는 조건이면 아니다.
//
// ⚠️ 문턱은 자산군마다 다르다 (2026-08-01 실측 교정). 옛 코드는 `SOLD_MIN=25`를 셋에 똑같이
//    적용했는데, 개찰 이력 434,903건과 온비드 원본 API가 말하는 회차당 낙찰률은 이렇다:
//      자동차 72.6% · 동산 44.5% · **부동산 1.6%**
//    부동산은 25%를 절대 넘을 수 없으므로 **부동산 공매 서비스의 랜딩에서 부동산이 구조적으로
//    0건**이 됐다(실제로 그랬다 — 랜딩 16건이 전부 차량·동산이었다). 차량 기준으로 맞춘 문턱을
//    부동산에 들이댄 것이고, 아무도 자산군별 분포를 확인하지 않아 생긴 일이다.
//
//    새 문턱을 마법 숫자로 다시 찍지 않는다 — **그 자산군의 실측 기준선(L0 셀 낙찰률)에서
//    끌어온다**: "같은 자산군 평균만큼은 팔리는가". 자산군이 늘어도 코드를 안 고쳐도 되고,
//    시장이 변하면 기준선도 같이 움직인다. 기준선을 못 구하면 옛 상수로 물러난다.
const SOLD_MIN = 25;   // % — 기준선을 못 구할 때만 쓰는 폴백
const FAIL_MAX = 5;    // 낙찰률 근거가 없을 때만 쓰는 폴백

// 취득 부대비용 가정 — 시뮬레이터·상세 마진 위젯과 같은 값(1.5% + 300만원).
function acqCostMan(priceMan) { return Math.round(priceMan * 0.015 + 300); }

function ddayOf(bidEnd, nowKst) {
  const s = String(bidEnd || '');
  if (s.length < 8) return null;
  const y = +s.slice(0, 4), mo = +s.slice(4, 6) - 1, da = +s.slice(6, 8);
  const now = nowKst || new Date(Date.now() + 9 * 3600 * 1000);
  return Math.round((Date.UTC(y, mo, da) - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / 86400000);
}

// 온비드 목록 아이템(mapOnbidItem 결과) → 공통 팩트
function fromOnbid(it) {
  return {
    source: 'onbid',
    id: it.id, cdtn: it.pbctCdtnNo,
    assetClass: it.assetClass || '부동산',
    type: it.type || '기타',
    usage: String(it.usage || it.type || '기타').trim() || '기타',
    title: it.title || '',
    region: it.region || '',
    apsl: Number(it.appr) || 0,
    low: Number(it.min) || 0,
    // 면적 기준 = **전용면적** (2026-07-31 실데이터로 확인, 이전의 '미확정' 표기를 해소).
    //   시세 밴드(mkt/seal)는 RTMS 실거래의 전용면적(excluUseAr) 기준 ㎡당 단가라, 여기 area가
    //   연면적이면 `밴드 × area`가 가치를 30~40% 부풀려 "보수 가정으로만 차익을 낸다"는
    //   이 트랙의 전제가 깨진다. 그래서 확인이 필요했다.
    //   확인 방법: 한국 아파트의 전용면적은 값 자체가 지문이다(국민평형 84.9x㎡ / 25평형 59.8x㎡).
    //   라이브 재고 4,683건에서 아파트·오피스텔 343건을 뽑으니 당진 84.95 · 파주 84.942 ·
    //   부산 84.9959처럼 **지역이 다른 물건들이 84.9x에 0.06㎡ 안쪽으로 모였다**(59.8x도 동일).
    //   공급면적이었다면 국민평형이 110~114로 찍혀야 한다. 보조 근거: 같은 건물 5개 호실의
    //   bldgAr이 제각각이라(94.1/72.3/81.1/66.5/86.0) 건물 전체 연면적이 아니고, landAr도
    //   호실마다 달라 대지권 지분으로 보인다 — 구분건물의 전유면적 + 대지권 조합.
    //   ⚠️ 확인 범위는 **집합건물(아파트·오피스텔·연립다세대)** 이다. 단독주택(sh)은 전용 개념이
    //   없어 같은 근거로 묶을 수 없다(별도 확인 대상).
    area: Number(it.bldgAr) || 0,
    failCount: Number(it.fail) || 0,
    round: Number(it.round) || 0,
    bidEnd: it.bidEnd || '',
  };
}

// ── 선별 ──
//   ctx = {
//     pred:  {lo,mid,hi,soldProb} | null,   봉인 예측(같은 실행에서 만든 것)
//     band:  {lo,mid,hi,n} | null,          시세 밴드(㎡당 만원, mkt/seal 봉인값)
//     cell:  {soldRate, lr:{p50}} | null,   실측 이력 셀
//     nowKst: Date
//   }
// 반환 { track, score, reasons:[{tag}], flags:[], margin? } | null(후보 아님)
function selectItem(f, ctx) {
  ctx = ctx || {};
  const nowKst = ctx.nowKst || new Date(Date.now() + 9 * 3600 * 1000);
  const reasons = [], flags = [];
  const dday = ddayOf(f.bidEnd, nowKst);

  // ── 1단 필터 ──
  let kind = null, mvCat = null;
  if (f.assetClass === '부동산') {
    kind = RESIDENTIAL[f.type] || null;
    if (!kind) return null;                       // 토지·상가·공장 등은 랜딩 후보 아님
  } else if (f.assetClass === '동산') {
    mvCat = mvDemandCat(f.title, f.usage);
    if (!mvCat) return null;                      // 일반 동산(폐기물·집기 등)은 후보 아님
  } else if (f.assetClass !== '자동차') {
    return null;
  }

  // ── 2단 배제 ──
  // 신탁·특수매각: 최저가가 감정가를 넘는 것은 할인이 아니라 구조가 다른 것 → 별도 트랙으로 분리.
  //
  // ⚠️ 판정을 두 군데 좁혔다 (2026-07-31 실데이터 교정). 원래 조건은 `apsl > 0 && low >= apsl`
  //    이었는데, 프로덕션 랜딩의 trust 트랙 8건이 **전부 차량·동산이고 전부 저가율 100%** 였다
  //    (기아 스포티지R 243/243, 르노 SM3 83/83, 정선경찰서 습득물 귀금속 275/275,
  //    창림저상슬로프장애인차 400/400 ×5). "신탁·특수매각"이라 써 놓고 SM3를 보여준 셈이다.
  //
  //   ① **부동산에만 적용한다.** 신탁공매는 부동산 개념이다(신탁계약에 따른 공매). 차량·동산은
  //      1회차에 최저가 = 감정가가 정상이라(아직 안 깎였다) 같은 조건을 걸면 **모든 신건
  //      차량·동산이 신탁으로 분류된다.** 걸러진 물건들은 아래 (b) 트랙에서 낙찰률로 평가된다.
  //   ② **등호를 뺀다.** 부동산도 1회차는 최저가 = 감정가라, 등호를 두면 신건 아파트가 전부
  //      신탁으로 찍힌다. 진짜 신탁 신호는 최저가가 감정가를 **넘는** 경우다
  //      (실례: 물건 2022-0100-002855 감정 2.56억 < 최저 3.73억).
  const isTrust = f.assetClass === '부동산' && f.apsl > 0 && f.low > f.apsl;
  if (isTrust) {
    return {
      track: 'trust', score: 0,
      reasons: [{ tag: `최저가가 감정가의 ${Math.round(f.low / f.apsl * 100)}% — 할인 구조가 아님` }],
      flags: ['신탁·특수매각 — 권리·인수조건이 압류재산과 다릅니다'],
      dday,
    };
  }

  const sold = (ctx.pred && ctx.pred.soldProb != null) ? ctx.pred.soldProb
    : (ctx.cell && ctx.cell.soldRate != null) ? ctx.cell.soldRate : null;
  // 문턱 = 그 자산군의 실측 기준선(없으면 옛 상수). 위 주석 참조.
  const floor = (typeof ctx.soldBaseline === 'number' && ctx.soldBaseline >= 0) ? ctx.soldBaseline : SOLD_MIN;
  if (sold != null) {
    if (sold < floor) return null;                // 같은 자산군 평균에도 못 미침 — 랜딩에 올리지 않는다
  } else if (f.failCount >= FAIL_MAX) {
    return null;                                  // 낙찰률 근거가 없을 때의 폴백
  }

  // ── 3단 순위 ──
  // (a) 차익 여지 — 주거 4종 + 시세 밴드 + 면적 + 봉인 예측이 모두 있을 때만
  if (kind && ctx.band && ctx.band.lo > 0 && f.area > 0 && ctx.pred && ctx.pred.hi > 0) {
    const value = Math.round(ctx.band.lo * f.area);          // 보수: 시세 하단(p25) × 면적
    const cost = ctx.pred.hi + acqCostMan(ctx.pred.hi);      // 보수: 예상 낙찰 상단 + 부대비용
    const net = value - cost;
    if (net > 0) {
      const pct = Math.round(net / cost * 1000) / 10;
      reasons.push({ tag: `보수적으로 계산해도 ${Math.round(net / 10000 * 10) / 10}억 여지 (시세 하단 기준)` });
      if (sold != null) reasons.push({ tag: `같은 조건 낙찰률 ${sold}%` });
      if (f.failCount > 0) reasons.push({ tag: `${f.failCount}회 유찰` });
      if (dday != null && dday >= 0 && dday <= 3) reasons.push({ tag: dday === 0 ? '오늘 개찰' : `개찰 D-${dday}` });
      return {
        track: (dday != null && dday >= 0 && dday <= 1) ? 'closing' : 'margin',
        score: Math.min(100, Math.round(pct)),
        reasons, flags, dday,
        margin: { netMan: net, pct, valueMan: value, costMan: cost, bandLo: ctx.band.lo, area: f.area, bandN: ctx.band.n || 0,
          // 면적 출처·기준을 산출물에 남긴다 — "이 차익이 어떤 면적으로 계산됐나"를 되물을 수 있어야 한다.
          // sh(단독주택)만 아직 미확인이라 기준을 따로 표기한다(위 fromOnbid 주석 참조).
          areaSrc: 'onbid-list:bldSqms', areaBasis: kind === 'sh' ? 'unverified' : 'exclusive' },
      };
    }
    return null; // 보수 기준으로 여지가 없으면 차익 트랙에 올리지 않는다(찍지 않는다)
  }

  // (b) 잘 팔리는 품목 — 차익은 말하지 않는다(이 품목들의 시세는 우리 데이터가 아니다)
  if (mvCat || f.assetClass === '자동차') {
    if (sold == null) return null;                // 낙찰률 근거 없이 "잘 팔린다"고 말하지 않는다
    reasons.push({ tag: `${mvCat ? mvCat.name : '차량'} · 같은 품목 낙찰률 ${sold}%` });
    if (f.apsl > 0 && f.low > 0 && f.low < f.apsl) {
      reasons.push({ tag: `최저가가 감정가의 ${Math.round(f.low / f.apsl * 100)}%` });
    }
    if (dday != null && dday >= 0 && dday <= 3) reasons.push({ tag: dday === 0 ? '오늘 개찰' : `개찰 D-${dday}` });
    flags.push('시세는 해당 품목 거래 채널에서 직접 확인하세요 — 우리가 산정하지 않습니다');
    return {
      track: (dday != null && dday >= 0 && dday <= 1) ? 'closing' : 'demand',
      score: Math.round(sold), reasons, flags, dday,
      category: mvCat ? mvCat.key : 'car',
    };
  }

  // (c) 주거인데 시세 밴드나 면적이 없어 차익을 계산 못 하는 경우 — 랜딩에 올리지 않는다.
  //     "싸 보인다"만으로 올리던 v1의 실수를 반복하지 않는다.
  return null;
}

// ── 동일 물건 묶기 (동산·차량) ──
// 부동산은 같은 건물 여러 호실을 랜딩·캘린더가 건물 키로 묶지만(같은 건물 외 N건), 동산·차량엔
// 그 장치가 없었다. 실제로 랜딩 trust 트랙 8칸 중 5칸을 **완전히 같은** "창림저상슬로프장애인차
// 2199cc"가 차지했다(감정 400·최저 400 동일). 트랙 상한이 8이라 중복 하나가 다른 물건 하나를
// 밀어낸다.
//
// 키를 **제목 원문 + 감정가 + 최저가 완전 일치**로 잡는다. 제목을 정규화해 느슨하게 묶으면
// 서로 다른 차량이 합쳐질 수 있다("불용 2019년 쏘나타순찰차 … 102두7045"처럼 차량번호로만
// 갈리는 제목이 있다) — 랜딩은 정밀도가 중요한 자리라 **애매하면 안 묶는다**.
// 부동산은 여기서 건드리지 않는다(건물 키 판정은 클라이언트 소관).
function dupKeyOf(c) {
  if (!c || (c.assetClass !== '동산' && c.assetClass !== '자동차')) return null;
  return `${c.assetClass}|${String(c.title || '').trim()}|${c.apsl || 0}|${c.low || 0}`;
}

// 대표 1건만 남기고 나머지는 접는다. 남는 대표에 dupCount(총 몇 건인지)를 달아
// 소비 측이 "외 N건"으로 표시할 수 있게 한다 — 재고를 숨기지 않고 접어서 보여주는 방식.
function dedupeMovable(list) {
  const seen = new Map(), out = [];
  for (const c of list || []) {
    const k = dupKeyOf(c);
    if (!k) { out.push(c); continue; }
    const hit = seen.get(k);
    if (hit) { hit.dupCount = (hit.dupCount || 1) + 1; continue; }
    seen.set(k, c); out.push(c);
  }
  return out;
}

module.exports = {
  fromOnbid, selectItem, ddayOf, mvDemandCat, acqCostMan, dupKeyOf, dedupeMovable,
  RESIDENTIAL, MV_DEMAND, SOLD_MIN, FAIL_MAX,
};
