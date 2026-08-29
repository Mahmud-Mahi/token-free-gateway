import { chromium } from "playwright-core";
import {
	getChromeWebSocketUrl,
	getDefaultCdpUrl,
	getHeadersWithAuth,
} from "../../browser/cdp-helpers.ts";

export interface CopilotWebAuth {
	cookie: string;
	userAgent: string;
}

export async function loginCopilotWeb(params: {
	onProgress: (msg: string) => void;
	openUrl: (url: string) => Promise<boolean>;
}): Promise<CopilotWebAuth> {
	const onProgress = params.onProgress;
	const cdpUrl = getDefaultCdpUrl();
	onProgress(`Connecting to Chrome at ${cdpUrl}...`);

	let wsUrl: string | null = null;
	for (let i = 0; i < 10; i++) {
		wsUrl = await getChromeWebSocketUrl(cdpUrl, 2000);
		if (wsUrl) break;
		await new Promise((r) => setTimeout(r, 500));
	}
	if (!wsUrl) {
		throw new Error(
			`Failed to connect to Chrome at ${cdpUrl}. Make sure Chrome is running in debug mode.`,
		);
	}

	onProgress("Connecting to browser...");
	const browser = await chromium.connectOverCDP(wsUrl, {
		headers: getHeadersWithAuth(wsUrl),
	});
	const context = browser.contexts()[0];
	if (!context) throw new Error("No browser context available");

	// Reuse existing Copilot tab to avoid duplicate (same fix as before)
	let page = context.pages().find((p) => p.url().includes("copilot.microsoft.com"));
	if (!page) {
		for (const p of context.pages()) {
			try {
				const href = await p.evaluate(() => location.href);
				if (href.includes("copilot.microsoft.com")) {
					page = p;
					break;
				}
			} catch {}
		}
	}
	if (!page) {
		page = await context.newPage();
		onProgress("Navigating to Copilot...");
		await page.goto("https://copilot.microsoft.com", { waitUntil: "domcontentloaded" });
	} else {
		try {
			await page.bringToFront();
		} catch {}
		if (!page.url().includes("copilot.microsoft.com")) {
			onProgress("Navigating to Copilot...");
			await page.goto("https://copilot.microsoft.com", { waitUntil: "domcontentloaded" });
		}
	}

	const userAgent = await page.evaluate(() => navigator.userAgent);
	onProgress("Please sign in to Copilot in the browser window...");
	onProgress("Waiting for authentication...");

	return new Promise<CopilotWebAuth>((resolve, reject) => {
		let resolved = false;

		const timeout = setTimeout(() => {
			if (!resolved) reject(new Error("Login timed out (5 minutes)."));
		}, 300000);

		// Like claude/chatgpt: poll context.cookies() which sees HttpOnly cookies.
		// document.cookie can't see _U/MSPAuth (HttpOnly) — that's why waitForFunction hung.
		const tryResolve = async () => {
			if (resolved) return;
			try {
				const cookies = await context.cookies();
				if (cookies.length === 0) return;

				const hasAuth = cookies.some(
					(c) => c.name === "_U" || c.name === "MSPAuth" || c.name === "MSPProf" || c.name === "__Host-copilot",
				);
				if (!hasAuth) return;

				resolved = true;
				clearTimeout(timeout);
				clearInterval(interval);
				const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
				onProgress("Login detected, capturing cookies...");
				onProgress("Authentication captured successfully.");
				resolve({ cookie: cookieString, userAgent });
			} catch (e) {
				console.error(`[Copilot] Failed to fetch cookies: ${e}`);
			}
		};

		page.on("close", () => {
			if (!resolved) {
				clearTimeout(timeout);
				clearInterval(interval);
				reject(new Error("Browser window closed before login was captured."));
			}
		});

		const interval = setInterval(() => {
			void tryResolve();
		}, 1000);

		void tryResolve();
	});
}
