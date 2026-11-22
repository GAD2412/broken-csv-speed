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
- That reader is a WebAssembly module, written in `fast.cjs` as a program in a small JSON notation and turned into
  module bytes at run time by one emitter function, then compiled ahead of its run (Liftoff only), so no time goes
  into warming up a JIT (for a JS loop over 11 MB run
  once that costs more than the loop). Plain fields are read 16 bytes at a time with SIMD: one comparison finds the
  commas and the bytes that need care, and the commas before the first escape are all written as `","` at once, by a
  table-driven byte shuffle. Quoted fields are copied 16 bytes at a time up to their next escape.
- Input and output go through 512 KiB windows (refilled and written out between records), so few memory pages are
  touched. The header flag comes after the text in the file, so the answer's first bytes are written as
  placeholders (padded with JSON whitespace) and filled in once the flag is read.
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
