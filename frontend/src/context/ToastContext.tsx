import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";

type Tone = "success" | "error" | "warning" | "info";

interface Toast {
  id: number;
  tone: Tone;
  title: string;
  body?: string;
  /** An Etherscan link, when the toast is reporting an anchored transaction. */
  link?: { href: string; label: string };
}

interface ToastValue {
  push: (toast: Omit<Toast, "id">) => void;
  success: (title: string, body?: string, link?: Toast["link"]) => void;
  error: (title: string, body?: string) => void;
  warning: (title: string, body?: string) => void;
  info: (title: string, body?: string) => void;
}

const ToastContext = createContext<ToastValue | null>(null);

const TONE_STYLE: Record<Tone, { icon: typeof Info; ring: string; iconClass: string }> = {
  success: { icon: CheckCircle2, ring: "border-success-soft", iconClass: "text-success" },
  error: { icon: XCircle, ring: "border-danger-soft", iconClass: "text-danger" },
  warning: { icon: AlertTriangle, ring: "border-warning-soft", iconClass: "text-warning" },
  info: { icon: Info, ring: "border-info-soft", iconClass: "text-info" },
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (toast: Omit<Toast, "id">) => {
      const id = nextId.current++;
      setToasts((current) => [...current, { ...toast, id }].slice(-4));
      // Errors stay longer: they usually carry something to read and act on.
      const ttl = toast.tone === "error" ? 9000 : 5000;
      window.setTimeout(() => dismiss(id), ttl);
    },
    [dismiss]
  );

  const value = useMemo<ToastValue>(
    () => ({
      push,
      success: (title, body, link) => push({ tone: "success", title, body, link }),
      error: (title, body) => push({ tone: "error", title, body }),
      warning: (title, body) => push({ tone: "warning", title, body }),
      info: (title, body) => push({ tone: "info", title, body }),
    }),
    [push]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}

      {/* aria-live so a screen reader announces a result the sighted user sees. */}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 p-4 sm:items-end sm:p-6"
      >
        {toasts.map((toast) => {
          const style = TONE_STYLE[toast.tone];
          const Icon = style.icon;
          return (
            <div
              key={toast.id}
              role={toast.tone === "error" ? "alert" : "status"}
              className={`pointer-events-auto flex w-full max-w-sm gap-3 rounded-card border ${style.ring} bg-bg-elevated p-3.5 shadow-lift animate-menu-in`}
            >
              <Icon size={18} className={`mt-0.5 shrink-0 ${style.iconClass}`} />
              <div className="min-w-0 flex-1">
                <p className="font-ui text-sm font-semibold leading-snug text-text">{toast.title}</p>
                {toast.body && (
                  <p className="mt-1 font-ui text-xs leading-relaxed text-muted">{toast.body}</p>
                )}
                {toast.link && (
                  <a
                    href={toast.link.href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mt-2 inline-block font-ui text-xs font-semibold text-primary underline underline-offset-2 decoration-dotted hover:decoration-solid"
                  >
                    {toast.link.label}
                  </a>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                aria-label="Dismiss"
                className="shrink-0 rounded-md p-1 text-faint transition hover:bg-surface-2 hover:text-text"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside ToastProvider.");
  return context;
}
