import { forwardRef, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, X } from "lucide-react";

/* ========================================================== Button ======= */

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "lg";

/**
 * `primary` fills with --primary-fill, not --primary.
 *
 * The brand green is #009245, and white on it is 4.04:1, just under AA. The
 * fill token is a deepened green that clears it at 5.06:1, while --primary
 * stays the lifted green that is readable as text on a dark surface. Same
 * brand, two jobs, both measured.
 */
const VARIANT: Record<Variant, string> = {
  primary:
    "btn-sheen bg-primary-fill text-on-primary hover:-translate-y-0.5 shadow-glow hover:shadow-glow-strong",
  secondary:
    "bg-surface-2 text-text border border-border hover:border-primary-ring hover:bg-surface hover:-translate-y-0.5",
  outline: "border border-primary text-primary hover:bg-primary-soft hover:-translate-y-0.5",
  ghost: "text-muted hover:bg-surface-2 hover:text-text",
  danger: "bg-danger text-white hover:brightness-110 hover:-translate-y-0.5",
};

const SIZE: Record<Size, string> = {
  sm: "h-8 px-3 text-xs gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  lg: "h-12 px-6 text-sm gap-2",
};

/**
 * Shared between Button and LinkButton, so a link that looks like a button is
 * not a second, drifting copy of the same styles.
 */
function buttonClass(variant: Variant, size: Size, full?: boolean, extra = ""): string {
  return `inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-full font-ui font-semibold uppercase
    tracking-wide transition-all duration-200 ease-smooth
    active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45
    ${VARIANT[variant]} ${SIZE[size]} ${full ? "w-full" : ""} ${extra}`;
}

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: React.ReactNode;
  iconRight?: React.ReactNode;
  full?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading, icon, iconRight, full, className = "", children, disabled, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      // A loading button must not be clickable twice: every action here costs gas.
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClass(variant, size, full, className)}
      {...rest}
    >
      {loading ? <Loader2 size={size === "sm" ? 13 : 15} className="animate-spin-slow" /> : icon}
      {children}
      {!loading && iconRight}
    </button>
  );
});

/**
 * A router link that looks like a button.
 *
 * This exists because `<Link><Button/></Link>` nests a button inside an anchor,
 * which is invalid HTML and gives assistive technology two conflicting roles for
 * one control. Anything that navigates is a link; anything that acts is a button.
 */
export function LinkButton({
  to,
  variant = "primary",
  size = "md",
  full,
  icon,
  iconRight,
  className = "",
  children,
}: {
  to: string;
  variant?: Variant;
  size?: Size;
  full?: boolean;
  icon?: React.ReactNode;
  iconRight?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link to={to} className={buttonClass(variant, size, full, className)}>
      {icon}
      {children}
      {iconRight}
    </Link>
  );
}

/* ============================================================ Card ======= */

export function Card({
  title,
  subtitle,
  actions,
  footer,
  className = "",
  bodyClassName = "",
  children,
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`panel overflow-hidden ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            {title && <h2 className="font-display text-lg leading-tight text-text">{title}</h2>}
            {subtitle && <p className="mt-1 font-ui text-xs leading-relaxed text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={`px-5 py-4 ${bodyClassName}`}>{children}</div>
      {footer && <footer className="border-t border-border bg-surface-2 px-5 py-3">{footer}</footer>}
    </section>
  );
}

/* ====================================================== PageHeader ======= */

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && (
          <p className="mb-1.5 font-jakarta text-2xs font-bold uppercase tracking-[0.14em] text-primary">
            {eyebrow}
          </p>
        )}
        <h1 className="font-display text-2xl leading-tight text-text sm:text-3xl">{title}</h1>
        {description && (
          <p className="mt-2 max-w-2xl font-ui text-sm leading-relaxed text-muted">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/* =========================================================== Stat ======== */

export function Stat({
  label,
  value,
  hint,
  tone = "default",
  icon,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: "default" | "success" | "warning" | "danger" | "info";
  icon?: React.ReactNode;
}) {
  const toneClass = {
    default: "text-text",
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
    info: "text-info",
  }[tone];

  return (
    <div className="panel-tight px-4 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <p className="font-ui text-2xs font-semibold uppercase tracking-wider text-muted">{label}</p>
        {icon && <span className="text-faint">{icon}</span>}
      </div>
      <p className={`mt-2 font-ui text-2xl font-bold tabular tracking-tight ${toneClass}`}>{value}</p>
      {hint && <p className="mt-1 font-ui text-2xs leading-relaxed text-faint">{hint}</p>}
    </div>
  );
}

/* ========================================================== Fields ======= */

export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="label">
        {label}
        {required && <span className="ml-1 text-danger">*</span>}
      </span>
      {children}
      {hint && !error && <span className="mt-1.5 block font-ui text-2xs text-faint">{hint}</span>}
      {error && (
        <span role="alert" className="mt-1.5 block font-ui text-2xs font-medium text-danger">
          {error}
        </span>
      )}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = "", ...rest }, ref) {
    return <input ref={ref} className={`input ${className}`} {...rest} />;
  }
);

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className = "", rows = 4, ...rest }, ref) {
    return <textarea ref={ref} rows={rows} className={`input resize-y ${className}`} {...rest} />;
  }
);

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className = "", children, ...rest }, ref) {
    return (
      <select ref={ref} className={`input cursor-pointer appearance-none pr-9 ${className}`} {...rest}>
        {children}
      </select>
    );
  }
);

export function Checkbox({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div
      className={`flex gap-3 rounded-xl border p-3 transition ${
        checked ? "border-primary bg-primary-soft" : "border-border bg-surface-2"
      } ${disabled ? "opacity-50" : "cursor-pointer hover:border-border-strong"}`}
      onClick={() => !disabled && onChange(!checked)}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        onClick={(event) => event.stopPropagation()}
        className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-[var(--primary)]"
      />
      <div className="min-w-0">
        <label htmlFor={id} className="block font-ui text-sm font-medium text-text">
          {label}
        </label>
        {description && <p className="mt-0.5 font-ui text-2xs leading-relaxed text-muted">{description}</p>}
      </div>
    </div>
  );
}

/* ========================================================== Modal ======== */

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = "max-w-lg",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);

  /**
   * The latest onClose, without making the effects depend on it.
   *
   * This ref is the fix for a bug that made every form in a dialog unusable.
   * Callers pass an inline arrow — `onClose={() => setOpen(false)}` — so its
   * identity changes on every render. With onClose in the dependency array below,
   * every keystroke in a field re-ran the effect, and the effect called
   * panel.focus(): focus jumped out of the input after each character and had to be
   * clicked back. Typing a name meant clicking eight times.
   *
   * A ref read inside the handler always sees the current function while never
   * changing identity, so the effect can depend on `open` alone.
   */
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", onKey);

    // Stop the page behind from scrolling, and move focus into the dialog so a
    // keyboard user is not left outside it. Once, on open — never again while the
    // dialog is up, or it fights whatever the user is typing into.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // The first field, if the dialog has one, so a form can be typed into
    // immediately. Focusing the panel instead satisfies the accessibility
    // requirement and then makes everybody reach for the mouse, and it silently
    // overrode any autoFocus a caller had set.
    const firstField = panel.current?.querySelector<HTMLElement>(
      "[autofocus], input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])"
    );
    (firstField ?? panel.current)?.focus();

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center p-0 sm:items-center sm:p-6">
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-[3px] animate-overlay-in"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`relative z-10 w-full ${width} animate-menu-in rounded-t-panel border border-border
          bg-bg-elevated shadow-lift outline-none sm:rounded-panel`}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="font-display text-lg leading-tight text-text">{title}</h2>
            {description && (
              <p className="mt-1 font-ui text-xs leading-relaxed text-muted">{description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-lg p-1.5 text-faint transition hover:bg-surface-2 hover:text-text"
          >
            <X size={16} />
          </button>
        </header>
        <div className="max-h-[min(70vh,640px)] overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <footer className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3.5">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

/* ========================================================= Reveal ======== */

/**
 * Scroll-triggered entrance. IntersectionObserver rather than a scroll listener,
 * so it costs nothing while idle, and it disconnects after firing once: content
 * that fades every time it re-enters the viewport is a nuisance, not polish.
 *
 * Two deliberate safeguards, because the failure mode here is a blank page:
 *
 *   - threshold 0, so it fires as soon as any sliver enters. A fractional
 *     threshold can never be met by an element taller than the viewport.
 *   - a timeout that reveals regardless. If the observer never fires for any
 *     reason, the content appears a moment late rather than never.
 */
export function Reveal({
  children,
  delay = 0,
  className = "",
  as: Tag = "div",
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
  as?: keyof JSX.IntrinsicElements;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          observer.disconnect();
        }
      },
      { threshold: 0, rootMargin: "0px 0px -40px 0px" }
    );
    observer.observe(node);

    // Last resort, deliberately narrow.
    //
    // A blanket timeout would reveal everything on a long page within seconds,
    // which destroys the effect for sections the reader has not reached yet. So
    // this rescues only the actual failure case: an element that is already at
    // or above the fold, and therefore should be visible, but which the
    // observer never reported. Anything still below the fold is left to the
    // observer, where it belongs.
    const failsafe = window.setTimeout(() => {
      const rect = node.getBoundingClientRect();
      if (rect.top < window.innerHeight) setShown(true);
    }, 1500);

    return () => {
      observer.disconnect();
      window.clearTimeout(failsafe);
    };
  }, []);

  const Component = Tag as any;
  return (
    <Component
      ref={ref as any}
      className={`${shown ? "anim" : "opacity-0"} ${className}`}
      style={{ ["--d" as any]: `${delay}s` }}
    >
      {children}
    </Component>
  );
}

/* ======================================================== Spinner ======== */

export function Spinner({ size = 18, className = "" }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={`animate-spin-slow text-primary ${className}`} />;
}

/* ====================================================== Copyable ========= */

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        } catch {
          // Clipboard needs a secure context and permission; the value is
          // already on screen and selectable, so this is not worth an error.
        }
      }}
      className="font-ui text-2xs font-semibold uppercase tracking-wider text-muted transition hover:text-primary"
    >
      {copied ? "Copied" : label}
    </button>
  );
}
