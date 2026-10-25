import { useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Eye, FileSearch, GitCompareArrows, History, ImagePlus, Link2, Search, UserPlus, Users } from "lucide-react";
import { api, type Verification } from "../lib/api";
import { useMutation, useQuery } from "../lib/useApi";
import { useToast } from "../context/ToastContext";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../i18n";
import { formatDate, formatDateTime, relativeTime } from "../lib/format";
import { compressImage, differenceHash } from "../lib/imageTools";
import { AsyncView, EmptyState } from "../components/DataState";
import { Button, Card, Field, Input, Modal, PageHeader, Select, Stat, Textarea } from "../components/ui";
import { VerificationBadge } from "../components/verification";
import { Chip, IntegrityNote, LeadDisclaimer, ScoreBar, SecureImage, labelOf, type IntegrityVerdict, type Tone } from "../components/smart";

/**
 * Third Eye: criminal intelligence records and case linking. Every result is a
 * lead for an investigator to verify, never an identification.
 */

/* ================================================================ types */

type Classification = "person_of_interest" | "suspect" | "accused" | "convicted";

interface Person {
  id: string;
  full_name: string;
  aliases: string[];
  gender: string | null;
  date_of_birth: string | null;
  age_estimate: number | null;
  height_cm: number | null;
  build: string | null;
  complexion: string | null;
  identifying_marks: string | null;
  physical_description: string | null;
  classification: Classification;
  home_station: string;
  record_status: string;
  record_digest: string;
  created_at: string;
  updated_at: string;
}

interface CaseLink {
  id: string;
  fir_number: string;
  police_station: string;
  offence: string;
  offence_category: string;
  modus_operandi: string | null;
  crime_date: string | null;
  crime_location: string | null;
  involvement: string;
  investigation_status: string;
  arrest_status: string | null;
  court_status: string | null;
  investigating_officer: string | null;
  verification: Verification | null;
  integrity?: IntegrityVerdict;
}

interface LeadSide {
  person: { id: string; full_name: string; classification: Classification; home_station: string } | null;
  caseLink: { id: string; fir_number: string; police_station: string; offence: string; crime_date: string | null; modus_operandi: string | null } | null;
}

interface Lead {
  id: string;
  kind: "possible_duplicate" | "image_similarity" | "related_cases";
  score: number;
  reasons: string[];
  status: "pending" | "confirmed" | "rejected";
  review_note: string | null;
  reviewed_at: string | null;
  created_at: string;
  a: LeadSide;
  b: LeadSide;
}

interface Meta {
  disclaimer: string;
  notes: string[];
  enums: { classifications: Classification[]; offenceCategories: string[]; involvements: string[]; investigationStatuses: string[]; arrestStatuses: string[] };
}

/** The legal standing of a person, kept visibly distinct. */
const CLASSIFICATION: Record<Classification, { label: string; tone: Tone; hint: string }> = {
  person_of_interest: { label: "Person of interest", tone: "neutral", hint: "Information only; no allegation" },
  suspect: { label: "Suspect", tone: "info", hint: "Under suspicion; not charged" },
  accused: { label: "Accused", tone: "warning", hint: "Charged; presumed innocent until convicted" },
  convicted: { label: "Convicted", tone: "danger", hint: "Convicted by a court" },
};

export function ClassificationChip({ value }: { value: Classification }) {
  const c = CLASSIFICATION[value];
  return <Chip tone={c.tone} title={c.hint}>{c.label}</Chip>;
}

const LEAD_LABEL: Record<Lead["kind"], string> = {
  possible_duplicate: "Possible duplicate record",
  image_similarity: "Same image on two records",
  related_cases: "Related cases",
};

function useMeta() {
  return useQuery<Meta>("/api/third-eye/meta");
}

/* ============================================================ landing */

type Tab = "search" | "register" | "leads" | "repeat" | "activity";
const TABS: { id: Tab; label: string; icon: typeof Eye }[] = [
  { id: "search", label: "Search", icon: Search },
  { id: "register", label: "New record", icon: UserPlus },
  { id: "leads", label: "Leads to review", icon: GitCompareArrows },
  { id: "repeat", label: "Repeat & cross-station", icon: Users },
  { id: "activity", label: "Officer activity", icon: History },
];

export function ThirdEyePage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "search";
  const meta = useMeta();
  const stats = useQuery<{ persons: number; caseLinks: number; stations: number; leads: { byStatus: Record<string, number> } }>("/api/third-eye/stats", [tab]);

  return (
    <>
      <PageHeader eyebrow={t("nav.thirdEye")} title={t("te.title")} description={t("te.intro")} />
      {meta.data && <div className="mb-5"><LeadDisclaimer text={meta.data.disclaimer} /></div>}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Person records" value={stats.data?.persons ?? "—"} icon={<Users size={15} />} />
        <Stat label="Linked FIRs" value={stats.data?.caseLinks ?? "—"} icon={<Link2 size={15} />} />
        <Stat label="Stations covered" value={stats.data?.stations ?? "—"} />
        <Stat label="Leads awaiting review" value={stats.data?.leads.byStatus.pending ?? "—"} tone="warning" />
      </div>

      <div role="tablist" aria-label="Third Eye sections" className="mb-5 flex gap-1 overflow-x-auto rounded-full border border-border bg-surface-2 p-1">
        {TABS.map(({ id, label, icon: Icon }) => (
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

      {tab === "search" && <SearchView meta={meta.data} />}
      {tab === "register" && <RegisterView meta={meta.data} />}
      {tab === "leads" && <LeadsView />}
      {tab === "repeat" && <RepeatView />}
      {tab === "activity" && <ActivityView />}
    </>
  );
}

/* ============================================================== search */

interface SearchResult {
  person: Person;
  score: number;
  reasons: string[];
  caseCount?: number;
  stations?: string[];
  photo_id: string | null;
}

function ResultList({ results, purpose }: { results: SearchResult[]; purpose: string }) {
  if (results.length === 0) return <EmptyState title="No records match" description="An empty result is not a clearance: it only means nothing on file matches these criteria." icon={<Search size={19} />} />;
  return (
    <ul className="space-y-3">
      {results.map((r) => (
        <li key={r.person.id}>
          <Link to={`/police/third-eye/${r.person.id}?purpose=${encodeURIComponent(purpose)}`} className="flex gap-3 rounded-xl border border-border bg-surface-2 p-3 transition hover:border-primary-ring">
            {r.photo_id ? (
              <SecureImage id={r.photo_id} alt={`Photograph on record for ${r.person.full_name}`} className="h-20 w-16 shrink-0 rounded-lg" />
            ) : (
              <div className="grid h-20 w-16 shrink-0 place-items-center rounded-lg bg-surface-3 text-faint"><Users size={18} aria-hidden /></div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-ui text-sm font-semibold text-text">{r.person.full_name}</p>
                <ScoreBar score={r.score} />
              </div>
              {r.person.aliases.length > 0 && <p className="font-ui text-2xs text-muted">alias {r.person.aliases.join(", ")}</p>}
              <div className="mt-1 flex flex-wrap gap-1.5">
                <ClassificationChip value={r.person.classification} />
                {r.caseCount !== undefined && <Chip>{r.caseCount} FIR{r.caseCount === 1 ? "" : "s"}</Chip>}
                {(r.stations ?? []).slice(0, 3).map((s) => <Chip key={s} tone="info">{s}</Chip>)}
              </div>
              <ul className="mt-1.5 space-y-0.5">{r.reasons.map((x) => <li key={x} className="font-ui text-2xs text-muted">• {x}</li>)}</ul>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function SearchView({ meta }: { meta?: Meta | null }) {
  const [purpose, setPurpose] = useState("");
  const [criteria, setCriteria] = useState({ name: "", fir: "", offenceCategory: "", station: "", modusOperandi: "", marks: "", classification: "" });
  const [results, setResults] = useState<{ results: SearchResult[]; kind: "record" | "image" } | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);

  const run = useMutation(async () => {
    const body: Record<string, string> = { purpose: purpose.trim() };
    for (const [k, v] of Object.entries(criteria)) if (v.trim()) body[k] = v.trim();
    return api.post<{ results: SearchResult[] }>("/api/third-eye/search", body);
  });
  const runImage = useMutation(async (file: File) => api.post<{ results: SearchResult[] }>("/api/third-eye/search/image", { purpose: purpose.trim(), perceptualHash: await differenceHash(file) }));

  const purposeOk = purpose.trim().length >= 10;
  const anyCriterion = Object.values(criteria).some((v) => v.trim());
  const set = (k: keyof typeof criteria, v: string) => setCriteria((c) => ({ ...c, [k]: v }));

  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_1.2fr]">
      <Card title="Search records" subtitle="Every search is logged with its purpose and criteria.">
        <div className="space-y-4">
          <Field label="Purpose of this search" required hint="The FIR or inquiry this is for, e.g. “Investigating FIR 77/2026, Dadar PS”">
            <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name or alias"><Input value={criteria.name} onChange={(e) => set("name", e.target.value)} /></Field>
            <Field label="FIR number"><Input value={criteria.fir} onChange={(e) => set("fir", e.target.value)} /></Field>
            <Field label="Offence category">
              <Select value={criteria.offenceCategory} onChange={(e) => set("offenceCategory", e.target.value)}>
                <option value="">Any</option>
                {meta?.enums.offenceCategories.map((c) => <option key={c} value={c}>{labelOf(c)}</option>)}
              </Select>
            </Field>
            <Field label="Police station"><Input value={criteria.station} onChange={(e) => set("station", e.target.value)} /></Field>
            <Field label="Standing">
              <Select value={criteria.classification} onChange={(e) => set("classification", e.target.value)}>
                <option value="">Any</option>
                {meta?.enums.classifications.map((c) => <option key={c} value={c}>{CLASSIFICATION[c].label}</option>)}
              </Select>
            </Field>
            <Field label="Marks or description"><Input value={criteria.marks} onChange={(e) => set("marks", e.target.value)} placeholder="scar, tattoo…" /></Field>
          </div>
          <Field label="Modus operandi" hint="Matched by shared keywords against the MO recorded for every linked FIR">
            <Textarea rows={2} value={criteria.modusOperandi} onChange={(e) => set("modusOperandi", e.target.value)} placeholder="Two men on a motorcycle snatch chains near bus stops" />
          </Field>
          {(run.error || runImage.error) && <p role="alert" className="font-ui text-xs text-danger">{(run.error ?? runImage.error)!.message}</p>}
          <div className="flex flex-wrap gap-2">
            <Button icon={<Search size={14} />} disabled={!purposeOk || !anyCriterion} loading={run.pending} onClick={async () => { const out = await run.run(undefined as never); if (out) setResults({ results: out.results, kind: "record" }); }}>
              Search records
            </Button>
            <Button variant="secondary" icon={<ImagePlus size={14} />} disabled={!purposeOk} loading={runImage.pending} onClick={() => imageInput.current?.click()}>
              Search by image
            </Button>
            <input ref={imageInput} type="file" aria-label="Choose an image to search by" tabIndex={-1} accept="image/*" className="sr-only" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) { const out = await runImage.run(f); if (out) setResults({ results: out.results, kind: "image" }); } }} />
          </div>
          <p className="font-ui text-2xs leading-relaxed text-faint">
            Image search finds the <strong>same picture</strong> already on file (a re-used photograph or CCTV still). It does not compare faces, and the image you choose is not uploaded or stored — only a 64-bit fingerprint computed on this device is sent.
          </p>
        </div>
      </Card>
      <Card title={results ? `${results.results.length} result${results.results.length === 1 ? "" : "s"}${results.kind === "image" ? " · image fingerprint" : ""}` : "Results"}>
        {results ? <ResultList results={results.results} purpose={purpose} /> : <EmptyState title="State a purpose and at least one criterion" icon={<FileSearch size={19} />} />}
      </Card>
    </div>
  );
}

/* ============================================================ register */

const EMPTY_PERSON = { fullName: "", aliases: "", gender: "", dateOfBirth: "", ageEstimate: "", heightCm: "", build: "", complexion: "", identifyingMarks: "", physicalDescription: "", classification: "suspect" as Classification };

function RegisterView({ meta }: { meta?: Meta | null }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [form, setForm] = useState(EMPTY_PERSON);
  const set = (k: keyof typeof EMPTY_PERSON, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const create = useMutation(async () =>
    api.post<{ person: Person; leads: Lead[] }>("/api/third-eye/persons", {
      fullName: form.fullName.trim(),
      aliases: form.aliases.split(",").map((a) => a.trim()).filter((a) => a.length >= 2),
      gender: form.gender || null,
      dateOfBirth: form.dateOfBirth || null,
      ageEstimate: form.ageEstimate ? Number(form.ageEstimate) : null,
      heightCm: form.heightCm ? Number(form.heightCm) : null,
      build: form.build.trim() || null,
      complexion: form.complexion.trim() || null,
      identifyingMarks: form.identifyingMarks.trim() || null,
      physicalDescription: form.physicalDescription.trim() || null,
      classification: form.classification,
    })
  );
  return (
    <Card title="New person record" subtitle="Record what is known and lawfully held. Add FIRs, photographs and sketches on the record once it exists.">
      <div className="grid gap-4 lg:grid-cols-2">
        <Field label="Full name" required><Input value={form.fullName} onChange={(e) => set("fullName", e.target.value)} /></Field>
        <Field label="Aliases" hint="Separate with commas"><Input value={form.aliases} onChange={(e) => set("aliases", e.target.value)} /></Field>
        <Field label="Standing in law" required hint={CLASSIFICATION[form.classification].hint}>
          <Select value={form.classification} onChange={(e) => set("classification", e.target.value)}>
            {(meta?.enums.classifications ?? (Object.keys(CLASSIFICATION) as Classification[])).map((c) => <option key={c} value={c}>{CLASSIFICATION[c].label}</option>)}
          </Select>
        </Field>
        <Field label="Gender">
          <Select value={form.gender} onChange={(e) => set("gender", e.target.value)}>
            <option value="">Not recorded</option>
            {["male", "female", "transgender", "unknown"].map((g) => <option key={g} value={g}>{labelOf(g)}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Date of birth"><Input type="date" value={form.dateOfBirth} onChange={(e) => set("dateOfBirth", e.target.value)} /></Field>
          <Field label="Age (est.)"><Input type="number" min={5} max={120} value={form.ageEstimate} onChange={(e) => set("ageEstimate", e.target.value)} /></Field>
          <Field label="Height (cm)"><Input type="number" min={50} max={250} value={form.heightCm} onChange={(e) => set("heightCm", e.target.value)} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Build"><Input value={form.build} onChange={(e) => set("build", e.target.value)} placeholder="Medium" /></Field>
          <Field label="Complexion"><Input value={form.complexion} onChange={(e) => set("complexion", e.target.value)} placeholder="Wheatish" /></Field>
        </div>
        <Field label="Identifying marks"><Textarea rows={2} value={form.identifyingMarks} onChange={(e) => set("identifyingMarks", e.target.value)} placeholder="Scar above left eyebrow; anchor tattoo on right forearm" /></Field>
        <Field label="Physical description"><Textarea rows={2} value={form.physicalDescription} onChange={(e) => set("physicalDescription", e.target.value)} /></Field>
      </div>
      {create.error && <p role="alert" className="mt-3 font-ui text-xs text-danger">{create.error.message}</p>}
      <div className="mt-4">
        <Button icon={<UserPlus size={14} />} disabled={form.fullName.trim().length < 2} loading={create.pending} onClick={async () => {
          const out = await create.run(undefined as never);
          if (out) {
            toast.success("Record created and anchored", out.leads.length ? `${out.leads.length} possible duplicate record(s) raised for review.` : undefined);
            navigate(`/police/third-eye/${out.person.id}`);
          }
        }}>
          Create record
        </Button>
      </div>
    </Card>
  );
}

/* =============================================================== leads */

function SideBlock({ side }: { side: LeadSide }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      {side.person ? (
        <Link to={`/police/third-eye/${side.person.id}`} className="font-ui text-sm font-semibold text-primary hover:underline">{side.person.full_name}</Link>
      ) : (
        <p className="font-ui text-sm text-muted">Record unavailable</p>
      )}
      {side.person && <div className="mt-1"><ClassificationChip value={side.person.classification} /></div>}
      {side.caseLink && (
        <p className="mt-1.5 font-ui text-2xs text-muted">
          FIR {side.caseLink.fir_number} · {side.caseLink.police_station}{side.caseLink.crime_date ? ` · ${formatDate(side.caseLink.crime_date)}` : ""}
          <br />{side.caseLink.offence}
          {side.caseLink.modus_operandi && <><br /><em>{side.caseLink.modus_operandi}</em></>}
        </p>
      )}
    </div>
  );
}

function LeadCard({ lead, onDone }: { lead: Lead; onDone: () => void }) {
  const toast = useToast();
  const { user } = useAuth();
  const [decision, setDecision] = useState<"confirmed" | "rejected" | null>(null);
  const [note, setNote] = useState("");
  const review = useMutation(async () => api.post(`/api/third-eye/leads/${lead.id}/review`, { decision, note: note.trim() }));
  return (
    <li className="rounded-xl border border-border bg-surface-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          <Chip tone="primary">{LEAD_LABEL[lead.kind]}</Chip>
          <Chip tone={lead.status === "confirmed" ? "success" : lead.status === "rejected" ? "neutral" : "warning"}>{labelOf(lead.status)}</Chip>
        </div>
        <ScoreBar score={Number(lead.score)} />
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2"><SideBlock side={lead.a} /><SideBlock side={lead.b} /></div>
      <ul className="mt-2 space-y-0.5">{lead.reasons.map((r) => <li key={r} className="font-ui text-2xs text-muted">• {r}</li>)}</ul>
      {lead.review_note && <p className="mt-2 font-ui text-xs text-text">Review: {lead.review_note}</p>}
      {lead.status === "pending" && user?.role === "police" && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setDecision("confirmed")}>Confirm lead</Button>
          <Button size="sm" variant="secondary" onClick={() => setDecision("rejected")}>Reject</Button>
        </div>
      )}
      <Modal
        open={decision !== null}
        onClose={() => setDecision(null)}
        title={decision === "confirmed" ? "Confirm this lead" : "Reject this lead"}
        description={decision === "confirmed" ? "Confirming records that, after your own inquiry, the link is worth pursuing. It is not an identification and does not change anyone's standing. Related cases at another station will be alerted." : "Record why the two are not linked."}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDecision(null)}>Cancel</Button>
            <Button disabled={note.trim().length < 15} loading={review.pending} onClick={async () => { if (await review.run(undefined as never)) { toast.success(decision === "confirmed" ? "Lead confirmed" : "Lead rejected"); setDecision(null); onDone(); } }}>Record decision</Button>
          </div>
        }
      >
        <Field label="What did you check?" required hint="At least 15 characters; recorded with your name on both records.">
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {review.error && <p role="alert" className="mt-2 font-ui text-xs text-danger">{review.error.message}</p>}
      </Modal>
    </li>
  );
}

function LeadsView() {
  const [status, setStatus] = useState("pending");
  const leads = useQuery<{ leads: Lead[] }>(`/api/third-eye/leads?status=${status}`, [status]);
  return (
    <Card title="Investigative leads" subtitle="Raised automatically from records; confirmed or rejected only by an officer, in writing." actions={
      <Select aria-label="Lead status" value={status} onChange={(e) => setStatus(e.target.value)} className="h-9 text-xs">
        <option value="pending">Awaiting review</option>
        <option value="confirmed">Confirmed</option>
        <option value="rejected">Rejected</option>
      </Select>
    }>
      <AsyncView state={leads} onRetry={leads.refetch} context="leads" isEmpty={(d) => d.leads.length === 0} empty={<EmptyState title="No leads" icon={<GitCompareArrows size={19} />} />}>
        {(d) => <ul className="space-y-3">{d.leads.map((l) => <LeadCard key={l.id} lead={l} onDone={leads.refetch} />)}</ul>}
      </AsyncView>
    </Card>
  );
}

/* ========================================================= repeat view */

function RepeatView() {
  const people = useQuery<{ people: { person: Person; caseCount: number; stations: string[]; categories: string[]; open: number; latest: string | null }[] }>("/api/third-eye/repeat-offenders");
  const cross = useQuery<{ leads: Lead[] }>("/api/third-eye/cross-case");
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Card title="Records with more than one FIR" subtitle="Ordered by the number of stations involved. Cases against a person are not proof of anything; check each FIR's status.">
        <AsyncView state={people} onRetry={people.refetch} context="records" isEmpty={(d) => d.people.length === 0} empty={<EmptyState title="None yet" icon={<Users size={19} />} />}>
          {(d) => (
            <ul className="space-y-2">
              {d.people.map((p) => (
                <li key={p.person.id}>
                  <Link to={`/police/third-eye/${p.person.id}`} className="block rounded-xl border border-border bg-surface-2 p-3 transition hover:border-primary-ring">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-ui text-sm font-semibold text-text">{p.person.full_name}</p>
                      <ClassificationChip value={p.person.classification} />
                    </div>
                    <p className="mt-1 font-ui text-2xs text-muted">{p.caseCount} FIRs · {p.stations.length} station{p.stations.length === 1 ? "" : "s"} · {p.open} open · latest {formatDate(p.latest)}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1">{p.stations.map((s) => <Chip key={s} tone="info">{s}</Chip>)}{p.categories.map((c) => <Chip key={c}>{labelOf(c)}</Chip>)}</div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </AsyncView>
      </Card>
      <Card title="Cases with a similar modus operandi" subtitle="Same offence category and shared MO keywords, often at different stations.">
        <AsyncView state={cross} onRetry={cross.refetch} context="links" isEmpty={(d) => d.leads.length === 0} empty={<EmptyState title="None yet" icon={<Link2 size={19} />} />}>
          {(d) => <ul className="space-y-3">{d.leads.map((l) => <LeadCard key={l.id} lead={l} onDone={cross.refetch} />)}</ul>}
        </AsyncView>
      </Card>
    </div>
  );
}

/* ============================================================ activity */

export function ActivityView() {
  const activity = useQuery<{ activity: { id: number; action: string; actor_name: string | null; actor_station: string | null; subject: string | null; outcome: string; detail: any; created_at: string }[] }>("/api/third-eye/activity");
  return (
    <Card title="Officer activity" subtitle="Every search (with its stated purpose), view, change and review on Third Eye.">
      <AsyncView state={activity} onRetry={activity.refetch} context="activity" isEmpty={(d) => d.activity.length === 0} empty={<EmptyState title="No activity yet" icon={<History size={19} />} />}>
        {(d) => (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left font-ui text-xs">
              <thead className="text-2xs uppercase tracking-wider text-muted">
                <tr><th className="py-2 pr-3">When</th><th className="py-2 pr-3">Officer</th><th className="py-2 pr-3">Action</th><th className="py-2">Purpose / detail</th></tr>
              </thead>
              <tbody>
                {d.activity.map((a) => (
                  <tr key={a.id} className="border-t border-border align-top">
                    <td className="py-2 pr-3 text-muted">{formatDateTime(a.created_at)}</td>
                    <td className="py-2 pr-3 text-text">{a.actor_name ?? "—"}<br /><span className="text-faint">{a.actor_station}</span></td>
                    <td className="py-2 pr-3 text-text">{labelOf(a.action.replace("third_eye.", ""))}</td>
                    <td className="py-2 text-muted">{a.detail?.purpose ?? a.detail?.reason ?? (a.detail?.fields ? `Changed ${a.detail.fields.join(", ")}` : "")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AsyncView>
    </Card>
  );
}

/* ============================================================ record page */

interface PersonDetail {
  person: Person;
  caseLinks: CaseLink[];
  media: { id: string; kind: string; sha256: string; source_note: string | null; uploaded_at: string; uploaded_station: string | null; verification: Verification | null }[];
  leads: Lead[];
  events: { id: string; kind: string; detail: any; actor_name: string | null; actor_station: string | null; occurred_at: string }[];
  verification: Verification | null;
  integrity: IntegrityVerdict;
  disclaimer: string;
}

const EMPTY_LINK = { firNumber: "", policeStation: "", offence: "", offenceCategory: "robbery", modusOperandi: "", crimeDate: "", crimeLocation: "", involvement: "suspect", investigationStatus: "under_investigation", arrestStatus: "", courtStatus: "", investigatingOfficer: "" };

export function PersonRecordPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const purpose = params.get("purpose") ?? "";
  const toast = useToast();
  const { user } = useAuth();
  const meta = useMeta();
  const detail = useQuery<PersonDetail>(`/api/third-eye/persons/${id}${purpose ? `?purpose=${encodeURIComponent(purpose)}` : ""}`, [id]);
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState({ ...EMPTY_LINK, policeStation: user?.stationOrCourt ?? "" });
  const [reclassify, setReclassify] = useState<{ to: Classification; reason: string } | null>(null);
  const [media, setMedia] = useState<{ file: Blob; hash: string | null; kind: string; note: string } | null>(null);
  const mediaInput = useRef<HTMLInputElement>(null);

  const addLink = useMutation(async () =>
    api.post<{ leads: Lead[] }>(`/api/third-eye/persons/${id}/cases`, {
      ...Object.fromEntries(Object.entries(link).map(([k, v]) => [k, typeof v === "string" && v.trim() === "" ? null : v])),
      firNumber: link.firNumber.trim(),
    })
  );
  const changeClass = useMutation(async () => api.patch(`/api/third-eye/persons/${id}`, { classification: reclassify!.to, reason: reclassify!.reason.trim() }));
  const upload = useMutation(async () => {
    const fd = new FormData();
    fd.append("kind", media!.kind);
    if (media!.hash) fd.append("perceptualHash", media!.hash);
    if (media!.note.trim()) fd.append("sourceNote", media!.note.trim());
    fd.append("file", media!.file, "image.jpg");
    return api.upload<{ leads: Lead[] }>(`/api/third-eye/persons/${id}/media`, fd);
  });

  const pendingLeads = useMemo(() => (detail.data?.leads ?? []).filter((l) => l.status === "pending").length, [detail.data]);

  return (
    <AsyncView state={detail} onRetry={detail.refetch} context="record">
      {(d) => (
        <>
          <PageHeader
            eyebrow="Third Eye · record"
            title={d.person.full_name}
            description={`${d.person.aliases.length ? `alias ${d.person.aliases.join(", ")} · ` : ""}home station ${d.person.home_station} · created ${formatDate(d.person.created_at)}`}
            actions={<><ClassificationChip value={d.person.classification} />{d.verification && <VerificationBadge state={d.verification.state} />}</>}
          />
          <div className="mb-5"><LeadDisclaimer text={d.disclaimer} /></div>

          <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
            <div className="space-y-5">
              <Card title="Case history" subtitle="One row per FIR, across stations. Involvement and status are as each station recorded them." actions={<Button size="sm" icon={<Link2 size={12} />} onClick={() => setLinkOpen(true)}>Link an FIR</Button>}>
                {d.caseLinks.length === 0 ? <EmptyState title="No FIRs linked" icon={<Link2 size={19} />} /> : (
                  <ul className="space-y-3">
                    {d.caseLinks.map((c) => (
                      <li key={c.id} className="rounded-xl border border-border bg-surface-2 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="font-ui text-sm font-semibold text-text">FIR {c.fir_number} · {c.police_station}</p>
                          <div className="flex gap-1">{c.verification && <VerificationBadge state={c.verification.state} short />}{c.integrity && !c.integrity.intact && <Chip tone="danger">Altered</Chip>}</div>
                        </div>
                        <p className="font-ui text-xs text-text">{c.offence} <span className="text-muted">({labelOf(c.offence_category)})</span></p>
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          <Chip tone={c.involvement === "convicted" ? "danger" : c.involvement === "accused" ? "warning" : c.involvement === "suspect" ? "info" : "neutral"}>{labelOf(c.involvement)}</Chip>
                          <Chip>{labelOf(c.investigation_status)}</Chip>
                          {c.arrest_status && <Chip>{labelOf(c.arrest_status)}</Chip>}
                        </div>
                        {c.modus_operandi && <p className="mt-1.5 font-ui text-2xs leading-relaxed text-muted"><strong>MO:</strong> {c.modus_operandi}</p>}
                        <p className="mt-1 font-ui text-2xs text-faint">{[c.crime_date && formatDate(c.crime_date), c.crime_location, c.investigating_officer && `IO ${c.investigating_officer}`, c.court_status].filter(Boolean).join(" · ")}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card title={`Linked investigations and leads${pendingLeads ? ` · ${pendingLeads} to review` : ""}`}>
                {d.leads.length === 0 ? <EmptyState title="No leads" icon={<GitCompareArrows size={19} />} /> : <ul className="space-y-3">{d.leads.map((l) => <LeadCard key={l.id} lead={l} onDone={detail.refetch} />)}</ul>}
              </Card>

              <Card title="Record history" subtitle="Append-only and hash-chained.">
                <ol className="space-y-2.5">
                  {d.events.map((e) => (
                    <li key={e.id} className="flex gap-3">
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden />
                      <div>
                        <p className="font-ui text-xs text-text">{labelOf(e.kind)}{e.detail?.classification?.to ? `: ${CLASSIFICATION[e.detail.classification.from as Classification]?.label} → ${CLASSIFICATION[e.detail.classification.to as Classification]?.label}` : e.detail?.firNumber ? `: FIR ${e.detail.firNumber}` : e.detail?.decision ? `: ${e.detail.decision}` : ""}</p>
                        {(e.detail?.reason || e.detail?.note) && <p className="font-ui text-2xs text-muted">{e.detail.reason ?? e.detail.note}</p>}
                        <p className="font-ui text-2xs text-faint">{e.actor_name ?? "Officer"}{e.actor_station ? `, ${e.actor_station}` : ""} · {formatDateTime(e.occurred_at)}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </Card>
            </div>

            <div className="space-y-5">
              <Card title="Photographs and sketches" actions={<Button size="sm" variant="secondary" icon={<ImagePlus size={12} />} onClick={() => mediaInput.current?.click()}>Add</Button>}>
                <input ref={mediaInput} type="file" aria-label="Choose an image to add to this record" tabIndex={-1} accept="image/*" className="sr-only" onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  const file = await compressImage(f).catch(() => f);
                  setMedia({ file, hash: await differenceHash(file).catch(() => null), kind: "suspect_photo", note: "" });
                }} />
                {d.media.length === 0 ? <EmptyState title="No images" icon={<ImagePlus size={19} />} /> : (
                  <ul className="grid grid-cols-2 gap-3">
                    {d.media.map((m) => (
                      <li key={m.id}>
                        <SecureImage id={m.id} alt={`${labelOf(m.kind)} on record`} className="aspect-[3/4] w-full rounded-lg" />
                        <p className="mt-1 font-ui text-2xs text-muted">{labelOf(m.kind)} · {relativeTime(m.uploaded_at)}</p>
                        {m.source_note && <p className="font-ui text-2xs text-faint">{m.source_note}</p>}
                        {m.verification && <VerificationBadge state={m.verification.state} short />}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card title="Description">
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 font-ui text-xs">
                  {([
                    ["Gender", d.person.gender && labelOf(d.person.gender)],
                    ["Date of birth", d.person.date_of_birth && formatDate(d.person.date_of_birth)],
                    ["Age (est.)", d.person.age_estimate?.toString()],
                    ["Height", d.person.height_cm ? `${d.person.height_cm} cm` : null],
                    ["Build", d.person.build],
                    ["Complexion", d.person.complexion],
                    ["Marks", d.person.identifying_marks],
                    ["Description", d.person.physical_description],
                  ] as [string, string | null | undefined][]).filter(([, v]) => v).map(([k, v]) => (
                    <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="text-text">{v}</dd></div>
                  ))}
                </dl>
                <div className="mt-4">
                  <Select aria-label="Change standing" value="" onChange={(e) => e.target.value && setReclassify({ to: e.target.value as Classification, reason: "" })}>
                    <option value="">Change standing…</option>
                    {(Object.keys(CLASSIFICATION) as Classification[]).filter((c) => c !== d.person.classification).map((c) => <option key={c} value={c}>{CLASSIFICATION[c].label}</option>)}
                  </Select>
                </div>
              </Card>
              <Card title="Record verification"><IntegrityNote integrity={d.integrity} /></Card>
            </div>
          </div>

          <Modal open={linkOpen} onClose={() => setLinkOpen(false)} title="Link an FIR to this record" width="max-w-2xl"
            footer={<div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setLinkOpen(false)}>Cancel</Button><Button disabled={link.firNumber.trim().length < 3 || link.policeStation.trim().length < 2 || link.offence.trim().length < 2} loading={addLink.pending} onClick={async () => {
              const out = await addLink.run(undefined as never);
              if (out) { toast.success("FIR linked and anchored", out.leads.length ? `${out.leads.length} related case(s) raised for review.` : undefined); setLinkOpen(false); setLink({ ...EMPTY_LINK, policeStation: user?.stationOrCourt ?? "" }); detail.refetch(); }
            }}>Link FIR</Button></div>}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="FIR number" required><Input value={link.firNumber} onChange={(e) => setLink({ ...link, firNumber: e.target.value })} placeholder="112/2026" /></Field>
              <Field label="Police station" required><Input value={link.policeStation} onChange={(e) => setLink({ ...link, policeStation: e.target.value })} /></Field>
              <Field label="Offence" required><Input value={link.offence} onChange={(e) => setLink({ ...link, offence: e.target.value })} placeholder="Robbery (BNS 309)" /></Field>
              <Field label="Category" required><Select value={link.offenceCategory} onChange={(e) => setLink({ ...link, offenceCategory: e.target.value })}>{meta.data?.enums.offenceCategories.map((c) => <option key={c} value={c}>{labelOf(c)}</option>)}</Select></Field>
              <Field label="Involvement" required><Select value={link.involvement} onChange={(e) => setLink({ ...link, involvement: e.target.value })}>{meta.data?.enums.involvements.map((c) => <option key={c} value={c}>{labelOf(c)}</option>)}</Select></Field>
              <Field label="Investigation status" required><Select value={link.investigationStatus} onChange={(e) => setLink({ ...link, investigationStatus: e.target.value })}>{meta.data?.enums.investigationStatuses.map((c) => <option key={c} value={c}>{labelOf(c)}</option>)}</Select></Field>
              <Field label="Arrest status"><Select value={link.arrestStatus} onChange={(e) => setLink({ ...link, arrestStatus: e.target.value })}><option value="">Not recorded</option>{meta.data?.enums.arrestStatuses.map((c) => <option key={c} value={c}>{labelOf(c)}</option>)}</Select></Field>
              <Field label="Crime date"><Input type="date" value={link.crimeDate} onChange={(e) => setLink({ ...link, crimeDate: e.target.value })} /></Field>
              <Field label="Crime location"><Input value={link.crimeLocation} onChange={(e) => setLink({ ...link, crimeLocation: e.target.value })} /></Field>
              <Field label="Investigating officer"><Input value={link.investigatingOfficer} onChange={(e) => setLink({ ...link, investigatingOfficer: e.target.value })} /></Field>
              <Field label="Court status"><Input value={link.courtStatus} onChange={(e) => setLink({ ...link, courtStatus: e.target.value })} /></Field>
            </div>
            <div className="mt-3"><Field label="Modus operandi" hint="Used to find related cases across stations"><Textarea rows={3} value={link.modusOperandi} onChange={(e) => setLink({ ...link, modusOperandi: e.target.value })} /></Field></div>
            {addLink.error && <p role="alert" className="mt-2 font-ui text-xs text-danger">{addLink.error.message}</p>}
          </Modal>

          <Modal open={reclassify !== null} onClose={() => setReclassify(null)} title={reclassify ? `Change standing to ${CLASSIFICATION[reclassify.to].label}` : ""} description="Only on the basis of a recorded legal step — a chargesheet, a conviction, an acquittal. The change and its reason are kept on the record's history and anchored."
            footer={<div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setReclassify(null)}>Cancel</Button><Button disabled={(reclassify?.reason.trim().length ?? 0) < 10} loading={changeClass.pending} onClick={async () => { if (await changeClass.run(undefined as never)) { toast.success("Standing changed"); setReclassify(null); detail.refetch(); } }}>Change</Button></div>}>
            <Field label="Legal basis" required hint="e.g. Chargesheet filed in FIR 112/2026 on 3 May 2026">
              <Textarea rows={2} value={reclassify?.reason ?? ""} onChange={(e) => setReclassify(reclassify && { ...reclassify, reason: e.target.value })} />
            </Field>
            {changeClass.error && <p role="alert" className="mt-2 font-ui text-xs text-danger">{changeClass.error.message}</p>}
          </Modal>

          <Modal open={media !== null} onClose={() => setMedia(null)} title="Add an image to this record"
            footer={<div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setMedia(null)}>Cancel</Button><Button loading={upload.pending} onClick={async () => {
              const out = await upload.run(undefined as never);
              if (out) { toast.success("Image stored encrypted and anchored", out.leads.length ? `The same image is on ${out.leads.length} other record(s): raised for review.` : undefined); setMedia(null); detail.refetch(); }
            }}>Upload</Button></div>}>
            <div className="grid gap-3">
              <Field label="What is it?">
                <Select value={media?.kind ?? "suspect_photo"} onChange={(e) => setMedia(media && { ...media, kind: e.target.value })}>
                  <option value="suspect_photo">Photograph</option>
                  <option value="cctv_still">CCTV still</option>
                  <option value="sketch">Sketch (stored; never auto-compared)</option>
                  <option value="other">Other</option>
                </Select>
              </Field>
              <Field label="Source" hint="Where it came from: arrest photograph, CCTV at…, sketch by…"><Input value={media?.note ?? ""} onChange={(e) => setMedia(media && { ...media, note: e.target.value })} /></Field>
              {upload.error && <p role="alert" className="font-ui text-xs text-danger">{upload.error.message}</p>}
            </div>
          </Modal>
        </>
      )}
    </AsyncView>
  );
}
