import { Link } from "react-router-dom";
import { ArrowRight, BellRing, Car, Eye } from "lucide-react";
import { useQuery } from "../lib/useApi";

/**
 * The Vehicle Trace, Third Eye and station-alert tiles on the police dashboard.
 * Deliberately light: it imports neither the map nor the module pages, so the
 * dashboard does not download them.
 */

interface Overview {
  vehicles: { total: number; matches: { byStatus: Record<string, number> } };
  thirdEye: { persons: number; leads: { byStatus: Record<string, number> } };
}

/** A compact count for the dashboard. */
export function SmartPolicingPanel() {
  const alerts = useQuery<{ alerts: unknown[] }>("/api/smart/alerts?status=unread", [], { pollMs: 60_000 });
  const overview = useQuery<Overview>("/api/smart/overview");
  const unread = alerts.data?.alerts.length ?? 0;
  const tiles = [
    { to: "/police/vehicles", icon: Car, title: "Vehicle Trace", body: overview.data ? `${overview.data.vehicles.matches.byStatus.pending ?? 0} match(es) to verify · ${overview.data.vehicles.total} reports` : "Lost, stolen and found vehicles", tone: "bg-primary-soft text-primary" },
    { to: "/police/third-eye", icon: Eye, title: "Third Eye", body: overview.data ? `${overview.data.thirdEye.leads.byStatus.pending ?? 0} lead(s) to review · ${overview.data.thirdEye.persons} records` : "Criminal intelligence and case links", tone: "bg-accent-soft text-accent" },
    { to: "/police/station-alerts", icon: BellRing, title: "Station alerts", body: unread ? `${unread} unread from other stations` : "Nothing unread", tone: unread ? "bg-warning-soft text-warning" : "bg-info-soft text-info" },
  ];
  return (
    <div className="mb-6 grid gap-4 sm:grid-cols-3">
      {tiles.map(({ to, icon: Icon, title, body, tone }) => (
        <Link key={to} to={to} className="panel group flex items-center gap-4 p-5 transition hover:-translate-y-0.5 hover:border-primary-ring hover:shadow-lift">
          <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl ${tone}`}><Icon size={19} aria-hidden /></span>
          <div className="min-w-0">
            <p className="font-display text-base text-text">{title}</p>
            <p className="mt-0.5 font-ui text-2xs leading-relaxed text-muted">{body}</p>
          </div>
          <ArrowRight size={15} className="ml-auto shrink-0 text-faint transition group-hover:text-primary" aria-hidden />
        </Link>
      ))}
    </div>
  );
}
