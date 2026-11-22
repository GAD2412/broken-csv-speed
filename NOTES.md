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

(filled in as I measure: change -> CPU time vs the baseline on the same machine)
