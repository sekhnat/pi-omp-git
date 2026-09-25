import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/shared/config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function makeConfigFixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-omp-git-config-"));
	temporaryDirectories.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	const writeUser = (value: unknown) =>
		writeFileSync(join(agentDir, "pi-omp-git.json"), JSON.stringify(value));
	const writeProject = (value: unknown) =>
		writeFileSync(join(cwd, ".pi", "pi-omp-git.json"), JSON.stringify(value));
	const resolve = (projectTrusted: boolean, env: NodeJS.ProcessEnv = {}) =>
		loadConfig({ agentDir, cwd, env, projectTrusted });
	return { agentDir, cwd, writeUser, writeProject, resolve };
}

describe("configuration resolution", () => {
	it("uses the user value when no trusted project override exists", () => {
		const fixture = makeConfigFixture();
		fixture.writeUser({ commit: { splitPolicy: "auto" } });
		expect(fixture.resolve(false).commit.splitPolicy).toBe("auto");
	});

	it("gives a trusted project value precedence over the user value", () => {
		const fixture = makeConfigFixture();
		fixture.writeUser({ commit: { splitPolicy: "auto" } });
		fixture.writeProject({ commit: { splitPolicy: "never" } });
		expect(fixture.resolve(true).commit.splitPolicy).toBe("never");
	});

	it("ignores project configuration unless the host grants trust", () => {
		const fixture = makeConfigFixture();
		fixture.writeUser({ commit: { splitPolicy: "auto" } });
		fixture.writeProject({ commit: { splitPolicy: "never" } });
		const config = fixture.resolve(false);
		expect(config.commit.splitPolicy).toBe("auto");
		expect(config.configSources.project).toEqual({
			path: join(fixture.cwd, ".pi", "pi-omp-git.json"),
			discovered: true,
			active: false,
		});
		expect(config.activeConfigLayers).toEqual(["defaults", "user"]);
	});

	it("falls back to a valid lower layer when a project value is invalid", () => {
		const fixture = makeConfigFixture();
		fixture.writeUser({ commit: { splitPolicy: "auto" } });
		fixture.writeProject({ commit: { splitPolicy: "sometimes" } });
		expect(fixture.resolve(true).commit.splitPolicy).toBe("auto");
	});

	it("lets supported environment overrides take precedence over trusted project values", () => {
		const fixture = makeConfigFixture();
		fixture.writeProject({ worktree: { root: "/project/worktrees" } });
		const config = fixture.resolve(true, {
			PI_OMP_GIT_WORKTREE_DIR: "/override/worktrees",
		});
		expect(config.worktreeRoot).toBe("/override/worktrees");
	});
	it("ignores malformed JSON without crashing and records it as inactive", () => {
		const fixture = makeConfigFixture();
		writeFileSync(join(fixture.agentDir, "pi-omp-git.json"), "{");
		const config = fixture.resolve(false);
		expect(config.commit.splitPolicy).toBe("confirm");
		expect(config.configSources.user.discovered).toBe(true);
		expect(config.configSources.user.active).toBe(false);
		expect(config.activeConfigLayers).toEqual(["defaults"]);
	});
});
