// Must run in its own process: the public limiter reads its ceiling at import,
// and the setting must load before the harness (imports are hoisted).
import "./support/strictPublicLimit";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { call, stopServer } from "./support/harness";

after(stopServer);

test("the public verification routes are rate limited per address", async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 8; i++) {
    statuses.push((await call(null, "GET", "/api/public/verify/NSE-00000000000000000000000000")).status);
  }
  assert.deepEqual(statuses.slice(0, 5), [404, 404, 404, 404, 404]);
  assert.ok(statuses.slice(5).every((s) => s === 429), `expected 429s, got ${statuses}`);
});
