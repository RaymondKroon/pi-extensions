import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Handlebars from 'handlebars';

/** The directory of the prompt template files (checked in next to this module so they can be reviewed and edited easily). */
const PROMPTS_DIR = join(import.meta.dirname, 'prompts');
const compiled = new Map<string, HandlebarsTemplateDelegate>();

// Handlebars has no equality helper by default; the prompt templates branch on
// string values (cycle reason, goal phase) with {{#if (eq reason "x")}}.
Handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);

function loadTemplate(name: string): HandlebarsTemplateDelegate {
	let template = compiled.get(name);
	if (template === undefined) {
		let text: string;
		try {
			text = readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf8');
		} catch {
			throw new Error(`Ralph prompt template not found: prompts/${name}.md`);
		}
		// A leading YAML frontmatter block (--- ... ---) documents the template
		// for its authors (description, example call): stripped before
		// compilation, so it never reaches the model.
		const stripped = text.replace(/^---\n[\s\S]*?\n---\n/, '');
		template = Handlebars.compile(stripped.trimEnd(), { noEscape: true, strict: true });
		compiled.set(name, template);
	}
	return template;
}

/**
 * Render a prompt template from the prompts/ directory with Handlebars:
 * `{{name}}` substitutes a variable, `{{#if}}`/`{{else}}`/`{{#each}}` branch
 * and repeat, and `(eq a b)` compares. `noEscape` keeps the text raw (prompts
 * are plain text, not HTML); `strict` makes a missing variable in a taken
 * branch throw — a typo in the template or the variable list must fail loudly,
 * not silently leak into a prompt sent to the model. A leading YAML
 * frontmatter preamble (description, example call) is stripped
 * before compilation. Templates are compiled once and cached.
 */
export function renderPrompt(name: string, vars: Record<string, unknown>): string {
	return loadTemplate(name)(vars);
}

/** Drop the template cache (for tests that swap template files). */
export function clearPromptTemplateCache(): void {
	compiled.clear();
}
