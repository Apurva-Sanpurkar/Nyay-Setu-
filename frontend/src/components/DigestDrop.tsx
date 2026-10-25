import { useCallback, useRef, useState } from "react";
import { FileUp, Fingerprint, Loader2 } from "lucide-react";
import { sha256File } from "../lib/hash";
import { formatBytes } from "../lib/format";
import { useI18n } from "../i18n";

export interface Digested {
  file: File;
  sha256: string;
}

/**
 * A drop zone that only ever computes a fingerprint. The file is read here, in
 * the browser, and nothing is uploaded — which is the promise the verify page
 * makes, so this component cannot be wired to an upload by accident.
 */
export function DigestDrop({
  onDigest,
  disabled,
  label,
  hint,
}: {
  onDigest: (result: Digested) => void;
  disabled?: boolean;
  label: string;
  hint?: string;
}) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [hashing, setHashing] = useState<{ name: string; progress: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const handle = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setError(null);
      setHashing({ name: file.name, progress: 0 });
      try {
        const sha256 = await sha256File(file, (progress) => setHashing({ name: file.name, progress }));
        onDigest({ file, sha256 });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : t("common.error"));
      } finally {
        setHashing(null);
        if (input.current) input.current.value = "";
      }
    },
    [onDigest, t]
  );

  return (
    <div>
      <button
        type="button"
        disabled={disabled || hashing !== null}
        onClick={() => input.current?.click()}
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
        className={`flex w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed px-5 py-10 text-center transition ${
          dragging ? "border-primary bg-primary-soft" : "border-border-strong bg-surface hover:border-primary hover:bg-primary-soft"
        } disabled:cursor-not-allowed disabled:opacity-60`}
      >
        {hashing ? (
          <>
            <Loader2 size={24} className="mb-3 animate-spin-slow text-primary" aria-hidden />
            <p className="font-ui text-sm font-semibold text-text">{t("passport.hashing")}</p>
            <p className="mt-1 max-w-xs truncate font-ui text-2xs text-muted">{hashing.name}</p>
            <div className="mt-3 h-1.5 w-56 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={Math.round(hashing.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${Math.round(hashing.progress * 100)}%` }} />
            </div>
          </>
        ) : (
          <>
            <span className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-primary-soft text-primary">
              <FileUp size={22} aria-hidden />
            </span>
            <p className="font-ui text-sm font-semibold text-text">{label}</p>
            {hint && <p className="mt-1.5 max-w-sm font-ui text-xs leading-relaxed text-muted">{hint}</p>}
          </>
        )}
      </button>
      <input ref={input} type="file" className="hidden" onChange={(event) => void handle(event.target.files?.[0])} />
      {error && (
        <p role="alert" className="mt-2 font-ui text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function DigestLine({ file, sha256, label }: { file?: File; sha256: string; label: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface-2 px-3.5 py-3">
      <p className="mb-1 flex items-center gap-1.5 font-ui text-2xs font-semibold uppercase tracking-wider text-faint">
        <Fingerprint size={11} aria-hidden /> {label}
      </p>
      <code className="hash block text-text">{sha256}</code>
      {file && (
        <p className="mt-1 truncate font-ui text-2xs text-muted">
          {file.name} · {formatBytes(file.size)}
        </p>
      )}
    </div>
  );
}
