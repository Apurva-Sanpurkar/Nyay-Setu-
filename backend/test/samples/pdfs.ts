// Must stay first: switches every external service off before the app reads its config.
import "../support/env";
import { randomBytes, randomUUID } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { call, makeActor, mem, resetDatabase, stopServer } from "../support/harness";
import { FakeChain } from "../support/fakeChain";
import { captureEvidence, createCase, manifestFor, uploadEvidence } from "../support/evidence";
import { trackAnchors } from "../../src/services/verification/anchors";
import { DEFAULT_SECTION63 } from "../../src/services/certificate.service";
import { env } from "../../src/config/env";

/**
 * Writes one of every PDF NyaySetu produces, from realistic sample data, so the
 * layouts can be reviewed by eye:
 *
 *   npm run samples:pdf [-- --out=<dir>]
 *
 * In-memory database and simulated chain only; nothing external is touched.
 */
async function main() {
  const outArg = process.argv.find((a) => a.startsWith("--out="));
  const out = outArg ? outArg.slice(6) : path.resolve(__dirname, "..", "..", "..", "docs", "samples");
  mkdirSync(out, { recursive: true });

  const fake = new FakeChain().install();
  (env as any).confirmationDepth = 1;
  resetDatabase();
  mem.table("document_templates").push({ id: randomUUID(), ...DEFAULT_SECTION63 });

  const police = makeActor("police", { name: "Inspector Asha Kulkarni" });
  mem.table("users").find((u) => u.id === police.id)!.designation = "Police Inspector";
  const kase = await createCase(police, {
    title: "Burglary at a hardware warehouse, Shivajinagar",
    fir: { number: "245", year: 2026 },
    origin: "fir",
  });

  const bytes = randomBytes(48_000);
  const captured = await captureEvidence(police, kase.id, manifestFor(police, kase.case_reference, bytes), bytes);
  const evidenceId = captured.body.evidence.id as string;
  const extra: string[] = [];
  for (let i = 0; i < 2; i++) extra.push((await uploadEvidence(police, kase.id)).response.body.evidence.id);
  fake.mine(3);
  await trackAnchors();

  const save = (name: string, raw: ArrayBuffer, status: number) => {
    if (status !== 200) throw new Error(`${name}: HTTP ${status} ${Buffer.from(raw).toString("utf8").slice(0, 300)}`);
    writeFileSync(path.join(out, name), Buffer.from(raw));
    console.log(`  ${name}`);
  };

  const seizure = await call(police, "POST", "/api/police/seizures", {
    body: {
      caseId: kase.id,
      memoNumber: "SZ-17/2026",
      seizedAt: new Date().toISOString(),
      place: "Ground-floor storeroom, Laxmi Hardware, Shivajinagar, Pune",
      seizedFrom: "Mr. Arun Gaikwad (store manager)",
      witnesses: [
        { name: "Sunil Pawar", address: "Flat 2, Laxmi Building, Shivajinagar" },
        { name: "Meena Kale", address: "14 FC Road, Pune" },
      ],
      notes: "Items photographed in place, bagged, sealed with seal No. SPS-0917 and signed by both witnesses.",
      items: [
        { evidenceId, label: "Photograph of forced shutter lock", description: "Rear shutter, lock cut" },
        { evidenceId: extra[0], label: "CCTV export, camera 2", description: "21:40–23:10 on the night" },
        { evidenceId: extra[1], label: "Mobile phone", description: "Black, cracked screen" },
      ],
    },
  });
  if (seizure.status !== 201) throw new Error(`seizure: ${JSON.stringify(seizure.body)}`);
  await call(police, "POST", `/api/police/evidence/${evidenceId}/malkhana`, {
    body: { movement: "IN", location: "Malkhana, Shivajinagar PS", shelf: "R2-S4", reason: "Deposited after seizure" },
  });

  console.log(`Writing sample PDFs to ${out}`);
  const memo = await call(police, "GET", `/api/police/seizures/${seizure.body.seizure.id}/memo.pdf`);
  save("seizure-memo.pdf", memo.raw, memo.status);
  const custody = await call(police, "GET", `/api/police/evidence/${evidenceId}/custody-form.pdf`);
  save("custody-form.pdf", custody.raw, custody.status);
  const cert = await call(police, "POST", `/api/evidence/${evidenceId}/certificate`, {
    body: { deviceDescription: "Android smartphone used by the investigating officer, NyaySetu field app 2.0.0" },
  });
  save("section63-certificate.pdf", cert.raw, cert.status);
  const passport = await call(police, "GET", `/api/evidence/${evidenceId}/passport.pdf`);
  save("passport-authorised.pdf", passport.raw, passport.status);
  const publicPassport = await call(null, "GET", `/api/public/verify/${captured.body.evidence.public_ref}/passport.pdf`);
  save("passport-public.pdf", publicPassport.raw, publicPassport.status);
  const report = await call(police, "GET", `/api/reports/cases/${kase.id}/final-report.pdf`);
  save("case-final-report.pdf", report.raw, report.status);

  fake.uninstall();
  await stopServer();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
