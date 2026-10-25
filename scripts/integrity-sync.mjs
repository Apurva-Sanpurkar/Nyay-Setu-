/**
 * Mirrors packages/integrity/src into backend/src/shared/integrity.
 *
 *   node scripts/integrity-sync.mjs           copy (run after editing the package)
 *   node scripts/integrity-sync.mjs --check   fail if the mirror differs by a byte
 *
 * Why a mirror at all: the API is built in a Docker context that contains only
 * backend/, so it cannot import ../packages. The web and mobile apps import the
 * package directly. See docs/DECISIONS.md D-07.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "packages", "integrity", "src");
const target = join(root, "backend", "src", "shared", "integrity");
const check = process.argv.includes("--check");

const files = readdirSync(source).filter((name) => name.endsWith(".ts"));
const problems = [];

if (!check) mkdirSync(target, { recursive: true });

for (const name of files) {
  const from = readFileSync(join(source, name));
  const to = join(target, name);
  if (check) {
    if (!existsSync(to)) problems.push(`missing: backend/src/shared/integrity/${name}`);
    else if (!from.equals(readFileSync(to))) problems.push(`differs: backend/src/shared/integrity/${name}`);
  } else {
    writeFileSync(to, from);
  }
}

// Files in the mirror that no longer exist in the package.
if (existsSync(target)) {
  for (const name of readdirSync(target).filter((n) => n.endsWith(".ts"))) {
    if (!files.includes(name)) {
      if (check) problems.push(`stale: backend/src/shared/integrity/${name}`);
      else rmSync(join(target, name));
    }
  }
}

if (check) {
  if (problems.length) {
    console.error("The backend's copy of @nyaysetu/integrity has drifted:\n  " + problems.join("\n  "));
    console.error("Run: npm run integrity:sync");
    process.exit(1);
  }
  console.log(`integrity mirror ok (${files.length} files identical)`);
} else {
  console.log(`mirrored ${files.length} files into backend/src/shared/integrity`);
}
