import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, ClipboardList, PackageCheck, ShieldCheck } from "lucide-react";
import { api, type CaseRow, type EvidenceRow } from "../lib/api";
import { useMutation, useQuery } from "../lib/useApi";
import { useToast } from "../context/ToastContext";
import { formatDateTime, formatCoords, STAGE_LABEL } from "../lib/format";
import { shortHash } from "../lib/hash";
import { AsyncView, EmptyState } from "../components/DataState";
import { Button, Card, Field, LinkButton, PageHeader, Select, Stat } from "../components/ui";
import { FileHashPicker, type HashedFile } from "../components/capture";
import { HashBadge, IntegrityBadge, StageChip } from "../components/trust";

interface VerifyResult {
  matched: boolean;
  databaseAgreesWithChain: boolean;
  submittedHash: string;
  onChainHash: string;
  onChain: {
    caseId: string;
    collectedAt: number;
    gpsLat: number;
    gpsLng: number;
    currentStage: string;
    mismatchCount: number;
    forensicReportHash: string;
    anomalyFlagHash: string;
    registrar: string;
  };
  anchoredTxHash: string | null;
  explorer: string | null;
}

/**
 * The defence verification portal.
 *
 * This screen exists to answer one question without asking the prosecution to
 * be trusted: is the file I was disclosed the file that was collected?
 *
 * Three properties make the answer worth something:
 *   - the digest is computed in counsel's own browser, not on the server
 *   - the comparison is against the chain, not against this database. If the
 *     database had been altered, comparing against it would agree with the
 *     alteration
 *   - the verification is itself anchored, so the fact that counsel checked, and
 *     what they found, becomes part of the record
 *
 * Counsel has no download route and no write access to any prosecution row.
 * Disclosure happens through the court, as it does now.
 */
export function DefenceVerify() {
  const toast = useToast();
  const cases = useQuery<{ cases: CaseRow[] }>("/api/cases");
  const [caseId, setCaseId] = useState("");
  const evidence = useQuery<{ items: EvidenceRow[] }>(caseId ? `/api/evidence/case/${caseId}` : null);

  const [evidenceId, setEvidenceId] = useState("");
  const [picked, setPicked] = useState<HashedFile | null>(null);
  const [result, setResult] = useState<VerifyResult | null>(null);

  const selected = useMemo(
    () => (evidence.data?.items ?? []).find((item) => item.id === evidenceId) ?? null,
    [evidence.data, evidenceId]
  );

  const verify = useMutation(async () =>
    api.post<VerifyResult>(`/api/evidence/${evidenceId}/verify`, {
      submittedHash: picked!.hash,
      anchor: true,
    })
  );

  const anchoredCount = (evidence.data?.items ?? []).filter((i) => i.chain_evidence_id !== null).length;
  const disputed = (evidence.data?.items ?? []).filter((i) => i.mismatch_count > 0).length;

  return (
    <>
      <PageHeader
        eyebrow="Independent verification"
        title="Verify the evidence independently"
        description="The file is fingerprinted in this browser and compared with the record on the public ledger, not with the prosecution's database. The result does not depend on trusting the server or its operator."
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Cases assigned" value={cases.data?.cases.length ?? "—"} icon={<ClipboardList size={14} />} />
        <Stat label="Items anchored" value={caseId ? anchoredCount : "—"} icon={<PackageCheck size={14} />} />
        <Stat
          label="Items with refused attempts"
          value={caseId ? disputed : "—"}
          tone={disputed > 0 ? "warning" : "default"}
          hint="Someone submitted a non-matching file"
          icon={<ShieldCheck size={14} />}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_1.1fr]">
        <div className="space-y-5">
          <Card title="1 · Choose the item" subtitle="Only cases you are assigned to appear here.">
            <AsyncView
              state={cases}
              onRetry={cases.refetch}
              context="your cases"
              isEmpty={(data) => data.cases.length === 0}
              empty={
                <EmptyState
                  title="No cases assigned"
                  description="A court administrator assigns counsel to a case. Access is read-only by design; it cannot be granted as write."
                  icon={<ClipboardList size={19} />}
                />
              }
            >
              {(data) => (
                <div className="space-y-4">
                  <Field label="Case" required>
                    <Select
                      value={caseId}
                      onChange={(event) => {
                        setCaseId(event.target.value);
                        setEvidenceId("");
                        setResult(null);
                      }}
                    >
                      <option value="">Select a case…</option>
                      {data.cases.map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.case_reference} — {row.title}
                        </option>
                      ))}
                    </Select>
                  </Field>

                  {caseId && (
                    <AsyncView
                      state={evidence}
                      onRetry={evidence.refetch}
                      context="the evidence list"
                      isEmpty={(data) => data.items.length === 0}
                      empty={
                        <EmptyState
                          title="No evidence on this case"
                          description="Nothing has been registered against it yet."
                          icon={<PackageCheck size={19} />}
                        />
                      }
                    >
                      {(data) => (
                        <Field label="Evidence item" required>
                          <Select
                            value={evidenceId}
                            onChange={(event) => {
                              setEvidenceId(event.target.value);
                              setResult(null);
                            }}
                          >
                            <option value="">Select an item…</option>
                            {data.items.map((item) => (
                              <option key={item.id} value={item.id} disabled={item.chain_evidence_id === null}>
                                {item.file_name}
                                {item.chain_evidence_id === null ? " (not anchored)" : ""}
                              </option>
                            ))}
                          </Select>
                        </Field>
                      )}
                    </AsyncView>
                  )}
                </div>
              )}
            </AsyncView>

            {selected && (
              <div className="mt-4 rounded-card border border-border bg-surface-2 p-4">
                <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                  <p className="font-ui text-sm font-semibold text-text">{selected.file_name}</p>
                  <div className="flex items-center gap-1.5">
                    <StageChip stage={selected.current_stage} />
                    <IntegrityBadge
                      anchored={selected.chain_evidence_id !== null}
                      mismatchCount={selected.mismatch_count}
                    />
                  </div>
                </div>
                <p className="font-ui text-2xs leading-relaxed text-muted">
                  Collected {formatDateTime(selected.collected_at)} at{" "}
                  {formatCoords(selected.gps_lat, selected.gps_lng)} · on-chain id{" "}
                  {selected.chain_evidence_id ?? "none"}
                </p>
                {selected.mismatch_count > 0 && (
                  <p className="mt-2 font-ui text-2xs font-semibold leading-relaxed text-warning">
                    {selected.mismatch_count} non-matching file{selected.mismatch_count > 1 ? "s have" : " has"} been
                    submitted for this item and refused. Each refusal is on chain.
                  </p>
                )}
              </div>
            )}
          </Card>

          <Card
            title="2 · Hash the file you were disclosed"
            subtitle="Computed here in your browser. Nothing is uploaded: only the digest is sent."
          >
            <FileHashPicker value={picked} onChange={setPicked} disabled={verify.pending} />

            {verify.error && (
              <p role="alert" className="mt-3 font-ui text-xs text-danger">
                {verify.error.message}
              </p>
            )}

            <Button
              full
              size="lg"
              className="mt-4"
              disabled={!evidenceId || !picked}
              loading={verify.pending}
              icon={<ShieldCheck size={15} />}
              onClick={async () => {
                const outcome = await verify.run(undefined as never);
                if (!outcome) return;
                setResult(outcome);
                if (outcome.matched) {
                  toast.success("Matches the chain", "This is the file that was registered at collection.");
                } else {
                  toast.error(
                    "Does not match the chain",
                    "This file differs from the one registered at collection."
                  );
                }
                evidence.refetch();
              }}
            >
              Verify against the chain
            </Button>

            <p className="mt-3 font-ui text-2xs leading-relaxed text-faint">
              The check is anchored, so the record will show that you performed it and what you found.
              This is the one write counsel has, and it touches no prosecution row.
            </p>
          </Card>
        </div>

        {/* ------------------------------------------------------ result */}
        <div className="lg:sticky lg:top-24 lg:self-start">
          {!result ? (
            <Card title="Result">
              <EmptyState
                title="No verification run yet"
                description="Choose an item, hash the file you hold, and the answer will be read from the chain."
                icon={<ShieldCheck size={19} />}
              />
            </Card>
          ) : (
            <Card
              title={result.matched ? "Verified" : "Does not match"}
              subtitle={
                result.matched
                  ? "The digest of your file is identical to the one on chain."
                  : "The digest of your file differs from the one on chain."
              }
              className={result.matched ? "border-success-soft" : "border-danger-soft"}
            >
              <div
                className={`rounded-card border p-4 ${
                  result.matched ? "border-success-soft bg-success-soft" : "border-danger-soft bg-danger-soft"
                }`}
              >
                <p className="font-display text-xl leading-tight text-text">
                  {result.matched
                    ? "This is the file that was collected"
                    : "This is not the file that was collected"}
                </p>
                <p className="mt-2 font-ui text-xs leading-relaxed text-muted">
                  {result.matched
                    ? "Whatever has happened to the prosecution's systems since, the bytes you hold hash to the value that was written to a public chain at the moment of collection."
                    : "Either the file has been altered since collection, or you have been given a different file. Both are findings worth raising."}
                </p>
              </div>

              <div className="mt-4 space-y-2.5">
                <HashBadge
                  hash={result.submittedHash}
                  label="Your file, hashed in this browser"
                  tone={result.matched ? "success" : "danger"}
                  full
                />
                <HashBadge hash={result.onChainHash} label="Registered on chain at collection" full />
              </div>

              {!result.databaseAgreesWithChain && (
                <div
                  role="alert"
                  className="mt-4 rounded-lg border border-danger-soft bg-danger-soft px-3 py-2.5"
                >
                  <p className="font-ui text-xs font-semibold text-text">
                    Separate finding: the database disagrees with the chain
                  </p>
                  <p className="mt-1 font-ui text-2xs leading-relaxed text-muted">
                    The digest stored off chain for this item no longer matches the digest on chain.
                    That is a statement about the prosecution&apos;s records, independent of your file.
                  </p>
                </div>
              )}

              <dl className="mt-4 space-y-2.5 border-t border-border pt-4">
                <Row
                  label="Collected at"
                  value={formatDateTime(new Date(result.onChain.collectedAt * 1000).toISOString())}
                />
                <Row
                  label="Collection coordinates"
                  value={formatCoords(result.onChain.gpsLat, result.onChain.gpsLng)}
                />
                <Row
                  label="Current custody"
                  value={STAGE_LABEL[result.onChain.currentStage as keyof typeof STAGE_LABEL] ?? "unknown"}
                />
                <Row label="Refused attempts on chain" value={result.onChain.mismatchCount} />
                <Row
                  label="Registering wallet"
                  value={<code className="font-mono text-2xs">{shortHash(result.onChain.registrar, 8, 6)}</code>}
                />
              </dl>

              {result.explorer && (
                <a
                  href={result.explorer}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-4 inline-flex items-center gap-1.5 font-ui text-2xs font-semibold text-primary hover:underline"
                >
                  Your verification, on the block explorer
                  <ArrowRight size={11} />
                </a>
              )}
            </Card>
          )}

          {evidenceId && (
            <LinkButton
              to={`/defence/cases/evidence/${evidenceId}`}
              variant="secondary"
              full
              className="mt-4"
            >
              See the full chain of custody
            </LinkButton>
          )}
        </div>
      </div>
    </>
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
