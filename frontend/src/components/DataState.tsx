import { AlertTriangle, Inbox, Link2Off, RefreshCw } from "lucide-react";
import { ApiError } from "../lib/api";
import { Button, Spinner } from "./ui";

/**
 * Loading, error and empty, in one place.
 *
 * Every async view in the app routes through this, which is how the "no
 * unhandled loading, error or empty state anywhere" requirement is actually
 * enforced rather than remembered per screen.
 *
 * A 503 is treated as its own case rather than as a generic error, because in
 * this system it means "the chain, IPFS or the model service is not configured",
 * which is a setup step and not a fault.
 */

export function Loading({ label = "Loading", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" className="py-2">
      <span className="sr-only">{label}</span>
      <div className="mb-4 flex items-center gap-2 font-ui text-xs text-muted">
        <Spinner size={14} />
        <span className="animate-pulse">{label}…</span>
      </div>
      <div className="space-y-2.5">
        {Array.from({ length: rows }).map((_, index) => (
          <div key={index} className="skeleton h-12" style={{ opacity: 1 - index * 0.16 }} />
        ))}
      </div>
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  context,
}: {
  error: unknown;
  onRetry?: () => void;
  context?: string;
}) {
  const unavailable = error instanceof ApiError && error.isUnavailable;
  const forbidden = error instanceof ApiError && error.isForbidden;
  const message =
    error instanceof Error ? error.message : "Something went wrong while loading this view.";

  const Icon = unavailable ? Link2Off : AlertTriangle;
  const tone = unavailable ? "border-warning-soft" : "border-danger-soft";
  const iconTone = unavailable ? "text-warning" : "text-danger";

  return (
    <div role="alert" className={`rounded-card border ${tone} bg-surface-2 p-5`}>
      <div className="flex gap-3">
        <Icon size={20} className={`mt-0.5 shrink-0 ${iconTone}`} />
        <div className="min-w-0 flex-1">
          <p className="font-ui text-sm font-semibold text-text">
            {unavailable
              ? "A required service is not configured"
              : forbidden
                ? "Not permitted"
                : context
                  ? `Could not load ${context}`
                  : "Could not load this view"}
          </p>
          <p className="mt-1.5 font-ui text-xs leading-relaxed text-muted">{message}</p>

          {unavailable && (
            <p className="mt-2 font-ui text-2xs leading-relaxed text-faint">
              Check the health endpoint at <code className="font-mono">/api/health</code> to see which
              subsystem is missing, then follow docs/deployment.md for that step.
            </p>
          )}

          {onRetry && (
            <Button
              variant="secondary"
              size="sm"
              className="mt-3.5"
              icon={<RefreshCw size={13} />}
              onClick={onRetry}
            >
              Try again
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-border px-6 py-12 text-center">
      <div className="mb-3.5 grid h-11 w-11 place-items-center rounded-full bg-surface-2 text-faint">
        {icon ?? <Inbox size={19} />}
      </div>
      <p className="font-display text-base text-text">{title}</p>
      {description && (
        <p className="mt-1.5 max-w-sm font-ui text-xs leading-relaxed text-muted">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * One component that resolves a query into exactly one of the four states.
 * `isEmpty` is a predicate rather than a boolean so a caller can decide what
 * empty means for its own shape.
 */
export function AsyncView<T>({
  state,
  onRetry,
  context,
  isEmpty,
  empty,
  loadingRows,
  children,
}: {
  state: { data: T | null; loading: boolean; error: unknown };
  onRetry?: () => void;
  context?: string;
  isEmpty?: (data: T) => boolean;
  empty?: React.ReactNode;
  loadingRows?: number;
  children: (data: T) => React.ReactNode;
}) {
  if (state.loading && state.data === null) {
    return <Loading label={context ? `Loading ${context}` : "Loading"} rows={loadingRows} />;
  }
  if (state.error && state.data === null) {
    return <ErrorState error={state.error} onRetry={onRetry} context={context} />;
  }
  if (state.data === null) {
    return <EmptyState title="Nothing to show" />;
  }
  if (isEmpty?.(state.data)) {
    return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;
  }
  return <>{children(state.data)}</>;
}
