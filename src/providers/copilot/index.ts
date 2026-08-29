import type { ProviderDefinition } from "../types.ts";
import { loginCopilotWeb } from "./auth.ts";
import { CopilotWebClient } from "./client.ts";

export const definition: ProviderDefinition = {
	id: "copilot-web",
	name: "Copilot Web",
	models: [
		{ id: "copilot-smart", name: "Copilot Smart" },
		{ id: "copilot-think-deeper", name: "Copilot Think Deeper" },
		{ id: "copilot-study", name: "Copilot Study" },
		{ id: "copilot-search", name: "Copilot Search" },
	],
	factory: (credentials) => new CopilotWebClient(credentials as any),
	loginFn: loginCopilotWeb,
};
