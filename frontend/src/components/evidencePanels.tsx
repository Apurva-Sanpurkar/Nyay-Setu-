import { useState } from "react";
import { Link } from "react-router-dom";
import { Download, ExternalLink, FileJson, MapPin, QrCode, ScanText, ShieldAlert, Smartphone, Upload } from "lucide-react";
import { useQuery } from "../lib/useApi";
import { api, apiOrigin, ApiError, type CaptureDetail, type PublicPassport, type StateHistoryRow, type Verification } from "../lib/api";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { useI18n } from "../i18n";
import { formatDateTime, osmLink } from "../lib/format";
import { Button, Card, CopyButton } from "./ui";
import { VerificationBadge, VerificationPanel } from "./verification";
import { ErrorState, Loading } from "./DataState";

/**
 * The 2.0 panels of the evidence page: where its anchoring has got (F2), and
 * its Integrity Passport with the capture details only assigned roles may see
 * (F3, F10).
 */

export function EvidenceVerificationCard({ evidenceId, onChanged }: { evidenceId: string; onChanged?: () => void }) {
  const { user } = useAuth();
  const { t } = useI18n();
  const state = useQuery<{ verification: Verification; history: StateHistoryRow[] }>(`/api/evidence/${evidenceId}/verification`, [], {
    pollMs: 15_000,
  });

  return (
    <Card title={t("passport.state")}>
      {state.loading && !state.data ? (
        <Loading rows={2} />
      ) : state.error && !state.data ? (
        <ErrorState error={state.error} onRetry={state.refetch} context="verification state" />
      ) : state.data ? (
        <VerificationPanel
          evidenceId={evidenceId}
          verification={state.data.verification}
          history={state.data.history}
          canRetry={user?.role === "police" || user?.role === "court_admin"}
          onChanged={() => {
            state.refetch();
            onChanged?.();
          }}
        />
      ) : null}
    </Card>
  );
}

interface AuthorisedPassport {
  passport: PublicPassport;
  capture: CaptureDetail | null;
  verifyUrl: string;
}

export function PassportCard({ evidenceId }: { evidenceId: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const state = useQuery<AuthorisedPassport>(`/api/evidence/${evidenceId}/passport`);

  const downloadPdf = async () => {
    try {
      const response = await api.download(`/api/evidence/${evidenceId}/passport.pdf`);
      const url = URL.createObjectURL(await response.blob());
      window.open(url, "_blank", "noopener");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (caught) {
      toast.error(t("common.error"), caught instanceof ApiError ? caught.message : undefined);
    }
  };

  const downloadManifest = async () => {
    try {
      const response = await api.download(`/api/evidence/${evidenceId}/manifest`);
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `manifest-${state.data?.passport.reference ?? evidenceId}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      toast.error(t("common.error"), caught instanceof ApiError ? caught.message : undefined);
    }
  };

  if (state.loading && !state.data) return <Card title={t("passport.title")}><Loading rows={3} /></Card>;
  if (state.error && !state.data) {
    return (
      <Card title={t("passport.title")}>
        <ErrorState error={state.error} onRetry={state.refetch} context="passport" />
      </Card>
    );
  }
  if (!state.data) return null;

  const { passport, capture } = state.data;
  const qrUrl = `${apiOrigin}/api/public/verify/${passport.reference}/qr.svg`;

  return (
    <Card
      title={t("passport.title")}
      actions={
        <Button size="sm" variant="secondary" icon={<Download size={12} />} onClick={() => void downloadPdf()}>
          PDF
        </Button>
      }
    >
      <div className="flex gap-4">
        <img src={qrUrl} alt={t("passport.qr")} width={96} height={96} className="h-24 w-24 shrink-0 rounded-lg border border-border bg-white p-1" />
        <div className="min-w-0 space-y-2">
          <div>
            <p className="font-ui text-2xs font-semibold uppercase tracking-wider text-faint">{t("passport.reference")}</p>
            <div className="flex items-center gap-2">
              <code className="truncate font-mono text-xs text-text">{passport.reference}</code>
              <CopyButton value={passport.reference} label={t("common.copy")} />
            </div>
          </div>
          <Link to={`/verify/${passport.reference}`} className="inline-flex items-center gap-1.5 font-ui text-xs font-semibold text-primary hover:underline">
            <QrCode size={13} aria-hidden /> {t("passport.openPublic")} <ExternalLink size={11} aria-hidden />
          </Link>
          <p className="flex items-center gap-1.5 font-ui text-2xs text-muted">
            {passport.source === "capture" ? <Smartphone size={11} aria-hidden /> : <Upload size={11} aria-hidden />}
            {passport.source === "capture" ? t("passport.sourceCapture") : t("passport.sourceUpload")}
          </p>
        </div>
      </div>

      {passport.flags.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {passport.flags.map((flag) => (
            <li key={flag} className="flex gap-2 rounded-lg bg-warning-soft px-2.5 py-1.5 font-ui text-2xs text-text">
              <ShieldAlert size={12} className="mt-0.5 shrink-0 text-warning" aria-hidden />
              {t(`passport.flag.${flag}` as never)}
            </li>
          ))}
        </ul>
      )}

      {capture && (
        <div className="mt-4 border-t border-border pt-4">
          <p className="font-ui text-xs font-semibold text-text">{t("passport.authorised")}</p>
          <p className="mb-3 font-ui text-2xs text-faint">{t("passport.authorisedNote")}</p>
          <dl className="grid gap-x-4 gap-y-2.5 font-ui text-xs sm:grid-cols-2">
            <Detail label={t("capture.purpose")} value={capture.purpose.replace(/_/g, " ")} />
            <Detail label="Device time" value={capture.deviceTime ? formatDateTime(capture.deviceTime) : "—"} />
            <Detail
              label="Clock skew"
              value={
                capture.clockSkewSeconds === null ? "—" : (
                  <span className={capture.clockSkewFlagged ? "font-semibold text-warning" : ""}>
                    {capture.clockSkewSeconds} s{capture.clockSkewFlagged ? " · flagged" : ""}
                  </span>
                )
              }
            />
            <Detail
              label="GPS"
              value={
                capture.gps.status ? (
                  <span className={capture.gps.status === "OK" ? "" : "font-semibold text-warning"}>
                    {capture.gps.status === "OK" ? t("capture.gpsOk") : capture.gps.status === "LOW_ACCURACY" ? "LOW ACCURACY" : t("capture.gpsNone")}
                    {capture.gps.accuracyMetres !== null && ` · ±${Math.round(capture.gps.accuracyMetres)} m`}
                  </span>
                ) : (
                  "—"
                )
              }
            />
            <Detail
              label="Device signature"
              value={
                <span className={capture.signatureStatus === "valid" ? "text-success" : capture.signatureStatus === "invalid" ? "font-semibold text-danger" : ""}>
                  {capture.signatureStatus.replace(/_/g, " ")}
                </span>
              }
            />
            {capture.durationMs !== null && <Detail label={t("capture.duration")} value={`${Math.round(capture.durationMs / 1000)} s`} />}
          </dl>
          {capture.gps.mocked && (
            <p className="mt-2 font-ui text-2xs font-semibold text-danger">{t("capture.mocked")}</p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {capture.gps.lat !== null && capture.gps.lng !== null && (
              <a
                href={osmLink(capture.gps.lat, capture.gps.lng)}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border px-3 font-ui text-2xs font-semibold text-primary hover:border-primary"
              >
                <MapPin size={12} aria-hidden /> {capture.gps.lat.toFixed(5)}, {capture.gps.lng.toFixed(5)}
              </a>
            )}
            {capture.manifest !== null && (
              <Button size="sm" variant="ghost" icon={<FileJson size={12} />} onClick={() => void downloadManifest()}>
                Manifest
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-wider text-faint">{label}</dt>
      <dd className="mt-0.5 text-text">{value}</dd>
    </div>
  );
}

/* ------------------------------------------------------------------ OCR */

interface OcrReading {
  id: string;
  text: string;
  confidence: number;
  variant: string;
  psm: number;
  lang: string;
  improvement: { rawConfidence: number; bestConfidence: number; rawChars: number; bestChars: number } | null;
  durationMs: number | null;
  resultDigest: string;
  proof: { inputSha256: string; preprocessedSha256: string; textSha256: string; engine: { name: string; version: string } };
  createdAt: string;
  verification: Verification;
}

const OCR_ROLES = new Set(["police", "forensic_lab", "prosecutor", "judge"]);

/**
 * Text read from a photographed or scanned item (015). The reading is a
 * searchable copy, not a replacement: the proof shows it was derived from the
 * registered file by a named pipeline, and its digest is anchored like any
 * other document on the case.
 */
export function OcrCard({ evidenceId }: { evidenceId: string }) {
  const { user } = useAuth();
  const toast = useToast();
  const state = useQuery<{ readings: OcrReading[]; available: boolean }>(`/api/evidence/${evidenceId}/ocr`);
  const [lang, setLang] = useState("eng");
  const [busy, setBusy] = useState(false);

  if (state.loading && !state.data) return <Card title="Text in this item (OCR)"><Loading rows={2} /></Card>;
  if (state.error && !state.data) {
    return (
      <Card title="Text in this item (OCR)">
        <ErrorState error={state.error} onRetry={state.refetch} context="OCR readings" />
      </Card>
    );
  }
  if (!state.data || (!state.data.available && state.data.readings.length === 0)) return null;

  const canRead = Boolean(user && OCR_ROLES.has(user.role)) && state.data.available;
  const latest = state.data.readings[0] ?? null;

  const read = async () => {
    setBusy(true);
    try {
      await api.post(`/api/evidence/${evidenceId}/ocr`, { lang });
      state.refetch();
    } catch (caught) {
      toast.error("Could not read the text", caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Text in this item (OCR)"
      subtitle="Read from the registered file after shadow removal, deskewing and thresholding. A reading aid: the image itself is the evidence."
      actions={
        canRead ? (
          <div className="flex items-center gap-2">
            <select
              aria-label="OCR language"
              value={lang}
              onChange={(event) => setLang(event.target.value)}
              className="h-8 rounded-lg border border-border bg-surface px-2 font-ui text-2xs text-text"
            >
              <option value="eng">English</option>
              <option value="eng+hin">English + Hindi</option>
              <option value="eng+mar">English + Marathi</option>
            </select>
            <Button size="sm" variant="secondary" icon={<ScanText size={12} />} loading={busy} onClick={() => void read()}>
              {latest ? "Read again" : "Extract text"}
            </Button>
          </div>
        ) : undefined
      }
    >
      {!latest ? (
        <p className="font-ui text-xs text-muted">No reading yet.</p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 font-ui text-2xs text-muted">
            <VerificationBadge state={latest.verification.state} short />
            <span>{Math.round(latest.confidence * 100)}% confidence</span>
            {latest.improvement && latest.improvement.rawConfidence < latest.improvement.bestConfidence && (
              <span>
                (unprocessed: {Math.round(latest.improvement.rawConfidence * 100)}%)
              </span>
            )}
            <span>· {latest.variant}, psm {latest.psm} · {latest.proof.engine.name} {latest.proof.engine.version}</span>
            <span>· {formatDateTime(latest.createdAt)}</span>
          </div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-surface-2 p-3 font-mono text-xs leading-relaxed text-text">
            {latest.text || "(no text found)"}
          </pre>
          <div className="flex justify-end">
            <CopyButton value={latest.text} label="Copy text" />
          </div>
          <dl className="space-y-1.5 border-t border-border pt-3">
            {(
              [
                ["Read from (registered file)", latest.proof.inputSha256],
                ["Prepared image", latest.proof.preprocessedSha256],
                ["Text", latest.proof.textSha256],
                ["Reading digest (anchored)", latest.resultDigest],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt className="font-ui text-2xs font-semibold uppercase tracking-wider text-faint">{label}</dt>
                <dd className="hash text-2xs text-text">{value}</dd>
              </div>
            ))}
          </dl>
          {state.data.readings.length > 1 && (
            <p className="font-ui text-2xs text-faint">{state.data.readings.length - 1} earlier reading(s) kept on record.</p>
          )}
        </div>
      )}
    </Card>
  );
}
