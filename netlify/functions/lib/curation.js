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
// 낙찰률 25% = 네 번 열려 세 번 이상 유찰되는 조건. 일반 입찰 참여자가 접근하기 어렵다고 보는 선.
// **낙찰률이 본 지표이고 유찰 횟수는 그것을 못 구할 때의 대리 지표다**(창업자 결정 2026-07-29):
// 유찰 3회여도 그 조건에서 잘 팔리면 접근 가능한 물건이고, 유찰 1회여도 안 팔리는 조건이면 아니다.
const SOLD_MIN = 25;   // %
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
    // ⚠️ 면적 단위 미확정 (2026-07-30 자체 점검에서 발견 — 창업자 확인 대기)
    //   시세 밴드(mkt/seal)는 RTMS 실거래의 **전용면적**(excluUseAr) 기준 ㎡당 단가다.
    //   여기 area는 온비드 목록의 bldSqms인데 **전용면적인지 연면적인지 확인되지 않았다.**
    //   연면적이라면 `밴드 × area`가 가치를 통째로 부풀리고(아파트는 통상 30~40%),
    //   그러면 이 트랙의 전제인 "보수 가정으로만 차익을 낸다"가 깨진다.
    //   상세 페이지는 이 불확실성을 이미 알고 있다 — 마진 위젯을 bldgAr로 자동 채우되
    //   "전용면적이 다르면 수정하세요"라고 사용자에게 판단을 넘긴다. 큐레이션엔 그 탈출구가 없다.
    //   확인 방법: 실물건 하나에서 온비드 공고의 전용면적 vs 우리 목록 bldgAr 대조(1분).
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
  // 신탁·특수매각: 최저가 ≥ 감정가는 할인이 아니라 구조가 다른 것 → 별도 트랙으로 분리
  const isTrust = f.apsl > 0 && f.low >= f.apsl;
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
  if (sold != null) {
    if (sold < SOLD_MIN) return null;             // 접근하기 어려운 물건 — 랜딩에 올리지 않는다
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
          // 면적 출처를 산출물에 남긴다 — 나중에 "이 차익이 어떤 면적으로 계산됐나"를 되물을 수 있어야 한다
          areaSrc: 'onbid-list:bldSqms', areaBasis: 'unverified' },
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

module.exports = {
  fromOnbid, selectItem, ddayOf, mvDemandCat, acqCostMan,
  RESIDENTIAL, MV_DEMAND, SOLD_MIN, FAIL_MAX,
};
