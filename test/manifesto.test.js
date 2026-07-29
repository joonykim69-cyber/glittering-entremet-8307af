// test/manifesto.test.js — 헌장이 실제 코드·시스템과 어긋나지 않는지 대조.
//
// 왜: 헌장은 원칙 문서지만 Appendix A(인벤토리)·B(스키마)는 **사실 기술**이다. 사실이
//   틀리면 헌장 전체의 신뢰가 깎인다. 실제로 14절 "실측 기록"이 n=43에 멈춰 있었는데
//   프로덕션은 107건이었다 — 그래서 수치는 아예 싣지 않기로 하고(단일 출처: scoreboard),
//   구조적 사실만 남긴 뒤 그 사실을 여기서 기계 대조한다.
//
// 이 테스트는 "헌장에 좋은 말이 쓰여 있는가"가 아니라 **"쓰여 있는 게 사실인가"**를 본다.

'use strict';

const fs = require('fs');
const path = require('path');
const { t, eq, done, repoPath, ROOT } = require('./_harness');

const M = fs.readFileSync(repoPath('000_PROJECT_MANIFESTO.md'), 'utf8');
const toml = fs.readFileSync(repoPath('netlify.toml'), 'utf8');

// ── Golden Rules ──
t('GR12 신설 — 정직함만으로는 부족하다', /12\. \*\*정직함만으로는 부족하다\.\*\*/.test(M));
t('GR12가 1~11번을 이기지 못함을 명시', /1~11번을 이기지는 못한다/.test(M));
t('GR12에 실제 사례가 붙어 있음', /채점 107건 중 부동산이 1건뿐일 때/.test(M));
eq('Golden Rules 12개', (M.match(/^\d+\. \*\*/gm) || []).length >= 12, true);

// ── 14절: 수치를 싣지 않는다(단일 출처) ──
t('14절이 단일 출처를 선언', /실측치의 단일 출처/.test(M));
t('낡은 스냅샷 제거(n=43)', !/n=43/.test(M), '헌장에 아직 옛 수치가 남아 있음');
t('부트스트랩 실측 문단 제거', !/실측 기록\(부트스트랩 시점/.test(M));
t('scoreboard를 출처로 지목', /scoreboard/.test(M));
// 증명한 것(서사)은 남긴다 — 숫자 없이
t('학습 곡선 증명 서술 유지', /학습이 늘수록 좋아진다/.test(M));
t('기각 사례 서술 유지', /열화는 라이브 전에 잡힌다/.test(M));

// ── Appendix A: 인벤토리가 실제 파일과 일치하는가 ──
const fnDir = path.join(ROOT, 'netlify', 'functions');
const fnCount = fs.readdirSync(fnDir).filter(f => f.endsWith('.js')).length;
const libs = fs.readdirSync(path.join(fnDir, 'lib')).filter(f => f.endsWith('.js'));
const pages = fs.readdirSync(ROOT).filter(f => /^bidcast.*\.html$/.test(f)).length;
const tests = fs.readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.test.js')).length;
const crons = (toml.match(/\[functions\."[^"]+"\]/g) || []).length;

t(`Appendix A 함수 수 일치 (실제 ${fnCount})`, M.includes(`서버리스 함수 ${fnCount}종`), M.match(/서버리스 함수 \d+종/));
t(`Appendix A 예약 함수 수 일치 (실제 ${crons})`, M.includes(`${crons}종이 예약 실행`), M.match(/\d+종이 예약 실행/));
t(`Appendix A 페이지 수 일치 (실제 ${pages})`, M.includes(`정적 페이지 ${pages}종`));
t(`Appendix A 테스트 수 일치 (실제 ${tests})`, M.includes(`${tests}파일`), M.match(/`test\/`, \d+파일/));
t(`Appendix A lib 수 일치 (실제 ${libs.length})`, M.includes(`공용 라이브러리 ${libs.length}종`));
for (const l of libs) t(`Appendix A에 ${l} 기재`, M.includes('`' + l + '`'), l);

// 인벤토리 날짜가 갱신됐는가(오래된 기준일을 방치하지 않는다)
t('Appendix A 기준일 2026-07-29', /Appendix A — 시스템 인벤토리 \(2026-07-29 기준\)/.test(M));

// 예약 함수는 전부 표에 ⏰로 표시돼 있어야 한다
const cronNames = [...toml.matchAll(/\[functions\."([^"]+)"\]/g)].map(m => m[1]);
for (const c of cronNames) {
  const row = M.split('\n').find(l => l.includes(c) && l.includes('⏰'));
  t(`⏰ 표시: ${c}`, !!row, `헌장 Appendix A에 ${c}가 예약 함수로 없음`);
}

// 크론 총량 문구가 실제와 맞는가
let perDay = 0;
for (const m of toml.matchAll(/\[functions\."[^"]+"\]\s*\n\s*schedule = "([^"]+)"/g)) {
  const [mi, h] = m[1].split(' ');
  const a = /^\*\/(\d+)$/.test(mi) ? Math.floor(60 / +mi.slice(2)) : 1;
  const b = h === '*' ? 24 : (/^\*\/(\d+)$/.test(h) ? Math.floor(24 / +h.slice(2)) : 1);
  perDay += a * b;
}
t(`크론 총량 문구 일치 (실제 ${perDay}회/일)`, M.includes(`하루 ${perDay}회`), M.match(/하루 \d+회/));

// ── Appendix B: 실제로 쓰는 네임스페이스가 기재돼 있는가 ──
for (const ns of ['mkt/seal/', 'mkt/agg', 'bt/sim/', '_quota/', 'alertsent/', 'subidx/']) {
  t(`Appendix B에 ${ns} 기재`, M.includes(ns), ns);
}
t('Appendix B: 시세 봉인 불변 명시', /lo\/mid\/hi 수정 금지/.test(M));
t('Appendix B: 시세·낙찰가 격리 명시', /절대 섞이지 않는다/.test(M));

// ── Appendix C: 이번 개정이 대장에 기록됐는가 ──
for (const d of ['성적 측정·표시 단위는 자산군별', '승격 판정은 상대전적', '근거 없으면 예측하지 않는다']) {
  t(`Appendix C 기록: ${d}`, M.includes(d), d);
}

// ── 코드와 헌장의 상호 참조가 살아 있는가 ──
const auditSrc = fs.readFileSync(path.join(fnDir, 'audit-weekly.js'), 'utf8');
t('감사역 코드가 상대전적으로 판정', /bWinRate >= 62/.test(auditSrc));
t('감사역 코드에 폭 가드 존재', /WIDTH_GUARD_X/.test(auditSrc));

done('manifesto (헌장 ↔ 실제 대조)');
