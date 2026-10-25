# NyaySetu 2.0 — final report

Date: 17 October 2026. Branch `main`, 24 commits from `56f0634` to `6a6da41`.

## Summary

NyaySetu 2.0 turns the 1.0 proof of concept into a system an office could run:
every chain write now has an honest verification state; evidence carries a
capture manifest and a public Integrity Passport; the police, laboratory,
prosecution, court, defence and accused each have their own workflow screens;
irreversible acts need two people; the whole web interface works in English,
Hindi and Marathi on phones and desktops in a light theme; and the field app
works offline. All local test suites pass; nothing was deployed and no live
database was changed.

## Feature coverage

| # | Feature | Status | Where |
|---|---|---|---|
| F1 | Case intake with own reference; FIR off chain, role-gated | Done | migration 008, `case.service.ts`, `NewCasePage`, `FirCard` |
| F2 | Verification state machine (6 states, 16 transitions, tracker, retry, idempotency) | Done | migration 009, `services/verification/*`, `VerificationPanel`, `docs/VERIFICATION_STATES.md` |
| F3 | Evidence Integrity Passport (public page, PDF, QR, file check) | Done | migration 010, `passport.service.ts`, `/verify/:ref` |
| F4 | Audit timeline with trust labels; discrepancy alerts | Done | `alerts.service.ts`, `AuditTimelineCard`, `AlertsPage` |
| F5 | Explainable AI outputs with human review | Done | `aiExplain.service.ts`, `AiInsightsCard` |
| F6 | Jan-Sahayak EN/HI/MR, text size, accessibility | Done; translations unreviewed | `frontend/src/i18n`, `packages/integrity/src/explain.ts`, `docs/JAN_SAHAYAK.md` |
| F7 | Mobile field capture, offline queue | Done; device signing on mobile not done | `mobile/src/lib/queue*.ts`, `CaptureScreen.tsx` |
| F8 | Security hardening | Done | `f08-authorization.test.ts`, `checkBundleSecrets.mjs`, `docs/SECURITY.md` |
| F9 | Metrics, user-testing kit, demo, docs, contributions | Done; no user study run | `docs/metrics`, `docs/USER_TESTING.md`, `docs/DEMO.md`, `docs/TEAM_CONTRIBUTIONS.md` |
| F10 | Live camera + GPS capture anchored by manifest | Done (web and mobile) | `capture.tsx`, `packages/integrity/src/manifest.ts` |
| F11 | Section 63 certificate PDF from the record | Done (template) | `certificate.service.ts`, `DocumentsCard`, `TemplatesPage` |
| F12 | Video capture for search and seizure, resumable upload | Done | migration 011, `upload.service.ts`, `journal.ts` |
| F13 | Seizures, malkhana register, memo and custody forms | Done | `police.service.ts`, `SeizuresPage`, `MalkhanaPage` |
| F14 | Forensic laboratory: intake re-check, working copies, versioned reports, queue | Done | `lab.service.ts`, `LabWorkPanel`, `ForensicInbox` |
| F15 | Prosecutor readiness view | Done | `prosecutionOverview`, `ProsecutionReadiness` |
| F16 | Defence access requests and objections | Done | `court.service.ts`, `AccessRequestsPage`, `CourtRecordCard` |
| F17 | Judge: hearings, orders, ranked bail compliance, findings | Done | `HearingsPage`, `BailComplianceCard` |
| F18 | Accused/witness: obligations, reasons for a missed check-in, reminders | Done | `ObligationsCard`, `AccusedHelpPage`, `notify.service.ts` |
| F19 | Two-person approval, legal holds, disposal, court export bundle, integration design | Done; integration is design only | `governance.service.ts`, `ApprovalsPage`, `GovernanceCard`, `docs/INTEGRATION.md` |
| F20 | Evidence kit (story, demo, metrics) | Done | `docs/STORY.md`, `docs/DEMO.md`, `docs/metrics/METRICS.md` |

## Commands and results

All run on 17 October 2026 on Windows 11, Node 24, without Supabase, email or
a public network (in-memory database, simulated or local Hardhat chain).

| Check | Command | Result |
|---|---|---|
| Contracts | `npm run contracts:test` | 53 passing |
| API | `cd backend && npm test` | 111 tests, 111 pass, 0 fail |
| API types | `cd backend && npx tsc --noEmit` | exit 0 |
| Migrations | `cd backend && npm run db:validate` | 12 migrations applied cleanly on PGlite; RLS and audit triggers on every 2.0 table |
| Shared package | `npm run test:integrity` | 25 tests, 25 pass |
| Shared package mirror | `npm run integrity:check` | exit 0 (backend copy in sync) |
| Web build | `cd frontend && npm run build` | built; WCAG AA contrast in both themes; 37 of 37 navigation links routed; 31 files scanned, no secrets |
| Field app types | `cd mobile && npx tsc --noEmit` | exit 0 |
| Field app tests | `cd mobile && npm test` | 9 tests, 9 pass |
| Field app bundle | `npx expo export --platform android` | 593 modules bundled |
| Browser flow | `npm run local`, then `cd frontend && npm run ui:flow` | passed: case registered, photo captured with GPS, passport opened, wrong file refused |
| Every page, every role (desktop) | `npm run ui:smoke` | 45 / 45 pages pass |
| … at phone width | `npm run ui:smoke -- --mobile` | 45 / 45 pages pass, no horizontal overflow |
| … in Hindi | `npm run ui:smoke -- --lang=hi` | 45 / 45 pages pass |
| … in Marathi | `npm run ui:smoke -- --lang=mr` | 45 / 45 pages pass |
| Dependencies | `npm audit --omit=dev` (backend, frontend, contracts), `pip-audit` | 0 vulnerabilities each |
| Metrics | `cd backend && npm run metrics` | see below |

### Metrics (from `docs/metrics/metrics.csv`)

| Metric | Value |
|---|---|
| Tampered files detected (one byte changed), 200 items | 100 % |
| Genuine files confirmed | 100 % |
| Public check latency, in process, p50 / p95 | 3.3 ms / 4.9 ms |
| Unauthorized read attempts blocked | 258 of 258 (100 %) |
| Sync with 35 % of sends failed by injection | 65 % first attempt, 100 % after one retry, 0 lost |

These come from a simulated chain and an in-memory database: they show the
application logic is correct, not how a public network behaves under load.

## Not run

- **`npm run chain:check` against Sepolia.** It sends about twenty
  transactions to the live test network from the deployment wallet. It passed
  at the start of this work; it was not repeated, because sending transactions
  is an outward action best taken by the project owner after checking which
  contract addresses `backend/.env` points at (see caveats). Run it after
  following `docs/api-keys.md` step 9.
- **Migrations 008–012 on the live Supabase project.** Validated on PGlite
  only. Apply them as in `docs/api-keys.md` step 2, after a backup.
- **A user study.** The kit is ready (`docs/USER_TESTING.md`); no participants
  have been tested.

## Gaps and known limitations

- Bail check-in coordinates are sent to `BailChain`, because the contract
  checks the geofence on chain. Evidence coordinates stay off chain. Changing
  this needs a contract change, deliberately not made.
- Hindi and Marathi text has not been reviewed by native speakers.
- The mobile app sends capture manifests unsigned; the web client signs with a
  non-extractable device key. Mobile device keys (SecureStore) are not built.
- The mobile app's Expo build tooling carries 8 dependency advisories that need
  an Expo SDK upgrade (deferred under D-01); they run on the developer's machine,
  not in the app.
- The Section 63 certificate and the forms are templates to be checked by a
  legal practitioner; the PDFs say so.
- CCTNS, ICJS and e-Courts integration is a design document, not code.
- No screen-reader user has tested the interface.

## Decisions taken

D-01 to D-11 are recorded in `docs/DECISIONS.md`. In short: no framework
upgrades; a salted on-chain case key instead of the FIR; raw evidence
coordinates off chain by default; capture-manifest digest anchored in the
existing file-hash slot; officer pseudonyms by HMAC; extra digests anchored as
standalone records rather than contract changes; one shared integrity package
mirrored into the backend; verification state kept by the application, not the
contract; migrations validated on PGlite; tests independent of Supabase and
Sepolia; light theme by default regardless of the operating system.

Further choices made in this phase:

- Portal pages load on demand (main bundle 597 kB → 218 kB).
- The build fails on a dead navigation link or anything resembling a secret.
- The authorization test reads the live route table, so new routes are covered
  automatically.
- The mobile queue never retries a refusal blindly and never drops an item
  without an explicit discard.

## Caveats for whoever deploys this

- `backend/.env` contains explicit contract addresses that differ from the
  working-tree `contracts/deployed/sepolia.json` (which has uncommitted local
  changes that were left untouched). Before `chain:check` or a deployment,
  decide which deployment is current and either clear the three
  `*_CHAIN_ADDRESS` lines or make them match.
- Until migrations 008–012 run, `/api/health` lists them as missing and the 2.0
  features answer `SCHEMA_OUT_OF_DATE`.
- The database refuses updates and deletes on `forensic_reports` (append-only
  by design). The 1.0 `flow:check` script cleans up after itself and was not
  re-run against 2.0; expect its cleanup step to fail on any report it filed,
  and run it only against a test project.
