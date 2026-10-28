import Anthropic from "@anthropic-ai/sdk";
import { SessionBudget, type BudgetSnapshot } from "./budget.js";
import { ByokError, redact } from "./errors.js";
import { KeyStore, type KeyStorage } from "./key.js";
import { PRICES, costOfUsage, estimatePromptTokens, priceFor, worstCaseCost, type ModelPrice, type PriceTable } from "./pricing.js";

/** Requests only ever go here. Set explicitly so no environment variable can redirect them. */
export const ANTHROPIC_API_ORIGIN = "https://api.anthropic.com";

export type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;

export interface ByokClaudeConfig {
  /** Models visitors' keys may be used with. The first is the default. Each needs a known price. */
  models: readonly [string, ...string[]];
  /** The most output tokens any one request may ask for, thinking included. */
  maxTokens: number;
  /** The most this page will spend of a visitor's credits before it stops sending requests. */
  sessionBudgetUsd: number;
  /** A system prompt sent with every request. */
  system?: string;
  /** Effort level sent with every request. Leave unset for the model's default. */
  effort?: Effort;
  /** Let visitors choose to keep their key in this browser. Off by default. */
  allowRememberKey?: boolean;
  /** Where a remembered key is kept. Defaults to `localStorage`. */
  storage?: KeyStorage | null;
  /** The storage entry name for a remembered key. */
  storageKey?: string;
  /** Extra or replacement prices, in USD per million tokens, merged over the built-in table. */
  prices?: Readonly<Record<string, ModelPrice>>;
}

export interface AskOptions {
  /** A single question. Use `messages` instead for a conversation. */
  prompt?: string;
  messages?: Anthropic.MessageParam[];
  /** One of the site's allowed models. Defaults to the first. */
  model?: string;
  /** Lower the output cap for this request. It can't go above the site's cap. */
  maxTokens?: number;
  signal?: AbortSignal;
  /** Called as the answer streams in. */
  onText?: (delta: string, textSoFar: string) => void;
}

export interface AskResult {
  text: string;
  model: string;
  stopReason: Anthropic.StopReason | null;
  /** A sentence for the visitor when the answer is incomplete or was declined. */
  notice: string | null;
  costUsd: number;
  usage: Anthropic.Usage;
  message: Anthropic.Message;
}

export interface ByokState {
  hasKey: boolean;
  keyRemembered: boolean;
  canRememberKey: boolean;
  busy: boolean;
  models: readonly string[];
  maxTokens: number;
  budget: BudgetSnapshot;
}

type Listener = () => void;

export class ByokClaude {
  readonly models: readonly string[];
  readonly maxTokens: number;
  readonly #config: ByokClaudeConfig;
  readonly #prices: PriceTable;
  readonly #keys: KeyStore;
  readonly #budget: SessionBudget;
  readonly #listeners = new Set<Listener>();
  readonly #inFlight = new Set<AbortController>();
  #client: { key: string; client: Anthropic } | null = null;
  #state: ByokState;

  constructor(config: ByokClaudeConfig) {
    if (config.models.length === 0) {
      throw new ByokError("bad_config", "List at least one allowed model.");
    }
    if (!Number.isInteger(config.maxTokens) || config.maxTokens < 1) {
      throw new ByokError("bad_config", "maxTokens must be a whole number of at least 1.");
    }
    this.#config = config;
    this.#prices = { ...PRICES, ...config.prices };
    // Fail at start-up, not on a visitor's first question, if a model has no price.
    for (const model of config.models) priceFor(model, this.#prices);
    this.models = [...config.models];
    this.maxTokens = config.maxTokens;
    this.#budget = new SessionBudget(config.sessionBudgetUsd);
    this.#keys = new KeyStore({
      allowRemember: config.allowRememberKey ?? false,
      ...(config.storage !== undefined && { storage: config.storage }),
      ...(config.storageKey !== undefined && { storageKey: config.storageKey }),
    });
    this.#state = this.#buildState();
  }

  /** Store the visitor's key. `remember` saves it in this browser if the site allows it. */
  setKey = (key: string, options: { remember?: boolean } = {}): void => {
    this.#keys.set(key, options);
    this.#client = null;
    this.#emit();
  };

  /** Forget the key everywhere it's held, and stop any request still running. */
  forgetKey = (): void => {
    for (const controller of this.#inFlight) controller.abort();
    this.#keys.forget();
    this.#client = null;
    this.#emit();
  };

  getState = (): ByokState => this.#state;

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Ask Claude, paying with the visitor's key, within the site's limits. */
  ask = async (options: AskOptions): Promise<AskResult> => {
    const key = this.#keys.get();
    if (key === null) {
      throw new ByokError("no_key", "Add your Anthropic API key to use this feature.");
    }
    const model = options.model ?? this.models[0] ?? "";
    if (!this.models.includes(model)) {
      throw new ByokError(
        "model_not_allowed",
        `This site doesn't allow the model "${model}". Allowed: ${this.models.join(", ")}.`,
      );
    }
    const maxTokens = Math.min(options.maxTokens ?? this.maxTokens, this.maxTokens);
    if (!Number.isInteger(maxTokens) || maxTokens < 1) {
      throw new ByokError("invalid_request", "maxTokens must be a whole number of at least 1.");
    }
    const messages = options.messages ?? (options.prompt?.trim() ? [{ role: "user" as const, content: options.prompt }] : null);
    if (!messages || messages.length === 0) {
      throw new ByokError("invalid_request", "Ask a question first.");
    }

    const { system, effort } = this.#config;
    const promptTokens = estimatePromptTokens(system === undefined ? { messages } : { system, messages });
    const reservation = this.#budget.reserve(worstCaseCost(model, promptTokens, maxTokens, this.#prices));

    const controller = new AbortController();
    const onAbort = () => {
      controller.abort();
    };
    options.signal?.addEventListener("abort", onAbort);
    if (options.signal?.aborted) controller.abort();
    this.#inFlight.add(controller);
    this.#emit();

    // Set once Anthropic accepts the request (a 2xx response). From then on it may be billed.
    const progress = { accepted: false };
    try {
      const stream = this.#clientFor(key).messages.stream(
        {
          model,
          max_tokens: maxTokens,
          messages,
          ...(system !== undefined && { system }),
          ...(effort !== undefined && { output_config: { effort } }),
        },
        { signal: controller.signal },
      );
      stream.on("connect", () => {
        progress.accepted = true;
      });
      const { onText } = options;
      if (onText) stream.on("text", onText);
      const message = await stream.finalMessage();

      const costUsd = costOfUsage(model, message.usage, this.#prices);
      this.#budget.settle(reservation, costUsd);
      return {
        text: message.content.flatMap((block: Anthropic.ContentBlock) => (block.type === "text" ? [block.text] : [])).join(""),
        model,
        stopReason: message.stop_reason,
        notice: noticeFor(message, maxTokens),
        costUsd,
        usage: message.usage,
        message,
      };
    } catch (error) {
      // Once Anthropic has accepted the request, part of it may be billed but the
      // final usage never arrived, so count the most it could have cost.
      if (progress.accepted) this.#budget.settle(reservation, reservation.amountUsd);
      else this.#budget.release(reservation);
      throw toByokError(error, key);
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      this.#inFlight.delete(controller);
      this.#emit();
    }
  };

  #clientFor(key: string): Anthropic {
    if (this.#client?.key !== key) {
      this.#client = {
        key,
        client: new Anthropic({
          apiKey: key,
          baseURL: ANTHROPIC_API_ORIGIN,
          // The SDK's documented opt-in for browser use. It also sends the
          // anthropic-dangerous-direct-browser-access header the API needs for CORS.
          dangerouslyAllowBrowser: true,
          logLevel: "off",
        }),
      };
    }
    return this.#client.client;
  }

  #buildState(): ByokState {
    return {
      hasKey: this.#keys.hasKey(),
      keyRemembered: this.#keys.isRemembered(),
      canRememberKey: this.#keys.allowRemember,
      busy: this.#inFlight.size > 0,
      models: this.models,
      maxTokens: this.maxTokens,
      budget: this.#budget.snapshot(),
    };
  }

  #emit(): void {
    this.#state = this.#buildState();
    for (const listener of this.#listeners) listener();
  }
}

export function createByokClaude(config: ByokClaudeConfig): ByokClaude {
  return new ByokClaude(config);
}

function noticeFor(message: Anthropic.Message, maxTokens: number): string | null {
  switch (message.stop_reason) {
    case "refusal":
      return "Claude declined to answer this request.";
    case "max_tokens":
      return `The answer reached this site's limit of ${String(maxTokens)} tokens and was cut off.`;
    default:
      return null;
  }
}

function toByokError(error: unknown, key: string): ByokError {
  if (error instanceof ByokError) return error;
  const detail = redact(error instanceof Error ? error.message : String(error), key);
  const make = (code: ConstructorParameters<typeof ByokError>[0], message: string) =>
    new ByokError(code, redact(message, key), { cause: error });

  if (error instanceof Anthropic.APIUserAbortError) {
    return make("aborted", "The request was stopped.");
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return make(
      "network",
      "Couldn't reach api.anthropic.com. Check your connection, and that this page's Content-Security-Policy allows it.",
    );
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return make("auth_failed", "Anthropic didn't accept this API key. Check it was copied in full and hasn't been deleted or disabled.");
  }
  if (error instanceof Anthropic.RateLimitError) {
    return make("rate_limited", "Your Anthropic account hit a rate limit. Wait a minute and try again.");
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return make("permission_denied", `Anthropic refused this request for your key: ${detail}`);
  }
  if (error instanceof Anthropic.APIError) {
    if (error.status === 402 || error.type === "billing_error") {
      return make(
        "no_credits",
        `Anthropic couldn't bill this key. Your account may be out of API credits or at its spend limit. Check Billing and Limits at platform.claude.com. (${detail})`,
      );
    }
    if ((error.status !== undefined && error.status >= 500) || error.type === "overloaded_error") {
      return make("overloaded", "Anthropic's API is busy or having trouble. Try again shortly.");
    }
    return make("request_rejected", `Anthropic rejected the request: ${detail}`);
  }
  return make("request_rejected", `Something went wrong: ${detail}`);
}
