/**
 * Fails the build if any text/background pair in tokens.css drops below WCAG
 * 2.2 AA (4.5:1 for text), in either theme.
 *
 *   node scripts/checkContrast.mjs           check, exit 1 on failure
 *   node scripts/checkContrast.mjs --report  also print every ratio
 *
 * Reads the CSS itself rather than a copy of the values, so a palette change and
 * its check cannot drift apart. Translucent "soft" tints are composited over the
 * surface they sit on before measuring, because that is what the eye sees.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "styles", "tokens.css"), "utf8");
const report = process.argv.includes("--report");

function block(selectorStart) {
  const start = css.indexOf(selectorStart);
  if (start === -1) throw new Error(`No block for ${selectorStart}`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}") depth--;
    if (depth === 0) return css.slice(open + 1, i);
  }
  throw new Error("unbalanced");
}

function vars(text) {
  const out = {};
  for (const match of text.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[match[1]] = match[2].trim();
  return out;
}

function parse(color) {
  const hexMatch = /^#([0-9a-f]{6})$/i.exec(color);
  if (hexMatch) return { rgb: hexMatch[1].match(/../g).map((x) => parseInt(x, 16)), a: 1 };
  const rgba = /^rgba?\(([^)]+)\)$/.exec(color);
  if (rgba) {
    const [r, g, b, a = "1"] = rgba[1].split(",").map((s) => s.trim());
    return { rgb: [Number(r), Number(g), Number(b)], a: Number(a) };
  }
  return null;
}

const over = (top, bottom) => top.rgb.map((c, i) => c * top.a + bottom.rgb[i] * (1 - top.a));
const lum = (rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const themes = {
  light: vars(block(':root,\n:root[data-theme="light"]')),
  dark: vars(block(':root[data-theme="dark"]')),
};

const TEXT = ["text", "text-muted", "text-faint", "primary", "accent", "success", "warning", "danger", "info"];
const SURFACES = ["bg", "surface", "surface-2"];
const FILLS = [
  ["on-primary", "primary-fill"],
  ["on-accent", "accent-fill"],
];
// Coloured text on its own soft tint: every status chip.
const CHIPS = [
  ["primary", "primary-soft"],
  ["accent", "accent-soft"],
  ["success", "success-soft"],
  ["warning", "warning-soft"],
  ["danger", "danger-soft"],
  ["info", "info-soft"],
];

let failures = 0;
const line = (theme, label, value) => {
  const ok = value >= 4.5;
  if (!ok) failures++;
  if (report || !ok) console.log(`${ok ? "  ok  " : "  FAIL"} ${theme.padEnd(5)} ${label.padEnd(36)} ${value.toFixed(2)}:1`);
};

for (const [theme, t] of Object.entries(themes)) {
  for (const surfaceName of SURFACES) {
    const surface = parse(t[surfaceName]);
    for (const textName of TEXT) {
      line(theme, `${textName} on ${surfaceName}`, ratio(parse(t[textName]).rgb, surface.rgb));
    }
  }
  for (const [fg, bg] of FILLS) line(theme, `${fg} on ${bg}`, ratio(parse(t[fg]).rgb, parse(t[bg]).rgb));
  for (const [fg, tint] of CHIPS) {
    for (const surfaceName of ["surface", "surface-2"]) {
      const base = parse(t[surfaceName]);
      const composite = over(parse(t[tint]), base);
      line(theme, `${fg} on ${tint} (over ${surfaceName})`, ratio(parse(t[fg]).rgb, composite));
    }
  }
}

if (failures) {
  console.error(`\ncheckContrast: ${failures} pair(s) below WCAG AA 4.5:1.`);
  process.exit(1);
}
console.log("checkContrast: every text pair meets WCAG AA (4.5:1) in both themes");
