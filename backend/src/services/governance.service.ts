import { Request } from "express";
import { zipSync, strToU8 } from "fflate";
import { db, unwrap, unwrapList, unwrapMaybe } from "../lib/supabase";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { sha256Hex } from "../lib/crypto";
import { explorerUrl, chain } from "../lib/chain";
import { recordAction } from "./audit";
import { loadAnchor, transition } from "./verification/anchors";
import { authorisedPassport, verifyUrl } from "./passport/passport.service";
import { buildPassportPdf } from "../lib/pdf/passport";
import { custodyFormPdf } from "./police.service";
import { renderCertificate } from "./certificate.service";
import { fetchPlaintext } from "./evidence.service";
import { getFirRecord } from "./case.service";
import type { SessionUser, UserRole } from "../middleware/auth";

/**
 * Governance (2.0 · F19): two-person approval for the actions that cannot be
 * undone, legal holds, disposal records, and the court export bundle.
 *
 * Two people means two different accounts. The API refuses a self-approval with
 * a clear message; the database refuses it again (approval_two_people), so no
 * path around the API gets round it either.
 */

export type ApprovalAction = "case_close" | "evidence_destroy" | "custody_after_mismatch";

const REQUESTERS: Record<ApprovalAction, UserRole[]> = {
  case_close: ["police", "prosecutor", "judge", "court_admin"],
  evidence_destroy: ["police", "court_admin"],
  custody_after_mismatch: ["police", "forensic_lab", "prosecutor", "court_admin"],
};

/** Approval is a judicial or registry act. */
const APPROVERS: UserRole[] = ["judge", "court_admin"];

async function activeHold(subjectType: "case" | "evidence", subjectId: string) {
  return unwrapMaybe(
    await db.from("legal_holds").select("id, reason, placed_at").eq("subject_type", subjectType).eq("subject_id", subjectId).is("released_at", null).maybeSingle()
  ) as { id: string; reason: string } | null;
}

/** An item is held if it, or its case, is under a legal hold. */
export async function holdBlocking(evidenceId: string, caseId: string) {
  return (await activeHold("evidence", evidenceId)) ?? (await activeHold("case", caseId));
}

export async function subjectCase(subjectType: "case" | "evidence", subjectId: string): Promise<string> {
  if (subjectType === "case") {
    const row = unwrapMaybe(await db.from("cases").select("id").eq("id", subjectId).maybeSingle());
    if (!row) throw notFound("Case");
    return subjectId;
  }
  const row = unwrapMaybe(await db.from("evidence_items").select("case_id").eq("id", subjectId).maybeSingle()) as { case_id: string } | null;
  if (!row) throw notFound("Evidence item");
  return row.case_id;
}

export interface ApprovalInput {
  action: ApprovalAction;
  subjectId: string;
  reason: string;
  payload?: Record<string, unknown>;
  idempotencyKey?: string | null;
}

export async function requestApproval(req: Request, user: SessionUser, input: ApprovalInput) {
  if (!REQUESTERS[input.action].includes(user.role)) throw forbidden(`Your role cannot request ${input.action.replace(/_/g, " ")}.`);
  const subjectType = input.action === "case_close" ? "case" : "evidence";
  const caseId = await subjectCase(subjectType, input.subjectId);

  if (input.idempotencyKey) {
    const prior = unwrapMaybe(await db.from("approval_requests").select("*").eq("idempotency_key", input.idempotencyKey).maybeSingle());
    if (prior) return prior;
  }

  if (input.action === "evidence_destroy") {
    const method = input.payload?.method;
    if (!["returned_to_owner", "destroyed", "auctioned", "transferred", "retained_by_court"].includes(String(method))) {
      throw badRequest("Say how the item is to be disposed of: returned_to_owner, destroyed, auctioned, transferred or retained_by_court.");
    }
    const hold = await holdBlocking(input.subjectId, caseId);
    if (hold) throw conflict(`A legal hold blocks disposal: ${hold.reason}`);
  }
  if (input.action === "custody_after_mismatch") {
    const item = unwrapMaybe(await db.from("evidence_items").select("anchor_id").eq("id", input.subjectId).maybeSingle()) as { anchor_id: string | null } | null;
    const anchor = item?.anchor_id ? await loadAnchor(item.anchor_id) : null;
    if (anchor?.state !== "INTEGRITY_MISMATCH") throw conflict("This item is not in INTEGRITY_MISMATCH, so there is nothing to release for review.");
  }

  const pending = unwrapList(
    await db.from("approval_requests").select("id").eq("action", input.action).eq("subject_id", input.subjectId).eq("status", "pending")
  );
  if (pending.length) throw conflict("A request for this is already waiting for approval.");

  const row = unwrap(
    await db
      .from("approval_requests")
      .insert({
        action: input.action,
        subject_type: subjectType,
        subject_id: input.subjectId,
        case_id: caseId,
        requested_by: user.id,
        requested_role: user.role,
        reason: input.reason,
        payload: input.payload ?? {},
        status: "pending",
        idempotency_key: input.idempotencyKey ?? null,
      })
      .select("*")
      .single()
  );
  await recordAction(req, { action: `approval.request`, subject: (row as any).id, caseId, detail: { reason: input.action } });
  return row;
}

async function execute(req: Request, approval: any, approver: SessionUser) {
  switch (approval.action as ApprovalAction) {
    case "case_close": {
      await db.from("cases").update({ status: "disposed" }).eq("id", approval.subject_id);
      await recordAction(req, { action: "case.status_change", subject: approval.subject_id, caseId: approval.case_id, detail: { status: "disposed" } });
      break;
    }
    case "evidence_destroy": {
      // Checked again at execution: a hold placed after the request still blocks.
      const hold = await holdBlocking(approval.subject_id, approval.case_id);
      if (hold) throw conflict(`A legal hold was placed after this request and blocks disposal: ${hold.reason}`);
      const now = new Date().toISOString();
      unwrap(
        await db
          .from("disposal_records")
          .insert({
            evidence_id: approval.subject_id,
            case_id: approval.case_id,
            method: approval.payload.method,
            witnesses: approval.payload.witnesses ?? [],
            notes: approval.payload.notes ?? null,
            approval_id: approval.id,
            recorded_by: approver.id,
            performed_at: now,
          })
          .select("id")
          .single()
      );
      await db.from("evidence_items").update({ disposed_at: now }).eq("id", approval.subject_id);
      break;
    }
    case "custody_after_mismatch": {
      const item = unwrapMaybe(await db.from("evidence_items").select("anchor_id").eq("id", approval.subject_id).maybeSingle()) as { anchor_id: string };
      const anchor = await loadAnchor(item.anchor_id);
      await transition(anchor, "REVIEW_REQUIRED", {
        code: "TWO_PERSON_RELEASE",
        reason: `Released for review by two people: ${approval.reason}`,
        actor: { id: approver.id, role: approver.role },
      });
      break;
    }
  }
}

export async function decideApproval(req: Request, user: SessionUser, approvalId: string, decision: "approve" | "reject", reason: string) {
  if (!APPROVERS.includes(user.role)) throw forbidden("Only a judge or the court registry can decide an approval.");
  const approval = unwrapMaybe(await db.from("approval_requests").select("*").eq("id", approvalId).maybeSingle()) as any;
  if (!approval) throw notFound("Approval request");
  if (approval.status !== "pending") throw conflict(`This request is already ${approval.status}.`);
  if (approval.requested_by === user.id) {
    await recordAction(req, { action: "approval.self_approval_refused", subject: approvalId, caseId: approval.case_id, outcome: "refused" });
    throw forbidden("The person who requested this cannot also approve it. A second person must decide.");
  }
  if (user.role === "judge") {
    const assigned = unwrapMaybe(await db.from("case_assignments").select("id").eq("case_id", approval.case_id).eq("user_id", user.id).maybeSingle());
    if (!assigned) throw forbidden("You are not assigned to this case.");
  }

  const decided = unwrapList(
    await db
      .from("approval_requests")
      .update({
        status: decision === "approve" ? "approved" : "rejected",
        approver_id: user.id,
        approver_role: user.role,
        approver_reason: reason,
        decided_at: new Date().toISOString(),
      })
      .eq("id", approvalId)
      .eq("status", "pending")
      .select("*")
  ) as any[];
  if (!decided.length) throw conflict("Someone else decided this request first.");

  await recordAction(req, { action: `approval.${decision}`, subject: approvalId, caseId: approval.case_id, detail: { reason: approval.action } });
  if (decision === "reject") return decided[0];

  await execute(req, decided[0], user);
  return unwrap(
    await db.from("approval_requests").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", approvalId).select("*").single()
  );
}

export async function listApprovals(user: SessionUser, filter: { status?: string; caseId?: string }) {
  let query = db.from("approval_requests").select("*, cases(case_reference, title)").order("created_at", { ascending: false }).limit(200);
  if (filter.status) query = query.eq("status", filter.status);
  if (filter.caseId) query = query.eq("case_id", filter.caseId);
  if (user.role !== "court_admin") {
    const ids = (unwrapList(await db.from("case_assignments").select("case_id").eq("user_id", user.id)) as { case_id: string }[]).map((a) => a.case_id);
    if (!ids.length) return [];
    query = query.in("case_id", ids);
  }
  return unwrapList(await query);
}

/* ----------------------------------------------------------- legal holds */

const HOLDERS: UserRole[] = ["judge", "prosecutor", "court_admin"];
const RELEASERS: UserRole[] = ["judge", "court_admin"];

export async function placeHold(req: Request, user: SessionUser, input: { subjectType: "case" | "evidence"; subjectId: string; reason: string }) {
  if (!HOLDERS.includes(user.role)) throw forbidden("Only the court, the prosecution or the registry can place a legal hold.");
  const caseId = await subjectCase(input.subjectType, input.subjectId);
  if (await activeHold(input.subjectType, input.subjectId)) throw conflict("A legal hold is already in place.");
  const row = unwrap(
    await db
      .from("legal_holds")
      .insert({ subject_type: input.subjectType, subject_id: input.subjectId, case_id: caseId, reason: input.reason, placed_by: user.id })
      .select("*")
      .single()
  );
  await recordAction(req, { action: "legal_hold.place", subject: input.subjectId, caseId, detail: { reason: input.subjectType } });
  return row;
}

export async function releaseHold(req: Request, user: SessionUser, holdId: string, reason: string) {
  if (!RELEASERS.includes(user.role)) throw forbidden("Only the court or the registry can release a legal hold.");
  const hold = unwrapMaybe(await db.from("legal_holds").select("*").eq("id", holdId).maybeSingle()) as any;
  if (!hold) throw notFound("Legal hold");
  if (hold.released_at) throw conflict("This hold is already released.");
  const row = unwrap(
    await db
      .from("legal_holds")
      .update({ released_by: user.id, release_reason: reason, released_at: new Date().toISOString() })
      .eq("id", holdId)
      .select("*")
      .single()
  );
  await recordAction(req, { action: "legal_hold.release", subject: hold.subject_id, caseId: hold.case_id });
  return row;
}

export async function holdsForCase(caseId: string) {
  return unwrapList(await db.from("legal_holds").select("*").eq("case_id", caseId).order("placed_at", { ascending: false }));
}

/* ------------------------------------------------------------ export bundle */

/** Roles that receive the evidence files themselves in a bundle; everyone else gets digests and proofs. */
const FILE_ROLES: UserRole[] = ["police", "forensic_lab", "prosecutor", "judge", "court_admin"];
const FIR_ROLES: UserRole[] = ["police", "prosecutor", "judge", "court_admin"];

/**
 * A ZIP for filing: per item its passport, chain-of-custody form, Section 63
 * certificate (or why there is none), the chain proofs, and — only for roles that
 * may download evidence in the portal — the file itself. Never anything the
 * requester could not open in the portal: built with the requester's own role.
 */
export async function exportBundle(req: Request, user: SessionUser, scope: { caseId: string; evidenceId?: string | null }) {
  const caseRow = unwrapMaybe(await db.from("cases").select("id, case_reference, title, status, court_name, police_station").eq("id", scope.caseId).maybeSingle()) as any;
  if (!caseRow) throw notFound("Case");
  let items = unwrapList(await db.from("evidence_items").select("*").eq("case_id", scope.caseId).order("created_at", { ascending: true })) as any[];
  if (scope.evidenceId) items = items.filter((i) => i.id === scope.evidenceId);
  if (!items.length) throw notFound("Evidence for this export");

  const files: Record<string, Uint8Array> = {};
  const sums: string[] = [];
  const add = (path: string, bytes: Uint8Array) => {
    files[path] = bytes;
    sums.push(`${sha256Hex(bytes).slice(2)}  ${path}`);
  };
  const includeFiles = FILE_ROLES.includes(user.role);
  const fir = FIR_ROLES.includes(user.role) ? await getFirRecord(caseRow.id) : null;

  const manifest: any = {
    generatedAt: new Date().toISOString(),
    generatedForRole: user.role,
    network: chain.network,
    case: { reference: caseRow.case_reference, title: caseRow.title, status: caseRow.status, court: caseRow.court_name, fir: fir ? { number: fir.fir_number, year: fir.fir_year } : null },
    items: [],
  };

  for (const item of items) {
    const folder = `evidence/${item.public_ref}`;
    const view = await authorisedPassport(item.id, user.role);
    add(`${folder}/passport.pdf`, await buildPassportPdf(view.passport, { verifyUrl: verifyUrl(item.public_ref), generatedFor: user.role }));
    add(`${folder}/custody-form.pdf`, (await custodyFormPdf(item.id)).pdf);

    // The certificate names its signer, so only a role that may certify generates it here.
    if (!FILE_ROLES.includes(user.role)) {
      add(`${folder}/section63-certificate-NOT-INCLUDED.txt`, strToU8("The Section 63 certificate is produced by the party offering the record, not included in this copy.\n"));
    } else try {
      const cert = await renderCertificate(item.id, user, {});
      add(`${folder}/section63-certificate.pdf`, cert.pdf);
    } catch (error) {
      add(`${folder}/section63-certificate-NOT-GENERATED.txt`, strToU8(`The certificate could not be generated: ${error instanceof Error ? error.message : String(error)}\n`));
    }

    const anchors = unwrapList(
      await db.from("anchors").select("purpose, state, tx_hash, block_number, block_hash, chain_record_id, expected_digest, expected_event, confirmed_at").eq("subject_id", item.id)
    ) as any[];
    const txs = anchors.map((a) => a.tx_hash).filter(Boolean);
    const events = txs.length ? (unwrapList(await db.from("chain_events").select("event_name, tx_hash, block_number, log_index, args").in("tx_hash", txs)) as any[]) : [];
    const proofs = anchors.map((a) => ({
      ...a,
      explorer: a.tx_hash ? explorerUrl(a.tx_hash) : null,
      decodedEvents: events.filter((e) => e.tx_hash === a.tx_hash),
    }));
    add(`${folder}/chain-proofs.json`, strToU8(JSON.stringify(proofs, null, 2)));

    if (item.capture_manifest && view.capture) {
      add(`${folder}/capture-manifest.json`, strToU8(JSON.stringify(item.capture_manifest)));
    }
    if (includeFiles && !item.disposed_at && item.ipfs_cid) {
      try {
        const { plaintext, intact } = await fetchPlaintext(item.id);
        add(`${folder}/file/${item.file_name.replace(/[^A-Za-z0-9._-]+/g, "_")}`, plaintext);
        if (!intact) add(`${folder}/FILE-INTEGRITY-WARNING.txt`, strToU8("The stored file no longer hashes to its registered digest.\n"));
      } catch (error) {
        add(`${folder}/file-NOT-INCLUDED.txt`, strToU8(`The file could not be retrieved: ${error instanceof Error ? error.message : String(error)}\n`));
      }
    }

    manifest.items.push({
      reference: item.public_ref,
      fileName: includeFiles ? item.file_name : undefined,
      fileSha256: item.file_hash,
      anchoredDigest: item.anchored_digest,
      anchorMode: item.anchor_mode,
      source: item.source,
      verificationState: view.passport.state,
      agreesWithChain: view.passport.agreement,
      disposed: Boolean(item.disposed_at),
      fileIncluded: includeFiles && !item.disposed_at,
    });
  }

  add("bundle.json", strToU8(JSON.stringify(manifest, null, 2)));
  add(
    "README.md",
    strToU8(
      [
        `# Court export — ${caseRow.case_reference}`,
        "",
        `Generated ${manifest.generatedAt} for the role \`${user.role}\`. It contains only what that role can open in NyaySetu.`,
        "",
        "## How to verify this bundle independently",
        "",
        "1. Check every file against SHA256SUMS.txt (`sha256sum -c SHA256SUMS.txt`).",
        "2. For an uploaded item, the SHA-256 of the evidence file must equal `anchoredDigest` in bundle.json.",
        "3. For a live capture (anchorMode `manifest`), put the file's SHA-256 into `file.sha256` of capture-manifest.json,",
        "   serialise it as canonical JSON (keys sorted, no spaces), and hash that: it must equal `anchoredDigest`.",
        "4. Open each transaction in chain-proofs.json on a block explorer and confirm the `fileHash` of its",
        "   EvidenceRegistered event equals `anchoredDigest`. That comparison does not depend on NyaySetu at all.",
        "",
        "## What this does not prove",
        "",
        "A matching fingerprint shows a file is unchanged since it was registered. It does not show that what it depicts",
        "is true, that it was lawfully collected, or that a location reading was not spoofed. Legal documents in this",
        "bundle are templates to be checked with a legal practitioner.",
        "",
      ].join("\n")
    )
  );
  add("SHA256SUMS.txt", strToU8(sums.join("\n") + "\n"));

  const zip = zipSync(files, { level: 6 });
  const digest = sha256Hex(zip);
  await recordAction(req, {
    action: "export.bundle",
    subject: scope.evidenceId ?? scope.caseId,
    caseId: caseRow.id,
    detail: { state: includeFiles ? "with_files" : "proofs_only", txHash: undefined },
  });
  return { zip: Buffer.from(zip), digest, fileName: `nyaysetu-${caseRow.case_reference.replace(/[^A-Za-z0-9]+/g, "-")}${scope.evidenceId ? `-${items[0].public_ref}` : ""}.zip` };
}
