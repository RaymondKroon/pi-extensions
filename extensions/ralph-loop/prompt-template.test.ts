import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearPromptTemplateCache, renderPrompt } from './prompt-template.ts';

describe('prompt-template', () => {
	test('every template file in prompts/ is a non-empty Markdown file', () => {
		const dir = join(import.meta.dirname, 'prompts');
		const files = readdirSync(dir).filter((name) => name.endsWith('.md'));
		expect(files.length).toBeGreaterThan(0);
		for (const name of files) {
			const text = readFileSync(join(dir, name), 'utf8');
			expect(text.trim().length > 0).toBe(true);
		}
	});
	test('every template referenced in index.ts has a file in prompts/', () => {
		const source = readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8');
		const names = [...source.matchAll(/renderPrompt\('([\w-]+)'/g)].map((match) => match[1]!);
		expect(names.length).toBeGreaterThan(0);
		for (const name of new Set(names)) {
			expect(readFileSync(join(import.meta.dirname, 'prompts', `${name}.md`), 'utf8').length > 0).toBe(true);
		}
	});

	test('replaces {{name}} placeholders with the given variables', () => {
		const text = renderPrompt('prefix', {});
		expect(text).toContain('Automated Ralph loop instruction');
	});

	test('renders the iteration template for the ralph loop', () => {
		const text = renderPrompt('iteration', {
			loopWord: 'loop',
			isAuto: false,
			isGoal: false,
			phase: '',
			contextNote: 'CTX',
			category: '',
			backlogNote: 'BLK',
			goalBlock: '',
			categoryScope: ' in category "General"',
			closeStep: 'CLOSE',
			decisionNote: 'DEC'
		});
		expect(text).toContain('Run the Ralph loop for this repository. CTX');
		expect(text).toContain('BLK');
		expect(text).toContain('CLOSE');
		expect(text).toContain('DEC');
		expect(text).not.toContain('{{');
	});

	test('strict mode throws when a variable in a taken branch is missing', () => {
		// Block conditions ({{#if var}}) never throw in strict mode — only a
		// missing variable that a taken branch would print does.
		expect(() =>
			renderPrompt('iteration', {
				loopWord: 'loop',
				isAuto: false,
				isGoal: false,
				phase: '',
				category: '',
				backlogNote: 'BLK',
				goalBlock: '',
				categoryScope: '',
				closeStep: 'CLOSE',
				decisionNote: 'DEC'
			})
		).toThrow(/contextNote/);
	});

	test('strict mode does not throw for a missing variable in a branch not taken', () => {
		const text = renderPrompt('iteration', {
			loopWord: 'loop',
			isAuto: false,
			isGoal: false,
			phase: '',
			contextNote: 'CTX',
			backlogNote: 'BLK',
			categoryScope: '',
			closeStep: 'CLOSE',
			decisionNote: 'DEC'
			// category and goalBlock are intentionally omitted: only the auto
			// and goal branches reference them, and neither is taken.
		});
		expect(text).toContain('Run the Ralph loop for this repository. CTX');
	});

	test('close-step renders all four commit/task combinations', () => {
		const commit = 'Commit the completed task locally in a single commit. Do not push. ';
		const task = 'This is the last step of the iteration: stop working when the commit is made.';
		const budget =
			'After committing, immediately go back to the first step and start the next open task. Keep working task after task: this iteration only ends when you are told to finish up (context budget) or when no open tasks remain. Do not stop after a completed task while open tasks remain.';
		expect(renderPrompt('close-step', { commit: true, task: true })).toBe(`- ${commit}${task}`);
		expect(renderPrompt('close-step', { commit: true, task: false })).toBe(`- ${commit}${budget}`);
		expect(renderPrompt('close-step', { commit: false, task: true })).toBe(`- ${task}`);
		expect(renderPrompt('close-step', { commit: false, task: false })).toBe(`- ${budget}`);
	});

	test('every placeholder in a template referenced in index.ts is provided by its renderPrompt call', () => {
		const source = readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8');
		const calls = [...source.matchAll(/renderPrompt\('([\w-]+)',\s*\{((?:[^{}]|\$\{[^}]*\})*)\}/g)];
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			const name = call[1]!;
			const vars = new Set([...call[2]!.matchAll(/(?:^|[,\n])\s*(\w+)(?=\s*:|\s*,|\s*$)/gm)].map((match) => match[1]!));
			const template = readFileSync(join(import.meta.dirname, 'prompts', `${name}.md`), 'utf8');
			// Handlebars placeholders: simple {{var}} (with optional
			// whitespace-stripping tildes), {{#if var}} and {{else if var}}
			// openers. Helper calls like (eq var "x") are skipped — their
			// arguments are checked by the rendered-output tests instead.
			const placeholders = new Set<string>();
			for (const match of template.matchAll(/\{\{~?\s*([A-Za-z_]\w*)\s*~?\}\}/g)) {
				if (match[1] !== 'else') placeholders.add(match[1]!);
			}
			for (const match of template.matchAll(/\{\{~?\s*#if\s+([A-Za-z_]\w*)/g)) {
				placeholders.add(match[1]!);
			}
			for (const match of template.matchAll(/\{\{~?\s*else if\s+([A-Za-z_]\w*)/g)) {
				placeholders.add(match[1]!);
			}
			for (const placeholder of placeholders) {
				expect(vars.has(placeholder), `template ${name}.md uses {{${placeholder}}} but the renderPrompt call in index.ts does not pass it`).toBe(true);
			}
		}
	});

	test('strips a leading frontmatter preamble before compilation', () => {
		writeFileSync(
			join(import.meta.dirname, 'prompts', 'tmp-preamble-test.md'),
			'---\ndescription: Test template.\nexample_input: |\n  {\n    "inner": "IN"\n  }\n---\nVisible [{{inner}}]'
		);
		try {
			clearPromptTemplateCache();
			const text = renderPrompt('tmp-preamble-test', { inner: 'IN' });
			expect(text).toBe('Visible [IN]');
			expect(text).not.toContain('Test template');
		} finally {
			rmSync(join(import.meta.dirname, 'prompts', 'tmp-preamble-test.md'));
			clearPromptTemplateCache();
		}
	});

	test('every template carries a frontmatter preamble with description and example_input', () => {
		const dir = join(import.meta.dirname, 'prompts');
		for (const name of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
			const lines = readFileSync(join(dir, name), 'utf8').split('\n');
			expect(lines[0], `${name}: first line is not ---`).toBe('---');
			const end = lines.indexOf('---', 1);
			expect(end > 1, `${name}: frontmatter is not closed`).toBe(true);
			const frontmatter = lines.slice(1, end).join('\n');
			expect(frontmatter.includes('description:'), `${name}: frontmatter has no description`).toBe(true);
			expect(frontmatter.includes('example_input:'), `${name}: frontmatter has no example_input`).toBe(true);
		}
	});

	test('does not strip a mid-file comment', () => {
		writeFileSync(join(import.meta.dirname, 'prompts', 'tmp-preamble-test.md'), 'Before <!-- mid note --> after');
		try {
			clearPromptTemplateCache();
			expect(renderPrompt('tmp-preamble-test', {})).toBe('Before <!-- mid note --> after');
		} finally {
			rmSync(join(import.meta.dirname, 'prompts', 'tmp-preamble-test.md'));
			clearPromptTemplateCache();
		}
	});

	test('throws when the template file is missing', () => {
		expect(() => renderPrompt('does-not-exist', {})).toThrow('Ralph prompt template not found: prompts/does-not-exist.md');
	});

	test('trims trailing whitespace from the template', () => {
		const text = renderPrompt('plan-recording', {});
		expect(text.endsWith('\n')).toBe(false);
	});

	test('caches templates until the cache is cleared', () => {
		const first = renderPrompt('prefix', {});
		clearPromptTemplateCache();
		const second = renderPrompt('prefix', {});
		expect(second).toBe(first);
	});
});
