# Notes: the exact reading this entry must reproduce

Written from reading the reference's behaviour (the kit's baseline and generator), as a spec for my own implementation.

## Reading rules

- `text` is `String(input.text)`, `header` is `input.header === true`.
- One U+FEFF at index 0 is skipped (only there; elsewhere it is a normal character).
- Before every record: skip any run of `\n` and `\r\n` (each counts one line). A lone `\r` is NOT skipped here.
  If the text is used up, stop.
- A record starts: `recordLine` = current line, `recordRow` = `null` if this is the header record
  (header and no columns yet), else `rows.length`.
- Fields of a record are read one after another while the previous field ended at a comma.
  A field is quoted when its first character is `"`.
- Unquoted field: characters up to `,` (consumed, record goes on), `\n` or `\r\n` (consumed, line+1, record ends) or
  the end. A `\r` not followed by `\n` is dropped and pushes `stray_cr` at once (with recordLine/recordRow).
  A `"` inside is literal.
- Quoted field: after the opening quote, `""` is one `"`, the first `"` not followed by `"` closes it.
  `\r\n` and a lone `\r` inside become `\n` (line+1 each), `\n` stays (line+1).
  After the close: end of text -> record ends; `,` -> next field; `\n` or `\r\n` -> record ends (line+1);
  anything else: read on with the unquoted rules, appending to the value (stray CRs still dropped with `stray_cr`),
  and when that field ends push `quote_junk` only if at least one character was appended.
- A quote that never closes (end reached before a closing quote; a trailing `""` is a doubled quote, not a close):
  push `unterminated_quote`, go back to just after the opening quote, restore the line counter to the opening
  quote's line, and read the rest as an unquoted field whose value starts with `"`.
- A record that is one field, `""` as value, and that field unquoted (a line made only of stray CRs) is no record;
  the stray_cr errors it pushed stay, with the row index the next record will take.
- `width` = the field count of the first record (the header when header is true).
- header true: the first record is `columns`; no padding or error for it.
- Every other record: fewer fields than width -> push `{code:'short_row', line, row, fields: count}` then pad with `""`;
  more -> push `{code:'long_row', line, row, extra: [cut fields]}` and cut. These come after the record's field errors.
- Answer: `{columns: header ? (columns ?? []) : null, rows, errors}`; errors `{code, line, row}` in the order met.
- Empty text (or only BOM / blank lines): `{columns: header ? [] : null, rows: [], errors: []}`.

## The drawn cases (generator)

- 6 cases a set, 1.4 to 2.0 million characters each (about 10-12 MB of CSV a set), 8 to 18 columns.
- Line break per file LF or CRLF (half each); BOM on 1 file in 3; header unless `index % 3 == 2`.
- Column kinds: int, decimal, date, code, word, phrase (commas and embedded quotes -> quoted), note (multi-line, lone
  CR sometimes), maybe (empty 40%). 1% of plain non-empty fields quoted for no need.
- Per record: short_row 1%, long_row 1% (1-3 extra fields), stray_cr 0.4%, quote_junk 0.4%, blank line 0.3%.
- Half the files: an unterminated quote opens the first of the last 1-20 records, which hold no other quote.
- 30% of files lose their final line break. Words include non-ASCII BMP characters (no surrogate pairs).

So almost every line is plain: no quote, no CR other than the CRLF ending. That is the fast path to optimise.

## Measurements

Local machine (Apple Silicon, Node 22.22, no CPU pinning, so +-10 ms noise). `test/bench.mjs`, CPU net of a
null `node -e 0`, mean of a set of 6 cases (about 11 MB of CSV):

| version | change | CPU ms |
|---|---|---|
| house baseline | csv-reader 1.0.0 | 488 |
| v1 | charCodeAt pass, slices | 187-198 |
| v2 | clean-line fast path (cached indexOf of quote / CR), native split | 184-206 (noise) |
| v2 + flags | main.ts: --single-threaded-gc, --no-concurrent-recompilation | 183-195 |
| v3 | byte transducer cases.json -> answers.json (transduce.js), run() as fallback | 98 |

Server (dev phase, gVisor, 3 runs): v2 = 1.25 s median (the board's run()-based entries sit at 1.2-2 s; the top 30
are byte-level transducers at 0-30 ms).

v3 phases locally: process start with TypeScript stripping 22 ms, read 1 ms, transduce 67 ms (a warm second call
takes 30 ms: the cold call pays for JIT tiering and deopts on branches with no feedback yet), write 1.5 ms.
A warm-up input that takes every branch removes the deopts but not the tiering cost; bigger warm-ups cost more than
they save. V8 tiering flags set at run time change nothing measurable.

Server v3 = 560 ms against 98 ms locally: under gVisor what costs is memory touched (page faults), syscalls and
thread wake-ups, so `/usr/bin/time -l` (instructions retired, page reclaims, RSS) is the local proxy now:

| program | instructions | faults (16 KiB pages) | RSS |
|---|---|---|---|
| empty .ts | 514 M | 5.2 k | 61 MB |
| empty .mjs | 301 M | 3.8 k | 39 MB |
| v3 (JS transducer) | 2262 M | 7.5 k | 97 MB |
| v4 (asm.js transducer, 1 MiB output window, CJS main.ts) | 968 M | 6.2 k | 77 MB |

v4: 51 ms net locally (v3 96 ms). Inside its fast path: read 1.1 ms, asm compile 1.5 ms, the six `","header":`
searches 3.8 ms, the six answers 16.8 ms (about 1.5 ns a byte).

`--single-threaded-gc` set at run time can abort V8 (concurrent marking already started); dropped.

Server v4 = 110 ms (from 560).

v5: no `","header":` search. The text is read up to the raw quote that ends it; the header flag only changes the
answer's first bytes, the separator after the first record and the errors' row numbers, so those are written as
fixed-size placeholders (padded with JSON whitespace: the output is the same JSON value, no longer the same bytes as
JSON.stringify) and errors kept as numbers until the flag is read; a placeholder already written out is patched in
the file with a positioned write.

v6: the input goes through a 512 KiB window too, refilled before a record when under 64 KiB are left (a record or
an unterminated quote's tail longer than that gives up to run()). Output window 512 KiB.

| version | instructions | faults | RSS | CPU net |
|---|---|---|---|---|
| empty CJS main.ts | 536 M | 5.28 k | 61.4 MB | - |
| v4 | 974 M | 6.25 k | 76.7 MB | 56 ms |
| v6 | 969 M | 5.54 k | 65.8 MB | 51 ms |

Fixed cost of v6 (a tiny input): 42 M instructions over the empty CJS main.ts; per input byte about 35
instructions. The bare copy loop alone in asm.js runs at 1.1-1.2 ns a byte (bounds-checked heap accesses);
unrolled by 4, 0.93-0.98.

Server v6 = 110 ms as well (interval 50-120): windowing the input changed nothing measurable there.

A symbolic link main.ts -> fast.cjs would skip TypeScript stripping (305 M instructions for the whole process
instead of 536 M), but the grader does not take a link as the entrypoint ("the snapshot has no main.ts").

Micro-benchmarks (ns a byte, copy-until-special over real cases.json bytes, this ARM machine): asm.js 1.13,
asm.js unrolled 0.95, wasm scalar 0.87 (TurboFan) / 1.40 (Liftoff), wasm SIMD 16-byte 1.11 (both tiers: i8x16.bitmask
is several instructions on ARM, one on x86), wasm SWAR 8-byte 0.77-0.87.

v7: the reader as a WebAssembly module (reader.cjs) written with a small assembler (wasm.cjs), SIMD for plain and
quoted fields, Liftoff only. Inside the run: answers 13.8 ms against 17.1 for asm.js, but assembling the module
(2.4 ms, cold JS) and the tables eat most of that back; whole process here: 815 M instructions against 911 M, the
same cycles (253-257 M). An x86 server (cheap bitmask) should favour it; the dev timing decides.

| version | instructions | cycles | CPU net (bench) |
|---|---|---|---|
| v6 + inline plain path (asm.js) | 911 M | 253 M | 47.6 ms |
| v7 wasm SIMD, Liftoff only | 831 M | 257 M | 58.7 ms (background threads on E-cores?) |

Phase split of v1 in one process: read 13 ms, JSON.parse 12, run (6 cases) 95, JSON.stringify 23, UTF-8 encode 8.
Floor for the run phase (only slicing every field, wrong answers): about 80 ms, so the parse itself is cheap and most
of the cost is allocating 1.1 M field strings and the GC that promotes them. An empty main.ts costs about 22 ms more
CPU than an empty .mjs (TypeScript stripping), the same for every entry.
