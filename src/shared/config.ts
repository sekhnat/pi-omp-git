/**
 * Configuration layering — ticket 03 (docs/pi-omp-git-reference.md §88).
 *
 * Layering (later wins): built-in defaults ← user file
 * `<agentDir>/pi-omp-git.json` ← project file `<cwd>/.pi/pi-omp-git.json`
 * (read only after project trust is granted) ← environment overrides.
 *
 * Only well-typed values are applied — an invalid or unknown key falls
 * back to the value of the layer below it, and an unparseable file is
 * ignored entirely. Configuration must never crash the extension.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface CacheSettings {
	enabled: boolean;
	softTtlSec: number;
	hardTtlSec: number;
}

export interface GithubSettings {
	enabled: boolean;
	cache: CacheSettings;
}

export interface WorktreeSettings {
	/** Absolute managed-worktree root; resolved with env overrides. */
	root?: string;
}

/** §76/§78/§81/§82 commit-pipeline settings. */
export interface CommitSettings {
	/** confirm | auto | never (§78); confirm requires an interactive UI. */
	splitPolicy?: "confirm" | "auto" | "never";
	/** Per-file subagent analysis fan-out (§76, divergence D5). */
	analyzeFilesEnabled?: boolean;
	analyzeFilesMaxFiles?: number;
	analyzeFilesMaxConcurrency?: number;
	/** Changelog integration (§81). */
	changelog?: boolean;
	changelogMaxDiffChars?: number;
	/** Avoid expensive per-file subagents during preview (§82). */
	dryRunAnalyzeFiles?: boolean;
}

export interface OmpGitSettings {
	github: GithubSettings;
	worktree: WorktreeSettings;
	commit: CommitSettings;
}

export const COMMIT_DEFAULTS: Required<CommitSettings> = {
	splitPolicy: "confirm",
	analyzeFilesEnabled: true,
	analyzeFilesMaxFiles: 8,
	analyzeFilesMaxConcurrency: 4,
	changelog: true,
	changelogMaxDiffChars: 2000,
	dryRunAnalyzeFiles: false,
};

export const CONFIG_DEFAULTS: OmpGitSettings = {
	github: {
		enabled: true,
		cache: {
			enabled: true,
			softTtlSec: 300, // 5 minutes
			hardTtlSec: 604_800, // 7 days
		},
	},
	worktree: {
		// §26 default managed-worktree root: <agentDir>/worktrees
		root: undefined,
	},
	commit: {},
};

export const CONFIG_FILE_NAME = "pi-omp-git.json";

export interface LoadConfigOptions {
	/** User configuration directory, e.g. ~/.pi/agent. */
	agentDir: string;
	/** Project directory the `.pi/` project config is resolved against. */
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** The project file is read only after project trust is granted. */
	projectTrusted: boolean;
}

export interface ResolvedConfig extends OmpGitSettings {
	/** Absolute path of the SQLite cache database after environment overrides. */
	cacheDatabasePath: string;
	/** Absolute managed-worktree root after environment overrides (§26). */
	worktreeRoot: string;
	/** Absolute root for captured log artifacts (§44). */
	artifactsRoot: string;
}

type UnknownRecord = Record<string, unknown>;

function pickSplitPolicy(
	layers: UnknownRecord[],
): CommitSettings["splitPolicy"] {
	for (const layer of layers) {
		const commit = layer.commit;
		if (commit === null || typeof commit !== "object") continue;
		const value = (commit as UnknownRecord).splitPolicy;
		if (value === "confirm" || value === "auto" || value === "never") {
			return value;
		}
	}
	return undefined;
}

function readJsonFile(path: string): UnknownRecord {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			Array.isArray(parsed)
		) {
			return {};
		}
		return parsed as UnknownRecord;
	} catch {
		// Missing or invalid configuration degrades to the next layer.
		return {};
	}
}

/** Pick a non-empty string, falling back when absent or mistyped. */
function pickString(
	layers: UnknownRecord[],
	path: string[],
): string | undefined {
	for (const layer of layers) {
		let current: unknown = layer;
		for (const segment of path) {
			if (current === null || typeof current !== "object") {
				current = undefined;
				break;
			}
			current = (current as UnknownRecord)[segment];
		}
		if (typeof current === "string" && current.trim() !== "") {
			return current;
		}
	}
	return undefined;
}

/** Pick a boolean, falling back when the value is absent or mistyped. */
function pickBoolean(
	layers: UnknownRecord[],
	path: string[],
	fallback: boolean,
): boolean {
	for (const layer of layers) {
		let current: unknown = layer;
		for (const segment of path) {
			if (current === null || typeof current !== "object") {
				current = undefined;
				break;
			}
			current = (current as UnknownRecord)[segment];
		}
		if (typeof current === "boolean") {
			return current;
		}
	}
	return fallback;
}

/** Pick a non-negative integer, falling back when absent or mistyped. */
function pickInteger(
	layers: UnknownRecord[],
	path: string[],
	fallback: number,
	minimum: number,
): number {
	for (const layer of layers) {
		let current: unknown = layer;
		for (const segment of path) {
			if (current === null || typeof current !== "object") {
				current = undefined;
				break;
			}
			current = (current as UnknownRecord)[segment];
		}
		if (
			typeof current === "number" &&
			Number.isFinite(current) &&
			current >= minimum
		) {
			return Math.trunc(current);
		}
	}
	return fallback;
}

export function loadConfig(options: LoadConfigOptions): ResolvedConfig {
	const layers: UnknownRecord[] = [];
	const userFile = join(options.agentDir, CONFIG_FILE_NAME);
	layers.push(readJsonFile(userFile));
	if (options.projectTrusted) {
		const projectFile = join(options.cwd, ".pi", CONFIG_FILE_NAME);
		layers.push(readJsonFile(projectFile));
	}

	const settings: OmpGitSettings = {
		worktree: {
			root: pickString(layers, ["worktree", "root"]),
		},
		commit: {
			splitPolicy: pickSplitPolicy(layers),
			analyzeFilesEnabled: pickBoolean(
				layers,
				["commit", "analyzeFilesEnabled"],
				COMMIT_DEFAULTS.analyzeFilesEnabled,
			),
			analyzeFilesMaxFiles: pickInteger(
				layers,
				["commit", "analyzeFilesMaxFiles"],
				COMMIT_DEFAULTS.analyzeFilesMaxFiles,
				1,
			),
			analyzeFilesMaxConcurrency: pickInteger(
				layers,
				["commit", "analyzeFilesMaxConcurrency"],
				COMMIT_DEFAULTS.analyzeFilesMaxConcurrency,
				1,
			),
			changelog: pickBoolean(
				layers,
				["commit", "changelog"],
				COMMIT_DEFAULTS.changelog,
			),
			changelogMaxDiffChars: pickInteger(
				layers,
				["commit", "changelogMaxDiffChars"],
				COMMIT_DEFAULTS.changelogMaxDiffChars,
				1,
			),
			dryRunAnalyzeFiles: pickBoolean(
				layers,
				["commit", "dryRunAnalyzeFiles"],
				COMMIT_DEFAULTS.dryRunAnalyzeFiles,
			),
		},
		github: {
			enabled: pickBoolean(
				layers,
				["github", "enabled"],
				CONFIG_DEFAULTS.github.enabled,
			),
			cache: {
				enabled: pickBoolean(
					layers,
					["github", "cache", "enabled"],
					CONFIG_DEFAULTS.github.cache.enabled,
				),
				softTtlSec: pickInteger(
					layers,
					["github", "cache", "softTtlSec"],
					CONFIG_DEFAULTS.github.cache.softTtlSec,
					0,
				),
				hardTtlSec: pickInteger(
					layers,
					["github", "cache", "hardTtlSec"],
					CONFIG_DEFAULTS.github.cache.hardTtlSec,
					0,
				),
			},
		},
	};

	// A hard TTL below the soft TTL is a misconfiguration; the hard
	// boundary never sits inside the fresh band.
	const hardTtlSec = Math.max(
		settings.github.cache.hardTtlSec,
		settings.github.cache.softTtlSec,
	);

	const envPath =
		options.env.PI_OMP_GITHUB_CACHE_DB ?? options.env.OMP_GITHUB_CACHE_DB;

	// §26: the managed-worktree root comes from the configuration file,
	// with PI_OMP_GIT_WORKTREE_DIR and the OMP migration alias overriding it.
	const envWorktreeRoot =
		options.env.PI_OMP_GIT_WORKTREE_DIR ?? options.env.OMP_WORKTREE_DIR;
	const worktreeRoot =
		envWorktreeRoot ??
		settings.worktree.root ??
		join(options.agentDir, "worktrees");

	const splitPolicy =
		settings.commit.splitPolicy ?? COMMIT_DEFAULTS.splitPolicy;

	return {
		...settings,
		commit: {
			...settings.commit,
			splitPolicy,
		},
		github: {
			...settings.github,
			cache: { ...settings.github.cache, hardTtlSec },
		},
		cacheDatabasePath:
			envPath ??
			join(options.agentDir, "cache", "pi-omp-git", "github-cache.db"),
		worktreeRoot,
		artifactsRoot: join(options.agentDir, "artifacts", "pi-omp-git"),
	};
}
