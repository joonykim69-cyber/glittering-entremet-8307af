// test/global-search.test.js — 앱 셸 상단 검색 + 검색 결과 소스 커버리지.
//
// 지키려는 것:
//   ① **부분 적용 금지** — 셸이 있는 화면에는 상단 검색이 다 있어야 한다. 화면마다
//      있다가 없다가 하면 미적용보다 나쁘다(Phase 2c에서 좌측 내비로 이미 겪은 실패).
//   ② **화면에서 "통합검색"이라 말하지 않는다** — 지금 훑는 곳은 온비드 하나뿐이라
//      이름이 앞서면 과장이 된다. 다중 소스는 우리 설계 어휘지 사용자 어휘가 아니다.
//   ③ **0건이 "어디에도 없다"로 읽히지 않게** 한다 — 안 훑은 시장을 밝힌다(GR12).
//   ④ **커버리지 문구는 소스 축에서 파생된다** — 시장을 추가하면 문구도 함께 바뀐다
//      (축만 고치고 문구를 잊는 경로를 구조적으로 없앤다).
//   ⑤ **소스에 색을 쓰지 않는다**(§3 색 규율 — 색은 판단 신호에 예약).
//   ⑥ 검색어를 들고 들어오면 **서버 질의에 실어 보낸다** — 안 그러면 첫 200건 조각에
//      없는 물건이 전부 "0건"이 된다(희소 유형에서 겪은 문제와 같은 뿌리).

'use strict';

const fs = require('fs');
const { t, eq, done, repoPath } = require('./_harness');

const PAGES = fs.readdirSync(repoPath('.')).filter(f => /^bidcast.*\.html$/.test(f)).sort();
const SRC = Object.fromEntries(PAGES.map(f => [f, fs.readFileSync(repoPath(f), 'utf8')]));
const CSS = fs.readFileSync(repoPath('bidcast.css'), 'utf8');
const LIST = SRC['bidcast-list.html'];

const shellPages = PAGES.filter(f => /<body class="shell-page"/.test(SRC[f]));
const gsPages = PAGES.filter(f => SRC[f].includes('공용 상단 검색'));

// ── ① 셸 적용 집합 == 상단 검색 적용 집합 ──────────────────────────────
t('셸 페이지가 12개', shellPages.length === 12, shellPages.length);
eq('셸 있는 화면 = 상단 검색 있는 화면', gsPages, shellPages);
for (const f of PAGES.filter(p => !shellPages.includes(p))) {
  t(`셸 밖(${f})에는 상단 검색 없음`, !SRC[f].includes('공용 상단 검색'));
}

// ── 블록이 12벌 **완전히 동일**한지 (복제본이 갈라지면 화면마다 다르게 동작한다) ──
function block(s) {
  const i = s.indexOf('<!-- 공용 상단 검색');
  const j = s.indexOf('</script>', i);
  return i < 0 ? null : s.slice(i, j + 9);
}
const blocks = shellPages.map(f => block(SRC[f]));
t('12페이지 블록이 모두 동일', new Set(blocks).size === 1, new Set(blocks).size);

const B = blocks[0] || '';
t('중복 실행 가드', /window\.__bcGS/.test(B));
t('셸 페이지에서만 동작', /classList\.contains\('shell-page'\)/.test(B));
t('nav 안에 삽입', /querySelector\('nav \.wrap'\)/.test(B));
t('nav-right 앞에 삽입', /insertBefore\(form, right\)/.test(B));
t('결과는 물건검색으로', /form\.action = 'bidcast-list\.html'/.test(B));
t('쿼리 키는 q', /input\.name = 'q'/.test(B));
t('접근성 라벨', /aria-label', '물건 검색'/.test(B) && /aria-label', '검색'/.test(B));

// ── ② 화면 문구에 "통합검색"이 없다 (주석·설계 어휘는 허용, 렌더 문자열은 금지) ──
// 사용자가 보는 문자열만 검사한다: placeholder / textContent / 화면 텍스트.
t('placeholder가 하는 일만 말한다',
  /placeholder = '물건명 · 지역 · 물건관리번호 검색'/.test(B));
const rendered = (B.match(/placeholder = '[^']*'|textContent = '[^']*'/g) || []).join(' ');
t('렌더 문자열에 "통합검색" 없음', !/통합\s*검색/.test(rendered), rendered);

// ── ③④ 소스 커버리지 ──────────────────────────────────────────────────
t('결과 커버리지 요소 존재', /id="srcCover"/.test(LIST));
t('기본은 숨김(빈 줄 안 남김)', /<div class="src-cover" id="srcCover" hidden>/.test(LIST));
t('renderList가 커버리지를 갱신', /renderSrcCover\(total\);/.test(LIST));

// 판정 함수를 **소스에서 추출해 실제로 실행**한다(주석이 아니라 동작을 고정).
function grabFn(src, name) {
  const i = src.indexOf(`function ${name}(`);
  const end = src.indexOf('\n}', i);
  return i < 0 || end < 0 ? null : src.slice(i, end + 2);
}
const axisFn = grabFn(LIST, 'srcAxisNames');
const coverFn = grabFn(LIST, 'renderSrcCover');
t('srcAxisNames 존재', !!axisFn);
t('renderSrcCover 존재', !!coverFn);

// 소스 축 마크업은 실제 페이지에서 뽑아 쓴다(테스트가 자기 마크업을 지어내지 않게).
const axisHtml = (LIST.match(/<div class="src-axis"[\s\S]*?<\/div>/) || [])[0] || '';
t('소스 축 마크업 추출', axisHtml.includes('src-tab'), axisHtml.slice(0, 60));

function runCover({ term, total, axis = axisHtml }) {
  const el = { hidden: false, innerHTML: '' };
  const dom = makeDom(axis, el);
  const fn = new Function('document', 'qTerm', 'rEsc', 'el0', `
    ${axisFn}
    ${coverFn}
    document.getElementById = () => el0;
    renderSrcCover(${total});
    return el0;
  `);
  return fn(dom, term, s => String(s), el);
}

// 최소 DOM 대역 — querySelectorAll('.src-axis .src-tab')와 cloneNode/remove만 흉내낸다.
// ⚠️ remove()가 **실제로 지우게** 만든다. 텍스트 게터가 알아서 span을 걷어내면, 코드가
//    remove() 호출을 잊어도 테스트가 통과해 버린다("목킹을 내 가정대로 만들지 말 것").
function makeDom(axisMarkup, el) {
  const tabs = [...axisMarkup.matchAll(/<button[^>]*class="src-tab[^"]*"[^>]*>([\s\S]*?)<\/button>/g)]
    .map(m => {
      const attrs = m[0].slice(0, m[0].indexOf('>'));
      const disabled = /aria-disabled="true"/.test(attrs);
      const inner = m[1];
      return {
        getAttribute: k => (k === 'aria-disabled' ? (disabled ? 'true' : null) : null),
        cloneNode() {
          const node = {
            html: inner,
            querySelectorAll(sel) {
              if (sel !== '.src-soon') return [];
              const found = [...node.html.matchAll(/<span class="src-soon">[\s\S]*?<\/span>/g)].map(x => x[0]);
              return found.map(frag => ({ remove() { node.html = node.html.replace(frag, ''); } }));
            },
            get textContent() { return node.html.replace(/<[^>]*>/g, '').trim(); },
          };
          return node;
        },
      };
    });
  return { querySelectorAll: () => tabs, getElementById: () => el };
}

let r = runCover({ term: '', total: 0 });
t('검색어 없으면 커버리지를 말하지 않는다', r.hidden === true && r.innerHTML === '');

r = runCover({ term: '은마', total: 0 });
t('0건에도 커버리지가 뜬다', r.hidden === false && r.innerHTML.length > 0);
t('0건 표기', /0건/.test(r.innerHTML), r.innerHTML);
t('훑은 시장을 밝힌다', /공매\(온비드\)/.test(r.innerHTML));
t('법원경매를 안 훑았다고 말한다', /법원경매/.test(r.innerHTML));
t('신탁공매를 안 훑았다고 말한다', /신탁공매/.test(r.innerHTML));
t('"준비 중" 꼬리표는 문구에 섞이지 않는다', !/준비 중/.test(r.innerHTML), r.innerHTML);
t('한국어 조사 처리(신탁공매는)', /신탁공매는/.test(r.innerHTML), r.innerHTML);

r = runCover({ term: '아파트', total: 1234 });
t('건수 천단위 구분', /1,234건/.test(r.innerHTML), r.innerHTML);

// ④ 축이 바뀌면 문구도 바뀐다 — 시장 하나를 활성으로 바꿔 넣고 확인.
const axis2 = axisHtml.replace(/aria-disabled="true"\s*\n?\s*onclick="srcSoon\('법원경매'\)"/, '');
r = runCover({ term: '아파트', total: 3, axis: axis2 });
t('활성 시장이 늘면 함께 훑은 것으로 표기', /법원경매/.test(r.innerHTML.split('<small>')[0]), r.innerHTML);
t('그 시장은 미검색 목록에서 빠진다', !/법원경매/.test((r.innerHTML.split('<small>')[1] || '')), r.innerHTML);

// 활성 하나만 남기고 준비 중이 없으면 미검색 문구 자체가 없다(없는 말을 하지 않는다).
const axisOnlyOne = '<div class="src-axis"><button class="src-tab on">🏛 공매(온비드)</button></div>';
r = runCover({ term: 'x', total: 5, axis: axisOnlyOne });
t('준비 중 시장이 없으면 미검색 문구도 없다', !/<small>/.test(r.innerHTML), r.innerHTML);

// ── ⑤ 색 규율 — 상단 검색·커버리지에 소스별 색이 없다 ────────────────────
const gsCss = (CSS.match(/\.gsearch[\s\S]*?(?=\n\/\* ──)/) || [''])[0];
const coverCss = (CSS.match(/\.src-cover[\s\S]*$/) || [''])[0];
for (const [label, css] of [['상단 검색', gsCss], ['커버리지', coverCss]]) {
  t(`${label}에 신호등 색 없음`,
    !/--green|--yellow|--red|#00A86B|#E5484D|#F5A623/.test(css), css.slice(0, 120));
}
t('상단 검색은 셸 폭에서만 보인다', /@media \(min-width:1024px\)\{\s*\n?\s*body\.shell-page \.gsearch/.test(CSS));
t('셸 밖 폭에서는 숨김', /^\.gsearch\{display:none\}/m.test(CSS));

// ── ⑥ 검색어를 서버 질의에 싣는다 ────────────────────────────────────────
t('첫 로드가 검색어를 서버로 보낸다',
  /loadRealItems\(qTerm \? \{ keyword: qTerm \} : \{\}\)/.test(LIST));
t('물건검색에서는 새로고침 대신 그 자리 검색', /window\.__gsearchLocal = function/.test(LIST));
t('그 자리 검색이 기존 경로를 탄다', /__gsearchLocal[\s\S]{0,220}doSearch\(\)/.test(LIST));
t('상단 검색이 그 훅을 쓴다', /typeof window\.__gsearchLocal === 'function'/.test(B));
t('빈 검색으로 페이지를 갈아 끼우지 않는다', /if \(!v\) e\.preventDefault\(\)/.test(B));

done('global-search');
