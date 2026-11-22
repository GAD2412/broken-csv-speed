# broken-csv-speed

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/GAD2412/broken-csv-speed/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/GAD2412/broken-csv-speed/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A dependency-free JavaScript reader of broken CSV text that returns exactly csv-reader 1.0.0's answer
(`{columns, rows, errors}`: short and long rows, stray CRs, junk after quotes, unterminated quotes) in less CPU time.
`solve.js` makes one pass over the text's UTF-16 code units and takes every field as a slice of the text, building a
value from pieces only where a quoted field holds `""` or a CR. A line with no quote and no stray CR (found with cached
`indexOf` positions, never char by char) is split at its commas natively; any other line is read with `charCodeAt`.
`main.ts` is the harness program; it also turns off V8's GC and compiler helper threads, which only cost CPU on one core.
The exact reading rules are in [NOTES.md](NOTES.md); `test/fuzz.mjs` checks the answers against the reference on
hundreds of thousands of random and adversarial inputs.

## Run it

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<out dir> node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=z1s7h5w8&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
