import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Plus, Search, X } from "lucide-react";
import { api } from "../lib/api";
import { Field, Input } from "./ui";

/**
 * Choosing the sections an FIR is registered under.
 *
 * WHY THIS REPLACED A TEXT BOX
 *   The field used to be "Sections, comma separated", which recorded whatever the
 *   station typed. "BNS 331(4)", "331(4)", "s.331(4)" and "BSN 331(4)" were all
 *   equally acceptable, and every later question — how grave is this charge, which
 *   chapter of the code, is it even a real section — was unanswerable. The API now
 *   carries all 358 sections of the Bharatiya Nyaya Sanhita, 2023, so the officer
 *   can search it and the charge is recorded against the code rather than against a
 *   spelling.
 *
 * WHY FREE TEXT IS STILL ALLOWED
 *   A real charge sheet cites the Sanhita and special legislation together — NDPS,
 *   POCSO, the Arms Act, the IT Act — and none of those are in the BNS. A picker
 *   that only accepted what it recognised would refuse most genuine filings. So
 *   anything can be typed and added; what the code recognises gains its heading and
 *   punishment, and what it does not is kept exactly as written and marked.
 *
 * SEVERITY IS SHOWN AS A LOWER BOUND
 *   Where a section states a punishment, that is what appears. Where it does not,
 *   the section either only defines the offence — 303 defines theft, 305 punishes a
 *   species of it — or the source transcription omitted its punishing sub-section.
 *   Those are indistinguishable from the data, so nothing here implies an offence
 *   carries no penalty.
 */

interface BnsSection {
  section: number;
  title: string;
  chapter: string;
  severity: number | null;
  maxPunishment: string | null;
  statesPunishment: boolean;
}

export function SectionPicker({
  value,
  onChange,
}: {
  /** Canonical citations, e.g. ["BNS 303(2)", "NDPS 21"]. */
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BnsSection[]>([]);
  const [open, setOpen] = useState(false);
  const [available, setAvailable] = useState(true);
  const box = useRef<HTMLDivElement>(null);

  // Debounced, because this fires on every keystroke and the reference is a
  // 96KB file the API reads once — cheap, but not free per character.
  useEffect(() => {
    if (!open) return;
    const handle = window.setTimeout(async () => {
      try {
        const response = await api.get<{ sections: BnsSection[]; available: boolean }>(
          `/api/reference/sections?q=${encodeURIComponent(query)}&limit=8`
        );
        setResults(response.sections);
        setAvailable(response.available !== false);
      } catch {
        // A missing reference is not an error the officer can act on. The field
        // keeps working as free text, which is how it behaved before this existed.
        setAvailable(false);
        setResults([]);
      }
    }, 180);
    return () => window.clearTimeout(handle);
  }, [query, open]);

  // Close on an outside click, so the list does not sit over the rest of the form.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const add = (citation: string) => {
    const trimmed = citation.trim();
    if (!trimmed || value.includes(trimmed)) return;
    onChange([...value, trimmed]);
    setQuery("");
  };

  const remove = (citation: string) => onChange(value.filter((v) => v !== citation));

  /** What a bare number or "BNS 305" typed into the box would be added as. */
  const typed = useMemo(() => {
    const raw = query.trim();
    if (!raw) return null;
    const digits = /^(?:bns\s*)?(\d{1,3})(?:\s*\(([^)]{1,8})\))?$/i.exec(raw);
    if (digits) return `BNS ${digits[1]}${digits[2] ? `(${digits[2]})` : ""}`;
    return raw;
  }, [query]);

  return (
    <Field
      label="Sections charged"
      hint={
        available
          ? "Search the Bharatiya Nyaya Sanhita by number or offence. Sections of other Acts can be typed in directly."
          : "The statute reference is unavailable on this deployment, so type citations directly."
      }
    >
      <div ref={box} className="relative">
        {value.length > 0 && (
          <ul className="mb-2 flex flex-wrap gap-1.5">
            {value.map((citation) => (
              <li
                key={citation}
                className="inline-flex items-center gap-1.5 rounded-full border border-primary-soft bg-primary-soft px-2.5 py-1"
              >
                <span className="font-mono text-2xs font-semibold text-primary">{citation}</span>
                <button
                  type="button"
                  onClick={() => remove(citation)}
                  aria-label={`Remove ${citation}`}
                  className="text-primary/70 transition hover:text-danger"
                >
                  <X size={11} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
          />
          <Input
            value={query}
            onFocus={() => setOpen(true)}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (results.length === 1) add(`BNS ${results[0].section}`);
                else if (typed) add(typed);
              }
              if (event.key === "Escape") setOpen(false);
            }}
            className="pl-9"
            placeholder="theft, murder, 303, NDPS 21…"
          />
        </div>

        {open && (query || results.length > 0) && (
          <div className="absolute z-30 mt-1.5 w-full animate-menu-in overflow-hidden rounded-card border border-border bg-bg-elevated shadow-lift">
            <ul className="max-h-64 overflow-y-auto">
              {results.map((s) => (
                <li key={s.section}>
                  <button
                    type="button"
                    onClick={() => add(`BNS ${s.section}`)}
                    className="flex w-full items-start gap-3 px-3.5 py-2.5 text-left transition hover:bg-surface-2"
                  >
                    <span className="mt-0.5 shrink-0 rounded bg-surface-raised px-1.5 py-0.5 font-mono text-2xs font-bold text-text">
                      {s.section}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-ui text-xs font-medium text-text">
                        {s.title}
                      </span>
                      <span className="block truncate font-ui text-3xs text-faint">
                        {s.chapter}
                        {s.maxPunishment ? ` · ${s.maxPunishment}` : " · punishment stated elsewhere"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}

              {typed && !results.some((s) => `BNS ${s.section}` === typed) && (
                <li className="border-t border-border">
                  <button
                    type="button"
                    onClick={() => add(typed)}
                    className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition hover:bg-surface-2"
                  >
                    <Plus size={13} className="shrink-0 text-accent" />
                    <span className="font-ui text-xs text-muted">
                      Add <span className="font-mono text-text">{typed}</span> as typed
                      {!/^BNS /.test(typed) && " — another Act"}
                    </span>
                  </button>
                </li>
              )}

              {results.length === 0 && !typed && (
                <li className="flex items-center gap-2 px-3.5 py-3">
                  <BookOpen size={13} className="text-faint" />
                  <span className="font-ui text-xs text-muted">
                    Type a section number or part of an offence.
                  </span>
                </li>
              )}
            </ul>
          </div>
        )}
      </div>
    </Field>
  );
}
