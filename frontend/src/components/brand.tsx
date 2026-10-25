import { useEffect, useState } from "react";
import { Download, Share, X } from "lucide-react";
import { useInstallPrompt } from "../lib/pwa";
import { LogoMark } from "./Logo";

/**
 * Brand pieces used across the app: the Maharashtra Police seal, the
 * "Install app" button, and the opening splash.
 */

export function PoliceSeal({ size = 36, showLabel = false, className = "" }: { size?: number; showLabel?: boolean; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      {showLabel && (
        <span className="hidden text-right leading-tight sm:block">
          <span className="block font-ui text-2xs font-semibold uppercase tracking-[0.12em] text-text">Maharashtra Police</span>
          <span className="block font-ui text-2xs text-muted">सद्रक्षणाय खलनिग्रहणाय</span>
        </span>
      )}
      <picture>
        <source srcSet="/maharashtra-police.webp" type="image/webp" />
        <img
          src="/maharashtra-police.png"
          alt="Maharashtra Police emblem"
          width={size}
          height={Math.round(size * 0.74)}
          style={{ width: size, height: "auto" }}
          className="select-none"
          draggable={false}
        />
      </picture>
    </span>
  );
}

export function InstallAppButton({ compact = false }: { compact?: boolean }) {
  const { canPrompt, installed, ios, install } = useInstallPrompt();
  const [hint, setHint] = useState(false);
  if (installed || (!canPrompt && !ios)) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => (canPrompt ? void install() : setHint(true))}
        className={`inline-flex items-center gap-1.5 rounded-full border border-primary-ring bg-primary-soft font-ui font-semibold text-primary transition hover:bg-primary hover:text-on-primary ${
          compact ? "h-9 px-3 text-xs" : "h-10 px-4 text-sm"
        }`}
        aria-label="Install the NyaySetu app"
      >
        <Download size={compact ? 13 : 15} aria-hidden />
        <span>{compact ? "Install" : "Install app"}</span>
      </button>
      {hint && (
        <div className="fixed inset-0 z-[90] grid place-items-end bg-black/40 p-4 sm:place-items-center" onClick={() => setHint(false)}>
          <div role="dialog" aria-modal="true" aria-label="Install on iPhone or iPad" className="panel w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <h2 className="font-display text-lg text-text">Add NyaySetu to your Home Screen</h2>
              <button type="button" aria-label="Close" onClick={() => setHint(false)} className="grid h-8 w-8 place-items-center rounded-full text-muted hover:bg-surface-2">
                <X size={16} aria-hidden />
              </button>
            </div>
            <ol className="mt-3 space-y-2 font-ui text-sm text-text">
              <li className="flex items-center gap-2">
                1. Tap <Share size={15} className="text-primary" aria-label="Share" /> in Safari.
              </li>
              <li>2. Choose “Add to Home Screen”.</li>
              <li>3. Tap “Add”.</li>
            </ol>
          </div>
        </div>
      )}
    </>
  );
}

const SPLASH_KEY = "nyaysetu.splash";

/**
 * A short opening animation, shown once per browser session. Plain CSS
 * (styles/index.css, .splash-*), so it costs nothing in the first download;
 * it is skipped entirely when the visitor prefers reduced motion.
 */
export function SplashScreen() {
  const [phase, setPhase] = useState<"show" | "leaving" | "gone">(() => {
    try {
      if (sessionStorage.getItem(SPLASH_KEY)) return "gone";
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return "gone";
      return "show";
    } catch {
      return "gone";
    }
  });

  useEffect(() => {
    if (phase === "gone") return;
    try {
      sessionStorage.setItem(SPLASH_KEY, "1");
    } catch {
      /* storage unavailable */
    }
    const leave = window.setTimeout(() => setPhase("leaving"), 1300);
    const gone = window.setTimeout(() => setPhase("gone"), 1750);
    return () => {
      window.clearTimeout(leave);
      window.clearTimeout(gone);
    };
  }, [phase === "gone"]);

  if (phase === "gone") return null;
  return (
    <div aria-hidden className={`splash pointer-events-none fixed inset-0 z-[100] grid place-items-center bg-bg ${phase === "leaving" ? "splash-leave" : ""}`}>
      <div className="flex flex-col items-center">
        <div className="relative">
          <span className="splash-ring absolute inset-0 rounded-full bg-primary-soft" />
          <span className="splash-logo block">
            <LogoMark size={84} />
          </span>
        </div>
        <p className="splash-rise mt-5 font-display text-2xl text-text" style={{ animationDelay: "0.25s" }}>
          NyaySetu
        </p>
        <p className="splash-rise mt-1 font-ui text-xs uppercase tracking-[0.2em] text-muted" style={{ animationDelay: "0.45s" }}>
          न्यायसेतु · Bridge of Justice
        </p>
        <span className="splash-bar mt-6 block h-0.5 w-40 origin-left rounded-full bg-primary" />
      </div>
    </div>
  );
}
