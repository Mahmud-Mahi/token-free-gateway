import type { Page } from "playwright-core";
import { BaseApiClient } from "../factory/base-api-client.ts";
import type { ApiClientConfig, NormalizedSendParams } from "../factory/types.ts";
import { parseCookieHeader } from "../shared/cookie-parser.ts";
import type { EvalResult } from "../shared/eval-helpers.ts";
import type { StreamResult } from "../types.ts";
import type { XiaomiMimoWebAuth } from "./auth.ts";
import { parseXiaomiMimoStream } from "./stream.ts";

const XIAOMIMO_BASE_URL = "https://aistudio.xiaomimimo.com";

function randomHex32(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class XiaomiMimoWebClient extends BaseApiClient<XiaomiMimoWebAuth> {
	readonly providerId = "xiaomimo-web";

	protected readonly config: ApiClientConfig = {
		hostKey: "xiaomimimo.com",
		startUrl: "https://aistudio.xiaomimimo.com",
		cookieDomain: ".xiaomimimo.com",
		defaultModel: "xiaomimo-chat",
		models: [{ id: "xiaomimo-chat", name: "MiMo Chat" }],
	};

	protected getCookies() {
		return parseCookieHeader(this.auth.cookie, this.config.cookieDomain);
	}

	protected async callApi(page: Page, params: NormalizedSendParams): Promise<EvalResult> {
		const conversationId = randomHex32();
		const msgId = randomHex32();
		const requestBody = {
			msgId,
			conversationId,
			query: params.message,
			isEditedQuery: false,
			modelConfig: {
				enableThinking: false,
				webSearchStatus: "disabled",
				model: "mimo-v2.5",
			},
			multiMedias: [],
		};

		return (await page.evaluate(
			async (args: {
				baseUrl: string;
				bodyJson: string;
				conversationId: string;
			}) => {
				const { baseUrl, bodyJson, conversationId } = args;
				const cookie = document.cookie;
				const phMatch = cookie.match(/xiaomichatbot_ph="?([^;"\s]+)/);
				const botPh = phMatch?.[1] || "";
				const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
				const baseHeaders: Record<string, string> = {
					"Content-Type": "application/json",
					Referer: `${baseUrl}/`,
					"x-timeZone": tz,
				};
				// The frontend creates the conversation first via /open-apis/chat/conversation/save
				// then calls /open-apis/bot/chat with the same conversationId.
				// Without the save, the server may return 401/busy or empty stream.
				const saveUrl = botPh
					? `${baseUrl}/open-apis/chat/conversation/save?xiaomichatbot_ph=${encodeURIComponent(botPh)}`
					: `${baseUrl}/open-apis/chat/conversation/save`;
				const saveBody = JSON.stringify({
					conversationId,
					title: "New conversation",
					type: "chat",
				});
				try {
					await fetch(saveUrl, {
						method: "POST",
						headers: baseHeaders,
						body: saveBody,
						credentials: "include",
					});
				} catch {
					// non-fatal: proceed to chat even if save fails (e.g. already exists)
				}

				let requestUrl = `${baseUrl}/open-apis/bot/chat`;
				if (botPh) {
					requestUrl += `?xiaomichatbot_ph=${encodeURIComponent(botPh)}`;
				}
				const res = await fetch(requestUrl, {
					method: "POST",
					headers: baseHeaders,
					body: bodyJson,
					credentials: "include",
				});
				const text = await res.text();
				if (!res.ok) {
					return {
						ok: false as const,
						status: res.status,
						error: `XiaomiMimo chat completion failed: ${res.status} ${text}`,
					};
				}
				return { ok: true as const, data: text };
			},
			{
				baseUrl: XIAOMIMO_BASE_URL,
				bodyJson: JSON.stringify(requestBody),
				conversationId,
			},
		)) as EvalResult;
	}

	protected parseStreamImpl(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult> {
		return parseXiaomiMimoStream(body, onDelta);
	}
}
