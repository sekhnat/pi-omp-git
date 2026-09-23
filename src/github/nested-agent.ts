/**
 * Nested headless agent sessions (docs/pi-omp-git-reference.md §75, ADR 0004).
 *
 * A nested session is a headless Pi SDK session with no built-in tools,
 * a narrow tool allowlist, in-memory session storage (a temporary session
 * directory by effect — the run never appears in the user's session
 * list), and the parent session's model unless overridden. Later tickets
 * (AI stage, commit agent) reuse this machinery; `pr_create --fill`
 * (ticket 10) is the first consumer.
 */

import {
	type CreateAgentSessionOptions,
	createAgentSession,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

/** The SDK's model type, derived without importing the nested pi-ai path. */
export type NestedModel = CreateAgentSessionOptions extends {
	model?: infer M;
}
	? M
	: never;

/** The session surface the nested run needs. */
export interface NestedAgentSession {
	prompt(text: string, options?: unknown): Promise<void>;
	/** Stop the active run; the pending prompt() resolves. */
	abort(): void;
	getLastAssistantText(): string | undefined;
	dispose(): void;
}

/**
 * Session factory seam. Tests inject a scripted factory here; production
 * passes the real SDK factory (the default).
 */
export type NestedSessionFactory = (
	options: CreateAgentSessionOptions,
) => Promise<{ session: NestedAgentSession }>;

export interface NestedAgentOptions {
	/** Working directory for the nested session. */
	cwd: string;
	/** The prompt for the nested run. */
	prompt: string;
	/** Narrow built-in tool allowlist; omitted → no tools at all. */
	tools?: string[];
	/** Custom tools (e.g. git_overview) registered for the nested run. */
	customTools?: CreateAgentSessionOptions["customTools"];
	/** The parent session's model; omitted → the SDK's configured default. */
	model?: NestedModel;
	/** The parent tool's abort signal; aborting stops the nested run. */
	signal?: AbortSignal;
	/** Test seam; defaults to the real SDK factory. */
	createSession?: NestedSessionFactory;
}

export interface NestedAgentRun {
	/** The assistant's final text ("" when the session produced none). */
	text: string;
}

/**
 * Run one headless nested agent session: create → prompt → collect the
 * final text → dispose. Sessions are in-memory, so nothing lands in the
 * user's session directory (§75).
 */
export async function runNestedAgent(
	options: NestedAgentOptions,
): Promise<NestedAgentRun> {
	const factory = options.createSession ?? createAgentSession;
	const { session } = await factory({
		cwd: options.cwd,
		model: options.model,
		noTools: "all",
		...(options.tools && options.tools.length > 0
			? { tools: options.tools }
			: {}),
		...(options.customTools ? { customTools: options.customTools } : {}),
		// In-memory storage: a temporary session directory by effect —
		// no session file is written, so the run can never appear in the
		// user's session list (§75).
		sessionManager: SessionManager.inMemory(options.cwd),
	});
	const onAbort = () => {
		void session.abort();
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		await session.prompt(options.prompt);
		return { text: session.getLastAssistantText() ?? "" };
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
		session.dispose();
	}
}
