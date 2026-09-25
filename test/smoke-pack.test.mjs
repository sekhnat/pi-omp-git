import { describe, expect, it } from "vitest";
import { inspectPackage, REQUIRED_PEERS } from "../scripts/smoke-pack.mjs";

const fixtureManifest = {
	name: "pi-omp-git",
	license: "MIT",
	peerDependencies: Object.fromEntries(
		REQUIRED_PEERS.map((peer) => [peer, "*"]),
	),
	devDependencies: Object.fromEntries(
		REQUIRED_PEERS.map((peer) => [peer, "1.0.0"]),
	),
	bin: { "pi-omp-git": "./bin/pi-omp-git.mjs" },
	pi: { extensions: ["./src/index.ts"] },
};
const fixtureFiles = [
	"package.json",
	"README.md",
	"dist/cli.js",
	"bin/pi-omp-git.mjs",
	"src/index.ts",
];

describe("packed package contract", () => {
	it("accepts the declared peers and published runtime entrypoints", () => {
		expect(inspectPackage(fixtureManifest, fixtureFiles)).toEqual([]);
	});

	it.each(REQUIRED_PEERS)("rejects a removed peer declaration: %s", (peer) => {
		const manifest = structuredClone(fixtureManifest);
		delete manifest.peerDependencies[peer];
		expect(inspectPackage(manifest, fixtureFiles).join(" ")).toContain(peer);
	});

	it.each(["bin/pi-omp-git.mjs", "dist/cli.js", "src/index.ts"])(
		"rejects a missing published runtime file: %s",
		(missing) => {
			const files = fixtureFiles.filter((file) => file !== missing);
			expect(inspectPackage(fixtureManifest, files).join(" ")).toContain(
				missing,
			);
		},
	);
});
