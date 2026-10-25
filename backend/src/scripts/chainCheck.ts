/**
 * Exercises the contract layer end to end without touching Supabase.
 *
 *   cd backend && npm run chain:check
 *
 * Useful for two things:
 *   - proving the backend/contract wiring works before the database exists,
 *     which is the first thing to check on a fresh clone
 *   - reproducing the tamper-rejection path on demand, since that is the single
 *     most important behaviour in the system
 *
 * It writes real transactions, so point it at a local chain unless you mean to
 * spend Sepolia ETH.
 */
import { initChain, chain, submit, read, eventArgs, toMicroDegrees, fromMicroDegrees } from "../lib/chain";
import { sha256Hex, keccakOfString, aadhaarToken } from "../lib/crypto";
import { AppError } from "../lib/errors";

const PASS = "  [ok]  ";
const FAIL = "  [!!]  ";

let failures = 0;

function check(condition: boolean, description: string, detail?: string) {
  if (condition) {
    console.log(PASS + description + (detail ? `  (${detail})` : ""));
  } else {
    failures += 1;
    console.log(FAIL + description + (detail ? `  (${detail})` : ""));
  }
}

async function main() {
  console.log("\nNyaySetu chain layer check\n" + "=".repeat(64));

  initChain();
  if (!chain.isReady) {
    console.error(`\nChain bridge not ready: ${chain.reason}\n`);
    process.exit(1);
  }

  console.log(`  network   ${chain.network?.name} (chain ${chain.network?.chainId})`);
  console.log(`  keeper    ${chain.keeperAddress}`);
  console.log(`  block     ${await chain.blockNumber()}\n`);

  // Unique per run, so repeated runs do not collide on the case id.
  const stamp = Date.now();
  const caseId = keccakOfString(`CHAINCHECK/${stamp}`);
  const officerToken = aadhaarToken("223344556676");
  const accusedToken = aadhaarToken("722667788997");

  const genuine = Buffer.from(`chaincheck-evidence-${stamp}`, "utf8");
  const tampered = Buffer.concat([genuine, Buffer.from("-EDITED")]);
  const genuineHash = sha256Hex(genuine);
  const tamperedHash = sha256Hex(tampered);

  const LAT = 18.5308;
  const LNG = 73.8478;

  // ------------------------------------------------------- evidence
  console.log("EvidenceChain");

  const registered = await submit("EvidenceChain", "registerEvidence", [
    caseId,
    genuineHash,
    toMicroDegrees(LAT, "lat"),
    toMicroDegrees(LNG, "lng"),
    officerToken,
  ]);
  const args = eventArgs(registered.receipt, "EvidenceChain", "EvidenceRegistered");
  const evidenceId = args?.evidenceId ? Number(args.evidenceId) : null;

  check(evidenceId !== null, "registerEvidence emits EvidenceRegistered", `id ${evidenceId}`);

  const stored = (await read<any>("EvidenceChain", "getEvidence", [evidenceId])) as any;
  check(stored.fileHash === genuineHash, "the stored digest round-trips exactly");
  check(
    Math.abs(fromMicroDegrees(stored.gpsLat) - LAT) < 1e-6,
    "GPS survives the micro-degree conversion",
    `${fromMicroDegrees(stored.gpsLat)}, ${fromMicroDegrees(stored.gpsLng)}`
  );
  check(stored.officerAadhaarToken === officerToken, "the Aadhaar token is stored, not the number");

  check(
    (await read<boolean>("EvidenceChain", "verifyIntegrity", [evidenceId, genuineHash])) === true,
    "verifyIntegrity accepts the genuine digest"
  );
  check(
    (await read<boolean>("EvidenceChain", "verifyIntegrity", [evidenceId, tamperedHash])) === false,
    "verifyIntegrity rejects an altered digest"
  );

  // A failing check must be recorded rather than reverted: this is the
  // behaviour the whole tamper-evidence claim rests on.
  const mismatchTx = await submit("EvidenceChain", "reportIntegrityCheck", [evidenceId, tamperedHash]);
  const mismatchEvent = eventArgs(mismatchTx.receipt, "EvidenceChain", "IntegrityMismatch");
  check(mismatchEvent !== null, "a failed check emits IntegrityMismatch instead of reverting");

  const afterMismatch = (await read<any>("EvidenceChain", "getEvidence", [evidenceId])) as any;
  check(Number(afterMismatch.mismatchCount) === 1, "the mismatch counter is now permanent", "count 1");

  // Custody with the wrong digest must be refused, and refused with a decodable error.
  const stageScene = await read<string>("EvidenceChain", "STAGE_SCENE");
  const stageLab = await read<string>("EvidenceChain", "STAGE_FORENSIC_LAB");

  let refused = false;
  let refusalCode = "";
  try {
    await submit("EvidenceChain", "transferCustody", [evidenceId, stageScene, stageLab, tamperedHash]);
  } catch (error) {
    refused = true;
    refusalCode = error instanceof AppError ? error.code : "unknown";
  }
  check(refused, "transferCustody refuses a non-matching digest", refusalCode);
  check(refusalCode === "CHAIN_HASHMISMATCH", "the revert decodes to a readable error");

  const transferred = await submit("EvidenceChain", "transferCustody", [
    evidenceId,
    stageScene,
    stageLab,
    genuineHash,
  ]);
  check(
    eventArgs(transferred.receipt, "EvidenceChain", "CustodyTransferred") !== null,
    "transferCustody accepts the matching digest"
  );

  const custody = (await read<any[]>("EvidenceChain", "getChainOfCustody", [evidenceId])) as any[];
  check(custody.length === 2, "the custody trail has the genesis entry plus one hop");

  // ------------------------------------------------------- summons
  console.log("\nSummonsChain");

  const expiry = BigInt(Math.floor(Date.now() / 1000) + 72 * 3600);
  const documentHash = sha256Hex(`chaincheck-summons-${stamp}`);

  const issued = await submit("SummonsChain", "issueSummons", [
    caseId,
    accusedToken,
    documentHash,
    expiry,
  ]);
  const summonsArgs = eventArgs(issued.receipt, "SummonsChain", "SummonsIssued");
  const summonsId = summonsArgs?.summonsId ? Number(summonsArgs.summonsId) : null;
  check(summonsId !== null, "issueSummons emits SummonsIssued", `id ${summonsId}`);

  check(
    Number(await read<bigint>("SummonsChain", "getDeliveryStatus", [summonsId])) === 0,
    "a fresh summons reports PENDING"
  );

  const acknowledged = await submit("SummonsChain", "confirmDelivery", [
    summonsId,
    accusedToken,
    toMicroDegrees(LAT, "lat"),
    toMicroDegrees(LNG, "lng"),
    keccakOfString("chaincheck-device"),
  ]);
  check(
    eventArgs(acknowledged.receipt, "SummonsChain", "DeliveryConfirmed") !== null,
    "confirmDelivery emits DeliveryConfirmed"
  );
  check(
    Number(await read<bigint>("SummonsChain", "getDeliveryStatus", [summonsId])) === 1,
    "the summons now reports DELIVERED"
  );

  let wrongTokenRefused = false;
  try {
    await submit("SummonsChain", "confirmDelivery", [
      summonsId,
      keccakOfString("somebody-else"),
      toMicroDegrees(LAT, "lat"),
      toMicroDegrees(LNG, "lng"),
      keccakOfString("d"),
    ]);
  } catch {
    wrongTokenRefused = true;
  }
  check(wrongTokenRefused, "a second acknowledgement is refused");

  // ---------------------------------------------------------- bail
  console.log("\nBailChain");

  const conditions = [
    await read<string>("BailChain", "CONDITION_GEO_RESTRICTION"),
    await read<string>("BailChain", "CONDITION_PERIODIC_CHECKIN"),
    await read<string>("BailChain", "CONDITION_NO_CONTACT"),
  ];

  await submit("BailChain", "setBailConditions", [
    caseId,
    accusedToken,
    conditions,
    BigInt(Math.floor(Date.now() / 1000) + 90 * 86400),
  ]);
  await submit("BailChain", "configureMonitoring", [
    caseId,
    toMicroDegrees(LAT, "lat"),
    toMicroDegrees(LNG, "lng"),
    2000n,
    3600n,
  ]);
  check(true, "setBailConditions and configureMonitoring both accepted");

  // Inside the fence: 0.005 degrees north is about 556 m.
  const near = await submit("BailChain", "weeklyCheckIn", [
    caseId,
    accusedToken,
    toMicroDegrees(LAT + 0.005, "lat"),
    toMicroDegrees(LNG, "lng"),
  ]);
  const nearEvent = eventArgs(near.receipt, "BailChain", "CheckInRecorded");
  check(nearEvent?.withinFence === true, "a check-in inside the fence is compliant", `${nearEvent?.distanceMetres} m`);

  let [score] = (await read<[bigint, boolean[]]>("BailChain", "checkCompliance", [caseId])) as any;
  check(Number(score) === 100, "the compliance score is 100 after a clean check-in");

  // Outside the fence: 0.05 degrees north is about 5566 m.
  const far = await submit("BailChain", "weeklyCheckIn", [
    caseId,
    accusedToken,
    toMicroDegrees(LAT + 0.05, "lat"),
    toMicroDegrees(LNG, "lng"),
  ]);
  const farEvent = eventArgs(far.receipt, "BailChain", "CheckInRecorded");
  const violation = eventArgs(far.receipt, "BailChain", "ViolationDetected");
  check(farEvent?.withinFence === false, "a check-in outside the fence is flagged", `${farEvent?.distanceMetres} m`);
  check(
    violation?.reason === "GEO_FENCE_BREACH",
    "the contract emits ViolationDetected without being told",
    String(violation?.reason)
  );

  const [afterScore, flags] = (await read<[bigint, boolean[]]>("BailChain", "checkCompliance", [caseId])) as any;
  check(Number(afterScore) === 75, "the score drops by the geo-violation penalty", `score ${afterScore}`);
  check(
    Array.from(flags as boolean[])[0] === true,
    "the violation flag lands on the geo-restriction condition, by index"
  );

  // --------------------------------------------------------- result
  console.log("\n" + "=".repeat(64));
  if (failures === 0) {
    console.log("  All checks passed. The backend and the contracts agree.\n");
    process.exit(0);
  }
  console.log(`  ${failures} check(s) failed.\n`);
  process.exit(1);
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.stack : error}\n`);
  process.exit(1);
});
