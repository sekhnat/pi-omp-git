import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REQUIRED_PEERS = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
];

function normalizePackedPath(value) {
	return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function inspectPackage(manifest, packedFiles) {
	const errors = [];
	const peers = manifest.peerDependencies ?? {};
	const devDependencies = manifest.devDependencies ?? {};
	for (const peer of REQUIRED_PEERS) {
		if (peers[peer] !== "*")
			errors.push(`Missing required peer declaration ${peer}@*`);
		if (!devDependencies[peer])
			errors.push(`Missing pinned development dependency for ${peer}`);
	}
	const files = new Set(packedFiles.map(normalizePackedPath));
	const entrypoints = [
		...Object.values(manifest.bin ?? {}),
		...(manifest.pi?.extensions ?? []),
	];
	if (entrypoints.length === 0)
		errors.push("Manifest declares no runtime entrypoints");
	for (const entrypoint of entrypoints) {
		const path = normalizePackedPath(entrypoint);
		if (!files.has(path)) errors.push(`Packed entrypoint is missing: ${path}`);
	}
	for (const required of ["package.json", "README.md", "dist/cli.js"]) {
		if (!files.has(required))
			errors.push(`Required packed file is missing: ${required}`);
	}
	if (manifest.license !== "MIT")
		errors.push("Manifest must declare the MIT license");
	return errors;
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		encoding: "utf8",
		maxBuffer: 10 * 1024 * 1024,
		windowsHide: true,
		shell: process.platform === "win32",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const details = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
		throw new Error(
			`${command} ${args.join(" ")} failed (${result.status}):\n${details}`,
		);
	}
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function assertValidPackage(manifest, packedFiles) {
	const errors = inspectPackage(manifest, packedFiles);
	if (errors.length > 0)
		throw new Error(
			`Packed package contract failed:\n- ${errors.join("\n- ")}`,
		);
}

async function smokePack() {
	const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const sourceManifest = JSON.parse(
		await readFile(join(projectRoot, "package.json"), "utf8"),
	);
	const scratch = await mkdtemp(join(tmpdir(), "pi-omp-git-smoke-"));
	try {
		const packResult = JSON.parse(
			run("npm", ["pack", "--json", "--pack-destination", scratch], {
				cwd: projectRoot,
			}).stdout,
		);
		const packed = packResult[0];
		if (!packed?.filename || !Array.isArray(packed.files)) {
			throw new Error("npm pack --json did not return a tarball and file list");
		}
		const packedFiles = packed.files.map((file) => file.path);
		assertValidPackage(sourceManifest, packedFiles);
		const tarball = join(scratch, packed.filename);
		const fixture = join(scratch, "fixture");
		await mkdir(fixture);
		await writeFile(join(fixture, "package.json"), '{"private":true}\n');
		const peerSpecs = REQUIRED_PEERS.map(
			(peer) => `${peer}@${sourceManifest.devDependencies[peer]}`,
		);
		const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
		run(
			npmCommand,
			[
				"install",
				"--prefix",
				fixture,
				"--no-save",
				"--no-package-lock",
				"--no-audit",
				"--no-fund",
				tarball,
				...peerSpecs,
			],
			{ cwd: projectRoot },
		);

		const packageRoot = join(
			fixture,
			"node_modules",
			...sourceManifest.name.split("/"),
		);
		const installedManifest = JSON.parse(
			await readFile(join(packageRoot, "package.json"), "utf8"),
		);
		assertValidPackage(installedManifest, packedFiles);
		const cliRelativePath =
			typeof installedManifest.bin === "string"
				? installedManifest.bin
				: installedManifest.bin?.["pi-omp-git"];
		if (!cliRelativePath)
			throw new Error("Packed manifest does not expose the pi-omp-git CLI");
		const cliResult = run(
			process.execPath,
			[resolve(packageRoot, cliRelativePath), "--help"],
			{ cwd: fixture },
		);
		if (!/pi-omp-git|Usage:/i.test(cliResult.stdout)) {
			throw new Error("Packed CLI --help did not print its usage");
		}

		const piPackageRoot = join(
			fixture,
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
		);
		const piManifest = JSON.parse(
			await readFile(join(piPackageRoot, "package.json"), "utf8"),
		);
		const piBin =
			typeof piManifest.bin === "string" ? piManifest.bin : piManifest.bin?.pi;
		if (!piBin)
			throw new Error(
				"Installed Pi host package does not expose its CLI loader",
			);
		const extensionPath = installedManifest.pi?.extensions?.[0];
		if (!extensionPath)
			throw new Error(
				"Packed manifest does not declare a Pi extension entrypoint",
			);
		const probePath = join(scratch, "loader-probe.ts");
		await writeFile(
			probePath,
			'export default function (pi) {\n\tpi.registerFlag("omp-git-smoke-loaded", { description: "Smoke loader probe", type: "boolean", default: false });\n}\n',
		);
		const piResult = run(
			process.execPath,
			[
				resolve(piPackageRoot, piBin),
				"--offline",
				"--no-session",
				"--no-context-files",
				"--extension",
				resolve(packageRoot, extensionPath),
				"--extension",
				probePath,
				"--help",
			],
			{
				cwd: fixture,
				env: {
					PI_OFFLINE: "1",
					PI_CODING_AGENT_DIR: join(scratch, "pi-agent"),
				},
			},
		);
		if (
			!`${piResult.stdout}\n${piResult.stderr}`.includes(
				"--omp-git-smoke-loaded",
			)
		) {
			throw new Error(
				"Pi CLI did not load the extension factory through --extension",
			);
		}
		console.log(
			`smoke:pack passed (${packed.filename}, ${packedFiles.length} packed files)`,
		);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

if (
	process.argv[1] &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
	smokePack().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
