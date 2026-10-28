import Anthropic from "@anthropic-ai/sdk";

/** One answer being streamed back from the model. */
export interface ForwardedStream {
  events: AsyncIterable<Anthropic.MessageStreamEvent>;
  finalMessage(): Promise<Anthropic.Message>;
}

/** Where the stand-in sends an approved request. */
export interface Forwarder {
  readonly simulated: boolean;
  open(params: Anthropic.MessageStreamParams, signal: AbortSignal): ForwardedStream;
}

/**
 * Sends requests to the real Claude API with the key of whoever runs the demo.
 * In the proposal, Anthropic would bill the visitor's own account instead.
 */
export function anthropicForwarder(apiKey: string): Forwarder {
  const client = new Anthropic({ apiKey, logLevel: "off" });
  return {
    simulated: false,
    open(params, signal) {
      const stream = client.messages.stream(params, { signal });
      return { events: stream, finalMessage: () => stream.finalMessage() };
    },
  };
}

function textOf(params: Anthropic.MessageStreamParams): string {
  const last = params.messages.at(-1);
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  return last.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ");
}

function usage(input: number, output: number): Anthropic.Usage {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: null,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: "standard",
    speed: null,
  };
}

/**
 * Canned answers with made-up token counts, so the flow can be tried without
 * any API key. Nothing is sent anywhere.
 */
export function simulatedForwarder(): Forwarder {
  return {
    simulated: true,
    open(params) {
      const question = textOf(params).slice(0, 200);
      const words = `Simulated answer. The stand-in has no API key, so Claude didn't write this. You asked: "${question}"`.split(" ");
      const inputTokens = Math.ceil(JSON.stringify(params.messages).length / 4);
      const outputTokens = Math.min(params.max_tokens, Math.ceil(words.length * 1.3));
      const message: Anthropic.Message = {
        id: "msg_simulated",
        type: "message",
        role: "assistant",
        model: params.model,
        content: [{ type: "text", text: words.join(" "), citations: null }],
        stop_reason: "end_turn",
        stop_sequence: null,
        stop_details: null,
        container: null,
        diagnostics: null,
        usage: usage(inputTokens, outputTokens),
      };
      async function* events(): AsyncGenerator<Anthropic.MessageStreamEvent> {
        yield { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: usage(inputTokens, 1) } };
        yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } };
        for (const [i, word] of words.entries()) {
          await new Promise((resolve) => setTimeout(resolve, 15));
          yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: i === 0 ? word : ` ${word}` } };
        }
        yield { type: "content_block_stop", index: 0 };
        yield {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null, container: null },
          usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, output_tokens_details: null },
        };
        yield { type: "message_stop" };
      }
      return { events: events(), finalMessage: () => Promise.resolve(message) };
    },
  };
}
