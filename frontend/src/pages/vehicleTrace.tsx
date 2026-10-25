import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Camera,
  Car,
  CheckCircle2,
  ExternalLink,
  LocateFixed,
  Map as MapIcon,
  MessageSquarePlus,
  RefreshCw,
  ScanLine,
  Search,
  Send,
  XCircle,
} from "lucide-react";
import { api, ApiError, type Verification } from "../lib/api";
import { useMutation, useQuery } from "../lib/useApi";
import { useToast } from "../context/ToastContext";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../i18n";
import { formatDateTime, relativeTime } from "../lib/format";
import { getFix } from "../lib/geo";
import { compressImage } from "../lib/imageTools";
import { formatPlate, isValidPlate, normalisePlate, readPlate, type PlateCandidate } from "../lib/anpr";
import { AsyncView, EmptyState } from "../components/DataState";
import { Button, Card, Field, Input, Modal, PageHeader, Select, Stat, Textarea } from "../components/ui";
import { VerificationBadge } from "../components/verification";
import { Chip, IntegrityNote, ScoreBar, SecureImage, labelOf, type IntegrityVerdict, type Tone } from "../components/smart";
import { LocationMap, MapLegend, type MapPoint } from "../components/LocationMap";

/** Vehicle Trace: lost, stolen, found and abandoned vehicles across police stations. */

/* ================================================================ types */

type ReportType = "missing" | "stolen" | "found" | "abandoned" | "suspicious";
type VehicleStatus =
  | "MISSING_REPORTED"
  | "VEHICLE_FOUND"
  | "POTENTIAL_MATCH"
  | "VERIFICATION_PENDING"
  | "MATCH_VERIFIED"
  | "RECOVERY_IN_PROGRESS"
  | "OWNER_VERIFICATION_PENDING"
  | "VEHICLE_RETURNED"
  | "CASE_CLOSED";

interface VehicleReport {
  id: string;
  report_type: ReportType;
  registration_norm: string | null;
  registration_source: string;
  vehicle_type: string;
  make: string | null;
  model: string | null;
  colour: string | null;
  chassis_last5: string | null;
  condition_notes: string | null;
  complaint_ref: string | null;
  incident_at: string | null;
  latitude: number | null;
  longitude: number | null;
  location_accuracy_m: number | null;
  location_source: string;
  location_text: string | null;
  station: string;
  station_norm: string;
  status: VehicleStatus;
  reported_by: string | null;
  reported_by_name?: string | null;
  reported_at: string;
  record_digest: string;
  owner_contact: string | null;
  owner_contact_withheld: boolean;
  maps_link: string | null;
  allowed_next: VehicleStatus[];
  photo_id?: string | null;
  verification?: Verification | null;
}

interface ReportSummary {
  id: string;
  report_type: ReportType;
  registration: string | null;
  vehicle_type: string;
  make: string | null;
  model: string | null;
  colour: string | null;
  status: VehicleStatus;
  station: string;
  complaint_ref: string | null;
  location_text: string | null;
  reported_at: string;
}

interface VehicleMatch {
  id: string;
  missing_report_id: string;
  found_report_id: string;
  match_type: "exact_registration" | "partial_registration" | "characteristics";
  score: number;
  reasons: string[];
  status: "pending" | "verified" | "rejected";
  decision_note: string | null;
  decided_at: string | null;
  sought?: ReportSummary | null;
  sighted?: ReportSummary | null;
  counterpart?: ReportSummary | null;
  involves_my_station?: boolean;
}

const REPORT_TYPES: { value: ReportType; label: string; hint: string }[] = [
  { value: "stolen", label: "Stolen", hint: "Complaint of theft" },
  { value: "missing", label: "Missing", hint: "Owner cannot trace it" },
  { value: "found", label: "Found", hint: "Recovered or handed in" },
  { value: "abandoned", label: "Abandoned", hint: "Left unattended" },
  { value: "suspicious", label: "Suspicious", hint: "Parked under suspicion" },
];

const VEHICLE_TYPES = ["two_wheeler", "three_wheeler", "car", "suv", "truck", "bus", "tractor", "bicycle", "other"];

export const STATUS_LABEL: Record<VehicleStatus, string> = {
  MISSING_REPORTED: "Missing vehicle reported",
  VEHICLE_FOUND: "Vehicle found",
  POTENTIAL_MATCH: "Potential match detected",
  VERIFICATION_PENDING: "Verification pending",
  MATCH_VERIFIED: "Match verified",
  RECOVERY_IN_PROGRESS: "Recovery in progress",
  OWNER_VERIFICATION_PENDING: "Owner verification pending",
  VEHICLE_RETURNED: "Vehicle returned",
  CASE_CLOSED: "Case closed",
};

const STATUS_TONE: Record<VehicleStatus, Tone> = {
  MISSING_REPORTED: "warning",
  VEHICLE_FOUND: "info",
  POTENTIAL_MATCH: "primary",
  VERIFICATION_PENDING: "primary",
  MATCH_VERIFIED: "success",
  RECOVERY_IN_PROGRESS: "success",
  OWNER_VERIFICATION_PENDING: "success",
  VEHICLE_RETURNED: "neutral",
  CASE_CLOSED: "neutral",
};

const STATUS_ORDER: VehicleStatus[] = [
  "MISSING_REPORTED",
  "VEHICLE_FOUND",
  "POTENTIAL_MATCH",
  "VERIFICATION_PENDING",
  "MATCH_VERIFIED",
  "RECOVERY_IN_PROGRESS",
  "OWNER_VERIFICATION_PENDING",
  "VEHICLE_RETURNED",
  "CASE_CLOSED",
];

const isSought = (t: string) => t === "missing" || t === "stolen";

export function StatusChip({ status }: { status: VehicleStatus }) {
  return <Chip tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Chip>;
}

function mapTone(r: { report_type: string; status: VehicleStatus }): MapPoint["tone"] {
  if (r.status === "VEHICLE_RETURNED" || r.status === "CASE_CLOSED") return "closed";
  if (["MATCH_VERIFIED", "RECOVERY_IN_PROGRESS", "OWNER_VERIFICATION_PENDING"].includes(r.status)) return "matched";
  return isSought(r.report_type) ? "sought" : "sighted";
}

function vehicleLine(r: { make: string | null; model: string | null; colour: string | null; vehicle_type: string }) {
  return [r.colour, r.make, r.model].filter(Boolean).join(" ") || labelOf(r.vehicle_type);
}

/* ============================================================ landing */

type Tab = "report" | "records" | "map" | "matches";
const TABS: { id: Tab; label: string; icon: typeof Car }[] = [
  { id: "report", label: "Report a vehicle", icon: Camera },
  { id: "records", label: "Records", icon: Search },
  { id: "map", label: "Map", icon: MapIcon },
  { id: "matches", label: "Matches", icon: CheckCircle2 },
];

export function VehicleTracePage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || (user?.role === "court_admin" ? "records" : "report");
  const stats = useQuery<{ total: number; stillSought: number; byStatus: Record<string, number>; matches: { byStatus: Record<string, number> }; recoveryRate: number }>("/api/vehicles/stats", [tab]);
  const tabs = user?.role === "court_admin" ? TABS.filter((x) => x.id !== "report") : TABS;

  return (
    <>
      <PageHeader eyebrow={t("nav.vehicleTrace")} title={t("vt.title")} description={t("vt.intro")} />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Reports on record" value={stats.data?.total ?? "—"} icon={<Car size={15} />} />
        <Stat label="Still sought" value={stats.data?.stillSought ?? "—"} tone="warning" hint="Missing or stolen, not yet matched and verified" />
        <Stat label="Matches to verify" value={stats.data?.matches.byStatus.pending ?? "—"} tone="info" />
        <Stat label="Recovery rate" value={stats.data ? `${Math.round(stats.data.recoveryRate * 100)}%` : "—"} tone="success" hint="Sought vehicles in recovery, returned or closed" />
      </div>

      <div role="tablist" aria-label="Vehicle Trace sections" className="mb-5 flex gap-1 overflow-x-auto rounded-full border border-border bg-surface-2 p-1">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setParams({ tab: id })}
            className={`flex shrink-0 items-center gap-1.5 rounded-full px-4 py-2 font-ui text-xs font-semibold transition ${tab === id ? "bg-surface text-text shadow-card" : "text-muted hover:text-text"}`}
          >
            <Icon size={13} aria-hidden />
            {label}
          </button>
        ))}
      </div>

      {tab === "report" && <ReportForm onFiled={() => stats.refetch()} />}
      {tab === "records" && <RecordsView />}
      {tab === "map" && <MapView />}
      {tab === "matches" && <MatchesView />}
    </>
  );
}

/* ========================================================= report form */

interface DuplicateInfo {
  existing: ReportSummary;
  byRegistration: boolean;
  message: string;
}

function PhotoPicker({ label, file, onFile, capture = true }: { label: string; file: Blob | null; onFile: (f: Blob | null) => void; capture?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!file) return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return (
    <div>
      <span className="label">{label}</span>
      <button
        type="button"
        onClick={() => input.current?.click()}
        className="group relative grid aspect-[4/3] w-full place-items-center overflow-hidden rounded-xl border border-dashed border-border-strong bg-surface-2 transition hover:border-primary-ring"
      >
        {preview ? (
          <img src={preview} alt={label} className="h-full w-full object-cover" />
        ) : (
          <span className="flex flex-col items-center gap-1.5 font-ui text-xs text-muted">
            <Camera size={20} aria-hidden />
            Take or choose a photo
          </span>
        )}
      </button>
      <input
        ref={input}
        type="file"
        aria-label={label}
        tabIndex={-1}
        accept="image/jpeg,image/png,image/webp,image/*"
        {...(capture ? { capture: "environment" as const } : {})}
        className="sr-only"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) onFile(await compressImage(f).catch(() => f));
        }}
      />
      {file && (
        <button type="button" className="mt-1 font-ui text-2xs text-muted underline" onClick={() => onFile(null)}>
          Remove
        </button>
      )}
    </div>
  );
}

const EMPTY_FORM = {
  reportType: "abandoned" as ReportType,
  registration: "",
  vehicleType: "two_wheeler",
  make: "",
  model: "",
  colour: "",
  chassisLast5: "",
  conditionNotes: "",
  complaintRef: "",
  incidentAt: "",
  ownerContact: "",
  locationText: "",
};

function ReportForm({ onFiled }: { onFiled: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [form, setForm] = useState(EMPTY_FORM);
  const set = <K extends keyof typeof EMPTY_FORM>(k: K, v: (typeof EMPTY_FORM)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const [vehiclePhoto, setVehiclePhoto] = useState<Blob | null>(null);
  const [platePhoto, setPlatePhoto] = useState<Blob | null>(null);
  const [regSource, setRegSource] = useState<"manual" | "anpr" | "anpr_corrected">("manual");
  const [anprRead, setAnprRead] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<PlateCandidate[] | null>(null);
  const [reading, setReading] = useState<number | null>(null);
  const [location, setLocation] = useState<{ lat: number; lng: number; accuracy: number | null; source: "gps" | "manual" } | null>(null);
  const [locating, setLocating] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [duplicate, setDuplicate] = useState<DuplicateInfo | null>(null);
  const [result, setResult] = useState<{ report: VehicleReport; matches: VehicleMatch[]; uploaded: number } | null>(null);
  const sought = isSought(form.reportType);

  const plate = normalisePlate(form.registration);
  const plateOk = plate.length === 0 || isValidPlate(plate);
  const check = useQuery<{ hits: { report: ReportSummary; comparison: { kind: string; score: number } }[] }>(
    !sought && plate.length >= 6 ? `/api/vehicles/plate-check?registration=${encodeURIComponent(plate)}` : null,
    [plate, sought]
  );

  async function readFromPhoto() {
    const image = platePhoto ?? vehiclePhoto;
    if (!image) return toast.error("Add a number plate photograph first.");
    setReading(0);
    try {
      const read = await readPlate(image, (p) => setReading(p));
      setCandidates(read.candidates);
      const best = read.candidates.find((c) => c.valid) ?? read.candidates[0];
      if (best) {
        set("registration", best.plate);
        setAnprRead(best.plate);
        setRegSource("anpr");
        toast.info(`Read ${formatPlate(best.plate)} ${read.source === "server" ? "(plate recognition service)" : "(on this device)"}`, "Check it against the plate and correct it if needed.");
      } else toast.error("No plate could be read.", "Type the number from the photograph.");
    } catch (error) {
      toast.error("Plate reading failed", error instanceof Error ? error.message : undefined);
    } finally {
      setReading(null);
    }
  }

  async function locate() {
    setLocating(true);
    try {
      const fix = await getFix();
      setLocation({ lat: Number(fix.lat.toFixed(6)), lng: Number(fix.lng.toFixed(6)), accuracy: Math.round(fix.accuracyMetres), source: "gps" });
    } catch (error) {
      toast.error("Location unavailable", `${error instanceof Error ? error.message : ""} Pick the point on the map instead.`);
      setShowMap(true);
    } finally {
      setLocating(false);
    }
  }

  const submit = useMutation(async (confirmNotDuplicate: boolean) => {
    const body = {
      reportType: form.reportType,
      registration: form.registration.trim() || null,
      registrationSource: plate ? (anprRead && anprRead !== plate ? "anpr_corrected" : regSource) : "none",
      vehicleType: form.vehicleType,
      make: form.make.trim() || null,
      model: form.model.trim() || null,
      colour: form.colour.trim() || null,
      chassisLast5: form.chassisLast5.trim() || null,
      conditionNotes: form.conditionNotes.trim() || null,
      complaintRef: form.complaintRef.trim() || null,
      incidentAt: form.incidentAt ? new Date(form.incidentAt).toISOString() : null,
      ownerContact: sought ? form.ownerContact.trim() || null : null,
      latitude: location?.lat ?? null,
      longitude: location?.lng ?? null,
      locationAccuracyM: location?.accuracy ?? null,
      locationSource: location?.source ?? "none",
      locationText: form.locationText.trim() || null,
      confirmNotDuplicate,
    };
    const created = await api.post<{ report: VehicleReport; matches: VehicleMatch[] }>("/api/vehicles", body);
    let uploaded = 0;
    for (const [kind, blob] of [["vehicle_photo", vehiclePhoto], ["plate_photo", platePhoto]] as const) {
      if (!blob) continue;
      const fd = new FormData();
      fd.append("kind", kind);
      fd.append("file", blob, `${kind}.jpg`);
      try {
        await api.upload(`/api/vehicles/${created.report.id}/media`, fd);
        uploaded++;
      } catch (error) {
        toast.error(`The ${kind === "vehicle_photo" ? "vehicle" : "plate"} photograph did not upload`, "Add it again from the report page.");
      }
    }
    return { ...created, uploaded };
  });

  async function file(confirmNotDuplicate = false) {
    setDuplicate(null);
    const out = await submit.run(confirmNotDuplicate);
    if (out) {
      setResult(out);
      onFiled();
      toast.success(out.matches.length ? `Filed — ${out.matches.length} possible match${out.matches.length > 1 ? "es" : ""} found` : "Report filed and anchored");
      setForm({ ...EMPTY_FORM, reportType: form.reportType });
      setVehiclePhoto(null);
      setPlatePhoto(null);
      setLocation(null);
      setCandidates(null);
      setAnprRead(null);
      setRegSource("manual");
      return;
    }
  }

  useEffect(() => {
    const error = submit.error;
    if (error instanceof ApiError && error.code === "DUPLICATE_REPORT") {
      const details = error.details as { existing: ReportSummary; byRegistration: boolean };
      setDuplicate({ existing: details.existing, byRegistration: details.byRegistration, message: error.message });
    }
  }, [submit.error]);

  const needsLocation = !sought && !location && !form.locationText.trim();
  const needsIdentity = sought && !plate && !form.chassisLast5.trim();
  const valid = plateOk && !needsLocation && !needsIdentity;

  return (
    <div className="grid gap-5 xl:grid-cols-[1.35fr_1fr]">
      <Card title="New vehicle report" subtitle="Photographs are compressed on this device, encrypted by the server, and their SHA-256 anchored on chain. No registration number or location is written to the chain.">
        <div className="space-y-5">
          <fieldset>
            <legend className="label">What is being reported</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {REPORT_TYPES.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  aria-pressed={form.reportType === r.value}
                  onClick={() => set("reportType", r.value)}
                  className={`rounded-xl border px-3 py-2.5 text-left transition ${form.reportType === r.value ? "border-primary bg-primary-soft" : "border-border bg-surface-2 hover:border-border-strong"}`}
                >
                  <span className="block font-ui text-sm font-semibold text-text">{r.label}</span>
                  <span className="block font-ui text-2xs text-muted">{r.hint}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <PhotoPicker label="Vehicle photograph" file={vehiclePhoto} onFile={setVehiclePhoto} capture={!sought} />
            <PhotoPicker label="Number plate photograph" file={platePhoto} onFile={setPlatePhoto} capture={!sought} />
          </div>

          <div className="rounded-xl border border-border bg-surface-2 p-4">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <Field
                label="Registration number"
                required={sought && !form.chassisLast5}
                error={!plateOk ? "This does not look like an Indian registration number. Check it, or file anyway if the plate is non-standard." : null}
                hint={plate ? `${formatPlate(plate)}${regSource !== "manual" ? (anprRead === plate ? " · read from photo" : " · read from photo, corrected") : ""}` : "e.g. MH 12 AB 1234 or 22 BH 1234 AA"}
              >
                <Input
                  value={form.registration}
                  onChange={(e) => set("registration", e.target.value.toUpperCase())}
                  placeholder="MH12AB1234"
                  autoCapitalize="characters"
                  className="font-mono tracking-wider"
                />
              </Field>
              <Button variant="secondary" icon={<ScanLine size={14} />} loading={reading !== null} disabled={!platePhoto && !vehiclePhoto} onClick={() => void readFromPhoto()}>
                {reading !== null && reading > 0 ? `Reading ${Math.round(reading * 100)}%` : "Read plate"}
              </Button>
            </div>
            {candidates && candidates.length > 1 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="font-ui text-2xs text-muted">Other readings:</span>
                {candidates.slice(1).map((c) => (
                  <button key={c.plate} type="button" className="chip border-border bg-surface font-mono" onClick={() => { set("registration", c.plate); setRegSource("anpr"); setAnprRead(c.plate); }}>
                    {formatPlate(c.plate)}
                  </button>
                ))}
              </div>
            )}
            {check.data && check.data.hits.length > 0 && (
              <div role="status" className="mt-3 rounded-lg border border-primary-ring bg-primary-soft px-3 py-2.5">
                <p className="font-ui text-xs font-semibold text-text">This plate is sought: {check.data.hits.length} open complaint{check.data.hits.length > 1 ? "s" : ""}</p>
                <ul className="mt-1 space-y-0.5">
                  {check.data.hits.slice(0, 3).map((h) => (
                    <li key={h.report.id} className="font-ui text-2xs text-muted">
                      {formatPlate(h.report.registration)} · {labelOf(h.report.report_type)} at {h.report.station} · {h.comparison.kind} match
                    </li>
                  ))}
                </ul>
                <p className="mt-1 font-ui text-2xs text-muted">File the report: the stations concerned are alerted automatically.</p>
              </div>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Vehicle type" required>
              <Select value={form.vehicleType} onChange={(e) => set("vehicleType", e.target.value)}>
                {VEHICLE_TYPES.map((v) => (
                  <option key={v} value={v}>{labelOf(v)}</option>
                ))}
              </Select>
            </Field>
            <Field label="Manufacturer">
              <Input value={form.make} onChange={(e) => set("make", e.target.value)} placeholder="Honda" />
            </Field>
            <Field label="Model">
              <Input value={form.model} onChange={(e) => set("model", e.target.value)} placeholder="Activa 6G" />
            </Field>
            <Field label="Colour">
              <Input value={form.colour} onChange={(e) => set("colour", e.target.value)} placeholder="Grey" />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Chassis number (last 5)" hint="Survives a changed or removed plate">
              <Input value={form.chassisLast5} maxLength={6} onChange={(e) => set("chassisLast5", e.target.value.toUpperCase())} className="font-mono" />
            </Field>
            {sought ? (
              <Field label="Complaint / FIR reference" hint="As registered at your station">
                <Input value={form.complaintRef} onChange={(e) => set("complaintRef", e.target.value)} placeholder="FIR 112/2026" />
              </Field>
            ) : (
              <Field label="Reference (optional)" hint="Station diary or GD entry">
                <Input value={form.complaintRef} onChange={(e) => set("complaintRef", e.target.value)} placeholder="GD 45/2026" />
              </Field>
            )}
          </div>
          {sought && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="When it went missing">
                <Input type="datetime-local" value={form.incidentAt} onChange={(e) => set("incidentAt", e.target.value)} />
              </Field>
              <Field label="Owner contact" hint="Encrypted; shown only to your station and a station holding a verified match">
                <Input value={form.ownerContact} onChange={(e) => set("ownerContact", e.target.value)} placeholder="Name, phone" />
              </Field>
            </div>
          )}
          <Field label={sought ? "Observations" : "Condition of the vehicle"}>
            <Textarea rows={2} value={form.conditionNotes} onChange={(e) => set("conditionNotes", e.target.value)} placeholder={sought ? "Distinguishing features, accessories, damage" : "Damage, missing parts, ignition tampered, how long it appears to have been there"} />
          </Field>

          <div className="space-y-3 rounded-xl border border-border bg-surface-2 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-ui text-sm font-semibold text-text">{sought ? "Where it was last seen" : "Where it is"}{!sought && <span className="ml-1 text-danger">*</span>}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" icon={<LocateFixed size={12} />} loading={locating} onClick={() => void locate()}>
                  Use my location
                </Button>
                <Button size="sm" variant="ghost" icon={<MapIcon size={12} />} onClick={() => setShowMap((v) => !v)}>
                  {showMap ? "Hide map" : "Pick on map"}
                </Button>
              </div>
            </div>
            {location && (
              <p className="font-ui text-xs text-muted">
                {location.lat}, {location.lng} · {location.source === "gps" ? `GPS, ±${location.accuracy ?? "?"} m` : "set on the map"}{" "}
                <a className="text-primary underline" href={`https://www.google.com/maps?q=${location.lat},${location.lng}`} target="_blank" rel="noreferrer">Google Maps</a>
              </p>
            )}
            {showMap && (
              <LocationMap
                className="h-64"
                picked={location}
                center={location ? [location.lat, location.lng] : undefined}
                onPick={(lat, lng) => setLocation({ lat, lng, accuracy: null, source: "manual" })}
              />
            )}
            <Input aria-label="Describe the place" value={form.locationText} onChange={(e) => set("locationText", e.target.value)} placeholder="Landmark, road, area" />
          </div>

          {duplicate && (
            <DuplicatePanel
              info={duplicate}
              onOverride={duplicate.byRegistration ? undefined : () => void file(true)}
              onOpen={() => navigate(`/police/vehicles/${duplicate.existing.id}`)}
            />
          )}
          {submit.error && !(submit.error instanceof ApiError && submit.error.code === "DUPLICATE_REPORT") && (
            <p role="alert" className="font-ui text-xs text-danger">{submit.error.message}</p>
          )}
          {needsIdentity && <p className="font-ui text-2xs text-warning">A missing or stolen vehicle needs its registration number or the end of its chassis number.</p>}
          {needsLocation && <p className="font-ui text-2xs text-warning">Set the location: GPS, a point on the map, or a description of the place.</p>}
          <Button full size="lg" icon={<Send size={14} />} disabled={!valid} loading={submit.pending} onClick={() => void file(false)}>
            File report and check for matches
          </Button>
        </div>
      </Card>

      <div className="space-y-5">
        {result ? (
          <Card title="Filed" subtitle={`${formatPlate(result.report.registration_norm)} · ${STATUS_LABEL[result.report.status]}`} actions={<Button size="sm" variant="secondary" onClick={() => navigate(`/police/vehicles/${result.report.id}`)}>Open</Button>}>
            <p className="font-ui text-xs text-muted">{result.uploaded} photograph{result.uploaded === 1 ? "" : "s"} stored encrypted.</p>
            {result.matches.length === 0 ? (
              <p className="mt-2 font-ui text-sm text-text">No matching {isSought(result.report.report_type) ? "found-vehicle" : "missing-vehicle"} report yet. The report stays open and will be matched when one is filed.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {result.matches.map((m) => (
                  <li key={m.id} className="rounded-xl border border-primary-ring bg-primary-soft p-3">
                    <div className="flex items-center justify-between gap-2">
                      <Chip tone="primary">{labelOf(m.match_type)}</Chip>
                      <ScoreBar score={Number(m.score)} />
                    </div>
                    <p className="mt-1.5 font-ui text-xs text-text">{m.reasons[0]}</p>
                    <p className="mt-1 font-ui text-2xs text-muted">The other station has been alerted. Verify the match on the report page.</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ) : (
          <Card title="How matching works">
            <ol className="list-decimal space-y-2 pl-4 font-ui text-xs leading-relaxed text-muted">
              <li>The registration number is read from the plate photograph (on this device, or by a plate recognition service if configured). You confirm or correct it.</li>
              <li>A found, abandoned or suspicious vehicle is compared with every open missing or stolen report across all stations — exact numbers first, then misreads (B/8, O/0), partial plates and the chassis number.</li>
              <li>A likely pair becomes a <em>potential match</em>. The station holding the complaint gets an alert with the photographs, location and a Google Maps link.</li>
              <li>An officer of either station verifies or rejects it in writing. Nothing is matched, returned or closed automatically.</li>
              <li>The complaint, the discovery, the verification, the handover and the closure are anchored on chain as digests.</li>
            </ol>
          </Card>
        )}
      </div>
    </div>
  );
}

function DuplicatePanel({ info, onOverride, onOpen }: { info: DuplicateInfo; onOverride?: () => void; onOpen: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState("");
  const add = useMutation(async () => api.post(`/api/vehicles/${info.existing.id}/observations`, { note: note.trim() }));
  return (
    <div role="alert" className="rounded-xl border border-warning-soft bg-warning-soft p-4">
      <p className="font-ui text-sm font-semibold text-text">Already reported</p>
      <p className="mt-1 font-ui text-xs text-text">{info.message}</p>
      <div className="mt-3 rounded-lg border border-border bg-surface p-3">
        <p className="font-mono text-sm text-text">{formatPlate(info.existing.registration)}</p>
        <p className="font-ui text-2xs text-muted">
          {labelOf(info.existing.report_type)} · {vehicleLine(info.existing)} · {info.existing.station} · {relativeTime(info.existing.reported_at)}
        </p>
        <div className="mt-1"><StatusChip status={info.existing.status} /></div>
      </div>
      <Field label="Add your observation to the existing report">
        <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you saw, when, and its condition" />
      </Field>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" icon={<MessageSquarePlus size={12} />} disabled={note.trim().length < 3} loading={add.pending} onClick={async () => {
          if (await add.run(undefined as never)) {
            toast.success("Observation added to the existing report");
            onOpen();
          }
        }}>
          Add observation
        </Button>
        <Button size="sm" variant="secondary" onClick={onOpen}>Open existing report</Button>
        {onOverride && (
          <Button size="sm" variant="ghost" onClick={onOverride}>It is a different vehicle — file anyway</Button>
        )}
      </div>
    </div>
  );
}

/* ============================================================ records */

function useFilters() {
  const [filters, setFilters] = useState({ scope: "all", type: "", status: "", q: "", station: "" });
  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (filters.scope === "mine") p.set("scope", "mine");
    if (filters.type) p.set("type", filters.type);
    if (filters.status) p.set("status", filters.status);
    if (filters.q.trim()) p.set("q", filters.q.trim());
    if (filters.station.trim() && filters.scope !== "mine") p.set("station", filters.station.trim());
    return p.toString();
  }, [filters]);
  return { filters, setFilters, query };
}

function FilterBar({ filters, setFilters }: ReturnType<typeof useFilters>) {
  return (
    <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
      <Select aria-label="Scope" value={filters.scope} onChange={(e) => setFilters({ ...filters, scope: e.target.value })}>
        <option value="all">All stations</option>
        <option value="mine">My station</option>
      </Select>
      <Input aria-label="Station" placeholder="Station name" value={filters.station} disabled={filters.scope === "mine"} onChange={(e) => setFilters({ ...filters, station: e.target.value })} />
      <Select aria-label="Type" value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })}>
        <option value="">Every type</option>
        {REPORT_TYPES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
      </Select>
      <Select aria-label="Status" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
        <option value="">Every status</option>
        {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
      </Select>
      <Input aria-label="Search" placeholder="Plate, make, place…" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
    </div>
  );
}

function RecordsView() {
  const f = useFilters();
  const reports = useQuery<{ reports: VehicleReport[] }>(`/api/vehicles?${f.query}`, [f.query]);
  return (
    <Card>
      <FilterBar {...f} />
      <AsyncView state={reports} onRetry={reports.refetch} context="vehicle reports" isEmpty={(d) => d.reports.length === 0} empty={<EmptyState title="No reports match" icon={<Car size={19} />} />}>
        {(data) => (
          <ul className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {data.reports.map((r) => (
              <li key={r.id}>
                <Link to={`/police/vehicles/${r.id}`} className="flex gap-3 rounded-xl border border-border bg-surface-2 p-3 transition hover:border-primary-ring">
                  {r.photo_id ? (
                    <SecureImage id={r.photo_id} alt={`Vehicle ${r.registration_norm ?? ""}`} className="h-20 w-24 shrink-0 rounded-lg" />
                  ) : (
                    <div className="grid h-20 w-24 shrink-0 place-items-center rounded-lg bg-surface-3 text-faint"><Car size={20} aria-hidden /></div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-sm font-semibold tracking-wide text-text">{formatPlate(r.registration_norm)}</p>
                    <p className="truncate font-ui text-2xs text-muted">{labelOf(r.report_type)} · {vehicleLine(r)}</p>
                    <p className="truncate font-ui text-2xs text-faint">{r.station} · {relativeTime(r.reported_at)}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1"><StatusChip status={r.status} />{r.verification && <VerificationBadge state={r.verification.state} short />}</div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </AsyncView>
    </Card>
  );
}

function MapView() {
  const f = useFilters();
  const navigate = useNavigate();
  const reports = useQuery<{ reports: VehicleReport[] }>(`/api/vehicles?${f.query}`, [f.query]);
  const points = useMemo<MapPoint[]>(
    () =>
      (reports.data?.reports ?? [])
        .filter((r) => r.latitude !== null && r.longitude !== null)
        .map((r) => ({ id: r.id, lat: r.latitude!, lng: r.longitude!, tone: mapTone(r), label: `${formatPlate(r.registration_norm)} · ${STATUS_LABEL[r.status]} · ${r.station}` })),
    [reports.data]
  );
  const without = (reports.data?.reports.length ?? 0) - points.length;
  return (
    <Card subtitle={`${points.length} report${points.length === 1 ? "" : "s"} with a location${without > 0 ? ` · ${without} without one (not shown)` : ""}. Select a point to open the report.`}>
      <FilterBar {...f} />
      <LocationMap points={points} className="h-[60vh] min-h-[320px]" onOpen={(id) => navigate(`/police/vehicles/${id}`)} />
      <MapLegend />
    </Card>
  );
}

/* ============================================================ matches */

function MatchDecision({ match, onDone }: { match: VehicleMatch; onDone: () => void }) {
  const toast = useToast();
  const [decision, setDecision] = useState<"verified" | "rejected" | null>(null);
  const [note, setNote] = useState("");
  const run = useMutation(async () => api.post(`/api/vehicles/matches/${match.id}/decision`, { decision, note: note.trim() }));
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon={<CheckCircle2 size={12} />} onClick={() => setDecision("verified")}>Verify match</Button>
        <Button size="sm" variant="secondary" icon={<XCircle size={12} />} onClick={() => setDecision("rejected")}>Reject</Button>
      </div>
      <Modal
        open={decision !== null}
        onClose={() => setDecision(null)}
        title={decision === "verified" ? "Verify this match" : "Reject this match"}
        description={decision === "verified" ? "Confirm only after checking the vehicle itself: chassis and engine numbers against the RC, not the plate alone. Both reports move to “Match verified”, and the verification is anchored on chain." : "Say why this is not the same vehicle. The reports go back to their previous status."}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDecision(null)}>Cancel</Button>
            <Button variant={decision === "verified" ? "primary" : "danger"} disabled={note.trim().length < 10} loading={run.pending} onClick={async () => {
              if (await run.run(undefined as never)) {
                toast.success(decision === "verified" ? "Match verified" : "Match rejected");
                setDecision(null);
                onDone();
              }
            }}>
              {decision === "verified" ? "Verify" : "Reject"}
            </Button>
          </div>
        }
      >
        <Field label="What did you check?" required hint="At least 10 characters. Recorded with your name.">
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder={decision === "verified" ? "Chassis no. ending 4K21 checked on site against the RC; matches." : "Chassis number differs; plate appears cloned."} />
        </Field>
        {run.error && <p role="alert" className="mt-2 font-ui text-xs text-danger">{run.error.message}</p>}
      </Modal>
    </>
  );
}

function SideCard({ title, r }: { title: string; r: ReportSummary | null | undefined }) {
  if (!r) return null;
  return (
    <Link to={`/police/vehicles/${r.id}`} className="block rounded-lg border border-border bg-surface p-3 transition hover:border-primary-ring">
      <p className="font-ui text-2xs font-semibold uppercase tracking-wider text-muted">{title}</p>
      <p className="mt-1 font-mono text-sm font-semibold text-text">{formatPlate(r.registration)}</p>
      <p className="font-ui text-2xs text-muted">{labelOf(r.report_type)} · {vehicleLine(r)}</p>
      <p className="font-ui text-2xs text-faint">{r.station}{r.complaint_ref ? ` · ${r.complaint_ref}` : ""} · {relativeTime(r.reported_at)}</p>
    </Link>
  );
}

function MatchesView() {
  const { user } = useAuth();
  const [status, setStatus] = useState("pending");
  const matches = useQuery<{ matches: VehicleMatch[] }>(`/api/vehicles/matches?status=${status}`, [status]);
  return (
    <Card actions={
      <Select aria-label="Match status" value={status} onChange={(e) => setStatus(e.target.value)} className="h-9 text-xs">
        <option value="pending">Awaiting verification</option>
        <option value="verified">Verified</option>
        <option value="rejected">Rejected</option>
      </Select>
    } title="Possible matches">
      <AsyncView state={matches} onRetry={matches.refetch} context="matches" isEmpty={(d) => d.matches.length === 0} empty={<EmptyState title="Nothing here" icon={<CheckCircle2 size={19} />} />}>
        {(data) => (
          <ul className="space-y-3">
            {data.matches.map((m) => (
              <li key={m.id} className="rounded-xl border border-border bg-surface-2 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip tone={m.match_type === "exact_registration" ? "success" : "primary"}>{labelOf(m.match_type)}</Chip>
                    {m.involves_my_station && <Chip tone="info">Your station</Chip>}
                  </div>
                  <ScoreBar score={Number(m.score)} />
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <SideCard title="Missing / stolen" r={m.sought} />
                  <SideCard title="Found / abandoned" r={m.sighted} />
                </div>
                <ul className="mt-3 space-y-0.5">
                  {m.reasons.map((reason) => <li key={reason} className="font-ui text-2xs text-muted">• {reason}</li>)}
                </ul>
                {m.decision_note && <p className="mt-2 font-ui text-xs text-text">Decision: {m.decision_note}</p>}
                {m.status === "pending" && m.involves_my_station && user?.role === "police" && (
                  <div className="mt-3"><MatchDecision match={m} onDone={matches.refetch} /></div>
                )}
              </li>
            ))}
          </ul>
        )}
      </AsyncView>
    </Card>
  );
}

/* ======================================================= report detail */

interface ReportDetail {
  report: VehicleReport;
  events: { id: string; kind: string; from_status: string | null; to_status: string | null; note: string | null; actor_name: string | null; actor_station: string | null; occurred_at: string; anchored: boolean; event_digest: string; verification: Verification | null }[];
  matches: VehicleMatch[];
  media: { id: string; kind: string; sha256: string; uploaded_at: string; verification: Verification | null }[];
  verification: Verification | null;
  integrity: IntegrityVerdict;
}

const STEP_HELP: Partial<Record<VehicleStatus, string>> = {
  VERIFICATION_PENDING: "A physical check has been arranged.",
  RECOVERY_IN_PROGRESS: "The vehicle is being secured or brought to the station.",
  OWNER_VERIFICATION_PENDING: "Waiting for the owner to prove ownership (RC, ID, keys).",
  VEHICLE_RETURNED: "Handed over to the verified owner, under the procedure the law requires.",
  CASE_CLOSED: "Nothing further to do.",
};

export function VehicleReportPage() {
  const { id = "" } = useParams();
  const { user } = useAuth();
  const toast = useToast();
  const detail = useQuery<ReportDetail>(`/api/vehicles/${id}`, [id]);
  const [next, setNext] = useState<VehicleStatus | null>(null);
  const [note, setNote] = useState("");
  const [observation, setObservation] = useState("");
  const [photo, setPhoto] = useState<Blob | null>(null);
  const police = user?.role === "police";

  const move = useMutation(async () => api.post(`/api/vehicles/${id}/status`, { status: next, note: note.trim() || null }));
  const observe = useMutation(async () => api.post(`/api/vehicles/${id}/observations`, { note: observation.trim() }));
  const rematch = useMutation(async () => api.post<{ matches: VehicleMatch[] }>(`/api/vehicles/${id}/rematch`));
  const addPhoto = useMutation(async (kind: string) => {
    const fd = new FormData();
    fd.append("kind", kind);
    fd.append("file", photo!, "photo.jpg");
    return api.upload(`/api/vehicles/${id}/media`, fd);
  });

  return (
    <AsyncView state={detail} onRetry={detail.refetch} context="vehicle report">
      {(d) => {
        const r = d.report;
        const stepIndex = STATUS_ORDER.indexOf(r.status);
        return (
          <>
            <PageHeader
              eyebrow={`Vehicle Trace · ${labelOf(r.report_type)}`}
              title={formatPlate(r.registration_norm)}
              description={`${vehicleLine(r)} · reported by ${r.reported_by_name ?? "an officer"}, ${r.station}, ${formatDateTime(r.reported_at)}`}
              actions={
                <>
                  <StatusChip status={r.status} />
                  {d.verification && <VerificationBadge state={d.verification.state} />}
                </>
              }
            />

            <ol className="mb-6 flex gap-1 overflow-x-auto pb-1" aria-label="Recovery workflow">
              {STATUS_ORDER.filter((s) => (isSought(r.report_type) ? s !== "VEHICLE_FOUND" : s !== "MISSING_REPORTED")).map((s) => {
                const i = STATUS_ORDER.indexOf(s);
                const done = i < stepIndex;
                const current = s === r.status;
                return (
                  <li key={s} className={`min-w-[7.5rem] flex-1 rounded-lg border px-2.5 py-2 ${current ? "border-primary bg-primary-soft" : done ? "border-success-soft bg-success-soft" : "border-border bg-surface-2"}`} aria-current={current ? "step" : undefined}>
                    <p className={`font-ui text-2xs font-semibold leading-tight ${current ? "text-primary" : done ? "text-success" : "text-muted"}`}>{STATUS_LABEL[s]}</p>
                  </li>
                );
              })}
            </ol>

            <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
              <div className="space-y-5">
                <Card title="Photographs" actions={police ? <PhotoAdd photo={photo} setPhoto={setPhoto} pending={addPhoto.pending} onAdd={async (kind) => { if (await addPhoto.run(kind)) { toast.success("Photograph added and anchored"); setPhoto(null); detail.refetch(); } }} /> : undefined}>
                  {d.media.length === 0 ? (
                    <EmptyState title="No photographs" icon={<Camera size={19} />} />
                  ) : (
                    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {d.media.map((m) => (
                        <li key={m.id}>
                          <SecureImage id={m.id} alt={labelOf(m.kind)} className="aspect-[4/3] w-full rounded-lg" />
                          <p className="mt-1 font-ui text-2xs text-muted">{labelOf(m.kind)} · {relativeTime(m.uploaded_at)}</p>
                          {m.verification && <VerificationBadge state={m.verification.state} short />}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>

                <Card title="Possible matches" actions={police ? <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} loading={rematch.pending} onClick={async () => { const out = await rematch.run(undefined as never); if (out) { toast.info(out.matches.length ? `${out.matches.length} new possible match(es)` : "No new matches"); detail.refetch(); } }}>Check again</Button> : undefined}>
                  {d.matches.length === 0 ? (
                    <EmptyState title="No matches yet" description="The report stays open; a matching report filed later at any station is linked automatically." icon={<Search size={19} />} />
                  ) : (
                    <ul className="space-y-3">
                      {d.matches.map((m) => (
                        <li key={m.id} className="rounded-xl border border-border bg-surface-2 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex gap-1.5"><Chip tone={m.status === "verified" ? "success" : m.status === "rejected" ? "neutral" : "primary"}>{labelOf(m.status)}</Chip><Chip>{labelOf(m.match_type)}</Chip></div>
                            <ScoreBar score={Number(m.score)} />
                          </div>
                          <div className="mt-2"><SideCard title={isSought(r.report_type) ? "Found / abandoned" : "Missing / stolen"} r={m.counterpart} /></div>
                          <ul className="mt-2 space-y-0.5">{m.reasons.map((x) => <li key={x} className="font-ui text-2xs text-muted">• {x}</li>)}</ul>
                          {m.decision_note && <p className="mt-1.5 font-ui text-xs text-text">Decision: {m.decision_note}</p>}
                          {m.status === "pending" && police && <div className="mt-3"><MatchDecision match={m} onDone={detail.refetch} /></div>}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>

                <Card title="Timeline" subtitle="Append-only and hash-chained; steps marked ⛓ are anchored on chain.">
                  <ol className="space-y-3">
                    {d.events.map((e) => (
                      <li key={e.id} className="flex gap-3">
                        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden />
                        <div className="min-w-0 flex-1">
                          <p className="font-ui text-xs text-text">
                            {e.kind === "status" ? <>Moved to <strong>{STATUS_LABEL[e.to_status as VehicleStatus] ?? e.to_status}</strong></> : e.kind === "reported" ? "Reported" : labelOf(e.kind)}
                            {e.anchored && <span title="Anchored on chain"> ⛓</span>}
                          </p>
                          {e.note && <p className="font-ui text-2xs leading-relaxed text-muted">{e.note}</p>}
                          <p className="font-ui text-2xs text-faint">{e.actor_name ?? "Officer"}{e.actor_station ? `, ${e.actor_station}` : ""} · {formatDateTime(e.occurred_at)}</p>
                          {e.verification && <div className="mt-1"><VerificationBadge state={e.verification.state} short /></div>}
                        </div>
                      </li>
                    ))}
                  </ol>
                  {police && (
                    <div className="mt-4 flex gap-2">
                      <Input aria-label="Add an observation" value={observation} onChange={(e) => setObservation(e.target.value)} placeholder="Add an observation" />
                      <Button variant="secondary" icon={<MessageSquarePlus size={13} />} disabled={observation.trim().length < 3} loading={observe.pending} onClick={async () => { if (await observe.run(undefined as never)) { setObservation(""); detail.refetch(); } }}>Add</Button>
                    </div>
                  )}
                </Card>
              </div>

              <div className="space-y-5">
                {police && r.allowed_next.length > 0 && (
                  <Card title="Next step">
                    <div className="space-y-2">
                      {r.allowed_next.map((s) => (
                        <button key={s} type="button" onClick={() => { setNext(s); setNote(""); }} className="w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-left transition hover:border-primary-ring">
                          <span className="block font-ui text-sm font-semibold text-text">{STATUS_LABEL[s]}</span>
                          <span className="block font-ui text-2xs text-muted">{STEP_HELP[s]}</span>
                        </button>
                      ))}
                    </div>
                  </Card>
                )}
                <Card title="Details">
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 font-ui text-xs">
                    {([
                      ["Type", labelOf(r.vehicle_type)],
                      ["Vehicle", vehicleLine(r)],
                      ["Chassis (last 5)", r.chassis_last5],
                      ["Plate read", labelOf(r.registration_source)],
                      [isSought(r.report_type) ? "Complaint / FIR" : "Reference", r.complaint_ref],
                      ["Incident", r.incident_at ? formatDateTime(r.incident_at) : null],
                      ["Condition", r.condition_notes],
                      ["Owner contact", r.owner_contact ?? (r.owner_contact_withheld ? "Withheld — visible to the complaint station and a station with a verified match" : null)],
                    ] as [string, string | null][]).filter(([, v]) => v).map(([k, v]) => (
                      <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="text-text">{v}</dd></div>
                    ))}
                  </dl>
                </Card>
                <Card title="Location">
                  {r.latitude !== null && r.longitude !== null ? (
                    <>
                      <LocationMap className="h-56" points={[{ id: r.id, lat: r.latitude, lng: r.longitude, tone: mapTone(r), label: r.location_text ?? "Reported location" }]} />
                      <p className="mt-2 font-ui text-xs text-muted">{r.location_text} · {r.location_source === "gps" ? `GPS ±${r.location_accuracy_m ?? "?"} m` : "set on map"}</p>
                      {r.maps_link && <a href={r.maps_link} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 font-ui text-xs font-semibold text-primary">Open in Google Maps <ExternalLink size={11} aria-hidden /></a>}
                    </>
                  ) : (
                    <p className="font-ui text-xs text-muted">{r.location_text ?? "No location recorded."}</p>
                  )}
                </Card>
                <Card title="Blockchain verification">
                  <IntegrityNote integrity={d.integrity} />
                  {d.verification?.txHash && <p className="mt-2 break-all font-mono text-2xs text-muted">tx {d.verification.txHash}</p>}
                </Card>
              </div>
            </div>

            <Modal
              open={next !== null}
              onClose={() => setNext(null)}
              title={next ? STATUS_LABEL[next] : ""}
              description={next ? `${STEP_HELP[next] ?? ""} ${next === "VEHICLE_RETURNED" || next === "CASE_CLOSED" ? "This step is anchored on chain." : ""}` : undefined}
              footer={
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setNext(null)}>Cancel</Button>
                  <Button disabled={(next === "VEHICLE_RETURNED" || next === "CASE_CLOSED") && note.trim().length < 10} loading={move.pending} onClick={async () => {
                    if (await move.run(undefined as never)) {
                      toast.success(`Moved to ${STATUS_LABEL[next!]}`);
                      setNext(null);
                      detail.refetch();
                    }
                  }}>Confirm</Button>
                </div>
              }
            >
              <Field label={next === "VEHICLE_RETURNED" ? "Handed over to, and how ownership was verified" : "Note"} required={next === "VEHICLE_RETURNED" || next === "CASE_CLOSED"}>
                <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder={next === "VEHICLE_RETURNED" ? "Returned to the registered owner after RC, ID and keys were verified; receipt no. 33/2026" : ""} />
              </Field>
              {move.error && <p role="alert" className="mt-2 font-ui text-xs text-danger">{move.error.message}</p>}
            </Modal>
          </>
        );
      }}
    </AsyncView>
  );
}

function PhotoAdd({ photo, setPhoto, pending, onAdd }: { photo: Blob | null; setPhoto: (b: Blob | null) => void; pending: boolean; onAdd: (kind: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-2">
      <input ref={input} type="file" aria-label="Add a photograph to this report" tabIndex={-1} accept="image/*" capture="environment" className="sr-only" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) setPhoto(await compressImage(f).catch(() => f)); }} />
      {photo ? (
        <>
          <Button size="sm" loading={pending} onClick={() => onAdd("vehicle_photo")}>Add as vehicle</Button>
          <Button size="sm" variant="secondary" loading={pending} onClick={() => onAdd("plate_photo")}>Add as plate</Button>
        </>
      ) : (
        <Button size="sm" variant="secondary" icon={<Camera size={12} />} onClick={() => input.current?.click()}>Add photo</Button>
      )}
    </div>
  );
}
