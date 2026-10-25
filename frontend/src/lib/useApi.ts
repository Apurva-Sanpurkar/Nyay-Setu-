import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

export interface QueryState<T> {
  data: T | null;
  loading: boolean;
  error: unknown;
}

/**
 * A GET with abort-on-unmount and a manual refetch.
 *
 * Deliberately small. Half the screens in this app poll a compliance score or a
 * delivery countdown, and reaching for a data library for that would add more
 * surface than it removes. `deps` behaves like a useEffect dependency list.
 */
export function useQuery<T>(
  path: string | null,
  deps: unknown[] = [],
  options: { pollMs?: number; enabled?: boolean } = {}
): QueryState<T> & { refetch: () => void; setData: (data: T) => void } {
  const { pollMs, enabled = true } = options;

  const [state, setState] = useState<QueryState<T>>({ data: null, loading: Boolean(path && enabled), error: null });
  const [nonce, setNonce] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!path || !enabled) {
      setState({ data: null, loading: false, error: null });
      return;
    }

    const controller = new AbortController();
    let timer: number | undefined;

    const run = async (isRefresh: boolean) => {
      if (!isRefresh) setState((current) => ({ ...current, loading: true }));
      try {
        const data = await api.get<T>(path, controller.signal);
        if (!mounted.current) return;
        setState({ data, loading: false, error: null });
      } catch (error) {
        // An abort is the component going away, not a failure to report.
        if (controller.signal.aborted) return;
        if (!mounted.current) return;
        // On a poll failure keep the last good data on screen and surface the
        // error only if there is nothing to show.
        setState((current) => ({ data: current.data, loading: false, error }));
      }
    };

    void run(false);

    if (pollMs && pollMs > 0) {
      timer = window.setInterval(() => void run(true), pollMs);
    }

    return () => {
      controller.abort();
      if (timer) window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, enabled, pollMs, nonce, ...deps]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback((data: T) => setState({ data, loading: false, error: null }), []);

  return { ...state, refetch, setData };
}

/**
 * A mutation with its own pending and error state, so a form can disable its
 * submit button and print a real message without any component-level plumbing.
 *
 * The error is normalised to an Error rather than left as unknown. That is not
 * cosmetic: `{state.error && <p>…</p>}` in JSX types as unknown when the left
 * operand is unknown, which React will not render, so every call site would
 * otherwise need a cast.
 */
export function useMutation<TArgs, TResult>(
  action: (args: TArgs) => Promise<TResult>
): {
  run: (args: TArgs) => Promise<TResult | null>;
  pending: boolean;
  error: Error | null;
  reset: () => void;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const run = useCallback(
    async (args: TArgs) => {
      setPending(true);
      setError(null);
      try {
        return await action(args);
      } catch (caught) {
        setError(caught instanceof Error ? caught : new Error(String(caught)));
        return null;
      } finally {
        setPending(false);
      }
    },
    [action]
  );

  return { run, pending, error, reset: () => setError(null) };
}

/** Ticks once a second, for the countdowns the summons and bail views need. */
export function useTicker(intervalMs = 1000): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return tick;
}
