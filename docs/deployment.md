# Deploying NyaySetu

Four services, and the order matters because each one consumes something the previous produced.

```
1. contracts   →  addresses + ABIs
2. database    →  schema, RLS, audit triggers
3. ai-service  →  a URL the API calls
4. backend     →  a URL the frontend calls
5. frontend    →  the thing people open
```

Deploying out of order is the single most common way to end up with a stack that starts but does nothing.

---

## 1 · Contracts → Sepolia

### What you need

- A Sepolia RPC URL. Alchemy, Infura and QuickNode all have a free tier.
- A wallet with Sepolia ETH. Use a throwaway one; the key goes in a `.env`.
  Faucets: [sepoliafaucet.com](https://sepoliafaucet.com), [Alchemy's faucet](https://sepoliafaucet.com), or the Google Cloud Web3 faucet.
- About 0.05 ETH covers deployment plus a few hundred demo transactions.

### Deploy

```bash
cd contracts
cp .env.example .env
```

```dotenv
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
DEPLOYER_PRIVATE_KEY=0x…                # 64 hex characters, throwaway wallet
ETHERSCAN_API_KEY=                      # optional, for source verification

# Split the roles across real wallets in production. Leave blank and the
# deployer receives every role, which is right for a demo and wrong for a court.
POLICE_ADDRESSES=
FORENSIC_ADDRESSES=
PROSECUTOR_ADDRESSES=
JUDGE_ADDRESSES=
DEFENCE_ADDRESSES=
ACCUSED_ADDRESSES=
COURT_ADMIN_ADDRESSES=
KEEPER_ADDRESSES=0x…                    # the backend's relayer wallet

# 0 makes a missed check-in fire immediately, which a live demo needs.
# Production value is 86400.
BAIL_GRACE_PERIOD_SECONDS=86400
```

```bash
npm test                  # do not deploy a suite that is not green
npm run deploy:sepolia
npm run verify:sepolia    # optional, publishes the source to Etherscan
```

This writes `contracts/deployed/sepolia.json` with addresses **and** ABIs. **Commit that file.** It is what the backend reads at boot, and it is part of the project record.

### Adding an operator later

```bash
# add the wallet to the right *_ADDRESSES line in contracts/.env, then
npm run grant:sepolia
```

No redeployment needed.

---

## 2 · Database → Supabase

Create a project, then run these in the SQL editor, in order:

| File | What it does |
|---|---|
| `database/migrations/001_schema.sql` | schemas, enums, tables, indexes, the `hash32` domain |
| `database/migrations/002_rls.sql` | row level security: default deny, then explicit policies |
| `database/migrations/003_audit.sql` | audit triggers on every sensitive table |
| `database/migrations/004_otp_channels.sql` | email OTP channel, email delivery log |
| `database/migrations/005_pii_access.sql` | `SECURITY DEFINER` functions for PII |
| `database/seed/reference.sql` | role reference rows, indexer cursors |

### No dashboard step

Aadhaar tokens and encrypted contact details live in a `restricted` schema that is deliberately **not** listed under Settings → API → Exposed schemas.

An earlier version did expose it. That had two problems: it was a manual step invisible in the repository, so it got skipped and produced an error that looked like a code bug; and exposing a schema makes every table in it reachable over REST forever, including ones added later. Migration `005` replaces it with four named functions — read one, list which exist, find by token, upsert — each pinning its `search_path` and granted only to `service_role`. The surface stops growing.

### Verify RLS took

```sql
select schemaname, tablename, rowsecurity
from pg_tables
where schemaname in ('public', 'restricted')
order by rowsecurity, tablename;
```

Every row must show `rowsecurity = true`. `002_rls.sql` raises a warning at the end if any does not.

### Collect the credentials

From **Settings → API**:

- `SUPABASE_URL` — the project URL
- `SUPABASE_SERVICE_ROLE_KEY` — the **service role** key, not the anon key

The service role key bypasses RLS. It belongs on the server and nowhere else. It must never reach a frontend bundle, a mobile app, or a git commit.

---

## 3 · AI service → Railway

Separate service, because scikit-learn inference is CPU-bound and would stall the API's event loop.

| Setting | Value |
|---|---|
| Root directory | `ai-service` |
| Build command | `pip install -r requirements.txt && python train.py` |
| Start command | `waitress-serve --host=0.0.0.0 --port=$PORT app:app` |

Training at build time is deliberate: it keeps the image reproducible from source with a fixed seed, and avoids committing ~10 MB of joblib.

### Environment

```dotenv
AI_SERVICE_KEY=<a long random string>   # the API sends this as X-AI-KEY
ANOMALY_SCORE_THRESHOLD=0.62
```

Generate the key with `openssl rand -hex 32`. Leave it blank only for local runs.

Check it with `GET /health`. It reports which models loaded and the model version.

---

## 4 · Backend → Railway

| Setting | Value |
|---|---|
| Root directory | `backend` |
| Build command | `npm ci && npm run build` |
| Start command | `npm start` |
| Health check | `/api/health` |

### Environment

```dotenv
NODE_ENV=production
PORT=4000                                # Railway injects its own; this is the fallback

# Cookies are credentials, so no wildcards.
CORS_ORIGINS=https://nyaysetu.vercel.app

# ------------------------------------------------------------------ database
SUPABASE_URL=https://YOUR-REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=…

# ------------------------------------------------------------------ sessions
SESSION_TTL_HOURS=8
# If the API and the SPA are on different domains, this must be `none`, which
# forces Secure and therefore HTTPS. Same site: keep `strict`.
COOKIE_SAMESITE=none

# -------------------------------------------------------------------- crypto
# Generate once. Keep them forever. Rotating either one is a migration.
AADHAAR_TOKEN_PEPPER=…                   # >= 32 chars; changing it voids every token
EVIDENCE_ENCRYPTION_KEY=…                # exactly 64 hex chars
EVIDENCE_ENCRYPTION_KEY_ID=v1

# --------------------------------------------------------------------- chain
CHAIN_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
CHAIN_PRIVATE_KEY=0x…                    # the keeper; needs KEEPER_ROLE and ETH
CHAIN_NETWORK=sepolia
CHAIN_CONFIRMATIONS=2                    # 2 is steadier than 1 on a public testnet

# ---------------------------------------------------------------------- IPFS
PINATA_JWT=…                             # Pinata → API Keys → New Key, scoped to pinFileToIPFS
PINATA_GATEWAY=https://gateway.pinata.cloud

# ------------------------------------------------------------------------ AI
AI_SERVICE_URL=https://nyaysetu-ai.up.railway.app
AI_SERVICE_KEY=…                         # same value as the AI service

# ----------------------------------------------------------------------- OTP
OTP_PROVIDER=sandbox                     # `uidai` needs an AUA licence; see below
OTP_ECHO_IN_RESPONSE=false               # forced off in production anyway

# ---------------------------------------------------------------------- jobs
SUMMONS_WINDOW_HOURS=72
SWEEP_INTERVAL_MS=120000
SCHEDULER_ENABLED=true                   # set false on all but ONE instance
INDEXER_ENABLED=true
```

### Two things that will bite you

**Generate the secrets before the first deploy, and keep them.** `AADHAAR_TOKEN_PEPPER` is baked into every stored Aadhaar token; changing it makes every existing token unmatchable and every OTP flow fail. `EVIDENCE_ENCRYPTION_KEY` decrypts every pinned file; losing it loses the evidence. Put both in a secrets manager on day one.

**If you scale past one instance, set `SCHEDULER_ENABLED=false` on the others.** Two schedulers sweeping the same summons will both try to mark it non-delivered; the second reverts with `SummonsNotPending`, which is harmless but noisy and wastes gas. For several instances, turn the scheduler off everywhere and add a Railway cron service:

| Setting | Value |
|---|---|
| Root directory | `backend` |
| Cron | `*/2 * * * *` |
| Command | `npm run sweep` |

### Seed, once

```bash
cd backend && npm run bootstrap
```

Creates one account per role plus a demo case. In a real deployment, create real accounts through `POST /api/admin/users` instead and skip this.

### Fund the keeper

The keeper relays every citizen action. Out of ETH means every check-in and acknowledgement fails. `/api/health` reports `keeperBalanceWei`, and the admin dashboard turns it red at zero. Watch it.

---

## 5 · Frontend → Vercel

| Setting | Value |
|---|---|
| Root directory | `frontend` |
| Framework preset | Vite |
| Build command | `npm run build` |
| Output directory | `dist` |

### Environment

```dotenv
VITE_API_BASE=https://nyaysetu-api.up.railway.app
```

Leave `VITE_API_BASE` blank only in development, where Vite proxies `/api` and keeps the browser on one origin so `SameSite=Strict` works with no CORS relaxation at all.

### SPA routing

Client-side routes need a rewrite, or a refresh on `/judge/bail` returns 404. Add `frontend/vercel.json`:

```json
{
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

### Netlify instead

Same build output. Add `frontend/netlify.toml`:

```toml
[build]
  base = "frontend"
  command = "npm run build"
  publish = "dist"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

Nothing in the build is platform-specific; only the redirect rule differs.

---

## 6 · Mobile, optional

```bash
cd mobile
npx expo install --fix          # reconcile versions to your SDK
```

`mobile/.env`:

```dotenv
EXPO_PUBLIC_API_BASE_URL=https://nyaysetu-api.up.railway.app
```

Then `eas build --platform android --profile preview` for a shareable APK, after `npm i -g eas-cli && eas login`.

Locally: an Android emulator reaches your laptop at `10.0.2.2`, an iOS simulator at `localhost`, and a physical phone at your LAN address — which must also be added to `CORS_ORIGINS`.

---

## Switching the OTP provider to a real one

Only for a deployment that holds a UIDAI licence. What is required:

1. AUA or Sub-AUA registration with UIDAI under the Authentication Regulations 2016
2. An ASA to carry requests; an AUA never reaches CIDR directly
3. A UIDAI-issued licence key and AUA code
4. A digital signature certificate: every Auth XML is signed, and the PID block is encrypted with the UIDAI public certificate
5. A security audit before production traffic

Then:

```dotenv
OTP_PROVIDER=uidai
UIDAI_BASE_URL=…
UIDAI_CLIENT_ID=…
UIDAI_CLIENT_SECRET=…
UIDAI_AUA_CODE=…
```

…and implement `sendOtp` / `verifyOtp` in `backend/src/otp/UidaiOtpProvider.ts`, where the endpoints, the request shapes and the signing steps are already written out. Nothing above that interface changes: the swap is one file.

---

## Post-deploy checklist

```bash
curl https://nyaysetu-api.up.railway.app/api/health
```

- [ ] `database.reachable` is true
- [ ] `blockchain.ready` is true, and `network.chainId` is 11155111
- [ ] `blockchain.keeperBalanceWei` is not "0"
- [ ] `storage.backend` is "pinata", not "local-fallback"
- [ ] `ai.reachable` is true
- [ ] `identity.authorisedForProduction` reads what you expect it to
- [ ] Signing in sets an `HttpOnly; Secure; SameSite` cookie — check it in devtools
- [ ] A refresh on a deep link such as `/judge/bail` does not 404
- [ ] Every table still reports `rowsecurity = true`
- [ ] `.env` is not in the repository: `git log --all --full-history -- "**/.env"` returns nothing
- [ ] `npm run audit` reports zero across all three Node packages
- [ ] `npm run audit:python` reports zero

---

## Recovering from the usual failures

| Symptom | Cause | Fix |
|---|---|---|
| `Blockchain unavailable: No deployment artefact found` | `contracts/deployed/<network>.json` is missing or `CHAIN_NETWORK` does not match its filename | Redeploy, or set `DEPLOYED_ARTIFACT` to the exact path |
| `CHAIN_ACCESSCONTROLUNAUTHORIZEDACCOUNT` | The keeper wallet lacks the on-chain role | Add it to `KEEPER_ADDRESSES` and run `npm run grant:sepolia` |
| Every OTP flow fails after a redeploy | `AADHAAR_TOKEN_PEPPER` changed | Restore the original value. There is no other recovery. |
| `CIPHERTEXT_TAMPERED` on download | Wrong `EVIDENCE_ENCRYPTION_KEY`, or the pinned bytes really did change | Check the key first; if it is right, this is a genuine finding |
| Sign-in succeeds but every later call 401s | The cookie is being dropped cross-site | `COOKIE_SAMESITE=none` and HTTPS on both ends, and the exact origin in `CORS_ORIGINS` |
| `Writing the Aadhaar token failed … schema` | `restricted` is not exposed | Supabase → Settings → API → Exposed schemas |
| Transactions stop confirming | The keeper is out of ETH | Top it up; `/api/health` shows the balance |

---

## Hosting it on Vercel, Render or similar

See **[hosting.md](hosting.md)**. Read it before importing the repo into Vercel:
the frontend builds fine, and four things in the API break silently unless they
are configured for it — the scheduler that closes the 72 hour summons window, the
blob fallback with no writable disk, and the two `127.0.0.1` URLs for the chain
and the model service.
