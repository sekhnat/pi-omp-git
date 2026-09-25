import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getCliAgentDir, resolveCliConfig } from "../src/cli.ts";
import { createOmpGitContext } from "../src/index.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalWorktreeRoot = process.env.PI_OMP_GIT_WORKTREE_DIR;
const temporaryDirectories: string[] = [];

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	if (originalWorktreeRoot === undefined) {
		delete process.env.PI_OMP_GIT_WORKTREE_DIR;
	} else process.env.PI_OMP_GIT_WORKTREE_DIR = originalWorktreeRoot;
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("Pi agent directory resolution", () => {
	it("uses Pi's custom directory for extension and CLI config and state defaults", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-omp-git-agent-dir-"));
		temporaryDirectories.push(root);
		const agentDir = join(root, "custom-agent");
		const projectDir = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(
			join(agentDir, "pi-omp-git.json"),
			JSON.stringify({ commit: { changelog: false } }),
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_OMP_GIT_WORKTREE_DIR = join(root, "override-worktrees");

		const extensionConfig = createOmpGitContext(projectDir).getConfig();
		const cliConfig = resolveCliConfig(projectDir);

		expect(getCliAgentDir()).toBe(agentDir);
		for (const config of [extensionConfig, cliConfig]) {
			expect(config.commit.changelog).toBe(false);
			expect(config.configSources.user.path).toBe(
				join(agentDir, "pi-omp-git.json"),
			);
			expect(config.cacheDatabasePath).toBe(
				join(agentDir, "cache", "pi-omp-git", "github-cache.db"),
			);
			expect(config.artifactsRoot).toBe(
				join(agentDir, "artifacts", "pi-omp-git"),
			);
			expect(config.worktreeRoot).toBe(join(root, "override-worktrees"));
		}
	});
});
