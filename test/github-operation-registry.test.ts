import { describe, expect, it } from "vitest";
import {
	GITHUB_OPERATION_REGISTRY,
	type RegisteredGithubOperation,
} from "../src/github/operations/registry.ts";

describe("GitHub operation registry", () => {
	it("registers repo, file, PR, and search operations with owned schemas and adapters", () => {
		const expected: RegisteredGithubOperation[] = [
			"repo_view",
			"file_read",
			"pr_create",
			"pr_checkout",
			"pr_push",
			"search_issues",
			"search_prs",
			"search_code",
			"search_commits",
			"search_repos",
			"run_watch",
		];
		expect(Object.keys(GITHUB_OPERATION_REGISTRY)).toEqual(expected);

		for (const operation of expected) {
			const definition = GITHUB_OPERATION_REGISTRY[operation];
			const schema = definition.parameters as {
				type?: string;
				properties?: { op?: { const?: unknown } };
			};
			expect(schema).toMatchObject({
				type: "object",
				properties: { op: { const: operation } },
			});
			expect(typeof definition.validate).toBe("function");
			expect(typeof definition.execute).toBe("function");
		}
	});

	it("requires a query in each search operation's owned parameter schema", () => {
		for (const operation of [
			"search_issues",
			"search_prs",
			"search_code",
			"search_commits",
			"search_repos",
		] as const) {
			const schema = GITHUB_OPERATION_REGISTRY[operation].parameters as {
				required?: string[];
			};
			expect(schema.required).toContain("query");
		}
	});
});
