/**
 * Deterministic Markdown rendering of single GitHub resources (§11) and
 * the native-read pagination discipline applied to rendered snapshots
 * (§7): offset/limit semantics, the 2000-line / 50KB caps, and the
 * standard continuation notices — byte-identical to Pi's native read
 * text path (built from Pi's own truncateHead/formatSize helpers).
 */

import {
	DEFAULT_MAX_BYTES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { PiOmpGitError } from "../../shared/errors.ts";
import type { GhIssue } from "./issues.ts";
import type { GhPull, GhReviewComment } from "./prs.ts";
/** Files preview cap (§12): 50, matching OMP's current preview limit. */
export const FILES_PREVIEW_CAP = 50;

export interface RenderedResource {
	text: string;
	details: { truncation: TruncationResult };
}

export function renderIssue(
	issue: GhIssue,
	options: { comments: boolean },
): string {
	const lines: string[] = [];
	lines.push(`# ${issue.number} ${issue.title}`);
	lines.push("");
	if (issue.state) lines.push(`State: ${issue.state}`);
	if (issue.stateReason) lines.push(`State reason: ${issue.stateReason}`);
	if (issue.author) lines.push(`Author: ${issue.author}`);
	if (issue.createdAt) lines.push(`Created: ${issue.createdAt}`);
	if (issue.updatedAt) lines.push(`Updated: ${issue.updatedAt}`);
	if (issue.labels.length > 0) lines.push(`Labels: ${issue.labels.join(", ")}`);
	if (issue.url) lines.push(`URL: ${issue.url}`);
	lines.push("");
	lines.push("## Body");
	lines.push("");
	lines.push(issue.body?.trim() ? issue.body : "*(no body)*");
	if (options.comments && issue.comments.length > 0) {
		lines.push("");
		lines.push("## Comments");
		for (const comment of issue.comments) {
			lines.push("");
			lines.push(
				`### ${comment.author ?? "ghost"}${comment.createdAt ? ` on ${comment.createdAt}` : ""}`,
			);
			lines.push("");
			lines.push(comment.body);
		}
	}
	return lines.join("\n");
}

/**
 * Deterministic rendering of `pr://N` (§12–§14, ticket 04).
 *
 * The required metadata block, body, a files preview capped at 50,
 * then — unless comments are suppressed (§14) — reviews, line-level
 * review comments with thread markers, and ordinary conversation
 * comments. A PR with review comments but zero conversation comments
 * still renders the review sections (§12). The trailing `## Diff`
 * section points at the diff resources (§15) and is never suppressed.
 */
export function renderPullRequest(
	pull: GhPull,
	options: { comments: boolean },
): string {
	const lines: string[] = [];
	lines.push(`# ${pull.number} ${pull.title}`);
	lines.push("");
	if (pull.state) lines.push(`State: ${pull.state}`);
	lines.push(`Draft: ${pull.isDraft ? "yes" : "no"}`);
	if (pull.author) lines.push(`Author: ${pull.author}`);
	if (pull.baseRefName) lines.push(`Base: ${pull.baseRefName}`);
	if (pull.headRefName) lines.push(`Head: ${pull.headRefName}`);
	if (pull.reviewDecision)
		lines.push(`Review decision: ${pull.reviewDecision}`);
	if (pull.mergeStateStatus)
		lines.push(`Merge state: ${pull.mergeStateStatus}`);
	if (pull.createdAt) lines.push(`Created: ${pull.createdAt}`);
	if (pull.updatedAt) lines.push(`Updated: ${pull.updatedAt}`);
	if (pull.labels.length > 0) lines.push(`Labels: ${pull.labels.join(", ")}`);
	if (pull.url) lines.push(`URL: ${pull.url}`);
	lines.push("");
	lines.push("## Body");
	lines.push("");
	lines.push(pull.body.trim() ? pull.body : "*(no body)*");

	if (pull.files.length > 0) {
		lines.push("");
		lines.push("## Files");
		for (const file of pull.files.slice(0, FILES_PREVIEW_CAP)) {
			const counts =
				file.additions !== undefined || file.deletions !== undefined
					? ` (+${file.additions ?? 0} -${file.deletions ?? 0})`
					: "";
			const rename =
				file.previousPath !== undefined
					? ` (renamed from ${file.previousPath})`
					: "";
			lines.push(`- ${file.path}${rename}${counts}`);
		}
		if (pull.files.length > FILES_PREVIEW_CAP) {
			lines.push("");
			lines.push(
				`*(...and ${pull.files.length - FILES_PREVIEW_CAP} more files — read pr://${pull.number}/diff for the full index.)*`,
			);
		}
	}

	if (options.comments) {
		if (pull.reviews.length > 0) {
			lines.push("");
			lines.push("## Reviews");
			for (const review of pull.reviews) {
				lines.push("");
				lines.push(
					`### ${review.state} — ${review.author ?? "ghost"}${review.submittedAt ? ` on ${review.submittedAt}` : ""}`,
				);
				lines.push("");
				if (review.body.trim()) lines.push(review.body);
			}
		}

		if (pull.reviewComments.length > 0) {
			lines.push("");
			lines.push("## Review Comments");
			lines.push(...renderReviewComments(pull.reviewComments));
		}

		if (pull.comments.length > 0) {
			lines.push("");
			lines.push("## Comments");
			for (const comment of pull.comments) {
				lines.push("");
				lines.push(
					`### ${comment.author ?? "ghost"}${comment.createdAt ? ` on ${comment.createdAt}` : ""}`,
				);
				lines.push("");
				lines.push(comment.body);
			}
		}
	}

	lines.push("");
	lines.push("## Diff");
	lines.push("");
	lines.push(
		`Changed files: pr://${pull.number}/diff · Unified diff: pr://${pull.number}/diff/all`,
	);
	return lines.join("\n");
}

/**
 * Line-level review comments in collection order; replies carry a
 * `↳` marker naming their parent (or its id when the parent is not in
 * the collected set), retaining the thread relationship (§13).
 */
function renderReviewComments(comments: GhReviewComment[]): string[] {
	const lines: string[] = [];
	const rendered = new Set<number>();
	for (const comment of comments) {
		if (rendered.has(comment.id)) continue;
		rendered.add(comment.id);
		const location = comment.path
			? ` on ${comment.path}:${comment.line ?? comment.originalLine ?? "?"}`
			: "";
		const date = comment.createdAt ? `, ${comment.createdAt}` : "";
		let marker = "";
		if (comment.inReplyToId !== undefined) {
			const parent = comments.find(
				(candidate) => candidate.id === comment.inReplyToId,
			);
			marker = parent
				? `↳ (reply to ${parent.author ?? "ghost"}) `
				: `(reply to #${comment.inReplyToId}) `;
		}
		lines.push(
			"",
			`### ${marker}${comment.author ?? "ghost"}${location}${date}`,
			"",
			comment.body,
		);
	}
	return lines;
}

/**
 * Slice a rendered snapshot with Pi's native read discipline. The only
 * divergence from the native read: when a single rendered line exceeds
 * the byte cap there is no `bash` fallback for a virtual URI, so the
 * notice omits the native `sed | head -c` hint.
 */
export function paginateRendered(
	content: string,
	offset?: number,
	limit?: number,
): RenderedResource {
	const allLines = content.split("\n");
	const totalFileLines = allLines.length;
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	const startLineDisplay = startLine + 1;
	if (startLine >= totalFileLines) {
		throw new PiOmpGitError(
			`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`,
		);
	}

	let selectedContent: string;
	let userLimitedLines: number | undefined;
	if (limit !== undefined) {
		const endLine = Math.min(startLine + limit, totalFileLines);
		selectedContent = allLines.slice(startLine, endLine).join("\n");
		userLimitedLines = endLine - startLine;
	} else {
		selectedContent = allLines.slice(startLine).join("\n");
	}

	const truncation = truncateHead(selectedContent);
	let text: string;
	const details = { truncation };

	if (truncation.firstLineExceedsLimit) {
		const firstLineSize = formatSize(
			Buffer.byteLength(allLines[startLine] ?? "", "utf-8"),
		);
		text = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit.]`;
	} else if (truncation.truncated) {
		const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
		const nextOffset = endLineDisplay + 1;
		text = truncation.content;
		text +=
			truncation.truncatedBy === "lines"
				? `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`
				: `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
	} else if (
		userLimitedLines !== undefined &&
		startLine + userLimitedLines < totalFileLines
	) {
		const remaining = totalFileLines - (startLine + userLimitedLines);
		const nextOffset = startLine + userLimitedLines + 1;
		text = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
	} else {
		text = truncation.content;
	}
	return { text, details };
}
