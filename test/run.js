// test/run.js — `npm test` 진입점. test/*.test.js 를 **각각 별도 프로세스**로 돌린다.
//
// 왜 별도 프로세스: 이 테스트들은 global.__FAKE_STORE__ / global.fetch 를 갈아끼우고
//   서버리스 함수 모듈을 require 캐시에 올린다. 한 프로세스에서 이어 돌리면 앞 테스트의
//   전역이 뒤 테스트에 새어 들어가 **없는 통과·없는 실패**를 만든다. 격리가 곧 신뢰다.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = __dirname;
const only = process.argv.slice(2).filter(a => !a.startsWith('-'));
const files = fs.readdirSync(dir)
  .filter(f => f.endsWith('.test.js'))
  .filter(f => !only.length || only.some(o => f.includes(o)))
  .sort();

if (!files.length) { console.log('테스트 파일이 없습니다.'); process.exit(1); }

let failed = 0;
const t0 = Date.now();
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

// ── 시계 스윕 (2026-07-30 신설) ──
// 같은 스위트를 시계만 +400일 돌려 한 번 더 돌린다. 잡는 것은 두 부류다:
//   ① **시한폭탄 픽스처** — 날짜를 하드코딩해 두어, 그 날이 지나면 조용히 무의미해지는 단언
//      (alerts.test.js가 실제로 그렇게 죽어 있었다)
//   ② **시점 로직 자체의 결함** — 이 스윕을 처음 돌렸을 때 predict-daily가 마감이 6개월
//      지난 물건을 전부 봉인 대상으로 통과시키는 것을 잡았다(창 필터에 하한이 없었다).
// 한 번만 더 도는 비용으로 이 부류가 다시 새는 것을 막는다. SKIP_TIME_SWEEP=1로 끌 수 있다.
let timeFailed = 0;
if (!process.env.SKIP_TIME_SWEEP && !only.length) {
  for (const f of files) {
    const r = spawnSync(process.execPath, ['-r', path.join(dir, '_timeshift.js'), path.join(dir, f)], {
      stdio: ['inherit', 'ignore', 'inherit'],
      env: { ...process.env, TIME_SHIFT_DAYS: '400' },
    });
    if (r.status !== 0) { timeFailed++; console.log(`  ✗ 시계 +400일에서 실패: ${f}`); }
  }
  console.log(timeFailed
    ? `⏰ 시계 스윕(+400일): ${timeFailed}개 파일 실패 — 날짜가 박힌 픽스처이거나 시점 로직 결함입니다.`
    : `⏰ 시계 스윕(+400일): 통과 (시한폭탄 없음)`);
  failed += timeFailed;
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);

console.log('─'.repeat(48));
console.log(failed
  ? `✗ ${failed}/${files.length} 파일 실패 (${secs}s)`
  : `✓ ${files.length}개 파일 전부 통과 (${secs}s)`);
process.exit(failed ? 1 : 0);
