/**
 * The session's last checkout — ticket 13
 * (docs/pi-omp-git-reference.md §110).
 *
 * `pr_push` and `run_watch` resolve their target to the most recent
 * `pr_checkout` in the session when no explicit parameter is given. The
 * record rides the checkout's session entry (`pi.appendEntry`) so it
 * survives resume and stays scoped to the active branch: on a fresh
 * load the caller derives the record from `sessionManager.getBranch()`.
 * These entries never enter the model context.
 */

/** Custom entry type this extension appends after each checkout. */
export const CHECKOUT_ENTRY_TYPE = "pi-omp-git.checkout";

export interface CheckoutRecord {
	/** The identifier exactly as the caller provided it. */
	pr: string;
	number: number;
	url?: string;
	branch: string;
	worktreePath: string;
	host?: string;
	owner?: string;
	repo?: string;
	/** Wall-clock ms when the checkout happened (advisory ordering only). */
	at?: number;
}

/** The slice of a session entry `findLastCheckout` consumes. */
export interface SessionEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

/** Validate one entry's data as a checkout record; null when it is not. */
export function checkoutEntryData(data: unknown): CheckoutRecord | null {
	if (!data || typeof data !== "object" || Array.isArray(data)) return null;
	const record = data as Record<string, unknown>;
	if (
		typeof record.pr !== "string" ||
		typeof record.number !== "number" ||
		!Number.isInteger(record.number) ||
		record.number <= 0 ||
		typeof record.branch !== "string" ||
		record.branch === "" ||
		typeof record.worktreePath !== "string" ||
		record.worktreePath === ""
	) {
		return null;
	}
	return {
		pr: record.pr,
		number: record.number,
		...(typeof record.url === "string" ? { url: record.url } : {}),
		branch: record.branch,
		worktreePath: record.worktreePath,
		...(typeof record.host === "string" ? { host: record.host } : {}),
		...(typeof record.owner === "string" ? { owner: record.owner } : {}),
		...(typeof record.repo === "string" ? { repo: record.repo } : {}),
		...(typeof record.at === "number" ? { at: record.at } : {}),
	};
}

/**
 * The most recent checkout on this branch of the session transcript, or
 * null when none is recorded. Entries are scanned in order; the last
 * valid one wins.
 */
export function findLastCheckout(
	entries: readonly SessionEntryLike[],
): CheckoutRecord | null {
	let found: CheckoutRecord | null = null;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== CHECKOUT_ENTRY_TYPE) {
			continue;
		}
		const record = checkoutEntryData(entry.data);
		if (record) found = record;
	}
	return found;
}
