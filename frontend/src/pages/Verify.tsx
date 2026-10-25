import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowRight,
  CheckCircle2,
  Download,
  ExternalLink,
  Fingerprint,
  Info,
  MapPinned,
  QrCode,
  RotateCcw,
  ShieldAlert,
  Smartphone,
  Upload,
  XCircle,
} from "lucide-react";
import { PublicShell } from "../components/PublicShell";
import { DigestDrop, DigestLine, type Digested } from "../components/DigestDrop";
import { VerificationBadge } from "../components/verification";
import { Button, CopyButton, Spinner } from "../components/ui";
import { api, apiOrigin, ApiError, type FileCheckResult, type PublicPassport } from "../lib/api";
import { useI18n, type MessageKey } from "../i18n";
import { formatDateTime } from "../lib/format";

const REF_PATTERN = /^NSE-[0-9A-Z]{26,32}$/;

/**
 * The Evidence Integrity Passport, public (2.0 · F3).
 *
 * Anyone with a reference — printed on the passport, encoded in its QR code —
 * can open this page without an account and check a file against the chain. The
 * file is hashed in the browser; only the fingerprint is sent.
 */
export default function VerifyPage() {
  const { ref } = useParams<{ ref?: string }>();
  return <PublicShell>{ref ? <PassportView reference={ref.trim().toUpperCase()} /> : <Lookup />}</PublicShell>;
}

function Lookup() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const normalised = value.trim().toUpperCase();
  const valid = REF_PATTERN.test(normalised);

  return (
    <div className="mx-auto max-w-2xl pt-6 text-center">
      <span className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-3xl bg-grad-brand text-white shadow-glow">
        <QrCode size={28} aria-hidden />
      </span>
      <p className="font-jakarta text-2xs font-bold uppercase tracking-[0.16em] text-primary">{t("passport.eyebrow")}</p>
      <h1 className="mt-2 font-display text-3xl leading-tight text-text sm:text-4xl">{t("passport.title")}</h1>
      <p className="mx-auto mt-3 max-w-xl font-ui text-sm leading-relaxed text-muted">{t("passport.intro")}</p>

      <form
        className="mx-auto mt-8 max-w-lg text-left"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) navigate(`/verify/${normalised}`);
        }}
      >
        <label htmlFor="ref" className="label">
          {t("passport.lookupLabel")}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="ref"
            className="input font-mono uppercase"
            placeholder={t("passport.lookupPlaceholder")}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={value !== "" && !valid}
            aria-describedby="ref-hint"
          />
          <Button type="submit" disabled={!valid} iconRight={<ArrowRight size={14} />}>
            {t("passport.lookup")}
          </Button>
        </div>
        <p id="ref-hint" className="mt-2 font-ui text-2xs text-faint">
          {value !== "" && !valid ? t("passport.malformed") : t("passport.lookupHint")}
        </p>
      </form>
    </div>
  );
}

function errorKey(error: unknown): MessageKey {
  if (error instanceof ApiError) {
    if (error.status === 404) return "passport.notFound";
    if (error.status === 400) return "passport.malformed";
    if (error.status === 429) return "passport.rateLimited";
    if (error.code === "CANNOT_VERIFY_NOW") return "passport.cannotVerify";
    if (error.code === "NOT_ANCHORED") return "passport.notAnchoredCheck";
  }
  return "common.error";
}

function PassportView({ reference }: { reference: string }) {
  const { t } = useI18n();
  const [passport, setPassport] = useState<PublicPassport | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setPassport(null);
    setError(null);
    api
      .get<{ passport: PublicPassport }>(`/api/public/verify/${encodeURIComponent(reference)}`, controller.signal)
      .then((result) => setPassport(result.passport))
      .catch((caught) => {
        if (!controller.signal.aborted) setError(caught);
      });
    return () => controller.abort();
  }, [reference, nonce]);

  if (error) {
    return (
      <div className="mx-auto max-w-xl rounded-panel border border-danger-soft bg-surface p-6 text-center shadow-card">
        <ShieldAlert size={26} className="mx-auto text-danger" aria-hidden />
        <p className="mt-3 font-ui text-sm font-semibold text-text">{t(errorKey(error))}</p>
        <code className="mt-2 block font-mono text-2xs text-muted">{reference}</code>
        <div className="mt-5 flex justify-center gap-2">
          <Button variant="secondary" size="sm" icon={<RotateCcw size={12} />} onClick={() => setNonce((n) => n + 1)}>
            {t("common.retry")}
          </Button>
        </div>
      </div>
    );
  }

  if (!passport) {
    return (
      <div className="grid min-h-[40vh] place-items-center" role="status">
        <Spinner size={26} />
        <span className="sr-only">{t("common.loading")}</span>
      </div>
    );
  }

  return <PassportBody passport={passport} />;
}

export function PassportBody({ passport, children }: { passport: PublicPassport; children?: React.ReactNode }) {
  const { t } = useI18n();
  const verified = passport.verified;
  const problem = passport.state === "INTEGRITY_MISMATCH" || passport.agreement === "DISAGREES";
  const pdfUrl = `${apiOrigin}/api/public/verify/${passport.reference}/passport.pdf`;
  const qrUrl = `${apiOrigin}/api/public/verify/${passport.reference}/qr.svg`;

  return (
    <div className="space-y-6">
      {/* -------------------------------------------------- headline card */}
      <section
        className={`relative overflow-hidden rounded-panel border bg-surface p-5 shadow-card sm:p-7 ${
          verified ? "border-success-soft" : problem ? "border-danger-soft" : "border-border"
        }`}
      >
        <div className={`absolute inset-x-0 top-0 h-1.5 ${verified ? "bg-grad-brand" : problem ? "bg-danger" : "bg-warning"}`} aria-hidden />
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1">
            <p className="font-jakarta text-2xs font-bold uppercase tracking-[0.16em] text-primary">{t("passport.title")}</p>
            <div className="mt-3 flex items-start gap-3">
              <span
                className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl ${
                  verified ? "bg-success-soft text-success" : problem ? "bg-danger-soft text-danger" : "bg-warning-soft text-warning"
                }`}
              >
                {verified ? <CheckCircle2 size={24} aria-hidden /> : problem ? <XCircle size={24} aria-hidden /> : <Info size={24} aria-hidden />}
              </span>
              <div className="min-w-0">
                <h1 className="font-display text-2xl leading-tight text-text sm:text-3xl">
                  {verified ? t("passport.verified") : t("passport.notVerified")}
                </h1>
                <div className="mt-2">
                  <VerificationBadge state={passport.state} />
                </div>
              </div>
            </div>
            <p className="mt-4 font-ui text-sm font-semibold text-text">{passport.explanation.heading}</p>
            <p className="mt-1 max-w-2xl font-ui text-sm leading-relaxed text-muted">{passport.explanation.text}</p>

            {passport.flags.length > 0 && (
              <ul className="mt-4 space-y-2">
                {passport.flags.map((flag) => (
                  <li key={flag} className="flex gap-2 rounded-xl border border-warning-soft bg-warning-soft px-3 py-2">
                    <ShieldAlert size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden />
                    <span className="font-ui text-xs leading-relaxed text-text">{t(`passport.flag.${flag}` as MessageKey)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex shrink-0 flex-row items-center gap-4 lg:flex-col lg:items-end">
            <img src={qrUrl} alt={t("passport.qr")} width={132} height={132} className="rounded-xl border border-border bg-white p-1.5" />
            <a
              href={pdfUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex h-10 items-center gap-2 rounded-full bg-primary-fill px-4 font-ui text-xs font-semibold text-on-primary transition hover:-translate-y-0.5"
            >
              <Download size={14} aria-hidden />
              {t("passport.downloadPdf")}
            </a>
          </div>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1.25fr_1fr]">
        <div className="space-y-6">
          {/* ---------------------------------------------- what is anchored */}
          <section className="panel p-5 sm:p-6">
            <dl className="space-y-4">
              <Field label={t("passport.reference")}>
                <div className="flex items-center gap-2">
                  <code className="font-mono text-sm text-text">{passport.reference}</code>
                  <CopyButton value={passport.reference} label={t("common.copy")} />
                </div>
              </Field>
              <Field label={passport.anchorMode === "manifest" ? t("passport.digestManifest") : t("passport.digest")}>
                <code className="hash block text-text">{passport.digest ?? "—"}</code>
                <p className="mt-1 font-ui text-2xs text-faint">
                  {passport.digestSource === "chain" ? t("passport.digestFromChain") : t("passport.digestFromRecord")}
                </p>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("passport.registered")}>{passport.registeredAt ? formatDateTime(passport.registeredAt) : "—"}</Field>
                <Field label={t("passport.network")}>
                  {passport.network ? `${passport.network.name} · ${passport.network.chainId}` : "—"}
                </Field>
              </div>
              <Field label={t("passport.transaction")}>
                {passport.transaction.hash ? (
                  passport.transaction.explorer ? (
                    <a href={passport.transaction.explorer} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1.5 break-all font-mono text-2xs text-primary hover:underline">
                      {passport.transaction.hash}
                      <ExternalLink size={11} className="shrink-0" aria-hidden />
                    </a>
                  ) : (
                    <code className="hash text-text">{passport.transaction.hash}</code>
                  )
                ) : (
                  "—"
                )}
              </Field>
              <Field label={t("passport.source")}>
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span className="chip border-border bg-surface-2 text-muted">
                    {passport.source === "capture" ? <Smartphone size={11} aria-hidden /> : <Upload size={11} aria-hidden />}
                    {passport.source === "capture" ? t("passport.sourceCapture") : t("passport.sourceUpload")}
                  </span>
                  {passport.source === "capture" && (
                    <span className="chip border-border bg-surface-2 text-muted">
                      <MapPinned size={11} aria-hidden />
                      {passport.locationCommitted ? t("passport.locationCommitted") : t("passport.locationNotCommitted")}
                    </span>
                  )}
                </span>
              </Field>
            </dl>
          </section>

          {/* ---------------------------------------------- custody */}
          <section className="panel p-5 sm:p-6">
            <h2 className="font-display text-lg text-text">{t("passport.custody")}</h2>
            {passport.custody.length === 0 ? (
              <p className="mt-3 font-ui text-sm text-muted">{t("passport.noCustody")}</p>
            ) : (
              <ol className="mt-4 space-y-4 border-l-2 border-border pl-5">
                {passport.custody.map((event, index) => (
                  <li key={index} className="relative">
                    <span className="absolute -left-[27px] top-1 grid h-4 w-4 place-items-center rounded-full border-2 border-surface bg-primary" aria-hidden />
                    <p className="font-ui text-sm font-semibold text-text">
                      {event.type === "REGISTERED" ? t("passport.custodyRegistered") : t("passport.custodyTransfer")}
                    </p>
                    <p className="font-ui text-xs text-muted">
                      {event.from ? `${event.from} → ${event.to}` : event.to}
                    </p>
                    <p className="mt-0.5 font-ui text-2xs text-faint">
                      {formatDateTime(event.at)} · {event.source === "chain" ? t("passport.custodyFromChain") : t("passport.custodyFromRecord")}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </section>
          {children}
        </div>

        <div className="space-y-6">
          <FileCheck passport={passport} />

          <section className="rounded-panel border border-accent-ring bg-accent-soft p-5">
            <h2 className="flex items-center gap-2 font-ui text-xs font-bold uppercase tracking-wider text-accent">
              <ShieldAlert size={14} aria-hidden /> {t("passport.limitsTitle")}
            </h2>
            <p className="mt-2 font-ui text-sm leading-relaxed text-text">{t("passport.limits")}</p>
          </section>

          <section className="panel p-5">
            <h2 className="flex items-center gap-2 font-ui text-sm font-semibold text-text">
              <Fingerprint size={15} className="text-primary" aria-hidden /> {t("passport.howToVerify")}
            </h2>
            <p className="mt-2 font-ui text-xs leading-relaxed text-muted">{t("passport.howToVerifyBody")}</p>
            <p className="mt-3 font-ui text-2xs text-faint">{t("passport.checkedAt", { time: formatDateTime(passport.checkedAt) })}</p>
          </section>
        </div>
      </div>
    </div>
  );
}

function FileCheck({ passport }: { passport: PublicPassport }) {
  const { t } = useI18n();
  const [digested, setDigested] = useState<Digested | null>(null);
  const [result, setResult] = useState<FileCheckResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [checking, setChecking] = useState(false);

  const check = async (input: Digested) => {
    setDigested(input);
    setResult(null);
    setError(null);
    setChecking(true);
    try {
      const response = await api.post<{ result: FileCheckResult }>(
        `/api/public/verify/${passport.reference}/check`,
        { sha256: input.sha256 }
      );
      setResult(response.result);
    } catch (caught) {
      setError(caught);
    } finally {
      setChecking(false);
    }
  };

  return (
    <section className="panel p-5 sm:p-6" aria-live="polite">
      <h2 className="font-display text-lg text-text">{t("passport.checkTitle")}</h2>
      <p className="mt-1.5 font-ui text-xs leading-relaxed text-muted">{t("passport.checkIntro")}</p>
      {passport.anchorMode === "manifest" && (
        <p className="mt-2 rounded-lg bg-info-soft px-3 py-2 font-ui text-2xs leading-relaxed text-text">{t("passport.checkCaptureNote")}</p>
      )}

      <div className="mt-4">
        {!digested ? (
          <DigestDrop label={t("passport.checkDrop")} onDigest={(d) => void check(d)} />
        ) : (
          <div className="space-y-3">
            <DigestLine file={digested.file} sha256={digested.sha256} label={t("passport.yourDigest")} />
            {checking && (
              <div className="flex items-center gap-2 font-ui text-xs text-muted" role="status">
                <Spinner size={14} /> {t("common.loading")}
              </div>
            )}
            {result && (
              <div
                className={`rounded-xl border p-4 ${result.matched ? "border-success-soft bg-success-soft" : "border-danger-soft bg-danger-soft"}`}
              >
                <p className={`flex items-center gap-2 font-ui text-sm font-bold ${result.matched ? "text-success" : "text-danger"}`}>
                  {result.matched ? <CheckCircle2 size={17} aria-hidden /> : <XCircle size={17} aria-hidden />}
                  {result.matched ? t("passport.matched") : t("passport.notMatched")}
                </p>
                <p className="mt-1.5 font-ui text-xs leading-relaxed text-text">
                  {result.matched ? t("passport.matchedBody") : t("passport.notMatchedBody")}
                </p>
              </div>
            )}
            {error !== null && (
              <p role="alert" className="rounded-xl border border-warning-soft bg-warning-soft p-3 font-ui text-xs text-text">
                {t(errorKey(error))}
              </p>
            )}
            <Button variant="secondary" size="sm" icon={<RotateCcw size={12} />} onClick={() => { setDigested(null); setResult(null); setError(null); }}>
              {t("passport.checkAnother")}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="font-ui text-2xs font-semibold uppercase tracking-wider text-faint">{label}</dt>
      <dd className="mt-1 font-ui text-sm text-text">{children}</dd>
    </div>
  );
}
