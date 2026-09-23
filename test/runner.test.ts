/**
 * Shared process runner — ticket 01 acceptance tests.
 *
 * External behavior only: arguments in, RunResult out. Real `node` child
 * processes prove spawn/timeout/cap/cancel behavior; the scripted exec
 * injection seam (fixtures) is exercised in scripted-seam.test.ts.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunner } from "../src/shared/subprocess.ts";

const NODE = process.execPath;

function tempMarkerPath(): string {
	return join(
		mkdtempSync(join(tmpdir(), "pi-omp-git-test-")),
		`marker-${randomUUID()}`,
	);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runner: shell-argument safety", () => {
	it("passes arguments containing shell metacharacters verbatim (no shell interpolation)", async () => {
		const runner = createRunner();
		const dangerous = [
			"a;b",
			"&&whoami",
			"$(whoami)",
			"`id`",
			"a b",
			"*",
			"x|y",
			'"; rm -rf /',
		];
		const script = "console.log(JSON.stringify(process.argv))";
		const result = await runner.run(NODE, {
			args: ["-e", script, "--", ...dangerous],
		});
		expect(result.exitCode).toBe(0);
		const argv: unknown = JSON.parse(result.stdout.trim());
		expect(argv).toEqual(expect.arrayContaining(dangerous));
	});
});

describe("runner: environment", () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) delete process.env[key];
		}
		Object.assign(process.env, originalEnv);
	});

	it("sets noninteractive environment and never prompts", async () => {
		const runner = createRunner();
		const result = await runner.run(NODE, {
			args: ["-e", "console.log(JSON.stringify(process.env))"],
			locale: "stable",
		});
		const env = JSON.parse(result.stdout.trim()) as Record<string, string>;
		expect(env.GH_PROMPT_DISABLED).toBe("1");
		expect(env.GIT_TERMINAL_PROMPT).toBe("0");
		expect(env.GIT_EDITOR).toBe("true");
		expect(env.GIT_ASKPASS).toBe("true");
		expect(env.SSH_ASKPASS_REQUIRE).toBe("never");
	});

	it("stabilizes the locale for parsed output", async () => {
		const runner = createRunner();
		const result = await runner.run(NODE, {
			args: ["-e", "console.log(JSON.stringify(process.env))"],
			locale: "stable",
		});
		const env = JSON.parse(result.stdout.trim()) as Record<string, string>;
		expect(env.LC_ALL).toBe("C");
		expect(env.LANG).toBe("C");
	});

	it("leaves the locale untouched by default", async () => {
		const runner = createRunner();
		const result = await runner.run(NODE, {
			args: ["-e", "console.log(JSON.stringify(process.env))"],
		});
		const env = JSON.parse(result.stdout.trim()) as Record<string, string>;
		expect(env.LC_ALL ?? "").toBe(process.env.LC_ALL ?? "");
	});

	it("preserves user-supplied authentication variables", async () => {
		process.env.GH_TOKEN = "user-secret-token";
		const runner = createRunner();
		const result = await runner.run(NODE, {
			args: [
				"-e",
				"console.log(JSON.stringify({ token: process.env.GH_TOKEN ?? null }))",
			],
		});
		const env = JSON.parse(result.stdout.trim()) as { token: string | null };
		expect(env.token).toBe("user-secret-token");
	});

	it("applies caller-supplied extraEnv on top of the noninteractive base", async () => {
		const runner = createRunner();
		const result = await runner.run(NODE, {
			args: ["-e", "console.log(JSON.stringify(process.env))"],
			extraEnv: { GH_HOST: "git.example.com" },
		});
		const env = JSON.parse(result.stdout.trim()) as Record<string, string>;
		expect(env.GH_HOST).toBe("git.example.com");
	});
});

describe("runner: limits and cancellation", () => {
	it("enforces the timeout and terminates the child process", async () => {
		const marker = tempMarkerPath();
		const runner = createRunner({ timeoutMs: 250 });
		const child = `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "x"), 3000)`;
		const started = Date.now();
		const result = await runner.run(NODE, { args: ["-e", child] });
		const elapsed = Date.now() - started;
		expect(result.timedOut).toBe(true);
		expect(result.exitCode).toBeNull();
		expect(elapsed).toBeLessThan(3000);
		await sleep(3500);
		expect(existsSync(marker)).toBe(false);
	}, 15_000);

	it("enforces the output cap, reports truncation honestly, and terminates the child", async () => {
		const marker = tempMarkerPath();
		const cap = 100_000;
		const runner = createRunner({ outputCapBytes: cap });
		// Writes ~9 MiB in one go, then writes the marker. The cap must cut it off.
		const child = [
			`const s = "x".repeat(1024 * 1024);`,
			`for (let i = 0; i < 9; i++) process.stdout.write(s);`,
			`setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "x"), 2000)`,
		].join("\n");
		const started = Date.now();
		const result = await runner.run(NODE, { args: ["-e", child] });
		const elapsed = Date.now() - started;
		expect(result.truncated).toBe(true);
		expect(result.stdout.length).toBeLessThanOrEqual(cap);
		expect(elapsed).toBeLessThan(2000);
		await sleep(2500);
		expect(existsSync(marker)).toBe(false);
	}, 15_000);

	it("terminates the child on cancellation", async () => {
		const marker = tempMarkerPath();
		const abort = new AbortController();
		const runner = createRunner();
		const child = `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "x"), 3000)`;
		const pending = runner.run(NODE, {
			args: ["-e", child],
			signal: abort.signal,
		});
		setTimeout(() => abort.abort(), 200);
		const result = await pending;
		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeNull();
		await sleep(3200);
		expect(existsSync(marker)).toBe(false);
	}, 15_000);

	it("resolves immediately without spawning when the signal is already aborted", async () => {
		const abort = new AbortController();
		abort.abort();
		const runner = createRunner();
		const result = await runner.run(NODE, {
			args: ["-e", "1+1"],
			signal: abort.signal,
		});
		expect(result.cancelled).toBe(true);
	});

	it("reports non-zero exit codes without throwing", async () => {
		const runner = createRunner();
		const result = await runner.run(NODE, {
			args: ["-e", 'console.error("boom"); process.exit(3)'],
		});
		expect(result.exitCode).toBe(3);
		expect(result.stderr).toContain("boom");
		expect(result.timedOut).toBe(false);
	});
});
