#!/usr/bin/env node
/**
 * Release gate checks for pi-omp-git (see RELEASING.md).
 *
 * Gate order is deliberate: tag/version agreement, a clean worktree, and the
 * tag pointing at HEAD are verified FIRST, so a mismatched or missing tag
 * fails before any build, check, smoke, or inspection step runs. This script
 * performs checks only — it never publishes and never reads or writes npm
 * credentials. Publication is a separate, deliberate manual step.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fail = (message) => {
	console.error(`release-check: FAIL — ${message}`);
	console.error("release-check: nothing was built, verified, or published.");
	process.exit(1);
};
const run = (cmd, args) =>
	execFileSync(cmd, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

const step = (message) => console.log(`release-check: ${message}`);

// --- Gate 1: tag/version agreement -----------------------------------------
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
	fail(
		`package.json version ${JSON.stringify(version)} is not a valid semver release version`,
	);
}
const expectedTag = `v${version}`;

let tag;
try {
	tag = run("git", [
		"describe",
		"--tags",
		"--abbrev=0",
		"--match",
		"v*",
	]).trim();
} catch {
	fail(
		`no release tag found; expected ${expectedTag}. Create the tag only after the changelog and version bump are final.`,
	);
}
if (tag !== expectedTag) {
	fail(
		`latest tag ${tag} does not match package.json version ${version} (expected ${expectedTag})`,
	);
}
step(`tag/version agreement OK (${expectedTag})`);

// --- Gate 2: clean worktree ------------------------------------------------
const status = run("git", ["status", "--porcelain"]);
if (status.trim() !== "") {
	fail("working tree is not clean — commit or stash before releasing");
}
step("worktree is clean");

// --- Gate 3: tag points at HEAD --------------------------------------------
const head = run("git", ["rev-parse", "HEAD"]).trim();
const tagged = run("git", ["rev-parse", `${expectedTag}^{commit}`]).trim();
if (head !== tagged) {
	fail(
		`tag ${expectedTag} points at ${tagged.slice(0, 12)}, not HEAD ${head.slice(0, 12)}`,
	);
}
step(`tag ${expectedTag} points at HEAD`);

// --- Gate 4: canonical check ------------------------------------------------
step("running npm run check (typecheck, Biome, tests)…");
try {
	run("npm", ["run", "check"]);
} catch (error) {
	fail(`npm run check failed: ${error.status ?? error.message}`);
}
step("npm run check passed");

// --- Gate 5: packed-tarball smoke ------------------------------------------
step("running npm run smoke:pack (isolated tarball install)…");
try {
	run("npm", ["run", "smoke:pack"]);
} catch (error) {
	fail(`npm run smoke:pack failed: ${error.status ?? error.message}`);
}
step("npm run smoke:pack passed");

// --- Gate 6: tarball inspection --------------------------------------------
step("packing and inspecting the tarball…");
const scratch = mkdtempSync(join(tmpdir(), "pi-omp-git-release-"));
let tarballPath;
try {
	const packed = JSON.parse(
		run("npm", ["pack", "--json", "--pack-destination", scratch]),
	);
	const entry = Array.isArray(packed) ? packed[0] : packed;
	tarballPath = entry.filename ?? join(scratch, `pi-omp-git-${version}.tgz`);

	const contents = run("tar", ["-tzf", tarballPath]).split("\n");
	const required = [
		"package/package.json",
		"package/README.md",
		"package/LICENSE",
		"package/CHANGELOG.md",
		"package/SECURITY.md",
		"package/bin/pi-omp-git.mjs",
		"package/dist/cli.js",
		"package/src/index.ts",
	];
	for (const name of required) {
		if (!contents.includes(name)) fail(`tarball is missing ${name}`);
	}

	const packedPkg = JSON.parse(
		run("tar", ["-xOzf", tarballPath, "package/package.json"]),
	);
	if (packedPkg.version !== version) {
		fail(
			`tarball package.json version ${packedPkg.version} does not match ${version}`,
		);
	}
	step(
		`tarball inspection OK (pi-omp-git-${version}.tgz, ${contents.filter(Boolean).length} files)`,
	);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

console.log(
	"release-check: all gates passed. Publication remains a manual step — see RELEASING.md.",
);
