/**
 * Copies non-TypeScript runtime assets into dist/.
 *
 * tsc emits only what it compiles, so the inline email logo would be absent
 * from a production build and every message would go out without its mark. The
 * mailer degrades rather than crashing in that case, which means the problem
 * would be invisible until somebody looked at a real email.
 */
import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// assets  : the inline email logo
// reference: the BNS section reference the FIR form and the API validate against
// deployed : the synced contract deployment (scripts/deployment-sync.mjs)
for (const folder of ["assets", "reference", "deployed"]) {
  const from = join(root, "src", folder);
  const to = join(root, "dist", folder);

  if (!existsSync(from)) {
    console.log(`no src/${folder} to copy`);
    continue;
  }

  await mkdir(to, { recursive: true });
  await cp(from, to, { recursive: true });
  console.log(`copied ${from} -> ${to}`);
}
