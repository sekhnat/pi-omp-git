/**
 * Repository mutation lock — ticket 11 (docs/pi-omp-git-reference.md §31).
 *
 * All Git mutations affecting shared repository metadata are serialized by
 * the **primary repository root**, not by individual worktree directories:
 * an in-process async mutex keyed by the resolved lock identity (MUST),
 * plus an advisory lockfile at `<git-common-dir>/pi-omp-git.lock` for
 * cross-process courtesy (SHOULD).
 *
 * The guarantee is scoped: mutations from another process are bounded only
 * best-effort by the lockfile, which is acquired with a bounded wait and
 * then abandoned rather than blocking forever. Nothing here runs `git` —
 * the caller resolves the identity (primary repository root / common dir).
 */

import { open, unlink } from "node:fs/promises";

/** Advisory lockfile name inside the repository's common Git directory. */
export const MUTATION_LOCKFILE_NAME = "pi-omp-git.lock";

const LOCKFILE_RETRY_DELAY_MS = 25;

export interface MutationLockOptions {
	/**
	 * How long the advisory lockfile is waited for before proceeding anyway
	 * (SHOULD-tier best effort — a stuck holder never wedges the session).
	 */
	lockfileWaitMs?: number;
}

export interface RepositoryMutationLock {
	/**
	 * Run `operation` serialized against every other holder of the same
	 * lock identity (the absolute primary repository root or common Git
	 * directory). Holds the advisory lockfile while the operation runs.
	 */
	withLock<T>(lockIdentity: string, operation: () => Promise<T>): Promise<T>;
	/** Test seam: operations currently queued behind `lockIdentity`. */
	pending(lockIdentity: string): number;
}

export function createMutationLock(
	options: MutationLockOptions = {},
): RepositoryMutationLock {
	const lockfileWaitMs = options.lockfileWaitMs ?? 5_000;
	interface LockState {
		/** The gate every queued holder waits behind. */
		tail: Promise<void>;
		/** Operations queued (not including the current holder). */
		waiting: number;
	}
	const states = new Map<string, LockState>();
	const delay = (ms: number): Promise<void> =>
		new Promise((resolve) => setTimeout(resolve, ms));

	async function acquireLockfile(path: string): Promise<boolean> {
		const deadline = Date.now() + lockfileWaitMs;
		for (;;) {
			try {
				const handle = await open(path, "wx");
				try {
					await handle.writeFile(`${process.pid}\n`, "utf8");
				} finally {
					await handle.close();
				}
				return true;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "EEXIST") {
					// Unwritable location — the advisory tier is best-effort.
					return false;
				}
				if (Date.now() >= deadline) {
					return false;
				}
				await delay(LOCKFILE_RETRY_DELAY_MS);
			}
		}
	}

	async function releaseLockfile(path: string): Promise<void> {
		try {
			await unlink(path);
		} catch {
			// Already gone or never ours — releasing is best-effort.
		}
	}

	return {
		async withLock<T>(lockIdentity: string, operation: () => Promise<T>) {
			const state = states.get(lockIdentity) ?? {
				tail: Promise.resolve(),
				waiting: 0,
			};
			states.set(lockIdentity, state);
			state.waiting += 1;

			// Capture the previous gate before installing ours — the holder
			// waits for everyone queued before it, never for itself.
			const previous = state.tail;
			let releaseGate!: () => void;
			const gate = new Promise<void>((resolve) => {
				releaseGate = resolve;
			});
			state.tail = gate;

			await previous.catch(() => {});
			state.waiting -= 1;

			const lockfilePath = `${lockIdentity}/${MUTATION_LOCKFILE_NAME}`;
			const ours = await acquireLockfile(lockfilePath);
			try {
				return await operation();
			} finally {
				if (ours) await releaseLockfile(lockfilePath);
				releaseGate();
				if (states.get(lockIdentity) === state && state.waiting === 0) {
					states.delete(lockIdentity);
				}
			}
		},

		pending(lockIdentity) {
			return states.get(lockIdentity)?.waiting ?? 0;
		},
	};
}
