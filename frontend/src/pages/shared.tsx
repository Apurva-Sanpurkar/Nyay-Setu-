import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  ClipboardList,
  Download,
  FileCheck2,
  FlaskConical,
  Gavel,
  PackageCheck,
  Plus,
  ScrollText,
  Search,
  ShieldCheck,
} from "lucide-react";
import { api, ApiError } from "../lib/api";
import type {
  StatuteSummary,
  BailRow,
  CaseRow,
  CustodyEventRow,
  EvidenceRow,
  SummonsRow,
  ViolationRow,
} from "../lib/api";
import { useQuery, useMutation } from "../lib/useApi";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import {
  CASE_STATUS_LABEL,
  ROLE_LABEL,
  STAGE_LABEL,
  STAGE_RECEIVER,
  formatBytes,
  formatDateTime,
  formatCoords,
  relativeTime,
} from "../lib/format";
import { shortHash } from "../lib/hash";
import { AsyncView, EmptyState, ErrorState } from "../components/DataState";
import { Button, Card, Field, Input, Modal, PageHeader, Stat, Textarea } from "../components/ui";
import {
  AnomalyNotice,
  ComplianceGauge,
  ConditionList,
  CustodyTimeline,
  HashBadge,
  IntegrityBadge,
  StageChip,
  StatusChip,
  SummonsStatusChip,
  TxLink,
} from "../components/trust";
import { FileHashPicker, type HashedFile } from "../components/capture";
import { CaseReportPanel } from "../components/CaseReport";
import { CaseProgress } from "../components/CaseProgress";
import { CasePredictions } from "../components/CasePredictions";
import { EvidenceVerificationCard, PassportCard } from "../components/evidencePanels";
import { DocumentsCard, GovernanceCard, LabWorkPanel } from "../components/workflowPanels";
import { VerificationBadge } from "../components/verification";
import { FirCard } from "../components/casePanels";
import { AiInsightsCard, AuditTimelineCard, CaseGovernanceCard } from "../components/dossierPanels";
import { CourtRecordCard } from "./court";

/* ==================================================== CasesPage ========== */

/**
 * Every role's case list. Which cases appear is decided by the API from case
 * assignments, so this one component serves all seven portals without a single
 * role check: a defence lawyer simply receives fewer rows.
 */
export function CasesPage({ basePath }: { basePath: string }) {
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const state = useQuery<{ cases: CaseRow[] }>("/api/cases");

  const filtered = useMemo(() => {
    const rows = state.data?.cases ?? [];
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) =>
      [row.case_reference, row.title, row.offence_type, row.police_station]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [state.data, search]);

  return (
    <>
      <PageHeader
        eyebrow="Case register"
        title="Cases"
        description={
          user?.role === "court_admin"
            ? "Every case on the register."
            : "Cases you have been assigned to. Assignment is what grants access, not your role."
        }
      />

      <div className="mb-5 relative max-w-md">
        <Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
        <Input
          placeholder="Search by FIR number, title or station"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="pl-10"
        />
      </div>

      <AsyncView
        state={state}
        onRetry={state.refetch}
        context="cases"
        isEmpty={(data) => data.cases.length === 0}
        empty={
          <EmptyState
            title="No cases assigned to you yet"
            description="A court administrator or judge assigns participants to a case. Until then there is nothing to show here."
            icon={<ClipboardList size={19} />}
          />
        }
      >
        {() =>
          filtered.length === 0 ? (
            <EmptyState
              title="Nothing matches that search"
              description={`No case matches "${search}".`}
              icon={<Search size={19} />}
            />
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {filtered.map((row) => (
                <Link
                  key={row.id}
                  to={`${basePath}/${row.id}`}
                  className="panel group block p-5 transition duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lift"
                >
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <code className="font-mono text-2xs text-primary">{row.case_reference}</code>
                    <StatusChip
                      tone={row.status === "disposed" ? "neutral" : "info"}
                      label={CASE_STATUS_LABEL[row.status] ?? row.status}
                    />
                  </div>

                  <h3 className="font-display text-lg leading-snug text-text">{row.title}</h3>
                  <p className="mt-1.5 font-ui text-xs text-muted">{row.offence_type}</p>

                  {row.sections.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {row.sections.map((section) => (
                        <span
                          key={section}
                          className="rounded-md border border-border bg-surface-2 px-2 py-0.5 font-mono text-2xs text-muted"
                        >
                          {section}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="mt-4 flex items-center justify-between border-t border-border pt-3.5">
                    <span className="font-ui text-2xs text-faint">
                      {row.police_station.split(",")[0]} · {relativeTime(row.registered_at)}
                    </span>
                    <span className="flex items-center gap-1 font-ui text-2xs font-semibold text-primary opacity-0 transition group-hover:opacity-100">
                      Open <ArrowRight size={11} />
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )
        }
      </AsyncView>
    </>
  );
}

/* ================================================== CaseDossierPage ====== */

interface Overview {
  case: CaseRow;
  /**
   * What the Bharatiya Nyaya Sanhita says about the sections cited. Optional
   * because the reference is a build artefact the API degrades without.
   */
  statute?: StatuteSummary;
  evidence: EvidenceRow[];
  summons: SummonsRow[];
  bail: BailRow | null;
  violations: ViolationRow[];
  counts: { evidence: number; flaggedEvidence: number; summons: number; openViolations: number };
}

/**
 * Acknowledging a breach.
 *
 * The contract detected it and the record holds it; this is the court saying it has
 * been seen and dealt with. It is a one-way action — there is no un-acknowledge,
 * because a judicial act that can be quietly reversed is not much of a record.
 */
function AcknowledgeViolation({
  violationId,
  onDone,
}: {
  violationId: string;
  onDone: () => void;
}) {
  const toast = useToast();
  const acknowledge = useMutation(async () =>
    api.post(`/api/bail/violations/${violationId}/acknowledge`)
  );

  return (
    <Button
      size="sm"
      variant="secondary"
      loading={acknowledge.pending}
      onClick={async () => {
        const outcome = await acknowledge.run(undefined as never);
        if (outcome) {
          toast.success("Breach acknowledged", "Recorded against this case.");
          onDone();
        } else if (acknowledge.error) {
          toast.error("Could not acknowledge it", acknowledge.error.message);
        }
      }}
    >
      Acknowledge
    </Button>
  );
}

/**
 * The case dossier. Role-aware by construction: the API redacts the summary and
 * the summons list for defence counsel, so this component renders whatever it
 * was given rather than deciding entitlements itself.
 */
export function CaseDossierPage({ basePath }: { basePath: string }) {
  const { caseId } = useParams<{ caseId: string }>();
  const { user } = useAuth();
  const state = useQuery<Overview>(caseId ? `/api/cases/${caseId}/overview` : null);

  return (
    <AsyncView state={state} onRetry={state.refetch} context="this case">
      {(data) => (
        <>
          <PageHeader
            eyebrow={data.case.case_reference}
            title={data.case.title}
            description={
              <>
                {data.case.offence_type}
                {data.case.sections.length > 0 && ` · ${data.case.sections.join(", ")}`}
                {data.statute?.severity !== null && data.statute?.severity !== undefined && (
                  <>
                    {" · "}
                    <span title="The gravest punishment any cited section states. A lower bound, not a finding.">
                      gravest stated punishment from {data.statute.severityFrom}
                    </span>
                  </>
                )}
                <br />
                {data.case.police_station}
                {data.case.court_name && ` · ${data.case.court_name}`}
              </>
            }
            actions={
              <StatusChip
                tone={data.case.status === "disposed" ? "neutral" : "info"}
                label={CASE_STATUS_LABEL[data.case.status] ?? data.case.status}
              />
            }
          />

          <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Evidence items" value={data.counts.evidence} icon={<PackageCheck size={14} />} />
            <Stat
              label="Flagged at intake"
              value={data.counts.flaggedEvidence}
              tone={data.counts.flaggedEvidence > 0 ? "warning" : "default"}
              icon={<AlertTriangle size={14} />}
            />
            <Stat label="Summons issued" value={data.counts.summons} icon={<ScrollText size={14} />} />
            <Stat
              label="Open violations"
              value={data.counts.openViolations}
              tone={data.counts.openViolations > 0 ? "danger" : "default"}
              icon={<Gavel size={14} />}
            />
          </div>

          <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
            <div className="space-y-5">
              {/* ---------------------------------------- final report */}
              {caseId && (
                <CaseReportPanel caseId={caseId} firNumber={data.case.case_reference} />
              )}

              {/* -------------------------------------------- evidence */}
              <Card
                title="Evidence"
                subtitle="Each item carries the digest computed on the collecting device."
              >
                {data.evidence.length === 0 ? (
                  <EmptyState
                    title="No evidence registered yet"
                    description="Items appear here once an officer captures them in the field."
                    icon={<PackageCheck size={19} />}
                  />
                ) : (
                  <ul className="space-y-3">
                    {data.evidence.map((item) => (
                      <li key={item.id}>
                        <Link
                          to={`${basePath}/evidence/${item.id}`}
                          className="block rounded-card border border-border bg-surface-2 p-4 transition hover:border-border-strong"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate font-ui text-sm font-semibold text-text">
                                {item.file_name}
                              </p>
                              <p className="mt-0.5 font-ui text-2xs text-muted">
                                {item.kind} · {formatBytes(item.size_bytes)} ·{" "}
                                {formatDateTime(item.collected_at)}
                              </p>
                            </div>
                            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                              <StageChip stage={item.current_stage} />
                              {item.verification ? (
                                <VerificationBadge state={item.verification.state} short />
                              ) : (
                                <IntegrityBadge
                                  anchored={item.chain_evidence_id !== null}
                                  mismatchCount={item.mismatch_count}
                                />
                              )}
                            </div>
                          </div>

                          <code className="mt-2.5 block font-mono text-2xs text-faint">
                            {shortHash(item.file_hash, 22, 12)}
                            {item.source === "capture" && " · live capture"}
                          </code>

                          {item.anomaly_flagged && (
                            <p className="mt-2 flex items-center gap-1.5 font-ui text-2xs font-semibold text-warning">
                              <AlertTriangle size={11} /> Flagged at intake
                            </p>
                          )}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              {caseId && <AuditTimelineCard caseId={caseId} />}
              {caseId && <CourtRecordCard caseId={caseId} />}

              {/* -------------------------------------------- summons */}
              {user?.role !== "defence_lawyer" && (
                <Card title="Summons" subtitle="Delivery status is read from the contract.">
                  {data.summons.length === 0 ? (
                    <EmptyState
                      title="No summons issued"
                      description="A judge or court administrator issues summons from the court portal."
                      icon={<ScrollText size={19} />}
                    />
                  ) : (
                    <ul className="space-y-2.5">
                      {data.summons.map((row) => (
                        <li
                          key={row.id}
                          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-4 py-3"
                        >
                          <div className="min-w-0">
                            <p className="font-ui text-sm font-medium text-text">{row.recipient_name}</p>
                            <p className="mt-0.5 font-ui text-2xs text-muted">
                              issued {formatDateTime(row.issued_at)} · window closes{" "}
                              {formatDateTime(row.expiry_at)}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <SummonsStatusChip status={row.effectiveStatus ?? row.status} />
                            <TxLink txHash={row.ack_tx_hash ?? row.issue_tx_hash} />
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              )}
            </div>

            {/* ---------------------------------------------- side rail */}
            <div className="space-y-5">
              {data.bail ? (
                <Card title="Bail" subtitle={data.bail.accused_name}>
                  <div className="flex justify-center">
                    <ComplianceGauge score={data.bail.compliance_score} size={116} />
                  </div>
                  <dl className="mt-4 space-y-2.5">
                    <Row label="Conditions" value={`${data.bail.conditions.length} encoded`} />
                    <Row
                      label="Geo-fence"
                      value={data.bail.radius_metres ? `${data.bail.radius_metres} m` : "none"}
                    />
                    <Row
                      label="Risk at grant"
                      value={data.bail.risk_band ?? "not assessed"}
                    />
                    <Row label="Expires" value={formatDateTime(data.bail.expiry_at)} />
                  </dl>
                </Card>
              ) : (
                <Card title="Bail">
                  <EmptyState
                    title="No bail order"
                    description="Nothing has been granted on this case."
                    icon={<Gavel size={19} />}
                  />
                </Card>
              )}

              {data.violations.length > 0 && (
                <Card title="Violations" subtitle="Detected on chain, mirrored here for triage.">
                  <ul className="space-y-2">
                    {data.violations.map((violation) => (
                      <li
                        key={violation.id}
                        className={`rounded-lg border p-3 ${
                          violation.acknowledged_at
                            ? "border-border bg-surface-2"
                            : "border-danger-soft bg-danger-soft"
                        }`}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-ui text-xs font-semibold text-text">{violation.reason}</p>
                            <p className="mt-0.5 font-ui text-2xs text-muted">
                              {formatDateTime(violation.detected_at)}
                              {violation.acknowledged_at ? " · acknowledged" : " · outstanding"}
                            </p>
                          </div>
                          {/*
                            Only a judge, and only once. A breach the contract found
                            is a fact; acknowledging it is a judicial act, which is
                            why it is recorded rather than merely dismissed — and why
                            an acknowledged violation cannot be un-acknowledged here.
                          */}
                          {!violation.acknowledged_at && user?.role === "judge" && (
                            <AcknowledgeViolation
                              violationId={violation.id}
                              onDone={() => state.refetch()}
                            />
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              <FirCard caseRow={data.case} onChanged={() => state.refetch()} />

              {data.case.summary && (
                <Card title="Case summary" subtitle="Stored off chain, editable, never anchored.">
                  <p className="whitespace-pre-line font-ui text-sm leading-relaxed text-muted">
                    {data.case.summary}
                  </p>
                </Card>
              )}

              <CaseGovernanceCard caseRow={data.case} />

              <AiInsightsCard caseId={data.case.id} />

              <CasePredictions caseId={data.case.id} />

              <CaseProgress
                caseId={data.case.id}
                status={data.case.status}
                access={data.case.access}
                onChanged={() => state.refetch()}
              />

              <Card title="On-chain case id">
                <HashBadge
                  hash={data.case.case_id_hash}
                  label={data.case.case_key_scheme === "salted_v2" ? "keccak256(reference + salt)" : "keccak256(FIR number)"}
                  full
                />
                <p className="mt-2.5 font-ui text-2xs leading-relaxed text-faint">
                  {data.case.case_key_scheme === "salted_v2"
                    ? "Salted: nothing about the case — not the FIR, not the reference — can be recovered from the blockchain. All three contracts address the case by this value."
                    : "Created before NyaySetu 2.0, so this case is keyed by its FIR number, which a determined reader could guess. All three contracts address the case by this value."}
                </p>
              </Card>
            </div>
          </div>
        </>
      )}
    </AsyncView>
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

/* ================================================ EvidenceDetailPage ===== */

interface CustodyResponse {
  evidence: EvidenceRow;
  offChain: CustodyEventRow[];
  onChain: unknown[];
  consistent: boolean;
}

interface VerifyResult {
  matched: boolean;
  databaseAgreesWithChain: boolean;
  submittedHash: string;
  onChainHash: string;
  onChain: {
    mismatchCount: number;
    forensicReportHash: string;
    anomalyFlagHash: string;
    registrar: string;
    collectedAt: number;
  };
  anchoredTxHash: string | null;
  explorer: string | null;
}

/**
 * One evidence item: its custody trail, its screening verdict, and the actions
 * the signed-in role is entitled to take on it.
 *
 * Three actions can appear here, and which ones do is decided by the item's
 * current stage rather than by a role list, so the UI cannot offer an action the
 * contract would reject.
 */
export function EvidenceDetailPage() {
  const { evidenceId } = useParams<{ evidenceId: string }>();
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const state = useQuery<CustodyResponse>(evidenceId ? `/api/evidence/${evidenceId}/custody` : null);
  const checks = useQuery<{ checks: any[] }>(
    evidenceId ? `/api/evidence/${evidenceId}/integrity-checks` : null
  );
  /**
   * Every forensic report on this exhibit, not only the latest.
   *
   * The digests panel shows one hash, which is the most recent. A laboratory can
   * file more than one — a preliminary opinion and a final one, or a second
   * examination on a different question — and each is separately anchored. Showing
   * only the last makes the earlier ones invisible, which is the opposite of what an
   * evidentiary record is for.
   */
  const reports = useQuery<{ reports: any[] }>(
    evidenceId ? `/api/evidence/${evidenceId}/forensic-reports` : null
  );

  const [verifyOpen, setVerifyOpen] = useState(false);
  const [picked, setPicked] = useState<HashedFile | null>(null);
  const [result, setResult] = useState<VerifyResult | null>(null);

  const item = state.data?.evidence;

  // The receiving role for the NEXT stage is the one that may accept custody.
  const nextStage = item
    ? ({ SCENE: "FORENSIC_LAB", FORENSIC_LAB: "PROSECUTOR", PROSECUTOR: "COURT", COURT: null } as const)[
        item.current_stage
      ]
    : null;
  const canAccept = Boolean(item && nextStage && user && STAGE_RECEIVER[nextStage] === user.role);
  const canDownload = user?.role !== "defence_lawyer";

  const accept = useMutation(async (hash: string) =>
    api.post<{ fromStage: string; toStage: string; chain: { txHash: string; explorer: string | null } }>(
      `/api/evidence/${evidenceId}/custody`,
      { confirmedHash: hash }
    )
  );

  const verify = useMutation(async (hash: string) =>
    api.post<VerifyResult>(`/api/evidence/${evidenceId}/verify`, { submittedHash: hash, anchor: true })
  );

  const handleAccept = async () => {
    if (!picked) return;
    const outcome = await accept.run(picked.hash);
    if (outcome) {
      toast.success(
        `Custody moved to ${STAGE_LABEL[outcome.toStage as keyof typeof STAGE_LABEL]}`,
        "The hash you submitted matched the registered digest.",
        outcome.chain.explorer ? { href: outcome.chain.explorer, label: "View transaction" } : undefined
      );
      setPicked(null);
      state.refetch();
      checks.refetch();
    }
  };

  const handleVerify = async () => {
    if (!picked) return;
    const outcome = await verify.run(picked.hash);
    if (outcome) {
      setResult(outcome);
      if (outcome.matched) {
        toast.success("Hash matches the chain", "This file is the file that was registered.");
      } else {
        toast.error("Hash does not match", "This file is not the file that was registered on chain.");
      }
      checks.refetch();
    }
  };

  const download = async () => {
    try {
      const response = await api.download(`/api/evidence/${evidenceId}/download`);
      const integrity = response.headers.get("x-nyaysetu-integrity");
      const blob = await response.blob();

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = item?.file_name ?? "evidence";
      anchor.click();
      URL.revokeObjectURL(url);

      if (integrity === "verified") {
        toast.success("Downloaded", "The decrypted bytes still hash to the registered digest.");
      } else {
        toast.error(
          "Integrity check failed on download",
          "The stored file no longer hashes to the registered digest. Escalate this."
        );
      }
    } catch (caught) {
      toast.error(
        "Could not download",
        caught instanceof ApiError ? caught.message : "The stored file could not be retrieved."
      );
    }
  };

  return (
    <AsyncView state={state} onRetry={state.refetch} context="this evidence item">
      {(data) => (
        <>
          <PageHeader
            eyebrow={`Evidence · ${data.evidence.kind}`}
            title={data.evidence.file_name}
            description={
              <>
                Collected {formatDateTime(data.evidence.collected_at)}
                {data.evidence.gps_lat !== null && data.evidence.gps_lng !== null
                  ? ` at ${formatCoords(data.evidence.gps_lat, data.evidence.gps_lng)}`
                  : " · no location recorded"}{" "}
                · {formatBytes(data.evidence.size_bytes)}
                {data.evidence.source === "capture" && " · live capture"}
              </>
            }
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <StageChip stage={data.evidence.current_stage} />
                <IntegrityBadge
                  anchored={data.evidence.chain_evidence_id !== null}
                  mismatchCount={data.evidence.mismatch_count}
                />
              </div>
            }
          />

          <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
            <div className="space-y-5">
              <Card
                title="Chain of custody"
                subtitle="Each hop was confirmed by the receiving party, who re-hashed what they held."
              >
                <CustodyTimeline
                  events={data.offChain}
                  currentStage={data.evidence.current_stage}
                  onChainCount={data.onChain.length}
                  consistent={data.consistent}
                />
              </Card>

              <Card
                title="Verification history"
                subtitle="Every check, including the ones that failed. A refused tamper attempt is evidence in itself."
                actions={
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<ShieldCheck size={13} />}
                    onClick={() => {
                      setResult(null);
                      setPicked(null);
                      setVerifyOpen(true);
                    }}
                  >
                    Verify a file
                  </Button>
                }
              >
                {checks.error && !checks.data ? (
                  <ErrorState error={checks.error} onRetry={checks.refetch} context="verification history" />
                ) : (checks.data?.checks.length ?? 0) === 0 ? (
                  <EmptyState
                    title="No verifications yet"
                    description="Anybody assigned to this case can check a file against the chain."
                    icon={<ShieldCheck size={19} />}
                  />
                ) : (
                  <ul className="space-y-2">
                    {checks.data!.checks.map((check) => (
                      <li
                        key={check.id}
                        className={`rounded-lg border p-3 ${
                          check.matched ? "border-success-soft bg-success-soft" : "border-danger-soft bg-danger-soft"
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="font-ui text-xs font-semibold text-text">
                            {check.matched ? "Matched" : "Mismatch"} ·{" "}
                            {check.checked_by_role ? ROLE_LABEL[check.checked_by_role as keyof typeof ROLE_LABEL] : "unknown"}
                          </p>
                          <TxLink txHash={check.tx_hash} />
                        </div>
                        <p className="mt-1 font-ui text-2xs text-muted">
                          {check.context} · {formatDateTime(check.created_at)}
                        </p>
                        {!check.matched && (
                          <code className="mt-1.5 block font-mono text-2xs text-danger">
                            submitted {shortHash(check.submitted_hash, 18, 10)}
                          </code>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              {item && <DocumentsCard item={item} />}
              {item && <GovernanceCard item={item} onChanged={() => state.refetch()} />}
            </div>

            <div className="space-y-5">
              {evidenceId && <EvidenceVerificationCard evidenceId={evidenceId} onChanged={() => state.refetch()} />}
              {evidenceId && <PassportCard evidenceId={evidenceId} />}

              {canAccept && nextStage && (
                <Card
                  title={`Accept custody at ${STAGE_LABEL[nextStage]}`}
                  subtitle="Re-hash the item you were handed. A mismatch is recorded on chain by a separate integrity-check transaction, and no transfer is attempted."
                >
                  <FileHashPicker value={picked} onChange={setPicked} disabled={accept.pending} />

                  {picked && (
                    <p
                      className={`mt-3 rounded-lg border px-3 py-2.5 font-ui text-2xs leading-relaxed ${
                        picked.hash === data.evidence.file_hash
                          ? "border-success-soft bg-success-soft text-text"
                          : "border-danger-soft bg-danger-soft text-text"
                      }`}
                    >
                      {picked.hash === data.evidence.file_hash
                        ? "This matches the registered file digest. The chain makes the final comparison when you accept."
                        : "This does not match the registered digest. Submitting it records the mismatch on chain through an integrity-check transaction, and custody does not move. That is the correct outcome if the file really has been altered."}
                    </p>
                  )}

                  {accept.error && (
                    <p role="alert" className="mt-3 font-ui text-2xs leading-relaxed text-danger">
                      {accept.error.message}
                    </p>
                  )}

                  <Button
                    full
                    className="mt-3.5"
                    disabled={!picked}
                    loading={accept.pending}
                    onClick={() => void handleAccept()}
                  >
                    Confirm and accept custody
                  </Button>
                </Card>
              )}

              <Card title="Intake screening">
                <AnomalyNotice
                  flagged={data.evidence.anomaly_flagged}
                  score={data.evidence.anomaly_score}
                  reasons={data.evidence.anomaly_reasons}
                  flagHash={data.evidence.anomaly_flag_hash}
                />
              </Card>

              <Card
                title="Digests"
                subtitle="The registered digest is what the chain holds."
                actions={
                  canDownload ? (
                    <Button size="sm" variant="ghost" icon={<Download size={13} />} onClick={() => void download()}>
                      Download
                    </Button>
                  ) : undefined
                }
              >
                <div className="space-y-2.5">
                  <HashBadge hash={data.evidence.file_hash} label="File digest (SHA-256)" full />
                  {data.evidence.anchor_mode === "manifest" && data.evidence.anchored_digest && (
                    <HashBadge hash={data.evidence.anchored_digest} label="Anchored capture-manifest digest" full />
                  )}
                  {data.evidence.forensic_report_hash && (
                    <HashBadge hash={data.evidence.forensic_report_hash} label="Forensic report (latest)" full />
                  )}
                  {data.evidence.anomaly_flag_hash && (
                    <HashBadge hash={data.evidence.anomaly_flag_hash} label="AI verdict (write-once)" full />
                  )}
                </div>

                <dl className="mt-4 space-y-2.5 border-t border-border pt-3.5">
                  <Row
                    label="On-chain id"
                    value={data.evidence.chain_evidence_id ?? "not anchored"}
                  />
                  <Row label="Refused attempts" value={data.evidence.mismatch_count} />
                  <Row
                    label="Registration"
                    value={<TxLink txHash={data.evidence.registration_tx_hash} />}
                  />
                </dl>
              </Card>

              {(reports.data?.reports?.length ?? 0) > 0 && (
                <Card
                  title="Forensic reports"
                  subtitle="Each conclusion is anchored by its own digest. A report altered afterwards would not reproduce it."
                >
                  <ul className="space-y-2.5">
                    {reports.data!.reports.map((report: any) => (
                      <li key={report.id} className="rounded-card border border-border bg-surface-2 p-3.5">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="font-ui text-2xs uppercase tracking-wider text-faint">
                            {report.version ? `v${report.version} · ` : ""}
                            {formatDateTime(report.created_at)}
                            {report.analyst_name ? ` · ${report.analyst_name}` : ""}
                          </span>
                          <TxLink txHash={report.tx_hash} />
                        </div>
                        <p className="mt-1.5 font-ui text-sm leading-relaxed text-text">
                          {report.conclusion}
                        </p>
                        {(report.tool || report.method) && (
                          <p className="mt-1 font-ui text-2xs text-muted">
                            {[report.tool, report.method].filter(Boolean).join(" · ")}
                          </p>
                        )}
                        {report.detail && (
                          <p className="mt-1 whitespace-pre-line font-ui text-xs leading-relaxed text-muted">
                            {report.detail}
                          </p>
                        )}
                        <div className="mt-2 border-t border-border pt-2">
                          <HashBadge hash={report.report_hash} label="Report digest" full />
                        </div>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              {item && (
                <LabWorkPanel
                  item={item}
                  reports={reports.data?.reports ?? []}
                  onChanged={() => {
                    state.refetch();
                    reports.refetch();
                    checks.refetch();
                  }}
                />
              )}
            </div>
          </div>

          {/* ----------------------------------------------- verify modal */}
          <Modal
            open={verifyOpen}
            onClose={() => setVerifyOpen(false)}
            title="Verify a file against the chain"
            description="The file is hashed in your browser. The comparison is made against the on-chain digest, not against this database."
            footer={
              <>
                <Button variant="ghost" onClick={() => setVerifyOpen(false)}>
                  Close
                </Button>
                <Button disabled={!picked} loading={verify.pending} onClick={() => void handleVerify()}>
                  Verify and anchor
                </Button>
              </>
            }
          >
            <FileHashPicker value={picked} onChange={setPicked} disabled={verify.pending} />

            {verify.error && (
              <p role="alert" className="mt-3 font-ui text-xs text-danger">
                {verify.error.message}
              </p>
            )}

            {result && (
              <div
                className={`mt-4 rounded-card border p-4 ${
                  result.matched ? "border-success-soft bg-success-soft" : "border-danger-soft bg-danger-soft"
                }`}
              >
                <p className="font-display text-lg text-text">
                  {result.matched ? "This is the registered file" : "This is not the registered file"}
                </p>
                <p className="mt-1.5 font-ui text-xs leading-relaxed text-muted">
                  {result.matched
                    ? "The digest of the file you supplied is identical to the digest recorded on chain when the evidence was collected."
                    : "The digest of the file you supplied differs from the digest recorded on chain. The file has been altered since collection, or it is a different file."}
                </p>

                <div className="mt-3.5 space-y-2">
                  <HashBadge hash={result.submittedHash} label="Your file" tone={result.matched ? "success" : "danger"} full />
                  <HashBadge hash={result.onChainHash} label="On chain" full />
                </div>

                {!result.databaseAgreesWithChain && (
                  <p
                    role="alert"
                    className="mt-3 rounded-lg border border-danger-soft bg-surface px-3 py-2.5 font-ui text-2xs leading-relaxed text-danger"
                  >
                    Separately: this database no longer agrees with the chain about the registered
                    digest. That is a finding about the database, not about your file.
                  </p>
                )}

                <p className="mt-3 font-ui text-2xs leading-relaxed text-faint">
                  This check has been anchored, so the fact that it was performed is part of the
                  record. On-chain refused attempts for this item: {result.onChain.mismatchCount}.
                </p>

                {result.explorer && (
                  <a
                    href={result.explorer}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mt-2 inline-block font-ui text-2xs font-semibold text-primary hover:underline"
                  >
                    View the anchoring transaction
                  </a>
                )}
              </div>
            )}
          </Modal>

        </>
      )}
    </AsyncView>
  );
}
