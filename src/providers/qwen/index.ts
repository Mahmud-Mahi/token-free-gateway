import type { ProviderDefinition } from "../types.ts";
import type { QwenWebAuth } from "./auth.ts";
import { loginQwenWeb } from "./auth.ts";
import { QwenWebClient } from "./client.ts";

export const definition: ProviderDefinition = {
	id: "qwen-web",
	name: "Qwen Intl Web",
	models: [
		{ id: "qwen3.7-plus-intl", name: "Qwen 3.7 Plus (Intl)" },
		{ id: "qwen3.8-max-intl", name: "Qwen 3.8 Max (Intl)" },
	],
	factory: (credentials) => new QwenWebClient(credentials as QwenWebAuth),
	loginFn: loginQwenWeb,
};
