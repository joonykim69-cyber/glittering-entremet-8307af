// test/hwp.test.js — HWP/HWPX 텍스트 추출 파서(lib/hwp.js).
//
// 순환 검증 회피: fixture는 **우리 코드가 만들지 않았다**. .hwp는 SheetJS `cfb`(제3자 CFB
//   구현)로, .hwpx는 시스템 `zip` 명령으로 생성해 test/fixtures/에 커밋해 두었다
//   (생성 절차는 test/fixtures/README.md). 우리 writer로 만든 파일을 우리 parser로 읽으면
//   둘이 같이 틀려도 통과하므로, 그 고리를 끊는 것이 이 테스트의 핵심이다.

'use strict';

const fs = require('fs');
const { t, done, fnPath, repoPath } = require('./_harness');
const H = require(fnPath('lib/hwp.js'));

const fx = n => fs.readFileSync(repoPath('test', 'fixtures', n));
const P1 = '공매재산명세서', P2 = '임차인: 홍길동, 보증금 5,000만원 (인수 조건)', P3 = '명도책임: 매수인';

// ── ① 압축 .hwp ──
const hwpBuf = fx('sample-compressed.hwp');
t('① sniff: CFB → hwp', H.sniff(hwpBuf) === 'hwp', H.sniff(hwpBuf));
let r = H.extractText(hwpBuf);
t('① 압축 .hwp 추출 성공', r.ok === true, r.reason);
t('① 본문 문단 전부 추출', r.ok && r.text.includes(P1) && r.text.includes(P2) && r.text.includes(P3));
t('① 다른 태그 내용 미포함(PARA_TEXT만)', r.ok && !/AAAA/.test(r.text));
t('① 섹션 순서 유지(Section0 → Section1)', r.ok && r.text.indexOf(P1) < r.text.indexOf(P3));

// ── ② 비압축 .hwp ──
r = H.extractText(fx('sample-uncompressed.hwp'));
t('② 비압축 .hwp 추출', r.ok === true && r.text.includes(P2), r.reason);

// ── ③ 암호 문서는 정직하게 실패(추측 복호화 금지) ──
r = H.extractText(fx('sample-encrypted.hwp'));
t('③ 암호 문서 실패 처리', r.ok === false && /암호/.test(r.reason), JSON.stringify(r));

// ── ④ 큰 레코드(size 0xFFF → 확장 헤더) ──
r = H.extractText(fx('sample-longrecord.hwp'));
t('④ 확장 크기 레코드 처리', r.ok === true && r.text.includes('가'.repeat(100)), r.ok ? r.text.length : r.reason);

// ── ⑤ 제어문자 규칙(확장/인라인 8 WCHAR 소비, 10/13 개행) ──
function wchars(codes) { const b = Buffer.alloc(codes.length * 2); codes.forEach((c, i) => b.writeUInt16LE(c, i * 2)); return b; }
const dec = H.decodeParaText(wchars([65, 66, 2, 0, 0, 0, 0, 0, 0, 0, 67, 68, 13, 69, 70]));
t('⑤ 확장 제어문자 8WCHAR 소비', dec.replace(/\n/g, '') === 'ABCDEF', JSON.stringify(dec));
t('⑤ 제어문자 쓰레기 미노출', !/[--]/.test(dec));

// ── ⑥ .hwpx (진짜 ZIP) ──
const hwpxBuf = fx('sample.hwpx');
t('⑥ sniff: ZIP → hwpx', H.sniff(hwpxBuf) === 'hwpx');
r = H.extractText(hwpxBuf);
t('⑥ .hwpx 추출 성공', r.ok === true, r.reason);
t('⑥ 두 섹션 모두 추출', r.ok && r.text.includes(P1) && r.text.includes(P3));
t('⑥ XML 태그 미노출', r.ok && !/<hp:/.test(r.text));

// ── ⑦ 형식 아닌 입력은 정직하게 실패 ──
r = H.extractText(Buffer.from('%PDF-1.4 hello'));
t('⑦ PDF 입력 → 실패(형식 아님)', r.ok === false && /형식/.test(r.reason), JSON.stringify(r));
t('⑦ 빈/짧은 입력 → 실패', H.extractText(Buffer.alloc(4)).ok === false);

// ── ⑧ 손상 파일에서 크래시하지 않음(던지지 말고 ok:false) ──
const broken = Buffer.from(hwpBuf); broken.fill(0, 600, 900);
let threw = false; try { H.extractText(broken); } catch (e) { threw = true; }
t('⑧ 손상 CFB에서 예외 던지지 않음', !threw);

done('hwp (HWP/HWPX 파서)');
