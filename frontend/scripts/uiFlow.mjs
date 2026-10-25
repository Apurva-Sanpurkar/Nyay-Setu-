/**
 * Drives the real web app in headless Chrome through the core 2.0 flow, against
 * a running local stack (`npm run local` at the repository root):
 *
 *   register a case → capture a photo with the (fake) camera and an overridden GPS
 *   fix → register it → open its public Integrity Passport → check a wrong file
 *
 *   node scripts/uiFlow.mjs [--password=…] [--out=dir] [--mobile] [--lang=hi]
 *
 * Exits non-zero on the first step that fails, after saving a screenshot of it.
 * Chrome's --use-fake-device-for-media-stream supplies a moving test pattern as
 * the camera, which is exactly what a headless test needs and nothing more.
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");

const opt = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]));
const BASE = opt.base ?? "http://localhost:5173";
const PASSWORD = opt.password ?? process.env.DEV_SEED_PASSWORD ?? "LocalDemo-2026";
const OUT = opt.out ?? join(tmpdir(), "nyaysetu-ui-flow");
mkdirSync(OUT, { recursive: true });

const CHROME = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => p && existsSync(p));
if (!CHROME) throw new Error("No Chrome or Edge found. Set CHROME_PATH.");

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--no-first-run"],
});
const context = browser.defaultBrowserContext();
await context.overridePermissions(BASE, ["geolocation", "camera", "microphone"]);
const page = await browser.newPage();
await page.setViewport(opt.mobile ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { width: 1366, height: 900 });
await page.setGeolocation({ latitude: 18.5308225, longitude: 73.8474647, accuracy: 8 });
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

let step = 0;
async function shot(name) {
  step++;
  const file = join(OUT, `${String(step).padStart(2, "0")}-${name}${opt.mobile ? "-mobile" : ""}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function fail(message) {
  const file = await shot("FAILED");
  console.error(`FAIL: ${message}\n  screenshot: ${file}`);
  for (const p of problems) console.error("  " + p);
  await browser.close();
  process.exit(1);
}

/** Sets an input, textarea or select found by its visible label text, the way React expects. */
async function fill(label, value) {
  const ok = await page.evaluate(
    (label, value) => {
      const labels = [...document.querySelectorAll("label")];
      const match = labels.find((l) => l.textContent?.trim().startsWith(label));
      const field = match?.querySelector("input, textarea, select") ?? (match?.htmlFor ? document.getElementById(match.htmlFor) : null);
      if (!field) return false;
      const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(field, value);
      field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
      return true;
    },
    label,
    value
  );
  if (!ok) await fail(`no field labelled "${label}"`);
}

async function click(text) {
  const handle = await page.waitForFunction(
    (text) => [...document.querySelectorAll("button, a")].find((b) => b.textContent?.trim().toLowerCase().includes(text.toLowerCase()) && !b.disabled),
    { timeout: 20_000 },
    text
  ).catch(() => null);
  if (!handle) await fail(`no enabled button or link "${text}"`);
  await handle.asElement().click();
}

async function waitText(text, timeout = 60_000) {
  const found = await page
    .waitForFunction((text) => document.body.innerText.toLowerCase().includes(text.toLowerCase()), { timeout }, text)
    .catch(() => null);
  if (!found) {
    const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 1500));
    await fail(`text never appeared: "${text}"
  page text: ${body}`);
  }
}

// ------------------------------------------------------------------ sign in
await page.goto(`${BASE}/login`, { waitUntil: "networkidle0" });
await page.evaluate((lang) => {
  localStorage.setItem("nyaysetu.lang", lang || "en");
  localStorage.setItem("nyaysetu.theme", "light");
}, opt.lang);
const login = await page.evaluate(async (password) => {
  const r = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email: "police@nyaysetu.local", password }),
  });
  return r.status;
}, PASSWORD);
if (login !== 200) await fail(`sign-in returned ${login}; is the local stack running with this password?`);

// ------------------------------------------------------------- register case
await page.goto(`${BASE}/police/new-case`, { waitUntil: "networkidle0" });
await shot("new-case");
if (!opt.lang || opt.lang === "en") {
  await fill("Title", "Burglary at a warehouse, Shivajinagar");
  await fill("Offence type", "Burglary");
  await fill("FIR number", `${Math.floor(Math.random() * 9000) + 1000}/2026`);
  await click("Register case");
  await page.waitForFunction(() => /\/police\/cases\/[0-9a-f-]{36}$/.test(location.pathname), { timeout: 30_000 }).catch(() => fail("case was not created"));
  await waitText("NS/");
  await shot("case-dossier");
  const caseId = page.url().split("/").pop();

  // ------------------------------------------------------------- capture
  await page.goto(`${BASE}/police/capture`, { waitUntil: "networkidle0" });
  // The case selector specifically: the sidebar's language selector comes first in the DOM.
  await page.waitForSelector(`option[value="${caseId}"]`);
  await page.evaluate((caseId) => {
    const select = [...document.querySelectorAll("select")].find((s) => s.querySelector(`option[value="${caseId}"]`));
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, caseId);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, caseId);
  await click("Start camera");
  await page.waitForFunction(() => {
    const v = document.querySelector("video");
    return v && v.readyState >= 2 && v.videoWidth > 0;
  }, { timeout: 30_000 }).catch(() => fail("camera preview never started"));
  await shot("camera-preview");
  await click("Take photo");
  await waitText("Capture manifest fingerprint");
  await shot("photo-captured");
  await click("Register evidence");
  await waitText("Registered", 120_000);
  await shot("registered");

  const reference = await page.evaluate(() => document.body.innerText.match(/NSE-[0-9A-Z]{26}/)?.[0]);
  if (!reference) await fail("no public reference shown after registration");

  // --------------------------------------------------------- passport
  await page.goto(`${BASE}/verify/${reference}`, { waitUntil: "networkidle0" });
  await waitText("Evidence Integrity Passport");
  await shot("passport");

  const wrong = join(OUT, "not-the-evidence.bin");
  writeFileSync(wrong, Buffer.from("this is not the registered photograph"));
  const [chooser] = await Promise.all([page.waitForFileChooser(), click("Choose or drop a file")]);
  await chooser.accept([wrong]);
  await waitText("This file does not match");
  await shot("passport-mismatch");
  console.log(`ok: case ${caseId}, evidence ${reference}`);
}

if (problems.length) {
  for (const p of problems) console.error(p);
  await browser.close();
  process.exit(1);
}
console.log(`UI flow passed. Screenshots in ${OUT}`);
await browser.close();
