import type { ProviderDefinition } from "../types.ts";
import type { ChatGPTWebAuth } from "./auth.ts";
import { loginChatGPTWeb } from "./auth.ts";
import { ChatGPTWebClient } from "./client.ts";

export const definition: ProviderDefinition = {
	id: "chatgpt-web",
	name: "ChatGPT Web",
	models: [
		{ id: "chatgpt-auto", name: "ChatGPT Auto" },
		{ id: "chatgpt-think", name: "ChatGPT Think" },
	],
	factory: (credentials) => new ChatGPTWebClient(credentials as ChatGPTWebAuth),
	loginFn: loginChatGPTWeb,
};
