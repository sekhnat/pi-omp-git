/**
 * The agentic `/commit` pipeline (docs/pi-omp-git-reference.md §73–§86).
 *
 * One pipeline implementation, two hosts (ADR 0004): the `/commit`
 * command runs it in-process and the `pi-omp-git commit` binary runs it
 * standalone. The commit correctness contract (§83) is absolute: a
 * non-dry-run run returns exactly one of "commits were created",
 * "failure", or "definitively no changes" — never a printed proposal
 * with exit success and no commit.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	NestedModel,
	NestedSessionFactory,
} from "../github/nested-agent.ts";
import type { GhRunner } from "../github/runner.ts";
import { PiOmpGitError } from "../shared/errors.ts";
import {
	type AnalyzeFilesSettings,
	type OverviewFile,
	runCommitAgent,
} from "./commit-agent.ts";
import {
	applyChangelogEntry,
	buildChangelogEntry,
	findChangelog,
} from "./commit-changelog.ts";
import {
	executeSingleCommit,
	executeSplitCommits,
	statusSnapshot,
	verifyConservation,
} from "./commit-execute.ts";
import {
	type PlanEntry,
	renderCommitMessage,
	renderPlan,
	validateSingleProposal,
	validateSplitProposal,
} from "./commit-plan.ts";
import { pushBranch } from "./commit-push.ts";
import type { GitRunner } from "./runner.ts";
import { parseStatusV2 } from "./status-model.ts";

export interface CommitPipelineDeps {
	git: GitRunner;
	/** Required for `--push` on PR branches (§86); unused otherwise. */
	gh: GhRunner;
	cwd: string;
	model?: NestedModel;
	createNestedSession?: NestedSessionFactory;
	signal?: AbortSignal;
	/** §76/§78/§81/§82 settings. */
	settings: {
		splitPolicy: "confirm" | "auto" | "never";
		analyzeFilesEnabled: boolean;
		analyzeFilesMaxFiles: number;
		analyzeFilesMaxConcurrency: number;
		changelog: boolean;
		changelogMaxDiffChars: number;
		dryRunAnalyzeFiles: boolean;
	};
	/** Test seam for transient files. */
	tempDir?: string;
	/** Test seam for analyze_files fan-out (§76). */
	analyzeRunner?: (paths: string[]) => Promise<string>;
}

export interface CommitPipelineOptions {
	dryRun?: boolean;
	push?: boolean;
	noChangelog?: boolean;
	context?: string;
	/**
	 * Interactive confirmation for split plans (§78 splitPolicy confirm).
	 * The host decides how to ask; noninteractive hosts without a
	 * confirmation path fail explicitly rather than guessing from a TTY.
	 */
	confirmPlan?: (plan: string) => Promise<boolean>;
}

export type CommitPipelineOutcome = "committed" | "no-changes" | "dry-run";

export interface CommitPipelineResult {
	outcome: CommitPipelineOutcome;
	commits: Array<{ short: string; subject: string; files: string[] }>;
	usedCompatibilityStaging: boolean;
	push?: { pushed: boolean; report: string };
	/** The rendered plan (always present for dry-run). */
	plan: string;
	text: string;
}

/**
 * Run the full pipeline. Throws PiOmpGitError subclasses on failure;
 * the §83 contract holds by construction: either commits exist (HEAD
 * moved), the call threw, or the tree was definitively clean.
 */
export async function runCommitPipeline(
	deps: CommitPipelineDeps,
	options: CommitPipelineOptions,
): Promise<CommitPipelineResult> {
	const dryRun = options.dryRun === true;
	// §74 preparation: root, HEAD, branch, staged/unstaged/untracked.
	const root = await gitOut(deps, ["rev-parse", "--show-toplevel"]);
	const head = await gitOut(deps, ["rev-parse", "HEAD"]);
	const branch = await gitOut(deps, ["branch", "--show-current"]);
	const status = await statusSnapshot({
		git: deps.git,
		cwd: deps.cwd,
		tempDir: deps.tempDir,
	});

	// Reuse the porcelain v2 parser (space-separated fields; untracked
	// entries arrive in the unstaged list with state "?").
	const parsed = parseStatusV2(status.join("\n"));
	const stagedFiles = parsed.staged.map((file) => file.path);
	const untracked = parsed.unstaged
		.filter((file) => file.state === "?")
		.map((file) => file.path);
	const unstagedOnly = parsed.unstaged
		.filter(
			(file) =>
				file.state !== "?" &&
				!parsed.staged.some((entry) => entry.path === file.path),
		)
		.map((file) => file.path);
	if (parsed.conflicts.length > 0) {
		// Conflicts abort the pipeline with a clear error.
		throw new PiOmpGitError(
			`The repository has unresolved conflicts (${parsed.conflicts[0]?.path ?? ""}) — resolve them before committing.`,
		);
	}

	// §74: a clean working tree must not produce a fake commit.
	if (
		stagedFiles.length === 0 &&
		unstagedOnly.length === 0 &&
		untracked.length === 0
	) {
		let text =
			"Nothing to commit: the working tree is clean — no commit was created.";
		let push: CommitPipelineResult["push"];
		if (options.push && !dryRun) {
			// §86: still push already-created local commits, or report why not.
			// (Dry-run never pushes, §82.)
			push = await pushBranch(
				{ git: deps.git, gh: deps.gh, cwd: deps.cwd },
				{ branch, hasCommits: false },
				deps.signal,
			);
			text += `\n${push.report}`;
		}
		return {
			outcome: "no-changes",
			commits: [],
			usedCompatibilityStaging: false,
			plan: "",
			...(push ? { push } : {}),
			text,
		};
	}

	// §74 compatibility staging: nothing staged but a dirty tree. Never in
	// dry-run (divergence D1) — dry-run reads the combined view instead.
	let usedCompatibilityStaging = false;
	if (stagedFiles.length === 0 && !dryRun) {
		const add = await deps.git.run(["add", "-A", "."], { cwd: root });
		if ((add.exitCode ?? 99) !== 0) {
			throw new PiOmpGitError(
				`Staging all changes failed: ${(add.stderr || "").trim().slice(0, 300)}`,
			);
		}
		usedCompatibilityStaging = true;
		// Re-derive the changed set from the freshly staged index.
		const restaged = await statusSnapshot({
			git: deps.git,
			cwd: deps.cwd,
			tempDir: deps.tempDir,
		});
		const restagedParsed = parseStatusV2(restaged.join("\n"));
		stagedFiles.length = 0;
		for (const file of restagedParsed.staged) stagedFiles.push(file.path);
	}

	// The operating view the agent plans over: the staged set, or the
	// combined view (diff HEAD + untracked) for the dry-run compat case
	// where nothing may be staged (D1).
	const operatingPaths =
		dryRun && stagedFiles.length === 0
			? [...stagedFiles, ...unstagedOnly, ...untracked]
			: stagedFiles;
	const changedFiles: OverviewFile[] = operatingPaths.map((path) => ({
		path,
		staged: stagedFiles.includes(path),
		unstaged:
			unstagedOnly.includes(path) ||
			(untracked.includes(path) && stagedFiles.length === 0),
		untracked: untracked.includes(path),
	}));
	const statView = dryRun
		? await deps.git.run(["diff", "HEAD", "--stat"], { cwd: root })
		: await deps.git.run(["diff", "--cached", "--stat"], { cwd: root });
	const patchView = dryRun
		? await deps.git.run(["diff", "HEAD"], { cwd: root })
		: await deps.git.run(["diff", "--cached"], { cwd: root });
	const styleView = await deps.git.run(
		["log", "--max-count=12", "--format=%s"],
		{ cwd: root },
	);

	const analyze: AnalyzeFilesSettings = {
		enabled: deps.settings.analyzeFilesEnabled,
		maxFiles: deps.settings.analyzeFilesMaxFiles,
		maxConcurrency: deps.settings.analyzeFilesMaxConcurrency,
		allowInDryRun: deps.settings.dryRunAnalyzeFiles,
		dryRun,
	};

	const agent = await runCommitAgent({
		git: deps.git,
		cwd: deps.cwd,
		context: {
			...(branch ? { branch } : {}),
			...(head ? { head } : {}),
			changedFiles,
			diffStat: statView.stdout,
			recentSubjects: styleView.stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0),
			patch: patchView.stdout,
			...(options.context ? { extraContext: options.context } : {}),
		},
		analyze,
		model: deps.model,
		createNestedSession: deps.createNestedSession,
		signal: deps.signal,
		...(deps.analyzeRunner ? { analyzeRunner: deps.analyzeRunner } : {}),
	});

	// Normalize the proposal into ordered groups (§77/§78).
	let groups: Array<{ message: string; files: string[] }>;
	if (agent.single) {
		const validated = validateSingleProposal(agent.single, operatingPaths);
		groups = [{ ...validated, message: renderCommitMessage(validated) }];
	} else if (agent.split) {
		const validated = validateSplitProposal(agent.split, operatingPaths);
		let commits = validated.commits;
		if (deps.settings.splitPolicy === "never") {
			// Never split: one commit, first message, all files.
			const first = validated.commits[0];
			if (!first) {
				throw new PiOmpGitError("The split proposal contains no commits.");
			}
			commits = [{ ...first, files: operatingPaths }];
		}
		groups = commits.map((commit) => ({
			...commit,
			message: renderCommitMessage(commit),
		}));
	} else {
		throw new PiOmpGitError("The commit agent returned no usable proposal.");
	}

	// §81 changelog: proposed within an appropriate commit (the first).
	// Missing changelog is not an error; disabled or dry-run plans skip it.
	const changelogName = findChangelog(root);
	const proposalList = agent.single
		? [agent.single]
		: (agent.split?.commits ?? []);
	const changelogPlan =
		changelogName && !options.noChangelog && deps.settings.changelog
			? buildChangelogEntry(
					root,
					proposalList,
					deps.settings.changelogMaxDiffChars,
				)
			: undefined;

	const planEntries: PlanEntry[] = groups.map((group, index) => ({
		message: group.message,
		files: group.files,
		...(index === 0 && changelogPlan ? { changelog: true } : {}),
	}));
	const planText = renderPlan(planEntries, {
		...(changelogPlan
			? {
					changelogPath: changelogPlan.path,
					changelogEntry: changelogPlan.entry,
				}
			: { changelogPath: changelogName }),
	});

	// §82 dry-run: print the full plan; execute nothing.
	if (dryRun) {
		const header = usedCompatibilityStaging
			? "Dry run (nothing staged, committed, or pushed):"
			: "Dry run:";
		return {
			outcome: "dry-run",
			commits: [],
			usedCompatibilityStaging,
			plan: planText,
			text: `${header}\n${planText}`,
		};
	}

	// §78: split plans with policy confirm need explicit approval. A host
	// without a confirmation path fails explicitly — never TTY sniffing.
	if (
		!agent.single &&
		deps.settings.splitPolicy === "confirm" &&
		groups.length > 1
	) {
		if (!options.confirmPlan) {
			throw new PiOmpGitError(
				"commit.splitPolicy is 'confirm': a split plan needs interactive approval. Configure 'auto' or 'never', or run /commit in the TUI.",
			);
		}
		const approved = await options.confirmPlan(planText);
		if (!approved) {
			throw new PiOmpGitError(
				"The split plan was not approved — nothing was committed.",
			);
		}
	}

	// Execute (§79): transactional for splits; changelog joins the first.
	const executeDeps = {
		git: deps.git,
		cwd: deps.cwd,
		...(deps.tempDir ? { tempDir: deps.tempDir } : {}),
		signal: deps.signal,
	};
	const before = await statusSnapshot(executeDeps);
	const dir =
		deps.tempDir ?? (await mkdtemp(join(tmpdir(), "pi-omp-git-pipeline-")));
	const ownsDir = !deps.tempDir;
	try {
		let executed: Array<{ short: string; subject: string; files: string[] }>;
		if (groups.length === 1) {
			if (changelogPlan) {
				applyChangelogEntry(root, changelogPlan);
				const add = await deps.git.run(
					["add", "-A", "--", changelogPlan.path],
					{ cwd: root },
				);
				if ((add.exitCode ?? 99) !== 0) {
					throw new PiOmpGitError(
						`Staging the changelog failed: ${(add.stderr || "").trim().slice(0, 300)}`,
					);
				}
			}
			const firstGroup = groups[0];
			if (!firstGroup) {
				throw new PiOmpGitError("The plan contains no commits.");
			}
			const single = await executeSingleCommit(
				executeDeps,
				firstGroup.message,
				firstGroup.files,
			);
			executed = [single];
		} else {
			const split = await executeSplitCommits(executeDeps, {
				groups,
				...(changelogPlan
					? {
							preStageFirst: async () => {
								applyChangelogEntry(root, changelogPlan);
								const add = await deps.git.run(
									["add", "-A", "--", changelogPlan.path],
									{ cwd: root },
								);
								if ((add.exitCode ?? 99) !== 0) {
									throw new PiOmpGitError(
										`Staging the changelog failed: ${(add.stderr || "").trim().slice(0, 300)}`,
									);
								}
							},
						}
					: {}),
			});
			executed = split.commits;
		}

		// §80 conservation: any unplanned difference aborts.
		const committedPaths = executed.flatMap((commit) => commit.files);
		await verifyConservation(executeDeps, before, committedPaths);

		// §86: push only after commits succeeded.
		let push: CommitPipelineResult["push"];
		if (options.push) {
			const pushOutcome = await pushBranch(
				{ git: deps.git, gh: deps.gh, cwd: deps.cwd },
				{ branch, hasCommits: true },
				deps.signal,
			);
			push = pushOutcome;
		}

		const lines = executed.map((commit) => `${commit.short} ${commit.subject}`);
		let text =
			executed.length === 1
				? `Committed ${lines[0] ?? ""}`
				: `Created ${executed.length} commits:\n${lines.map((line) => `  ${line}`).join("\n")}`;
		if (usedCompatibilityStaging) {
			text =
				"Note: nothing was staged, so all changes were staged for this commit (compatibility mode).\n" +
				text;
		}
		if (changelogPlan) {
			text += `\nChangelog updated: ${changelogPlan.path}`;
		}
		if (push) text += `\n${push.report}`;
		return {
			outcome: "committed",
			commits: executed,
			usedCompatibilityStaging,
			plan: planText,
			...(push ? { push } : {}),
			text,
		};
	} finally {
		if (ownsDir) await rm(dir, { recursive: true, force: true });
	}
}

async function gitOut(
	deps: CommitPipelineDeps,
	args: string[],
): Promise<string> {
	const result = await deps.git.run(args, { cwd: deps.cwd });
	if ((result.exitCode ?? 99) !== 0) {
		throw new PiOmpGitError(
			`git ${args[0] ?? ""} failed: ${(result.stderr || "").trim().slice(0, 300)}`,
		);
	}
	return result.stdout.trim();
}
