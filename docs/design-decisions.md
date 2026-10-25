# Viva notes

The design decisions worth defending, and the answers to the questions an examiner actually asks.

---

## 1 · "Why not just use Postgres?"

This is the question. Everything else follows from it.

A database is exactly as trustworthy as whoever administers it. In a criminal matter, that party is not neutral — it is the prosecution. So a prosecution-run database asking the defence to accept its own audit log is not a solution; it is a restatement of the problem.

Three specific things Postgres cannot give you here:

**A tamper-evident record the adversary cannot rewrite.** A row can be updated. A trigger can be dropped. An audit table can be truncated. All three require privileges the prosecution's own DBA has by definition. A keccak digest in a Sepolia block cannot be altered by anyone in the case, because nobody in the case controls Sepolia.

**A timestamp neither party set.** A summons acknowledgement matters because it cannot be back-dated. `now()` in Postgres is the server's opinion. `block.timestamp` is a value thousands of independent nodes agreed on and cannot retroactively change.

**Verification without access.** Defence counsel checks a digest against the chain using a public RPC endpoint. They need no account on the prosecution's systems, no trust in its operator, and no cooperation from it. That is the property this whole project exists to buy.

And the honest converse: **almost everything else belongs in Postgres.** Evidence files, FIR content, personal data, hearing schedules, dashboards. A chain is expensive, public, permanent and unindexable — which is why the split below is strict.

---

## 2 · The on-chain / off-chain split

### On chain — small, permanent, worth gas

| What | Why it must be there |
|---|---|
| Evidence digest (SHA-256) | The thing integrity is checked against |
| GPS and collection timestamp | Where and when, provable, not asserted |
| Every custody transfer, with the confirming party | The chain of custody itself |
| Integrity checks, **including failures** | A refused tamper attempt is evidence |
| Summons document hash | Proves the document was not edited after issue |
| Delivery confirmation events | Defeats "I was never served" |
| Bail conditions, check-ins, violations | So a breach is computed, not reported |
| Forensic report hash | Write-once: a conclusion cannot be revised silently |
| AI anomaly verdict hash | Write-once: a flag cannot be quietly dropped |

### Off chain — large, private, or correctable

| What | Why it must not be there |
|---|---|
| Evidence files | A 4 GB bodycam video is unaffordable, and IPFS content is world-readable, so it is AES-256-GCM encrypted before pinning |
| FIR content, case notes, bail order text | Long, revised often, and privileged |
| Officer and accused personal data | **A chain is permanent. Personal data must be erasable.** Under the DPDP Act 2023 a data principal has a right to erasure, which an immutable ledger cannot honour. |
| Hearing schedules, dashboards, reports | Derived, queryable, needs indexes |

### The rule that decides it

> On chain if its value comes from being unforgeable. Off chain if its value comes from being readable, revisable or erasable.

---

## 2b · The palette is derived from the logo, and measured

The logo uses exactly two colours: `#009245` green and `#ff751f` orange. Both are used verbatim wherever brand fidelity matters. But a brand colour and a readable colour are not always the same value, so the token system carries both:

| Token | Value (dark) | Contrast | Used for |
|---|---|---|---|
| `--brand-green` | `#009245` | 4.73:1 | gradients, chrome, large fills |
| `--primary` | `#10b45f` | 7.03:1 | text, icons, links |
| `--primary-fill` | `#00803c` | 5.06:1 under white | filled buttons |
| `--accent` | `#ff751f` | 7.12:1 | emphasis, attention states |

`#009245` on the dark canvas is 4.73:1, which clears the 3:1 a UI component needs but sits under the 4.5:1 body text needs. White on `#009245` is 4.04:1, also short. Hence two greens. Light theme darkens both further, because `#ff751f` on white is only 2.69:1.

**And the mapping is not arbitrary.** Green means verified, orange means attention. That is what the logo already says, and it happens to be exactly the two states this product cares about most: a hash that matched, and a deadline that has not been met. A third unrelated colour for "pending" would have weakened both. Danger stays a distinct red so a breach never reads as merely pending, and colour never carries meaning alone: every state has an icon and a word as well.

---

## 3 · "Aadhaar is sensitive. What exactly do you store?"

Nothing reversible.

```
12 digits  →  Verhoeff checksum validated  →  HMAC-SHA256 with a server-side pepper  →  32 bytes
```

- The number is used to build the token and then goes out of scope. No function in the codebase stores, returns or logs one. `backend/src/lib/logger.ts` redacts anything matching a 12-digit pattern before it reaches a log line, as a second net.
- **HMAC, not a plain hash.** A bare SHA-256 of a 12-digit number is brute-forceable in seconds — there are only 10¹² candidates. The pepper is what makes the token non-reversible to anyone holding only the database.
- The token is what the contracts see, so nothing about the on-chain design depends on the number existing anywhere.
- `aadhaar_last4` is kept for display. It is not the number, and it narrows the space by 10⁴ at most, which the pepper already dominates.
- Tokens live in a separate `restricted` schema with its own RLS, readable only by the subject and the court administrator.

**Follow-up you will get: "so you cannot recover the number?"** Correct, and that is the point. The system never needs it. Identity is asserted by an OTP to the mobile registered against that Aadhaar; the token only has to *match*, not *decode*.

---

## 4 · "Your API uses the service role key, which bypasses RLS. So what is RLS for?"

A fair challenge, and the answer is defence in depth.

- **Authorisation for API traffic is enforced by the RBAC middleware**, not RLS. It runs on every route, it can return a useful 403, and it can write an audit row. `assertCaseAccess` is the real gate: being a judge is not enough, the judge must be assigned to the case.
- **RLS is the second wall.** It is what stands between the contents of these tables and: a leaked anon key, a future direct-from-browser query, a Realtime subscription, a misconfigured PostgREST setting. A table with RLS off has no second wall at all.
- Every table in `public` and `restricted` has it enabled, including `sessions` and `otp_challenges`, which deliberately have **zero policies** — default deny, service-only.
- `audit_log` and `action_log` have a read policy for the court administrator and no write policy at all. The audit trigger is `SECURITY DEFINER`, which is the only path in.
- Column-level access is done with a view: `public.user_directory` exposes six safe columns of `public.users` and runs with the owner's rights, so password hashes and lockout state stay behind the table's own policies.

`002_rls.sql` ends with a query that raises a warning if any table slipped through. Run it live if asked.

---

## 5 · "How does tamper detection actually work?"

Four properties, in order of importance.

**The digest is computed on the device, before upload.** `frontend/src/lib/hash.ts` uses WebCrypto; `mobile/src/lib/hash.ts` uses `expo-crypto` over raw bytes. If the server hashed the upload, the digest would only describe what the server received, and an officer would have to take the server's word for it.

**The server recomputes and refuses a disagreement.** `evidence.service.ts` hashes the bytes that arrived and rejects the registration if the client's digest differs, rather than registering a hash that does not describe the stored file. So neither a lying client nor a corrupted transfer can produce a bad record.

**Custody is confirmed by the receiver, not the sender.** The receiving party re-hashes the artefact it was handed and submits that digest. A transfer therefore proves "what I received is what was registered", which is the thing a court needs to know. A sender-signed transfer proves only that a handover was claimed.

**A refused transfer is anchored, not merely refused.** This is the subtle one, and the reason `reportIntegrityCheck` exists separately from `transferCustody`:

> A revert erases state. If `transferCustody` simply reverted on a mismatch, the tamper attempt would leave *nothing at all* on chain — the strongest possible evidence would be destroyed by the very check that caught it.

So the backend calls `reportIntegrityCheck` first, which **never reverts** and emits `IntegrityMismatch`, and only then attempts the transfer. The rejection becomes a permanent record. `mismatchCount` on the evidence struct is a counter nobody can decrement.

Demonstrate it: `npm run chain:check` proves exactly this in two adjacent assertions.

---

## 6 · "A chain cannot detect something that did not happen. How do you catch a missed check-in?"

Correct, and this is the most interesting problem in the project.

A blockchain reacts to transactions. A missed check-in is the *absence* of a transaction, so there is nothing to react to. Three mechanisms together:

**Lazy evaluation in a view.** `checkCompliance()` and `isOverdue()` compute overdue-ness from `block.timestamp` against the last check-in plus the interval plus grace. A court dashboard is therefore correct the instant the deadline passes, and nobody paid gas. Same trick in `SummonsChain.getDeliveryStatus()`, which reports `FAILED` for a stored-`PENDING` summons whose 72 hours elapsed.

**A sweep job that writes the conclusion down.** `backend/src/jobs/scheduler.ts` calls `flagMissedCheckIn()` and `markNonDelivery()`, so the alert exists as a transaction the court can point at rather than only as a computed view.

**Idempotence, so one absence counts once.** `lastMissedFlagAt` moves the reference forward when an absence is flagged, and `flagMissedCheckIn` reverts with `NotOverdue` if nothing is actually due. Without it, the sweep would flag the same absence every two minutes and the compliance score would fall to zero in an hour.

There is a fourth case worth mentioning: a **late** check-in. `weeklyCheckIn` checks overdue-ness *before* resetting the clock, so arriving four days late records the breach and the check-in.

---

## 7 · "Geo-fencing on chain? The EVM has no floating point."

It does not, and it has no trigonometry either. `GeoMath.sol`:

- Coordinates are **micro-degrees** (`degrees × 10⁶`) as `int256`. That is about 11 cm of resolution with no floats.
- Distance uses an **equirectangular projection**: `dy = Δlat × 111320`, `dx = Δlng × 111320 × cos(lat)`. For the few-kilometre radii a bail fence uses, the error is well under 1%.
- `cos(lat)` comes from a **10-degree lookup table with linear interpolation**. Ten constants, no series expansion.
- Comparison is on **squared** distances, so there is never a square root: `dx² + dy² ≤ r²`.
- Longitude wrap across the antimeridian is normalised, so a fence near ±180° does not silently invert.

**Why it matters that this runs on chain and not in the backend:** a violation computed by the prosecution's server is an assertion. A violation computed by the contract is reproducible by anyone reading the chain, including the defence. `frontend/src/lib/geo.ts` uses the same approximation so the distance shown before a check-in matches the one the contract computes.

---

## 8 · "Why one shared `caseId` and no registry contract?"

`caseId = keccak256(FIR_NUMBER)`.

All three contracts address a case by that value, so no registry and no cross-contract call is needed. The FIR number is already the case's unique identifier in Indian criminal procedure, so the mapping is one-way, deterministic and requires no coordination.

The trade-off, stated honestly: the FIR number must be exact and normalised, which is why `caseIdHash()` trims and upper-cases before hashing, and why the number cannot be corrected after registration. A typo means a new case.

---

## 9 · "The ML is trained on synthetic data. Why is that acceptable?"

It is acceptable only because of what the models are used *for*, and the project says so everywhere rather than hiding it.

**Why real data was not used:** evidence metadata from live investigations is protected material with no lawful route to it; bail outcomes linked to individuals are personal data under the DPDP Act 2023; NJDG publishes aggregate pendency, not the per-case feature vectors a delay regressor needs.

**Every distribution is written out** in `ai-service/src/datasets.py`, with the latent scoring function for bail risk and the coefficient structure for delay. A reviewer can judge exactly what the models learned rather than taking a metric on faith.

**What they are used for:**

| Model | Output | Its actual role |
|---|---|---|
| Isolation Forest + rules | anomaly flag with reasons | A prompt for a human to look. Never a finding of tampering. |
| Random Forest | LOW / MEDIUM / HIGH | Advisory input to a judicial decision, shown *before* bail is granted. |
| Gradient Boosting | days, with a range | Listing priority. Reported as a range because a single day count would imply precision it lacks. |

**The design detail worth pointing at:** the anomaly model has an **explainable rule layer** alongside it, and the rules are what carry the flag. Measured on the planted-anomaly evaluation set, the forest alone gets recall 0.59; the forest plus rules gets 1.00 at precision 0.97. That is not just a better number — "the computer flagged it" is not something anyone should act on in a criminal matter, so the reasons a person can check are the deliverable and the forest is there for combinations no single rule names.

**And the anchoring:** the verdict's canonical digest is written on chain by `anchorAnomalyFlag`, **write-once**. Not even a court administrator can replace it. So a flag raised at intake cannot be quietly removed later, which converts an advisory score into something with procedural weight.

---

## 10 · Security decisions, and why each one

| Decision | The alternative, and why it is worse |
|---|---|
| **Server-side sessions, not JWTs** | A JWT is valid until it expires. An officer suspended at 10:00 keeps access until 10:08. The cookie here is an opaque 256-bit random string; the database holds only its SHA-256. Revocation is a `DELETE`, and a stolen database yields no usable sessions. |
| **HttpOnly + Secure + SameSite=Strict** | Script cannot read the session cookie, so XSS cannot exfiltrate it; a cross-site form cannot ride along. |
| **Double-submit CSRF compared against the session row** | Comparing cookie-to-header alone is forgeable by a subdomain that can set cookies. Comparing the header against the token stored on the session row is not. |
| **AES-256-GCM before IPFS, not after** | IPFS content is world-readable by CID. Pinning a plaintext evidence photograph publishes it. GCM rather than CBC because the auth tag detects modified ciphertext — a pinning service could in principle serve back different bytes, and `CIPHERTEXT_TAMPERED` catches that. |
| **The `hash32` Postgres domain** | A malformed digest is rejected at the database boundary, not discovered when a contract call reverts and costs gas. |
| **Explicit nonce ledger for the keeper** | The keeper is a relayer: one wallet, many citizens' transactions. Letting the signer ask the node for a pending count is not reliable — the count straight after a send does not always include it — and two sends then reuse a nonce and one vanishes silently. Serial queue plus an explicit ledger, incremented only after acceptance. This was found by integration testing, not by reading. |
| **Rate limits keyed by session, falling back to an IPv6 /64** | A shared police-station NAT would otherwise lock out a whole thana because one officer mistyped a password. A routed /64 has 2⁶⁴ addresses, so keying on a bare IP is no limit at all. |
| **No CORS layer on the model service** | Nothing in a browser talks to it; the Node API is the only caller. Sending no `Access-Control-Allow-Origin` header is stronger than sending a restrictive one, because with no header no page on any origin can read a response whatever it manages to send. It also removed `flask-cors`, which was the one Python dependency carrying an open advisory. |
| **A signed cookie carrying a half-finished sign-in** | The obvious design hands the client a challenge id and takes it back with the code, which makes id-plus-code sufficient to mint a session from anywhere. Binding the pending sign-in to a short-lived HttpOnly HMAC-signed cookie means the code must be redeemed from the browser that supplied the correct password. It grants nothing on its own and is cleared the moment verification resolves. |
| **Email addresses masked in the email log** | Outbound mail is logged so "I never got the code" is answerable, but a log of every message would otherwise become a directory of who is on bail. Addresses are stored as `a•••••a@gmail.com`; the full one lives in `public.users` and nowhere else. Bodies and codes are never stored at all. |
| **PII behind functions, not an exposed schema** | Exposing `restricted` to PostgREST would have made every table in it reachable over REST forever, including tables added later, and it was a dashboard step invisible in the repository. Four `SECURITY DEFINER` functions do exactly one thing each, pin their `search_path` so a caller cannot shadow a table name, and are granted only to `service_role`. Less setup and a surface that does not grow. |
| **Two audit layers** | The trigger records row diffs and fires whatever made the change, including a direct psql session. The API's `action_log` records *intent*, including attempts that were refused and therefore changed no row. A refused tamper attempt is invisible to a row-diff audit, and it is exactly the event a court wants. |

---

## 10b · "Your OTP is fake, so your whole identity story is fake"

This is the sharpest version of the Aadhaar challenge, and the answer is that there are **two** channels doing **two** jobs, and only one of them is simulated.

| | Sign-in second factor | Citizen action |
|---|---|---|
| Channel | Email, via the deployment's own SMTP server | Aadhaar-registered mobile |
| Question it answers | Is this really the person who holds this account? | Did this specific person perform this legal act? |
| Implementation | `EmailOtpProvider`, genuinely real | `SandboxAadhaarProvider`, simulated |
| `isAuthorisedForProduction` | `true` | `false` |

Three design points worth making when this comes up:

**They are separate providers, not one with a switch.** `otp/index.ts` builds both. A challenge records which channel issued it, and `verifyChallenge` refuses a code created for one channel if it is presented through the other. Without that check, a deployment running both would let the weaker path validate the stronger path's codes.

**The lifecycle is shared, so the simulated one is not weaker in any other respect.** Both use one implementation of the rules: a CSPRNG code, a short TTL, a capped attempt count, single use, and a scope binding it to one purpose and one record. The only thing the sandbox does not do is reach UIDAI.

**`/api/health` reports them separately**, and the interface prints "simulated" wherever an Aadhaar code is displayed. An examiner should be able to find that notice without being told, because a system that quietly faked an identity check would be worse than one that plainly does not have it.

---

## 11 · Things that are deliberately not finished

Saying these first is stronger than being caught by them.

**Aadhaar OTP is simulated.** The live UIDAI API needs AUA/KUA registration, an ASA route, a licence key and a signing certificate, granted to government departments and the entities they authorise, which this deployment is not. `UidaiOtpProvider.ts` writes out the real endpoints and request shapes and **refuses to run without credentials** rather than pretending to work. The sandbox matches the real lifecycle exactly. `/api/health` reports `authorisedForProduction: false` so no deployment can be mistaken for an authenticated one. Swapping providers is one environment variable.

**Citizen actions are relayed by the keeper.** An accused does not hold a funded Sepolia wallet. Their OTP-verified action is submitted by the backend's keeper, and the Aadhaar token in the transaction binds it to them. Production would want account abstraction or a custodial wallet per citizen. The contracts already permit either: `weeklyCheckIn` accepts `KEEPER_ROLE` **or** `ACCUSED_ROLE`, so a citizen with their own wallet can sign directly today.

**Sepolia is a testnet.** A real deployment needs a permissioned chain or an L2 with predictable costs and an availability guarantee, plus a legal framework that recognises an on-chain record as admissible. This demonstrates the mechanism, not the jurisdiction.

**The Hardhat 2 toolchain has open advisories.** Twenty-five of them, all transitive inside Hardhat's own dependency tree, all dev-only. Nothing from `contracts/` is deployed — what reaches Sepolia is solc bytecode. `npm run audit` checks production dependencies and reports zero across all three Node packages; `npm run audit:all` shows the dev findings. The only fix is Hardhat 3, a rewrite that would break a green suite, so the residual is accepted and documented rather than papered over. If asked which dependency choice you would revisit: this one.

**No formal verification.** The contracts have 53 unit tests covering the paths that matter and use OpenZeppelin `AccessControl` and `ReentrancyGuard`, but no Certora or Slither run. For code that would hold criminal evidence, an audit is not optional.

**IPFS pinning is single-provider.** One Pinata account is one point of failure. Production wants several pinning services, or Filecoin for a retrieval guarantee.

---

## 12 · Numbers to have ready

| Claim | Where it comes from |
|---|---|
| 3 smart contracts, 53 passing tests | `npm run contracts:test` |
| 24 backend↔contract integration checks | `npm run chain:check` |
| RLS on 21 of 21 tables in `public` + `restricted` | the verification query at the end of `002_rls.sql` |
| Anomaly pipeline: recall 1.00, precision 0.97 | `models/metadata.json`, `forest_plus_rules` |
| Bail risk: 67% three-class accuracy | `models/metadata.json`; the confusion matrix prints at train time |
| Delay: MAE 69 days, R² 0.82 | `models/metadata.json` |
| Frontend bundle: ~118 KB gzipped, in 4 chunks | `npm run build` in `frontend/` |
| 0 vulnerabilities in everything that ships | `npm run audit` (Node, production deps) and `npm run audit:python` |

---

## 13 · The ten-minute demo, and where to slow down

Drive it from the portals. Invite one account per role from `/admin`, put them all on one case at `/admin/access`, then follow this order:

1. **Landing page** (15 s) — say the thesis: proof rather than paperwork.
2. **Police → capture** (90 s) — this is the moment to slow down. Point at the digest appearing *before* the upload button becomes available, and say: this number is computed on the device, and the server can only agree with it or refuse.
3. **Forensic → accept custody** (45 s) — the receiver re-hashes. Show the green match banner.
4. **Try a tampered file** (90 s) — **the most important 90 seconds in the demo.** Open the same item as the prosecutor, attach an edited file, watch the red mismatch warning appear *before* submitting, submit anyway, and then show the refusal recorded on chain with a transaction hash. Say the line: the rejection is a permanent record, not a server log.
5. **Judge → issue summons** (45 s) — point at the 72-hour countdown.
6. **Accused → acknowledge** (60 s) — OTP plus GPS. Note the sandbox banner out loud; do not let an examiner find it.
7. **Judge → grant bail** (60 s) — press *Assess* before granting, and say the score is advisory and synthetic.
8. **Accused → check in twice** (90 s) — once nearby, once from 5.5 km away. Show the distance shown before the second one, then the violation on the judge's board.
9. **Defence → verify** (75 s) — the close. Upload the genuine file, then the forged one. Say: this answer came from the chain, not from the prosecution's database, and that is the entire point.

Leave the admin health page open in a tab. If something fails live, it tells you which subsystem in one glance, which is a better recovery than guessing.
