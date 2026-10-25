<div align="center">

<img src="brand/nyaysetu-logo.png" width="130" alt="NyaySetu" />

# NyaySetu &nbsp;·&nbsp; न्यायसेतु

### The Bridge of Justice

**Evidence digests, summons acknowledgements and bail conditions anchored to a public blockchain — so integrity is something anyone can check, not something a party asserts.**

<br>

[![Live](https://img.shields.io/badge/demo-live-00C853?style=for-the-badge&logo=vercel&logoColor=white)](https://nyaysetu-project.vercel.app)
[![Contracts](https://img.shields.io/badge/contracts-on%20Sepolia-627EEA?style=for-the-badge&logo=ethereum&logoColor=white)](https://sepolia.etherscan.io/address/0x383d996De8cd2a19aCC8d66CdEa2F4A3b1E7F6D4)
[![Tests](https://img.shields.io/badge/tests-53%20contract%20%C2%B7%20111%20API%20%C2%B7%2045%20UI%20pages-brightgreen?style=for-the-badge)](#-what-is-verified-and-how)
[![Licence](https://img.shields.io/badge/licence-MIT-blue?style=for-the-badge)](#-licence)

<br>

<img src="https://img.shields.io/badge/Solidity-0.8.24-363636?style=flat-square&logo=solidity&logoColor=white" />
<img src="https://img.shields.io/badge/Hardhat-2.x-FFF100?style=flat-square&logo=hardhat&logoColor=black" />
<img src="https://img.shields.io/badge/OpenZeppelin-5-4E5EE4?style=flat-square&logo=openzeppelin&logoColor=white" />
<img src="https://img.shields.io/badge/Ethers.js-6-2535A0?style=flat-square&logo=ethers&logoColor=white" />
<img src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white" />
<img src="https://img.shields.io/badge/Node.js-20%2B-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white" />
<img src="https://img.shields.io/badge/Express-4-000000?style=flat-square&logo=express&logoColor=white" />
<br>
<img src="https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black" />
<img src="https://img.shields.io/badge/Vite-8-646CFF?style=flat-square&logo=vite&logoColor=white" />
<img src="https://img.shields.io/badge/Tailwind-3.4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white" />
<img src="https://img.shields.io/badge/PostgreSQL-RLS%20on%20every%20table-4169E1?style=flat-square&logo=postgresql&logoColor=white" />
<img src="https://img.shields.io/badge/Supabase-3FCF8E?style=flat-square&logo=supabase&logoColor=white" />
<img src="https://img.shields.io/badge/Python-3.13-3776AB?style=flat-square&logo=python&logoColor=white" />
<img src="https://img.shields.io/badge/scikit--learn-1.5-F7931E?style=flat-square&logo=scikitlearn&logoColor=white" />
<img src="https://img.shields.io/badge/Flask-3-000000?style=flat-square&logo=flask&logoColor=white" />
<br>
<img src="https://img.shields.io/badge/IPFS-Pinata-65C2CB?style=flat-square&logo=ipfs&logoColor=white" />
<img src="https://img.shields.io/badge/AES--256--GCM-encrypted%20at%20rest-7B1FA2?style=flat-square&logo=letsencrypt&logoColor=white" />
<img src="https://img.shields.io/badge/SHA--256-computed%20on%20device-455A64?style=flat-square" />
<img src="https://img.shields.io/badge/React%20Native-Expo-000020?style=flat-square&logo=expo&logoColor=white" />
<img src="https://img.shields.io/badge/PDFKit-court%20documents-D32F2F?style=flat-square&logo=adobeacrobatreader&logoColor=white" />
<img src="https://img.shields.io/badge/BNS%202023-358%20sections-FF6F00?style=flat-square" />

<br>

Evidence, summons and bail records you can verify

**Developed by [Sai Randive](https://github.com/SAI-RANDIVE)**

</div>

---

## Contents

| | | |
|---|---|---|
| [🔗 See it running](#-see-it-running) | [📐 How it fits together](#-how-it-fits-together) | [🧰 Tech stack](#-tech-stack-by-layer) |
| [⚖️ The problem](#️-what-problem-this-actually-solves) | [🏛️ The three modules](#️-the-three-modules) | [📁 Repository layout](#-repository-layout) |
| [🔑 The five `.env` files](#-the-env-files-and-why-there-are-five) | [🚀 Running it locally](#-running-it-locally) | [🎬 Walkthrough](#-the-nine-step-walkthrough) |
| [📖 The handbook](#-the-handbook) | [🔐 The two OTP channels](#-two-one-time-codes-and-only-one-of-them-is-simulated) | [✅ What is verified](#-what-is-verified-and-how) |
| [⚠️ Honest limitations](#️-honest-limitations) | [📚 The reasoning](#-where-the-reasoning-is-written-down) | [📄 Licence](#-licence) |

---

## 🔗 See it running

| | Where | What to look at |
|---|---|---|
| **Web application** | [nyaysetu-project.vercel.app](https://nyaysetu-project.vercel.app) | The landing page and the public handbook need no account |
| **API health** | [`/api/health`](https://nyaysetu-project.vercel.app/api/health) | Every subsystem reports itself separately, including what is still a fallback |
| **EvidenceChain** | [`0x383d996D…F6D4`](https://sepolia.etherscan.io/address/0x383d996De8cd2a19aCC8d66CdEa2F4A3b1E7F6D4) | Live on Sepolia. Every digest below is verifiable here |
| **SummonsChain** | [`0x18f8D239…8232`](https://sepolia.etherscan.io/address/0x18f8D239653A5542d0cBfA8d13c30E46F3c18232) | Acknowledgements, with time and coordinates |
| **BailChain** | [`0x90e8B17C…F946`](https://sepolia.etherscan.io/address/0x90e8B17CB82848ad0fE64Eb217c495cb91E8F946) | Conditions, check-ins, and violations the contract found itself |

> There is **no sign-up**. A court is a closed institution, so an account exists because a court administrator created it and emailed its holder a one-time password. `/handbook` is public and explains the whole system without one.

---

## 📐 How it fits together

```
                          ┌──────────────────────────────┐
   officer's device       │   BROWSER / PHONE            │   SHA-256 is computed HERE,
   ───────────────────────│   React · Vite · Tailwind    │   before a byte is uploaded.
                          │   React Native (Expo)        │   That is what makes the
                          └──────────────┬───────────────┘   digest mean anything.
                                         │  HTTPS, session cookie + CSRF
                                         ▼
   ┌─────────────────────────────────────────────────────────────────────────┐
   │  API   Node · Express · TypeScript (strict)                             │
   │                                                                         │
   │  RBAC + per-case access      opaque server-side sessions, revocable     │
   │  Aadhaar → HMAC token        the number itself is never stored          │
   │  AES-256-GCM                 encrypts a file before it leaves           │
   │  nonce ledger                serialises every chain write               │
   │  sweep jobs                  notice what did NOT happen                 │
   └───┬──────────────┬───────────────────┬──────────────────┬───────────────┘
       │              │                   │                  │
       ▼              ▼                   ▼                  ▼
 ┌───────────┐  ┌───────────┐     ┌──────────────┐   ┌──────────────┐
 │ Postgres  │  │  IPFS     │     │ Flask +      │   │  Ethereum    │
 │ Supabase  │  │  Pinata   │     │ scikit-learn │   │  Sepolia     │
 │           │  │           │     │              │   │              │
 │ RLS on    │  │ ciphertext│     │ anomaly ·    │   │ Evidence ·   │
 │ every     │  │ only      │     │ bail risk ·  │   │ Summons ·    │
 │ table     │  │           │     │ delay        │   │ Bail         │
 └───────────┘  └───────────┘     └──────────────┘   └──────────────┘
   readable        durable            advisory          AUTHORITATIVE
   record          storage            only              and immutable
```

**The chain holds only what must be impossible to revise** — a digest, an acknowledgement, a condition. Everything readable lives in Postgres, and the two are reconciled by an indexer. If they ever disagree, the chain is right.

---

## 🧰 Tech stack, by layer

### Blockchain

| | Why this one |
|---|---|
| **Solidity 0.8.24** | Built-in overflow checks, so the geo-fence arithmetic needs no SafeMath |
| **Hardhat 2** | 53 tests run against a real EVM, not a mock |
| **OpenZeppelin 5** | `AccessControl` for the eight roles, `ReentrancyGuard` on every state-changing entry |
| **Ethers v6** | One bridge module owns every call; nothing else touches a provider |
| **Integer-only geodesy** | Micro-degrees and a cosine lookup table. No floats on chain — a float cannot be relied on to give the same answer twice |

### Backend

| | Why this one |
|---|---|
| **Node 22 · Express 5 · TypeScript** | `strict` everywhere, and the build fails on an error rather than warning |
| **Zod** | Every route body is parsed, not cast |
| **Server-side sessions** | Not JWTs. A suspended officer's session dies the instant it is revoked; a signed token cannot be withdrawn |
| **bcrypt, 12 rounds** | Passwords. Invited ones are single-use |
| **express-rate-limit** | Per-route budgets, keyed on the session rather than the IP where one exists |
| **Nodemailer + HTTPS providers** | SMTP locally; Brevo or Resend over port 443 where a host blocks SMTP |
| **PDFKit** | Court documents in Times, no headless browser on the critical path |

### Data

| | Why this one |
|---|---|
| **PostgreSQL via Supabase** | Row level security on **every** table, default-deny |
| **`SECURITY DEFINER` functions** | The four routes to an Aadhaar token. The table holding them is unreachable over the API |
| **Audit in two layers** | Triggers record row changes; `action_log` records attempts, including refusals that left no row |
| **IPFS via Pinata** | Ciphertext only. The digest is computed before encryption, so the store is never trusted |

### Intelligence

| | Model | Honest about |
|---|---|---|
| **Evidence screening** | Isolation Forest + an explainable rule layer | Rules always flag; the forest only adds unexplained outliers |
| **Bail risk** | RandomForest, percentile-cut bands | Decision support, never a finding |
| **Case delay** | GradientBoosting with a residual-derived interval | Trained on declared distributions, written out in full |
| **Statute reference** | All **358 sections** of the Bharatiya Nyaya Sanhita, 2023 | Severity is a **lower bound**; the source omits some punishment sub-sections |

### Frontend

| | Why this one |
|---|---|
| **React 19 · Vite 8** | Seven role portals from one bundle, ~70 KB gzipped |
| **Tailwind 4** | Every colour a CSS variable, so light and dark are one token swap |
| **WebCrypto** | `SHA-256` in the browser, before upload. The whole trust model starts here |
| **React Native (Expo)** | Field capture and bail check-in. `expo-crypto` hashes on device |

---

## ⚖️ What problem this actually solves

Three places in a criminal matter where the record is only as good as somebody's word:

| Question asked in court | How it is answered today | What NyaySetu does |
|---|---|---|
| Was this evidence altered? | A custody register, which records that a transfer happened, not that the item is the same item. | The digest is computed on the collecting device and anchored on chain. Each receiving party re-hashes what they were handed and confirms it. A mismatch is anchored **and** the transfer refused. |
| Were you served? | A process server's endorsement against a flat denial. Cases adjourn for months on this. | Acknowledgement is an Aadhaar-OTP-authenticated transaction carrying time, coordinates and a device fingerprint. It cannot be produced without the recipient or back-dated. |
| Did they comply with bail? | A PDF nobody monitors until something has already gone wrong. | Conditions live on chain, check-ins are transactions, and the geo-fence arithmetic runs in the contract. A breach emits an event the court dashboard is subscribed to. |

---

## 🏛️ The three modules

**SaakshyaSetu** (`EvidenceChain.sol`) — evidence registration, chain of custody, tamper rejection, independent defence verification.

**SammansSetu** (`SummonsChain.sol`) — summons issuance, OTP-authenticated acknowledgement with GPS, a 72-hour window the contract enforces itself.

**JaminSetu** (`BailChain.sol`) — bail conditions as code, geo-fenced check-ins, automatic violation detection, live compliance scoring.

---

## 📁 Repository layout

Six deployable pieces and two folders that are not code. Each piece runs on its
own and says so when a neighbour is missing, which is why you can start the API
with no chain and no models and still get a working portal.

```
nyaysetu/
│
├── frontend/           ← THE WEBSITE. React + Vite + Tailwind.
│   │                     This is the folder you deploy to Vercel or Netlify.
│   ├── src/
│   │   ├── pages/        one file per portal: police, forensic, prosecutor,
│   │   │                 judge, defence, accused, admin, plus Landing, Login,
│   │   │                 FirstRun and the public Handbook
│   │   ├── components/   shared UI: ui.tsx is the whole design system,
│   │   │                 trust.tsx renders hashes and transaction links
│   │   ├── context/      auth, theme and toast providers
│   │   ├── lib/          api.ts is the only place the app touches the network
│   │   └── styles/       tokens.css holds every colour as a variable
│   ├── public/           favicons, manifest, the logo the browser tab shows
│   └── dist/             build output. Never committed.
│
├── backend/            ← THE API. Node + Express + TypeScript. Port 4000.
│   └── src/
│       ├── routes/       one file per area; auth.ts holds the two-step sign-in
│       ├── middleware/   auth (sessions + RBAC), csrf, rate limits, validation
│       ├── services/     the logic a route calls: evidence, summons, bail, audit
│       ├── lib/          chain.ts (ethers bridge + nonce ledger), crypto.ts
│       │                 (every primitive in one auditable file), mailer.ts,
│       │                 supabase.ts, pii.ts (the only route to Aadhaar tokens)
│       ├── otp/          the swappable identity seam: sandbox, email, UIDAI
│       ├── jobs/         the sweeps that notice a summons nobody answered
│       ├── indexer/      reads contract events back into Postgres
│       └── scripts/      bootstrap (the first admin), chainCheck, authCheck
│
├── contracts/          ← THE CHAIN. Solidity 0.8.24 + Hardhat. 53 tests.
│   ├── contracts/        EvidenceChain, SummonsChain, BailChain, NyayRoles,
│   │                     GeoMath (integer-only geodesy, no floats on chain)
│   ├── test/             the 53 tests, including tamper rejection
│   ├── scripts/          deploy, grantRoles, verify
│   └── deployed/         addresses + ABIs the backend reads at boot
│
├── database/           ← THE SCHEMA. Not a service; SQL you run once.
│   ├── migrations/       001 schema · 002 RLS · 003 audit · 004 OTP channels
│   │                     005 PII access · 006 invitations · 007 account removal
│   │                     Run in order, in the
│   │                     Supabase SQL editor — Supabase blocks DDL over the API.
│   └── seed/             reference.sql: role labels only, no accounts
│
├── ai-service/         ← THE MODELS. Python + scikit-learn + Flask. Port 5001.
│   ├── src/              three models: anomaly screening, bail risk, delay
│   └── models/           trained artefacts + metadata.json with the metrics
│
├── mobile/             ← THE FIELD APP. React Native (Expo). Optional.
│                         Scene capture and bail check-in. Hashes on-device.
│
├── docs/               ← EVERY GUIDE. Start with docs/README.md.
├── brand/              ← the source logo the favicons were generated from
└── render.yaml           deploy blueprint for the API
```

### Which folder is "the website"?

**`frontend/`.** Set that as the Root Directory in Vercel or Netlify; the build
command is `npm run build` and the output is `dist`. `frontend/vercel.json` and
`frontend/netlify.toml` are already in place with SPA rewrites and security
headers. The API is a **separate** deployment from `backend/` — see
[docs/hosting.md](docs/hosting.md).

---

## 🔑 The `.env` files, and why there are five

One per deployable piece, because each one runs as its own process and they do
not share a filesystem in production. Splitting them is not tidiness: it is what
keeps the Supabase key out of the browser bundle. Every file is git-ignored, and
each has a committed `.env.example` next to it.

| File | Belongs to | Holds | Secret? |
|---|---|---|---|
| **`backend/.env`** | the API | Supabase service key, Aadhaar pepper, evidence AES key, SMTP password, the keeper wallet's private key | **Yes — all of it.** The only file that holds real secrets |
| **`frontend/.env`** | the website | the API's URL | **No, and it must never be.** Vite inlines every `VITE_` variable into the bundle, so anything here is readable by anyone who opens the site |
| **`mobile/.env`** | the phone app | the API's URL as seen from the device | No, same reason — `EXPO_PUBLIC_` variables are compiled into the app |
| **`ai-service/.env`** | the model service | its port and the shared secret the API calls it with | Mildly. It holds no user data and no keys |
| **`contracts/.env`** | deploying to Sepolia | RPC URL, deployer key, Etherscan key | Yes, but only needed when deploying. Nothing at runtime reads it |

The rule the split enforces: **`SUPABASE_SERVICE_ROLE_KEY` appears in exactly one
file, and that file is never read by anything a user's browser can see.** It
bypasses row level security by design, so a copy of it in a frontend bundle would
hand every visitor the whole database.

`contracts/.env` is only read by Hardhat at deploy time; the backend learns the
contract addresses from `contracts/deployed/<network>.json` or from its own
`EVIDENCE_CHAIN_ADDRESS` / `SUMMONS_CHAIN_ADDRESS` / `BAIL_CHAIN_ADDRESS`.

### Setting them up

Each `.env.example` is a ready-to-fill template with step-by-step instructions
in its comments: where to sign up, which button to press, which value to copy.
Copy each one to `.env` in the same folder and paste values after the `=`:

```bash
cp backend/.env.example    backend/.env
cp contracts/.env.example  contracts/.env
cp frontend/.env.example   frontend/.env
cp ai-service/.env.example ai-service/.env
cp mobile/.env.example     mobile/.env
```

(PowerShell: `Copy-Item backend\.env.example backend\.env`, and so on.)

| What | Free from | Into | Needed? |
|---|---|---|---|
| 3 generated secrets | your computer (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) | `backend/.env` | **Required** |
| Supabase URL + service-role key | supabase.com | `backend/.env` | **Required** |
| Gmail App Password, or Brevo / Resend API key | myaccount.google.com/apppasswords · brevo.com · resend.com | `backend/.env` | Recommended (sign-in codes) |
| Ethereum test wallet (address + private key) | MetaMask | `contracts/.env`, `backend/.env` | For the public test network |
| Sepolia RPC URL | alchemy.com or infura.io | `contracts/.env`, `backend/.env` | For the public test network |
| Sepolia test ETH | any Sepolia faucet | your wallet | For the public test network |
| Etherscan API key | etherscan.io | `contracts/.env` | Optional |
| Pinata JWT | pinata.cloud | `backend/.env` | Optional |
| AI service key | your computer | `backend/.env`, `ai-service/.env` | Only if the AI service is public |

Every item above is free; Sepolia test ETH has no monetary value. The longer
walkthrough, with what each one changes and what to do if one leaks, is
[docs/api-keys.md](docs/api-keys.md).

### Running once the `.env` files are filled

```bash
# 1 · install everything (once)
npm run install:all
cd ai-service && python -m venv .venv && .venv\Scripts\activate && pip install -r requirements.txt && cd ..
#    (macOS/Linux: source .venv/bin/activate)

# 2 · database: run migrations 001–012 and seed/reference.sql in the Supabase SQL editor
cd backend && npm run check && cd ..        # confirms Supabase, email and chain

# 3 · blockchain — EITHER local …
npm run chain                               # terminal 1, keep it open
npm run deploy:local                        # once per fresh chain
#   … OR the public test network (contracts/.env filled):
npm run deploy:sepolia                      # once; then CHAIN_NETWORK=sepolia in backend/.env

# 4 · first administrator (once)
npm run bootstrap                           # prints the admin's password

# 5 · start the services, each in its own terminal
npm run ai:train                            # once
npm run ai:serve                            # AI service  → http://localhost:5001
npm run api                                 # API         → http://localhost:4000
npm run web                                 # web app     → http://localhost:5173
npm run app                                 # phone app (optional) → scan the QR with Expo Go
```

Open `http://localhost:4000/api/health`: `database.schema.upToDate`,
`blockchain.ready` and `email.reachable` should all be `true`. Sign in at
`http://localhost:5173` with the administrator account and invite the other
roles from **Participants**.

---

## 🚀 Running it locally

### The quick way: everything on your machine, no accounts

```bash
npm run install:all
DEV_SEED_PASSWORD="choose-a-password" npm run local
```

This starts a local Hardhat chain, deploys the contracts to it, runs the API
against an in-memory database seeded with one account per role
(`police@nyaysetu.local`, `forensic.lab@nyaysetu.local`, `prosecutor@…`,
`judge@…`, `defence.lawyer@…`, `accused@…`, `court.admin@…`), and serves the web
app at `http://localhost:5173`. Nothing is written to Supabase or any testnet,
and everything is lost when it stops. `docs/DEMO.md` walks through it.

The steps below set up the full deployment with Supabase and Sepolia.

### 0 · What you need

- Node 20 or newer, and Python 3.10 or newer
- A Supabase project (free tier is enough)
- Optionally: a Pinata account, and a Sepolia RPC URL plus a funded testnet wallet

Everything except Supabase is optional. Each missing piece reports itself as unavailable on `/api/health` rather than failing quietly.

### 1 · Install

```bash
cd nyaysetu
npm run install:all
cd ai-service && python -m venv .venv && .venv\Scripts\activate   # source .venv/bin/activate on macOS/Linux
pip install -r requirements.txt && cd ..
```

### 2 · Database

Run these files, in order, in the Supabase SQL editor:

```
database/migrations/001_schema.sql             tables, enums, indexes
database/migrations/002_rls.sql                row level security, default deny
database/migrations/003_audit.sql              audit triggers
database/migrations/004_otp_channels.sql       email OTP channel, email log
database/migrations/005_pii_access.sql         PII access functions
database/migrations/006_invitations.sql        invitations and first-run passwords
database/migrations/007_account_removal.sql    account removal
database/migrations/008_case_intake.sql        2.0: case references, FIR records
database/migrations/009_verification_state.sql 2.0: anchors and the verification state machine
database/migrations/010_passport_capture.sql   2.0: public references, capture manifests, device keys
database/migrations/011_chunked_uploads.sql    2.0: resumable uploads
database/migrations/012_workflows.sql          2.0: seizures, malkhana, lab, court, governance, alerts
database/seed/reference.sql                    role reference rows
```

Every 2.0 migration is idempotent and only adds; none drops or rewrites data.
`cd backend && npm run db:validate` applies all of them to a throwaway
in-process Postgres (PGlite) and checks RLS and audit triggers on every table,
without touching Supabase. Until 008–012 are applied, `/api/health` lists them
under `database.schema.missingMigrations` and the features they add answer
`SCHEMA_OUT_OF_DATE`.

No dashboard configuration is needed. Personally identifying data lives in a
`restricted` schema that is deliberately **not** exposed over the API; migration
`005` reaches it through four `SECURITY DEFINER` functions instead. Exposing the
schema would have made every table in it reachable forever, including ones added
later; four named functions do not grow.

Confirm everything is wired with:

```bash
cd backend && npm run check
```

It reports Supabase, SMTP and the chain separately, and names the fix for
whatever is wrong rather than leaving you to infer it.

### 3 · Contracts

> **Already deployed to Sepolia.** The addresses are in the table at the top and in
> `contracts/deployed/sepolia.json`. You only need the steps below to run a local
> chain, or to deploy a fresh set of your own — and note that redeploying orphans
> every anchor already written, because the artefact carries the deployment block
> the indexer starts from.

```bash
npm run contracts:test          # 53 tests, all should pass

# Terminal A — a local chain
npm run chain

# Terminal B
cp contracts/.env.example contracts/.env
npm run deploy:local
```

For Sepolia instead: put `SEPOLIA_RPC_URL` and `DEPLOYER_PRIVATE_KEY` in `contracts/.env`, then `npm run deploy:sepolia`.

The deploy script writes `contracts/deployed/<network>.json` with both addresses and ABIs, and the backend reads it at boot. No copying required.

### 4 · Models

```bash
npm run ai:train      # writes ai-service/models/, prints the metrics
npm run ai:serve      # http://localhost:5001
```

### 5 · Backend

```bash
cp backend/.env.example backend/.env
```

Fill in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, then generate the two secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # EVIDENCE_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"  # AADHAAR_TOKEN_PEPPER
```

For a local chain, `CHAIN_PRIVATE_KEY` can be Hardhat's first account — it is printed when you run `npm run chain`.

```bash
npm run chain:check   # 24 checks against the live contracts, no database needed
npm run bootstrap     # the first court administrator; prints its password once
npm run api           # http://localhost:4000
```

`npm run bootstrap` reads `BOOTSTRAP_ADMIN_EMAIL` from `backend/.env`, or takes
it directly:

```bash
cd backend && npm run bootstrap -- --email you@example.com --name "Your Name"
```

Use a mailbox you can read. Every sign-in emails a six digit code to that
address, so an address that bounces is an account you cannot get into.

### 6 · Frontend

```bash
npm run web           # http://localhost:5173
```

Sign in at `/login` with the address and password `npm run bootstrap` printed.

Sign-in is two steps when SMTP is configured: the password, then a six digit code
emailed to the account's own address. Without SMTP it stays password-only and the
second step never appears.

### Accounts

**There are none until you make them, and there is no sign-up.** A court is a
closed institution: somebody with authority decides who is a judge. So the only
route into the system is a court administrator creating an account from `/admin`,
which emails its holder a one-time password.

| Step | Where |
|---|---|
| The first administrator | `npm run bootstrap`, once, from a terminal |
| Everybody else | `/admin/users` → **Invite a participant** |
| Which cases they can open | `/admin/access` |

An invited account can do exactly one thing until it replaces the password it was
emailed: replace it. Every other route answers `403 PASSWORD_CHANGE_REQUIRED`,
because a password that has been sent by email is a password sitting in an inbox.

Holding a role is not the same as being on a case. A judge is a judge; *this*
judge is on *this* case. Grant that separately at `/admin/access`, or the portal
will be correctly empty.

### 7 · Mobile, optional

```bash
npm run install:mobile
cd mobile && npx expo install --fix     # reconciles versions to your Expo SDK
cp .env.example .env
npm start
```

An Android emulator reaches your laptop at `10.0.2.2`, not `localhost`. A physical phone needs your LAN address added to `CORS_ORIGINS` in `backend/.env`.

---

## 🎬 The nine-step walkthrough

Drive it yourself from the portals; there is no scripted cast to stand in for
real accounts. Invite one account per role from `/admin`, assign them all to one
case at `/admin/access`, then:

1. Police register evidence at a scene
2. The forensic laboratory confirms the hash on arrival
3. **A tampered file is refused, and the refusal is anchored on chain**
4. Prosecutor and court take custody of the genuine file
5. A judge issues a summons with a 72-hour window
6. The accused acknowledges it with Aadhaar OTP and GPS
7. The judge grants bail with conditions encoded on chain
8. A compliant check-in, then one from outside the geo-fence
9. **Defence counsel verifies independently, against the chain**

Steps 3 and 9 are the ones worth watching. Step 3 shows that a rejected tamper attempt leaves a permanent record rather than a server log. Step 9 shows the defence getting the same answer from a source neither party controls.

---

## 📖 The handbook

There is a full walkthrough built into the app at **`/handbook`**, public and readable without an account. It covers:

- the one technical idea, a digest, in two paragraphs and with a worked example
- what each of the three bridges replaces, and why
- **a step-by-step walkthrough for each of the seven roles**, with what that role deliberately cannot do
- what every badge and status chip in the interface means
- why there are two different one-time codes, and which one is simulated
- eight common questions, a plain-English glossary, and a triage list for when something goes wrong

It is linked from the landing page, the sign-in screen and every portal header. When you are signed in it jumps straight to your own role.

---

## 🔐 Two one-time codes, and only one of them is simulated

This distinction matters more than anything else in the honesty of the project.

| | Signing in | Acting on a case |
|---|---|---|
| **Channel** | Email, over your own SMTP server | Aadhaar-registered mobile |
| **Proves** | You control this account | This specific person performed this legal act |
| **Used for** | The second factor after a password | Acknowledging a summons, filing a bail check-in |
| **Real?** | **Yes.** A working mail server delivers it. | **No.** Simulated, because UIDAI access is government-gated. |

`/api/health` reports both separately, and the interface says "simulated" wherever an Aadhaar code appears. Collapsing them into one provider would let the simulated channel stand in for the real one, which is exactly the kind of quiet substitution this project is built to prevent.

---

## ✅ What is verified, and how

| Layer | Check | How to run it |
|---|---|---|
| Contracts | 53 unit tests: tamper rejection, unauthorised transfer, expired summons, missed check-in, geo-fence breach | `npm run contracts:test` |
| Backend ↔ contracts | 24 integration checks — **run against live Sepolia**, not a mock: a refused tamper, a re-acknowledgement rejected, a 5.5 km geo-fence breach the contract found unprompted | `npm run chain:check` |
| Sign-in and invitations | 21 assertions over real HTTP: two-step sign-in, single-use invitation, the gate that refuses every other route, credential rotation, the last-admin guard | `cd backend && npm run auth:check -- <admin-email> <password> <you+check@your-mail>` |
| Every feature, end to end | 51 assertions: it invites one account per role, registers an FIR, captures evidence, refuses a tampered file, moves custody, verifies from the defence side, issues and acknowledges a summons, grants bail, and breaches a geo-fence — then cleans up | `cd backend && npm run flow:check -- <admin-email> <password>` |
| Types | Strict TypeScript across backend and frontend | `npm run typecheck` |
| Models | Metrics printed at train time, written to `models/metadata.json` | `npm run ai:train` |
| Dependencies (shipped) | 0 vulnerabilities across all three Node packages | `npm run audit` |
| Dependencies (Python) | 0 vulnerabilities | `npm run audit:python` |
| API (2.0) | 111 tests over real HTTP against an in-memory database and a simulated chain: verification states, passport, capture, certificate, seizures, laboratory, court, governance | `cd backend && npm test` |
| Authorization matrix | Walks all 145 routes: no data to anonymous callers, no case data to unassigned users of any role, CSRF on every write | part of `npm test` (`f08-authorization.test.ts`) |
| Shared integrity package | 25 tests including golden digests shared by web, mobile and API | `npm run test:integrity` |
| Database migrations | All migrations applied to PGlite; RLS and audit triggers checked on every 2.0 table | `cd backend && npm run db:validate` |
| Every page, every role | Signs in as each of 7 roles, opens all 45 pages, fails on script errors, error panels or serious axe accessibility violations; also `--mobile` and `--lang=hi` | `cd frontend && npm run ui:smoke` (with `npm run local` running) |
| Frontend build | Contrast (WCAG AA, both themes), no dead navigation links, no secrets in the bundle | `cd frontend && npm run build` |
| Field app | Offline queue: idempotency, backoff, nothing dropped | `cd mobile && npm test` |
| Evaluation metrics | Tamper detection, check latency, unauthorized access, sync under injected faults | `cd backend && npm run metrics` → `docs/metrics/METRICS.md` |
| Whole stack boots | Chain, models, API and web all start; health reports each subsystem | see below |

---

## ⚠️ Honest limitations

These are the questions any careful reviewer should ask; the answers are here rather than left to be discovered.

**Aadhaar OTP is simulated; email OTP is not.** Sign-in uses a real code delivered by a real mail server. Citizen actions on a case use a simulated Aadhaar channel, because the live UIDAI API requires AUA/KUA registration, an ASA route, a licence key and a digital signature certificate. UIDAI grants that to government departments and the entities they authorise; this deployment holds no such licence, and there is no public sandbox that issues real OTPs. `backend/src/otp/UidaiOtpProvider.ts` writes out the real protocol and refuses to run without credentials, rather than pretending. The sandbox provider matches the real lifecycle exactly: a six digit code, a short TTL, a capped attempt count, single use, bound to one action. `/api/health` reports `authorisedForProduction: false` so a demo deployment can never be mistaken for an authenticated one.

**The models are trained on synthetic data.** Evidence metadata from live investigations is protected. Bail outcomes linked to individuals are personal data under the DPDP Act 2023. NJDG publishes aggregate pendency, not the per-case features a delay regressor needs. Every distribution is written out in `ai-service/src/datasets.py` so a reviewer can judge what the models learned. The outputs are decision support, never findings of fact.

**Citizen actions are relayed.** An accused does not hold a funded Sepolia wallet, so the backend's keeper wallet submits their transactions after OTP verification. The Aadhaar token in the transaction is what binds it to them. A production deployment would want account abstraction or a custodial wallet per citizen.

**Sepolia is not a court system.** A production deployment would need a permissioned chain or a Layer 2 with predictable costs, an availability guarantee, and a legal framework recognising an on-chain record. This demonstrates the mechanism.

**The Hardhat 2 toolchain carries open advisories.** `npm run audit` checks what ships and reports zero across contracts, backend and frontend. `npm run audit:all` includes dev dependencies and reports 25 findings in `contracts/`, every one of them inside Hardhat 2's own tree (adm-zip, undici, elliptic, tmp and friends). None of it is deployed: what reaches Sepolia is solc output, and the package is devDependencies only. The fix is Hardhat 3, which is a rewrite with a different config format and different plugin names, and would break a green 53-test suite. That trade is stated rather than hidden.

**Bail check-in and summons acknowledgement coordinates are on chain.** Evidence coordinates stay off chain (only a manifest fingerprint is anchored), but `BailChain` performs the geofence check itself and `SummonsChain` stores where a summons was acknowledged, so those coordinates are in their transactions. Moving that check off chain needs a contract change, deliberately not made in 2.0.

**The Hindi and Marathi text has not been reviewed by native speakers.** See `docs/JAN_SAHAYAK.md`.

**The Section 63 certificate is a template.** It is filled from the record and says on its face that it must be checked by a legal practitioner.

**The field app does not sign captures with a device key yet.** The web client registers a non-extractable device key and signs manifests; the mobile app sends manifests unsigned, and its Expo build tooling carries advisories that need an SDK upgrade (see `docs/SECURITY.md`).

**RLS does not constrain the API.** Supabase's service role bypasses row level security by design, so the policies in `002_rls.sql` do not police API traffic — the RBAC middleware does. RLS is the second wall, and it is what stands between a leaked anon key and the contents of these tables. Every table has it on; see `docs/design-decisions.md`.

---

## 📚 Where the reasoning is written down

- **[`docs/`](docs/)** — all the guides, with an index that says which one you want
- **`docs/hosting.md`** — deploy the API to Render and the web app to Vercel or Netlify, with one all-in-one env file
- **`docs/TESTING.md`** — every automated check, and a step-by-step walkthrough for each role
- **`docs/samples/`** — one of every generated court document (seizure memo, custody record, Section 63 certificate, passports, final report)
- **`docs/STORY.md`** — why this exists and what 2.0 changes, in plain words
- **`docs/DEMO.md`** — a twelve-minute demonstration that ends with the Section 63 certificate
- **`docs/DECISIONS.md`** — the 2.0 decisions (D-01 to D-11) and why
- **`docs/VERIFICATION_STATES.md`** — the six verification states and every legal transition
- **`docs/SECURITY.md`** — access control, rate limits, audits and failure modes
- **`docs/metrics/METRICS.md`** — measured results, and what they do not show
- **`docs/USER_TESTING.md`** — tasks, SUS questionnaire and practitioner form
- **`docs/JAN_SAHAYAK.md`** — plain-language help, accessibility, translation review
- **`docs/INTEGRATION.md`** — how CCTNS, ICJS and e-Courts would connect (design only)
- **`docs/api-keys.md`** — every credential, where to get it, what breaks without it
- **`docs/hosting.md`** — Vercel and Render, and the four things that break if you skip it
- **`docs/production.md`** — the six fallbacks a default deployment still uses, and the checklist before real data
- **`docs/design-decisions.md`** — the on-chain/off-chain split, why not just Postgres, and the decisions worth defending
- **`docs/deployment.md`** — exact environment variables per service, and the order to deploy them in
- **`ai-service/src/datasets.py`** — every synthetic distribution, in full
- **`backend/src/otp/UidaiOtpProvider.ts`** — the government-authorisation seam
- **`database/migrations/002_rls.sql`** — the security model, with its own reasoning in the header

---

## 👤 Developer

**Sai Randive** — design and development of NyaySetu: smart contracts, API, web portal, field app and documentation.

GitHub: [@SAI-RANDIVE](https://github.com/SAI-RANDIVE)

---

## 📄 Licence

MIT. See the limitations above before deploying any of this near a real proceeding.
