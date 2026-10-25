# Integrating with CCTNS, ICJS and e-Courts

**Status: design only.** NyaySetu does not connect to any government system
today. This document describes how it could, so that the interfaces it already
has are shaped for it. Any real integration needs the owning agency's approval,
credentials and a security review.

## The systems

| System | Owner | What it holds | What NyaySetu would exchange |
|---|---|---|---|
| CCTNS | NCRB / state police | FIRs, case diaries, charge sheets | Receive FIR details for a case; return evidence references and their verification state |
| ICJS | MHA | Data exchange between police, courts, prisons, forensics and prosecution | The transport for the exchanges above |
| e-Courts / CIS | e-Committee, Supreme Court | Case status, hearings, orders | Receive hearing dates and orders; return the evidence index and Integrity Passport links |
| e-Forensics | State FSLs | Laboratory case management | Exchange custody hand-overs and report digests |

## Principles

1. **NyaySetu stays the evidence-integrity layer, not a copy of the case
   system.** It keeps what it needs to anchor and verify evidence; the source of
   truth for FIRs and court orders remains the owning system.
2. **Identifiers, not personal data, cross the boundary by default.** The case
   is matched by the source system's identifier, stored against NyaySetu's own
   case reference. The salted on-chain case key never leaves NyaySetu.
3. **Every inbound record is attributable.** Each message is stored with its
   source system, received time and payload digest in the audit trail, exactly
   as a person's action is.
4. **Nothing inbound is anchored automatically.** An imported FIR is a record,
   not evidence; anchoring remains an officer's act.

## Interfaces

### Inbound: FIR from CCTNS (via ICJS)

`POST /api/integrations/cctns/fir` (to be built), authenticated by mutual TLS
with the ICJS gateway and a signed message.

```json
{
  "source": "CCTNS",
  "stateCode": "MH",
  "districtCode": "PUNE",
  "policeStationCode": "SHIVAJINAGAR",
  "firNumber": "123/2026",
  "firYear": 2026,
  "registeredAt": "2026-10-16T09:30:00+05:30",
  "sections": ["BNS 305", "BNS 331(4)"],
  "messageId": "…",
  "signature": "…"
}
```

The handler would create or update a case and its `fir_records` row (migration
008 already separates the FIR from the case reference), keyed on
`(source, stateCode, policeStationCode, firNumber, firYear)` and idempotent on
`messageId`.

### Outbound: evidence index to e-Courts

When a case reaches the court stage, NyaySetu would offer the court's system:

- the list of evidence items with their public references and current
  verification state,
- a link to each item's Integrity Passport (`/verify/:ref`), which needs no
  account and reveals no personal data,
- on request, the court export bundle (`GET /api/governance/export`), which is
  already built for the requesting role and carries a manifest of SHA-256
  digests.

### Inbound: hearings and orders from e-Courts

Hearing dates and orders would arrive as `court_events` (migration 012 already
has the table, with `linked_type` and `document_sha256`), so the accused
person's reminders and the case timeline would follow the court's own record
instead of being typed in twice.

## Security requirements for any integration

- Mutual TLS and message signatures; no shared passwords.
- Allow-list of source systems; every message logged with its digest.
- Rate limits and size limits per source, as for any other client.
- A schema version on every message, and refusal of unknown versions rather
  than best-effort parsing.
- A data-sharing agreement stating what each side may store and for how long.

## What would need to change in NyaySetu

- An `integration_sources` table and per-source credentials.
- Inbound endpoints under `/api/integrations/*`, outside the user session and
  CSRF model, authenticated per source.
- An outbound queue with retries, on the same pattern as `notification_outbox`.
