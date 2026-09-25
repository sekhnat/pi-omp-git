/**
 * The shared commit-option contract (docs/pi-omp-git-reference.md §73,
 * ADR 0004: one parser, two hosts).
 *
 * Both `/commit` (Pi) and `pi-omp-git commit` (CLI) feed the same
 * `parseCommitTokens`. Parsing is strict: unknown flags, missing or
 * empty values for value-taking options, flag-shaped values supplied as
 * option values, duplicate value-taking options, and bare positional
 * arguments are errors raised before any repository work. A `--`
 * delimiter turns the remaining words into free-form commit context; an
 * explicit `--context` is never silently overwritten by it.
 *
 * Pi receives a raw command string, so `tokenizeCommitInput` lexes it
 * with shell-like quoting/escape rules first; the CLI hands its argv
 * tokens straight to the parser (quoted argv values are already single
 * tokens). The CLI-only `-C <dir>` is extracted by the host before the
 * shared parser runs.
 */

import { PiOmpGitError } from "../shared/errors.ts";

export interface CommitArgs {
	all: boolean;
	dryRun: boolean;
	push: boolean;
	noChangelog: boolean;
	context?: string;
	model?: string;
}

const BOOLEAN_FLAGS = new Set([
	"--all",
	"--dry-run",
	"--push",
	"--no-changelog",
]);
const VALUE_OPTIONS = new Set(["--model", "--context"]);

/**
 * Parse a raw Pi `/commit` input string: tokenize with shell-like
 * quoting rules, then apply the shared strict token parser.
 */
export function parseCommitArgs(input: string): CommitArgs {
	return parseCommitTokens(tokenizeCommitInput(input));
}

/**
 * Parse commit option tokens. Throws PiOmpGitError with an actionable
 * message on any invalid form.
 */
export function parseCommitTokens(tokens: string[]): CommitArgs {
	const result: CommitArgs = {
		all: false,
		dryRun: false,
		push: false,
		noChangelog: false,
	};
	const seenValues = new Set<string>();
	const trailing: string[] = [];
	let trailingMode = false;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === undefined) continue;
		if (trailingMode) {
			trailing.push(token);
			continue;
		}
		if (token === "--") {
			trailingMode = true;
			continue;
		}
		if (BOOLEAN_FLAGS.has(token)) {
			if (token === "--all") result.all = true;
			else if (token === "--dry-run") result.dryRun = true;
			else if (token === "--push") result.push = true;
			else result.noChangelog = true;
			continue;
		}
		if (VALUE_OPTIONS.has(token)) {
			const value = tokens[index + 1];
			if (value === undefined) {
				throw new PiOmpGitError(`${token} requires a value.`);
			}
			if (value.startsWith("--")) {
				throw new PiOmpGitError(
					`${token} requires a value; ${value} looks like another option.`,
				);
			}
			if (value.trim() === "") {
				throw new PiOmpGitError(`${token} requires a non-empty value.`);
			}
			if (seenValues.has(token)) {
				throw new PiOmpGitError(`${token} was given more than once.`);
			}
			seenValues.add(token);
			if (token === "--model") result.model = value;
			else result.context = value;
			index += 1;
			continue;
		}
		if (token.startsWith("--")) {
			const equals = token.indexOf("=");
			const name = equals === -1 ? token : token.slice(0, equals);
			if (BOOLEAN_FLAGS.has(name)) {
				throw new PiOmpGitError(`${name} does not take a value.`);
			}
			if (VALUE_OPTIONS.has(name)) {
				const value = token.slice(equals + 1);
				if (value.trim() === "") {
					throw new PiOmpGitError(`${name} requires a non-empty value.`);
				}
				if (seenValues.has(name)) {
					throw new PiOmpGitError(`${name} was given more than once.`);
				}
				seenValues.add(name);
				if (name === "--model") result.model = value;
				else result.context = value;
				continue;
			}
			throw new PiOmpGitError(`Unknown option: ${name}.`);
		}
		if (token.startsWith("-")) {
			throw new PiOmpGitError(`Unknown option: ${token}.`);
		}
		throw new PiOmpGitError(
			`Unexpected argument: ${token} (use -- <context> for free-form commit context).`,
		);
	}
	if (trailing.length > 0) {
		if (result.context !== undefined) {
			throw new PiOmpGitError(
				"context was given more than once — an explicit --context cannot be combined with trailing context after --.",
			);
		}
		result.context = trailing.join(" ");
	}
	return result;
}

/**
 * Tokenize a raw `/commit` argument string the way a shell would:
 * whitespace-separated words, double-quoted strings with backslash
 * escapes, single-quoted strings, and backslash escapes in bare words.
 * Quoted segments may appear inside a word (`--context="release notes"`),
 * and unterminated quotes or escapes are parse errors.
 */
export function tokenizeCommitInput(input: string): string[] {
	const tokens: string[] = [];
	let index = 0;
	while (index < input.length) {
		const char = input[index] ?? "";
		if (char === " " || char === "\t" || char === "\n" || char === "\r") {
			index += 1;
			continue;
		}
		let word = "";
		let hasWord = false;
		while (index < input.length) {
			const inner = input[index] ?? "";
			if (inner === " " || inner === "\t" || inner === "\n" || inner === "\r") {
				index += 1;
				break;
			}
			if (inner === "\\") {
				const next = input[index + 1];
				if (next === undefined) {
					throw new PiOmpGitError("Unterminated escape in commit arguments.");
				}
				word += next;
				hasWord = true;
				index += 2;
				continue;
			}
			if (inner === '"' || inner === "'") {
				const quote = inner;
				index += 1;
				let closed = false;
				while (index < input.length) {
					const quoted = input[index] ?? "";
					if (quote === '"' && quoted === "\\") {
						const next = input[index + 1];
						if (next === undefined) break;
						word += next;
						index += 2;
						continue;
					}
					if (quoted === quote) {
						closed = true;
						index += 1;
						break;
					}
					word += quoted;
					index += 1;
				}
				if (!closed) {
					throw new PiOmpGitError("Unterminated quoted commit argument.");
				}
				hasWord = true;
				continue;
			}
			word += inner;
			hasWord = true;
			index += 1;
		}
		if (hasWord) tokens.push(word);
	}
	return tokens;
}
