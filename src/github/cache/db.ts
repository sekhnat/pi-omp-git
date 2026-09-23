/**
 * The SQLite cache store — ticket 03 (docs/pi-omp-git-reference.md §51, §55).
 *
 * Uses the built-in `node:sqlite` module (no native dependency). Every
 * operation is guarded: an unavailable or corrupted database degrades to
 * uncached operation (`handle()` returns null) — a cache failure must
 * never make GitHub unusable (§55).
 *
 * Permissions (Unix-like): cache directory 0700, database 0600, WAL and
 * SHM files 0600. SQLite is initialized with WAL journaling,
 * synchronous = NORMAL, and a 5000 ms busy timeout.
 */

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface CacheEntry {
	content: string;
	fetchedAtMs: number;
}

export interface CacheKey {
	authKey: string;
	host: string;
	repo: string;
	kind: "issue" | "pr" | "pr-diff";
	number: number;
	includeComments: boolean;
}

export interface CacheStore {
	get(key: CacheKey): CacheEntry | undefined;
	set(key: CacheKey, entry: CacheEntry): void;
	remove(key: CacheKey): void;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export class SqliteCacheStore implements CacheStore {
	private db: DatabaseSync | null = null;
	private degraded = false;

	constructor(private readonly path: string) {}

	/**
	 * The open database, or null when degraded. Opening is lazy and
	 * single-shot; the first operation that throws also degrades the
	 * store for the remainder of the session (corruption, probe failure).
	 */
	private handle(): DatabaseSync | null {
		if (this.degraded) return null;
		if (this.db) return this.db;
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			chmodBestEffort(dirname(this.path), DIR_MODE);
			const db = new DatabaseSync(this.path);
			db.exec("PRAGMA journal_mode = WAL");
			db.exec("PRAGMA synchronous = NORMAL");
			db.exec("PRAGMA busy_timeout = 5000");
			db.exec(`CREATE TABLE IF NOT EXISTS github_cache (
	auth_key TEXT NOT NULL,
	host TEXT NOT NULL,
	repo TEXT NOT NULL,
	kind TEXT NOT NULL,
	number INTEGER NOT NULL,
	include_comments INTEGER NOT NULL,
	content TEXT NOT NULL,
	fetched_at_ms INTEGER NOT NULL,
	PRIMARY KEY (auth_key, host, repo, kind, number, include_comments)
)`);
			chmodBestEffort(this.path, FILE_MODE);
			chmodBestEffort(`${this.path}-wal`, FILE_MODE);
			chmodBestEffort(`${this.path}-shm`, FILE_MODE);
			this.db = db;
			return db;
		} catch {
			this.degrade();
			return null;
		}
	}

	get(key: CacheKey): CacheEntry | undefined {
		const db = this.handle();
		if (!db) return undefined;
		try {
			const row = db
				.prepare(
					"SELECT content, fetched_at_ms FROM github_cache WHERE auth_key = ? AND host = ? AND repo = ? AND kind = ? AND number = ? AND include_comments = ?",
				)
				.get(
					key.authKey,
					key.host,
					key.repo,
					key.kind,
					key.number,
					key.includeComments ? 1 : 0,
				) as { content: string; fetched_at_ms: number } | undefined;
			if (!row) return undefined;
			return { content: row.content, fetchedAtMs: Number(row.fetched_at_ms) };
		} catch {
			this.degrade();
			return undefined;
		}
	}

	set(key: CacheKey, entry: CacheEntry): void {
		const db = this.handle();
		if (!db) return;
		try {
			db.prepare(
				"INSERT OR REPLACE INTO github_cache (auth_key, host, repo, kind, number, include_comments, content, fetched_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				key.authKey,
				key.host,
				key.repo,
				key.kind,
				key.number,
				key.includeComments ? 1 : 0,
				entry.content,
				entry.fetchedAtMs,
			);
			chmodBestEffort(this.path, FILE_MODE);
			chmodBestEffort(`${this.path}-wal`, FILE_MODE);
			chmodBestEffort(`${this.path}-shm`, FILE_MODE);
		} catch {
			this.degrade();
		}
	}

	remove(key: CacheKey): void {
		const db = this.handle();
		if (!db) return;
		try {
			db.prepare(
				"DELETE FROM github_cache WHERE auth_key = ? AND host = ? AND repo = ? AND kind = ? AND number = ? AND include_comments = ?",
			).run(
				key.authKey,
				key.host,
				key.repo,
				key.kind,
				key.number,
				key.includeComments ? 1 : 0,
			);
		} catch {
			this.degrade();
		}
	}

	private degrade(): void {
		this.degraded = true;
		try {
			this.db?.close();
		} catch {
			// ignore — the database is unusable
		}
		this.db = null;
	}
}

function chmodBestEffort(path: string, mode: number): void {
	if (!existsSync(path)) return;
	try {
		chmodSync(path, mode);
	} catch {
		// Windows or restrictive mounts — best effort only.
	}
}

/**
 * Open the store at `path`, degrading to a null store on any failure
 * (missing node:sqlite probe, unwritable path, corruption). The null
 * store makes every cache operation a no-op.
 */
export function openCacheStore(path: string): CacheStore {
	try {
		// §51: probe `node:sqlite` availability up front so a broken
		// build degrades here rather than mid-read.
		new DatabaseSync(":memory:").close();
	} catch {
		return new NullCacheStore();
	}
	return new SqliteCacheStore(path);
}

export class NullCacheStore implements CacheStore {
	get(): CacheEntry | undefined {
		return undefined;
	}
	set(): void {}
	remove(): void {}
}
