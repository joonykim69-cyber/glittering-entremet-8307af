// test/shell.test.js — 앱 셸(좌측 내비)이 "부분부분" 적용으로 되돌아가지 않게 고정한다.
//
// 왜 이 테스트가 있나(2026-08-04 창업자 지적 "지금은 부분부분 적용이 되어 있어요"):
//   Phase 2b가 마이·리스트 2페이지에만 셸을 붙였더니, 좌측 내비에서 링크를 눌러 이동하면
//   **그 내비가 사라졌다.** 한 화면씩 보면 각각 옳은데 이어서 쓰면 화면마다 내비가 바뀐다 —
//   부분 적용이 미적용보다 나쁜 전형이다. 페이지는 앞으로도 늘어나므로, 사람이 기억하는 대신
//   **내비 링크 집합과 셸 적용 집합이 어긋나면 실패**하게 만든다.
//
// 지키는 것:
//   ① 좌측 내비가 가리키는 화면에서는 좌측 내비가 유지된다(집합 일치 — 새 페이지를 내비에
//      넣으면 그 페이지에도 셸이 있어야 한다)
//   ② 제외는 우연이 아니라 결정이다 — 랜딩·파트너(마케팅 진입)·상세(#187 판단)에는 셸이 없다
//   ③ 내비 블록은 12페이지가 동일하다(활성 표시만 다름 — 한 곳만 고치는 drift 방지)
//   ④ 우측 패널이 없으면 `no-aside` — 3열 격자를 그대로 두면 292px 유령 컬럼이 생겨
//      본문이 이유 없이 좁아진다(1440px에서 1128 → 810px)
//   ⑤ fixed 오버레이(모달)는 셸 밖에 둔다 — 본문 격자에 넣지 않는다
//   ⑥ 모바일(<1024px)은 셸이 꺼지고 기존 top nav·햄버거가 그대로 동작한다(정보 손실 0)

'use strict';

const fs = require('fs');
const { t, eq, done, repoPath } = require('./_harness');

const css = fs.readFileSync(repoPath('bidcast.css'), 'utf8');
const read = f => fs.readFileSync(repoPath(f), 'utf8');
const allPages = fs.readdirSync(repoPath('.')).filter(f => /^bidcast.*\.html$/.test(f));

// 셸을 쓰지 않기로 한 화면 — 이유는 위 ②. 목록을 늘리려면 근거를 함께 남길 것.
const EXCLUDED = ['bidcast.html', 'bidcast-partner.html', 'bidcast-detail.html'];
const shellPages = allPages.filter(f => read(f).includes('class="shell-nav"'));

// ── ① 내비가 가리키는 화면 == 셸을 쓰는 화면 ──
const navBlock = s => {
  const i = s.indexOf('<aside class="shell-nav"');
  return i < 0 ? '' : s.slice(i, s.indexOf('</aside>', i));
};
const navTargets = [...new Set(
  [...navBlock(read('bidcast-list.html')).matchAll(/href="(bidcast[^"]*\.html)"/g)].map(m => m[1])
)];

t('① 내비 링크가 12개(찾기 4 · 판단 도구 5 · 내 공간 3)', navTargets.length === 12, navTargets.length);
t('① 내비가 가리키는 페이지는 전부 실재', navTargets.filter(p => !allPages.includes(p)));
eq('① 내비 링크 집합 == 셸 적용 집합', [...shellPages].sort().join(), [...navTargets].sort().join());
t('① 셸 적용 12페이지', shellPages.length === 12, shellPages.length);

// ── ② 제외는 결정이다 ──
for (const f of EXCLUDED) {
  t(`② 셸 미적용: ${f}`, !read(f).includes('class="shell-nav"'));
  t(`② 내비에도 없음: ${f}`, !navTargets.includes(f));
}
eq('② 전체 = 셸 12 + 제외 3', allPages.length, shellPages.length + EXCLUDED.length);

// ── ③ 내비 블록은 페이지마다 같다(활성 표시만 다름) ──
const strip = s => s.replace(/ class="on"/g, '');
const canon = strip(navBlock(read('bidcast-list.html')));
for (const f of shellPages) {
  const s = read(f);
  const nb = navBlock(s);
  eq(`③ 내비 블록 동일: ${f}`, strip(nb), canon);
  const on = [...nb.matchAll(/href="(bidcast[^"]*\.html)" class="on"/g)].map(m => m[1]);
  eq(`③ 자기 자신만 활성: ${f}`, on.join(), f);
  t(`③ body.shell-page: ${f}`, /<body class="[^"]*shell-page/.test(s));
  t(`③ 공용 CSS 링크: ${f}`, s.includes('bidcast.css'));
  // 셸 열고 닫힘이 균형인가(닫는 주석은 마크업 재배치의 유일한 안전줄이다)
  eq(`③ shell-main 열고 닫음: ${f}`,
    (s.match(/<div class="shell-main">/g) || []).length,
    (s.match(/\/\.shell-main -->/g) || []).length);
  eq(`③ shell 열고 닫음: ${f}`,
    (s.match(/<div class="shell( no-aside)?">/g) || []).length,
    (s.match(/\/\.shell -->/g) || []).length);
}

// ── ④ 우측 패널이 없으면 no-aside ──
t('④ 공용 CSS에 no-aside 규칙', /\.shell\.no-aside\{grid-template-columns:228px minmax\(0,1fr\)\}/.test(css));
t('④ 3열은 1280px 이상에서만', /@media\(min-width:1280px\)\{[^}]*\.shell\{grid-template-columns:228px minmax\(0,1fr\) 292px\}/.test(css));
for (const f of shellPages) {
  const s = read(f);
  const hasAside = s.includes('class="shell-aside"');
  const declared = !s.includes('<div class="shell no-aside">');
  eq(`④ 패널 유무와 선언 일치: ${f}`, hasAside, declared);
}
t('④ 패널 보유 화면은 리스트·마이 2곳', shellPages.filter(f => read(f).includes('class="shell-aside"')).join() ===
  'bidcast-list.html,bidcast-my.html', shellPages.filter(f => read(f).includes('class="shell-aside"')).join());

// ── ⑤ fixed 오버레이는 셸 밖 ──
for (const f of shellPages) {
  const s = read(f);
  const open = s.indexOf('<div class="shell');
  const close = s.lastIndexOf('/.shell -->');
  const inside = s.slice(open, close);
  t(`⑤ auth 모달이 셸 밖: ${f}`, !inside.includes('id="authOverlay"'));
  t(`⑤ 그 외 오버레이도 셸 밖: ${f}`, !/id="[A-Za-z]*[Oo]verlay"/.test(inside),
    (inside.match(/id="[A-Za-z]*[Oo]verlay"/g) || []).join());
}

// ── ⑥ 모바일은 셸이 꺼진다 ──
t('⑥ 셸은 기본 display:block(격자 아님)', /\.shell\{display:block\}/.test(css));
t('⑥ 내비·패널은 기본 숨김', /\.shell-nav\{display:none\}/.test(css) && /\.shell-aside\{display:none\}/.test(css));
t('⑥ 격자는 1024px 이상에서만', /@media\(min-width:1024px\)\{[\s\S]{0,400}?\.shell\{display:grid/.test(css));
t('⑥ top 메뉴 숨김도 셸이 켜질 때만', /@media\(min-width:1024px\)\{[\s\S]{0,200}?body\.shell-page \.nav-links\{display:none\}/.test(css));
for (const f of shellPages) {
  const s = read(f);
  t(`⑥ 모바일 내비 유지: ${f}`, s.includes('mobile-nav') && s.includes('class="nav-links"'));
}

done('shell (앱 셸 — 좌측 내비가 가리키는 화면에는 좌측 내비가 있다)');
