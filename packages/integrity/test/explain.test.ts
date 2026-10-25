import { test } from "node:test";
import assert from "node:assert/strict";
import { LANGS, boundary, explainAssistance, explainCheckIn, explainEvidence, explainSummons, type VerificationState } from "../src";

const STATES: VerificationState[] = ["LOCAL_ONLY", "SUBMITTED", "CONFIRMED", "INTEGRITY_MISMATCH", "SYNC_ERROR", "REVIEW_REQUIRED"];

test("every evidence state has text in every language, and the same state always explains the same way", () => {
  for (const lang of LANGS) {
    for (const state of STATES) {
      const a = explainEvidence(state, lang);
      assert.ok(a.title && a.body, `${state}/${lang}`);
      assert.deepEqual(explainEvidence(state, lang), a);
    }
  }
});

test("only CONFIRMED reads as ok; nothing pending is presented as verified", () => {
  for (const state of STATES) {
    const tone = explainEvidence(state, "en").tone;
    assert.equal(tone === "ok", state === "CONFIRMED", state);
  }
  assert.match(explainEvidence("LOCAL_ONLY", "en").body, /not verified/);
  assert.match(explainEvidence("CONFIRMED", "en").body, /does not prove/);
});

test("Hindi and Marathi copy is actually Devanagari, not English left behind", () => {
  for (const lang of ["hi", "mr"] as const) {
    for (const text of [explainEvidence("CONFIRMED", lang).body, boundary(lang), explainAssistance(lang).body]) {
      assert.match(text, /[\u0900-\u097F]/, lang);
    }
  }
});

test("summons and check-in explanations fill in the numbers and stay within process", () => {
  assert.match(explainSummons({ status: "PENDING", hoursRemaining: 30.7 }, "en").body, /30 hours/);
  assert.match(explainSummons({ status: "PENDING", hoursRemaining: 30.7 }, "hi").body, /30 घंटे/);
  assert.equal(explainSummons({ status: "PENDING", hoursRemaining: 5 }, "en").tone, "attention");
  assert.match(explainCheckIn({ state: "OVERDUE" }, "en").body, /not treated as a violation automatically/);
  for (const lang of LANGS) assert.ok(boundary(lang).length > 20);
  assert.match(boundary("en"), /not legal advice/);
});
