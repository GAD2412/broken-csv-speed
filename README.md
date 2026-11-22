# broken-csv-speed

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/GAD2412/broken-csv-speed/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/GAD2412/broken-csv-speed/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A dependency-free JavaScript reader of broken CSV text that returns exactly csv-reader 1.0.0's answer
(`{columns, rows, errors}`: short and long rows, stray CRs, junk after quotes, unterminated quotes) in less CPU time.

- `fast.cjs` (the fast path; `main.ts` is one line that calls it) never decodes the CSV into JS strings: it reads the
  bytes of `cases.json` and writes the bytes of `answers.json`. In the JSON text every character the CSV reading looks
  at is ASCII and appears as `,` or as the escapes `\"`, `\n`, `\r`; everything else is opaque and copied through,
  since JSON escapes one character at a time. Quote doubling, CR to LF inside quotes, stray CRs, junk, unterminated
  quotes and ragged rows are all handled on the escaped bytes.
- That reader is written in the asm.js subset of JavaScript, so V8 validates it and compiles it ahead of time to
  machine code: no time is spent warming up a JIT, which for a JS loop over 11 MB run once costs more than the loop.
  The input is read whole into the asm heap with one read; the output goes through a 1 MiB window written out between
  records, so few memory pages are touched.
- `solve.js` exports `run(input)`, the same reading on JS strings (one pass with `charCodeAt`, fields as slices of the
  text). Whenever the file is not of the expected shape (other keys, a header that is not a boolean, `\u` escapes of a
  comma, quote, CR or LF, a record bigger than the window) every case is answered with `run()` instead.
The exact reading rules are in [NOTES.md](NOTES.md); `test/fuzz.mjs` checks the answers against the reference on
hundreds of thousands of random and adversarial inputs.

## Run it

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<out dir> node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=z1s7h5w8&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
