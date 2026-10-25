import { Link } from "react-router-dom";

/**
 * The NyaySetu mark.
 *
 * The logo's white strokes are NEGATIVE SPACE, not white pixels: they are
 * transparent in the source file. Put it straight onto the dark canvas and the
 * "N" dissolves, because the shapes that define it are holes.
 *
 * So the mark always sits on an opaque white plate. That is what this component
 * exists to guarantee — every placement in the app goes through it, rather than
 * each screen remembering to add a background of its own.
 */

type Shape = "circle" | "squircle";

export function LogoMark({
  size = 36,
  shape = "squircle",
  className = "",
  glow = false,
}: {
  size?: number;
  shape?: Shape;
  className?: string;
  /** A soft brand halo. For the landing page and sign-in, not for dense UI. */
  glow?: boolean;
}) {
  return (
    <span
      className={`relative inline-grid shrink-0 place-items-center overflow-hidden bg-white ${
        shape === "circle" ? "rounded-full" : "rounded-[28%]"
      } ${className}`}
      style={{
        width: size,
        height: size,
        // A hairline keeps the white plate from bleeding into a light surface.
        boxShadow: glow
          ? "0 0 0 1px rgba(0,146,69,0.25), 0 0 26px rgba(0,146,69,0.30), 0 0 48px rgba(255,117,31,0.14)"
          : "0 0 0 1px rgba(0,0,0,0.06)",
      }}
    >
      <img
        src="/logo.png"
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        // 74% leaves the mark room to breathe inside the plate at every size.
        style={{ width: "74%", height: "74%", objectFit: "contain" }}
        draggable={false}
      />
    </span>
  );
}

/**
 * Mark plus wordmark, as a link. Used in headers.
 *
 * `alt` on the image is empty and the text carries the accessible name, so a
 * screen reader announces "NyaySetu" once rather than describing a logo twice.
 */
export function LogoLock({
  to = "/",
  size = 38,
  subtitle,
  className = "",
  compact = false,
}: {
  to?: string;
  size?: number;
  subtitle?: string;
  className?: string;
  /** Hides the wordmark below the sm breakpoint. */
  compact?: boolean;
}) {
  return (
    <Link
      to={to}
      className={`group flex shrink-0 items-center gap-2.5 ${className}`}
      aria-label="NyaySetu home"
    >
      <LogoMark
        size={size}
        className="transition-transform duration-300 ease-smooth group-hover:scale-105 group-hover:rotate-[-3deg]"
      />
      <span className={compact ? "hidden sm:block" : "block"}>
        <span className="block font-display text-base leading-none text-text">NyaySetu</span>
        <span className="block font-ui text-2xs leading-tight text-faint">
          {subtitle ?? "न्यायसेतु"}
        </span>
      </span>
    </Link>
  );
}

/**
 * A wordmark with the brand gradient running through it.
 *
 * Gradient text is invisible if background-clip fails, so the colour is set as
 * a fallback first and only then overridden. Belt and braces for a name that
 * must never disappear.
 */
export function BrandWord({ className = "" }: { className?: string }) {
  return (
    <span
      className={`bg-grad-brand bg-clip-text text-transparent ${className}`}
      style={{ color: "var(--primary)" }}
    >
      NyaySetu
    </span>
  );
}
