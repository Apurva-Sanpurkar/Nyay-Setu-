import { Link } from "react-router-dom";
import { ClipboardList, Inbox, PackageCheck, ScrollText, TrendingUp } from "lucide-react";
import { api, type CaseRow, type EvidenceRow, type SummonsRow } from "../lib/api";
import { useMutation, useQuery } from "../lib/useApi";
import { formatDateTime, formatDuration, relativeTime } from "../lib/format";
import { AsyncView, EmptyState } from "../components/DataState";
import { Button, Card, Field, Input, Modal, PageHeader, Select, Stat } from "../components/ui";
import { IntegrityBadge, StageChip, SummonsStatusChip, TxLink } from "../components/trust";
import { useState } from "react";
import { useToast } from "../context/ToastContext";
import { ProsecutionReadiness } from "./court";

/**
 * The prosecutor's view.
 *
 * Their job in this system is to take custody of evidence for trial, review the
 * chain behind it, and see the delivery state of every summons on their cases.
 * They cannot issue a summons or grant bail; both belong to the court.
 */
export function ProsecutorDashboard() {
  const cases = useQuery<{ cases: CaseRow[] }>("/api/cases");
  const inbox = useQuery<{ items: EvidenceRow[] }>("/api/evidence/inbox", [], { pollMs: 30_000 });
  const summons = useQuery<{
    summons: SummonsRow[];
    counts: { pending: number; delivered: number; failed: number };
  }>("/api/summons/court/overview", [], { pollMs: 60_000 });
  const [delayOpen, setDelayOpen] = useState(false);

  return (
    <>
      <PageHeader
        eyebrow="Prosecution portal"
        title="Case preparation"
        description="Accept custody of examined evidence, review the verified chain of custody for each item, and monitor service of process across your cases."
        actions={
          <Button variant="secondary" icon={<TrendingUp size={14} />} onClick={() => setDelayOpen(true)}>
            Estimate disposal time
          </Button>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Cases assigned" value={cases.data?.cases.length ?? "—"} icon={<ClipboardList size={14} />} />
        <Stat label="Awaiting your custody" value={inbox.data?.items.length ?? "—"} icon={<Inbox size={14} />} />
        <Stat
          label="Summons pending"
          value={summons.data?.counts.pending ?? "—"}
          tone="warning"
          icon={<ScrollText size={14} />}
        />
        <Stat
          label="Service failed"
          value={summons.data?.counts.failed ?? "—"}
          tone={(summons.data?.counts.failed ?? 0) > 0 ? "danger" : "default"}
          icon={<ScrollText size={14} />}
        />
      </div>

      <div className="mb-6">
        <ProsecutionReadiness basePath="/prosecutor/cases" />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          title="Evidence awaiting your custody"
          subtitle="Items the laboratory has finished with. Accepting is a hash confirmation."
        >
          <AsyncView
            state={inbox}
            onRetry={inbox.refetch}
            context="your intake queue"
            isEmpty={(data) => data.items.length === 0}
            empty={
              <EmptyState
                title="Nothing waiting"
                description="Items appear here once the laboratory has taken custody and finished its examination."
                icon={<PackageCheck size={19} />}
              />
            }
          >
            {(data) => (
              <ul className="space-y-2.5">
                {data.items.map((item) => (
                  <li key={item.id}>
                    <Link
                      to={`/prosecutor/cases/evidence/${item.id}`}
                      className="block rounded-lg border border-border bg-surface-2 p-3.5 transition hover:border-primary"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-ui text-sm font-medium text-text">{item.file_name}</p>
                          <p className="mt-0.5 font-ui text-2xs text-muted">
                            {item.cases?.case_reference} · {relativeTime(item.collected_at)}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <StageChip stage={item.current_stage} />
                        </div>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </AsyncView>
        </Card>

        <Card title="Service of process" subtitle="Status read from the contract, not from a register.">
          <AsyncView
            state={summons}
            onRetry={summons.refetch}
            context="summons"
            isEmpty={(data) => data.summons.length === 0}
            empty={
              <EmptyState
                title="No summons issued"
                description="The court issues summons. They appear here once they exist."
                icon={<ScrollText size={19} />}
              />
            }
          >
            {(data) => (
              <ul className="space-y-2.5">
                {data.summons.slice(0, 10).map((row) => (
                  <li
                    key={row.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-3.5 py-3"
                  >
                    <div className="min-w-0">
                      <p className="font-ui text-sm font-medium text-text">{row.recipient_name}</p>
                      <p className="mt-0.5 font-ui text-2xs text-muted">
                        {row.cases?.case_reference} ·{" "}
                        {row.effectiveStatus === "PENDING"
                          ? `${formatDuration((row.hoursRemaining ?? 0) * 3600)} left`
                          : formatDateTime(row.delivered_at ?? row.expiry_at)}
                      </p>
                    </div>
                    <SummonsStatusChip status={row.effectiveStatus ?? row.status} />
                  </li>
                ))}
              </ul>
            )}
          </AsyncView>
        </Card>
      </div>

      <DelayEstimateModal open={delayOpen} onClose={() => setDelayOpen(false)} cases={cases.data?.cases ?? []} />
    </>
  );
}

/* ================================================ DelayEstimateModal ===== */

/**
 * The case-delay regressor, exposed where it is actually useful: deciding what
 * to push for a listing date. The result is shown as a range, and labelled as
 * trained on synthetic data, because a single confident day count would imply a
 * precision the model does not have.
 */
export function DelayEstimateModal({
  open,
  onClose,
  cases,
}: {
  open: boolean;
  onClose: () => void;
  cases: CaseRow[];
}) {
  const toast = useToast();
  const [form, setForm] = useState({
    caseId: "",
    offenceType: "",
    courtBacklog: "6000",
    witnessCount: "5",
    evidenceCount: "10",
    adjournmentsSoFar: "1",
    isBailGranted: "true",
  });
  const [result, setResult] = useState<{
    available: boolean;
    predictedDays: number;
    confidenceLow: number;
    confidenceHigh: number;
  } | null>(null);

  const estimate = useMutation(async () =>
    api.post<{ prediction: { available: boolean; predictedDays: number; confidenceLow: number; confidenceHigh: number } }>(
      "/api/ai/case-delay",
      {
        caseId: form.caseId || undefined,
        offenceType: form.offenceType || "burglary",
        courtBacklog: Number(form.courtBacklog),
        witnessCount: Number(form.witnessCount),
        evidenceCount: Number(form.evidenceCount),
        adjournmentsSoFar: Number(form.adjournmentsSoFar),
        isBailGranted: form.isBailGranted === "true",
      }
    )
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Estimate time to disposal"
      description="A gradient boosting regressor trained on declared synthetic distributions. Advisory only: it informs listing priority, never a finding."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            loading={estimate.pending}
            onClick={async () => {
              const outcome = await estimate.run(undefined as never);
              if (!outcome) return;
              if (!outcome.prediction.available) {
                toast.warning(
                  "Model service unavailable",
                  "Start the Flask service, or leave AI_SERVICE_URL blank to hide this feature."
                );
                return;
              }
              setResult(outcome.prediction);
            }}
          >
            Estimate
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Case" hint="Optional. Attaching it records the estimate against the case.">
          <Select value={form.caseId} onChange={(event) => {
            const row = cases.find((c) => c.id === event.target.value);
            setForm({
              ...form,
              caseId: event.target.value,
              offenceType: row?.offence_type ?? form.offenceType,
            });
          }}>
            <option value="">Not attached to a case</option>
            {cases.map((row) => (
              <option key={row.id} value={row.id}>
                {row.case_reference} — {row.title}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Offence type" required>
          <Input
            value={form.offenceType}
            onChange={(event) => setForm({ ...form, offenceType: event.target.value })}
            placeholder="burglary"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Court backlog" hint="Pending matters before this court">
            <Input
              type="number"
              min={0}
              value={form.courtBacklog}
              onChange={(event) => setForm({ ...form, courtBacklog: event.target.value })}
            />
          </Field>
          <Field label="Witnesses">
            <Input
              type="number"
              min={0}
              value={form.witnessCount}
              onChange={(event) => setForm({ ...form, witnessCount: event.target.value })}
            />
          </Field>
          <Field label="Evidence items">
            <Input
              type="number"
              min={0}
              value={form.evidenceCount}
              onChange={(event) => setForm({ ...form, evidenceCount: event.target.value })}
            />
          </Field>
          <Field label="Adjournments so far">
            <Input
              type="number"
              min={0}
              value={form.adjournmentsSoFar}
              onChange={(event) => setForm({ ...form, adjournmentsSoFar: event.target.value })}
            />
          </Field>
        </div>

        <Field label="Bail granted?">
          <Select
            value={form.isBailGranted}
            onChange={(event) => setForm({ ...form, isBailGranted: event.target.value })}
          >
            <option value="true">Yes</option>
            <option value="false">No, in custody</option>
          </Select>
        </Field>

        {estimate.error && (
          <p role="alert" className="font-ui text-xs text-danger">
            {estimate.error.message}
          </p>
        )}

        {result && (
          <div className="rounded-card border border-info-soft bg-info-soft p-4">
            <p className="font-ui text-2xs font-semibold uppercase tracking-wider text-info">
              Estimated time to disposal
            </p>
            <p className="mt-1.5 font-ui text-3xl font-bold tabular text-text">
              {Math.round(result.predictedDays)} <span className="text-base font-medium text-muted">days</span>
            </p>
            <p className="mt-1.5 font-ui text-xs text-muted">
              Roughly {Math.round(result.predictedDays / 30)} months. Likely range{" "}
              {Math.round(result.confidenceLow)} to {Math.round(result.confidenceHigh)} days, from the
              spread of held-out residuals.
            </p>
            <p className="mt-2.5 font-ui text-2xs leading-relaxed text-faint">
              Trained on synthetic data, because NJDG publishes aggregate pendency rather than the
              per-case features a regressor needs. Treat it as a planning aid.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}
