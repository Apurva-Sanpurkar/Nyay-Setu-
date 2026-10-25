/**
 * Browser geolocation, wrapped so every caller gets the same error messages and
 * the same accuracy expectations.
 *
 * Accuracy matters here in a way it usually does not. A bail check-in is
 * compared against a geo-fence on chain, so a 500 m fix against a 2 km fence is
 * fine but a 5 km fix is not evidence of anything. The reading carries its
 * accuracy so the UI can warn before a weak fix becomes a violation.
 */

export interface Fix {
  lat: number;
  lng: number;
  accuracyMetres: number;
  takenAt: string;
}

export interface GeoFailure {
  code: "unsupported" | "denied" | "unavailable" | "timeout" | "insecure";
  message: string;
}

export class GeoError extends Error {
  readonly code: GeoFailure["code"];
  constructor(failure: GeoFailure) {
    super(failure.message);
    this.name = "GeoError";
    this.code = failure.code;
  }
}

export function isGeoAvailable(): boolean {
  return typeof navigator !== "undefined" && "geolocation" in navigator;
}

/**
 * Asks for one high-accuracy fix.
 *
 * maximumAge is 0 on purpose: a cached fix from an hour ago would let someone
 * check in from anywhere, which is precisely the thing the geo-fence exists to
 * prevent.
 */
export function getFix(timeoutMs = 15000): Promise<Fix> {
  return new Promise((resolve, reject) => {
    if (!isGeoAvailable()) {
      reject(
        new GeoError({
          code: "unsupported",
          message: "This browser does not provide location. Use the mobile app for field capture.",
        })
      );
      return;
    }

    if (!window.isSecureContext) {
      reject(
        new GeoError({
          code: "insecure",
          message:
            "Location needs a secure context. Open NyaySetu over HTTPS, or on localhost during development.",
        })
      );
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracyMetres: position.coords.accuracy,
          takenAt: new Date(position.timestamp).toISOString(),
        }),
      (error) => {
        const map: Record<number, GeoFailure> = {
          1: {
            code: "denied",
            message:
              "Location permission was refused. A check-in cannot be recorded without coordinates, " +
              "because the court verifies where it came from.",
          },
          2: {
            code: "unavailable",
            message: "No position fix available. Move somewhere with a clearer view of the sky and retry.",
          },
          3: {
            code: "timeout",
            message: "The device took too long to find a position. Retry in a moment.",
          },
        };
        reject(new GeoError(map[error.code] ?? { code: "unavailable", message: error.message }));
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }
    );
  });
}

/** Rough advice on whether a fix is good enough for a given fence. */
export function accuracyVerdict(
  accuracyMetres: number,
  radiusMetres: number | null
): { ok: boolean; note: string } {
  if (accuracyMetres <= 50) {
    return { ok: true, note: `Fix accurate to about ${Math.round(accuracyMetres)} m.` };
  }
  if (!radiusMetres || accuracyMetres < radiusMetres / 4) {
    return { ok: true, note: `Fix accurate to about ${Math.round(accuracyMetres)} m.` };
  }
  return {
    ok: false,
    note:
      `This fix is only accurate to about ${Math.round(accuracyMetres)} m, which is wide relative to a ` +
      `${radiusMetres} m fence. Wait for a better fix before checking in.`,
  };
}

/**
 * Equirectangular distance in metres, the same approximation GeoMath.sol uses,
 * so the number shown before a check-in matches the one the contract computes.
 */
export function distanceMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const metresPerDegree = 111_320;
  const dLat = (lat2 - lat1) * metresPerDegree;
  const dLng = (lng2 - lng1) * metresPerDegree * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

/** A stable per-device identifier for a summons acknowledgement. */
export function deviceHint(): { deviceId: string; platform: string } {
  const KEY = "nyaysetu.device";
  let deviceId = "";
  try {
    deviceId = localStorage.getItem(KEY) ?? "";
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      localStorage.setItem(KEY, deviceId);
    }
  } catch {
    // Private browsing, or storage blocked. A per-session id still fingerprints
    // the device for this acknowledgement, which is all the contract needs.
    deviceId = `ephemeral-${Math.random().toString(36).slice(2)}`;
  }
  return { deviceId, platform: navigator.platform || "web" };
}
