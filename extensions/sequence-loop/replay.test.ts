import { describe, expect, test } from 'bun:test';
import { detectSequenceDrift } from './detect.ts';

// Deterministic streaming replay: feed progressively longer prefixes at the
// same STRIDE boundaries the extension uses, and assert the detector trips
// MID-stream (not only on the finished text) at the right cut point.

const STRIDE = 50;
const OPTS = { minTokens: 25, tailChars: 1600, dominance: 0.85 };

function replay(text: string) {
	let detectedAt: number | null = null;
	let hit = null;
	for (let at = STRIDE; at <= text.length; at += STRIDE) {
		const h = detectSequenceDrift(text.slice(0, at), OPTS);
		if (h) {
			detectedAt = at;
			hit = h;
			break;
		}
	}
	return { detectedAt, hit };
}

describe('streaming replay', () => {
	test('trips mid-stream, far before the degeneration finishes', () => {
		const full = 'Enumerating:\n' + hexRun(0x2100, 300);
		const { detectedAt, hit } = replay(full);
		expect(detectedAt).not.toBeNull();
		// 300 tokens ≈ 2700 chars; 25 tokens ≈ 250 — must trip early.
		expect(detectedAt!).toBeLessThan(full.length * 0.5);
		expect(hit.cleanPrefix).toBe('Enumerating:\n');
		expect(hit.delta).toBe(1);
	});

	test('trips even when the stream is aborted mid-token', () => {
		// Simulate an abort landing inside a token: cut the full text at an
		// arbitrary point inside a number.
		const full = hexRun(0x2100, 200);
		const cut = full.length - 7; // inside the final token
		const { detectedAt, hit } = replay(full.slice(0, cut));
		expect(detectedAt).not.toBeNull();
		expect(hit.delta).toBe(1);
	});

	test('never trips on a labeled table, even fully streamed', () => {
		const full = Array.from({ length: 100 }, (_, i) => `0x${(0x2100 + i).toString(16).toUpperCase()}  LABEL_${i % 7}`).join('\n');
		const { detectedAt } = replay(full);
		expect(detectedAt).toBeNull();
	});

	test('a finished enumeration (run + summary) is not flagged on the final text', () => {
		// While the run is live it trips mid-stream — that is the point. But
		// once the model actually finished and wrote a summary, the complete
		// text must NOT be flagged (the run is no longer live at the tail).
		const full = hexRun(0x2100, 60) + '\nThat covers the whole block; the next range starts at 0x2200.';
		expect(detectSequenceDrift(full, OPTS)).toBeNull();
	});
});

function hexRun(start: number, count: number, perLine = 10): string {
	const lines: string[] = [];
	for (let i = 0; i < count; i += perLine) {
		const row: string[] = [];
		for (let j = i; j < Math.min(i + perLine, count); j++)
			row.push('0x' + (start + j).toString(16).toUpperCase());
		lines.push((i === 0 ? '' : '       ') + row.join(', '));
	}
	return lines.join('\n');
}
