/**
 * Visits every page in every portal, as each of the seven roles, against a
 * running local stack (`npm run local` at the repository root), and checks:
 *
 *   - the page renders without a JavaScript error,
 *   - no panel shows an error state (a failed API call the role should be allowed),
 *   - axe-core finds no serious or critical accessibility violation,
 *   - nothing overflows the viewport sideways at phone width (with --mobile).
 *
 *   node scripts/uiSmoke.mjs [--password=…] [--mobile] [--lang=hi] [--out=dir]
 *
 * Writes a summary (and a screenshot per page) to the output directory, and exits
 * non-zero if any page failed a check.
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const opt = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]));
const BASE = opt.base ?? "http://localhost:5173";
const PASSWORD = opt.password ?? process.env.DEV_SEED_PASSWORD ?? "LocalDemo-2026";
const OUT = opt.out ?? join(tmpdir(), "nyaysetu-ui-smoke");
mkdirSync(OUT, { recursive: true });

const CHROME = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => p && existsSync(p));
if (!CHROME) throw new Error("No Chrome or Edge found. Set CHROME_PATH.");

// The navigation table is the list of pages: read it, rather than keeping a copy.
const shell = readFileSync(fileURLToPath(new URL("../src/components/PortalShell.tsx", import.meta.url)), "utf8");
const ROLES = {
  police: "police",
  forensic_lab: "forensic",
  prosecutor: "prosecutor",
  judge: "judge",
  defence_lawyer: "defence",
  accused: "accused",
  court_admin: "admin",
};
const links = [...shell.matchAll(/\{\s*to:\s*"([^"]+)"/g)].map((m) => m[1]);
const PUBLIC = ["/", "/about", "/login", "/verify", "/handbook"];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--no-first-run"],
});

const viewport = opt.mobile ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { width: 1366, height: 900 };
const results = [];

async function check(page, path, label) {
  const errors = [];
  const onError = (e) => errors.push(`pageerror: ${e.message}`);
  page.on("pageerror", onError);
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle0", timeout: 60_000 });
    // Let lazy chunks and first queries settle.
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), { timeout: 15_000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    // Scroll through once so content revealed on scroll is rendered, then
    // checked by axe and captured in the screenshot.
    await page.evaluate(async () => {
      for (let y = 0; y < document.documentElement.scrollHeight; y += window.innerHeight / 2) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
    });
    // Long enough for staggered reveal animations to finish before contrast is checked.
    await new Promise((r) => setTimeout(r, 1600));

    const landed = new URL(page.url()).pathname;
    const state = await page.evaluate(() => ({
      errorPanels: [...document.querySelectorAll('[role="alert"]')]
        .map((el) => el.textContent?.trim() ?? "")
        .filter((text) => /could not|failed|error|went wrong/i.test(text))
        .slice(0, 3),
      notFound: /There is nothing at this address/.test(document.body.innerText),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    }));

    await page.evaluate(axeSource);
    const axe = await page.evaluate(async () => {
      // @ts-ignore injected above
      const out = await window.axe.run(document, { resultTypes: ["violations"], runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
      return out.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => `${v.id} (${v.impact}, ${v.nodes.length}×): ${v.nodes[0]?.target?.join(" ")}`);
    });

    const failures = [
      ...errors,
      ...(landed !== path ? [`redirected to ${landed}`] : []),
      ...(state.notFound ? ["404 page"] : []),
      ...state.errorPanels.map((t) => `error panel: ${t.slice(0, 160)}`),
      ...axe.map((a) => `axe: ${a}`),
      ...(opt.mobile && state.overflow > 1 ? [`horizontal overflow of ${state.overflow}px`] : []),
    ];
    const file = join(OUT, `${label}${path.replace(/\//g, "_") || "_root"}${opt.mobile ? "-mobile" : ""}.png`);
    await page.screenshot({ path: file, fullPage: true });
    results.push({ label, path, ok: failures.length === 0, failures });
    console.log(`${failures.length ? "FAIL" : "ok  "} ${label.padEnd(15)} ${path}${failures.length ? "\n       " + failures.join("\n       ") : ""}`);
  } finally {
    page.off("pageerror", onError);
  }
}

async function freshPage() {
  const context = await browser.createBrowserContext();
  await context.overridePermissions(BASE, ["geolocation", "camera", "microphone"]);
  const page = await context.newPage();
  await page.setViewport(viewport);
  await page.setGeolocation({ latitude: 18.5308225, longitude: 73.8474647, accuracy: 8 });
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle0" });
  await page.evaluate((lang) => {
    localStorage.setItem("nyaysetu.lang", lang || "en");
    localStorage.setItem("nyaysetu.theme", "light");
  }, opt.lang);
  return { context, page };
}

// ---------------------------------------------------------------- public pages
{
  const { context, page } = await freshPage();
  for (const path of PUBLIC) await check(page, path, "public");
  await context.close();
}

// ---------------------------------------------------------------- each portal
for (const [role, prefix] of Object.entries(ROLES)) {
  const { context, page } = await freshPage();
  const status = await page.evaluate(
    async (email, password) => {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
      return r.status;
    },
    `${role.replace("_", ".")}@nyaysetu.local`,
    PASSWORD
  );
  if (status !== 200) {
    results.push({ label: role, path: "(sign-in)", ok: false, failures: [`sign-in returned ${status}`] });
    console.log(`FAIL ${role} sign-in returned ${status}`);
    await context.close();
    continue;
  }
  for (const path of links.filter((l) => l === `/${prefix}` || l.startsWith(`/${prefix}/`))) await check(page, path, role);

  // The dossier and evidence pages are reached from lists, not the navigation:
  // open the first case and the first item the role can see.
  if (role !== "accused") {
    const target = await page.evaluate(async () => {
      const cases = await (await fetch("/api/cases", { credentials: "include" })).json();
      const first = cases.cases?.[0];
      if (!first) return null;
      const items = await (await fetch(`/api/evidence/case/${first.id}`, { credentials: "include" })).json();
      return { caseId: first.id, evidenceId: items.items?.[0]?.id ?? null };
    });
    if (target) {
      await check(page, `/${prefix}/cases/${target.caseId}`, role);
      if (target.evidenceId) await check(page, `/${prefix}/cases/evidence/${target.evidenceId}`, role);
    }
  }
  await context.close();
}

await browser.close();

const failed = results.filter((r) => !r.ok);
const summary = [
  `# UI smoke (${opt.mobile ? "phone, 390 px" : "desktop, 1366 px"}, ${opt.lang || "en"})`,
  "",
  `${results.length - failed.length} of ${results.length} pages passed.`,
  "",
  "| Role | Page | Result |",
  "|---|---|---|",
  ...results.map((r) => `| ${r.label} | \`${r.path}\` | ${r.ok ? "pass" : r.failures.join("<br>")} |`),
  "",
].join("\n");
writeFileSync(join(OUT, `summary${opt.mobile ? "-mobile" : ""}${opt.lang ? `-${opt.lang}` : ""}.md`), summary);
console.log(`\n${results.length - failed.length}/${results.length} pages passed. Summary and screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
