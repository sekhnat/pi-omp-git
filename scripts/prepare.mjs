#!/usr/bin/env node
/**
 * Defensive `prepare` (openspec change git-only-cli-distribution).
 *
 * npm's git-dependency pipeline installs the dependency's devDependencies
 * before running `prepare`, so building here gives `npm install -g
 * git+<url>` a working `dist/`. Pi's git install runs `npm install
 * --omit=dev` inside the clone — `prepare` still fires, but without dev
 * dependencies a build would fail and take the whole install down, so the
 * build is skipped whenever the TypeScript compiler is not installed.
 * Real build failures propagate: a working dev environment must not ship
 * a silently broken build.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const tscBin = join(process.cwd(), "node_modules", ".bin", "tsc");
if (!existsSync(tscBin)) {
	process.exit(0);
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const build = spawnSync(npmCommand, ["run", "build"], { stdio: "inherit" });
process.exit(build.status ?? 1);
