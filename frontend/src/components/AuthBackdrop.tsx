/**
 * The light background behind the sign-in and first-run screens: the page
 * colour with two soft brand washes and a faint grid. Decorative only, and
 * built from theme tokens so it follows the light or dark theme.
 */
export function AuthBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -left-40 -top-40 h-[34rem] w-[34rem] rounded-full bg-primary-soft blur-3xl" />
      <div className="absolute -bottom-48 -right-32 h-[30rem] w-[30rem] rounded-full bg-accent-soft blur-3xl" />
      <div
        className="absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage: "linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(ellipse at center, black 30%, transparent 75%)",
          WebkitMaskImage: "radial-gradient(ellipse at center, black 30%, transparent 75%)",
        }}
      />
    </div>
  );
}
