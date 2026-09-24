/**
 * Commit plan structures (docs/pi-omp-git-reference.md §77–§78).
 *
 * Proposals are file-level in this release: every selected path belongs
 * to at most one commit, every intended change belongs to a commit, and
 * a file containing unrelated concerns is placed in its dominant commit
 * (hunk-level assignment is a recorded non-goal).
 */

import { PiOmpGitError } from "../shared/errors.ts";

export interface CommitProposal {
	/** Conventional Commits type, e.g. feat, fix, chore. */
	type: string;
	scope?: string;
	/** Imperative, specific summary. */
	summary: string;
	body?: string;
	/** Repo-root-relative paths, each in exactly one commit of a plan. */
	files: string[];
}

export interface SplitCommitProposal {
	commits: CommitProposal[];
}

/** Render the final message from structured data (§77). */
export function renderCommitMessage(proposal: CommitProposal): string {
	const scope = proposal.scope ? `${proposal.scope}` : undefined;
	const head = scope
		? `${proposal.type}(${scope}): ${proposal.summary}`
		: `${proposal.type}: ${proposal.summary}`;
	const body = proposal.body?.trim();
	return body ? `${head}\n\n${body}` : head;
}

/**
 * Validate a single proposal against the changed set: files must be
 * non-empty, known, and cover every intended change.
 */
export function validateSingleProposal(
	proposal: CommitProposal,
	changedFiles: string[],
): CommitProposal {
	assertProposalShape(proposal);
	const known = new Set(changedFiles);
	const files = [...new Set(proposal.files)];
	for (const file of files) {
		if (!known.has(file)) {
			throw new PiOmpGitError(
				`The commit proposal references ${file}, which is not part of the changes.`,
			);
		}
	}
	const missing = changedFiles.filter((file) => !files.includes(file));
	if (missing.length > 0) {
		throw new PiOmpGitError(
			`The commit proposal does not cover: ${missing.join(", ")}.`,
		);
	}
	return { ...proposal, files };
}

/**
 * Validate a split proposal: file-level assignment (a path in at most
 * one commit), full coverage, coherent entries, and a sane order.
 */
export function validateSplitProposal(
	proposal: SplitCommitProposal,
	changedFiles: string[],
): SplitCommitProposal {
	if (!Array.isArray(proposal.commits) || proposal.commits.length === 0) {
		throw new PiOmpGitError("The split proposal contains no commits.");
	}
	for (const commit of proposal.commits) {
		assertProposalShape(commit);
	}
	const seen = new Map<string, number>();
	for (const [index, commit] of proposal.commits.entries()) {
		if (commit.files.length === 0) {
			throw new PiOmpGitError(
				`Commit ${index + 1} of the split proposal lists no files.`,
			);
		}
		for (const file of commit.files) {
			const previous = seen.get(file);
			if (previous !== undefined) {
				throw new PiOmpGitError(
					`${file} is assigned to multiple commits (commit ${previous + 1} and ${index + 1}); split plans are file-level.`,
				);
			}
			seen.set(file, index);
		}
	}
	const covered = [...seen.keys()];
	const missing = changedFiles.filter((file) => !covered.includes(file));
	if (missing.length > 0) {
		throw new PiOmpGitError(
			`The split proposal does not cover: ${missing.join(", ")}.`,
		);
	}
	const unknown = covered.filter((file) => !changedFiles.includes(file));
	for (const file of unknown) {
		throw new PiOmpGitError(
			`The split proposal references ${file}, which is not part of the changes.`,
		);
	}
	return { commits: proposal.commits.map((commit) => ({ ...commit })) };
}

function assertProposalShape(proposal: CommitProposal): void {
	if (!proposal || typeof proposal !== "object") {
		throw new PiOmpGitError("The commit proposal is not an object.");
	}
	if (typeof proposal.type !== "string" || proposal.type.trim() === "") {
		throw new PiOmpGitError("The commit proposal has no type.");
	}
	if (typeof proposal.summary !== "string" || proposal.summary.trim() === "") {
		throw new PiOmpGitError("The commit proposal has no summary.");
	}
	if (!Array.isArray(proposal.files)) {
		throw new PiOmpGitError("The commit proposal has no file list.");
	}
}

/** One displayed plan entry: message plus its files. */
export interface PlanEntry {
	message: string;
	files: string[];
	changelog?: boolean;
}

/**
 * Render the plan shown before execution (§78 interactive display, §82
 * dry run): messages, grouping, and the changelog plan.
 */
export function renderPlan(
	entries: PlanEntry[],
	options: { changelogPath?: string; changelogEntry?: string } = {},
): string {
	const lines: string[] = [];
	entries.forEach((entry, index) => {
		const label =
			entries.length === 1
				? "Commit"
				: `Commit ${index + 1} of ${entries.length}`;
		lines.push(`${label}: ${entry.message.split("\n")[0]}`);
		if (entry.message.includes("\n")) {
			for (const line of entry.message.split("\n").slice(1)) {
				if (line.trim()) lines.push(`  ${line}`);
			}
		}
		for (const file of entry.files) lines.push(`  - ${file}`);
		if (entry.changelog && options.changelogPath) {
			lines.push(`  - ${options.changelogPath} (changelog entry)`);
		}
	});
	if (options.changelogEntry && options.changelogPath) {
		lines.push(
			`Changelog plan — ${options.changelogPath}:\n${options.changelogEntry
				.split("\n")
				.map((line) => `  ${line}`)
				.join("\n")}`,
		);
	}
	if (options.changelogPath && !options.changelogEntry) {
		lines.push(
			`Changelog: none (${options.changelogPath} not found or disabled).`,
		);
	}
	return lines.join("\n");
}
