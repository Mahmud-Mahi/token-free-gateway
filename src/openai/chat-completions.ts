import { evictProviderClient } from "../providers/registry.ts";
import type { WebProviderClient } from "../providers/types.ts";
import { ProviderApiError, SessionExpiredError } from "../providers/types.ts";
import { buildPromptFromMessages, parseToolResponse } from "../tool-calling/converter.ts";
import { makeChunk, sseDone, sseEvent, sseHeaders } from "./sse.ts";
import type {
	ChatCompletionRequest,
	ChatCompletionResponse,
	ToolCallDelta,
	ToolCallOutput,
} from "./types.ts";

let _routeTimeoutMs = 300_000;

export function setRouteTimeoutSec(sec: number): void {
	_routeTimeoutMs = sec * 1000;
}

function generateId(): string {
	return `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export async function handleChatCompletions(
	body: ChatCompletionRequest,
	client: WebProviderClient,
): Promise<Response> {
	if (!body.messages || body.messages.length === 0) {
		return jsonError("messages is required and must not be empty", 400);
	}

	if (!body.model) {
		return jsonError("model is required", 400);
	}

	const id = generateId();
	const model = body.model;
	const { prompt, hasTools } = buildPromptFromMessages(body.messages, body.tools, body.tool_choice);

	if (!prompt) {
		return jsonError("Could not construct prompt from messages", 400);
	}

	const handler = body.stream
		? handleStreaming(id, model, prompt, hasTools, body, client)
		: handleNonStreaming(id, model, prompt, hasTools, body, client);

	const timeout = new Promise<Response>((resolve) =>
		setTimeout(() => {
			console.error(`[chat-completions] Request timed out after ${_routeTimeoutMs / 1000}s`);
			resolve(jsonError("Gateway timeout: upstream provider did not respond in time", 504));
		}, _routeTimeoutMs),
	);

	return Promise.race([handler, timeout]);
}

async function handleNonStreaming(
	id: string,
	model: string,
	prompt: string,
	hasTools: boolean,
	body: ChatCompletionRequest,
	client: WebProviderClient,
): Promise<Response> {
	try {
		const stream = await client.sendMessage({ message: prompt, model });
		const result = await client.parseStream(stream);

		// Fallback: if parser put answer into thinkingText (e.g. missing </think>), ensure content is not empty/null
		let effectiveText = result.text;
		let effectiveThinking = result.thinkingText;
		if (!effectiveText && effectiveThinking) {
			// If text is empty but thinking exists, treat thinking as content to avoid null
			// Keep original thinking as reasoning as well for backward compat
			effectiveText = effectiveThinking;
			// keep thinking for reasoning duplicate is okay, but avoid empty content
		}
		const { content, toolCalls, finishReason } = hasTools
			? parseToolResponse(effectiveText, body.tools)
			: { content: effectiveText, toolCalls: undefined, finishReason: "stop" as const };

		const promptTokens = estimateTokens(prompt);
		const completionTokens = estimateTokens(effectiveText + (effectiveThinking || ""));

		const response: ChatCompletionResponse = {
			id,
			object: "chat.completion",
			created: Math.floor(Date.now() / 1000),
			model,
			system_fingerprint: `fp_${id.slice(-12)}`,
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content,
						...(toolCalls ? { tool_calls: toolCalls } : {}),
						...(effectiveThinking
							? {
									reasoning_content: effectiveThinking,
									reasoning: effectiveThinking,
									thinking: effectiveThinking,
								}
							: {}),
					},
					finish_reason: finishReason,
				},
			],
			usage: {
				prompt_tokens: promptTokens,
				completion_tokens: completionTokens,
				total_tokens: promptTokens + completionTokens,
			},
		};

		return Response.json(response);
	} catch (err) {
		return providerErrorResponse(err, "non-streaming");
	}
}

// ---- Streaming helpers ----

type SseWriter = {
	writeChunk(id: string, model: string, choices: Parameters<typeof makeChunk>[2]): void;
	done(): void;
	error(message: string): void;
	close(): void;
};

function createSseWriter(controller: ReadableStreamDefaultController<Uint8Array>): SseWriter {
	const encoder = new TextEncoder();
	const emit = (data: string) => controller.enqueue(encoder.encode(data));
	return {
		writeChunk(id, model, choices) {
			emit(sseEvent(JSON.stringify(makeChunk(id, model, choices))));
		},
		done() {
			emit(sseDone());
		},
		error(message: string) {
			emit(sseEvent(JSON.stringify({ error: { message, type: "server_error" } })));
		},
		close() {
			controller.close();
		},
	};
}

function emitToolCallDeltas(w: SseWriter, id: string, model: string, toolCalls: ToolCallOutput[]) {
	for (let i = 0; i < toolCalls.length; i++) {
		const tc = toolCalls[i];
		if (!tc) continue;
		const tcStart: ToolCallDelta = {
			index: i,
			id: tc.id,
			type: "function",
			function: { name: tc.function.name, arguments: "" },
		};
		w.writeChunk(id, model, [{ index: 0, delta: { tool_calls: [tcStart] }, finish_reason: null }]);
		const tcArgs: ToolCallDelta = {
			index: i,
			function: { arguments: tc.function.arguments },
		};
		w.writeChunk(id, model, [{ index: 0, delta: { tool_calls: [tcArgs] }, finish_reason: null }]);
	}
}

async function handleStreaming(
	id: string,
	model: string,
	prompt: string,
	hasTools: boolean,
	body: ChatCompletionRequest,
	client: WebProviderClient,
): Promise<Response> {
	// Await sendMessage BEFORE creating the SSE stream so that pre-stream
	// errors (auth, rate-limit, model-not-available) return a proper HTTP
	// error status instead of being buried inside an SSE event that the
	// client cannot parse as a ChatCompletionChunk.
	let providerStream: ReadableStream<Uint8Array>;
	try {
		providerStream = await client.sendMessage({ message: prompt, model });
	} catch (err) {
		return providerErrorResponse(err, "streaming (pre-stream)");
	}

	const readable = new ReadableStream({
		async start(controller) {
			const w = createSseWriter(controller);
			try {
				w.writeChunk(id, model, [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]);

				if (!hasTools) {
					await streamWithoutTools(w, id, model, providerStream, client);
				} else {
					await streamWithTools(w, id, model, providerStream, body, client);
				}

				w.done();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.error(`[chat-completions] Stream error (mid-stream): ${message}`);
				w.error(message);
				w.done();
			}
			w.close();
		},
	});

	return new Response(readable, { headers: sseHeaders() });
}

async function streamWithoutTools(
	w: SseWriter,
	id: string,
	model: string,
	providerStream: ReadableStream<Uint8Array>,
	client: WebProviderClient,
) {
	// For think/reasoning models we need buffered parsing so reasoning_content
	// can be emitted BEFORE content (like deepseek-reasoner). For regular models
	// keep live incremental streaming for better UX.
	const isThinkModel = model.toLowerCase().includes("think") || model.toLowerCase().includes("reasoner");
	if (isThinkModel) {
		const result = await client.parseStream(providerStream);
		let effectiveText = result.text;
		let effectiveThinking = result.thinkingText;
		if (!effectiveText && effectiveThinking) {
			effectiveText = effectiveThinking;
		}
		if (effectiveThinking) {
			w.writeChunk(id, model, [
				{ index: 0, delta: { reasoning_content: effectiveThinking, reasoning: effectiveThinking, thinking: effectiveThinking }, finish_reason: null },
			]);
		}
		if (effectiveText) {
			w.writeChunk(id, model, [{ index: 0, delta: { content: effectiveText }, finish_reason: null }]);
		} else {
			w.writeChunk(id, model, [{ index: 0, delta: { content: "" }, finish_reason: null }]);
		}
		w.writeChunk(id, model, [{ index: 0, delta: {}, finish_reason: "stop" }]);
		return;
	}
	// Live incremental for non-reasoning models
	const result = await client.parseStream(providerStream, (delta) => {
		w.writeChunk(id, model, [{ index: 0, delta: { content: delta }, finish_reason: null }]);
	});
	let liveEffectiveText = result.text;
	let liveEffectiveThinking = result.thinkingText;
	if (!liveEffectiveText && liveEffectiveThinking) {
		liveEffectiveText = liveEffectiveThinking;
		w.writeChunk(id, model, [{ index: 0, delta: { content: liveEffectiveText }, finish_reason: null }]);
	}
	// Fallback: if parser buffered thinking (e.g. deepseek style via tag) even for non-think label,
	// emit it if present (rare but safe)
	if (liveEffectiveThinking) {
		// If we already emitted content via delta, reasoning should have been before content for correctness,
		// but for live path it's okay to emit after as fallback
		w.writeChunk(id, model, [
			{ index: 0, delta: { reasoning_content: liveEffectiveThinking, reasoning: liveEffectiveThinking }, finish_reason: null },
		]);
	}
	w.writeChunk(id, model, [{ index: 0, delta: {}, finish_reason: "stop" }]);
}

async function streamWithTools(
	w: SseWriter,
	id: string,
	model: string,
	providerStream: ReadableStream<Uint8Array>,
	body: ChatCompletionRequest,
	client: WebProviderClient,
) {
	const result = await client.parseStream(providerStream);
	let effectiveText = result.text;
	let effectiveThinking = result.thinkingText;
	if (!effectiveText && effectiveThinking) {
		effectiveText = effectiveThinking;
	}
	const { content, toolCalls, finishReason } = parseToolResponse(effectiveText, body.tools);

	// If thinking exists and not a tool call, emit reasoning first
	if (effectiveThinking && finishReason !== "tool_calls") {
		w.writeChunk(id, model, [
			{ index: 0, delta: { reasoning_content: effectiveThinking, reasoning: effectiveThinking }, finish_reason: null },
		]);
	}

	if (finishReason === "tool_calls" && toolCalls) {
		emitToolCallDeltas(w, id, model, toolCalls);
		w.writeChunk(id, model, [{ index: 0, delta: {}, finish_reason: "tool_calls" }]);
	} else {
		if (content) {
			w.writeChunk(id, model, [{ index: 0, delta: { content }, finish_reason: null }]);
		} else if (!effectiveThinking) {
			w.writeChunk(id, model, [{ index: 0, delta: { content: "" }, finish_reason: null }]);
		} else {
			// fallback already has effectiveText = thinking, so content will be set
			w.writeChunk(id, model, [{ index: 0, delta: { content: effectiveText }, finish_reason: null }]);
		}
		w.writeChunk(id, model, [{ index: 0, delta: {}, finish_reason: "stop" }]);
	}
}

function jsonError(message: string, status: number): Response {
	return Response.json({ error: { message, type: "invalid_request_error" } }, { status });
}

/**
 * Map a caught provider error to an HTTP Response.
 * - SessionExpiredError → 401, evict cached client
 * - ProviderApiError    → mirror the provider's 4xx (don't wrap in 502)
 * - anything else       → 502
 */
function providerErrorResponse(err: unknown, context: string): Response {
	if (err instanceof SessionExpiredError) {
		evictProviderClient(err.providerId);
		console.error(
			`[chat-completions] ${context}: session expired for "${err.providerId}". Run 'token-free-gateway webauth'.`,
		);
		return jsonError(err.message, 401);
	}
	if (err instanceof ProviderApiError) {
		const message = err.message;
		console.error(`[chat-completions] ${context}: provider error ${err.httpStatus}: ${message}`);
		return jsonError(message, err.httpStatus);
	}
	const message = err instanceof Error ? err.message : String(err);
	console.error(`[chat-completions] ${context}: ${message}`);
	return jsonError(message, 502);
}
