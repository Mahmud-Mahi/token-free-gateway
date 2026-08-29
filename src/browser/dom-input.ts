import type { ElementHandle, Page } from "playwright-core";

/**
 * Insert text into the currently focused element.
 *
 * React-controlled contenteditable inputs (Perplexity, ChatGPT, …) keep their
 * own state and only re-render/sync when they receive a real `input` event.
 * A bare synthetic `ClipboardEvent("paste")` mutates the DOM but does NOT
 * update React's state, so the text looks inserted while the app still
 * believes the field is empty — pressing Enter then submits nothing.
 *
 * Strategy (in order):
 *  1. `document.execCommand("insertText")` — fires a genuine `input` event
 *     that React's synthetic event system picks up.
 *  2. Synthetic ClipboardEvent + explicit InputEvent dispatch.
 *  3. Real clipboard + Ctrl/Cmd+V as a last resort.
 */
export async function pasteText(
	page: Page,
	text: string,
	inputHandle?: ElementHandle | null,
): Promise<void> {
	// 1) execCommand insertText (fires a real `input` event)
	await page.evaluate((t: string) => {
		const el = document.activeElement as HTMLElement | null;
		if (!el) return false;
		el.focus();
		try {
			const sel = window.getSelection();
			if (sel) {
				const range = document.createRange();
				range.selectNodeContents(el);
				range.collapse(false); // move caret to the end
				sel.removeAllRanges();
				sel.addRange(range);
			}
			return document.execCommand("insertText", false, t);
		} catch {
			return false;
		}
	}, text);
	await page.waitForTimeout(400);

	if (await pasted(page, text, inputHandle)) return;

	// 2) Synthetic ClipboardEvent + explicit InputEvent (so React state syncs)
	await page.evaluate((t: string) => {
		const el = document.activeElement;
		if (!el) return;
		const dt = new DataTransfer();
		dt.setData("text/plain", t);
		el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
		el.dispatchEvent(
			new InputEvent("input", { bubbles: true, data: t, inputType: "insertText" }),
		);
	}, text);
	await page.waitForTimeout(400);

	if (await pasted(page, text, inputHandle)) return;

	console.log("[dom-input] paste missed, retrying via Ctrl+V");
	await page.evaluate(async (t: string) => {
		await navigator.clipboard.writeText(t);
	}, text);
	await page.waitForTimeout(200);
	const mod = process.platform === "darwin" ? "Meta" : "Control";
	await page.keyboard.press(`${mod}+KeyV`);
	await page.waitForTimeout(400);
	await pasted(page, text, inputHandle);
}

/** Verify the focused/target element actually received the text. */
async function pasted(
	page: Page,
	text: string,
	inputHandle?: ElementHandle | null,
): Promise<boolean> {
	const actual = inputHandle
		? await inputHandle.innerText().catch(() => "")
		: await page.evaluate(() => (document.activeElement as HTMLElement)?.innerText ?? "");
	return actual.trim().length >= Math.min(text.length * 0.5, 20);
}
