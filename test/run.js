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
const secs = ((Date.now() - t0) / 1000).toFixed(1);

console.log('─'.repeat(48));
console.log(failed
  ? `✗ ${failed}/${files.length} 파일 실패 (${secs}s)`
  : `✓ ${files.length}개 파일 전부 통과 (${secs}s)`);
process.exit(failed ? 1 : 0);
