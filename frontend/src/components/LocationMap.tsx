import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

/* ========================================================= LocationMap === */

export interface MapPoint {
  id: string;
  lat: number;
  lng: number;
  label: string;
  tone: "sought" | "sighted" | "matched" | "closed";
}

const TONE_COLOUR: Record<MapPoint["tone"], string> = {
  sought: "#c2410c",
  sighted: "#2563eb",
  matched: "#16a34a",
  closed: "#6b7280",
};

/**
 * OpenStreetMap through Leaflet. Points are circle markers, so no marker image
 * assets need bundling. With `onPick`, a click (or tap) sets a location — the
 * fallback when GPS is refused or inaccurate.
 */
export function LocationMap({
  points = [],
  picked,
  onPick,
  onOpen,
  className = "h-80",
  center = [18.5204, 73.8567],
}: {
  points?: MapPoint[];
  picked?: { lat: number; lng: number } | null;
  onPick?: (lat: number, lng: number) => void;
  onOpen?: (id: string) => void;
  className?: string;
  center?: [number, number];
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const pickRef = useRef(onPick);
  const openRef = useRef(onOpen);
  pickRef.current = onPick;
  openRef.current = onOpen;

  useEffect(() => {
    if (!host.current || map.current) return;
    const m = L.map(host.current, { zoomControl: true, attributionControl: true }).setView(center, 12);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    m.on("click", (e: L.LeafletMouseEvent) => pickRef.current?.(Number(e.latlng.lat.toFixed(6)), Number(e.latlng.lng.toFixed(6))));
    map.current = m;
    // A map created inside a hidden or resizing container measures 0×0.
    const observer = new ResizeObserver(() => m.invalidateSize());
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const m = map.current;
    const group = layer.current;
    if (!m || !group) return;
    group.clearLayers();
    const bounds: L.LatLngExpression[] = [];
    for (const p of points) {
      const marker = L.circleMarker([p.lat, p.lng], { radius: 8, color: "#fff", weight: 2, fillColor: TONE_COLOUR[p.tone], fillOpacity: 0.95 });
      marker.bindTooltip(p.label);
      marker.on("click", () => openRef.current?.(p.id));
      marker.addTo(group);
      bounds.push([p.lat, p.lng]);
    }
    if (picked) {
      L.circleMarker([picked.lat, picked.lng], { radius: 10, color: "#111827", weight: 3, fillColor: "#facc15", fillOpacity: 1 }).addTo(group);
      m.setView([picked.lat, picked.lng], Math.max(m.getZoom(), 15));
    } else if (bounds.length) {
      m.fitBounds(L.latLngBounds(bounds), { padding: [30, 30], maxZoom: 15 });
    }
  }, [points, picked]);

  return (
    <div
      ref={host}
      className={`relative z-0 w-full overflow-hidden rounded-xl border border-border ${onPick ? "cursor-crosshair" : ""} ${className}`}
      role="application"
      aria-label={onPick ? "Map: click or tap to set the location" : "Map of reported vehicles"}
    />
  );
}

export const MAP_LEGEND: [MapPoint["tone"], string][] = [
  ["sought", "Missing / stolen"],
  ["sighted", "Found / abandoned"],
  ["matched", "Match verified / recovery"],
  ["closed", "Returned / closed"],
];

export function MapLegend() {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
      {MAP_LEGEND.map(([tone, label]) => (
        <li key={tone} className="flex items-center gap-1.5 font-ui text-2xs text-muted">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: TONE_COLOUR[tone] }} aria-hidden />
          {label}
        </li>
      ))}
    </ul>
  );
}
