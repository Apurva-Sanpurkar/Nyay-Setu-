# Testing NyaySetu

Three levels, from fastest to most complete. None of the automated checks
touch your live database, email or the public blockchain unless stated.

## 1 · Automated checks (about 10 minutes, no accounts needed)

Run from the repository root after `npm run install:all` (and `cd mobile && npm install` for the app).

| What | Command | Expected |
|---|---|---|
| Smart contracts | `npm run contracts:test` | 53 passing |
| API (all workflows, security matrix) | `cd backend && npm test` | 111 pass, 0 fail |
| API types | `cd backend && npm run typecheck` | no output |
| Database migrations (throwaway Postgres) | `cd backend && npm run db:validate` | 12 migrations applied cleanly |
| Upgrade file in sync | `npm run db:bundle:check` | matches migrations 008–012 |
| Shared integrity package | `npm run test:integrity` | 25 pass |
| Web build + contrast + links + secret scan | `cd frontend && npm run build` | all four checks print OK |
| Field app | `cd mobile && npx tsc --noEmit && npm test` | 9 pass |
| Measured results | `cd backend && npm run metrics` | writes `docs/metrics/METRICS.md` |
| Sample documents | `cd backend && npm run samples:pdf` | six PDFs in `docs/samples/` |

## 2 · Every page as every role (local, about 15 minutes)

Start the self-contained local system (local chain, in-memory database, one
account per role, email off):

```bash
DEV_SEED_PASSWORD="LocalDemo-2026" npm run local
# already running the API or web app yourself? use other ports:
LOCAL_API_PORT=4100 LOCAL_WEB_PORT=5180 DEV_SEED_PASSWORD="LocalDemo-2026" npm run local
```

Then, in another terminal:

```bash
cd frontend
npm run ui:flow                                  # case → live capture → passport → wrong file refused
npm run ui:smoke                                 # every page, every role: errors, accessibility
npm run ui:smoke -- --mobile                     # the same at phone width (390 px)
npm run ui:smoke -- --lang=hi                    # Hindi;  --lang=mr for Marathi
# with custom ports add:  --base=http://localhost:5180
```

Screenshots and a summary are written to your temp folder
(`nyaysetu-ui-smoke`). Every page should pass.

## 3 · Manual walkthrough (the real experience)

Sign in at `http://localhost:5173` (or 5180) with `<role>@nyaysetu.local`
and the password you chose. Follow the order below; each step relies on the
one before it.

| # | As | Do | Check |
|---|---|---|---|
| 1 | Police | **Register a case** | A reference like `NS/…/2026/000001` is shown |
| 2 | Police | **Capture evidence** → take a photo (allow camera and location) | Fingerprint and GPS accuracy appear before upload; the item reaches *Confirmed on chain* |
| 3 | Police | **Seizures** → record a memo with two witnesses → **Memo PDF** | PDF opens with the police seal top right, IST times, officer's name filled |
| 4 | Police | **Malkhana register** → record *Deposited* | Movement listed with its ledger state |
| 5 | Anyone | Copy the item's `NSE-…` reference → open `/verify/<reference>` in a private window → drop the original file, then an edited copy | Original matches; edited copy does not |
| 6 | Forensic lab | **Laboratory queue** → open the item → accept custody with the original file → **Record intake** → **File the report** → **File a correction** | Re-check matched; two report versions listed |
| 7 | Police | Register another item; as the lab, accept it with a *different* file | Custody does not move; state *Integrity mismatch* |
| 8 | Judge | **Alerts** → open the mismatch → resolve with a reason; **Approvals** shows nothing until someone requests a release | Alert resolved; the requester cannot approve their own request |
| 9 | Prosecutor | Dashboard → **Readiness by case** | Confirmed / pending / mismatched counts per case |
| 10 | Defence | **Access requests** → request a case by reference; as the judge, grant it | Defence then sees the case read-only |
| 11 | Judge | **Hearings & orders** → schedule a hearing | Listed under upcoming hearings |
| 12 | Accused | Switch language to हिन्दी or मराठी → **What you need to do**, **Help** | Plain-language explanations and the legal-advice boundary |
| 13 | Court registry | Open an evidence item → **Documents → Section 63 certificate** → generate | PDF with Part A filled, Part B blank, template caution in the footer |
| 14 | Court registry | **Templates** → edit a section → save | Version number increases |
| 15 | Any | Phone (same Wi-Fi, `http://<laptop-ip>:5173`) → **Install** | App installs to the home screen (production build or hosted site) |

## 4 · Against your live services

With your real `.env` (Supabase, Sepolia, Gmail, Pinata):

```bash
cd backend && npm run check          # Supabase, email and chain, each reported separately
cd backend && npm run mail:probe     # which SMTP ports work and whether the password is accepted
npm run chain:check                  # ~20 Sepolia test transactions (spends test ETH)
npm run api                          # then open http://localhost:4000/api/health
npm run web                          # http://localhost:5173 — sign in as the super administrator
```

`/api/health` should report `database.schema.upToDate: true`,
`blockchain.ready: true`, `email.reachable: true` and `storage.backend: pinata`.

After hosting, repeat steps 2, 5 and 13 on the hosted site; see
`docs/hosting.md` → *Checks after every deployment*.
