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

export interface OmpGitSettings {
	github: GithubSettings;
}

export const CONFIG_DEFAULTS: OmpGitSettings = {
	github: {
		enabled: true,
		cache: {
			enabled: true,
			softTtlSec: 300, // 5 minutes
			hardTtlSec: 604_800, // 7 days
		},
	},
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
}

type UnknownRecord = Record<string, unknown>;

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

	return {
		...settings,
		github: {
			...settings.github,
			cache: { ...settings.github.cache, hardTtlSec },
		},
		cacheDatabasePath:
			envPath ??
			join(options.agentDir, "cache", "pi-omp-git", "github-cache.db"),
	};
}
