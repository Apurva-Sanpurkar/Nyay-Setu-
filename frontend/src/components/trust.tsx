import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  ExternalLink,
  Fingerprint,
  MapPin,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import type { CustodyEventRow, Stage, SummonsStatus } from "../lib/api";
import { shortHash } from "../lib/hash";
import {
  STAGE_LABEL,
  STAGE_ORDER,
  ROLE_LABEL,
  formatDateTime,
  formatMetres,
  relativeTime,
} from "../lib/format";
import { CopyButton } from "./ui";

/**
 * The trust visualisation layer.
 *
 * The entire pitch of this project is that integrity becomes visible, so these
 * components carry more weight than ordinary chrome. Two rules they all follow:
 *
 *   - green is only ever used for something that was actually verified, never
 *     for "probably fine". An unanchored item is grey, not green.
 *   - colour never carries meaning alone. Every state has an icon and a word,
 *     because about one man in twelve cannot reliably separate red from green.
 */

/* ===================================================== StatusChip ======== */

type ChipTone = "success" | "danger" | "warning" | "info" | "neutral";

/**
 * Green means verified, orange means attention. Both come straight from the
 * logo, which is why the trust visualisation and the brand say the same thing
 * without anyone having to be told the mapping.
 */
const CHIP_TONE: Record<ChipTone, string> = {
  success: "border-success-soft bg-success-soft text-success",
  danger: "border-danger-soft bg-danger-soft text-danger",
  warning: "border-warning-soft bg-warning-soft text-warning",
  info: "border-info-soft bg-info-soft text-info",
  neutral: "border-border bg-surface-2 text-muted",
};

export function StatusChip({
  tone,
  label,
  icon,
  title,
}: {
  tone: ChipTone;
  label: string;
  icon?: React.ReactNode;
  title?: string;
}) {
  return (
    <span className={`chip ${CHIP_TONE[tone]}`} title={title}>
      {icon}
      {label}
    </span>
  );
}

export function SummonsStatusChip({ status }: { status: SummonsStatus }) {
  if (status === "DELIVERED") {
    return <StatusChip tone="success" label="Acknowledged" icon={<CheckCircle2 size={11} />} />;
  }
  if (status === "FAILED") {
    return <StatusChip tone="danger" label="Not delivered" icon={<XCircle size={11} />} />;
  }
  return <StatusChip tone="warning" label="Pending" icon={<Clock size={11} />} />;
}

export function StageChip({ stage }: { stage: Stage }) {
  return <StatusChip tone="info" label={STAGE_LABEL[stage]} icon={<MapPin size={11} />} />;
}

/**
 * The single most important badge in the product: did this item's hash match
 * what the chain says?
 *
 * `anchored` false means we have no chain record at all, which is shown as
 * "not anchored" in grey. Presenting that as verified would be the exact
 * failure mode this whole system exists to prevent.
 */
export function IntegrityBadge({
  anchored,
  verified,
  mismatchCount,
}: {
  anchored: boolean;
  verified?: boolean | null;
  mismatchCount?: number;
}) {
  if (!anchored) {
    return (
      <StatusChip
        tone="neutral"
        label="Not anchored"
        icon={<ShieldAlert size={11} />}
        title="This item has no on-chain record yet, so there is nothing to verify against."
      />
    );
  }
  if (verified === false) {
    return (
      <StatusChip
        tone="danger"
        label="Hash mismatch"
        icon={<XCircle size={11} />}
        title="The file does not match the digest registered on chain."
      />
    );
  }
  if (verified === true) {
    return (
      <StatusChip
        tone="success"
        label="Hash verified"
        icon={<ShieldCheck size={11} />}
        title="The file matches the digest registered on chain."
      />
    );
  }
  return (
    <StatusChip
      tone="info"
      label={
        mismatchCount && mismatchCount > 0
          ? `Anchored · ${mismatchCount} refused attempt${mismatchCount > 1 ? "s" : ""}`
          : "Anchored on chain"
      }
      icon={<Fingerprint size={11} />}
      title="Registered on chain. Run a verification to compare a file against it."
    />
  );
}

/* ======================================================= HashBadge ======= */

export function HashBadge({
  hash,
  label,
  tone = "neutral",
  full = false,
}: {
  hash: string | null | undefined;
  label?: string;
  tone?: "neutral" | "success" | "danger";
  full?: boolean;
}) {
  const border =
    tone === "success" ? "border-success-soft" : tone === "danger" ? "border-danger-soft" : "border-border";
  const text = tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "text-muted";

  return (
    <div className={`rounded-lg border ${border} bg-surface-2 px-3 py-2`}>
      {label && (
        <p className="mb-1 font-ui text-2xs font-semibold uppercase tracking-wider text-faint">{label}</p>
      )}
      <div className="flex items-center gap-2">
        <code className={`hash flex-1 ${text}`} title={hash ?? undefined}>
          {full ? (hash ?? "—") : shortHash(hash, 18, 10)}
        </code>
        {hash && <CopyButton value={hash} />}
      </div>
    </div>
  );
}

export function TxLink({ txHash, explorer }: { txHash?: string | null; explorer?: string | null }) {
  if (!txHash) return <span className="font-ui text-2xs text-faint">not anchored</span>;

  const content = (
    <>
      <code className="font-mono text-2xs">{shortHash(txHash, 10, 6)}</code>
      {explorer && <ExternalLink size={11} />}
    </>
  );

  if (!explorer) {
    // A local chain has no explorer, so show the hash without a dead link.
    return (
      <span
        className="inline-flex items-center gap-1.5 text-muted"
        title="Local chain: no public explorer for this transaction."
      >
        {content}
      </span>
    );
  }

  return (
    <a
      href={explorer}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1.5 text-primary transition hover:underline"
    >
      {content}
    </a>
  );
}

/* ================================================== CustodyTimeline ====== */

/**
 * The chain of custody, drawn as a vertical timeline.
 *
 * It shows the stages that have not happened yet in grey rather than hiding
 * them, because "where is this item now, and where should it be next" is the
 * question a prosecutor actually asks.
 */
export function CustodyTimeline({
  events,
  currentStage,
  onChainCount,
  consistent,
}: {
  events: CustodyEventRow[];
  currentStage: Stage;
  onChainCount?: number;
  consistent?: boolean;
}) {
  const reached = new Set(events.map((e) => e.to_stage));

  return (
    <div>
      {consistent === false && (
        <div
          role="alert"
          className="mb-4 flex gap-2.5 rounded-lg border border-danger-soft bg-danger-soft p-3"
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" />
          <p className="font-ui text-xs leading-relaxed text-text">
            The on-chain custody trail has {onChainCount} entries but this database has {events.length}.
            The chain is authoritative. Treat the difference as a finding, not a display bug.
          </p>
        </div>
      )}

      <ol className="relative space-y-0">
        {STAGE_ORDER.map((stage, index) => {
          const event = events.find((e) => e.to_stage === stage);
          const isReached = reached.has(stage);
          const isCurrent = stage === currentStage;
          const isLast = index === STAGE_ORDER.length - 1;

          return (
            <li key={stage} className="relative flex gap-4 pb-5 last:pb-0">
              {/* The connector, drawn only between nodes. */}
              {!isLast && (
                <span
                  aria-hidden="true"
                  className={`absolute left-[13px] top-7 h-[calc(100%-1.75rem)] w-px ${
                    isReached && reached.has(STAGE_ORDER[index + 1]) ? "bg-primary" : "bg-border"
                  }`}
                />
              )}

              <span
                className={`relative z-10 mt-0.5 grid h-[27px] w-[27px] shrink-0 place-items-center rounded-full border-2 transition ${
                  isCurrent
                    ? "border-primary bg-primary text-on-primary animate-pulse-ring"
                    : isReached
                      ? "border-primary bg-surface text-primary"
                      : "border-border bg-surface-2 text-faint"
                }`}
              >
                {isReached ? <CheckCircle2 size={13} /> : <span className="text-2xs font-bold">{index + 1}</span>}
              </span>

              <div className="min-w-0 flex-1 pt-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <p
                    className={`font-ui text-sm font-semibold ${
                      isReached ? "text-text" : "text-faint"
                    }`}
                  >
                    {STAGE_LABEL[stage]}
                  </p>
                  {isCurrent && <StatusChip tone="success" label="Current holder" />}
                  {!isReached && <span className="font-ui text-2xs text-faint">awaiting transfer</span>}
                </div>

                {event ? (
                  <div className="mt-1.5 space-y-1.5">
                    <p className="font-ui text-2xs text-muted">
                      {formatDateTime(event.occurred_at)} · {relativeTime(event.occurred_at)}
                      {event.actor_role && ` · confirmed by ${ROLE_LABEL[event.actor_role]}`}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-ui text-2xs text-faint">
                        hash confirmed <code className="font-mono">{shortHash(event.confirmed_hash, 12, 6)}</code>
                      </span>
                      <TxLink txHash={event.tx_hash} />
                      {event.block_number && (
                        <span className="font-ui text-2xs text-faint">block {event.block_number}</span>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="mt-1.5 font-ui text-2xs text-faint">
                    {index === 0
                      ? "Not yet registered."
                      : `Next: the receiving party re-hashes the item and confirms it matches.`}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* =================================================== ComplianceGauge ===== */

/**
 * A compliance score as an arc rather than a bar.
 *
 * The number alone is not enough for a court dashboard: 85 means nothing
 * without knowing that below 85 is a breach. So the band is drawn and named.
 */
export function ComplianceGauge({
  score,
  overdue,
  size = 132,
}: {
  score: number | null | undefined;
  overdue?: boolean;
  size?: number;
}) {
  const value = Math.max(0, Math.min(100, score ?? 0));
  const known = score !== null && score !== undefined;

  const stroke = 9;
  const radius = (size - stroke) / 2;
  // Three-quarter arc: a full circle reads as a pie chart, which this is not.
  const circumference = 2 * Math.PI * radius * 0.75;
  const filled = (value / 100) * circumference;

  const tone = !known ? "var(--text-faint)" : value >= 85 && !overdue ? "var(--success)" : value >= 60 ? "var(--warning)" : "var(--danger)";
  const label = !known ? "Unknown" : overdue ? "Overdue" : value >= 85 ? "Compliant" : value >= 60 ? "At risk" : "In breach";

  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-[135deg]">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--border)"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${circumference} ${circumference * 2}`}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={tone}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${filled} ${circumference * 2}`}
            style={{
              transition:
                "stroke-dasharray 0.9s cubic-bezier(0.22, 1, 0.36, 1), stroke 0.4s ease",
            }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-ui text-3xl font-bold tabular tracking-tight" style={{ color: tone }}>
            {known ? value : "—"}
          </span>
          <span className="font-ui text-2xs uppercase tracking-wider text-faint">of 100</span>
        </div>
      </div>
      <p
        className="mt-1 font-ui text-xs font-semibold uppercase tracking-wider"
        style={{ color: tone }}
      >
        {label}
      </p>
    </div>
  );
}

/* ================================================= ConditionList ========= */

export function ConditionList({
  conditions,
}: {
  conditions: { label: string; violated: boolean; tagHash?: string }[];
}) {
  return (
    <ul className="space-y-2">
      {conditions.map((condition, index) => (
        <li
          key={condition.tagHash ?? index}
          className={`flex items-start gap-2.5 rounded-lg border p-3 ${
            condition.violated ? "border-danger-soft bg-danger-soft" : "border-border bg-surface-2"
          }`}
        >
          {condition.violated ? (
            <XCircle size={15} className="mt-0.5 shrink-0 text-danger" />
          ) : (
            <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-success" />
          )}
          <div className="min-w-0 flex-1">
            <p className="font-ui text-xs leading-relaxed text-text">{condition.label}</p>
            <p className="mt-0.5 font-ui text-2xs font-semibold uppercase tracking-wider text-faint">
              {condition.violated ? "Breached" : "Met"}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ================================================== AnomalyNotice ======== */

export function AnomalyNotice({
  flagged,
  score,
  reasons,
  flagHash,
}: {
  flagged: boolean;
  score: number | null;
  reasons: string[];
  flagHash?: string | null;
}) {
  if (!flagged) {
    return (
      <div className="flex items-start gap-2.5 rounded-lg border border-success-soft bg-success-soft p-3">
        <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-success" />
        <p className="font-ui text-xs leading-relaxed text-text">
          Intake screening found nothing unusual
          {score !== null && ` (score ${score.toFixed(3)})`}.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-warning-soft bg-warning-soft p-3">
      <div className="flex items-start gap-2.5">
        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="font-ui text-xs font-semibold text-text">
            Flagged at intake{score !== null && ` · score ${score.toFixed(3)}`}
          </p>
          <ul className="mt-2 space-y-1">
            {reasons.map((reason, index) => (
              <li key={index} className="flex gap-1.5 font-ui text-2xs leading-relaxed text-muted">
                <ArrowRight size={11} className="mt-0.5 shrink-0" />
                {reason}
              </li>
            ))}
          </ul>
          {flagHash && (
            <p className="mt-2.5 font-ui text-2xs leading-relaxed text-faint">
              This verdict is anchored on chain and cannot be removed, by anyone. It is a prompt to
              look, not a finding of tampering.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
