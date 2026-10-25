import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarClock, CheckSquare, Gavel, HelpCircle, KeyRound, LifeBuoy, Mail, MessageSquareWarning, Scale, ShieldCheck } from "lucide-react";
import { boundary, explainAssistance, explainCheckIn, explainSummons, type Explanation } from "@nyaysetu/integrity";
import { api, type CaseRow } from "../lib/api";
import { useMutation, useQuery } from "../lib/useApi";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { useI18n, type MessageKey } from "../i18n";
import { ROLE_HOME, formatDateTime, relativeTime } from "../lib/format";
import { AsyncView, EmptyState } from "../components/DataState";
import { Button, Card, Field, Input, Modal, PageHeader, Select, Textarea } from "../components/ui";

/**
 * Court-facing workflows (2.0 · F15–F19): prosecution readiness, hearings and
 * orders, defence access requests, objections, two-person approvals, ranked
 * bail compliance, and the accused person's obligations and help screen.
 */

function useCases() {
  return useQuery<{ cases: CaseRow[] }>("/api/cases");
}

function ReasonDialog({
  title,
  description,
  minLength,
  confirmLabel,
  children,
  onClose,
  onConfirm,
}: {
  title: string;
  description?: string;
  minLength: number;
  confirmLabel: string;
  children?: React.ReactNode;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState("");
  const act = useMutation(onConfirm);
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={reason.trim().length < minLength} loading={act.pending} onClick={async () => (await act.run(reason.trim())) !== null && onClose()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {children}
        <Field label={t("gov.reason")} required hint={t("court.minChars", { n: minLength })}>
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {act.error && (
          <p role="alert" className="font-ui text-xs text-danger">
            {act.error.message}
          </p>
        )}
      </div>
    </Modal>
  );
}

/* ================================================================== F15 */

interface ReadinessRow {
  id: string;
  case_reference: string;
  title: string;
  status: string;
  evidence: number;
  verified: number;
  pending: number;
  flagged: number;
  atCourt: number;
  openAlerts: number;
  custodyGaps: number;
}

export function ProsecutionReadiness({ basePath }: { basePath: string }) {
  const { t } = useI18n();
  const data = useQuery<{ cases: ReadinessRow[] }>("/api/court/prosecution");
  return (
    <Card title={t("court.readiness")} subtitle={t("court.readinessHint")}>
      <AsyncView state={data} onRetry={data.refetch} context="prosecution readiness" isEmpty={(d) => d.cases.length === 0} empty={<EmptyState title={t("dash.noCases")} icon={<Scale size={19} />} />}>
        {(d) => (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] font-ui text-xs">
              <thead>
                <tr className="border-b border-border text-left text-2xs uppercase tracking-wider text-faint">
                  <th className="py-2 pr-3">{t("capture.case")}</th>
                  <th className="py-2 pr-3 text-right">{t("court.items")}</th>
                  <th className="py-2 pr-3 text-right">{t("state.CONFIRMED")}</th>
                  <th className="py-2 pr-3 text-right">{t("court.pending")}</th>
                  <th className="py-2 pr-3 text-right">{t("state.INTEGRITY_MISMATCH")}</th>
                  <th className="py-2 pr-3 text-right">{t("nav.alerts")}</th>
                  <th className="py-2">{t("court.ready")}</th>
                </tr>
              </thead>
              <tbody>
                {d.cases.map((c) => {
                  const ready = c.evidence > 0 && c.verified === c.evidence && c.openAlerts === 0;
                  return (
                    <tr key={c.id} className="border-b border-border last:border-0">
                      <td className="py-2.5 pr-3">
                        <Link to={`${basePath}/${c.id}`} className="font-semibold text-text hover:text-primary">
                          {c.case_reference}
                        </Link>
                        <p className="max-w-[16rem] truncate text-2xs text-muted">{c.title}</p>
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">{c.evidence}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-success">{c.verified}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">{c.pending}</td>
                      <td className={`py-2.5 pr-3 text-right tabular-nums ${c.flagged ? "font-semibold text-danger" : ""}`}>{c.flagged}</td>
                      <td className={`py-2.5 pr-3 text-right tabular-nums ${c.openAlerts ? "text-warning" : ""}`}>
                        {c.openAlerts}
                        {c.custodyGaps ? ` (${t("court.gaps", { n: c.custodyGaps })})` : ""}
                      </td>
                      <td className="py-2.5">
                        <span className={`chip ${ready ? "border-success-soft bg-success-soft text-success" : "border-border bg-surface-2 text-muted"}`}>
                          {ready ? t("court.readyYes") : t("court.readyNo")}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </AsyncView>
    </Card>
  );
}

/* ================================================================== F17 */

const EVENT_KINDS = ["hearing", "order", "adjournment", "direction", "judgment"] as const;

export function HearingsPage() {
  const { t } = useI18n();
  const toast = useToast();
  const { user } = useAuth();
  const cases = useCases();
  const hearings = useQuery<{ hearings: { id: string; case_id: string; title: string; scheduled_for: string; cases?: { case_reference: string; title: string } }[] }>("/api/court/hearings");
  const [form, setForm] = useState({ caseId: "", kind: "hearing" as (typeof EVENT_KINDS)[number], title: "", body: "", scheduledFor: "" });
  const save = useMutation(async () =>
    api.post(`/api/court/cases/${form.caseId}/events`, {
      kind: form.kind,
      title: form.title.trim(),
      body: form.body.trim() || null,
      scheduledFor: form.scheduledFor ? new Date(form.scheduledFor).toISOString() : null,
    })
  );
  const needsDate = form.kind === "hearing" || form.kind === "adjournment";
  const base = user ? `${ROLE_HOME[user.role]}/cases` : "";

  return (
    <>
      <PageHeader eyebrow={t("nav.hearings")} title={t("court.hearingsTitle")} description={t("court.hearingsIntro")} />
      <div className="grid gap-5 lg:grid-cols-[1fr_1.1fr]">
        <Card title={t("court.newEvent")}>
          <div className="space-y-4">
            <Field label={t("capture.case")} required>
              <Select value={form.caseId} onChange={(e) => setForm({ ...form, caseId: e.target.value })}>
                <option value="">{t("capture.selectCase")}</option>
                {(cases.data?.cases ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.case_reference} — {c.title}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("court.eventKind")} required>
                <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as (typeof EVENT_KINDS)[number] })}>
                  {EVENT_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {t(`court.kind.${k}` as MessageKey)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("court.scheduledFor")} required={needsDate}>
                <Input type="datetime-local" value={form.scheduledFor} onChange={(e) => setForm({ ...form, scheduledFor: e.target.value })} />
              </Field>
            </div>
            <Field label={t("court.eventTitle")} required>
              <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </Field>
            <Field label={t("court.eventBody")}>
              <Textarea rows={4} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
            </Field>
            {save.error && <p role="alert" className="font-ui text-xs text-danger">{save.error.message}</p>}
            <Button
              full
              icon={<Gavel size={14} />}
              disabled={!form.caseId || form.title.trim().length < 3 || (needsDate && !form.scheduledFor)}
              loading={save.pending}
              onClick={async () => {
                if (await save.run(undefined as never)) {
                  toast.success(t("court.eventRecorded"));
                  setForm({ ...form, title: "", body: "", scheduledFor: "" });
                  hearings.refetch();
                }
              }}
            >
              {t("court.recordEvent")}
            </Button>
          </div>
        </Card>
        <Card title={t("court.upcoming")}>
          <AsyncView state={hearings} onRetry={hearings.refetch} context="hearings" isEmpty={(d) => d.hearings.length === 0} empty={<EmptyState title={t("court.noHearings")} icon={<CalendarClock size={19} />} />}>
            {(d) => (
              <ul className="space-y-2.5">
                {d.hearings.map((h) => (
                  <li key={h.id} className="rounded-xl border border-border bg-surface-2 p-3.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="font-ui text-sm font-semibold text-text">{formatDateTime(h.scheduled_for)}</p>
                      <span className="font-ui text-2xs text-faint">{relativeTime(h.scheduled_for)}</span>
                    </div>
                    <p className="mt-0.5 font-ui text-xs text-text">{h.title}</p>
                    <Link to={`${base}/${h.case_id}`} className="font-mono text-2xs text-primary hover:underline">
                      {h.cases?.case_reference}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </AsyncView>
        </Card>
      </div>
    </>
  );
}

/** Court events and objections on the case dossier. */
export function CourtRecordCard({ caseId }: { caseId: string }) {
  const { t } = useI18n();
  const { user } = useAuth();
  const toast = useToast();
  const events = useQuery<{ events: { id: string; kind: string; title: string; body: string | null; scheduled_for: string | null; created_at: string }[] }>(`/api/court/cases/${caseId}/events`);
  const objections = useQuery<{ objections: { id: string; evidence_id: string | null; grounds: string; status: string; ruling: string | null; created_at: string }[] }>(
    user?.role === "accused" ? null : `/api/court/cases/${caseId}/objections`
  );
  const [filing, setFiling] = useState(false);
  const [ruling, setRuling] = useState<{ id: string; outcome: "upheld" | "dismissed" } | null>(null);
  const canFile = user?.role === "defence_lawyer" || user?.role === "prosecutor";
  const canRule = user?.role === "judge" || user?.role === "court_admin";

  return (
    <Card title={t("court.record")} subtitle={t("court.recordHint")} actions={canFile ? <Button size="sm" variant="secondary" icon={<MessageSquareWarning size={13} />} onClick={() => setFiling(true)}>{t("court.fileObjection")}</Button> : undefined}>
      <div className="space-y-4">
        {(events.data?.events.length ?? 0) === 0 && (objections.data?.objections.length ?? 0) === 0 ? (
          <p className="font-ui text-xs text-muted">{t("court.nothingYet")}</p>
        ) : null}
        {(events.data?.events.length ?? 0) > 0 && (
          <ol className="space-y-2 border-l-2 border-border pl-4">
            {events.data!.events.map((e) => (
              <li key={e.id}>
                <p className="font-ui text-xs font-semibold text-text">
                  {t(`court.kind.${e.kind}` as MessageKey)} · {e.title}
                </p>
                <p className="font-ui text-2xs text-muted">{e.scheduled_for ? formatDateTime(e.scheduled_for) : formatDateTime(e.created_at)}</p>
                {e.body && <p className="mt-0.5 whitespace-pre-line font-ui text-xs text-muted">{e.body}</p>}
              </li>
            ))}
          </ol>
        )}
        {(objections.data?.objections.length ?? 0) > 0 && (
          <div>
            <p className="mb-1.5 font-ui text-xs font-semibold text-text">{t("court.objections")}</p>
            <ul className="space-y-2">
              {objections.data!.objections.map((o) => (
                <li key={o.id} className="rounded-lg bg-surface-2 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="chip border-border bg-surface text-muted">{t(`court.objection.${o.status}` as MessageKey)}</span>
                    <span className="font-ui text-2xs text-faint">{formatDateTime(o.created_at)}</span>
                  </div>
                  <p className="mt-1 font-ui text-xs text-text">{o.grounds}</p>
                  {o.ruling && <p className="mt-1 font-ui text-xs text-muted">{t("court.ruling")}: {o.ruling}</p>}
                  {canRule && o.status === "open" && (
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" variant="secondary" onClick={() => setRuling({ id: o.id, outcome: "upheld" })}>
                        {t("court.uphold")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRuling({ id: o.id, outcome: "dismissed" })}>
                        {t("court.dismiss")}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {filing && (
        <ReasonDialog
          title={t("court.fileObjection")}
          description={t("court.objectionHint")}
          minLength={10}
          confirmLabel={t("court.fileObjection")}
          onClose={() => setFiling(false)}
          onConfirm={async (grounds) => {
            await api.post("/api/court/objections", { caseId, grounds });
            toast.success(t("court.objectionFiled"));
            objections.refetch();
          }}
        />
      )}
      {ruling && (
        <ReasonDialog
          title={ruling.outcome === "upheld" ? t("court.uphold") : t("court.dismiss")}
          minLength={10}
          confirmLabel={ruling.outcome === "upheld" ? t("court.uphold") : t("court.dismiss")}
          onClose={() => setRuling(null)}
          onConfirm={async (text) => {
            await api.post(`/api/court/objections/${ruling.id}/rule`, { outcome: ruling.outcome, ruling: text });
            objections.refetch();
          }}
        />
      )}
    </Card>
  );
}

/* ================================================================== F16 */

interface AccessRequest {
  id: string;
  case_id: string;
  reason: string;
  status: "pending" | "granted" | "refused" | "withdrawn";
  decision_reason: string | null;
  decided_at: string | null;
  created_at: string;
  requester_name: string | null;
  cases?: { case_reference: string; title: string } | null;
}

export function AccessRequestsPage() {
  const { t } = useI18n();
  const toast = useToast();
  const { user } = useAuth();
  const isDefence = user?.role === "defence_lawyer";
  const list = useQuery<{ requests: AccessRequest[] }>("/api/court/access-requests");
  const [form, setForm] = useState({ caseReference: "", reason: "" });
  const [deciding, setDeciding] = useState<{ request: AccessRequest; grant: boolean } | null>(null);
  const create = useMutation(async () => api.post("/api/court/access-requests", { caseReference: form.caseReference.trim(), reason: form.reason.trim() }));
  const withdraw = useMutation(async (id: string) => api.post(`/api/court/access-requests/${id}/withdraw`));

  return (
    <>
      <PageHeader eyebrow={t("nav.accessRequests")} title={t("court.accessTitle")} description={isDefence ? t("court.accessIntroDefence") : t("court.accessIntroJudge")} />
      <div className={`grid gap-5 ${isDefence ? "lg:grid-cols-[1fr_1.2fr]" : ""}`}>
        {isDefence && (
          <Card title={t("court.requestAccess")}>
            <div className="space-y-4">
              <Field label={t("court.caseReference")} required>
                <Input value={form.caseReference} onChange={(e) => setForm({ ...form, caseReference: e.target.value })} placeholder="NS-2026-000123" />
              </Field>
              <Field label={t("court.accessReason")} required hint={t("court.minChars", { n: 10 })}>
                <Textarea rows={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
              </Field>
              {create.error && <p role="alert" className="font-ui text-xs text-danger">{create.error.message}</p>}
              <Button
                full
                icon={<KeyRound size={14} />}
                disabled={form.caseReference.trim().length < 5 || form.reason.trim().length < 10}
                loading={create.pending}
                onClick={async () => {
                  if (await create.run(undefined as never)) {
                    toast.success(t("court.accessSent"));
                    setForm({ caseReference: "", reason: "" });
                    list.refetch();
                  }
                }}
              >
                {t("court.requestAccess")}
              </Button>
              <p className="font-ui text-2xs leading-relaxed text-faint">{t("court.readOnlyGrant")}</p>
            </div>
          </Card>
        )}
        <Card title={t("court.requests")}>
          <AsyncView state={list} onRetry={list.refetch} context="access requests" isEmpty={(d) => d.requests.length === 0} empty={<EmptyState title={t("court.noRequests")} icon={<KeyRound size={19} />} />}>
            {(d) => (
              <ul className="space-y-2.5">
                {d.requests.map((r) => (
                  <li key={r.id} className="rounded-xl border border-border bg-surface-2 p-3.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-ui text-sm font-semibold text-text">{r.cases?.case_reference}</span>
                      <span className="chip border-border bg-surface text-muted">{t(`court.access.${r.status}` as MessageKey)}</span>
                      <span className="ml-auto font-ui text-2xs text-faint">{relativeTime(r.created_at)}</span>
                    </div>
                    {!isDefence && r.requester_name && <p className="mt-1 font-ui text-2xs text-muted">{r.requester_name}</p>}
                    <p className="mt-1 font-ui text-xs text-text">{r.reason}</p>
                    {r.decision_reason && <p className="mt-1 font-ui text-xs text-muted">{t("court.decision")}: {r.decision_reason}</p>}
                    {r.status === "pending" && (
                      <div className="mt-2.5 flex flex-wrap gap-2">
                        {isDefence ? (
                          <Button size="sm" variant="ghost" loading={withdraw.pending} onClick={async () => (await withdraw.run(r.id)) && list.refetch()}>
                            {t("court.withdraw")}
                          </Button>
                        ) : (
                          <>
                            <Button size="sm" icon={<ShieldCheck size={12} />} onClick={() => setDeciding({ request: r, grant: true })}>
                              {t("court.grant")}
                            </Button>
                            <Button size="sm" variant="secondary" onClick={() => setDeciding({ request: r, grant: false })}>
                              {t("court.refuse")}
                            </Button>
                          </>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </AsyncView>
        </Card>
      </div>
      {deciding && (
        <ReasonDialog
          title={deciding.grant ? t("court.grant") : t("court.refuse")}
          description={deciding.grant ? t("court.readOnlyGrant") : undefined}
          minLength={5}
          confirmLabel={deciding.grant ? t("court.grant") : t("court.refuse")}
          onClose={() => setDeciding(null)}
          onConfirm={async (reason) => {
            await api.post(`/api/court/access-requests/${deciding.request.id}/decide`, { grant: deciding.grant, reason });
            list.refetch();
          }}
        />
      )}
    </>
  );
}

/* ================================================================== F19 */

interface Approval {
  id: string;
  action: string;
  subject_type: string;
  subject_id: string;
  case_id: string;
  requested_by: string;
  requested_role: string;
  reason: string;
  payload: { method?: string } | null;
  status: string;
  approver_reason: string | null;
  created_at: string;
  cases?: { case_reference: string; title: string } | null;
}

export function ApprovalsPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [status, setStatus] = useState("pending");
  const list = useQuery<{ approvals: Approval[] }>(`/api/governance/approvals${status ? `?status=${status}` : ""}`, [status]);
  const [deciding, setDeciding] = useState<{ approval: Approval; decision: "approve" | "reject" } | null>(null);
  const base = user ? `${ROLE_HOME[user.role]}/cases` : "";

  return (
    <>
      <PageHeader eyebrow={t("nav.approvals")} title={t("court.approvalsTitle")} description={t("gov.twoPeople")} />
      <div className="mb-5 flex items-center gap-3">
        <label htmlFor="approval-status" className="font-ui text-xs font-semibold text-muted">
          {t("alerts.filterStatus")}
        </label>
        <Select id="approval-status" className="w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          {["pending", "executed", "rejected"].map((s) => (
            <option key={s} value={s}>
              {t(`gov.status.${s}` as MessageKey)}
            </option>
          ))}
          <option value="">{t("alerts.all")}</option>
        </Select>
      </div>
      <AsyncView state={list} onRetry={list.refetch} context="approvals" isEmpty={(d) => d.approvals.length === 0} empty={<EmptyState title={t("court.noApprovals")} icon={<CheckSquare size={19} />} />}>
        {(d) => (
          <ul className="space-y-3">
            {d.approvals.map((a) => {
              const own = a.requested_by === user?.id;
              return (
                <li key={a.id} className="panel p-4 sm:p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-ui text-sm font-semibold text-text">{t(`gov.action.${a.action}` as MessageKey)}</span>
                    <span className="chip border-border bg-surface-2 text-muted">{t(`gov.status.${a.status}` as MessageKey)}</span>
                    {a.payload?.method && <span className="chip border-border bg-surface-2 text-muted">{t(`gov.method.${a.payload.method}` as MessageKey)}</span>}
                    <span className="ml-auto font-ui text-2xs text-faint">{relativeTime(a.created_at)}</span>
                  </div>
                  <p className="mt-1 font-ui text-2xs text-muted">
                    <Link to={`${base}/${a.case_id}`} className="font-mono text-primary hover:underline">
                      {a.cases?.case_reference}
                    </Link>{" "}
                    · {t(`role.${a.requested_role}` as MessageKey)}
                  </p>
                  <p className="mt-2 font-ui text-sm text-text">{a.reason}</p>
                  {a.approver_reason && <p className="mt-1 font-ui text-xs text-muted">{t("court.decision")}: {a.approver_reason}</p>}
                  {a.status === "pending" &&
                    (own ? (
                      <p className="mt-2 font-ui text-2xs text-faint">{t("court.ownRequest")}</p>
                    ) : (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button size="sm" onClick={() => setDeciding({ approval: a, decision: "approve" })}>
                          {t("court.approve")}
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setDeciding({ approval: a, decision: "reject" })}>
                          {t("court.reject")}
                        </Button>
                      </div>
                    ))}
                </li>
              );
            })}
          </ul>
        )}
      </AsyncView>
      {deciding && (
        <ReasonDialog
          title={deciding.decision === "approve" ? t("court.approve") : t("court.reject")}
          description={deciding.decision === "approve" ? t("court.approveHint") : undefined}
          minLength={5}
          confirmLabel={deciding.decision === "approve" ? t("court.approve") : t("court.reject")}
          onClose={() => setDeciding(null)}
          onConfirm={async (reason) => {
            await api.post(`/api/governance/approvals/${deciding.approval.id}/decide`, { decision: deciding.decision, reason });
            list.refetch();
          }}
        />
      )}
    </>
  );
}

/* ============================================================ F17 bail */

interface RankedViolation {
  id: string;
  caseId: string;
  kind: string;
  reason: string;
  detectedAt: string;
  severity: "critical" | "serious" | "moderate" | "minor";
  why: string;
  explanation: { reason: string; category: string; submittedAt: string } | null;
  courtFinding: string | null;
}

const FINDINGS = ["no_violation", "gps_drift", "technical", "violation", "absconding"] as const;
const SEVERITY_TONE = {
  critical: "border-danger bg-danger-soft text-danger",
  serious: "border-danger-soft bg-danger-soft text-danger",
  moderate: "border-warning-soft bg-warning-soft text-warning",
  minor: "border-border bg-surface-2 text-muted",
} as const;

export function BailComplianceCard() {
  const { t } = useI18n();
  const { user } = useAuth();
  const data = useQuery<{ violations: RankedViolation[] }>("/api/court/bail/compliance");
  const record = useMutation(async (input: { id: string; finding: string }) => api.post(`/api/court/violations/${input.id}/finding`, { finding: input.finding }));
  const canFind = user?.role === "judge" || user?.role === "court_admin";

  return (
    <Card title={t("court.complianceTitle")} subtitle={t("court.complianceHint")}>
      <AsyncView state={data} onRetry={data.refetch} context="bail compliance" isEmpty={(d) => d.violations.length === 0} empty={<EmptyState title={t("court.noViolations")} icon={<Scale size={19} />} />}>
        {(d) => (
          <ul className="space-y-2.5">
            {d.violations.map((v) => (
              <li key={v.id} className="rounded-xl border border-border bg-surface-2 p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`chip ${SEVERITY_TONE[v.severity]}`}>{t(`court.severity.${v.severity}` as MessageKey)}</span>
                  <span className="font-ui text-xs font-semibold text-text">{v.kind.replace(/_/g, " ").toLowerCase()}</span>
                  <span className="ml-auto font-ui text-2xs text-faint">{formatDateTime(v.detectedAt)}</span>
                </div>
                <p className="mt-1 font-ui text-xs text-muted">{v.why}</p>
                {v.explanation && (
                  <p className="mt-1.5 rounded-lg bg-info-soft px-3 py-2 font-ui text-xs text-text">
                    <strong>{t(`court.category.${v.explanation.category}` as MessageKey)}:</strong> {v.explanation.reason}
                  </p>
                )}
                {canFind && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label className="font-ui text-2xs text-muted" htmlFor={`finding-${v.id}`}>
                      {t("court.finding")}
                    </label>
                    <Select
                      id={`finding-${v.id}`}
                      className="w-auto"
                      value={v.courtFinding ?? ""}
                      disabled={record.pending}
                      onChange={async (e) => {
                        if (e.target.value && (await record.run({ id: v.id, finding: e.target.value }))) data.refetch();
                      }}
                    >
                      <option value="">{t("court.noFinding")}</option>
                      {FINDINGS.map((f) => (
                        <option key={f} value={f}>
                          {t(`court.findingValue.${f}` as MessageKey)}
                        </option>
                      ))}
                    </Select>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </AsyncView>
      <p className="mt-3 font-ui text-2xs leading-relaxed text-faint">{t("alerts.neverPenalise")}</p>
    </Card>
  );
}

/* ================================================================== F18 */

interface Obligations {
  bail: {
    bailId: string;
    caseReference: string | null;
    active: boolean;
    nextDueAt: string;
    overdue: boolean;
    lastCheckIn: { occurred_at: string; within_fence: boolean } | null;
    missed: { id: string; detected_at: string; explained: boolean }[];
  }[];
  summons: { id: string; status: "PENDING" | "DELIVERED" | "FAILED"; expiry_at: string | null; hearing_at: string | null; cases?: { case_reference: string } | null }[];
}

const TONE_STYLE: Record<Explanation["tone"], string> = {
  ok: "border-success-soft bg-success-soft",
  pending: "border-info-soft bg-info-soft",
  attention: "border-warning-soft bg-warning-soft",
  problem: "border-danger-soft bg-danger-soft",
};

function ExplanationBox({ e }: { e: Explanation }) {
  return (
    <div className={`rounded-xl border p-4 ${TONE_STYLE[e.tone]}`}>
      <p className="font-ui text-base font-semibold text-text">{e.title}</p>
      <p className="mt-1 font-ui text-sm leading-relaxed text-text">{e.body}</p>
      {e.next && <p className="mt-2 font-ui text-sm font-semibold text-text">{e.next}</p>}
    </div>
  );
}

export function ObligationsCard() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const data = useQuery<Obligations>("/api/court/me/obligations", [], { pollMs: 60_000 });
  const [explaining, setExplaining] = useState<{ bailId: string; violationId: string } | null>(null);
  const [category, setCategory] = useState("network");

  return (
    <Card title={t("accused.obligations")} subtitle={t("accused.obligationsHint")}>
      <AsyncView state={data} onRetry={data.refetch} context="your obligations" isEmpty={(d) => d.bail.length === 0 && d.summons.length === 0} empty={<EmptyState title={t("accused.noObligations")} icon={<ShieldCheck size={19} />} />}>
        {(d) => (
          <div className="space-y-4">
            {d.bail
              .filter((b) => b.active)
              .map((b) => {
                const hoursUntilDue = Math.round((new Date(b.nextDueAt).getTime() - Date.now()) / 360_000) / 10;
                const e = explainCheckIn({ state: b.overdue ? "OVERDUE" : "DUE", hoursUntilDue }, lang);
                return (
                  <div key={b.bailId} className="space-y-2">
                    <p className="font-mono text-2xs text-muted">{b.caseReference}</p>
                    <ExplanationBox e={e} />
                    <p className="font-ui text-xs text-muted">
                      {t("accused.nextDue")}: <strong className="text-text">{formatDateTime(b.nextDueAt)}</strong>
                    </p>
                    {b.missed
                      .filter((m) => !m.explained)
                      .map((m) => (
                        <div key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2">
                          <span className="font-ui text-xs text-text">
                            {t("accused.missedOn")} {formatDateTime(m.detected_at)}
                          </span>
                          <Button size="sm" variant="secondary" onClick={() => setExplaining({ bailId: b.bailId, violationId: m.id })}>
                            {t("accused.giveReason")}
                          </Button>
                        </div>
                      ))}
                  </div>
                );
              })}
            {d.summons.map((s) => {
              const hoursRemaining = s.expiry_at ? Math.round((new Date(s.expiry_at).getTime() - Date.now()) / 360_000) / 10 : null;
              return (
                <div key={s.id} className="space-y-1">
                  <p className="font-mono text-2xs text-muted">{s.cases?.case_reference}</p>
                  <ExplanationBox e={explainSummons({ status: s.status, hoursRemaining, hearingAt: s.hearing_at ? formatDateTime(s.hearing_at) : null }, lang)} />
                </div>
              );
            })}
            <p className="font-ui text-2xs leading-relaxed text-faint">{boundary(lang)}</p>
          </div>
        )}
      </AsyncView>
      {explaining && (
        <ReasonDialog
          title={t("accused.giveReason")}
          description={t("accused.reasonHint")}
          minLength={5}
          confirmLabel={t("common.submit")}
          onClose={() => setExplaining(null)}
          onConfirm={async (reason) => {
            await api.post(`/api/court/bail/${explaining.bailId}/explanations`, { violationId: explaining.violationId, category, reason });
            toast.success(t("accused.reasonSent"));
            data.refetch();
          }}
        >
          <Field label={t("accused.reasonCategory")} required>
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {["medical", "network", "device", "travel_permitted", "other"].map((c) => (
                <option key={c} value={c}>
                  {t(`court.category.${c}` as MessageKey)}
                </option>
              ))}
            </Select>
          </Field>
        </ReasonDialog>
      )}
    </Card>
  );
}

export function NotificationsCard() {
  const { t } = useI18n();
  const data = useQuery<{ notifications: { id: string; subject: string; body: string; created_at: string }[] }>("/api/court/me/notifications");
  if (!data.data || data.data.notifications.length === 0) return null;
  return (
    <Card title={t("accused.notifications")}>
      <ul className="space-y-2">
        {data.data.notifications.slice(0, 10).map((n) => (
          <li key={n.id} className="flex gap-2.5 rounded-lg bg-surface-2 px-3 py-2">
            <Mail size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden />
            <div>
              <p className="font-ui text-xs font-semibold text-text">{n.subject}</p>
              <p className="font-ui text-xs text-muted">{n.body}</p>
              <p className="font-ui text-2xs text-faint">{relativeTime(n.created_at)}</p>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function AccusedHelpPage() {
  const { t, lang } = useI18n();
  const help = useMemo(() => explainAssistance(lang), [lang]);
  const questions: { q: MessageKey; a: MessageKey }[] = [
    { q: "help.q.checkin", a: "help.a.checkin" },
    { q: "help.q.missed", a: "help.a.missed" },
    { q: "help.q.summons", a: "help.a.summons" },
    { q: "help.q.location", a: "help.a.location" },
    { q: "help.q.data", a: "help.a.data" },
  ];
  return (
    <>
      <PageHeader eyebrow={t("nav.help")} title={t("help.title")} description={t("help.intro")} />
      <div className="grid gap-5 lg:grid-cols-[1.3fr_1fr]">
        <Card title={t("help.questions")}>
          <div className="space-y-2">
            {questions.map(({ q, a }) => (
              <details key={q} className="group rounded-xl border border-border bg-surface-2 px-4 py-3">
                <summary className="flex cursor-pointer list-none items-center gap-2 font-ui text-sm font-semibold text-text">
                  <HelpCircle size={15} className="shrink-0 text-primary" aria-hidden /> {t(q)}
                </summary>
                <p className="mt-2 font-ui text-sm leading-relaxed text-muted">{t(a)}</p>
              </details>
            ))}
          </div>
        </Card>
        <div className="space-y-5">
          <Card title={help.title}>
            <div className="flex gap-3">
              <LifeBuoy size={18} className="mt-0.5 shrink-0 text-primary" aria-hidden />
              <div>
                <p className="font-ui text-sm leading-relaxed text-text">{help.body}</p>
                {help.next && <p className="mt-2 font-ui text-xs text-muted">{help.next}</p>}
              </div>
            </div>
          </Card>
          <NotificationsCard />
          <p className="font-ui text-2xs leading-relaxed text-faint">{boundary(lang)}</p>
        </div>
      </div>
    </>
  );
}
