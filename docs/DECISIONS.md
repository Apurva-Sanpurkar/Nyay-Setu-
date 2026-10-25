# Decisions

Every non-obvious choice made while building NyaySetu 2.0, with the reason and
what it costs. Numbered so code comments can cite them (`see DECISIONS D-04`).

---

### D-01 · No framework upgrades in 2.0

React stays on 18, Express on 4, Tailwind on 3. Upgrading at the same time as
twenty features would make every regression ambiguous between "the feature" and
"the framework". The brief's version numbers are recorded as a discrepancy in
`AUDIT_2_0.md` §1.

### D-02 · Cases get their own reference; FIR becomes optional and off chain

- New column `cases.case_reference` (`NS/<STATION>/<YEAR>/<SERIAL>`), unique,
  always present. Existing rows are back-filled from their FIR number.
- `fir_number` becomes nullable (a relaxation, not a destructive change).
  Uniqueness moves to **(station, year, FIR number)**, which is how FIRs are
  actually numbered.
- For **new** cases the on-chain `caseId` is
  `keccak256("nyaysetu:case:v2:" || case_reference || ":" || 32 random bytes)`.
  The salt is stored in `cases.case_salt`. Nobody can recover the FIR — or even
  the case reference — from the chain.
- **Existing** cases keep `keccak256(FIR)`; their anchors are already on chain and
  cannot be re-keyed. This is listed as a residual in the final report.
- FIR number, FIR date and the FIR's police station are returned only to police,
  prosecutor, judge and court_admin. Defence and the accused see that an FIR is
  linked, not its number.

### D-03 · Raw coordinates are off chain by default

`ANCHOR_RAW_COORDS_ON_CHAIN` (default `false`). When false, every new
`registerEvidence` call passes `(0, 0)`; `GeoMath.validate` accepts that. The
real fix is committed inside the capture manifest digest (D-04), so it is
tamper-evident without being public. Setting the flag to `true` restores 1.0
behaviour (micro-degrees in storage and in `EvidenceRegistered`) — useful for a
demonstration, and a permanent disclosure of where every item was collected.

### D-04 · Capture manifests are anchored through the existing `fileHash` slot

`EvidenceChain` has no metadata field. Rather than change the contract:

- **Uploads** (`source = upload`) anchor the file's SHA-256, exactly as in 1.0.
- **Live captures** (`source = capture`, photo / video / audio-video) anchor the
  SHA-256 of a canonical JSON manifest that itself contains the file digest, the
  GPS fix, device time, device id, case reference and app version.

Verification recomputes `file → fileSha256 → manifest → manifestSha256` and
compares that to the chain. Altering a single pixel, a coordinate or the
timestamp changes the anchored value.

Custody transfers keep working because the receiver's client (or the server,
using the stored manifest) derives the manifest digest from the file digest the
receiver computed; the contract still compares one `bytes32` with another.

Public verification of a capture works from the photo alone: the server holds
the manifest, substitutes the visitor's file digest into it, and compares the
result with the chain. A tampered database cannot produce a false match without
a SHA-256 pre-image. The manifest itself (it contains coordinates) is shown only
to authorised case roles.

Cost: two anchoring modes to explain. Recorded in `evidence_items.anchor_mode`.

### D-05 · Evidence registration uses an officer pseudonym, not an Aadhaar token

`registerEvidence` needs a non-zero `officerAadhaarToken`. 2.0 passes
`HMAC(pepper, "nyaysetu:officer:" || user_id)` instead of the Aadhaar-derived
token, so no Aadhaar-derived value is written for new evidence and an officer no
longer needs an Aadhaar record to register an item. Summons acknowledgement and
bail check-in still bind to the citizen's keyed Aadhaar token, because the
deployed `SummonsChain` and `BailChain` compare it on chain; changing that needs
a contract migration and is listed as a residual.

### D-06 · Extra digests are anchored as standalone records

`anchorForensicResult` is write-once per evidence id, so a corrected report, a
forensic working copy or a Section 63 certificate cannot use it twice. These are
anchored through `registerEvidence` with zeroed coordinates and the case's
`caseId`, producing a separate on-chain record whose `fileHash` is the
document's digest. The relationship (original → working copy, report v1 → v2) is
stored off chain in `anchors.parent_anchor_id` and the feature tables. The
contract is unchanged.

### D-07 · One shared integrity package, mirrored into the backend

`packages/integrity` is the only implementation of canonical JSON, the capture
manifest, SHA-256 (streaming, pure TypeScript, for files too large to hold in
memory) and HMAC. The web app and the Expo app import it through a path alias.
The API is built inside a Docker context that contains only `backend/`, so it
cannot reach `../packages`; `npm run integrity:sync` copies the source into
`backend/src/shared/integrity/` and `npm run integrity:check` fails if the copy
has drifted by a single byte. Golden test vectors run against all three.

### D-08 · Verification state is an application concept

`LOCAL_ONLY → SUBMITTED → CONFIRMED`, plus `INTEGRITY_MISMATCH`, `SYNC_ERROR`,
`REVIEW_REQUIRED`, live on the `anchors` table and are driven by one module
(`backend/src/services/verification/stateMachine.ts`) with an explicit transition
table. They are **not** contract states. `CONFIRMED` requires a successful
receipt, the expected event decoded from it with the expected digest and case,
and `CONFIRMATION_DEPTH` blocks on top.

### D-09 · Migrations are written, validated locally, and not applied to the live database

008 onward are additive. They are validated by applying 001–0xx in order to an
in-process Postgres (PGlite) with the Supabase roles stubbed. They are **not**
applied to the project's Supabase instance from this machine: altering a live
database is a step for its owner. The run order is in the final report.

### D-10 · Tests do not need Supabase or Sepolia

- Route tests run the real Express app against an in-memory implementation of
  the subset of the Supabase query builder the API uses (`NYAY_DB=memory`,
  refused when `NODE_ENV=production`).
- Chain tests run against a local Hardhat node.
- `chain:check` against Sepolia is run once at the start and once at the end, not
  after every feature, because each run spends ≈ 20 testnet transactions.

### D-11 · The light theme is the default, whatever the operating system says

The palette is rebuilt light-first. Dark remains available from the theme
switch and is remembered per browser and per account, but a first visit is
always light. Migration 008 changes the column default to `light` and resets
every stored preference to `light` once — the old default was `dark`, and the
database cannot tell a deliberate choice from the default. Anyone who wants dark
picks it again with one click.
