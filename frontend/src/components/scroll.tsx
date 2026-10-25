import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";

/**
 * Scroll affordances, kept together because they share one listener.
 *
 * Every one of these is passive and rAF-throttled. A scroll handler that does
 * layout work on every event is the classic way to make a long page feel worse
 * than it did with no effects at all, and this page is long.
 *
 * All of them respect prefers-reduced-motion: the progress bar still tracks
 * position, because that is information rather than decoration, but nothing
 * animates its way in.
 */

function useScrollMetrics() {
  const [metrics, setMetrics] = useState({ progress: 0, y: 0 });
  const frame = useRef(0);

  useEffect(() => {
    const measure = () => {
      frame.current = 0;
      const doc = document.documentElement;
      const scrollable = doc.scrollHeight - doc.clientHeight;
      setMetrics({
        progress: scrollable > 0 ? Math.min(1, doc.scrollTop / scrollable) : 0,
        y: doc.scrollTop,
      });
    };

    const onScroll = () => {
      // Coalesce to one measurement per frame. Without this a fast trackpad
      // fires dozens of layout reads between paints.
      if (frame.current) return;
      frame.current = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, []);

  return metrics;
}

/**
 * A brand-gradient bar showing how far down the page the reader is.
 *
 * Worth having on the handbook and the landing page, which are long enough that
 * "how much is left" is a real question. Not worth having on a dashboard.
 */
export function ScrollProgress() {
  const { progress } = useScrollMetrics();

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-[3px]"
      style={{ background: "transparent" }}
    >
      <div
        className="h-full origin-left bg-grad-brand"
        style={{
          transform: `scaleX(${progress})`,
          // No transition: the bar should track the finger exactly. A lag here
          // reads as the page being slow rather than as smoothing.
          willChange: "transform",
        }}
      />
    </div>
  );
}

/** Appears once the reader is well down the page. */
export function ScrollToTop({ showAfter = 700 }: { showAfter?: number }) {
  const { y } = useScrollMetrics();
  const visible = y > showAfter;

  return (
    <button
      type="button"
      aria-label="Back to top"
      title="Back to top"
      tabIndex={visible ? 0 : -1}
      onClick={() =>
        window.scrollTo({
          top: 0,
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
        })
      }
      className={`fixed bottom-6 right-6 z-50 grid h-11 w-11 place-items-center rounded-full
        border border-border bg-bg-elevated text-muted shadow-lift transition-all duration-300 ease-smooth
        hover:-translate-y-1 hover:border-primary hover:text-primary
        ${visible ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0"}`}
    >
      <ArrowUp size={17} />
    </button>
  );
}

/**
 * A downward cue under the hero, so it is obvious the page continues.
 *
 * Fades out as soon as the reader starts scrolling: once they know, the hint is
 * just something moving in the corner of their eye.
 */
export function ScrollCue({ label = "Scroll" }: { label?: string }) {
  const { y } = useScrollMetrics();

  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none flex flex-col items-center gap-1.5 transition-opacity duration-500 ${
        y > 60 ? "opacity-0" : "opacity-100"
      }`}
    >
      <span className="font-ui text-[10px] uppercase tracking-[0.22em] text-white/40">{label}</span>
      <span className="animate-nudge text-white/50">
        <svg width="14" height="18" viewBox="0 0 14 18" fill="none" aria-hidden="true">
          <path
            d="M7 1v14M1.5 10L7 15.5 12.5 10"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </div>
  );
}

/**
 * Nudges a child along one axis as it passes through the viewport.
 *
 * `strength` is in pixels of total travel. Kept small deliberately: parallax
 * that moves far enough to notice is also far enough to feel like drift, and on
 * a long document it makes text hard to track.
 */
export function Parallax({
  children,
  strength = 28,
  className = "",
}: {
  children: React.ReactNode;
  strength?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const frame = useRef(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const measure = () => {
      frame.current = 0;
      const node = ref.current;
      if (!node) return;

      const rect = node.getBoundingClientRect();
      const viewport = window.innerHeight || 1;
      // -1 when the element is just below the fold, +1 when just above it.
      const centred = (rect.top + rect.height / 2 - viewport / 2) / viewport;
      setOffset(Math.max(-1, Math.min(1, centred)) * strength);
    };

    const onScroll = () => {
      if (frame.current) return;
      frame.current = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [strength]);

  return (
    <div
      ref={ref}
      className={className}
      style={{ transform: `translate3d(0, ${offset}px, 0)`, willChange: "transform" }}
    >
      {children}
    </div>
  );
}

/**
 * Follows the pointer with a soft brand-coloured glow.
 *
 * Only on devices with a real pointer: on a touchscreen there is no hover, and
 * the listener would be dead weight.
 */
export function PointerGlow() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    const onMove = (event: PointerEvent) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const node = ref.current;
        if (node) {
          node.style.transform = `translate3d(${event.clientX - 180}px, ${event.clientY - 180}px, 0)`;
          node.style.opacity = "1";
        }
      });
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none fixed left-0 top-0 z-0 h-[360px] w-[360px] rounded-full opacity-0 transition-opacity duration-700"
      style={{
        background:
          "radial-gradient(circle, rgba(0,146,69,0.10) 0%, rgba(255,117,31,0.05) 45%, transparent 70%)",
        filter: "blur(28px)",
      }}
    />
  );
}
