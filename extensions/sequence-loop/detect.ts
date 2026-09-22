// Pure core of the sequence-drift detector.
//
// Catches a failure mode that repetition-based loop detectors cannot see: the
// model degenerates into emitting an unending arithmetic progression of
// numeric tokens (0x2100, 0x2101, 0x2102, …). Every token is different, so
// verbatim and paragraph repetition never match — but the stream is almost
// entirely numbers with a constant delta, and the run is still going at the
// tail of the stream.
//
// The detector is a pure function of (text, options) so it can be unit-tested
// and replayed deterministically without any pi runtime.

export interface SequenceDriftOptions {
	/** Minimum number of consecutive constant-delta tokens required to fire. Below 2 disables. */
	minTokens: number;
	/** How many trailing characters of the stream to examine. Default 1600. */
	tailChars?: number;
	/** Minimum share of non-whitespace chars in the run region that must be numeric. Default 0.85. */
	dominance?: number;
}

export interface SequenceDriftHit {
	/** Stream text before the run (the part that is safe to keep). */
	cleanPrefix: string;
	/** Number of constant-delta tokens in the run. */
	tokens: number;
	/** Constant step between consecutive values (may be 0: stuck on one value). */
	delta: number;
	/** Measured numeric dominance of the run region. */
	dominance: number;
	firstValue: number;
	lastValue: number;
}

// Hex/binary alternatives come first so 0x2100 is not double-read as 2100.
const NUM_RE = /0[xX][0-9a-fA-F]+|0[bB][01]+|\d+/g;
// For the run to count as "live" (still being emitted), only separator
// punctuation/whitespace may follow the run's last token — plus at most one
// further numeric token, which covers the still-streaming partial token.
const LIVE_TAIL_RE = /^[\s,.;:]*(0[xX][0-9a-fA-F]+|0[bB][01]+|\d+)?$/;
// Characters that may sit between/after run tokens without breaking the
// backwards walk used to find a clean prose boundary (see cleanPrefix).
const RUN_CHARS_RE = /[\s,.;:0-9a-fA-FxXb]/;

function parseNumericToken(tok: string): number {
	if (/^0[xX]/.test(tok)) return parseInt(tok, 16);
	if (/^0[bB]/.test(tok)) return parseInt(tok, 2);
	return parseInt(tok, 10);
}

export function detectSequenceDrift(text: string, opts: SequenceDriftOptions): SequenceDriftHit | null {
	const minTokens = Math.floor(opts.minTokens);
	if (minTokens < 2 || text.length === 0) return null;
	const tailChars = Math.max(64, Math.floor(opts.tailChars ?? 1600));
	const minDominance = opts.dominance ?? 0.85;

	const tailStart = Math.max(0, text.length - tailChars);
	const tail = text.slice(tailStart);

	// Tokenize the tail, remembering each token's start offset and length.
	const values: number[] = [];
	const starts: number[] = [];
	const lens: number[] = [];
	NUM_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = NUM_RE.exec(tail)) !== null) {
		values.push(parseNumericToken(m[0]));
		starts.push(m.index);
		lens.push(m[0].length);
		if (values.length > 10000) break; // runaway guard
	}
	const n = values.length;
	if (n < minTokens) return null;

	// Longest constant-delta suffix run. The run may end at the last token or
	// the second-to-last: while streaming, the final token is often a partial
	// value (the model is mid-emission on "0x21…"), which breaks the delta.
	const runEndingAt = (end: number): { start: number; delta: number } | null => {
		if (end < 1) return null;
		const delta = values[end] - values[end - 1];
		let start = end - 1;
		while (start > 0 && values[start] - values[start - 1] === delta) start--;
		return { start, delta };
	};

	let run: { start: number; delta: number } | null = null;
	let runEnd = n - 1;
	const r1 = runEndingAt(n - 1);
	if (r1 && n - r1.start >= minTokens) {
		run = r1;
	} else {
		const r2 = runEndingAt(n - 2);
		if (r2 && n - 1 - r2.start >= minTokens) {
			run = r2;
			runEnd = n - 2;
		}
	}
	if (!run) return null;

	// Live at the tail: nothing but separators/whitespace (and at most the one
	// in-progress token) after the run's last token. A run followed by prose
	// is a finished enumeration, not a degeneration.
	const runLastEnd = starts[runEnd] + lens[runEnd];
	if (!LIVE_TAIL_RE.test(tail.slice(runLastEnd))) return null;

	// Dominance: the region from the run's first token to the end of the text
	// must be almost entirely numeric characters. Separator punctuation
	// (commas, …) and whitespace do not count against the run — only real
	// content does, so labeled tables ("0x2100  TGLAF …") collapse the ratio
	// while "1000, 1001, 1002, …" stays at 1.0.
	const regionStart = tailStart + starts[run.start];
	const region = text.slice(regionStart);
	let numericChars = 0;
	for (let i = run.start; i <= runEnd; i++) numericChars += lens[i];
	const contentChars = region.replace(/[\s,.;:]/g, '').length;
	if (contentChars === 0) return null;
	const dominance = numericChars / contentChars;
	if (dominance < minDominance) return null;

	// Clean cut point. Normally the run's first token; but when the run
	// predates the tail window, the tail starts inside the run and the
	// fragment tokens before the run's start are pure run-noise (digits,
	// x/b prefixes, separators, whitespace). In that case walk backwards
	// over run-character noise to find the last real prose boundary, so the
	// kept prefix does not itself end mid-sequence. (The walk may shave a
	// few trailing prose chars that look like run noise — acceptable: it
	// only happens for runs longer than the tail window.)
	let cut = regionStart;
	if (tailStart > 0) {
		const preRun = text.slice(tailStart, regionStart);
		const allNoise = preRun.length <= 256 && [...preRun].every((ch) => RUN_CHARS_RE.test(ch));
		if (allNoise) {
			let i = tailStart;
			const bound = Math.max(0, tailStart - 8000);
			while (i > bound && RUN_CHARS_RE.test(text[i - 1])) i--;
			// Never cut inside a word: a-f look like hex digits, so the walk
			// may have eaten the tail of a prose word ("table" → "tabl").
			// Extend the cut to the word's end instead.
			if (i > 0 && /[a-zA-Z]/.test(text[i - 1])) {
				let j = i;
				while (j < text.length && /[a-zA-Z]/.test(text[j])) j++;
				i = j;
			}
			cut = i;
		}
	}

	return {
		cleanPrefix: text.slice(0, cut),
		tokens: runEnd - run.start + 1,
		delta: run.delta,
		dominance,
		firstValue: values[run.start],
		lastValue: values[runEnd]
	};
}
