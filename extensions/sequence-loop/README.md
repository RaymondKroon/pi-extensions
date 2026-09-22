# sequence-loop

Aborts streams that degenerate into an unending numeric sequence
(`0x2100, 0x2101, 0x2102, …`) in **thinking** or visible **output** — a
failure mode `pi-loop-police` cannot see, because every token is different
(no verbatim/paragraph repetition) and cross-turn continuations defeat
Jaccard-based stagnation guards (disjoint number words ≈ 0 similarity).

Observed incident: Qwen3.8-27B (vLLM) thinking stream emitting a +1 hex
progression for hundreds of tokens until the max-token budget.

## How it detects

Stride-sampled (every 50 new chars) over the streaming thinking / last text
block. Fires when the tail of the stream contains:

- ≥ `MIN_TOKENS` numeric tokens (hex/binary/decimal) in a **constant-delta**
  run (Δ may be 0: stuck on one value),
- the run is **live** — still going at the end of the stream (a finished
  enumeration followed by prose is not flagged),
- the run region is ≥ `DOMINANCE` numeric characters (labeled tables like
  `0x2100  TGLAF …` are left alone).

## Recovery

On a hit the stream is aborted and, at message end, the block is rewritten in
place: the reasoning before the run is kept (unsigned thinking stays
thinking; signed thinking becomes a plain text marker), the run is replaced
by a `[SEQUENCE LOOP — truncated]` marker, and a recovery turn is triggered
telling the model to state the range and step instead of enumerating.

**Continuation watch:** after a firing, the next assistant message is checked
at `CONTINUATION_TOKENS` for a same-delta run — catches the model restarting
the enumeration it just lost. Cleared on a clean message.

## Coexistence with pi-loop-police

On this pattern the two never compete (loop-police's detectors cannot fire on
an incrementing sequence). If both ever abort the same stream, the rewrite is
gated on our clean prefix still being intact, so the second extension skips
its rewrite.

## Observability

Every firing emits `sequence-loop:detection` on pi's extension event bus with
the same payload shape as `loop-police:detection`
(`event: thinking_sequence_loop | output_sequence_loop`,
`details: {stream, tokens, delta, dominance, firstValue, lastValue, continuation}`).

## Commands

```
/sequence-loop               status + config
/sequence-loop set KEY=VAL   session-only config change
/sequence-loop reset         clear all state
```

| Key | Default | Meaning |
|-----|---------|---------|
| `MIN_TOKENS_THINKING` | `25` | min constant-delta run in thinking (0 = off) |
| `MIN_TOKENS_OUTPUT` | `40` | min constant-delta run in output (0 = off) |
| `CONTINUATION_TOKENS` | `15` | armed-continuation threshold (same delta) |
| `TAIL_CHARS` | `1600` | tail of the stream examined per checkpoint |
| `DOMINANCE` | `0.85` | min numeric share of the run region |
| `STRIDE` | `50` | check every N new characters |
| `FENCE_FACTOR` | `2` | output runs inside ``` fences need this × tokens |

## Tests

```
bun test .
```

`detect.test.ts` — unit tests (the incident sample is the primary fixture);
`replay.test.ts` — deterministic streaming replay proving the detector trips
mid-stream at the right cut point.
