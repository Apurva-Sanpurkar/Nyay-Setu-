# Evaluation metrics

Measured 2026-10-17 with `npm run metrics` (backend), 200 items for tamper detection and 100 for sync, against the in-memory database and the simulated chain. Re-run to reproduce; the numbers below are copied from `metrics.csv`.

| Metric | Value | Unit |
|---|---|---|
| items registered | 200 | count |
| tampered files detected (one byte changed) | 100.00 | % |
| genuine files confirmed (false alarms = 100 - this) | 100.00 | % |
| public check latency p50 (in process) | 3.3 | ms |
| public check latency p95 (in process) | 4.9 | ms |
| unauthorized read attempts | 258 | count |
| unauthorized read attempts blocked | 100.00 | % |
| sync items | 100 | count |
| sends failed by injection (RPC down) | 35 | count |
| confirmed on first attempt | 65.00 | % |
| confirmed after one retry pass | 100.00 | % |
| items lost | 0 | count |

## How each is measured

- **Tamper detection:** every registered file is checked on the public verification endpoint twice: as registered, and with one random byte changed. A changed file must not match; the original must.
- **Latency:** wall time of the public check inside one process. It excludes network, database and RPC latency, so it measures the application's own cost only. Against a local Hardhat node the full round trip measured 161–325 ms; a public testnet adds its RPC provider's latency.
- **Unauthorized access:** users of six roles, none assigned to the case, request the case, its FIR and up to ten items' detail, manifest, passport and download. Blocked means 401, 403 or 404. (The court registry sees every case by design and is excluded.)
- **Sync:** 30% of sends fail at random with an RPC outage. Items are never lost; failed ones are retried once, as the officer's retry button or the tracker would.

## Limits

- The chain is simulated, so these numbers say whether the application logic is right, not how a public network behaves under load.
- SHA-256 detecting a one-byte change is expected; the measurement confirms the system compares the right values end to end, not the strength of the hash.
- No user study has been run yet; see `docs/USER_TESTING.md` for the kit.
