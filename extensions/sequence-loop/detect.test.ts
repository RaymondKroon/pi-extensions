import { describe, expect, test } from 'bun:test';
import { detectSequenceDrift } from './detect.ts';

const OPTS = { minTokens: 25, tailChars: 1600, dominance: 0.85 };

// The user's exact sample from the incident (first five lines, 50 tokens).
const USER_SAMPLE = `0x2100, 0x2101, 0x2102, 0x2103, 0x2104, 0x2105, 0x2106, 0x2107, 0x2108, 0x2109,
       0x210A, 0x210B, 0x210C, 0x210D, 0x210E, 0x210F, 0x2110, 0x2111, 0x2112, 0x2113,
       0x2114, 0x2115, 0x2116, 0x2117, 0x2118, 0x2119, 0x211A, 0x211B, 0x211C, 0x211D,
       0x211E, 0x211F, 0x2120, 0x2121, 0x2122, 0x2123, 0x2124, 0x2125, 0x2126, 0x2127,
       0x2128, 0x2129, 0x212A, 0x212B, 0x212C, 0x212D, 0x212E, 0x212F, 0x2130, 0x2131,`;

// Generates a wrapped hex run like the incident: 10 values per line, +1 step.
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

describe('detectSequenceDrift', () => {
	test('fires on the exact incident sample', () => {
		const h = detectSequenceDrift(USER_SAMPLE, OPTS);
		expect(h).not.toBeNull();
		expect(h!.delta).toBe(1);
		expect(h!.tokens).toBe(50);
		expect(h!.firstValue).toBe(0x2100);
		expect(h!.lastValue).toBe(0x2131);
		expect(h!.cleanPrefix).toBe('');
	});

	test('fires on a long generated run and cuts after the prose', () => {
		const text = 'Let me enumerate the code points:\n' + hexRun(0x2100, 120);
		const h = detectSequenceDrift(text, OPTS);
		expect(h).not.toBeNull();
		expect(h!.cleanPrefix).toBe('Let me enumerate the code points:\n');
		expect(h!.delta).toBe(1);
		expect(h!.tokens).toBe(120);
	});

	test('run longer than the tail window: walks back to the prose boundary', () => {
		const text = 'Here is the table:\n' + hexRun(0x2100, 400);
		const h = detectSequenceDrift(text, OPTS);
		expect(h).not.toBeNull();
		// The walk eats run-noise backwards; ':' is run-noise, so the kept
		// prefix ends at the last prose word (never mid-word, never mid-run).
		expect(h!.cleanPrefix).toBe('Here is the table');
	});

	test('fires on decimal runs', () => {
		const text = Array.from({ length: 40 }, (_, i) => 1000 + i).join(', ') + ',';
		const h = detectSequenceDrift(text, OPTS);
		expect(h).not.toBeNull();
		expect(h!.delta).toBe(1);
		expect(h!.firstValue).toBe(1000);
	});

	test('fires on a stuck single value (delta 0)', () => {
		const h = detectSequenceDrift('42, '.repeat(30), OPTS);
		expect(h).not.toBeNull();
		expect(h!.delta).toBe(0);
	});

	test('fires across mixed radix with constant value delta', () => {
		// 255 (decimal) then 0x100, 0x101, … — all step +1 in value.
		const text = '255, ' + Array.from({ length: 40 }, (_, i) => '0x' + (0x100 + i).toString(16)).join(', ') + ',';
		const h = detectSequenceDrift(text, OPTS);
		expect(h).not.toBeNull();
		expect(h!.delta).toBe(1);
		expect(h!.firstValue).toBe(255);
	});

	test('fires with a partial token still streaming at the tail', () => {
		const text = hexRun(0x2100, 30) + ' 0x21';
		const h = detectSequenceDrift(text, OPTS);
		expect(h).not.toBeNull();
		expect(h!.lastValue).toBe(0x211d); // last COMPLETE value
	});

	test('fires with CRLF line endings', () => {
		const text = hexRun(0x2100, 40).replace(/\n/g, '\r\n');
		expect(detectSequenceDrift(text, OPTS)).not.toBeNull();
	});

	test('fires when a stray token breaks the start of the run', () => {
		const text = '0x2100, 0x2101, garbage, ' + hexRun(0x2103, 40);
		const h = detectSequenceDrift(text, OPTS);
		expect(h).not.toBeNull();
		expect(h!.firstValue).toBe(0x2103);
	});

	test('does not fire on a labeled table (dominance)', () => {
		const text = Array.from({ length: 60 }, (_, i) => `0x${(0x2100 + i).toString(16).toUpperCase()}  TGLAF${i % 10}`).join('\n');
		expect(detectSequenceDrift(text, OPTS)).toBeNull();
	});

	test('does not fire below the token threshold', () => {
		expect(detectSequenceDrift(hexRun(0x2100, 20), OPTS)).toBeNull();
	});

	test('does not fire when the run is finished (prose after)', () => {
		const text = hexRun(0x2100, 40) + '\nDone — that is the full list.';
		expect(detectSequenceDrift(text, OPTS)).toBeNull();
	});

	test('does not fire on prose', () => {
		expect(detectSequenceDrift('Let me think about the approach for this refactor. '.repeat(20), OPTS)).toBeNull();
	});

	test('does not fire on a non-constant delta', () => {
		const text = Array.from({ length: 60 }, (_, i) => 0x2100 + i * i).map((v) => '0x' + v.toString(16)).join(', ');
		expect(detectSequenceDrift(text, OPTS)).toBeNull();
	});

	test('does not fire when disabled (minTokens < 2)', () => {
		expect(detectSequenceDrift(hexRun(0x2100, 60), { ...OPTS, minTokens: 1 })).toBeNull();
	});

	test('continuation mode: shorter same-delta run fires at a lower threshold', () => {
		const h = detectSequenceDrift(hexRun(0x2100, 15), { ...OPTS, minTokens: 15 });
		expect(h).not.toBeNull();
		expect(h!.tokens).toBe(15);
	});
});
