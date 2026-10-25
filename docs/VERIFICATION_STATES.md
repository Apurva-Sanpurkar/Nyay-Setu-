# Verification states

Every evidence-related write to the chain — a registration, an integrity
check, a custody transfer, a forensic report, an anomaly flag, a document
digest — is tracked as an **anchor** and moves through six states.

> These are **application** states. The contracts know nothing about them.
> They describe how far one transaction has got and whether the application
> has checked what came back. A contract can only tell you what it stored; the
> state machine tells you whether we have confirmed that it stored what we
> sent.

| State | Meaning | Shown to people as |
|---|---|---|
| `LOCAL_ONLY` | Recorded off chain (or on a phone). Nothing sent. | Recorded locally — not yet sent |
| `SUBMITTED` | The node accepted a transaction; we have its hash. Not confirmed. | Submitted — awaiting confirmation |
| `CONFIRMED` | Receipt succeeded, the expected event was decoded from it with the expected digest and case, and `CONFIRMATION_DEPTH` blocks sit on top. | Confirmed on chain |
| `SYNC_ERROR` | Sending failed, the transaction reverted, or the node dropped it. | Failed to anchor — retry available |
| `REVIEW_REQUIRED` | A person must look: no receipt for too long, the event missing or for a different case, or a reorg after confirmation. | Needs review |
| `INTEGRITY_MISMATCH` | A digest that should have matched did not — at a custody handover, a laboratory re-check, or in the event itself. | Integrity mismatch |

Only `CONFIRMED` is ever presented as verified. `SUBMITTED` is not confirmed.

## Transitions

The table lives in `backend/src/services/verification/stateMachine.ts` and
nowhere else.

```
LOCAL_ONLY          → SUBMITTED, SYNC_ERROR, INTEGRITY_MISMATCH
SUBMITTED           → CONFIRMED, SYNC_ERROR, REVIEW_REQUIRED, INTEGRITY_MISMATCH
SYNC_ERROR          → SUBMITTED, REVIEW_REQUIRED
CONFIRMED           → REVIEW_REQUIRED, INTEGRITY_MISMATCH
REVIEW_REQUIRED     → SUBMITTED, CONFIRMED, INTEGRITY_MISMATCH, SYNC_ERROR
INTEGRITY_MISMATCH  → REVIEW_REQUIRED      (two-person approval, F19)
```

An illegal transition throws `ILLEGAL_TRANSITION` (409) and is written to
`action_log` with outcome `refused`. A transition to `CONFIRMED` additionally
requires a proof object — successful receipt, matched event, matched digest,
block hash, enough confirmations — so no caller can reach it by asking. The
database enforces the same thing: `anchors_confirmed_has_proof` refuses a
`CONFIRMED` row without a transaction hash, block number and block hash.

Every transition is appended to `anchor_state_events`, which a trigger makes
append-only.

## What moves an anchor

| Observation | From | To | Reason code |
|---|---|---|---|
| Node accepted the transaction | LOCAL_ONLY / SYNC_ERROR / REVIEW_REQUIRED | SUBMITTED | `SENT` |
| RPC unreachable when sending | LOCAL_ONLY | SYNC_ERROR | `RPC_UNAVAILABLE` |
| Contract refused during estimation | LOCAL_ONLY | SYNC_ERROR | `CONTRACT_REJECTED` |
| Receipt status 0 | SUBMITTED | SYNC_ERROR | `REVERTED` |
| Node forgot the tx, after `DROPPED_AFTER_MINUTES` | SUBMITTED | SYNC_ERROR | `DROPPED` |
| No receipt after `PENDING_TIMEOUT_MINUTES` | SUBMITTED | REVIEW_REQUIRED | `PENDING_TOO_LONG` |
| Receipt has no expected event | SUBMITTED | REVIEW_REQUIRED | `EVENT_MISSING` |
| Event's case / evidence id differs | SUBMITTED | REVIEW_REQUIRED | `EVENT_ARGS_MISMATCH` |
| Event's digest differs from what was sent | SUBMITTED | INTEGRITY_MISMATCH | `EVENT_DIGEST_MISMATCH` |
| Event matches, depth reached | SUBMITTED | CONFIRMED | `CONFIRMED` |
| Receipt vanished, or moved block, within `REORG_WATCH_MINUTES` | CONFIRMED | REVIEW_REQUIRED | `REORGED` |
| Custody receiver's digest refused by the chain | any | INTEGRITY_MISMATCH | `CUSTODY_HASH_MISMATCH` |
| Laboratory re-hash on arrival refused by the chain | any | INTEGRITY_MISMATCH | `LAB_RECHECK_MISMATCH` |
| RPC unreachable while tracking | any | *(unchanged)* | `RPC_UNAVAILABLE` |

An RPC outage never changes state on its own: it says nothing about the
transaction.

## Retry safety

- Registration takes an `Idempotency-Key` header. A second request with the same
  key returns the first result (`200`, `replayed: true`) and sends nothing.
  Two copies racing produce one row: the database's unique constraint decides.
- Each anchor has its own idempotency key; creating it twice returns the same row.
- A retry of an anchor that once had a transaction **first looks for that
  transaction's receipt**. If it was mined after all, the anchor is tracked
  from that receipt and nothing is resent. If the chain cannot be asked, the
  retry is refused rather than risking a second record on chain.
- Transitions use optimistic concurrency: an update applies only if the state is
  still the one it was read in, so two workers cannot both move the same anchor.
- Sends go through the keeper's existing serial queue and nonce ledger.

## Configuration

| Variable | Default | |
|---|---|---|
| `CONFIRMATION_DEPTH` | 3 on a public network, 1 on `localhost`/`hardhat` | Blocks required on top of the receipt's block |
| `PENDING_TIMEOUT_MINUTES` | 30 | No receipt after this long → review |
| `DROPPED_AFTER_MINUTES` | 10 | Unknown to the node after this long → dropped |
| `REORG_WATCH_MINUTES` | 60 | How long a confirmed anchor is re-checked |

The tracker runs inside the scheduler (`SWEEP_INTERVAL_MS`). On a host where the
process sleeps, `POST /api/health/sweep` with `CRON_SECRET` runs the same pass.

## Endpoints

- `GET /api/evidence/:id/verification` — state, explanation, and full history.
- `POST /api/evidence/:id/anchor/retry` — police with write access, or the registry.
- `POST /api/evidence/:id/anchor/recheck` — any assigned role; moves state only if the chain justifies it.
