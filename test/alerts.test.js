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
  store2.seed('sub/t9', { token: 't9', email: 'x@example.com', items: [item('A', '20260729' + '1700')] });
  delete process.env.RESEND_API_KEY;
  const daily = require(fnPath('alert-daily.js'));
  r = await daily.handler({ queryStringParameters: {} });
  b = JSON.parse(r.body);
  t('② 키 없으면 sent=0, pending>0', b.sent === 0 && b.pending > 0, r.body);
  t('② 키 없으면 발송 마커 미기록', store2.keys('alertsent/').length === 0, store2.keys('alertsent/').join(','));
  t('② 키 없음을 정직하게 안내', /RESEND_API_KEY 미설정/.test(b.note || ''), b.note);
  const hb = await store2.get('_run/alert-daily');
  t('하트비트 기록', hb && hb.ok === true);

  delete global.__FAKE_STORE__;
  done('alerts (마감 알림)');
})().catch(e => { console.log('THROW', e); process.exit(1); });
