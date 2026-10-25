// Must stay first: switches every external service off before the app reads its config.
import "./support/env";
import { test, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { ROLES, assign, call, makeActor, resetDatabase, stopServer, type Actor } from "./support/harness";
import { FakeChain } from "./support/fakeChain";
import { randomBytes } from "crypto";
import { captureEvidence, createCase, manifestFor } from "./support/evidence";
import type { UserRole } from "../src/middleware/auth";

/**
 * The authorization matrix (2.0 · F8).
 *
 * Routes are read from the running Express app rather than listed by hand, so a
 * route added later is covered without anyone remembering to add it here:
 *
 *   1. anonymous callers get nothing from any non-public route, and nothing 5xx;
 *   2. a signed-in user of every role, NOT assigned to a case, gets no case data
 *      from any route that names that case or one of its items;
 *   3. writes refuse without the CSRF header;
 *   4. role-restricted writes refuse every role outside their list.
 */

after(stopServer);

interface RouteInfo {
  method: string;
  path: string;
}

/** Every method + full path registered on the app (Express 4 router stack). */
function listRoutes(): RouteInfo[] {
  const out: RouteInfo[] = [];
  const prefixOf = (layer: any): string => {
    const source: string = layer.regexp?.source ?? "";
    // "^\/api\/cases\/?(?=\/|$)" -> "/api/cases"
    return source
      .replace(/^\^/, "")
      .replace(/\\\/\?\(\?=\\\/\|\$\)$/, "")
      .replace(/\\\//g, "/")
      .replace(/\$$/, "");
  };
  const walk = (stack: any[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          const full = prefix + layer.route.path;
          out.push({ method: method.toUpperCase(), path: full.length > 1 ? full.replace(/\/$/, "") : full });
        }
      } else if (layer.name === "router" && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + prefixOf(layer));
      }
    }
  };
  walk((app as any)._router.stack, "");
  return out;
}

const PUBLIC_PREFIXES = ["/api/health", "/api/public", "/api/auth", "/api/reference"];
const isPublic = (path: string) => path === "/" || PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p + "/"));

let fake: FakeChain;
let police: Actor;
let kase: { id: string; case_reference: string };
let evidenceId: string;

beforeEach(async () => {
  resetDatabase();
  fake = new FakeChain().install();
  police = makeActor("police");
  kase = await createCase(police);
  const bytes = randomBytes(2048);
  const captured = await captureEvidence(police, kase.id, manifestFor(police, kase.case_reference, bytes), bytes);
  assert.equal(captured.status, 201, JSON.stringify(captured.body));
  evidenceId = captured.body.evidence.id;
});
afterEach(() => fake.uninstall());

/** Fills route parameters with ids of the seeded case and its item. */
function concrete(path: string): string {
  return path
    .replace(/:caseId\b/g, kase.id)
    .replace(/:evidenceId\b/g, evidenceId)
    .replace(/:ref\b/g, "NSE-00000000000000000000000000")
    .replace(/:key\b/g, "section63_certificate")
    .replace(/\/cases\/:id\b/g, `/cases/${kase.id}`)
    .replace(/:id\b/g, evidenceId)
    .replace(/:[a-zA-Z]+\b/g, randomUUID());
}

test("the route table was read, and is large enough to be the real one", () => {
  const routes = listRoutes();
  assert.ok(routes.length > 80, `only ${routes.length} routes found; is the router walk broken?`);
  assert.ok(routes.some((r) => r.path === "/api/cases" && r.method === "GET"));
  assert.ok(routes.some((r) => r.path === "/api/governance/approvals/:id/decide"));
});

test("anonymous callers get nothing from any non-public route, and no route fails with 5xx", async () => {
  const failures: string[] = [];
  for (const route of listRoutes()) {
    if (isPublic(route.path)) continue;
    const res = await call(null, route.method, concrete(route.path), route.method === "GET" ? {} : { body: {} });
    if (res.status < 400 || res.status >= 500) failures.push(`${route.method} ${route.path} -> ${res.status}`);
  }
  assert.deepEqual(failures, []);
});

test("writes refuse without the CSRF header, before doing anything", async () => {
  const before = (await call(police, "GET", `/api/evidence/case/${kase.id}`)).body.items.length;
  const res = await call(police, "POST", "/api/cases", { body: { title: "Should not exist", origin: "complaint" }, noCsrf: true });
  assert.equal(res.status, 403);
  const listed = await call(police, "GET", "/api/cases");
  assert.equal(listed.body.cases.length, 1);
  assert.equal((await call(police, "GET", `/api/evidence/case/${kase.id}`)).body.items.length, before);
});

test("no role, unassigned to a case, can read that case or its items through any route", async () => {
  const caseRoutes = listRoutes().filter(
    (r) => r.method === "GET" && !isPublic(r.path) && /:(caseId|evidenceId)\b|\/cases\/:id\b|\/evidence\/:id\b/.test(r.path)
  );
  assert.ok(caseRoutes.length > 15, `only ${caseRoutes.length} case-scoped routes found`);

  // Positive control: the same substitution, for the officer who owns the case,
  // does return the case. Without this a broken substitution would pass silently.
  let visible = 0;
  for (const route of caseRoutes) {
    const res = await call(police, "GET", concrete(route.path));
    if (res.status === 200) visible++;
  }
  assert.ok(visible >= caseRoutes.length - 3, `the owner was served on only ${visible} of ${caseRoutes.length} routes; parameter substitution is likely wrong`);

  const leaks: string[] = [];
  for (const role of ROLES) {
    if (role === "court_admin") continue; // the registry sees every case by design
    const outsider = makeActor(role as UserRole);
    for (const route of caseRoutes) {
      const res = await call(outsider, "GET", concrete(route.path));
      if (res.status >= 500) leaks.push(`${role} ${route.path} -> ${res.status}`);
      else if (res.status < 400) {
        // A 200 is acceptable only if it names nothing from the case.
        const text = Buffer.from(res.raw).toString("utf8");
        if (text.includes(kase.id) || text.includes(evidenceId) || text.includes(kase.case_reference)) {
          leaks.push(`${role} ${route.path} -> ${res.status} and returned case data`);
        }
      }
    }
  }
  assert.deepEqual(leaks, []);
});

/** Writes whose role list is part of the design; each is refused for everyone else. */
const RESTRICTED: { method: string; path: string; allowed: UserRole[]; body: () => unknown }[] = [
  { method: "POST", path: "/api/cases", allowed: ["police", "court_admin"], body: () => ({ title: "x", origin: "complaint" }) },
  { method: "POST", path: "/api/police/seizures", allowed: ["police"], body: () => ({ caseId: kase.id }) },
  { method: "POST", path: `/api/police/evidence/${"EVID"}/malkhana`, allowed: ["police"], body: () => ({}) },
  { method: "POST", path: `/api/lab/evidence/${"EVID"}/intake`, allowed: ["forensic_lab"], body: () => ({}) },
  { method: "POST", path: `/api/lab/evidence/${"EVID"}/reports`, allowed: ["forensic_lab"], body: () => ({}) },
  { method: "POST", path: "/api/governance/approvals/ID/decide", allowed: ["judge", "court_admin"], body: () => ({}) },
  { method: "POST", path: "/api/governance/holds", allowed: ["judge", "prosecutor", "court_admin"], body: () => ({}) },
  { method: "POST", path: "/api/court/access-requests", allowed: ["defence_lawyer"], body: () => ({}) },
  { method: "POST", path: "/api/court/access-requests/ID/decide", allowed: ["judge", "court_admin"], body: () => ({}) },
  { method: "POST", path: `/api/court/cases/${"CASE"}/events`, allowed: ["judge", "court_admin"], body: () => ({}) },
  { method: "POST", path: "/api/court/objections/ID/rule", allowed: ["judge", "court_admin"], body: () => ({}) },
  { method: "POST", path: "/api/court/bail/ID/explanations", allowed: ["accused"], body: () => ({}) },
  { method: "PUT", path: "/api/templates/section63_certificate", allowed: ["court_admin"], body: () => ({}) },
];

test("role-restricted writes refuse every role outside their list", async () => {
  const wrong: string[] = [];
  for (const rule of RESTRICTED) {
    for (const role of ROLES) {
      if (rule.allowed.includes(role as UserRole)) continue;
      const actor = makeActor(role as UserRole);
      assign(actor, kase.id, "write");
      const path = rule.path.replace("EVID", evidenceId).replace("CASE", kase.id).replace("ID", randomUUID());
      const res = await call(actor, rule.method, path, { body: rule.body() });
      if (res.status !== 403) wrong.push(`${role} ${rule.method} ${rule.path} -> ${res.status}`);
    }
  }
  assert.deepEqual(wrong, []);
});
