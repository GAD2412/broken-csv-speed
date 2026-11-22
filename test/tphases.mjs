// Phase times of the transducer path in one fresh process: node test/tphases.mjs <set dir> [out file]
import { readFileSync, writeFileSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');
setFlagsFromString('--single-threaded-gc');
setFlagsFromString('--no-concurrent-recompilation');
const cpu = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
let t = cpu();
const lap = (name) => {
  const now = cpu();
  console.log(`${name.padEnd(12)} ${(now - t).toFixed(1)} ms`);
  t = now;
};
console.log(`startup     ${t.toFixed(1)} ms`);
const { transduce, warm } = await import('../transduce.js');
lap('import');
if (process.env.WARM !== '0') warm();
lap('warm');
const bytes = readFileSync(process.argv[2] + '/input/cases.json');
lap('read');
const out = transduce(bytes);
lap('transduce');
writeFileSync(process.argv[3] ?? '/dev/null', out);
lap('write');
