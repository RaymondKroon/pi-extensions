import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import betterEdit, {
	applyEditsEnhanced,
	betterEditRenderCall,
	betterEditRenderResult,
	computeEditsPreview,
	enhancedExecute,
} from './index.ts';
import { Box, Container } from '@earendil-works/pi-tui';
import { initTheme } from '@earendil-works/pi-coding-agent';

const FIXTURES = join(import.meta.dir, 'fixtures');

describe('applyEditsEnhanced — built-in behavior preserved', () => {
	test('exact match', () => {
		const { newContent } = applyEditsEnhanced('hello world\n', [{ oldText: 'hello', newText: 'goodbye' }], 'f.ts');
		expect(newContent).toBe('goodbye world\n');
	});

	test('fuzzy match: smart quotes (built-in fuzzy stage)', () => {
		const { newContent } = applyEditsEnhanced("it’s fine\n", [{ oldText: "it's fine", newText: 'ok' }], 'f.ts');
		expect(newContent).toBe('ok\n');
	});

	test('multiple disjoint edits in one call', () => {
		const { newContent } = applyEditsEnhanced('a b c d\n', [
			{ oldText: 'a', newText: '1' },
			{ oldText: 'd', newText: '2' },
		], 'f.ts');
		expect(newContent).toBe('1 b c 2\n');
	});

	test('duplicate oldText is rejected', () => {
		expect(() => applyEditsEnhanced('x x\n', [{ oldText: 'x', newText: 'y' }], 'f.ts')).toThrow(/occurrences/);
	});

	test('overlapping edits are rejected', () => {
		expect(() =>
			applyEditsEnhanced('abc\n', [
				{ oldText: 'ab', newText: 'x' },
				{ oldText: 'bc', newText: 'y' },
			], 'f.ts'),
		).toThrow(/overlap/);
	});

	test('empty oldText is rejected', () => {
		expect(() => applyEditsEnhanced('abc\n', [{ oldText: '', newText: 'x' }], 'f.ts')).toThrow(/must not be empty/);
	});

	test('no-change is rejected', () => {
		expect(() => applyEditsEnhanced('abc\n', [{ oldText: 'abc', newText: 'abc' }], 'f.ts')).toThrow(/No changes made/);
	});

	test('mid-line exact match is a plain substring replacement (built-in semantics)', () => {
		const { newContent } = applyEditsEnhanced('foo bar\nbaz\n', [{ oldText: 'bar\nbaz', newText: 'qux' }], 'f.ts');
		expect(newContent).toBe('foo qux\n');
	});
});

describe('applyEditsEnhanced — indentation-tolerant matching', () => {
	test('model over-indented by one tab: edit succeeds and file indentation is kept', () => {
		const file = "\t\tpromptGuidelines: [\n\t\t\t'Use ralph_request_decision instead of guessing.'\n\t\t],\n";
		const oldText = "\t\tpromptGuidelines: [\n\t\t\t\t'Use ralph_request_decision instead of guessing.'\n\t\t\t],";
		const newText = "\t\tpromptGuidelines: [\n\t\t\t\t'New wording.'\n\t\t\t],";
		// Sanity: neither exact nor built-in fuzzy matching can find this.
		expect(file.includes(oldText)).toBe(false);
		const { newContent } = applyEditsEnhanced(file, [{ oldText, newText }], 'f.ts');
		expect(newContent).toBe("\t\tpromptGuidelines: [\n\t\t\t'New wording.'\n\t\t],\n");
	});

	test('model under-indented with different whitespace (spaces vs tabs): edit succeeds, newText used as-is', () => {
		const file = "\t'line one'\n";
		const oldText = "  'line one'";
		const newText = "  'line two'";
		const { newContent } = applyEditsEnhanced(file, [{ oldText, newText }], 'f.ts');
		expect(newContent).toBe("  'line two'\n");
	});

	test('non-uniform delta: edit succeeds, newText used as-is', () => {
		const file = "\t'a'\n\t\t\t'b'\n";
		const oldText = "\t\t'a'\n\t\t\t\t'b'";
		const newText = "\t\t'x'\n\t\t\t\t'y'";
		const { newContent } = applyEditsEnhanced(file, [{ oldText, newText }], 'f.ts');
		expect(newContent).toBe("\t\t'x'\n\t\t\t\t'y'\n");
	});

	test('tabs vs spaces drift: edit succeeds', () => {
		const file = "\tfoo();\n";
		const oldText = '    foo();';
		const newText = '    bar();';
		const { newContent } = applyEditsEnhanced(file, [{ oldText, newText }], 'f.ts');
		expect(newContent).toBe('    bar();\n');
	});

	test('duplicate in indent space is rejected', () => {
		const file = "\t\tx();\n\tx();\n";
		expect(() => applyEditsEnhanced(file, [{ oldText: '  x();', newText: 'x2();' }], 'f.ts')).toThrow(/occurrences/);
	});

	test('partial drift: only first line drifted; rewritten line takes the next oldText line file indentation', () => {
		// Live case from the 2026-09-05 smoke run: the model drifted only the
		// `description:` line (+1 tab) and rewrote the description string.
		const file = "\t\tdescription:\n\t\t\t'old long description',\n\t\tpromptSnippet: 'x',\n";
		const oldText = "\t\t\tdescription:\n\t\t\t'old long description',";
		const newText = "\t\t\tdescription:\n\t\t\t'new short description',";
		const { newContent } = applyEditsEnhanced(file, [{ oldText, newText }], 'f.ts');
		expect(newContent).toBe("\t\tdescription:\n\t\t\t'new short description',\n\t\tpromptSnippet: 'x',\n");
	});

	test('session regression: ralph_goal block from the 2026-09-05 session', () => {
		const oldText = readFileSync(join(FIXTURES, 'session-oldtext.txt'), 'utf-8');
		const newText = readFileSync(join(FIXTURES, 'session-newtext.txt'), 'utf-8');
		const region = readFileSync(join(FIXTURES, 'session-file-region.txt'), 'utf-8');
		const file = `\tpi.registerTool({\n\t\tname: 'ralph_goal',\n${region}\n\t\t\tparameters: Type.Object({\n\t\t\t}),\n\t});\n`;
		// Sanity: the built-in exact match fails on this input.
		expect(file.includes(oldText)).toBe(false);

		const { newContent } = applyEditsEnhanced(file, [{ oldText, newText }], 'index.ts');

		// The replacement must use the file's indentation (2t/3t), not the
		// model's drifted indentation (3t/4t).
		expect(newContent).toContain("\t\tpromptSnippet: 'Read/update the Ralph goal',");
		expect(newContent).toContain('\t\tpromptGuidelines: [');
		expect(newContent).toContain("\t\t\t'ralph_goal complete requires a full verification run of every SPEC.md command with evidence; never claim an unverified completion.',");
		expect(newContent).toContain("\t\t\t'After the user answers a completion approval: approved → record the decision, call ralph_resolve_decision, then ralph_goal confirm; rejected → ralph_goal withdraw with what is missing, then keep working.'");
		expect(newContent).toContain('\n\t\t],\n\t\t\tparameters:');
		// The new (rewritten) description is present.
		expect(newContent).toContain("'Read/update the single goal of the Ralph backlog (active loop\\'s backlog, else TODO.ralph).");
		// Surrounding context is untouched.
		expect(newContent).toContain("\tpi.registerTool({\n\t\tname: 'ralph_goal',");
		expect(newContent).toContain('\t\t\tparameters: Type.Object({\n\t\t\t}),\n\t});\n');
	});
});

describe('applyEditsEnhanced — diagnostic errors', () => {
	const file = [
		'function alpha() {',
		'\treturn 1;',
		'}',
		'',
		'function beta() {',
		'\treturn 2;',
		'}',
		'',
	].join('\n');

	test('single edit: closest region with line numbers and + lines', () => {
		try {
			applyEditsEnhanced(file, [{ oldText: 'function alfa() {\n\treturn 1;\n}', newText: 'x' }], 'f.ts');
			expect.unreachable('should have thrown');
		} catch (err) {
			const msg = (err as Error).message;
			expect(msg).toContain('Could not find the text in f.ts');
			expect(msg).toContain('closest match at line 1');
			expect(msg).toContain('(- = your oldText, + = file)');
			expect(msg).toContain('- function alfa() {');
			expect(msg).toContain('+ function alpha() {');
			expect(msg).toContain('Copy the + lines verbatim');
		}
	});

	test('batch: per-edit status and all-or-nothing notice', () => {
		try {
			applyEditsEnhanced(
				file,
				[
					{ oldText: 'function alpha() {', newText: 'function alpha2() {' },
					{ oldText: 'function alfa() {', newText: 'x' },
					{ oldText: 'function beta() {', newText: 'function beta2() {' },
				],
				'f.ts',
			);
			expect.unreachable('should have thrown');
		} catch (err) {
			const msg = (err as Error).message;
			expect(msg).toContain('1 of 3 edits did not match');
			expect(msg).toContain('edits[0] OK');
			expect(msg).toContain('edits[1] FAIL');
			expect(msg).toContain('edits[2] OK');
			expect(msg).toContain('closest match at line 1');
			expect(msg).toContain('- function alfa() {');
			expect(msg).toContain('+ function alpha() {');
			expect(msg).toContain('NOT applied (all-or-nothing)');
			expect(msg).toContain('resubmit only the failed edit(s)');
		}
	});

	test('indent-only near-miss gets the indentation hint', () => {
		// Two lines differ only in indentation, one line differs in content:
		// the indent-tolerant match fails because of the content difference,
		// and the diagnostic should point at the indentation.
		const f = "\t'a'\n\t\t'b'\n\t'c'\n";
		try {
			applyEditsEnhanced(f, [{ oldText: "  'a'\n    'b'\n  'z'", newText: 'x' }], 'f.ts');
			expect.unreachable('should have thrown');
		} catch (err) {
			const msg = (err as Error).message;
			expect(msg).toContain('closest match at line 1');
			expect(msg).toContain('differ only in leading indentation');
		}
	});

	test('no similar region: says so', () => {
		try {
			applyEditsEnhanced(file, [{ oldText: 'completely different text', newText: 'x' }], 'f.ts');
			expect.unreachable('should have thrown');
		} catch (err) {
			expect((err as Error).message).toContain('no similar region found');
		}
	});
});

describe('enhancedExecute — end to end', () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'better-edit-'));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test('applies an exact edit and reports success', async () => {
		const p = join(dir, 'a.txt');
		await writeFile(p, 'hello world\n');
		const result = await enhancedExecute('1', { path: p, edits: [{ oldText: 'hello', newText: 'goodbye' }] }, undefined, undefined, { cwd: dir });
		expect(result.content[0].text).toBe(`Successfully replaced 1 block(s) in ${p}.`);
		expect(await readFile(p, 'utf-8')).toBe('goodbye world\n');
		expect(result.details.diff).toContain('-1 hello world');
		expect(result.details.diff).toContain('+1 goodbye world');
	});

	test('applies an indent-drifted edit and keeps file indentation', async () => {
		const p = join(dir, 'b.ts');
		await writeFile(p, "\t\tpromptGuidelines: [\n\t\t\t'old'\n\t\t],\n");
		const result = await enhancedExecute(
			'1',
			{ path: p, edits: [{ oldText: "\t\tpromptGuidelines: [\n\t\t\t\t'old'\n\t\t\t],", newText: "\t\tpromptGuidelines: [\n\t\t\t\t'new'\n\t\t\t]," }] },
			undefined,
			undefined,
			{ cwd: dir },
		);
		expect(result.content[0].text).toContain('Successfully replaced');
		expect(await readFile(p, 'utf-8')).toBe("\t\tpromptGuidelines: [\n\t\t\t'new'\n\t\t],\n");
	});

	test('failed edit leaves the file untouched and returns the diagnostic', async () => {
		const p = join(dir, 'c.ts');
		await writeFile(p, 'function alpha() {\n\treturn 1;\n}\n');
		let err: Error | undefined;
		try {
			await enhancedExecute(
				'1',
				{ path: p, edits: [{ oldText: 'function alfa() {\n\treturn 1;\n}', newText: 'x' }] },
				undefined,
				undefined,
				{ cwd: dir },
			);
		} catch (e) {
			err = e as Error;
		}
		expect(err).toBeDefined();
		expect(err!.message).toContain('closest match at line 1');
		expect(err!.message).toContain('+ function alpha() {');
		expect(await readFile(p, 'utf-8')).toBe('function alpha() {\n\treturn 1;\n}\n');
	});

	test('preserves CRLF line endings', async () => {
		const p = join(dir, 'd.txt');
		await writeFile(p, 'line one\r\nline two\r\n');
		await enhancedExecute('1', { path: p, edits: [{ oldText: 'line one', newText: 'line uno' }] }, undefined, undefined, { cwd: dir });
		expect(await readFile(p, 'utf-8')).toBe('line uno\r\nline two\r\n');
	});

	test('preserves BOM', async () => {
		const p = join(dir, 'e.txt');
		await writeFile(p, '\uFEFFhello\n');
		await enhancedExecute('1', { path: p, edits: [{ oldText: 'hello', newText: 'world' }] }, undefined, undefined, { cwd: dir });
		expect(await readFile(p, 'utf-8')).toBe('\uFEFFworld\n');
	});

	test('relative paths resolve against ctx.cwd', async () => {
		const p = join(dir, 'rel.txt');
		await writeFile(p, 'abc\n');
		await enhancedExecute('1', { path: 'rel.txt', edits: [{ oldText: 'abc', newText: 'xyz' }] }, undefined, undefined, { cwd: dir });
		expect(await readFile(p, 'utf-8')).toBe('xyz\n');
	});

	test('missing file error matches the built-in format', async () => {
		let err: Error | undefined;
		try {
			await enhancedExecute('1', { path: join(dir, 'nope.txt'), edits: [{ oldText: 'a', newText: 'b' }] }, undefined, undefined, { cwd: dir });
		} catch (e) {
			err = e as Error;
		}
		expect(err!.message).toContain('Could not edit file');
	});
});

describe('computeEditsPreview — TUI preview uses enhanced matching', () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'better-edit-preview-'));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test('exact edit: preview shows the diff', async () => {
		const p = join(dir, 'a.txt');
		await writeFile(p, 'hello world\n');
		const preview = await computeEditsPreview(p, [{ oldText: 'hello', newText: 'goodbye' }], dir);
		expect('error' in preview).toBe(false);
		expect((preview as { diff: string }).diff).toContain('goodbye');
	});

	test('indent-drifted edit: preview shows the diff, not a false error', async () => {
		const p = join(dir, 'b.ts');
		await writeFile(p, "\t\tpromptGuidelines: [\n\t\t\t'old'\n\t\t],\n");
		const preview = await computeEditsPreview(
			p,
			[{ oldText: "\t\tpromptGuidelines: [\n\t\t\t\t'old'\n\t\t\t],", newText: "\t\tpromptGuidelines: [\n\t\t\t\t'new'\n\t\t\t]," }],
			dir,
		);
		expect('error' in preview).toBe(false);
		expect((preview as { diff: string }).diff).toContain('new');
	});

	test('genuine mismatch: preview shows the diagnostic error', async () => {
		const p = join(dir, 'c.ts');
		await writeFile(p, 'function alpha() {\n\treturn 1;\n}\n');
		const preview = await computeEditsPreview(p, [{ oldText: 'function alfa() {\n\treturn 1;\n}', newText: 'x' }], dir);
		expect('error' in preview).toBe(true);
		expect((preview as { error: string }).error).toContain('closest match at line 1');
	});
});

describe('renderer', () => {
	beforeAll(() => {
		// The exported renderDiff uses the global theme singleton, which the
		// TUI initializes at startup.
		initTheme('dark');
	});
	const theme = {
		fg: (_c: string, t: string) => t,
		bg: (_c: string, t: string) => t,
		bold: (t: string) => t,
		inverse: (t: string) => t,
	} as never;

	test('renderCall renders and computes the preview asynchronously', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'better-edit-render-'));
		try {
			const p = join(dir, 'd.ts');
			await writeFile(p, "\t\tpromptGuidelines: [\n\t\t\t'old'\n\t\t],\n");
			const args = {
				path: p,
				edits: [{ oldText: "\t\tpromptGuidelines: [\n\t\t\t\t'old'\n\t\t\t],", newText: "\t\tpromptGuidelines: [\n\t\t\t\t'new'\n\t\t\t]," }],
			};
			const state: Record<string, unknown> = {};
			let invalidated = 0;
			const component = betterEditRenderCall(args, theme, {
				args,
				lastComponent: undefined,
				state,
				cwd: dir,
				argsComplete: true,
				isError: false,
				invalidate: () => invalidated++,
			} as never);
			expect(component).toBeInstanceOf(Box);
			await new Promise((r) => setTimeout(r, 150));
			const callComponent = state.callComponent as { preview?: { diff?: string; error?: string } } | undefined;
			expect(callComponent?.preview).toBeDefined();
			expect(callComponent?.preview?.error).toBeUndefined();
			expect(callComponent?.preview?.diff).toContain('new');
			expect(invalidated).toBeGreaterThanOrEqual(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('renderResult renders without error', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'better-edit-render2-'));
		try {
			const p = join(dir, 'e.ts');
			await writeFile(p, 'hello\n');
			const args = { path: p, edits: [{ oldText: 'hello', newText: 'world' }] };
			const state: Record<string, unknown> = {};
			const callCtx = { args, lastComponent: undefined, state, cwd: dir, argsComplete: true, isError: false, invalidate: () => {} } as never;
			const callComponent = betterEditRenderCall(args, theme, callCtx);
			// In the real TUI the result slot's lastComponent is its own
			// Container (or undefined on first render) — not the call component.
			const resultComponent = betterEditRenderResult(
				{ content: [{ type: 'text', text: `Successfully replaced 1 block(s) in ${p}.` }], details: { diff: '-1 hello\n+1 world', patch: '' } },
				{},
				theme,
				{ ...callCtx, lastComponent: undefined, isError: false } as never,
			);
			expect(resultComponent).toBeInstanceOf(Container);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe('extension entry', () => {
	test('registers a tool named edit with the recovery guidelines', () => {
		const registered: unknown[] = [];
		const pi = { registerTool: (tool: unknown) => registered.push(tool) };
		betterEdit(pi as never);
		expect(registered).toHaveLength(1);
		const tool = registered[0] as Record<string, unknown>;
		expect(tool.name).toBe('edit');
		expect(typeof tool.execute).toBe('function');
		const guidelines = tool.promptGuidelines as string[];
		expect(guidelines.some((g) => g.includes('resubmit only the failed edit(s)'))).toBe(true);
		expect(guidelines.some((g) => g.includes('never reconstruct indentation from memory'))).toBe(true);
		// Built-in guidelines are kept.
		expect(guidelines.some((g) => g.includes('Use edit for precise changes'))).toBe(true);
		// Built-in schema is kept.
		expect(tool.parameters).toBeDefined();
	});
});
