import { useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  BadgeCheck,
  Camera,
  CheckCircle2,
  Clock3,
  Database,
  FileCheck2,
  FlaskConical,
  Gavel,
  Languages,
  Link2,
  Lock,
  Menu,
  QrCode,
  Scale,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { Reveal } from "../components/ui";
import { LogoMark } from "../components/Logo";
import { InstallAppButton, PoliceSeal } from "../components/brand";

/**
 * The public entry point: what NyaySetu records, who uses it, what goes on the
 * blockchain and what deliberately does not, and what it cannot prove. Every
 * claim here should match the code; the "Limits" section is part of the page,
 * not a footnote.
 */

const NAV = [
  { href: "#how", label: "How it works" },
  { href: "#roles", label: "Who uses it" },
  { href: "#privacy", label: "On and off chain" },
  { href: "#limits", label: "Limits" },
];

const STEPS = [
  {
    icon: Camera,
    title: "Capture",
    body: "A photo or video is taken in the app, or a file is chosen. Its SHA-256 fingerprint is computed on the device before anything is uploaded, together with the time, the GPS fix and its accuracy.",
  },
  {
    icon: Link2,
    title: "Anchor",
    body: "The fingerprint of a capture manifest is written to an Ethereum contract. The record says honestly where that has got to: saved locally, submitted, or confirmed after enough blocks.",
  },
  {
    icon: FlaskConical,
    title: "Hand over",
    body: "Police, laboratory, prosecution and court each re-hash what they receive before accepting it. A mismatch is recorded on chain and the transfer does not happen.",
  },
  {
    icon: Gavel,
    title: "Produce in court",
    body: "Anyone can check an item on its public Integrity Passport. The Section 63 certificate template, custody form and an export bundle are generated from the same record.",
  },
];

const STATES = [
  { tone: "bg-surface-2 text-muted", label: "Saved locally", body: "Recorded here; not yet sent to the blockchain." },
  { tone: "bg-info-soft text-info", label: "Submitted", body: "Sent; waiting for the network to include it." },
  { tone: "bg-success-soft text-success", label: "Confirmed on chain", body: "Included and buried under enough blocks to rely on." },
  { tone: "bg-warning-soft text-warning", label: "Review required", body: "Something unexpected happened; a person must look." },
  { tone: "bg-danger-soft text-danger", label: "Integrity mismatch", body: "A file did not match its anchored fingerprint." },
];

const ROLES = [
  { icon: ShieldCheck, name: "Police", body: "Register cases, capture evidence with GPS, record seizure memos and malkhana movements." },
  { icon: FlaskConical, name: "Forensic laboratory", body: "Re-hash on arrival, check the seal, record working copies and file versioned reports." },
  { icon: Scale, name: "Prosecution", body: "See which cases are ready: what is confirmed, what is pending, and every open alert." },
  { icon: Gavel, name: "Judge", body: "Hearings and orders, access requests, objections, ranked bail compliance and approvals." },
  { icon: BadgeCheck, name: "Defence", body: "Request access through the court and verify disclosed files against the chain, not the database." },
  { icon: UserRound, name: "Accused or witness", body: "Summons and check-ins explained plainly in English, Hindi or Marathi, with a way to give reasons." },
  { icon: Users, name: "Court registry", body: "Participants, case access, document templates, the audit trail and the chain's health." },
];

const ON_CHAIN = [
  "A salted case key, from which neither the FIR nor the case reference can be recovered",
  "The fingerprint of each evidence item's capture manifest",
  "Custody transfers and integrity checks, including the ones that failed",
  "Fingerprints of seizure memos, malkhana movements, working copies and forensic reports",
  "Summons issue and acknowledgement events, including the acknowledgement's coordinates",
  "Bail conditions and check-ins, whose coordinates the contract needs to check the permitted area",
];

const OFF_CHAIN = [
  "The evidence files, encrypted with AES-256-GCM before storage",
  "Names, FIR details, addresses and witnesses",
  "Exact evidence coordinates (kept in the manifest, which only assigned roles may see)",
  "Report text, court orders, comments and case notes",
  "Accounts, sessions and the role-based access rules, enforced in the API and by row-level security",
];

const LIMITS = [
  "A matching fingerprint proves a file is unchanged since it was anchored. It does not prove what the file shows is true, or how it was collected.",
  "GPS can be wrong or spoofed. Accuracy is recorded with every fix, and a poor fix is flagged rather than hidden.",
  "The AI screening and estimates are decision support. They are labelled with their limitations and never decide anything.",
  "Generated certificates and forms are templates filled from the record, to be checked by a legal practitioner before filing.",
  "One-time codes use a sandbox provider by default. Real Aadhaar authentication needs a licensed provider and is not part of this build.",
  "Hindi and Marathi text has not yet been reviewed by native speakers.",
];

function Header() {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-surface/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Link to="/" className="flex items-center gap-2.5" aria-label="NyaySetu home">
          <LogoMark size={34} />
          <span>
            <span className="block font-display text-lg leading-none text-text">NyaySetu</span>
            <span className="block font-ui text-2xs leading-tight text-muted">न्यायसेतु</span>
          </span>
        </Link>
        <nav aria-label="Sections" className="hidden flex-1 items-center gap-1 md:flex">
          {NAV.map((item) => (
            <a key={item.href} href={item.href} className="rounded-full px-3 py-2 font-ui text-sm text-muted transition hover:bg-surface-2 hover:text-text">
              {item.label}
            </a>
          ))}
          <Link to="/about" className="rounded-full px-3 py-2 font-ui text-sm text-muted transition hover:bg-surface-2 hover:text-text">
            About
          </Link>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <InstallAppButton compact />
          <Link to="/verify" className="hidden rounded-full border border-border px-4 py-2 font-ui text-sm font-semibold text-text transition hover:border-primary lg:inline-flex">
            Verify evidence
          </Link>
          <Link to="/login" className="inline-flex rounded-full bg-primary-fill px-4 py-2 font-ui text-sm font-semibold text-on-primary transition hover:opacity-90">
            Sign in
          </Link>
          <button
            type="button"
            className="grid h-10 w-10 place-items-center rounded-full border border-border text-text md:hidden"
            aria-label="Menu"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X size={17} aria-hidden /> : <Menu size={17} aria-hidden />}
          </button>
          <PoliceSeal size={38} className="hidden sm:inline-flex" />
        </div>
      </div>
      {open && (
        <nav aria-label="Sections" className="border-t border-border bg-surface px-4 pb-4 pt-2 md:hidden">
          {[...NAV, { href: "/about", label: "About NyaySetu" }, { href: "/verify", label: "Verify evidence" }].map((item) =>
            item.href.startsWith("#") ? (
              <a key={item.href} href={item.href} onClick={() => setOpen(false)} className="block rounded-xl px-3 py-3 font-ui text-base text-text hover:bg-surface-2">
                {item.label}
              </a>
            ) : (
              <Link key={item.href} to={item.href} onClick={() => setOpen(false)} className="block rounded-xl px-3 py-3 font-ui text-base text-text hover:bg-surface-2">
                {item.label}
              </Link>
            )
          )}
        </nav>
      )}
    </header>
  );
}

function PassportPreview() {
  return (
    <div className="panel relative mx-auto w-full max-w-sm p-5 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-ui text-2xs font-semibold uppercase tracking-[0.14em] text-muted">Evidence Integrity Passport</p>
          <p className="mt-1 font-mono text-xs text-text">NSE-92519SYK3AD82N3R5A3EH83YRG</p>
        </div>
        <span className="grid h-12 w-12 place-items-center rounded-xl bg-surface-2 text-text">
          <QrCode size={26} aria-hidden />
        </span>
      </div>
      <span className="chip mt-4 border-success-soft bg-success-soft text-success">
        <CheckCircle2 size={11} aria-hidden /> Confirmed on chain
      </span>
      <dl className="mt-4 space-y-2.5 font-ui text-xs">
        {[
          ["Fingerprint", "0x87012c45…28df6e"],
          ["Captured", "17 Oct 2026, 01:09"],
          ["GPS accuracy", "± 8 m"],
          ["Custody", "Scene → Laboratory"],
        ].map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 border-b border-border pb-2 last:border-0">
            <dt className="text-muted">{k}</dt>
            <dd className="font-medium text-text">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 font-ui text-2xs leading-relaxed text-muted">Drop the file on the public page: it is hashed in your browser and compared with the chain.</p>
      <p className="absolute -bottom-3 right-4 rounded-full border border-border bg-surface px-3 py-1 font-ui text-2xs text-muted shadow-card">Illustration</p>
    </div>
  );
}

function SectionHead({ eyebrow, title, body }: { eyebrow: string; title: string; body?: string }) {
  return (
    <Reveal>
      <p className="mb-2 font-ui text-xs font-bold uppercase tracking-[0.16em] text-primary">{eyebrow}</p>
      <h2 className="max-w-3xl font-display text-3xl leading-tight text-text sm:text-4xl">{title}</h2>
      {body && <p className="mt-3 max-w-3xl font-ui text-base leading-relaxed text-muted">{body}</p>}
    </Reveal>
  );
}

export default function Landing() {
  return (
    <div className="min-h-screen bg-bg">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-4 focus:py-2">
        Skip to content
      </a>
      <Header />

      <main id="main">
        {/* ------------------------------------------------------------ hero */}
        <section className="relative overflow-hidden border-b border-border">
          <div aria-hidden className="pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-primary-soft blur-3xl" />
          <div aria-hidden className="pointer-events-none absolute -right-24 top-24 h-80 w-80 rounded-full bg-accent-soft blur-3xl" />
          <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-[1.15fr_1fr]">
            <div>
              <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 font-ui text-xs font-semibold text-muted">
                <ShieldCheck size={13} className="text-primary" aria-hidden /> Evidence · Summons · Bail
              </p>
              <h1 className="font-display text-4xl leading-[1.08] text-text sm:text-5xl lg:text-6xl">
                A record anyone can check, from the scene to the courtroom.
              </h1>
              <p className="mt-5 max-w-xl font-ui text-base leading-relaxed text-muted sm:text-lg">
                NyaySetu fingerprints evidence on the device that captures it, anchors those fingerprints to a public blockchain, and makes every
                hand-over prove it received the same thing. Personal details stay off chain.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link to="/verify" className="inline-flex items-center gap-2 rounded-full bg-primary-fill px-6 py-3 font-ui text-sm font-semibold text-on-primary shadow-card transition hover:-translate-y-0.5">
                  Verify a piece of evidence <ArrowRight size={15} aria-hidden />
                </Link>
                <Link to="/login" className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-6 py-3 font-ui text-sm font-semibold text-text transition hover:border-primary">
                  Sign in to your portal
                </Link>
              </div>
              <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 font-ui text-sm text-muted">
                <li className="flex items-center gap-1.5"><Languages size={14} className="text-primary" aria-hidden /> English, हिन्दी, मराठी</li>
                <li className="flex items-center gap-1.5"><Smartphone size={14} className="text-primary" aria-hidden /> Works on phones</li>
                <li className="flex items-center gap-1.5"><Lock size={14} className="text-primary" aria-hidden /> No sign-in to verify</li>
              </ul>
            </div>
            <Reveal delay={0.1}>
              <PassportPreview />
            </Reveal>
          </div>
        </section>

        {/* ----------------------------------------------------- problems */}
        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
          <SectionHead eyebrow="Why" title="Three questions a court should not have to take on trust" />
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {[
              { icon: FileCheck2, q: "Is this the evidence that was collected?", a: "A register records that a transfer happened, not that the item is unchanged. A fingerprint checked at every hand-over does." },
              { icon: ScrollText, q: "Was the summons received?", a: "The recipient acknowledges with a one-time code, and the acknowledgement is a timestamped blockchain event." },
              { icon: Scale, q: "Are bail conditions being kept?", a: "Check-ins are recorded against the permitted area, ranked for the court with the reason for each rank and any explanation given." },
            ].map((item, i) => (
              <Reveal key={item.q} delay={i * 0.06}>
                <div className="panel h-full p-6">
                  <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary-soft text-primary">
                    <item.icon size={18} aria-hidden />
                  </span>
                  <h3 className="mt-4 font-display text-xl leading-snug text-text">{item.q}</h3>
                  <p className="mt-2 font-ui text-sm leading-relaxed text-muted">{item.a}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        {/* ---------------------------------------------------- how it works */}
        <section id="how" className="scroll-mt-20 border-y border-border bg-surface">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
            <SectionHead eyebrow="How it works" title="Four steps, each one checkable" />
            <ol className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((step, i) => (
                <li key={step.title} className="h-full">
                  <Reveal delay={i * 0.06} className="relative h-full rounded-panel border border-border bg-bg p-6">
                    <span className="font-mono text-xs text-faint">0{i + 1}</span>
                    <step.icon size={22} className="mt-2 text-primary" aria-hidden />
                    <h3 className="mt-3 font-display text-xl text-text">{step.title}</h3>
                    <p className="mt-2 font-ui text-sm leading-relaxed text-muted">{step.body}</p>
                  </Reveal>
                </li>
              ))}
            </ol>

            <Reveal delay={0.1}>
              <div className="mt-10 rounded-panel border border-border bg-bg p-6">
                <div className="flex items-center gap-2">
                  <Clock3 size={16} className="text-primary" aria-hidden />
                  <h3 className="font-display text-lg text-text">Every record says where it has got to</h3>
                </div>
                <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  {STATES.map((s) => (
                    <li key={s.label}>
                      <span className={`inline-block rounded-full px-2.5 py-1 font-ui text-xs font-semibold ${s.tone}`}>{s.label}</span>
                      <p className="mt-1.5 font-ui text-xs leading-relaxed text-muted">{s.body}</p>
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ---------------------------------------------------------- roles */}
        <section id="roles" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16 sm:px-6 sm:py-24">
          <SectionHead eyebrow="Who uses it" title="Seven roles, one record" body="Each role sees and can do only what its part of the process needs. The API enforces it, and so does the database." />
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {ROLES.map((role, i) => (
              <Reveal key={role.name} delay={(i % 4) * 0.05}>
                <div className="panel h-full p-5 transition hover:-translate-y-0.5 hover:border-primary-ring">
                  <role.icon size={19} className="text-primary" aria-hidden />
                  <h3 className="mt-3 font-ui text-base font-semibold text-text">{role.name}</h3>
                  <p className="mt-1.5 font-ui text-sm leading-relaxed text-muted">{role.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        {/* -------------------------------------------------------- privacy */}
        <section id="privacy" className="scroll-mt-20 border-y border-border bg-surface">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
            <SectionHead
              eyebrow="On and off chain"
              title="What goes on a public blockchain, and what never does"
              body="A blockchain is public and permanent. That suits a fingerprint, and is exactly wrong for a photograph, a name or an address."
            />
            <div className="mt-10 grid gap-5 lg:grid-cols-2">
              {[
                { title: "On chain", icon: Link2, items: ON_CHAIN, dot: "bg-primary" },
                { title: "Off chain", icon: Database, items: OFF_CHAIN, dot: "bg-accent" },
              ].map((col, i) => (
                <Reveal key={col.title} delay={i * 0.06}>
                  <div className="h-full rounded-panel border border-border bg-bg p-6">
                    <div className="flex items-center gap-2">
                      <col.icon size={17} className="text-primary" aria-hidden />
                      <h3 className="font-display text-xl text-text">{col.title}</h3>
                    </div>
                    <ul className="mt-4 space-y-3">
                      {col.items.map((item) => (
                        <li key={item} className="flex gap-2.5">
                          <span className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${col.dot}`} aria-hidden />
                          <span className="font-ui text-sm leading-relaxed text-text">{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* --------------------------------------------------------- limits */}
        <section id="limits" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16 sm:px-6 sm:py-24">
          <SectionHead eyebrow="Limits" title="What NyaySetu does not prove" body="Saying so plainly is part of the design." />
          <ul className="mt-8 grid gap-4 md:grid-cols-2">
            {LIMITS.map((limit, i) => (
              <li key={limit} className="h-full">
                <Reveal delay={(i % 2) * 0.05} className="flex h-full gap-3 rounded-panel border border-border bg-surface p-5">
                  <ShieldAlert size={17} className="mt-0.5 shrink-0 text-warning" aria-hidden />
                  <span className="font-ui text-sm leading-relaxed text-text">{limit}</span>
                </Reveal>
              </li>
            ))}
          </ul>
        </section>

        {/* ------------------------------------------------------------ cta */}
        <section className="px-4 pb-20 sm:px-6">
          <Reveal>
            <div className="mx-auto max-w-6xl rounded-[28px] border border-primary-ring bg-primary-soft px-6 py-12 text-center sm:px-12">
              <h2 className="font-display text-3xl leading-tight text-text sm:text-4xl">Have a reference or a file? Check it now.</h2>
              <p className="mx-auto mt-3 max-w-2xl font-ui text-base leading-relaxed text-muted">
                The public verification page needs no account. It shows what the blockchain holds for an item, never who or where.
              </p>
              <div className="mt-7 flex flex-wrap justify-center gap-3">
                <Link to="/verify" className="inline-flex items-center gap-2 rounded-full bg-primary-fill px-6 py-3 font-ui text-sm font-semibold text-on-primary transition hover:-translate-y-0.5">
                  Open verification <ArrowRight size={15} aria-hidden />
                </Link>
                <Link to="/handbook" className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-6 py-3 font-ui text-sm font-semibold text-text transition hover:border-primary">
                  Read the handbook
                </Link>
              </div>
            </div>
          </Reveal>
        </section>
      </main>

      <footer className="border-t border-border bg-surface px-4 py-8 sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <LogoMark size={32} />
            <div>
              <p className="font-display text-base leading-none text-text">NyaySetu</p>
              <p className="mt-1 font-ui text-xs text-muted">Evidence, summons and bail records you can verify.</p>
            </div>
          </div>
          <nav aria-label="Footer" className="flex flex-wrap items-center gap-5 font-ui text-sm">
            <Link to="/verify" className="text-muted hover:text-primary">Verify</Link>
            <Link to="/handbook" className="text-muted hover:text-primary">Handbook</Link>
            <Link to="/login" className="font-semibold text-primary hover:underline">Sign in</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
