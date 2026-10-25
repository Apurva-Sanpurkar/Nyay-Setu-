import { useState } from "react";
import {
  AlertOctagon,
  CheckCircle2,
  CircleDashed,
  Clock3,
  ExternalLink,
  History,
  RefreshCw,
  SearchCheck,
  ShieldCheck,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { explainEvidence } from "@nyaysetu/integrity";
import type { StateHistoryRow, Verification, VerificationState } from "../lib/api";
import { api } from "../lib/api";
import { useI18n, type MessageKey } from "../i18n";
import { shortHash } from "../lib/hash";
import { formatDateTime } from "../lib/format";
import { useToast } from "../context/ToastContext";
import { Button } from "./ui";

/**
 * How the verification state machine is shown (2.0 · F2).
 *
 * The rule this file exists to keep: only CONFIRMED is ever green and only
 * CONFIRMED is ever called verified. SUBMITTED is "awaiting confirmation", never
 * a tick. Every state has an icon and a word, so nothing depends on colour.
 */

const TONE: Record<VerificationState, { chip: string; icon: typeof CheckCircle2 }> = {
  CONFIRMED: { chip: "border-success-soft bg-success-soft text-success", icon: ShieldCheck },
  SUBMITTED: { chip: "border-info-soft bg-info-soft text-info", icon: Clock3 },
  LOCAL_ONLY: { chip: "border-border bg-surface-2 text-muted", icon: CircleDashed },
  SYNC_ERROR: { chip: "border-warning-soft bg-warning-soft text-warning", icon: TriangleAlert },
  REVIEW_REQUIRED: { chip: "border-warning-soft bg-warning-soft text-warning", icon: SearchCheck },
  INTEGRITY_MISMATCH: { chip: "border-danger-soft bg-danger-soft text-danger", icon: XCircle },
};

export function VerificationBadge({
  state,
  short = false,
  className = "",
}: {
  state: VerificationState;
  short?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const tone = TONE[state] ?? TONE.LOCAL_ONLY;
  const Icon = tone.icon;
  const label = t((short ? `state.short.${state}` : `state.${state}`) as MessageKey);
  return (
    <span className={`chip ${tone.chip} ${className}`} title={t(`state.${state}` as MessageKey)}>
      <Icon size={11} aria-hidden />
      {label}
    </span>
  );
}

/**
 * The full verification block for one evidence item: state, what it means in
 * plain words, confirmations, transaction, failure reason, history, and the
 * two actions — retry (for a failure) and look at the chain now.
 */
export function VerificationPanel({
  evidenceId,
  verification,
  history,
  canRetry,
  onChanged,
}: {
  evidenceId: string;
  verification: Verification;
  history?: StateHistoryRow[];
  canRetry: boolean;
  onChanged?: () => void;
}) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState<"retry" | "recheck" | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const explained = explainEvidence(verification.state, lang);

  const run = async (kind: "retry" | "recheck") => {
    setBusy(kind);
    try {
      await api.post(`/api/evidence/${evidenceId}/anchor/${kind}`);
      toast.success(kind === "retry" ? t("state.retried") : t("state.rechecked"));
      onChanged?.();
    } catch (error) {
      toast.error(t("common.error"), error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const retryable = verification.state === "SYNC_ERROR" || verification.state === "REVIEW_REQUIRED";
  const tracking = verification.state === "SUBMITTED" || verification.state === "CONFIRMED" || verification.state === "REVIEW_REQUIRED";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <VerificationBadge state={verification.state} />
        {verification.state === "SUBMITTED" && (
          <span className="font-ui text-2xs text-muted">
            {t("state.confirmations", { n: verification.confirmations, required: verification.requiredConfirmations })}
          </span>
        )}
      </div>

      <div className="rounded-xl border border-border bg-surface-2 p-3.5">
        <p className="font-ui text-sm font-semibold text-text">{explained.title}</p>
        <p className="mt-1 font-ui text-xs leading-relaxed text-muted">{explained.body}</p>
        {explained.next && <p className="mt-2 font-ui text-xs font-medium text-text">{explained.next}</p>}
      </div>

      {verification.failureReason && verification.state !== "CONFIRMED" && (
        <div role="status" className="flex gap-2.5 rounded-xl border border-warning-soft bg-warning-soft p-3">
          <AlertOctagon size={15} className="mt-0.5 shrink-0 text-warning" aria-hidden />
          <p className="font-ui text-xs leading-relaxed text-text">
            <span className="font-semibold">{t("state.failure")}: </span>
            {verification.failureReason}
            {verification.failureCode && <code className="ml-1.5 font-mono text-2xs text-muted">{verification.failureCode}</code>}
          </p>
        </div>
      )}

      {verification.txHash && (
        <dl className="grid gap-2 font-ui text-xs sm:grid-cols-2">
          <div>
            <dt className="text-faint">Transaction</dt>
            <dd className="mt-0.5">
              {verification.explorer ? (
                <a href={verification.explorer} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-mono text-2xs text-primary hover:underline">
                  {shortHash(verification.txHash, 12, 8)}
                  <ExternalLink size={11} aria-hidden />
                  <span className="sr-only">{t("common.openOnExplorer")}</span>
                </a>
              ) : (
                <code className="font-mono text-2xs text-muted">{shortHash(verification.txHash, 12, 8)}</code>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-faint">Block</dt>
            <dd className="mt-0.5 font-mono text-2xs text-text">{verification.blockNumber ?? "—"}</dd>
          </div>
          {verification.confirmedAt && (
            <div>
              <dt className="text-faint">{t("state.short.CONFIRMED")}</dt>
              <dd className="mt-0.5 text-text">{formatDateTime(verification.confirmedAt)}</dd>
            </div>
          )}
          {verification.lastCheckedAt && (
            <div>
              <dt className="text-faint">{t("state.rechecked")}</dt>
              <dd className="mt-0.5 text-text">{formatDateTime(verification.lastCheckedAt)}</dd>
            </div>
          )}
        </dl>
      )}

      <div className="flex flex-wrap gap-2">
        {canRetry && retryable && (
          <Button size="sm" icon={<RefreshCw size={12} />} loading={busy === "retry"} onClick={() => void run("retry")}>
            {t("state.retry")}
          </Button>
        )}
        {tracking && (
          <Button size="sm" variant="secondary" icon={<SearchCheck size={12} />} loading={busy === "recheck"} onClick={() => void run("recheck")}>
            {t("state.recheck")}
          </Button>
        )}
        {history && history.length > 0 && (
          <Button size="sm" variant="ghost" icon={<History size={12} />} onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory}>
            {t("state.history")}
          </Button>
        )}
      </div>

      {showHistory && history && (
        <ol className="space-y-2 border-l-2 border-border pl-4">
          {history.map((row, index) => (
            <li key={index} className="relative">
              <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-primary" aria-hidden />
              <div className="flex flex-wrap items-center gap-2">
                <VerificationBadge state={row.to_state} short />
                <code className="font-mono text-2xs text-faint">{row.reason_code}</code>
                <span className="font-ui text-2xs text-faint">{formatDateTime(row.occurred_at)}</span>
              </div>
              {row.reason && <p className="mt-0.5 font-ui text-2xs leading-relaxed text-muted">{row.reason}</p>}
            </li>
          ))}
        </ol>
      )}

      <p className="font-ui text-2xs leading-relaxed text-faint">{t("state.appNotContract")}</p>
    </div>
  );
}
