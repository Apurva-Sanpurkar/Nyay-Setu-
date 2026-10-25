import { useEffect, useState } from "react";
import { ImageOff, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { api } from "../lib/api";
import { shortHash } from "../lib/hash";

/**
 * Shared pieces of the smart-policing screens (Vehicle Trace, Third Eye):
 * photographs fetched through the API, status chips and the integrity verdict.
 * The map lives in LocationMap.tsx so Leaflet loads only where a map is shown.
 */

/* ====================================================== SecureImage ===== */

/**
 * A photograph decrypted by the API. Fetched with the session rather than put in
 * an <img src>, so it works across origins in development and is never cached
 * by the browser or a proxy.
 */
export function SecureImage({ id, alt, className = "" }: { id: string; alt: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let revoked: string | null = null;
    let live = true;
    setFailed(false);
    api
      .download(`/api/smart/media/${id}`)
      .then((r) => r.blob())
      .then((blob) => {
        if (!live) return;
        revoked = URL.createObjectURL(blob);
        setUrl(revoked);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [id]);
  if (failed) {
    return (
      <div className={`grid place-items-center bg-surface-2 text-faint ${className}`} role="img" aria-label={`${alt} could not be loaded`}>
        <ImageOff size={18} aria-hidden />
      </div>
    );
  }
  if (!url) return <div className={`animate-pulse bg-surface-2 ${className}`} aria-label={`Loading ${alt}`} />;
  return <img src={url} alt={alt} className={`object-cover ${className}`} />;
}

/* ====================================================== Status chips ===== */

export type Tone = "neutral" | "info" | "warning" | "success" | "danger" | "primary";

const CHIP: Record<Tone, string> = {
  neutral: "border-border bg-surface-2 text-muted",
  info: "border-info-soft bg-info-soft text-info",
  warning: "border-warning-soft bg-warning-soft text-warning",
  success: "border-success-soft bg-success-soft text-success",
  danger: "border-danger-soft bg-danger-soft text-danger",
  primary: "border-primary-ring bg-primary-soft text-primary",
};

export function Chip({ tone = "neutral", children, title }: { tone?: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span className={`chip ${CHIP[tone]}`} title={title}>
      {children}
    </span>
  );
}

/* ======================================================= Integrity ======= */

export interface IntegrityVerdict {
  intact: boolean;
  onChain?: boolean;
  anchorState?: string | null;
  rowMatchesStoredDigest: boolean;
  storedDigestWasAnchored: boolean;
  recomputedDigest: string;
  storedDigest: string;
  explanation: string;
}

/** Whether the record reads now as it did when it was anchored. */
export function IntegrityNote({ integrity }: { integrity: IntegrityVerdict | null | undefined }) {
  if (!integrity) return null;
  // Green only when the ledger has confirmed it; matching but unconfirmed is amber.
  const confirmed = integrity.intact && integrity.onChain !== false;
  const Icon = confirmed ? ShieldCheck : integrity.rowMatchesStoredDigest ? ShieldAlert : ShieldX;
  const tone = confirmed ? "border-success-soft bg-success-soft text-success" : integrity.rowMatchesStoredDigest ? "border-warning-soft bg-warning-soft text-warning" : "border-danger-soft bg-danger-soft text-danger";
  return (
    <div className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-3 ${tone}`} role="status">
      <Icon size={16} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0">
        <p className="font-ui text-xs font-semibold">{confirmed ? "Record intact, confirmed on chain" : integrity.intact ? "Record intact, awaiting the ledger" : integrity.rowMatchesStoredDigest ? "Not anchored" : "Record integrity problem"}</p>
        <p className="mt-0.5 font-ui text-2xs leading-relaxed text-text">{integrity.explanation}</p>
        <p className="mt-1 font-mono text-2xs text-muted" title={integrity.storedDigest}>
          SHA-256 {shortHash(integrity.storedDigest, 12, 8)}
        </p>
      </div>
    </div>
  );
}

/** A red-bordered reminder that a score is not an identification. */
export function LeadDisclaimer({ text }: { text: string }) {
  return (
    <div role="note" className="flex items-start gap-2.5 rounded-xl border border-warning-soft bg-warning-soft px-4 py-3">
      <ShieldAlert size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
      <p className="font-ui text-xs leading-relaxed text-text">{text}</p>
    </div>
  );
}

export function labelOf(value: string | null | undefined): string {
  if (!value) return "—";
  return value.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

export function ScoreBar({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const tone = score >= 0.85 ? "bg-success" : score >= 0.6 ? "bg-warning" : "bg-faint";
  return (
    <div className="flex items-center gap-2" title={`Similarity score ${pct}% — a reason to look, not a finding`}>
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-3" aria-hidden>
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="font-ui text-2xs tabular text-muted">{pct}%</span>
    </div>
  );
}
