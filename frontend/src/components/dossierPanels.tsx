import { useState } from "react";
import { Archive, Bot, Database, ExternalLink, Link2, Lock, ShieldCheck, TriangleAlert } from "lucide-react";
import { api, type CaseRow } from "../lib/api";
import { useMutation, useQuery } from "../lib/useApi";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { useI18n, type MessageKey } from "../i18n";
import { formatDateTime } from "../lib/format";
import { shortHash } from "../lib/hash";
import { fetchDocument } from "../lib/download";
import { Button, Card, Field, Modal, Select, Textarea } from "./ui";
import { EmptyState, ErrorState, Loading } from "./DataState";

/**
 * Case dossier panels (2.0): the labelled audit timeline (F4), AI outputs with
 * human review (F5), and case-level governance — closing a case, legal holds
 * and the court export bundle (F19).
 */

/* ================================================================== F4 */

type Trust = "VERIFIED_ON_CHAIN" | "DB_ONLY" | "CHAIN_ONLY" | "MISMATCH" | "PENDING";

interface TimelineEntry {
  id: string;
  at: string;
  source: "chain" | "database";
  label: string;
  trust: Trust;
  txHash?: string | null;
  explorer?: string | null;
  indexed?: boolean;
  actorRole?: string | null;
  outcome?: "ok" | "refused" | "failed";
  detail?: string | null;
}

const TRUST_STYLE: Record<Trust, { cls: string; Icon: typeof ShieldCheck }> = {
  VERIFIED_ON_CHAIN: { cls: "border-success-soft bg-success-soft text-success", Icon: ShieldCheck },
  PENDING: { cls: "border-info-soft bg-info-soft text-info", Icon: Link2 },
  DB_ONLY: { cls: "border-border bg-surface-2 text-muted", Icon: Database },
  CHAIN_ONLY: { cls: "border-warning-soft bg-warning-soft text-warning", Icon: TriangleAlert },
  MISMATCH: { cls: "border-danger-soft bg-danger-soft text-danger", Icon: TriangleAlert },
};

export function TrustChip({ trust }: { trust: Trust }) {
  const { t } = useI18n();
  const { cls, Icon } = TRUST_STYLE[trust];
  return (
    <span className={`chip ${cls}`}>
      <Icon size={11} aria-hidden /> {t(`trust.${trust}` as MessageKey)}
    </span>
  );
}

export function AuditTimelineCard({ caseId }: { caseId: string }) {
  const { t } = useI18n();
  const state = useQuery<{ entries: TimelineEntry[]; counts: Partial<Record<Trust, number>> }>(`/api/alerts/cases/${caseId}/timeline`);
  const [filter, setFilter] = useState<Trust | "">("");
  const [showAll, setShowAll] = useState(false);

  const entries = [...(state.data?.entries ?? [])].reverse().filter((e) => !filter || e.trust === filter);
  const visible = showAll ? entries : entries.slice(0, 25);

  return (
    <Card
      title={t("case.timeline")}
      subtitle={t("trust.hint")}
      actions={
        <Select aria-label={t("alerts.filterStatus")} className="w-auto" value={filter} onChange={(e) => setFilter(e.target.value as Trust | "")}>
          <option value="">{t("alerts.all")}</option>
          {(Object.keys(TRUST_STYLE) as Trust[]).map((k) => (
            <option key={k} value={k}>
              {t(`trust.${k}` as MessageKey)} ({state.data?.counts[k] ?? 0})
            </option>
          ))}
        </Select>
      }
    >
      {state.loading && !state.data ? (
        <Loading rows={3} />
      ) : state.error && !state.data ? (
        <ErrorState error={state.error} onRetry={state.refetch} context="audit timeline" />
      ) : entries.length === 0 ? (
        <EmptyState title={t("case.timelineEmpty")} icon={<Database size={19} />} />
      ) : (
        <>
          <ol className="space-y-3 border-l-2 border-border pl-4">
            {visible.map((e) => (
              <li key={e.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-ui text-sm font-medium text-text">{e.label}</p>
                  <TrustChip trust={e.trust} />
                  {e.outcome && e.outcome !== "ok" && <span className={`font-ui text-2xs font-bold uppercase ${e.outcome === "refused" ? "text-danger" : "text-warning"}`}>{e.outcome}</span>}
                </div>
                <p className="font-ui text-2xs text-faint">
                  {formatDateTime(e.at)}
                  {e.actorRole && ` · ${t(`role.${e.actorRole}` as MessageKey)}`}
                  {e.txHash && (
                    <>
                      {" · "}
                      {e.explorer ? (
                        <a href={e.explorer} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 font-mono text-primary hover:underline">
                          {shortHash(e.txHash, 10, 6)} <ExternalLink size={10} aria-hidden />
                        </a>
                      ) : (
                        <code className="font-mono">{shortHash(e.txHash, 10, 6)}</code>
                      )}
                      {e.source === "chain" && e.trust === "VERIFIED_ON_CHAIN" && !e.indexed && ` · ${t("trust.notIndexed")}`}
                    </>
                  )}
                </p>
                {e.detail && <p className="mt-0.5 font-ui text-2xs text-muted">{e.detail}</p>}
              </li>
            ))}
          </ol>
          {entries.length > visible.length && (
            <Button size="sm" variant="ghost" className="mt-3" onClick={() => setShowAll(true)}>
              {t("trust.showAll", { n: entries.length })}
            </Button>
          )}
        </>
      )}
    </Card>
  );
}

/* ================================================================== F5 */

interface Insight {
  id: string;
  model: string;
  modelVersion: string | null;
  subject: { id: string; file_name: string; public_ref: string } | null;
  createdAt: string;
  payloadHash: string | null;
  explanation: {
    flagged?: boolean;
    score?: number | null;
    estimate?: string | number | null;
    reasons?: { kind: string; label: string; text: string; note?: string }[];
    interval?: { kind: string; low?: number; high?: number; values?: Record<string, number> } | null;
    topFactors?: string[];
    limitations: string;
  };
  reviews: { decision: string; reason: string; reviewer_role: string; created_at: string }[];
}

export function AiInsightsCard({ caseId }: { caseId: string }) {
  const { t } = useI18n();
  const { user } = useAuth();
  const allowed = user && ["police", "forensic_lab", "prosecutor", "judge", "court_admin"].includes(user.role);
  const state = useQuery<{ banner: string; trainingCaveat: string; outputs: Insight[] }>(allowed ? `/api/ai/cases/${caseId}/insights` : null);
  const [reviewing, setReviewing] = useState<Insight | null>(null);
  if (!allowed || !state.data || state.data.outputs.length === 0) return null;

  return (
    <Card title={t("ai.title")} subtitle={state.data.banner}>
      <ul className="space-y-3">
        {state.data.outputs.map((o) => (
          <li key={o.id} className="rounded-xl border border-border bg-surface-2 p-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <Bot size={14} className="text-muted" aria-hidden />
              <span className="font-ui text-xs font-semibold text-text">{t(`ai.model.${o.model}` as MessageKey)}</span>
              {o.modelVersion && <span className="font-mono text-2xs text-faint">{o.modelVersion}</span>}
              {o.explanation.flagged !== undefined && (
                <span className={`chip ${o.explanation.flagged ? "border-warning-soft bg-warning-soft text-warning" : "border-border bg-surface text-muted"}`}>
                  {o.explanation.flagged ? t("ai.flagged") : t("ai.notFlagged")}
                </span>
              )}
              <span className="ml-auto font-ui text-2xs text-faint">{formatDateTime(o.createdAt)}</span>
            </div>
            {o.subject && <p className="mt-1 font-ui text-2xs text-muted">{o.subject.file_name} · <code className="font-mono">{o.subject.public_ref}</code></p>}
            {o.explanation.estimate !== undefined && o.explanation.estimate !== null && (
              <p className="mt-1.5 font-ui text-sm text-text">
                {t("ai.estimate")}: <strong>{String(o.explanation.estimate)}</strong>
                {o.explanation.interval?.low !== undefined && ` (${o.explanation.interval.low}–${o.explanation.interval.high}, ${o.explanation.interval.kind})`}
              </p>
            )}
            {(o.explanation.reasons?.length ?? 0) > 0 && (
              <ul className="mt-2 space-y-1">
                {o.explanation.reasons!.map((r, i) => (
                  <li key={i} className="font-ui text-xs text-text">
                    <span className="font-semibold">{r.label}:</span> {r.text}
                    {r.note && <span className="block text-2xs text-muted">{r.note}</span>}
                  </li>
                ))}
              </ul>
            )}
            {(o.explanation.topFactors?.length ?? 0) > 0 && (
              <p className="mt-1.5 font-ui text-xs text-muted">
                {t("ai.factors")}: {o.explanation.topFactors!.join(", ")}
              </p>
            )}
            <p className="mt-2 font-ui text-2xs leading-relaxed text-faint">{o.explanation.limitations}</p>
            {o.reviews.length > 0 && (
              <ul className="mt-2 space-y-1 border-t border-border pt-2">
                {o.reviews.map((r, i) => (
                  <li key={i} className="font-ui text-2xs text-muted">
                    <strong className="text-text">{t(`ai.decision.${r.decision}` as MessageKey)}</strong> · {t(`role.${r.reviewer_role}` as MessageKey)} · {formatDateTime(r.created_at)} — {r.reason}
                  </li>
                ))}
              </ul>
            )}
            <Button size="sm" variant="ghost" className="mt-2" onClick={() => setReviewing(o)}>
              {t("ai.review")}
            </Button>
          </li>
        ))}
      </ul>
      <p className="mt-3 font-ui text-2xs leading-relaxed text-faint">{state.data.trainingCaveat}</p>
      {reviewing && <ReviewDialog insight={reviewing} onClose={() => setReviewing(null)} onDone={() => { setReviewing(null); state.refetch(); }} />}
    </Card>
  );
}

function ReviewDialog({ insight, onClose, onDone }: { insight: Insight; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [decision, setDecision] = useState<"agree" | "contest" | "dismiss">("agree");
  const [reason, setReason] = useState("");
  const save = useMutation(async () => api.post(`/api/ai/flags/${insight.id}/review`, { decision, reason: reason.trim() }));
  return (
    <Modal
      open
      onClose={onClose}
      title={t("ai.review")}
      description={t("ai.reviewHint")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={reason.trim().length < 10} loading={save.pending} onClick={async () => (await save.run(undefined as never)) && onDone()}>
            {t("common.submit")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t("ai.yourDecision")} required>
          <Select value={decision} onChange={(e) => setDecision(e.target.value as typeof decision)}>
            {(["agree", "contest", "dismiss"] as const).map((d) => (
              <option key={d} value={d}>
                {t(`ai.decision.${d}` as MessageKey)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("gov.reason")} required hint={t("court.minChars", { n: 10 })}>
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {save.error && <p role="alert" className="font-ui text-xs text-danger">{save.error.message}</p>}
      </div>
    </Modal>
  );
}

/* ================================================================== F19 */

export function CaseGovernanceCard({ caseRow }: { caseRow: CaseRow }) {
  const { t } = useI18n();
  const { user } = useAuth();
  const toast = useToast();
  const holds = useQuery<{ holds: { id: string; subject_type: string; subject_id: string; reason: string; placed_at: string; released_at: string | null }[] }>(
    user?.role === "accused" ? null : `/api/governance/cases/${caseRow.id}/holds`
  );
  const [dialog, setDialog] = useState<null | "close" | "hold" | { release: string }>(null);
  const [bundling, setBundling] = useState(false);
  if (!user || user.role === "accused") return null;

  const role = user.role;
  const canClose = ["police", "prosecutor", "judge", "court_admin"].includes(role) && caseRow.status !== "disposed";
  const canHold = ["judge", "prosecutor", "court_admin"].includes(role);
  const canRelease = role === "judge" || role === "court_admin";
  const active = (holds.data?.holds ?? []).filter((h) => !h.released_at);

  const bundle = async () => {
    setBundling(true);
    try {
      const { sha256 } = await fetchDocument(`/api/governance/export?caseId=${caseRow.id}`, { fileName: `nyaysetu-${caseRow.case_reference.replace(/[^A-Za-z0-9]+/g, "-")}.zip` });
      toast.success(t("docs.produced"), sha256 ? `SHA-256 ${shortHash(sha256, 14, 8)}` : undefined);
    } catch (caught) {
      toast.error(t("docs.failed"), caught instanceof Error ? caught.message : undefined);
    } finally {
      setBundling(false);
    }
  };

  return (
    <Card title={t("gov.caseTitle")} subtitle={t("gov.caseSubtitle")}>
      <div className="space-y-3">
        {active.map((h) => (
          <div key={h.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-warning-soft bg-warning-soft px-3 py-2">
            <p className="flex gap-2 font-ui text-xs text-text">
              <Lock size={13} className="mt-0.5 shrink-0 text-warning" aria-hidden />
              <span>
                <strong>{h.subject_type === "case" ? t("gov.caseHold") : t("gov.itemHold")}:</strong> {h.reason}
              </span>
            </p>
            {canRelease && (
              <Button size="sm" variant="ghost" onClick={() => setDialog({ release: h.id })}>
                {t("gov.release")}
              </Button>
            )}
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" icon={<Archive size={13} />} loading={bundling} onClick={() => void bundle()}>
            {t("docs.bundle")}
          </Button>
          {canHold && (
            <Button size="sm" variant="secondary" icon={<Lock size={13} />} onClick={() => setDialog("hold")}>
              {t("gov.placeHold")}
            </Button>
          )}
          {canClose && (
            <Button size="sm" variant="ghost" onClick={() => setDialog("close")}>
              {t("gov.requestClose")}
            </Button>
          )}
        </div>
        <p className="font-ui text-2xs leading-relaxed text-faint">{t("gov.bundleHint")}</p>
      </div>
      {dialog && (
        <CaseGovernanceDialog
          kind={dialog}
          caseId={caseRow.id}
          onClose={() => setDialog(null)}
          onDone={(message) => {
            setDialog(null);
            holds.refetch();
            toast.success(message);
          }}
        />
      )}
    </Card>
  );
}

function CaseGovernanceDialog({ kind, caseId, onClose, onDone }: { kind: "close" | "hold" | { release: string }; caseId: string; onClose: () => void; onDone: (message: string) => void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState("");
  const save = useMutation(async () => {
    if (kind === "close") return api.post("/api/governance/approvals", { action: "case_close", subjectId: caseId, reason: reason.trim() });
    if (kind === "hold") return api.post("/api/governance/holds", { subjectType: "case", subjectId: caseId, caseId, reason: reason.trim() });
    return api.post(`/api/governance/holds/${kind.release}/release`, { reason: reason.trim() });
  });
  const title = kind === "close" ? t("gov.requestClose") : kind === "hold" ? t("gov.placeHold") : t("gov.release");
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      description={kind === "close" ? t("gov.closeHint") : kind === "hold" ? t("gov.holdHint") : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={reason.trim().length < 10}
            loading={save.pending}
            onClick={async () => (await save.run(undefined as never)) && onDone(kind === "close" ? t("gov.requested") : kind === "hold" ? t("gov.holdPlaced") : t("gov.released"))}
          >
            {title}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t("gov.reason")} required hint={t("gov.reasonHint")}>
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {save.error && <p role="alert" className="font-ui text-xs text-danger">{save.error.message}</p>}
      </div>
    </Modal>
  );
}
