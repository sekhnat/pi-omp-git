/**
 * Unified diff parsing and single-hunk patch extraction for the Git TUI
 * (docs/pi-omp-git-reference.md §61–§65).
 */

export interface DiffLine {
	kind: "context" | "add" | "del";
	text: string;
}

export interface DiffHunk {
	/** The full `@@ -a,b +c,d @@ context` header line. */
	header: string;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: DiffLine[];
}

export interface ParsedDiff {
	/** Everything before the first hunk: diff --git, index, ---, +++, mode changes. */
	header: string[];
	hunks: DiffHunk[];
}

/**
 * Parse a unified diff (git-style) into a header plus hunks. Returns an
 * empty diff for empty input.
 */
export function parseUnifiedDiff(text: string): ParsedDiff {
	const normalized = text.replace(/\r\n/g, "\n");
	const lines = normalized === "" ? [] : normalized.split("\n");
	// A trailing newline produces a final "" element; keep it attached by
	// dropping only the last empty element when the text ended with \n.
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

	const header: string[] = [];
	let hunks: DiffHunk[] = [];
	let current: DiffHunk | null = null;

	for (const line of lines) {
		if (line.startsWith("@@")) {
			const parsed = parseHunkHeader(line);
			current = {
				header: line,
				oldStart: parsed.oldStart,
				oldLines: parsed.oldLines,
				newStart: parsed.newStart,
				newLines: parsed.newLines,
				lines: [],
			};
			hunks.push(current);
			continue;
		}
		if (!current) {
			header.push(line);
			continue;
		}
		if (line.startsWith("\\ No newline at end of file")) {
			continue;
		}
		const marker = line.slice(0, 1);
		if (marker === "+") {
			current.lines.push({ kind: "add", text: line.slice(1) });
		} else if (marker === "-") {
			current.lines.push({ kind: "del", text: line.slice(1) });
		} else if (marker === " ") {
			current.lines.push({ kind: "context", text: line.slice(1) });
		} else if (line === "") {
			// Empty context line (trailing space stripped by some tools).
			current.lines.push({ kind: "context", text: "" });
		} else {
			// Unknown body line (e.g. "\ No newline" variants) — keep verbatim.
			current.lines.push({ kind: "context", text: line });
		}
	}
	hunks = hunks.filter(
		(hunk) =>
			hunk.lines.some((l) => l.kind === "add") ||
			hunk.lines.some((l) => l.kind === "del"),
	);
	return { header, hunks };
}

function parseHunkHeader(line: string): {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
} {
	const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
	if (!match) {
		return { oldStart: 0, oldLines: 0, newStart: 0, newLines: 0 };
	}
	return {
		oldStart: Number(match[1]),
		oldLines: match[2] === undefined ? 1 : Number(match[2]),
		newStart: Number(match[3]),
		newLines: match[4] === undefined ? 1 : Number(match[4]),
	};
}

/**
 * Build a valid single-hunk patch: the diff header plus exactly one
 * hunk. The result always ends with a newline (git apply rejects
 * patches whose last line lacks one).
 */
export function extractHunkPatch(diffText: string, hunkIndex: number): string {
	const parsed = parseUnifiedDiff(diffText);
	const hunk = parsed.hunks[hunkIndex];
	if (!hunk) {
		throw new RangeError(
			`hunk ${hunkIndex} out of range (diff has ${parsed.hunks.length} hunks)`,
		);
	}
	const body = parsed.header.join("\n");
	const lines = [hunk.header];
	for (const line of hunk.lines) {
		const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
		lines.push(marker + line.text);
	}
	let patch = `${(body === "" ? "" : `${body}\n`) + lines.join("\n")}\n`;
	// Preserve "no newline at end of file" markers from the source diff.
	const source = diffText.replace(/\r\n/g, "\n");
	if (source.includes("\\ No newline at end of file")) {
		patch = reattachNoNewlineMarkers(patch, source, hunkIndex);
	}
	return patch;
}

/**
 * Copy `\ No newline at end of file` markers from the source diff into
 * the extracted single-hunk patch so reverse application round-trips.
 */
function reattachNoNewlineMarkers(
	patch: string,
	source: string,
	hunkIndex: number,
): string {
	const sourceHunks = splitRawHunks(source);
	const sourceHunk = sourceHunks[hunkIndex];
	if (!sourceHunk) return patch;
	const sourceBody = sourceHunk.body;
	if (!sourceBody.includes("\\ No newline at end of file")) return patch;

	// Find which terminal line of the hunk the marker follows in the source.
	const srcLines = sourceBody.split("\n");
	const markerIndex = srcLines.indexOf("\\ No newline at end of file");
	if (markerIndex <= 0) return patch;
	const preceding = srcLines[markerIndex - 1] ?? "";

	const patchLines = patch.split("\n");
	const insertAt = patchLines.lastIndexOf(preceding);
	if (insertAt < 0) return patch;
	patchLines.splice(insertAt + 1, 0, "\\ No newline at end of file");
	return patchLines.join("\n");
}

/** Split a raw diff into raw hunk text blocks (header lines excluded). */
function splitRawHunks(
	diffText: string,
): Array<{ header: string; body: string }> {
	const normalized = diffText.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	const hunks: Array<{ header: string; body: string }> = [];
	let current: { header: string; body: string[] } | null = null;
	for (const line of lines) {
		if (line.startsWith("@@")) {
			if (current)
				hunks.push({ header: current.header, body: current.body.join("\n") });
			current = { header: line, body: [] };
			continue;
		}
		if (!current) continue;
		current.body.push(line);
	}
	if (current)
		hunks.push({ header: current.header, body: current.body.join("\n") });
	return hunks;
}

/**
 * Normalized hunk body: only the changed lines (add/del), joined. Used
 * to verify a patch applied — the same change keeps the same body even
 * when surrounding line numbers shift.
 */
export function hunkBody(diffText: string, hunkIndex: number): string {
	const parsed = parseUnifiedDiff(diffText);
	const hunk = parsed.hunks[hunkIndex];
	if (!hunk) return "";
	return hunk.lines
		.filter((line) => line.kind !== "context")
		.map((line) => (line.kind === "add" ? "+" : "-") + line.text)
		.join("\n");
}

/** Count hunks in a diff whose normalized body equals `body`. */
export function countHunkBodies(diffText: string, body: string): number {
	if (body === "") return 0;
	const parsed = parseUnifiedDiff(diffText);
	return parsed.hunks.filter(
		(hunk) =>
			hunk.lines
				.filter((line) => line.kind !== "context")
				.map((line) => (line.kind === "add" ? "+" : "-") + line.text)
				.join("\n") === body,
	).length;
}
