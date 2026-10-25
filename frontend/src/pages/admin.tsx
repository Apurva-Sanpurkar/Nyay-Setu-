import { useState } from "react";
import {
  Activity,
  AlertTriangle,
  Blocks,
  CheckCircle2,
  ClipboardList,
  Database,
  FileSearch,
  HardDrive,
  KeyRound,
  Link2Off,
  Mail,
  MailWarning,
  Plus,
  RefreshCw,
  ScrollText,
  Send,
  ShieldCheck,
  Trash2,
  Users as UsersIcon,
  Wallet,
} from "lucide-react";
import { api, type CaseRow, type HealthResponse, type Role } from "../lib/api";
import { useMutation, useQuery } from "../lib/useApi";
import { useToast } from "../context/ToastContext";
import { ROLE_LABEL, formatDateTime, formatEth, relativeTime } from "../lib/format";
import { shortHash } from "../lib/hash";
import { AsyncView, EmptyState } from "../components/DataState";
import {
  Button,
  Card,
  CopyButton,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Stat,
} from "../components/ui";
import { StatusChip, TxLink } from "../components/trust";
import { checkAadhaar, formatAadhaar } from "../lib/aadhaar";

/* ==================================================== AdminOverview ====== */

interface Stats {
  stats: {
    activeUsers: number;
    cases: number;
    evidenceItems: number;
    flaggedEvidence: number;
    summonsPending: number;
    summonsFailed: number;
    activeBailOrders: number;
    openViolations: number;
  };
}

export function AdminOverview() {
  const toast = useToast();
  const stats = useQuery<Stats>("/api/admin/stats", [], { pollMs: 60_000 });
  const health = useQuery<HealthResponse>("/api/health", [], { pollMs: 30_000 });

  const sweepSummons = useMutation(async () => api.post<{ marked: number }>("/api/summons/sweep"));
  const sweepBail = useMutation(async () => api.post<{ flagged: number }>("/api/bail/sweep"));

  return (
    <>
      <PageHeader
        eyebrow="Court registry"
        title="System overview"
        description="Participants, case load, and the operational status of every service on which the platform depends."
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              loading={sweepSummons.pending}
              icon={<ScrollText size={13} />}
              onClick={async () => {
                const outcome = await sweepSummons.run(undefined as never);
                if (outcome)
                  toast.success(
                    outcome.marked === 0 ? "Nothing overdue" : `${outcome.marked} marked non-delivered`,
                    "The 72 hour sweep also runs automatically every two minutes."
                  );
              }}
            >
              Sweep summons
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={sweepBail.pending}
              icon={<RefreshCw size={13} />}
              onClick={async () => {
                const outcome = await sweepBail.run(undefined as never);
                if (outcome)
                  toast.success(
                    outcome.flagged === 0 ? "No check-in overdue" : `${outcome.flagged} flagged`,
                    "Missed check-ins are now recorded on chain."
                  );
              }}
            >
              Sweep check-ins
            </Button>
          </>
        }
      />

      <AsyncView state={stats} onRetry={stats.refetch} context="the statistics">
        {(data) => (
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Active participants" value={data.stats.activeUsers} icon={<UsersIcon size={14} />} />
            <Stat label="Cases" value={data.stats.cases} icon={<ClipboardList size={14} />} />
            <Stat
              label="Evidence items"
              value={data.stats.evidenceItems}
              hint={`${data.stats.flaggedEvidence} flagged at intake`}
              tone={data.stats.flaggedEvidence > 0 ? "warning" : "default"}
              icon={<Blocks size={14} />}
            />
            <Stat
              label="Active bail orders"
              value={data.stats.activeBailOrders}
              hint={`${data.stats.openViolations} open violations`}
              tone={data.stats.openViolations > 0 ? "danger" : "default"}
              icon={<Activity size={14} />}
            />
          </div>
        )}
      </AsyncView>

      <Card
        title="Subsystem health"
        subtitle="Every dependency reports whether it is configured and whether it actually answers."
      >
        <AsyncView state={health} onRetry={health.refetch} context="system health">
          {(data) => (
            <div className="space-y-3">
              <HealthRow
                icon={<Database size={16} />}
                name="Supabase Postgres"
                ok={data.subsystems.database.reachable}
                detail={
                  data.subsystems.database.reachable
                    ? "Reachable. Row level security is enabled on every table."
                    : "Unreachable. Check SUPABASE_URL and the service role key, and that the migrations have been run."
                }
              />

              <HealthRow
                icon={<Blocks size={16} />}
                name="Ethereum"
                ok={data.subsystems.blockchain.ready}
                detail={
                  data.subsystems.blockchain.ready
                    ? `${data.subsystems.blockchain.network?.name} (chain ${data.subsystems.blockchain.network?.chainId}) at block ${data.subsystems.blockchain.blockNumber}`
                    : data.subsystems.blockchain.reason
                }
              />

              <HealthRow
                icon={<HardDrive size={16} />}
                name="Evidence storage"
                ok={data.subsystems.storage.configured}
                warnOnly
                detail={data.subsystems.storage.note ?? data.subsystems.storage.backend}
              />

              <HealthRow
                icon={<Activity size={16} />}
                name="Model service"
                ok={data.subsystems.ai.reachable}
                warnOnly
                detail={
                  data.subsystems.ai.reachable
                    ? "Answering. Screening and risk scoring are live."
                    : (data.subsystems.ai.note ??
                      "Not reachable. Screening reports itself unavailable rather than claiming an item is clean.")
                }
              />

              <HealthRow
                icon={<KeyRound size={16} />}
                name="Identity provider"
                ok={data.subsystems.identity.authorisedForProduction}
                warnOnly
                detail={data.subsystems.identity.note ?? data.subsystems.identity.provider}
              />

              {data.subsystems.blockchain.ready && (
                <div className="mt-4 rounded-card border border-border bg-surface-2 p-4">
                  <p className="mb-3 flex items-center gap-2 font-ui text-xs font-semibold text-text">
                    <Wallet size={14} className="text-primary" />
                    Keeper wallet
                  </p>
                  <dl className="space-y-2">
                    <Row
                      label="Address"
                      value={
                        <code className="font-mono text-2xs">
                          {shortHash(data.subsystems.blockchain.keeper, 10, 8)}
                        </code>
                      }
                    />
                    <Row label="Balance" value={formatEth(data.subsystems.blockchain.keeperBalanceWei)} />
                  </dl>
                  {data.subsystems.blockchain.keeperBalanceWei === "0" && (
                    <p className="mt-2.5 font-ui text-2xs leading-relaxed text-danger">
                      The keeper has no ETH, so every citizen action it relays will fail. Fund it from a
                      Sepolia faucet.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </AsyncView>
      </Card>
    </>
  );
}

function HealthRow({
  icon,
  name,
  ok,
  detail,
  warnOnly,
}: {
  icon: React.ReactNode;
  name: string;
  ok: boolean;
  detail: string;
  /** A missing optional subsystem is a warning, not a failure. */
  warnOnly?: boolean;
}) {
  const tone = ok ? "border-success-soft bg-success-soft" : warnOnly ? "border-warning-soft bg-warning-soft" : "border-danger-soft bg-danger-soft";
  const iconTone = ok ? "text-success" : warnOnly ? "text-warning" : "text-danger";

  return (
    <div className={`flex gap-3 rounded-lg border p-3.5 ${tone}`}>
      <span className={`mt-0.5 shrink-0 ${iconTone}`}>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-ui text-sm font-semibold text-text">{name}</p>
          {ok ? (
            <StatusChip tone="success" label="OK" icon={<CheckCircle2 size={10} />} />
          ) : (
            <StatusChip
              tone={warnOnly ? "warning" : "danger"}
              label={warnOnly ? "Degraded" : "Down"}
              icon={warnOnly ? <AlertTriangle size={10} /> : <Link2Off size={10} />}
            />
          )}
        </div>
        <p className="mt-1 font-ui text-2xs leading-relaxed text-muted">{detail}</p>
      </div>
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

/* ======================================================= AdminUsers ====== */

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  designation: string | null;
  station_or_court: string | null;
  is_active: boolean;
  last_login_at: string | null;
  aadhaarOnFile: boolean;
  aadhaarLast4: string | null;
  /** Present once migration 006 has been applied. */
  must_change_password?: boolean;
  invited_at?: string | null;
  first_login_at?: string | null;
}

/**
 * What an invitation currently looks like from the registry's side.
 *
 * "Invited" and "never signed in" are different facts and a court administrator
 * chasing somebody needs both: one says the email went out, the other says
 * nothing came back.
 */
function inviteState(row: UserRow): { tone: "success" | "warning" | "neutral"; label: string } {
  if (row.must_change_password) return { tone: "warning", label: "Invited" };
  if (!row.last_login_at) return { tone: "neutral", label: "Never signed in" };
  return { tone: "success", label: "Active" };
}

export function AdminUsers() {
  const toast = useToast();
  const users = useQuery<{ users: UserRow[] }>("/api/admin/users?limit=200");
  const [createOpen, setCreateOpen] = useState(false);
  const [inviting, setInviting] = useState<UserRow | null>(null);
  const [aadhaarFor, setAadhaarFor] = useState<UserRow | null>(null);
  const [removing, setRemoving] = useState<UserRow | null>(null);

  const toggle = useMutation(async (args: { id: string; isActive: boolean }) =>
    api.patch(`/api/admin/users/${args.id}`, { isActive: args.isActive })
  );

  return (
    <>
      <PageHeader
        eyebrow="Court registry"
        title="Participants"
        description="Every account on the platform. Accounts are created only by the registry; a new holder must replace the temporary password before using the system. Deactivating an account ends its active sessions immediately."
        actions={
          <Button icon={<Plus size={14} />} onClick={() => setCreateOpen(true)}>
            Invite a participant
          </Button>
        }
      />

      <Card title="Accounts">
        <AsyncView
          state={users}
          onRetry={users.refetch}
          context="participants"
          isEmpty={(data) => data.users.length === 0}
          empty={
            <EmptyState
              title="No participants yet"
              description="Invite the first officer, lab analyst or judge. They receive a one-time password by email and choose their own on first sign-in."
              icon={<UsersIcon size={19} />}
            />
          }
        >
          {(data) => (
            <div className="-mx-5 overflow-x-auto">
              <table className="w-full min-w-[820px] border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    {["Name", "Role", "Posting", "Aadhaar", "Last seen", "Account", ""].map((heading) => (
                      <th
                        key={heading}
                        className="px-5 py-2.5 text-left font-ui text-2xs font-semibold uppercase tracking-wider text-faint"
                      >
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.users.map((row) => (
                    <tr key={row.id} className="border-b border-border last:border-0">
                      <td className="px-5 py-3">
                        <p className="font-ui text-sm font-medium text-text">{row.full_name}</p>
                        <p className="font-ui text-2xs text-muted">{row.email}</p>
                      </td>
                      <td className="px-5 py-3">
                        <span className="font-ui text-xs text-text">{ROLE_LABEL[row.role]}</span>
                      </td>
                      <td className="px-5 py-3">
                        <span className="font-ui text-2xs text-muted">{row.station_or_court ?? "—"}</span>
                      </td>
                      <td className="px-5 py-3">
                        {row.aadhaarOnFile ? (
                          <span className="font-mono text-2xs text-muted">•••• {row.aadhaarLast4}</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setAadhaarFor(row)}
                            className="rounded-full border border-warning-soft bg-warning-soft px-2.5 py-1 font-ui text-2xs font-semibold text-warning transition hover:border-warning"
                            title="Without this, every action that writes to the chain is refused"
                          >
                            Missing — add
                          </button>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <span className="font-ui text-2xs text-muted">
                          {row.last_login_at ? relativeTime(row.last_login_at) : "never"}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        {row.is_active ? (
                          <StatusChip {...inviteState(row)} />
                        ) : (
                          <StatusChip tone="neutral" label="Disabled" />
                        )}
                        {row.invited_at && row.must_change_password && (
                          <p className="mt-1 font-ui text-2xs text-faint">
                            emailed {relativeTime(row.invited_at)}
                          </p>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<Send size={12} />}
                            disabled={!row.is_active}
                            onClick={() => setInviting(row)}
                          >
                            {row.must_change_password ? "Resend" : "Reset"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<Trash2 size={12} />}
                            onClick={() => setRemoving(row)}
                          >
                            Remove
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              const outcome = await toggle.run({
                                id: row.id,
                                isActive: !row.is_active,
                              });
                              if (outcome) {
                                toast.success(
                                  row.is_active ? "Account disabled" : "Account enabled",
                                  row.is_active
                                    ? "Its live sessions have been revoked."
                                    : undefined
                                );
                                users.refetch();
                              }
                            }}
                          >
                            {row.is_active ? "Disable" : "Enable"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AsyncView>
      </Card>

      <CreateUserModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => users.refetch()}
      />

      <ReinviteModal
        target={inviting}
        onClose={() => setInviting(null)}
        onSent={() => users.refetch()}
      />

      <AadhaarModal
        target={aadhaarFor}
        onClose={() => setAadhaarFor(null)}
        onSaved={() => users.refetch()}
      />

      <RemoveUserModal
        target={removing}
        onClose={() => setRemoving(null)}
        onDone={() => users.refetch()}
      />
    </>
  );
}

/**
 * Deleting an account, and the more common case of being told not to.
 *
 * Most accounts cannot be deleted, and that is the feature rather than the
 * limitation: once somebody has collected an exhibit or issued a summons, the
 * record names them and the database refuses to erase them. So this dialog puts
 * the alternative in front of the administrator before they click, and when the
 * refusal comes it shows the server's own explanation rather than "delete failed".
 */
function RemoveUserModal({
  target,
  onClose,
  onDone,
}: {
  target: UserRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const remove = useMutation(async (id: string) => api.del<{ deleted: string }>(`/api/admin/users/${id}`));

  const close = () => {
    remove.reset();
    onClose();
  };

  return (
    <Modal
      open={Boolean(target)}
      onClose={close}
      title="Remove this account"
      description="Only possible while nothing in the case record names them. This cannot be undone."
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            loading={remove.pending}
            icon={<Trash2 size={13} />}
            onClick={async () => {
              if (!target) return;
              const outcome = await remove.run(target.id);
              if (outcome) {
                toast.success("Account removed", `${target.full_name} no longer exists.`);
                onDone();
                close();
              } else {
                // The refusal is the interesting case, so the dialog stays open
                // with the reason on it rather than closing on an error toast.
                onDone();
              }
            }}
          >
            Remove permanently
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-card border border-border bg-surface-raised px-4 py-3">
          <p className="font-ui text-sm font-medium text-text">{target?.full_name}</p>
          <p className="font-mono text-2xs text-muted">{target?.email}</p>
          <p className="mt-1 font-ui text-2xs text-muted">
            {target ? ROLE_LABEL[target.role] : ""}
            {target?.last_login_at ? " · has signed in" : " · never signed in"}
          </p>
        </div>

        <p className="font-ui text-xs leading-relaxed text-muted">
          If this person has collected evidence, taken custody, issued a summons or granted bail, the
          database will refuse — they are part of that record's provenance. Disabling instead keeps
          the history and stops them signing in, and can be reversed.
        </p>

        {remove.error && (
          <p
            role="alert"
            className="rounded-card border border-warning-soft bg-warning-soft px-3.5 py-3 font-ui text-xs leading-relaxed text-text"
          >
            {remove.error.message}
          </p>
        )}
      </div>
    </Modal>
  );
}

/**
 * Completes a record after the fact.
 *
 * The number is sent once and never stored: the server validates its check digit,
 * HMACs it with a server-side pepper and keeps the token and the last four digits.
 * There is no screen anywhere that can show it back, which is the point.
 */
function AadhaarModal({
  target,
  onClose,
  onSaved,
}: {
  target: UserRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [value, setValue] = useState("");
  const save = useMutation(async (id: string) =>
    api.put<{ aadhaarLast4: string }>(`/api/admin/users/${id}/aadhaar`, {
      aadhaarNumber: value.replace(/[^0-9]/g, ""),
    })
  );

  const close = () => {
    setValue("");
    onClose();
  };

  return (
    <Modal
      open={Boolean(target)}
      onClose={close}
      title="Complete this record"
      description="The number is converted to a one-way token and discarded. Only the token and the last four digits are kept, and nothing can show the number again."
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={checkAadhaar(value).state !== "valid"}
            loading={save.pending}
            onClick={async () => {
              if (!target) return;
              const outcome = await save.run(target.id);
              if (outcome) {
                toast.success(
                  "Record completed",
                  `${target.full_name} can now act on the chain.`
                );
                onSaved();
                close();
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="font-ui text-xs leading-relaxed text-muted">
          {target?.full_name} · {target ? ROLE_LABEL[target.role] : ""}
        </p>
        <AadhaarField required value={value} onChange={setValue} />
        {save.error && (
          <p role="alert" className="font-ui text-xs text-danger">
            {save.error.message}
          </p>
        )}
      </div>
    </Modal>
  );
}

/**
 * The panel that hands a credential over.
 *
 * Shown after a successful invitation whether or not the email went out, because
 * the administrator is the fallback channel: if the mail server refused the
 * message, this is the only copy of the password that exists, and once this modal
 * closes the platform holds nothing but its hash.
 */
function CredentialPanel({
  email,
  password,
  delivery,
}: {
  email: string;
  password: string;
  delivery: { status: string; error?: string | null; forcedChange?: boolean };
}) {
  const sent = delivery.status === "sent";

  return (
    <div className="space-y-4">
      <div
        className={`rounded-card border px-4 py-3 ${
          sent ? "border-success-soft bg-success-soft" : "border-warning-soft bg-warning-soft"
        }`}
      >
        <p className="flex items-center gap-1.5 font-ui text-xs font-semibold text-text">
          {sent ? <CheckCircle2 size={13} /> : <MailWarning size={13} />}
          {sent ? "The invitation was emailed" : "The invitation could not be emailed"}
        </p>
        <p className="mt-1 font-ui text-2xs leading-relaxed text-muted">
          {sent
            ? `Sent to ${email}. The password below is in that message; you do not need to pass it on.`
            : delivery.error ??
              "The mail server refused the message. Give the password below to its holder by some other means."}
        </p>
      </div>

      <div className="rounded-card border border-border bg-surface-raised px-4 py-3.5">
        <p className="font-ui text-2xs uppercase tracking-wider text-faint">Email</p>
        <p className="mt-1 break-all font-mono text-sm text-text">{email}</p>

        <p className="mt-3.5 font-ui text-2xs uppercase tracking-wider text-faint">
          One-time password
        </p>
        <div className="mt-1 flex items-center gap-2">
          <p className="flex-1 break-all font-mono text-base font-bold tracking-wide text-primary">
            {password}
          </p>
          <CopyButton value={password} label="Copy" />
        </div>
      </div>

      <p className="font-ui text-2xs leading-relaxed text-muted">
        {delivery.forcedChange === false ? (
          <>
            Migration <code className="font-mono">006_invitations.sql</code> has not been applied, so
            this password will not expire on first use. Run it and re-invite.
          </>
        ) : (
          <>
            This works once. The platform refuses every route for this account until its holder has
            chosen a password of their own, so nothing can be done with a copy of it afterwards.
          </>
        )}
      </p>

      <p className="font-ui text-2xs leading-relaxed text-faint">
        This is the only time it is shown. Only its hash is stored; if it is lost, send a new
        invitation rather than trying to recover this one.
      </p>
    </div>
  );
}

interface InviteResult {
  temporaryPassword: string;
  invitation: { status: string; error?: string | null; forcedChange?: boolean };
}

/**
 * Re-invite, which is also the password-reset path.
 *
 * Deliberately not self-service. A reset link sitting in an inbox is the same
 * exposure as a password sitting in an inbox, and a court can afford to make
 * somebody ask a registrar. It rotates the credential, so whatever was in the
 * previous email stops working.
 */
function ReinviteModal({
  target,
  onClose,
  onSent,
}: {
  target: UserRow | null;
  onClose: () => void;
  onSent: () => void;
}) {
  const [result, setResult] = useState<InviteResult | null>(null);
  const send = useMutation(async (id: string) => api.post<InviteResult>(`/api/admin/users/${id}/invite`));

  const close = () => {
    setResult(null);
    onClose();
  };

  return (
    <Modal
      open={Boolean(target)}
      onClose={close}
      title={result ? "New password issued" : "Send a new invitation"}
      description={
        result
          ? undefined
          : "A fresh one-time password is generated and emailed. Whatever was in the previous invitation stops working, and every live session on this account is signed out."
      }
      width="max-w-lg"
      footer={
        result ? (
          <Button onClick={close}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              loading={send.pending}
              icon={<Send size={13} />}
              onClick={async () => {
                if (!target) return;
                const outcome = await send.run(target.id);
                if (outcome) {
                  setResult(outcome);
                  onSent();
                }
              }}
            >
              Send it
            </Button>
          </>
        )
      }
    >
      {result && target ? (
        <CredentialPanel
          email={target.email}
          password={result.temporaryPassword}
          delivery={result.invitation}
        />
      ) : (
        <div className="space-y-3">
          <p className="font-ui text-sm text-text">
            {target?.full_name}{" "}
            <span className="font-ui text-xs text-muted">
              · {target ? ROLE_LABEL[target.role] : ""}
            </span>
          </p>
          <p className="font-mono text-xs text-muted">{target?.email}</p>
          {send.error && (
            <p role="alert" className="font-ui text-xs text-danger">
              {send.error.message}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

function CreateUserModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    email: "",
    fullName: "",
    role: "police" as Role,
    designation: "",
    stationOrCourt: "",
    aadhaarNumber: "",
    phone: "",
  });
  const [result, setResult] = useState<InviteResult | null>(null);

  const create = useMutation(async () =>
    api.post<InviteResult>("/api/admin/users", {
      email: form.email.trim(),
      fullName: form.fullName.trim(),
      role: form.role,
      designation: form.designation.trim() || undefined,
      stationOrCourt: form.stationOrCourt.trim() || undefined,
      aadhaarNumber: form.aadhaarNumber.replace(/[^0-9]/g, "") || undefined,
      phone: form.phone.trim() || undefined,
    })
  );

  const valid = /\S+@\S+\.\S+/.test(form.email) && form.fullName.trim().length >= 3;
  // A complete, checksum-valid number or none at all. A half-typed one is a typo
  // rather than a decision, and a twelve-digit number that fails its check digit is
  // a number the API will refuse anyway — better to say so before the round trip.
  const aadhaarVerdict = checkAadhaar(form.aadhaarNumber);
  const aadhaarUsable = aadhaarVerdict.state === "empty" || aadhaarVerdict.state === "valid";

  const close = () => {
    setResult(null);
    setForm({
      email: "",
      fullName: "",
      role: "police",
      designation: "",
      stationOrCourt: "",
      aadhaarNumber: "",
      phone: "",
    });
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={result ? "Invitation issued" : "Invite a participant"}
      description={
        result
          ? undefined
          : "You do not choose their password. One is generated, emailed to the address below, and expires the first time it is used. An Aadhaar number entered here is converted to a one-way token and discarded; only the token and the last four digits are kept."
      }
      width="max-w-xl"
      footer={
        result ? (
          <Button onClick={close}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              disabled={!valid || !aadhaarUsable}
              loading={create.pending}
              icon={<Send size={13} />}
              onClick={async () => {
                const outcome = await create.run(undefined as never);
                if (outcome) {
                  setResult(outcome);
                  onCreated();
                }
              }}
            >
              Create and invite
            </Button>
          </>
        )
      }
    >
      {result ? (
        <CredentialPanel
          email={form.email.trim()}
          password={result.temporaryPassword}
          delivery={result.invitation}
        />
      ) : (
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" required>
            <Input value={form.fullName} onChange={(event) => setForm({ ...form, fullName: event.target.value })} />
          </Field>
          <Field label="Role" required>
            <Select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as Role })}>
              {(Object.keys(ROLE_LABEL) as Role[]).map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABEL[role]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Email" required>
          <Input
            type="email"
            value={form.email}
            onChange={(event) => setForm({ ...form, email: event.target.value })}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Designation">
            <Input
              value={form.designation}
              onChange={(event) => setForm({ ...form, designation: event.target.value })}
              placeholder="Inspector, Crime Branch"
            />
          </Field>
          <Field label="Station or court">
            <Input
              value={form.stationOrCourt}
              onChange={(event) => setForm({ ...form, stationOrCourt: event.target.value })}
            />
          </Field>
        </div>

        <div className="rounded-card border border-border bg-surface-raised px-4 py-3">
          <p className="font-ui text-xs font-semibold text-text">
            Why the Aadhaar number is not optional
          </p>
          <p className="mt-1 font-ui text-2xs leading-relaxed text-muted">
            The token derived from it is the identity the contracts record against every action this
            person takes — the officer who collected an exhibit, the lab that received it, the judge
            who issued a summons. Without it they can sign in and read, and everything that writes to
            the chain is refused. You can add it later from the participants screen, but they cannot
            do their job until you do.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <AadhaarField
            required
            value={form.aadhaarNumber}
            onChange={(next) => setForm({ ...form, aadhaarNumber: next })}
          />
          <Field label="Phone" hint="Encrypted at rest.">
            <Input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
          </Field>
        </div>

        {aadhaarVerdict.state === "empty" && (
          <p className="font-ui text-xs leading-relaxed text-warning">
            Inviting without an Aadhaar number. They will be able to sign in and read, and every
            action that writes to the chain will be refused until you add one.
          </p>
        )}

        {create.error && (
          <p role="alert" className="font-ui text-xs text-danger">
            {create.error.message}
          </p>
        )}
      </div>
      )}
    </Modal>
  );
}

/* ====================================================== AdminAccess ====== */

/**
 * Per-case access.
 *
 * Holding a role is not the same as being on a case. A judge is a judge, but this
 * judge is on this case, and that distinction is what keeps a district's entire
 * evidence store from being readable by everyone who holds a badge. The API
 * mirrors it: assertCaseAccess checks the assignment on every case-scoped route,
 * and the RLS policies check it again in the database.
 *
 * Two rules are worth knowing before using this screen:
 *
 *   - The court registry is not listed. A court_admin sees every case by design,
 *     which is what makes this screen possible in the first place.
 *   - Defence counsel is always downgraded to read. The server does it, not this
 *     form, so it holds however the request was made.
 */
export function AdminAccess() {
  const toast = useToast();
  const cases = useQuery<{ cases: CaseRow[] }>("/api/cases");
  const users = useQuery<{ users: UserRow[] }>("/api/admin/users?limit=200");
  const [selected, setSelected] = useState<string | null>(null);

  const activeCase = selected ?? cases.data?.cases[0]?.id ?? null;

  return (
    <>
      <PageHeader
        eyebrow="Court registry"
        title="Case access"
        description="Assign participants to cases. A role grants access to a portal; an assignment grants access to a particular case. Without an assignment, every request for that case is refused by the server and by the database."
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
        <Card title="Cases" bodyClassName="!px-0 !py-0">
          <AsyncView
            state={cases}
            onRetry={cases.refetch}
            context="cases"
            isEmpty={(data) => data.cases.length === 0}
            empty={
              <EmptyState
                title="No cases yet"
                description="An FIR has to be registered by a police account before there is anything to grant access to."
                icon={<ClipboardList size={19} />}
              />
            }
          >
            {(data) => (
              <ul className="max-h-[620px] overflow-y-auto">
                {data.cases.map((row) => {
                  const active = row.id === activeCase;
                  return (
                    <li key={row.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(row.id)}
                        className={`flex w-full flex-col gap-0.5 border-l-2 px-4 py-3 text-left transition-colors duration-200 ${
                          active
                            ? "border-primary bg-primary-soft"
                            : "border-transparent hover:bg-surface-raised"
                        }`}
                      >
                        <span className="font-mono text-2xs text-muted">{row.case_reference}</span>
                        <span className="line-clamp-2 font-ui text-xs font-medium text-text">
                          {row.title}
                        </span>
                        <span className="font-ui text-2xs text-faint">{row.police_station}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </AsyncView>
        </Card>

        {activeCase ? (
          <CaseAccessPanel
            caseId={activeCase}
            users={users.data?.users ?? []}
            onChanged={() => toast.success("Access updated")}
          />
        ) : (
          <Card title="Access list">
            <EmptyState
              title="Nothing selected"
              description="Pick a case on the left."
              icon={<ShieldCheck size={19} />}
            />
          </Card>
        )}
      </div>
    </>
  );
}

interface Assignment {
  id: string;
  full_name: string;
  role: Role;
  designation: string | null;
  station_or_court: string | null;
  access: "read" | "write";
}

function CaseAccessPanel({
  caseId,
  users,
  onChanged,
}: {
  caseId: string;
  users: UserRow[];
  onChanged: () => void;
}) {
  const toast = useToast();
  const detail = useQuery<{ case: CaseRow; assignments: Assignment[] }>(
    `/api/cases/${caseId}`,
    [caseId]
  );

  const [userId, setUserId] = useState("");
  const [access, setAccess] = useState<"read" | "write">("read");

  const grant = useMutation(async () =>
    api.post<{ downgradedToRead: boolean }>(`/api/cases/${caseId}/assignments`, { userId, access })
  );
  const revoke = useMutation(async (id: string) =>
    api.del(`/api/cases/${caseId}/assignments/${id}`)
  );

  // The registry already sees everything, and an account that cannot sign in
  // cannot use an assignment, so neither is worth offering.
  const assigned = new Set((detail.data?.assignments ?? []).map((a) => a.id));
  const candidates = users.filter(
    (user) => user.is_active && user.role !== "court_admin" && !assigned.has(user.id)
  );

  return (
    <div className="space-y-5">
      <Card
        title="Who can open this case"
        subtitle={detail.data ? `${detail.data.case.case_reference} · ${detail.data.case.title}` : undefined}
        bodyClassName="!px-0 !py-0"
      >
        <AsyncView
          state={detail}
          onRetry={detail.refetch}
          context="case access"
          isEmpty={(data) => data.assignments.length === 0}
          empty={
            <EmptyState
              title="Nobody is assigned"
              description="Not even the officer who registered the FIR can open it until somebody is. Add the first person below."
              icon={<Link2Off size={19} />}
            />
          }
        >
          {(data) => (
            <ul className="divide-y divide-border">
              {data.assignments.map((row) => (
                <li key={row.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-ui text-sm font-medium text-text">
                      {row.full_name ?? "Unknown"}
                    </p>
                    <p className="font-ui text-2xs text-muted">
                      {ROLE_LABEL[row.role] ?? row.role}
                      {row.designation ? ` · ${row.designation}` : ""}
                    </p>
                  </div>
                  <StatusChip
                    tone={row.access === "write" ? "info" : "neutral"}
                    label={row.access === "write" ? "Read & write" : "Read only"}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Trash2 size={12} />}
                    loading={revoke.pending}
                    onClick={async () => {
                      const outcome = await revoke.run(row.id);
                      if (outcome) {
                        toast.success(
                          "Access revoked",
                          `${row.full_name ?? "User"} can no longer open this case.`
                        );
                        detail.refetch();
                        onChanged();
                      }
                    }}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </AsyncView>
      </Card>

      <Card title="Grant access" subtitle="Takes effect on their next request; no re-login needed.">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_150px_auto] sm:items-end">
          <Field label="Participant">
            <Select value={userId} onChange={(event) => setUserId(event.target.value)}>
              <option value="">Choose somebody…</option>
              {candidates.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.full_name} — {ROLE_LABEL[user.role]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Access">
            <Select
              value={access}
              onChange={(event) => setAccess(event.target.value as "read" | "write")}
            >
              <option value="read">Read only</option>
              <option value="write">Read &amp; write</option>
            </Select>
          </Field>

          <Button
            disabled={!userId}
            loading={grant.pending}
            icon={<Plus size={13} />}
            onClick={async () => {
              const outcome = await grant.run(undefined as never);
              if (outcome) {
                toast.success(
                  "Access granted",
                  outcome.downgradedToRead
                    ? "Downgraded to read only: defence counsel never gets write access to prosecution material."
                    : undefined
                );
                setUserId("");
                detail.refetch();
                onChanged();
              }
            }}
          >
            Grant
          </Button>
        </div>

        {candidates.length === 0 && (
          <p className="mt-3 font-ui text-2xs leading-relaxed text-muted">
            Everybody who could be added already has access, or there is nobody else to add. Invite a
            participant first.
          </p>
        )}

        {grant.error && (
          <p role="alert" className="mt-3 font-ui text-xs text-danger">
            {grant.error.message}
          </p>
        )}
      </Card>
    </div>
  );
}

/**
 * The Aadhaar field, with its verdict under it.
 *
 * One component for both the invite form and the completion dialog, because the
 * rules are the same and two copies would drift. It reports as the officer types:
 * a half-entered number says how many digits are left, and only a finished number
 * that fails is called an error.
 *
 * The number is never stored. What the API keeps is an HMAC of it and the last four
 * digits, so the reassurance shown on success is the last four — the most anybody,
 * including this screen, will see again.
 */
function AadhaarField({
  value,
  onChange,
  label = "Aadhaar number",
  required,
}: {
  value: string;
  onChange: (next: string) => void;
  label?: string;
  required?: boolean;
}) {
  const verdict = checkAadhaar(value);

  return (
    <Field
      label={label}
      required={required}
      hint={
        verdict.state === "valid"
          ? `Valid. Stored as a one-way token and ${verdict.masked}.`
          : verdict.state === "incomplete"
            ? `${verdict.problem} to go.`
            : verdict.state === "invalid"
              ? undefined
              : "12 digits from the card. Spaces are fine."
      }
    >
      <Input
        inputMode="numeric"
        maxLength={14}
        value={formatAadhaar(value)}
        onChange={(event) => onChange(event.target.value)}
        className={`font-mono ${
          verdict.state === "invalid"
            ? "border-danger"
            : verdict.state === "valid"
              ? "border-primary"
              : ""
        }`}
        placeholder="2665 8452 7491"
        aria-invalid={verdict.state === "invalid"}
      />
      {verdict.state === "invalid" && (
        <p role="alert" className="mt-1.5 font-ui text-2xs leading-relaxed text-danger">
          {verdict.problem}
        </p>
      )}
    </Field>
  );
}

/* ======================================================= AdminAudit ====== */

export function AdminAudit() {
  const [tab, setTab] = useState<"actions" | "rows" | "email">("actions");
  const actions = useQuery<{ entries: any[] }>("/api/admin/audit/actions?limit=100", [], {
    enabled: tab === "actions",
  });
  const rows = useQuery<{ entries: any[] }>("/api/admin/audit/rows?limit=100", [], {
    enabled: tab === "rows",
  });
  /**
   * Outbound email attempts.
   *
   * Worth a screen of its own: "I never received the code" is the single most
   * common support question a system like this generates, and it is unanswerable
   * without a record of whether the message was even accepted for delivery.
   * Addresses are masked and no body is ever stored, so the log answers that
   * question without becoming a directory of who is on bail.
   */
  const email = useQuery<{ entries: any[]; counts: Record<string, number> }>(
    "/api/admin/email-log?limit=100",
    [],
    { enabled: tab === "email" }
  );

  return (
    <>
      <PageHeader
        eyebrow="Court registry"
        title="Audit trail"
        description="A two-level record. Actions capture what each user attempted, including attempts that were refused; row changes are captured by database triggers, so even a direct edit to the database is recorded."
      />

      <div className="mb-5 inline-flex rounded-full border border-border bg-surface-2 p-1">
        {(["actions", "rows", "email"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`rounded-full px-4 py-2 font-ui text-xs font-semibold transition ${
              tab === value ? "bg-primary text-on-primary" : "text-muted hover:text-text"
            }`}
          >
            {value === "actions" ? "API actions" : value === "rows" ? "Row changes" : "Email log"}
          </button>
        ))}
      </div>

      {tab === "email" ? (
        <Card
          title="Outbound email"
          subtitle="Every attempt, with the address masked and no body stored. This is what answers 'I never received the code'."
          actions={
            email.data ? (
              <div className="flex items-center gap-1.5">
                <StatusChip tone="success" label={`${email.data.counts.sent} sent`} />
                {email.data.counts.failed > 0 && (
                  <StatusChip tone="danger" label={`${email.data.counts.failed} failed`} />
                )}
                {email.data.counts.skipped > 0 && (
                  <StatusChip tone="neutral" label={`${email.data.counts.skipped} skipped`} />
                )}
              </div>
            ) : undefined
          }
        >
          <AsyncView
            state={email}
            onRetry={email.refetch}
            context="the email log"
            isEmpty={(data) => data.entries.length === 0}
            empty={
              <EmptyState
                title="Nothing sent yet"
                description="Sign-in codes, invitations and summons notices appear here as they go out."
                icon={<Mail size={19} />}
              />
            }
          >
            {(data) => (
              <div className="-mx-5 overflow-x-auto">
                <table className="w-full min-w-[760px] border-collapse">
                  <thead>
                    <tr className="border-b border-border">
                      {["When", "Purpose", "To", "Subject", "Status"].map((heading) => (
                        <th
                          key={heading}
                          className="px-5 py-2.5 text-left font-ui text-2xs font-semibold uppercase tracking-wider text-faint"
                        >
                          {heading}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.entries.map((entry) => (
                      <tr key={entry.id} className="border-b border-border last:border-0">
                        <td className="px-5 py-2.5 font-ui text-2xs text-muted">
                          {formatDateTime(entry.occurred_at)}
                        </td>
                        <td className="px-5 py-2.5 font-mono text-2xs text-text">{entry.purpose}</td>
                        <td className="px-5 py-2.5 font-mono text-2xs text-muted">{entry.masked_to}</td>
                        <td className="max-w-[240px] px-5 py-2.5">
                          <span className="block truncate font-ui text-2xs text-muted">
                            {entry.subject}
                          </span>
                        </td>
                        <td className="px-5 py-2.5">
                          <StatusChip
                            tone={
                              entry.status === "sent"
                                ? "success"
                                : entry.status === "failed"
                                  ? "danger"
                                  : "neutral"
                            }
                            label={entry.status}
                          />
                          {entry.error && (
                            <p className="mt-1 max-w-[260px] font-ui text-3xs leading-relaxed text-danger">
                              {entry.error}
                            </p>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </AsyncView>
        </Card>
      ) : tab === "actions" ? (
        <Card title="API actions" subtitle="What was attempted, by whom, and whether it succeeded.">
          <AsyncView
            state={actions}
            onRetry={actions.refetch}
            context="the action log"
            isEmpty={(data) => data.entries.length === 0}
            empty={<EmptyState title="Nothing logged yet" icon={<FileSearch size={19} />} />}
          >
            {(data) => (
              <ul className="space-y-2">
                {data.entries.map((entry) => (
                  <li
                    key={entry.id}
                    className={`rounded-lg border p-3 ${
                      entry.outcome === "refused"
                        ? "border-warning-soft bg-warning-soft"
                        : entry.outcome === "failed"
                          ? "border-danger-soft bg-danger-soft"
                          : "border-border bg-surface-2"
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <code className="font-mono text-2xs font-semibold text-text">{entry.action}</code>
                      <div className="flex items-center gap-2">
                        {entry.actor_role && (
                          <span className="font-ui text-2xs text-muted">{ROLE_LABEL[entry.actor_role as Role]}</span>
                        )}
                        <StatusChip
                          tone={entry.outcome === "ok" ? "success" : entry.outcome === "refused" ? "warning" : "danger"}
                          label={entry.outcome}
                        />
                      </div>
                    </div>
                    <p className="mt-1 font-ui text-2xs text-faint">{formatDateTime(entry.occurred_at)}</p>
                    {entry.detail && (
                      <pre tabIndex={0} className="mt-1.5 overflow-x-auto rounded bg-surface px-2.5 py-2 font-mono text-2xs leading-relaxed text-muted">
                        {JSON.stringify(entry.detail, null, 2)}
                      </pre>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </AsyncView>
        </Card>
      ) : (
        <Card title="Row changes" subtitle="Captured by a trigger, so it fires whatever made the change.">
          <AsyncView
            state={rows}
            onRetry={rows.refetch}
            context="the row audit"
            isEmpty={(data) => data.entries.length === 0}
            empty={<EmptyState title="Nothing logged yet" icon={<FileSearch size={19} />} />}
          >
            {(data) => (
              <div className="-mx-5 overflow-x-auto">
                <table className="w-full min-w-[720px] border-collapse">
                  <thead>
                    <tr className="border-b border-border">
                      {["When", "Table", "Operation", "Actor", "Columns changed"].map((heading) => (
                        <th
                          key={heading}
                          className="px-5 py-2.5 text-left font-ui text-2xs font-semibold uppercase tracking-wider text-faint"
                        >
                          {heading}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.entries.map((entry) => (
                      <tr key={entry.id} className="border-b border-border last:border-0">
                        <td className="px-5 py-2.5 font-ui text-2xs text-muted">
                          {formatDateTime(entry.occurred_at)}
                        </td>
                        <td className="px-5 py-2.5 font-mono text-2xs text-text">{entry.table_name}</td>
                        <td className="px-5 py-2.5">
                          <StatusChip
                            tone={entry.operation === "DELETE" ? "danger" : entry.operation === "INSERT" ? "success" : "info"}
                            label={entry.operation}
                          />
                        </td>
                        <td className="px-5 py-2.5 font-ui text-2xs text-muted">{entry.actor_role ?? "service"}</td>
                        <td className="px-5 py-2.5 font-mono text-2xs text-muted">
                          {(entry.changed_columns ?? []).join(", ") || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </AsyncView>
        </Card>
      )}
    </>
  );
}

/* ======================================================= AdminChain ====== */

export function AdminChain() {
  const chain = useQuery<{
    status: {
      ready: boolean;
      reason: string;
      network: { name: string; chainId: number } | null;
      keeper: string | null;
      keeperBalanceWei: string | null;
      blockNumber: number | null;
      addresses: Record<string, string | undefined> | null;
    };
    transactions: any[];
    events: any[];
    counts: { pending: number; failed: number };
  }>("/api/admin/chain", [], { pollMs: 20_000 });

  return (
    <>
      <PageHeader
        eyebrow="Court registry"
        title="Chain status"
        description="The deployed contracts, the keeper wallet, and every transaction the platform has submitted to the ledger."
      />

      <AsyncView state={chain} onRetry={chain.refetch} context="chain status">
        {(data) => (
          <>
            {!data.status.ready && (
              <div role="alert" className="panel mb-6 border-danger-soft p-5">
                <div className="flex gap-3">
                  <Link2Off size={19} className="mt-0.5 shrink-0 text-danger" />
                  <div>
                    <p className="font-ui text-sm font-semibold text-text">The chain bridge is not ready</p>
                    <p className="mt-1 font-ui text-xs leading-relaxed text-muted">{data.status.reason}</p>
                  </div>
                </div>
              </div>
            )}

            <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat
                label="Network"
                value={data.status.network?.name ?? "—"}
                hint={data.status.network ? `chain ${data.status.network.chainId}` : undefined}
                icon={<Blocks size={14} />}
              />
              <Stat label="Block" value={data.status.blockNumber ?? "—"} icon={<Activity size={14} />} />
              <Stat
                label="Keeper balance"
                value={formatEth(data.status.keeperBalanceWei)}
                tone={data.status.keeperBalanceWei === "0" ? "danger" : "default"}
                icon={<Wallet size={14} />}
              />
              <Stat
                label="Failed transactions"
                value={data.counts.failed}
                tone={data.counts.failed > 0 ? "danger" : "default"}
                hint={`${data.counts.pending} pending`}
                icon={<AlertTriangle size={14} />}
              />
            </div>

            {data.status.addresses && (
              <Card className="mb-5" title="Deployed contracts">
                <dl className="space-y-2.5">
                  {Object.entries(data.status.addresses).map(([name, address]) => (
                    <div key={name} className="flex flex-wrap items-baseline justify-between gap-2">
                      <dt className="font-ui text-xs font-semibold text-text">{name}</dt>
                      <dd>
                        <code className="font-mono text-2xs text-muted">{address ?? "—"}</code>
                      </dd>
                    </div>
                  ))}
                </dl>
              </Card>
            )}

            <div className="grid gap-5 lg:grid-cols-2">
              <Card title="Recent transactions" subtitle="Everything this platform has submitted.">
                {data.transactions.length === 0 ? (
                  <EmptyState title="No transactions yet" icon={<Blocks size={19} />} />
                ) : (
                  <ul className="space-y-2">
                    {data.transactions.map((tx) => (
                      <li
                        key={tx.tx_hash}
                        className={`rounded-lg border p-3 ${
                          tx.status === "failed"
                            ? "border-danger-soft bg-danger-soft"
                            : tx.status === "pending"
                              ? "border-warning-soft bg-warning-soft"
                              : "border-border bg-surface-2"
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <code className="font-mono text-2xs font-semibold text-text">
                            {tx.contract}.{tx.method}
                          </code>
                          <StatusChip
                            tone={tx.status === "confirmed" ? "success" : tx.status === "pending" ? "warning" : "danger"}
                            label={tx.status}
                          />
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                          <TxLink txHash={tx.tx_hash} />
                          {tx.block_number && (
                            <span className="font-ui text-2xs text-faint">block {tx.block_number}</span>
                          )}
                          {tx.gas_used && (
                            <span className="font-ui text-2xs text-faint">{Number(tx.gas_used).toLocaleString()} gas</span>
                          )}
                          <span className="font-ui text-2xs text-faint">{relativeTime(tx.created_at)}</span>
                        </div>
                        {tx.error && (
                          <p className="mt-1.5 font-ui text-2xs leading-relaxed text-danger">{tx.error}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card
                title="Indexed events"
                subtitle="Materialised from the contracts. The chain stays authoritative; this is a read cache."
              >
                {data.events.length === 0 ? (
                  <EmptyState
                    title="No events indexed"
                    description="The indexer polls every few seconds once the chain bridge is ready."
                    icon={<Activity size={19} />}
                  />
                ) : (
                  <ul className="space-y-2">
                    {data.events.map((event, index) => (
                      <li key={`${event.tx_hash}-${index}`} className="rounded-lg border border-border bg-surface-2 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <code className="font-mono text-2xs font-semibold text-primary">{event.event_name}</code>
                          <span className="font-ui text-2xs text-faint">block {event.block_number}</span>
                        </div>
                        <p className="mt-0.5 font-ui text-2xs text-muted">{event.contract}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </>
        )}
      </AsyncView>
    </>
  );
}
