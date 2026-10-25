import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { en, type MessageKey } from "./en";
import { hi } from "./hi";
import { mr } from "./mr";

/**
 * Jan-Sahayak language and readability preferences (2.0 · F6).
 *
 * Key-based: every 2.0 screen asks for a message by key, never by English text,
 * so a missing translation is a build failure (scripts/checkI18n.mjs) rather than
 * an English sentence quietly left on a Marathi screen.
 *
 * The Hindi and Marathi copy has NOT been reviewed by a native speaker. That is
 * recorded in docs/JAN_SAHAYAK.md and must stay true until someone does it.
 */

export type Lang = "en" | "hi" | "mr";
export type TextSize = "normal" | "large";
export type { MessageKey };

export const LANGUAGES: { code: Lang; label: string; native: string }[] = [
  { code: "en", label: "English", native: "English" },
  { code: "hi", label: "Hindi", native: "हिन्दी" },
  { code: "mr", label: "Marathi", native: "मराठी" },
];

const DICTIONARIES: Record<Lang, Partial<Record<MessageKey, string>>> = { en, hi, mr };

const LANG_KEY = "nyaysetu.lang";
const SIZE_KEY = "nyaysetu.textSize";

export type Vars = Record<string, string | number>;

/** Pure lookup, usable outside React (the PDF and toast helpers use it). */
export function translate(lang: Lang, key: MessageKey, vars?: Vars): string {
  const template = DICTIONARIES[lang][key] ?? en[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

interface I18nValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  textSize: TextSize;
  setTextSize: (size: TextSize) => void;
  t: (key: MessageKey, vars?: Vars) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

function stored<T extends string>(key: string, allowed: T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key) as T | null;
    return value && allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => stored<Lang>(LANG_KEY, ["en", "hi", "mr"], "en"));
  const [textSize, setTextSizeState] = useState<TextSize>(() => stored<TextSize>(SIZE_KEY, ["normal", "large"], "normal"));

  useEffect(() => {
    // The lang attribute is what tells a screen reader which voice to use and
    // the browser which hyphenation and font rules apply.
    document.documentElement.setAttribute("lang", lang);
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {
      /* storage blocked: the choice lasts this visit */
    }
  }, [lang]);

  useEffect(() => {
    if (textSize === "large") document.documentElement.setAttribute("data-text-size", "large");
    else document.documentElement.removeAttribute("data-text-size");
    try {
      localStorage.setItem(SIZE_KEY, textSize);
    } catch {
      /* as above */
    }
  }, [textSize]);

  const t = useCallback((key: MessageKey, vars?: Vars) => translate(lang, key, vars), [lang]);
  const setLang = useCallback((next: Lang) => setLangState(next), []);
  const setTextSize = useCallback((next: TextSize) => setTextSizeState(next), []);

  const value = useMemo(() => ({ lang, setLang, textSize, setTextSize, t }), [lang, setLang, textSize, setTextSize, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider.");
  return context;
}

/** Locale for dates and numbers. Indian English keeps day-month order. */
export function localeFor(lang: Lang): string {
  return lang === "hi" ? "hi-IN" : lang === "mr" ? "mr-IN" : "en-IN";
}
