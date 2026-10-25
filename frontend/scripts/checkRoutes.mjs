#!/usr/bin/env node
/**
 * Every link in the portal navigation must have a route. Reads the NAV table in
 * PortalShell and the routes declared in App.tsx (literal paths, the
 * WORKFLOW_PAGES table, and the three paths caseRoutes() generates per portal),
 * and fails the build if a navigation entry would land on the 404 page.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const shell = readFileSync(path.join(src, "components", "PortalShell.tsx"), "utf8");
const app = readFileSync(path.join(src, "App.tsx"), "utf8");

const links = [...shell.matchAll(/\{\s*to:\s*"([^"]+)"/g)].map((m) => m[1]);
const routes = new Set([
  ...[...app.matchAll(/path="([^"]+)"/g)].map((m) => m[1]),
  ...[...app.matchAll(/\{\s*path:\s*"([^"]+)"/g)].map((m) => m[1]),
]);
for (const m of app.matchAll(/caseRoutes\("([^"]+)"/g)) routes.add(`${m[1]}/cases`);

const missing = links.filter((link) => !routes.has(link));
if (links.length === 0) {
  console.error("checkRoutes: found no navigation links; has PortalShell's NAV table moved?");
  process.exit(1);
}
if (missing.length) {
  console.error(`checkRoutes: ${missing.length} navigation link(s) have no route:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}
console.log(`checkRoutes: all ${links.length} navigation links have routes.`);
