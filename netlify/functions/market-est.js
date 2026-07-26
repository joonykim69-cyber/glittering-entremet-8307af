// netlify/functions/market-est.js
// 시세 축 1단계 — "신뢰도 프로브": 실거래(RTMS) 매칭 → 시점 보정 → ㎡당 시세 범위 + 신뢰도.
//
// 왜 프로브인가: "이 물건을 결국 얼마에 팔 수 있나"가 사용자 최종 질문이지만, 정직하게
// 줄 수 있는 건 "한 숫자"가 아니라 "근거 붙은 범위 + 신뢰도"다(헌장 §6·Golden Rule 6).
// 이 함수는 전면 배포 전에 실물건으로 추정 품질을 눈검증하기 위한 탐침이다 —
// 품질이 부실하면 여기서 멈춘다(전 자산군 확산은 검증 후).
//
// 방법:
//   ① 시군구(lawd)×유형(kind)의 최근 N개월 실거래를 rtms-svc로 수집
//   ② (선택) 단지명 부분일치 + 전용면적 ±20% 밴드로 매칭 정밀화
//   ③ (선택) 부동산원 지수(rone-svc, region)로 거래 시점→현재 시점 보정
//   ④ ㎡당 만원 분위수 p25/p50/p75 + 표본수 + 신뢰도 등급 반환(개별 거래 목록 포함 — 눈검증용)
//
// 정직성 장치:
//   - 표본 3건 미만이면 통계를 만들지 않는다(status:'insufficient').
//   - '높음' 신뢰도는 단지명 매칭 + 표본 10건 이상일 때만 — 시군구 전체 통계로는 '보통'이 상한.
//   - 최근 1~2개월은 신고 지연(계약 후 30일)으로 미완결일 수 있음을 notice로 명시.
//   - 시점 보정은 지수(rone-svc)가 응답할 때만 적용하고 applied 플래그로 구분.
//
// GET 파라미터:
//   kind=apt|offi|rh|sh (아파트|오피스텔|연립다세대|단독다가구 — 주거 4종 프로브)
//   lawd=법정동 앞 5자리(필수) · months=조회 개월(기본 6, 최대 12)
//   name=단지명 부분일치(선택) · area=전용면적㎡(선택, ±20% 밴드+총액 환산)
//   region=시도명(선택, 시점 보정용) · debug=1

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

const KINDS = {
  apt: { svc: 'apt_trade_dev', label: '아파트' },
  offi: { svc: 'offi_trade', label: '오피스텔' },
  rh: { svc: 'rh_trade', label: '연립다세대' },
  sh: { svc: 'sh_trade', label: '단독/다가구' },
};

const num = v => Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')) || 0;

// rtms-svc 원시 필드(서비스별 상이)를 관용적으로 흡수 — bidcast-detail의 매핑과 동일 계열
function mapTrade(x) {
  return {
    name: x.aptNm || x.offiNm || x.mhouseNm || x.bldgNm || x.buildingUse || x.houseType || '',
    area: parseFloat(x.excluUseAr || x.dealArea || x.buildingAr || x.totalFloorAr || x.plottageAr || '') || 0,
    amt: num(x.dealAmount), // 만원
    y: num(x.dealYear), m: num(x.dealMonth), dd: num(x.dealDay),
    floor: num(x.floor) || null,
    dong: x.umdNm || '',
    built: num(x.buildYear) || null,
  };
}

function quantile(sorted, p) {
  const idx = (sorted.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) out.push(...await Promise.all(items.slice(i, i + limit).map(fn)));
  return out;
}

// 최근 N개월(직전월부터 과거로)의 YYYYMM 목록 — KST
function monthList(n) {
  const out = [];
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  d.setUTCDate(1);
  for (let i = 1; i <= n; i++) {
    const t = new Date(d); t.setUTCMonth(t.getUTCMonth() - i);
    out.push(`${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  const base = process.env.URL || '';
  const debug = qs.debug === '1';

  const kindKey = String(qs.kind || 'apt').toLowerCase();
  const kind = KINDS[kindKey];
  const lawd = String(qs.lawd || qs.lawdCd || '').replace(/[^0-9]/g, '').slice(0, 5);
  if (!kind || lawd.length !== 5) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ status: 'bad_request', error: `kind(${Object.keys(KINDS).join('|')})와 lawd(법정동 앞 5자리)가 필요합니다.` }) };
  }
  const months = Math.min(12, Math.max(1, num(qs.months) || 6));
  const nameQ = String(qs.name || '').trim();
  const areaQ = parseFloat(qs.area || '') || 0;
  const region = String(qs.region || '').trim();

  try {
    // ① 월별 실거래 수집 (rtms-svc 경유 — 청크 병렬)
    const mm = monthList(months);
    const monthResults = await mapLimit(mm, 3, async ym => {
      try {
        const r = await fetch(`${base}/.netlify/functions/rtms-svc?svc=${kind.svc}&lawdCd=${lawd}&dealYmd=${ym}&numOfRows=500`);
        if (!r.ok) return { ym, items: [], err: `HTTP ${r.status}` };
        const j = await r.json();
        return { ym, items: Array.isArray(j.items) ? j.items : [], err: j.error ? String(j.error.message || 'err') : null };
      } catch (e) { return { ym, items: [], err: e.message }; }
    });

    const all = [];
    for (const mr of monthResults) for (const raw of mr.items) {
      const t = mapTrade(raw);
      if (t.amt > 0 && t.area > 0) { t.ym = mr.ym; all.push(t); }
    }

    // ② 매칭 정밀화 — 단지명 부분일치 · 면적 적응형 밴드
    // 은마 교차 검증(2026-07-26 네이버 호가 대조)에서 ±20% 밴드가 인접 평형(76.79㎡)을
    // 섞어 84㎡ 총액 상단을 ~3% 부풀리는 편향 확인 → 동일 평형(±5%) 표본이 5건 이상이면
    // 그것만 쓰고, 부족할 때만 ±20%로 넓힌다(표본 부족 시 통계 포기보다 넓은 밴드가 정직).
    let matched = all;
    const nameMatched = !!nameQ;
    if (nameQ) matched = matched.filter(t => t.name && t.name.indexOf(nameQ) >= 0);
    let areaMode = null;
    if (areaQ > 0) {
      const tight = matched.filter(t => Math.abs(t.area - areaQ) <= areaQ * 0.05);
      if (tight.length >= 5) { matched = tight; areaMode = 'tight'; }
      else { matched = matched.filter(t => t.area >= areaQ * 0.8 && t.area <= areaQ * 1.2); areaMode = 'wide'; }
    }

    // ③ 시점 보정 — 부동산원 지수 12개월 변동에서 월복리율 도출(가능할 때만)
    let adjust = { applied: false };
    if (region) {
      try {
        const rr = await fetch(`${base}/.netlify/functions/rone-svc?region=${encodeURIComponent(region)}`);
        if (rr.ok) {
          const rj = await rr.json();
          const c = rj && rj.change ? rj.change : null;
          const yearly = c && Number.isFinite(Number(c.m12)) ? Number(c.m12)
            : c && Number.isFinite(Number(c.m6)) ? Number(c.m6) * 2
            : null;
          if (rj && rj.status === 'ok' && yearly != null) {
            const monthly = Math.pow(1 + yearly / 100, 1 / 12) - 1;
            adjust = { applied: true, basis: `부동산원 지수 12개월 ${yearly.toFixed(1)}% (${rj.region || region})`, monthlyRatePct: Math.round(monthly * 1000) / 10 / 100 * 100 };
            const nowYm = Number(monthList(1)[0]);
            for (const t of matched) {
              const age = Math.max(0, (Math.floor(nowYm / 100) - t.y) * 12 + (nowYm % 100) - t.m);
              t.perM2Adj = Math.round(t.amt / t.area * Math.pow(1 + monthly, age) * 10) / 10;
            }
          }
        }
      } catch (e) { /* 지수 실패 → 보정 없이 진행 (정직하게 applied:false) */ }
    }
    for (const t of matched) t.perM2 = Math.round(t.amt / t.area * 10) / 10;

    // ④ 통계 + 신뢰도 — 표본 3건 미만이면 통계를 만들지 않는다
    const vals = matched.map(t => (adjust.applied && t.perM2Adj) ? t.perM2Adj : t.perM2).sort((a, b) => a - b);
    const trades = matched
      .sort((a, b) => (b.y * 100 + b.m) - (a.y * 100 + a.m))
      .slice(0, 40)
      .map(t => ({ ym: `${t.y}.${String(t.m).padStart(2, '0')}`, name: t.name, dong: t.dong, area: t.area, floor: t.floor, built: t.built, amt: t.amt, perM2: t.perM2, ...(t.perM2Adj ? { perM2Adj: t.perM2Adj } : {}) }));

    const common = {
      status: 'ok', kind: kindKey, kindLabel: kind.label, lawd,
      window: { from: mm[mm.length - 1], to: mm[0], months },
      filter: {
        name: nameQ || null,
        areaBand: areaQ > 0 ? (areaMode === 'tight' ? `동일 평형 ±5% (${(areaQ * 0.95).toFixed(1)}~${(areaQ * 1.05).toFixed(1)}㎡)` : `±20% (${(areaQ * 0.8).toFixed(1)}~${(areaQ * 1.2).toFixed(1)}㎡ — 동일 평형 표본 부족)`) : null,
        areaMode,
      },
      sample: { n: matched.length, rawN: all.length, monthsWithData: monthResults.filter(m => m.items.length).length },
      adjust,
      notice: '참고용 시세 추정입니다 — 투자 자문이 아니며, 최근 1~2개월 실거래는 신고 지연으로 일부 누락될 수 있습니다.',
      ...(debug ? { debugMonths: monthResults.map(m => ({ ym: m.ym, n: m.items.length, err: m.err || undefined })) } : {}),
    };

    if (vals.length < 3) {
      return { statusCode: 200, headers: { ...CORS, 'Cache-Control': 'no-store' }, body: JSON.stringify({ ...common, status: 'insufficient', confidence: '불충분', note: '매칭 표본이 3건 미만이라 통계를 제시하지 않습니다(정직성 원칙). 조건을 넓히거나 개월수를 늘려보세요.', trades }) };
    }

    const perM2 = {
      p25: Math.round(quantile(vals, 0.25) * 10) / 10,
      p50: Math.round(quantile(vals, 0.5) * 10) / 10,
      p75: Math.round(quantile(vals, 0.75) * 10) / 10,
      unit: '만원/㎡',
    };
    // 신뢰도: '높음'은 단지명 매칭 + 10건 이상일 때만. 시군구 전체 통계는 '보통'이 상한.
    const n = vals.length;
    const confidence = nameMatched ? (n >= 10 ? '높음' : n >= 5 ? '보통' : '참고')
      : (n >= 20 ? '보통' : '참고');

    return {
      statusCode: 200,
      headers: { ...CORS, 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        ...common, perM2, confidence,
        ...(areaQ > 0 ? { total: { p25: Math.round(perM2.p25 * areaQ), p50: Math.round(perM2.p50 * areaQ), p75: Math.round(perM2.p75 * areaQ), unit: '만원', area: areaQ } } : {}),
        trades,
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ status: 'error', error: e.message }) };
  }
};
