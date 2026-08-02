// test/ladder.test.js — "몇 회차 더 기다리면 얼마까지 내려가나" (2026-08-01 창업자 방향 전환)
//
// 왜 이 질문으로 바꿨나:
//   우리가 답하던 "이번 회차에 얼마에 낙찰될까"는 부동산 개찰 이벤트의 **1.5%**에서만 일어난다
//   (실측 회차당 낙찰률: 자동차 66.8% · 동산 48.9% · 부동산 2.6%). 유찰이 기본값인 시장에서
//   나머지 98.5%의 사용자에게는 답이 없는 질문이었다.
//
// 지키는 것:
//   ① 이 표의 숫자는 **예측이 아니라 사실**이다 — 온비드가 회차별 최저가·마감일을 공표한다.
//      그러므로 봉인·채점 대상이 아니고, 화면도 그렇게 말해야 한다.
//   ② 지나간 회차는 선택지가 아니다(빼야 한다).
//   ③ 남은 회차가 하나뿐이면 "기다리면"이 성립하지 않는다(섹션을 열지 않는다).
//   ④ 투자 권유 어휘 금지.

'use strict';

const fs = require('fs');
const { t, eq, done, repoPath } = require('./_harness');

const html = fs.readFileSync(repoPath('bidcast-detail.html'), 'utf8');
const m = html.match(/\/\/ LADDER-START([\s\S]*?)\/\/ LADDER-END/);
t('사다리 엔진 블록 추출', !!m);

// DOM 없이 순수 계산부만 실행한다(렌더러는 document를 쓰므로 스텁을 준다).
const sandbox = { document: { getElementById: () => null } };
const fn = new Function('document', m[1] + '\nreturn { ladderRows, renderLadder };');
const { ladderRows } = fn(sandbox.document);

// ── 실제 온비드 응답 형태 (물건 2022-04172-001, cseqBidInfClgList 실측) ──
// 감정가 1.11억에서 회차마다 감정가의 10%씩 내려가는 사다리.
const APPR = 111000000;
const sched = [
  { pbctNsq: '033', lowstBidPrcIndctCont: '111000000', cltrBidEndDt: '202609161700' },
  { pbctNsq: '034', lowstBidPrcIndctCont: '99900000', cltrBidEndDt: '202609301700' },
  { pbctNsq: '035', lowstBidPrcIndctCont: '88800000', cltrBidEndDt: '202610071700' },
  { pbctNsq: '036', lowstBidPrcIndctCont: '77700000', cltrBidEndDt: '202610141700' },
  { pbctNsq: '037', lowstBidPrcIndctCont: '66600000', cltrBidEndDt: '202610211700' },
  { pbctNsq: '038', lowstBidPrcIndctCont: '55500000', cltrBidEndDt: '202610281700' },
  { pbctNsq: '039', lowstBidPrcIndctCont: '44400000', cltrBidEndDt: '202611041700' },
  { pbctNsq: '040', lowstBidPrcIndctCont: '33300000', cltrBidEndDt: '202611111700' },
  { pbctNsq: '041', lowstBidPrcIndctCont: '22200000', cltrBidEndDt: '202611181700' },
  { pbctNsq: '042', lowstBidPrcIndctCont: '11100000', cltrBidEndDt: '202611251700' },
];

// ── ① 남은 회차 판정은 **날짜**로 한다 ──
// ⚠️ 회차 번호로 과거와 조인하면 안 된다 — pbctNsq는 공고 안의 순번이라 공고가 바뀌면
//    재사용된다. 실물건 2022-04172-001의 과거 기록에는 017회차가 2023·2024년에 각각 있고,
//    사다리에 없는 044·045·048도 있으며 이미 낙찰된 회차(026·030·037)까지 섞여 있다.
//    번호로 조인했더니 040이 2024년 취소 기록에 걸려 빠지고 039·041만 남는 엉뚱한 사다리가
//    나왔다(실데이터 검증에서 발견). 마감일은 공고가 몇 번 바뀌었든 모호하지 않다.
const all = ladderRows(sched, null, '', APPR, '20260801');
eq('① 남은 회차 전부(오늘 이후)', all.length, 10);
eq('① 날짜 오름차순', all.map(r => r.nsq).join(','), '033,034,035,036,037,038,039,040,041,042');
eq('① "다음"은 가장 가까운 회차', all.filter(r => r.isCur).map(r => r.nsq).join(','), '033');
eq('① 감정가 대비 % — 첫 회차 100%', all[0].apprPct, 100);
eq('① 감정가 대비 % — 마지막 10%', all[9].apprPct, 10);
// 기다림의 대가를 금액으로: 다음(1.11억) 대비 마지막(1,110만)은 9,990만 낮다.
eq('① 다음 회차 대비 하락액', all[9].dropWon, 99900000);
eq('① 다음 회차 대비 하락률', all[9].dropPct, 90);
eq('① 다음 회차는 하락 0', all[0].dropWon, 0);

// ── ② 지나간 회차는 선택지가 아니다 (날짜로 판정) ──
const mid = ladderRows(sched, null, '', APPR, '20261022'); // 037(10.21)까지 지남
eq('② 지난 회차 제외', mid.map(r => r.nsq).join(','), '038,039,040,041,042');
eq('② 기준은 "다음"(038)', mid[0].dropWon, 0);
eq('② 끝까지 기다리면 4,440만 더 싸짐', mid[4].dropWon, 55500000 - 11100000);
eq('② 마지막 하나 남으면 1건', ladderRows(sched, null, '', APPR, '20261119').length, 1);
eq('② 다 지나면 0건', ladderRows(sched, null, '', APPR, '20261201').length, 0);

// 번호로 조인하던 옛 동작의 회귀 방지 — 과거 기록을 줘도 결과가 달라지지 않아야 한다.
const bogusPast = { '040': { pbctStatNm: '취소' }, '033': { pbctStatNm: '유찰' }, '037': { pbctStatNm: '낙찰' } };
eq('② 다른 공고의 과거 기록에 흔들리지 않음',
  ladderRows(sched, bogusPast, '042', APPR, '20260801').map(r => r.nsq).join(','), all.map(r => r.nsq).join(','));

// ── ③ 방어 ──
eq('③ 가격 없는 행 제외', ladderRows([{ pbctNsq: '001', lowstBidPrcIndctCont: '0', cltrBidEndDt: '202609161700' }], null, '', APPR, '20260801').length, 0);
eq('③ 빈 입력 안전', ladderRows(null, null, '', 0, '20260801').length, 0);
// placeholder 날짜(2999…)는 "언제까지 기다리면"에 답할 수 없으므로 제외한다.
eq('③ 일정 미정(2999) 제외',
  ladderRows([{ pbctNsq: '050', lowstBidPrcIndctCont: '5000000', cltrBidEndDt: '299912301700' }], null, '', APPR, '20260801').length, 0);
t('③ 감정가 0이면 % 생략', ladderRows(sched, null, '', 0, '20260801')[0].apprPct === null);

// ── ④ 화면 문구: 사실과 판단을 섞지 않는다 · 권유 어휘 금지 ──
const sec = html.match(/<section[^>]*id="sec-ladder"[\s\S]*?<\/section>/);
t('④ 섹션 존재', !!sec);
t('④ 라벨이 "온비드 공고 일정"', /온비드 공고 일정/.test(sec[0]));
t('④ 봉인 라벨을 달지 않는다', !/봉인/.test(sec[0]));
const render = m[1];
t('④ 공표된 사실임을 명시', /온비드가 미리 공표|공표한 일정|공표된 사실/.test(render));
t('④ 채점 대상이 아님을 명시', /봉인·채점 대상이 아닙니다/.test(render));
t('④ 중간 낙찰 시 사라짐을 경고', /그 전에 낙찰되면/.test(render));
t('④ 입찰 권유 아님 명시', /입찰 권유가 아닙니다/.test(render));
// 화면에 나가는 문자열에 투자 권유 어휘가 없어야 한다(주석은 제외).
const shown = render.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
const banned = /(추천합니다|사세요|매수하세요|유망|수익이 (기대|보장)|좋은 물건|반드시 (사|입찰))/;
t('④ 권유 어휘 없음', !banned.test(shown), (shown.match(banned) || [])[0]);

// ── ⑤ 배선 ──
t('⑤ 회차 데이터 도착 시 렌더 호출', /renderLadder\(sched,\s*apprWonLive\)/.test(html));
t('⑤ 과거 기록을 렌더에 넘기지 않는다(번호 조인 금지)', !/renderLadder\([^)]*pastMap/.test(html));
t('⑤ 추가 API 호출 없음(기존 응답 재사용)', !/renderLadder[\s\S]{0,400}fetch\(/.test(html));

done('가격 사다리 (몇 회차 더 기다리면 얼마까지 · 예측 아닌 사실)');
