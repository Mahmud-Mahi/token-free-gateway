import type { Page } from "playwright-core";
import { pasteText } from "../../browser/dom-input.ts";
import { BaseApiClient } from "../factory/base-api-client.ts";
import type { ApiClientConfig, NormalizedSendParams } from "../factory/types.ts";
import { parseCookieHeader } from "../shared/cookie-parser.ts";
import type { EvalResult } from "../shared/eval-helpers.ts";
import { textToStream } from "../shared/stream-helpers.ts";
import type { StreamResult } from "../types.ts";
import type { CopilotWebAuth } from "./auth.ts";
import { parseCopilotStream } from "./stream.ts";

function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

export class CopilotWebClient extends BaseApiClient<CopilotWebAuth> {
	readonly providerId = "copilot-web";

	protected readonly config: ApiClientConfig = {
		hostKey: "copilot.microsoft.com",
		startUrl: "https://copilot.microsoft.com",
		cookieDomain: ".copilot.microsoft.com",
		defaultModel: "copilot-smart",
		models: [
			{ id: "copilot-smart", name: "Copilot Smart" },
			{ id: "copilot-think-deeper", name: "Copilot Think Deeper" },
			{ id: "copilot-study", name: "Copilot Study" },
			{ id: "copilot-search", name: "Copilot Search" },
		],
	};

	lastConversationId: string | undefined;

	protected getCookies() {
		return parseCookieHeader(this.auth.cookie, this.config.cookieDomain);
	}

	async checkSession(): Promise<{ valid: boolean; reason?: string }> {
		try {
			const page = await this.getPage();
			const result = await page.evaluate(() => {
				const elements = document.querySelectorAll("button, a, [role='button']");
				const hasSignIn = Array.from(elements).some((el) => {
					const text = el.textContent?.trim().toLowerCase() ?? "";
					return text === "sign in" || text === "log in" || text.includes("sign in with");
				});
				const hasChatInput =
					!!document.querySelector('[contenteditable="true"]') ||
					!!document.querySelector("textarea[placeholder]") ||
					!!document.querySelector('div[role="textbox"]');
				return { hasSignIn, hasChatInput };
			});
			if (result.hasSignIn) {
				return { valid: false, reason: "Copilot sign-in page detected — session expired" };
			}
			if (result.hasChatInput) return { valid: true };
			return { valid: false, reason: "Copilot chat input not found" };
		} catch (err) {
			return { valid: false, reason: err instanceof Error ? err.message : String(err) };
		}
	}

	/**
	 * Not used directly — Copilot overrides `sendMessage` because its
	 * pull-based streaming and DOM fallback logic requires custom flow.
	 */
	protected async callApi(_page: Page, _params: NormalizedSendParams): Promise<EvalResult> {
		throw new Error("Copilot uses custom sendMessage; callApi is not reachable.");
	}

	/**
	 * Full custom sendMessage for Copilot:
	 * - Uses DOM-based interaction since Copilot doesn't have a simple REST API
	 * - Falls back to DOM simulation for all requests
	 */
	override async sendMessage(params: {
		message: string;
		model?: string;
		signal?: AbortSignal;
	}): Promise<ReadableStream<Uint8Array>> {
		return this.chatCompletionsViaDOM({ message: params.message, signal: params.signal });
	}

	private async chatCompletionsViaDOM(params: {
		message: string;
		signal?: AbortSignal;
	}): Promise<ReadableStream<Uint8Array>> {
		const page = await this.getPage();
		const inputSelectors = [
			'[contenteditable="true"]',
			"textarea[placeholder]",
			"textarea",
			'div[role="textbox"]',
		];
		let inputHandle = null;
		for (const sel of inputSelectors) {
			inputHandle = await page.$(sel);
			if (inputHandle) break;
		}
		if (!inputHandle) throw new Error("Copilot: could not find chat input");
		await inputHandle.click();
		await delay(300);
		await pasteText(page, params.message, inputHandle);
		await delay(300);
		await page.keyboard.press("Enter");
		const maxWaitMs = 90000;
		const pollIntervalMs = 2000;
		let lastText = "";
		let stableCount = 0;
		for (let elapsed = 0; elapsed < maxWaitMs; elapsed += pollIntervalMs) {
			if (params.signal?.aborted) throw new Error("Copilot request aborted");
			await delay(pollIntervalMs);
			const result = await page.evaluate(() => {
				const clean = (t: string) => t.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
				const selectors = [
					'[data-content="ai-message"]',
					'[class*="response"]',
					'[class*="assistant"]',
					'[class*="message"]',
					"article",
					"[class*='markdown']",
					".prose",
				];
				let text = "";
				for (const sel of selectors) {
					const els = document.querySelectorAll(sel);
					const last = els.length > 0 ? els[els.length - 1] : null;
					if (last) {
						const t = clean((last as HTMLElement).textContent ?? "");
						if (t.length > 10) {
							text = t;
							break;
						}
					}
				}
				if (!text) {
					const all = document.querySelectorAll("p, div[class]");
					for (let i = all.length - 1; i >= 0; i--) {
						const t = clean((all[i] as HTMLElement).textContent ?? "");
						if (t.length > 20 && !t.includes("Ask me anything")) {
							text = t;
							break;
						}
					}
				}
				const stopBtn = document.querySelector('[aria-label*="Stop"], [aria-label*="stop"]');
				return { text, isStreaming: !!stopBtn };
			});
			if (result.text && result.text !== lastText) {
				lastText = result.text;
				stableCount = 0;
			} else if (result.text) {
				stableCount++;
				if (!result.isStreaming && stableCount >= 2) break;
			}
		}
		if (!lastText)
			throw new Error(
				"Copilot: no reply detected. Open copilot.microsoft.com, sign in, and ensure the chat input is visible.",
			);
		lastText = lastText
			.replace(/^Copilot said\s*/i, "")
			.replace(/\s*Edit in a page\s*$/i, "")
			.trim();
		const ndjsonLine = `${JSON.stringify({ contentDelta: lastText })}\n`;
		return textToStream(ndjsonLine);
	}

	protected parseStreamImpl(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult> {
		return parseCopilotStream(body, onDelta);
	}
}
