import { Link } from "react-router-dom";
import { LogIn } from "lucide-react";
import { LogoMark } from "./Logo";
import { DisplayControls } from "./PortalShell";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../i18n";
import { ROLE_HOME } from "../lib/format";

/**
 * Chrome for pages anyone may open without signing in: the Integrity Passport,
 * the handbook. Light, quiet, and the same language and text-size controls as
 * the portals, because a member of the public is exactly who needs them.
 */
export function PublicShell({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { t } = useI18n();

  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-full focus:bg-primary-fill focus:px-4 focus:py-2 focus:font-ui focus:text-sm focus:font-semibold focus:text-on-primary"
      >
        {t("shell.skip")}
      </a>
      <div className="pointer-events-none fixed inset-x-0 top-0 -z-0 h-[520px] bg-grad-hero" aria-hidden />

      <header className="relative z-10 border-b border-border bg-bg-elevated/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5">
            <LogoMark size={34} />
            <span className="font-display text-lg text-text">NyaySetu</span>
          </Link>
          <div className="ml-auto flex items-center gap-2">
            <div className="hidden sm:block">
              <DisplayControls compact />
            </div>
            <Link
              to={user ? ROLE_HOME[user.role] : "/login"}
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary-fill px-4 font-ui text-xs font-semibold text-on-primary transition hover:-translate-y-0.5"
            >
              <LogIn size={13} aria-hidden />
              {user ? t("nav.dashboard") : t("shell.signIn")}
            </Link>
          </div>
        </div>
        <div className="border-t border-border px-4 py-2 sm:hidden">
          <DisplayControls compact />
        </div>
      </header>

      <main id="main" tabIndex={-1} className="relative z-10 mx-auto w-full max-w-6xl flex-1 px-4 py-8 outline-none sm:px-6 sm:py-12">
        {children}
      </main>

      <footer className="relative z-10 border-t border-border px-4 py-6 sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
          <p className="font-ui text-2xs text-faint">{t("shell.footer")}</p>
          <div className="flex gap-4">
            <Link to="/handbook" className="font-ui text-2xs text-faint hover:text-primary">
              {t("shell.handbook")}
            </Link>
            <Link to="/" className="font-ui text-2xs text-faint hover:text-primary">
              {t("shell.about")}
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
