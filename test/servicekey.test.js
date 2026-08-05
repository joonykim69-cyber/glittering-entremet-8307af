// test/servicekey.test.js — data.go.kr 인증키 정규화.
// 지키려는 것: 포털이 보여 주는 **두 형태(Encoding·Decoding) 어느 쪽을 넣어도**
//   상위에 도달하는 문자열이 동일해야 한다. 그리고 키를 읽는 프록시가 **하나도 빠짐없이**
//   이 정규화를 거쳐야 한다 — 한 곳만 빠져도 그 서비스만 조용히 죽는다(2026-08-05 실장애).

'use strict';

const fs = require('fs');
const path = require('path');
const { t, eq, done, fnPath, mockFetch } = require('./_harness');
const { normalizeServiceKey } = require(fnPath('lib/servicekey.js'));

// 실제 포털 표기를 그대로 본뜬 표본(값 자체는 가짜).
// Decoding: base64 문자셋 그대로 / Encoding: + / = 를 %2B %2F %3D 로.
const DEC = 'KdxWKYhU9v/r/ckTvbM3+xk1YcOJHNbg5fa6xOZUNufoU=';
const ENC = 'KdxWKYhU9v%2Fr%2FckTvbM3%2Bxk1YcOJHNbg5fa6xOZUNufoU%3D';

// ── ① 두 형태가 같은 값으로 수렴한다 ──
eq('Decoding 형태는 그대로', normalizeServiceKey(DEC), DEC);
eq('Encoding 형태는 디코딩된다', normalizeServiceKey(ENC), DEC);
t('두 입력이 같은 결과', normalizeServiceKey(ENC) === normalizeServiceKey(DEC));

// ── ② 라운드트립 — 상위가 실제로 받는 문자열 ──
// 프록시는 전부 URLSearchParams로 쿼리를 만든다(자동 인코딩). 정규화 후 그 인코딩을 거치면
// 포털이 보여 주는 Encoding 값과 **정확히 일치**해야 한다. 이게 이 모듈의 존재 이유다.
const sent = k => new URLSearchParams({ serviceKey: normalizeServiceKey(k) }).toString();
eq('Decoding 입력 → 상위 수신 문자열', sent(DEC), 'serviceKey=' + ENC);
eq('Encoding 입력 → 상위 수신 문자열', sent(ENC), 'serviceKey=' + ENC);
t('정규화 없으면 이중 인코딩(회귀 증명)',
  new URLSearchParams({ serviceKey: ENC }).toString().includes('%252F'));

// ── ③ 복붙 사고 ──
eq('앞뒤 공백 제거', normalizeServiceKey('  ' + DEC + '  '), DEC);
eq('줄바꿈 제거', normalizeServiceKey(DEC + '\n'), DEC);
eq('이중 인코딩도 복구', normalizeServiceKey(ENC.replace(/%/g, '%25')), DEC);

// ── ④ 건드리면 안 되는 값 ──
const HEX = 'd5fcd53739b5a1c0f2e7b8d401a0053791efc819bb9379e51068ae27ba653eb';
eq('hex 형태 키(% 없음)는 불변', normalizeServiceKey(HEX), HEX);
eq('깨진 %XX는 예외 없이 원문 유지', normalizeServiceKey('abc%ZZdef'), 'abc%ZZdef');
eq('불완전한 % 시퀀스도 원문 유지', normalizeServiceKey('abc%2'), 'abc%2');
t('null 안전', normalizeServiceKey(null) === null);
t('undefined 안전', normalizeServiceKey(undefined) === undefined);
eq('빈 문자열', normalizeServiceKey(''), '');

// ── ⑤ 디코딩 상한 (무한 루프 방지) ──
let deep = DEC;
for (let i = 0; i < 6; i++) deep = encodeURIComponent(deep);
t('6중 인코딩은 완전히 못 풀어도 예외 없이 반환', typeof normalizeServiceKey(deep) === 'string');

// ── ⑥ 구조 규율 — 키를 읽는 곳은 전부 정규화를 거친다 ──
// 새 프록시를 만들면서 빠뜨리면 여기서 걸린다. 파일 목록을 고정하지 않고 **소스를 훑어**
// 판정하므로, 나중에 추가되는 함수도 자동으로 검사 대상이 된다.
const FN_DIR = path.dirname(fnPath('lib/servicekey.js')).replace(/[\\/]lib$/, '');
const readers = fs.readdirSync(FN_DIR)
  .filter(f => f.endsWith('.js'))
  .map(f => ({ f, src: fs.readFileSync(path.join(FN_DIR, f), 'utf8') }))
  .filter(x => /process\.env\.(ONBID|RTMS)_SERVICE_KEY/.test(x.src));

t('키를 읽는 함수가 10개 이상 발견됨', readers.length >= 10, readers.length);

for (const { f, src } of readers) {
  // integrations-status는 '설정 여부'만 보는 자가진단이라 상위 호출을 하지 않는다 — 예외.
  if (f === 'integrations-status.js') continue;
  t(`${f} — 정규화를 거쳐 키를 읽는다`,
    /normalizeServiceKey\(\s*process\.env\.(ONBID|RTMS)_SERVICE_KEY/.test(src)
    || /normalizeServiceKey\(\s*process\.env\.RTMS_SERVICE_KEY \|\| process\.env\.ONBID_SERVICE_KEY/.test(src));
  t(`${f} — servicekey 모듈을 require한다`, src.includes("require('./lib/servicekey.js')"));
}

// 정규화된 값을 다시 인코딩해 넣는 곳이 없어야 한다(이중 인코딩 재발 방지).
for (const { f, src } of readers) {
  if (f === 'integrations-status.js') continue;
  t(`${f} — serviceKey를 직접 encodeURIComponent해 URL에 붙이지 않는다`,
    !/serviceKey=\$\{encodeURIComponent\(serviceKey\)\}/.test(src));
}

// ── ⑦ 실제 핸들러를 태워 상위로 나가는 URL을 확인 (배선 검증) ──
// ①~⑥은 라이브러리와 소스 텍스트를 본다. 여기서는 **함수를 실제로 실행해** fetch에 도달한
// URL을 잡는다 — require는 해 놓고 정작 다른 경로로 raw env를 쓰는 배선 실수를 잡는 유일한 방법.
(async () => {
  const prevEnv = { ...process.env };
  process.env.ONBID_API_URL = 'https://apis.data.go.kr/B010003/OnbidRlstListSrvc2';
  process.env.ONBID_DETAIL_API_URL = 'https://apis.data.go.kr/B010003/OnbidRlstDtlSrvc2';

  for (const [label, keyForm] of [['Encoding', ENC], ['Decoding', DEC]]) {
    process.env.ONBID_SERVICE_KEY = keyForm;
    const f = mockFetch([[/apis\.data\.go\.kr/, { header: { resultCode: '00' }, body: { items: { item: [] }, totalCount: 0 } }]]);
    delete require.cache[require.resolve(fnPath('onbid-search.js'))];
    const search = require(fnPath('onbid-search.js'));
    await search.handler({ httpMethod: 'GET', queryStringParameters: { numOfRows: '1' } });

    const url = f.calls.find(u => u.includes('serviceKey=')) || '';
    t(`${label} 키 입력 → 상위 호출 발생`, !!url);
    t(`${label} 키 입력 → 단일 인코딩으로 도달`, url.includes('serviceKey=' + ENC), url.slice(0, 140));
    t(`${label} 키 입력 → 이중 인코딩 없음`, !/%25/.test(url));
  }

  process.env = prevEnv;
  done('servicekey (data.go.kr 인증키 Encoding/Decoding 정규화)');
})().catch(e => { console.log('THROW', e); process.exit(1); });
