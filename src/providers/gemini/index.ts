import type { ProviderDefinition } from "../types.ts";
import { loginGeminiWeb } from "./auth.ts";
import { GeminiWebClient } from "./client.ts";

export const definition: ProviderDefinition = {
	id: "gemini-web",
	name: "Gemini Web",
	models: [
		{ id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite" },
		{ id: "gemini-3.6-flash", name: "Gemini 3.6 Flash" },
		{ id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
	],
	factory: (credentials) => new GeminiWebClient(credentials as any),
	loginFn: loginGeminiWeb,
};
