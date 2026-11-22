// Draws realistic case sets with the kit's own generator (its draw.ts, run as a program, never copied here).
//
//   node test/gen.mjs <kit dir> <out dir> [sets=4] [first seed index=1]
//
// Writes <out dir>/set-<k>/input/cases.json and <out dir>/set-<k>/reference/expected.json.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [kitArg, outArg, setsArg, firstArg] = process.argv.slice(2);
if (!kitArg || !outArg) {
  console.error('usage: node test/gen.mjs <kit dir> <out dir> [sets] [first]');
  process.exit(2);
}
const draw = resolve(kitArg, 'program/generator/draw.ts');
const sets = Number(setsArg ?? 4);
const first = Number(firstArg ?? 1);

for (let k = first; k < first + sets; k++) {
  const dir = resolve(outArg, `set-${k}`);
  const seedDir = join(dir, 'seed');
  mkdirSync(seedDir, { recursive: true });
  const seed = createHash('sha256').update(`my-local-set-${k}`).digest('hex');
  writeFileSync(join(seedDir, 'seed.json'), JSON.stringify({ schema: 'agent-fun/instance-seed/v1', seed }));
  const r = spawnSync(process.execPath, [draw], {
    env: { ...process.env, MAKEFUN_INPUT_DIR: seedDir, MAKEFUN_OUTPUT_DIR: dir },
    stdio: 'inherit',
  });
  if (r.status !== 0) process.exit(1);
  console.log(`set-${k} written`);
}
