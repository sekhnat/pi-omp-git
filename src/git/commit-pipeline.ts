/**
 * The agentic `/commit` pipeline (docs/pi-omp-git-reference.md §73–§86).
 *
 * One pipeline implementation, two hosts (ADR 0004): the `/commit`
 * command runs it in-process and the `pi-omp-git commit` binary runs it
 * standalone. The commit correctness contract (§83) is absolute: a
 * non-dry-run run returns exactly one of "commits were created",
 * "failure", or "definitively no changes" — never a printed proposal
 * with exit success and no commit.
 *
 * The commit scope is explicit: without `--all` the pipeline operates on
 * the staged set only and returns a `no-staged-changes` outcome when
 * nothing is staged but the tree is dirty — it never stages on its own
 * behalf. `--all` opts into repository-wide staging (tracked
 * modifications, deletions, and untracked files). Its plan is built
 * against a disposable index (a copy of the caller's index with
 * everything staged, addressed through GIT_INDEX_FILE), so a dry run —
 * or a failed or absent proposal — leaves the caller's index untouched.
 * The real index is staged only after the proposal is validated and
 * approved, guarded against intervening HEAD, index, or working-tree
 * changes, and verified to match the planned tree before execution.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
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
	restoreIndex,
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
	/**
	 * Explicit consent to stage and commit the repository-wide change set:
	 * tracked modifications, deletions, and untracked files — whether or
	 * not some files were already staged. Without it the staged set is the
	 * whole scope; nothing is ever staged implicitly.
	 */
	all?: boolean;
	noChangelog?: boolean;
	context?: string;
	/**
	 * Interactive confirmation for split plans (§78 splitPolicy confirm).
	 * The host decides how to ask; noninteractive hosts without a
	 * confirmation path fail explicitly rather than guessing from a TTY.
	 */
	confirmPlan?: (plan: string) => Promise<boolean>;
}

export type CommitPipelineOutcome =
	| "committed"
	| "no-changes"
	| "no-staged-changes"
	| "dry-run";

export interface CommitPipelineResult {
	outcome: CommitPipelineOutcome;
	commits: Array<{ short: string; subject: string; files: string[] }>;
	push?: { pushed: boolean; report: string };
	/** The rendered plan (always present for dry-run). */
	plan: string;
	text: string;
}

/**
 * Run the full pipeline. Throws PiOmpGitError subclasses on failure;
 * the §83 contract holds by construction: either commits exist (HEAD
 * moved), the call threw, or the tree was definitively clean (including
 * the no-staged-changes guidance outcome).
 */
export async function runCommitPipeline(
	deps: CommitPipelineDeps,
	options: CommitPipelineOptions,
): Promise<CommitPipelineResult> {
	const dryRun = options.dryRun === true;
	const all = options.all === true;
	// §74 preparation: root, HEAD, branch, staged/unstaged/untracked.
	const root = await gitOut(deps.git, deps.cwd, [
		"rev-parse",
		"--show-toplevel",
	]);
	const head = await gitOut(deps.git, deps.cwd, ["rev-parse", "HEAD"]);
	const branch = await gitOut(deps.git, deps.cwd, ["branch", "--show-current"]);
	const status = await statusSnapshot({
		git: deps.git,
		cwd: deps.cwd,
		tempDir: deps.tempDir,
	});

	// Reuse the porcelain v2 parser (space-separated fields; untracked
	// entries arrive in the unstaged list with state "?").
	const parsed = parseStatusV2(status.join("\n"));
	if (parsed.conflicts.length > 0) {
		// Conflicts abort the pipeline with a clear error.
		throw new PiOmpGitError(
			`The repository has unresolved conflicts (${parsed.conflicts[0]?.path ?? ""}) — resolve them before committing.`,
		);
	}
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

	const ownsScratch = !deps.tempDir;
	const scratch =
		deps.tempDir ?? (await mkdtemp(join(tmpdir(), "pi-omp-git-pipeline-")));
	try {
		const cleanTreeOutcome = async (): Promise<CommitPipelineResult> => {
			let text =
				"Nothing to commit: the working tree is clean — no commit was created.";
			let push: CommitPipelineResult["push"];
			if (options.push && !dryRun) {
				// §86: still push already-created local commits, or report why
				// not. (Dry-run never pushes, §82.)
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
				plan: "",
				...(push ? { push } : {}),
				text,
			};
		};

		// Staged-only default: with nothing staged, the dirty-tree case is
		// actionable guidance and the clean tree is the definitive
		// no-changes outcome. The pipeline never stages on its own behalf.
		if (!all && stagedFiles.length === 0) {
			if (unstagedOnly.length === 0 && untracked.length === 0) {
				return await cleanTreeOutcome();
			}
			return {
				outcome: "no-staged-changes",
				commits: [],
				plan: "",
				text: [
					"Nothing is staged — no commit was created.",
					"Stage the intended files (e.g. `git add <files>`) and rerun, or rerun with --all to stage and commit all tracked modifications, deletions, and untracked files.",
				].join("\n"),
			};
		}

		// All-changes planning runs against a disposable index: a copy of
		// the caller's index with everything staged, addressed through
		// GIT_INDEX_FILE. The caller's real index is untouched until the
		// proposal has been validated and (when required) approved.
		let allView:
			| {
					paths: string[];
					planTree: string;
					callerTree: string;
					git: GitRunner;
					fingerprints: Map<string, string>;
			  }
			| undefined;
		if (all) {
			const callerTree = await gitOut(deps.git, root, ["write-tree"]);
			const scoped = scopedIndexRunner(deps.git, join(scratch, "all-index"));
			const init = await scoped.run(["read-tree", callerTree], { cwd: root });
			if ((init.exitCode ?? 99) !== 0) {
				throw new PiOmpGitError(
					`Could not prepare the all-changes planning index: ${(init.stderr || "").trim().slice(0, 300)}`,
				);
			}
			const stagePlan = await scoped.run(["add", "-A", "."], { cwd: root });
			if ((stagePlan.exitCode ?? 99) !== 0) {
				throw new PiOmpGitError(
					`Staging all changes into the planning index failed: ${(stagePlan.stderr || "").trim().slice(0, 300)}`,
				);
			}
			const planTree = await gitOut(scoped, root, ["write-tree"]);
			const planned = parseStatusV2(
				(await statusSnapshot({ git: scoped, cwd: deps.cwd })).join("\n"),
			);
			if (planned.conflicts.length > 0) {
				throw new PiOmpGitError(
					"The all-changes planning index has unmerged entries — resolve the conflicts before committing.",
				);
			}
			const paths = planned.staged.map((file) => file.path);
			if (paths.length === 0) {
				// `--all` on a clean tree is the deterministic no-changes outcome.
				return await cleanTreeOutcome();
			}
			// Snapshot the planned working-tree state for the pre-staging
			// guard (bounded; the final tree verification covers the rest).
			const fingerprints = new Map<string, string>();
			for (const path of paths.slice(0, FINGERPRINT_PATH_CAP)) {
				fingerprints.set(
					path,
					fingerprintKey(fingerprintWorktreePath(root, path)),
				);
			}
			allView = { paths, planTree, callerTree, git: scoped, fingerprints };
		}

		// The operating view the agent plans over: the staged set, or the
		// complete all-changes view from the disposable index — which,
		// unlike `diff HEAD`, includes untracked file contents.
		const operatingPaths = allView ? allView.paths : stagedFiles;
		const stagedSet = new Set(stagedFiles);
		const unstagedSet = new Set(unstagedOnly);
		const untrackedSet = new Set(untracked);
		const changedFiles: OverviewFile[] = operatingPaths.map((path) => ({
			path,
			staged: allView ? stagedSet.has(path) : true,
			unstaged: unstagedSet.has(path),
			untracked: untrackedSet.has(path),
		}));
		const viewGit = allView ? allView.git : deps.git;
		const statView = await gitOut(viewGit, root, [
			"diff",
			"--cached",
			"--stat",
		]);
		const patchView = await gitOut(viewGit, root, ["diff", "--cached"]);
		const styleView = await gitOut(deps.git, root, [
			"log",
			"--max-count=12",
			"--format=%s",
		]);

		const analyze: AnalyzeFilesSettings = {
			enabled: deps.settings.analyzeFilesEnabled,
			maxFiles: deps.settings.analyzeFilesMaxFiles,
			maxConcurrency: deps.settings.analyzeFilesMaxConcurrency,
			allowInDryRun: deps.settings.dryRunAnalyzeFiles,
			dryRun,
		};

		const agent = await runCommitAgent({
			git: viewGit,
			cwd: deps.cwd,
			context: {
				...(branch ? { branch } : {}),
				...(head ? { head } : {}),
				changedFiles,
				diffStat: statView,
				recentSubjects: styleView
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line.length > 0),
				patch: patchView,
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
			return {
				outcome: "dry-run",
				commits: [],
				plan: planText,
				text: `Dry run (nothing staged, committed, or pushed):\n${planText}`,
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

		// `--all`: stage the validated plan into the real index only now —
		// after proposal validation and any required confirmation — guarded
		// against intervening HEAD, index, or working-tree changes.
		if (allView) {
			const headNow = await gitOut(deps.git, root, ["rev-parse", "HEAD"]);
			if (headNow !== head) {
				throw new PiOmpGitError(
					"HEAD moved while the commit was being planned — nothing was staged or committed. Inspect the repository and retry.",
				);
			}
			const callerTreeNow = await gitOut(deps.git, root, ["write-tree"]);
			if (callerTreeNow !== allView.callerTree) {
				throw new PiOmpGitError(
					"The index changed while the commit was being planned — nothing was staged or committed. Inspect the repository and retry.",
				);
			}
			for (const [path, planned] of allView.fingerprints) {
				const current = fingerprintKey(fingerprintWorktreePath(root, path));
				if (current !== planned) {
					throw new PiOmpGitError(
						`The working tree changed while the commit was being planned (${path}) — nothing was staged or committed. Inspect the repository and retry.`,
					);
				}
			}
			const stage = await deps.git.run(["add", "-A", "."], { cwd: root });
			if ((stage.exitCode ?? 99) !== 0) {
				throw new PiOmpGitError(
					`Staging all changes failed: ${(stage.stderr || "").trim().slice(0, 300)}`,
				);
			}
			const stagedTree = await gitOut(deps.git, root, ["write-tree"]);
			if (stagedTree !== allView.planTree) {
				// The real staged tree must match the validated plan; restore
				// the caller's index and abort rather than widen the scope.
				await restoreIndex(
					{ git: deps.git, cwd: deps.cwd },
					allView.callerTree,
				);
				throw new PiOmpGitError(
					"The staged all-changes tree does not match the validated plan — the caller's index was restored and nothing was committed.",
				);
			}
		}

		// Execute (§79): transactional for splits; changelog joins the first.
		const executeDeps = {
			git: deps.git,
			cwd: deps.cwd,
			tempDir: scratch,
			signal: deps.signal,
		};
		const before = await statusSnapshot(executeDeps);
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
		if (all) {
			text = `Staged and committed the full change set (--all).\n${text}`;
		}
		if (changelogPlan) {
			text += `\nChangelog updated: ${changelogPlan.path}`;
		}
		if (push) text += `\n${push.report}`;
		return {
			outcome: "committed",
			commits: executed,
			plan: planText,
			...(push ? { push } : {}),
			text,
		};
	} finally {
		if (ownsScratch) {
			await rm(scratch, { recursive: true, force: true });
		}
	}
}

/**
 * A Git runner scoped to a disposable index: every invocation addresses
 * `indexFile` through GIT_INDEX_FILE, leaving the caller's real index
 * untouched. Used only for all-changes planning views and the agent's
 * read-only file tools.
 */
function scopedIndexRunner(git: GitRunner, indexFile: string): GitRunner {
	return {
		run(args, runOptions = {}) {
			return git.run(args, {
				...runOptions,
				extraEnv: {
					...runOptions.extraEnv,
					GIT_INDEX_FILE: indexFile,
				},
			});
		},
	};
}

/** Bounded worktree fingerprint for the pre-staging guard. */
const FINGERPRINT_SIZE_CAP = 8 * 1024 * 1024;
const FINGERPRINT_PATH_CAP = 2000;

type WorktreeFingerprint =
	| { missing: true }
	| { missing: false; size: number; hash?: string };

function fingerprintWorktreePath(
	root: string,
	path: string,
): WorktreeFingerprint {
	try {
		const stat = statSync(join(root, path));
		if (!stat.isFile()) return { missing: false, size: -1 };
		if (stat.size > FINGERPRINT_SIZE_CAP)
			return { missing: false, size: stat.size };
		const hash = createHash("sha1")
			.update(readFileSync(join(root, path)))
			.digest("hex");
		return { missing: false, size: stat.size, hash };
	} catch {
		return { missing: true };
	}
}

function fingerprintKey(fingerprint: WorktreeFingerprint): string {
	if (fingerprint.missing) return "missing";
	return fingerprint.hash !== undefined
		? `${fingerprint.size}:${fingerprint.hash}`
		: `${fingerprint.size}:size-only`;
}

async function gitOut(
	git: GitRunner,
	cwd: string,
	args: string[],
): Promise<string> {
	const result = await git.run(args, { cwd });
	if ((result.exitCode ?? 99) !== 0) {
		throw new PiOmpGitError(
			`git ${args[0] ?? ""} failed: ${(result.stderr || "").trim().slice(0, 300)}`,
		);
	}
	return result.stdout.trim();
}
