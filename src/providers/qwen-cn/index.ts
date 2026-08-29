import type { ProviderDefinition } from "../types.ts";
import type { QwenCNWebAuth } from "./auth.ts";
import { loginQwenCNWeb } from "./auth.ts";
import { QwenCNWebClient } from "./client.ts";

export const definition: ProviderDefinition = {
	id: "qwen-cn-web",
	name: "Qwen CN Web",
	models: [
		{ id: "qwen3.7-cn", name: "Qwen 3.7 (CN)" },
		{ id: "qwen3.8-max-cn", name: "Qwen 3.8 Max (CN)" },
		{ id: "qwen3.7-max-cn", name: "Qwen 3.7 Max (CN)" },
		{ id: "qwen3.6-flash-cn", name: "Qwen 3.6 Flash (CN)" },
	],
	factory: (credentials) => new QwenCNWebClient(credentials as QwenCNWebAuth),
	loginFn: loginQwenCNWeb,
};
