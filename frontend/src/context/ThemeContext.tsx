import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";

type Theme = "dark" | "light";

interface ThemeValue {
  theme: Theme;
  toggle: () => void;
  /** Changes the theme and persists it to the user's profile. */
  set: (theme: Theme) => void;
  /** Applies a theme without writing it back. Used when a session restores. */
  adopt: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);
const STORAGE_KEY = "nyaysetu.theme";

/**
 * Theme resolution:
 *   1. the signed-in user's saved preference, which follows them across devices
 *   2. this browser's last choice
 *   3. light
 *
 * The operating system's preference is deliberately NOT consulted (DECISIONS
 * D-11): the portal looks the same everywhere until a person chooses otherwise.
 * index.html applies the stored value before first paint, so nothing flashes.
 */
function initialTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

const THEME_COLOR: Record<Theme, string> = { light: "#f5f7fa", dark: "#07130e" };

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Not fatal: the server-side preference is the durable one.
    }
  }, [theme]);

  const set = useCallback((next: Theme) => {
    setTheme(next);
    // Persist to the profile, but never block the UI on it. An unauthenticated
    // visitor gets a 401 here, which is fine: their choice lives in this browser.
    void api.patch("/api/auth/me/theme", { theme: next }).catch(() => undefined);
  }, []);

  // Adopting the server's value must not write it straight back.
  const adopt = useCallback((next: Theme) => setTheme(next), []);

  const toggle = useCallback(() => set(theme === "dark" ? "light" : "dark"), [set, theme]);

  const value = useMemo(() => ({ theme, toggle, set, adopt }), [theme, toggle, set, adopt]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside ThemeProvider.");
  return context;
}
