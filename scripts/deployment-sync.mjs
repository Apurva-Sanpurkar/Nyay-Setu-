#!/usr/bin/env node
/**
 * Mirrors contracts/deployed/sepolia.json into backend/src/deployed/sepolia.json.
 *
 *   node scripts/deployment-sync.mjs           copy (run after a redeploy)
 *   node scripts/deployment-sync.mjs --check   fail if the mirror differs
 *
 * Why: when the API runs as a Vercel function (or in a container built from
 * backend/ alone), ../contracts is not part of the bundle. The API looks in
 * backend's own src/deployed (and dist/deployed after a build) as well.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "contracts", "deployed", "sepolia.json");
const targetDir = join(root, "backend", "src", "deployed");
const target = join(targetDir, "sepolia.json");

const wanted = readFileSync(source, "utf8").replace(/\r\n/g, "\n");
if (process.argv.includes("--check")) {
  const current = existsSync(target) ? readFileSync(target, "utf8").replace(/\r\n/g, "\n") : "";
  if (current !== wanted) {
    console.error("backend/src/deployed/sepolia.json is out of date. Run: node scripts/deployment-sync.mjs");
    process.exit(1);
  }
  console.log("backend/src/deployed/sepolia.json matches contracts/deployed/sepolia.json.");
} else {
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(target, wanted);
  console.log("Copied the Sepolia deployment into backend/src/deployed/.");
}
