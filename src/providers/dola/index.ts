import type { ProviderDefinition } from "../types.ts";
import { loginDolaWeb } from "./auth.ts";
import { DolaWebClient } from "./client.ts";

export const definition: ProviderDefinition = {
	id: "dola-web",
	name: "Dola Web",
	models: [
		{ id: "dola-fast", name: "Dola Fast" },
		{ id: "dola-pro", name: "Dola Pro" },
	],
	factory: (credentials) => new DolaWebClient(credentials as any),
	loginFn: loginDolaWeb,
};
