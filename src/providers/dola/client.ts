import type { Page } from "playwright-core";
import { type BrowserCookie, BrowserManager } from "../../browser/manager.ts";
import { BaseApiClient } from "../factory/base-api-client.ts";
import type { ApiClientConfig, NormalizedSendParams } from "../factory/types.ts";
import { parseCookieHeader } from "../shared/cookie-parser.ts";
import type { EvalResult } from "../shared/eval-helpers.ts";
import type { StreamResult } from "../types.ts";
import type { DolaWebAuth } from "./auth.ts";
import { parseDolaStream } from "./stream.ts";

export interface DolaWebClientConfig {
	aid?: string;
	device_id?: string;
	device_platform?: string;
	fp?: string;
	language?: string;
	pc_version?: string;
	pkg_type?: string;
	real_aid?: string;
	region?: string;
	samantha_web?: string;
	sys_region?: string;
	tea_uuid?: string;
	use_olympus_account?: string;
	version_code?: string;
	web_id?: string;
	web_tab_id?: string;
	msToken?: string;
	a_bogus?: string;
}

interface DolaMessage {
	role: "user" | "assistant" | "system";
	content: string;
}

const DOLA_API_BASE = "https://www.dola.com";

export class DolaWebClient extends BaseApiClient<DolaWebAuth> {
	readonly providerId = "dola-web";

	protected readonly config: ApiClientConfig = {
		hostKey: "dola.com",
		startUrl: "https://www.dola.com/chat/",
		cookieDomain: ".dola.com",
		defaultModel: "dola-fast",
		models: [
			{ id: "dola-fast", name: "Dola Fast" },
			{ id: "dola-pro", name: "Dola Pro" },
		],
	};

	private dolaConfig: DolaWebClientConfig;

	constructor(auth: DolaWebAuth | string, extraConfig: DolaWebClientConfig = {}) {
		const parsed: DolaWebAuth =
			typeof auth === "string"
				? (() => {
						try {
							return JSON.parse(auth);
						} catch {
							return { sessionid: auth, userAgent: "" };
						}
					})()
				: auth;
		super(parsed);

		const dynamic: Partial<DolaWebClientConfig> = {};
		const a = this.auth as DolaWebAuth & Record<string, string | undefined>;
		for (const k of [
			"msToken",
			"a_bogus",
			"fp",
			"tea_uuid",
			"device_id",
			"web_tab_id",
			"aid",
			"version_code",
			"pc_version",
			"region",
			"language",
		] as const) {
			if (a[k]) (dynamic as Record<string, string>)[k] = a[k] as string;
		}
		this.dolaConfig = {
			aid: "495671",
			device_platform: "web",
			language: "zh",
			pkg_type: "release_version",
			real_aid: "495671",
			region: "CN",
			samantha_web: "1",
			sys_region: "CN",
			use_olympus_account: "1",
			version_code: "20800",
			...dynamic,
			...extraConfig,
		};
	}

	protected getCookies(): BrowserCookie[] {
		return [];
	}

	/** Custom page bootstrapping: Doubao uses either a cookie header string OR sessionid/ttwid objects. */
	protected override async getPage(): Promise<Page> {
		if (this.page) {
			try {
				await this.page.evaluate(() => document.readyState);
				return this.page;
			} catch {
				this.page = null;
			}
		}
		const bm = BrowserManager.getInstance();
		this.page = await bm.getPage(this.config.hostKey, this.config.startUrl);

		const cookieHeader = this.auth.cookie;
		if (cookieHeader?.trim() && !cookieHeader.startsWith("{")) {
			await bm.addCookies(parseCookieHeader(cookieHeader, this.config.cookieDomain));
		} else {
			const toAdd: BrowserCookie[] = [
				{
					name: "sessionid",
					value: this.auth.sessionid,
					domain: this.config.cookieDomain,
					path: "/",
				},
			];
			if (this.auth.ttwid) {
				toAdd.push({
					name: "ttwid",
					value: decodeURIComponent(this.auth.ttwid),
					domain: this.config.cookieDomain,
					path: "/",
				});
			}
			await bm.addCookies(toAdd);
		}
		return this.page;
	}

	protected override async onInit(): Promise<void> {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const page = await this.getPage();
				const queryParams = this.buildQueryParams();
				const probeUrl = `${DOLA_API_BASE}/im/conversation/info?${queryParams}`;
				await page.evaluate(
					async ({ url }: { url: string }) => {
						await fetch(url, {
							method: "GET",
							headers: {
								Accept: "application/json",
								Referer: "https://www.dola.com/chat/",
								Origin: "https://www.dola.com",
								"Agw-js-conv": "str",
							},
							credentials: "include",
						});
					},
					{ url: probeUrl },
				);
				return;
			} catch {
				if (attempt < 2) {
					await new Promise((r) => setTimeout(r, 1500));
					this.page = null;
				}
			}
		}
	}

	protected async callApi(page: Page, params: NormalizedSendParams): Promise<EvalResult> {
		const queryParams = this.buildQueryParams();
		const url = `${DOLA_API_BASE}/chat/completion?${queryParams}`;
		const text = this.mergeMessagesForSamantha([{ role: "user", content: params.message }]);
		const modelId = params.model === "dola-pro" ? "dola-pro" : "dola-fast";
		const deepThinkValue = modelId === "dola-pro" ? 3 : 0;
		const blockId = crypto.randomUUID();
		const messageId = crypto.randomUUID();
		const uniqueKey = crypto.randomUUID();
		const now = Date.now();
		const fp = this.auth.s_v_web_id || this.auth.fp || "";
		const localConversationId = `local_${Date.now().toString().slice(-16)}`;

		const body = JSON.stringify({
			client_meta: {
				local_conversation_id: localConversationId,
				conversation_id: "",
				bot_id: "7339470689562525703",
				last_section_id: "",
				last_message_index: null,
			},
			messages: [
				{
					local_message_id: messageId,
					content_block: [
						{
							block_type: 10000,
							content: {
								text_block: {
									text,
									icon_url: "",
									icon_url_dark: "",
									summary: "",
								},
								pc_event_block: "",
							},
							block_id: blockId,
							parent_id: "",
							meta_info: [],
							append_fields: [],
						},
					],
					message_status: 0,
				},
			],
			option: {
				send_message_scene: "",
				create_time_ms: now,
				collect_id: "",
				is_audio: false,
				answer_with_suggest: false,
				tts_switch: false,
				need_deep_think: deepThinkValue,
				click_clear_context: false,
				from_suggest: false,
				is_regen: false,
				is_replace: false,
				is_from_click_option: false,
				is_from_click_softlink: false,
				disable_sse_cache: false,
				select_text_action: "",
				is_select_text: false,
				resend_for_regen: false,
				scene_type: 0,
				unique_key: uniqueKey,
				start_seq: 0,
				need_create_conversation: true,
				conversation_init_option: { need_ack_conversation: true },
				regen_query_id: [],
				edit_query_id: [],
				regen_instruction: "",
				no_replace_for_regen: false,
				message_from: 0,
				shared_app_name: "",
				shared_app_id: "",
				sse_recv_event_options: { support_chunk_delta: true },
				is_ai_playground: false,
				is_old_user: false,
				recovery_option: {
					is_recovery: false,
					req_create_time_sec: Math.floor(now / 1000),
					append_sse_event_scene: 0,
				},
				message_storage_type: 0,
			},
			user_context: [],
			ext: {
				use_deep_think: String(deepThinkValue),
				fp,
				sub_conv_firstmet_type: "1",
				collection_id: "",
				conversation_init_option: JSON.stringify({ need_ack_conversation: true }),
				commerce_credit_config_enable: "0",
			},
		});

		const maxRetries = 2;
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				const result = (await page.evaluate(
					async ({ postUrl, bodyJson }: { postUrl: string; bodyJson: string }) => {
						const res = await fetch(postUrl, {
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								Accept: "text/event-stream",
								Referer: "https://www.dola.com/chat/",
								Origin: "https://www.dola.com",
								"Agw-js-conv": "str",
							},
							body: bodyJson,
							credentials: "include",
						});
						if (!res.ok) {
							const errText = await res.text().catch(() => "");
							return {
								ok: false as const,
								status: res.status,
								error: `Dola API error: ${res.status} ${errText.slice(0, 500)}`,
							};
						}
						const reader = res.body?.getReader();
						if (!reader)
							return { ok: false as const, status: 500, error: "No response body from Dola API" };
						const decoder = new TextDecoder();
						let fullText = "";
						while (true) {
							const { done, value } = await reader.read();
							if (done) break;
							fullText += decoder.decode(value, { stream: true });
						}
						return { ok: true as const, data: fullText };
					},
					{ postUrl: url, bodyJson: body },
				)) as EvalResult;
				return result;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes("navigation") || msg.includes("destroyed")) {
					if (attempt < maxRetries) {
						await new Promise((r) => setTimeout(r, 1000));
						const freshPage = await this.getPage();
						page = freshPage;
						continue;
					}
				}
				throw err;
			}
		}
		throw new Error("Dola API call failed after retries");
	}

	protected parseStreamImpl(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult> {
		return parseDolaStream(body, onDelta);
	}

	private buildQueryParams(): string {
		const params = new URLSearchParams();
		const deviceId = this.dolaConfig.device_id || Date.now().toString();
		const fp = this.auth.s_v_web_id || this.auth.fp || "";

		const entries: [string, string][] = [
			["aid", "495671"],
			["real_aid", "495671"],
			["device_platform", "web"],
			["device_id", deviceId],
			["web_id", deviceId],
			["tea_uuid", this.dolaConfig.tea_uuid || deviceId],
			["web_tab_id", crypto.randomUUID()],
			["pc_version", this.dolaConfig.pc_version || "3.25.3"],
			["pkg_type", "release_version"],
			["version_code", "20800"],
			["samantha_web", "1"],
			["web_platform", "browser"],
			["use-olympus-account", "1"],
			["language", this.dolaConfig.language || "en"],
			["region", this.dolaConfig.region || "US"],
			["sys_region", this.dolaConfig.sys_region || "US"],
			["fp", fp],
		];
		if (this.dolaConfig.msToken) entries.push(["msToken", this.dolaConfig.msToken]);
		if (this.dolaConfig.a_bogus) entries.push(["a_bogus", this.dolaConfig.a_bogus]);

		for (const [k, v] of entries) params.append(k, v);
		return params.toString();
	}

	private mergeMessagesForSamantha(messages: DolaMessage[]): string {
		return `${messages
			.map((m) => {
				const role = m.role === "user" ? "user" : m.role === "assistant" ? "assistant" : "system";
				return `<|im_start|>${role}\n${m.content}\n`;
			})
			.join("")}<|redacted_im_end|>\n`;
	}
}
