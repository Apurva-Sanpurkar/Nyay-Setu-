import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Crosshair,
  FileUp,
  Fingerprint,
  KeyRound,
  Loader2,
  MapPin,
  RefreshCw,
  ShieldAlert,
  X,
} from "lucide-react";
import { explainCryptoAvailability, sha256File, shortHash } from "../lib/hash";
import { accuracyVerdict, distanceMetres, getFix, type Fix } from "../lib/geo";
import { formatBytes, formatMetres, osmLink } from "../lib/format";
import { Button, CopyButton, Field, Input } from "./ui";
import type { OtpDispatch } from "../lib/api";

/* ================================================== FileHashPicker ======= */

export interface HashedFile {
  file: File;
  hash: string;
  /** The file's own last-modified time. The anomaly model compares it to the
   *  claimed collection time, which is how "edited after the fact" is caught. */
  lastModified: string;
}

/**
 * Picks a file and hashes it in the browser before anything is uploaded.
 *
 * The digest is shown before the upload button becomes available, on purpose:
 * the officer sees the number that is about to be committed to a public chain,
 * rather than being told afterwards what was recorded on their behalf.
 */
export function FileHashPicker({
  value,
  onChange,
  accept = "image/*,video/*,audio/*,application/pdf",
  disabled,
}: {
  value: HashedFile | null;
  onChange: (value: HashedFile | null) => void;
  accept?: string;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [hashing, setHashing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const cryptoIssue = explainCryptoAvailability();

  const handle = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setError(null);
      setHashing(true);
      setProgress(0);
      try {
        const hash = await sha256File(file, setProgress);
        onChange({
          file,
          hash,
          lastModified: new Date(file.lastModified).toISOString(),
        });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not hash that file.");
        onChange(null);
      } finally {
        setHashing(false);
      }
    },
    [onChange]
  );

  if (cryptoIssue) {
    return (
      <div role="alert" className="rounded-card border border-danger-soft bg-danger-soft p-4">
        <div className="flex gap-2.5">
          <ShieldAlert size={17} className="mt-0.5 shrink-0 text-danger" />
          <p className="font-ui text-xs leading-relaxed text-text">{cryptoIssue}</p>
        </div>
      </div>
    );
  }

  if (value) {
    return (
      <div className="rounded-card border border-primary bg-primary-soft p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 gap-3">
            <Fingerprint size={18} className="mt-0.5 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="truncate font-ui text-sm font-semibold text-text">{value.file.name}</p>
              <p className="mt-0.5 font-ui text-2xs text-muted">
                {formatBytes(value.file.size)} · {value.file.type || "unknown type"}
              </p>
            </div>
          </div>
          {!disabled && (
            <button
              type="button"
              onClick={() => onChange(null)}
              aria-label="Remove file"
              className="shrink-0 rounded-md p-1 text-faint transition hover:bg-surface-2 hover:text-text"
            >
              <X size={15} />
            </button>
          )}
        </div>

        <div className="mt-3 rounded-lg border border-border bg-surface px-3 py-2">
          <p className="mb-1 flex items-center gap-1.5 font-ui text-2xs font-semibold uppercase tracking-wider text-primary">
            <CheckCircle2 size={11} /> SHA-256, computed on this device
          </p>
          <div className="flex items-center gap-2">
            <code className="hash flex-1 text-text">{value.hash}</code>
            <CopyButton value={value.hash} />
          </div>
        </div>

        <p className="mt-2.5 font-ui text-2xs leading-relaxed text-muted">
          This digest is what goes on chain. The server will recompute it over the bytes it receives
          and refuse the upload if the two differ.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-label="Choose an evidence file"
        onClick={() => !disabled && !hashing && inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!disabled && !hashing) void handle(event.dataTransfer.files?.[0]);
        }}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-card border-2 border-dashed
          px-5 py-9 text-center transition ${
            dragging ? "border-primary bg-primary-soft" : "border-border bg-surface-2 hover:border-border-strong"
          } ${disabled || hashing ? "pointer-events-none opacity-60" : ""}`}
      >
        {hashing ? (
          <>
            <Loader2 size={22} className="mb-3 animate-spin-slow text-primary" />
            <p className="font-ui text-sm font-semibold text-text">Hashing on this device…</p>
            <div className="mt-3 h-1.5 w-48 overflow-hidden rounded-full bg-border">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-200"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <p className="mt-2 font-ui text-2xs text-muted">{Math.round(progress * 100)}%</p>
          </>
        ) : (
          <>
            <FileUp size={22} className="mb-3 text-faint" />
            <p className="font-ui text-sm font-semibold text-text">Choose or drop the evidence file</p>
            <p className="mt-1.5 max-w-xs font-ui text-2xs leading-relaxed text-muted">
              It is hashed here, in your browser, before any of it is sent. Up to 50 MB.
            </p>
          </>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(event) => void handle(event.target.files?.[0])}
      />

      {error && (
        <p role="alert" className="mt-2 font-ui text-2xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/* ====================================================== GpsCapture ======= */

/**
 * Takes a single high-accuracy position fix.
 *
 * When a fence is supplied it shows the live distance to its centre and whether
 * the fix is precise enough to be meaningful against it, so an accused is not
 * surprised by a geo-violation caused by a bad GPS reading.
 */
export function GpsCapture({
  value,
  onChange,
  fence,
  autoRequest = false,
}: {
  value: Fix | null;
  onChange: (fix: Fix | null) => void;
  fence?: { lat: number; lng: number; radiusMetres: number } | null;
  autoRequest?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const request = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      onChange(await getFix());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not read your location.");
      onChange(null);
    } finally {
      setPending(false);
    }
  }, [onChange]);

  useEffect(() => {
    if (autoRequest && !value && !pending) void request();
    // Runs once on mount when asked to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRequest]);

  const verdict = value ? accuracyVerdict(value.accuracyMetres, fence?.radiusMetres ?? null) : null;
  const distance =
    value && fence ? distanceMetres(fence.lat, fence.lng, value.lat, value.lng) : null;
  const inside = distance !== null && fence ? distance <= fence.radiusMetres : null;

  return (
    <div className="rounded-card border border-border bg-surface-2 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex gap-3">
          <MapPin size={18} className={`mt-0.5 shrink-0 ${value ? "text-primary" : "text-faint"}`} />
          <div>
            <p className="font-ui text-sm font-semibold text-text">Position</p>
            <p className="mt-0.5 font-ui text-2xs text-muted">
              {value
                ? `${value.lat.toFixed(5)}, ${value.lng.toFixed(5)}`
                : "Not captured yet"}
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant={value ? "secondary" : "primary"}
          size="sm"
          loading={pending}
          icon={value ? <RefreshCw size={12} /> : <Crosshair size={12} />}
          onClick={() => void request()}
        >
          {value ? "Refresh" : "Capture"}
        </Button>
      </div>

      {value && (
        <div className="mt-3 space-y-2">
          <p
            className={`font-ui text-2xs leading-relaxed ${verdict?.ok ? "text-muted" : "text-warning"}`}
          >
            {verdict?.note}
          </p>

          {fence && distance !== null && (
            <div
              className={`rounded-lg border p-2.5 ${
                inside ? "border-success-soft bg-success-soft" : "border-danger-soft bg-danger-soft"
              }`}
            >
              <p className="font-ui text-2xs leading-relaxed text-text">
                <strong>{formatMetres(distance)}</strong> from the permitted centre, against a{" "}
                {formatMetres(fence.radiusMetres)} fence.{" "}
                {inside
                  ? "Inside the permitted area."
                  : "Outside the permitted area: checking in from here will record a geo-fence breach on chain."}
              </p>
            </div>
          )}

          <a
            href={osmLink(value.lat, value.lng)}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-block font-ui text-2xs font-semibold text-primary hover:underline"
          >
            View on a map
          </a>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2.5 font-ui text-2xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/* ======================================================== OtpPanel ======= */

/**
 * The two-step Aadhaar OTP exchange.
 *
 * In the sandbox the code comes back in the response, and it is shown with an
 * explicit "simulated" notice. That notice is not decoration: anyone looking at
 * this screen must be able to tell that no real UIDAI authentication happened.
 */
export function OtpPanel({
  dispatch,
  onRequest,
  onVerify,
  requesting,
  verifying,
  disabled,
  purposeLabel,
}: {
  dispatch: OtpDispatch | null;
  onRequest: () => void;
  onVerify: (otp: string) => void;
  requesting?: boolean;
  verifying?: boolean;
  disabled?: boolean;
  purposeLabel: string;
}) {
  const [otp, setOtp] = useState("");

  return (
    <div className="rounded-card border border-border bg-surface-2 p-4">
      <div className="flex gap-3">
        <KeyRound size={18} className="mt-0.5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="font-ui text-sm font-semibold text-text">Aadhaar OTP</p>
          <p className="mt-0.5 font-ui text-2xs leading-relaxed text-muted">
            {purposeLabel} is authenticated with a one-time code before it is written on chain.
          </p>
        </div>
      </div>

      {!dispatch ? (
        <Button
          type="button"
          className="mt-3.5"
          loading={requesting}
          disabled={disabled}
          onClick={onRequest}
          full
        >
          Send me a code
        </Button>
      ) : (
        <div className="mt-3.5 space-y-3">
          <p className="font-ui text-2xs text-muted">
            Sent to {dispatch.maskedDestination}. Valid until{" "}
            {new Date(dispatch.expiresAt).toLocaleTimeString("en-IN", {
              hour: "2-digit",
              minute: "2-digit",
            })}
            .
          </p>

          {dispatch.otp && (
            <div className="rounded-lg border border-warning-soft bg-warning-soft px-3 py-2.5">
              <p className="font-ui text-2xs font-semibold uppercase tracking-wider text-warning">
                Sandbox provider · simulated
              </p>
              <p className="mt-1 font-mono text-xl font-bold tracking-[0.3em] text-text">{dispatch.otp}</p>
              <p className="mt-1.5 font-ui text-2xs leading-relaxed text-muted">
                A real deployment sends this by SMS through a licensed AUA. It is shown here because
                this deployment does not hold UIDAI authorisation.
              </p>
            </div>
          )}

          <Field label="Six digit code">
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              value={otp}
              onChange={(event) => setOtp(event.target.value.replace(/[^0-9]/g, ""))}
              className="text-center font-mono text-lg tracking-[0.4em]"
            />
          </Field>

          <div className="flex gap-2">
            <Button
              type="button"
              full
              loading={verifying}
              disabled={otp.length !== 6 || disabled}
              onClick={() => onVerify(otp)}
            >
              Verify and record
            </Button>
            <Button type="button" variant="ghost" size="md" loading={requesting} onClick={onRequest}>
              Resend
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
