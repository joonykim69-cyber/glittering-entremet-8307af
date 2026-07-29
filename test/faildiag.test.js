// 유찰 진단 엔진 시뮬레이션 — FD-ENGINE 마커로 실코드 블록을 추출해 DOM 스텁으로 실행
const fs = require('fs');
let fail = 0;
const ok = (c, m) => { if (!c) { console.error('❌', m); fail++; } else console.log('✓', m); };

const html = fs.readFileSync(__dirname + '/../bidcast-detail.html', 'utf8');
const m = html.match(/\/\/ FD-ENGINE-START[\s\S]*?\/\/ FD-ENGINE-END/);
if (!m) { console.error('❌ FD-ENGINE 블록 추출 실패'); process.exit(1); }

// DOM·window 스텁
const els = {};
global.document = { getElementById: id => els[id] || (els[id] = { style: {}, innerHTML: '', textContent: '' }) };
global.window = global;
eval(m[0]);

function reset() { delete window.__fd; for (const k in els) delete els[k]; } // 실행 순서 재현: 첫 fdSet 호출 시 __fd 미초기화 상태

// ⓪ 실행 순서 회귀: __fd가 없는 상태에서 첫 fdSet 호출이 던지지 않아야(실배포 버그 재현)
reset();
let threw = false;
try { fdSet({ live: true, fail: 17, appr: 11100, min: 1110 }); } catch (e) { threw = true; }
ok(!threw, '초기화 전 첫 fdSet 호출이 예외를 던지지 않음 (자가 초기화)');

// ① 동광아파트 케이스: 유찰 17·저가율 10%·취소 3·압류재산·시세 밴드
reset();
fdSet({ live: true, fail: 17, round: 42, appr: 11100, min: 1110 });
fdSet({ cancels: 3 });
fdSet({ prptDiv: '압류재산' });
fdSet({ mkt: { scope: '중리동', kind: '아파트 매매' } });
const card = els.failDiagCard.innerHTML;
ok(els['sec-failDiag'].style.display === '', '섹션 표시됨');
ok(/가격 매력 부족이 원인일 가능성은 낮습니다/.test(card), '가격 요인 배제 판정(강 신호)');
ok(/10%/.test(card), '저가율 10% 표기');
ok(/취소가 3회/.test(card), '취소 반복 신호');
ok(/압류재산 공매/.test(card), '압류재산 신호');
ok(/중리동.*아파트 매매.*대조/.test(card), '시세 밴드 참조 안내');
ok(/등기부등본/.test(card) && /공매재산명세서/.test(card) && /현장 점유/.test(card), '체크리스트 3대 항목');
ok(card.indexOf('등기부등본') < card.indexOf('공매재산명세서'), '체크리스트 우선순위(등기부 먼저)');
ok(/취소된 회차의 공고 취소/.test(card), '취소 사유 확인 항목 추가');
ok(/17회/.test(card) && /42회차/.test(card), '유찰·회차 헤더');
ok(/원인 확정이 아니라/.test(els.failDiagNote.textContent), '면책 문구');

// ② 유찰 2회 → 미표시
reset();
fdSet({ live: true, fail: 2, appr: 10000, min: 6400 });
ok(!els['sec-failDiag'] || els['sec-failDiag'].style.display !== '', '유찰 3회 미만 → 미표시');

// ③ 데모(라이브 아님) → 미표시
reset();
fdSet({ fail: 10, appr: 10000, min: 3000 });
ok(!els['sec-failDiag'] || els['sec-failDiag'].style.display !== '', '라이브 아님 → 미표시');

// ④ 신탁(최저가≥감정가)
reset();
fdSet({ live: true, fail: 4, appr: 5000, min: 6000 });
ok(/신탁\/특수 매각 구조/.test(els.failDiagCard.innerHTML), '신탁 구조 신호');

// ⑤ 감정가 미공개
reset();
fdSet({ live: true, fail: 5, appr: 0, min: 300 });
ok(/감정가 미공개/.test(els.failDiagCard.innerHTML), '감정가 0 → 판단 불가 문구');

// ⑥ 중간 저가율(유찰 3·disc 64%) → 강 신호 아님, 정보성
reset();
fdSet({ live: true, fail: 3, appr: 10000, min: 6400 });
const c6 = els.failDiagCard.innerHTML;
ok(!/가능성은 낮습니다/.test(c6) && /64%/.test(c6), '중간 깊이 → 정보성 신호만');

console.log(fail ? `\n❌ ${fail} FAIL` : '\n✅ ALL PASS');
process.exit(fail ? 1 : 0);
