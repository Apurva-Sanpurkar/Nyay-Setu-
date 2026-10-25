import { useState } from "react";
import { Archive, Boxes, CheckCircle2, Copy, FileCheck2, FileDown, FlaskConical, Lock, ShieldAlert, XCircle } from "lucide-react";
import { api, ApiError, type EvidenceRow, type Role } from "../lib/api";
import { useMutation, useQuery } from "../lib/useApi";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { useI18n, type MessageKey } from "../i18n";
import { formatDateTime } from "../lib/format";
import { shortHash } from "../lib/hash";
import { fetchDocument } from "../lib/download";
import { Button, Card, Checkbox, Field, Input, Modal, Select, Textarea } from "./ui";
import { FileHashPicker, type HashedFile } from "./capture";
import { HashBadge } from "./trust";
import { VerificationBadge } from "./verification";

/**
 * Workflow panels of the evidence page (2.0): the laboratory's intake, working
 * copies and versioned reports (F14), the Section 63 certificate (F11), the
 * custody form and malkhana history (F13), and governance requests (F19).
 * Each panel only renders for the roles the API would accept it from.
 */

function has(role: Role | undefined, ...roles: Role[]) {
  return Boolean(role && roles.includes(role));
}

function ErrorLine({ error }: { error: Error | null }) {
  if (!error) return null;
  const missing = error instanceof ApiError && Array.isArray((error.details as any)?.missing) ? ((error.details as any).missing as string[]) : null;
  return (
    <div role="alert" className="rounded-lg border border-danger-soft bg-danger-soft px-3 py-2 font-ui text-xs text-text">
      {error.message}
      {missing && (
        <ul className="mt-1 list-disc pl-4">
          {missing.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ====================================================== laboratory (F14) */

interface Intake {
  id: string;
  seal_intact: boolean;
  seal_notes: string | null;
  condition_notes: string | null;
  recheck_matched: boolean | null;
  recheck_digest: string | null;
  status: "received" | "in_analysis" | "reported" | "returned";
  received_at: string;
}
interface WorkingCopy {
  id: string;
  copy_sha256: string;
  tool: string;
  tool_version: string;
  method: string;
  created_at: string;
}
export interface ReportRow {
  id: string;
  report_hash: string;
  conclusion: string;
  detail: string | null;
  created_at: string;
  tx_hash: string | null;
  version?: number;
  supersedes_id?: string | null;
  analyst_name?: string | null;
  tool?: string | null;
  method?: string | null;
}

const NEXT_STATUS: Record<Intake["status"], Intake["status"] | null> = {
  received: "in_analysis",
  in_analysis: "reported",
  reported: "returned",
  returned: null,
};

export function LabWorkPanel({ item, reports, onChanged }: { item: EvidenceRow; reports: ReportRow[]; onChanged: () => void }) {
  const { user } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const lab = useQuery<{ intakes: Intake[]; workingCopies: WorkingCopy[] }>(`/api/lab/evidence/${item.id}`);
  const [dialog, setDialog] = useState<null | "intake" | "copy" | "report">(null);
  const canWork = user?.role === "forensic_lab" && item.current_stage === "FORENSIC_LAB";
  const latestIntake = lab.data?.intakes[0] ?? null;
  const latestReport = reports[0] ?? null;

  const advance = useMutation(async (status: Intake["status"]) => api.patch(`/api/lab/intakes/${latestIntake!.id}`, { status }));

  if (!has(user?.role, "forensic_lab", "prosecutor", "judge", "court_admin", "police")) return null;
  const empty = !lab.data || (lab.data.intakes.length === 0 && lab.data.workingCopies.length === 0);
  if (!canWork && empty) return null;

  return (
    <Card title={t("lab.title")} subtitle={t("lab.subtitle")}>
      <div className="space-y-4">
        {latestIntake ? (
          <div className="rounded-xl border border-border bg-surface-2 p-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-ui text-xs font-semibold text-text">{t("lab.intake")}</span>
              <span className="chip border-border bg-surface text-muted">{t(`lab.status.${latestIntake.status}` as MessageKey)}</span>
              {latestIntake.recheck_matched === true && (
                <span className="chip border-success-soft bg-success-soft text-success">
                  <CheckCircle2 size={11} aria-hidden /> {t("lab.recheckMatched")}
                </span>
              )}
              {latestIntake.recheck_matched === false && (
                <span className="chip border-danger-soft bg-danger-soft text-danger">
                  <XCircle size={11} aria-hidden /> {t("lab.recheckMismatch")}
                </span>
              )}
              {!latestIntake.seal_intact && <span className="chip border-warning-soft bg-warning-soft text-warning">{t("lab.sealBroken")}</span>}
            </div>
            <p className="mt-1 font-ui text-2xs text-muted">{formatDateTime(latestIntake.received_at)}</p>
            {latestIntake.seal_notes && <p className="mt-1 font-ui text-xs text-text">{latestIntake.seal_notes}</p>}
            {latestIntake.condition_notes && <p className="mt-1 font-ui text-xs text-muted">{latestIntake.condition_notes}</p>}
            {canWork && NEXT_STATUS[latestIntake.status] && (
              <Button
                size="sm"
                variant="secondary"
                className="mt-2.5"
                loading={advance.pending}
                onClick={async () => {
                  if (await advance.run(NEXT_STATUS[latestIntake.status]!)) {
                    lab.refetch();
                    onChanged();
                  }
                }}
              >
                {t("lab.markAs")} {t(`lab.status.${NEXT_STATUS[latestIntake.status]}` as MessageKey)}
              </Button>
            )}
            <ErrorLine error={advance.error} />
          </div>
        ) : (
          canWork && (
            <p className="rounded-xl bg-info-soft px-3.5 py-3 font-ui text-xs leading-relaxed text-text">{t("lab.intakeFirst")}</p>
          )
        )}

        {(lab.data?.workingCopies.length ?? 0) > 0 && (
          <div>
            <p className="mb-1.5 font-ui text-xs font-semibold text-text">{t("lab.workingCopies")}</p>
            <ul className="space-y-1.5">
              {lab.data!.workingCopies.map((c) => (
                <li key={c.id} className="rounded-lg bg-surface-2 px-3 py-2 font-ui text-2xs text-muted">
                  <code className="font-mono text-text">{shortHash(c.copy_sha256, 14, 8)}</code> · {c.tool} {c.tool_version} · {c.method}
                </li>
              ))}
            </ul>
          </div>
        )}

        {canWork && (
          <div className="flex flex-wrap gap-2">
            {!latestIntake && (
              <Button size="sm" icon={<FlaskConical size={13} />} onClick={() => setDialog("intake")}>
                {t("lab.recordIntake")}
              </Button>
            )}
            {latestIntake && (
              <>
                <Button size="sm" variant="secondary" icon={<Copy size={13} />} onClick={() => setDialog("copy")}>
                  {t("lab.addWorkingCopy")}
                </Button>
                <Button size="sm" variant="secondary" icon={<FileCheck2 size={13} />} onClick={() => setDialog("report")}>
                  {latestReport ? t("lab.fileCorrection") : t("lab.fileReport")}
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {dialog === "intake" && (
        <IntakeDialog
          item={item}
          onClose={() => setDialog(null)}
          onDone={(matched) => {
            setDialog(null);
            lab.refetch();
            onChanged();
            if (matched) toast.success(t("lab.recheckMatched"));
            else toast.error(t("lab.recheckMismatch"), t("lab.mismatchRecorded"));
          }}
        />
      )}
      {dialog === "copy" && (
        <WorkingCopyDialog
          evidenceId={item.id}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            lab.refetch();
            toast.success(t("lab.copyRecorded"));
          }}
        />
      )}
      {dialog === "report" && (
        <ReportDialog
          evidenceId={item.id}
          supersedes={latestReport}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            onChanged();
            toast.success(t("lab.reportFiled"));
          }}
        />
      )}
    </Card>
  );
}

function IntakeDialog({ item, onClose, onDone }: { item: EvidenceRow; onClose: () => void; onDone: (matched: boolean) => void }) {
  const { t } = useI18n();
  const [picked, setPicked] = useState<HashedFile | null>(null);
  const [sealIntact, setSealIntact] = useState(true);
  const [sealNotes, setSealNotes] = useState("");
  const [conditionNotes, setConditionNotes] = useState("");
  const save = useMutation(async () =>
    api.post<{ matched: boolean }>(`/api/lab/evidence/${item.id}/intake`, {
      sealIntact,
      sealNotes: sealNotes.trim() || null,
      conditionNotes: conditionNotes.trim() || null,
      recheckSha256: picked!.hash,
    })
  );
  const valid = picked && (sealIntact || sealNotes.trim().length > 0);

  return (
    <Modal
      open
      onClose={onClose}
      title={t("lab.recordIntake")}
      description={t("lab.intakeHint")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!valid}
            loading={save.pending}
            onClick={async () => {
              const out = await save.run(undefined as never);
              if (out) onDone(out.matched);
            }}
          >
            {t("lab.recordIntake")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FileHashPicker value={picked} onChange={setPicked} disabled={save.pending} />
        {picked && (
          <p className={`rounded-lg px-3 py-2 font-ui text-2xs ${picked.hash === item.file_hash ? "bg-success-soft" : "bg-danger-soft"} text-text`}>
            {picked.hash === item.file_hash ? t("lab.localMatch") : t("lab.localMismatch")}
          </p>
        )}
        <Checkbox label={t("lab.sealIntact")} checked={sealIntact} onChange={setSealIntact} />
        {!sealIntact && (
          <Field label={t("lab.sealNotes")} required>
            <Textarea rows={2} value={sealNotes} onChange={(e) => setSealNotes(e.target.value)} />
          </Field>
        )}
        <Field label={t("lab.conditionNotes")}>
          <Textarea rows={2} value={conditionNotes} onChange={(e) => setConditionNotes(e.target.value)} />
        </Field>
        <ErrorLine error={save.error} />
      </div>
    </Modal>
  );
}

function WorkingCopyDialog({ evidenceId, onClose, onDone }: { evidenceId: string; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [picked, setPicked] = useState<HashedFile | null>(null);
  const [form, setForm] = useState({ tool: "", toolVersion: "", method: "", notes: "" });
  const save = useMutation(async () =>
    api.post(`/api/lab/evidence/${evidenceId}/working-copies`, {
      copySha256: picked!.hash,
      tool: form.tool.trim(),
      toolVersion: form.toolVersion.trim(),
      method: form.method.trim(),
      notes: form.notes.trim() || null,
    })
  );
  return (
    <Modal
      open
      onClose={onClose}
      title={t("lab.addWorkingCopy")}
      description={t("lab.copyHint")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!picked || form.tool.trim().length < 2 || !form.toolVersion.trim() || form.method.trim().length < 3}
            loading={save.pending}
            onClick={async () => (await save.run(undefined as never)) && onDone()}
          >
            {t("lab.addWorkingCopy")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FileHashPicker value={picked} onChange={setPicked} accept="*/*" disabled={save.pending} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("lab.tool")} required>
            <Input value={form.tool} onChange={(e) => setForm({ ...form, tool: e.target.value })} placeholder="FTK Imager" />
          </Field>
          <Field label={t("lab.toolVersion")} required>
            <Input value={form.toolVersion} onChange={(e) => setForm({ ...form, toolVersion: e.target.value })} placeholder="4.7.1" />
          </Field>
        </div>
        <Field label={t("lab.method")} required>
          <Input value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} />
        </Field>
        <Field label={t("capture.notes")}>
          <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
        <ErrorLine error={save.error} />
      </div>
    </Modal>
  );
}

function ReportDialog({ evidenceId, supersedes, onClose, onDone }: { evidenceId: string; supersedes: ReportRow | null; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [form, setForm] = useState({ conclusion: "", detail: "", tool: "", method: "" });
  const save = useMutation(async () =>
    api.post(`/api/lab/evidence/${evidenceId}/reports`, {
      conclusion: form.conclusion.trim(),
      detail: form.detail.trim() || null,
      tool: form.tool.trim(),
      method: form.method.trim(),
      supersedesId: supersedes?.id ?? null,
    })
  );
  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-2xl"
      title={supersedes ? t("lab.fileCorrection") : t("lab.fileReport")}
      description={supersedes ? t("lab.correctionHint") : t("lab.reportHint")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={form.conclusion.trim().length < 10 || form.tool.trim().length < 2 || form.method.trim().length < 3}
            loading={save.pending}
            onClick={async () => (await save.run(undefined as never)) && onDone()}
          >
            {supersedes ? t("lab.fileCorrection") : t("lab.fileReport")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {supersedes && (
          <p className="rounded-lg bg-surface-2 px-3 py-2 font-ui text-2xs text-muted">
            {t("lab.supersedes")} v{supersedes.version ?? 1}: {supersedes.conclusion}
          </p>
        )}
        <Field label={t("lab.conclusion")} required hint={t("lab.conclusionHint")}>
          <Textarea rows={3} value={form.conclusion} onChange={(e) => setForm({ ...form, conclusion: e.target.value })} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("lab.tool")} required>
            <Input value={form.tool} onChange={(e) => setForm({ ...form, tool: e.target.value })} />
          </Field>
          <Field label={t("lab.method")} required>
            <Input value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} />
          </Field>
        </div>
        <Field label={t("lab.detail")}>
          <Textarea rows={6} value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} />
        </Field>
        <ErrorLine error={save.error} />
      </div>
    </Modal>
  );
}

/* ================================================= documents (F11, F13) */

export function DocumentsCard({ item }: { item: EvidenceRow }) {
  const { user } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const [certOpen, setCertOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const history = useQuery<{ movements: { id: string; movement: string; location: string; shelf: string | null; reason: string; occurred_at: string; verification: { state: any } | null }[] }>(
    `/api/police/evidence/${item.id}/malkhana`
  );
  const canCertify = has(user?.role, "police", "forensic_lab", "prosecutor", "judge", "court_admin");
  if (user?.role === "accused") return null;

  const run = async (key: string, task: () => Promise<{ sha256: string | null }>) => {
    setBusy(key);
    try {
      const { sha256 } = await task();
      if (sha256) toast.success(t("docs.produced"), `SHA-256 ${shortHash(sha256, 14, 8)}`);
    } catch (caught) {
      toast.error(t("docs.failed"), caught instanceof Error ? caught.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title={t("docs.title")} subtitle={t("docs.subtitle")}>
      <div className="flex flex-wrap gap-2">
        {canCertify && (
          <Button size="sm" icon={<FileCheck2 size={13} />} onClick={() => setCertOpen(true)}>
            {t("docs.certificate")}
          </Button>
        )}
        <Button size="sm" variant="secondary" icon={<FileDown size={13} />} loading={busy === "custody"} onClick={() => void run("custody", () => fetchDocument(`/api/police/evidence/${item.id}/custody-form.pdf`, { fileName: `custody-form-${item.public_ref}.pdf`, open: true }))}>
          {t("docs.custodyForm")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon={<Archive size={13} />}
          loading={busy === "bundle"}
          onClick={() => void run("bundle", () => fetchDocument(`/api/governance/export?caseId=${item.case_id}&evidenceId=${item.id}`, { fileName: `nyaysetu-${item.public_ref}.zip` }))}
        >
          {t("docs.bundle")}
        </Button>
      </div>
      <p className="mt-2 font-ui text-2xs leading-relaxed text-faint">{t("docs.templateCaution")}</p>

      {(history.data?.movements.length ?? 0) > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <p className="mb-2 flex items-center gap-1.5 font-ui text-xs font-semibold text-text">
            <Boxes size={13} aria-hidden /> {t("malkhana.title")}
          </p>
          <ol className="space-y-1.5">
            {history.data!.movements.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2 font-ui text-2xs text-muted">
                <span className="font-semibold text-text">{t(`malkhana.movement.${m.movement}` as MessageKey)}</span>
                <span>
                  {m.location}
                  {m.shelf ? ` / ${m.shelf}` : ""} · {formatDateTime(m.occurred_at)}
                </span>
                {m.verification && <VerificationBadge state={m.verification.state} short />}
              </li>
            ))}
          </ol>
        </div>
      )}

      {certOpen && <CertificateDialog item={item} onClose={() => setCertOpen(false)} />}
    </Card>
  );
}

function CertificateDialog({ item, onClose }: { item: EvidenceRow; onClose: () => void }) {
  const { user } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const [form, setForm] = useState({ custodianName: user?.fullName ?? "", custodianDesignation: "", deviceDescription: "", productionMethod: "" });
  const [error, setError] = useState<Error | null>(null);
  const [pending, setPending] = useState(false);
  const [sha, setSha] = useState<string | null>(null);

  const generate = async () => {
    setPending(true);
    setError(null);
    try {
      const body = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v.trim() || null]));
      const { sha256 } = await fetchDocument(`/api/evidence/${item.id}/certificate`, { method: "POST", body, fileName: `section63-${item.public_ref}.pdf`, open: true });
      setSha(sha256);
      toast.success(t("docs.produced"));
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-2xl"
      title={t("docs.certificate")}
      description={t("docs.certificateHint")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button icon={<FileCheck2 size={13} />} loading={pending} onClick={() => void generate()}>
            {t("docs.generate")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("docs.custodianName")}>
            <Input value={form.custodianName} onChange={(e) => setForm({ ...form, custodianName: e.target.value })} />
          </Field>
          <Field label={t("docs.custodianDesignation")}>
            <Input value={form.custodianDesignation} onChange={(e) => setForm({ ...form, custodianDesignation: e.target.value })} />
          </Field>
        </div>
        <Field label={t("docs.deviceDescription")} hint={t("docs.autoFilled")}>
          <Textarea rows={2} value={form.deviceDescription} onChange={(e) => setForm({ ...form, deviceDescription: e.target.value })} />
        </Field>
        <Field label={t("docs.productionMethod")} hint={t("docs.autoFilled")}>
          <Textarea rows={2} value={form.productionMethod} onChange={(e) => setForm({ ...form, productionMethod: e.target.value })} />
        </Field>
        <ErrorLine error={error} />
        {sha && <HashBadge hash={sha} label={t("docs.pdfDigest")} full />}
        <p className="rounded-lg bg-warning-soft px-3 py-2 font-ui text-2xs leading-relaxed text-text">{t("docs.templateCaution")}</p>
      </div>
    </Modal>
  );
}

/* ===================================================== governance (F19) */

const DISPOSAL_METHODS = ["returned_to_owner", "destroyed", "auctioned", "transferred", "retained_by_court"] as const;

export function GovernanceCard({ item, onChanged }: { item: EvidenceRow; onChanged: () => void }) {
  const { user } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const holds = useQuery<{ holds: { id: string; subject_type: string; subject_id: string; reason: string; placed_at: string; released_at: string | null }[] }>(
    `/api/governance/cases/${item.case_id}/holds`
  );
  const approvals = useQuery<{ approvals: { id: string; action: string; subject_id: string; status: string; reason: string; created_at: string }[] }>(
    `/api/governance/approvals?caseId=${item.case_id}`
  );
  const verification = useQuery<{ verification: { state: string } }>(`/api/evidence/${item.id}/verification`);
  const verificationState = verification.data?.verification.state ?? null;
  const [dialog, setDialog] = useState<null | "destroy" | "release" | "hold">(null);

  const role = user?.role;
  const canDispose = has(role, "police", "court_admin");
  const canRelease = has(role, "police", "forensic_lab", "prosecutor", "court_admin") && verificationState === "INTEGRITY_MISMATCH";
  const canHold = has(role, "judge", "prosecutor", "court_admin");
  if (!has(role, "police", "forensic_lab", "prosecutor", "judge", "court_admin")) return null;

  const activeHolds = (holds.data?.holds ?? []).filter((h) => !h.released_at && (h.subject_type === "case" || h.subject_id === item.id));
  const mine = (approvals.data?.approvals ?? []).filter((a) => a.subject_id === item.id);
  const disposed = Boolean((item as EvidenceRow & { disposed_at?: string | null }).disposed_at);

  if (!canDispose && !canRelease && !canHold && activeHolds.length === 0 && mine.length === 0) return null;

  return (
    <Card title={t("gov.title")} subtitle={t("gov.subtitle")}>
      <div className="space-y-3">
        {disposed && <p className="rounded-lg bg-surface-2 px-3 py-2 font-ui text-xs text-text">{t("gov.disposed")}</p>}
        {activeHolds.map((h) => (
          <p key={h.id} className="flex gap-2 rounded-lg border border-warning-soft bg-warning-soft px-3 py-2 font-ui text-xs text-text">
            <Lock size={13} className="mt-0.5 shrink-0 text-warning" aria-hidden />
            <span>
              <strong>{h.subject_type === "case" ? t("gov.caseHold") : t("gov.itemHold")}:</strong> {h.reason}
            </span>
          </p>
        ))}
        {mine.length > 0 && (
          <ul className="space-y-1.5">
            {mine.map((a) => (
              <li key={a.id} className="rounded-lg bg-surface-2 px-3 py-2 font-ui text-2xs text-muted">
                <span className="font-semibold text-text">{t(`gov.action.${a.action}` as MessageKey)}</span> · {t(`gov.status.${a.status}` as MessageKey)} · {formatDateTime(a.created_at)}
                <p className="mt-0.5 text-text">{a.reason}</p>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          {canRelease && (
            <Button size="sm" variant="secondary" icon={<ShieldAlert size={13} />} onClick={() => setDialog("release")}>
              {t("gov.requestRelease")}
            </Button>
          )}
          {canDispose && !disposed && (
            <Button size="sm" variant="secondary" disabled={activeHolds.length > 0} onClick={() => setDialog("destroy")}>
              {t("gov.requestDisposal")}
            </Button>
          )}
          {canHold && (
            <Button size="sm" variant="secondary" icon={<Lock size={13} />} onClick={() => setDialog("hold")}>
              {t("gov.placeHold")}
            </Button>
          )}
        </div>
        <p className="font-ui text-2xs leading-relaxed text-faint">{t("gov.twoPeople")}</p>
      </div>
      {dialog && (
        <GovernanceDialog
          kind={dialog}
          item={item}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            holds.refetch();
            approvals.refetch();
            verification.refetch();
            onChanged();
            toast.success(dialog === "hold" ? t("gov.holdPlaced") : t("gov.requested"));
          }}
        />
      )}
    </Card>
  );
}

function GovernanceDialog({ kind, item, onClose, onDone }: { kind: "destroy" | "release" | "hold"; item: EvidenceRow; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState("");
  const [method, setMethod] = useState<(typeof DISPOSAL_METHODS)[number]>("returned_to_owner");
  const [holdScope, setHoldScope] = useState<"evidence" | "case">("evidence");
  const save = useMutation(async () => {
    if (kind === "hold") {
      return api.post("/api/governance/holds", { subjectType: holdScope, subjectId: holdScope === "case" ? item.case_id : item.id, caseId: item.case_id, reason: reason.trim() });
    }
    return api.post("/api/governance/approvals", {
      action: kind === "destroy" ? "evidence_destroy" : "custody_after_mismatch",
      subjectId: item.id,
      reason: reason.trim(),
      ...(kind === "destroy" ? { payload: { method } } : {}),
    });
  });
  const title = kind === "hold" ? t("gov.placeHold") : kind === "destroy" ? t("gov.requestDisposal") : t("gov.requestRelease");

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      description={kind === "hold" ? t("gov.holdHint") : kind === "destroy" ? t("gov.disposalHint") : t("gov.releaseHint")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={reason.trim().length < 10} loading={save.pending} onClick={async () => (await save.run(undefined as never)) && onDone()}>
            {title}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {kind === "destroy" && (
          <Field label={t("gov.method")} required>
            <Select value={method} onChange={(e) => setMethod(e.target.value as (typeof DISPOSAL_METHODS)[number])}>
              {DISPOSAL_METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`gov.method.${m}` as MessageKey)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {kind === "hold" && (
          <Field label={t("gov.holdScope")}>
            <Select value={holdScope} onChange={(e) => setHoldScope(e.target.value as "evidence" | "case")}>
              <option value="evidence">{t("gov.itemHold")}</option>
              <option value="case">{t("gov.caseHold")}</option>
            </Select>
          </Field>
        )}
        <Field label={t("gov.reason")} required hint={t("gov.reasonHint")}>
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <ErrorLine error={save.error} />
      </div>
    </Modal>
  );
}
