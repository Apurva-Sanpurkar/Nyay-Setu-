# NyaySetu 2.0 — Pre-implementation audit

This is the state of the repository **before** any 2.0 work, read from the code
rather than from the README. Where the README and the code disagree, the code
is what is recorded here.

Audited at commit `698d2b3` on 2026-10-15.

---

## 1. Stack as it actually is

The 2.0 brief describes React 19, Express 5 and Tailwind 4. The repository runs:

| Layer | Brief said | Repository has |
|---|---|---|
| Web | React 19, Vite, Tailwind 4 | **React 18.3**, Vite 8, **Tailwind 3.4** |
| API | Express 5, TS strict, Zod | **Express 4.21**, TypeScript strict, Zod 3 |
| Contracts | Solidity 0.8.24, Hardhat, OZ 5 | same |
| Database | Supabase Postgres, migrations 001–007 | same |
| AI | Flask + scikit-learn | same |
| Mobile | Expo | Expo SDK 52, React Native 0.76 (no `node_modules` installed) |

No framework upgrade is part of 2.0. Upgrading React or Express in the same
change as twenty features would make every regression ambiguous.

---

## 2. Case creation and FIR linkage

**A case-creation flow exists**, contrary to the brief's default assumption:

- `POST /api/cases` (police, court_admin) in `backend/src/routes/cases.ts`.
- The registering officer is given `write` access automatically.
- `GET /api/cases`, `GET /api/cases/:id`, `GET /api/cases/:id/overview`,
  assignment management and `PATCH /api/cases/:id/status` exist.

**What is missing or problematic for 2.0:**

1. **The FIR number is mandatory and is the case's identity.** `cases.fir_number`
   is `NOT NULL UNIQUE`, and `case_id_hash = keccak256(upper(fir_number))`. That
   hash is the `caseId` every contract stores. FIR numbers are low-entropy
   (station / serial / year), so the on-chain case id can be reversed by
   enumeration — the FIR number is effectively public on chain. This conflicts
   with the 2.0 privacy rule "FIR numbers never on chain".
2. No separate case reference. There is nothing to call a case by when there is
   no FIR yet (a complaint under inquiry, a court-initiated matter).
3. FIR uniqueness is global, not per station and year.
4. No case timeline endpoint. `action_log` has `case_id`, but nothing presents it.
5. FIR visibility is not role-gated: every assigned role (including defence and
   the accused, if assigned) receives `fir_number` in every case payload.

## 3. Evidence lifecycle in code

| Step | Where it happens | DB | Contract | Indexer |
|---|---|---|---|---|
| Hash | Browser (`frontend/src/lib/hash.ts`, WebCrypto) or phone (`mobile/src/lib/hash.ts`, expo-crypto over raw bytes). Server re-hashes and refuses a mismatch (`evidence.service.ts:registerEvidence`, recorded in `action_log` as `refused`). | — | — | — |
| Screen | AI anomaly model, before anchoring. Degrades to "skipped" if unavailable. | `evidence_items.anomaly_*`, `ai_flags` | `anchorAnomalyFlag` (write-once) | yes |
| Encrypt + store | AES-256-GCM, Pinata or a local folder fallback. | `ipfs_cid`, `encryption_*` | — | — |
| Register | Row inserted **first**, then `registerEvidence`. | `evidence_items`, `custody_events` (genesis), `chain_tx` | `EvidenceRegistered` | yes |
| Custody transfer | Receiver submits the digest they recomputed. `reportIntegrityCheck` is sent **first**, then `transferCustody` only if the DB says it matched. | `integrity_checks`, `custody_events`, `evidence_items.current_stage` | `IntegrityVerified` / `IntegrityMismatch`, then `CustodyTransferred` | yes |
| Independent verify | Reads `getEvidence` from chain, compares, optionally anchors via `reportIntegrityCheck`. Reports whether the DB still agrees with the chain. | `integrity_checks`, `action_log` | optional `IntegrityVerified`/`IntegrityMismatch` | yes |
| Forensic report | `anchorForensicResult`, **write-once per evidence id**. | `forensic_reports` | `ForensicResultAnchored` | yes |

### Where state lives

- **Authoritative:** `EvidenceChain` storage — file hash, case id, coordinates,
  stage, custody array, mismatch count, report hash, anomaly flag hash.
- **Readable record:** `evidence_items`, `custody_events`, `integrity_checks`,
  `forensic_reports`.
- **Bookkeeping:** `chain_tx` (pending/confirmed/failed per tx hash),
  `chain_events` (indexer cache), `indexer_state` (cursor per contract per chain).

## 4. How tamper refusal is recorded

**The mechanism is correct.** `transferCustody()` in the service calls
`reportIntegrityCheck(evidenceId, submittedHash)` **before** attempting the
transfer. That function never reverts on a mismatch; it increments
`mismatchCount` and emits `IntegrityMismatch` in a **successful** transaction.
The service then writes an `integrity_checks` row and an `action_log` row with
`outcome = 'refused'`, and does **not** send `transferCustody` at all.
`EvidenceChain.sol` itself says the same thing in its header comment, and
`contracts/test/EvidenceChain.test.ts` ("anchors a failing check permanently
instead of reverting") covers it.

**Wording that overclaims, to correct:**

| Location | Problem |
|---|---|
| `backend/src/lib/chain.ts`, `FRIENDLY_REVERTS.HashMismatch` | Says "the mismatch was recorded". This message is shown when `transferCustody` **itself reverts** with `HashMismatch`, and that revert recorded nothing. |

**A logic gap behind that wording:** the service decides "matched" by comparing
against the **database** copy of the digest. If the database row had been
altered to agree with a tampered file, the service would see a match, the chain
would emit `IntegrityMismatch`, and the service would then send a
`transferCustody` that reverts — surfacing the misleading message above. 2.0
decides the outcome from the decoded `reportIntegrityCheck` event (the chain's
own comparison), not from the database.

Correct statements, kept: Handbook, `evidence.service.ts`, `design-decisions.md`
all describe the separate integrity-check transaction, which is accurate.

## 5. Statuses, enums and indexer behaviour

- `case_status`: registered, under_investigation, charge_sheeted, trial, disposed.
- `custody_stage`: SCENE, FORENSIC_LAB, PROSECUTOR, COURT (strictly linear on chain).
- `chain_tx_status`: pending, confirmed, failed.
- `summons_status`: PENDING, DELIVERED, FAILED.
- `violation_kind`: GEO_FENCE_BREACH, MISSED_CHECK_IN, NO_CONTACT_BREACH, OTHER.

**There is no verification state for evidence.** An item whose registration
transaction failed simply has `chain_evidence_id = null`; the UI cannot tell
"still pending" from "failed" from "never attempted".

**Confirmation:** `submit()` waits for `CHAIN_CONFIRMATIONS` (default 1) and marks
`chain_tx.confirmed` on a successful receipt. It does not check the decoded event
against the expected digest, does not track depth beyond that one wait, and has
no reorg handling.

**Indexer:** polls `queryFilter("*")` per contract in windows, cursor keyed by
`contract@chainId`, idempotent upsert on `(tx_hash, log_index)`. It never revisits
blocks it has passed, so a reorg after indexing leaves stale rows.

### Where DB and chain can drift

1. Registration row inserted, transaction fails → row with no chain id, no state.
2. Transaction succeeds, the follow-up `update` (chain id, tx hash) fails → chain
   has it, DB does not know its id.
3. Custody transfer confirmed on chain, `custody_events` insert fails → trails
   disagree (the UI already compares lengths and flags this).
4. Anomaly flag anchoring failure is logged and swallowed.
5. A reorg after confirmation.
6. Direct DB edits (caught by the audit trigger, but nothing compares to chain).

## 6. EvidenceChain interface

`registerEvidence(bytes32 caseId, bytes32 fileHash, int256 gpsLat, int256 gpsLng, bytes32 officerAadhaarToken)`

- **No metadata field.** There is no slot for a manifest hash besides `fileHash`.
- **Raw coordinates go on chain today**, in storage and in the
  `EvidenceRegistered` event, for every item.
- **An Aadhaar-derived token goes on chain** for every registration
  (`officerAadhaarToken`, an HMAC with a server pepper — pseudonymous, but derived
  from Aadhaar).
- `GeoMath.validate` accepts `(0, 0)`, so coordinates can be withheld without a
  contract change.
- The keeper wallet signs every transaction and therefore holds every role.

Consequence for F10/F12: the manifest digest can be anchored through the existing
`fileHash` slot with no contract change. See `docs/DECISIONS.md` D-04.

## 7. i18n, accessibility, offline, PDFs

- **i18n:** none. All copy is English string literals. No Devanagari font is loaded.
- **Accessibility:** good intent (40 `aria-*` attributes, labelled inputs, focus
  management in `Modal`, colour never used alone in status chips). No skip link,
  no large-text mode, no automated audit has ever been run.
- **Theme:** dark by default; light follows the OS preference. The DB column
  `users.theme` defaults to `dark`.
- **Mobile offline:** none. Capture requires a live session and network; nothing
  is queued. Gallery picking is allowed in the capture screen.
- **PDF:** PDFKit with a typeset `CourtDocument` builder (`backend/src/lib/pdf`)
  producing the Final Report / charge sheet. No passport, certificate or forms.
- **QR:** none. **ZIP:** none.

## 8. Baseline results (run 2026-10-15, before any change)

| Check | Command | Result |
|---|---|---|
| Contract tests | `npm --prefix contracts test` | **53 passing** (9 s) |
| Backend types | `npm --prefix backend run typecheck` | **pass** |
| Frontend build | `npm --prefix frontend run build` | **pass** (tsc + vite, CSS animation check ok) |
| Connection check | `npm --prefix backend run check` | **pass**: Supabase connected, 16 tables, PII functions present, 7 roles, SMTP authenticated, chain ready on Sepolia |
| Chain check | `npm run chain:check` (live Sepolia, block ≈ 11 921 724) | **all checks passed**: EvidenceChain 12, SummonsChain 5, BailChain 7. "All checks passed. The backend and the contracts agree." |
| Root `check` script | `npm run check` | **does not exist** at the root; it lives in `backend/` |
| Mobile typecheck | — | not runnable: `mobile/node_modules` absent |

Notes:

- `chain:check` sends real Sepolia transactions (≈ 20 per run). Subsequent
  regression runs use a local Hardhat node so the keeper's testnet balance is not
  spent on every feature.
- `backend/.env` pins contract addresses (`0x3902…`, `0xCb99…`, `0x1AA6…`) that
  differ from the uncommitted `contracts/deployed/sepolia.json` in the working tree
  (`0x5498…`, `0x37E7…`, `0x3c97…`). The env override wins. That working-tree file
  is the user's and is left untouched.

## 9. Other findings

- Several strings described the project in terms of its origin rather than its licence status (OTP providers,
  Handbook, OTP panels). They are reworded to describe the licensing constraint
  itself.
- `users.theme` defaults to `dark`; 2.0 makes the light theme the default
  regardless of the operating system.
- `evidence.service.ts:verifyAgainstChain` already reads the chain independently
  of Postgres. The Passport reuses that approach.
