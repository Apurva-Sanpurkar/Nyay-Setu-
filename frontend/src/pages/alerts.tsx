import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertOctagon, BellRing, CheckCircle2, Info, MessageSquare, TriangleAlert } from "lucide-react";
import { api } from "../lib/api";
import { useQuery, useMutation } from "../lib/useApi";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { useI18n, type MessageKey } from "../i18n";
import { ROLE_HOME, formatDateTime, relativeTime } from "../lib/format";
import { AsyncView, EmptyState } from "../components/DataState";
import { Button, Card, Modal, PageHeader, Select, Textarea } from "../components/ui";

/**
 * Discrepancy alerts (2.0 · F4): what could not be verified, why, and what a
 * person decided about it. An alert never penalises anyone by itself.
 */

interface Alert {
  id: string;
  case_id: string | null;
  evidence_id: string | null;
  kind: string;
  severity: "info" | "warning" | "serious";
  explanation: string;
  status: "open" | "acknowledged" | "resolved";
  detected_at: string;
  resolution: string | null;
  cases?: { case_reference: string; title: string } | null;
}

const SEVERITY_STYLE = {
  serious: { cls: "border-danger-soft bg-danger-soft text-danger", Icon: AlertOctagon },
  warning: { cls: "border-warning-soft bg-warning-soft text-warning", Icon: TriangleAlert },
  info: { cls: "border-info-soft bg-info-soft text-info", Icon: Info },
} as const;

export function SeverityChip({ severity }: { severity: Alert["severity"] }) {
  const { t } = useI18n();
  const { cls, Icon } = SEVERITY_STYLE[severity];
  return (
    <span className={`chip ${cls}`}>
      <Icon size={11} aria-hidden /> {t(`alerts.severity.${severity}` as MessageKey)}
    </span>
  );
}

export function AlertsPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [status, setStatus] = useState<string>("open");
  const [selected, setSelected] = useState<Alert | null>(null);
  const alerts = useQuery<{ alerts: Alert[] }>(`/api/alerts${status ? `?status=${status}` : ""}`, [status]);
  const canHandle = user?.role !== "defence_lawyer";

  return (
    <>
      <PageHeader eyebrow={t("nav.alerts")} title={t("alerts.title")} description={t("alerts.intro")} />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <label className="font-ui text-xs font-semibold text-muted" htmlFor="alert-status">
          {t("alerts.filterStatus")}
        </label>
        <Select id="alert-status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
          <option value="open">{t("alerts.status.open")}</option>
          <option value="acknowledged">{t("alerts.status.acknowledged")}</option>
          <option value="resolved">{t("alerts.status.resolved")}</option>
          <option value="">{t("alerts.all")}</option>
        </Select>
      </div>
      <p className="mb-5 flex gap-2 rounded-xl bg-info-soft px-4 py-3 font-ui text-xs leading-relaxed text-text">
        <Info size={14} className="mt-0.5 shrink-0 text-info" aria-hidden /> {t("alerts.neverPenalise")}
      </p>

      <AsyncView
        state={alerts}
        onRetry={alerts.refetch}
        context="alerts"
        isEmpty={(d) => d.alerts.length === 0}
        empty={<EmptyState title={t("alerts.none")} icon={<CheckCircle2 size={19} />} />}
      >
        {(data) => (
          <ul className="space-y-3">
            {data.alerts.map((alert) => (
              <li key={alert.id}>
                <button
                  type="button"
                  onClick={() => setSelected(alert)}
                  className="panel w-full p-4 text-left transition hover:-translate-y-0.5 hover:border-primary-ring sm:p-5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <SeverityChip severity={alert.severity} />
                    <span className="chip border-border bg-surface-2 text-muted">{t(`alerts.kind.${alert.kind}` as MessageKey)}</span>
                    <span className="chip border-border bg-surface-2 text-muted">{t(`alerts.status.${alert.status}` as MessageKey)}</span>
                    <span className="ml-auto font-ui text-2xs text-faint">{relativeTime(alert.detected_at)}</span>
                  </div>
                  <p className="mt-2.5 font-ui text-sm leading-relaxed text-text">{alert.explanation}</p>
                  {alert.cases && <p className="mt-1.5 font-mono text-2xs text-muted">{alert.cases.case_reference}</p>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </AsyncView>

      {selected && (
        <AlertDialog
          alert={selected}
          canHandle={canHandle}
          evidenceBase={user ? `${ROLE_HOME[user.role]}/cases/evidence/` : ""}
          onClose={() => setSelected(null)}
          onChanged={() => {
            alerts.refetch();
            setSelected(null);
          }}
        />
      )}
    </>
  );
}

function AlertDialog({
  alert,
  canHandle,
  evidenceBase,
  onClose,
  onChanged,
}: {
  alert: Alert;
  canHandle: boolean;
  evidenceBase: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const detail = useQuery<{ comments: { id: string; author_role: string; body: string; created_at: string }[] }>(`/api/alerts/${alert.id}`);
  const [comment, setComment] = useState("");
  const [resolution, setResolution] = useState("");

  const act = useMutation(async (kind: "acknowledge" | "comment" | "resolve") => {
    if (kind === "acknowledge") return api.post(`/api/alerts/${alert.id}/acknowledge`);
    if (kind === "comment") return api.post(`/api/alerts/${alert.id}/comments`, { body: comment });
    return api.post(`/api/alerts/${alert.id}/resolve`, { resolution });
  });

  return (
    <Modal open onClose={onClose} title={t(`alerts.kind.${alert.kind}` as MessageKey)} description={formatDateTime(alert.detected_at)} width="max-w-2xl">
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <SeverityChip severity={alert.severity} />
          <span className="chip border-border bg-surface-2 text-muted">{t(`alerts.status.${alert.status}` as MessageKey)}</span>
        </div>
        <p className="font-ui text-sm leading-relaxed text-text">{alert.explanation}</p>
        {alert.evidence_id && (
          <Link to={`${evidenceBase}${alert.evidence_id}`} className="inline-block font-ui text-xs font-semibold text-primary hover:underline">
            {t("capture.openItem")}
          </Link>
        )}
        {alert.resolution && (
          <p className="rounded-xl bg-success-soft p-3 font-ui text-xs text-text">
            <strong>{t("alerts.resolution")}:</strong> {alert.resolution}
          </p>
        )}

        <div>
          <p className="mb-2 flex items-center gap-1.5 font-ui text-xs font-semibold text-text">
            <MessageSquare size={13} aria-hidden /> {t("alerts.comments")}
          </p>
          <ul className="space-y-2">
            {(detail.data?.comments ?? []).map((c) => (
              <li key={c.id} className="rounded-lg bg-surface-2 px-3 py-2">
                <p className="font-ui text-xs text-text">{c.body}</p>
                <p className="mt-0.5 font-ui text-2xs text-faint">
                  {t(`role.${c.author_role}` as MessageKey)} · {formatDateTime(c.created_at)}
                </p>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-2">
            <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t("alerts.commentPlaceholder")} aria-label={t("alerts.comment")} />
            <Button
              size="sm"
              variant="secondary"
              disabled={!comment.trim()}
              loading={act.pending}
              onClick={async () => {
                if (await act.run("comment")) {
                  setComment("");
                  detail.refetch();
                }
              }}
            >
              {t("alerts.send")}
            </Button>
          </div>
        </div>

        {canHandle && alert.status !== "resolved" && (
          <div className="space-y-2 border-t border-border pt-4">
            <Textarea rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder={t("alerts.resolutionHint")} aria-label={t("alerts.resolution")} />
            <div className="flex flex-wrap gap-2">
              {alert.status === "open" && (
                <Button size="sm" variant="secondary" icon={<BellRing size={12} />} loading={act.pending} onClick={async () => (await act.run("acknowledge")) && (toast.success(t("alerts.status.acknowledged")), onChanged())}>
                  {t("alerts.acknowledge")}
                </Button>
              )}
              <Button size="sm" disabled={resolution.trim().length < 10} loading={act.pending} onClick={async () => (await act.run("resolve")) && (toast.success(t("alerts.status.resolved")), onChanged())}>
                {t("alerts.resolve")}
              </Button>
            </div>
          </div>
        )}
        {act.error && <p role="alert" className="font-ui text-xs text-danger">{act.error.message}</p>}
      </div>
    </Modal>
  );
}
