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
 * Extract all text deltas from a GLM SSE event. Same chatglm/z.ai backend
 * shape as the CN parser: incremental `parts[].content[].text` chunks followed
 * by full accumulated copies.
 */
function extractGlmIntlText(data: Record<string, unknown>): string {
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
			}
		}
	}
	if (out) return out;
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

export async function parseGlmIntlStream(
	body: ReadableStream<Uint8Array>,
	onDelta?: (delta: string) => void,
): Promise<StreamResult> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let fullText = "";

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
		appendDelta(extractGlmIntlText(data));
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
