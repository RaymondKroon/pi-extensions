# better-edit

A global pi extension that replaces the built-in `edit` tool with a more
model-robust version. It shadows the built-in by registering a tool with the
same name (`edit`), keeping the same schema, atomic all-or-nothing semantics,
CRLF/BOM handling, file-mutation queue, and TUI renderers (a port of the
built-in renderers that reuses the enhanced matching, so preview and result
always agree).

## Why

Session analysis (2026-09-05, `qwen3.8-27B`) showed the model failing the
built-in `edit` tool 6 times in a row on a 7-edit batch, then corrupting the
file with a line-number-splice fallback. Root cause: when regenerating a
multi-line `oldText` from memory, the model drifted by one indentation level
(+1 tab on every line from line 3 on). The built-in fuzzy matcher only
normalizes trailing whitespace and Unicode — not leading indentation — and
the error message gave no diagnostics, so each retry re-transmitted ~12 KB of
arguments and hit the next drifted edit.

## What it changes

1. **Indentation-tolerant matching.** When exact and built-in fuzzy matching
   fail, a third stage ignores leading whitespace (the match must stay
   unique). When the model's `oldText` is uniformly over-indented relative to
   the file, the replacement is re-indented to the file's indentation: each
   `newText` line is aligned to its `oldText` counterpart (exact trimmed
   match, then word-similarity) and takes the file's indentation for that
   line; unmatched lines take the indentation of the oldText line they
   positionally correspond to. Conservative fallbacks: file-deeper or mixed
   deltas → `newText` is used as-is.
2. **Diagnostic errors.** When an edit still fails, the error lists
   per-edit status (`edits[0] OK`, `edits[1] FAIL`, …) and, for each failed
   edit, the closest region in the file as a line-numbered diff
   (`-` = your oldText, `+` = file), with a hint when most differences are
   indentation-only. The message tells the model to copy the `+` lines
   verbatim and resubmit only the failed edits.
3. **Recovery guidelines** in the system prompt: re-read the exact region
   before retrying; never reconstruct indentation from memory; resubmit only
   failed edits.

## Known limitations

- Re-indentation is a heuristic; when alignment is ambiguous the model's own
  `newText` indentation is kept.
- Small text helpers (line-ending/BOM handling, the core fuzzy normalization,
  line-preserving replacement) are mirrored from pi core's `edit-diff.ts` /
  `path-utils.ts` because those functions are not exported. If pi core changes
  them, re-sync this extension (the exact-match stage is unaffected).

## Development

```sh
bun test .          # 32 tests, incl. a regression test using the exact
                    # oldText/newText from the 2026-09-05 session (fixtures/)
bunx tsc --noEmit --strict --target es2022 --module esnext \
  --moduleResolution bundler --skipLibCheck index.ts
```

`node_modules/@earendil-works/pi-coding-agent` is a symlink to the global
install (bun resolves the real path), and
`node_modules/@earendil-works/pi-tui` is a symlink to that package's own
nested `pi-tui` (the TUI renderer imports it directly). If pi is upgraded,
re-check both versions.

## Installation

Registered as a pi package in `~/.pi/agent/settings.json`:

```json
"packages": [
  "...",
  "../../Development/raymondkroon/pi-extensions/extensions/better-edit"
]
```
