// test/curation.test.js — 랜딩에 올릴 물건을 우리 기준으로 고르는가 (큐레이션 v2)
//
// 왜 v1을 버렸나(2026-07-29 창업자 지시):
//   v1 점수의 68%가 "싸 보이는가"(저가율+유찰)였는데, 상세 페이지는 정확히 그 조합에
//   **"이만한 명목 마진에도 안 팔린 건 숨은 인수 부담의 시장 신호"** 라고 경고를 붙인다.
//   랜딩이 1등으로 데려온 물건에 상세가 빨간 신호를 띄우는 구조였다 — 같은 서비스가 반대말.
//
// 지키는 것:
//   ① 1단 필터 — 실제 입찰 수요가 있는 분류만(주거 4종 / 명품·회원권·보석·골동품 / 차량)
//   ② 2단 배제 — 낙찰률이 본 지표, 유찰 횟수는 폴백. 신탁은 제외가 아니라 **분리**
//   ③ 3단 순위 — 차익은 보수 가정으로만, 근거 없으면 아예 안 올림
//   ④ 동산에 차익을 말하지 않는다(시세가 우리 데이터가 아님)
//   ⑤ 보장 어휘 금지

'use strict';

const { t, eq, done, repoPath } = require('./_harness');
const { fromOnbid, selectItem, ddayOf, mvDemandCat, acqCostMan, SOLD_MIN, FAIL_MAX } =
  require(repoPath('netlify/functions/lib/curation'));
const { lawdOf, LAWD } = require(repoPath('netlify/functions/lib/lawd'));

const nowKst = new Date(Date.UTC(2026, 6, 26)); // 2026-07-26
const base = {
  source: 'onbid', id: 'A1', cdtn: '1', assetClass: '부동산', type: '아파트', usage: '아파트',
  title: '서울 강남구 대치동 은마아파트 101동 501호', region: '서울 강남구 대치동',
  apsl: 100000, low: 62000, area: 59.8, failCount: 1, round: 2, bidEnd: '202608051700',
};
const ctxOK = { pred: { lo: 66000, mid: 71000, hi: 78000, soldProb: 64 }, band: { lo: 1600, mid: 1900, hi: 2200, n: 240 }, nowKst };

// ── 어댑터 ──
const f = fromOnbid({ id: 'A1', pbctCdtnNo: '001', assetClass: '부동산', type: '아파트', usage: '아파트',
  title: 'T', region: '서울 강남구', appr: 10000, min: 6000, bldgAr: 84.9, fail: 3, round: 4, bidEnd: '202607271400' });
t('어댑터: 금액·면적·회차 매핑', f.apsl === 10000 && f.low === 6000 && f.area === 84.9 && f.failCount === 3);
eq('D-day 0(오늘)', ddayOf('202607261400', nowKst), 0);
eq('D-day 3', ddayOf('202607291400', nowKst), 3);
eq('bidEnd 없으면 null', ddayOf('', nowKst), null);

// ── ① 1단 필터 ──
t('① 주거 4종은 후보', ['아파트', '오피스텔', '연립다세대', '단독주택']
  .every(ty => selectItem({ ...base, type: ty }, ctxOK) != null));
t('① 토지·상가·공장은 후보 아님', ['토지', '상가', '공장창고', '농지임야', '사무실']
  .every(ty => selectItem({ ...base, type: ty }, ctxOK) === null));

const mv = { ...base, assetClass: '동산', type: '기타', area: 0, apsl: 1400, low: 1180 };
t('① 명품시계 감지', mvDemandCat('롤렉스 서브마리너 126610LN', '') !== null);
t('① 골프회원권 감지', mvDemandCat('OO컨트리클럽 골프 회원권 1구좌', '') !== null);
t('① 귀금속 감지', mvDemandCat('순금 골드바 100g', '') !== null);
t('① 골동품 감지', mvDemandCat('조선백자 도자기', '') !== null);
t('① 일반 동산(폐기물)은 후보 아님',
  selectItem({ ...mv, title: '폐기물 2,376점 일괄' }, { pred: { soldProb: 80 }, nowKst }) === null);
t('① 중고 집기도 후보 아님',
  selectItem({ ...mv, title: '업소용 중고 오븐 1대' }, { pred: { soldProb: 80 }, nowKst }) === null);

// ── ② 2단 배제 — 낙찰률이 본 지표 ──
eq('② 낙찰률 문턱 미만 → 제외', selectItem(base, { ...ctxOK, pred: { ...ctxOK.pred, soldProb: SOLD_MIN - 1 } }), null);
t('② 문턱 이상이면 통과', selectItem(base, { ...ctxOK, pred: { ...ctxOK.pred, soldProb: SOLD_MIN } }) != null);

// 유찰 횟수보다 낙찰률이 우선한다(창업자 결정) — 유찰 4회여도 잘 팔리는 조건이면 남긴다
t('② 유찰 4회여도 낙찰률 높으면 통과', selectItem({ ...base, failCount: 4 }, ctxOK) != null);
// 낙찰률 근거가 없을 때만 유찰 횟수로 폴백
t('② 낙찰률 근거 없고 유찰 과다 → 제외',
  selectItem({ ...base, failCount: FAIL_MAX }, { band: ctxOK.band, pred: { lo: 66000, mid: 71000, hi: 78000 }, nowKst }) === null);
t('② 낙찰률 근거 없어도 유찰 적으면 통과',
  selectItem({ ...base, failCount: 1 }, { band: ctxOK.band, pred: { lo: 66000, mid: 71000, hi: 78000 }, nowKst }) != null);
t('② 봉인에 확률이 없으면 셀 낙찰률 사용',
  selectItem(base, { band: ctxOK.band, pred: { lo: 66000, mid: 71000, hi: 78000 }, cell: { soldRate: 10 }, nowKst }) === null);

// 신탁은 "제외"가 아니라 "분리"
const trust = selectItem({ ...base, apsl: 50000, low: 53000 }, ctxOK);
eq('② 신탁·특수매각 → trust 트랙', trust && trust.track, 'trust');
t('② 신탁은 근거를 밝힌다', /할인 구조가 아님/.test(trust.reasons[0].tag));
t('② 신탁에 구조 경고 부착', trust.flags.some(x => /권리·인수조건/.test(x)));

// ── ③ 3단 순위 — 차익은 보수 가정으로만 ──
const m = selectItem(base, ctxOK);
eq('③ 차익 트랙', m.track, 'margin');
eq('③ 보수 가치 = 시세 하단 × 면적', m.margin.valueMan, Math.round(1600 * 59.8));
eq('③ 보수 비용 = 예상 낙찰 상단 + 부대비용', m.margin.costMan, 78000 + acqCostMan(78000));
eq('③ 순여지 = 가치 − 비용', m.margin.netMan, Math.round(1600 * 59.8) - (78000 + acqCostMan(78000)));
t('③ 근거에 여지 금액 표기', /여지/.test(m.reasons[0].tag));

// 근거가 하나라도 없으면 차익 트랙에 올리지 않는다
t('③ 시세 밴드 없으면 미산출', selectItem(base, { ...ctxOK, band: null }) === null);
t('③ 면적 없으면 미산출', selectItem({ ...base, area: 0 }, ctxOK) === null);
t('③ 봉인 예측 없으면 미산출', selectItem(base, { ...ctxOK, pred: null }) === null);
// 보수 기준으로 여지가 없으면 올리지 않는다("싸 보인다"만으로 올리던 v1의 실수)
t('③ 보수 기준 여지 없으면 미산출', selectItem(base, { ...ctxOK, band: { lo: 900, mid: 1000, hi: 1100, n: 99 } }) === null);

// 마감 임박은 closing 트랙으로 (같은 물건이 두 트랙에 겹치지 않게)
eq('③ D-0은 closing 트랙', selectItem({ ...base, bidEnd: '202607261700' }, ctxOK).track, 'closing');

// ── ④ 동산에는 차익을 말하지 않는다 ──
const w = selectItem({ ...mv, title: '롤렉스 서브마리너 126610LN' }, { pred: { soldProb: 71 }, nowKst });
eq('④ 명품시계 → demand 트랙', w.track, 'demand');
eq('④ 동산에는 margin이 없다', w.margin, undefined);
t('④ 품목·낙찰률을 근거로', /명품시계 · 같은 품목 낙찰률 71%/.test(w.reasons[0].tag));
t('④ 시세는 직접 확인하라고 밝힘', w.flags.some(x => /직접 확인/.test(x)));
t('④ 낙찰률 근거 없으면 "잘 팔린다"고 말하지 않음',
  selectItem({ ...mv, title: '롤렉스 서브마리너' }, { nowKst }) === null);

// ── ⑤ 보장 어휘 금지 ──
const allTags = [m, w, trust].flatMap(r => (r.reasons || []).map(x => x.tag).concat(r.flags || [])).join(' ');
t('⑤ 보장·추천 어휘 없음', !/(보장|확실|추천|사세요|매수하|반드시|무조건)/.test(allTags), allTags.slice(0, 160));
t('⑤ 차익은 "보수적으로 계산해도"로 한정', /보수적으로 계산해도/.test(m.reasons[0].tag));

// ── 지역 코드 (시세 밴드 셀의 지역 축) ──
eq('lawd: 서울 강남구', lawdOf('서울 강남구 대치동'), '11680');
eq('lawd: 시 아래 구', lawdOf('경기도 수원시 권선구 금곡동'), '41113');
eq('lawd: 정식 시도명(전라남도)', lawdOf('전라남도 여수시 학동'), '46130');
eq('lawd: 단층 시도(세종)', lawdOf('세종특별자치시 조치원읍'), '36110');
eq('lawd: 미등록은 빈 문자열', lawdOf('알수없는곳 어딘가'), '');

// 클라이언트(bidcast-detail.html)에 있는 사본과 어긋나지 않는가 — 빌드가 없어 사본이 둘이다
{
  const fs = require('fs');
  const html = fs.readFileSync(repoPath('bidcast-detail.html'), 'utf8');
  const mm = html.match(/const RTMS_LAWD=(\{[\s\S]*?\n      \});/);
  t('lawd: 클라이언트 사본 추출', !!mm);
  if (mm) {
    const client = eval('(' + mm[1] + ')');
    const diffs = [];
    for (const sido of Object.keys(client)) {
      for (const sgg of Object.keys(client[sido])) {
        if (!LAWD[sido] || LAWD[sido][sgg] !== client[sido][sgg]) diffs.push(`${sido}/${sgg}`);
      }
    }
    eq('lawd: 서버·클라이언트 사본 일치', diffs.slice(0, 3), []);
  }
}

done('curation v2 (수요 분류 · 낙찰률 배제 · 보수 차익 · 신탁 분리)');
