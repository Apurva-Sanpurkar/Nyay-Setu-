import { CheckCircle2, ChevronRight, Circle, Lock } from "lucide-react";
import { api, ApiError, type Role } from "../lib/api";
import { useMutation } from "../lib/useApi";
import { useToast } from "../context/ToastContext";
import { useAuth } from "../context/AuthContext";
import { Card } from "./ui";

/**
 * Where a case has reached, and moving it on.
 *
 * WHY THIS EXISTS
 *   A case was registered and stayed "registered" forever. The API could change it;
 *   nothing in the interface could, so every case in the system looked like it had
 *   never been investigated. A dossier that cannot show progress is a dossier
 *   nobody trusts to be current.
 *
 * WHY IT IS A LADDER AND NOT A DROPDOWN
 *   These stages happen in order, and a dropdown invites skipping one or going
 *   backwards. Only the next stage is offered. Going back is not offered at all —
 *   if a case genuinely regresses, that is a decision with a reason, and the record
 *   should carry the reason rather than a silent edit.
 *
 * WHO CAN MOVE IT
 *   The API allows police, prosecutor, judge and the registry, and requires write
 *   access to the case. Defence counsel and the accused see the ladder and cannot
 *   touch it, which is the correct asymmetry: they are entitled to know where the
 *   case stands and not to change it.
 */

const STAGES = [
  { value: "registered", label: "Registered", note: "FIR on record" },
  { value: "under_investigation", label: "Under investigation", note: "Evidence being collected" },
  { value: "charge_sheeted", label: "Charge sheeted", note: "Final report filed" },
  { value: "trial", label: "Trial", note: "Before the court" },
  { value: "disposed", label: "Disposed", note: "Concluded" },
] as const;

const MAY_ADVANCE: Role[] = ["police", "prosecutor", "judge", "court_admin"];

export function CaseProgress({
  caseId,
  status,
  access,
  onChanged,
}: {
  caseId: string;
  status: string;
  /** The caller's access to this case. Read-only means the ladder is display only. */
  access?: "read" | "write";
  onChanged: () => void;
}) {
  const toast = useToast();
  const { user } = useAuth();

  const advance = useMutation(async (next: string) =>
    api.patch(`/api/cases/${caseId}/status`, { status: next })
  );

  const currentIndex = STAGES.findIndex((s) => s.value === status);
  const next = currentIndex >= 0 && currentIndex < STAGES.length - 1 ? STAGES[currentIndex + 1] : null;

  const mayAdvance =
    Boolean(user && MAY_ADVANCE.includes(user.role)) && access !== "read" && next !== null;

  return (
    <Card
      title="Progress"
      subtitle="Stages run in order. Only the next one is offered, and there is no way back — a case that regresses is a decision, not an edit."
    >
      <ol className="space-y-0">
        {STAGES.map((stage, index) => {
          const done = currentIndex >= 0 && index < currentIndex;
          const current = index === currentIndex;

          return (
            <li key={stage.value} className="flex gap-3">
              <div className="flex flex-col items-center">
                {done ? (
                  <CheckCircle2 size={16} className="shrink-0 text-primary" />
                ) : current ? (
                  <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full border-2 border-primary">
                    <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                  </span>
                ) : (
                  <Circle size={16} className="shrink-0 text-border-strong" />
                )}
                {index < STAGES.length - 1 && (
                  <span
                    className={`my-0.5 w-0.5 flex-1 ${done ? "bg-primary" : "bg-border"}`}
                    style={{ minHeight: 18 }}
                  />
                )}
              </div>

              <div className="min-w-0 pb-3">
                <p
                  className={`font-ui text-xs ${
                    current
                      ? "font-semibold text-text"
                      : done
                        ? "font-medium text-muted"
                        : "text-faint"
                  }`}
                >
                  {stage.label}
                </p>
                <p className="font-ui text-2xs leading-relaxed text-faint">{stage.note}</p>
              </div>
            </li>
          );
        })}
      </ol>

      {next && mayAdvance && (
        <button
          type="button"
          disabled={advance.pending}
          onClick={async () => {
            const outcome = await advance.run(next.value);
            if (outcome) {
              toast.success(`Moved to ${next.label.toLowerCase()}`);
              onChanged();
            } else if (advance.error) {
              toast.error(
                "Could not move the case on",
                advance.error instanceof ApiError ? advance.error.message : undefined
              );
            }
          }}
          className="mt-1 flex w-full items-center justify-between gap-2 rounded-card border border-border bg-surface-2 px-3.5 py-2.5 text-left transition hover:border-primary disabled:opacity-50"
        >
          <span>
            <span className="block font-ui text-2xs uppercase tracking-wider text-faint">
              Move to
            </span>
            <span className="block font-ui text-sm font-semibold text-text">{next.label}</span>
          </span>
          <ChevronRight size={16} className="shrink-0 text-primary" />
        </button>
      )}

      {next && !mayAdvance && (
        <p className="mt-1 flex items-start gap-2 font-ui text-2xs leading-relaxed text-faint">
          <Lock size={11} className="mt-0.5 shrink-0" />
          {access === "read"
            ? "You have read-only access to this case."
            : "Your role does not move a case between stages."}
        </p>
      )}

      {!next && currentIndex >= 0 && (
        <p className="mt-1 font-ui text-2xs leading-relaxed text-muted">
          This case is concluded. Nothing here is deleted — the evidence, its custody
          trail and every anchored digest remain readable.
        </p>
      )}
    </Card>
  );
}
