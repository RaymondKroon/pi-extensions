/**
 * better-edit — drop-in replacement for pi's built-in `edit` tool.
 *
 * Registers a tool named `edit` (shadowing the built-in) that keeps the
 * built-in schema, atomic all-or-nothing semantics, CRLF/BOM handling, the
 * file-mutation queue, and the TUI renderers, but adds:
 *
 *  1. Indentation-tolerant matching. When exact and built-in fuzzy matching
 *     fail, leading whitespace is ignored (the match must stay unique). If
 *     the model's oldText is uniformly over-indented relative to the file,
 *     newText is re-indented by the same delta so the file keeps consistent
 *     indentation. (Models — especially smaller ones — regularly drift by
 *     one indentation level when regenerating multi-line oldText from
 *     memory, which made the built-in edit tool unusable for them.)
 *
 *  2. Diagnostic errors. When an edit still fails, the error reports which
 *     edits in the batch matched, and for each failed edit shows the closest
 *     region in the file as a line-numbered diff (+ lines are the file's
 *     actual text).
 *
 *  3. Recovery guidelines in the system prompt: copy oldText verbatim from
 *     the file, and resubmit only the edits that failed.
 *
 * The TUI renderer is a port of the built-in one, with the preview computed
 * by the same matching as execution, so the preview and the result agree.
 */
import {
	createEditToolDefinition,
	generateDiffString,
	generateUnifiedPatch,
	renderDiff,
	Theme,
	withFileMutationQueue,
	type EditDiffResult,
	type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { Box, Container, Spacer, Text, getCapabilities, hyperlink, type Component } from '@earendil-works/pi-tui';
import { constants } from 'node:fs';
import { access, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Text helpers (mirror pi core's edit-diff.ts / path-utils.ts, which are not
// exported from the package root).
// ---------------------------------------------------------------------------

function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function splitBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

/** Same normalization as pi core's fuzzy matcher. */
function normalizeForFuzzyMatch(text: string): string {
	return (
		text
			.normalize("NFKC")
			// Strip trailing whitespace per line
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			// Smart single quotes → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Various dashes/hyphens → -
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces → regular space
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

/** Fuzzy normalization plus leading-whitespace stripping (indent-tolerant space). */
function normalizeForIndentMatch(text: string): string {
	return normalizeForFuzzyMatch(text)
		.split("\n")
		.map((line) => line.replace(/^[ \t]+/, ""))
		.join("\n");
}

function leadingWs(line: string): string {
	return line.match(/^[ \t]*/)?.[0] ?? "";
}

/** Mirror of core's resolveToCwd (unicode spaces, @ prefix, ~ expansion). */
function resolveToCwd(filePath: string, cwd: string): string {
	let p = filePath.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") return homedir();
	if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
	return isAbsolute(p) ? p : resolve(cwd, p);
}

function splitLinesWithEndings(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

interface LineSpan {
	start: number;
	end: number;
}

function getLineSpans(content: string): LineSpan[] {
	let offset = 0;
	return splitLinesWithEndings(content).map((line) => {
		const span = { start: offset, end: offset + line.length };
		offset = span.end;
		return span;
	});
}

function getReplacementLineRange(
	lines: LineSpan[],
	matchIndex: number,
	matchLength: number,
): { startLine: number; endLine: number } {
	const replacementStart = matchIndex;
	const replacementEnd = matchIndex + matchLength;
	let startLine = -1;
	for (let i = 0; i < lines.length; i++) {
		if (replacementStart >= lines[i].start && replacementStart < lines[i].end) {
			startLine = i;
			break;
		}
	}
	if (startLine === -1) throw new Error("Replacement range is outside the base content.");
	let endLine = startLine;
	while (endLine < lines.length && lines[endLine].end < replacementEnd) endLine++;
	if (endLine >= lines.length) throw new Error("Replacement range is outside the base content.");
	return { startLine, endLine: endLine + 1 };
}

interface TextReplacement {
	matchIndex: number;
	matchLength: number;
	newText: string;
}

function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
	let result = content;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const r = replacements[i];
		const matchIndex = r.matchIndex - offset;
		result = result.substring(0, matchIndex) + r.newText + result.substring(matchIndex + r.matchLength);
	}
	return result;
}

/**
 * Apply replacements matched against `baseContent` to `originalContent`
 * while preserving unchanged line blocks from the original (mirrors pi core).
 */
function applyReplacementsPreservingUnchangedLines(
	originalContent: string,
	baseContent: string,
	replacements: TextReplacement[],
): string {
	const originalLines = splitLinesWithEndings(originalContent);
	const baseLines = getLineSpans(baseContent);
	if (originalLines.length !== baseLines.length) {
		throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
	}
	const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = [];
	const sorted = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
	for (const replacement of sorted) {
		const range = getReplacementLineRange(baseLines, replacement.matchIndex, replacement.matchLength);
		const current = groups[groups.length - 1];
		if (current && range.startLine < current.endLine) {
			current.endLine = Math.max(current.endLine, range.endLine);
			current.replacements.push(replacement);
			continue;
		}
		groups.push({ ...range, replacements: [replacement] });
	}
	let originalLineIndex = 0;
	let result = "";
	for (const group of groups) {
		result += originalLines.slice(originalLineIndex, group.startLine).join("");
		const groupStartOffset = baseLines[group.startLine].start;
		const groupEndOffset = baseLines[group.endLine - 1].end;
		result += applyReplacements(
			baseContent.slice(groupStartOffset, groupEndOffset),
			group.replacements,
			groupStartOffset,
		);
		originalLineIndex = group.endLine;
	}
	result += originalLines.slice(originalLineIndex).join("");
	return result;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

type Stage = "exact" | "fuzzy" | "indent";

interface Edit {
	oldText: string;
	newText: string;
}

interface MatchedEdit {
	editIndex: number;
	stage: Stage;
	matchIndex: number;
	matchLength: number;
	oldText: string;
	newText: string;
}

function countOccurrences(content: string, needle: string): number {
	return content.split(needle).length - 1;
}

/** Match oldText in content: exact → fuzzy → indent-tolerant. */
function matchEdit(
	content: string,
	fuzzyContent: string,
	indentContent: string,
	oldText: string,
): { stage: Stage; index: number; matchLength: number } | null {
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) return { stage: "exact", index: exactIndex, matchLength: oldText.length };
	const fuzzyOld = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOld);
	if (fuzzyIndex !== -1) return { stage: "fuzzy", index: fuzzyIndex, matchLength: fuzzyOld.length };
	const indentOld = normalizeForIndentMatch(oldText);
	const indentIndex = indentContent.indexOf(indentOld);
	if (indentIndex !== -1) return { stage: "indent", index: indentIndex, matchLength: indentOld.length };
	return null;
}

/**
 * Re-indent newText so the replacement keeps the file's indentation.
 *
 * Models (especially smaller ones) regularly drift by one indentation level
 * when regenerating a multi-line oldText from memory — and generate newText
 * in the same drifted coordinate system. The match is line-aligned, so we
 * can take the file's indentation for every newText line that corresponds to
 * an oldText line.
 *
 * Preconditions (conservative — returns undefined, i.e. "use newText as-is",
 * whenever they are not met):
 *  - the match aligns with line boundaries on both ends;
 *  - every line where the model's oldText indentation differs from the file's
 *    is uniformly *deeper* by the same prefix (the drift scenario); a
 *    shallower or mixed delta means the match may be a false positive.
 *
 * Alignment: each newText line is matched to the best oldText line by word
 * Dice similarity (monotonic, threshold 0.5); matched lines take the file's
 * indentation for the corresponding oldText line, unmatched lines keep the
 * model's own indentation.
 */
function reindentNewText(content: string, baseContent: string, m: MatchedEdit): string | undefined {
	const baseLines = getLineSpans(baseContent);
	const { startLine, endLine } = getReplacementLineRange(baseLines, m.matchIndex, m.matchLength);
	const startsAtLineStart = m.matchIndex === 0 || baseContent[m.matchIndex - 1] === "\n";
	const endsAtLineEnd =
		m.matchIndex + m.matchLength >= baseContent.length || baseContent[m.matchIndex + m.matchLength] === "\n";
	if (!startsAtLineStart || !endsAtLineEnd) return undefined;

	const modelLines = m.oldText.split("\n");
	if (endLine - startLine !== modelLines.length) return undefined;
	const originalLines = splitLinesWithEndings(content);
	const fileRegion = originalLines.slice(startLine, endLine);

	// 1. Uniform over-indentation check.
	let anyDiff = false;
	let delta: string | null = null;
	for (let i = 0; i < modelLines.length; i++) {
		const modelIndent = leadingWs(modelLines[i]);
		const fileIndent = leadingWs(fileRegion[i]);
		if (modelIndent === fileIndent) continue;
		anyDiff = true;
		if (!modelIndent.startsWith(fileIndent)) return undefined;
		const d = modelIndent.slice(fileIndent.length);
		if (delta === null) delta = d;
		else if (delta !== d) return undefined;
	}
	if (!anyDiff || !delta) return undefined;

	// 2. Align newText lines to oldText lines: exact trimmed-content match
	//    first, then word Dice similarity (monotonic, threshold 0.5).
	const newLines = m.newText.split("\n");
	if (modelLines.length > 200 || newLines.length > 200) return undefined;
	const oldTrimmed = modelLines.map((l) => l.trim());
	const newTrimmed = newLines.map((l) => l.trim());
	const oldSets = modelLines.map((l) => wordSet(l.trim()));
	const newSets = newLines.map((l) => wordSet(l.trim()));
	const matchIdx: Array<number | null> = new Array(newLines.length).fill(null);
	let lastI = -1;
	for (let j = 0; j < newLines.length; j++) {
		let bestI = -1;
		let bestScore = 0.5;
		for (let i = lastI + 1; i < modelLines.length; i++) {
			const s = newTrimmed[j] === oldTrimmed[i] ? 1 : wordDice(newSets[j], oldSets[i]);
			if (s > bestScore) {
				bestScore = s;
				bestI = i;
			}
		}
		if (bestI !== -1) {
			matchIdx[j] = bestI;
			lastI = bestI;
		}
	}

	// 3. Matched lines take the file's indentation for the corresponding
	//    oldText line. Unmatched lines (rewritten/inserted) take the
	//    indentation of the oldText line they positionally correspond to: the
	//    first unmatched oldText line between the surrounding matches, or the
	//    nearest matched oldText line for pure insertions.
	const pairs: Array<{ j: number; i: number }> = [];
	for (let j = 0; j < newLines.length; j++) {
		if (matchIdx[j] !== null) pairs.push({ j, i: matchIdx[j]! });
	}
	return newLines
		.map((line, j) => {
			const i = matchIdx[j];
			let targetOld: number | null = i;
			if (i === null) {
				const prev = pairs.filter((p) => p.j < j).pop();
				const next = pairs.find((p) => p.j > j);
				const nextI = next ? next.i : modelLines.length;
				// An oldText line that the model did not carry over (rewritten or
				// dropped) sits between the surrounding matches: the first such
				// line is the best positional guess for this newText line.
				if (prev && prev.i + 1 < nextI) targetOld = prev.i + 1;
				else if (prev) targetOld = prev.i;
				else if (next) targetOld = next.i;
			}
			if (targetOld === null) return line;
			const fileIndent = leadingWs(fileRegion[targetOld]);
			const ws = leadingWs(line);
			return fileIndent + line.slice(ws.length);
		})
		.join("\n");
}

function wordSet(text: string): Map<string, number> {
	const m = new Map<string, number>();
	for (const w of text.toLowerCase().split(/[^a-z0-9_]+/)) {
		if (w) m.set(w, (m.get(w) ?? 0) + 1);
	}
	return m;
}

function wordDice(a: Map<string, number>, b: Map<string, number>): number {
	let inter = 0;
	let sa = 0;
	let sb = 0;
	for (const [w, c] of a) {
		sa += c;
		inter += Math.min(c, b.get(w) ?? 0);
	}
	for (const c of b.values()) sb += c;
	if (sa === 0 || sb === 0) return 0;
	return (2 * inter) / (sa + sb);
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

interface Region {
	startLine: number;
	window: string[];
}

/**
 * Find the region in the file closest to oldText: candidate windows anchored
 * on lines that equal (after trim) a line of oldText, scored by the number of
 * line-equal pairs. All lines are compared in fuzzy-normalized form so
 * Unicode differences do not count as mismatches.
 */
function findClosestRegion(fileLines: string[], oldText: string): Region | null {
	const oldLines = oldText.split("\n");
	const n = oldLines.length;
	if (n === 0 || fileLines.length === 0) return null;
	const candidateStarts = new Set<number>();
	const lineOrder = [
		0,
		n - 1,
		...Array.from({ length: n }, (_, i) => i).sort((a, b) => oldLines[b].trim().length - oldLines[a].trim().length),
	];
	for (const oi of lineOrder) {
		const target = oldLines[oi].trim();
		if (!target) continue;
		for (let li = 0; li < fileLines.length && candidateStarts.size < 200; li++) {
			if (fileLines[li].trim() !== target) continue;
			const start = li - oi;
			if (start >= 0 && start + n <= fileLines.length) candidateStarts.add(start);
		}
	}
	if (candidateStarts.size === 0) {
		// Fallback: no line of oldText appears in the file (e.g. a typo). Anchor
		// on the file lines most similar to the oldText lines.
		const oldSets = oldLines.map((l) => wordSet(l.trim()));
		const fileSets = fileLines.map((l) => wordSet(l.trim()));
		for (const oi of lineOrder) {
			const target = oldLines[oi].trim();
			if (!target) continue;
			for (let li = 0; li < fileLines.length && candidateStarts.size < 200; li++) {
				if (wordDice(oldSets[oi], fileSets[li]) < 0.5) continue;
				const start = li - oi;
				if (start >= 0 && start + n <= fileLines.length) candidateStarts.add(start);
			}
			if (candidateStarts.size > 0) break;
		}
	}
	if (candidateStarts.size === 0) return null;
	let best: { startLine: number; score: number } | null = null;
	for (const start of candidateStarts) {
		let score = 0;
		for (let i = 0; i < n; i++) {
			if (fileLines[start + i].trim() === oldLines[i].trim()) score++;
		}
		if (!best || score > best.score) best = { startLine: start, score };
	}
	if (!best) return null;
	return { startLine: best.startLine, window: fileLines.slice(best.startLine, best.startLine + n) };
}

const MAX_DIFF_PAIRS = 15;

/**
 * Render a compact line-numbered diff of oldText vs the closest file region.
 * Lines are compared exactly (in fuzzy-normalized form), so indentation
 * differences show up as -/+ pairs; lines that differ only in indentation are
 * counted for the hint below.
 */
function renderRegionDiff(oldText: string, region: Region): string[] {
	const oldLines = normalizeForFuzzyMatch(oldText).split("\n");
	const win = region.window;
	const n = oldLines.length;
	const IND = "    ";
	const num = (i: number) => String(region.startLine + i + 1);
	const out: string[] = [`${IND}(- = your oldText, + = file)`];
	let i = 0;
	let diffPairs = 0;
	let indentOnlyPairs = 0;
	// Leading context: show up to 2 lines.
	while (i < n && oldLines[i] === win[i]) {
		if (i < 2) out.push(`${IND} ${num(i)} ${win[i]}`);
		i++;
	}
	if (i > 2) out.push(`${IND}   … (${i - 2} unchanged line(s))`);
	// Body.
	while (i < n) {
		if (oldLines[i] !== win[i]) {
			if (diffPairs >= MAX_DIFF_PAIRS) {
				out.push(`${IND}   … (${n - i} more line(s))`);
				break;
			}
			diffPairs++;
			if (oldLines[i].trim() === win[i].trim()) indentOnlyPairs++;
			out.push(`${IND}- ${oldLines[i]}`);
			out.push(`${IND}+ ${win[i]}`);
			i++;
		} else {
			let j = i;
			while (j < n && oldLines[j] === win[j]) j++;
			const run = j - i;
			if (run <= 2) {
				for (let k = i; k < j; k++) out.push(`${IND} ${num(k)} ${win[k]}`);
			} else if (n - j === 0) {
				for (let k = i; k < i + 2; k++) out.push(`${IND} ${num(k)} ${win[k]}`);
				out.push(`${IND}   … (${run - 2} unchanged line(s))`);
			} else {
				out.push(`${IND}   … (${run} unchanged line(s))`);
			}
			i = j;
		}
	}
	if (diffPairs > 0 && indentOnlyPairs * 2 >= diffPairs) {
		out.push(`${IND}Hint: most differing lines differ only in leading indentation (tabs/spaces). Copy the + lines verbatim.`);
	}
	return out;
}

/** Build the diagnostic error shown to the model when edits do not match. */
function buildDiagnosticError(
	path: string,
	content: string,
	edits: Edit[],
	matches: Array<{ stage: Stage; index: number; matchLength: number } | null>,
): Error {
	const fuzzyLines = normalizeForFuzzyMatch(content).split("\n");
	const lines: string[] = [];
	const failed: number[] = [];
	const okCount = matches.filter(Boolean).length;
	if (edits.length === 1) {
		lines.push(`Could not find the text in ${path}.`);
		failed.push(0);
	} else {
		lines.push(`Could not apply edit to ${path}: ${edits.length - okCount} of ${edits.length} edits did not match.`);
		edits.forEach((_, i) => {
			if (matches[i]) {
				lines.push(`  edits[${i}] OK`);
			} else {
				lines.push(`  edits[${i}] FAIL`);
				failed.push(i);
			}
		});
	}
	for (const i of failed) {
		const oldText = normalizeForFuzzyMatch(normalizeToLF(edits[i].oldText));
		const region = findClosestRegion(fuzzyLines, oldText);
		const label = edits.length === 1 ? "" : `edits[${i}] — `;
		if (region) {
			lines.push(`${label}closest match at line ${region.startLine + 1}:`);
			lines.push(...renderRegionDiff(oldText, region));
		} else {
			lines.push(`${label}no similar region found in the file.`);
		}
	}
	lines.push("");
	lines.push(
		edits.length === 1
			? "Copy the + lines verbatim (they are the file's actual text) and retry."
			: "The matching edits were NOT applied (all-or-nothing). Copy the + lines verbatim (they are the file's actual text), fix the failed oldText(s), and resubmit only the failed edit(s).",
	);
	return new Error(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Apply one or more replacements to LF-normalized content.
 *
 * Matching is exact → fuzzy (pi core's normalization) → indent-tolerant.
 * All edits are matched against the same original content and applied
 * atomically (all-or-nothing), like the built-in.
 */
export function applyEditsEnhanced(
	content: string,
	edits: Edit[],
	path: string,
): { baseContent: string; newContent: string } {
	const normalizedEdits: Edit[] = edits.map((e) => ({
		oldText: normalizeToLF(e.oldText),
		newText: normalizeToLF(e.newText),
	}));
	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw new Error(
				normalizedEdits.length === 1 ? `oldText must not be empty in ${path}.` : `edits[${i}].oldText must not be empty in ${path}.`,
			);
		}
	}
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const indentContent = normalizeForIndentMatch(content);
	const matches = normalizedEdits.map((e) => matchEdit(content, fuzzyContent, indentContent, e.oldText));
	if (matches.some((m) => m === null)) {
		throw buildDiagnosticError(path, content, normalizedEdits, matches);
	}

	// Replacement base = the most-normalized space any edit needs.
	const baseStage: Stage = matches.some((m) => m!.stage === "indent")
		? "indent"
		: matches.some((m) => m!.stage === "fuzzy")
			? "fuzzy"
			: "exact";
	const replacementBase = baseStage === "exact" ? content : baseStage === "fuzzy" ? fuzzyContent : indentContent;

	const matched: MatchedEdit[] = normalizedEdits.map((e, i) => {
		const baseOld =
			baseStage === "exact" ? e.oldText : baseStage === "fuzzy" ? normalizeForFuzzyMatch(e.oldText) : normalizeForIndentMatch(e.oldText);
		const index = replacementBase.indexOf(baseOld);
		if (index === -1) {
			// Should not happen (normalization is monotonic), but stay safe.
			throw new Error(
				normalizedEdits.length === 1
					? `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
					: `Could not find edits[${i}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
			);
		}
		const occurrences = countOccurrences(replacementBase, baseOld);
		if (occurrences > 1) {
			throw new Error(
				normalizedEdits.length === 1
					? `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
					: `Found ${occurrences} occurrences of edits[${i}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
			);
		}
		return {
			editIndex: i,
			stage: matches[i]!.stage,
			matchIndex: index,
			matchLength: baseOld.length,
			oldText: e.oldText,
			newText: e.newText,
		};
	});

	// Re-indent newText for indent-tolerant matches (uniform over-indentation).
	for (const m of matched) {
		if (m.stage !== "indent") continue;
		const reindented = reindentNewText(content, replacementBase, m);
		if (reindented !== undefined) m.newText = reindented;
	}

	const sorted = [...matched].sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < sorted.length; i++) {
		if (sorted[i - 1].matchIndex + sorted[i - 1].matchLength > sorted[i].matchIndex) {
			throw new Error(
				`edits[${sorted[i - 1].editIndex}] and edits[${sorted[i].editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	const baseContent = content;
	const newContent =
		baseStage === "exact"
			? applyReplacements(content, matched, 0)
			: applyReplacementsPreservingUnchangedLines(content, replacementBase, matched);

	if (baseContent === newContent) {
		throw new Error(
			normalizedEdits.length === 1
				? `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
				: `No changes made to ${path}. The replacements produced identical content.`,
		);
	}
	return { baseContent, newContent };
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

function validateEditInput(input: { path?: string; edits?: Edit[] }): { path: string; edits: Edit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path as string, edits: input.edits };
}

export async function enhancedExecute(
	_toolCallId: string,
	input: { path?: string; edits?: Edit[] },
	signal: AbortSignal | undefined,
	_onUpdate: unknown,
	ctx: { cwd?: string } | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: { diff: string; patch: string; firstChangedLine?: number } }> {
	const { path, edits } = validateEditInput(input);
	const absolutePath = resolveToCwd(path, ctx?.cwd ?? process.cwd());
	return withFileMutationQueue(absolutePath, async () => {
		const throwIfAborted = () => {
			if (signal?.aborted) throw new Error("Operation aborted");
		};
		throwIfAborted();
		try {
			await access(absolutePath, constants.R_OK | constants.W_OK);
		} catch (error) {
			throwIfAborted();
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
		}
		throwIfAborted();
		const buffer = await readFile(absolutePath);
		const rawContent = buffer.toString("utf-8");
		throwIfAborted();
		// Strip BOM before matching. The model will not include an invisible BOM in oldText.
		const { bom, text: content } = splitBom(rawContent);
		const originalEnding = detectLineEnding(content);
		const normalizedContent = normalizeToLF(content);
		const { baseContent, newContent } = applyEditsEnhanced(normalizedContent, edits, path);
		throwIfAborted();
		const finalContent = bom + restoreLineEndings(newContent, originalEnding);
		await writeFile(absolutePath, finalContent, "utf-8");
		throwIfAborted();
		const diffResult = generateDiffString(baseContent, newContent);
		const patch = generateUnifiedPatch(path, baseContent, newContent);
		return {
			content: [{ type: "text" as const, text: `Successfully replaced ${edits.length} block(s) in ${path}.` }],
			details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
		};
	});
}

const EXTRA_PROMPT_GUIDELINES = [
	"If an edit fails, the error shows which edits matched and the closest region in the file (+ lines are the file's actual text). Fix the failed oldText(s) and resubmit only the failed edit(s) — never resubmit edits that already matched.",
	"Copy oldText verbatim from the file. If unsure about whitespace, re-read the exact region first (read, or `sed -n 'X,Yp' file | cat -A`); never reconstruct indentation from memory.",
];

// ---------------------------------------------------------------------------
// TUI renderer (port of the built-in edit renderer; the preview is computed
// with the same matching as execution, so the preview and the result agree).
// ---------------------------------------------------------------------------

type EditPreview = EditDiffResult | { error: string };

interface BetterEditCallComponent extends Box {
	preview?: EditPreview;
	previewArgsKey?: string;
	previewPending?: boolean;
	settledError?: boolean;
}

interface BetterEditRenderState {
	callComponent?: BetterEditCallComponent;
}

interface RenderableEditArgs {
	path?: string;
	file_path?: string;
	edits?: Edit[];
	oldText?: string;
	newText?: string;
}

interface EditToolResultLike {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: { diff?: string; patch?: string; firstChangedLine?: number };
}

interface RenderContext<TState, TArgs> {
	args: TArgs;
	lastComponent: unknown;
	state: TState;
	cwd: string;
	argsComplete: boolean;
	isError: boolean;
	invalidate: () => void;
}

/** Compute the diff preview without applying, using the enhanced matching. */
export async function computeEditsPreview(path: string, edits: Edit[], cwd: string): Promise<EditPreview> {
	const absolutePath = resolveToCwd(path, cwd);
	try {
		await access(absolutePath, constants.R_OK);
	} catch (error) {
		const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
		return { error: `Could not edit file: ${path}. ${errorMessage}.` };
	}
	try {
		const rawContent = (await readFile(absolutePath)).toString("utf-8");
		const { text: content } = splitBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const { baseContent, newContent } = applyEditsEnhanced(normalizedContent, edits, path);
		return generateDiffString(baseContent, newContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

function shortenPath(path: string): string {
	if (typeof path !== "string") return "";
	const home = homedir();
	if (path.startsWith(home)) return `~${path.slice(home.length)}`;
	return path;
}

function linkPath(styledText: string, rawPath: string, cwd: string): string {
	if (!getCapabilities().hyperlinks) return styledText;
	const absolutePath = resolveToCwd(rawPath, cwd);
	return hyperlink(styledText, pathToFileURL(absolutePath).href);
}

function renderToolPath(rawPath: string | null, theme: Theme, cwd: string): string {
	if (rawPath === null) return theme.fg("error", "[invalid arg]");
	if (!rawPath) return theme.fg("toolOutput", "...");
	return linkPath(theme.fg("accent", shortenPath(rawPath)), rawPath, cwd);
}

function createEditCallRenderComponent(): BetterEditCallComponent {
	return Object.assign(new Box(1, 1, (text: string) => text), {
		preview: undefined as EditPreview | undefined,
		previewArgsKey: undefined as string | undefined,
		previewPending: false,
		settledError: false,
	});
}

function getEditCallRenderComponent(state: BetterEditRenderState, lastComponent: unknown): BetterEditCallComponent {
	if (lastComponent instanceof Box) {
		state.callComponent = lastComponent as BetterEditCallComponent;
		return state.callComponent;
	}
	if (state.callComponent) return state.callComponent;
	state.callComponent = createEditCallRenderComponent();
	return state.callComponent;
}

function getRenderablePreviewInput(args: RenderableEditArgs | undefined): { path: string; edits: Edit[] } | null {
	if (!args) return null;
	const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
	if (!path) return null;
	if (
		Array.isArray(args.edits) &&
		args.edits.length > 0 &&
		args.edits.every((edit) => typeof edit?.oldText === "string" && typeof edit?.newText === "string")
	) {
		return { path, edits: args.edits };
	}
	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		return { path, edits: [{ oldText: args.oldText, newText: args.newText }] };
	}
	return null;
}

function formatEditCall(args: RenderableEditArgs | undefined, theme: Theme, cwd: string): string {
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	return `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;
}

function formatEditResult(
	args: RenderableEditArgs | undefined,
	preview: EditPreview | undefined,
	result: EditToolResultLike,
	theme: Theme,
	isError: boolean,
): string | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	const previewDiff = preview && !("error" in preview) ? preview.diff : undefined;
	const previewError = preview && "error" in preview ? preview.error : undefined;
	if (isError) {
		const errorText = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("\n");
		if (!errorText || errorText === previewError) {
			return undefined;
		}
		return theme.fg("error", errorText);
	}
	const resultDiff = result.details?.diff;
	if (resultDiff && resultDiff !== previewDiff) {
		return renderDiff(resultDiff, { filePath: rawPath ?? undefined });
	}
	return undefined;
}

function getEditHeaderBg(
	preview: EditPreview | undefined,
	settledError: boolean | undefined,
	theme: Theme,
): (text: string) => string {
	if (preview) {
		if ("error" in preview) return (text: string) => theme.bg("toolErrorBg", text);
		return (text: string) => theme.bg("toolSuccessBg", text);
	}
	if (settledError) return (text: string) => theme.bg("toolErrorBg", text);
	return (text: string) => theme.bg("toolPendingBg", text);
}

function buildEditCallComponent(
	component: BetterEditCallComponent,
	args: RenderableEditArgs | undefined,
	theme: Theme,
	cwd: string,
): BetterEditCallComponent {
	component.setBgFn(getEditHeaderBg(component.preview, component.settledError, theme));
	component.clear();
	component.addChild(new Text(formatEditCall(args, theme, cwd), 0, 0));
	if (!component.preview) return component;
	const body = "error" in component.preview ? theme.fg("error", component.preview.error) : renderDiff(component.preview.diff);
	component.addChild(new Spacer(1));
	component.addChild(new Text(body, 0, 0));
	return component;
}

function setEditPreview(component: BetterEditCallComponent, preview: EditPreview, argsKey: string | undefined): boolean {
	const current = component.preview;
	const changed =
		current === undefined ||
		("error" in current && "error" in preview
			? current.error !== preview.error
			: "error" in current !== "error" in preview) ||
		(!("error" in current) &&
			!("error" in preview) &&
			(current.diff !== preview.diff || current.firstChangedLine !== preview.firstChangedLine));
	component.preview = preview;
	component.previewArgsKey = argsKey;
	component.previewPending = false;
	return changed;
}

export function betterEditRenderCall(
	args: RenderableEditArgs,
	theme: Theme,
	context: RenderContext<BetterEditRenderState, RenderableEditArgs>,
): Component {
	const state = context.state as BetterEditRenderState;
	const component = getEditCallRenderComponent(state, context.lastComponent);
	const previewInput = getRenderablePreviewInput(args);
	const argsKey = previewInput ? JSON.stringify({ path: previewInput.path, edits: previewInput.edits }) : undefined;
	if (component.previewArgsKey !== argsKey) {
		component.preview = undefined;
		component.previewArgsKey = argsKey;
		component.previewPending = false;
		component.settledError = false;
	}
	if (context.argsComplete && previewInput && !component.preview && !component.previewPending) {
		component.previewPending = true;
		const requestKey = argsKey;
		void computeEditsPreview(previewInput.path, previewInput.edits, context.cwd).then((preview) => {
			if (component.previewArgsKey === requestKey) {
				setEditPreview(component, preview, requestKey);
				context.invalidate();
			}
		});
	}
	return buildEditCallComponent(component, args, theme, context.cwd);
}

export function betterEditRenderResult(
	result: EditToolResultLike,
	_options: unknown,
	theme: Theme,
	context: RenderContext<BetterEditRenderState, RenderableEditArgs>,
): Component {
	const state = context.state as BetterEditRenderState;
	const callComponent = state.callComponent;
	const previewInput = getRenderablePreviewInput(context.args as RenderableEditArgs | undefined);
	const argsKey = previewInput ? JSON.stringify({ path: previewInput.path, edits: previewInput.edits }) : undefined;
	const resultDiff = !context.isError ? result.details?.diff : undefined;
	let changed = false;
	if (callComponent) {
		if (typeof resultDiff === "string") {
			changed =
				setEditPreview(
					callComponent,
					{ diff: resultDiff, firstChangedLine: result.details?.firstChangedLine },
					argsKey,
				) || changed;
		}
		if (callComponent.settledError !== context.isError) {
			callComponent.settledError = context.isError;
			changed = true;
		}
		if (changed) {
			buildEditCallComponent(callComponent, context.args as RenderableEditArgs | undefined, theme, context.cwd);
		}
	}
	const output = formatEditResult(context.args as RenderableEditArgs | undefined, callComponent?.preview, result, theme, context.isError);
	const component = (context.lastComponent as Container | undefined) ?? new Container();
	component.clear();
	if (!output) return component;
	component.addChild(new Spacer(1));
	component.addChild(new Text(output, 1, 0));
	return component;
}

export default function betterEdit(pi: ExtensionAPI): void {
	const base = createEditToolDefinition(process.cwd());
	pi.registerTool({
		...base,
		promptGuidelines: [...(base.promptGuidelines ?? []), ...EXTRA_PROMPT_GUIDELINES],
		execute: enhancedExecute,
		renderCall: betterEditRenderCall,
		renderResult: betterEditRenderResult,
	});
}
