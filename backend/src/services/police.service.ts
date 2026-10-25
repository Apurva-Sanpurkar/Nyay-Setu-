import { Request } from "express";
import { db, unwrap, unwrapList, unwrapMaybe } from "../lib/supabase";
import { badRequest, conflict, notFound } from "../lib/errors";
import { canonicalHash } from "../lib/crypto";
import { recordAction } from "./audit";
import { anchorDocument } from "./verification/documentAnchor";
import { presentVerification } from "./evidence.service";
import { loadAnchor } from "./verification/anchors";
import { buildTemplatePdf } from "../lib/pdf/template";
import { MOVEMENT_LABEL, ROLE_LABEL, STAGE_LABEL, VERIFICATION_LABEL, istDateTime, istDateTimeSeconds, shortDigest } from "../lib/pdf/format";
import type { SessionUser, UserRole } from "../middleware/auth";

/**
 * Police workflow (2.0 · F13): seizures that group related items, the
 * malkhana (property room) register, and the memo and custody forms filled from
 * the record.
 */

/** Roles that may read where, from whom and in front of whom something was seized. */
const SEIZURE_DETAIL_ROLES: UserRole[] = ["police", "prosecutor", "judge", "court_admin"];

export interface SeizureInput {
  caseId: string;
  memoNumber: string;
  seizedAt: string;
  place: string;
  seizedFrom?: string | null;
  witnesses: { name: string; address?: string }[];
  notes?: string | null;
  items: { evidenceId: string; label: string; description?: string | null }[];
}

export async function createSeizure(req: Request, user: SessionUser, input: SeizureInput) {
  if (input.items.length === 0) throw badRequest("A seizure needs at least one item.");
  const ids = input.items.map((i) => i.evidenceId);
  if (new Set(ids).size !== ids.length) throw badRequest("An item appears twice in the same seizure.");

  const evidence = unwrapList(await db.from("evidence_items").select("id, case_id").in("id", ids)) as { id: string; case_id: string }[];
  if (evidence.length !== ids.length || evidence.some((e) => e.case_id !== input.caseId)) {
    throw badRequest("Every item must be evidence already registered in this case.");
  }
  const already = unwrapList(await db.from("seizure_items").select("evidence_id").in("evidence_id", ids)) as { evidence_id: string }[];
  if (already.length) throw conflict("An item is already part of another seizure.");

  // The memo's digest covers everything it says, so the anchored record proves
  // the list of items and their order have not been edited since.
  const memoDigest = canonicalHash({
    caseId: input.caseId,
    memoNumber: input.memoNumber,
    seizedAt: new Date(input.seizedAt).toISOString(),
    place: input.place,
    seizedFrom: input.seizedFrom ?? null,
    witnesses: input.witnesses,
    items: input.items.map((i, index) => ({ index: index + 1, evidenceId: i.evidenceId, label: i.label, description: i.description ?? null })),
  });

  const seizure = unwrap(
    await db
      .from("seizures")
      .insert({
        case_id: input.caseId,
        memo_number: input.memoNumber,
        memo_digest: memoDigest,
        seized_at: new Date(input.seizedAt).toISOString(),
        place: input.place,
        seized_from: input.seizedFrom ?? null,
        witnesses: input.witnesses,
        notes: input.notes ?? null,
        created_by: user.id,
      })
      .select("*")
      .single()
  ) as any;

  for (const [index, item] of input.items.entries()) {
    await db.from("seizure_items").insert({
      seizure_id: seizure.id,
      evidence_id: item.evidenceId,
      item_label: item.label,
      description: item.description ?? null,
      item_index: index + 1,
    });
  }

  const { anchor } = await anchorDocument({
    caseId: input.caseId,
    digest: memoDigest,
    subjectType: "seizure",
    subjectId: seizure.id,
    idempotencyKey: `seizure:${seizure.id}:memo`,
    actor: { id: user.id, role: user.role },
  });

  await recordAction(req, {
    action: "police.seizure",
    subject: seizure.id,
    caseId: input.caseId,
    detail: { items: input.items.length, state: anchor.state, txHash: anchor.tx_hash },
  });

  return { seizure: { ...seizure, items: input.items }, verification: presentVerification(anchor) };
}

export async function listSeizures(caseId: string, role: UserRole) {
  const seizures = unwrapList(
    await db.from("seizures").select("*").eq("case_id", caseId).order("seized_at", { ascending: false })
  ) as any[];
  if (seizures.length === 0) return [];

  const items = unwrapList(
    await db
      .from("seizure_items")
      .select("seizure_id, evidence_id, item_label, description, item_index")
      .in("seizure_id", seizures.map((s) => s.id))
  ) as any[];
  const evidence = items.length
    ? (unwrapList(
        await db
          .from("evidence_items")
          .select("id, file_name, file_hash, public_ref, current_stage, anchor_id")
          .in("id", items.map((i) => i.evidence_id))
      ) as any[])
    : [];
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const detail = SEIZURE_DETAIL_ROLES.includes(role);

  return seizures.map((s) => ({
    id: s.id,
    case_id: s.case_id,
    memo_number: s.memo_number,
    memo_digest: s.memo_digest,
    seized_at: s.seized_at,
    // Place, person and witnesses are off chain and role-gated.
    place: detail ? s.place : null,
    seized_from: detail ? s.seized_from : null,
    witnesses: detail ? s.witnesses : [],
    notes: detail ? s.notes : null,
    items: items
      .filter((i) => i.seizure_id === s.id)
      .sort((a, b) => a.item_index - b.item_index)
      .map((i) => ({ ...i, evidence: byId.get(i.evidence_id) ?? null })),
  }));
}

export async function seizureMemoPdf(seizureId: string, role: UserRole) {
  const seizure = unwrapMaybe(await db.from("seizures").select("*").eq("id", seizureId).maybeSingle()) as any;
  if (!seizure) throw notFound("Seizure");
  const [full] = (await listSeizures(seizure.case_id, role)).filter((s) => s.id === seizureId);
  const caseRow = unwrapMaybe(await db.from("cases").select("case_reference, title, police_station").eq("id", seizure.case_id).maybeSingle()) as any;
  const detail = SEIZURE_DETAIL_ROLES.includes(role);

  const officer = seizure.created_by
    ? (unwrapMaybe(await db.from("user_directory").select("full_name, designation").eq("id", seizure.created_by).maybeSingle()) as {
        full_name: string;
        designation: string | null;
      } | null)
    : null;
  const witnesses = (seizure.witnesses ?? []) as { name: string; address?: string }[];

  const pdf = await buildTemplatePdf({
    title: "Seizure Memo (Panchnama)",
    subtitle: `Case ${caseRow?.case_reference ?? "—"}${caseRow?.title ? ` · ${caseRow.title}` : ""}`,
    issuer: caseRow?.police_station ?? null,
    reference: full.memo_number,
    sections: [
      {
        heading: "1. Particulars of the seizure",
        body:
          `The articles listed below were seized on ${istDateTime(seizure.seized_at)} at ` +
          `${detail ? seizure.place : "[withheld from this copy]"}` +
          `${detail && seizure.seized_from ? `, from the possession of ${seizure.seized_from}` : ""}, in the presence of the ` +
          "witnesses named below. Each article was photographed or recorded, its SHA-256 digest was computed on the " +
          "recording device, and it was registered as a separate evidence record.",
      },
      {
        heading: "2. Witnesses (panch)",
        body: detail
          ? witnesses.map((w, i) => `${i + 1}. ${w.name}${w.address ? `, residing at ${w.address}` : ""}`).join("\n") || "No witnesses were recorded."
          : "[withheld from this copy]",
      },
      ...(detail && seizure.notes ? [{ heading: "3. Remarks", body: String(seizure.notes) }] : []),
    ],
    tables: [
      {
        heading: `${detail && seizure.notes ? "4" : "3"}. Articles seized`,
        columns: ["No.", "Article and description", "Evidence reference", "SHA-256 digest"],
        widths: [28, 160, 125, 170],
        rows: full.items.map((i: any) => [
          String(i.item_index),
          `${i.item_label}${i.description ? ` — ${i.description}` : ""}`,
          i.evidence?.public_ref ?? "—",
          i.evidence?.file_hash ?? "—",
        ]),
        emptyText: "No articles recorded",
      },
    ],
    digestLines: [["Digest of this memo's contents, anchored on the ledger", seizure.memo_digest ?? "Not yet anchored"]],
    signatures: [
      { role: "Seizing officer", name: officer?.full_name ?? null, designation: officer?.designation ?? null },
      ...witnesses.slice(0, 4).map((w, i) => ({ role: `Witness ${i + 1}`, name: detail ? w.name : null, designation: null })),
      ...(witnesses.length === 0 ? [{ role: "Witness", name: null, designation: null }] : []),
    ],
    footer: "Template generated by NyaySetu from the case record. Confirm the required form under the BNSS with a legal practitioner before use.",
  });
  return { pdf, memoNumber: full.memo_number as string };
}

/* ----------------------------------------------------------- malkhana */

const MOVEMENTS = ["IN", "OUT", "RETURN", "TRANSFER"] as const;
export type Movement = (typeof MOVEMENTS)[number];

/** IN or RETURN puts an item on the shelf; OUT or TRANSFER takes it off. */
function onShelfAfter(movement: Movement): boolean {
  return movement === "IN" || movement === "RETURN";
}

export async function malkhanaHistory(evidenceId: string) {
  return unwrapList(
    await db
      .from("malkhana_movements")
      .select("id, movement, location, shelf, reason, counterparty, performed_by, occurred_at, movement_digest, anchor_id")
      .eq("evidence_id", evidenceId)
      .order("occurred_at", { ascending: true })
  ) as any[];
}

export async function recordMovement(
  req: Request,
  user: SessionUser,
  evidenceId: string,
  input: { movement: Movement; location: string; shelf?: string | null; reason: string; counterparty?: string | null }
) {
  const item = unwrapMaybe(await db.from("evidence_items").select("id, case_id, disposed_at").eq("id", evidenceId).maybeSingle()) as any;
  if (!item) throw notFound("Evidence item");
  if (item.disposed_at) throw conflict("This item has been disposed of; the register is closed for it.");

  const history = await malkhanaHistory(evidenceId);
  const last = history.at(-1) as { movement: Movement } | undefined;
  const onShelf = last ? onShelfAfter(last.movement) : false;
  if ((input.movement === "IN" || input.movement === "RETURN") && onShelf) {
    throw conflict("This item is already in the malkhana. Record it going out before it can come in again.");
  }
  if ((input.movement === "OUT" || input.movement === "TRANSFER") && !onShelf) {
    throw conflict("This item is not in the malkhana, so it cannot be taken out.");
  }
  if (input.movement === "RETURN" && !last) throw conflict("Nothing has left the malkhana to be returned.");

  const occurredAt = new Date().toISOString();
  const digest = canonicalHash({
    evidenceId,
    movement: input.movement,
    location: input.location,
    shelf: input.shelf ?? null,
    reason: input.reason,
    counterparty: input.counterparty ?? null,
    occurredAt,
    previous: history.at(-1)?.movement_digest ?? null,
  });

  const row = unwrap(
    await db
      .from("malkhana_movements")
      .insert({
        evidence_id: evidenceId,
        case_id: item.case_id,
        movement: input.movement,
        location: input.location,
        shelf: input.shelf ?? null,
        reason: input.reason,
        counterparty: input.counterparty ?? null,
        performed_by: user.id,
        occurred_at: occurredAt,
        movement_digest: digest,
      })
      .select("*")
      .single()
  ) as any;

  const { anchor } = await anchorDocument({
    caseId: item.case_id,
    digest,
    subjectType: "malkhana_movement",
    subjectId: row.id,
    idempotencyKey: `malkhana:${row.id}`,
    actor: { id: user.id, role: user.role },
  });
  // The register is append-only; the anchor id lives on the anchor (subject_id),
  // so nothing about the written row is ever changed.

  await recordAction(req, {
    action: "police.malkhana",
    subject: evidenceId,
    caseId: item.case_id,
    detail: { movement: input.movement, state: anchor.state, txHash: anchor.tx_hash },
  });

  return { movement: row, verification: presentVerification(anchor) };
}

/** The register: every item in the caller's scope with where it is now. */
export async function malkhanaRegister(caseIds: string[] | null) {
  let query = db
    .from("malkhana_movements")
    .select("id, evidence_id, case_id, movement, location, shelf, reason, occurred_at")
    .order("occurred_at", { ascending: true })
    .limit(2000);
  if (caseIds) query = query.in("case_id", caseIds);
  const movements = unwrapList(await query) as any[];

  const latest = new Map<string, any>();
  for (const m of movements) latest.set(m.evidence_id, m);
  const ids = [...latest.keys()];
  const evidence = ids.length
    ? (unwrapList(await db.from("evidence_items").select("id, file_name, public_ref, kind, cases(case_reference)").in("id", ids)) as any[])
    : [];
  const byId = new Map(evidence.map((e) => [e.id, e]));

  return ids.map((id) => {
    const m = latest.get(id);
    return {
      evidence: byId.get(id) ?? null,
      onShelf: onShelfAfter(m.movement),
      location: m.location,
      shelf: m.shelf,
      lastMovement: m.movement,
      lastReason: m.reason,
      since: m.occurred_at,
    };
  });
}

export async function movementVerifications(movementIds: string[]) {
  if (movementIds.length === 0) return new Map<string, ReturnType<typeof presentVerification>>();
  const anchors = unwrapList(
    await db.from("anchors").select("*").eq("subject_type", "malkhana_movement").in("subject_id", movementIds)
  ) as any[];
  return new Map(anchors.map((a) => [a.subject_id, presentVerification(a)]));
}

/* ----------------------------------------------------------- custody form */

/** The chain-of-custody form for one item: every hop, check and movement, from the record and the anchors. */
export async function custodyFormPdf(evidenceId: string) {
  const item = unwrapMaybe(await db.from("evidence_items").select("*, cases(case_reference, title)").eq("id", evidenceId).maybeSingle()) as any;
  if (!item) throw notFound("Evidence item");
  const [custody, checks, movements] = await Promise.all([
    unwrapList(
      await db
        .from("custody_events")
        .select("from_stage, to_stage, actor_role, occurred_at, tx_hash, confirmed_hash")
        .eq("evidence_id", evidenceId)
        .order("occurred_at", { ascending: true })
    ) as any[],
    unwrapList(
      await db
        .from("integrity_checks")
        .select("matched, checked_by_role, context, tx_hash, created_at")
        .eq("evidence_id", evidenceId)
        .order("created_at", { ascending: true })
    ) as any[],
    malkhanaHistory(evidenceId),
  ]);
  const anchor = item.anchor_id ? await loadAnchor(item.anchor_id) : null;
  const caseRow = unwrapMaybe(await db.from("cases").select("police_station").eq("id", item.case_id).maybeSingle()) as { police_station: string | null } | null;

  const pdf = await buildTemplatePdf({
    title: "Chain of Custody Record",
    subtitle: `Case ${item.cases?.case_reference ?? "—"}${item.cases?.title ? ` · ${item.cases.title}` : ""}`,
    issuer: caseRow?.police_station ?? null,
    reference: item.public_ref,
    sections: [
      {
        heading: "1. Description of the article",
        body:
          `${item.file_name}, a ${String(item.kind).replace(/_/g, " ")} record. ` +
          `Present custody: ${STAGE_LABEL[item.current_stage] ?? item.current_stage}. ` +
          `Status on the ledger: ${VERIFICATION_LABEL[anchor?.state ?? "LOCAL_ONLY"]}.`,
      },
    ],
    digestLines: [
      ["SHA-256 digest of the file", item.file_hash],
      [item.anchor_mode === "manifest" ? "Value anchored on the ledger (capture manifest digest)" : "Value anchored on the ledger", item.anchored_digest ?? "Not yet anchored"],
    ],
    tables: [
      {
        heading: "2. Transfers of custody",
        columns: ["Date and time", "From", "To", "Received by", "Transaction"],
        widths: [105, 90, 90, 85, 113],
        rows: custody.map((c) => [
          istDateTimeSeconds(c.occurred_at),
          c.from_stage ? STAGE_LABEL[c.from_stage] ?? c.from_stage : "Registration",
          STAGE_LABEL[c.to_stage] ?? c.to_stage,
          c.actor_role ? ROLE_LABEL[c.actor_role] ?? c.actor_role : "—",
          shortDigest(c.tx_hash),
        ]),
        emptyText: "No transfers recorded",
      },
      {
        heading: "3. Integrity checks",
        columns: ["Date and time", "Result", "Checked by", "Context", "Transaction"],
        widths: [105, 65, 90, 110, 113],
        rows: checks.map((c) => [
          istDateTimeSeconds(c.created_at),
          c.matched ? "Matched" : "Did not match",
          c.checked_by_role ? ROLE_LABEL[c.checked_by_role] ?? c.checked_by_role : "—",
          String(c.context ?? "—").replace(/_/g, " "),
          shortDigest(c.tx_hash),
        ]),
        emptyText: "No checks recorded",
      },
      {
        heading: "4. Malkhana (property room) register",
        columns: ["Date and time", "Movement", "Location / shelf", "Reason", "Entry digest"],
        widths: [105, 65, 110, 90, 113],
        rows: movements.map((m) => [
          istDateTimeSeconds(m.occurred_at),
          MOVEMENT_LABEL[m.movement] ?? m.movement,
          `${m.location}${m.shelf ? ` / ${m.shelf}` : ""}`,
          m.reason,
          shortDigest(m.movement_digest),
        ]),
        emptyText: "No movements recorded",
      },
    ],
    signatures: [
      { role: "Officer producing this record", name: null, designation: null },
      { role: "Received by (court / prosecution)", name: null, designation: null },
    ],
    footer: "Template generated by NyaySetu from the case record. Each transaction listed can be verified on a public block explorer. Confirm the form required by your court with a legal practitioner.",
  });
  return { pdf, publicRef: item.public_ref as string, caseId: item.case_id as string };
}
