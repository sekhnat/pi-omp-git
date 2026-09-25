import { PiOmpGitError } from "../../shared/errors.ts";

/** Shared validation error retained as a public dispatcher error contract. */
export class GithubParamsError extends PiOmpGitError {}

/** Parse a common optional string parameter without trimming its value. */
export function optionalNonEmptyString(
	params: Record<string, unknown>,
	field: string,
): string | undefined {
	const value = params[field];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || value.trim() === "") {
		throw new GithubParamsError(
			`The \`${field}\` parameter must be a non-empty string.`,
		);
	}
	return value;
}
