import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AskOptions, AskResult, ByokClaude, ByokState } from "./client.js";
import { ByokError } from "./errors.js";

export interface UseByokClaude extends ByokState {
  /** The answer so far, updated as it streams in. */
  answer: string;
  /** The last completed result, with its cost and any notice. */
  result: AskResult | null;
  error: ByokError | null;
  ask: (prompt: string, options?: Omit<AskOptions, "prompt" | "signal" | "onText">) => Promise<AskResult | null>;
  /** Stop the answer that's streaming in. */
  stop: () => void;
  setKey: ByokClaude["setKey"];
  forgetKey: ByokClaude["forgetKey"];
}

/**
 * React bindings for one ByokClaude instance. Create the instance once, outside
 * your components, and pass it in.
 */
export function useByokClaude(claude: ByokClaude): UseByokClaude {
  const state = useSyncExternalStore(claude.subscribe, claude.getState, claude.getState);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<AskResult | null>(null);
  const [error, setError] = useState<ByokError | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  const ask = useCallback<UseByokClaude["ask"]>(
    async (prompt, options = {}) => {
      controller.current?.abort();
      const current = new AbortController();
      controller.current = current;
      setAnswer("");
      setResult(null);
      setError(null);
      try {
        const done = await claude.ask({
          ...options,
          prompt,
          signal: current.signal,
          onText: (_delta, soFar) => {
            setAnswer(soFar);
          },
        });
        setAnswer(done.text);
        setResult(done);
        return done;
      } catch (caught) {
        setError(caught instanceof ByokError ? caught : new ByokError("request_rejected", "Something went wrong."));
        return null;
      } finally {
        if (controller.current === current) controller.current = null;
      }
    },
    [claude],
  );

  const stop = useCallback(() => {
    controller.current?.abort();
  }, []);

  return { ...state, answer, result, error, ask, stop, setKey: claude.setKey, forgetKey: claude.forgetKey };
}
