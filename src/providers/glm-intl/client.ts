import type { Page } from "playwright-core";
import { pasteText } from "../../browser/dom-input.ts";
import { BaseDomClient } from "../factory/base-dom-client.ts";
import type { DomClientConfig, NormalizedSendParams } from "../factory/types.ts";
import { parseCookieHeader } from "../shared/cookie-parser.ts";
import type { StreamResult } from "../types.ts";
import type { GlmIntlWebAuth } from "./auth.ts";
import { parseGlmIntlStream } from "./stream.ts";

export class GlmIntlWebClient extends BaseDomClient<GlmIntlWebAuth> {
	readonly providerId = "glm-intl-web";

	private static isRealContent(text: string): boolean {
		if (!text || text.length < 2) return false;
		const rawLower = text
			.toLowerCase()
			.trim()
			.replace(/[\u200B-\u200D\uFEFF]/g, "")
			.replace(/\s+/g, " ");
		const thinkingOnly = [
			"thinking...",
			"thinking…",
			"thinking",
			"思考中",
			"thought process",
			"analyzing...",
			"processing...",
			"let me think",
		];
		for (const p of thinkingOnly) {
			if (
				rawLower === p ||
				rawLower.startsWith(`${p}\n`) ||
				rawLower.startsWith(`${p}\r`) ||
				rawLower.startsWith(`${p} `)
			) {
				return false;
			}
		}
		const stripped = GlmIntlWebClient.stripThinkingText(text);
		return stripped.length >= 2;
	}

	private static stripThinkingText(text: string): string {
		let result = text
			.replace(/<redacted_thinking>[\s\S]*?<\/redacted_thinking>/gi, "")
			.replace(/<think>[\s\S]*?<\/think>/gi, "")
			.replace(/^[\s\S]*?<\/think>\s*/gi, "")
			.replace(/^Thought\s*Process\s*:?\s*/im, "")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
		const lower = result
			.toLowerCase()
			.trim()
			.replace(/[\u200B-\u200D\uFEFF]/g, "")
			.replace(/\s+/g, " ");
		const thinkPrefixes = [
			"thinking...",
			"thinking…",
			"thinking",
			"思考中",
			"thought process",
			"analyzing...",
			"processing...",
			"let me think",
		];
		for (const prefix of thinkPrefixes) {
			if (lower === prefix || lower.startsWith(`${prefix}\n`) || lower.startsWith(`${prefix} `)) {
				result = result
					.slice(prefix.length)
					.replace(/^[\s:]+\n?/, "")
					.trim();
				break;
			}
		}
		return result;
	}

	protected readonly config: DomClientConfig = {
		hostKey: "chat.z.ai",
		startUrl: "https://chat.z.ai/",
		cookieDomain: ".z.ai",
		models: [
			{ id: "glm-5.3-flash-intl", name: "GLM-5.3-Flash (Intl)" },
			{ id: "glm-5.3-intl", name: "GLM-5.3 (Intl)" },
			{ id: "glm-5.2-intl", name: "GLM-5.2 (Intl)" },
			{ id: "glm-5-turbo-intl", name: "GLM-5-Turbo (Intl)" },
		],
		pollIntervalMs: 900,
		maxWaitMs: 120_000,
		stabilityThreshold: 3,
	};

	protected getCookies() {
		return parseCookieHeader(this.auth.cookie, this.config.cookieDomain);
	}

	protected async sendViaDom(page: Page, params: NormalizedSendParams): Promise<string> {
		if (!page.url().includes("chat.z.ai")) {
			await page.goto("https://chat.z.ai/", { waitUntil: "domcontentloaded", timeout: 120000 });
		}

		const beforeCount = await page.evaluate(() => {
			const selectors = [
				".chat-assistant",
				".assistant-message",
				".message-assistant",
				"[data-role='assistant']",
				".chat-message",
				".conversation-turn",
			];
			let maxCount = 0;
			for (const sel of selectors) {
				const count = document.querySelectorAll(sel).length;
				if (count > maxCount) maxCount = count;
			}
			return maxCount;
		});

		let sent = false;
		const textarea = page.locator("textarea").first();
		if ((await textarea.count()) > 0) {
			await textarea.click({ timeout: 5000 });
			await textarea.fill(params.message);
			await textarea.press("Enter");
			sent = true;
		}
		if (!sent) {
			const editable = page.locator('[contenteditable="true"]').first();
			if ((await editable.count()) > 0) {
				await editable.click({ timeout: 5000 });
				await pasteText(page, params.message);
				await page.keyboard.press("Enter");
				sent = true;
			}
		}
		if (!sent) {
			const input = page.locator('input[type="text"]').first();
			if ((await input.count()) > 0) {
				await input.click({ timeout: 5000 });
				await input.fill(params.message);
				const sendBtn = page
					.locator('button.sendMessageButton, button[aria-label*="Send"], button:has-text("发送")')
					.first();
				if ((await sendBtn.count()) > 0) {
					await sendBtn.click();
					sent = true;
				} else {
					await input.press("Enter");
					sent = true;
				}
			}
		}
		if (!sent) throw new Error("GLM Intl UI send failed: no chat input found.");

		await page
			.waitForFunction(
				(prev) => {
					const selectors = [
						".chat-assistant",
						".assistant-message",
						".message-assistant",
						"[data-role='assistant']",
						".chat-message:last-child",
						".conversation-turn:last-child .content",
					];
					for (const sel of selectors) {
						if (document.querySelectorAll(sel).length > prev) return true;
					}
					return false;
				},
				beforeCount,
				{ timeout: 120000, polling: 500 },
			)
			.catch(() => {});

		const raw = await this.pollForStableText(
			async () => {
				return page.evaluate(() => {
					const selectors = [
						".chat-assistant",
						".assistant-message",
						".message-assistant",
						"[data-role='assistant']",
						".chat-message:last-child",
						".conversation-turn:last-child .content",
					];
					let latest: HTMLElement | null = null;
					for (const sel of selectors) {
						const nodes = Array.from(document.querySelectorAll(sel));
						if (nodes.length > 0) {
							latest = nodes[nodes.length - 1] as HTMLElement;
							break;
						}
					}
					if (!latest) return "";
					const text = (latest.innerText ?? "").trim();
					if (!text) return "";
					const lower = text
						.toLowerCase()
						.replace(/[\u200B-\u200D\uFEFF]/g, "")
						.replace(/\s+/g, " ")
						.trim();
					const thinkLabels = [
						"thought process",
						"thinking...",
						"thinking…",
						"thinking",
						"思考中",
						"analyzing...",
						"processing...",
						"let me think",
					];
					for (const label of thinkLabels) {
						if (lower.startsWith(label)) {
							const afterThink = text
								.slice(label.length)
								.replace(/^[\s:]+\n?/, "")
								.trim();
							if (afterThink) return afterThink;
							return "";
						}
					}
					return text;
				});
			},
			params.signal,
			GlmIntlWebClient.isRealContent,
		);
		return GlmIntlWebClient.stripThinkingText(raw);
	}

	protected parseStreamImpl(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult> {
		return parseGlmIntlStream(body, onDelta);
	}
}
