import { Crosshair, MapPin, MapPinOff, RefreshCw, TriangleAlert } from "lucide-react";
import type { GpsFixInput } from "@nyaysetu/integrity";
import { useI18n } from "../i18n";
import { Button, Spinner } from "./ui";

/**
 * A position fix taken at the moment of capture, never before and never typed
 * in (2.0 · F10). Shown with its accuracy radius, and tagged rather than hidden
 * when it is missing or too wide.
 */

export interface FixState {
  status: "idle" | "locating" | "ok" | "low" | "none";
  fix: GpsFixInput | null;
  reason: "DENIED" | "UNAVAILABLE" | "TIMEOUT" | "UNSUPPORTED" | null;
}

export const NO_FIX: FixState = { status: "idle", fix: null, reason: null };

/** Asks for one fresh, high-accuracy fix. maximumAge 0: a cached position is never accepted. */
export function requestFix(maxAccuracyMetres: number, timeoutMs = 15_000): Promise<FixState> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator) || !window.isSecureContext) {
      resolve({ status: "none", fix: null, reason: "UNSUPPORTED" });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const fix: GpsFixInput = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracyMetres: position.coords.accuracy,
          altitudeMetres: position.coords.altitude,
          takenAtMs: Math.round(position.timestamp),
          // Browsers do not expose a mock-location flag. Recorded as unknown, not false.
          mocked: null,
        };
        resolve({ status: fix.accuracyMetres > maxAccuracyMetres ? "low" : "ok", fix, reason: null });
      },
      (error) =>
        resolve({
          status: "none",
          fix: null,
          reason: error.code === 1 ? "DENIED" : error.code === 3 ? "TIMEOUT" : "UNAVAILABLE",
        }),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }
    );
  });
}

export function CaptureGps({
  label,
  state,
  maxAccuracyMetres,
  onRetry,
}: {
  label: string;
  state: FixState;
  maxAccuracyMetres: number;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  const { status, fix, reason } = state;

  const tone =
    status === "ok"
      ? "border-success-soft bg-success-soft"
      : status === "low"
        ? "border-warning-soft bg-warning-soft"
        : status === "none"
          ? "border-danger-soft bg-danger-soft"
          : "border-border bg-surface-2";

  return (
    <div className={`rounded-xl border p-3.5 ${tone}`} aria-live="polite">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-2.5">
          {status === "locating" ? (
            <Spinner size={16} className="mt-0.5" />
          ) : status === "none" ? (
            <MapPinOff size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden />
          ) : status === "low" ? (
            <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
          ) : (
            <MapPin size={16} className={`mt-0.5 shrink-0 ${status === "ok" ? "text-success" : "text-faint"}`} aria-hidden />
          )}
          <div className="min-w-0">
            <p className="font-ui text-xs font-semibold text-text">{label}</p>
            <p className="mt-0.5 font-ui text-2xs leading-relaxed text-muted">
              {status === "idle" && "—"}
              {status === "locating" && t("capture.locating")}
              {(status === "ok" || status === "low") && fix && (
                <>
                  <span className="font-semibold text-text">{status === "ok" ? t("capture.gpsOk") : t("capture.gpsLow", { n: maxAccuracyMetres })}</span>
                  {" · "}
                  {t("capture.accuracy", { n: Math.round(fix.accuracyMetres) })}
                  {" · "}
                  <span className="font-mono">
                    {fix.lat.toFixed(5)}, {fix.lng.toFixed(5)}
                  </span>
                </>
              )}
              {status === "none" && (
                <span className="font-semibold text-danger">
                  {t("capture.gpsNone")} — {reason === "DENIED" ? t("capture.gpsDenied") : t("capture.gpsUnavailable")}
                </span>
              )}
            </p>
          </div>
        </div>
        {onRetry && status !== "locating" && status !== "ok" && (
          <Button size="sm" variant="secondary" icon={status === "idle" ? <Crosshair size={12} /> : <RefreshCw size={12} />} onClick={onRetry}>
            {t("capture.gpsRetry")}
          </Button>
        )}
      </div>
    </div>
  );
}
