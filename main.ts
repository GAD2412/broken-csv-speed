// main.ts: the program the harness runs (node22). Reads /input/cases.json and writes /output/answers.json (one answer
// per case, in order). Outside the grader $MAKEFUN_INPUT_DIR / $MAKEFUN_OUTPUT_DIR stand in for /input and /output.
//
// Fast path: transduce.js turns the cases.json bytes into the answers.json bytes directly. If the file is not of the
// shape it expects, every case is answered with run() from solve.js instead, as the house driver does.

import { readFileSync, writeFileSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';

// Flags first (the house baseline runs with incremental marking off); on one CPU, GC and compiler helper threads
// only add switching and synchronisation.
setFlagsFromString('--no-incremental-marking');
setFlagsFromString('--single-threaded-gc');
setFlagsFromString('--no-concurrent-recompilation');

const { transduce } = (await import('./transduce.js')) as { transduce: (b: Buffer) => Uint8Array | null };

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const bytes = readFileSync(inDir + '/cases.json');
let answers: Uint8Array | string | null = transduce(bytes);
if (answers === null) {
  const { run } = (await import('./solve.js')) as { run: (input: unknown) => unknown };
  const cases = JSON.parse(bytes.toString('utf8')) as { input: unknown }[];
  const list = new Array(cases.length);
  for (let i = 0; i < cases.length; i++) list[i] = run(cases[i].input);
  answers = JSON.stringify(list);
}
writeFileSync(outDir + '/answers.json', answers, { mode: 0o644 });
