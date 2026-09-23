/**
 * Virtual GitHub URI grammar and validation
 * (docs/pi-omp-git-reference.md §8, §9).
 *
 * Grammar (single resources carry the read target; list forms browse):
 *
 *   issue:// | issue://N | issue://owner/repo | issue://owner/repo/N
 *   issue://host/owner/repo | issue://host/owner/repo/N
 *   pr://    | pr://N    | pr://owner/repo    | pr://owner/repo/N
 *   pr://host/owner/repo    | pr://host/owner/repo/N
 *   pr://N/diff[/<I>|/all]  | pr://owner/repo/N/diff[/<I>|/all]
 *
 * Diff file indices are 1-based. Diff forms are bare or repo-scoped only
 * (§8.3 lists no host-qualified diff resources). Diff is rejected for
 * issue resources — they are read-only prose resources.
 *
 * Grammar ambiguities resolve by the trailing number: a segment-count
 * form ending in a positive integer is the single-resource reading
 * (`issue://host/owner/123` is issue 123 in `host/owner`, not a listing
 * of a repo named "123"); otherwise it is the listing form.
 */

import { PiOmpGitError } from "../../shared/errors.ts";

export type GithubResource =
	| { kind: "issue-list"; host?: string; owner?: string; repo?: string }
	| {
			kind: "issue";
			host?: string;
			owner?: string;
			repo?: string;
			number: number;
			comments: boolean;
	  }
	| { kind: "pr-list"; host?: string; owner?: string; repo?: string }
	| {
			kind: "pr";
			host?: string;
			owner?: string;
			repo?: string;
			number: number;
			comments: boolean;
	  }
	| {
			kind: "pr-diff";
			host?: string;
			owner?: string;
			repo?: string;
			number: number;
			fileIndex?: number | "all";
	  };

export class InvalidResourceUriError extends PiOmpGitError {
	constructor(message: string) {
		super(message);
	}
}

function invalid(raw: string, reason: string): never {
	throw new InvalidResourceUriError(
		`Invalid GitHub resource URI: ${raw} — ${reason}`,
	);
}

const NUMERIC = /^[0-9]+$/;

function decodeSegment(
	rawUri: string,
	rawSegment: string,
	position: number,
): string {
	let decoded: string;
	try {
		decoded = decodeURIComponent(rawSegment);
	} catch {
		invalid(rawUri, `invalid percent-encoding in segment ${position + 1}`);
	}
	if (decoded === "") {
		invalid(rawUri, `empty path segment ${position + 1}`);
	}
	if (decoded === "." || decoded === "..") {
		invalid(rawUri, `traversal segment "${decoded}" is not allowed`);
	}
	if (decoded.includes("/")) {
		invalid(rawUri, `segment ${position + 1} decodes to a path separator`);
	}
	return decoded;
}

function decodeQueryValue(rawUri: string, part: string): string {
	try {
		return decodeURIComponent(part);
	} catch {
		invalid(rawUri, `invalid percent-encoding in query`);
	}
}

function parseQuery(rawUri: string, query: string): { comments: boolean } {
	let comments = true;
	for (const pair of query.split("&")) {
		const eq = pair.indexOf("=");
		const rawKey = eq === -1 ? pair : pair.slice(0, eq);
		const rawValue = eq === -1 ? "" : pair.slice(eq + 1);
		const key = decodeQueryValue(rawUri, rawKey);
		const value = decodeQueryValue(rawUri, rawValue);
		if (key === "comments") {
			if (value === "0" || value === "false") {
				comments = false;
			} else if (value === "1" || value === "true") {
				comments = true;
			} else {
				invalid(
					rawUri,
					`invalid comments value "${value}" — expected 0, false, 1, or true`,
				);
			}
			continue;
		}
		invalid(rawUri, `unexpected query parameter "${key}"`);
	}
	return { comments };
}

function parsePositiveNumber(
	rawUri: string,
	label: "issue" | "PR",
	segment: string,
): number {
	if (!NUMERIC.test(segment)) {
		invalid(rawUri, `invalid ${label} number "${segment}"`);
	}
	const value = Number(segment);
	if (!(value >= 1)) {
		invalid(rawUri, `invalid ${label} number "${segment}" — must be positive`);
	}
	return value;
}

function diffFileIndex(rawUri: string, segment: string): number | "all" {
	if (segment === "all") {
		return "all";
	}
	if (!NUMERIC.test(segment)) {
		invalid(
			rawUri,
			`invalid diff file index "${segment}" — must be a 1-based number or "all"`,
		);
	}
	const value = Number(segment);
	if (!(value >= 1)) {
		invalid(rawUri, `invalid diff file index "${segment}" — must be 1-based`);
	}
	return value;
}

function rejectDiffOnIssue(rawUri: string): never {
	invalid(rawUri, `"diff" is not valid for issue resources`);
}

/**
 * Parse a virtual GitHub resource URI. Only `issue://` and `pr://` scheme
 * URIs reach here (the read override delegates everything else to Pi's
 * native read); anything else is an invalid resource URI.
 */
export function parseGithubUri(rawUri: string): GithubResource {
	const schemeMatch = /^(issue|pr):\/\//i.exec(rawUri);
	if (!schemeMatch) {
		invalid(rawUri, `missing issue:// or pr:// scheme`);
	}
	const scheme = schemeMatch[1]?.toLowerCase() ?? "";
	if (scheme !== "issue" && scheme !== "pr") {
		invalid(
			rawUri,
			`unsupported scheme "${scheme}" — expected issue:// or pr://`,
		);
	}
	const rest = rawUri.slice(schemeMatch[0]?.length ?? 0);
	const queryStart = rest.indexOf("?");
	const pathPart = queryStart === -1 ? rest : rest.slice(0, queryStart);
	const queryPart = queryStart === -1 ? undefined : rest.slice(queryStart + 1);

	if (queryPart !== undefined && queryPart === "") {
		invalid(rawUri, `dangling "?" — unexpected suffix`);
	}

	const rawSegments = pathPart === "" ? [] : pathPart.split("/");
	const segments = rawSegments.map((segment, index) =>
		decodeSegment(rawUri, segment, index),
	);
	const count = segments.length;

	// Query parameters apply to single (numbered) resources only — listing
	// parameters arrive with the listing ticket (§10), and ?comments=0 is
	// defined for single-resource reads (§14).
	let comments = true;
	if (queryPart !== undefined) {
		const numbered = count > 0 && NUMERIC.test(segments[count - 1] ?? "");
		if (!numbered) {
			invalid(rawUri, `query parameters apply to single resources only`);
		}
		({ comments } = parseQuery(rawUri, queryPart));
	}

	const seg = (index: number): string => segments[index] ?? "";
	const firstIsNumber = count > 0 && NUMERIC.test(segments[0] ?? "");

	if (count === 0) {
		return { kind: `${scheme}-list` };
	}

	// A numeric first segment can only begin a bare-number resource.
	if (firstIsNumber) {
		if (scheme === "issue") {
			if (count === 1) {
				return {
					kind: "issue",
					number: parsePositiveNumber(rawUri, "issue", seg(0)),
					comments,
				};
			}
			if (segments[1] === "diff") {
				rejectDiffOnIssue(rawUri);
			}
			invalid(rawUri, `unexpected suffix "/${seg(1)}"`);
		}
		// pr scheme with a numeric head:
		if (count === 1) {
			return {
				kind: "pr",
				number: parsePositiveNumber(rawUri, "PR", seg(0)),
				comments,
			};
		}
		const number = parsePositiveNumber(rawUri, "PR", seg(0));
		if (segments[1] === "diff") {
			if (count === 2) {
				return { kind: "pr-diff", number };
			}
			return {
				kind: "pr-diff",
				number,
				fileIndex: diffFileIndex(rawUri, seg(2)),
			};
		}
		invalid(rawUri, `unexpected suffix "/${seg(1)}"`);
	}

	if (count === 1) {
		const label = scheme === "issue" ? "issue" : "PR";
		return {
			kind: scheme,
			number: parsePositiveNumber(rawUri, label, seg(0)),
			comments,
		};
	}
	if (count === 2) {
		return { kind: `${scheme}-list`, owner: seg(0), repo: seg(1) };
	}

	if (count === 3) {
		// `issue|pr://owner/repo/N` or host-qualified listing `host/owner/repo`.
		if (NUMERIC.test(seg(2))) {
			const numberSegment = seg(2);
			const number = parsePositiveNumber(
				rawUri,
				scheme === "issue" ? "issue" : "PR",
				numberSegment,
			);
			return scheme === "issue"
				? { kind: "issue", owner: seg(0), repo: seg(1), number, comments }
				: { kind: "pr", owner: seg(0), repo: seg(1), number, comments };
		}
		return {
			kind: `${scheme}-list`,
			host: seg(0),
			owner: seg(1),
			repo: seg(2),
		};
	}

	if (count === 4) {
		const fourth = seg(3);
		if (scheme === "issue") {
			if (fourth === "diff") {
				rejectDiffOnIssue(rawUri);
			}
			if (NUMERIC.test(fourth)) {
				const number = parsePositiveNumber(rawUri, "issue", fourth);
				return {
					kind: "issue",
					host: seg(0),
					owner: seg(1),
					repo: seg(2),
					number,
					comments,
				};
			}
			invalid(rawUri, `unexpected suffix "/${fourth}"`);
		}
		// pr scheme, 4 segments: repo-scoped diff or host-qualified single.
		if (fourth === "diff") {
			const number = parsePositiveNumber(rawUri, "PR", seg(2));
			return { kind: "pr-diff", owner: seg(0), repo: seg(1), number };
		}
		if (NUMERIC.test(fourth)) {
			const number = parsePositiveNumber(rawUri, "PR", fourth);
			return {
				kind: "pr",
				host: seg(0),
				owner: seg(1),
				repo: seg(2),
				number,
				comments,
			};
		}
		invalid(rawUri, `unexpected suffix "/${fourth}"`);
	}

	if (count === 5 && scheme === "pr") {
		const fifth = seg(4);
		if (seg(3) === "diff") {
			const number = parsePositiveNumber(rawUri, "PR", seg(2));
			return {
				kind: "pr-diff",
				owner: seg(0),
				repo: seg(1),
				number,
				fileIndex: diffFileIndex(rawUri, fifth),
			};
		}
		invalid(rawUri, `unexpected suffix "/${fifth}"`);
	}

	if (count >= 4 && scheme === "issue") {
		if (seg(3) === "diff") {
			rejectDiffOnIssue(rawUri);
		}
	}

	invalid(rawUri, `unexpected path shape`);
}
