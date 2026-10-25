import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Camera, ClipboardList, FilePlus2, Fingerprint, ShieldAlert, Sparkles } from "lucide-react";
import { api, type CaseRow, type EvidenceRow, type VerificationState } from "../lib/api";
import { useQuery, useMutation } from "../lib/useApi";
import { useToast } from "../context/ToastContext";
import { useAuth } from "../context/AuthContext";
import { useI18n, type MessageKey } from "../i18n";
import { CASE_STATUS_LABEL, ROLE_HOME, relativeTime } from "../lib/format";
import { AsyncView, EmptyState } from "../components/DataState";
import { Button, Card, Field, Input, LinkButton, PageHeader, Select, Textarea } from "../components/ui";
import { SectionPicker } from "../components/SectionPicker";
import { StatusChip } from "../components/trust";
import { VerificationBadge } from "../components/verification";
import { SmartPolicingPanel } from "../components/SmartPolicingPanel";

/* ================================================== shared summary ======= */

export interface VerificationSummary {
  counts: Record<VerificationState, number>;
  attention: (EvidenceRow & { cases?: { case_reference: string; title: string } })[];
  recent?: (EvidenceRow & { cases?: { case_reference: string; title: string } })[];
  total: number;
}

const STATE_ORDER: VerificationState[] = ["CONFIRMED", "SUBMITTED", "LOCAL_ONLY", "SYNC_ERROR", "REVIEW_REQUIRED", "INTEGRITY_MISMATCH"];

/** Counts of items in each verification state, never merged into one green total. */
export function VerificationCounts({ counts }: { counts: Record<VerificationState, number> }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      {STATE_ORDER.map((state) => (
        <div key={state} className="panel-tight px-4 py-3.5">
          <VerificationBadge state={state} short />
          <p className="mt-2 font-ui text-2xl font-bold tabular text-text">{counts[state] ?? 0}</p>
        </div>
      ))}
    </div>
  );
}

/** Items in SYNC_ERROR, REVIEW_REQUIRED or INTEGRITY_MISMATCH: what needs a person. */
export function AttentionList({ items, basePath }: { items: VerificationSummary["attention"]; basePath: string }) {
  const { t } = useI18n();
  if (items.length === 0) {
    return <EmptyState title={t("dash.noAttention")} icon={<Sparkles size={19} />} />;
  }
  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <li key={item.id}>
          <Link
            to={`${basePath}/cases/evidence/${item.id}`}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface-2 px-4 py-3 transition hover:border-border-strong"
          >
            <div className="min-w-0">
              <p className="truncate font-ui text-sm font-medium text-text">{item.file_name}</p>
              <p className="mt-0.5 font-ui text-2xs text-muted">
                {item.cases?.case_reference} · {item.verification?.failureReason ?? relativeTime(item.collected_at)}
              </p>
            </div>
            {item.verification && <VerificationBadge state={item.verification.state} short />}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/* ================================================== PoliceDashboard ====== */

export function PoliceDashboard() {
  const { t } = useI18n();
  const cases = useQuery<{ cases: CaseRow[] }>("/api/cases");
  const summary = useQuery<VerificationSummary>("/api/evidence/summary", [], { pollMs: 30_000 });

  return (
    <>
      <PageHeader
        eyebrow="Police portal"
        title={t("dash.policeTitle")}
        description={t("dash.policeIntro")}
        actions={
          <>
            <LinkButton to="/police/new-case" variant="secondary" icon={<FilePlus2 size={14} />}>
              {t("nav.newCase")}
            </LinkButton>
            <LinkButton to="/police/capture" icon={<Camera size={14} />}>
              {t("nav.capture")}
            </LinkButton>
          </>
        }
      />

      <SmartPolicingPanel />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        {(
          [
            ["/police/capture", "nav.capture", "dash.captureHint", Camera, "bg-primary-soft text-primary"],
            ["/police/new-case", "nav.newCase", "dash.newCaseHint", FilePlus2, "bg-accent-soft text-accent"],
            ["/police/cases", "nav.cases", "dash.casesHint", ClipboardList, "bg-info-soft text-info"],
          ] as const
        ).map(([to, label, hint, Icon, tone]) => (
          <Link
            key={to}
            to={to}
            className="panel group flex items-center gap-4 p-5 transition hover:-translate-y-0.5 hover:border-primary-ring hover:shadow-lift"
          >
            <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl ${tone}`}>
              <Icon size={19} aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="font-display text-base text-text">{t(label)}</p>
              <p className="mt-0.5 font-ui text-2xs leading-relaxed text-muted">
                {to === "/police/cases" ? t("dash.casesAssigned", { n: cases.data?.cases.length ?? "—" }) : t(hint)}
              </p>
            </div>
            <ArrowRight size={15} className="ml-auto shrink-0 text-faint transition group-hover:text-primary" aria-hidden />
          </Link>
        ))}
      </div>

      <section className="mb-6" aria-labelledby="states-heading">
        <h2 id="states-heading" className="mb-3 flex items-center gap-2 font-ui text-xs font-bold uppercase tracking-wider text-muted">
          <Fingerprint size={14} aria-hidden /> {t("dash.verificationStates")}
        </h2>
        {summary.data ? <VerificationCounts counts={summary.data.counts} /> : <div className="skeleton h-20" />}
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={t("dash.attention")} subtitle={t("dash.attentionHint")} actions={<ShieldAlert size={16} className="text-warning" aria-hidden />}>
          <AsyncView state={summary} onRetry={summary.refetch} context="verification states">
            {(data) => <AttentionList items={data.attention} basePath="/police" />}
          </AsyncView>
        </Card>

        <Card title={t("dash.recentCases")}>
          <AsyncView
            state={cases}
            onRetry={cases.refetch}
            context="your cases"
            isEmpty={(data) => data.cases.length === 0}
            empty={
              <EmptyState
                title={t("dash.noCases")}
                icon={<ClipboardList size={19} />}
                action={
                  <LinkButton size="sm" to="/police/new-case">
                    {t("nav.newCase")}
                  </LinkButton>
                }
              />
            }
          >
            {(data) => (
              <ul className="space-y-2.5">
                {data.cases.slice(0, 8).map((row) => (
                  <li key={row.id}>
                    <Link
                      to={`/police/cases/${row.id}`}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface-2 px-4 py-3 transition hover:border-border-strong"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-ui text-sm font-medium text-text">{row.title}</p>
                        <code className="mt-0.5 block font-mono text-2xs text-muted">{row.case_reference}</code>
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusChip tone="info" label={CASE_STATUS_LABEL[row.status] ?? row.status} />
                        <span className="font-ui text-2xs text-faint">{relativeTime(row.registered_at)}</span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </AsyncView>
        </Card>
      </div>
    </>
  );
}

/* ===================================================== NewCasePage ======= */

/**
 * Case intake (2.0 · F1). The case gets its own reference; the FIR is optional,
 * stored apart, visible to four roles and never written to the chain.
 */
export function NewCasePage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const thisYear = new Date().getFullYear();
  const [sections, setSections] = useState<string[]>([]);
  const [origin, setOrigin] = useState<"fir" | "complaint" | "court" | "other">("fir");
  const [form, setForm] = useState({
    title: "",
    offenceType: "",
    policeStation: user?.stationOrCourt ?? "",
    courtName: "",
    summary: "",
    firNumber: "",
    firYear: String(thisYear),
    firDate: "",
    district: "",
  });

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [key]: event.target.value });

  const create = useMutation(async () =>
    api.post<{ case: CaseRow }>("/api/cases", {
      title: form.title.trim(),
      offenceType: form.offenceType.trim(),
      sections,
      policeStation: form.policeStation.trim(),
      courtName: form.courtName.trim() || null,
      summary: form.summary.trim() || null,
      origin,
      fir:
        origin === "fir"
          ? {
              number: form.firNumber.trim(),
              year: Number(form.firYear),
              date: form.firDate || null,
              district: form.district.trim() || null,
            }
          : null,
    })
  );

  const valid =
    form.title.trim().length >= 3 &&
    form.offenceType.trim().length >= 2 &&
    form.policeStation.trim().length >= 2 &&
    (origin !== "fir" || (form.firNumber.trim().length >= 1 && Number(form.firYear) >= 1950));

  const base = user ? ROLE_HOME[user.role] : "/police";

  return (
    <>
      <PageHeader eyebrow={t("nav.newCase")} title={t("case.registerTitle")} description={t("case.registerIntro")} />

      <form
        className="grid gap-5 lg:grid-cols-[1.4fr_1fr]"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!valid) return;
          const result = await create.run(undefined as never);
          if (result) {
            toast.success(t("case.created", { reference: result.case.case_reference }));
            navigate(`${base}/cases/${result.case.id}`);
          }
        }}
      >
        <div className="space-y-5">
          <Card title={t("case.title")}>
            <div className="space-y-4">
              <Field label={t("case.title")} required>
                <Input value={form.title} onChange={set("title")} placeholder={t("case.titlePlaceholder")} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("case.offence")} required>
                  <Input value={form.offenceType} onChange={set("offenceType")} />
                </Field>
                <Field label={t("case.station")} required>
                  <Input value={form.policeStation} onChange={set("policeStation")} />
                </Field>
              </div>
              <SectionPicker value={sections} onChange={setSections} />
              <Field label={t("case.court")}>
                <Input value={form.courtName} onChange={set("courtName")} />
              </Field>
              <Field label={t("case.summary")} hint={t("case.summaryHint")}>
                <Textarea rows={4} value={form.summary} onChange={set("summary")} />
              </Field>
            </div>
          </Card>
        </div>

        <div className="space-y-5">
          <Card title={t("case.origin")}>
            <div className="space-y-4">
              <Field label={t("case.origin")}>
                <Select value={origin} onChange={(e) => setOrigin(e.target.value as typeof origin)}>
                  <option value="fir">{t("case.origin.fir")}</option>
                  <option value="complaint">{t("case.origin.complaint")}</option>
                  <option value="court">{t("case.origin.court")}</option>
                  <option value="other">{t("case.origin.other")}</option>
                </Select>
              </Field>

              {origin === "fir" && (
                <div className="space-y-4 rounded-xl border border-border bg-surface-2 p-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={t("case.firNumber")} required>
                      <Input value={form.firNumber} onChange={set("firNumber")} placeholder="0042/2026" className="font-mono" />
                    </Field>
                    <Field label={t("case.firYear")} required>
                      <Input type="number" min={1950} max={thisYear} value={form.firYear} onChange={set("firYear")} />
                    </Field>
                    <Field label={t("case.firDate")}>
                      <Input type="date" max={new Date().toISOString().slice(0, 10)} value={form.firDate} onChange={set("firDate")} />
                    </Field>
                    <Field label={t("case.firDistrict")}>
                      <Input value={form.district} onChange={set("district")} />
                    </Field>
                  </div>
                  <p className="font-ui text-2xs leading-relaxed text-muted">{t("case.firHint")}</p>
                </div>
              )}

              <p className="rounded-xl bg-primary-soft px-3.5 py-3 font-ui text-2xs leading-relaxed text-text">{t("case.keySalted")}</p>

              {create.error && (
                <p role="alert" className="rounded-xl border border-danger-soft bg-danger-soft px-3 py-2.5 font-ui text-xs text-text">
                  {create.error.message}
                </p>
              )}

              <Button type="submit" full size="lg" disabled={!valid} loading={create.pending} icon={<FilePlus2 size={15} />}>
                {t("case.create")}
              </Button>
            </div>
          </Card>
        </div>
      </form>
    </>
  );
}
