/**
 * Credential fingerprint — ticket 03 (docs/pi-omp-git-reference.md §54).
 *
 * Cache rows are scoped by a SHA-256 digest of the available credential
 * material so private content never leaks between GitHub identities on
 * the same machine. The token itself is never persisted — only the
 * digest. When no reliable credential material can be produced, caching
 * is bypassed rather than risking cross-account leakage.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * `gh` configuration directory: `GH_CONFIG_DIR`, then `~/.config/gh`
 * (gh's own resolution rules).
 */
export function ghConfigDir(env: NodeJS.ProcessEnv): string {
	return env.GH_CONFIG_DIR ?? join(homedir(), ".config", "gh");
}

/**
 * Build the cache auth key. Material sources (§54): the relevant GitHub
 * token environment variables and gh's authenticated-host configuration
 * (`hosts.yml`). Returns null when no reliable credential material
 * exists — the caller must then bypass caching.
 */
export function credentialFingerprint(env: NodeJS.ProcessEnv): string | null {
	const materials: string[] = [];
	if (env.GH_TOKEN) materials.push(`GH_TOKEN:${env.GH_TOKEN}`);
	if (env.GITHUB_TOKEN) materials.push(`GITHUB_TOKEN:${env.GITHUB_TOKEN}`);
	if (env.GH_ENTERPRISE_TOKEN)
		materials.push(`GH_ENTERPRISE_TOKEN:${env.GH_ENTERPRISE_TOKEN}`);
	if (env.GITHUB_ENTERPRISE_TOKEN)
		materials.push(`GITHUB_ENTERPRISE_TOKEN:${env.GITHUB_ENTERPRISE_TOKEN}`);

	const configDir = env.GH_CONFIG_DIR ?? join(homedir(), ".config", "gh");
	const hostsPath = join(configDir, "hosts.yml");
	if (existsSync(hostsPath)) {
		try {
			materials.push(`hosts:${readFileSync(hostsPath, "utf8")}`);
		} catch {
			// Unreadable config is not a credential; treat as absent.
		}
	}

	if (materials.length === 0) {
		return null;
	}
	return createHash("sha256")
		.update(materials.join("\u0000"), "utf8")
		.digest("hex");
}
