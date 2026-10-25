import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { animate, motion, useInView, useReducedMotion, useScroll, useSpring, useTransform } from "motion/react";
import {
  ArrowRight,
  Blocks,
  Camera,
  CheckCircle2,
  Eye,
  FileCheck2,
  FlaskConical,
  Gavel,
  Github,
  Globe2,
  Languages,
  Lock,
  Scale,
  ScrollText,
  ShieldCheck,
  Smartphone,
  Sparkles,
} from "lucide-react";
import { LogoMark } from "../components/Logo";
import { InstallAppButton, PoliceSeal } from "../components/brand";

/**
 * About NyaySetu: what it is for, how it works, what it is built on, and who
 * built it. Animated with Motion; every animation is skipped for visitors who
 * prefer reduced motion.
 */

const PHRASES = [
  "this evidence has not been altered.",
  "custody passed hand to hand, verified each time.",
  "the summons reached the person it named.",
  "bail conditions were kept, or were not.",
];

function Typewriter({ phrases }: { phrases: string[] }) {
  const reduce = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [text, setText] = useState(reduce ? phrases[0] : "");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (reduce) return;
    const full = phrases[index];
    const done = !deleting && text === full;
    const empty = deleting && text === "";
    const delay = done ? 1800 : empty ? 250 : deleting ? 22 : 45;
    const timer = window.setTimeout(() => {
      if (done) setDeleting(true);
      else if (empty) {
        setDeleting(false);
        setIndex((i) => (i + 1) % phrases.length);
      } else setText(deleting ? full.slice(0, text.length - 1) : full.slice(0, text.length + 1));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [text, deleting, index, phrases, reduce]);

  return (
    <span className="text-primary">
      {text}
      <motion.span
        aria-hidden
        className="ml-0.5 inline-block h-[0.9em] w-[3px] translate-y-[0.1em] rounded bg-primary"
        animate={reduce ? undefined : { opacity: [1, 0, 1] }}
        transition={{ duration: 1, repeat: Infinity }}
      />
    </span>
  );
}

function Counter({ to, suffix = "", label }: { to: number; suffix?: string; label: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });
  const reduce = useReducedMotion();
  useEffect(() => {
    if (!inView || !ref.current) return;
    if (reduce) {
      ref.current.textContent = `${to}${suffix}`;
      return;
    }
    const controls = animate(0, to, {
      duration: 1.4,
      ease: "easeOut",
      onUpdate: (v) => {
        if (ref.current) ref.current.textContent = `${Math.round(v)}${suffix}`;
      },
    });
    return () => controls.stop();
  }, [inView, to, suffix, reduce]);
  return (
    <div className="text-center">
      <span ref={ref} className="block font-display text-4xl text-text sm:text-5xl">
        0{suffix}
      </span>
      <span className="mt-1 block font-ui text-sm text-muted">{label}</span>
    </div>
  );
}

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] as const } },
};
const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.09 } } };

function Section({ id, eyebrow, title, intro, children, tint = false }: { id?: string; eyebrow: string; title: string; intro?: string; children: React.ReactNode; tint?: boolean }) {
  return (
    <section id={id} className={`scroll-mt-20 ${tint ? "border-y border-border bg-surface" : ""}`}>
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
        <motion.div variants={fadeUp} initial="hidden" whileInView="show" viewport={{ once: true, margin: "-80px" }}>
          <p className="mb-2 font-ui text-xs font-bold uppercase tracking-[0.18em] text-primary">{eyebrow}</p>
          <h2 className="max-w-3xl font-display text-3xl leading-tight text-text sm:text-4xl">{title}</h2>
          {intro && <p className="mt-4 max-w-3xl font-ui text-base leading-relaxed text-muted sm:text-lg">{intro}</p>}
        </motion.div>
        {children}
      </div>
    </section>
  );
}

const JOURNEY = [
  { icon: Camera, title: "At the scene", body: "The officer captures a photograph or video in NyaySetu. Its SHA-256 fingerprint is computed on the device, with the time and an accuracy-rated GPS fix, before a single byte is uploaded." },
  { icon: Blocks, title: "Anchored", body: "The fingerprint of the capture record is written to an Ethereum smart contract. The item's status advances from saved, to submitted, to confirmed — and the screen always states which." },
  { icon: FlaskConical, title: "In the laboratory", body: "The laboratory re-computes the fingerprint on arrival and records the condition of the seal. A mismatch is written to the ledger and the transfer is refused." },
  { icon: Scale, title: "With the prosecution", body: "The prosecutor sees, case by case, how much evidence is confirmed, what is pending, and every open discrepancy, before deciding the case is ready." },
  { icon: Gavel, title: "Before the court", body: "The judge, the defence and any member of the public can check an item against the ledger. The Section 63 certificate and custody record are generated from the same data." },
];

const PRINCIPLES = [
  { icon: Eye, title: "Verifiable by anyone", body: "Integrity is checked against a public ledger that no party to the case controls — not asserted by whoever runs the server." },
  { icon: Lock, title: "Private by design", body: "Only fingerprints go on the blockchain. Files, names, addresses and evidence locations stay off chain, encrypted and access-controlled." },
  { icon: CheckCircle2, title: "Honest about status", body: "Nothing is described as confirmed before it is. Failures are recorded, explained, and placed before a person to decide." },
  { icon: Languages, title: "Accessible to all", body: "Every screen is available in English, Hindi and Marathi, works on a phone, and meets WCAG AA contrast in both themes." },
];

const STACK = [
  { label: "Ledger", value: "Solidity 0.8.24 smart contracts on Ethereum (Sepolia), OpenZeppelin access control" },
  { label: "Server", value: "Node.js, Express and TypeScript, with a verification state machine and role-based access" },
  { label: "Data", value: "PostgreSQL on Supabase with row-level security on every table and a trigger-based audit trail" },
  { label: "Files", value: "AES-256-GCM encryption before storage, pinned to IPFS through Pinata" },
  { label: "Web", value: "React, Tailwind CSS and Motion; installable as an app on Android" },
  { label: "Field app", value: "React Native (Expo) with an offline evidence queue" },
  { label: "Analytics", value: "Python and scikit-learn decision support, clearly labelled and never decisive" },
];

export default function About() {
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll();
  const progress = useSpring(scrollYProgress, { stiffness: 120, damping: 30 });
  const timelineRef = useRef<HTMLOListElement>(null);
  const { scrollYProgress: timelineProgress } = useScroll({ target: timelineRef, offset: ["start 75%", "end 60%"] });
  const lineScale = useTransform(timelineProgress, [0, 1], [0, 1]);
  const heroRef = useRef<HTMLElement>(null);
  const { scrollYProgress: heroProgress } = useScroll({ target: heroRef, offset: ["start start", "end start"] });
  const heroY = useTransform(heroProgress, [0, 1], [0, reduce ? 0 : 80]);

  useEffect(() => {
    document.title = "About · NyaySetu";
  }, []);

  return (
    <div className="min-h-screen bg-bg">
      <motion.div aria-hidden className="fixed inset-x-0 top-0 z-50 h-1 origin-left bg-primary" style={{ scaleX: progress }} />

      <header className="sticky top-0 z-40 border-b border-border bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5" aria-label="NyaySetu home">
            <LogoMark size={34} />
            <span className="font-display text-lg text-text">NyaySetu</span>
          </Link>
          <div className="ml-auto flex items-center gap-2">
            <InstallAppButton compact />
            <Link to="/verify" className="hidden rounded-full border border-border px-4 py-2 font-ui text-sm font-semibold text-text transition hover:border-primary sm:inline-flex">
              Verify evidence
            </Link>
            <Link to="/login" className="rounded-full bg-primary-fill px-4 py-2 font-ui text-sm font-semibold text-on-primary transition hover:opacity-90">
              Sign in
            </Link>
            <PoliceSeal size={36} className="hidden sm:inline-flex" />
          </div>
        </div>
      </header>

      <main id="main">
        {/* ------------------------------------------------------------ hero */}
        <section ref={heroRef} className="relative overflow-hidden border-b border-border">
          <motion.div aria-hidden style={{ y: heroY }} className="pointer-events-none absolute inset-0">
            <div className="absolute -left-40 -top-40 h-[30rem] w-[30rem] rounded-full bg-primary-soft blur-3xl" />
            <div className="absolute -right-32 top-20 h-96 w-96 rounded-full bg-accent-soft blur-3xl" />
          </motion.div>
          <div className="relative mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
            <motion.p
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 font-ui text-xs font-semibold text-muted"
            >
              <Sparkles size={13} className="text-primary" aria-hidden /> About NyaySetu · न्यायसेतु
            </motion.p>
            <motion.h1
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.1 }}
              className="max-w-4xl font-display text-4xl leading-[1.12] text-text sm:text-5xl lg:text-6xl"
            >
              A bridge of justice that lets anyone confirm <Typewriter phrases={PHRASES} />
            </motion.h1>
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.7, delay: 0.35 }}
              className="mt-6 max-w-2xl font-ui text-lg leading-relaxed text-muted"
            >
              NyaySetu is an evidence-integrity and court-process platform for the criminal justice system. It records each step from the scene of an
              offence to the courtroom, and anchors a tamper-evident fingerprint of every step to a public blockchain.
            </motion.p>
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.5 }} className="mt-9 flex flex-wrap gap-3">
              <Link to="/verify" className="inline-flex items-center gap-2 rounded-full bg-primary-fill px-6 py-3 font-ui text-sm font-semibold text-on-primary shadow-card transition hover:-translate-y-0.5">
                Verify a piece of evidence <ArrowRight size={15} aria-hidden />
              </Link>
              <Link to="/handbook" className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-6 py-3 font-ui text-sm font-semibold text-text transition hover:border-primary">
                Read the handbook
              </Link>
            </motion.div>
          </div>
        </section>

        {/* ------------------------------------------------------- numbers */}
        <section className="border-b border-border bg-surface">
          <div className="mx-auto grid max-w-6xl grid-cols-2 gap-8 px-4 py-12 sm:px-6 md:grid-cols-4">
            <Counter to={7} label="roles, each with its own portal" />
            <Counter to={3} label="smart contracts on Ethereum" />
            <Counter to={3} label="languages: English, हिन्दी, मराठी" />
            <Counter to={100} suffix="%" label="of tampered files detected in testing" />
          </div>
        </section>

        {/* ------------------------------------------------------- mission */}
        <Section
          eyebrow="Why it exists"
          title="Three questions a court should never have to take on trust"
          intro="Was this evidence altered? Did the summons reach the person it named? Are the conditions of bail being kept? Each is routinely answered by the word of an interested party. NyaySetu replaces that word with a record anyone can check."
        >
          <motion.div variants={stagger} initial="hidden" whileInView="show" viewport={{ once: true, margin: "-60px" }} className="mt-10 grid gap-5 md:grid-cols-3">
            {[
              { icon: FileCheck2, title: "Evidence", body: "A digital fingerprint taken on the recording device and re-checked at every hand-over shows whether an item is unchanged." },
              { icon: ScrollText, title: "Summons", body: "Acknowledgement by one-time code becomes a time-stamped ledger event, ending disputes over service." },
              { icon: Scale, title: "Bail", body: "Check-ins are recorded against the permitted area and ranked for the court, together with any explanation the accused has given." },
            ].map((card) => (
              <motion.div key={card.title} variants={fadeUp} whileHover={reduce ? undefined : { y: -6 }} className="panel h-full p-6">
                <span className="grid h-11 w-11 place-items-center rounded-2xl bg-primary-soft text-primary">
                  <card.icon size={20} aria-hidden />
                </span>
                <h3 className="mt-4 font-display text-xl text-text">{card.title}</h3>
                <p className="mt-2 font-ui text-sm leading-relaxed text-muted">{card.body}</p>
              </motion.div>
            ))}
          </motion.div>
        </Section>

        {/* ------------------------------------------------------ journey */}
        <Section tint eyebrow="How it works" title="One item of evidence, from the scene to the courtroom">
          <ol ref={timelineRef} className="relative mt-12 space-y-10 pl-10 sm:pl-14">
            <span aria-hidden className="absolute left-4 top-0 h-full w-0.5 bg-border sm:left-6" />
            <motion.span aria-hidden style={{ scaleY: lineScale }} className="absolute left-4 top-0 h-full w-0.5 origin-top bg-primary sm:left-6" />
            {JOURNEY.map((step, i) => (
              <motion.li
                key={step.title}
                initial={{ opacity: 0, x: reduce ? 0 : 30 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, margin: "-80px" }}
                transition={{ duration: 0.55, delay: i * 0.05 }}
                className="relative"
              >
                <span className="absolute -left-10 top-0 grid h-9 w-9 place-items-center rounded-full border-2 border-primary bg-surface text-primary sm:-left-14 sm:h-11 sm:w-11">
                  <step.icon size={17} aria-hidden />
                </span>
                <div className="panel p-5 sm:p-6">
                  <p className="font-mono text-xs text-faint">Step {i + 1}</p>
                  <h3 className="mt-1 font-display text-xl text-text">{step.title}</h3>
                  <p className="mt-2 font-ui text-sm leading-relaxed text-muted">{step.body}</p>
                </div>
              </motion.li>
            ))}
          </ol>
        </Section>

        {/* ----------------------------------------------------- principles */}
        <Section eyebrow="Principles" title="What the system will and will not do">
          <motion.div variants={stagger} initial="hidden" whileInView="show" viewport={{ once: true, margin: "-60px" }} className="mt-10 grid gap-5 sm:grid-cols-2">
            {PRINCIPLES.map((p) => (
              <motion.div key={p.title} variants={fadeUp} className="flex gap-4 rounded-panel border border-border bg-surface p-6">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-primary-soft text-primary">
                  <p.icon size={20} aria-hidden />
                </span>
                <div>
                  <h3 className="font-display text-lg text-text">{p.title}</h3>
                  <p className="mt-1.5 font-ui text-sm leading-relaxed text-muted">{p.body}</p>
                </div>
              </motion.div>
            ))}
          </motion.div>
          <motion.p
            variants={fadeUp}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true }}
            className="mt-8 rounded-panel border border-warning-soft bg-warning-soft p-5 font-ui text-sm leading-relaxed text-text"
          >
            <strong>A matching fingerprint proves that a file is unchanged — not that it is true.</strong> Whether a recording shows what really
            happened, or was lawfully obtained, remains a matter for investigation and for the court. Generated certificates and forms are templates
            to be reviewed by a legal practitioner.
          </motion.p>
        </Section>

        {/* ---------------------------------------------------------- stack */}
        <Section tint eyebrow="Technology" title="Built on open, well-tested foundations">
          <motion.dl variants={stagger} initial="hidden" whileInView="show" viewport={{ once: true, margin: "-60px" }} className="mt-10 grid gap-px overflow-hidden rounded-panel border border-border bg-border sm:grid-cols-2">
            {STACK.map((row) => (
              <motion.div key={row.label} variants={fadeUp} className="bg-surface p-5">
                <dt className="font-ui text-xs font-bold uppercase tracking-[0.14em] text-primary">{row.label}</dt>
                <dd className="mt-1.5 font-ui text-sm leading-relaxed text-text">{row.value}</dd>
              </motion.div>
            ))}
            <motion.div variants={fadeUp} className="bg-surface p-5">
              <dt className="flex items-center gap-2 font-ui text-xs font-bold uppercase tracking-[0.14em] text-primary">
                <Smartphone size={14} aria-hidden /> Install
              </dt>
              <dd className="mt-1.5 font-ui text-sm leading-relaxed text-text">Install it on Android from the browser menu, or with the Install button.</dd>
            </motion.div>
          </motion.dl>
        </Section>

        {/* ------------------------------------------------------ developer */}
        <Section eyebrow="Developer" title="Designed and developed by Sai Randive">
          <motion.div
            initial={{ opacity: 0, scale: reduce ? 1 : 0.97 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="mt-10 grid gap-6 rounded-[28px] border border-primary-ring bg-primary-soft p-6 sm:p-10 md:grid-cols-[auto_1fr] md:items-center"
          >
            <span className="grid h-24 w-24 place-items-center rounded-full bg-primary-fill font-display text-3xl text-on-primary shadow-card">SR</span>
            <div>
              <p className="font-ui text-base leading-relaxed text-text">
                Sai Randive designed and built NyaySetu end to end — the smart contracts, the verification server, the role portals, the field app,
                the court documents and the evaluation that measures them.
              </p>
              <div className="mt-5 flex flex-wrap gap-3">
                <a
                  href="https://github.com/SAI-RANDIVE/NyaySetu"
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-2 rounded-full bg-surface px-5 py-2.5 font-ui text-sm font-semibold text-text shadow-card transition hover:-translate-y-0.5"
                >
                  <Github size={16} aria-hidden /> Source on GitHub
                </a>
                <Link to="/verify" className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-5 py-2.5 font-ui text-sm font-semibold text-text transition hover:border-primary">
                  <ShieldCheck size={16} aria-hidden /> Try verification
                </Link>
              </div>
            </div>
          </motion.div>
        </Section>
      </main>

      <footer className="border-t border-border bg-surface px-4 py-8 sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <LogoMark size={30} />
            <p className="font-ui text-sm text-muted">NyaySetu · Evidence, summons and bail records you can verify.</p>
          </div>
          <nav aria-label="Footer" className="flex flex-wrap items-center gap-5 font-ui text-sm">
            <Link to="/" className="text-muted hover:text-primary">Home</Link>
            <Link to="/verify" className="text-muted hover:text-primary">Verify</Link>
            <Link to="/handbook" className="text-muted hover:text-primary">Handbook</Link>
            <span className="inline-flex items-center gap-1.5 text-muted">
              <Globe2 size={14} aria-hidden /> Developed by Sai Randive
            </span>
          </nav>
        </div>
      </footer>
    </div>
  );
}

