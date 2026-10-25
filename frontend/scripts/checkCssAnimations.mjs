/**
 * Fails the build if the stylesheet names an animation it never defines.
 *
 * WHY THIS EXISTS
 * ---------------
 * Tailwind emits a @keyframes block only when the matching `animate-*` utility
 * appears in scanned markup. Hand-written CSS that says `animation: reveal ...`
 * is invisible to that scanner, so the keyframes were silently dropped from the
 * bundle.
 *
 * The result was not a warning or a broken animation. `.anim` declared
 * `opacity: 0` and animated to a definition that did not exist, so every
 * element wrapped in <Reveal> stayed at zero opacity forever. The landing page
 * and the entire sign-in form rendered blank, with no console error and a build
 * that reported success.
 *
 * A missing @keyframes should never again be something you discover by looking
 * at the page.
 */
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const assets = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "assets");

if (!existsSync(assets)) {
  console.error("checkCssAnimations: no dist/assets. Run the build first.");
  process.exit(1);
}

const files = (await readdir(assets)).filter((name) => name.endsWith(".css"));
if (files.length === 0) {
  console.error("checkCssAnimations: no CSS emitted, which is itself suspicious.");
  process.exit(1);
}

let failed = false;

for (const file of files) {
  const css = await readFile(join(assets, file), "utf8");

  const defined = new Set(
    [...css.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)].map((match) => match[1])
  );

  // `animation` shorthand and `animation-name`, minified or not. The name is
  // whichever token is not a time, a timing function, or a keyword.
  const KEYWORDS = new Set([
    "none", "infinite", "normal", "reverse", "alternate", "alternate-reverse",
    "forwards", "backwards", "both", "running", "paused", "linear", "ease",
    "ease-in", "ease-out", "ease-in-out", "step-start", "step-end", "initial",
    "inherit", "unset", "revert",
  ]);

  const used = new Set();

  for (const match of css.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)) {
    // Split on commas for multiple animations, then on whitespace.
    for (const part of match[1].split(",")) {
      for (const token of part.trim().split(/\s+/)) {
        const name = token.trim();
        if (!name) continue;
        if (KEYWORDS.has(name)) continue;
        if (/^[\d.]/.test(name)) continue;                 // 0.85s, 300ms
        if (/^(cubic-bezier|steps|var|calc)\(/.test(name)) continue;
        if (name.startsWith("(") || name.endsWith(")")) continue;
        if (!/^[A-Za-z_-][A-Za-z0-9_-]*$/.test(name)) continue;
        used.add(name);
      }
    }
  }

  const missing = [...used].filter((name) => !defined.has(name));

  if (missing.length > 0) {
    failed = true;
    console.error(`\n  ${file}`);
    console.error(`    referenced but never defined: ${missing.join(", ")}`);
    console.error("    Anything named from hand-written CSS must declare its own");
    console.error("    @keyframes in src/styles/index.css. Tailwind will not emit");
    console.error("    keyframes for an animation it cannot see being used.\n");
  } else {
    console.log(
      `  ${file}: ${used.size} animation(s) referenced, all ${defined.size} definitions present`
    );
  }
}

if (failed) {
  console.error("checkCssAnimations: FAILED\n");
  process.exit(1);
}

console.log("checkCssAnimations: ok");
