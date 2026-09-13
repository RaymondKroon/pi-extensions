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

	test('replaces repeated placeholders and keeps surrounding text', () => {
		const text = renderPrompt('iteration-markdown', {
			contextNote: 'CTX',
			decisionNote: 'DEC',
			ralphCloseStep: 'CLOSE',
			todoPath: '/tmp/todo.md'
		});
		expect(text).toContain('Read /tmp/todo.md in full.');
		expect(text).toContain('update /tmp/todo.md:');
		expect(text).not.toContain('{{');
	});

	test('throws when a placeholder has no variable', () => {
		expect(() => renderPrompt('context-checkpoint-markdown', {})).toThrow('Missing prompt variable "todoPath"');
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
