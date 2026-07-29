// test/sealed-surface.test.js — 화면에 뜨는 숫자 = 우리가 채점받는 숫자 (봉인 장부 연결)
//                                 + 봉인 창 확대의 대가를 정직하게 드러내기(leadDays).
//
// 왜 이 규율을 고정하나(2026-07-29 발견):
//   상세 페이지의 "AI 예상 낙찰가"가 봉인 장부를 안 쓰고 `최저가 × 1.02~1.13` 고정 계수를
//   썼는데, 바로 아래에 **"개찰 전 봉인 · 수정 없음"** 라벨이 붙어 있었다.
//   봉인된 적 없는 숫자에 봉인 라벨을 다는 것은 Golden Rule 1(봉인 불변)·6(근거 없는 수치
//   금지)을 정면으로 어긴다. 사용자가 가장 오래 머무는 화면이라 파급도 가장 크다.
//
// 지키는 것:
//   ① 상세가 봉인 장부(scoreboard?pred)를 실제로 조회한다
//   ② 봉인이 없으면 **수치를 지우고** "봉인 전"이라 밝힌다(추정값에 봉인 라벨 금지)
//   ③ 봉인 창을 넓혔으면 leadDays를 남기고 채점에서 분리 집계한다(먼 예측이 어려운 걸 숨기지 않음)

'use strict';

const fs = require('fs');
const { t, eq, done, makeStore, mockFetch, fnPath, repoPath } = require('./_harness');

const detail = fs.readFileSync(repoPath('bidcast-detail.html'), 'utf8');

// ── ① 상세가 봉인 장부를 조회하는가 ──
t('① scoreboard?pred 조회', /scoreboard\?pred=/.test(detail));
t('① loadSealedPred 존재', /async function loadSealedPred\(\)/.test(detail));
t('① 페이지 로드 시 실행', /window\.__aiReady\s*=\s*loadSealedPred\(\)/.test(detail));
t('① 봉인값으로 aiRange 교체', /aiRange'\)\.textContent=`\$\{fmt\(p\.lo\)\} ~ \$\{fmt\(p\.hi\)\}`/.test(detail));
t('① 봉인 근거(통계 출처·모델·시각) 표기', /statBucket/.test(detail) && /sealedAt/.test(detail) && /modelV/.test(detail));

// ── ② 봉인 없으면 정직하게 비운다 ──
t('② 미봉인 시 수치 대신 "봉인 전"', /aiRange'\)\.textContent='봉인 전'/.test(detail));
t('② 미봉인 시 참고입찰가·신뢰도도 비움', /aiRec'\)\.textContent='—'/.test(detail) && /aiConf'\)\.textContent='—'/.test(detail));
t('② 미봉인 사유를 밝힘', /추정값을 봉인인 것처럼 보여주지 않기 위해 비워 둡니다/.test(detail));
t('② 미봉인 시 __ai를 0으로(마진 위젯 등 하위 소비자 차단)', /window\.__ai\.lo=0;/.test(detail));
t('② 데모 물건은 "참고 추정치"로 라벨 강등', /참고 추정치 — 봉인 예측 아님/.test(detail));

// 경합 방지 — __ai를 읽는 소비자가 봉인 조회 완료를 기다리는가
t('② 시세 밴드가 __aiReady를 기다림', /await \(window\.__aiReady\|\|Promise\.resolve\(\)\)/.test(detail));

// 스코프 사고 방지 — 뒤쪽 함수의 esc를 끌어 쓰지 않는다(ReferenceError)
t('② 자체 이스케이프 사용(escS)', /const escS=v=>String/.test(detail));
t('② 봉인 근거에 원시 esc 미사용', !/escS\(when\)[\s\S]{0,200}[^S]esc\(p\./.test(detail));

// ── ③ 봉인 창 확대 + leadDays ──
const pd = fs.readFileSync(repoPath('netlify/functions/predict-daily.js'), 'utf8');
t('③ 창이 env로 조절되고 기본 14일', /SEAL_WINDOW_DAYS \|\| '14'/.test(pd));
t('③ leadDays 계산 함수', /function leadDaysOf\(bidEnd\)/.test(pd));
t('③ 봉인 레코드에 leadDays 저장', /leadDays: leadDaysOf\(it\.bidEnd\)/.test(pd));
t('③ 표본이 늘지 않는다는 사실을 주석에 남김', /표본은 늘지 않는다/.test(pd));

const sd = fs.readFileSync(repoPath('netlify/functions/score-daily.js'), 'utf8');
t('③ 채점이 leadDays로 분리 집계', /agg\.byLead/.test(sd));
const sb = fs.readFileSync(repoPath('netlify/functions/scoreboard.js'), 'utf8');
t('③ scoreboard가 byLead 노출', /byLead: Object\.fromEntries/.test(sb));

// leadDaysOf 실제 동작 — predict-daily를 로드해 확인
(async () => {
  const store = makeStore();
  global.__FAKE_STORE__ = store;
  process.env.URL = 'https://example.test';
  process.env.SEAL_WINDOW_DAYS = '14';

  // 오늘(KST) 기준으로 D+0 / D+7 / D+20 물건을 만든다
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const ymd = d => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const plus = n => ymd(new Date(kst.getTime() + n * 86400000));
  const mk = (id, days) => ({ id, pbctCdtnNo: '1', title: `물건${id}`, appr: 10000, min: 7000,
    usage: '아파트', type: '아파트', bidEnd: plus(days) + '1700', failCount: 0, round: 1 });

  mockFetch([
    [/onbid-search/, { items: [mk('A', 0), mk('B', 7), mk('C', 20)] }],
    [/onbid-mvast-search/, { items: [] }],
    [/onbid-vhcl-search/, { items: [] }],
    [/onbid-svc\?svc=stat_usg/, { items: [{ clsCdNm: '아파트', scfbAmtRto1: 80, scfbAmtRto2: 95 }] }],
    [/hist-stats/, { status: 'empty' }],
  ]);

  const mod = require(fnPath('predict-daily.js'));
  await mod.handler({ queryStringParameters: {} });

  const a = await store.get('pred/A_1'), b = await store.get('pred/B_1'), c = await store.get('pred/C_1');
  t('③ 창 안(D+0) 봉인', !!a, 'D+0 미봉인');
  t('③ 창 안(D+7) 봉인 — 확대 전이면 빠졌을 물건', !!b, 'D+7 미봉인');
  eq('③ 창 밖(D+20)은 봉인 안 함', c, null);
  eq('③ leadDays D+0 = 0', a && a.leadDays, 0);
  eq('③ leadDays D+7 = 7', b && b.leadDays, 7);

  // 창을 좁히면 D+7이 빠진다(창 설정이 실제로 먹는지)
  delete require.cache[require.resolve(fnPath('predict-daily.js'))];
  process.env.SEAL_WINDOW_DAYS = '2';
  const store2 = makeStore();
  global.__FAKE_STORE__ = store2;
  mockFetch([
    [/onbid-search/, { items: [mk('A', 0), mk('B', 7)] }],
    [/onbid-mvast-search/, { items: [] }],
    [/onbid-vhcl-search/, { items: [] }],
    [/onbid-svc\?svc=stat_usg/, { items: [{ clsCdNm: '아파트', scfbAmtRto1: 80, scfbAmtRto2: 95 }] }],
    [/hist-stats/, { status: 'empty' }],
  ]);
  const mod2 = require(fnPath('predict-daily.js'));
  await mod2.handler({ queryStringParameters: {} });
  t('③ 창 2일이면 D+7 제외(설정이 실제로 작동)', (await store2.get('pred/B_1')) === null);
  t('③ 창 2일에서도 D+0은 봉인', !!(await store2.get('pred/A_1')));

  delete global.__FAKE_STORE__;
  done('sealed-surface (봉인 장부 연결 · 예측 시점 분리)');
})().catch(e => { console.log('THROW', e); process.exit(1); });
