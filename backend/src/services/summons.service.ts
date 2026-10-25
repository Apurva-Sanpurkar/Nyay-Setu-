import { Request } from "express";
import { db, unwrap, unwrapList, unwrapMaybe } from "../lib/supabase";
import { sha256Hex, canonicalise, deviceFingerprint } from "../lib/crypto";
import { storeEncrypted } from "../lib/storage";
import { submit, read, eventArgs, toMicroDegrees, explorerUrl, chain } from "../lib/chain";
import { badRequest, conflict, notFound, forbidden } from "../lib/errors";
import { logger } from "../lib/logger";
import { env } from "../config/env";
import { otpProvider } from "../otp";
import { sendNonDeliveryAlert, sendSummonsNotice } from "../lib/mailer";
import { recordAction } from "./audit";
import { SessionUser } from "../middleware/auth";

/**
 * SammansSetu service layer.
 *
 * The claim this module defeats is "I was never served". An acknowledgement
 * here is an Aadhaar-OTP-authenticated transaction carrying a timestamp, GPS
 * and a device fingerprint. A recipient cannot produce it without their own
 * registered mobile, and nobody can back-date it, because the timestamp is the
 * block's, not the server's.
 */

const CHAIN_STATUS = ["PENDING", "DELIVERED", "FAILED"] as const;

/**
 * Every citizen-facing action needs the caller's Aadhaar token, and an account
 * without one cannot take part in an OTP flow at all. Narrowing it once here
 * keeps the null check out of every call site.
 */
function requireAadhaarToken(user: SessionUser): string {
  if (!user.aadhaarToken) {
    throw badRequest(
      "Your account has no Aadhaar token on file. Ask the court administrator to complete your record."
    );
  }
  return user.aadhaarToken;
}

export interface IssueInput {
  caseId: string;
  recipientUserId?: string | null;
  recipientName: string;
  recipientAadhaarToken: string;
  documentBody: string;
  hearingAt?: string | null;
  windowHours?: number;
}

export async function issueSummons(req: Request, user: SessionUser, input: IssueInput) {
  const caseRow = unwrapMaybe(
    await db.from("cases").select("id, case_reference, case_id_hash, court_name").eq("id", input.caseId).maybeSingle()
  ) as { id: string; case_reference: string; case_id_hash: string; court_name: string | null } | null;
  if (!caseRow) throw notFound("Case");

  const windowHours = input.windowHours ?? env.SUMMONS_WINDOW_HOURS;
  const issuedAt = new Date();
  const expiryAt = new Date(issuedAt.getTime() + windowHours * 3600_000);

  // The digest covers everything that makes the document what it is, so a later
  // edit to any of these fields is detectable.
  const documentHash = sha256Hex(
    canonicalise({
      caseReference: caseRow.case_reference,
      recipient: input.recipientAadhaarToken,
      body: input.documentBody,
      hearingAt: input.hearingAt ?? null,
      issuedBy: user.id,
    })
  );

  // The summons text is off-chain and encrypted, like every other document.
  let cid: string | null = null;
  try {
    const stored = await storeEncrypted(Buffer.from(input.documentBody, "utf8"), `summons-${documentHash.slice(2, 14)}`);
    cid = stored.cid;
  } catch (error) {
    logger.warn("Could not pin the summons document; continuing with the hash only", { error });
  }

  const row = unwrap(
    await db
      .from("summons")
      .insert({
        case_id: caseRow.id,
        recipient_user_id: input.recipientUserId ?? null,
        recipient_name: input.recipientName,
        recipient_aadhaar_token: input.recipientAadhaarToken,
        document_hash: documentHash,
        document_ipfs_cid: cid,
        document_body: input.documentBody,
        hearing_at: input.hearingAt ?? null,
        issued_by: user.id,
        issued_at: issuedAt.toISOString(),
        expiry_at: expiryAt.toISOString(),
        status: "PENDING",
      })
      .select("*")
      .single()
  ) as any;

  const result = await submit(
    "SummonsChain",
    "issueSummons",
    [
      caseRow.case_id_hash,
      input.recipientAadhaarToken,
      documentHash,
      BigInt(Math.floor(expiryAt.getTime() / 1000)),
    ],
    { submittedBy: user.id, payload: { summonsRowId: row.id, caseReference: caseRow.case_reference } }
  );

  const args = eventArgs(result.receipt, "SummonsChain", "SummonsIssued");
  const chainSummonsId = args?.summonsId ? Number(args.summonsId) : null;

  await db
    .from("summons")
    .update({ chain_summons_id: chainSummonsId, issue_tx_hash: result.txHash })
    .eq("id", row.id);

  await recordAction(req, {
    action: "summons.issue",
    subject: row.id,
    caseId: caseRow.id,
    detail: { chainSummonsId, txHash: result.txHash, windowHours },
  });

  // Tell the recipient a summons exists. The summons itself is NOT emailed: its
  // contents are privileged, and an email inbox is not an access-controlled
  // place to keep them. The notice carries a deadline and a link, nothing more.
  //
  // Fire-and-forget on purpose. A mail server that is down must not undo a
  // summons that is already anchored on chain.
  if (env.emailNotificationsEnabled) {
    void notifyRecipient({
      recipientUserId: input.recipientUserId ?? null,
      recipientName: input.recipientName,
      caseReference: caseRow.case_reference,
      courtName: caseRow.court_name,
      expiryAt: expiryAt.toISOString(),
    });
  }

  return {
    summons: { ...row, chain_summons_id: chainSummonsId, issue_tx_hash: result.txHash },
    chain: {
      txHash: result.txHash,
      blockNumber: result.blockNumber,
      explorer: explorerUrl(result.txHash),
      chainSummonsId,
    },
  };
}

/** Step one of acknowledgement: send the recipient an OTP bound to this summons. */
export async function requestAcknowledgementOtp(req: Request, user: SessionUser, summonsId: string) {
  const row = await loadSummons(summonsId);
  const aadhaarToken = requireAadhaarToken(user);

  if (row.recipient_aadhaar_token !== aadhaarToken) {
    throw forbidden("This summons was not issued to you.");
  }
  if (row.status !== "PENDING") {
    throw conflict(`This summons is already ${row.status}.`);
  }
  if (new Date(row.expiry_at).getTime() < Date.now()) {
    throw conflict("The 72 hour acknowledgement window has closed. The court has been notified.");
  }

  const dispatch = await otpProvider.sendOtp({
    subjectToken: aadhaarToken,
    purpose: "summons_ack",
    referenceId: row.id,
    destinationHint: "registered mobile",
  });

  await recordAction(req, {
    action: "summons.ack_otp",
    subject: row.id,
    caseId: row.case_id,
    detail: { challengeId: dispatch.challengeId },
  });

  return dispatch;
}

/** Step two: verify the OTP, then record the acknowledgement on chain. */
export async function confirmAcknowledgement(
  req: Request,
  user: SessionUser,
  input: {
    summonsId: string;
    challengeId: string;
    otp: string;
    gpsLat: number;
    gpsLng: number;
    deviceId?: string | null;
    platform?: string | null;
  }
) {
  const row = await loadSummons(input.summonsId);
  const aadhaarToken = requireAadhaarToken(user);

  if (row.recipient_aadhaar_token !== aadhaarToken) {
    throw forbidden("This summons was not issued to you.");
  }
  if (row.status !== "PENDING") throw conflict(`This summons is already ${row.status}.`);
  if (row.chain_summons_id === null) throw conflict("This summons is not anchored on chain yet.");

  const verification = await otpProvider.verifyOtp({
    challengeId: input.challengeId,
    otp: input.otp,
    subjectToken: aadhaarToken,
    purpose: "summons_ack",
    referenceId: row.id,
  });

  if (!verification.verified) {
    await recordAction(req, {
      action: "summons.acknowledge",
      subject: row.id,
      caseId: row.case_id,
      outcome: "refused",
      detail: { reason: verification.reason },
    });
    throw badRequest(otpFailureMessage(verification.reason), {
      reason: verification.reason,
      attemptsRemaining: verification.attemptsRemaining,
    });
  }

  const fingerprint = deviceFingerprint({
    userAgent: req.get("user-agent") ?? undefined,
    platform: input.platform ?? undefined,
    deviceId: input.deviceId ?? undefined,
  });

  const result = await submit(
    "SummonsChain",
    "confirmDelivery",
    [
      row.chain_summons_id,
      aadhaarToken,
      toMicroDegrees(input.gpsLat, "latitude"),
      toMicroDegrees(input.gpsLng, "longitude"),
      fingerprint,
    ],
    { submittedBy: user.id, payload: { summonsRowId: row.id } }
  );

  await db
    .from("summons")
    .update({
      status: "DELIVERED",
      delivered_at: new Date().toISOString(),
      delivery_lat: input.gpsLat,
      delivery_lng: input.gpsLng,
      device_fingerprint: fingerprint,
      ack_tx_hash: result.txHash,
    })
    .eq("id", row.id);

  await recordAction(req, {
    action: "summons.acknowledge",
    subject: row.id,
    caseId: row.case_id,
    detail: { txHash: result.txHash },
  });

  return {
    status: "DELIVERED" as const,
    acknowledgedAt: new Date().toISOString(),
    chain: {
      txHash: result.txHash,
      blockNumber: result.blockNumber,
      explorer: explorerUrl(result.txHash),
    },
  };
}

/**
 * Status straight from the contract, which applies the deadline itself, so the
 * court sees FAILED the moment the window closes even if the sweep job has not
 * run yet.
 */
export async function deliveryStatus(summonsId: string) {
  const row = await loadSummons(summonsId);

  let onChain: { status: string; secondsRemaining: number } | null = null;
  if (row.chain_summons_id !== null && chain.isReady) {
    try {
      const status = Number(await read<bigint>("SummonsChain", "getDeliveryStatus", [row.chain_summons_id]));
      const remaining = Number(await read<bigint>("SummonsChain", "timeRemaining", [row.chain_summons_id]));
      onChain = { status: CHAIN_STATUS[status] ?? "PENDING", secondsRemaining: remaining };
    } catch (error) {
      logger.warn("Could not read the summons status from chain", { summonsId, error });
    }
  }

  const expired = new Date(row.expiry_at).getTime() < Date.now();

  return {
    summons: row,
    offChainStatus: row.status,
    onChainStatus: onChain?.status ?? null,
    secondsRemaining: onChain?.secondsRemaining ?? Math.max(0, Math.floor((new Date(row.expiry_at).getTime() - Date.now()) / 1000)),
    // What the court dashboard actually displays.
    effectiveStatus: row.status === "PENDING" && expired ? "FAILED" : row.status,
    windowClosed: expired,
  };
}

/**
 * The 72 hour timer. Called by the scheduler; also exposed to court admins.
 * Writes the conclusion on chain and raises the court-side alert.
 */
export async function sweepNonDelivery(): Promise<{ marked: number; ids: string[] }> {
  const overdue = unwrapList(
    await db
      .from("summons")
      .select("id, case_id, chain_summons_id, recipient_name, expiry_at, non_delivery_alerted_at")
      .eq("status", "PENDING")
      .lt("expiry_at", new Date().toISOString())
      .limit(50)
  ) as any[];

  if (overdue.length === 0) return { marked: 0, ids: [] };

  const marked: string[] = [];

  for (const row of overdue) {
    try {
      if (row.chain_summons_id !== null && chain.isReady) {
        await submit("SummonsChain", "markNonDelivery", [row.chain_summons_id], {
          payload: { summonsRowId: row.id, sweep: true },
        });
      }
      await db
        .from("summons")
        .update({ status: "FAILED", non_delivery_alerted_at: new Date().toISOString() })
        .eq("id", row.id);
      marked.push(row.id);
      logger.info("Summons marked non-delivered", { summonsId: row.id, recipient: row.recipient_name });

      // The court dashboard already shows this, but a sweep runs unattended at
      // two in the morning and a judge is not watching a dashboard then.
      if (env.emailNotificationsEnabled) void alertIssuer(row);
    } catch (error) {
      logger.warn("Could not mark a summons non-delivered", {
        summonsId: row.id,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  return { marked: marked.length, ids: marked };
}

/** Emails the judge or admin who issued a summons that went unanswered. */
async function alertIssuer(row: {
  id: string;
  case_id: string;
  recipient_name: string;
  expiry_at: string;
  issued_by?: string | null;
}): Promise<void> {
  try {
    const summons = unwrapMaybe(
      await db
        .from("summons")
        .select("issued_by, cases(case_reference)")
        .eq("id", row.id)
        .maybeSingle()
    ) as { issued_by: string | null; cases: { case_reference: string } | null } | null;

    if (!summons?.issued_by) return;

    const issuer = unwrapMaybe(
      await db.from("users").select("id, email, is_active").eq("id", summons.issued_by).maybeSingle()
    ) as { id: string; email: string; is_active: boolean } | null;

    if (!issuer?.email || !issuer.is_active) return;

    await sendNonDeliveryAlert({
      to: issuer.email,
      userId: issuer.id,
      recipientName: row.recipient_name,
      caseReference: summons.cases?.case_reference ?? "the case",
      expiryAt: row.expiry_at,
      portalUrl: `${env.PUBLIC_APP_URL.replace(/\/$/, "")}/judge/summons`,
    });
  } catch (error) {
    logger.warn("Could not send the non-delivery alert", {
      summonsId: row.id,
      error: error instanceof Error ? error.message : error,
    });
  }
}

export async function listForCase(caseId: string) {
  return unwrapList(
    await db
      .from("summons")
      .select(
        "id, case_id, chain_summons_id, recipient_name, status, issued_at, expiry_at, delivered_at, " +
          "hearing_at, document_hash, issue_tx_hash, ack_tx_hash, non_delivery_alerted_at, delivery_lat, delivery_lng"
      )
      .eq("case_id", caseId)
      .order("issued_at", { ascending: false })
  ) as any[];
}

export async function listForRecipient(user: SessionUser) {
  if (!user.aadhaarToken) return [];
  return unwrapList(
    await db
      .from("summons")
      .select(
        "id, case_id, chain_summons_id, recipient_name, status, issued_at, expiry_at, delivered_at, " +
          "hearing_at, document_hash, document_body, cases(case_reference, title, court_name)"
      )
      .eq("recipient_aadhaar_token", user.aadhaarToken)
      .order("issued_at", { ascending: false })
  ) as any[];
}

/** Everything pending or failed across the court, for the judge dashboard. */
export async function courtOverview() {
  const rows = unwrapList(
    await db
      .from("summons")
      .select(
        "id, case_id, recipient_name, status, issued_at, expiry_at, delivered_at, non_delivery_alerted_at, " +
          "cases(case_reference, title)"
      )
      .order("issued_at", { ascending: false })
      .limit(100)
  ) as any[];

  const now = Date.now();
  return rows.map((row) => ({
    ...row,
    effectiveStatus:
      row.status === "PENDING" && new Date(row.expiry_at).getTime() < now ? "FAILED" : row.status,
    hoursRemaining: Math.max(0, (new Date(row.expiry_at).getTime() - now) / 3600_000),
  }));
}

/**
 * Looks up the recipient's address and sends the notice.
 *
 * Only an account with an email gets one. A summons issued against a raw
 * Aadhaar number with no NyaySetu account has no address to send to, and
 * inventing one is not an option, so it is silently skipped and the court still
 * has the on-chain record either way.
 */
async function notifyRecipient(args: {
  recipientUserId: string | null;
  recipientName: string;
  caseReference: string;
  courtName: string | null;
  expiryAt: string;
}): Promise<void> {
  try {
    if (!args.recipientUserId) return;

    const recipient = unwrapMaybe(
      await db
        .from("users")
        .select("id, email, is_active")
        .eq("id", args.recipientUserId)
        .maybeSingle()
    ) as { id: string; email: string; is_active: boolean } | null;

    if (!recipient?.email || !recipient.is_active) return;

    await sendSummonsNotice({
      to: recipient.email,
      userId: recipient.id,
      recipientName: args.recipientName,
      caseReference: args.caseReference,
      courtName: args.courtName,
      expiryAt: args.expiryAt,
      portalUrl: `${env.PUBLIC_APP_URL.replace(/\/$/, "")}/accused/summons`,
    });
  } catch (error) {
    logger.warn("Could not send the summons notice", {
      error: error instanceof Error ? error.message : error,
    });
  }
}

export async function loadSummons(summonsId: string) {
  const row = unwrapMaybe(
    await db.from("summons").select("*").eq("id", summonsId).maybeSingle()
  ) as any;
  if (!row) throw notFound("Summons");
  return row;
}

export function otpFailureMessage(reason?: string): string {
  switch (reason) {
    case "expired":
      return "That code has expired. Request a new one.";
    case "consumed":
      return "That code has already been used.";
    case "attempts_exhausted":
      return "Too many wrong codes. Request a new one.";
    case "scope_mismatch":
      return "That code was issued for a different action.";
    case "not_found":
      return "That challenge does not exist. Request a new code.";
    default:
      return "That code is not correct.";
  }
}
