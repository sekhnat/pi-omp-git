import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
	ConfigLayerName,
	LoadConfigOptions,
	ResolvedConfig,
} from "./config.ts";
import { loadConfig } from "./config.ts";
import {
	CommandNotFoundError,
	createRunner,
	type Runner,
	type RunResult,
} from "./subprocess.ts";

export const DOCTOR_TIMEOUT_MS = 5_000;
export const DOCTOR_OUTPUT_CAP_BYTES = 8 * 1024;

export type DoctorStatus = "ok" | "disabled" | "optional-unavailable" | "error";

export interface DoctorCheck {
	status: DoctorStatus;
	message: string;
	value?: string;
}

export interface DoctorDirectory {
	path: string;
	access: DoctorCheck;
}

export interface DoctorReport {
	versions: {
		node: string;
		package: string;
		pi?: string;
	};
	git: DoctorCheck;
	github: {
		enabled: boolean;
		cli: DoctorCheck;
		auth: DoctorCheck;
	};
	configuration: {
		activeLayers: ConfigLayerName[];
		sources: Array<{
			layer: "user" | "project";
			path: string;
			discovered: boolean;
			active: boolean;
		}>;
	};
	paths: {
		agentDirectory: DoctorDirectory;
		worktreeRoot: DoctorDirectory;
		cacheDatabase: string;
		cacheDirectory: DoctorDirectory;
		artifactsRoot: DoctorDirectory;
		cwd: string;
		repository: DoctorCheck;
	};
}

export interface DirectoryAccess {
	exists: boolean;
	writable: boolean;
}

export interface CollectDoctorOptions extends LoadConfigOptions {
	runner?: Runner;
	/** Optional Pi version supplied by the host; never read from arbitrary output. */
	piVersion?: string;
	/** Test seam for package metadata when running outside the package root. */
	packageVersion?: string;
	/** Filesystem probe seam; the default checks the nearest existing directory. */
	inspectDirectory?: (path: string) => Promise<DirectoryAccess>;
}

interface CommandProbe {
	result?: RunResult;
	missing: boolean;
}

const VERSION_PATTERN = /^\d+\.\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?$/;

function isCommandMissing(error: unknown): boolean {
	if (error instanceof CommandNotFoundError) return true;
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

function environmentOverrides(env: NodeJS.ProcessEnv): Record<string, string> {
	return Object.fromEntries(
		Object.entries(env).filter((entry): entry is [string, string] => {
			return entry[1] !== undefined;
		}),
	);
}

async function probeCommand(
	runner: Runner,
	command: string,
	args: string[],
	cwd: string,
	extraEnv: Record<string, string>,
): Promise<CommandProbe> {
	try {
		return {
			result: await runner.run(command, {
				args,
				cwd,
				locale: "stable",
				extraEnv,
				timeoutMs: DOCTOR_TIMEOUT_MS,
				outputCapBytes: DOCTOR_OUTPUT_CAP_BYTES,
			}),
			missing: false,
		};
	} catch (error) {
		return { missing: isCommandMissing(error) };
	}
}

function parsedVersion(
	output: string,
	command: "git" | "gh",
): string | undefined {
	const firstLine = output.split(/\r?\n/, 1)[0]?.trim() ?? "";
	const prefix = command === "git" ? "git version " : "gh version ";
	if (!firstLine.startsWith(prefix)) return undefined;
	const version = firstLine.slice(prefix.length).split(/\s+/, 1)[0];
	return version && VERSION_PATTERN.test(version) ? version : undefined;
}

function checkFromVersionProbe(
	probe: CommandProbe,
	command: "git" | "gh",
	optional: boolean,
): DoctorCheck {
	if (probe.missing) {
		return {
			status: optional ? "optional-unavailable" : "error",
			message: `${command} executable is unavailable.`,
		};
	}
	const result = probe.result;
	if (result?.exitCode !== 0 || result.timedOut || result.cancelled) {
		return {
			status: optional ? "optional-unavailable" : "error",
			message: `Could not determine ${command} version.`,
		};
	}
	const version = parsedVersion(result.stdout, command);
	return version
		? { status: "ok", message: `${command} is available.`, value: version }
		: {
				status: "ok",
				message: `${command} is available; version could not be parsed.`,
			};
}

function packageVersionFromMetadata(raw: string): string {
	try {
		const version = (JSON.parse(raw) as { version?: unknown }).version;
		return typeof version === "string" && VERSION_PATTERN.test(version)
			? version
			: "unknown";
	} catch {
		return "unknown";
	}
}

async function readPackageVersion(): Promise<string> {
	try {
		return packageVersionFromMetadata(
			await readFile(new URL("../../package.json", import.meta.url), "utf8"),
		);
	} catch {
		return "unknown";
	}
}

async function inspectDirectory(path: string): Promise<DirectoryAccess> {
	let candidate = resolve(path);
	while (true) {
		try {
			const info = await stat(candidate);
			if (!info.isDirectory())
				return { exists: candidate === resolve(path), writable: false };
			await access(candidate, constants.W_OK);
			return { exists: candidate === resolve(path), writable: true };
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? (error as { code?: unknown }).code
					: undefined;
			if (code !== "ENOENT" && code !== "ENOTDIR") {
				return { exists: candidate === resolve(path), writable: false };
			}
			const parent = dirname(candidate);
			if (parent === candidate) return { exists: false, writable: false };
			candidate = parent;
		}
	}
}

async function directoryCheck(
	path: string,
	probe: (path: string) => Promise<DirectoryAccess>,
): Promise<DoctorDirectory> {
	try {
		const result = await probe(path);
		if (result.writable) {
			return {
				path,
				access: {
					status: "ok",
					message: result.exists
						? "Directory is writable."
						: "Directory does not exist yet; its nearest existing parent is writable.",
				},
			};
		}
		return {
			path,
			access: {
				status: "error",
				message: result.exists
					? "Directory is not writable or is not a directory."
					: "Directory cannot be created with the current permissions.",
			},
		};
	} catch {
		return {
			path,
			access: {
				status: "error",
				message: "Directory access could not be checked.",
			},
		};
	}
}

function authenticationCheck(probe: CommandProbe): DoctorCheck {
	if (probe.missing) {
		return {
			status: "optional-unavailable",
			message: "Authentication status unavailable because gh is missing.",
		};
	}
	const result = probe.result;
	if (!result || result.timedOut || result.cancelled) {
		return {
			status: "error",
			message: "Could not determine GitHub CLI authentication status.",
		};
	}
	return result.exitCode === 0
		? { status: "ok", message: "GitHub CLI is authenticated." }
		: {
				status: "error",
				message:
					"GitHub CLI is not authenticated; run `gh auth login` to enable GitHub features.",
			};
}

function repositoryCheck(probe: CommandProbe, git: DoctorCheck): DoctorCheck {
	if (git.status === "error") {
		return {
			status: "optional-unavailable",
			message: "Repository root unavailable because Git could not be queried.",
		};
	}
	const result = probe.result;
	if (probe.missing || !result || result.timedOut || result.cancelled) {
		return {
			status: "optional-unavailable",
			message: "Repository root could not be determined.",
		};
	}
	if (result.exitCode !== 0) {
		return {
			status: "optional-unavailable",
			message: "Current directory is not inside a Git repository.",
		};
	}
	const root = result.stdout.trim();
	if (root.length === 0 || root.length > 4096 || /[\r\n]/.test(root)) {
		return {
			status: "optional-unavailable",
			message: "Repository root could not be determined.",
		};
	}
	return { status: "ok", message: "Git repository detected.", value: root };
}

function sourceInfo(
	config: ResolvedConfig,
): DoctorReport["configuration"]["sources"] {
	return (["user", "project"] as const).map((layer) => ({
		layer,
		...config.configSources[layer],
	}));
}

/** Collect bounded, token-free local environment diagnostics. */
export async function collectDoctorReport(
	options: CollectDoctorOptions,
): Promise<DoctorReport> {
	const config = loadConfig(options);
	const runner = options.runner ?? createRunner({ cwd: options.cwd });
	const env = environmentOverrides(options.env);
	const directoryProbe = options.inspectDirectory ?? inspectDirectory;
	const [
		packageVersion,
		agentDirectory,
		worktreeRoot,
		cacheDirectory,
		artifactsRoot,
	] = await Promise.all([
		options.packageVersion
			? Promise.resolve(options.packageVersion)
			: readPackageVersion(),
		directoryCheck(options.agentDir, directoryProbe),
		directoryCheck(config.worktreeRoot, directoryProbe),
		directoryCheck(dirname(config.cacheDatabasePath), directoryProbe),
		directoryCheck(config.artifactsRoot, directoryProbe),
	]);
	const [gitVersionProbe, repositoryProbe] = await Promise.all([
		probeCommand(runner, "git", ["--version"], options.cwd, env),
		probeCommand(
			runner,
			"git",
			["rev-parse", "--show-toplevel"],
			options.cwd,
			env,
		),
	]);
	const git = checkFromVersionProbe(gitVersionProbe, "git", false);
	let gh: DoctorCheck;
	let auth: DoctorCheck;
	if (!config.github.enabled) {
		gh = {
			status: "disabled",
			message: "GitHub CLI checks disabled by configuration.",
		};
		auth = {
			status: "disabled",
			message: "GitHub integration is disabled by configuration.",
		};
	} else {
		const ghVersionProbe = await probeCommand(
			runner,
			"gh",
			["--version"],
			options.cwd,
			env,
		);
		gh = checkFromVersionProbe(ghVersionProbe, "gh", true);
		if (gh.status !== "ok") {
			auth = ghVersionProbe.missing
				? authenticationCheck({ missing: true })
				: {
						status: "optional-unavailable",
						message:
							"Authentication status unavailable because gh could not be queried.",
					};
		} else {
			const authProbe = await probeCommand(
				runner,
				"gh",
				["auth", "status"],
				options.cwd,
				env,
			);
			auth = authenticationCheck(authProbe);
		}
	}
	const piVersion =
		options.piVersion && VERSION_PATTERN.test(options.piVersion)
			? options.piVersion
			: undefined;
	return {
		versions: {
			node: process.version,
			package: VERSION_PATTERN.test(packageVersion)
				? packageVersion
				: "unknown",
			...(piVersion ? { pi: piVersion } : {}),
		},
		git,
		github: {
			enabled: config.github.enabled,
			cli: gh,
			auth,
		},
		configuration: {
			activeLayers: [...config.activeConfigLayers],
			sources: sourceInfo(config),
		},
		paths: {
			agentDirectory,
			worktreeRoot,
			cacheDatabase: config.cacheDatabasePath,
			cacheDirectory,
			artifactsRoot,
			cwd: options.cwd,
			repository: repositoryCheck(repositoryProbe, git),
		},
	};
}

function checkText(check: DoctorCheck): string {
	return check.value ? `${check.message} (${check.value})` : check.message;
}

/** Render the shared model without exposing subprocess output or credentials. */
export function formatDoctorReport(report: DoctorReport): string {
	const lines = [
		"pi-omp-git doctor",
		`Node: ${report.versions.node}`,
		`pi-omp-git: ${report.versions.package}`,
		...(report.versions.pi ? [`Pi: ${report.versions.pi}`] : []),
		`Git: ${checkText(report.git)}`,
		`GitHub integration: ${report.github.enabled ? "enabled" : "disabled"}`,
		`gh: ${checkText(report.github.cli)}`,
		`GitHub auth: ${checkText(report.github.auth)}`,
		`Agent directory: ${report.paths.agentDirectory.path} — ${report.paths.agentDirectory.access.message}`,
		`Worktree root: ${report.paths.worktreeRoot.path} — ${report.paths.worktreeRoot.access.message}`,
		`Cache database: ${report.paths.cacheDatabase}`,
		`Cache directory: ${report.paths.cacheDirectory.path} — ${report.paths.cacheDirectory.access.message}`,
		`Artifacts root: ${report.paths.artifactsRoot.path} — ${report.paths.artifactsRoot.access.message}`,
		`Working directory: ${report.paths.cwd}`,
		`Repository: ${checkText(report.paths.repository)}`,
		`Active config layers: ${report.configuration.activeLayers.join(", ")}`,
		...report.configuration.sources.map((source) => {
			const discovered = source.discovered ? "discovered" : "not found";
			const active = source.active ? "active" : "inactive";
			return `${source.layer} config: ${discovered}, ${active} (${source.path})`;
		}),
	];
	return lines.join("\n");
}
