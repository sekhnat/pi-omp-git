/**
 * Ticket 11 acceptance tests: the repository mutation lock
 * (docs/pi-omp-git-reference.md §31) — in-process serialization by lock
 * identity, cross-process advisory lockfile behavior, and release on
 * failure.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createMutationLock,
	MUTATION_LOCKFILE_NAME,
} from "../src/git/mutation-lock.ts";

const tempDirs: string[] = [];

function tempRepoDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-omp-git-lock-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("repository mutation lock", () => {
	it("serializes concurrent operations on the same lock identity", async () => {
		const lock = createMutationLock();
		const timeline: string[] = [];

		const first = lock.withLock("repo-root", async () => {
			timeline.push("first:enter");
			await delay(50);
			timeline.push("first:exit");
		});
		const second = lock.withLock("repo-root", async () => {
			timeline.push("second:enter");
			timeline.push("second:exit");
		});
		await Promise.all([first, second]);

		expect(timeline).toEqual([
			"first:enter",
			"first:exit",
			"second:enter",
			"second:exit",
		]);
	});

	it("does not serialize operations on different lock identities", async () => {
		const lock = createMutationLock();
		const releaseFirst = { release: (): void => {} };
		let firstRunning = false;
		let secondDone = false;

		const first = lock.withLock("repo-a", async () => {
			firstRunning = true;
			await new Promise<void>((resolve) => {
				releaseFirst.release = resolve;
			});
		});
		const second = lock.withLock("repo-b", async () => {
			// This must complete while `first` is still holding its lock.
			secondDone = firstRunning;
		});
		await delay(20);
		expect(secondDone).toBe(true);
		releaseFirst.release();
		await Promise.all([first, second]);
	});

	it("holds and releases the advisory lockfile around the operation", async () => {
		const root = tempRepoDir();
		const lock = createMutationLock();
		let lockfileDuring: boolean | undefined;

		await lock.withLock(root, async () => {
			lockfileDuring = existsSync(join(root, MUTATION_LOCKFILE_NAME));
		});
		const lockfileAfter = existsSync(join(root, MUTATION_LOCKFILE_NAME));

		expect(lockfileDuring).toBe(true);
		expect(lockfileAfter).toBe(false);
	});

	it("proceeds best-effort when another process holds the lockfile", async () => {
		const root = tempRepoDir();
		// A "stuck" holder: a pre-existing lockfile that never releases.
		writeFileSync(join(root, MUTATION_LOCKFILE_NAME), "999999\n");
		const lock = createMutationLock({ lockfileWaitMs: 60 });

		let ran = false;
		await lock.withLock(root, async () => {
			ran = true;
		});

		expect(ran).toBe(true);
		// The abandoned holder's lockfile is never removed by us.
		expect(existsSync(join(root, MUTATION_LOCKFILE_NAME))).toBe(true);
	});

	it("releases the lockfile and mutex when the operation throws", async () => {
		const root = tempRepoDir();
		const lock = createMutationLock();

		await expect(
			lock.withLock(root, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		expect(existsSync(join(root, MUTATION_LOCKFILE_NAME))).toBe(false);
		expect(lock.pending(root)).toBe(0);

		// The mutex still admits a follow-up operation.
		let ran = false;
		await lock.withLock(root, async () => {
			ran = true;
		});
		expect(ran).toBe(true);
	});

	it("reports queued operations through the pending seam", async () => {
		const lock = createMutationLock();
		let releaseHolder!: () => void;
		const holder = new Promise<void>((resolve) => {
			releaseHolder = resolve;
		});

		const first = lock.withLock("repo", () => holder);
		const second = lock.withLock("repo", async () => {});
		await delay(10);
		expect(lock.pending("repo")).toBe(1);

		releaseHolder();
		await Promise.all([first, second]);
		expect(lock.pending("repo")).toBe(0);
	});
});
