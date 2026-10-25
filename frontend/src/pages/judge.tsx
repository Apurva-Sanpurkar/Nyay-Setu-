import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Gavel,
  Plus,
  Scale,
  ScrollText,
  ShieldAlert,
  Timer,
} from "lucide-react";
import { api, type BailRow, type CaseRow, type SummonsRow } from "../lib/api";
import { useMutation, useQuery, useTicker } from "../lib/useApi";
import { useToast } from "../context/ToastContext";
import { BailComplianceCard } from "./court";
import { formatDateTime, formatDuration, formatMetres, violationLabel } from "../lib/format";
import { AsyncView, EmptyState } from "../components/DataState";
import {
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  LinkButton,
  Modal,
  PageHeader,
  Select,
  Stat,
  Textarea,
} from "../components/ui";
import {
  ComplianceGauge,
  StatusChip,
  SummonsStatusChip,
  TxLink,
} from "../components/trust";

/* ================================================== JudgeDashboard ======= */

export function JudgeDashboard() {
  const summons = useQuery<{
    summons: SummonsRow[];
    counts: { pending: number; delivered: number; failed: number };
  }>("/api/summons/court/overview", [], { pollMs: 45_000 });

  const bail = useQuery<{
    orders: BailRow[];
    counts: { total: number; compliant: number; breach: number; overdue: number };
  }>("/api/bail/dashboard", [], { pollMs: 45_000 });

  const cases = useQuery<{ cases: CaseRow[] }>("/api/cases");

  const failedSummons = (summons.data?.summons ?? []).filter((row) => row.effectiveStatus === "FAILED");
  const breaching = (bail.data?.orders ?? []).filter((order) => order.state === "breach");

  return (
    <>
      <PageHeader
        eyebrow="Court portal"
        title="Court overview"
        description="The status of service of process and of bail compliance across your cases, read directly from the ledger rather than from a manually maintained register."
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Cases" value={cases.data?.cases.length ?? "—"} icon={<ClipboardList size={14} />} />
        <Stat
          label="Summons pending"
          value={summons.data?.counts.pending ?? "—"}
          tone="warning"
          hint="Window still open"
          icon={<Timer size={14} />}
        />
        <Stat
          label="Service failed"
          value={summons.data?.counts.failed ?? "—"}
          tone={(summons.data?.counts.failed ?? 0) > 0 ? "danger" : "default"}
          hint="72 hours elapsed unanswered"
          icon={<ShieldAlert size={14} />}
        />
        <Stat
          label="Bail in breach"
          value={bail.data?.counts.breach ?? "—"}
          tone={(bail.data?.counts.breach ?? 0) > 0 ? "danger" : "success"}
          hint={`${bail.data?.counts.compliant ?? 0} compliant`}
          icon={<Scale size={14} />}
        />
      </div>

      {/* Anything demanding attention is surfaced above the routine lists. */}
      {(failedSummons.length > 0 || breaching.length > 0) && (
        <div className="mb-6 space-y-3">
          {failedSummons.length > 0 && (
            <div className="panel border-danger-soft p-5">
              <div className="flex items-start gap-3">
                <ShieldAlert size={19} className="mt-0.5 shrink-0 text-danger" />
                <div className="min-w-0 flex-1">
                  <h2 className="font-display text-lg text-text">
                    {failedSummons.length} summons went unanswered
                  </h2>
                  <p className="mt-1 font-ui text-xs leading-relaxed text-muted">
                    The acknowledgement window closed without the recipient authenticating. The
                    contract reports FAILED; the court can proceed on that basis.
                  </p>
                  <ul className="mt-3 space-y-1.5">
                    {failedSummons.slice(0, 4).map((row) => (
                      <li key={row.id} className="font-ui text-xs text-text">
                        {row.recipient_name} · {row.cases?.case_reference} · closed{" "}
                        {formatDateTime(row.expiry_at)}
                      </li>
                    ))}
                  </ul>
                  <Link
                    to="/judge/summons"
                    className="mt-3 inline-block font-ui text-2xs font-semibold uppercase tracking-wider text-primary hover:underline"
                  >
                    Open the summons register
                  </Link>
                </div>
              </div>
            </div>
          )}

          {breaching.length > 0 && (
            <div className="panel border-danger-soft p-5">
              <div className="flex items-start gap-3">
                <AlertTriangle size={19} className="mt-0.5 shrink-0 text-danger" />
                <div className="min-w-0 flex-1">
                  <h2 className="font-display text-lg text-text">
                    {breaching.length} bail order{breaching.length > 1 ? "s" : ""} in breach
                  </h2>
                  <ul className="mt-3 space-y-1.5">
                    {breaching.slice(0, 4).map((order) => (
                      <li key={order.id} className="font-ui text-xs text-text">
                        {order.accused_name} · {order.cases?.case_reference} · score{" "}
                        {order.live?.score ?? order.compliance_score}
                        {order.live?.overdue && " · check-in overdue"}
                      </li>
                    ))}
                  </ul>
                  <Link
                    to="/judge/bail"
                    className="mt-3 inline-block font-ui text-2xs font-semibold uppercase tracking-wider text-primary hover:underline"
                  >
                    Open the compliance board
                  </Link>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          title="Service of process"
          subtitle="Delivery status straight from SummonsChain."
          actions={
            <Link
              to="/judge/summons"
              className="font-ui text-2xs font-semibold uppercase tracking-wider text-primary hover:underline"
            >
              All summons
            </Link>
          }
        >
          <AsyncView
            state={summons}
            onRetry={summons.refetch}
            context="summons"
            isEmpty={(data) => data.summons.length === 0}
            empty={
              <EmptyState
                title="No summons issued yet"
                description="Issue one from the summons register."
                icon={<ScrollText size={19} />}
                action={
                  <LinkButton to="/judge/summons" size="sm">
                    Issue a summons
                  </LinkButton>
                }
              />
            }
          >
            {(data) => <SummonsList rows={data.summons.slice(0, 8)} />}
          </AsyncView>
        </Card>

        <Card
          title="Bail compliance"
          subtitle="Scores computed on chain, so anyone can reproduce them."
          actions={
            <Link
              to="/judge/bail"
              className="font-ui text-2xs font-semibold uppercase tracking-wider text-primary hover:underline"
            >
              Full board
            </Link>
          }
        >
          <AsyncView
            state={bail}
            onRetry={bail.refetch}
            context="bail orders"
            isEmpty={(data) => data.orders.length === 0}
            empty={
              <EmptyState
                title="No active bail orders"
                description="Grant bail from the compliance board to start monitoring."
                icon={<Scale size={19} />}
              />
            }
          >
            {(data) => (
              <ul className="space-y-2.5">
                {data.orders.slice(0, 8).map((order) => (
                  <li
                    key={order.id}
                    className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3.5 py-3 ${
                      order.state === "breach" ? "border-danger-soft bg-danger-soft" : "border-border bg-surface-2"
                    }`}
                  >
                    <div className="min-w-0">
                      <p className="font-ui text-sm font-medium text-text">{order.accused_name}</p>
                      <p className="mt-0.5 font-ui text-2xs text-muted">
                        {order.cases?.case_reference}
                        {order.live && ` · next check-in ${formatDuration(order.live.secondsUntilNextCheckIn)}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {order.state === "breach" ? (
                        <StatusChip tone="danger" label={`Score ${order.live?.score ?? order.compliance_score}`} icon={<AlertTriangle size={11} />} />
                      ) : (
                        <StatusChip tone="success" label={`Score ${order.live?.score ?? order.compliance_score}`} icon={<CheckCircle2 size={11} />} />
                      )}
                    </div>
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

function SummonsList({ rows }: { rows: SummonsRow[] }) {
  useTicker(30_000); // keep the countdowns honest without refetching

  return (
    <ul className="space-y-2.5">
      {rows.map((row) => {
        const secondsLeft = Math.max(0, (new Date(row.expiry_at).getTime() - Date.now()) / 1000);
        const status = row.effectiveStatus ?? row.status;
        return (
          <li
            key={row.id}
            className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3.5 py-3 ${
              status === "FAILED" ? "border-danger-soft bg-danger-soft" : "border-border bg-surface-2"
            }`}
          >
            <div className="min-w-0">
              <p className="font-ui text-sm font-medium text-text">{row.recipient_name}</p>
              <p className="mt-0.5 font-ui text-2xs text-muted">
                {row.cases?.case_reference} ·{" "}
                {status === "PENDING"
                  ? `${formatDuration(secondsLeft)} left to acknowledge`
                  : status === "DELIVERED"
                    ? `acknowledged ${formatDateTime(row.delivered_at)}`
                    : `window closed ${formatDateTime(row.expiry_at)}`}
              </p>
            </div>
            <SummonsStatusChip status={status} />
          </li>
        );
      })}
    </ul>
  );
}

/* ==================================================== SummonsPage ======== */

export function SummonsPage() {
  const [issueOpen, setIssueOpen] = useState(false);
  const overview = useQuery<{
    summons: SummonsRow[];
    counts: { pending: number; delivered: number; failed: number };
  }>("/api/summons/court/overview", [], { pollMs: 45_000 });
  const cases = useQuery<{ cases: CaseRow[] }>("/api/cases");

  return (
    <>
      <PageHeader
        eyebrow="Summons"
        title="Summons register"
        description="Issue a summons and track its acknowledgement. If it is not acknowledged within 72 hours, the ledger records the service as failed, without any manual step."
        actions={
          <Button icon={<Plus size={14} />} onClick={() => setIssueOpen(true)}>
            Issue summons
          </Button>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Pending" value={overview.data?.counts.pending ?? "—"} tone="warning" icon={<Timer size={14} />} />
        <Stat
          label="Acknowledged"
          value={overview.data?.counts.delivered ?? "—"}
          tone="success"
          icon={<CheckCircle2 size={14} />}
        />
        <Stat
          label="Failed"
          value={overview.data?.counts.failed ?? "—"}
          tone={(overview.data?.counts.failed ?? 0) > 0 ? "danger" : "default"}
          icon={<ShieldAlert size={14} />}
        />
      </div>

      <Card title="All summons" subtitle="Newest first.">
        <AsyncView
          state={overview}
          onRetry={overview.refetch}
          context="the summons register"
          isEmpty={(data) => data.summons.length === 0}
          empty={
            <EmptyState
              title="Nothing issued yet"
              description="A summons here is a document hash plus a 72 hour acknowledgement window, both on chain."
              icon={<ScrollText size={19} />}
              action={<Button size="sm" onClick={() => setIssueOpen(true)}>Issue the first one</Button>}
            />
          }
        >
          {(data) => <SummonsList rows={data.summons} />}
        </AsyncView>
      </Card>

      <IssueSummonsModal
        open={issueOpen}
        onClose={() => setIssueOpen(false)}
        cases={cases.data?.cases ?? []}
        onIssued={() => {
          overview.refetch();
          setIssueOpen(false);
        }}
      />
    </>
  );
}

function IssueSummonsModal({
  open,
  onClose,
  cases,
  onIssued,
}: {
  open: boolean;
  onClose: () => void;
  cases: CaseRow[];
  onIssued: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({
    caseId: "",
    recipientName: "",
    recipientAadhaarNumber: "",
    documentBody: "",
    hearingAt: "",
    windowHours: "72",
  });

  const issue = useMutation(async () =>
    api.post<{ summons: SummonsRow; chain: { txHash: string; explorer: string | null; chainSummonsId: number } }>(
      "/api/summons",
      {
        caseId: form.caseId,
        recipientName: form.recipientName.trim(),
        recipientAadhaarNumber: form.recipientAadhaarNumber.replace(/[^0-9]/g, ""),
        documentBody: form.documentBody.trim(),
        hearingAt: form.hearingAt ? new Date(form.hearingAt).toISOString() : undefined,
        windowHours: Number(form.windowHours),
      }
    )
  );

  const valid =
    form.caseId &&
    form.recipientName.trim().length >= 3 &&
    /^[0-9]{12}$/.test(form.recipientAadhaarNumber.replace(/[^0-9]/g, "")) &&
    form.documentBody.trim().length >= 20;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Issue a summons"
      description="The Aadhaar number is tokenised the moment it arrives and then discarded. Only the token reaches the database or the chain."
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid}
            loading={issue.pending}
            onClick={async () => {
              const outcome = await issue.run(undefined as never);
              if (outcome) {
                toast.success(
                  `Summons #${outcome.chain.chainSummonsId} issued`,
                  `The document hash and a ${form.windowHours} hour window are on chain.`,
                  outcome.chain.explorer
                    ? { href: outcome.chain.explorer, label: "View transaction" }
                    : undefined
                );
                onIssued();
              }
            }}
          >
            Issue on chain
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Case" required>
          <Select value={form.caseId} onChange={(event) => setForm({ ...form, caseId: event.target.value })}>
            <option value="">Select a case…</option>
            {cases.map((row) => (
              <option key={row.id} value={row.id}>
                {row.case_reference} — {row.title}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Recipient name" required>
            <Input
              value={form.recipientName}
              onChange={(event) => setForm({ ...form, recipientName: event.target.value })}
              placeholder="Vikram Jadhav"
            />
          </Field>

          <Field
            label="Recipient Aadhaar"
            required
            hint="Tokenised with an HMAC and discarded. Never stored, never logged."
          >
            <Input
              inputMode="numeric"
              maxLength={14}
              value={form.recipientAadhaarNumber}
              onChange={(event) =>
                setForm({ ...form, recipientAadhaarNumber: event.target.value.replace(/[^0-9 ]/g, "") })
              }
              placeholder="7226 6778 8997"
              className="font-mono"
            />
          </Field>
        </div>

        <Field
          label="Summons text"
          required
          hint="Stored off chain and encrypted. Its digest is anchored, so a later edit is detectable."
        >
          <Textarea
            rows={6}
            value={form.documentBody}
            onChange={(event) => setForm({ ...form, documentBody: event.target.value })}
            placeholder="IN THE COURT OF SESSIONS, PUNE&#10;&#10;You are hereby summoned to appear…"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Hearing date">
            <Input
              type="datetime-local"
              value={form.hearingAt}
              onChange={(event) => setForm({ ...form, hearingAt: event.target.value })}
            />
          </Field>

          <Field label="Acknowledgement window" hint="Hours. The specification uses 72.">
            <Input
              type="number"
              min={1}
              max={720}
              value={form.windowHours}
              onChange={(event) => setForm({ ...form, windowHours: event.target.value })}
            />
          </Field>
        </div>

        {issue.error && (
          <p role="alert" className="font-ui text-xs text-danger">
            {issue.error.message}
          </p>
        )}
      </div>
    </Modal>
  );
}

/* ====================================================== BailBoard ======== */

interface ConditionOption {
  tag: string;
  label: string;
  monitored: string;
}

export function BailBoard() {
  const [grantOpen, setGrantOpen] = useState(false);
  const board = useQuery<{
    orders: BailRow[];
    counts: { total: number; compliant: number; breach: number; overdue: number };
  }>("/api/bail/dashboard", [], { pollMs: 30_000 });
  const cases = useQuery<{ cases: CaseRow[] }>("/api/cases");

  return (
    <>
      <PageHeader
        eyebrow="Bail"
        title="Bail compliance"
        description="Bail conditions are recorded on the ledger and each check-in is assessed against the permitted area by the contract itself, so a breach is identified consistently and without delay."
        actions={
          <Button icon={<Plus size={14} />} onClick={() => setGrantOpen(true)}>
            Grant bail
          </Button>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Active orders" value={board.data?.counts.total ?? "—"} icon={<Scale size={14} />} />
        <Stat label="Compliant" value={board.data?.counts.compliant ?? "—"} tone="success" icon={<CheckCircle2 size={14} />} />
        <Stat
          label="In breach"
          value={board.data?.counts.breach ?? "—"}
          tone={(board.data?.counts.breach ?? 0) > 0 ? "danger" : "default"}
          icon={<AlertTriangle size={14} />}
        />
        <Stat
          label="Check-in overdue"
          value={board.data?.counts.overdue ?? "—"}
          tone={(board.data?.counts.overdue ?? 0) > 0 ? "warning" : "default"}
          icon={<Timer size={14} />}
        />
      </div>

      <div className="mb-6">
        <BailComplianceCard />
      </div>

      <AsyncView
        state={board}
        onRetry={board.refetch}
        context="the compliance board"
        isEmpty={(data) => data.orders.length === 0}
        empty={
          <EmptyState
            title="No active bail orders"
            description="Granting bail here writes the conditions on chain and starts the check-in clock."
            icon={<Scale size={19} />}
            action={<Button size="sm" onClick={() => setGrantOpen(true)}>Grant bail</Button>}
          />
        }
      >
        {(data) => (
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {data.orders.map((order) => (
              <BailCard key={order.id} order={order} onChanged={board.refetch} />
            ))}
          </div>
        )}
      </AsyncView>

      <GrantBailModal
        open={grantOpen}
        onClose={() => setGrantOpen(false)}
        cases={cases.data?.cases ?? []}
        onGranted={() => {
          board.refetch();
          setGrantOpen(false);
        }}
      />
    </>
  );
}

/**
 * Discharging a bail order.
 *
 * A reason is required, not optional. An order that simply stops being active
 * leaves no answer to "why was the monitoring lifted", and that is precisely the
 * question asked if the accused later absconds. The reason is recorded in the
 * action log alongside who closed it.
 *
 * Closing does not erase anything: the check-ins, the violations and every anchored
 * transaction stay readable. It stops the contract expecting further check-ins.
 */
function CloseBailModal({
  open,
  onClose,
  caseId,
  accusedName,
  onClosed,
}: {
  open: boolean;
  onClose: () => void;
  caseId: string;
  accusedName: string;
  onClosed: () => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const close = useMutation(async () =>
    api.post(`/api/bail/case/${caseId}/close`, { reason: reason.trim() })
  );

  const dismiss = () => {
    close.reset();
    setReason("");
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={dismiss}
      title="Close the bail order"
      description="Monitoring stops and no further check-ins are expected. Nothing already recorded is removed."
      footer={
        <>
          <Button variant="ghost" onClick={dismiss}>
            Cancel
          </Button>
          <Button
            disabled={reason.trim().length < 4}
            loading={close.pending}
            onClick={async () => {
              const outcome = await close.run(undefined as never);
              if (outcome) {
                toast.success("Bail order closed", `Monitoring for ${accusedName} has ended.`);
                onClosed();
                dismiss();
              }
            }}
          >
            Close the order
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="font-ui text-sm text-text">{accusedName}</p>
        <Field
          label="Reason"
          required
          hint="Recorded against the case. This is the answer to 'why was monitoring lifted'."
        >
          <Textarea
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Discharged on conclusion of trial; bail bond cancelled."
          />
        </Field>
        {close.error && (
          <p role="alert" className="font-ui text-xs text-danger">
            {close.error.message}
          </p>
        )}
      </div>
    </Modal>
  );
}

function BailCard({ order, onChanged }: { order: BailRow; onChanged: () => void }) {
  const toast = useToast();
  const [reportOpen, setReportOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [reason, setReason] = useState("NO_CONTACT_BREACH");

  const report = useMutation(async () =>
    api.post(`/api/bail/case/${order.case_id}/violation`, { reason })
  );

  const score = order.live?.score ?? order.compliance_score;
  const breach = order.state === "breach";

  return (
    <div className={`panel p-5 ${breach ? "border-danger-soft" : ""}`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-lg leading-tight text-text">{order.accused_name}</p>
          <code className="mt-0.5 block font-mono text-2xs text-muted">{order.cases?.case_reference}</code>
        </div>
        {order.risk_band && (
          <StatusChip
            tone={order.risk_band === "HIGH" ? "danger" : order.risk_band === "MEDIUM" ? "warning" : "success"}
            label={`${order.risk_band} risk`}
          />
        )}
      </div>

      <div className="flex justify-center">
        <ComplianceGauge score={score} overdue={order.live?.overdue} size={124} />
      </div>

      <dl className="mt-4 space-y-2">
        <Row label="Geo-fence" value={order.radius_metres ? formatMetres(order.radius_metres) : "none"} />
        <Row
          label="Next check-in"
          value={
            order.live
              ? order.live.overdue
                ? "overdue"
                : formatDuration(order.live.secondsUntilNextCheckIn)
              : "—"
          }
        />
        <Row label="Open violations" value={order.openViolations ?? 0} />
        <Row label="Expires" value={formatDateTime(order.expiry_at)} />
      </dl>

      <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
        <LinkButton to={`/judge/cases/${order.case_id}`} variant="secondary" size="sm" full className="flex-1">
          Open case
        </LinkButton>
        <Button variant="ghost" size="sm" onClick={() => setReportOpen(true)}>
          Report breach
        </Button>
        {order.active && (
          <Button variant="ghost" size="sm" onClick={() => setCloseOpen(true)}>
            Close order
          </Button>
        )}
      </div>

      <CloseBailModal
        open={closeOpen}
        onClose={() => setCloseOpen(false)}
        caseId={order.case_id}
        accusedName={order.accused_name}
        onClosed={onChanged}
      />

      <Modal
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        title="Report a breach"
        description="For conditions only a person can observe, such as contacting a witness. Geo-fence and missed check-ins are detected on chain without this."
        footer={
          <>
            <Button variant="ghost" onClick={() => setReportOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={report.pending}
              onClick={async () => {
                const outcome = await report.run(undefined as never);
                if (outcome) {
                  toast.success("Breach recorded on chain", violationLabel(reason));
                  setReportOpen(false);
                  onChanged();
                }
              }}
            >
              Record on chain
            </Button>
          </>
        }
      >
        <Field label="Breach" required>
          <Select value={reason} onChange={(event) => setReason(event.target.value)}>
            <option value="NO_CONTACT_BREACH">Contacted a protected person</option>
            <option value="PASSPORT_NOT_SURRENDERED">Passport not surrendered</option>
            <option value="WITNESS_INTIMIDATION">Witness intimidation</option>
            <option value="FURTHER_OFFENCE">Further offence alleged</option>
          </Select>
        </Field>
        {report.error && (
          <p role="alert" className="mt-3 font-ui text-xs text-danger">
            {report.error.message}
          </p>
        )}
      </Modal>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="font-ui text-2xs uppercase tracking-wider text-faint">{label}</dt>
      <dd className="text-right font-ui text-xs font-medium text-text">{value}</dd>
    </div>
  );
}

/* =================================================== GrantBailModal ====== */

/**
 * Granting bail.
 *
 * The risk score is offered before the order is written, not after: the whole
 * point is that a judge sees the assessment while still deciding. It is
 * advisory, it is labelled as trained on synthetic data, and nothing in the
 * form requires it.
 */
function GrantBailModal({
  open,
  onClose,
  cases,
  onGranted,
}: {
  open: boolean;
  onClose: () => void;
  cases: CaseRow[];
  onGranted: () => void;
}) {
  const toast = useToast();
  const conditions = useQuery<{ conditions: ConditionOption[] }>(open ? "/api/bail/conditions" : null);

  const [form, setForm] = useState({
    caseId: "",
    accusedName: "",
    accusedAadhaarNumber: "",
    centreLat: "18.5308",
    centreLng: "73.8478",
    radiusMetres: "2000",
    intervalHours: "168",
    expiryDays: "90",
    orderText: "",
    suretyName: "",
  });
  const [selected, setSelected] = useState<string[]>(["GEO_RESTRICTION", "PERIODIC_CHECKIN"]);
  const [risk, setRisk] = useState<{ band: string; score: number; factors: string[] } | null>(null);
  const [riskForm, setRiskForm] = useState({
    priorConvictions: "0",
    ageYears: "30",
    previousBailViolations: "0",
    checkInConsistency: "1",
    movementRadiusKm: "5",
    employmentStable: "true",
  });

  const selectedCase = cases.find((row) => row.id === form.caseId);

  const assess = useMutation(async () =>
    api.post<{ risk: { available: boolean; band: string; score: number; factors: string[] } }>(
      "/api/bail/risk-preview",
      {
        offenceType: selectedCase?.offence_type ?? "burglary",
        priorConvictions: Number(riskForm.priorConvictions),
        ageYears: Number(riskForm.ageYears),
        previousBailViolations: Number(riskForm.previousBailViolations),
        checkInConsistency: Number(riskForm.checkInConsistency),
        movementRadiusKm: Number(riskForm.movementRadiusKm),
        employmentStable: riskForm.employmentStable === "true",
      }
    )
  );

  const grant = useMutation(async () =>
    api.post<{ bail: BailRow; chain: { txHash: string; explorer: string | null } }>("/api/bail/grant", {
      caseId: form.caseId,
      accusedName: form.accusedName.trim(),
      accusedAadhaarNumber: form.accusedAadhaarNumber.replace(/[^0-9]/g, ""),
      conditionTags: selected,
      centreLat: Number(form.centreLat),
      centreLng: Number(form.centreLng),
      radiusMetres: Number(form.radiusMetres),
      checkinIntervalSeconds: Math.round(Number(form.intervalHours) * 3600),
      expiryAt: new Date(Date.now() + Number(form.expiryDays) * 86400_000).toISOString(),
      orderText: form.orderText.trim() || undefined,
      suretyName: form.suretyName.trim() || undefined,
      riskFactors: {
        offenceType: selectedCase?.offence_type ?? "burglary",
        priorConvictions: Number(riskForm.priorConvictions),
        ageYears: Number(riskForm.ageYears),
        previousBailViolations: Number(riskForm.previousBailViolations),
        checkInConsistency: Number(riskForm.checkInConsistency),
        movementRadiusKm: Number(riskForm.movementRadiusKm),
        employmentStable: riskForm.employmentStable === "true",
      },
    })
  );

  const geoSelected = selected.includes("GEO_RESTRICTION");
  const valid =
    form.caseId &&
    form.accusedName.trim().length >= 3 &&
    /^[0-9]{12}$/.test(form.accusedAadhaarNumber.replace(/[^0-9]/g, "")) &&
    selected.length > 0 &&
    (!geoSelected || Number(form.radiusMetres) > 0);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Grant bail"
      description="Conditions are written on chain in the order you choose them, and the compliance view returns one flag per condition at the same index."
      width="max-w-3xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid}
            loading={grant.pending}
            onClick={async () => {
              const outcome = await grant.run(undefined as never);
              if (outcome) {
                toast.success(
                  "Bail granted",
                  "Conditions and the geo-fence are on chain. The check-in clock has started.",
                  outcome.chain.explorer
                    ? { href: outcome.chain.explorer, label: "View transaction" }
                    : undefined
                );
                onGranted();
              }
            }}
          >
            Grant on chain
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Case" required>
          <Select value={form.caseId} onChange={(event) => setForm({ ...form, caseId: event.target.value })}>
            <option value="">Select a case…</option>
            {cases.map((row) => (
              <option key={row.id} value={row.id}>
                {row.case_reference} — {row.title}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Accused" required>
            <Input
              value={form.accusedName}
              onChange={(event) => setForm({ ...form, accusedName: event.target.value })}
              placeholder="Vikram Jadhav"
            />
          </Field>
          <Field label="Accused Aadhaar" required hint="Tokenised immediately and discarded.">
            <Input
              inputMode="numeric"
              maxLength={14}
              value={form.accusedAadhaarNumber}
              onChange={(event) =>
                setForm({ ...form, accusedAadhaarNumber: event.target.value.replace(/[^0-9 ]/g, "") })
              }
              placeholder="7226 6778 8997"
              className="font-mono"
            />
          </Field>
        </div>

        {/* ------------------------------------------------ conditions */}
        <div>
          <p className="label">Conditions</p>
          <AsyncView state={conditions} onRetry={conditions.refetch} context="the condition list">
            {(data) => (
              <div className="space-y-2">
                {data.conditions.map((condition) => (
                  <Checkbox
                    key={condition.tag}
                    label={condition.label}
                    description={
                      condition.monitored === "on-chain"
                        ? "Detected automatically on chain"
                        : "Observable only off chain; the court reports a breach"
                    }
                    checked={selected.includes(condition.tag)}
                    onChange={(checked) =>
                      setSelected((current) =>
                        checked ? [...current, condition.tag] : current.filter((t) => t !== condition.tag)
                      )
                    }
                  />
                ))}
              </div>
            )}
          </AsyncView>
        </div>

        {/* ------------------------------------------------- monitoring */}
        <div className="rounded-card border border-border bg-surface-2 p-4">
          <p className="mb-3 font-ui text-xs font-semibold text-text">Monitoring parameters</p>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Residence latitude" required>
              <Input
                value={form.centreLat}
                onChange={(event) => setForm({ ...form, centreLat: event.target.value })}
                className="font-mono"
              />
            </Field>
            <Field label="Residence longitude" required>
              <Input
                value={form.centreLng}
                onChange={(event) => setForm({ ...form, centreLng: event.target.value })}
                className="font-mono"
              />
            </Field>
            <Field
              label="Permitted radius (metres)"
              required={geoSelected}
              hint={geoSelected ? "Must be above zero when a geo-restriction applies." : "Zero disables the fence."}
              error={geoSelected && Number(form.radiusMetres) <= 0 ? "Set a radius, or drop the geo-restriction." : null}
            >
              <Input
                type="number"
                min={0}
                value={form.radiusMetres}
                onChange={(event) => setForm({ ...form, radiusMetres: event.target.value })}
              />
            </Field>
            <Field label="Check-in interval (hours)" hint="168 is weekly. Use 1 for a live demo.">
              <Input
                type="number"
                min={1}
                value={form.intervalHours}
                onChange={(event) => setForm({ ...form, intervalHours: event.target.value })}
              />
            </Field>
          </div>
        </div>

        {/* ------------------------------------------------ risk score */}
        <div className="rounded-card border border-border bg-surface-2 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="font-ui text-xs font-semibold text-text">Violation risk assessment</p>
            <Button size="sm" variant="secondary" loading={assess.pending} onClick={async () => {
              const outcome = await assess.run(undefined as never);
              if (!outcome) return;
              if (!outcome.risk.available) {
                toast.warning("Model service unavailable", "The grant will proceed without a score.");
                return;
              }
              setRisk(outcome.risk);
            }}>
              Assess
            </Button>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Prior convictions">
              <Input
                type="number"
                min={0}
                value={riskForm.priorConvictions}
                onChange={(event) => setRiskForm({ ...riskForm, priorConvictions: event.target.value })}
              />
            </Field>
            <Field label="Age">
              <Input
                type="number"
                min={14}
                value={riskForm.ageYears}
                onChange={(event) => setRiskForm({ ...riskForm, ageYears: event.target.value })}
              />
            </Field>
            <Field label="Past bail violations">
              <Input
                type="number"
                min={0}
                value={riskForm.previousBailViolations}
                onChange={(event) => setRiskForm({ ...riskForm, previousBailViolations: event.target.value })}
              />
            </Field>
            <Field label="Check-in consistency" hint="0 to 1">
              <Input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={riskForm.checkInConsistency}
                onChange={(event) => setRiskForm({ ...riskForm, checkInConsistency: event.target.value })}
              />
            </Field>
            <Field label="Daily movement (km)">
              <Input
                type="number"
                min={0}
                value={riskForm.movementRadiusKm}
                onChange={(event) => setRiskForm({ ...riskForm, movementRadiusKm: event.target.value })}
              />
            </Field>
            <Field label="Stable employment">
              <Select
                value={riskForm.employmentStable}
                onChange={(event) => setRiskForm({ ...riskForm, employmentStable: event.target.value })}
              >
                <option value="true">Yes</option>
                <option value="false">No</option>
              </Select>
            </Field>
          </div>

          {risk && (
            <div
              className={`mt-3.5 rounded-lg border p-3 ${
                risk.band === "HIGH"
                  ? "border-danger-soft bg-danger-soft"
                  : risk.band === "MEDIUM"
                    ? "border-warning-soft bg-warning-soft"
                    : "border-success-soft bg-success-soft"
              }`}
            >
              <p className="font-ui text-sm font-bold text-text">
                {risk.band} risk · {(risk.score * 100).toFixed(0)}%
              </p>
              <ul className="mt-1.5 space-y-0.5">
                {risk.factors.map((factor, index) => (
                  <li key={index} className="font-ui text-2xs leading-relaxed text-muted">
                    · {factor}
                  </li>
                ))}
              </ul>
              <p className="mt-2 font-ui text-2xs leading-relaxed text-faint">
                A random forest trained on declared synthetic distributions. Advisory input to a
                judicial decision, never a substitute for one.
              </p>
            </div>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Surety name">
            <Input
              value={form.suretyName}
              onChange={(event) => setForm({ ...form, suretyName: event.target.value })}
              placeholder="Sunita Jadhav"
            />
          </Field>
          <Field label="Bail duration (days)">
            <Input
              type="number"
              min={1}
              value={form.expiryDays}
              onChange={(event) => setForm({ ...form, expiryDays: event.target.value })}
            />
          </Field>
        </div>

        <Field label="Order text" hint="Stored off chain in full. Not anchored.">
          <Textarea
            rows={3}
            value={form.orderText}
            onChange={(event) => setForm({ ...form, orderText: event.target.value })}
            placeholder="Bail granted on a personal bond of Rs 50,000 with one surety of the like amount."
          />
        </Field>

        {grant.error && (
          <p role="alert" className="font-ui text-xs text-danger">
            {grant.error.message}
          </p>
        )}
      </div>
    </Modal>
  );
}
