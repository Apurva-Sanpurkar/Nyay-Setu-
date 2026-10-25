import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  MapPin,
  Scale,
  ScrollText,
  ShieldCheck,
  Timer,
} from "lucide-react";
import { api, type BailRow, type CheckInRow, type OtpDispatch, type SummonsRow, type ViolationRow } from "../lib/api";
import { useMutation, useQuery, useTicker } from "../lib/useApi";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { formatDateTime, formatDuration, formatMetres, violationLabel } from "../lib/format";
import { AsyncView, EmptyState } from "../components/DataState";
import { Button, Card, LinkButton, PageHeader, Stat } from "../components/ui";
import { GpsCapture, OtpPanel } from "../components/capture";
import { NotificationsCard, ObligationsCard } from "./court";
import { ComplianceGauge, ConditionList, StatusChip, SummonsStatusChip, TxLink } from "../components/trust";
import { deviceHint, type Fix } from "../lib/geo";

/* ==================================================== AccusedHome ======== */

/**
 * What a citizen actually needs: what is required of me, and by when.
 *
 * Written in the second person and without legal jargon, because the audience is
 * not a lawyer. Where a deadline exists it is shown as a countdown, not a date,
 * since "17 hours left" is actionable in a way that a timestamp is not.
 */
export function AccusedHome() {
  const { user } = useAuth();
  const summons = useQuery<{ summons: SummonsRow[] }>("/api/summons/inbox", [], { pollMs: 60_000 });
  const bail = useQuery<{ orders: (BailRow & { live?: any })[] }>("/api/bail/mine", [], { pollMs: 60_000 });
  const surety = useQuery<{ orders: any[] }>("/api/bail/surety");
  useTicker(30_000);

  const pending = (summons.data?.summons ?? []).filter((row) => row.status === "PENDING");
  const orders = bail.data?.orders ?? [];
  const overdue = orders.filter((order) => order.live?.overdue);

  if (!user?.hasAadhaarToken) {
    return (
      <>
        <PageHeader title="Your obligations" />
        <Card title="Your record is incomplete">
          <div className="flex gap-3">
            <AlertTriangle size={19} className="mt-0.5 shrink-0 text-warning" />
            <div>
              <p className="font-ui text-sm leading-relaxed text-text">
                Your account has no Aadhaar token on file, so you cannot acknowledge a summons or file
                a bail check-in. Both are authenticated with a one-time code sent to the mobile
                registered against your Aadhaar.
              </p>
              <p className="mt-2 font-ui text-xs leading-relaxed text-muted">
                Ask the court registry to complete your record. Your Aadhaar number itself is never
                stored: it is converted to a one-way token and discarded.
              </p>
            </div>
          </div>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Your obligations"
        title={`Welcome, ${user.fullName.split(" ")[0]}`}
        description="Everything the court currently requires of you, with the deadline for each."
      />

      {/* Anything urgent goes above the routine content. */}
      {(pending.length > 0 || overdue.length > 0) && (
        <div className="mb-6 space-y-3">
          {pending.map((row) => {
            const secondsLeft = Math.max(0, (new Date(row.expiry_at).getTime() - Date.now()) / 1000);
            return (
              <div key={row.id} className="panel border-warning-soft p-5">
                <div className="flex items-start gap-3">
                  <ScrollText size={19} className="mt-0.5 shrink-0 text-warning" />
                  <div className="min-w-0 flex-1">
                    <h2 className="font-display text-lg leading-tight text-text">
                      You have a summons to acknowledge
                    </h2>
                    <p className="mt-1.5 font-ui text-xs leading-relaxed text-muted">
                      {row.cases?.court_name ?? "The court"} in {row.cases?.case_reference}.{" "}
                      <strong className="text-text">{formatDuration(secondsLeft)} left.</strong> If the
                      window closes without your acknowledgement, the court is told it could not be
                      served and may proceed on that basis.
                    </p>
                    <LinkButton to="/accused/summons" size="sm" className="mt-3">
                      Acknowledge it now
                    </LinkButton>
                  </div>
                </div>
              </div>
            );
          })}

          {overdue.map((order) => (
            <div key={order.id} className="panel border-danger-soft p-5">
              <div className="flex items-start gap-3">
                <Timer size={19} className="mt-0.5 shrink-0 text-danger" />
                <div className="min-w-0 flex-1">
                  <h2 className="font-display text-lg leading-tight text-text">
                    Your bail check-in is overdue
                  </h2>
                  <p className="mt-1.5 font-ui text-xs leading-relaxed text-muted">
                    A missed check-in is recorded as a breach and reduces your compliance score. File
                    it as soon as you can.
                  </p>
                  <LinkButton to="/accused/checkin" size="sm" className="mt-3">
                    Check in now
                  </LinkButton>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Summons" subtitle="Court notices addressed to you.">
          <AsyncView
            state={summons}
            onRetry={summons.refetch}
            context="your summons"
            isEmpty={(data) => data.summons.length === 0}
            empty={
              <EmptyState
                title="Nothing to acknowledge"
                description="You have no outstanding court notices."
                icon={<CheckCircle2 size={19} />}
              />
            }
          >
            {(data) => (
              <ul className="space-y-2.5">
                {data.summons.map((row) => (
                  <li
                    key={row.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-3.5 py-3"
                  >
                    <div className="min-w-0">
                      <p className="font-ui text-sm font-medium text-text">{row.cases?.case_reference}</p>
                      <p className="mt-0.5 font-ui text-2xs text-muted">
                        {row.hearing_at ? `Hearing ${formatDateTime(row.hearing_at)}` : "No hearing date set"}
                      </p>
                    </div>
                    <SummonsStatusChip status={row.status} />
                  </li>
                ))}
              </ul>
            )}
          </AsyncView>
        </Card>

        <Card title="Bail" subtitle="Your conditions and how you are tracking against them.">
          <AsyncView
            state={bail}
            onRetry={bail.refetch}
            context="your bail orders"
            isEmpty={(data) => data.orders.length === 0}
            empty={
              <EmptyState
                title="No active bail order"
                description="Nothing to check in for."
                icon={<Scale size={19} />}
              />
            }
          >
            {(data) => (
              <div className="space-y-4">
                {data.orders.map((order) => (
                  <div key={order.id}>
                    <div className="flex justify-center">
                      <ComplianceGauge
                        score={order.live?.score ?? order.compliance_score}
                        overdue={order.live?.overdue}
                        size={118}
                      />
                    </div>
                    <dl className="mt-3 space-y-2">
                      <Row label="Case" value={order.cases?.case_reference ?? "—"} />
                      <Row
                        label="Next check-in"
                        value={
                          order.live
                            ? order.live.overdue
                              ? "overdue"
                              : formatDuration(order.live.secondsUntilNextCheckIn)
                            : "—"
                        }
                      />
                      <Row
                        label="Stay within"
                        value={order.radius_metres ? formatMetres(order.radius_metres) : "no restriction"}
                      />
                      <Row label="Until" value={formatDateTime(order.expiry_at)} />
                    </dl>
                    <LinkButton to="/accused/checkin" full variant="secondary" size="sm" className="mt-3">
                      Check in
                    </LinkButton>
                  </div>
                ))}
              </div>
            )}
          </AsyncView>
        </Card>
      </div>

      {/* The surety view. Present only for an account that guarantees somebody. */}
      {(surety.data?.orders.length ?? 0) > 0 && (
        <Card
          className="mt-5"
          title="Orders you are surety for"
          subtitle="Compliance only. You cannot see the case file, the order text or the movement history."
        >
          <ul className="space-y-2.5">
            {surety.data!.orders.map((order) => (
              <li
                key={order.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-3.5 py-3"
              >
                <div className="min-w-0">
                  <p className="font-ui text-sm font-medium text-text">{order.accusedName}</p>
                  <p className="mt-0.5 font-ui text-2xs text-muted">
                    {order.firNumber} · until {formatDateTime(order.expiryAt)}
                  </p>
                </div>
                <StatusChip
                  tone={order.complianceScore >= 85 && !order.overdue ? "success" : "danger"}
                  label={`Score ${order.complianceScore}`}
                />
              </li>
            ))}
          </ul>
        </Card>
      )}
      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <ObligationsCard />
        <NotificationsCard />
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="font-ui text-2xs uppercase tracking-wider text-faint">{label}</dt>
      <dd className="text-right font-ui text-xs font-medium text-text">{value}</dd>
    </div>
  );
}

/* ================================================== SummonsInbox ========= */

export function AccusedSummons() {
  const toast = useToast();
  const inbox = useQuery<{ summons: SummonsRow[] }>("/api/summons/inbox");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dispatch, setDispatch] = useState<OtpDispatch | null>(null);
  const [fix, setFix] = useState<Fix | null>(null);
  useTicker(30_000);

  const requestOtp = useMutation(async (summonsId: string) =>
    api.post<OtpDispatch>(`/api/summons/${summonsId}/otp`)
  );

  const acknowledge = useMutation(async (args: { summonsId: string; otp: string }) => {
    const device = deviceHint();
    return api.post<{ chain: { txHash: string; explorer: string | null } }>(
      `/api/summons/${args.summonsId}/acknowledge`,
      {
        challengeId: dispatch!.challengeId,
        otp: args.otp,
        gpsLat: fix!.lat,
        gpsLng: fix!.lng,
        deviceId: device.deviceId,
        platform: device.platform,
      }
    );
  });

  return (
    <>
      <PageHeader
        eyebrow="Summons"
        title="Your summons"
        description="Acknowledging a summons records the time, your location and a device identifier on the public ledger. It confirms to the court that the summons reached you, and gives you a record that you responded."
      />

      <AsyncView
        state={inbox}
        onRetry={inbox.refetch}
        context="your summons"
        isEmpty={(data) => data.summons.length === 0}
        empty={
          <EmptyState
            title="No summons"
            description="Nothing has been issued to you."
            icon={<ScrollText size={19} />}
          />
        }
      >
        {(data) => (
          <div className="space-y-5">
            {data.summons.map((row) => {
              const secondsLeft = Math.max(0, (new Date(row.expiry_at).getTime() - Date.now()) / 1000);
              const isActive = activeId === row.id;
              const canAck = row.status === "PENDING" && secondsLeft > 0;

              return (
                <Card
                  key={row.id}
                  title={row.cases?.title ?? row.cases?.case_reference ?? "Court notice"}
                  subtitle={`${row.cases?.case_reference ?? ""} · ${row.cases?.court_name ?? "Court"}`}
                  actions={<SummonsStatusChip status={row.status} />}
                  className={row.status === "PENDING" ? "border-warning-soft" : ""}
                >
                  <dl className="space-y-2.5">
                    <Row label="Issued" value={formatDateTime(row.issued_at)} />
                    <Row
                      label="Hearing"
                      value={row.hearing_at ? formatDateTime(row.hearing_at) : "not set"}
                    />
                    <Row
                      label={row.status === "PENDING" ? "Time to acknowledge" : "Window closed"}
                      value={
                        row.status === "PENDING" ? (
                          <span className={secondsLeft < 12 * 3600 ? "text-danger" : "text-text"}>
                            {formatDuration(secondsLeft)}
                          </span>
                        ) : (
                          formatDateTime(row.expiry_at)
                        )
                      }
                    />
                    {row.delivered_at && (
                      <Row label="You acknowledged" value={formatDateTime(row.delivered_at)} />
                    )}
                  </dl>

                  {row.document_body && (
                    <div className="mt-4 rounded-lg border border-border bg-surface-2 p-4">
                      <p className="mb-2 font-ui text-2xs font-semibold uppercase tracking-wider text-faint">
                        The notice
                      </p>
                      <p className="whitespace-pre-line font-ui text-sm leading-relaxed text-text">
                        {row.document_body}
                      </p>
                    </div>
                  )}

                  {row.status === "DELIVERED" && (
                    <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-success-soft bg-success-soft p-3">
                      <ShieldCheck size={15} className="mt-0.5 shrink-0 text-success" />
                      <div>
                        <p className="font-ui text-xs font-semibold text-text">
                          Your acknowledgement is on chain
                        </p>
                        <p className="mt-0.5 font-ui text-2xs leading-relaxed text-muted">
                          Nobody can later claim you were not served, and nobody can claim you
                          acknowledged at a different time.
                        </p>
                        <div className="mt-1.5">
                          <TxLink txHash={row.ack_tx_hash} />
                        </div>
                      </div>
                    </div>
                  )}

                  {row.status === "FAILED" && (
                    <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-danger-soft bg-danger-soft p-3">
                      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger" />
                      <p className="font-ui text-xs leading-relaxed text-text">
                        The acknowledgement window closed. The court has been notified that this
                        summons could not be served. Contact the court registry.
                      </p>
                    </div>
                  )}

                  {canAck && !isActive && (
                    <Button
                      full
                      className="mt-4"
                      onClick={() => {
                        setActiveId(row.id);
                        setDispatch(null);
                        setFix(null);
                      }}
                    >
                      Acknowledge this summons
                    </Button>
                  )}

                  {canAck && isActive && (
                    <div className="mt-4 space-y-4">
                      <GpsCapture value={fix} onChange={setFix} autoRequest />

                      <OtpPanel
                        purposeLabel="Acknowledging a summons"
                        dispatch={dispatch}
                        requesting={requestOtp.pending}
                        verifying={acknowledge.pending}
                        disabled={!fix}
                        onRequest={async () => {
                          const outcome = await requestOtp.run(row.id);
                          if (outcome) setDispatch(outcome);
                        }}
                        onVerify={async (otp) => {
                          if (!fix) {
                            toast.warning("Capture your position first", "The court records where you acknowledged.");
                            return;
                          }
                          const outcome = await acknowledge.run({ summonsId: row.id, otp });
                          if (outcome) {
                            toast.success(
                              "Acknowledged",
                              "The time, place and your device are now on chain.",
                              outcome.chain.explorer
                                ? { href: outcome.chain.explorer, label: "View transaction" }
                                : undefined
                            );
                            setActiveId(null);
                            setDispatch(null);
                            inbox.refetch();
                          }
                        }}
                      />

                      {!fix && (
                        <p className="font-ui text-2xs leading-relaxed text-warning">
                          Capture your position before verifying the code. The acknowledgement records
                          where it happened.
                        </p>
                      )}

                      {(requestOtp.error || acknowledge.error) && (
                        <p role="alert" className="font-ui text-xs text-danger">
                          {(requestOtp.error ?? acknowledge.error)?.message}
                        </p>
                      )}

                      <Button variant="ghost" full size="sm" onClick={() => setActiveId(null)}>
                        Cancel
                      </Button>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </AsyncView>
    </>
  );
}

/* ==================================================== CheckInPage ======== */

interface ComplianceResponse {
  bail: BailRow;
  case: { case_reference: string; title: string };
  compliance: { score: number; flags: boolean[]; overdue: boolean; secondsUntilNextCheckIn: number } | null;
  conditionStates: { label: string; tagHash: string; violated: boolean }[];
  checkins: CheckInRow[];
  violations: ViolationRow[];
}

export function AccusedCheckIn() {
  const toast = useToast();
  const orders = useQuery<{ orders: (BailRow & { live?: any })[] }>("/api/bail/mine");
  const order = orders.data?.orders[0] ?? null;

  const detail = useQuery<ComplianceResponse>(order ? `/api/bail/case/${order.case_id}` : null);

  const [dispatch, setDispatch] = useState<OtpDispatch | null>(null);
  const [fix, setFix] = useState<Fix | null>(null);

  const fence = useMemo(() => {
    if (!order?.centre_lat || !order?.centre_lng) return null;
    return { lat: order.centre_lat, lng: order.centre_lng, radiusMetres: order.radius_metres };
  }, [order]);

  const requestOtp = useMutation(async () =>
    api.post<OtpDispatch>(`/api/bail/case/${order!.case_id}/otp`)
  );

  const checkIn = useMutation(async (otp: string) => {
    const device = deviceHint();
    return api.post<{
      withinFence: boolean;
      distanceMetres: number | null;
      violations: { reason: string }[];
      compliance: { score: number } | null;
      chain: { txHash: string; explorer: string | null };
    }>(`/api/bail/case/${order!.case_id}/checkin`, {
      challengeId: dispatch!.challengeId,
      otp,
      gpsLat: fix!.lat,
      gpsLng: fix!.lng,
      deviceId: device.deviceId,
      platform: device.platform,
    });
  });

  return (
    <>
      <PageHeader
        eyebrow="Bail"
        title="Bail check-in"
        description="Each check-in records your position at that moment. Whether it complies with your bail conditions is determined by the same rule for everyone, so the result does not depend on who reviews it."
      />

      <AsyncView
        state={orders}
        onRetry={orders.refetch}
        context="your bail orders"
        isEmpty={(data) => data.orders.length === 0}
        empty={
          <EmptyState
            title="No active bail order"
            description="There is nothing for you to check in against."
            icon={<Scale size={19} />}
          />
        }
      >
        {() => (
          <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
            <div className="space-y-5">
              <Card
                title="File your check-in"
                subtitle="Your position, then a one-time code. Both are required."
              >
                <GpsCapture value={fix} onChange={setFix} fence={fence} autoRequest />

                <div className="mt-4">
                  <OtpPanel
                    purposeLabel="A bail check-in"
                    dispatch={dispatch}
                    requesting={requestOtp.pending}
                    verifying={checkIn.pending}
                    disabled={!fix}
                    onRequest={async () => {
                      const outcome = await requestOtp.run(undefined as never);
                      if (outcome) setDispatch(outcome);
                    }}
                    onVerify={async (otp) => {
                      if (!fix) {
                        toast.warning("Capture your position first", "A check-in without coordinates proves nothing.");
                        return;
                      }
                      const outcome = await checkIn.run(otp);
                      if (!outcome) return;

                      if (outcome.withinFence && outcome.violations.length === 0) {
                        toast.success(
                          "Check-in recorded",
                          `${formatMetres(outcome.distanceMetres ?? 0)} from your declared residence, inside the permitted area.`,
                          outcome.chain.explorer
                            ? { href: outcome.chain.explorer, label: "View transaction" }
                            : undefined
                        );
                      } else {
                        toast.error(
                          "Check-in recorded, with a breach",
                          outcome.violations.map((v) => violationLabel(v.reason)).join(" · ") ||
                            "You checked in from outside the permitted area."
                        );
                      }
                      setDispatch(null);
                      detail.refetch();
                      orders.refetch();
                    }}
                  />
                </div>

                {(requestOtp.error || checkIn.error) && (
                  <p role="alert" className="mt-3 font-ui text-xs text-danger">
                    {(requestOtp.error ?? checkIn.error)?.message}
                  </p>
                )}
              </Card>

              <AsyncView state={detail} onRetry={detail.refetch} context="your conditions">
                {(data) => (
                  <Card title="Your conditions" subtitle="Each one, and whether it is currently met.">
                    <ConditionList conditions={data.conditionStates} />
                  </Card>
                )}
              </AsyncView>
            </div>

            <div className="space-y-5">
              <AsyncView state={detail} onRetry={detail.refetch} context="your compliance">
                {(data) => (
                  <>
                    <Card title="Compliance" subtitle="Computed by the contract, not by this server.">
                      <div className="flex justify-center">
                        <ComplianceGauge
                          score={data.compliance?.score ?? data.bail.compliance_score}
                          overdue={data.compliance?.overdue}
                        />
                      </div>
                      <dl className="mt-4 space-y-2.5">
                        <Row label="Case" value={data.case.case_reference} />
                        <Row
                          label="Next check-in due"
                          value={
                            data.compliance
                              ? data.compliance.overdue
                                ? "overdue now"
                                : formatDuration(data.compliance.secondsUntilNextCheckIn)
                              : "—"
                          }
                        />
                        <Row
                          label="Permitted radius"
                          value={data.bail.radius_metres ? formatMetres(data.bail.radius_metres) : "no restriction"}
                        />
                        <Row label="Order expires" value={formatDateTime(data.bail.expiry_at)} />
                      </dl>
                    </Card>

                    <Card title="Your check-ins" subtitle="Newest first.">
                      {data.checkins.length === 0 ? (
                        <EmptyState
                          title="No check-ins yet"
                          description="File your first one above."
                          icon={<Clock size={19} />}
                        />
                      ) : (
                        <ul className="space-y-2">
                          {data.checkins.slice(0, 10).map((row) => (
                            <li
                              key={row.id}
                              className={`flex flex-wrap items-center justify-between gap-2.5 rounded-lg border px-3.5 py-2.5 ${
                                row.within_fence
                                  ? "border-border bg-surface-2"
                                  : "border-danger-soft bg-danger-soft"
                              }`}
                            >
                              <div className="min-w-0">
                                <p className="font-ui text-xs font-medium text-text">
                                  {formatDateTime(row.occurred_at)}
                                </p>
                                <p className="mt-0.5 flex items-center gap-1 font-ui text-2xs text-muted">
                                  <MapPin size={10} />
                                  {row.distance_metres !== null
                                    ? `${formatMetres(row.distance_metres)} from home`
                                    : "no fence set"}
                                </p>
                              </div>
                              <div className="flex items-center gap-2">
                                <StatusChip
                                  tone={row.within_fence ? "success" : "danger"}
                                  label={row.within_fence ? "Inside" : "Outside"}
                                />
                                <TxLink txHash={row.tx_hash} />
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </Card>

                    {data.violations.length > 0 && (
                      <Card title="Recorded breaches" subtitle="Each one is on chain and cannot be removed.">
                        <ul className="space-y-2">
                          {data.violations.map((violation) => (
                            <li
                              key={violation.id}
                              className="rounded-lg border border-danger-soft bg-danger-soft p-3"
                            >
                              <p className="font-ui text-xs font-semibold text-text">
                                {violationLabel(violation.reason)}
                              </p>
                              <p className="mt-0.5 font-ui text-2xs text-muted">
                                {formatDateTime(violation.detected_at)}
                              </p>
                            </li>
                          ))}
                        </ul>
                      </Card>
                    )}
                  </>
                )}
              </AsyncView>
            </div>
          </div>
        )}
      </AsyncView>
    </>
  );
}
