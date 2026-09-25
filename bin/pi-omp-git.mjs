#!/usr/bin/env node
/**
 * The pi-omp-git companion binary (ticket 24): `pi-omp-git git` opens
 * the interactive Git TUI on its own terminal via the shared
 * @earendil-works/pi-tui component library; `pi-omp-git commit` runs the
 * same agentic commit pipeline as the `/commit` command.
 *
 * Resolution tiers (openspec change git-only-cli-distribution):
 *  1. compiled `../dist/cli.js` — required under `node_modules`, where Node
 *     refuses to strip TypeScript from imported sources;
 *  2. `../src/cli.ts` via Node type stripping — source checkouts, whose
 *     `node_modules` satisfies the host package imports;
 *  3. `../src/cli.ts` again with a resolve hook that maps the four host
 *     package specifiers into the user's Pi installation. Pi's git clones
 *     have an empty `node_modules` (the pinned dev copies shadow the peer
 *     edges under `--omit=dev`), so the plain source fallback cannot resolve
 *     there; the hook runs the CLI against the user's own Pi runtime.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOST_PACKAGES = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
];

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = join(here, "..", "dist", "cli.js");
const srcEntry = join(here, "..", "src", "cli.ts");

function isHostSpecifier(specifier) {
	if (specifier === "typebox") return true;
	return HOST_PACKAGES.some(
		(name) => specifier === name || specifier.startsWith(`${name}/`),
	);
}

/** Package name of a specifier: `typebox`, `@scope/pkg`, ignoring subpaths. */
function packageName(specifier) {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * Resolve a bare root specifier against candidate roots by reading each
 * candidate's package exports. Plain Node resolution cannot be redirected
 * at an arbitrary root (import.meta.resolve ignores a parent argument), so
 * the hook computes the entry itself: `exports["."]` with the `import`
 * condition first, then `default`/`node`, then `main`.
 */
function resolveHostFromRoots(roots, specifier) {
	const name = packageName(specifier);
	const subPath = specifier.slice(name.length) || ".";
	for (const root of roots) {
		const pkgDir = join(root, name);
		const pkgPath = join(pkgDir, "package.json");
		if (!existsSync(pkgPath)) continue;
		let pkg;
		try {
			pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		} catch {
			continue;
		}
		let sub = null;
		if (pkg.exports) {
			const target = subPath === "." ? pkg.exports["."] : pkg.exports[subPath];
			if (typeof target === "string") sub = target;
			else if (target && typeof target === "object") {
				sub = target.import ?? target.default ?? target.node ?? null;
			}
		} else if (pkg.main && subPath === ".") {
			sub = pkg.main;
		}
		if (typeof sub !== "string") continue;
		// Realpath so the host package's own dependencies resolve from its real
		// location (package managers like pnpm install hosts through symlinks).
		return pathToFileURL(realpathSync(join(pkgDir, sub))).href;
	}
	return null;
}

/**
 * Locate the user's Pi installation: the npm global root of the active node
 * (no registry access — `npm root -g` only prints a path), plus the Pi
 * package's own nested `node_modules` for its dependencies. Returns null
 * when no Pi installation is discoverable.
 */
function discoverPiRoots() {
	const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
	const probe = spawnSync(npmCommand, ["root", "-g"], {
		encoding: "utf8",
		timeout: 10_000,
	});
	const globalRoot =
		probe.status === 0 ? (probe.stdout.split("\n")[0] ?? "").trim() : "";
	if (
		!globalRoot ||
		!existsSync(join(globalRoot, "@earendil-works", "pi-coding-agent"))
	) {
		return null;
	}
	return [
		globalRoot,
		join(globalRoot, "@earendil-works", "pi-coding-agent", "node_modules"),
	];
}

function missingHostPackage(error) {
	const match = /Cannot find package '([^']+)'/.exec(
		String(error?.message ?? ""),
	);
	if (!match) return null;
	const specifier = match[1];
	return isHostSpecifier(specifier) ? specifier : null;
}

async function importCliMain() {
	try {
		return await import(distEntry);
	} catch (distError) {
		if (existsSync(distEntry)) {
			// Compiled output exists but is broken: surface the real error instead
			// of silently masquerading as a source run.
			throw distError;
		}
		process.stderr.write(
			"pi-omp-git: no dist/ build found; running from TypeScript source\n",
		);
		try {
			return await import(srcEntry);
		} catch (sourceError) {
			const missing = missingHostPackage(sourceError);
			if (!missing) throw sourceError;
			const roots = discoverPiRoots();
			if (!roots) {
				process.stderr.write(
					`pi-omp-git: cannot resolve host package '${missing}' from this install; ` +
						"install Pi (it provides the host packages) or run `npm install` in the package directory\n",
				);
				throw sourceError;
			}
			process.stderr.write(
				"pi-omp-git: resolving host packages from the Pi installation\n",
			);
			if (typeof registerHooks === "function") {
				registerHooks({
					resolve(specifier, context, nextResolve) {
						if (isHostSpecifier(specifier)) {
							const url = resolveHostFromRoots(roots, specifier);
							if (url) return { url, shortCircuit: true };
						}
						return nextResolve(specifier, context);
					},
				});
			}
			return await import(srcEntry);
		}
	}
}

const { cliMain } = await importCliMain();
process.exitCode = await cliMain(process.argv.slice(2));
