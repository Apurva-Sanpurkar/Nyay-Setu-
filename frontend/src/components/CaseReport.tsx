import { useState } from "react";
import { Download, FileText, Mail, Plus, Send, ShieldCheck, X } from "lucide-react";
import { api, ApiError, type Role } from "../lib/api";
import { useMutation, useQuery } from "../lib/useApi";
import { useToast } from "../context/ToastContext";
import { useAuth } from "../context/AuthContext";
import { ROLE_LABEL } from "../lib/format";
import { Button, Card, Field, Input, Modal, Textarea } from "./ui";

/**
 * Producing and serving the Final Report.
 *
 * The document is rendered by the API, not here. A charge sheet has to be the same
 * document every time it is produced and has to contain everything the record
 * holds, which makes it a function of the database rather than of whatever this
 * screen had loaded. So this component does two things only: ask for the bytes, and
 * say who they should go to.
 */

interface Recipient {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  access: string;
}

const CAN_EMAIL: Role[] = ["police", "prosecutor", "judge", "court_admin"];

export function CaseReportPanel({ caseId, firNumber }: { caseId: string; firNumber: string }) {
  const toast = useToast();
  const { user } = useAuth();
  const [emailOpen, setEmailOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const mayEmail = user ? CAN_EMAIL.includes(user.role) : false;

  /**
   * Fetched through the API client rather than by pointing the browser at the URL,
   * because the session is an HttpOnly cookie and a plain link would work but would
   * lose the digest header — and that header is the point: it lets whoever receives
   * the file confirm they received the bytes that were sent.
   */
  const download = async () => {
    setDownloading(true);
    try {
      const response = await api.download(`/api/reports/cases/${caseId}/final-report.pdf`);
      const digest = response.headers.get("x-nyaysetu-sha256");
      const blob = await response.blob();

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `final-report-${firNumber.replace(/[^A-Za-z0-9]+/g, "-")}.pdf`;
      anchor.click();
      URL.revokeObjectURL(url);

      toast.success(
        "Final Report downloaded",
        digest ? `SHA-256 ${digest.slice(0, 18)}… — quoted in the document itself.` : undefined
      );
    } catch (caught) {
      toast.error(
        "Could not produce the report",
        caught instanceof ApiError ? caught.message : "Try again."
      );
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      <Card
        title="Final Report"
        subtitle="The charge sheet under Section 193 BNSS, with the schedule of electronic records and the certificate under Section 63 BSA."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<Download size={13} />}
              loading={downloading}
              onClick={() => void download()}
            >
              Download PDF
            </Button>
            {mayEmail && (
              <Button size="sm" icon={<Mail size={13} />} onClick={() => setEmailOpen(true)}>
                Send by email
              </Button>
            )}
          </div>
        }
      >
        <ul className="space-y-2.5">
          {[
            "Items 1 to 18 of the prescribed final report, from the case record.",
            "Annexure A — every section charged, with its heading and punishment from the Bharatiya Nyaya Sanhita.",
            "Annexure B — each exhibit, its SHA-256 digest, and the whole chain of custody with the transaction that recorded each transfer.",
            "Annexure C — the certificate for electronic records, with instructions a recipient can follow without asking the prosecution for anything.",
          ].map((line) => (
            <li key={line} className="flex gap-2.5">
              <FileText size={13} className="mt-0.5 shrink-0 text-primary" />
              <span className="font-ui text-xs leading-relaxed text-muted">{line}</span>
            </li>
          ))}
        </ul>

        <p className="mt-4 flex items-start gap-2 rounded-card border border-border bg-surface-raised px-3.5 py-2.5 font-ui text-2xs leading-relaxed text-muted">
          <ShieldCheck size={12} className="mt-0.5 shrink-0 text-primary" />
          The endorsement blocks are left blank. The document is produced by this system and signed by
          an officer, and it does not pretend to do the second.
        </p>
      </Card>

      <EmailReportModal
        open={emailOpen}
        onClose={() => setEmailOpen(false)}
        caseId={caseId}
        firNumber={firNumber}
      />
    </>
  );
}

/**
 * Choosing who receives it.
 *
 * Defaults to the people assigned to the case, because those are the people
 * entitled to it and that list is already maintained. Extra addresses are typed in
 * for the ones who are not on the platform — a Sessions registry, a superior
 * officer, counsel without an account yet.
 */
function EmailReportModal({
  open,
  onClose,
  caseId,
  firNumber,
}: {
  open: boolean;
  onClose: () => void;
  caseId: string;
  firNumber: string;
}) {
  const toast = useToast();
  const recipients = useQuery<{ emailConfigured: boolean; recipients: Recipient[] }>(
    open ? `/api/reports/cases/${caseId}/final-report/recipients` : null,
    [caseId, open]
  );

  const [includeAssigned, setIncludeAssigned] = useState(true);
  const [extra, setExtra] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");

  const send = useMutation(async () =>
    api.post<{ sent: number; failed: number; digest: string; results: { to: string; status: string }[] }>(
      `/api/reports/cases/${caseId}/final-report/email`,
      {
        includeAssigned,
        recipients: extra,
        note: note.trim() || undefined,
      }
    )
  );

  const valid = /\S+@\S+\.\S+/.test(draft.trim());
  const assignedCount = recipients.data?.recipients.length ?? 0;
  const total = (includeAssigned ? assignedCount : 0) + extra.length;

  const addDraft = () => {
    const address = draft.trim().toLowerCase();
    if (!valid || extra.includes(address)) return;
    setExtra([...extra, address]);
    setDraft("");
  };

  const close = () => {
    send.reset();
    setExtra([]);
    setDraft("");
    setNote("");
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={`Send the Final Report — ${firNumber}`}
      description="The PDF is attached, and the covering email carries its SHA-256 so the recipient can confirm nothing changed in transit. Each copy is sent separately, so nobody learns who else received it."
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            icon={<Send size={13} />}
            loading={send.pending}
            disabled={total === 0 || recipients.data?.emailConfigured === false}
            onClick={async () => {
              const outcome = await send.run(undefined as never);
              if (outcome) {
                if (outcome.failed === 0) {
                  toast.success(
                    `Sent to ${outcome.sent} recipient${outcome.sent === 1 ? "" : "s"}`,
                    `SHA-256 ${outcome.digest.slice(0, 16)}…`
                  );
                  close();
                } else {
                  toast.error(
                    `${outcome.failed} of ${outcome.sent + outcome.failed} could not be delivered`,
                    "The rest went out. See the email log under the registry."
                  );
                }
              }
            }}
          >
            Send {total > 0 ? `to ${total}` : ""}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {recipients.data?.emailConfigured === false && (
          <p className="rounded-card border border-warning-soft bg-warning-soft px-3.5 py-3 font-ui text-xs leading-relaxed text-text">
            No mail server is configured on this deployment, so nothing can be sent. Download the PDF
            and send it yourself.
          </p>
        )}

        <div>
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={includeAssigned}
              onChange={(event) => setIncludeAssigned(event.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--primary-fill)]"
            />
            <span>
              <span className="block font-ui text-sm font-medium text-text">
                Everyone assigned to this case ({assignedCount})
              </span>
              <span className="block font-ui text-2xs leading-relaxed text-muted">
                Including defence counsel. A charge sheet is served on the accused as a matter of law.
              </span>
            </span>
          </label>

          {includeAssigned && assignedCount > 0 && (
            <ul className="mt-3 space-y-1.5 rounded-card border border-border bg-surface-raised px-3.5 py-3">
              {recipients.data?.recipients.map((r) => (
                <li key={r.id} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0">
                    <span className="font-ui text-xs text-text">{r.fullName}</span>
                    <span className="ml-2 font-ui text-2xs text-faint">{ROLE_LABEL[r.role]}</span>
                  </span>
                  <span className="shrink-0 font-mono text-2xs text-muted">{r.email}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <Field
          label="Other addresses"
          hint="For anyone not on the platform — a registry, a superior officer, counsel without an account."
        >
          <div className="flex gap-2">
            <Input
              type="email"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addDraft();
                }
              }}
              placeholder="registry@districtcourt.gov.in"
            />
            <Button variant="secondary" icon={<Plus size={13} />} disabled={!valid} onClick={addDraft}>
              Add
            </Button>
          </div>
        </Field>

        {extra.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {extra.map((address) => (
              <li
                key={address}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-raised px-2.5 py-1"
              >
                <span className="font-mono text-2xs text-text">{address}</span>
                <button
                  type="button"
                  onClick={() => setExtra(extra.filter((a) => a !== address))}
                  aria-label={`Remove ${address}`}
                  className="text-faint transition hover:text-danger"
                >
                  <X size={11} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <Field
          label="Covering note"
          hint="Optional, and deliberately short. The document is the communication; a note that restates it creates a second version that can disagree."
        >
          <Textarea
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Filed before the Court of Sessions, Pune, on…"
          />
        </Field>

        {send.error && (
          <p role="alert" className="font-ui text-xs text-danger">
            {send.error.message}
          </p>
        )}
      </div>
    </Modal>
  );
}
