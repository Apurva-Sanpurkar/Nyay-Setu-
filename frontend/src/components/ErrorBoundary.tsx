import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

/**
 * The last line of defence for a screen that throws while rendering.
 *
 * Without one, React unmounts the whole tree and the officer is left with a
 * blank page and no idea whether the evidence they just sent was registered.
 * This keeps the shell, says what failed, and offers a reload. Nothing about a
 * registration is lost by reloading: a registration is idempotent by its key,
 * and an interrupted recording is still in the on-device journal.
 *
 * `resetKey` (the route) clears the error on navigation, so one broken screen
 * does not stay broken after the officer moves on.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Screen failed to render", error, info.componentStack);
  }

  componentDidUpdate(previous: { resetKey?: string }) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="mx-auto my-10 max-w-xl rounded-card border border-danger-soft bg-surface-2 p-6">
        <div className="flex gap-3">
          <AlertTriangle size={20} className="mt-0.5 shrink-0 text-danger" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-ui text-sm font-semibold text-text">This screen could not be shown</p>
            <p className="mt-1 break-words font-ui text-xs leading-relaxed text-muted">{this.state.error.message}</p>
            <p className="mt-2 font-ui text-2xs leading-relaxed text-faint">
              Anything already registered is safe. Reloading resends nothing that was already accepted.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 inline-flex h-9 items-center gap-2 rounded-full border border-border px-4 font-ui text-xs font-semibold text-text hover:border-primary"
            >
              <RefreshCw size={13} aria-hidden /> Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
