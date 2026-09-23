/**
 * The cache facade — ticket 03 (docs/pi-omp-git-reference.md §52–§56).
 *
 * Freshness algorithm (§56): a fresh row is served as-is; a row inside
 * the soft/hard band is refreshed synchronously (stale + visible warning
 * when the refresh fails); a `pr-diff` row in that band serves stale and
 * schedules a deduplicated background refresh; a row past the hard TTL
 * is evicted and fetched live. Disabled caching, no credential
 * fingerprint, or a degraded store all mean uncached operation.
 */

import type { CacheKey, CacheStore } from "./db.ts";

export interface CacheIdentity {
	kind: "issue" | "pr" | "pr-diff";
	host: string;
	owner: string;
	repo: string;
	number: number;
	includeComments: boolean;
}

export interface CacheReadOutcome {
	text: string;
	/** Present when a cached copy was served because a refresh failed. */
	staleNotice?: string;
	fromCache: boolean;
}

export interface CacheSettings {
	enabled: boolean;
	softTtlSec: number;
	hardTtlSec: number;
}

export interface GithubCacheDeps {
	getStore: () => CacheStore;
	getSettings: () => CacheSettings;
	/** SHA-256 credential fingerprint, or null when caching is bypassed. */
	authKey: () => string | null;
	now?: () => number;
}

export interface GithubCache {
	readThrough(
		identity: CacheIdentity,
		live: (signal?: AbortSignal) => Promise<string>,
		signal?: AbortSignal,
	): Promise<CacheReadOutcome>;
	/** Drop the row for one identity (used by mutation invalidation later). */
	invalidate(identity: CacheIdentity): void;
	/** Resolves once no background refresh is in flight (test seam). */
	flushBackground(): Promise<void>;
}

/** Stable dedup/lookup key: fingerprint + full resource identity. */
export function cacheKey(authKey: string, identity: CacheIdentity): string {
	return [
		authKey,
		identity.host,
		identity.owner,
		identity.repo,
		identity.kind,
		identity.number,
		identity.includeComments ? 1 : 0,
	].join("\u0000");
}

/** Visible staleness warning served when a synchronous refresh fails (§56). */
export const STALE_NOTICE =
	"GitHub cache: refresh failed; showing the cached copy.";

export function createGithubCache(deps: GithubCacheDeps): GithubCache {
	const now = deps.now ?? (() => Date.now());
	const backgroundRefreshes = new Map<string, Promise<void>>();
	let store: CacheStore | null = null;
	let degraded = false;

	const handle = (): CacheStore | null => {
		if (degraded) return null;
		if (!store) {
			try {
				store = deps.getStore();
			} catch {
				degraded = true;
				return null;
			}
		}
		return store;
	};

	function degrade(): void {
		degraded = true;
		store = null;
	}

	function safeGet(cache: CacheStore, key: CacheKey) {
		try {
			return cache.get(key);
		} catch {
			degrade();
			return undefined;
		}
	}

	function safeSet(
		cache: CacheStore,
		key: CacheKey,
		entry: { content: string; fetchedAtMs: number },
	): void {
		try {
			cache.set(key, entry);
		} catch {
			degrade();
		}
	}

	function safeRemove(cache: CacheStore, key: CacheKey): void {
		try {
			cache.remove(key);
		} catch {
			degrade();
		}
	}

	function keyOf(identity: CacheIdentity): CacheKey | null {
		const authKey = deps.authKey();
		if (!authKey) return null;
		return {
			authKey,
			host: identity.host,
			repo: `${identity.owner}/${identity.repo}`,
			kind: identity.kind,
			number: identity.number,
			includeComments: identity.includeComments,
		};
	}

	function scheduleBackgroundRefresh(
		key: CacheKey,
		dedupKey: string,
		live: (signal?: AbortSignal) => Promise<string>,
		signal?: AbortSignal,
	): void {
		if (backgroundRefreshes.has(dedupKey)) {
			return; // deduplicated (§56)
		}
		const refresh = live(signal)
			.then((text) => {
				const cache = handle();
				if (cache) safeSet(cache, key, { content: text, fetchedAtMs: now() });
			})
			.catch(() => {
				// A background refresh failure must not surface as an error —
				// the stale copy was already served.
			})
			.finally(() => {
				backgroundRefreshes.delete(dedupKey);
			});
		backgroundRefreshes.set(dedupKey, refresh);
	}

	return {
		async readThrough(identity, live, signal) {
			const settings = deps.getSettings();
			const key = keyOf(identity);
			if (!settings.enabled || !key) {
				return { text: await live(signal), fromCache: false };
			}
			const cache = handle();
			if (!cache) {
				return { text: await live(signal), fromCache: false };
			}

			const entry = safeGet(cache, key);
			const timestamp = now();
			if (!entry) {
				const text = await live(signal);
				safeSet(cache, key, { content: text, fetchedAtMs: timestamp });
				return { text, fromCache: false };
			}

			const ageMs = timestamp - entry.fetchedAtMs;
			const softTtlMs = settings.softTtlSec * 1000;
			const hardTtlMs = settings.hardTtlSec * 1000;

			if (ageMs <= softTtlMs) {
				return { text: entry.content, fromCache: true };
			}

			if (ageMs <= hardTtlMs) {
				if (identity.kind === "pr-diff") {
					// §56: serve stale and schedule a deduplicated background refresh.
					scheduleBackgroundRefresh(
						key,
						cacheKey(deps.authKey() ?? "", identity),
						live,
						signal,
					);
					return { text: entry.content, fromCache: true };
				}
				try {
					const text = await live(signal);
					safeSet(cache, key, { content: text, fetchedAtMs: now() });
					return { text, fromCache: false };
				} catch {
					return {
						text: entry.content,
						fromCache: true,
						staleNotice: STALE_NOTICE,
					};
				}
			}

			// Past the hard TTL: evict and refetch.
			safeRemove(cache, key);
			const text = await live(signal);
			safeSet(cache, key, { content: text, fetchedAtMs: timestamp });
			return { text, fromCache: false };
		},

		invalidate(identity) {
			const key = keyOf(identity);
			const cache = handle();
			if (!key || !cache) return;
			safeRemove(cache, key);
		},

		async flushBackground() {
			await Promise.allSettled([...backgroundRefreshes.values()]);
		},
	};
}
