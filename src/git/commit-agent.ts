/**
 * The commit agent (docs/pi-omp-git-reference.md §75–§78, ADR 0004).
 *
 * A nested headless session with a narrow tool surface — git_overview,
 * git_file_diff, git_hunk, analyze_files, propose_commit,
 * propose_split_commit — and never a shell. One pipeline implementation
 * serves two hosts: the `/commit` command in-process and the
 * `pi-omp-git commit` binary standalone. The default model is the
 * current session's model unless overridden.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
	type NestedModel,
	type NestedSessionFactory,
	runNestedAgent,
} from "../github/nested-agent.ts";
import { PiOmpGitError } from "../shared/errors.ts";
import type { CommitProposal, SplitCommitProposal } from "./commit-plan.ts";
import { parseUnifiedDiff } from "./diff.ts";
import type { GitRunner } from "./runner.ts";

export const COMMIT_AGENT_TOOLS = [
	"git_overview",
	"git_file_diff",
	"git_hunk",
	"analyze_files",
	"propose_commit",
	"propose_split_commit",
] as const;

export interface OverviewFile {
	path: string;
	/** Staged / unstaged classification from the preparation phase. */
	staged: boolean;
	unstaged: boolean;
	untracked: boolean;
}

export interface CommitAgentContext {
	branch?: string;
	head?: string;
	/** The changed set the plan must cover (repo-root-relative). */
	changedFiles: OverviewFile[];
	/** Diffstat of the operating view. */
	diffStat: string;
	/** Recent commit subjects for style matching (§76). */
	recentSubjects: string[];
	/** Full patch of the operating view (bounded). */
	patch: string;
	/** User-supplied extra context (§73 --context). */
	extraContext?: string;
}

export interface AnalyzeFilesSettings {
	enabled: boolean;
	maxFiles: number;
	maxConcurrency: number;
	/** Dry-run optimization (§82): skip expensive per-file subagents. */
	allowInDryRun: boolean;
	dryRun: boolean;
}

export interface CommitAgentDeps {
	git: GitRunner;
	cwd: string;
	context: CommitAgentContext;
	analyze: AnalyzeFilesSettings;
	model?: NestedModel;
	createNestedSession?: NestedSessionFactory;
	signal?: AbortSignal;
	/** Sub-agent seam for analyze_files fan-out tests. */
	analyzeRunner?: (paths: string[]) => Promise<string>;
}

export interface CommitAgentResult {
	single?: CommitProposal;
	split?: SplitCommitProposal;
}

const PROPOSAL_SCHEMA = Type.Object({
	type: Type.String(),
	scope: Type.Optional(Type.String()),
	summary: Type.String(),
	body: Type.Optional(Type.String()),
	files: Type.Array(Type.String()),
});

const SPLIT_SCHEMA = Type.Object({
	commits: Type.Array(PROPOSAL_SCHEMA),
});

const FILE_DIFF_SCHEMA = Type.Object({ path: Type.String() });
const HUNK_SCHEMA = Type.Object({ path: Type.String(), hunk: Type.Integer() });
const ANALYZE_SCHEMA = Type.Object({ paths: Type.Array(Type.String()) });

type ProposalParams = Static<typeof PROPOSAL_SCHEMA>;
type SplitParams = Static<typeof SPLIT_SCHEMA>;

/**
 * Run the commit agent once. Exactly one of `single`/`split` is
 * returned; a run without any proposal fails (§100 "proposal absent").
 */
export async function runCommitAgent(
	deps: CommitAgentDeps,
): Promise<CommitAgentResult> {
	const recorded: {
		single?: CommitProposal;
		split?: SplitCommitProposal;
	} = {};

	const paths = deps.context.changedFiles.map((file) => file.path);
	const known = new Set(paths);

	const overviewText = renderOverview(deps.context);

	const tools: ToolDefinition[] = [
		{
			name: "git_overview",
			label: "Git overview",
			description:
				"Repository overview: branch, HEAD, changed files with staged/unstaged classification, diffstat, and recent commit-message style.",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: overviewText }],
				details: undefined,
			}),
		},
		{
			name: "git_file_diff",
			label: "Git file diff",
			description: "Return one changed file's patch from the operating view.",
			parameters: FILE_DIFF_SCHEMA,
			execute: async (_id, params: Static<typeof FILE_DIFF_SCHEMA>) => {
				if (!known.has(params.path)) {
					return toolError(`${params.path} is not part of the changes.`);
				}
				const patch = await filePatch(deps.git, deps.cwd, params.path);
				return {
					content: [{ type: "text", text: patch || "(no diff)" }],
					details: undefined,
				};
			},
		},
		{
			name: "git_hunk",
			label: "Git hunk",
			description:
				"Return one precise hunk (0-based) of a changed file's patch.",
			parameters: HUNK_SCHEMA,
			execute: async (_id, params: Static<typeof HUNK_SCHEMA>) => {
				if (!known.has(params.path)) {
					return toolError(`${params.path} is not part of the changes.`);
				}
				const patch = await filePatch(deps.git, deps.cwd, params.path);
				const hunks = parseUnifiedDiff(patch).hunks;
				const hunk = hunks[params.hunk];
				if (!hunk) {
					return toolError(
						`${params.path} has no hunk ${params.hunk} (it has ${hunks.length}).`,
					);
				}
				const text = [
					hunk.header,
					...hunk.lines.map((line) =>
						line.kind === "add"
							? `+${line.text}`
							: line.kind === "del"
								? `-${line.text}`
								: ` ${line.text}`,
					),
				].join("\n");
				return {
					content: [{ type: "text", text }],
					details: undefined,
				};
			},
		},
		{
			name: "analyze_files",
			label: "Analyze files",
			description:
				"Delegate detailed semantic analysis of selected files to sub-agents. Use sparingly (§76).",
			parameters: ANALYZE_SCHEMA,
			execute: async (_id, params: Static<typeof ANALYZE_SCHEMA>) => {
				if (!deps.analyze.enabled) {
					return toolError("analyze_files is disabled by configuration.");
				}
				if (deps.analyze.dryRun && !deps.analyze.allowInDryRun) {
					return {
						content: [
							{
								type: "text",
								text: "analyze_files is skipped in dry-run (dryRunAnalyzeFiles: false); plan from the overview and diffs.",
							},
						],
						details: undefined,
					};
				}
				const requested = [...new Set(params.paths)].filter((path) =>
					known.has(path),
				);
				if (requested.length === 0) {
					return toolError("analyze_files received no valid paths.");
				}
				if (requested.length > deps.analyze.maxFiles) {
					return toolError(
						`analyze_files is capped at ${deps.analyze.maxFiles} files per call (analyzeFilesMaxFiles).`,
					);
				}
				const summaries = await analyzeFiles(deps, requested);
				return {
					content: [{ type: "text", text: summaries }],
					details: undefined,
				};
			},
		},
		{
			name: "propose_commit",
			label: "Propose commit",
			description:
				"Propose one commit covering every change: type, optional scope, imperative summary, optional body, and the files it contains.",
			parameters: PROPOSAL_SCHEMA,
			execute: async (_id, params: ProposalParams) => {
				if (recorded.single || recorded.split) {
					return toolError("A proposal was already recorded.");
				}
				recorded.single = params;
				return {
					content: [{ type: "text", text: "Proposal recorded." }],
					details: undefined,
				};
			},
		},
		{
			name: "propose_split_commit",
			label: "Propose split commit",
			description:
				"Propose multiple coherent commits for unrelated changes. File-level: every path in exactly one commit, covering every changed file.",
			parameters: SPLIT_SCHEMA,
			execute: async (_id, params: SplitParams) => {
				if (recorded.single || recorded.split) {
					return toolError("A proposal was already recorded.");
				}
				recorded.split = params;
				return {
					content: [{ type: "text", text: "Split proposal recorded." }],
					details: undefined,
				};
			},
		},
	];

	const prompt = buildCommitPrompt();
	await runNestedAgent({
		cwd: deps.cwd,
		prompt,
		tools: [],
		customTools: tools,
		model: deps.model,
		signal: deps.signal,
		createSession: deps.createNestedSession,
	});

	if (!recorded.single && !recorded.split) {
		throw new PiOmpGitError("The commit agent did not propose a commit plan.");
	}
	if (recorded.single && recorded.split) {
		throw new PiOmpGitError(
			"The commit agent proposed both a single and a split plan.",
		);
	}
	return { single: recorded.single, split: recorded.split };
}

function toolError(message: string): {
	content: Array<{ type: "text"; text: string }>;
	details: undefined;
} {
	return {
		content: [{ type: "text", text: `Error: ${message}` }],
		details: undefined,
	};
}

/** Per-file patch of the operating view (staged or combined). */
async function filePatch(
	git: GitRunner,
	cwd: string,
	path: string,
): Promise<string> {
	// The staged view is the operating view; untracked files staged by
	// compatibility mode appear here too. Fall back to the combined view
	// for dry-run analysis (index untouched).
	const staged = await git.run(["diff", "--cached", "--", path], { cwd });
	if ((staged.exitCode ?? 99) === 0 && staged.stdout.trim()) {
		return staged.stdout;
	}
	const combined = await git.run(["diff", "HEAD", "--", path], { cwd });
	return combined.stdout;
}

function renderOverview(context: CommitAgentContext): string {
	const lines: string[] = [];
	lines.push(`Branch: ${context.branch ?? "(detached)"}`);
	if (context.head) lines.push(`HEAD: ${context.head}`);
	lines.push("", "Changed files:");
	for (const file of context.changedFiles) {
		const flags = [
			file.staged ? "staged" : null,
			file.unstaged ? "unstaged" : null,
			file.untracked ? "untracked" : null,
		]
			.filter(Boolean)
			.join("+");
		lines.push(`- ${file.path} (${flags})`);
	}
	if (context.diffStat.trim()) {
		lines.push("", "Diffstat:", context.diffStat.trim());
	}
	if (context.recentSubjects.length > 0) {
		lines.push(
			"",
			"Recent commit subjects (style reference):",
			...context.recentSubjects.map((subject) => `- ${subject}`),
		);
	}
	if (context.patch.trim()) {
		const limit = 6000;
		const patch =
			context.patch.length > limit
				? `${context.patch.slice(0, limit)}\n… (truncated — use git_file_diff for details)`
				: context.patch;
		lines.push("", "Patch:", patch);
	}
	if (context.extraContext?.trim()) {
		lines.push("", "User context:", context.extraContext.trim());
	}
	return lines.join("\n");
}

function buildCommitPrompt(): string {
	return [
		"Plan the commit(s) for the current changes in this repository.",
		"",
		"Procedure: call git_overview first, inspect relevant diffs with",
		"git_file_diff / git_hunk, and match the repository's existing commit",
		"style. Use analyze_files only when a diff is unusually large, its",
		"semantic intent is unclear, or several independent concerns need",
		"classification (§76) — never one call per file blindly.",
		"",
		"Then call propose_commit once for a single logical change, or",
		"propose_split_commit for unrelated logical changes. Requirements:",
		"- file-level assignment: every changed path in exactly one commit;",
		"- every changed path covered;",
		"- each commit independently coherent, ordering respects dependencies;",
		"- summaries imperative, specific, never generic;",
		"- Conventional Commits type (feat, fix, docs, chore, ...), optional",
		"  scope, optional body.",
		"",
		"Never run shell commands; only the listed tools exist.",
	].join("\n");
}

/** Bounded analyze_files fan-out (§76, divergence D5). */
async function analyzeFiles(
	deps: CommitAgentDeps,
	paths: string[],
): Promise<string> {
	if (deps.analyzeRunner) {
		return deps.analyzeRunner(paths);
	}
	const concurrency = Math.max(1, deps.analyze.maxConcurrency);
	const results = new Map<string, string>();
	let index = 0;
	const workers = Array.from(
		{ length: Math.min(concurrency, paths.length) },
		() =>
			(async () => {
				while (index < paths.length) {
					const current = paths[index];
					index += 1;
					if (current === undefined) continue;
					results.set(current, await analyzeOne(deps, current));
				}
			})(),
	);
	await Promise.all(workers);
	return paths
		.map((path) => `### ${path}\n${results.get(path) ?? "(no analysis)"}`)
		.join("\n\n");
}

async function analyzeOne(
	deps: CommitAgentDeps,
	path: string,
): Promise<string> {
	const patch = await filePatch(deps.git, deps.cwd, path);
	const run = await runNestedAgent({
		cwd: deps.cwd,
		prompt: [
			`Analyze the change to ${path} and summarize its semantic intent.`,
			"",
			patch || "(no diff)",
			"",
			"Respond with 3-6 short bullet lines about intent and side effects.",
			"Plain text only.",
		].join("\n"),
		tools: [],
		model: deps.model,
		signal: deps.signal,
		createSession: deps.createNestedSession,
	});
	return run.text.trim() || "(no analysis)";
}
