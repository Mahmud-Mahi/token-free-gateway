import type { ProviderDefinition } from "../types.ts";
import { loginClaudeWeb } from "./auth.ts";
import { ClaudeWebClient } from "./client.ts";

export const definition: ProviderDefinition = {
	id: "claude-web",
	name: "Claude Web",
	models: [
		{ id: "claude-sonnet-5", name: "Claude Sonnet 5" },
		{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
		{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
	],
	factory: (credentials) => new ClaudeWebClient(credentials as any),
	loginFn: loginClaudeWeb,
};
