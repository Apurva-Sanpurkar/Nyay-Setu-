import { useState } from "react";
import { CheckCircle2, FileText, Lock, PencilLine, XCircle, AlertTriangle } from "lucide-react";
import { api, type CaseRow, type TimelineEntry } from "../lib/api";
import { useQuery, useMutation } from "../lib/useApi";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { useI18n, type MessageKey } from "../i18n";
import { formatDate, formatDateTime } from "../lib/format";
import { Button, Card, Field, Input, Modal } from "./ui";
import { EmptyState, ErrorState, Loading } from "./DataState";

/**
 * Case-level panels for F1: the FIR, shown only to the roles that may read it,
 * and the case timeline — everything recorded against the case, refusals
 * included.
 */

const FIR_ROLES = ["police", "prosecutor", "judge", "court_admin"];

export function FirCard({ caseRow, onChanged }: { caseRow: CaseRow; onChanged: () => void }) {
  const { user } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const fir = caseRow.fir;
  const thisYear = new Date().getFullYear();
  const [form, setForm] = useState({
    number: fir?.number ?? "",
    year: String(fir?.year ?? thisYear),
    date: fir?.date ?? "",
    policeStation: fir?.policeStation ?? caseRow.police_station,
    district: fir?.district ?? "",
  });

  const canEdit = (user?.role === "police" && caseRow.access !== "read") || user?.role === "court_admin";
  const privileged = user ? FIR_ROLES.includes(user.role) : false;

  const save = useMutation(async () =>
    api.put(`/api/cases/${caseRow.id}/fir`, {
      number: form.number.trim(),
      year: Number(form.year),
      date: form.date || null,
      policeStation: form.policeStation.trim(),
      district: form.district.trim() || null,
    })
  );

  if (!fir) return null;

  return (
    <Card
      title={t("case.fir")}
      actions={
        canEdit ? (
          <Button size="sm" variant="ghost" icon={<PencilLine size={12} />} onClick={() => setOpen(true)}>
            {fir.linked ? t("case.editFir") : t("case.linkFir")}
          </Button>
        ) : undefined
      }
    >
      {!fir.linked ? (
        <p className="font-ui text-sm text-muted">{t("case.firNotLinked")}</p>
      ) : !privileged || !fir.number ? (
        <p className="flex gap-2 font-ui text-xs leading-relaxed text-muted">
          <Lock size={14} className="mt-0.5 shrink-0 text-faint" aria-hidden />
          {t("case.firWithheld")}
        </p>
      ) : (
        <dl className="space-y-2 font-ui text-xs">
          <div className="flex justify-between gap-3">
            <dt className="text-faint">{t("case.firNumber")}</dt>
            <dd className="font-mono text-text">{fir.number}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-faint">{t("case.firYear")}</dt>
            <dd className="text-text">{fir.year}</dd>
          </div>
          {fir.date && (
            <div className="flex justify-between gap-3">
              <dt className="text-faint">{t("case.firDate")}</dt>
              <dd className="text-text">{formatDate(fir.date)}</dd>
            </div>
          )}
          <div className="flex justify-between gap-3">
            <dt className="text-faint">{t("case.station")}</dt>
            <dd className="text-right text-text">{fir.policeStation}</dd>
          </div>
          {fir.backfilled && (
            <p className="mt-2 flex gap-1.5 rounded-lg bg-warning-soft px-2.5 py-1.5 text-2xs text-text">
              <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warning" aria-hidden />
              {t("case.firBackfilled")}
            </p>
          )}
        </dl>
      )}
      <p className="mt-3 font-ui text-2xs leading-relaxed text-faint">{t("case.firHint")}</p>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={fir.linked ? t("case.editFir") : t("case.linkFir")}
        description={t("case.firHint")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              loading={save.pending}
              disabled={!form.number.trim() || !form.year}
              onClick={async () => {
                const result = await save.run(undefined as never);
                if (result) {
                  toast.success(t("case.firLinked"));
                  setOpen(false);
                  onChanged();
                }
              }}
            >
              {t("common.save")}
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("case.firNumber")} required>
            <Input value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} placeholder="0042/2026" />
          </Field>
          <Field label={t("case.firYear")} required>
            <Input type="number" min={1950} max={thisYear} value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} />
          </Field>
          <Field label={t("case.firDate")}>
            <Input type="date" max={new Date().toISOString().slice(0, 10)} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </Field>
          <Field label={t("case.firDistrict")}>
            <Input value={form.district} onChange={(e) => setForm({ ...form, district: e.target.value })} />
          </Field>
          <div className="sm:col-span-2">
            <Field label={t("case.station")} required>
              <Input value={form.policeStation} onChange={(e) => setForm({ ...form, policeStation: e.target.value })} />
            </Field>
          </div>
        </div>
        {save.error && (
          <p role="alert" className="mt-3 font-ui text-xs text-danger">
            {save.error.message}
          </p>
        )}
      </Modal>
    </Card>
  );
}

const OUTCOME_ICON = {
  ok: <CheckCircle2 size={13} className="text-success" aria-hidden />,
  refused: <XCircle size={13} className="text-danger" aria-hidden />,
  failed: <AlertTriangle size={13} className="text-warning" aria-hidden />,
};

export function CaseTimelineCard({ caseId }: { caseId: string }) {
  const { t } = useI18n();
  const state = useQuery<{ entries: TimelineEntry[] }>(`/api/cases/${caseId}/timeline`);

  return (
    <Card title={t("case.timeline")}>
      {state.loading && !state.data ? (
        <Loading rows={3} />
      ) : state.error && !state.data ? (
        <ErrorState error={state.error} onRetry={state.refetch} context="case timeline" />
      ) : !state.data || state.data.entries.length === 0 ? (
        <EmptyState title={t("case.timelineEmpty")} icon={<FileText size={19} />} />
      ) : (
        <ol className="space-y-3 border-l-2 border-border pl-5">
          {[...state.data.entries].reverse().map((entry) => (
            <li key={entry.id} className="relative">
              <span className="absolute -left-[27px] top-0.5 grid h-4 w-4 place-items-center rounded-full border-2 border-surface bg-surface">
                {OUTCOME_ICON[entry.outcome]}
              </span>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <p className="font-ui text-sm font-medium text-text">{entry.label}</p>
                {entry.outcome !== "ok" && (
                  <span className={`font-ui text-2xs font-bold uppercase ${entry.outcome === "refused" ? "text-danger" : "text-warning"}`}>
                    {entry.outcome}
                  </span>
                )}
              </div>
              <p className="font-ui text-2xs text-faint">
                {formatDateTime(entry.at)}
                {entry.actorRole && ` · ${t(`role.${entry.actorRole}` as MessageKey)}`}
                {typeof entry.detail.state === "string" && ` · ${t(`state.short.${entry.detail.state}` as MessageKey)}`}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
