// test/alerts.test.js — 관심물건 마감 알림(lib/alerts.js + subscribe.js + alert-daily.js).
//
// 지키려는 것:
//   ① 같은 물건·같은 단계는 **두 번 보내지 않는다**(중복 발송 = 신뢰 훼손)
//   ② 키가 없으면 **보낸 척하지 않는다**(마커도 안 남겨 키 설정 즉시 정상 발송)
//   ③ 수신거부하면 이메일을 **즉시 지운다**
//   ④ 클라이언트가 보낸 여분 필드는 저장하지 않는다(개인정보 최소화)

'use strict';

const { t, eq, done, makeStore, fnPath } = require('./_harness');
const alerts = require(fnPath('lib/alerts.js'));

const NOW = new Date('2026-07-29T00:00:00Z'); // KST 2026-07-29 09:00
const item = (id, bidEnd) => ({ id, cdtn: '01', title: `물건${id}`, bidEnd, min: 1e8, type: '아파트' });

// ── 단계 판정 ──
eq('오늘 마감 = d0', alerts.stageFor('202607291700', NOW), 'd0');
eq('내일 마감 = d1', alerts.stageFor('202607301700', NOW), 'd1');
eq('3일 뒤 마감 = d3', alerts.stageFor('202608011700', NOW), 'd3');
eq('2일 뒤는 단계 아님', alerts.stageFor('202607311700', NOW), null);
eq('먼 물건은 제외', alerts.stageFor('202609011700', NOW), null);
eq('마감 지난 물건은 제외', alerts.stageFor('202607281700', NOW), null);
eq('마감일 불명은 제외', alerts.stageFor('', NOW), null);

(async () => {
  const sent = new Set();
  const isSent = async k => sent.has(k);
  const subs = [
    { token: 'tok1', email: 'a@example.com', items: [item('A', '202607291700'), item('B', '202607301700'), item('Z', '202612011700')] },
    { token: 'tok2', email: 'b@example.com', items: [item('C', '202608011700')] },
    { token: 'tok3', email: 'c@example.com', items: [item('A', '202607291700')], unsubscribedAt: '2026-07-01T00:00:00Z' },
  ];

  let plans = await alerts.planSends(subs, { now: NOW, isSent });
  eq('구독 2건에 발송 계획', plans.length, 2);
  const p1 = plans.find(p => p.token === 'tok1');
  eq('먼 물건(Z)은 계획에서 제외', p1.items.length, 2);
  t('수신거부자는 계획 없음', !plans.some(p => p.token === 'tok3'));

  // ① 멱등 — 이미 보낸 단계는 다시 계획되지 않는다
  for (const p of plans) for (const it of p.items) sent.add(it.sentKey);
  plans = await alerts.planSends(subs, { now: NOW, isSent });
  eq('재실행 시 재발송 0', plans.length, 0);

  // 단계가 바뀌면(d3 → d1) 새로 보낸다
  const later = new Date('2026-07-31T00:00:00Z'); // C가 d1이 되는 날
  plans = await alerts.planSends(subs, { now: later, isSent });
  const p2 = plans.find(p => p.token === 'tok2');
  t('새 단계는 다시 발송', !!p2 && p2.items[0].stage === 'd1', JSON.stringify(plans));

  // ── 메일 본문 ──
  const mail = alerts.renderEmail(
    { email: 'a@example.com', token: 'tok1', items: [{ ...item('A', '202607291700'), title: '<script>x</script>물건', stage: 'd0', dday: 0 }] },
    { siteUrl: 'https://s.test', unsubUrl: 'https://s.test/unsub?token=tok1' });
  t('사용자 데이터 이스케이프', !/<script>/.test(mail.html), mail.html.slice(0, 200));
  t('수신거부 링크 필수', mail.html.includes('https://s.test/unsub?token=tok1'));
  t('보장 표현 아님을 명시', /보장/.test(mail.html + mail.text));

  // ══ subscribe.js CRUD ══
  const store = makeStore();
  global.__FAKE_STORE__ = store;
  const sub = require(fnPath('subscribe.js'));
  const post = b => sub.handler({ httpMethod: 'POST', body: JSON.stringify(b), queryStringParameters: {} });
  const get = qs => sub.handler({ httpMethod: 'GET', queryStringParameters: qs });

  let r = await post({ email: 'nope', items: [] });
  eq('잘못된 이메일 거부', r.statusCode, 400);

  r = await post({ email: 'Me@Example.COM', items: [{ ...item('A', '202607291700'), password: 'x', ip: '1.2.3.4' }] });
  let b = JSON.parse(r.body);
  t('구독 생성', b.status === 'ok' && !!b.token, r.body);
  const token = b.token;
  t('응답의 이메일은 마스킹', /\*/.test(b.email), b.email);

  const stored = await store.get(`sub/${token}`);
  const keys = Object.keys(stored.items[0]).sort();
  eq('④ 필요한 필드만 저장', keys, ['bidEnd', 'cdtn', 'id', 'min', 'title', 'type']);
  t('이메일 조회 키는 해시', store.keys('subidx/').every(k => !k.includes('@')), store.keys('subidx/').join(','));

  r = await post({ token, items: [item('A', '202607291700'), item('B', '202607301700')] });
  eq('토큰으로 동기화(이메일 재입력 없이)', JSON.parse(r.body).count, 2);

  r = await get({ token });
  b = JSON.parse(r.body);
  t('조회 시 이메일 마스킹', b.status === 'ok' && /\*/.test(b.email), r.body);

  r = await get({ token, unsubscribe: '1' });
  eq('수신거부 200', r.statusCode, 200);
  const after = await store.get(`sub/${token}`);
  t('③ 수신거부 시 이메일 삭제', !after.email && !!after.unsubscribedAt, JSON.stringify(after));

  // ══ alert-daily: 키 없으면 pending, 마커 미기록 ══
  const store2 = makeStore();
  global.__FAKE_STORE__ = store2;
  // ⚠️ alert-daily는 고정 NOW가 아니라 **실제 시계**로 단계를 판정한다. 고정 날짜를 심으면
  //    그 날이 지나는 순간 물건이 "마감 지남"으로 걸러져 plans=0이 되고, 이 단언은 조용히
  //    무의미해진다(실제로 2026-07-30에 터졌다). 그래서 오늘(KST) 마감으로 계산해 심는다.
  const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
  const todayKst = `${kstNow.getUTCFullYear()}${String(kstNow.getUTCMonth() + 1).padStart(2, '0')}${String(kstNow.getUTCDate()).padStart(2, '0')}`;
  store2.seed('sub/t9', { token: 't9', email: 'x@example.com', items: [item('A', todayKst + '2359')] });
  delete process.env.RESEND_API_KEY;
  const daily = require(fnPath('alert-daily.js'));
  r = await daily.handler({ queryStringParameters: {} });
  b = JSON.parse(r.body);
  t('② 키 없으면 sent=0, pending>0', b.sent === 0 && b.pending > 0, r.body);
  t('② 키 없으면 발송 마커 미기록', store2.keys('alertsent/').length === 0, store2.keys('alertsent/').join(','));
  t('② 키 없음을 정직하게 안내', /RESEND_API_KEY 미설정/.test(b.note || ''), b.note);
  const hb = await store2.get('_run/alert-daily');
  t('하트비트 기록', hb && hb.ok === true);

  // ══ 한 통의 메일이 덮은 물건은 한 번에 표시한다 ══
  // 이전엔 물건마다 순차 await로 마커를 썼다. 구독당 50건 × 발송 상한 200건 = 최악
  // 1만 번의 순차 Blob 왕복이라 실행시간 한도를 넘고, 중간에 죽으면 **메일은 갔는데
  // 마커는 일부만** 남아 다음 실행이 "나머지 물건만" 담은 두 번째 메일을 보낸다.
  {
    const store3 = makeStore();
    global.__FAKE_STORE__ = store3;
    process.env.RESEND_API_KEY = 'test-key';
    const kn = new Date(Date.now() + 9 * 3600 * 1000);
    const today3 = `${kn.getUTCFullYear()}${String(kn.getUTCMonth() + 1).padStart(2, '0')}${String(kn.getUTCDate()).padStart(2, '0')}`;
    const many = Array.from({ length: 12 }, (_, i) => item('M' + i, today3 + '2359'));
    store3.seed('sub/tm', { token: 'tm', email: 'many@example.com', items: many });

    let calls = 0;
    global.fetch = async () => { calls++; return { ok: true, status: 200, json: async () => ({ id: 'x' }), text: async () => '{}' }; };
    delete require.cache[require.resolve(fnPath('alert-daily.js'))];
    const rm = await require(fnPath('alert-daily.js')).handler({ queryStringParameters: {} });
    const bm = JSON.parse(rm.body);

    eq('12건이 메일 한 통으로 나간다', calls, 1);
    eq('12건 전부 발송 처리', bm.sent, 12);
    eq('마커도 12건 전부 기록', store3.keys('alertsent/').length, 12);

    // 재실행 — 같은 물건·같은 단계는 다시 보내지 않는다(부분 중복도 없어야 한다)
    calls = 0;
    delete require.cache[require.resolve(fnPath('alert-daily.js'))];
    const rm2 = await require(fnPath('alert-daily.js')).handler({ queryStringParameters: {} });
    eq('재실행 시 추가 발송 0', calls, 0);
    eq('재실행 시 sent 0', JSON.parse(rm2.body).sent, 0);
    delete process.env.RESEND_API_KEY;
  }

  // ── 관측 가능성 (2026-07-31) ──
  // alert-daily는 예약 함수라 HTTP로 찔러볼 수 없다(403). 그래서 "키가 들어갔는지"도
  // "실제로 보내졌는지"도 볼 방법이 없었다 — 발송 기능이 통째로 블랙박스였다.
  // 자가진단(integrations-status)과 성적표(scoreboard)가 그 둘을 각각 드러내야 한다.
  {
    const isPath = fnPath('integrations-status.js');
    const load = async () => {
      delete require.cache[require.resolve(isPath)];
      const r = await require(isPath).handler({ httpMethod: 'GET' });
      const d = JSON.parse(r.body);
      return d.integrations.find(i => i.key === 'resend');
    };

    delete process.env.RESEND_API_KEY; delete process.env.ALERT_FROM;
    let re = await load();
    t('자가진단이 resend를 추적한다', !!re);
    eq('키 없으면 미설정으로 보고', re.configured, false);
    t('키 없을 때 "보낸 척 안 함"을 설명', /보낸 척하지 않고|pending/.test(re.note), re.note);

    // 키만 있는 상태 — 발송은 되지만 계정 소유자에게만 배달된다.
    // **보내고 있다고 착각하기 가장 쉬운 상태**라 configured=true이면서도 구분이 드러나야 한다.
    process.env.RESEND_API_KEY = 'rs_test';
    re = await load();
    eq('키만 있으면 발송은 활성', re.configured, true);
    eq('배달 범위 = 계정 소유자만', re.deliversTo, 'account_owner_only');
    eq('발신 도메인 미인증', re.senderVerified, false);
    t('그 위험을 말로 설명한다', /계정 소유자에게만/.test(re.note), re.note);

    process.env.ALERT_FROM = '신호등옥션 <alert@example.com>';
    re = await load();
    eq('ALERT_FROM 설정 시 전원 발송', re.deliversTo, 'all');
    eq('발신 도메인 인증됨', re.senderVerified, true);
    delete process.env.RESEND_API_KEY; delete process.env.ALERT_FROM;

    // scoreboard가 알림 하트비트를 노출하는가 — 없으면 발송 실패를 영영 모른다.
    const store = global.__FAKE_STORE__;
    await store.setJSON('_run/alert-daily', { at: '2026-07-31T23:00:00.000Z', ok: true, sent: 2, failed: 0, pending: 0, subs: 1 });
    const sbPath = fnPath('scoreboard.js');
    delete require.cache[require.resolve(sbPath)];
    const sb = JSON.parse((await require(sbPath).handler({ httpMethod: 'GET', queryStringParameters: {} })).body);
    t('scoreboard.runs.alert 노출', sb.runs && sb.runs.alert != null);
    eq('발송 건수가 보인다', sb.runs.alert.sent, 2);
    eq('구독자 수가 보인다', sb.runs.alert.subs, 1);
  }

  delete global.__FAKE_STORE__;
  done('alerts (마감 알림 · 관측 가능성)');
})().catch(e => { console.log('THROW', e); process.exit(1); });
