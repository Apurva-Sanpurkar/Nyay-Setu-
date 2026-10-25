#!/usr/bin/env node
/**
 * Fails the build if the shipped bundle contains anything that looks like a
 * secret. Everything in dist/ is downloaded by every visitor, so a service key
 * or a wallet key that slipped in through an environment variable would be
 * public the moment it was deployed.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist", import.meta.url));

const PATTERNS = [
  { name: "JSON Web Token (e.g. a Supabase service key)", re: /eyJhbGciOi[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "Supabase service-role reference", re: /service_role/i },
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "bare 32-byte hex (possible wallet private key)", re: /(?<![0-9a-fA-Fx])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/ },
  { name: "server-only variable name", re: /\b(DEPLOYER_PRIVATE_KEY|CHAIN_PRIVATE_KEY|SUPABASE_SERVICE_ROLE_KEY|PINATA_JWT|PINATA_API_SECRET|SMTP_PASS|AI_SERVICE_KEY|SESSION_SECRET|ETHERSCAN_API_KEY)\b/ },
  { name: "provider API key", re: /\b(sk-[A-Za-z0-9]{20,}|re_[A-Za-z0-9]{20,}|xkeysib-[A-Za-z0-9-]{20,})\b/ },
];

/** Illustrative SHA-256 digests printed in the handbook's worked example. Public by design. */
const ALLOWED = new Set([
  "0x4d80b1f3c95e26a7048fd3b19c6e5720af83d641e0b2975ca3f8d0e461b5c29a",
  "0x9f2a4c81e07b3d6a5f18c2be49d70a3ec815b26f4a0d938172ce5b4f60a9d7e3",
]);

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(js|css|html|json|map|txt|svg)$/.test(name)) yield path;
  }
}

let found = 0;
let scanned = 0;
for (const file of files(dist)) {
  scanned++;
  const text = readFileSync(file, "utf8");
  for (const { name, re } of PATTERNS) {
    const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    const match = [...text.matchAll(global)].find((m) => !ALLOWED.has(m[0].toLowerCase()));
    if (match) {
      found++;
      const at = match.index ?? 0;
      console.error(`checkBundleSecrets: ${name} in ${relative(dist, file)}: …${text.slice(Math.max(0, at - 30), at + 20).replace(/\s+/g, " ")}…`);
    }
  }
}
if (found) {
  console.error(`checkBundleSecrets: ${found} finding(s). Nothing in the frontend bundle may be secret.`);
  process.exit(1);
}
console.log(`checkBundleSecrets: ${scanned} files scanned, nothing that looks like a secret.`);
