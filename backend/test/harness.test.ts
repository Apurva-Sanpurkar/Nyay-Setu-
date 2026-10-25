import { test, after } from "node:test";
import assert from "node:assert/strict";
import { call, makeActor, stopServer } from "./support/harness";

after(stopServer);

test("the harness drives the real app: session, RBAC and CSRF all apply", async () => {
  const police = makeActor("police");
  const me = await call(police, "GET", "/api/auth/me");
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(me.body.user.role, "police");

  assert.equal((await call(null, "GET", "/api/cases")).status, 401);

  const noCsrf = await call(police, "POST", "/api/cases", { body: {}, noCsrf: true });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.error.code, "CSRF_MISSING");

  const defence = makeActor("defence_lawyer");
  const refused = await call(defence, "POST", "/api/cases", { body: {} });
  assert.equal(refused.status, 403);
});
