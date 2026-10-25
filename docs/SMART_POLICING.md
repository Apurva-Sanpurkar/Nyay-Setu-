# Smart policing: Vehicle Trace and Third Eye

Two modules on the Police Dashboard that work **across police stations** rather
than inside one case. They reuse NyaySetu's sessions, RBAC, CSRF, audit trail,
encrypted storage and verification (anchoring) pipeline; nothing existing was
rebuilt.

| | Vehicle Trace | Third Eye |
|---|---|---|
| What | Lost, stolen, found, abandoned and suspicious vehicles | Suspect / accused / convicted person records and their FIRs across stations |
| Produces | **Matches** between a sought and a sighted vehicle | **Leads**: possible duplicate records, same image on two records, related cases |
| Decided by | An officer of either station involved, in writing | An investigator, in writing |
| Alerts | The station holding the complaint | The other station, when a related-case lead is confirmed |
| On chain | Digests of the report, photographs, match verification, recovery, handover, closure | Digests of the record, each FIR link, each photograph, each change |
| Never on chain | Registration number, owner, location | Name, description, photograph |

---

## 1 · How it fits the existing system

```
 Police Dashboard (React)                         API (Express, Vercel Function)
 ─────────────────────────                        ───────────────────────────────
 /police/vehicles            ──► /api/vehicles       routes/vehicles.ts ─► services/vehicleTrace.service.ts
 /police/vehicles/:id                                                       │ matching (lib/similarity.ts)
 /police/third-eye           ──► /api/third-eye      routes/thirdEye.ts ─► services/thirdEye.service.ts
 /police/third-eye/:id                                                      │ leads, search, audit
 /police/station-alerts      ──► /api/smart/alerts   routes/smart.ts   ─► services/smart/stationAlerts.service.ts
 /police/analytics           ──► /api/smart/overview
 <SecureImage>               ──► /api/smart/media/:id                   ─► services/smart/media.service.ts
                                                                          │  AES-256-GCM → Pinata (or local)
                                                                          ▼
                                     services/smart/recordAnchor.ts ─► verification/anchors.ts (existing)
                                                                          │  EvidenceChain.registerEvidence(key, digest, 0, 0, officer)
                                                                          ▼
                                                                      Sepolia / local Hardhat
```

* **Auth and RBAC** — the existing session cookie, `requireAuth`, `requireRole`, CSRF and rate limiters.
  `police` reads and writes both modules; `court_admin` (the registry) may read Vehicle Trace,
  the analytics and the Third Eye activity log for oversight, but cannot open person records.
* **Station** — taken from the officer's account (`users.station_or_court`), never from the request.
* **Audit** — every write, view, search (with its stated purpose), photo view and refused
  action goes to `action_log`; every row change goes to the existing `audit_log` trigger.
* **Anchoring** — `anchorRecord()` uses the same contract call and the same six verification
  states as evidence. These records belong to no single case, so the on-chain "case" field is
  `sha256("nyaysetu:<module>:<record id>")`: all events of one vehicle report share one key,
  and the key says nothing about the vehicle or person.
* **Storage** — photos are compressed on the device (≤1600 px JPEG, which also strips EXIF),
  sniffed by magic bytes on the server (JPEG/PNG/WebP only), encrypted with the evidence key,
  stored on Pinata, and re-hashed on every read. A substituted file is refused, not shown.

## 2 · Data model (migration `014_smart_policing.sql`)

| Table | Purpose | Notes |
|---|---|---|
| `vehicle_reports` | One officer's account of one vehicle | `registration_norm` (MH12AB1234), status, location, `owner_contact_enc` (encrypted), `record_digest` |
| `vehicle_events` | Timeline: reported, observation, status, match, media | **Append-only** and **hash-chained** (`previous_digest`); key steps anchored |
| `vehicle_matches` | Sought ↔ sighted pairs | Type, score, reasons; a decision requires a ≥10-character reason (DB constraint) |
| `ti_persons` | Third Eye person records | `classification`: person_of_interest / suspect / accused / convicted |
| `ti_case_links` | One row per FIR per person | Station, offence category, MO, involvement, investigation / arrest / court status |
| `ti_leads` | Investigative leads | Review requires a ≥15-character note (DB constraint); one row per pair |
| `ti_events` | Record history | Append-only, hash-chained |
| `secure_media` | Photographs and sketches for both modules | Append-only; stores the ciphertext location, SHA-256 and perceptual hash |
| `station_alerts` | Inter-station alerts | Addressed to a normalised station name; de-duplicated |

Every table has RLS enabled (default-deny, reads for `police` and `court_admin`), writes revoked
from `anon`/`authenticated`, and the audit trigger. `npm --prefix backend run db:validate` checks
all of that against a real Postgres engine. `database/upgrade_2_0.sql` includes 014.

## 3 · Vehicle Trace

### Reporting
Report type, vehicle and plate photographs, registration number (typed or read), type, make, model,
colour, chassis ending, condition, complaint/FIR reference, owner contact (missing/stolen only),
and location: GPS with accuracy, a point picked on the map when GPS fails or is refused, and a
free-text description.

### Number plate recognition (ANPR)
1. If `PLATE_RECOGNIZER_TOKEN` is set, `POST /api/vehicles/anpr` sends the image to
   Plate Recognizer (region `in`) and returns candidates.
2. Otherwise the API answers `501 ANPR_ON_DEVICE` and the app runs **Tesseract.js** in the
   browser (lazy-loaded; nobody else downloads it), on an upscaled, high-contrast copy.
3. Raw text is fitted to Indian formats (`MH12AB1234`, `DL3CAB1234`, `22BH1234AA`) with
   position-aware corrections (a `0` where a letter must be is `O`, an `8` is `B`), and only
   valid state codes are accepted.
4. The officer confirms or corrects. The report records `manual`, `anpr` or `anpr_corrected`.

### Matching (`scorePair`, `comparePlates` in `lib/similarity.ts`)
| Signal | Type | Score |
|---|---|---|
| Same registration | `exact_registration` | 1.0 (0.75 if the vehicle type differs — possible cloned plate) |
| Differs only in confusable characters (O/0, I/1, S/5, B/8, Z/2) | `partial_registration` | 0.9 × 0.7 + attributes × 0.3 |
| One character different | `partial_registration` | 0.8 × 0.7 + … |
| Same state + last four digits / same last four / contained | `partial_registration` | 0.6 / 0.45 / 0.55 × 0.7 + … |
| Same chassis ending, no usable plate | `characteristics` | 0.6 + attributes × 0.3 |
| No plate, ≥4 attributes all equal | `characteristics` | 0.5 |

Partial matches below 0.5 are discarded. Each match carries its reasons in words.

### Duplicates
Same registration with an open report on the same side → `409 DUPLICATE_REPORT` with the existing
report; the app offers to add an observation to it instead. Without a plate, same type and colour
within 150 m in 72 h → the same 409, which the officer may override after looking.

### Workflow
```
MISSING_REPORTED ─┐                         ┌─► VERIFICATION_PENDING ─┐
                  ├─► POTENTIAL_MATCH ──────┤                          ├─► MATCH_VERIFIED ─► RECOVERY_IN_PROGRESS
VEHICLE_FOUND ────┘   (matcher only)        └──────────────────────────┘   (verification only)
                                                                                   │
CASE_CLOSED ◄─ VEHICLE_RETURNED ◄─ OWNER_VERIFICATION_PENDING ◄────────────────────┘
```
* `POTENTIAL_MATCH` is set only by the matcher; `MATCH_VERIFIED` only by verifying a match.
* Only officers of the two stations involved can decide a match or move a matched report.
* Once verified, the two reports move together. Rejecting the last match sends a report back.
* `VEHICLE_RETURNED` needs a note of who received it and how ownership was verified;
  `CASE_CLOSED` needs a reason. Illegal transitions answer `409 ILLEGAL_TRANSITION` and are audited.
* Anchored: the report, every photo, `MATCH_VERIFIED`, `RECOVERY_IN_PROGRESS`, `VEHICLE_RETURNED`, `CASE_CLOSED`.

### Alerts
On a match, the station holding the *other* report is alerted with: registration, found photo(s),
location, Google Maps link, time, reporting officer and station, original complaint reference,
match type and score, and verification status. When the station that found it returns the vehicle,
the complaint station is alerted again. If email notifications are configured, officers of the
receiving station get an email that names no vehicle, person or place.

### Owner contact
Encrypted at rest. Shown only to the station that filed it and, after a match is verified, to the
other station involved.

## 4 · Third Eye

### What it is and is not
| It does | It does not |
|---|---|
| Keep person records with standing, description, aliases and FIRs across stations | Recognise faces |
| Raise **possible-duplicate** leads from names/aliases (initials, transliteration: Ravi/Ravee, Shaikh/Sheikh), date of birth / age, gender, marks | Compare sketches with photographs |
| Raise **same-image** leads with a 64-bit perceptual hash computed on the device | Decide identity, guilt, arrest or any action |
| Raise **related-case** leads: same offence category + shared MO keywords | Merge records automatically |
| Search by name/alias, FIR, offence, station, MO, marks, standing, or by image fingerprint | Store the image used for an image search |

`GET /api/third-eye/meta` returns these capabilities (`faceRecognition: false`,
`sketchToPhoto: false`) and the disclaimer that every response carries.

### Safeguards
* **Purpose-bound search.** Every search states its purpose (≥10 characters, e.g. the FIR being
  investigated); the purpose and criteria are written to the audit log with the officer's id.
* **Human verification.** A lead is `pending` until an officer confirms or rejects it with a
  written note (≥15 characters; enforced in the API and the database). Confirmation is recorded
  on both records' history and changes nobody's standing.
* **Standing kept distinct.** Person of interest, suspect, accused and convicted are separate,
  colour-coded and explained ("Accused: charged; presumed innocent until convicted"). Changing it
  requires the legal basis in writing and is anchored.
* **Empty is not clear.** A search with no results says so explicitly.
* **Tamper evidence.** Each record and FIR link has a digest that is anchored; the record page
  recomputes it and reports *intact*, *changed outside NyaySetu*, or *never anchored*.
* **Oversight.** The registry (court_admin) sees the officer activity log and analytics, not the records.
* **Access.** Police only for records; defence, accused, judges and prosecutors are refused.

### Before adding facial recognition
Do not enable it until **all** of these exist: a method validated on Indian data with published
false-match rates by demographic group; a written legal basis and authorisation; a protocol in which
a match is reviewed by a trained examiner and never used alone; audit of every query; and a data
protection impact assessment under the DPDP Act, 2023. The extension point is
`imageLeadsFor()` / `searchByImage()` in `thirdEye.service.ts`, which already produce reviewable
leads rather than identifications.

## 5 · API reference

All routes need a session; writes need the CSRF header. `P` = police, `R` = registry (court_admin).

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/api/vehicles?scope&station&status&type&q&from&to` | P R | List / filter reports |
| POST | `/api/vehicles` | P | File a report; runs duplicate check and matching |
| GET | `/api/vehicles/:id` | P R | Report, timeline, matches, photos, verification, integrity |
| POST | `/api/vehicles/:id/observations` | P | Add an observation |
| POST | `/api/vehicles/:id/status` | P | Move along the workflow |
| POST | `/api/vehicles/:id/media` | P | Add a vehicle or plate photo (multipart `file`, `kind`) |
| POST | `/api/vehicles/:id/rematch` | P | Re-run matching |
| GET | `/api/vehicles/matches?status` | P R | Matches |
| POST | `/api/vehicles/matches/:id/decision` | P | Verify or reject (`note` ≥10) |
| GET | `/api/vehicles/plate-check?registration` | P R | Is this plate sought anywhere? |
| POST | `/api/vehicles/anpr` | P | Server ANPR (501 when not configured) |
| GET | `/api/vehicles/stats` | P R | Counts |
| GET | `/api/third-eye/meta` | P R | Capabilities, disclaimer, enums |
| GET | `/api/third-eye/activity` | P R | Officer activity log |
| POST | `/api/third-eye/search` | P | Search (`purpose` + ≥1 criterion) |
| POST | `/api/third-eye/search/image` | P | Search by perceptual hash (`purpose`) |
| POST | `/api/third-eye/persons` | P | Create a record |
| GET | `/api/third-eye/persons/:id?purpose` | P | Record, FIRs, media, leads, history, integrity |
| PATCH | `/api/third-eye/persons/:id` | P | Update (`reason` required) |
| POST | `/api/third-eye/persons/:id/cases` | P | Link an FIR |
| PATCH | `/api/third-eye/cases/:id` | P | Update an FIR link's status (`reason`) |
| POST | `/api/third-eye/persons/:id/media` | P | Add photo / CCTV still / sketch (`perceptualHash`) |
| GET | `/api/third-eye/leads?status` | P | Leads |
| POST | `/api/third-eye/leads/:id/review` | P | Confirm / reject (`note` ≥15) |
| GET | `/api/third-eye/repeat-offenders` · `/cross-case` · `/stats` | P | Cross-station views |
| GET | `/api/smart/alerts?status` · PATCH `/api/smart/alerts/:id` | P (R read) | Station alerts |
| GET | `/api/smart/media/:id` | P R | A decrypted, re-verified photograph (no-store) |
| GET | `/api/smart/overview` | P R | Analytics |

## 6 · Deploying

Nothing changes in `vercel.json`: the new routes are part of the same Express function.

1. Apply `database/migrations/014_smart_policing.sql` in the Supabase SQL editor (or the whole
   `database/upgrade_2_0.sql`, which is idempotent). `/api/health` lists `014_smart_policing`
   under missing migrations until it is applied.
2. **Pinata must be configured in production** (`PINATA_JWT`). Without it photos are written to
   local disk, which is read-only on Vercel.
3. Optional: `PLATE_RECOGNIZER_TOKEN` for server-side ANPR. Without it plates are read on the
   device; the browser downloads Tesseract's engine and English model from jsDelivr on first use.
4. Police accounts must have their station set (Admin → Participants); a report cannot be filed
   without one, and alerts are addressed by station.
5. Optional demo data on a real database: `npm --prefix backend run demo:smart -- --confirm`
   (synthetic, every reference marked DEMO; refuses to run twice).

Function request bodies are capped at 4.5 MB on Vercel; the app compresses photos to well under
3.5 MB, and the API refuses anything larger with a clear message.

## 7 · Testing

```bash
cd backend
npx tsx --test test/f20-vehicle-trace.test.ts test/f21-third-eye.test.ts
npm test                 # the whole suite (128 tests)
npm run db:validate      # migrations against a real Postgres engine
cd ../frontend && npm run build   # typecheck, bundle, contrast, routes, secrets
```

Covered: plate normalisation and Indian formats; exact, misread and partial matching; inter-station
alerts with the full payload; duplicate refusal and override; owner-contact visibility; the whole
recovery workflow, illegal transitions and station checks; rejection reverting status; hash-chained
timelines; integrity failure after an out-of-band edit; encrypted photo round-trip and type
sniffing; RBAC and CSRF; server-ANPR fallback; Third Eye record creation, anchoring and
reclassification with reason; duplicate-person leads (initials, transliteration); purpose-bound
search and its audit entries; related-case leads and the alert on confirmation; same-image leads,
sketches excluded, image search storing nothing; repeat offenders; role refusals.

## 8 · Demonstration (local stack)

`npm run local` seeds three police stations (Shivajinagar, Kothrud, Hinjewadi) and synthetic data:

1. Sign in as **police@nyaysetu.local** (Shivajinagar). The dashboard shows Vehicle Trace, Third Eye
   and **2 unread station alerts**.
2. **Station alerts** → the grey Activa *MH 12 QW 4821* reported stolen here was found abandoned by
   Kothrud PS: photo, map link, reporting officer. Open it.
3. **Verify match** → write what was checked. Both reports move to *Match verified*; the step is anchored.
4. Sign in as **police.kothrud@nyaysetu.local** → move it through recovery, owner verification and
   return (the return needs a handover note). Shivajinagar is alerted that it was returned.
5. **Matches** tab → the red Swift: Kothrud's ANPR read `MH12HJ771O`; it is still offered as a
   partial match for *MH 12 HJ 7710* (O/0).
6. **Vehicle Trace → Report** → photograph a plate, *Read plate*, correct it, set the location
   on the map, file. Try filing the same plate twice to see the duplicate panel.
7. **Third Eye → Search** → purpose "Investigating chain snatching near temples", MO
   "red cap black motorcycle chain temple". Two records at two stations come back with reasons.
8. **Leads to review** → *Demo Suspect Raju Kale* / *Raju Kaale* (possible duplicate) and the two
   chain-snatching FIRs (related cases). Confirm the related-case lead with a note → the other
   station is alerted. Nothing is merged and nobody's standing changes.
9. Open a record → *Record verification* shows the anchored digest; **Officer activity** shows
   every search with its purpose.

## 9 · Files added and changed

**Added** — `database/migrations/014_smart_policing.sql`; backend `lib/similarity.ts`,
`services/smart/{recordAnchor,media.service,stationAlerts.service}.ts`,
`services/vehicleTrace.service.ts`, `services/thirdEye.service.ts`,
`routes/{vehicles,thirdEye,smart}.ts`, `scripts/smartDemo.ts`,
`test/f20-vehicle-trace.test.ts`, `test/f21-third-eye.test.ts`; frontend `lib/{anpr,imageTools}.ts`,
`components/{smart,LocationMap,SmartPolicingPanel}.tsx`,
`pages/{vehicleTrace,thirdEye,smartPolicing}.tsx`; this document.

**Changed** — `backend/src/app.ts` (mount routes), `config/env.ts` (`PLATE_RECOGNIZER_*`),
`lib/supabase.ts` (migration probe), `lib/memoryDb.ts` (unique keys), `scripts/devSeed.ts`
(two more stations, demo data), `package.json` (`demo:smart`); frontend `App.tsx` (routes),
`components/PortalShell.tsx` (navigation), `pages/police.tsx` (dashboard panel),
`i18n/{en,hi,mr}.ts`, `package.json` (leaflet, tesseract.js); `scripts/bundle-upgrade.mjs`,
`database/upgrade_2_0.sql`, `.env.hosting.example`, `backend/.env.example`, `README.md`,
`docs/README.md`, `docs/hosting.md`.

## 10 · Known limitations

* No connection to VAHAN, CCTNS or any government registry: matching covers reports filed in
  NyaySetu. Those integrations need authorisation and approved APIs.
* Matching scans open reports in the API process; fine for thousands of reports, not millions.
  At that scale move candidate selection into SQL (trigram index on `registration_norm`).
* On-device OCR is weaker than a dedicated ANPR service on angled, dirty or night images; the
  officer's confirmation is the safeguard.
* Two writes to the same timeline at the same instant could fork its hash chain; the timeline is
  ordered by chain links and anything off-chain is shown last.
* Station names are free text, normalised (`"Shivajinagar PS"` = `"shivajinagar  ps"`). A station
  master table would make alert addressing stricter.
* Hindi and Marathi copy for the new screens is machine-assisted and unreviewed, like the rest
  (see `JAN_SAHAYAK.md`); detailed form labels in the new screens are English.
* Nothing here has been reviewed against police standing orders or by a legal practitioner; the
  workflow follows the general shape of BNSS property and recovery procedure and must be checked
  before real use.
