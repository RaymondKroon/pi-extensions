/**
 * Measures the per-turn context cost of the ralph-loop extension (v8:
 * deferred tool loading) in both states: idle (no loop — only ralph_enable
 * active) and active (loop running — all ralph tools active).
 *
 * Counts (o200k BPE via gpt-tokenizer when installed, chars/4 fallback):
 *  1. Tool definitions (name + description + parameter schema) sent to the model API.
 *  2. The full system prompt built by pi's real buildSystemPrompt.
 *  3. One-time cost of reading the bundled reference doc.
 *
 * Usage: bun measure-context.ts
 */
// o200k BPE when gpt-tokenizer is installed (dev-only, not a package dep);
// chars/4 fallback otherwise.
let tok: (s: string) => number;
try {
	const { countTokens } = await import('gpt-tokenizer');
	tok = (s) => countTokens(s);
} catch {
	tok = (s) => Math.ceil(s.length / 4);
}
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import ext from './index.ts';

const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve('@earendil-works/pi-coding-agent/package.json'));
const { buildSystemPrompt } = await import(join(pkgDir, 'dist/core/system-prompt.js'));

type CapturedTool = {
	name: string;
	description: string;
	parameters: unknown;
	promptSnippet?: string;
	promptGuidelines?: string[];
};

const tools: CapturedTool[] = [];
const pi = {
	registerTool: (t: CapturedTool) => tools.push(t),
	registerCommand: () => {},
	on: () => {},
	sendMessage: () => {},
	sendUserMessage: () => {},
	appendEntry: () => {},
	getActiveTools: () => [],
	setActiveTools: () => {}
} as never;

ext(pi);

const baseSnippets: Record<string, string> = { read: 'Read a file', bash: 'Run a shell command', edit: 'Edit a file', write: 'Write a file' };

/** Full system prompt for a given set of active tools. */
const promptFor = (activeNames: string[]) => {
	const active = tools.filter((t) => activeNames.includes(t.name));
	const toolSnippets: Record<string, string> = { ...baseSnippets };
	const guidelines: string[] = [];
	for (const t of active) {
		if (t.promptSnippet) toolSnippets[t.name] = t.promptSnippet;
		guidelines.push(...(t.promptGuidelines ?? []));
	}
	return buildSystemPrompt({
		selectedTools: ['read', 'bash', 'edit', 'write', ...active.map((t) => t.name)],
		toolSnippets,
		promptGuidelines: guidelines,
		cwd: '/home/user/project'
	});
};

const toolDefsFor = (activeNames: string[]) => {
	let total = 0;
	for (const t of tools.filter((t) => activeNames.includes(t.name))) {
		total += tok(JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }));
	}
	return total;
};

const ralphNames = tools.filter((t) => t.name !== 'ralph_enable').map((t) => t.name);
const builtinNames = ['read', 'bash', 'edit', 'write'];
const idleNames = [...builtinNames, 'ralph_enable']; // ralph_enable is always active
const activeNames = [...idleNames, ...ralphNames];

const baseTok = tok(promptFor(builtinNames)); // pi base, no ralph at all
const idleTok = tok(promptFor(idleNames));
const activeTok = tok(promptFor(activeNames));

console.log('=== Tool definitions (per API request) ===');
for (const t of tools) {
	const n = tok(JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }));
	const always = t.name === 'ralph_enable' ? ' (always active)' : '';
	console.log(`  ${t.name.padEnd(24)} ${String(n).padStart(5)} tok${always}`);
}

console.log('\n=== Full system prompt (pi real buildSystemPrompt) ===');
console.log(`  base pi prompt (4 tools):      ${String(baseTok).padStart(5)} tok`);
console.log(`  idle (only ralph_enable):      ${String(idleTok).padStart(5)} tok  (delta ${idleTok - baseTok})`);
console.log(`  active (loop running):         ${String(activeTok).padStart(5)} tok  (delta ${activeTok - baseTok})`);

const refPath = join(import.meta.dirname, 'docs', 'ralph-backlog.md');
const refTok = tok(readFileSync(refPath, 'utf8'));

console.log('\n=== Per-turn totals (tool defs + full system prompt) ===');
console.log(`  idle:   ${toolDefsFor(idleNames) + idleTok} tok  (ralph-attributable: ${toolDefsFor(idleNames) + (idleTok - baseTok)})`);
console.log(`  active: ${toolDefsFor(activeNames) + activeTok} tok  (ralph-attributable: ${toolDefsFor(activeNames) + (activeTok - baseTok)})`);
console.log(`  one-time reference doc read:   ${refTok} tok  (${refPath})`);
