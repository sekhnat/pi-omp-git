/**
 * Prepare-script and install-path tests (openspec change
 * git-only-cli-distribution). The real `scripts/prepare.mjs` and launcher
 * run inside disposable fixtures; npm interactions use local `file:` and
 * `git+file:` sources, so no registry access is needed.
 */
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

const REPO_ROOT = join(import.meta.dirname, "..");
const PREPARE = join(REPO_ROOT, "scripts", "prepare.mjs");
const LAUNCHER = readFileSync(join(REPO_ROOT, "bin", "pi-omp-git.mjs"), "utf8");
const HOST_PACKAGES = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
];

function freshDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function stubNpmDir(globalRoot: string): string {
	const dir = freshDir("pi-omp-git-fake-npm-");
	const npm = join(dir, "npm");
	writeFileSync(npm, `#!/bin/sh\necho '${globalRoot}'\n`);
	chmodSync(npm, 0o755);
	return dir;
}

interface RunResult {
	status: number;
	stdout: string;
	stderr: string;
}

function run(
	command: string,
	args: string[],
	options: { cwd: string; envPath?: string },
): RunResult {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		env: options.envPath
			? {
					...process.env,
					PATH: `${options.envPath}${delimiter}${process.env.PATH ?? ""}`,
				}
			: { ...process.env },
	});
	return {
		status: result.status ?? -1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

describe("prepare script guard", () => {
	it("exits 0 and builds nothing when dev dependencies are absent", () => {
		const fixture = freshDir("pi-omp-git-prepare-skip-");
		const result = run(process.execPath, [PREPARE], { cwd: fixture });
		expect(result.status).toBe(0);
		expect(existsSync(join(fixture, "dist"))).toBe(false);
	});

	it("runs the build when the TypeScript compiler is installed", () => {
		const fixture = freshDir("pi-omp-git-prepare-build-");
		writeFileSync(
			join(fixture, "package.json"),
			JSON.stringify({
				name: "prepare-fixture",
				version: "0.0.0",
				scripts: {
					build:
						"node -e \"require('node:fs').mkdirSync('dist',{recursive:true});require('node:fs').writeFileSync('dist/built.txt','yes')\"",
				},
			}),
		);
		mkdirSync(join(fixture, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(fixture, "node_modules", ".bin", "tsc"), "");
		const result = run(process.execPath, [PREPARE], { cwd: fixture });
		expect(result.status).toBe(0);
		expect(readFileSync(join(fixture, "dist", "built.txt"), "utf8")).toBe(
			"yes",
		);
	});

	it("propagates build failures", () => {
		const fixture = freshDir("pi-omp-git-prepare-fail-");
		writeFileSync(
			join(fixture, "package.json"),
			JSON.stringify({
				name: "prepare-fixture",
				version: "0.0.0",
				scripts: { build: "node -e 'process.exit(7)'" },
			}),
		);
		mkdirSync(join(fixture, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(fixture, "node_modules", ".bin", "tsc"), "");
		const result = run(process.execPath, [PREPARE], { cwd: fixture });
		expect(result.status).toBe(7);
	});
});

describe("install-path simulations", () => {
	it("makes the CLI work from a Pi-style git clone with an empty node_modules", () => {
		const clone = freshDir("pi-omp-git-clone-sim-");
		mkdirSync(join(clone, "bin"), { recursive: true });
		cpSync(join(REPO_ROOT, "package.json"), join(clone, "package.json"));
		cpSync(join(REPO_ROOT, "src"), join(clone, "src"), { recursive: true });
		mkdirSync(join(clone, "scripts"), { recursive: true });
		cpSync(PREPARE, join(clone, "scripts", "prepare.mjs"));
		writeFileSync(join(clone, "bin", "pi-omp-git.mjs"), LAUNCHER);

		const install = run(
			"npm",
			["install", "--omit=dev", "--no-audit", "--no-fund"],
			{
				cwd: clone,
			},
		);
		expect(install.status).toBe(0);
		expect(existsSync(join(clone, "node_modules", "@earendil-works"))).toBe(
			false,
		);

		const piRoot = freshDir("pi-omp-git-fake-pi-");
		for (const name of HOST_PACKAGES) {
			const target = join(piRoot, name);
			mkdirSync(dirname(target), { recursive: true });
			symlinkSync(join(REPO_ROOT, "node_modules", name), target);
		}

		const result = run(
			process.execPath,
			[join(clone, "bin", "pi-omp-git.mjs"), "--help"],
			{
				cwd: clone,
				envPath: stubNpmDir(piRoot),
			},
		);
		expect(result.stderr).toContain("running from TypeScript source");
		expect(result.stderr).toContain(
			"resolving host packages from the Pi installation",
		);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("OMP Git/GitHub parity");
	}, 120_000);

	it("builds dist during npm's git-dependency install and runs it from the installed bin", () => {
		const consumer = installGitFixture();
		const installed = join(consumer, "node_modules", "pi-omp-git-fixture");
		expect(existsSync(join(installed, "dist", "cli.js"))).toBe(true);
		const result = run(
			process.execPath,
			[join(installed, "bin", "pi-omp-git.mjs"), "--help"],
			{
				cwd: consumer,
			},
		);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("DIST-MODE");
		expect(result.stderr).not.toContain("running from TypeScript source");
	}, 120_000);
});

/**
 * Build a git-repo fixture package whose `prepare` is the real repo script
 * and whose `build` emits a marker dist entry, install it into a fresh
 * consumer with `npm install git+file://`, and return the consumer dir.
 */
function installGitFixture(): string {
	const fixture = freshDir("pi-omp-git-gitdep-");
	writeFileSync(
		join(fixture, "package.json"),
		JSON.stringify({
			name: "pi-omp-git-fixture",
			version: "0.0.0",
			type: "module",
			bin: { "pi-omp-git-fixture": "./bin/pi-omp-git.mjs" },
			scripts: {
				prepare: "node scripts/prepare.mjs",
				build: "node scripts/build.mjs",
			},
		}),
	);
	mkdirSync(join(fixture, "scripts"), { recursive: true });
	cpSync(PREPARE, join(fixture, "scripts", "prepare.mjs"));
	writeFileSync(
		join(fixture, "scripts", "build.mjs"),
		[
			"import { mkdirSync, writeFileSync } from 'node:fs';",
			"mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });",
			"writeFileSync(new URL('../dist/cli.js', import.meta.url),",
			"\t\"export const cliMain = async () => { console.log('DIST-MODE'); return 0; };\\n\");",
			"",
		].join("\n"),
	);
	mkdirSync(join(fixture, "src"), { recursive: true });
	writeFileSync(
		join(fixture, "src", "cli.ts"),
		"export const cliMain = async () => { console.log('SOURCE-MODE'); return 0; };\n",
	);
	mkdirSync(join(fixture, "bin"), { recursive: true });
	writeFileSync(join(fixture, "bin", "pi-omp-git.mjs"), LAUNCHER);
	// npm's git-dependency pipeline installs the dependency's devDependencies
	// before running prepare; the seeded compiler stands in for them.
	mkdirSync(join(fixture, "node_modules", ".bin"), { recursive: true });
	writeFileSync(join(fixture, "node_modules", ".bin", "tsc"), "");
	const git = (args: string[]) => {
		const result = spawnSync("git", args, {
			cwd: fixture,
			encoding: "utf8",
			env: { ...process.env },
		});
		if (result.status !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
		}
	};
	git(["init", "-q", "."]);
	git(["add", "-A", "."]);
	git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);

	const consumer = freshDir("pi-omp-git-consumer-");
	writeFileSync(
		join(consumer, "package.json"),
		JSON.stringify({ name: "consumer", version: "0.0.0", private: true }),
	);
	const install = run(
		"npm",
		["install", "--no-audit", "--no-fund", `git+file://${fixture}`],
		{
			cwd: consumer,
		},
	);
	expect(install.status).toBe(0);
	return consumer;
}
