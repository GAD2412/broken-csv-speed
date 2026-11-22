# broken-csv-speed

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/GAD2412/broken-csv-speed/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/GAD2412/broken-csv-speed/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A dependency-free JavaScript reader of broken CSV text that returns exactly csv-reader 1.0.0's answer
(`{columns, rows, errors}`: short and long rows, stray CRs, junk after quotes, unterminated quotes) in less CPU time.

- `transduce.js` (the fast path `main.ts` takes) never decodes the CSV into JS strings: it reads the bytes of
  `cases.json` and writes the bytes of `answers.json`. In the JSON text every character the CSV reading looks at is
  ASCII and appears as `,` or as the escapes `\"`, `\n`, `\r`; everything else is opaque and copied through, since JSON
  escapes one character at a time. Quote doubling, CR to LF inside quotes, stray CRs, junk, unterminated quotes and
  ragged rows are all handled on the escaped bytes. Files of any other shape make it give up.
- `solve.js` exports `run(input)`, the same reading on JS strings (one pass with `charCodeAt`, fields as slices of the
  text), used for every case whenever the transducer gives up.
- `main.ts` is the harness program; it also turns off V8's GC helper threads, which only cost CPU on one core.
The exact reading rules are in [NOTES.md](NOTES.md); `test/fuzz.mjs` checks the answers against the reference on
hundreds of thousands of random and adversarial inputs.

## Run it

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<out dir> node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=z1s7h5w8&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
