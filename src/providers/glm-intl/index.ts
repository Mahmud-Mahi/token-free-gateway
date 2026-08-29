import type { ProviderDefinition } from "../types.ts";
import { loginGlmIntlWeb } from "./auth.ts";
import { GlmIntlWebClient } from "./client.ts";

export const definition: ProviderDefinition = {
	id: "glm-intl-web",
	name: "GLM International (Web)",
	models: [
		{ id: "glm-5.3-flash-intl", name: "GLM-5.3-Flash (Intl)" },
		{ id: "glm-5.3-intl", name: "GLM-5.3 (Intl)" },
		{ id: "glm-5.2-intl", name: "GLM-5.2 (Intl)" },
		{ id: "glm-5-turbo-intl", name: "GLM-5-Turbo (Intl)" },
	],
	factory: (credentials) => new GlmIntlWebClient(credentials as any),
	loginFn: loginGlmIntlWeb,
};
