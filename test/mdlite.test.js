// 검증: mdLite — 이스케이프 우선 + 변환 정확성 (실 요약 출력 형태 재현 fixture)
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../bidcast-detail.html', 'utf8');

// 1차: 문법
let ok = 0, fail = 0;
const re = /<script(?![^>]*ld\+json)[^>]*>([\s\S]*?)<\/script>/gi;
let m;
while ((m = re.exec(src))) {
  const body = m[1];
  if (!body.trim()) continue;
  try { new Function(body); ok++; } catch (e) { fail++; console.log('SYNTAX FAIL:', e.message); }
}
console.log(`[1차 문법] ok=${ok} fail=${fail}`);
if (fail) process.exit(1);

// 2차: mdLite 추출 fixture — 실 요약 스크린샷 형태 재현
const fx = src.match(/function mdLite[\s\S]*?\n}/)[0];
const sandbox = {};
new Function('exports', fx + '\nexports.mdLite=mdLite;')(sandbox);
const { mdLite } = sandbox;

let n = 0, bad = 0;
function t(name, cond) { n++; if (!cond) { bad++; console.log('FAIL:', name); } }

// 실 출력 형태(스크린샷 재현)
const real = '# 부동산매매계약서 내용 정리\n\n**문서에 기재된 내용의 요약이며 법률 자문이 아닙니다.**\n\n---\n\n## ① 임대차·임차인 관련\n\n- **임대차 현황**: 제19조 특약사항 ⑦';
const out = mdLite(real);
t('제목 변환', out.includes('<strong style="display:block') && !out.includes('# 부동산'));
t('굵게 변환', out.includes('<strong>임대차 현황</strong>') && !/\*\*/.test(out));
t('구분선 변환', out.includes('<hr') && !/---/.test(out));
t('불릿 변환', out.includes('· <strong>임대차'));
t('개행 변환', out.includes('<br>'));

// 보안: HTML/script 주입이 이스케이프되는지 (요약은 LLM 출력 = 신뢰 불가 텍스트)
const evil = mdLite('<script>alert(1)<\/script> <img src=x onerror=y> ## 제목');
t('script 이스케이프', !evil.includes('<script>') && evil.includes('&lt;script&gt;'));
t('img 이스케이프', !evil.includes('<img'));
t('중간 ## 비변환(행 시작만)', !evil.includes('display:block')); // '## 제목'이 행 중간이라 제목 아님

// 이스케이프 후 변환 순서 — & 이중 이스케이프 없음
t('& 처리', mdLite('A & B') === 'A &amp; B');

// 렌더 배선(정적): 성공 경로가 mdLite 사용, 실패·스캔 경로는 textContent 유지(주입면 없음)
t('성공 경로 mdLite', /box\.innerHTML=`<strong>📖 문서 AI 정리/.test(src) && /\+mdLite\(d\.summary\)/.test(src));
t('스캔 경로 textContent 유지', /box\.textContent=`ℹ️/.test(src));
t('실패 경로 textContent 유지', src.includes("box.textContent='⚠️ 문서 정리에 실패했습니다"));

console.log(`[2차 fixture] ${n - bad}/${n} pass`);
process.exit(bad ? 1 : 0);
