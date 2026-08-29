import type { StreamResult } from "../types.ts";

function parseSseData(dataStr: string): Record<string, unknown> | null {
	if (!dataStr || dataStr === "[DONE]") return null;
	try {
		const v = JSON.parse(dataStr);
		return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * Extract all text deltas from a chatglm.cn SSE event.
 *
 * The backend sends `parts[].content[]` where `type === "text"` items hold the
 * response text. Each event normally carries one small incremental chunk, and
 * the final 1–2 events repeat the *full accumulated* text. Non-text items
 * (`think`, `tool_calls`, etc.) are ignored here.
 */
function extractGlmText(data: Record<string, unknown>): string {
	let out = "";
	if (data.parts && Array.isArray(data.parts)) {
		for (const part of data.parts) {
			if (!part || typeof part !== "object") continue;
			const p = part as Record<string, unknown>;
			const content = p.content;
			if (Array.isArray(content)) {
				for (const c of content) {
					if (c && typeof c === "object") {
						const cc = c as Record<string, unknown>;
						if (cc.type === "text" && typeof cc.text === "string") out += cc.text;
					}
				}
			} else if (typeof content === "string") {
				out += content;
			}
		}
	}
	if (out) return out;

	const choices = data.choices;
	if (Array.isArray(choices) && choices.length > 0) {
		const choice = choices[0] as Record<string, unknown>;
		const d = choice.delta as Record<string, unknown> | undefined;
		if (d && typeof d.content === "string") return d.content;
	}

	const t = data.text ?? data.content ?? data.delta ?? (typeof data.message === "string" ? data.message : undefined);
	return typeof t === "string" ? t : "";
}

function splitRedactedThinking(full: string): { text: string; thinkingText: string } {
	let thinkingText = "";
	const re = /<redacted_thinking>([\s\S]*?)<\/redacted_thinking>/gi;
	for (let m = re.exec(full); m !== null; m = re.exec(full)) {
		thinkingText += (thinkingText ? "\n" : "") + (m[1]?.trim() ?? "");
	}
	const text = full.replace(re, "").trim();
	return { text, thinkingText };
}

export async function parseGlmStream(
	body: ReadableStream<Uint8Array>,
	onDelta?: (delta: string) => void,
): Promise<StreamResult> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let fullText = "";

	/**
	 * chatglm.cn streams *incremental* text chunks, then a couple of *full
	 * accumulated* copies at the end. Append each chunk; if the incoming text is
	 * a cumulative prefix of what we've already built (e.g. a re-sent snapshot or
	 * a growing-prefix backend), only push the added tail so we never duplicate.
	 */
	function appendDelta(delta: string): void {
		if (!delta) return;
		if (delta.startsWith(fullText)) {
			const newPart = delta.slice(fullText.length);
			if (newPart) {
				fullText += newPart;
				onDelta?.(newPart);
			}
		} else {
			fullText += delta;
			onDelta?.(delta);
		}
	}

	function processLine(line: string): void {
		if (!line.startsWith("data:")) return;
		const dataStr = line.slice(5).trim();
		const data = parseSseData(dataStr);
		if (!data) return;
		appendDelta(extractGlmText(data));
	}

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				if (buffer.trim()) processLine(buffer.trim());
				break;
			}
			const chunk = decoder.decode(value, { stream: true });
			const combined = buffer + chunk;
			const parts = combined.split("\n");
			buffer = parts.pop() || "";
			for (const part of parts) {
				const trimmed = part.trim();
				if (trimmed) processLine(trimmed);
			}
		}
	} finally {
		reader.releaseLock();
	}

	const split = splitRedactedThinking(fullText);
	return {
		text: split.text,
		thinkingText: split.thinkingText,
	};
}
