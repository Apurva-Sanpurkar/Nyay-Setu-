# Keys, wallet and environment: step by step

Every credential NyaySetu uses, which free service it comes from, and exactly
which line of which `.env` file it goes into.

**Nothing here is needed to try the system.** `npm run local` runs everything
on your machine with no accounts at all (see `docs/DEMO.md`). The steps below
are for a shared deployment on Supabase and the Sepolia test network.

**Only Supabase is required.** Everything else degrades gracefully: the
affected feature reports itself unavailable on `/api/health` instead of
crashing, so you can add keys one at a time and watch each subsystem come up.

All the services below have a free tier that is enough. Sepolia test ETH has no
monetary value.

---

## Overview

| # | What | Free from | Goes into | Required? |
|---|---|---|---|---|
| 1 | Three generated secrets | your own computer | `backend/.env` | **Yes** |
| 2 | Supabase URL + service key | supabase.com | `backend/.env` | **Yes** |
| 3 | Email for sign-in codes | Gmail App Password, or Brevo / Resend | `backend/.env` | Recommended |
| 4 | Ethereum test wallet | MetaMask | `contracts/.env`, `backend/.env` | For a public chain |
| 5 | Sepolia RPC URL | Alchemy (or Infura) | `contracts/.env`, `backend/.env` | For a public chain |
| 6 | Sepolia test ETH | a faucet | your wallet | For a public chain |
| 7 | Etherscan API key | etherscan.io | `contracts/.env` | Optional |
| 8 | Pinata JWT | pinata.cloud | `backend/.env` | Optional |
| 9 | AI service key | your own computer | `backend/.env`, `ai-service/.env` | Only if the AI service is public |
| 10 | Frontend and mobile URLs | — | `frontend/.env`, `mobile/.env` | For hosting / phones |

Each folder has a `.env.example`. Copy it to `.env` in the same folder and fill
it in:

```bash
cp backend/.env.example backend/.env
cp contracts/.env.example contracts/.env
cp frontend/.env.example frontend/.env
cp ai-service/.env.example ai-service/.env
cp mobile/.env.example mobile/.env
```

(On Windows PowerShell use `Copy-Item` instead of `cp`.) Every `.env` is
git-ignored. **Never commit one, paste one into a chat, or put one in a
screenshot.**

---

## 1 · Generate the three secrets

These protect data at rest, so generate them once, keep a backup somewhere
safe (a password manager), and do not change them once real data exists:
changing `EVIDENCE_ENCRYPTION_KEY` makes stored files unreadable, and changing
`AADHAAR_TOKEN_PEPPER` breaks every existing token and officer pseudonym.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Run it three times and put one result on each line of **`backend/.env`**:

```dotenv
AADHAAR_TOKEN_PEPPER=<first value>
EVIDENCE_ENCRYPTION_KEY=<second value>
LOGIN_CHALLENGE_SECRET=<third value>
```

---

## 2 · Supabase (required)

1. Go to **supabase.com** → sign in → **New project**. Name it `nyaysetu`,
   pick the region nearest you (Mumbai if offered), set a database password and
   keep it safe.
2. When it is ready, open **SQL Editor** and run these files **in order**, one
   at a time (paste the file's contents, press **Run**, wait for success):

   ```
   database/migrations/001_schema.sql
   database/migrations/002_rls.sql
   database/migrations/003_audit.sql
   database/migrations/004_otp_channels.sql
   database/migrations/005_pii_access.sql
   database/migrations/006_invitations.sql
   database/migrations/007_account_removal.sql
   database/migrations/008_case_intake.sql
   database/migrations/009_verification_state.sql
   database/migrations/010_passport_capture.sql
   database/migrations/011_chunked_uploads.sql
   database/migrations/012_workflows.sql
   database/seed/reference.sql
   ```

   The 2.0 files (008–012) only add tables and columns and are safe to run
   twice. Before running them on a database with real data, take a backup
   (**Database → Backups**) and, if you like, check them first locally with
   `cd backend && npm run db:validate`.
3. Open **Project Settings → API** (or **API Keys**) and copy:

   ```dotenv
   SUPABASE_URL=https://<your-project-ref>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<the service_role secret, or an sb_secret_… key>
   ```

   into **`backend/.env`**. The service key bypasses row-level security: it
   belongs only in the backend, never in the frontend or the mobile app (the
   frontend build fails if it finds one).
4. Check: `cd backend && npm run check`. It reports Supabase, email and the
   chain separately and names the fix for anything wrong.

---

## 3 · Email for sign-in codes (recommended)

Used for the six-digit code after the password, invitations, and reminders.
Pick **one** of these.

### Option A — Gmail App Password

1. **myaccount.google.com/security** → turn on **2-Step Verification**.
2. **myaccount.google.com/apppasswords** → name it `NyaySetu` → **Create**.
3. Copy the 16 characters **without spaces** into **`backend/.env`**:

   ```dotenv
   EMAIL_TRANSPORT=smtp
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=yourname@gmail.com
   SMTP_PASSWORD=abcdefghijklmnop
   SMTP_FROM=NyaySetu <yourname@gmail.com>
   ```

   Your normal Google password will not work here.

### Option B — Brevo or Resend (better on hosts that block SMTP, such as Render's free tier)

- **Brevo:** brevo.com → **SMTP & API → API Keys → Generate**. Verify a sender
  address under **Senders**.
  ```dotenv
  EMAIL_TRANSPORT=brevo
  BREVO_API_KEY=xkeysib-…
  SMTP_FROM=NyaySetu <the-verified-sender@example.com>
  ```
- **Resend:** resend.com → **API Keys → Create**.
  ```dotenv
  EMAIL_TRANSPORT=resend
  RESEND_API_KEY=re_…
  SMTP_FROM=NyaySetu <onboarding@resend.dev>
  ```

### The first administrator

```dotenv
BOOTSTRAP_ADMIN_EMAIL=you@example.com
BOOTSTRAP_ADMIN_NAME=Your Name
PUBLIC_APP_URL=http://localhost:5173
```

Then `npm run bootstrap` (repository root) creates that court-registry account
and emails its one-time password. Every other account is invited from inside
the web portal.

No email at all? Set `LOGIN_OTP_ENABLED=false`: sign-in becomes password-only
and invitation passwords are shown to the administrator instead of emailed.

---

## 4 · Create an Ethereum test wallet (MetaMask)

This wallet deploys the contracts and then acts as the **keeper**: it pays the
gas for every record the API anchors.

1. Install **MetaMask** (metamask.io) as a browser extension.
2. Choose **Create a new wallet**. Set a password. Write the 12-word Secret
   Recovery Phrase on paper and keep it offline. Use a **new wallet used only
   for this project**, never one that holds real funds.
3. Show test networks: **Settings → Advanced → Show test networks → On**. Pick
   **Sepolia** from the network list.
4. Copy your **address** (starts with `0x`, 42 characters) from the top of the
   wallet.
5. Export the **private key**: account menu **⋮ → Account details → Show
   private key** → enter your password. It is `0x` followed by 64 hex
   characters (add the `0x` if MetaMask shows it without).

The private key controls the wallet. It goes only into the two `.env` files
below; anyone who sees it can spend the wallet's (test) ETH and sign as your
keeper.

---

## 5 · Get a Sepolia RPC URL (Alchemy)

1. **alchemy.com** → sign up → **Create new app** → chain **Ethereum**, network
   **Sepolia**.
2. Copy the **HTTPS** endpoint, e.g.
   `https://eth-sepolia.g.alchemy.com/v2/AbC123…`

Infura (infura.io) or QuickNode work the same way.

---

## 6 · Fund the wallet with test ETH

Paste your **address** (not the private key) into a faucet:

- Google Cloud Web3 faucet (Ethereum Sepolia)
- Alchemy's Sepolia faucet (signed in with the account from step 5)
- sepolia-faucet.pk910.de (proof-of-work in the browser, no sign-up)

Faucets change their rules often; if one refuses, try another. About
**0.05 Sepolia ETH** covers deploying the three contracts and a few hundred
anchored records. Check the balance on **sepolia.etherscan.io** by searching
your address.

---

## 7 · Etherscan API key (optional)

Lets you publish the contracts' source code so anyone can read what was
deployed.

1. **etherscan.io** → sign up → **API Keys → Add**.
2. Put it in **`contracts/.env`** as `ETHERSCAN_API_KEY=…`.

---

## 8 · Deploy the contracts to Sepolia

Fill in **`contracts/.env`**:

```dotenv
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/AbC123…
DEPLOYER_PRIVATE_KEY=0x<64 hex characters>
ETHERSCAN_API_KEY=<optional>
# Leave the *_ADDRESSES lines blank: the deployer then holds every role,
# which is what the API's keeper needs.
BAIL_GRACE_PERIOD_SECONDS=86400
```

`BAIL_GRACE_PERIOD_SECONDS=0` makes a missed check-in fire immediately (useful
for a demonstration); `86400` (24 hours) is the realistic value.

Then, from the repository root:

```bash
npm run contracts:test        # 53 tests, local only
npm run deploy:sepolia        # spends a little test ETH
cd contracts && npm run verify:sepolia   # optional, needs ETHERSCAN_API_KEY
```

The deploy writes `contracts/deployed/sepolia.json` with the three addresses
and ABIs. **Commit that file** (it holds no secrets) so the API and every
teammate use the same contracts.

---

## 9 · Point the API at Sepolia

In **`backend/.env`**:

```dotenv
CHAIN_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/AbC123…
CHAIN_PRIVATE_KEY=0x<the same private key as DEPLOYER_PRIVATE_KEY>
CHAIN_NETWORK=sepolia
CONFIRMATION_DEPTH=3
EVIDENCE_CHAIN_ADDRESS=
SUMMONS_CHAIN_ADDRESS=
BAIL_CHAIN_ADDRESS=
```

Leave the three `*_CHAIN_ADDRESS` lines **empty**: the API then reads the
addresses from `contracts/deployed/sepolia.json`. Fill them only if you need to
point at different contracts, and then all three must match one deployment —
a mismatch between these lines and `sepolia.json` is the most common reason
anchoring fails after a redeploy.

Check with `cd backend && npm run check`, then `npm run chain:check` (repository
root), which sends about twenty test transactions to Sepolia and confirms each
behaves as expected.

---

## 10 · Pinata for IPFS storage (optional)

Evidence files are encrypted with AES-256-GCM before storage either way.
Without Pinata they are written to `backend/storage/blobs/`, which is fine on
one machine but lost on hosts with temporary disks.

1. **pinata.cloud** → sign up → **API Keys → New Key** → enable
   **pinFileToIPFS** → create.
2. Copy the **JWT** (the long value) into **`backend/.env`**:

   ```dotenv
   PINATA_JWT=eyJhbGciOi…
   ```

---

## 11 · AI service key (only if the AI service is reachable from the internet)

Generate one more secret with the command from step 1 and put the **same
value** in both files:

```dotenv
# ai-service/.env
AI_SERVICE_KEY=<value>

# backend/.env
AI_SERVICE_URL=https://<where-the-ai-service-runs>
AI_SERVICE_KEY=<same value>
```

Locally, leave both blank and keep `AI_SERVICE_URL=http://localhost:5001`.

---

## 12 · Frontend and mobile

**`frontend/.env`** (local development needs no changes):

```dotenv
VITE_API_BASE=                          # blank in development: Vite proxies /api
VITE_API_PROXY=http://localhost:4000
```

When hosting the web app separately from the API, set
`VITE_API_BASE=https://<your-api-host>` and add the web app's address to
`CORS_ORIGINS` and `PUBLIC_APP_URL` in `backend/.env`. Only `VITE_`-prefixed
values reach the browser, and every one of them is public: never put a key in
this file.

**`mobile/.env`**: where the API is, as seen from the phone:

```dotenv
EXPO_PUBLIC_API_BASE_URL=http://10.0.2.2:4000        # Android emulator
# EXPO_PUBLIC_API_BASE_URL=http://192.168.1.20:4000  # a real phone: your laptop's LAN address
```

For a real phone, also add that address to `CORS_ORIGINS` in `backend/.env`.

---

## 13 · Start and check

```bash
npm run ai:serve    # terminal 1 (optional)
npm run api         # terminal 2
npm run web         # terminal 3 → http://localhost:5173
```

Open `http://localhost:4000/api/health`. Each subsystem reports itself:
`database.schema.upToDate` should be `true` (otherwise it lists the migrations
still to run), `blockchain.ready` should be `true` with `network.name` set to
`sepolia`, and `email.reachable` should be `true`.

---

## Complete `backend/.env` checklist

```dotenv
# required
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
AADHAAR_TOKEN_PEPPER=
EVIDENCE_ENCRYPTION_KEY=
LOGIN_CHALLENGE_SECRET=

# email (pick one transport)
EMAIL_TRANSPORT=
SMTP_USER=
SMTP_PASSWORD=
BREVO_API_KEY=
RESEND_API_KEY=
SMTP_FROM=
BOOTSTRAP_ADMIN_EMAIL=
PUBLIC_APP_URL=

# public chain
CHAIN_RPC_URL=
CHAIN_PRIVATE_KEY=
CHAIN_NETWORK=sepolia
CONFIRMATION_DEPTH=3

# optional
PINATA_JWT=
AI_SERVICE_URL=
AI_SERVICE_KEY=
CORS_ORIGINS=
CRON_SECRET=
```

Every other variable in `backend/.env.example` has a working default and is
documented there.

## If a key leaks

- **Wallet private key:** create a new wallet, move any test ETH, redeploy or
  grant the new address the keeper role, and update both `.env` files.
- **Supabase service key:** rotate it under Project Settings → API, then update
  `backend/.env`.
- **Email, Pinata, Etherscan, Alchemy:** revoke the key in that service and
  create a new one.
- **`EVIDENCE_ENCRYPTION_KEY` or `AADHAAR_TOKEN_PEPPER`:** these cannot simply
  be rotated without re-encrypting data; treat a leak as a security incident.
