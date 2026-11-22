// Runs main.ts on every set under a directory (as test/gen.mjs writes them) and checks answers.json against the
// set's reference: byte for byte against JSON.stringify of the oracle's answers, else as JSON values.
//   node test/sets.mjs <sets dir>
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const main = fileURLToPath(new URL('../main.ts', import.meta.url));
const root = process.argv[2];
const out = mkdtempSync(join(tmpdir(), 'sets-'));
let bad = 0;
let n = 0;
for (const name of readdirSync(root).sort()) {
  const dir = join(root, name);
  if (!existsSync(join(dir, 'reference/expected.json'))) continue;
  const r = spawnSync(process.execPath, [main], {
    env: { ...process.env, MAKEFUN_INPUT_DIR: join(dir, 'input'), MAKEFUN_OUTPUT_DIR: out },
    encoding: 'utf8',
  });
  const want = JSON.stringify(JSON.parse(readFileSync(join(dir, 'reference/expected.json'), 'utf8')).cases.map((c) => c.output));
  const got = r.status === 0 ? readFileSync(join(out, 'answers.json'), 'utf8') : `exit ${r.status}: ${r.stderr}`;
  n++;
  let same = got === want;
  if (!same) {
    // Not the same bytes (fast.cjs pads with JSON whitespace): the same JSON value? (Key order kept, so stringify.)
    try {
      same = JSON.stringify(JSON.parse(got)) === want;
    } catch {}
  }
  if (!same) {
    bad++;
    console.log(`${name}: DIFFERENT (${got.length} vs ${want.length} bytes) ${r.stderr.slice(0, 300)}`);
  }
}
console.log(`${n} sets, ${bad} different`);
process.exit(bad === 0 ? 0 : 1);
