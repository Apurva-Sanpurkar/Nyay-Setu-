import { Brain, Link2, ShieldQuestion } from "lucide-react";
import { useQuery } from "../lib/useApi";
import { formatDateTime } from "../lib/format";
import { shortHash } from "../lib/hash";
import { AsyncView, EmptyState } from "./DataState";
import { Card } from "./ui";
import { TxLink } from "./trust";

/**
 * Every model output recorded against a case.
 *
 * WHY IT IS WORTH A PANEL
 *   The models already run — screening on every upload, risk at every bail grant —
 *   and each verdict is hashed and anchored so it cannot be revised afterwards.
 *   None of that was visible anywhere. A model whose outputs are invisible cannot
 *   be audited, and an anchored verdict nobody can see is a guarantee nobody can
 *   use.
 *
 * WHY THE LANGUAGE IS CAREFUL
 *   These are advisory. A risk band is not a finding of fact, a flagged exhibit is
 *   not an altered one, and a delay estimate is not a listing date. The panel says
 *   so rather than leaving a number to be read as a conclusion — which is exactly
 *   how statistical output gets misused in a proceeding.
 *
 *   The anchor is the part that matters evidentially: it means a verdict shown to a
 *   judge in March can be proved to be the verdict the model actually produced,
 *   rather than one reconstructed later to fit.
 */

interface Prediction {
  id: string;
  model: string;
  model_version: string;
  subject_type: string;
  subject_id: string;
  output: Record<string, unknown>;
  payload_hash: string;
  anchored_tx_hash: string | null;
  created_at: string;
}

const MODEL_LABEL: Record<string, { name: string; means: string }> = {
  evidence_anomaly: {
    name: "Evidence screening",
    means: "An indication to examine an exhibit. Not a finding that it was altered — the digest is the test of that.",
  },
  bail_risk: {
    name: "Bail risk",
    means: "Decision support for the judge at the moment of grant. Never a finding about the person.",
  },
  case_delay: {
    name: "Expected duration",
    means: "An estimate from declared distributions, with an interval. Not a listing date.",
  },
};

/** Renders whatever shape the model produced, without pretending to know it. */
function summarise(output: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ["band", "score", "anomaly", "flagged", "days", "reasons", "factors"]) {
    const value = output[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length) parts.push(value.slice(0, 2).join("; "));
    } else if (typeof value === "boolean") {
      parts.push(`${key}: ${value ? "yes" : "no"}`);
    } else {
      parts.push(`${key} ${value}`);
    }
  }
  return parts.join(" · ") || JSON.stringify(output).slice(0, 120);
}

export function CasePredictions({ caseId }: { caseId: string }) {
  const state = useQuery<{ predictions: Prediction[] }>(
    `/api/ai/case/${caseId}/predictions?limit=25`,
    [caseId]
  );

  return (
    <Card
      title="Model outputs"
      subtitle="Advisory, and anchored so a verdict cannot be revised after the fact."
    >
      <AsyncView
        state={state}
        onRetry={state.refetch}
        context="the model outputs"
        isEmpty={(data) => data.predictions.length === 0}
        empty={
          <EmptyState
            title="Nothing scored yet"
            description="Screening runs when evidence is registered; a risk band is produced when bail is granted."
            icon={<Brain size={19} />}
          />
        }
      >
        {(data) => (
          <ul className="space-y-2.5">
            {data.predictions.map((p) => {
              const meta = MODEL_LABEL[p.model];
              return (
                <li key={p.id} className="rounded-card border border-border bg-surface-2 p-3.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-ui text-xs font-semibold text-text">
                      {meta?.name ?? p.model}
                    </p>
                    <span className="font-ui text-3xs text-faint">
                      {p.model_version} · {formatDateTime(p.created_at)}
                    </span>
                  </div>

                  <p className="mt-1 font-ui text-xs leading-relaxed text-muted">
                    {summarise(p.output)}
                  </p>

                  {meta && (
                    <p className="mt-1.5 flex items-start gap-1.5 font-ui text-3xs leading-relaxed text-faint">
                      <ShieldQuestion size={10} className="mt-0.5 shrink-0" />
                      {meta.means}
                    </p>
                  )}

                  <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-border pt-2">
                    <span className="inline-flex items-center gap-1.5 font-mono text-3xs text-faint">
                      <Link2 size={10} />
                      {shortHash(p.payload_hash)}
                    </span>
                    {p.anchored_tx_hash ? (
                      <TxLink txHash={p.anchored_tx_hash} />
                    ) : (
                      <span className="font-ui text-3xs text-faint">not anchored</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </AsyncView>
    </Card>
  );
}
