import type { ProviderDefinition } from "../types.ts";
import { loginKimiWeb } from "./auth.ts";
import { KimiWebClient } from "./client.ts";

export const definition: ProviderDefinition = {
	id: "kimi-web",
	name: "Kimi (Web)",
	models: [
		{ id: "k3-instant", name: "Kimi Instant" },
		{ id: "k3", name: "Kimi K3" },
		{ id: "k3-stream", name: "Kimi K3 Stream" },
	],
	factory: (credentials) => new KimiWebClient(credentials as any),
	loginFn: loginKimiWeb,
};
