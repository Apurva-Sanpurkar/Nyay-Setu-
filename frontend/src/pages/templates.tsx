import { useEffect, useState } from "react";
import { FileText, Plus, Save, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { useMutation, useQuery } from "../lib/useApi";
import { useToast } from "../context/ToastContext";
import { useI18n } from "../i18n";
import { formatDateTime } from "../lib/format";
import { AsyncView, EmptyState } from "../components/DataState";
import { Button, Card, Field, Input, PageHeader, Textarea } from "../components/ui";

/**
 * Document templates (2.0 · F11). The court registry edits the wording of the
 * Section 63 certificate and the forms without a code change; every save is a
 * new version, and the footer must keep saying the document is a template.
 */

interface Template {
  template_key: string;
  title: string;
  sections: { heading: string; body: string }[];
  footer: string;
  version: number;
  updated_at?: string;
}

export function TemplatesPage() {
  const { t } = useI18n();
  const toast = useToast();
  const list = useQuery<{ templates: Template[] }>("/api/templates");
  const [key, setKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<Template | null>(null);

  useEffect(() => {
    const templates = list.data?.templates ?? [];
    if (!key && templates.length) setKey(templates[0].template_key);
  }, [list.data, key]);
  useEffect(() => {
    const found = list.data?.templates.find((tpl) => tpl.template_key === key) ?? null;
    setDraft(found ? structuredClone(found) : null);
  }, [key, list.data]);

  const save = useMutation(async (tpl: Template) =>
    api.put<{ template: Template }>(`/api/templates/${tpl.template_key}`, {
      title: tpl.title.trim(),
      sections: tpl.sections.map((s) => ({ heading: s.heading.trim(), body: s.body })),
      footer: tpl.footer.trim(),
    })
  );

  const placeholders = draft ? [...new Set(draft.sections.flatMap((s) => s.body.match(/\{\w+\}/g) ?? []))] : [];

  return (
    <>
      <PageHeader eyebrow={t("nav.templates")} title={t("tpl.title")} description={t("tpl.intro")} />
      <AsyncView state={list} onRetry={list.refetch} context="templates" isEmpty={(d) => d.templates.length === 0} empty={<EmptyState title={t("tpl.none")} description={t("tpl.noneHint")} icon={<FileText size={19} />} />}>
        {(data) => (
          <div className="grid gap-5 lg:grid-cols-[16rem_1fr]">
            <nav aria-label={t("tpl.title")} className="space-y-1.5">
              {data.templates.map((tpl) => (
                <button
                  key={tpl.template_key}
                  type="button"
                  onClick={() => setKey(tpl.template_key)}
                  className={`block w-full rounded-xl border px-3.5 py-2.5 text-left transition ${tpl.template_key === key ? "border-primary bg-primary-soft" : "border-border bg-surface hover:border-primary-ring"}`}
                >
                  <p className="font-ui text-xs font-semibold text-text">{tpl.title}</p>
                  <p className="font-mono text-2xs text-muted">
                    {tpl.template_key} · v{tpl.version}
                  </p>
                </button>
              ))}
            </nav>
            {draft && (
              <Card
                title={`${draft.template_key} · v${draft.version}`}
                subtitle={draft.updated_at ? `${t("tpl.updated")} ${formatDateTime(draft.updated_at)}` : undefined}
                actions={
                  <Button
                    size="sm"
                    icon={<Save size={13} />}
                    loading={save.pending}
                    onClick={async () => {
                      const out = await save.run(draft);
                      if (out) {
                        toast.success(t("tpl.saved", { n: out.template.version }));
                        list.refetch();
                      }
                    }}
                  >
                    {t("tpl.save")}
                  </Button>
                }
              >
                <div className="space-y-4">
                  <Field label={t("court.eventTitle")} required>
                    <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                  </Field>
                  {draft.sections.map((section, i) => (
                    <div key={i} className="space-y-2 rounded-xl border border-border bg-surface-2 p-3.5">
                      <div className="flex items-center gap-2">
                        <Input
                          aria-label={`${t("tpl.heading")} ${i + 1}`}
                          value={section.heading}
                          onChange={(e) => setDraft({ ...draft, sections: draft.sections.map((s, j) => (j === i ? { ...s, heading: e.target.value } : s)) })}
                        />
                        <button
                          type="button"
                          aria-label={t("tpl.removeSection")}
                          disabled={draft.sections.length <= 1}
                          className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-border text-muted hover:text-danger disabled:opacity-40"
                          onClick={() => setDraft({ ...draft, sections: draft.sections.filter((_, j) => j !== i) })}
                        >
                          <Trash2 size={14} aria-hidden />
                        </button>
                      </div>
                      <Textarea
                        aria-label={`${t("tpl.body")} ${i + 1}`}
                        rows={4}
                        value={section.body}
                        onChange={(e) => setDraft({ ...draft, sections: draft.sections.map((s, j) => (j === i ? { ...s, body: e.target.value } : s)) })}
                      />
                    </div>
                  ))}
                  <Button size="sm" variant="ghost" icon={<Plus size={12} />} disabled={draft.sections.length >= 30} onClick={() => setDraft({ ...draft, sections: [...draft.sections, { heading: "", body: "" }] })}>
                    {t("tpl.addSection")}
                  </Button>
                  <Field label={t("tpl.footer")} required hint={t("tpl.footerHint")}>
                    <Textarea rows={2} value={draft.footer} onChange={(e) => setDraft({ ...draft, footer: e.target.value })} />
                  </Field>
                  {placeholders.length > 0 && (
                    <div>
                      <p className="mb-1 font-ui text-2xs font-semibold text-muted">{t("tpl.placeholders")}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {placeholders.map((p) => (
                          <code key={p} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-2xs text-text">
                            {p}
                          </code>
                        ))}
                      </div>
                    </div>
                  )}
                  {save.error && <p role="alert" className="font-ui text-xs text-danger">{save.error.message}</p>}
                </div>
              </Card>
            )}
          </div>
        )}
      </AsyncView>
    </>
  );
}
