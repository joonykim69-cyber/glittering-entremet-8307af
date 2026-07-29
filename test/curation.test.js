const { fromOnbid, scoreOpportunity, ddayOf } = require(__dirname + '/../netlify/functions/lib/curation');
let fail = 0;
const ok = (c, m) => { if (!c) { console.error('❌', m); fail++; } else console.log('✓', m); };
const nowKst = new Date(Date.UTC(2026, 6, 26)); // 2026-07-26

// 어댑터: 온비드 아이템 → 공통 팩트
const f = fromOnbid({ id: 'A1', pbctCdtnNo: '001', assetClass: '부동산', type: '아파트', usage: '아파트', region: '서울', appr: 10000, min: 6000, fail: 3, round: 4, bidEnd: '202607271400', photo: 'x' });
ok(f.source === 'onbid' && f.apsl === 10000 && f.low === 6000 && f.failCount === 3, '어댑터 매핑');

// ddayOf
ok(ddayOf('202607261400', nowKst) === 0, 'D-day 0(오늘)');
ok(ddayOf('202607291400', nowKst) === 3, 'D-day 3');
ok(ddayOf('', nowKst) === null, 'bidEnd 없으면 null');

// 큰 할인 + 유찰3 + 임박 + 예측 여력 → 높은 점수, 근거 다수
const r1 = scoreOpportunity(f, { pred: { lo: 6500, mid: 7500, hi: 8500 }, cell: null, nowKst });
ok(r1 && r1.score > 60, '큰 할인+유찰+여력 → 고득점: ' + (r1 && r1.score));
ok(r1.reasons.some(x => /감정가의 60%/.test(x.tag)), '저가율 근거 태그(60%)');
ok(r1.reasons.some(x => /3회 유찰/.test(x.tag)), '유찰 근거 태그');
ok(r1.reasons.some(x => /최저가보다/.test(x.tag)), '저평가 여력 근거 태그');
ok(r1.reasons.some(x => /D-1/.test(x.tag)), '개찰 임박 근거 태그');
ok(r1.flags.length === 0, '정상 물건 플래그 없음');

// 신탁(최저가 ≥ 감정가): 할인 가점 없음 + 주의 플래그
const t = fromOnbid({ id: 'T', pbctCdtnNo: '1', appr: 5000, min: 6000, fail: 0, bidEnd: '' });
const rt = scoreOpportunity(t, { pred: null, cell: null, nowKst });
ok(rt === null || rt.reasons.every(x => !/하락/.test(x.tag)), '신탁: 할인 가점 없음');
const rt2 = scoreOpportunity(fromOnbid({ id: 'T2', pbctCdtnNo: '1', appr: 5000, min: 6000, fail: 2, bidEnd: '' }), { nowKst });
ok(rt2.flags.some(x => /신탁·특수/.test(x)), '신탁: 주의 플래그');

// 감정가 미공개(0): 할인 판단 불가 플래그, 유찰만으로 점수
const nz = scoreOpportunity(fromOnbid({ id: 'N', pbctCdtnNo: '1', appr: 0, min: 3000, fail: 2, bidEnd: '' }), { nowKst });
ok(nz && nz.flags.some(x => /감정가 미공개/.test(x)), '감정가 0 → 미공개 플래그');
ok(nz.reasons.some(x => /유찰/.test(x.tag)), '감정가 0라도 유찰 가점');

// 근거 하나도 없음(신건·유찰0·감정가만·여력 없음) → null (큐레이션 제외)
const none = scoreOpportunity(fromOnbid({ id: 'Z', pbctCdtnNo: '1', appr: 10000, min: 9900, fail: 0, bidEnd: '' }), { nowKst });
ok(none === null, '가점 근거 없으면 null(제외)');

// 셀 폴백: 예측 없고 셀 중앙 낙찰가율 높으면 여력 가점
const cf = scoreOpportunity(fromOnbid({ id: 'C', pbctCdtnNo: '1', appr: 10000, min: 7000, fail: 0, bidEnd: '' }), { cell: { n: 40, lr: { p10: 105, p50: 120, p90: 140 } }, nowKst });
ok(cf.reasons.some(x => /유사 사례 중앙 낙찰가율/.test(x.tag)), '셀 폴백 여력 근거');

// 점수 0~100 클램프
ok(r1.score <= 100, '점수 상한 100');

console.log(fail ? `\n❌ ${fail} FAIL` : '\n✅ ALL PASS');
process.exit(fail ? 1 : 0);
