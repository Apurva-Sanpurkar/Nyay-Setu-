import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Camera,
  CheckCircle2,
  CircleStop,
  ClipboardList,
  FileUp,
  Info,
  PackageCheck,
  Plus,
  QrCode,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  SwitchCamera,
  Trash2,
  Video,
  X,
} from "lucide-react";
import {
  buildCaptureManifest,
  manifestDigest,
  ManifestError,
  RecordingJournal,
  type CaptureManifest,
  type CapturePurpose,
  type MediaKind,
} from "@nyaysetu/integrity";
import { api, ApiError, type CaseRow, type EvidenceRow, type Verification } from "../lib/api";
import { useQuery } from "../lib/useApi";
import { useAuth } from "../context/AuthContext";
import { useI18n, type MessageKey } from "../i18n";
import { ROLE_HOME, formatBytes } from "../lib/format";
import { sha256File } from "../lib/hash";
import { CameraError, grabFrame, recorderMimeType, startCamera, stopStream } from "../lib/camera";
import { deviceId, randomNonce, signManifest, signingAvailable } from "../lib/deviceKey";
import { idbJournalStore } from "../lib/idb";
import { PIECE_SIZE, uploadInPieces } from "../lib/chunkedUpload";
import { Button, Card, Checkbox, Field, Input, PageHeader, Select, Textarea } from "../components/ui";
import { CaptureGps, NO_FIX, requestFix, type FixState } from "../components/CaptureGps";
import { DigestDrop, DigestLine } from "../components/DigestDrop";
import { VerificationBadge } from "../components/verification";
import { EmptyState } from "../components/DataState";

/**
 * Evidence capture (2.0 · F10 photo, F12 video, and upload).
 *
 * LIVE CAPTURE NEVER TOUCHES THE GALLERY. The photograph is taken now, by this
 * device's camera, and the bytes the camera produced are the bytes hashed and
 * sent: nothing re-encodes, compresses or strips them afterwards. The GPS fix is
 * requested at the moment the shutter fires, with maximumAge 0, so a cached or
 * typed-in position can never be recorded as the place of capture.
 *
 * An existing file goes through "Upload existing file" and is tagged as an
 * upload, anchored by its own digest. The two are never confused.
 */

type Mode = "photo" | "video" | "upload";
const MAX_ACCURACY_METRES = 50;
const APP_VERSION = "2.0.0";
// Larger files go up in 2 MB pieces. Kept under 4.5 MB because hosted proxies
// (Vercel forwarding /api to the API) refuse request bodies above that.
const DIRECT_LIMIT = 4 * 1024 * 1024;
const journal = new RecordingJournal(idbJournalStore);

interface Captured {
  blob: Blob;
  fileName: string;
  sha256: string;
  deviceTimeMs: number;
  durationMs: number | null;
  start: FixState;
  end: FixState | null;
  journalId?: string;
  previewUrl: string;
}

interface Registered {
  evidence: EvidenceRow;
  verification: Verification;
  replayed: boolean;
}

function cameraMessage(error: unknown): MessageKey {
  if (error instanceof CameraError) {
    if (error.kind === "denied") return "capture.cameraDenied";
    if (error.kind === "missing" || error.kind === "unsupported") return "capture.cameraMissing";
    if (error.kind === "insecure") return "capture.cameraInsecure";
  }
  return "capture.cameraError";
}

export function CapturePage() {
  const { user } = useAuth();
  const { t } = useI18n();
  const cases = useQuery<{ cases: CaseRow[] }>("/api/cases");
  const writable = useMemo(() => (cases.data?.cases ?? []).filter((row) => row.access !== "read"), [cases.data]);

  const [mode, setMode] = useState<Mode>("photo");
  const [caseId, setCaseId] = useState("");
  const [purpose, setPurpose] = useState<CapturePurpose>("general");
  const [notes, setNotes] = useState("");
  const [witnesses, setWitnesses] = useState<string[]>([""]);
  const [checklist, setChecklist] = useState({ place: false, witnesses: false, continuous: false, sealed: false });
  const [captured, setCaptured] = useState<Captured | null>(null);
  const [proceedAnyway, setProceedAnyway] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [registered, setRegistered] = useState<Registered | null>(null);

  // Upload mode
  const [uploadFile, setUploadFile] = useState<{ file: File; sha256: string } | null>(null);
  const [uploadKind, setUploadKind] = useState<"photo" | "video" | "document" | "audio" | "physical">("photo");
  const [collectedAt, setCollectedAt] = useState(() => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
  const [uploadFix, setUploadFix] = useState<FixState>(NO_FIX);
  const [useLocation, setUseLocation] = useState(false);

  useEffect(() => {
    if (writable.length === 1 && !caseId) setCaseId(writable[0].id);
  }, [writable, caseId]);

  useEffect(() => {
    // Purpose follows the mode unless chosen otherwise.
    setPurpose(mode === "video" ? "search_seizure" : "general");
  }, [mode]);

  const selectedCase = writable.find((row) => row.id === caseId) ?? null;
  const evidenceBase = user ? `${ROLE_HOME[user.role]}/cases/evidence/` : "/";

  const reset = useCallback(() => {
    if (captured) URL.revokeObjectURL(captured.previewUrl);
    setCaptured(null);
    setProceedAnyway(false);
    setRegistered(null);
    setError(null);
    setProgress(null);
    setUploadFile(null);
  }, [captured]);

  /* --------------------------------------------------------- register */

  const register = async () => {
    if (!user || !selectedCase) return;
    setRegistering(true);
    setError(null);
    try {
      let blob: Blob;
      let fileName: string;
      let sha256: string;
      let manifest: CaptureManifest | null = null;
      let kind: string;
      let idempotencyKey: string;

      const form = new FormData();
      form.append("caseId", selectedCase.id);

      if (mode === "upload") {
        if (!uploadFile) return;
        blob = uploadFile.file;
        fileName = uploadFile.file.name;
        sha256 = uploadFile.sha256;
        kind = uploadKind;
        idempotencyKey = `upload-${sha256.slice(2, 34)}-${selectedCase.id.slice(0, 8)}`;
        form.append("source", "upload");
        form.append("collectedAt", new Date(collectedAt).toISOString());
        form.append("deviceReportedMtime", new Date(uploadFile.file.lastModified).toISOString());
        if (useLocation && uploadFix.fix) {
          form.append("gpsLat", String(uploadFix.fix.lat));
          form.append("gpsLng", String(uploadFix.fix.lng));
        }
      } else {
        if (!captured) return;
        blob = captured.blob;
        fileName = captured.fileName;
        sha256 = captured.sha256;
        kind = mode === "photo" ? "photo" : "video";
        const nonce = randomNonce();
        const mediaKind: MediaKind = mode === "photo" ? "photo" : "audio_video";
        manifest = buildCaptureManifest({
          source: "capture",
          mediaKind,
          purpose,
          file: { sha256, bytes: blob.size, mimeType: blob.type || (mode === "photo" ? "image/jpeg" : "video/webm") },
          caseRef: selectedCase.case_reference,
          officerId: user.id,
          deviceId: deviceId(),
          appVersion: APP_VERSION,
          platform: "web",
          deviceTimeMs: captured.deviceTimeMs,
          durationMs: captured.durationMs,
          gpsStart: captured.start.fix,
          gpsEnd: captured.end?.fix ?? null,
          noFixReason: captured.start.reason,
          maxAccuracyMetres: MAX_ACCURACY_METRES,
          nonce,
        });
        idempotencyKey = `capture-${nonce}`;
        form.append("source", "capture");
        form.append("collectedAt", new Date(captured.deviceTimeMs).toISOString());
        form.append("manifest", JSON.stringify(manifest));
        const signature = await signManifest(manifest, user.id);
        if (signature) form.append("signature", JSON.stringify(signature));
      }

      form.append("clientHash", sha256);
      form.append("kind", kind);
      if (notes.trim()) form.append("notes", notes.trim());
      if (purpose === "search_seizure") {
        const named = witnesses.map((w) => w.trim()).filter((w) => w.length >= 2).map((name) => ({ name }));
        if (named.length) form.append("witnesses", JSON.stringify(named));
        form.append("searchChecklist", JSON.stringify(checklist));
      }

      if (blob.size > DIRECT_LIMIT) {
        const uploadId = await uploadInPieces({
          blob,
          caseId: selectedCase.id,
          fileName,
          sha256,
          onProgress: (done, total) => setProgress({ done, total }),
        });
        form.append("uploadId", uploadId);
      } else {
        form.append("file", blob, fileName);
      }
      form.append("deviceClockAtSendMs", String(Date.now()));

      const result = await api.upload<Registered>("/api/evidence", form, { "idempotency-key": idempotencyKey });
      setRegistered(result);
      if (captured?.journalId) await journal.discard(captured.journalId).catch(() => undefined);
    } catch (caught) {
      // A 5xx the API chose not to explain still says which failure it was and
      // where the explanation is, rather than a bare "something went wrong".
      const detail = caught instanceof ApiError && caught.status >= 500 && caught.code === "INTERNAL" ? ` (${caught.code} · HTTP ${caught.status} — the API log has the cause)` : "";
      setError(
        caught instanceof ManifestError || caught instanceof ApiError || caught instanceof Error
          ? caught.message + detail
          : t("common.error")
      );
    } finally {
      setRegistering(false);
    }
  };

  /* --------------------------------------------------------- readiness */

  const fixOk = (state: FixState | null | undefined) => state?.status === "ok";
  const needsConsent = mode !== "upload" && captured !== null && (!fixOk(captured.start) || (captured.end !== null && !fixOk(captured.end)));
  const ready =
    Boolean(selectedCase) &&
    !registering &&
    (mode === "upload" ? Boolean(uploadFile) && (!useLocation || Boolean(uploadFix.fix)) : Boolean(captured) && (!needsConsent || proceedAnyway));

  /* --------------------------------------------------------- render */

  if (registered) {
    return <RegisteredView registered={registered} evidenceBase={evidenceBase} onAnother={reset} />;
  }

  return (
    <>
      <PageHeader eyebrow="Evidence capture" title={t("capture.title")} description={t("capture.intro")} />

      <div className="grid gap-5 lg:grid-cols-[1.35fr_1fr]">
        <div className="min-w-0 space-y-5">
          {/* ---------------------------------------------------- case */}
          <Card title={`1 · ${t("capture.case")}`}>
            {cases.loading && !cases.data ? (
              <p className="font-ui text-sm text-muted">{t("common.loading")}</p>
            ) : writable.length === 0 ? (
              <EmptyState
                title={t("capture.noWritableCase")}
                icon={<ClipboardList size={19} />}
                action={
                  user?.role === "police" ? (
                    <Link to="/police/new-case" className="font-ui text-xs font-semibold text-primary hover:underline">
                      {t("nav.newCase")}
                    </Link>
                  ) : undefined
                }
              />
            ) : (
              <Field label={t("capture.case")} required>
                <Select value={caseId} onChange={(event) => setCaseId(event.target.value)}>
                  <option value="">{t("capture.selectCase")}</option>
                  {writable.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.case_reference} — {row.title}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </Card>

          {/* ---------------------------------------------------- mode */}
          <div role="tablist" aria-label={t("capture.title")} className="grid grid-cols-3 gap-2 rounded-2xl border border-border bg-surface p-1.5">
            {(
              [
                ["photo", "capture.modePhoto", Camera],
                ["video", "capture.modeVideo", Video],
                ["upload", "capture.modeUpload", FileUp],
              ] as const
            ).map(([value, label, Icon]) => (
              <button
                key={value}
                role="tab"
                type="button"
                aria-selected={mode === value}
                disabled={registering}
                onClick={() => {
                  reset();
                  setMode(value);
                }}
                className={`flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-2 py-2 font-ui text-xs font-semibold transition sm:text-sm ${
                  mode === value ? "bg-primary-fill text-on-primary shadow-sm" : "text-muted hover:bg-surface-2 hover:text-text"
                }`}
              >
                <Icon size={16} aria-hidden />
                <span className="text-center leading-tight">{t(label)}</span>
              </button>
            ))}
          </div>

          {/* ---------------------------------------------------- capture */}
          <Card title={`2 · ${t(mode === "photo" ? "capture.modePhoto" : mode === "video" ? "capture.modeVideo" : "capture.modeUpload")}`}>
            {mode === "photo" && <PhotoCapture captured={captured} onCaptured={setCaptured} onReset={reset} disabled={registering} />}
            {mode === "video" && <VideoCapture caseId={caseId} captured={captured} onCaptured={setCaptured} onReset={reset} disabled={registering} />}
            {mode === "upload" && (
              <div className="space-y-4">
                {uploadFile ? (
                  <div className="space-y-2">
                    <DigestLine file={uploadFile.file} sha256={uploadFile.sha256} label={t("capture.fileDigest")} />
                    <Button size="sm" variant="ghost" icon={<X size={12} />} onClick={() => setUploadFile(null)}>
                      {t("capture.discard")}
                    </Button>
                  </div>
                ) : (
                  <DigestDrop label={t("capture.uploadPick")} hint={t("capture.uploadHint")} onDigest={(d) => setUploadFile(d)} />
                )}
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t("capture.kind")} required>
                    <Select value={uploadKind} onChange={(e) => setUploadKind(e.target.value as typeof uploadKind)}>
                      <option value="photo">Photo</option>
                      <option value="video">Video</option>
                      <option value="audio">Audio</option>
                      <option value="document">Document</option>
                      <option value="physical">Physical item (photograph of)</option>
                    </Select>
                  </Field>
                  <Field label={t("capture.collectedAt")} hint={t("capture.collectedAtHint")} required>
                    <Input type="datetime-local" value={collectedAt} onChange={(e) => setCollectedAt(e.target.value)} />
                  </Field>
                </div>
                <Checkbox
                  label={t("capture.useLocation")}
                  checked={useLocation}
                  onChange={async (checked) => {
                    setUseLocation(checked);
                    if (checked && !uploadFix.fix) {
                      setUploadFix({ ...NO_FIX, status: "locating" });
                      setUploadFix(await requestFix(MAX_ACCURACY_METRES));
                    }
                  }}
                />
                {useLocation && (
                  <CaptureGps
                    label={t("capture.location")}
                    state={uploadFix}
                    maxAccuracyMetres={MAX_ACCURACY_METRES}
                    onRetry={async () => {
                      setUploadFix({ ...NO_FIX, status: "locating" });
                      setUploadFix(await requestFix(MAX_ACCURACY_METRES));
                    }}
                  />
                )}
              </div>
            )}
          </Card>

          {/* ---------------------------------------------------- details */}
          <Card title={`3 · ${t("capture.notes")}`}>
            <div className="space-y-4">
              {mode !== "upload" && (
                <Field label={t("capture.purpose")}>
                  <Select value={purpose} onChange={(e) => setPurpose(e.target.value as CapturePurpose)}>
                    <option value="general">{t("capture.purposeGeneral")}</option>
                    <option value="search_seizure">{t("capture.purposeSearch")}</option>
                    <option value="lab_intake">{t("capture.purposeLab")}</option>
                  </Select>
                </Field>
              )}
              <Field label={t("capture.notes")} hint={t("capture.notesHint")}>
                <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>

              {purpose === "search_seizure" && mode !== "upload" && (
                <div className="space-y-3 rounded-xl border border-border bg-surface-2 p-4">
                  <p className="font-ui text-sm font-semibold text-text">{t("capture.witnesses")}</p>
                  <p className="font-ui text-2xs text-muted">{t("capture.witnessesHint")}</p>
                  {witnesses.map((name, index) => (
                    <div key={index} className="flex gap-2">
                      <Input
                        aria-label={`${t("capture.witnessName")} ${index + 1}`}
                        placeholder={t("capture.witnessName")}
                        value={name}
                        onChange={(e) => setWitnesses(witnesses.map((w, i) => (i === index ? e.target.value : w)))}
                      />
                      {witnesses.length > 1 && (
                        <button
                          type="button"
                          aria-label={t("capture.discard")}
                          onClick={() => setWitnesses(witnesses.filter((_, i) => i !== index))}
                          className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-border text-muted hover:text-danger"
                        >
                          <Trash2 size={14} aria-hidden />
                        </button>
                      )}
                    </div>
                  ))}
                  {witnesses.length < 6 && (
                    <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => setWitnesses([...witnesses, ""])}>
                      {t("capture.addWitness")}
                    </Button>
                  )}

                  <p className="pt-2 font-ui text-sm font-semibold text-text">{t("capture.checklist")}</p>
                  <div className="grid gap-2">
                    {(
                      [
                        ["place", "capture.checkPlace"],
                        ["witnesses", "capture.checkWitnesses"],
                        ["continuous", "capture.checkContinuous"],
                        ["sealed", "capture.checkSealed"],
                      ] as const
                    ).map(([key, label]) => (
                      <Checkbox key={key} label={t(label)} checked={checklist[key]} onChange={(v) => setChecklist({ ...checklist, [key]: v })} />
                    ))}
                  </div>
                  <p className="flex gap-2 rounded-lg bg-info-soft px-3 py-2 font-ui text-2xs leading-relaxed text-text">
                    <Info size={13} className="mt-0.5 shrink-0 text-info" aria-hidden />
                    {t("capture.legalNote")}
                  </p>
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* ------------------------------------------------------ side rail */}
        <div className="space-y-5 lg:sticky lg:top-6 lg:self-start">
          <Card title={t("capture.ready")}>
            <ul className="space-y-2.5">
              <Check done={Boolean(selectedCase)} label={t("capture.case")} />
              <Check done={mode === "upload" ? Boolean(uploadFile) : Boolean(captured)} label={t("capture.fileDigest")} />
              {mode !== "upload" && <Check done={Boolean(captured && fixOk(captured.start))} label={t("capture.location")} warn={needsConsent} />}
            </ul>

            {captured && mode !== "upload" && selectedCase && user && (
              <ManifestPreview captured={captured} caseReference={selectedCase.case_reference} />
            )}

            {needsConsent && (
              <div className="mt-4 space-y-2">
                <Checkbox
                  label={t("capture.gpsProceed")}
                  description={t("capture.gpsProceedNote", {
                    status: captured?.start.status === "low" ? "LOW_ACCURACY" : "NO_GPS",
                  })}
                  checked={proceedAnyway}
                  onChange={setProceedAnyway}
                />
              </div>
            )}

            {progress && (
              <div className="mt-4" role="status">
                <p className="font-ui text-2xs text-muted">{t("capture.uploading", { done: progress.done, total: progress.total })}</p>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
                  <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
                </div>
              </div>
            )}

            {error && (
              <div role="alert" className="mt-4 rounded-xl border border-danger-soft bg-danger-soft px-3 py-2.5 font-ui text-xs leading-relaxed text-text">
                {error}
              </div>
            )}

            <Button full size="lg" className="mt-4" disabled={!ready} loading={registering} icon={<PackageCheck size={15} />} onClick={() => void register()}>
              {registering ? t("capture.registering") : t("capture.register")}
            </Button>

            <p className="mt-3 flex gap-2 font-ui text-2xs leading-relaxed text-faint">
              <ShieldCheck size={13} className="mt-0.5 shrink-0" aria-hidden />
              {t("capture.gpsPrivacy")}
            </p>
            {mode !== "upload" && (
              <p className="mt-2 rounded-lg bg-accent-soft px-3 py-2 font-ui text-2xs leading-relaxed text-text">{t("capture.honesty")}</p>
            )}
            {mode !== "upload" && !signingAvailable() && (
              <p className="mt-2 font-ui text-2xs text-faint">{t("capture.signatureUnavailable")}</p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function Check({ done, label, warn }: { done: boolean; label: string; warn?: boolean }) {
  return (
    <li className="flex items-center gap-2.5">
      <span
        className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border text-2xs font-bold ${
          done ? "border-primary bg-primary text-on-primary" : warn ? "border-warning bg-warning-soft text-warning" : "border-border text-faint"
        }`}
        aria-hidden
      >
        {done ? "✓" : warn ? "!" : ""}
      </span>
      <span className={`font-ui text-xs ${done ? "text-text" : "text-muted"}`}>{label}</span>
      <span className="sr-only">{done ? "done" : "not done"}</span>
    </li>
  );
}

function ManifestPreview({ captured, caseReference }: { captured: Captured; caseReference: string }) {
  const { t } = useI18n();
  const { user } = useAuth();
  // A preview digest with a fixed nonce, for display only: the real manifest is
  // built with a fresh nonce at registration, so this exact value is not what
  // goes on chain. It shows what is being committed to.
  const preview = useMemo(() => {
    try {
      return manifestDigest(
        buildCaptureManifest({
          source: "capture",
          mediaKind: captured.durationMs ? "audio_video" : "photo",
          file: { sha256: captured.sha256, bytes: captured.blob.size, mimeType: captured.blob.type || "image/jpeg" },
          caseRef: caseReference,
          officerId: user?.id ?? "preview",
          deviceId: deviceId(),
          appVersion: APP_VERSION,
          platform: "web",
          deviceTimeMs: captured.deviceTimeMs,
          durationMs: captured.durationMs,
          gpsStart: captured.start.fix,
          gpsEnd: captured.end?.fix ?? null,
          noFixReason: captured.start.reason,
          maxAccuracyMetres: MAX_ACCURACY_METRES,
          nonce: "0".repeat(32),
        })
      );
    } catch (error) {
      return error instanceof Error ? error.message : null;
    }
  }, [captured, caseReference, user]);

  return (
    <div className="mt-4 space-y-2">
      <DigestLine sha256={captured.sha256} label={t("capture.fileDigest")} />
      <div className="rounded-xl border border-primary-ring bg-primary-soft px-3.5 py-3">
        <p className="mb-1 font-ui text-2xs font-semibold uppercase tracking-wider text-primary">{t("capture.manifestDigest")}</p>
        <code className="hash block text-text">{preview}</code>
      </div>
    </div>
  );
}

/* ================================================================ photo */

function PhotoCapture({
  captured,
  onCaptured,
  onReset,
  disabled,
}: {
  captured: Captured | null;
  onCaptured: (c: Captured) => void;
  onReset: () => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [cameraError, setCameraError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => () => stopStream(stream), [stream]);

  const open = async (which = facing) => {
    setCameraError(null);
    try {
      stopStream(stream);
      const next = await startCamera({ facing: which, audio: false });
      setStream(next);
      if (videoRef.current) {
        videoRef.current.srcObject = next;
        await videoRef.current.play().catch(() => undefined);
      }
    } catch (error) {
      setCameraError(error);
    }
  };

  const shoot = async () => {
    if (!videoRef.current) return;
    setBusy(true);
    try {
      const deviceTimeMs = Date.now();
      // The fix is requested at the shutter, in parallel with encoding the frame.
      const [blob, start] = await Promise.all([grabFrame(videoRef.current), requestFix(MAX_ACCURACY_METRES)]);
      const sha256 = await sha256File(blob);
      stopStream(stream);
      setStream(null);
      onCaptured({
        blob,
        fileName: `capture-${new Date(deviceTimeMs).toISOString().replace(/[:.]/g, "-")}.jpg`,
        sha256,
        deviceTimeMs,
        durationMs: null,
        start,
        end: null,
        previewUrl: URL.createObjectURL(blob),
      });
    } catch (error) {
      setCameraError(error);
    } finally {
      setBusy(false);
    }
  };

  if (captured) {
    return (
      <div className="space-y-3">
        <img src={captured.previewUrl} alt="" className="max-h-[420px] w-full rounded-xl border border-border bg-surface-2 object-contain" />
        <p className="font-ui text-2xs text-muted">
          {formatBytes(captured.blob.size)} · {new Date(captured.deviceTimeMs).toLocaleString()}
        </p>
        <CaptureGps label={t("capture.location")} state={captured.start} maxAccuracyMetres={MAX_ACCURACY_METRES} />
        <Button variant="secondary" size="sm" icon={<RotateCcw size={12} />} disabled={disabled} onClick={() => { onReset(); void open(); }}>
          {t("capture.retake")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-xl border border-border bg-[#0b1220]">
        <video ref={videoRef} playsInline muted className={`aspect-video w-full object-cover ${stream ? "" : "hidden"}`} />
        {!stream && (
          <div className="grid aspect-video place-items-center p-6 text-center">
            <div>
              <Camera size={30} className="mx-auto text-white/60" aria-hidden />
              <p className="mt-3 max-w-xs font-ui text-xs text-white/70">{t("capture.noGallery")}</p>
            </div>
          </div>
        )}
      </div>

      {cameraError !== null && (
        <p role="alert" className="rounded-xl border border-danger-soft bg-danger-soft p-3 font-ui text-xs text-text">
          {t(cameraMessage(cameraError), { reason: cameraError instanceof Error ? cameraError.message : "" })}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {!stream ? (
          <Button icon={<Camera size={14} />} onClick={() => void open()} disabled={disabled}>
            {t("capture.startCamera")}
          </Button>
        ) : (
          <>
            <Button size="lg" icon={<Camera size={16} />} loading={busy} onClick={() => void shoot()}>
              {t("capture.takePhoto")}
            </Button>
            <Button
              variant="secondary"
              icon={<SwitchCamera size={14} />}
              onClick={() => {
                const next = facing === "environment" ? "user" : "environment";
                setFacing(next);
                void open(next);
              }}
            >
              {t("capture.switchCamera")}
            </Button>
            <Button variant="ghost" onClick={() => { stopStream(stream); setStream(null); }}>
              {t("capture.stopCamera")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/* ================================================================ video */

function VideoCapture({
  caseId,
  captured,
  onCaptured,
  onReset,
  disabled,
}: {
  caseId: string;
  captured: Captured | null;
  onCaptured: (c: Captured) => void;
  onReset: () => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const piecesRef = useRef<Blob[]>([]);
  const journalIdRef = useRef<string | null>(null);
  const startRef = useRef<{ at: number; fix: Promise<FixState> } | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [cameraError, setCameraError] = useState<unknown>(null);
  const [finishing, setFinishing] = useState(false);
  const [recovered, setRecovered] = useState<{ id: string; chunks: number; bytes: number; startedAtMs: number; extra?: Record<string, unknown> } | null>(null);
  const mime = recorderMimeType();

  useEffect(() => () => stopStream(stream), [stream]);

  // A recording interrupted by a crash or a closed tab is still in the journal.
  useEffect(() => {
    void journal
      .interrupted()
      .then((list) => setRecovered(list.find((m) => m.chunks > 0) ?? null))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setElapsed(Date.now() - (startRef.current?.at ?? Date.now())), 500);
    return () => window.clearInterval(timer);
  }, [recording]);

  const open = async () => {
    setCameraError(null);
    try {
      const next = await startCamera({ facing: "environment", audio: true });
      setStream(next);
      if (videoRef.current) {
        videoRef.current.srcObject = next;
        await videoRef.current.play().catch(() => undefined);
      }
    } catch (error) {
      setCameraError(error);
    }
  };

  const start = async () => {
    if (!stream) return;
    const id = randomNonce();
    const at = Date.now();
    const fix = requestFix(MAX_ACCURACY_METRES);
    startRef.current = { at, fix };
    journalIdRef.current = id;
    piecesRef.current = [];
    await journal.begin({ id, caseId, mimeType: mime || "video/webm", startedAtMs: at });
    // Kept with the journal, so a recovered recording still knows where it began.
    void fix.then((state) => journal.annotate(id, { gpsStart: state }).catch(() => undefined));

    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return;
      piecesRef.current.push(event.data);
      // Every piece goes to IndexedDB as it arrives, so a crash loses at most two seconds.
      void event.data.arrayBuffer().then((buffer) => journal.append(id, new Uint8Array(buffer)).catch(() => undefined));
    };
    recorderRef.current = recorder;
    recorder.start(2000);
    setElapsed(0);
    setRecording(true);
  };

  const finish = async () => {
    const recorder = recorderRef.current;
    if (!recorder || !startRef.current) return;
    setFinishing(true);
    const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
    recorder.stop();
    await stopped;
    setRecording(false);
    const durationMs = Date.now() - startRef.current.at;
    const [startFix, endFix] = await Promise.all([startRef.current.fix, requestFix(MAX_ACCURACY_METRES)]);
    const blob = new Blob(piecesRef.current, { type: mime || "video/webm" });
    const sha256 = await sha256File(blob);
    stopStream(stream);
    setStream(null);
    setFinishing(false);
    onCaptured({
      blob,
      fileName: `search-${new Date(startRef.current.at).toISOString().replace(/[:.]/g, "-")}.webm`,
      sha256,
      deviceTimeMs: startRef.current.at,
      durationMs,
      start: startFix,
      end: endFix,
      journalId: journalIdRef.current ?? undefined,
      previewUrl: URL.createObjectURL(blob),
    });
  };

  const useRecovered = async () => {
    if (!recovered) return;
    const parts: Uint8Array[] = [];
    for await (const piece of journal.pieces(recovered.id)) parts.push(piece);
    const blob = new Blob(parts as BlobPart[], { type: mime || "video/webm" });
    const sha256 = await sha256File(blob);
    const start = (recovered.extra?.gpsStart as FixState | undefined) ?? { status: "none", fix: null, reason: "UNAVAILABLE" };
    onCaptured({
      blob,
      fileName: `recovered-${new Date(recovered.startedAtMs).toISOString().replace(/[:.]/g, "-")}.webm`,
      sha256,
      deviceTimeMs: recovered.startedAtMs,
      // The length of an interrupted recording is not known for certain, so it is not claimed.
      durationMs: null,
      start,
      end: null,
      journalId: recovered.id,
      previewUrl: URL.createObjectURL(blob),
    });
    setRecovered(null);
  };

  if (typeof MediaRecorder === "undefined") {
    return <p className="font-ui text-sm text-muted">{t("capture.cameraMissing")}</p>;
  }

  if (captured) {
    return (
      <div className="space-y-3">
        <video src={captured.previewUrl} controls playsInline className="max-h-[420px] w-full rounded-xl border border-border bg-black" />
        <p className="font-ui text-2xs text-muted">
          {formatBytes(captured.blob.size)}
          {captured.durationMs !== null && ` · ${Math.round(captured.durationMs / 1000)} s`}
          {captured.blob.size > DIRECT_LIMIT && ` · ${Math.ceil(captured.blob.size / PIECE_SIZE)} pieces`}
        </p>
        <CaptureGps label={`${t("capture.location")} — start`} state={captured.start} maxAccuracyMetres={MAX_ACCURACY_METRES} />
        {captured.end && <CaptureGps label={`${t("capture.location")} — end`} state={captured.end} maxAccuracyMetres={MAX_ACCURACY_METRES} />}
        <Button variant="secondary" size="sm" icon={<RotateCcw size={12} />} disabled={disabled} onClick={onReset}>
          {t("capture.retake")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {recovered && (
        <div role="status" className="rounded-xl border border-warning-soft bg-warning-soft p-3.5">
          <p className="font-ui text-xs text-text">
            {t("capture.recovered", { duration: `${recovered.chunks} × 2 s · ${formatBytes(recovered.bytes)}` })}
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <Button size="sm" icon={<RefreshCw size={12} />} onClick={() => void useRecovered()}>
              {t("capture.useRecovered")}
            </Button>
            <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => void journal.discard(recovered.id).then(() => setRecovered(null))}>
              {t("capture.discard")}
            </Button>
          </div>
        </div>
      )}

      <div className="relative overflow-hidden rounded-xl border border-border bg-[#0b1220]">
        <video ref={videoRef} playsInline muted className={`aspect-video w-full object-cover ${stream ? "" : "hidden"}`} />
        {!stream && (
          <div className="grid aspect-video place-items-center p-6 text-center">
            <Video size={30} className="text-white/60" aria-hidden />
          </div>
        )}
        {recording && (
          <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 font-ui text-2xs font-bold text-white">
            <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" aria-hidden />
            {t("capture.recording")} · {Math.floor(elapsed / 60000)}:{String(Math.floor((elapsed % 60000) / 1000)).padStart(2, "0")}
          </span>
        )}
      </div>

      {cameraError !== null && (
        <p role="alert" className="rounded-xl border border-danger-soft bg-danger-soft p-3 font-ui text-xs text-text">
          {t(cameraMessage(cameraError), { reason: cameraError instanceof Error ? cameraError.message : "" })}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {!stream ? (
          <Button icon={<Video size={14} />} onClick={() => void open()} disabled={disabled || !caseId}>
            {t("capture.startCamera")}
          </Button>
        ) : !recording ? (
          <Button size="lg" icon={<Video size={16} />} onClick={() => void start()} disabled={!caseId}>
            {t("capture.startRecording")}
          </Button>
        ) : (
          <Button size="lg" variant="danger" icon={<CircleStop size={16} />} loading={finishing} onClick={() => void finish()}>
            {t("capture.stopRecording")}
          </Button>
        )}
      </div>
    </div>
  );
}

/* ============================================================ registered */

function RegisteredView({ registered, evidenceBase, onAnother }: { registered: Registered; evidenceBase: string; onAnother: () => void }) {
  const { t } = useI18n();
  const ref = registered.evidence.public_ref;
  return (
    <div className="mx-auto max-w-2xl">
      <div className="panel overflow-hidden">
        <div className="h-1.5 bg-grad-brand" aria-hidden />
        <div className="p-6 sm:p-8">
          <span className="grid h-14 w-14 place-items-center rounded-2xl bg-success-soft text-success">
            <CheckCircle2 size={28} aria-hidden />
          </span>
          <h1 className="mt-4 font-display text-2xl text-text sm:text-3xl">{t("capture.registered")}</h1>
          <div className="mt-3">
            <VerificationBadge state={registered.verification.state} />
          </div>
          <dl className="mt-5 space-y-3">
            {ref && (
              <div>
                <dt className="font-ui text-2xs font-semibold uppercase tracking-wider text-faint">{t("passport.reference")}</dt>
                <dd className="mt-0.5 font-mono text-sm text-text">{ref}</dd>
              </div>
            )}
            <div>
              <dt className="font-ui text-2xs font-semibold uppercase tracking-wider text-faint">{t("passport.digest")}</dt>
              <dd className="hash mt-0.5 text-text">{registered.evidence.anchored_digest ?? registered.evidence.file_hash}</dd>
            </div>
          </dl>
          {registered.verification.failureReason && (
            <p className="mt-4 rounded-xl bg-warning-soft p-3 font-ui text-xs text-text">{registered.verification.failureReason}</p>
          )}
          <div className="mt-6 flex flex-wrap gap-2">
            <Link
              to={`${evidenceBase}${registered.evidence.id}`}
              className="inline-flex h-10 items-center gap-2 rounded-full bg-primary-fill px-5 font-ui text-xs font-semibold uppercase tracking-wide text-on-primary"
            >
              {t("capture.openItem")}
            </Link>
            {ref && (
              <Link
                to={`/verify/${ref}`}
                className="inline-flex h-10 items-center gap-2 rounded-full border border-border px-5 font-ui text-xs font-semibold uppercase tracking-wide text-text hover:border-primary"
              >
                <QrCode size={14} aria-hidden /> {t("capture.openPassport")}
              </Link>
            )}
            <Button variant="ghost" onClick={onAnother}>
              {t("capture.captureAnother")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
