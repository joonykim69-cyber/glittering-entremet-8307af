// netlify/functions/lib/curation.js
// 큐레이션 엔진 — "분석해 볼 만한 물건"의 주목 점수(기회 점수)를 산출한다.
//
// ── 설계 원칙 (AIOS 대비 · 헌장 §5 모듈 확장) ──
// 이 엔진은 **소스 중립적 공통 팩트**만 읽는다. 온비드·법원경매·신탁·NPL 어느 소스든,
// 각 소스의 원시 응답을 어댑터(fromOnbid 등)로 공통 팩트로 바꿔 넘기면 점수 로직은
// 한 줄도 바뀌지 않는다. **새 소스 추가 = 어댑터 함수 하나 작성.**
//
// ── 정직성 (헌장 §6·§12, Golden Rule 6) ──
// 점수는 "투자 추천"이 아니라 "분석 주목도"다. 마법 숫자 하나로 뭉치지 않고 근거 태그
// (reasons)로 분해해 반환한다 — 사용자가 왜 볼 만한 물건인지 스스로 판단하도록.
// 데이터가 없으면 점수를 만들지 않는다(통계 근거 없는 가점 금지).
//
// ── 공통 팩트 스키마 (소스 중립 계약 — 새 어댑터가 채워야 하는 필드) ──
//   { source, id, cdtn, assetClass, type, usage, region,
//     apsl, low,        // 감정가 · 최저가 (만원)
//     failCount, round, // 유찰 횟수 · 회차
//     bidEnd }          // 'yyyyMMddHHmm' | ''

// 온비드 목록 아이템(mapOnbidItem 결과) → 공통 팩트
function fromOnbid(it) {
  return {
    source: 'onbid',
    id: it.id, cdtn: it.pbctCdtnNo,
    assetClass: it.assetClass || '부동산',
    type: it.type || '기타',
    usage: String(it.usage || it.type || '기타').trim() || '기타',
    region: it.region || it.court || '',
    apsl: Number(it.appr) || 0,
    low: Number(it.min) || 0,
    failCount: Number(it.fail) || 0,
    round: Number(it.round) || 0,
    bidEnd: it.bidEnd || '',
  };
}

// D-day (KST) — bidEnd(yyyyMMddHHmm)까지 남은 일수. 값 없으면 null.
function ddayOf(bidEnd, nowKst) {
  const s = String(bidEnd || '');
  if (s.length < 8) return null;
  const y = +s.slice(0, 4), mo = +s.slice(4, 6) - 1, da = +s.slice(6, 8);
  const now = nowKst || new Date(Date.now() + 9 * 3600 * 1000);
  return Math.round((Date.UTC(y, mo, da) - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / 86400000);
}

// 기회 점수 — 공통 팩트 + 컨텍스트(셀 통계·봉인 예측)만 사용.
//   ctx = { cell: {n, lr:{p10,p50,p90}} | null, pred: {lo,mid,hi} | null, nowKst: Date }
// 반환 { score:0~100, reasons:[{tag, pts, kind}], flags:[...] } | null(가점 근거 없음 → 큐레이션 제외)
function scoreOpportunity(f, ctx) {
  ctx = ctx || {};
  const reasons = [], flags = [];
  const nowKst = ctx.nowKst || new Date(Date.now() + 9 * 3600 * 1000);
  let score = 0;
  const disc = (f.apsl > 0 && f.low > 0) ? f.low / f.apsl : null; // 저가율(최저가/감정가)

  // 저가율 깊이 — 신탁/특수(최저가 ≥ 감정가)는 할인이 아니므로 가점 대신 주의 플래그.
  if (disc != null && disc >= 1.0) {
    flags.push('신탁·특수매각(최저가 ≥ 감정가) — 할인 아님, 권리·조건 확인');
  } else if (disc != null) {
    if (disc <= 0.64) { score += 34; reasons.push({ tag: `최저가가 감정가의 ${Math.round(disc * 100)}% — 큰 폭 하락`, pts: 34, kind: 'plus' }); }
    else if (disc <= 0.80) { score += 22; reasons.push({ tag: `최저가가 감정가의 ${Math.round(disc * 100)}% — 중간 폭 하락`, pts: 22, kind: 'plus' }); }
    else if (disc <= 0.95) { score += 10; reasons.push({ tag: `최저가가 감정가의 ${Math.round(disc * 100)}% — 소폭 하락`, pts: 10, kind: 'plus' }); }
  } else {
    flags.push('감정가 미공개 — 할인 폭 판단 불가');
  }

  // 유찰 누적 — 경쟁 약화·추가 할인 신호. 과도하면 부실 위험이라 상한(3회)·경고 플래그.
  if (f.failCount >= 1) {
    const p = Math.min(f.failCount, 3) * 6; // 1·2·3회 → 6·12·18
    score += p;
    reasons.push({ tag: `${f.failCount}회 유찰 — 경쟁 약화 가능`, pts: p, kind: 'plus' });
    if (f.failCount >= 5) flags.push('유찰 과다 — 하자·권리 문제 가능성 점검');
  }

  // 저평가 여력 — 봉인 예측 중심(mid)이 최저가보다 충분히 높으면 여력. 없으면 실측 셀 중앙값으로 대체.
  if (ctx.pred && ctx.pred.mid > 0 && f.low > 0) {
    const head = ctx.pred.mid / f.low;
    if (head >= 1.15) { score += 18; reasons.push({ tag: `예상 낙찰 구간 중심이 최저가보다 ${Math.round((head - 1) * 100)}% 높음`, pts: 18, kind: 'plus' }); }
    else if (head >= 1.05) { score += 9; reasons.push({ tag: '예상 낙찰 구간이 최저가보다 다소 높음', pts: 9, kind: 'plus' }); }
  } else if (ctx.cell && ctx.cell.lr && ctx.cell.lr.p50 > 0) {
    if (ctx.cell.lr.p50 >= 115) { score += 14; reasons.push({ tag: `유사 사례 중앙 낙찰가율 ${Math.round(ctx.cell.lr.p50)}% — 최저가 대비 여력`, pts: 14, kind: 'plus' }); }
  } else {
    flags.push('통계 근거 부족 — 유사 개찰 사례가 적음');
  }

  // 개찰 임박 — 지금 봐야 의미 있는 물건 소폭 가점.
  const dday = ddayOf(f.bidEnd, nowKst);
  if (dday != null && dday >= 0 && dday <= 3) {
    score += 6;
    reasons.push({ tag: dday === 0 ? '오늘 개찰 임박' : `개찰 D-${dday}`, pts: 6, kind: 'plus' });
  }

  if (!reasons.length) return null; // 가점 근거가 하나도 없으면 큐레이션에 올리지 않는다
  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons, flags };
}

module.exports = { fromOnbid, scoreOpportunity, ddayOf };
