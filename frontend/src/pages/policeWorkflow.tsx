import { useEffect, useMemo, useState } from "react";
import { Boxes, Download, Package, Plus, Trash2 } from "lucide-react";
import { api, type CaseRow, type EvidenceRow, type Verification } from "../lib/api";
import { useQuery, useMutation } from "../lib/useApi";
import { useToast } from "../context/ToastContext";
import { useI18n, type MessageKey } from "../i18n";
import { formatDateTime, relativeTime } from "../lib/format";
import { fetchDocument } from "../lib/download";
import { AsyncView, EmptyState } from "../components/DataState";
import { Button, Card, Checkbox, Field, Input, PageHeader, Select, Textarea } from "../components/ui";
import { VerificationBadge } from "../components/verification";

/** Police workflow screens (2.0 · F13): seizures and the malkhana register. */

function useWritableCases() {
  const cases = useQuery<{ cases: CaseRow[] }>("/api/cases");
  const writable = useMemo(() => (cases.data?.cases ?? []).filter((c) => c.access !== "read"), [cases.data]);
  return { cases, writable };
}

function CaseSelect({ value, onChange, cases }: { value: string; onChange: (id: string) => void; cases: CaseRow[] }) {
  const { t } = useI18n();
  return (
    <Field label={t("capture.case")} required>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t("capture.selectCase")}</option>
        {cases.map((c) => (
          <option key={c.id} value={c.id}>
            {c.case_reference} — {c.title}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/* ================================================================ seizures */

interface SeizureView {
  id: string;
  memo_number: string;
  memo_digest: string | null;
  seized_at: string;
  place: string | null;
  seized_from: string | null;
  witnesses: { name: string; address?: string }[];
  items: { item_index: number; item_label: string; description: string | null; evidence: { public_ref: string; file_hash: string; file_name: string } | null }[];
}

export function SeizuresPage() {
  const { t } = useI18n();
  const toast = useToast();
  const { writable } = useWritableCases();
  const [caseId, setCaseId] = useState("");
  useEffect(() => {
    if (!caseId && writable.length === 1) setCaseId(writable[0].id);
  }, [writable, caseId]);

  const evidence = useQuery<{ items: EvidenceRow[] }>(caseId ? `/api/evidence/case/${caseId}` : null, [caseId]);
  const seizures = useQuery<{ seizures: SeizureView[] }>(caseId ? `/api/police/cases/${caseId}/seizures` : null, [caseId]);
  const taken = new Set((seizures.data?.seizures ?? []).flatMap((s) => s.items.map((i) => i.evidence?.public_ref)));
  const available = (evidence.data?.items ?? []).filter((e) => !taken.has(e.public_ref));

  const [form, setForm] = useState({ memoNumber: "", seizedAt: new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16), place: "", seizedFrom: "", notes: "" });
  const [witnesses, setWitnesses] = useState([{ name: "", address: "" }, { name: "", address: "" }]);
  const [items, setItems] = useState<Record<string, { label: string; description: string } | undefined>>({});
  const chosen = Object.entries(items).filter(([, v]) => v) as [string, { label: string; description: string }][];

  const create = useMutation(async () =>
    api.post("/api/police/seizures", {
      caseId,
      memoNumber: form.memoNumber.trim(),
      seizedAt: new Date(form.seizedAt).toISOString(),
      place: form.place.trim(),
      seizedFrom: form.seizedFrom.trim() || null,
      notes: form.notes.trim() || null,
      witnesses: witnesses.filter((w) => w.name.trim().length >= 2).map((w) => ({ name: w.name.trim(), ...(w.address.trim() ? { address: w.address.trim() } : {}) })),
      items: chosen.map(([evidenceId, v]) => ({ evidenceId, label: v.label.trim(), description: v.description.trim() || null })),
    })
  );

  const valid = caseId && form.memoNumber.trim() && form.place.trim().length >= 3 && chosen.length > 0 && chosen.every(([, v]) => v.label.trim());

  return (
    <>
      <PageHeader eyebrow={t("nav.seizures")} title={t("seizure.title")} description={t("seizure.intro")} />
      <div className="grid gap-5 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-5">
          <Card title={t("seizure.new")}>
            <div className="space-y-4">
              <CaseSelect value={caseId} onChange={setCaseId} cases={writable} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("seizure.memoNumber")} required>
                  <Input value={form.memoNumber} onChange={(e) => setForm({ ...form, memoNumber: e.target.value })} placeholder="SZ-17/2026" />
                </Field>
                <Field label={t("seizure.seizedAt")} required>
                  <Input type="datetime-local" value={form.seizedAt} onChange={(e) => setForm({ ...form, seizedAt: e.target.value })} />
                </Field>
              </div>
              <Field label={t("seizure.place")} required hint={t("seizure.offChain")}>
                <Input value={form.place} onChange={(e) => setForm({ ...form, place: e.target.value })} />
              </Field>
              <Field label={t("seizure.seizedFrom")}>
                <Input value={form.seizedFrom} onChange={(e) => setForm({ ...form, seizedFrom: e.target.value })} />
              </Field>

              <div className="space-y-2 rounded-xl border border-border bg-surface-2 p-4">
                <p className="font-ui text-sm font-semibold text-text">{t("capture.witnesses")}</p>
                {witnesses.map((w, i) => (
                  <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                    <Input aria-label={`${t("capture.witnessName")} ${i + 1}`} placeholder={t("capture.witnessName")} value={w.name} onChange={(e) => setWitnesses(witnesses.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                    <Input aria-label={`${t("seizure.witnessAddress")} ${i + 1}`} placeholder={t("seizure.witnessAddress")} value={w.address} onChange={(e) => setWitnesses(witnesses.map((x, j) => (j === i ? { ...x, address: e.target.value } : x)))} />
                    <button type="button" aria-label={t("capture.discard")} className="grid h-10 w-10 place-items-center rounded-xl border border-border text-muted hover:text-danger" onClick={() => setWitnesses(witnesses.filter((_, j) => j !== i))}>
                      <Trash2 size={14} aria-hidden />
                    </button>
                  </div>
                ))}
                <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => setWitnesses([...witnesses, { name: "", address: "" }])}>
                  {t("capture.addWitness")}
                </Button>
              </div>

              <div className="space-y-2">
                <p className="font-ui text-sm font-semibold text-text">{t("seizure.items")}</p>
                <p className="font-ui text-2xs text-muted">{t("seizure.itemsHint")}</p>
                {!caseId ? null : available.length === 0 ? (
                  <p className="font-ui text-xs text-muted">{t("seizure.noItems")}</p>
                ) : (
                  available.map((e) => {
                    const entry = items[e.id];
                    return (
                      <div key={e.id} className={`rounded-xl border p-3 ${entry ? "border-primary bg-primary-soft" : "border-border bg-surface"}`}>
                        <Checkbox
                          label={e.file_name}
                          description={`${e.public_ref} · ${relativeTime(e.collected_at)}`}
                          checked={Boolean(entry)}
                          onChange={(on) => setItems({ ...items, [e.id]: on ? { label: "", description: "" } : undefined })}
                        />
                        {entry && (
                          <div className="mt-2 grid gap-2 sm:grid-cols-2">
                            <Input aria-label={t("seizure.itemLabel")} placeholder={t("seizure.itemLabel")} value={entry.label} onChange={(ev) => setItems({ ...items, [e.id]: { ...entry, label: ev.target.value } })} />
                            <Input aria-label={t("seizure.itemDescription")} placeholder={t("seizure.itemDescription")} value={entry.description} onChange={(ev) => setItems({ ...items, [e.id]: { ...entry, description: ev.target.value } })} />
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
              <Field label={t("capture.notes")}>
                <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </Field>
              {create.error && <p role="alert" className="font-ui text-xs text-danger">{create.error.message}</p>}
              <Button
                full
                icon={<Package size={14} />}
                disabled={!valid}
                loading={create.pending}
                onClick={async () => {
                  if (await create.run(undefined as never)) {
                    toast.success(t("seizure.created"));
                    setItems({});
                    setForm({ ...form, memoNumber: "", place: "", seizedFrom: "", notes: "" });
                    seizures.refetch();
                  }
                }}
              >
                {t("seizure.create")}
              </Button>
            </div>
          </Card>
        </div>

        <Card title={t("seizure.list")}>
          {!caseId ? (
            <EmptyState title={t("capture.selectCase")} icon={<Package size={19} />} />
          ) : (
            <AsyncView state={seizures} onRetry={seizures.refetch} context="seizures" isEmpty={(d) => d.seizures.length === 0} empty={<EmptyState title={t("seizure.none")} icon={<Package size={19} />} />}>
              {(data) => (
                <ul className="space-y-3">
                  {data.seizures.map((s) => (
                    <li key={s.id} className="rounded-xl border border-border bg-surface-2 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="font-ui text-sm font-semibold text-text">{s.memo_number}</p>
                          <p className="font-ui text-2xs text-muted">{formatDateTime(s.seized_at)} · {s.place ?? t("seizure.withheld")}</p>
                        </div>
                        <Button size="sm" variant="secondary" icon={<Download size={12} />} onClick={() => void fetchDocument(`/api/police/seizures/${s.id}/memo.pdf`, { fileName: `seizure-${s.memo_number}.pdf`, open: true })}>
                          {t("seizure.memoPdf")}
                        </Button>
                      </div>
                      <ol className="mt-3 space-y-1">
                        {s.items.map((i) => (
                          <li key={i.item_index} className="font-ui text-xs text-text">
                            {i.item_index}. {i.item_label}
                            {i.description ? ` — ${i.description}` : ""} <code className="font-mono text-2xs text-faint">{i.evidence?.public_ref}</code>
                          </li>
                        ))}
                      </ol>
                    </li>
                  ))}
                </ul>
              )}
            </AsyncView>
          )}
        </Card>
      </div>
    </>
  );
}

/* ================================================================ malkhana */

interface RegisterRow {
  evidence: { id: string; file_name: string; public_ref: string; kind: string; cases?: { case_reference: string } } | null;
  onShelf: boolean;
  location: string;
  shelf: string | null;
  lastMovement: string;
  lastReason: string;
  since: string;
}

export function MalkhanaPage() {
  const { t } = useI18n();
  const toast = useToast();
  const { writable } = useWritableCases();
  const register = useQuery<{ items: RegisterRow[] }>("/api/police/malkhana");
  const [caseId, setCaseId] = useState("");
  const evidence = useQuery<{ items: EvidenceRow[] }>(caseId ? `/api/evidence/case/${caseId}` : null, [caseId]);
  const [evidenceId, setEvidenceId] = useState("");
  const history = useQuery<{ movements: { id: string; movement: string; location: string; shelf: string | null; reason: string; occurred_at: string; verification: Verification | null }[] }>(
    evidenceId ? `/api/police/evidence/${evidenceId}/malkhana` : null,
    [evidenceId]
  );
  const [form, setForm] = useState({ movement: "IN", location: "", shelf: "", reason: "", counterparty: "" });

  const record = useMutation(async () =>
    api.post(`/api/police/evidence/${evidenceId}/malkhana`, {
      movement: form.movement,
      location: form.location.trim(),
      shelf: form.shelf.trim() || null,
      reason: form.reason.trim(),
      counterparty: form.counterparty.trim() || null,
    })
  );

  return (
    <>
      <PageHeader eyebrow={t("nav.malkhana")} title={t("malkhana.title")} description={t("malkhana.intro")} />
      <div className="grid gap-5 lg:grid-cols-[1fr_1.2fr]">
        <Card title={t("malkhana.record")}>
          <div className="space-y-4">
            <CaseSelect value={caseId} onChange={(id) => { setCaseId(id); setEvidenceId(""); }} cases={writable} />
            <Field label={t("malkhana.item")} required>
              <Select value={evidenceId} onChange={(e) => setEvidenceId(e.target.value)} disabled={!caseId}>
                <option value="">{t("malkhana.chooseItem")}</option>
                {(evidence.data?.items ?? []).map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.public_ref} — {e.file_name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("malkhana.movement")} required>
                <Select value={form.movement} onChange={(e) => setForm({ ...form, movement: e.target.value })}>
                  {["IN", "OUT", "RETURN", "TRANSFER"].map((m) => (
                    <option key={m} value={m}>
                      {t(`malkhana.movement.${m}` as MessageKey)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("malkhana.shelf")}>
                <Input value={form.shelf} onChange={(e) => setForm({ ...form, shelf: e.target.value })} placeholder="R2-S4" />
              </Field>
            </div>
            <Field label={t("malkhana.location")} required>
              <Input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
            </Field>
            <Field label={t("malkhana.reason")} required>
              <Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
            </Field>
            <Field label={t("malkhana.counterparty")}>
              <Input value={form.counterparty} onChange={(e) => setForm({ ...form, counterparty: e.target.value })} />
            </Field>
            {record.error && <p role="alert" className="font-ui text-xs text-danger">{record.error.message}</p>}
            <Button
              full
              icon={<Boxes size={14} />}
              disabled={!evidenceId || form.location.trim().length < 2 || form.reason.trim().length < 3}
              loading={record.pending}
              onClick={async () => {
                if (await record.run(undefined as never)) {
                  toast.success(t("malkhana.recorded"));
                  setForm({ ...form, reason: "", counterparty: "" });
                  history.refetch();
                  register.refetch();
                }
              }}
            >
              {t("malkhana.record")}
            </Button>
            {evidenceId && history.data && (
              <ol className="space-y-2 border-l-2 border-border pl-4">
                {history.data.movements.map((m) => (
                  <li key={m.id}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-ui text-xs font-semibold text-text">{t(`malkhana.movement.${m.movement}` as MessageKey)}</span>
                      {m.verification && <VerificationBadge state={m.verification.state} short />}
                    </div>
                    <p className="font-ui text-2xs text-muted">
                      {m.location}
                      {m.shelf ? ` / ${m.shelf}` : ""} · {m.reason} · {formatDateTime(m.occurred_at)}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </Card>

        <Card title={t("malkhana.register")}>
          <AsyncView state={register} onRetry={register.refetch} context="malkhana register" isEmpty={(d) => d.items.length === 0} empty={<EmptyState title={t("malkhana.none")} icon={<Boxes size={19} />} />}>
            {(data) => (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] font-ui text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-2xs uppercase tracking-wider text-faint">
                      <th className="py-2 pr-3">{t("malkhana.item")}</th>
                      <th className="py-2 pr-3">{t("malkhana.where")}</th>
                      <th className="py-2 pr-3">{t("malkhana.movement")}</th>
                      <th className="py-2">{t("malkhana.since")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((row, i) => (
                      <tr key={i} className="border-b border-border last:border-0">
                        <td className="py-2.5 pr-3">
                          <p className="text-text">{row.evidence?.file_name}</p>
                          <code className="font-mono text-2xs text-faint">{row.evidence?.public_ref}</code>
                        </td>
                        <td className="py-2.5 pr-3 text-text">
                          {row.onShelf ? `${row.location}${row.shelf ? ` / ${row.shelf}` : ""}` : <span className="text-warning">{t("malkhana.offShelf")}</span>}
                        </td>
                        <td className="py-2.5 pr-3 text-muted">{t(`malkhana.movement.${row.lastMovement}` as MessageKey)}</td>
                        <td className="py-2.5 text-muted">{relativeTime(row.since)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </AsyncView>
        </Card>
      </div>
    </>
  );
}
