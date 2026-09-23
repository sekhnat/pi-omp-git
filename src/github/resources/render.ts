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
