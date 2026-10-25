import { Link } from "react-router-dom";
import { ArrowRight, BellRing, Car, CheckCheck, Eye, ExternalLink, Link2, MapPin } from "lucide-react";
import { api } from "../lib/api";
import { useMutation, useQuery } from "../lib/useApi";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { useI18n } from "../i18n";
import { formatDateTime, relativeTime } from "../lib/format";
import { formatPlate } from "../lib/anpr";
import { AsyncView, EmptyState } from "../components/DataState";
import { Button, Card, PageHeader, Stat } from "../components/ui";
import { Chip, ScoreBar, SecureImage, labelOf } from "../components/smart";
import { ActivityView } from "./thirdEye";

/** Inter-station alerts and the smart-policing analytics overview. */

interface StationAlert {
  id: string;
  kind: "vehicle_match" | "vehicle_recovered" | "third_eye_link";
  subject_type: string;
  subject_id: string;
  title: string;
  payload: Record<string, any>;
  status: "unread" | "read" | "actioned";
  created_at: string;
  target_station: string;
}

function AlertBody({ alert }: { alert: StationAlert }) {
  const p = alert.payload;
  if (alert.kind === "vehicle_match") {
    return (
      <div className="mt-3 grid gap-3 sm:grid-cols-[auto_1fr]">
        {p.photoIds?.[0] && <SecureImage id={p.photoIds[0]} alt={`Found vehicle ${p.registration ?? ""}`} className="h-28 w-36 rounded-lg" />}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-ui text-xs">
          <dt className="text-muted">Registration</dt><dd className="font-mono text-text">{formatPlate(p.registration)}</dd>
          <dt className="text-muted">Your complaint</dt><dd className="text-text">{p.originalComplaintRef ?? "—"}</dd>
          <dt className="text-muted">Reported by</dt><dd className="text-text">{p.reportingOfficer ?? "—"}, {p.reportingStation}</dd>
          <dt className="text-muted">When</dt><dd className="text-text">{formatDateTime(p.foundAt)}</dd>
          <dt className="text-muted">Where</dt>
          <dd className="text-text">
            {p.location ?? "—"}{" "}
            {p.mapsLink && <a href={p.mapsLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-semibold text-primary">Google Maps <ExternalLink size={10} aria-hidden /></a>}
          </dd>
          <dt className="text-muted">Match</dt><dd className="flex items-center gap-2 text-text">{labelOf(p.matchType)} <ScoreBar score={Number(p.score ?? 0)} /></dd>
        </dl>
      </div>
    );
  }
  if (alert.kind === "vehicle_recovered") {
    return <p className="mt-2 font-ui text-xs text-text">{formatPlate(p.registration)} ({p.complaintRef ?? "no reference"}) was returned by {p.returnedBy}. {p.note}</p>;
  }
  return (
    <div className="mt-2 font-ui text-xs text-text">
      <p>Your FIR <strong>{p.yourFir}</strong> may be linked to FIR <strong>{p.otherFir}</strong> at {p.otherStation}, confirmed by an officer at {p.confirmedBy}.</p>
      <p className="mt-1 text-muted">Their note: {p.reviewNote}</p>
      <ul className="mt-1 space-y-0.5">{(p.reasons ?? []).map((r: string) => <li key={r} className="text-2xs text-muted">• {r}</li>)}</ul>
    </div>
  );
}

function alertLink(a: StationAlert): string {
  if (a.kind === "vehicle_match") return `/police/vehicles/${a.payload.soughtReportId}`;
  if (a.kind === "vehicle_recovered") return `/police/vehicles/${a.payload.reportId}`;
  return "/police/third-eye?tab=leads";
}

export function StationAlertsPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const toast = useToast();
  const alerts = useQuery<{ alerts: StationAlert[] }>("/api/smart/alerts", [], { pollMs: 60_000 });
  const mark = useMutation(async ({ id, status }: { id: string; status: "read" | "actioned" }) => api.patch(`/api/smart/alerts/${id}`, { status }));
  return (
    <>
      <PageHeader eyebrow={t("nav.stationAlerts")} title={t("sa.title")} description={t("sa.intro", { station: user?.stationOrCourt ?? "—" })} />
      <AsyncView state={alerts} onRetry={alerts.refetch} context="station alerts" isEmpty={(d) => d.alerts.length === 0} empty={<EmptyState title="No alerts for your station" description="When another station reports a vehicle you hold a complaint for, or confirms a link to one of your FIRs, it appears here." icon={<BellRing size={19} />} />}>
        {(d) => (
          <ul className="space-y-3">
            {d.alerts.map((a) => (
              <li key={a.id} className={`panel p-4 ${a.status === "unread" ? "border-primary-ring" : ""}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Chip tone={a.kind === "third_eye_link" ? "info" : a.kind === "vehicle_recovered" ? "success" : "primary"}>{a.kind === "third_eye_link" ? "Third Eye" : "Vehicle Trace"}</Chip>
                      <Chip tone={a.status === "unread" ? "warning" : "neutral"}>{labelOf(a.status)}</Chip>
                    </div>
                    <p className="mt-1.5 font-display text-base text-text">{a.title}</p>
                    <p className="font-ui text-2xs text-faint">{relativeTime(a.created_at)}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Link to={alertLink(a)} onClick={() => a.status === "unread" && user?.role === "police" && void mark.run({ id: a.id, status: "read" })} className="inline-flex h-8 items-center gap-1 rounded-full border border-border bg-surface-2 px-3 font-ui text-xs font-semibold uppercase tracking-wide text-text hover:border-primary-ring">
                      Open <ArrowRight size={12} aria-hidden />
                    </Link>
                    {a.status !== "actioned" && user?.role === "police" && (
                      <Button size="sm" variant="ghost" icon={<CheckCheck size={12} />} onClick={async () => { if (await mark.run({ id: a.id, status: "actioned" })) { toast.success("Marked as actioned"); alerts.refetch(); } }}>Actioned</Button>
                    )}
                  </div>
                </div>
                <AlertBody alert={a} />
              </li>
            ))}
          </ul>
        )}
      </AsyncView>
    </>
  );
}

/* ============================================================ analytics */

interface Overview {
  vehicles: {
    total: number;
    byType: Record<string, number>;
    byStatus: Record<string, number>;
    byStation: Record<string, number>;
    anprShare: number;
    matches: { total: number; byStatus: Record<string, number>; byType: Record<string, number> };
    recoveryRate: number;
  };
  thirdEye: {
    persons: number;
    byClassification: Record<string, number>;
    caseLinks: number;
    byCategory: Record<string, number>;
    stations: number;
    leads: { total: number; byStatus: Record<string, number>; byKind: Record<string, number> };
  };
  capabilities: { serverAnpr: boolean; faceRecognition: boolean };
}

/** Horizontal bars, one hue, largest first: a count per category reads best this way. */
function Bars({ data, empty = "No data yet", raw = false }: { data: Record<string, number>; empty?: string; raw?: boolean }) {
  const rows = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...rows.map(([, v]) => v));
  if (rows.length === 0) return <p className="font-ui text-xs text-muted">{empty}</p>;
  return (
    <ul className="space-y-2">
      {rows.map(([k, v]) => (
        <li key={k} className="grid grid-cols-[minmax(7rem,40%)_1fr_auto] items-center gap-3">
          <span className="truncate font-ui text-xs text-text" title={raw ? k : labelOf(k)}>{raw ? k : labelOf(k)}</span>
          <span className="h-2.5 overflow-hidden rounded-full bg-surface-3" aria-hidden>
            <span className="block h-full rounded-full bg-primary" style={{ width: `${(v / max) * 100}%` }} />
          </span>
          <span className="font-ui text-xs tabular text-muted">{v}</span>
        </li>
      ))}
    </ul>
  );
}

export function SmartAnalyticsPage() {
  const { t } = useI18n();
  const overview = useQuery<Overview>("/api/smart/overview");
  return (
    <>
      <PageHeader eyebrow={t("nav.analytics")} title={t("an.title")} description={t("an.intro")} />
      <AsyncView state={overview} onRetry={overview.refetch} context="analytics">
        {(o) => (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Vehicle reports" value={o.vehicles.total} icon={<Car size={15} />} />
              <Stat label="Recovery rate" value={`${Math.round(o.vehicles.recoveryRate * 100)}%`} tone="success" hint="Sought vehicles in recovery, returned or closed" />
              <Stat label="Plates read by ANPR" value={`${Math.round(o.vehicles.anprShare * 100)}%`} tone="info" hint={o.capabilities.serverAnpr ? "Server recognition service configured" : "Read on officers' devices"} />
              <Stat label="Matches verified" value={o.vehicles.matches.byStatus.verified ?? 0} hint={`${o.vehicles.matches.byStatus.pending ?? 0} pending · ${o.vehicles.matches.byStatus.rejected ?? 0} rejected`} />
            </div>
            <div className="grid gap-5 lg:grid-cols-2">
              <Card title="Vehicle reports by status"><Bars data={o.vehicles.byStatus} /></Card>
              <Card title="Vehicle reports by station"><Bars data={o.vehicles.byStation} raw /></Card>
              <Card title="Vehicle reports by type"><Bars data={o.vehicles.byType} /></Card>
              <Card title="How matches were found"><Bars data={o.vehicles.matches.byType} /></Card>
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Third Eye records" value={o.thirdEye.persons} icon={<Eye size={15} />} />
              <Stat label="Linked FIRs" value={o.thirdEye.caseLinks} icon={<Link2 size={15} />} />
              <Stat label="Stations" value={o.thirdEye.stations} icon={<MapPin size={15} />} />
              <Stat label="Leads confirmed" value={o.thirdEye.leads.byStatus.confirmed ?? 0} hint={`${o.thirdEye.leads.byStatus.pending ?? 0} pending · ${o.thirdEye.leads.byStatus.rejected ?? 0} rejected`} />
            </div>
            <div className="grid gap-5 lg:grid-cols-2">
              <Card title="Linked FIRs by offence"><Bars data={o.thirdEye.byCategory} /></Card>
              <Card title="Records by standing" subtitle="Person of interest, suspect, accused and convicted are counted apart and never merged."><Bars data={o.thirdEye.byClassification} /></Card>
            </div>
            <ActivityView />
          </div>
        )}
      </AsyncView>
    </>
  );
}
