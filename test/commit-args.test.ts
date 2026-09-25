/**
 * The shared commit-argument contract (§73), enforced as one
 * table-driven matrix against BOTH host adapters: the Pi `/commit`
 * raw-input parser and the companion CLI's argv parser. Every logical
 * option must resolve identically; every invalid form must be rejected
 * with an equivalent error before any repository mutation.
 *
 * Host-only surface (`-C`) is asserted on the CLI adapter only; the Pi
 * adapter must reject it as an unknown option.
 */

import { describe, expect, it } from "vitest";
import { parseCommitCliArgs } from "../src/cli.ts";
import { parseCommitArgs } from "../src/index.ts";

interface CommitOptions {
	all: boolean;
	dryRun: boolean;
	push: boolean;
	noChangelog: boolean;
	context?: string;
	model?: string;
}

interface MatrixCase {
	name: string;
	/** Raw Pi `/commit` input (tokenized by the host before parsing). */
	pi: string;
	/** Companion CLI argv tokens for the commit subcommand. */
	cli: string[];
	/** Expected parse result (both hosts). */
	expect?: CommitOptions;
	/** Expected parse error (both hosts). */
	error?: RegExp;
	/** Expected parse error on the Pi adapter only (host-only surface). */
	piError?: RegExp;
	/** CLI-only `-C <dir>` expectation. */
	cliDir?: string;
}

const none: CommitOptions = {
	all: false,
	dryRun: false,
	push: false,
	noChangelog: false,
};

const cases: MatrixCase[] = [
	{
		name: "no arguments",
		pi: "",
		cli: [],
		expect: none,
	},
	{
		name: "every flag",
		pi: "--all --dry-run --push --no-changelog",
		cli: ["--all", "--dry-run", "--push", "--no-changelog"],
		expect: { ...none, all: true, dryRun: true, push: true, noChangelog: true },
	},
	{
		name: "value options",
		pi: "--model gpt-5 --context notes",
		cli: ["--model", "gpt-5", "--context", "notes"],
		expect: { ...none, model: "gpt-5", context: "notes" },
	},
	{
		name: "equals value forms",
		pi: "--model=gpt-5 --context=notes",
		cli: ["--model=gpt-5", "--context=notes"],
		expect: { ...none, model: "gpt-5", context: "notes" },
	},
	{
		name: "quoted multiword context",
		pi: '--context "release notes"',
		cli: ["--context", "release notes"],
		expect: { ...none, context: "release notes" },
	},
	{
		name: "trailing free-form context after --",
		pi: "-- release notes for 0.1.0",
		cli: ["--", "release", "notes", "for", "0.1.0"],
		expect: { ...none, context: "release notes for 0.1.0" },
	},
	{
		name: "multiple flags with quoted context and model",
		pi: '--all --dry-run --model provider/model-id --context "release notes"',
		cli: [
			"--all",
			"--dry-run",
			"--model",
			"provider/model-id",
			"--context",
			"release notes",
		],
		expect: {
			...none,
			all: true,
			dryRun: true,
			model: "provider/model-id",
			context: "release notes",
		},
	},
	{
		name: "flag-shaped words after -- are context, not options",
		pi: "-- --all",
		cli: ["--", "--all"],
		expect: { ...none, context: "--all" },
	},
	{
		name: "duplicate context is an error",
		pi: "--context a --context b",
		cli: ["--context", "a", "--context", "b"],
		error: /context/i,
	},
	{
		name: "duplicate model is an error",
		pi: "--model a --model b",
		cli: ["--model", "a", "--model", "b"],
		error: /model/i,
	},
	{
		name: "explicit context is not overwritten by trailing context",
		pi: "--context a -- more",
		cli: ["--context", "a", "--", "more"],
		error: /context/i,
	},
	{
		name: "missing model value at end",
		pi: "--model",
		cli: ["--model"],
		error: /model/i,
	},
	{
		name: "missing context value at end",
		pi: "--context",
		cli: ["--context"],
		error: /context/i,
	},
	{
		name: "flag-shaped value for context",
		pi: "--context --push",
		cli: ["--context", "--push"],
		error: /context/i,
	},
	{
		name: "flag-shaped value for model",
		pi: "--model --dry-run",
		cli: ["--model", "--dry-run"],
		error: /model/i,
	},
	{
		name: "empty model value",
		pi: "--model=",
		cli: ["--model="],
		error: /model/i,
	},
	{
		name: "empty model argument",
		pi: '--model ""',
		cli: ["--model", ""],
		error: /model/i,
	},
	{
		name: "empty context value",
		pi: "--context=",
		cli: ["--context="],
		error: /context/i,
	},
	{
		name: "unknown flag",
		pi: "--unknown",
		cli: ["--unknown"],
		error: /unknown/i,
	},
	{
		name: "unknown flag with value form",
		pi: "--unknown=1",
		cli: ["--unknown=1"],
		error: /unknown/i,
	},
	{
		name: "bare positional argument",
		pi: "notes",
		cli: ["notes"],
		error: /unexpected|positional/i,
	},
	{
		name: "cli-only -C directory",
		pi: "-C /tmp/repo --all",
		cli: ["-C", "/tmp/repo", "--all"],
		expect: { ...none, all: true },
		piError: /unknown/i,
		cliDir: "/tmp/repo",
	},
];

describe("shared commit argument matrix (§73)", () => {
	for (const matrixCase of cases) {
		it(`${matrixCase.name} — pi adapter`, () => {
			const piError = matrixCase.piError ?? matrixCase.error;
			if (piError) {
				expect(() => parseCommitArgs(matrixCase.pi)).toThrow(piError);
			} else {
				expect(matrixCase.expect).toBeDefined();
				expect(parseCommitArgs(matrixCase.pi)).toEqual(matrixCase.expect);
			}
		});
		it(`${matrixCase.name} — cli adapter`, () => {
			if (matrixCase.error) {
				expect(() => parseCommitCliArgs(matrixCase.cli)).toThrow(
					matrixCase.error,
				);
			} else {
				expect(matrixCase.expect).toBeDefined();
				const parsed = parseCommitCliArgs(matrixCase.cli);
				expect(parsed.options).toEqual(matrixCase.expect);
				if (matrixCase.cliDir !== undefined) {
					expect(parsed.dir).toBe(matrixCase.cliDir);
				}
			}
		});
	}
});
