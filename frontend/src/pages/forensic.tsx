import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Clock3, FlaskConical, Inbox, Microscope, Timer } from "lucide-react";
import { useQuery } from "../lib/useApi";
import { useI18n, type MessageKey } from "../i18n";
import { AsyncView, EmptyState } from "../components/DataState";
import { Card, PageHeader, Select, Stat } from "../components/ui";

/**
 * The laboratory's queue (2.0 · F14): every item on the lab's cases that is
 * on its way in or at the laboratory, with where its intake stands and how long
 * it has been there. Turnaround is measured from intake to report.
 */

type QueueStatus = "awaiting_custody" | "awaiting_intake" | "received" | "in_analysis" | "reported" | "returned";

interface QueueItem {
  evidence: { id: string; case_id: string; file_name: string; public_ref: string; kind: string; current_stage: string; cases?: { case_reference: string; title: string } | null };
  queueStatus: QueueStatus;
  intake: { seal_intact: boolean; recheck_matched: boolean | null } | null;
  hoursAtLab: number | null;
}

const ORDER: QueueStatus[] = ["awaiting_custody", "awaiting_intake", "received", "in_analysis", "reported", "returned"];

const TONE: Record<QueueStatus, string> = {
  awaiting_custody: "border-border bg-surface-2 text-muted",
  awaiting_intake: "border-warning-soft bg-warning-soft text-warning",
  received: "border-info-soft bg-info-soft text-info",
  in_analysis: "border-primary-soft bg-primary-soft text-primary",
  reported: "border-success-soft bg-success-soft text-success",
  returned: "border-border bg-surface-2 text-muted",
};

function hours(value: number | null, t: (k: MessageKey, v?: Record<string, string | number>) => string) {
  if (value === null) return "—";
  return value < 48 ? t("queue.hours", { n: value }) : t("queue.days", { n: Math.round((value / 24) * 10) / 10 });
}

export function ForensicInbox() {
  const { t } = useI18n();
  const queue = useQuery<{ items: QueueItem[]; turnaround: { caseId: string; reported: number; averageHours: number }[] }>("/api/lab/queue", [], { pollMs: 30_000 });
  const [filter, setFilter] = useState<QueueStatus | "">("");

  const counts = useMemo(() => {
    const c = Object.fromEntries(ORDER.map((s) => [s, 0])) as Record<QueueStatus, number>;
    for (const i of queue.data?.items ?? []) c[i.queueStatus] += 1;
    return c;
  }, [queue.data]);
  const avg = useMemo(() => {
    const rows = queue.data?.turnaround ?? [];
    const n = rows.reduce((a, r) => a + r.reported, 0);
    return n ? Math.round((rows.reduce((a, r) => a + r.averageHours * r.reported, 0) / n) * 10) / 10 : null;
  }, [queue.data]);

  return (
    <>
      <PageHeader eyebrow={t("nav.labQueue")} title={t("queue.title")} description={t("queue.intro")} />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t("queue.status.awaiting_custody")} value={queue.data ? counts.awaiting_custody : "—"} icon={<Inbox size={14} />} />
        <Stat label={t("queue.status.awaiting_intake")} value={queue.data ? counts.awaiting_intake : "—"} tone={counts.awaiting_intake ? "warning" : "default"} icon={<Clock3 size={14} />} />
        <Stat label={t("queue.status.in_analysis")} value={queue.data ? counts.received + counts.in_analysis : "—"} icon={<Microscope size={14} />} />
        <Stat label={t("queue.turnaround")} value={avg === null ? "—" : hours(avg, t)} icon={<Timer size={14} />} />
      </div>

      <Card
        title={t("queue.items")}
        subtitle={t("queue.itemsHint")}
        actions={
          <Select aria-label={t("alerts.filterStatus")} value={filter} onChange={(e) => setFilter(e.target.value as QueueStatus | "")} className="w-auto">
            <option value="">{t("alerts.all")}</option>
            {ORDER.map((s) => (
              <option key={s} value={s}>
                {t(`queue.status.${s}` as MessageKey)}
              </option>
            ))}
          </Select>
        }
      >
        <AsyncView
          state={queue}
          onRetry={queue.refetch}
          context="the laboratory queue"
          isEmpty={(d) => d.items.length === 0}
          empty={<EmptyState title={t("queue.empty")} description={t("queue.emptyHint")} icon={<FlaskConical size={19} />} />}
        >
          {(data) => {
            const rows = data.items
              .filter((i) => !filter || i.queueStatus === filter)
              .sort((a, b) => ORDER.indexOf(a.queueStatus) - ORDER.indexOf(b.queueStatus) || (b.hoursAtLab ?? 0) - (a.hoursAtLab ?? 0));
            return rows.length === 0 ? (
              <EmptyState title={t("queue.empty")} icon={<FlaskConical size={19} />} />
            ) : (
              <ul className="space-y-2.5">
                {rows.map((row) => (
                  <li key={row.evidence.id}>
                    <Link
                      to={`/forensic/cases/evidence/${row.evidence.id}`}
                      className="block rounded-card border border-border bg-surface-2 p-4 transition hover:border-primary"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-ui text-sm font-semibold text-text">{row.evidence.file_name}</p>
                          <p className="mt-0.5 font-ui text-2xs text-muted">
                            {row.evidence.cases?.case_reference ?? "—"} · <code className="font-mono">{row.evidence.public_ref}</code>
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                          <span className={`chip ${TONE[row.queueStatus]}`}>{t(`queue.status.${row.queueStatus}` as MessageKey)}</span>
                          {row.intake?.recheck_matched === false && <span className="chip border-danger-soft bg-danger-soft text-danger">{t("lab.recheckMismatch")}</span>}
                          {row.intake && !row.intake.seal_intact && <span className="chip border-warning-soft bg-warning-soft text-warning">{t("lab.sealBroken")}</span>}
                          {row.hoursAtLab !== null && <span className="chip border-border bg-surface text-muted">{hours(row.hoursAtLab, t)}</span>}
                        </div>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            );
          }}
        </AsyncView>
      </Card>
    </>
  );
}
