/**
 * sequence-loop — aborts streams that degenerate into an unending numeric
 * sequence (0x2100, 0x2101, 0x2102, …) in thinking or visible output.
 *
 * This is a failure mode pi-loop-police cannot see: every token is different,
 * so verbatim/paragraph repetition never matches, and cross-turn continuations
 * defeat Jaccard-based stagnation guards (disjoint number words ≈ 0 similarity).
 *
 * Behaviour (mirrors pi-loop-police's proven lifecycle):
 *   message_update — stride-sampled detectSequenceDrift() over the streaming
 *     thinking / last text block; on a hit, record the clean prefix and
 *     ctx.abort().
 *   message_end    — rewrite the aborted block in place (keeping the reasoning
 *     before the run, unless the thinking block carries a provider signature,
 *     in which case it becomes a plain text marker), emit a detection payload,
 *     notify the TUI, and trigger a recovery turn.
 *
 * Continuation watch: after a firing, the next assistant message is checked at
 * a lower token threshold for a run with the same delta — this catches the
 * model restarting the enumeration it just lost. Cleared on a clean message.
 *
 * Coexistence with pi-loop-police: on this pattern the two never compete (its
 * detectors cannot fire on an incrementing sequence). If both ever abort the
 * same stream, the rewrite is gated on our clean prefix still being intact, so
 * the second extension simply skips its rewrite.
 *
 * Observability: every firing emits "sequence-loop:detection" on pi's
 * extension event bus with the same payload shape as loop-police's
 * "loop-police:detection".
 *
 * Commands:
 *   /sequence-loop             status
 *   /sequence-loop set KEY=VAL change one or more keys (session only)
 *   /sequence-loop reset       clear all state
 */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { detectSequenceDrift, type SequenceDriftHit } from './detect.ts';

const DEFAULTS = {
	// Minimum constant-delta token run to fire, per stream. 0 disables a stream.
	MIN_TOKENS_THINKING: 25,
	MIN_TOKENS_OUTPUT: 40,
	// Armed-continuation threshold (same-delta run right after a firing).
	CONTINUATION_TOKENS: 15,
	// Tail of the stream examined per checkpoint.
	TAIL_CHARS: 1600,
	// Minimum numeric share of non-whitespace chars in the run region.
	DOMINANCE: 0.85,
	// Check every N new characters while streaming.
	STRIDE: 50,
	// Output runs inside a ``` fence need this multiple of the token threshold
	// (a code array of addresses is more plausibly intentional).
	FENCE_FACTOR: 2
} as const;

type Stream = 'thinking' | 'output';

const cfg: Record<keyof typeof DEFAULTS, number> = { ...DEFAULTS };

const MSG_THINKING =
	'⚠️ SEQUENCE LOOP DETECTED (thinking): Your thinking degenerated into an unending numeric sequence ({tokens}+ values, step {delta}) and the sequence has been removed from your context. Do NOT continue or restart the enumeration. If you actually need those values, state the range and step in one line (e.g. "0x2100–0x228F, step 1") and resume the real task.';
const MSG_OUTPUT =
	'⚠️ SEQUENCE LOOP DETECTED (output): Your response degenerated into an unending numeric sequence ({tokens}+ values, step {delta}) and has been truncated. Do NOT re-emit the sequence — state the range and step in one line, or wrap up with a concise conclusion.';
const MSG_ESCALATED =
	'⚠️ SEQUENCE LOOP ({count}x in a row): You keep degenerating into numeric sequences. STOP enumerating entirely. Express any range as start–end plus step in a single line, and take a different concrete action on the task.';

export default function (pi: ExtensionAPI) {
	let aborted = false;
	let abortedStream: Stream = 'thinking';
	let abortedContentIndex: number | null = null;
	let cleanPrefix: string | null = null;
	let hit: SequenceDriftHit | null = null;
	let consecutive = 0;
	let turnIndex = 0;
	// Continuation watch (armed after any firing).
	let armedContinuation = false;
	let lastDelta: number | null = null;
	// Per-stream stride state.
	let thinkLen = 0;
	let thinkCi: number | null = null;
	let outLen = 0;
	let outCi: number | null = null;
	let outFences = 0;

	function resetStreamState() {
		thinkLen = 0;
		thinkCi = null;
		outLen = 0;
		outCi = null;
		outFences = 0;
	}

	function reset() {
		aborted = false;
		abortedStream = 'thinking';
		abortedContentIndex = null;
		cleanPrefix = null;
		hit = null;
		consecutive = 0;
		armedContinuation = false;
		lastDelta = null;
		resetStreamState();
	}

	pi.on('agent_start', reset);

	pi.on('turn_start', (event) => {
		turnIndex = event.turnIndex;
		resetStreamState();
		aborted = false;
		cleanPrefix = null;
		abortedContentIndex = null;
		// NOTE: consecutive / armedContinuation deliberately persist across
		// turns — the recovery turn is exactly where continuations happen.
	});

	function checkStream(stream: Stream, text: string, inFence: boolean): SequenceDriftHit | null {
		const base =
			(stream === 'thinking' ? cfg.MIN_TOKENS_THINKING : cfg.MIN_TOKENS_OUTPUT) *
			(stream === 'output' && inFence ? cfg.FENCE_FACTOR : 1);
		let h = detectSequenceDrift(text, { minTokens: base, tailChars: cfg.TAIL_CHARS, dominance: cfg.DOMINANCE });
		// Armed continuation: right after a firing, a shorter run with the SAME
		// delta is the model restarting the enumeration it just lost.
		if (!h && armedContinuation && lastDelta !== null && base > cfg.CONTINUATION_TOKENS) {
			const h2 = detectSequenceDrift(text, {
				minTokens: cfg.CONTINUATION_TOKENS,
				tailChars: cfg.TAIL_CHARS,
				dominance: cfg.DOMINANCE
			});
			if (h2 && h2.delta === lastDelta) h = h2;
		}
		return h;
	}

	function abortStream(h: SequenceDriftHit, stream: Stream, contentIndex: number | null, ctx: { abort(): void }) {
		aborted = true;
		abortedStream = stream;
		abortedContentIndex = contentIndex;
		cleanPrefix = h.cleanPrefix;
		hit = h;
		consecutive++;
		armedContinuation = true;
		lastDelta = h.delta;
		ctx.abort();
	}

	pi.on('message_update', (event, ctx) => {
		if (aborted || event.message.role !== 'assistant') return;
		const ci = 'contentIndex' in event.assistantMessageEvent ? event.assistantMessageEvent.contentIndex : null;

		// Thinking stream.
		const thinking = extractThinkingAt(event.message, ci);
		if (thinking !== null) {
			if (ci !== thinkCi) {
				thinkCi = ci;
				thinkLen = 0;
			}
			// Shrinking text means a new thinking block started streaming.
			if (thinking.length < thinkLen) thinkLen = 0;
			if (thinking.length >= thinkLen + cfg.STRIDE) {
				thinkLen = thinking.length;
				const h = checkStream('thinking', thinking, false);
				if (h) abortStream(h, 'thinking', ci, ctx);
			}
		}

		// Output stream (the last text block — streaming appends to the newest).
		const output = extractTextAt(event.message, ci);
		if (output !== null) {
			if (ci !== outCi) {
				outCi = ci;
				outLen = 0;
				outFences = 0;
			}
			if (output.length < outLen) {
				outLen = 0;
				outFences = 0;
			}
			if (output.length >= outLen + cfg.STRIDE) {
				const fresh = output.slice(outLen);
				outFences += (fresh.match(/```/g) ?? []).length;
				outLen = output.length;
				const h = checkStream('output', output, outFences % 2 === 1);
				if (h) abortStream(h, 'output', ci, ctx);
			}
		}
	});

	pi.on('message_end', (event, ctx) => {
		if (event.message.role !== 'assistant') return;

		if (aborted) {
			const stream = abortedStream;
			const ci = abortedContentIndex;
			const prefix = cleanPrefix ?? '';
			const h = hit;
			aborted = false;
			abortedContentIndex = null;
			cleanPrefix = null;
			hit = null;
			resetStreamState();

			if (h) {
				// Re-verify our target is still intact before rewriting: if
				// another extension (e.g. pi-loop-police) already truncated the
				// stream, our prefix is gone and we skip the rewrite.
				const finalText =
					stream === 'thinking' ? extractThinkingAt(event.message, ci) : extractTextAt(event.message, ci);
				const intact = finalText !== null && finalText.startsWith(prefix);

				let cleaned = event.message;
				if (intact) {
					const marker =
						stream === 'thinking'
							? `${prefix}\n[SEQUENCE LOOP — truncated by sequence-loop: an unending numeric sequence was removed here. Do not continue or restart it.]`
							: `${prefix}\n\n[SEQUENCE LOOP — truncated by sequence-loop]`;
					cleaned =
						stream === 'thinking'
							? replaceThinkingAt(event.message, ci, marker)
							: replaceTextAt(event.message, ci, marker);
				}

				const continuation = armedContinuation && consecutive > 1;
				emitDetection(ctx, stream, h, continuation);
				ctx.ui.notify(
					`⚠️ SEQUENCE LOOP (${stream}): ${h.tokens} values, step ${h.delta} — stream aborted`,
					'warning'
				);
				const escalated = consecutive >= 2;
				const advice = escalated
					? MSG_ESCALATED.replaceAll('{count}', String(consecutive))
					: (stream === 'thinking' ? MSG_THINKING : MSG_OUTPUT)
							.replaceAll('{tokens}', String(h.tokens))
							.replaceAll('{delta}', String(h.delta));
				// The run is aborting (our own ctx.abort() in abortStream): at
				// message_end the session still reports streaming, so
				// sendCustomMessage would route this through agent.steer() into
				// the DYING run, and pi ends the run on an 'aborted' stop without
				// draining the steering queue — the advice would never be
				// delivered and the session would sit idle with no recovery turn
				// (same defect as pi-loop-police, session 01a0cd1f). Defer
				// delivery until the run has settled: pi starts any run another
				// extension or the user queued at settle before returning to the
				// event loop, so a one-tick delay tells the two cases apart —
				// steer the advice into the live run, or start the recovery turn
				// ourselves when the session is idle.
				let unsubscribeSettled: () => void = () => {};
				const onSettled = () => {
					unsubscribeSettled();
					setTimeout(() => {
						if (ctx.isIdle()) {
							pi.sendMessage({ customType: 'sequence-loop', content: advice, display: true }, { triggerTurn: true });
						} else {
							pi.sendMessage({ customType: 'sequence-loop', content: advice, display: true }, { deliverAs: 'steer' });
						}
					}, 0);
				};
				unsubscribeSettled = pi.on('agent_settled', onSettled);
				if (intact) return { message: cleaned };
				return;
			}
		}

		// Clean assistant message: the model is progressing — clear the
		// continuation watch and the escalation counter.
		armedContinuation = false;
		consecutive = 0;
		resetStreamState();
	});

	function emitDetection(ctx: ExtensionContext, stream: Stream, h: SequenceDriftHit, continuation: boolean) {
		const payload = {
			event: stream === 'thinking' ? 'thinking_sequence_loop' : 'output_sequence_loop',
			timestamp: new Date().toISOString(),
			model: ctx.model
				? { id: ctx.model.id, name: ctx.model.name, provider: ctx.model.provider }
				: null,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile() ?? null,
			cwd: ctx.cwd,
			turnIndex,
			consecutiveLoops: consecutive,
			details: {
				stream,
				tokens: h.tokens,
				delta: h.delta,
				dominance: h.dominance,
				firstValue: h.firstValue,
				lastValue: h.lastValue,
				continuation
			}
		};
		pi.events.emit('sequence-loop:detection', payload);
	}

	pi.registerCommand('sequence-loop', {
		description: 'Show status; /sequence-loop reset; /sequence-loop set KEY=VAL [KEY=VAL ...]',
		handler: (args, ctx) => {
			const trimmed = args?.trim() ?? '';

			if (trimmed === 'reset') {
				reset();
				ctx.ui.notify('Sequence Loop: state reset', 'info');
				return;
			}

			if (trimmed.startsWith('set ')) {
				const results = parseAssignments(trimmed.slice(4)).map((pair) => {
					const eq = pair.indexOf('=');
					const key = pair.slice(0, eq);
					const val = Number(pair.slice(eq + 1));
					if (!(key in cfg)) return `unknown: ${key}`;
					if (!Number.isFinite(val) || val < 0) return `invalid: ${pair}`;
					cfg[key as keyof typeof cfg] = val;
					return `${key}=${val}`;
				});
				ctx.ui.notify(`Sequence Loop: ${results.join(', ')} (session only)`, 'info');
				return;
			}

			ctx.ui.notify(
				[
					'Sequence Loop status',
					`  aborted:           ${aborted}`,
					`  consecutive:       ${consecutive}`,
					`  continuation:      ${armedContinuation ? `armed (delta ${lastDelta})` : 'idle'}`,
					'',
					'  config (set KEY=VAL to change):',
					...Object.keys(DEFAULTS).map((k) => `    ${k}=${cfg[k as keyof typeof cfg]}`)
				].join('\n'),
				'info'
			);
		}
	});

	pi.registerMessageRenderer('sequence-loop', (message, _opts, theme) =>
		new Text(theme.fg('warning', String(message.content)), 0, 0)
	);
}

// --- helpers -----------------------------------------------------------------

function parseAssignments(input: string): string[] {
	return [...input.matchAll(/(?:^|\s)([A-Z][A-Z0-9_]*)=/g)].map((match, i, all) => {
		const start = (match.index ?? 0) + match[0].length;
		const end = i + 1 < all.length ? all[i + 1].index! : input.length;
		return `${match[1]}=${input.slice(start, end).trim()}`;
	});
}

function extractThinkingAt(message: any, index: number | null): string | null {
	if (index === null || !Array.isArray(message?.content)) return null;
	const block = message.content[index];
	return block?.type === 'thinking' && typeof block.thinking === 'string' ? block.thinking : null;
}

function extractTextAt(message: any, index: number | null): string | null {
	if (index === null || !Array.isArray(message?.content)) return null;
	const block = message.content[index];
	return block?.type === 'text' && typeof block.text === 'string' ? block.text : null;
}

function replaceTextAt(message: any, index: number | null, newText: string): any {
	if (index === null || !Array.isArray(message?.content) || message.content[index]?.type !== 'text') return message;
	return {
		...message,
		content: message.content.map((block: any, i: number) => (i === index ? { ...block, text: newText } : block))
	};
}

// Signed thinking must never be modified in place: some providers reject a
// signature whose text no longer matches (and replaying the signed payload can
// restore the degeneration). Replace the whole block with a plain text marker;
// unsigned thinking keeps the pre-run reasoning as thinking.
function replaceThinkingAt(message: any, index: number | null, newText: string): any {
	if (index === null || !Array.isArray(message?.content) || message.content[index]?.type !== 'thinking')
		return message;
	const signed = message.content[index].signature != null;
	return {
		...message,
		content: message.content.map((block: any, i: number) =>
			i === index ? (signed ? { type: 'text', text: newText } : { ...block, thinking: newText }) : block
		)
	};
}
