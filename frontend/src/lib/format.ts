import type { Role, Stage } from "./api";

export const ROLE_LABEL: Record<Role, string> = {
  police: "Police Officer",
  forensic_lab: "Forensic Laboratory",
  prosecutor: "Public Prosecutor",
  judge: "Judge",
  defence_lawyer: "Defence Counsel",
  accused: "Accused",
  court_admin: "Court Administrator",
};

export const ROLE_HOME: Record<Role, string> = {
  police: "/police",
  forensic_lab: "/forensic",
  prosecutor: "/prosecutor",
  judge: "/judge",
  defence_lawyer: "/defence",
  accused: "/accused",
  court_admin: "/admin",
};

export const STAGE_LABEL: Record<Stage, string> = {
  SCENE: "Scene",
  FORENSIC_LAB: "Forensic Lab",
  PROSECUTOR: "Prosecutor",
  COURT: "Court",
};

export const STAGE_ORDER: Stage[] = ["SCENE", "FORENSIC_LAB", "PROSECUTOR", "COURT"];

/** Which role receives custody at each stage. Mirrors EvidenceChain.stageRole. */
export const STAGE_RECEIVER: Record<Stage, Role> = {
  SCENE: "police",
  FORENSIC_LAB: "forensic_lab",
  PROSECUTOR: "prosecutor",
  COURT: "judge",
};

export const CASE_STATUS_LABEL: Record<string, string> = {
  registered: "Registered",
  under_investigation: "Under investigation",
  charge_sheeted: "Charge-sheeted",
  trial: "In trial",
  disposed: "Disposed",
};

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

/** "4 h ago", "in 3 d". Relative time reads faster than a timestamp in a feed. */
export function relativeTime(value: string | null | undefined): string {
  if (!value) return "—";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "—";

  const deltaSeconds = Math.round((then - Date.now()) / 1000);
  const future = deltaSeconds > 0;
  const seconds = Math.abs(deltaSeconds);

  const units: [number, string][] = [
    [60, "s"],
    [3600, "min"],
    [86400, "h"],
    [2592000, "d"],
    [31536000, "mo"],
  ];

  let text = `${Math.round(seconds / 31536000)} y`;
  if (seconds < 60) text = `${seconds} s`;
  else {
    for (let i = 0; i < units.length - 1; i++) {
      if (seconds < units[i + 1][0]) {
        text = `${Math.round(seconds / units[i][0])} ${units[i + 1][1]}`;
        break;
      }
    }
  }
  return future ? `in ${text}` : `${text} ago`;
}

/** Countdown for the 72 hour summons window and the check-in interval. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "elapsed";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  return `${minutes} min`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[index]}`;
}

export function formatMetres(metres: number | null | undefined): string {
  if (metres === null || metres === undefined) return "—";
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(2)} km`;
}

export function formatCoords(lat: number | null | undefined, lng: number | null | undefined): string {
  if (lat === null || lat === undefined || lng === null || lng === undefined) return "—";
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

/** Wei to a short ETH string, for the keeper balance on the admin dashboard. */
export function formatEth(wei: string | null | undefined): string {
  if (!wei) return "—";
  try {
    const value = BigInt(wei);
    const whole = value / 10n ** 18n;
    const fraction = (value % 10n ** 18n).toString().padStart(18, "0").slice(0, 4);
    return `${whole}.${fraction} ETH`;
  } catch {
    return "—";
  }
}

export function osmLink(lat: number, lng: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;
}

/** Turns a violation reason tag into something a person would read. */
export function violationLabel(reason: string): string {
  const known: Record<string, string> = {
    GEO_FENCE_BREACH: "Left the permitted area",
    MISSED_CHECK_IN: "Missed a check-in",
    NO_CONTACT_BREACH: "Contacted a protected person",
  };
  return known[reason] ?? reason.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
}
