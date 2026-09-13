import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The directory of the prompt template files (checked in next to this module so they can be reviewed and edited easily). */
const PROMPTS_DIR = join(import.meta.dirname, 'prompts');
const templates = new Map<string, string>();

function loadTemplate(name: string): string {
	let template = templates.get(name);
	if (template === undefined) {
		let text: string;
		try {
			text = readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf8');
		} catch {
			throw new Error(`Ralph prompt template not found: prompts/${name}.md`);
		}
		template = text.trimEnd();
		templates.set(name, template);
	}
	return template;
}

/**
 * Render a prompt template from the prompts/ directory: every `{{name}}`
 * placeholder is replaced with the corresponding variable. The template is
 * read once and cached. Throws when a placeholder has no variable — a typo in
 * the template or the variable list must fail loudly, not silently leak into
 * a prompt sent to the model.
 */
export function renderPrompt(name: string, vars: Record<string, string>): string {
	return loadTemplate(name).replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
		const value = vars[key];
		if (value === undefined) {
			throw new Error(`Missing prompt variable "${key}" for template "${name}"`);
		}
		return value;
	});
}

/** Drop the template cache (for tests that swap template files). */
export function clearPromptTemplateCache(): void {
	templates.clear();
}
