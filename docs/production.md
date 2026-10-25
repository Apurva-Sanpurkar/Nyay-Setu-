# Making it production-ready

Written for whoever has it deployed and working, and now has to decide whether it
is safe to put real evidence in.

The short answer: the code is production-shaped, and a default deployment is not
production-configured. Those are different things, and the gap between them is
this document. Six deliberate fallbacks keep a partly configured clone runnable;
each one is safe and each one is wrong for real use.

**The instance tells you which apply to it.** `GET /api/health` returns a
`posture` array naming every fallback still in use and why it matters, and the
same list is written to the log at boot — loudly when `NODE_ENV=production`. Start
there rather than with this list, because it is about your deployment rather than
about deployments in general.

---

## 1 · The six fallbacks

### Aadhaar OTP is simulated

`OTP_PROVIDER=sandbox` generates codes locally. A summons acknowledgement on such
an instance proves somebody with the account's session pressed a button, not that
the recipient was served — which is the entire evidentiary value of the feature.

Fixing it is not a configuration change. UIDAI's Authentication API needs an AUA
or Sub-AUA licence, an ASA connection, a signing certificate and an audit.
`src/otp/UidaiOtpProvider.ts` is written against the real API and is where the
credentials go; the seam exists so the swap is one environment variable once the
licence exists. Until then, say "simulated" in every presentation.

### The chain is local

`CHAIN_NETWORK=localhost` anchors to a chain with one node, which you control.
An anchor is only worth anything because independent parties observe it, so
anchoring to your own Hardhat node proves nothing to a court.

Sepolia is the demonstrable step (see [hosting.md](hosting.md)). A real
deployment would use a permissioned chain the judiciary and the police both run
nodes on, or an L2 with an independent validator set, and the choice is a policy
question rather than a technical one.

### Files fall back to local disk

With no `PINATA_JWT`, encrypted blobs are written to `storage/blobs`. On a
container that filesystem is not durable, and losing it loses the files while
their on-chain digests survive — which is the worst of the two outcomes, because
the record then says a file existed and cannot produce it.

Set `PINATA_JWT`, or point the storage layer at S3 with versioning and object lock.
Note that the digest is computed on the collecting device *before* upload, so the
storage backend is never trusted to be honest about what it holds.

### The keeper wallet is one hot key

`CHAIN_PRIVATE_KEY` is a single key in an environment variable, and it holds
`KEEPER_ROLE` on all three contracts. Whoever reads it can relay any citizen
action. It is the right design for a project — the alternative is every user
holding a wallet — and the wrong one for production.

The production shape is a KMS-held key or a multisig, and `NyayRoles` already
supports granting `KEEPER_ROLE` to a contract rather than to an EOA.

### The model service has no authentication by default

`AI_SERVICE_KEY` blank means the Flask service accepts any caller that can reach
it. On one machine that set is "processes on this machine", which is why the
default is safe. Once it is on its own host, set the key on both sides, and bind
it to a private network rather than a public URL.

### Sign-in can be one factor

`LOGIN_OTP_ENABLED=false`, or no SMTP, makes a password the only thing between an
attacker and a judge's portal. Leave it on. With SMTP configured it is on by
default, and a user can only opt out per-account via `mfa_email_enabled`.

---

## 2 · What is already production-grade

Worth knowing so you do not spend time on it:

- **Sessions** are server-side and opaque. The cookie holds 256 bits of random;
  the database holds only its SHA-256. A session can be revoked the instant an
  officer is suspended, and a stolen database yields no usable sessions. Not JWTs,
  deliberately — a signed token cannot be revoked.
- **CSRF** is double-submit compared against the session row, not against itself.
- **RLS is on every table**, default-deny. It does not police API traffic, because
  the service role bypasses it by design — the RBAC middleware does that. RLS is
  what stands between a leaked anon key and the contents of these tables.
- **Aadhaar numbers are never stored.** A number is validated against its Verhoeff
  check digit, HMAC'd with a server-side pepper, and discarded. The table holding
  the tokens is in a schema PostgREST cannot reach at all; four
  `SECURITY DEFINER` functions with a pinned `search_path` are the only route in.
- **Evidence is encrypted before it leaves the process**, AES-256-GCM, so a
  pinning service that served back different bytes would fail its auth tag.
- **Rate limits and lockout** on every auth route: 10 attempts per minute, five
  failures locks the account for fifteen minutes.
- **The audit trail is two trails.** Database triggers record row changes with
  secrets redacted; `action_log` records API-level attempts, including refused
  ones that left no row behind.
- **Invitations are single-use.** A password that travelled by email is spent on
  first sign-in, and `requirePasswordSettled` refuses every other route until it
  is replaced.
- **The last administrator cannot be removed**, enforced by a trigger rather than
  only by the API, because the API is not the only thing that can write there.

---

## 3 · Before real data: the checklist

**Secrets**

- [ ] Rotate everything that was ever pasted into a chat, a screenshot or a
      terminal you do not own. The Gmail App Password and the Supabase service key
      in particular.
- [ ] Move secrets out of `.env` files into the platform's secret store, or a
      real manager (AWS Secrets Manager, Doppler, Infisical).
- [ ] Set `LOGIN_CHALLENGE_SECRET` to its own value, so it is not the Aadhaar
      pepper doing two jobs.
- [ ] Understand that **`AADHAAR_TOKEN_PEPPER` and `EVIDENCE_ENCRYPTION_KEY`
      cannot be rotated.** Changing the pepper invalidates every stored token;
      changing the key makes every encrypted file undecryptable. Back them up
      somewhere you will still have in five years. `EVIDENCE_ENCRYPTION_KEY_ID`
      exists so a future key can be introduced alongside the old one.

**Configuration**

- [ ] `NODE_ENV=production`. It forces `Secure` cookies and switches the sandbox
      OTP echo off regardless of what `OTP_ECHO_IN_RESPONSE` says.
- [ ] `CORS_ORIGINS` is exact HTTPS origins. No wildcards — cookies are used, and
      a browser would reject a wildcard anyway.
- [ ] `CHAIN_CONFIRMATIONS=2` or more on a public chain. One confirmation can
      still be reorganised away.
- [ ] `SCHEDULER_ENABLED=true` on exactly **one** instance. Two schedulers
      double-sweep, and the sweeps write conclusions.
- [ ] `/api/health` returns an empty `posture` array, or you can justify every
      entry in it.

**Database**

- [ ] All seven migrations applied, in order.
- [ ] Point-in-time recovery on. The chain proves a record was not altered; it
      does not bring back a dropped table.
- [ ] Confirm RLS really is on: `select tablename, rowsecurity from pg_tables
      where schemaname = 'public'` should show `true` for every row.
- [ ] Rotate the anon key if it was ever exposed. It is the key RLS is defending
      against.

**Operations**

- [ ] Monitor the keeper wallet's balance. `/api/health` reports it; when it runs
      dry, chain writes start failing while reads keep working, which is a quiet
      failure mode.
- [ ] Alert on `chain_tx` rows stuck in `pending` and on `email_log` rows with
      status `failed`. Both are visible at `/admin/chain` and `/admin`.
- [ ] Run `POST /api/admin/prune` on a schedule; expired sessions and spent OTP
      challenges accumulate.
- [ ] Keep `contracts/deployed/<network>.json` somewhere permanent. It carries the
      addresses and ABIs, and redeploying to get new ones orphans every anchor
      already written.

**Legal and organisational** — outside the code, and the part that actually
decides whether this is usable:

- [ ] A UIDAI licence, or a documented statement that identity verification is
      simulated.
- [ ] A DPDP Act assessment. The system holds Aadhaar tokens, encrypted phone
      numbers and addresses, and GPS coordinates of accused persons.
- [ ] A retention policy. Nothing here deletes evidence, by design; something has
      to decide when a case's data may go.
- [ ] Whoever holds `court_admin` can invite any role, including another
      administrator. That is an organisational control, not a technical one.

---

## 4 · What is verified, and how

| Layer | Check | Command |
|---|---|---|
| Contracts | 53 unit tests: tamper rejection, unauthorised transfer, expired summons, missed check-in, geo-fence breach | `npm run contracts:test` |
| Backend ↔ contracts | 24 integration checks against a live chain | `npm run chain:check` |
| Sign-in and invitations | 22 assertions over real HTTP | `cd backend && npm run auth:check -- <admin-email> <password> <you+check@your-mail>` |
| Every feature, end to end | 51 assertions covering all three modules, driven through the invite flow | `cd backend && npm run flow:check -- <admin-email> <password>` |
| Types | Strict TypeScript, backend and frontend | `npm run typecheck` |
| Dependencies | 0 vulnerabilities, Node and Python | `npm run audit && npm run audit:python` |
| Models | Metrics at train time, written to `models/metadata.json` | `npm run ai:train` |

None of these tests the one thing that matters most, which is whether the people
using it understand what it does and does not prove. That is what `/handbook` is
for.
