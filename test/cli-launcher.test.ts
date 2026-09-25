/**
 * Launcher resolution-tier tests (openspec change git-only-cli-distribution).
 * The real launcher file is copied into disposable fixtures with stub
 * `dist/cli.js` / `src/cli.ts` entries so every tier is exercised without
 * touching the repository tree. Host resolution uses a stubbed `npm` on
 * PATH pointing at a fixture Pi root — no network, no real Pi dependency.
 */
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

const REPO_ROOT = join(import.meta.dirname, "..");
const LAUNCHER = readFileSync(join(REPO_ROOT, "bin", "pi-omp-git.mjs"), "utf8");
const DIST_ENTRY = join(REPO_ROOT, "dist", "cli.js");

const DIST_OK =
	"export const cliMain = async (argv) => { console.log('DIST-MODE ' + JSON.stringify(argv)); return 3; };\n";
const SRC_OK =
	"export const cliMain = async (argv) => { console.log('SOURCE-MODE ' + JSON.stringify(argv)); return 0; };\n";
const SRC_WITH_HOST = `import "@earendil-works/pi-coding-agent";\n${SRC_OK}`;
const SRC_WITH_TYPEBOX = `import "typebox";\n${SRC_OK}`;
const SRC_FOREIGN_HOST = `import "not-a-real-host-package";\n${SRC_OK}`;
const DIST_BROKEN = 'throw new Error("BOOM-DIST-BROKEN");\n';

interface Fixture {
	root: string;
	bin: string;
}

function makeFixture(options: { dist?: string; source?: string }): Fixture {
	const root = mkdtempSync(join(tmpdir(), "pi-omp-git-launcher-"));
	tempDirs.push(root);
	mkdirSync(join(root, "bin"), { recursive: true });
	const bin = join(root, "bin", "pi-omp-git.mjs");
	writeFileSync(bin, LAUNCHER);
	chmodSync(bin, 0o755);
	if (options.dist !== undefined) {
		mkdirSync(join(root, "dist"), { recursive: true });
		writeFileSync(join(root, "dist", "cli.js"), options.dist);
	}
	if (options.source !== undefined) {
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src", "cli.ts"), options.source);
	}
	return { root, bin };
}

/**
 * A stub `npm` executable whose `root -g` prints `globalRoot`; prepending
 * its directory to PATH redirects the launcher's Pi discovery.
 */
function stubNpmDir(globalRoot: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-omp-git-fake-npm-"));
	tempDirs.push(dir);
	const npm = join(dir, "npm");
	writeFileSync(npm, `#!/bin/sh\necho '${globalRoot}'\n`);
	chmodSync(npm, 0o755);
	return dir;
}

/** Minimal host package stub: package.json with an import-condition entry. */
function writeHostStub(
	hostRoot: string,
	name: string,
	entry = "./index.js",
): void {
	const pkgDir = join(hostRoot, name);
	mkdirSync(pkgDir, { recursive: true });
	writeFileSync(
		join(pkgDir, "package.json"),
		JSON.stringify({
			name,
			version: "0.0.0",
			type: "module",
			exports: { ".": { import: entry } },
		}),
	);
	writeFileSync(
		join(pkgDir, entry.replace(/^\.\//, "")),
		"export default {};\n",
	);
}

/** Pi installation fixture: `@earendil-works/pi-coding-agent` anchors discovery. */
function makeFakePiRoot(options: { nestedTypebox?: boolean } = {}): string {
	const root = mkdtempSync(join(tmpdir(), "pi-omp-git-fake-pi-"));
	tempDirs.push(root);
	writeHostStub(root, "@earendil-works/pi-coding-agent");
	if (options.nestedTypebox) {
		writeHostStub(
			join(root, "@earendil-works", "pi-coding-agent", "node_modules"),
			"typebox",
		);
	}
	return root;
}

interface RunResult {
	status: number;
	stdout: string;
	stderr: string;
}

function run(bin: string, args: string[], envPath?: string): RunResult {
	const result = spawnSync(process.execPath, [bin, ...args], {
		encoding: "utf8",
		env: envPath
			? {
					...process.env,
					PATH: `${envPath}${delimiter}${process.env.PATH ?? ""}`,
				}
			: { ...process.env },
	});
	return {
		status: result.status ?? -1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

describe("launcher resolution tiers", () => {
	it("runs from source when dist is absent", () => {
		const fixture = makeFixture({ source: SRC_OK });
		const result = run(fixture.bin, ["--help"]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("SOURCE-MODE");
		expect(result.stderr).toContain("running from TypeScript source");
	});

	it("prefers compiled dist and forwards argv and exit codes", () => {
		const fixture = makeFixture({ dist: DIST_OK, source: SRC_OK });
		const result = run(fixture.bin, ["--help", "extra"]);
		expect(result.status).toBe(3);
		expect(result.stdout).toContain('DIST-MODE ["--help","extra"]');
		expect(result.stderr).not.toContain("running from TypeScript source");
	});

	it("surfaces a broken dist error instead of falling back", () => {
		const fixture = makeFixture({ dist: DIST_BROKEN, source: SRC_OK });
		const result = run(fixture.bin, ["--help"]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("BOOM-DIST-BROKEN");
		expect(result.stdout).not.toContain("SOURCE-MODE");
	});

	it("resolves host packages from fixture Pi roots", () => {
		const piRoot = makeFakePiRoot();
		const fixture = makeFixture({ source: SRC_WITH_HOST });
		const result = run(fixture.bin, ["--help"], stubNpmDir(piRoot));
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("SOURCE-MODE");
		expect(result.stderr).toContain(
			"resolving host packages from the Pi installation",
		);
	});

	it("resolves nested hosts from the Pi package's own node_modules", () => {
		const piRoot = makeFakePiRoot({ nestedTypebox: true });
		const fixture = makeFixture({ source: SRC_WITH_TYPEBOX });
		const result = run(fixture.bin, ["--help"], stubNpmDir(piRoot));
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("SOURCE-MODE");
		expect(result.stderr).toContain(
			"resolving host packages from the Pi installation",
		);
	});

	it("fails with a hint when nothing provides the host packages", () => {
		const emptyRoot = mkdtempSync(join(tmpdir(), "pi-omp-git-empty-root-"));
		tempDirs.push(emptyRoot);
		const fixture = makeFixture({ source: SRC_WITH_HOST });
		const result = run(fixture.bin, ["--help"], stubNpmDir(emptyRoot));
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(
			"cannot resolve host package '@earendil-works/pi-coding-agent'",
		);
	});

	it("does not engage host resolution for non-host import failures", () => {
		const piRoot = makeFakePiRoot();
		const fixture = makeFixture({ source: SRC_FOREIGN_HOST });
		const result = run(fixture.bin, ["--help"], stubNpmDir(piRoot));
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("not-a-real-host-package");
		expect(result.stderr).not.toContain("resolving host packages");
		expect(result.stderr).not.toContain("cannot resolve host package");
	});

	it("runs the real repository CLI through the launcher", () => {
		const result = run(join(REPO_ROOT, "bin", "pi-omp-git.mjs"), ["--help"]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("OMP Git/GitHub parity");
		if (existsSync(DIST_ENTRY)) {
			expect(result.stderr).not.toContain("running from TypeScript source");
		} else {
			expect(result.stderr).toContain("running from TypeScript source");
		}
	});
});
