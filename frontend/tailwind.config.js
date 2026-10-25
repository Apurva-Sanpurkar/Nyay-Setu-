/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["selector", '[data-theme="dark"]'],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      /**
       * Every colour is a CSS variable defined in src/styles/tokens.css, in
       * both a light and a dark set. That is what makes the theme switch a
       * single attribute on <html> rather than a `dark:` variant on every
       * element, and it is what lets the final palette be dropped in without
       * touching a component.
       */
      colors: {
        bg: "var(--bg)",
        "bg-elevated": "var(--bg-elevated)",
        surface: "var(--surface)",
        "surface-2": "var(--surface-2)",
        "surface-3": "var(--surface-3)",
        sidebar: "var(--sidebar)",
        border: "var(--border)",
        "border-strong": "var(--border-strong)",
        text: "var(--text)",
        muted: "var(--text-muted)",
        faint: "var(--text-faint)",
        primary: "var(--primary)",
        "primary-strong": "var(--primary-strong)",
        "primary-soft": "var(--primary-soft)",
        accent: "var(--accent)",
        success: "var(--success)",
        warning: "var(--warning)",
        danger: "var(--danger)",
        info: "var(--info)",
        "on-primary": "var(--on-primary)",
        /**
         * Tailwind cannot apply an opacity modifier to a colour that is a bare
         * CSS variable: `border-success/40` would emit invalid CSS. So every
         * tint a component needs exists as its own token, already carrying the
         * alpha. Nothing in this app writes `token/alpha`.
         */
        "success-soft": "var(--success-soft)",
        "warning-soft": "var(--warning-soft)",
        "danger-soft": "var(--danger-soft)",
        "info-soft": "var(--info-soft)",
        "primary-ring": "var(--primary-ring)",
        "primary-fill": "var(--primary-fill)",
        "accent-soft": "var(--accent-soft)",
        "accent-ring": "var(--accent-ring)",
        "accent-fill": "var(--accent-fill)",
        "accent-strong": "var(--accent-strong)",
        "on-accent": "var(--on-accent)",
        // The literal logo values, for chrome that must not drift.
        brand: "var(--brand-green)",
        "brand-orange": "var(--brand-orange)",
      },
      fontFamily: {
        // Per the brief: an elegant serif for display, a geometric sans for body.
        // Every stack falls back to Noto Sans Devanagari, so Hindi and Marathi
        // render in a face designed for them rather than a system substitute.
        display: ['"Playfair Display"', '"Noto Serif Devanagari"', "Georgia", "serif"],
        body: ["Montserrat", '"Noto Sans Devanagari"', "system-ui", "-apple-system", "sans-serif"],
        // Inter carries data, numerals and dense UI, where Montserrat is too wide.
        ui: ["Inter", '"Noto Sans Devanagari"', "system-ui", "-apple-system", "sans-serif"],
        jakarta: ['"Plus Jakarta Sans"', "Inter", '"Noto Sans Devanagari"', "sans-serif"],
        accent: ['"Instrument Serif"', "Georgia", "serif"],
        // Retro dot-matrix, for the stat glyphs on the landing page only.
        dot: ['"BubbledotICG-FinePos"', '"Geist Pixel Circle"', "monospace"],
        mono: ['"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "monospace"],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      borderRadius: {
        card: "18px",
        panel: "22px",
      },
      boxShadow: {
        nav: "0 4px 14px rgba(0, 0, 0, 0.16)",
        card: "0 1px 2px var(--shadow-soft), 0 12px 32px var(--shadow-deep)",
        lift: "0 18px 48px var(--shadow-deep)",
        glow: "0 0 0 1px var(--primary-ring), 0 0 24px var(--primary-glow)",
        "glow-strong": "0 0 0 1px var(--primary-ring), 0 0 40px var(--primary-glow)",
        inset: "inset 0 1px 1px rgba(255, 255, 255, 0.1)",
      },
      backgroundImage: {
        // Green into orange, the way the logo reads.
        "grad-primary": "var(--grad-brand)",
        "grad-brand": "var(--grad-brand)",
        "grad-surface": "linear-gradient(180deg, var(--surface) 0%, var(--surface-2) 100%)",
        "grad-hero": "var(--grad-hero)",
        "grad-sheen":
          "linear-gradient(110deg, transparent 20%, rgba(255,255,255,0.13) 45%, transparent 70%)",
      },
      keyframes: {
        reveal: {
          from: { opacity: "0", transform: "translateY(22px) scale(0.98)", filter: "blur(6px)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)", filter: "blur(0)" },
        },
        revealPulse: {
          "0%": { opacity: "0", transform: "translateY(22px) scale(0.98)", filter: "blur(6px)" },
          "70%": { opacity: "1", transform: "translateY(0) scale(1.03)", filter: "blur(0)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        slideDown: {
          from: { opacity: "0", transform: "translateY(-18px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        headlineFade: {
          from: { opacity: "0", transform: "translateY(14px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        overlayIn: { from: { opacity: "0" }, to: { opacity: "1" } },
        menuIn: {
          from: { opacity: "0", transform: "translateY(-12px) scale(0.98)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        pulseRing: {
          "0%": { boxShadow: "0 0 0 0 var(--primary-glow)" },
          "70%": { boxShadow: "0 0 0 14px transparent" },
          "100%": { boxShadow: "0 0 0 0 transparent" },
        },
        spinSlow: { to: { transform: "rotate(360deg)" } },
        // A light sweep across a surface on hover. Used sparingly, on the few
        // controls that commit something irreversible.
        sheen: {
          "0%": { transform: "translateX(-120%)" },
          "100%": { transform: "translateX(120%)" },
        },
        floatY: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-6px)" },
        },
        // The scroll cue under the hero.
        nudge: {
          "0%, 100%": { transform: "translateY(0)", opacity: "0.45" },
          "50%": { transform: "translateY(5px)", opacity: "1" },
        },
        countPop: {
          "0%": { transform: "scale(0.96)" },
          "60%": { transform: "scale(1.03)" },
          "100%": { transform: "scale(1)" },
        },
      },
      animation: {
        reveal: "reveal 0.85s cubic-bezier(0.22, 1, 0.36, 1) forwards",
        "reveal-pulse": "revealPulse 0.95s cubic-bezier(0.22, 1, 0.36, 1) forwards",
        "slide-down": "slideDown 0.7s cubic-bezier(0.22, 1, 0.36, 1) both",
        "headline-fade": "headlineFade 0.85s cubic-bezier(0.22, 1, 0.36, 1) both",
        "overlay-in": "overlayIn 0.28s ease both",
        "menu-in": "menuIn 0.38s cubic-bezier(0.22, 1, 0.36, 1) both",
        shimmer: "shimmer 1.6s infinite",
        "pulse-ring": "pulseRing 2s ease-out infinite",
        "spin-slow": "spinSlow 1.1s linear infinite",
        sheen: "sheen 0.9s cubic-bezier(0.22, 1, 0.36, 1)",
        "float-y": "floatY 5s ease-in-out infinite",
        nudge: "nudge 1.8s ease-in-out infinite",
        "count-pop": "countPop 0.5s cubic-bezier(0.22, 1, 0.36, 1)",
      },
      transitionTimingFunction: {
        smooth: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    },
  },
  plugins: [],
};
