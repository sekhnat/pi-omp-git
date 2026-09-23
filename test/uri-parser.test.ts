/**
 * Virtual GitHub URI grammar and validation — ticket 02
 * (docs/pi-omp-git-reference.md §8.1, §9).
 */

import { describe, expect, it } from "vitest";
import { parseGithubUri } from "../src/github/resources/parser.ts";

const issue = (extra: object) => ({ kind: "issue", comments: true, ...extra });

describe("issue:// grammar", () => {
	it("parses a bare numbered resource (current repository)", () => {
		expect(parseGithubUri("issue://123")).toEqual(issue({ number: 123 }));
	});

	it("parses a repository-scoped issue", () => {
		expect(parseGithubUri("issue://owner/repo/123")).toEqual(
			issue({ owner: "owner", repo: "repo", number: 123 }),
		);
	});

	it("parses a host-qualified issue", () => {
		expect(parseGithubUri("issue://github.example.com/owner/repo/123")).toEqual(
			issue({
				host: "github.example.com",
				owner: "owner",
				repo: "repo",
				number: 123,
			}),
		);
	});

	it("parses the repository-scoped listing form (ticket 07)", () => {
		expect(parseGithubUri("issue://owner/repo")).toEqual({
			kind: "issue-list",
			owner: "owner",
			repo: "repo",
			state: "open",
			limit: 30,
		});
	});

	it("parses bare and host-qualified listing forms", () => {
		expect(parseGithubUri("issue://")).toEqual({
			kind: "issue-list",
			state: "open",
			limit: 30,
		});
		expect(parseGithubUri("issue://github.example.com/owner/repo")).toEqual({
			kind: "issue-list",
			host: "github.example.com",
			owner: "owner",
			repo: "repo",
			state: "open",
			limit: 30,
		});
	});

	it("decodes percent-encoded segments", () => {
		expect(parseGithubUri("issue://o%2Ew/r/123")).toEqual(
			issue({ owner: "o.w", repo: "r", number: 123 }),
		);
	});

	it("accepts the comments suppression flag in both spellings", () => {
		expect(parseGithubUri("issue://123?comments=0")).toEqual(
			issue({ number: 123, comments: false }),
		);
		expect(parseGithubUri("issue://123?comments=false")).toEqual(
			issue({ number: 123, comments: false }),
		);
		expect(parseGithubUri("issue://123?comments=true")).toEqual(
			issue({ number: 123 }),
		);
	});

	it("rejects unknown or malformed query parameters", () => {
		for (const bad of [
			"issue://123?comments=maybe",
			"issue://123?state=open",
			"issue://123?bogus",
			"issue://123?",
		]) {
			expect(() => parseGithubUri(bad)).toThrow(/Invalid GitHub resource URI/);
		}
	});
});

describe("listing query parameters (§10)", () => {
	it("parses filters, defaults, merged PRs, and clamps limits", () => {
		expect(parseGithubUri("issue://")).toEqual({
			kind: "issue-list",
			state: "open",
			limit: 30,
		});
		expect(parseGithubUri("issue://owner/repo")).toEqual({
			kind: "issue-list",
			owner: "owner",
			repo: "repo",
			state: "open",
			limit: 30,
		});
		expect(
			parseGithubUri(
				"issue://owner/repo?state=closed&limit=25&author=alice&label=help%20wanted",
			),
		).toEqual({
			kind: "issue-list",
			owner: "owner",
			repo: "repo",
			state: "closed",
			limit: 25,
			author: "alice",
			label: "help wanted",
		});
		expect(
			parseGithubUri(
				"pr://?state=merged&limit=999999999999999999999999999999&author=alice&label=bug",
			),
		).toEqual({
			kind: "pr-list",
			state: "merged",
			limit: 100,
			author: "alice",
			label: "bug",
		});
		expect(
			parseGithubUri("pr://github.example.com/owner/repo?state=all"),
		).toEqual({
			kind: "pr-list",
			host: "github.example.com",
			owner: "owner",
			repo: "repo",
			state: "all",
			limit: 30,
		});
	});

	it("rejects invalid listing states, limits, and empty filters", () => {
		for (const bad of [
			"issue://?state=merged",
			"pr://?state=unknown",
			"pr://?limit=0",
			"pr://?limit=1.5",
			"issue://?author=",
			"issue://?comments=0",
			"pr://123?state=open",
		]) {
			expect(() => parseGithubUri(bad)).toThrow(/Invalid GitHub resource URI/);
		}
	});
});

describe("issue:// validation rejections (§9)", () => {
	it("rejects non-positive and non-numeric numbers", () => {
		for (const bad of [
			"issue://0",
			"issue://-1",
			"issue://abc",
			"issue://1.5",
			"issue://12_3",
		]) {
			expect(() => parseGithubUri(bad)).toThrow(/issue number/);
		}
	});

	it("rejects traversal segments, raw and encoded", () => {
		for (const bad of [
			"issue://owner/../123",
			"issue://../123",
			"issue://owner/%2e%2e/123",
			"issue://%2E/123",
		]) {
			expect(() => parseGithubUri(bad)).toThrow(
				/traversal|Invalid GitHub resource URI/,
			);
		}
	});

	it("rejects empty path segments, raw and encoded", () => {
		for (const bad of [
			"issue://owner//123",
			"issue://owner/",
			"issue://%2F/123",
			"issue://owner/repo/",
		]) {
			expect(() => parseGithubUri(bad)).toThrow(
				/empty|Invalid GitHub resource URI/,
			);
		}
	});

	it("rejects invalid percent-encoding", () => {
		for (const bad of [
			"issue://%zz/123",
			"issue://owner%/repo/123",
			"issue://ow%2/r/123",
		]) {
			expect(() => parseGithubUri(bad)).toThrow(
				/percent|Invalid GitHub resource URI/,
			);
		}
	});

	it("rejects unexpected suffixes", () => {
		for (const bad of [
			"issue://123/foo",
			"issue://owner/repo/123/diff",
			"issue://owner/repo/123/x/y",
		]) {
			expect(() => parseGithubUri(bad)).toThrow(/Invalid GitHub resource URI/);
		}
	});

	it("rejects diff on issue resources", () => {
		expect(() => parseGithubUri("issue://123/diff")).toThrow(/diff/);
	});

	it("rejects a lone non-number segment", () => {
		expect(() => parseGithubUri("issue://owner")).toThrow(
			/Invalid GitHub resource URI/,
		);
	});
});

describe("pr:// grammar (parsed in 02, rendered in 04)", () => {
	it("parses single-PR forms", () => {
		expect(parseGithubUri("pr://123")).toEqual({
			kind: "pr",
			comments: true,
			number: 123,
		});
		expect(parseGithubUri("pr://owner/repo/123")).toEqual({
			kind: "pr",
			owner: "owner",
			repo: "repo",
			number: 123,
			comments: true,
		});
		expect(parseGithubUri("pr://github.example.com/owner/repo/123")).toEqual({
			kind: "pr",
			host: "github.example.com",
			owner: "owner",
			repo: "repo",
			number: 123,
			comments: true,
		});
	});

	it("rejects invalid diff indices on PR resources", () => {
		for (const bad of [
			"pr://123/diff/0",
			"pr://123/diff/-1",
			"pr://123/diff/x",
		]) {
			expect(() => parseGithubUri(bad)).toThrow(/diff/);
		}
	});

	it("accepts valid diff resource shapes", () => {
		expect(parseGithubUri("pr://123/diff")).toEqual({
			kind: "pr-diff",
			number: 123,
		});
		expect(parseGithubUri("pr://123/diff/2")).toEqual({
			kind: "pr-diff",
			number: 123,
			fileIndex: 2,
		});
		expect(parseGithubUri("pr://123/diff/all")).toEqual({
			kind: "pr-diff",
			number: 123,
			fileIndex: "all",
		});
		expect(parseGithubUri("pr://owner/repo/123/diff/all")).toEqual({
			kind: "pr-diff",
			owner: "owner",
			repo: "repo",
			number: 123,
			fileIndex: "all",
		});
	});

	it("rejects unexpected suffixes on PR resources", () => {
		expect(() => parseGithubUri("pr://123/foo")).toThrow(
			/Invalid GitHub resource URI/,
		);
	});

	it("rejects diff on issue resources but not on PR resources", () => {
		expect(() => parseGithubUri("issue://owner/repo/123/diff")).toThrow(/diff/);
	});
});
