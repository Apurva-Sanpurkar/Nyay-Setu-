# Security

How NyaySetu protects records and people, and how each claim is checked. Every
check below runs without the live database, email or blockchain.

## Access control

| Layer | What it does | Checked by |
|---|---|---|
| Sessions | Server-side sessions in an `HttpOnly`, `SameSite=Strict` cookie; suspending an account ends its sessions at once. | `backend/test/harness.test.ts` |
| CSRF | Every state-changing request needs the `x-csrf-token` header bound to the session. | `f08-authorization.test.ts` — a write without it is refused and changes nothing |
| Roles | Each route declares the roles allowed to call it (`requireRole`). | `f08-authorization.test.ts` — 13 role-restricted writes × 7 roles |
| Case assignment | Case data is served only to users assigned to the case (the court registry sees all cases by design). | `f08-authorization.test.ts` — every case-scoped `GET` route, for an unassigned user of each role, with a positive control proving the same requests return data to the owner |
| Database | Row-level security on every table, default deny; the API uses the service role, the browser never does. | `npm run db:validate` (PGlite) checks RLS and audit triggers on every 2.0 table |
| Two people | Disposal, closing a case and release after a mismatch need a second person; the database also refuses a self-approval. | `f19-governance.test.ts` |

The authorization test reads the route table from the running Express app, so a
route added later is covered without anyone adding it to a list. At the time of
writing it walks 145 routes: none answers an anonymous caller with data, none
fails with a 5xx, and none leaks case data to an unassigned user.

## Rate limits

Defaults per IP per minute (all configurable in `backend/.env`):

| Limiter | Default | Applies to |
|---|---|---|
| General | 120 | every API route |
| Sign-in | 10 | `/api/auth/login` and related |
| One-time codes | 5 | requesting a code |
| Writes | 40 | creating or changing records |
| Public verification | 30 | `/api/public/*` |

After `LOGIN_LOCKOUT_ATTEMPTS` (5) failed sign-ins, an account is locked for
fifteen minutes.

## What never leaves the server

- **Blockchain:** no names, FIR numbers, case references, addresses or evidence
  coordinates. Cases are addressed by a salted key. Bail check-in coordinates
  *are* sent to `BailChain`, because the contract performs the geofence check;
  this is a known limitation of the original contract design (see
  `docs/DECISIONS.md`).
- **Public pages:** the Integrity Passport shows only the reference, digests,
  times and custody stages — never people or places.
- **Frontend bundle:** `npm run build` ends with `checkBundleSecrets.mjs`, which
  fails the build on anything resembling a JWT, a private key, a 32-byte hex
  value, a provider API key or the name of a server-only variable.

## Dependency audits

Run on 17 October 2026, production dependencies only:

| Package set | Tool | Result |
|---|---|---|
| backend | `npm audit --omit=dev` | 0 vulnerabilities (fflate upgraded 0.8.2 → 0.8.3 for GHSA-px8p-9vwx-vf98) |
| frontend | `npm audit --omit=dev` | 0 vulnerabilities |
| contracts | `npm audit --omit=dev` | 0 vulnerabilities |
| ai-service | `pip-audit -r requirements.txt` | No known vulnerabilities |
| mobile | `npm audit --omit=dev` | 8 advisories (1 critical, 5 high, 2 moderate) in `tar`, `node-forge`, `@xmldom/xmldom`, `braces`, `image-size`, `postcss`, `sprintf-js` and `uuid`, all pulled in by the `expo` package's build tooling (CLI, Metro, config plugins). They run on the developer's machine during a build, not in the app on the phone. Clearing them needs an Expo SDK upgrade, deferred under decision D-01. |

Re-run these before every deployment; the result above is a snapshot.

## Failure modes

| Failure | Behaviour |
|---|---|
| Blockchain unreachable | Evidence is saved and marked *Saved locally*; the tracker retries. Nothing claims to be confirmed. |
| Transaction never mined | After `PENDING_TIMEOUT_MINUTES` the record becomes *Review required* and an alert is raised. |
| A file does not match | *Integrity mismatch*, recorded on chain; custody does not move; only two people can release it for review. |
| Database missing a 2.0 migration | The affected features answer `SCHEMA_OUT_OF_DATE` (503); `/api/health` lists the missing migrations. |
| AI service down | Screening and estimates report themselves unavailable; nothing else depends on them. |
| Email provider down | Sign-in codes cannot be sent; `/api/health` reports the email transport as unreachable. |

## Reporting a problem

Report suspected vulnerabilities privately to the maintainers rather than in a
public issue, with steps to reproduce.
