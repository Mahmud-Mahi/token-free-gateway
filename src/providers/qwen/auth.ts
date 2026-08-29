import { chromium } from "playwright-core";
import {
	getChromeWebSocketUrl,
	getDefaultCdpUrl,
	getHeadersWithAuth,
} from "../../browser/cdp-helpers.ts";

export interface QwenWebAuth {
	sessionToken: string;
	cookie: string;
	userAgent: string;
}

export async function loginQwenWeb(params: {
	onProgress: (msg: string) => void;
	openUrl: (url: string) => Promise<boolean>;
}): Promise<QwenWebAuth> {
	const cdpUrl = getDefaultCdpUrl();
	params.onProgress("Connecting to Chrome debug port...");

	let wsUrl: string | null = null;
	for (let i = 0; i < 10; i++) {
		wsUrl = await getChromeWebSocketUrl(cdpUrl, 2000);
		if (wsUrl) {
			break;
		}
		await new Promise((r) => setTimeout(r, 500));
	}

	if (!wsUrl) {
		throw new Error(`Failed to resolve Chrome WebSocket URL from ${cdpUrl} after retries.`);
	}

	params.onProgress("Connecting to browser...");
	const browser = await chromium.connectOverCDP(wsUrl, {
		headers: getHeadersWithAuth(wsUrl),
		timeout: 60_000,
	});
	const context = browser.contexts()[0];
	if (!context) {
		throw new Error("No browser context available");
	}
	// Reuse an existing chat.qwen.ai tab instead of navigating pages()[0]
	// (which hijacks whatever tab happens to be first and creates duplicates).
	const existingPage = context.pages().find((p) => p.url().includes("chat.qwen.ai"));
	let page = existingPage ?? (await context.newPage());
	if (!page.url().includes("chat.qwen.ai")) {
		await page.goto("https://chat.qwen.ai/");
	}
	const userAgent = await page.evaluate(() => navigator.userAgent);

	params.onProgress("Please login to Qwen in the opened browser window...");

	return await new Promise<QwenWebAuth>((resolve, reject) => {
		let capturedToken: string | undefined;
		let resolved = false;

		const timeout = setTimeout(() => {
			if (!resolved) {
				reject(new Error("Login timed out (5 minutes)."));
			}
		}, 300_000);

		// chat.qwen.ai keeps its session token in localStorage under "token"
		// (it is no longer exposed as a cookie). Read it in-page.
		const readLocalStorageToken = async (): Promise<string | undefined> => {
			try {
				const token = await page.evaluate(() => {
					const direct = localStorage.getItem("token");
					if (direct) return direct;
					// Fall back to scanning for any token-like entry
					for (let i = 0; i < localStorage.length; i++) {
						const key = localStorage.key(i);
						if (!key) continue;
						const lower = key.toLowerCase();
						if (lower.includes("token") || lower.includes("session") || lower.includes("auth")) {
							const value = localStorage.getItem(key);
							if (value && value.length > 20) return value;
						}
					}
					return null;
				});
				return token || undefined;
			} catch {
				return undefined;
			}
		};

		const tryResolve = async () => {
			if (resolved) {
				return;
			}

			try {
				const cookies = await context.cookies(["https://chat.qwen.ai", "https://qwen.ai"]);
				if (cookies.length === 0) {
					console.log(`[Qwen] No cookies found in context yet.`);
					return;
				}

				const cookieNames = cookies.map((c) => c.name);
				console.log(`[Qwen] Found cookies: ${cookieNames.join(", ")}`);

				const localStorageToken = await readLocalStorageToken();
				const finalToken = capturedToken || localStorageToken || "";

				if (finalToken && cookies.length > 2) {
					resolved = true;
					clearTimeout(timeout);
					console.log(`[Qwen] Session token captured!`);

					const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

					resolve({
						sessionToken: finalToken,
						cookie: cookieString,
						userAgent,
					});
				} else {
					console.log(`[Qwen] Waiting for session token (localStorage/Authorization)...`);
				}
			} catch (e: unknown) {
				console.error(`[Qwen] Failed to fetch cookies: ${String(e)}`);
			}
		};

		// Capture the Bearer token the SPA sends on API requests (context-wide,
		// so login flows in other qwen tabs are caught too).
		context.on("request", (request) => {
			if (!request.url().includes("qwen.ai")) return;
			const auth = request.headers().authorization;
			if (auth?.startsWith("Bearer ") && auth.length > 10) {
				if (!capturedToken) {
					console.log(`[Qwen] Captured authorization token from request.`);
					capturedToken = auth.replace("Bearer ", "");
				}
				void tryResolve();
			}
		});

		page.on("response", async (response) => {
			const url = response.url();
			if (url.includes("qwen.ai") && response.ok()) {
				await tryResolve();
			}
		});

		// If the user closes the qwen tab, try to recover with another qwen tab
		// (the token lives in the profile, not the tab). Only give up if none remain.
		page.on("close", async () => {
			if (resolved) return;
			const replacement = context.pages().find((p) => p.url().includes("chat.qwen.ai"));
			if (replacement) {
				page = replacement;
				console.log(`[Qwen] Tab closed; switched to another Qwen tab.`);
				return;
			}
			const token = await readLocalStorageToken().catch(() => undefined);
			const cookies = await context
				.cookies(["https://chat.qwen.ai", "https://qwen.ai"])
				.catch(() => []);
			if (token && cookies.length > 2) {
				resolved = true;
				clearTimeout(timeout);
				console.log(`[Qwen] Session token captured from profile after tab close.`);
				resolve({
					sessionToken: token,
					cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
					userAgent,
				});
				return;
			}
			reject(new Error("Browser window closed before login was captured."));
		});

		const checkInterval = setInterval(async () => {
			await tryResolve();
			if (resolved) {
				clearInterval(checkInterval);
			}
		}, 2000);
	});
}
