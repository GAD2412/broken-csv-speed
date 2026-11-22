// main.ts: the program the harness runs (node22). Reads every case from /input/cases.json, answers each one with
// run() from solve.js, writes /output/answers.json (one answer per case, in order).
// Outside the grader $MAKEFUN_INPUT_DIR / $MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// Flags first, so all of solve.js runs under them (the house baseline runs with incremental marking off).
setFlagsFromString('--no-incremental-marking');

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inDir, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers = new Array(cases.length);
for (let i = 0; i < cases.length; i++) answers[i] = run(cases[i].input);
writeFileSync(join(outDir, 'answers.json'), JSON.stringify(answers), { mode: 0o644 });
