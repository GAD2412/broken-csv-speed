// Self time per function from a --cpu-prof .cpuprofile file: node test/prof-summary.mjs <file> [top=25]
import { readFileSync } from 'node:fs';

const prof = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const top = Number(process.argv[3] ?? 25);
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const self = new Map();
const dts = prof.timeDeltas;
for (let i = 0; i < prof.samples.length; i++) {
  const n = byId.get(prof.samples[i]);
  const f = n.callFrame;
  const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + (dts[i] ?? 0));
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) {
  console.log(`${(v / 1000).toFixed(1).padStart(8)} ms ${((100 * v) / total).toFixed(1).padStart(5)}%  ${k}`);
}
