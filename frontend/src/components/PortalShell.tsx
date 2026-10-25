import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  Activity,
  BellRing,
  BarChart3,
  BookOpen,
  Car,
  Boxes,
  Camera,
  CheckSquare,
  Eye,
  ClipboardList,
  FilePlus2,
  FileSearch,
  FileText,
  FlaskConical,
  Gavel,
  KeyRound,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  Menu,
  Moon,
  Package,
  QrCode,
  Radio,
  ScrollText,
  Scale,
  ShieldAlert,
  ShieldCheck,
  Sun,
  Type,
  Users,
  X,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { LANGUAGES, useI18n, type Lang, type MessageKey } from "../i18n";
import { LogoMark } from "./Logo";
import { InstallAppButton, PoliceSeal } from "./brand";
import type { Role } from "../lib/api";

interface NavItem {
  to: string;
  label: MessageKey;
  icon: typeof LayoutDashboard;
  end?: boolean;
}

/**
 * One nav definition per portal. Kept here so routes and links cannot drift; a
 * link is added in the same change as the page it points to, so nothing here is
 * ever a dead end.
 */
export const NAV: Record<Role, NavItem[]> = {
  police: [
    { to: "/police", label: "nav.dashboard", icon: LayoutDashboard, end: true },
    { to: "/police/new-case", label: "nav.newCase", icon: FilePlus2 },
    { to: "/police/capture", label: "nav.capture", icon: Camera },
    { to: "/police/seizures", label: "nav.seizures", icon: Package },
    { to: "/police/malkhana", label: "nav.malkhana", icon: Boxes },
    { to: "/police/vehicles", label: "nav.vehicleTrace", icon: Car },
    { to: "/police/third-eye", label: "nav.thirdEye", icon: Eye },
    { to: "/police/station-alerts", label: "nav.stationAlerts", icon: Radio },
    { to: "/police/alerts", label: "nav.alerts", icon: BellRing },
    { to: "/police/analytics", label: "nav.analytics", icon: BarChart3 },
    { to: "/police/cases", label: "nav.cases", icon: ClipboardList },
  ],
  forensic_lab: [
    { to: "/forensic", label: "nav.labQueue", icon: FlaskConical, end: true },
    { to: "/forensic/capture", label: "nav.capture", icon: Camera },
    { to: "/forensic/cases", label: "nav.cases", icon: ClipboardList },
  ],
  prosecutor: [
    { to: "/prosecutor", label: "nav.dashboard", icon: LayoutDashboard, end: true },
    { to: "/prosecutor/alerts", label: "nav.alerts", icon: BellRing },
    { to: "/prosecutor/cases", label: "nav.cases", icon: ClipboardList },
  ],
  judge: [
    { to: "/judge", label: "nav.courtDashboard", icon: LayoutDashboard, end: true },
    { to: "/judge/hearings", label: "nav.hearings", icon: Gavel },
    { to: "/judge/summons", label: "nav.summons", icon: ScrollText },
    { to: "/judge/bail", label: "nav.bail", icon: Scale },
    { to: "/judge/access", label: "nav.accessRequests", icon: KeyRound },
    { to: "/judge/approvals", label: "nav.approvals", icon: CheckSquare },
    { to: "/judge/alerts", label: "nav.alerts", icon: BellRing },
    { to: "/judge/cases", label: "nav.cases", icon: ClipboardList },
  ],
  defence_lawyer: [
    { to: "/defence", label: "nav.verification", icon: ShieldCheck, end: true },
    { to: "/defence/access", label: "nav.accessRequests", icon: KeyRound },
    { to: "/defence/cases", label: "nav.cases", icon: ClipboardList },
  ],
  accused: [
    { to: "/accused", label: "nav.obligations", icon: LayoutDashboard, end: true },
    { to: "/accused/summons", label: "nav.summons", icon: ScrollText },
    { to: "/accused/checkin", label: "nav.checkIn", icon: Scale },
    { to: "/accused/help", label: "nav.help", icon: LifeBuoy },
  ],
  court_admin: [
    { to: "/admin", label: "nav.overview", icon: LayoutDashboard, end: true },
    { to: "/admin/users", label: "nav.participants", icon: Users },
    { to: "/admin/access", label: "nav.caseAccess", icon: ShieldCheck },
    { to: "/admin/approvals", label: "nav.approvals", icon: CheckSquare },
    { to: "/admin/alerts", label: "nav.alerts", icon: BellRing },
    { to: "/admin/templates", label: "nav.templates", icon: FileText },
    { to: "/admin/audit", label: "nav.audit", icon: FileSearch },
    { to: "/admin/smart-policing", label: "nav.analytics", icon: BarChart3 },
    { to: "/admin/chain", label: "nav.chain", icon: Activity },
    { to: "/admin/cases", label: "nav.cases", icon: ClipboardList },
  ],
};

/**
 * Shown to an accused person whose record has no Aadhaar token. Acknowledging a
 * summons and checking in on bail are authenticated against it, so without one
 * those actions would be refused at the end of a form.
 */
function IncompleteRecordNotice() {
  const { user } = useAuth();
  const { t } = useI18n();
  if (!user || user.role !== "accused" || user.hasAadhaarToken !== false) return null;

  return (
    <div role="status" className="mb-6 flex items-start gap-3 rounded-card border border-warning-soft bg-warning-soft px-4 py-3.5">
      <ShieldAlert size={17} className="mt-0.5 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0">
        <p className="font-ui text-sm font-semibold text-text">{t("shell.incompleteTitle")}</p>
        <p className="mt-1 font-ui text-xs leading-relaxed text-muted">{t("shell.incompleteBody")}</p>
      </div>
    </div>
  );
}

/** Language, theme and text size. Shared by the sidebar and the public pages. */
export function DisplayControls({ compact = false }: { compact?: boolean }) {
  const { theme, toggle } = useTheme();
  const { lang, setLang, textSize, setTextSize, t } = useI18n();

  return (
    <div className={`flex items-center gap-2 ${compact ? "" : "flex-wrap"}`}>
      <label className="sr-only" htmlFor="lang-select">
        {t("shell.language")}
      </label>
      <select
        id="lang-select"
        value={lang}
        onChange={(event) => setLang(event.target.value as Lang)}
        className="h-9 cursor-pointer rounded-full border border-border bg-surface px-3 font-ui text-xs font-semibold text-text transition hover:border-border-strong"
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.native}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => setTextSize(textSize === "large" ? "normal" : "large")}
        aria-pressed={textSize === "large"}
        aria-label={textSize === "large" ? t("shell.textNormal") : t("shell.textLarge")}
        title={textSize === "large" ? t("shell.textNormal") : t("shell.textLarge")}
        className={`grid h-9 w-9 place-items-center rounded-full border transition ${
          textSize === "large" ? "border-primary bg-primary-soft text-primary" : "border-border text-muted hover:border-border-strong hover:text-text"
        }`}
      >
        <Type size={15} aria-hidden />
      </button>
      <button
        type="button"
        onClick={toggle}
        aria-label={theme === "dark" ? t("shell.switchToLight") : t("shell.switchToDark")}
        title={theme === "dark" ? t("shell.switchToLight") : t("shell.switchToDark")}
        className="grid h-9 w-9 place-items-center rounded-full border border-border text-muted transition hover:border-border-strong hover:text-text"
      >
        {theme === "dark" ? <Sun size={15} aria-hidden /> : <Moon size={15} aria-hidden />}
      </button>
    </div>
  );
}

function NavList({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const { t } = useI18n();
  return (
    <ul className="space-y-1">
      {items.map((item) => (
        <li key={item.to}>
          <NavLink
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              `group flex items-center gap-3 rounded-xl px-3 py-2.5 font-ui text-sm font-medium transition ${
                isActive
                  ? "bg-primary-soft text-primary shadow-[inset_3px_0_0_var(--primary)]"
                  : "text-muted hover:bg-surface-2 hover:text-text"
              }`
            }
          >
            <item.icon size={17} aria-hidden className="shrink-0" />
            <span className="truncate">{t(item.label)}</span>
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const { user, signOut } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  if (!user) return null;

  const handleSignOut = async () => {
    await signOut();
    navigate("/login", { replace: true });
  };

  return (
    <div className="flex h-full flex-col">
      <Link to={NAV[user.role][0].to} onClick={onNavigate} className="group flex items-center gap-3 px-5 pb-5 pt-6">
        <LogoMark size={40} className="transition-transform duration-300 ease-smooth group-hover:scale-105" />
        <span className="min-w-0">
          <span className="block font-display text-lg leading-none text-text">NyaySetu</span>
          <span className="mt-1 block truncate font-ui text-2xs font-semibold uppercase tracking-wider text-primary">
            {t(`role.${user.role}` as MessageKey)}
          </span>
        </span>
      </Link>

      <nav aria-label="Primary" className="flex-1 overflow-y-auto px-3 no-scrollbar">
        <NavList items={NAV[user.role]} onNavigate={onNavigate} />

        <div className="mt-5 border-t border-border pt-4">
          <ul className="space-y-1">
            <li>
              <Link
                to="/verify"
                onClick={onNavigate}
                className="flex items-center gap-3 rounded-xl px-3 py-2.5 font-ui text-sm font-medium text-muted transition hover:bg-surface-2 hover:text-text"
              >
                <QrCode size={17} aria-hidden />
                {t("shell.verify")}
              </Link>
            </li>
            <li>
              <Link
                to="/handbook"
                onClick={onNavigate}
                className="flex items-center gap-3 rounded-xl px-3 py-2.5 font-ui text-sm font-medium text-muted transition hover:bg-surface-2 hover:text-text"
              >
                <BookOpen size={17} aria-hidden />
                {t("shell.handbook")}
              </Link>
            </li>
          </ul>
        </div>
      </nav>

      <div className="space-y-3 border-t border-border px-4 py-4">
        <div>
          <p className="mb-2 font-ui text-2xs font-semibold uppercase tracking-wider text-faint">{t("shell.preferences")}</p>
          <DisplayControls />
        </div>
        <div className="flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2.5">
          <span
            aria-hidden
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-grad-brand font-ui text-sm font-bold text-white"
          >
            {user.fullName.trim().charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-ui text-xs font-semibold text-text">{user.fullName}</p>
            <p className="truncate font-ui text-2xs text-faint">{user.designation ?? t(`role.${user.role}` as MessageKey)}</p>
          </div>
          <button
            type="button"
            onClick={() => void handleSignOut()}
            aria-label={t("shell.signOut")}
            title={t("shell.signOut")}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted transition hover:bg-danger-soft hover:text-danger"
          >
            <LogOut size={15} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}

export function PortalShell({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { t } = useI18n();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLDivElement>(null);

  // A route change closes the drawer, or it stays over the new page.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    drawer.current?.querySelector<HTMLElement>("a, button")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [menuOpen]);

  if (!user) return null;

  return (
    <div className="min-h-screen bg-bg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-full focus:bg-primary-fill focus:px-4 focus:py-2 focus:font-ui focus:text-sm focus:font-semibold focus:text-on-primary"
      >
        {t("shell.skip")}
      </a>

      {/* ------------------------------------------------ desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-72 border-r border-border bg-sidebar lg:block">
        <SidebarBody />
      </aside>

      {/* ------------------------------------------------ mobile top bar */}
      <header className="sticky top-0 z-40 flex h-16 items-center gap-3 border-b border-border bg-bg-elevated/90 px-4 backdrop-blur lg:hidden">
        <button
          ref={menuButton}
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-label={t("shell.menu")}
          aria-expanded={menuOpen}
          aria-controls="mobile-drawer"
          className="grid h-10 w-10 place-items-center rounded-full border border-border text-text"
        >
          <Menu size={18} aria-hidden />
        </button>
        <Link to={NAV[user.role][0].to} className="flex items-center gap-2">
          <LogoMark size={32} />
          <span className="font-display text-base text-text">NyaySetu</span>
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <InstallAppButton compact />
          <PoliceSeal size={34} />
        </div>
      </header>

      {menuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px] animate-overlay-in" onClick={() => setMenuOpen(false)} aria-hidden />
          <div
            id="mobile-drawer"
            ref={drawer}
            role="dialog"
            aria-modal="true"
            aria-label={t("shell.menu")}
            className="absolute inset-y-0 left-0 w-[86%] max-w-xs animate-menu-in border-r border-border bg-sidebar shadow-lift"
          >
            <button
              type="button"
              onClick={() => setMenuOpen(false)}
              aria-label={t("shell.closeMenu")}
              className="absolute right-3 top-5 grid h-9 w-9 place-items-center rounded-full text-muted hover:bg-surface-2"
            >
              <X size={17} aria-hidden />
            </button>
            <SidebarBody onNavigate={() => setMenuOpen(false)} />
          </div>
        </div>
      )}

      <div className="lg:pl-72">
        {/* ------------------------------------------------ desktop top bar */}
        <div className="sticky top-0 z-20 hidden h-16 items-center justify-between border-b border-border bg-bg-elevated/85 px-10 backdrop-blur lg:flex">
          <span className="truncate rounded-full bg-primary-soft px-3 py-1 font-ui text-xs font-semibold text-primary">
            {t(`role.${user.role}` as MessageKey)}
          </span>
          <div className="flex items-center gap-4">
            <InstallAppButton />
            <PoliceSeal size={40} showLabel />
          </div>
        </div>
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-7xl px-4 py-6 outline-none sm:px-6 sm:py-8 lg:px-10">
          <IncompleteRecordNotice />
          {children}
        </main>
        <footer className="border-t border-border px-4 py-5 sm:px-6 lg:px-10">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
            <p className="font-ui text-2xs text-faint">{t("shell.footer")}</p>
            <div className="flex items-center gap-4">
              <Link to="/handbook" className="font-ui text-2xs text-faint transition hover:text-primary">
                {t("shell.handbook")}
              </Link>
              <Link to="/about" className="font-ui text-2xs text-faint transition hover:text-primary">
                {t("shell.about")}
              </Link>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
