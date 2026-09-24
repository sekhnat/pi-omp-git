/**
 * Commit composer operations (docs/pi-omp-git-reference.md §72, §83-85).
 *
 * The composer supports manual messages, editable AI-generated
 * Conventional Commits messages, and amend mode. Execution is verified
 * by repository state: HEAD must move (§83), hooks run normally with
 * their stderr preserved on rejection (§84), and Git signing
 * configuration is respected (§85 — no pinentry workarounds, no silent
 * unsigned retry).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type NestedModel,
	type NestedSessionFactory,
	runNestedAgent,
} from "../github/nested-agent.ts";
import { GitMutationError, PiOmpGitError } from "../shared/errors.ts";
import type { GitRunner } from "./runner.ts";

export interface CommitOpsDeps {
	git: GitRunner;
	cwd: string;
	/** Parent session model for message generation (§72). */
	model?: NestedModel;
	/** Test seam for the nested agent session. */
	createNestedSession?: NestedSessionFactory;
	signal?: AbortSignal;
}

/** Build-in tool names the message generator may use (read-only). */
export const MESSAGE_AGENT_TOOLS = ["read", "grep", "find", "ls"];

/** Recent commit-message examples for style matching (§76). */
export async function collectCommitStyle(
	deps: CommitOpsDeps,
	limit = 12,
): Promise<string[]> {
	const result = await deps.git.run(
		["log", `--max-count=${limit}`, "--format=%s"],
		{ cwd: deps.cwd },
	);
	if (result.exitCode !== 0) return [];
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/**
 * Generate a Conventional Commits message from the staged changes via a
 * nested agent session (§72). The response is plain text; the first
 * line must read `type(scope): summary` style.
 */
export async function generateCommitMessage(
	deps: CommitOpsDeps,
	options: { amend?: boolean } = {},
): Promise<string> {
	const stat = options.amend
		? await deps.git.run(["show", "--stat", "--format=", "HEAD"], {
				cwd: deps.cwd,
			})
		: await deps.git.run(["diff", "--cached", "--stat"], { cwd: deps.cwd });
	const patchLimit = 8000;
	const diff = options.amend
		? await deps.git.run(["show", "--format=", `--max-count=1`, "HEAD"], {
				cwd: deps.cwd,
			})
		: await deps.git.run(["diff", "--cached"], { cwd: deps.cwd });
	const style = await collectCommitStyle(deps);

	const sections: string[] = [];
	sections.push(
		options.amend
			? "Rewrite the commit message for the commit currently at HEAD (amend)."
			: "Write a commit message for the staged changes.",
	);
	if (stat.stdout.trim()) sections.push(`\nFiles:\n${stat.stdout.trim()}`);
	if (diff.stdout.trim()) {
		const patch =
			diff.stdout.length > patchLimit
				? `${diff.stdout.slice(0, patchLimit)}\n… (truncated)`
				: diff.stdout;
		sections.push(`\nPatch:\n${patch}`);
	}
	if (style.length > 0) {
		sections.push(`\nRecent commit subjects for style:\n${style.join("\n")}`);
	}
	sections.push(
		"",
		"Respond with the commit message only: a Conventional Commits subject line",
		'("type(scope): summary", imperative, specific), optionally followed by a',
		"blank line and a short body. Plain text only — no code fences, no",
		"alternatives, no explanation.",
	);

	const run = await runNestedAgent({
		cwd: deps.cwd,
		prompt: sections.join("\n"),
		tools: MESSAGE_AGENT_TOOLS,
		model: deps.model,
		signal: deps.signal,
		createSession: deps.createNestedSession,
	});
	const message = normalizeCommitMessage(run.text);
	if (!message) {
		throw new PiOmpGitError(
			"The nested agent returned no usable commit message.",
		);
	}
	return message;
}

/** Trim fences and blank padding; keep the first paragraph block. */
export function normalizeCommitMessage(text: string): string {
	const cleaned = text
		.replace(/```[a-z]*\n?/gi, "")
		.split("\n")
		.map((line) => line.replace(/\s+$/, ""));
	while (cleaned.length > 0 && cleaned[0] === "") cleaned.shift();
	while (cleaned.length > 0 && cleaned[cleaned.length - 1] === "")
		cleaned.pop();
	// Reject obviously non-message responses (explanations, options).
	const subject = cleaned[0] ?? "";
	if (!subject || /^[0-9]+\.\s/.test(subject) || subject.startsWith("- ")) {
		return "";
	}
	return cleaned.join("\n");
}

export interface CommitOutcome {
	/** The new HEAD SHA. */
	head: string;
	/** Short SHA for display. */
	short: string;
	amend: boolean;
}

/**
 * Execute `git commit` (or `--amend`) and verify success by repository
 * state: HEAD must move (§83). Hooks run normally (§84); a rejection
 * preserves the hook's stderr. Signing configuration is inherited
 * unchanged (§85).
 */
export async function executeCommit(
	deps: CommitOpsDeps,
	options: { message: string; amend?: boolean },
): Promise<CommitOutcome> {
	const message = options.message.replace(/\s+$/, "");
	if (!message) {
		throw new GitMutationError("The commit message is empty.");
	}
	const headBefore = await deps.git.run(["rev-parse", "HEAD"], {
		cwd: deps.cwd,
	});
	if (headBefore.exitCode !== 0) {
		throw new GitMutationError(
			`git rev-parse HEAD failed: ${(headBefore.stderr || "").trim().slice(0, 300)}`,
		);
	}

	const dir = await mkdtemp(join(tmpdir(), "pi-omp-git-commit-"));
	const file = join(dir, "COMMIT_MSG");
	try {
		// `-F <file>` keeps the message verbatim (no editor, no mangling).
		await writeFile(file, `${message}\n`, "utf8");
		// git's default cleanup mode applies; `-F` keeps the message verbatim.
		const argv = ["commit", "-F", file];
		if (options.amend) argv.push("--amend");
		const result = await deps.git.run(argv, { cwd: deps.cwd });
		if (result.exitCode !== 0) {
			throw commitFailure(result);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}

	const headAfter = await deps.git.run(["rev-parse", "HEAD"], {
		cwd: deps.cwd,
	});
	const after = headAfter.exitCode === 0 ? headAfter.stdout.trim() : "";
	if (!after) {
		throw new GitMutationError(
			"Could not read HEAD after the commit — repository state is unclear.",
		);
	}
	if (after === headBefore.stdout.trim()) {
		throw new GitMutationError(
			"The commit did not change HEAD; the repository state does not prove a commit occurred.",
		);
	}
	return { head: after, short: after.slice(0, 8), amend: !!options.amend };
}

/** Preserve hook stderr and identify the failed step (§84). */
export function commitFailure(result: {
	exitCode: number | null;
	stderr: string;
	stdout: string;
}): PiOmpGitError {
	const raw = `${result.stderr}\n${result.stdout}`;
	const lines = raw
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("hint:"));
	// Identify the failing hook step when git names one.
	const hookMatch = /([\w./-]+)\.hook/.exec(raw);
	const step = hookMatch ? `hook ${hookMatch[1]}` : "the commit step";
	const details = lines.slice(0, 8).join("\n");
	const bounded = details.length > 800 ? `${details.slice(0, 800)}…` : details;
	return new GitMutationError(
		`Commit failed at ${step} (exit ${result.exitCode ?? "signal"}):\n${bounded}`,
	);
}
