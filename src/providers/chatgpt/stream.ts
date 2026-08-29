import type { StreamResult } from "../types.ts";

// Tokens that should be ignored (end-of-thinking markers etc.)
const JUNK_TOKENS = new Set([
	"<｜end▁of▁thinking｜>",
	"<|end▁of▁thinking|>",
	"<｜end_of_thinking｜>",
	"<|end_of_thinking|>",
	"<|endoftext|>",
]);

function stripEntityTags(text: string): string {
	// Extract middle text from entity citations: entity["company","OpenAI","AI research..."] → "OpenAI"
	let out = text.replace(/entity\s*(\[[^\]]*?\])\s*/g, (_, jsonStr: string) => {
		try {
			const arr = JSON.parse(jsonStr) as unknown[];
			if (Array.isArray(arr)) {
				if (arr.length >= 2 && typeof arr[1] === "string" && (arr[1] as string).trim()) {
					return arr[1] as string;
				}
				for (const v of arr) {
					if (typeof v === "string" && v.trim() && v !== "company" && v !== "person" && v !== "entity" && v !== "organization") {
						return v;
					}
				}
				if (typeof arr[0] === "string") return arr[0] as string;
			}
		} catch {
			// fallback: extract quoted strings
			const quotes = [...jsonStr.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
			if (quotes.length >= 2) return quotes[1]!;
			if (quotes.length === 1) return quotes[0]!;
		}
		return "";
	});
	out = out.replace(/[^]*?/g, "").replace(/【[^】]*?】/g, "").replace(/\[\^[^\]]*?\]/g, "");
	return out;
}

function stripInlineMarkdown(text: string): string {
	return text
		.replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/`{1,3}([^`]+)`{1,3}/g, "$1");
}

function stripMarkdown(text: string): string {
	let out = stripEntityTags(text);
	// Remove bold/italic markers **, __, *, _
	out = out
		.replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/_([^_]+)_/g, "$1")
		.replace(/`{1,3}([^`]+)`{1,3}/g, "$1")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/^\s*[-*]\s+/gm, "")
		.replace(/^\s*\d+\.\s+/gm, "");
	// Flatten newlines to spaces and collapse whitespace (remove \n as requested)
	out = out.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ");
	// Fix spacing artifacts from entity removal (e.g. "by .")
	out = out.replace(/\s+([.,!?;:])/g, "$1");
	return out.trim();
}

function sanitizeChunk(chunk: string): string {
	// For live streaming deltas, do lightweight cleaning that is safe per-chunk
	let out = stripEntityTags(chunk);
	out = stripInlineMarkdown(out);
	// Flatten newlines in chunk as well to avoid \n in streaming
	out = out.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ");
	out = out.replace(/\s+([.,!?;:])/g, "$1");
	return out;
}

export async function parseChatGPTStream(
	body: ReadableStream<Uint8Array>,
	onDelta?: (delta: string) => void,
	onMeta?: (meta: { conversationId?: string; parentMessageId?: string }) => void,
): Promise<StreamResult> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let accumulatedContent = "";
	let text = "";
	let thinkingText = "";

	// Tag-based thinking detection (like deepseek-reasoner / qwen)
	let currentMode: "text" | "thinking" = "text";
	let tagBuffer = "";

	const emitText = (delta: string) => {
		if (!delta || JUNK_TOKENS.has(delta)) return;
		text += delta;
		onDelta?.(sanitizeChunk(delta));
	};

	const emitThinking = (delta: string) => {
		if (!delta || JUNK_TOKENS.has(delta)) return;
		thinkingText += delta;
	};

	const pushDelta = (delta: string, forceType?: "text" | "thinking") => {
		if (!delta) return;
		if (forceType === "thinking") {
			emitThinking(delta);
			return;
		}
		if (forceType === "text") {
			emitText(delta);
			return;
		}
		tagBuffer += delta;

		const checkTags = () => {
			const thinkStartMatch = tagBuffer.match(/<(?:think(?:ing)?|thought|reasoning)\b[^<>]*>/i);
			const thinkEndMatch = tagBuffer.match(/<\/(?:think(?:ing)?|thought|reasoning)\b[^<>]*>/i);

			const indices = [
				{
					type: "think_start" as const,
					idx: thinkStartMatch?.index ?? -1,
					len: thinkStartMatch?.[0].length ?? 0,
				},
				{
					type: "think_end" as const,
					idx: thinkEndMatch?.index ?? -1,
					len: thinkEndMatch?.[0].length ?? 0,
				},
			].filter((t) => t.idx !== -1).toSorted((a, b) => a.idx - b.idx);

			if (indices.length > 0) {
				const first = indices[0]!;
				const before = tagBuffer.slice(0, first.idx);
				if (before) {
					if (currentMode === "thinking") emitThinking(before);
					else emitText(before);
				}
				if (first.type === "think_start") {
					currentMode = "thinking";
				} else if (first.type === "think_end") {
					currentMode = "text";
				}
				tagBuffer = tagBuffer.slice(first.idx + first.len);
				checkTags();
			} else {
				const lastAngle = tagBuffer.lastIndexOf("<");
				if (lastAngle === -1) {
					if (currentMode === "thinking") emitThinking(tagBuffer);
					else emitText(tagBuffer);
					tagBuffer = "";
				} else if (lastAngle > 0) {
					const safe = tagBuffer.slice(0, lastAngle);
					if (currentMode === "thinking") emitThinking(safe);
					else emitText(safe);
					tagBuffer = tagBuffer.slice(lastAngle);
				}
			}
		};
		checkTags();
	};

	const flushTagBuffer = () => {
		if (!tagBuffer) return;
		if (currentMode === "thinking") emitThinking(tagBuffer);
		else emitText(tagBuffer);
		tagBuffer = "";
	};

	const processLine = (line: string) => {
		if (!line?.startsWith("data: ")) {
			return;
		}

		const dataStr = line.slice(6).trim();
		if (dataStr === "[DONE]") {
			return;
		}
		if (!dataStr) {
			return;
		}

		try {
			const data = JSON.parse(dataStr) as Record<string, unknown>;

			// Meta tracking (conversation_id / message id)
			if (typeof data.conversation_id === "string") {
				onMeta?.({ conversationId: data.conversation_id });
			}
			const msg = data.message as
				| {
						id?: string;
						author?: { role?: string };
						role?: string;
						content?: { parts?: unknown[]; content_type?: string; text?: string; thinking?: string; reasoning?: string };
						metadata?: Record<string, unknown>;
				  }
				| undefined;
			if (msg?.id) {
				onMeta?.({ parentMessageId: msg.id });
			}

			// --- Structured thinking fields (deepseek-like / openai-like) ---
			// p/v reasoning channel (DeepSeek style, also possible for ChatGPT)
			const pField = data.p as string | undefined;
			const pStr = typeof pField === "string" ? pField : "";
			if ((pStr.includes("reasoning") || pStr.includes("thinking") || data.type === "thinking") && typeof data.v === "string") {
				pushDelta(data.v, "thinking");
				return;
			}
			if (data.type === "thinking" && typeof data.content === "string") {
				pushDelta(data.content, "thinking");
				return;
			}

			// reasoning_content in choices[0].delta (OpenAI style used by think models)
			const choice = (data.choices as Array<{ delta?: { reasoning_content?: string; reasoning?: string; thinking?: string; content?: string } }> | undefined)?.[0];
			if (choice?.delta) {
				if (choice.delta.reasoning_content) {
					pushDelta(choice.delta.reasoning_content, "thinking");
				}
				if (choice.delta.reasoning) {
					pushDelta(choice.delta.reasoning, "thinking");
				}
				if (choice.delta.thinking) {
					pushDelta(choice.delta.thinking, "thinking");
				}
				// If there was reasoning, also handle content separately
				if (choice.delta.content) {
					pushDelta(choice.delta.content);
					return;
				}
				if (choice.delta.reasoning_content || choice.delta.reasoning || choice.delta.thinking) {
					return;
				}
			}

			// v as array with THINKING fragments
			if (Array.isArray(data.v)) {
				let handled = false;
				for (const frag of data.v as Array<Record<string, unknown>>) {
					if (frag.type === "THINKING" || frag.type === "reasoning" || frag.type === "thinking") {
						pushDelta(String(frag.content || ""), "thinking");
						handled = true;
					} else if (frag.content) {
						pushDelta(String(frag.content));
						handled = true;
					}
				}
				if (handled) return;
			}

			// ChatGPT specific: message.content with thinking type
			if (msg?.content) {
				const c = msg.content as Record<string, unknown>;
				// Handle explicit thinking content_type
				if (c.content_type === "thinking" || c.content_type === "reasoning" || c.content_type === "thoughts") {
					const thoughtStr =
						(typeof c.thinking === "string" && c.thinking) ||
						(typeof c.reasoning === "string" && c.reasoning) ||
						(typeof c.text === "string" && c.text) ||
						"";
					if (thoughtStr) {
						pushDelta(thoughtStr, "thinking");
						return;
					}
					// parts may contain thinking strings
					const partsThinking = c.parts as unknown[] | undefined;
					if (Array.isArray(partsThinking) && partsThinking.length > 0) {
						for (const p of partsThinking) {
							if (typeof p === "string" && p) pushDelta(p, "thinking");
							else if (typeof p === "object" && p !== null && "text" in p && typeof (p as { text?: string }).text === "string") {
								pushDelta((p as { text: string }).text, "thinking");
							}
						}
						return;
					}
				}

				// Also check metadata for reasoning
				if (msg.metadata) {
					const m = msg.metadata as Record<string, unknown>;
					const metaThinking =
						(typeof m.reasoning === "string" && m.reasoning) ||
						(typeof m.thinking === "string" && m.thinking) ||
						(typeof m.thought === "string" && m.thought) ||
						"";
					if (metaThinking) {
						pushDelta(metaThinking, "thinking");
						// don't return, also process content below
					}
				}
			}

			// Standard ChatGPT content: message.content.parts[0] as string or {text: string}
			if (msg) {
				const role = msg.author?.role ?? msg.role;
				if (role && role !== "assistant") {
					return;
				}

				const rawPart = msg.content?.parts?.[0];
				const content =
					typeof rawPart === "string"
						? rawPart
						: typeof rawPart === "object" &&
						  rawPart !== null &&
						  "text" in rawPart &&
						  typeof (rawPart as { text?: string }).text === "string"
						? (rawPart as { text: string }).text
						: undefined;
				if (typeof content === "string" && content) {
					// Delta detection via accumulatedContent slicing (ChatGPT sends full content each time)
					// But content may also contain think tags inline.
					const delta = content.slice(accumulatedContent.length);
					if (delta) {
						accumulatedContent = content;
						pushDelta(delta);
					} else if (content.length < accumulatedContent.length) {
						// Content was reset (new message) - treat as new
						accumulatedContent = content;
						pushDelta(content);
					}
					return;
				}
			}

			// Generic fallback: data.text / data.content / data.delta strange shapes
			if (typeof data.text === "string" && data.text) {
				pushDelta(data.text);
				return;
			}
			if (typeof data.content === "string" && data.content) {
				// If not already handled as thinking, treat as text but also check for think tags
				pushDelta(data.content);
				return;
			}
			// Direct string v without p (content channel)
			if (typeof data.v === "string" && (!pField || pStr.includes("content") || pStr.includes("choices"))) {
				pushDelta(data.v);
				return;
			}
			if (data.type === "text" && typeof data.content === "string") {
				pushDelta(data.content);
				return;
			}
		} catch {
			// ignore partial or non-JSON lines
		}
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				if (buffer.trim()) {
					processLine(buffer.trim());
				}
				break;
			}

			const chunk = decoder.decode(value, { stream: true });
			const combined = buffer + chunk;
			const parts = combined.split("\n");
			buffer = parts.pop() || "";

			for (const part of parts) {
				processLine(part.trim());
			}
		}
	} finally {
		reader.releaseLock();
	}

	// Flush any remaining tag-buffered content
	if (tagBuffer) {
		flushTagBuffer();
	}

	// Fallback: if thinking was embedded as <think> tags but we missed mode transitions due to full-content slicing,
	// also try to extract from final text (defensive).
	// We already handled via pushDelta tagging, but if text still contains tags, split them.
	if (!thinkingText && text.includes("<think")) {
		const extracted = extractThinkTags(text);
		if (extracted.thinking) {
			text = extracted.text;
			thinkingText = extracted.thinking;
		}
	}

	// Sanitize final output: remove \n, **, entity citations etc. per user request
	const cleanText = stripMarkdown(text);
	const cleanThinking = stripEntityTags(thinkingText).trim();

	return { text: cleanText, thinkingText: cleanThinking };
}

function extractThinkTags(raw: string): { text: string; thinking: string } {
	let thinking = "";
	const re = /<(?:think|thinking|thought|reasoning)\b[^<>]*>([\s\S]*?)<\/(?:think|thinking|thought|reasoning)>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(raw)) !== null) {
		thinking += (thinking ? "\n" : "") + (m[1]?.trim() ?? "");
	}
	const text = raw.replace(re, "").trim();
	return { text, thinking };
}
