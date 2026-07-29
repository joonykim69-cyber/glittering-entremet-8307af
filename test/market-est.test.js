// market-est 프로브 스모크 — fetch 목킹으로 매칭·보정·신뢰도·불충분 경로 검증
const path = require('path');
const REPO = '/home/user/glittering-entremet-8307af';
let fail = 0;
const ok = (c, m) => { if (!c) { console.error('❌', m); fail++; } else console.log('✓', m); };

// 최근 월 계산(함수와 동일 로직으로 시드 날짜 생성)
function ymAgo(i) {
  const d = new Date(Date.now() + 9 * 3600 * 1000); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, ym: `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}` };
}

// 시드: 은마 84㎡대 12건(월별 2건씩, 오래된 건 저렴) + 다른 단지 8건 + 소형 4건
function tradesFor(ym) {
  const i = [1, 2, 3, 4, 5, 6].find(k => ymAgo(k).ym === ym);
  if (!i) return [];
  const t = ymAgo(i);
  const basePrice = 240000 - i * 2000; // 만원 (오래될수록 저렴 — 보정 시 격차 줄어야)
  const mk = (aptNm, ar, amt) => ({ aptNm, excluUseAr: String(ar), dealAmount: String(amt).replace(/\B(?=(\d{3})+(?!\d))/g, ','), dealYear: String(t.y), dealMonth: String(t.m), dealDay: '15', floor: '10', umdNm: '대치동' });
  return [
    mk('은마', 84.43, basePrice), mk('은마', 76.79, Math.round(basePrice * 0.92)),
    mk('래미안대치', 84.99, basePrice + 30000),
    mk('은마', 34.0, 90000), // 면적 밴드 밖(84 기준) — 제외돼야
  ];
}

global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('rtms-svc')) {
    const ym = (u.match(/dealYmd=(\d{6})/) || [])[1];
    return { ok: true, status: 200, json: async () => ({ items: tradesFor(ym), totalCount: 4 }) };
  }
  if (u.includes('rone-svc')) {
    return { ok: true, status: 200, json: async () => ({ status: 'ok', region: '서울 아파트', latest: { time: '202606', value: 130.3 }, change: { m3: 0.6, m6: 2.1, m12: 4.8 } }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
process.env.URL = 'http://x';

const fn = require(path.join(REPO, 'netlify/functions/market-est'));
const call = async (q) => JSON.parse((await fn.handler({ queryStringParameters: q })).body);

(async () => {
  // ① 단지명+면적 매칭 + 보정 + 적응형 밴드(동일 평형 우선)
  const r1 = await call({ kind: 'apt', lawd: '11680', name: '은마', area: '84', months: '6', region: '서울' });
  ok(r1.status === 'ok', '기본 조회 ok');
  ok(r1.filter.areaMode === 'tight', `동일 평형 ±5% 모드 발동 (실제 ${r1.filter.areaMode})`);
  ok(r1.sample.n === 6, `84.43만 매칭 6건 — 76.79 혼입 제거 (실제 ${r1.sample.n})`);
  ok(!r1.trades.some(t => Math.abs(t.area - 84) > 84 * 0.05), '±5% 밖(76.79) 제외');
  ok(r1.confidence === '보통', `단지명+5건 이상 → 보통 (실제 ${r1.confidence})`);
  ok(r1.perM2 && r1.perM2.p25 < r1.perM2.p50 && r1.perM2.p50 < r1.perM2.p75, '분위수 순서');
  ok(r1.total && r1.total.p50 === Math.round(r1.perM2.p50 * 84), '총액 = ㎡당 × 면적');
  ok(r1.adjust.applied === true, '지수 보정 적용됨');
  const oldT = r1.trades.find(t => t.perM2Adj && t.perM2Adj > t.perM2);
  ok(!!oldT, '과거 거래 보정가 > 원가 (상승장 보정 방향)');
  ok(!r1.trades.some(t => t.name !== '은마'), '타 단지 제외');

  // ①-b 동일 평형 표본 부족 → ±20% 폴백
  const r1b = await call({ kind: 'apt', lawd: '11680', name: '은마', area: '84', months: '2' });
  ok(r1b.filter.areaMode === 'wide', `표본 부족 시 ±20% 폴백 (실제 ${r1b.filter.areaMode})`);
  ok(r1b.sample.n === 4, `폴백 매칭 4건(84.43×2+76.79×2, 실제 ${r1b.sample.n})`);

  // ② region 없으면 보정 미적용
  const r2 = await call({ kind: 'apt', lawd: '11680', name: '은마', area: '84', months: '6' });
  ok(r2.adjust.applied === false, 'region 없으면 보정 미적용');

  // ③ 단지명 없이 → 상한 보통
  const r3 = await call({ kind: 'apt', lawd: '11680', months: '6' });
  ok(r3.sample.n >= 20 && r3.confidence === '보통', `단지명 없이 n=${r3.sample.n} → 보통(상한)`);

  // ④ 불충분: 없는 단지
  const r4 = await call({ kind: 'apt', lawd: '11680', name: '없는단지', months: '6' });
  ok(r4.status === 'insufficient' && r4.confidence === '불충분' && !r4.perM2, '3건 미만 → 통계 미제시');

  // ⑤ 파라미터 검증
  const r5 = await call({ kind: 'apt', lawd: '123' });
  ok(r5.status === 'bad_request', 'lawd 5자리 검증');

  // ⑥ 동(읍면동) 적응형 필터 — 시드는 전부 대치동이라 매칭 시 local, 미존재 동은 sgg 유지
  const r6 = await call({ kind: 'apt', lawd: '11680', dong: '대치동', months: '6' });
  ok(r6.filter.dongMode === 'local' && r6.sample.n === 24, `동 매칭 5건 이상 → local (${r6.filter.dongMode}, n=${r6.sample.n})`);
  const r7 = await call({ kind: 'apt', lawd: '11680', dong: '없는동', months: '6' });
  ok(r7.filter.dongMode === 'sgg' && r7.sample.n === 24, `동 표본 부족 → 시군구 유지 (${r7.filter.dongMode}, n=${r7.sample.n})`);

  console.log(fail ? `\n❌ ${fail} FAIL` : '\n✅ ALL PASS');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
