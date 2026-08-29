import type { ProviderDefinition } from "../types.ts";
import { loginGlmWeb } from "./auth.ts";
import { GlmWebClient } from "./client.ts";

export const definition: ProviderDefinition = {
	id: "glm-web",
	name: "ChatGLM (Web)",
	models: [
		{ id: "glm-5.3-cn", name: "GLM-5.3 (CN)" },
		{ id: "glm-flash-cn", name: "GLM-Flash (CN)" },
	],
	factory: (credentials) => new GlmWebClient(credentials as any),
	loginFn: loginGlmWeb,
};
