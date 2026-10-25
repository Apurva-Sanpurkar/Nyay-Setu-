// Must stay first: switches every external service off before the app reads its config.
import "../support/env";
import { randomBytes, randomInt } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { performance } from "perf_hooks";
import { assign, call, makeActor, resetDatabase, stopServer, ROLES, type Actor } from "../support/harness";
import { FakeChain } from "../support/fakeChain";
import { createCase, sha, uploadEvidence } from "../support/evidence";
import { trackAnchors } from "../../src/services/verification/anchors";
import { env } from "../../src/config/env";
import type { UserRole } from "../../src/middleware/auth";

/**
 * The evaluation metrics (2.0 · F9), measured by driving the real API in process
 * against the in-memory database and the simulated chain. Nothing here touches
 * Supabase, email or a real network.
 *
 *   npm run metrics [-- --items=200]
 *
 * Writes docs/metrics/metrics.csv and docs/metrics/METRICS.md. Timings exclude
 * real RPC and database latency by construction; see the limits in the report.
 */

const arg = (name: string, fallback: number) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? Number(found.split("=")[1]) : fallback;
};
const ITEMS = arg("items", 200);
const SYNC_ITEMS = arg("sync", 100);
const FAILURE_RATE = 0.3;

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function flipOneByte(bytes: Buffer): Buffer {
  const copy = Buffer.from(bytes);
  const at = randomInt(copy.length);
  copy[at] = copy[at] ^ (1 + randomInt(255));
  return copy;
}

async function main() {
  const fake = new FakeChain().install();
  (env as any).confirmationDepth = 1;
  resetDatabase();
  const rows: [string, string, string][] = [];
  const record = (metric: string, value: string | number, unit: string) => rows.push([metric, String(value), unit]);

  const police = makeActor("police");
  const kase = await createCase(police);

  /* ---------------------------------------------- 1. tamper detection */
  const items: { ref: string; bytes: Buffer }[] = [];
  for (let i = 0; i < ITEMS; i++) {
    const bytes = randomBytes(1024 + randomInt(64 * 1024));
    const { response } = await uploadEvidence(police, kase.id, { bytes });
    if (response.status !== 201) throw new Error(`upload ${i} failed: ${JSON.stringify(response.body)}`);
    fake.mine(2);
    items.push({ ref: response.body.evidence.public_ref, bytes });
  }
  await trackAnchors();

  let genuineMatched = 0;
  let tamperedCaught = 0;
  const timings: number[] = [];
  for (const item of items) {
    const t0 = performance.now();
    const genuine = await call(null, "POST", `/api/public/verify/${item.ref}/check`, { body: { sha256: sha(item.bytes) } });
    timings.push(performance.now() - t0);
    if (genuine.body?.result?.matched === true) genuineMatched++;

    const tampered = await call(null, "POST", `/api/public/verify/${item.ref}/check`, { body: { sha256: sha(flipOneByte(item.bytes)) } });
    if (tampered.body?.result?.matched === false) tamperedCaught++;
  }
  timings.sort((a, b) => a - b);
  record("items registered", ITEMS, "count");
  record("tampered files detected (one byte changed)", ((tamperedCaught / ITEMS) * 100).toFixed(2), "%");
  record("genuine files confirmed (false alarms = 100 - this)", ((genuineMatched / ITEMS) * 100).toFixed(2), "%");
  record("public check latency p50 (in process)", percentile(timings, 50).toFixed(1), "ms");
  record("public check latency p95 (in process)", percentile(timings, 95).toFixed(1), "ms");

  /* ------------------------------------- 2. unauthorized access blocked */
  const evidenceIds = (await call(police, "GET", `/api/evidence/case/${kase.id}`)).body.items.slice(0, 10).map((e: { id: string }) => e.id);
  const probes = [
    `/api/cases/${kase.id}`,
    `/api/cases/${kase.id}/fir`,
    `/api/evidence/case/${kase.id}`,
    ...evidenceIds.flatMap((id: string) => [`/api/evidence/${id}`, `/api/evidence/${id}/manifest`, `/api/evidence/${id}/passport`, `/api/evidence/${id}/download`]),
  ];
  let attempts = 0;
  let blocked = 0;
  for (const role of ROLES.filter((r) => r !== "court_admin")) {
    const outsider = makeActor(role as UserRole);
    for (const probe of probes) {
      attempts++;
      const res = await call(outsider, "GET", probe);
      if (res.status === 401 || res.status === 403 || res.status === 404) blocked++;
    }
  }
  record("unauthorized read attempts", attempts, "count");
  record("unauthorized read attempts blocked", ((blocked / attempts) * 100).toFixed(2), "%");

  /* ---------------------------------------- 3. sync under injected faults */
  const kase2 = await createCase(police);
  const syncIds: string[] = [];
  let injected = 0;
  for (let i = 0; i < SYNC_ITEMS; i++) {
    if (Math.random() < FAILURE_RATE) {
      fake.nextSend = "rpc-down";
      injected++;
    }
    const { response } = await uploadEvidence(police, kase2.id);
    if (response.status !== 201) throw new Error(`sync upload ${i} failed: ${JSON.stringify(response.body)}`);
    syncIds.push(response.body.evidence.id);
    fake.mine(2);
  }
  const stateOf = async (id: string) => (await call(police, "GET", `/api/evidence/${id}/verification`)).body.verification.state as string;
  const firstPass = (await Promise.all(syncIds.map(stateOf))).filter((s) => s === "CONFIRMED").length;
  // One retry pass for anything that did not anchor, as the officer or the tracker would.
  for (const id of syncIds) {
    if ((await stateOf(id)) === "SYNC_ERROR") await call(police, "POST", `/api/evidence/${id}/anchor/retry`);
  }
  fake.mine(2);
  await trackAnchors();
  const finalStates = await Promise.all(syncIds.map(stateOf));
  const confirmed = finalStates.filter((s) => s === "CONFIRMED").length;
  const listed = (await call(police, "GET", `/api/evidence/case/${kase2.id}`)).body.items.length;
  record("sync items", SYNC_ITEMS, "count");
  record("sends failed by injection (RPC down)", injected, "count");
  record("confirmed on first attempt", ((firstPass / SYNC_ITEMS) * 100).toFixed(2), "%");
  record("confirmed after one retry pass", ((confirmed / SYNC_ITEMS) * 100).toFixed(2), "%");
  record("items lost", SYNC_ITEMS - listed, "count");

  fake.uninstall();
  await stopServer();

  /* --------------------------------------------------------- reports */
  const out = path.resolve(__dirname, "..", "..", "..", "docs", "metrics");
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "metrics.csv"), ["metric,value,unit", ...rows.map((r) => r.map((c) => `"${c}"`).join(","))].join("\n") + "\n");
  const when = new Date().toISOString().slice(0, 10);
  writeFileSync(
    path.join(out, "METRICS.md"),
    [
      "# Evaluation metrics",
      "",
      `Measured ${when} with \`npm run metrics\` (backend), ${ITEMS} items for tamper detection and ${SYNC_ITEMS} for sync, against the in-memory database and the simulated chain. Re-run to reproduce; the numbers below are copied from \`metrics.csv\`.`,
      "",
      "| Metric | Value | Unit |",
      "|---|---|---|",
      ...rows.map(([m, v, u]) => `| ${m} | ${v} | ${u} |`),
      "",
      "## How each is measured",
      "",
      "- **Tamper detection:** every registered file is checked on the public verification endpoint twice: as registered, and with one random byte changed. A changed file must not match; the original must.",
      "- **Latency:** wall time of the public check inside one process. It excludes network, database and RPC latency, so it measures the application's own cost only. Against a local Hardhat node the full round trip measured 161–325 ms; a public testnet adds its RPC provider's latency.",
      `- **Unauthorized access:** users of six roles, none assigned to the case, request the case, its FIR and up to ten items' detail, manifest, passport and download. Blocked means 401, 403 or 404. (The court registry sees every case by design and is excluded.)`,
      `- **Sync:** ${Math.round(FAILURE_RATE * 100)}% of sends fail at random with an RPC outage. Items are never lost; failed ones are retried once, as the officer's retry button or the tracker would.`,
      "",
      "## Limits",
      "",
      "- The chain is simulated, so these numbers say whether the application logic is right, not how a public network behaves under load.",
      "- SHA-256 detecting a one-byte change is expected; the measurement confirms the system compares the right values end to end, not the strength of the hash.",
      "- No user study has been run yet; see `docs/USER_TESTING.md` for the kit.",
      "",
    ].join("\n")
  );
  console.table(rows.map(([metric, value, unit]) => ({ metric, value, unit })));
  console.log(`Written to ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
