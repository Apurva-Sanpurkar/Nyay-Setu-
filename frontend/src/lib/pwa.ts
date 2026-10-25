import { useEffect, useState } from "react";

/**
 * Installing NyaySetu as an app (Android Chrome, Edge, desktop Chrome).
 *
 * The browser fires `beforeinstallprompt` once, often before React has
 * mounted, so it is captured here at module load and handed to whichever
 * component asks. iOS Safari has no prompt; the button explains "Add to Home
 * Screen" there instead.
 */

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    notify();
  });
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function isIos(): boolean {
  return typeof navigator !== "undefined" && /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function useInstallPrompt() {
  const [, force] = useState(0);
  useEffect(() => {
    const update = () => force((n) => n + 1);
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, []);
  return {
    /** True when the browser will show its install dialog. */
    canPrompt: deferred !== null,
    installed: isStandalone(),
    ios: isIos(),
    async install(): Promise<"accepted" | "dismissed" | "unavailable"> {
      if (!deferred) return "unavailable";
      const event = deferred;
      await event.prompt();
      const { outcome } = await event.userChoice;
      if (outcome === "accepted") deferred = null;
      notify();
      return outcome;
    },
  };
}

/** Registers the service worker in production builds only. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* Installation is a convenience; the site works without it. */
    });
  });
}
