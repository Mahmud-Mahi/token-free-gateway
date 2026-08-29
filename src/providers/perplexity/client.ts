import type { Page } from "playwright-core";
import { pasteText } from "../../browser/dom-input.ts";
import { BaseDomClient } from "../factory/base-dom-client.ts";
import type { DomClientConfig, NormalizedSendParams } from "../factory/types.ts";
import { parseCookieHeader } from "../shared/cookie-parser.ts";
import type { StreamResult } from "../types.ts";
import type { PerplexityWebAuth } from "./auth.ts";
import { parsePerplexityStream } from "./stream.ts";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class PerplexityWebClient extends BaseDomClient<PerplexityWebAuth> {
	readonly providerId = "perplexity-web";

	protected readonly config: DomClientConfig = {
		hostKey: "perplexity.ai",
		startUrl: "https://www.perplexity.ai",
		cookieDomain: ".perplexity.ai",
		models: [
			{ id: "perplexity-web", name: "Perplexity (Sonar)" },
			{ id: "perplexity-pro", name: "Perplexity Pro" },
		],
		pollIntervalMs: 3000,
		maxWaitMs: 120_000,
		stabilityThreshold: 2,
	};

	protected getCookies() {
		return parseCookieHeader(this.auth.cookie, this.config.cookieDomain);
	}

	protected async sendViaDom(page: Page, params: NormalizedSendParams): Promise<string> {
		const newThreadBtn = await page.$(
			'button:has-text("新建问题"), button:has-text("New Thread"), a:has-text("新建问题"), a:has-text("New Thread")',
		);
		if (newThreadBtn) {
			await newThreadBtn.click();
			await delay(1500);
		} else {
			await page.goto("https://www.perplexity.ai/", { waitUntil: "domcontentloaded" });
			await delay(2000);
		}

		const inputSel = 'div[contenteditable="true"], [role="textbox"], textarea';
		const inputHandle = await page.$(inputSel);
		if (!inputHandle) throw new Error("Perplexity DOM: input not found");
		await inputHandle.click();
		await delay(300);
		await page.keyboard.press("Meta+a");
		await page.keyboard.press("Backspace");
		await delay(200);
		await pasteText(page, params.message, inputHandle);
		await delay(300);

		const urlBeforeSubmit = page.url();
		await page.keyboard.press("Enter");

		try {
			await page.waitForURL(
				(url) =>
					url.href !== urlBeforeSubmit &&
					(url.pathname.startsWith("/search/") || url.pathname.startsWith("/c/")),
				{ timeout: 15000 },
			);
		} catch {
			/* continue polling */
		}

		// Dump DOM diagnostics once so `bun --hot` logs show what
		// selectors are actually present on the user's Perplexity page.
		// This helps when Perplexity A/B tests a new layout.
		try {
			const diag = await page.evaluate(() => {
				const clean = (t: string) => t.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
				const cnt = (sel: string) => document.querySelectorAll(sel).length;
				const sample = (sel: string, n = 3) =>
					Array.from(document.querySelectorAll(sel))
						.slice(-n)
						.map((e) => clean((e as HTMLElement).innerText ?? "").slice(0, 120));
				return {
					url: location.href,
					markdownContent: cnt('div[id^="markdown-content-"]'),
					prose: cnt('[class*="prose"]'),
					threadWidth: cnt('div[class*="threadContentWidth"], div.max-w-threadContentWidth'),
					selectText: cnt('span.select-text'),
					answerTestId: cnt("[data-testid='answer-content']"),
					pMy2: cnt("p.my-2"),
					markdownSample: sample('div[id^="markdown-content-"]', 1),
					proseSample: sample('[class*="prose"]', 2),
				};
			});
			console.log("[Perplexity] DOM diag:", JSON.stringify(diag, null, 2));
		} catch {
			/* ignore diag errors */
		}

		return this.pollForStableText(async () => {
			const extracted = await page.evaluate(
				(userPrompt) => {
					const clean = (t: string) => t.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();

					const normText = (s: string) =>
						s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim();

					/**
					 * Find the element that holds the user's *query*.
					 *
					 * IMPORTANT: we must anchor on the real prompt text, not just on
					 * "query-ish" selectors. Perplexity also renders `span.select-text`
					 * inside the ANSWER body and follow-up suggestion chips that match
					 * `[class*='query']` — anchoring on those makes every candidate be
					 * filtered to "content after the anchor", which drops the whole
					 * answer and leaves only the last block + suggestion chips.
					 */
					const getLastQueryEl = (): Element | null => {
						const selectors = [
							"span.select-text",
							"h1[class*='group/query']",
							"h1",
							"[class*='query']",
							"[class*='question']",
						];
						const want = normText(userPrompt ?? "");
						const wantHead = want.slice(0, 60);
						const canMatch = wantHead.length >= 5;
						let heuristic: Element | null = null;
						for (const sel of selectors) {
							const els = document.querySelectorAll(sel);
							for (let i = els.length - 1; i >= 0; i--) {
								const el = els[i] as HTMLElement;
								const t = clean(el.innerText ?? "");
								if (t.length < 5) continue;
								if (!heuristic) heuristic = el;
								if (!canMatch) continue;
								const nt = normText(t);
								if (!nt) continue;
								// The prompt (or a meaningful prefix of it) must appear in the element
								if (nt.includes(wantHead) || wantHead.startsWith(nt)) return el;
							}
						}
						// Prompt too short to anchor on (e.g. "hi") — fall back to the
						// previous heuristic, preferring the LAST query-ish element that
						// sits BEFORE any large answer body.
						return heuristic;
					};

					const joinProseIn = (root: Element): string | null => {
						const proseEls = root.querySelectorAll(".prose, [class*='prose']");
						if (proseEls.length > 0) {
							const parts: string[] = [];
							for (const el of Array.from(proseEls)) {
								const t = clean((el as HTMLElement).innerText ?? "");
								if (t) parts.push(t);
							}
							const deduped = parts.filter((p, i) => i === 0 || p !== parts[i - 1]);
							if (deduped.length > 0) {
								const j = deduped.join("\n\n");
								if (j.length >= 2) return j;
							}
						}
						const t = clean((root as HTMLElement).innerText ?? "");
						return t.length >= 2 ? t : null;
					};

					const lastQuery = getLastQueryEl();
					const candidates: { name: string; text: string }[] = [];
					const push = (name: string, text: string | null) => {
						if (text && text.length >= 10) candidates.push({ name, text });
					};

					// 1) markdown-content containers - collect ALL after lastQuery
					const markdownContainers = Array.from(
						document.querySelectorAll('div[id^="markdown-content-"]'),
					) as HTMLElement[];
					if (markdownContainers.length > 0) {
						let relevant: HTMLElement[] = markdownContainers;
						if (lastQuery) {
							const filtered = markdownContainers.filter(
								(el) => (lastQuery.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
							);
							if (filtered.length > 0) relevant = filtered;
						} else {
							// No query marker: on a fresh thread all containers belong to last turn
							relevant = markdownContainers;
						}
						const allParts: string[] = [];
						for (const cont of relevant) {
							const j = joinProseIn(cont);
							if (j) allParts.push(j);
						}
						if (allParts.length > 0) {
							const deduped = allParts.filter((p, i) => i === 0 || p !== allParts[i - 1]);
							push("markdown-content", deduped.join("\n\n"));
						}
					}

					// 2) data-testid selectors
					for (const sel of ["[data-testid='answer-content']", "[data-testid='search-result']", "[data-testid*='answer']"]) {
						const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
						if (els.length === 0) continue;
						let relevant: HTMLElement[] = els;
						if (lastQuery) {
							const filtered = els.filter(
								(el) => (lastQuery.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
							);
							if (filtered.length > 0) relevant = filtered;
						}
						const parts = relevant.map((e) => clean(e.innerText ?? "")).filter((t) => t.length >= 10);
						if (parts.length > 0) push(`testid:${sel}`, parts.join("\n\n"));
					}

					// 3) prose / p.my-2 after lastQuery, scoped to threadWidth then document
					const scopeCandidates = Array.from(
						document.querySelectorAll('div[class*="threadContentWidth"], div.max-w-threadContentWidth'),
					) as HTMLElement[];
					const scopes: Element[] = scopeCandidates.length > 0 ? [scopeCandidates[scopeCandidates.length - 1] as Element] : [document.body];
					// also try document-wide as separate candidate
					if (scopes[0] !== document.body) scopes.push(document.body);

					for (const scope of scopes) {
						for (const sel of ["[class*='prose']", "p.my-2", "[class*='answer']", "[class*='response']"]) {
							const els = Array.from(scope.querySelectorAll(sel)) as HTMLElement[];
							if (els.length === 0) continue;
							let relevant = els;
							if (lastQuery) {
								const filtered = els.filter(
									(el) => (lastQuery.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
								);
								if (filtered.length > 0) relevant = filtered;
							}
							const slice = relevant.length > 50 && !lastQuery ? relevant.slice(-50) : relevant;
							const parts = slice.map((e) => clean(e.innerText ?? "")).filter((t) => t.length >= 5);
							const noise = ["Copy", "Share", "Rewrite", "Related", "Sources"];
							const filteredParts = parts.filter((p) => !noise.some((n) => p === n));
							if (filteredParts.length > 0) push(`prose:${sel}@${scope === document.body ? "body" : "thread"}`, filteredParts.join("\n\n"));
						}
					}

					// 4) generic fallback selectors
					for (const sel of ['[class*="break-words"][class*="font-sans"]', '[class*="markdown"]', '[class*="threadConten"] [class*="gap-y-sm"]']) {
						const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
						if (els.length === 0) continue;
						let relevant = els;
						if (lastQuery) {
							const filtered = els.filter(
								(el) => (lastQuery.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
							);
							if (filtered.length > 0) relevant = filtered;
						}
						const parts = relevant.map((e) => clean(e.innerText ?? "")).filter((t) => t.length >= 10);
						if (parts.length > 0) push(`generic:${sel}`, parts.join("\n\n"));
					}

					// 5) Brutal fallback: body/main innerText sliced after last query text
					//    This catches layouts where prose selectors changed entirely.
					try {
						const bodyText = clean(document.body.innerText ?? "");
						const mainText = clean(document.querySelector("main")?.textContent ? (document.querySelector("main") as HTMLElement).innerText ?? "" : "");
						const textToSlice = mainText.length > bodyText.length * 0.6 ? mainText : bodyText;
						if (textToSlice.length > 400) {
							let sliceIdx = -1;
							if (lastQuery) {
								const qText = clean((lastQuery as HTMLElement).innerText ?? "").slice(0, 80);
								if (qText.length >= 10) sliceIdx = textToSlice.lastIndexOf(qText);
								if (sliceIdx !== -1) sliceIdx += qText.length;
							}
							if (sliceIdx === -1 && userPrompt) {
								const q = clean(userPrompt).slice(0, 40);
								if (q.length >= 10) {
									const idx = textToSlice.lastIndexOf(q);
									if (idx !== -1) sliceIdx = idx + q.length;
								}
							}
							if (sliceIdx !== -1 && sliceIdx < textToSlice.length - 50) {
								let after = textToSlice.slice(sliceIdx).trim();
								// Strip common footer noise
								after = after.replace(/^(References|Sources|Related|Follow-up).*/ims, "").trim();
								// Remove trailing UI chrome like "Ask anything" placeholder duplication
								after = after.split("\n").filter((line) => {
									const l = line.trim().toLowerCase();
									return l !== "ask anything" && l !== "sources" && l !== "related" && l.length > 0;
								}).join("\n");
								if (after.length >= 100) push("body-slice", after);
							} else if (textToSlice.length >= 500) {
								// No query anchor found — push main text as low-priority candidate
								push("body-full", textToSlice.slice(0, 8000));
							}
						}
					} catch {}

					if (candidates.length === 0) return "";

					// Strip Perplexity's inline source-citation chips, which are rendered
					// inside the answer as a bare domain followed by a "+N" count line,
					// e.g. "busuu\n+1" / "englishlive.ef\n+3".
					const stripCitationChips = (s: string): string =>
						s
							.replace(/\n[a-z0-9][a-z0-9.-]{1,40}\n\+\d{1,3}\b/gi, "")
							.replace(/\n\+\d{1,3}\b/g, "")
							.replace(/\n{3,}/g, "\n\n")
							.trim();

					// Pick longest candidate (heuristic: longest non-noise text is most complete)
					// Log candidate lengths via a side-channel property the outer code can read
					(candidates as unknown as { __debug?: unknown }).__debug = candidates.map((c) => `${c.name}:${c.text.length}`).join(" | ");
					// Attach debug string to DOM for outer log
					(document as unknown as { __pplxCandidatesDebug?: string }).__pplxCandidatesDebug = candidates
						.map((c) => `${c.name}:${c.text.length}`)
						.join(" | ");

					let best = candidates[0] as { name: string; text: string };
					for (const c of candidates) if (c.text.length > best.text.length) best = c;
					// Also consider that best should contain at least 2 sentences or >200 chars if any candidate does
					const longEnough = candidates.filter((c) => c.text.length >= 200);
					if (longEnough.length > 0) {
						let bestLong = longEnough[0] as { name: string; text: string };
						for (const c of longEnough) if (c.text.length > bestLong.text.length) bestLong = c;
						// Prefer longEnough over tiny tail
						if (bestLong.text.length > best.text.length * 1.5 || best.text.length < 200) best = bestLong;
					}
					return stripCitationChips(best.text);
				},
				params.message,
			);

			// Diagnostics: log candidate breakdown and extracted length
			try {
				const candDebug = await page.evaluate(() => (document as unknown as { __pplxCandidatesDebug?: string }).__pplxCandidatesDebug ?? "");
				// @ts-ignore - stash on global
				const g = globalThis as unknown as { __pplxLastLen?: number; __pplxLastDebug?: string };
				if (extracted.length !== g.__pplxLastLen || candDebug !== g.__pplxLastDebug) {
					g.__pplxLastLen = extracted.length;
					g.__pplxLastDebug = candDebug;
					console.log(`[Perplexity] candidates: ${candDebug}`);
					console.log(`[Perplexity] poll picked ${extracted.length} chars: ${extracted.slice(0, 180).replace(/\n/g, "\\n")}...`);
				}
			} catch {}

			// If still suspiciously short (<250 chars) and we likely truncated,
			// dump a snapshot for debugging (outerHTML truncated)
			if (extracted.length > 0 && extracted.length < 250) {
				try {
					const htmlLen = await page.evaluate(() => document.documentElement.outerHTML.length);
					console.warn(`[Perplexity] WARNING: extracted only ${extracted.length} chars (tail) htmlLen=${htmlLen} — dumping selectors`);
					const extra = await page.evaluate(() => {
						const clean = (t: string) => t.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
						return {
							mainInnerTextLen: clean((document.querySelector("main") as HTMLElement)?.innerText ?? "").length,
							bodyInnerTextLen: clean(document.body.innerText ?? "").length,
							proseCount: document.querySelectorAll('[class*="prose"]').length,
							markdownCount: document.querySelectorAll('div[id^="markdown-content-"]').length,
							mainSnippet: clean((document.querySelector("main") as HTMLElement)?.innerText ?? "").slice(0, 600),
						};
					});
					console.warn(`[Perplexity] extra: ${JSON.stringify(extra, null, 2)}`);
				} catch {}
			}

			return extracted;
		}, params.signal);
	}

	protected override formatSsePayload(text: string): string {
		return `data: ${JSON.stringify({ text })}\n\ndata: [DONE]\n\n`;
	}

	protected parseStreamImpl(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult> {
		return parsePerplexityStream(body, onDelta);
	}
}
