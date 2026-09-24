/**
 * Changelog integration (docs/pi-omp-git-reference.md §81).
 *
 * Unless disabled, the pipeline identifies the project changelog and
 * proposes a corresponding entry that is committed as part of an
 * appropriate commit — never a hidden unrelated mutation. A missing
 * changelog is not an error. The entry respects the configured diff
 * budget (changelogMaxDiffChars).
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommitProposal } from "./commit-plan.ts";

/** Candidate changelog file names, in priority order. */
export const CHANGELOG_CANDIDATES = [
	"CHANGELOG.md",
	"CHANGELOG",
	"changelog.md",
	"HISTORY.md",
];

export interface ChangelogPlan {
	path: string;
	entry: string;
}

/**
 * Find the project changelog at the repository root. Absence is not an
 * error — the caller plans without a changelog entry.
 */
export function findChangelog(root: string): string | undefined {
	for (const candidate of CHANGELOG_CANDIDATES) {
		const path = join(root, candidate);
		if (existsSync(path) && statIsFile(path)) return candidate;
	}
	return undefined;
}

/**
 * Build the changelog entry deterministically from the proposal
 * (deterministic preview, bounded by the configured budget). Returns
 * undefined when there is no changelog or the entry would be empty.
 */
export function buildChangelogEntry(
	root: string,
	commits: CommitProposal[],
	maxChars: number,
): ChangelogPlan | undefined {
	const name = findChangelog(root);
	if (!name) return undefined;
	const lines = commits.map((commit) => {
		const scope = commit.scope ? `(${commit.scope})` : "";
		const summary = commit.summary.trim();
		return `- ${commit.type}${scope}: ${summary}`;
	});
	const entry = lines.join("\n");
	if (!entry) return undefined;
	const bounded =
		entry.length > maxChars
			? `${entry.slice(0, Math.max(0, maxChars - 1))}…`
			: entry;
	return { path: name, entry: bounded };
}

/**
 * Apply the changelog entry to the file: under an existing
 * `## Unreleased` section when present, otherwise as a new one directly
 * after the document title, otherwise at the top of the file. Returns
 * the full new file content.
 */
export function applyChangelogEntry(root: string, plan: ChangelogPlan): void {
	const path = join(root, plan.path);
	const current = readFileSync(path, "utf8");
	writeFileSync(path, insertEntry(current, plan.entry), "utf8");
}

export function insertEntry(content: string, entry: string): string {
	const lines = content.split("\n");
	const unreleased = lines.findIndex((line) =>
		/^##\s+Unreleased\b/i.test(line),
	);
	if (unreleased >= 0) {
		// Insert after the heading (and any immediately following blank line).
		let insertAt = unreleased + 1;
		while (insertAt < lines.length && lines[insertAt] === "") insertAt += 1;
		lines.splice(insertAt, 0, ...entry.split("\n"), "");
		return lines.join("\n");
	}
	// After a top-level title if the file starts with one.
	if (lines[0]?.startsWith("# ")) {
		let insertAt = 1;
		while (insertAt < lines.length && lines[insertAt] === "") insertAt += 1;
		lines.splice(insertAt, 0, "## Unreleased", "", ...entry.split("\n"), "");
		return lines.join("\n");
	}
	return `${["## Unreleased", "", ...entry.split("\n"), ""].join("\n")}\n${content}`;
}

function statIsFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}
