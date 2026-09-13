import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
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

	test('replaces placeholders and keeps surrounding text', () => {
		const text = renderPrompt('iteration-ralph', {
			contextNote: 'CTX',
			backlogNote: 'BLK',
			categoryScope: ' in category "General"',
			ralphCloseStep: 'CLOSE',
			decisionNote: 'DEC'
		});
		expect(text).toContain('Run the Ralph loop for this repository. CTX');
		expect(text).toContain('BLK');
		expect(text).toContain('CLOSE');
		expect(text).toContain('DEC');
		expect(text).not.toContain('{{');
	});

	test('throws when a placeholder has no variable', () => {
		expect(() => renderPrompt('iteration-ralph', {})).toThrow('Missing prompt variable "contextNote"');
	});

	test('every placeholder in a template referenced in index.ts is provided by its renderPrompt call', () => {
		const source = readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8');
		const calls = [...source.matchAll(/renderPrompt\('([\w-]+)',\s*\{((?:[^{}]|\$\{[^}]*\})*)\}/g)];
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			const name = call[1]!;
			const vars = new Set([...call[2]!.matchAll(/^\s*(\w+)(?=\s*:|\s*,|\s*$)/gm)].map((match) => match[1]!));
			const template = readFileSync(join(import.meta.dirname, 'prompts', `${name}.md`), 'utf8');
			for (const placeholder of new Set([...template.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]!))) {
				expect(vars.has(placeholder), `template ${name}.md uses {{${placeholder}}} but the renderPrompt call in index.ts does not pass it`).toBe(true);
			}
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
