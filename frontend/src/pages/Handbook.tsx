import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Ban,
  BookOpen,
  Camera,
  CheckCircle2,
  ChevronRight,
  Clock,
  Fingerprint,
  FlaskConical,
  Gavel,
  Info,
  KeyRound,
  Lock,
  Mail,
  MapPin,
  Menu,
  Scale,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  Users,
  X,
  XCircle,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import type { Role } from "../lib/api";
import { ROLE_HOME, ROLE_LABEL } from "../lib/format";
import { Reveal } from "../components/ui";
import { StatusChip } from "../components/trust";
import { LogoMark } from "../components/Logo";
import { ScrollProgress, ScrollToTop } from "../components/scroll";

/**
 * The handbook.
 *
 * Written for somebody who has never seen the platform and does not know what a
 * hash is. That shapes three choices:
 *
 *   - It explains the one idea (a digest) before any screen, because every other
 *     concept here is downstream of it and none of them land without it.
 *   - The role walkthroughs are tabs, not a long scroll. A police officer should
 *     not have to read the judge's workflow to find their own, and a person
 *     reading on a phone at a scene has no patience for that.
 *   - It is public. A defence lawyer or an accused person needs to understand
 *     what the system claims about them before they have an account, and putting
 *     this behind a login would defeat the point.
 */

/* ============================================================ content ===== */

interface Step {
  title: string;
  body: string;
  note?: string;
  warning?: string;
}

interface RoleGuide {
  role: Role;
  icon: typeof Camera;
  oneLine: string;
  whatYouSee: string;
  steps: Step[];
  cannot: string[];
}

const ROLE_GUIDES: RoleGuide[] = [
  {
    role: "police",
    icon: Camera,
    oneLine: "You register the FIR and capture evidence at the scene.",
    whatYouSee:
      "A dashboard with your assigned cases, a capture screen built for a phone held in one hand, and the chain of custody for everything you have collected.",
    steps: [
      {
        title: "Register the FIR",
        body:
          "From the dashboard, choose Register FIR. The FIR number you type becomes the permanent on-chain identifier for this case, derived by hashing it, so type it exactly as it appears on the paper record.",
        warning:
          "The FIR number cannot be corrected afterwards. A typo means a new case and an orphaned old one.",
      },
      {
        title: "Open Capture evidence",
        body:
          "Pick the case, then photograph the item or attach a file. The moment you choose it, your browser or phone computes its SHA-256 digest and shows you the result. Nothing has been uploaded yet.",
        note:
          "Look at that digest. It is the number about to be written to a public blockchain, and you are seeing it before it is committed, not being told afterwards what was recorded for you.",
      },
      {
        title: "Capture your position",
        body:
          "The app asks for a location fix. The coordinates and the timestamp go on chain beside the digest, which is what turns 'collected at the scene' from a claim into a record.",
        warning:
          "A refused location permission stops the capture. That is deliberate: evidence with no provable place of collection is much weaker in court.",
      },
      {
        title: "Register on chain",
        body:
          "The button stays unavailable until the case, the file and the position all exist. Pressing it encrypts the file, pins it, writes the transaction, and shows you the transaction hash.",
        note:
          "If intake screening flags the item, you will see why in plain language. A flag is not an accusation; it is a prompt for somebody to look. It is anchored on chain and cannot be removed later, including by an administrator.",
      },
      {
        title: "Hand it to the laboratory",
        body:
          "You do nothing further. The item appears in the laboratory's intake queue, and the analyst there re-hashes what physically arrived and confirms it matches. Custody is confirmed by whoever receives it, never by whoever sends it.",
      },
    ],
    cannot: [
      "Issue a summons or grant bail; both belong to the court.",
      "Accept custody on the laboratory's behalf.",
      "Remove or alter an intake flag once it is anchored.",
    ],
  },
  {
    role: "forensic_lab",
    icon: FlaskConical,
    oneLine: "You confirm that what arrived is what was collected, then anchor your report.",
    whatYouSee:
      "An intake queue of items still at the scene stage, each showing the digest registered when it was collected, so you can compare before you open anything.",
    steps: [
      {
        title: "Read the queue",
        body:
          "Each waiting item shows its registered digest in full. Anything flagged at collection carries the reasons, so you know what to look at before you begin.",
      },
      {
        title: "Re-hash what you physically received",
        body:
          "Open the item and choose the file you were handed. Your browser hashes it and compares against the registered digest. A green banner means they match; a red one means they do not.",
        note:
          "You are not taking anyone's word for it. The comparison happens on your machine, against a value recorded before the item left the scene.",
      },
      {
        title: "Accept custody, or do not",
        body:
          "If the digests match, accepting moves custody to the laboratory and writes that confirmation on chain with your role attached. If they do not match, submit it anyway.",
        note:
          "Submitting a mismatch is the right thing to do. The system records the failed check permanently and refuses the transfer, so the discrepancy becomes part of the record rather than a conversation nobody can prove happened.",
      },
      {
        title: "Anchor the report",
        body:
          "While the item is in your custody, Anchor a report writes the digest of your conclusion on chain. The text itself stays in the database, where it can be read and searched.",
        warning:
          "This is write-once. A conclusion cannot be quietly revised later, which is the point. Be sure before you anchor.",
      },
    ],
    cannot: [
      "Anchor a second report for the same item.",
      "Accept custody for the prosecutor.",
      "Edit an item's registered digest. Nobody can.",
    ],
  },
  {
    role: "prosecutor",
    icon: ScrollText,
    oneLine: "You take custody for trial and review the chain behind every item.",
    whatYouSee:
      "Items the laboratory has finished with, the service status of every summons on your cases, and an estimate of how long each case is likely to take.",
    steps: [
      {
        title: "Accept custody of examined evidence",
        body:
          "Items appear once the laboratory is done. As at every other hop, you re-hash the artefact you received and confirm it matches before custody moves.",
      },
      {
        title: "Read the chain of custody",
        body:
          "Every item shows its full trail: who confirmed it, when, with which digest, and the transaction that recorded each step. Grey stages have not happened yet, so you can see where an item is and where it should go next.",
        note:
          "The refused-attempt counter on an item is worth checking. A non-zero value means somebody submitted a file that did not match, and that attempt is on chain.",
      },
      {
        title: "Watch service of process",
        body:
          "The summons board shows PENDING, ACKNOWLEDGED or NOT DELIVERED for every notice on your cases, read from the contract rather than from a register somebody maintains by hand.",
      },
      {
        title: "Estimate disposal time",
        body:
          "Estimate disposal time gives a range in days from the case's characteristics. Use it for listing priority.",
        warning:
          "The model is trained on synthetic data because per-case data is not published. It is a planning aid and nothing more.",
      },
    ],
    cannot: [
      "Issue a summons or grant bail; both belong to the court.",
      "Register new evidence.",
      "See another prosecutor's cases unless you are assigned to them.",
    ],
  },
  {
    role: "judge",
    icon: Gavel,
    oneLine: "You issue summons, grant bail with enforceable conditions, and see every breach.",
    whatYouSee:
      "A court dashboard that puts anything demanding attention above the routine lists: summons that went unanswered, and bail orders currently in breach.",
    steps: [
      {
        title: "Issue a summons",
        body:
          "From the summons register, fill in the recipient, their Aadhaar number and the notice text. The Aadhaar number is converted to a one-way token the instant it arrives and then discarded; only the token reaches the database or the chain.",
        note:
          "The window defaults to 72 hours. The contract enforces it: once it closes without an acknowledgement, the status reads NOT DELIVERED whether or not anybody is looking.",
      },
      {
        title: "Watch for non-delivery",
        body:
          "You do not have to chase it. The dashboard raises unanswered summons to the top, and if email is configured you receive a message when a window closes, because a sweep at two in the morning is not something anybody is watching.",
      },
      {
        title: "Assess risk before granting bail",
        body:
          "On the bail screen, press Assess before you grant anything. You get a band, a score and the factors that moved it.",
        warning:
          "Advisory only, and trained on synthetic data. It is an input to your decision, never a substitute for it, and the screen says so.",
      },
      {
        title: "Grant bail",
        body:
          "Choose the conditions, set the residence coordinates, the permitted radius and the check-in interval. The conditions are written on chain in the order you chose them, and the compliance view returns one flag per condition at the same index.",
        note:
          "For a live demonstration set the interval to one hour. For a real order, 168 hours is weekly.",
      },
      {
        title: "Read the compliance board",
        body:
          "Each accused shows a score out of 100, when their next check-in falls due, and whether they are currently overdue. Green is compliant, red is not, and every number is computed by the contract so anyone can reproduce it.",
      },
      {
        title: "Record a breach only a person can see",
        body:
          "Geo-fence breaches and missed check-ins are detected without anyone reporting them. Contacting a witness is not, so Report breach exists for those and writes them on chain too.",
      },
    ],
    cannot: [
      "Alter a check-in or a violation once recorded.",
      "Grant bail twice on the same case.",
      "Change a summons after issuing it; its hash is anchored.",
    ],
  },
  {
    role: "defence_lawyer",
    icon: ShieldCheck,
    oneLine: "You verify the evidence yourself, against the chain, without trusting the prosecution.",
    whatYouSee:
      "A verification portal and read-only access to the chain of custody for cases you are assigned to. No download route and no write access to any prosecution record.",
    steps: [
      {
        title: "Choose the item",
        body:
          "Pick the case, then the evidence item. You will see when and where it was collected, its current custody stage, and how many non-matching files have been submitted for it and refused.",
      },
      {
        title: "Hash the file you were disclosed",
        body:
          "Choose the file you received through disclosure. Your browser computes its digest. The file is not uploaded; only the digest is sent.",
      },
      {
        title: "Verify against the chain",
        body:
          "The answer is read from the blockchain, not from the prosecution's database. This is the part that matters: if their database had been altered, a comparison against it would agree with the alteration. A comparison against the chain would not.",
        note:
          "You also get a separate finding: whether their database still agrees with the chain. A disagreement there is a statement about their records, independent of your file.",
      },
      {
        title: "Your check becomes part of the record",
        body:
          "The verification is itself anchored, so the fact that you checked and what you found are on chain. This is the only write counsel has, and it touches no prosecution record.",
      },
    ],
    cannot: [
      "Download evidence files. Disclosure happens through the court, as it does now.",
      "Be granted write access to a case. The system downgrades it to read even if an administrator tries.",
      "See prosecution case notes or the summons register.",
    ],
  },
  {
    role: "accused",
    icon: Scale,
    oneLine: "You acknowledge summons and file bail check-ins, and you can prove you did.",
    whatYouSee:
      "A plain list of what is required of you and by when. Deadlines are shown as countdowns, because seventeen hours left is more useful than a timestamp.",
    steps: [
      {
        title: "Acknowledge a summons",
        body:
          "Open the summons, read it, then acknowledge. You will need a location fix and a one-time code sent to the mobile registered against your Aadhaar.",
        note:
          "This protects you as much as the court. Once acknowledged, nobody can claim you were not served, and nobody can claim you acknowledged at some other time or place.",
      },
      {
        title: "Watch the window",
        body:
          "A summons has a limited window, usually 72 hours. If it closes without your acknowledgement, the court is told the summons could not be served and may proceed on that basis.",
        warning:
          "There is no way to acknowledge late. If you have missed it, contact the court registry directly.",
      },
      {
        title: "File a bail check-in",
        body:
          "Capture your position, then request a code. Before you confirm anything, the screen shows how far you are from your declared residence and whether that is inside the permitted radius.",
        note:
          "You are told before you submit, not after. If you are outside the area, the button says so plainly.",
      },
      {
        title: "Keep your score up",
        body:
          "Your compliance score starts at 100. A missed check-in costs 15, leaving the permitted area costs 25, and a breach reported by the court costs 20. The next due date is always on screen.",
      },
    ],
    cannot: [
      "Remove a recorded breach. Nobody can.",
      "Check in for somebody else; the code goes to your registered mobile.",
      "See the case file, other parties' evidence, or the prosecution's notes.",
    ],
  },
  {
    role: "court_admin",
    icon: Users,
    oneLine: "You manage accounts, case assignments and the audit trail.",
    whatYouSee:
      "An overview of the whole system, including whether every subsystem it depends on is actually running, and both layers of the audit trail.",
    steps: [
      {
        title: "Check subsystem health first",
        body:
          "The overview says whether the database, the chain, evidence storage, the model service, email and identity are configured and answering. When somebody reports a problem, look here before anywhere else.",
        note:
          "Watch the keeper wallet balance. It relays every citizen action, and at zero every check-in and acknowledgement fails.",
      },
      {
        title: "Add participants",
        body:
          "Create an account with a role, and optionally an Aadhaar number. The number is validated against its checksum, converted to a one-way token and discarded; only the token and the last four digits are kept.",
        warning:
          "An account without an Aadhaar token cannot take part in any OTP flow, so an accused person needs one before they can acknowledge anything.",
      },
      {
        title: "Assign people to cases",
        body:
          "This is the single control that grants access to everything. Being a judge is not enough; the judge must be assigned. Defence counsel is always downgraded to read-only, even if write is requested.",
      },
      {
        title: "Read both audit layers",
        body:
          "API actions record what was attempted, including refused attempts that changed no row. Row changes come from database triggers, so a direct edit is captured whatever made it.",
        note:
          "A refused tamper attempt is invisible to a row-diff audit, which is exactly why there are two layers.",
      },
      {
        title: "Deactivate an account",
        body:
          "Disabling an account revokes its live sessions immediately, because sessions are held server-side rather than as self-contained tokens.",
      },
    ],
    cannot: [
      "Grant bail or issue a summons in a judge's place.",
      "Read an Aadhaar number. They are not stored.",
      "Delete an audit entry.",
    ],
  },
];

const BADGES: { chip: React.ReactNode; meaning: string }[] = [
  {
    chip: <StatusChip tone="success" label="Hash verified" icon={<ShieldCheck size={11} />} />,
    meaning:
      "The file matches the digest recorded on chain. This is the only badge that means verified, and it is never shown speculatively.",
  },
  {
    chip: <StatusChip tone="danger" label="Hash mismatch" icon={<XCircle size={11} />} />,
    meaning:
      "The file does not match. Either it has been altered since collection, or it is a different file. Both are findings worth raising.",
  },
  {
    chip: <StatusChip tone="info" label="Anchored on chain" icon={<Fingerprint size={11} />} />,
    meaning:
      "There is a blockchain record to verify against, but nobody has run a check yet. Run one to turn this green or red.",
  },
  {
    chip: <StatusChip tone="neutral" label="Not anchored" icon={<ShieldAlert size={11} />} />,
    meaning:
      "No blockchain record exists yet, so there is nothing to verify against. Grey, never green: presenting this as verified is exactly the failure this system exists to prevent.",
  },
  {
    chip: <StatusChip tone="warning" label="Pending" icon={<Clock size={11} />} />,
    meaning: "A summons whose acknowledgement window is still open.",
  },
  {
    chip: <StatusChip tone="success" label="Acknowledged" icon={<CheckCircle2 size={11} />} />,
    meaning:
      "The recipient authenticated with a one-time code and their position was recorded. Service is proved.",
  },
  {
    chip: <StatusChip tone="danger" label="Not delivered" icon={<XCircle size={11} />} />,
    meaning:
      "The window closed unanswered. The contract reports this itself; nobody had to notice.",
  },
  {
    chip: <StatusChip tone="warning" label="Flagged at intake" icon={<AlertTriangle size={11} />} />,
    meaning:
      "Screening found something unusual at collection, with reasons you can check. A prompt to look, not a finding of tampering, and it cannot be removed.",
  },
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "Do I need to understand blockchain to use this?",
    a: "No. You need one idea: a file can be reduced to a short number, and changing even one byte of the file changes that number completely. Everything else is the interface doing the work. The word blockchain only means the number is stored somewhere nobody in the case controls.",
  },
  {
    q: "Is my evidence file public because it is on a blockchain?",
    a: "No, and this is the most common misunderstanding. The file is never on the blockchain. Only its digest is, which reveals nothing about the contents. The file itself is encrypted with AES-256 before it is stored, and the key never leaves the server.",
  },
  {
    q: "Why two different one-time codes?",
    a: "They answer different questions. The code emailed when you sign in proves you control the account. The code for acknowledging a summons or filing a check-in goes to the mobile registered against your Aadhaar and proves a specific person did a specific legal act. Treating them as interchangeable would weaken the second one.",
  },
  {
    q: "What if I lose my phone signal at a scene?",
    a: "Registration needs a connection, because the transaction has to reach the chain. Capture the item and the position when you have signal. The digest is computed on the device either way, so nothing about the file changes while you wait.",
  },
  {
    q: "Can an administrator change something after the fact?",
    a: "They can change database rows, and both audit layers will record it. What they cannot change is anything anchored on chain: a digest, a custody confirmation, a check-in, a violation, an intake flag. If the database and the chain disagree, the verification screen says so, and the chain is authoritative.",
  },
  {
    q: "What happens if I submit the wrong file by mistake?",
    a: "It is refused and the mismatch is recorded. That is not a black mark against you; the record shows a check was run and failed, not who was at fault. Find the right file and submit again.",
  },
  {
    q: "The system says a subsystem is unavailable. Is my work lost?",
    a: "No. Each part degrades separately. If the model service is down, screening reports itself skipped rather than claiming an item is clean. If email is down, sign-in falls back to a password. If the chain is unreachable, anything not yet anchored is held and clearly marked as not anchored, rather than being shown as verified.",
  },
  {
    q: "Why is the defence allowed to see the evidence chain at all?",
    a: "Because a verification nobody can perform proves nothing. The point of the design is that counsel can check integrity without trusting the prosecution. They get the custody trail and the verification tool, and no write access to prosecution records and no file downloads.",
  },
];

const GLOSSARY: { term: string; plain: string }[] = [
  {
    term: "Digest, or hash",
    plain:
      "A short fixed-length number computed from a file. Change one byte and it changes completely. You cannot work backwards from the number to the file, which is why publishing it reveals nothing.",
  },
  {
    term: "Anchored",
    plain:
      "Written into a blockchain transaction. Once anchored, a value cannot be altered by anyone, including whoever runs this system.",
  },
  {
    term: "Chain of custody",
    plain:
      "The record of who held an item, when, and whether the item they held was the same one that was collected. Here each handover is confirmed by the receiver re-computing the digest.",
  },
  {
    term: "Geo-fence",
    plain:
      "A circle around a declared address, with a permitted radius. A bail check-in from outside it is a breach, and the arithmetic runs inside the contract so the result is reproducible.",
  },
  {
    term: "Compliance score",
    plain:
      "A number out of 100 summarising how well a bail order is being kept. Computed by the contract from recorded check-ins and breaches, so anyone can recompute it.",
  },
  {
    term: "Aadhaar token",
    plain:
      "A one-way code derived from an Aadhaar number with a server-side secret. The number itself is never stored. The token can be matched, never decoded.",
  },
  {
    term: "Keeper wallet",
    plain:
      "The account this system uses to submit transactions on a citizen's behalf, after their one-time code has been verified. It exists because no ordinary citizen holds a funded blockchain wallet.",
  },
  {
    term: "Transaction hash",
    plain:
      "The identifier of a single blockchain transaction. On a public network you can paste it into a block explorer and see the record independently of this system.",
  },
];

const SECTIONS = [
  { id: "start", label: "Start here" },
  { id: "idea", label: "The one idea" },
  { id: "bridges", label: "The three bridges" },
  { id: "roles", label: "Your role, step by step" },
  { id: "reading", label: "Reading the interface" },
  { id: "codes", label: "The two one-time codes" },
  { id: "faq", label: "Common questions" },
  { id: "glossary", label: "Glossary" },
  { id: "trouble", label: "When something goes wrong" },
];

/* ============================================================== page ====== */

export default function Handbook() {
  const { user } = useAuth();
  const { theme, toggle } = useTheme();
  const [activeRole, setActiveRole] = useState<Role>(user?.role ?? "police");
  const [activeSection, setActiveSection] = useState("start");
  const [tocOpen, setTocOpen] = useState(false);

  // Follow the reader down the page so the contents list stays useful.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setActiveSection(visible.target.id);
      },
      { rootMargin: "-84px 0px -60% 0px", threshold: 0 }
    );

    SECTIONS.forEach((section) => {
      const node = document.getElementById(section.id);
      if (node) observer.observe(node);
    });
    return () => observer.disconnect();
  }, []);

  // Signing in mid-read should switch the walkthrough to the reader's own role.
  useEffect(() => {
    if (user?.role) setActiveRole(user.role);
  }, [user?.role]);

  const guide = useMemo(
    () => ROLE_GUIDES.find((entry) => entry.role === activeRole) ?? ROLE_GUIDES[0],
    [activeRole]
  );

  return (
    <div className="min-h-screen bg-bg">
      {/* A long document, so how far through it you are is genuinely useful. */}
      <ScrollProgress />
      <ScrollToTop />

      {/* ------------------------------------------------------------ header */}
      <header className="sticky top-0 z-40 border-b border-border bg-bg-elevated/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Link to={user ? ROLE_HOME[user.role] : "/"} aria-label={user ? "Back to your portal" : "NyaySetu home"} className="group flex shrink-0 items-center gap-2.5">
            <LogoMark
              size={38}
              className="transition-transform duration-300 ease-smooth group-hover:scale-105 group-hover:rotate-[-4deg]"
            />
            <span className="hidden sm:block">
              <span className="block font-display text-base leading-none text-text">Handbook</span>
              <span className="block font-ui text-2xs leading-tight text-faint">
                NyaySetu · न्यायसेतु
              </span>
            </span>
          </Link>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={toggle}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              className="grid h-9 w-9 place-items-center rounded-full border border-border font-ui text-xs text-muted transition hover:border-border-strong hover:text-text"
            >
              {theme === "dark" ? "☀" : "☾"}
            </button>

            <Link
              to={user ? ROLE_HOME[user.role] : "/login"}
              className="btn-sheen inline-flex h-9 items-center gap-1.5 rounded-full bg-primary-fill px-4 font-ui text-xs font-bold uppercase tracking-wide text-on-primary transition-all duration-300 hover:-translate-y-0.5 hover:shadow-glow"
            >
              {user ? "Back to my portal" : "Sign in"}
              <ArrowRight size={13} />
            </Link>

            <button
              type="button"
              onClick={() => setTocOpen((open) => !open)}
              aria-label="Contents"
              aria-expanded={tocOpen}
              className="grid h-9 w-9 place-items-center rounded-full border border-border text-text lg:hidden"
            >
              {tocOpen ? <X size={16} /> : <Menu size={16} />}
            </button>
          </div>
        </div>

        {tocOpen && (
          <nav className="animate-menu-in border-t border-border bg-bg-elevated px-4 py-3 lg:hidden">
            <ul className="space-y-0.5">
              {SECTIONS.map((section) => (
                <li key={section.id}>
                  <a
                    href={`#${section.id}`}
                    onClick={() => setTocOpen(false)}
                    className={`block rounded-lg px-3 py-2.5 font-ui text-sm transition ${
                      activeSection === section.id
                        ? "bg-primary-soft font-semibold text-primary"
                        : "text-muted hover:bg-surface-2"
                    }`}
                  >
                    {section.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </header>

      <div className="mx-auto flex max-w-6xl gap-10 px-4 py-10 sm:px-6 sm:py-14">
        {/* ------------------------------------------------------- contents */}
        <aside className="hidden w-52 shrink-0 lg:block">
          <nav className="sticky top-24">
            <p className="mb-3 font-jakarta text-2xs font-bold uppercase tracking-[0.14em] text-faint">
              Contents
            </p>
            <ul className="space-y-0.5 border-l border-border">
              {SECTIONS.map((section) => (
                <li key={section.id}>
                  <a
                    href={`#${section.id}`}
                    className={`-ml-px block border-l-2 py-1.5 pl-3.5 font-ui text-xs transition ${
                      activeSection === section.id
                        ? "border-primary font-semibold text-primary"
                        : "border-transparent text-muted hover:border-border-strong hover:text-text"
                    }`}
                  >
                    {section.label}
                  </a>
                </li>
              ))}
            </ul>

            <div className="mt-6 rounded-card border border-border bg-surface-2 p-3.5">
              <p className="font-ui text-2xs leading-relaxed text-muted">
                Reading time about twelve minutes. The section on your own role is the one that
                matters; the rest can wait until you need it.
              </p>
            </div>
          </nav>
        </aside>

        {/* ---------------------------------------------------------- body */}
        <main className="min-w-0 flex-1">
          {/* ===================================================== start */}
          <section id="start" className="scroll-mt-24">
            <Reveal>
              <p className="mb-3 font-jakarta text-2xs font-bold uppercase tracking-[0.16em] text-primary">
                Start here
              </p>
              <h1 className="font-display text-3xl leading-tight text-text sm:text-4xl">
                What this platform is for
              </h1>

              <div className="mt-5 space-y-4 font-ui text-sm leading-relaxed text-muted">
                <p>
                  There are three moments in a criminal case where the record depends entirely on
                  somebody&apos;s word. Was this evidence altered between the scene and the
                  courtroom? Was the accused actually served with the summons? Did they keep the
                  conditions of their bail? In each case the usual answer is a register, an
                  endorsement or a signed undertaking, and each of those is only as reliable as the
                  person who wrote it.
                </p>
                <p>
                  NyaySetu does not replace any of that paperwork. It adds one thing to it: a short
                  number, recorded in a place that nobody involved in the case controls, against
                  which the claim can be checked later by anybody. That is the whole idea. Everything
                  you will see in the interface is a consequence of it.
                </p>
                <p>
                  You do not need to know anything about blockchains to use this well. You do need
                  the next section, which is two paragraphs long and explains the only technical
                  concept that matters.
                </p>
              </div>
            </Reveal>

            {user && (
              <Reveal delay={0.06}>
                <div className="mt-7 flex items-start gap-3 rounded-card border border-primary-ring bg-primary-soft p-4">
                  <ShieldCheck size={18} className="mt-0.5 shrink-0 text-primary" />
                  <div>
                    <p className="font-ui text-sm font-semibold text-text">
                      You are signed in as {ROLE_LABEL[user.role]}
                    </p>
                    <p className="mt-1 font-ui text-xs leading-relaxed text-muted">
                      The walkthrough below has already jumped to your role.{" "}
                      <a href="#roles" className="font-semibold text-primary hover:underline">
                        Go straight to it
                      </a>
                      .
                    </p>
                  </div>
                </div>
              </Reveal>
            )}
          </section>

          {/* ====================================================== idea */}
          <section id="idea" className="mt-16 scroll-mt-24">
            <Reveal>
              <SectionHeading eyebrow="The one idea" title="A file can be reduced to a number" />

              <div className="mt-5 space-y-4 font-ui text-sm leading-relaxed text-muted">
                <p>
                  Take any file: a photograph, a video, a PDF. There is a standard calculation called
                  SHA-256 that turns it into a 64-character number. The same file always produces the
                  same number. A different file essentially never does.
                </p>
                <p>
                  The useful part is how sensitive it is. Change a single pixel in a photograph, add
                  one space to a document, re-save a video at a slightly different quality, and the
                  number that comes out is completely different. Not slightly different: unrecognisably
                  different.
                </p>
              </div>
            </Reveal>

            <Reveal delay={0.08}>
              <div className="mt-6 space-y-3">
                <HashDemo
                  label="The original bodycam frame"
                  text="bodycam-frame-0001.jpg"
                  hash="0x9f2a4c81e07b3d6a5f18c2be49d70a3ec815b26f4a0d938172ce5b4f60a9d7e3"
                  tone="success"
                />
                <HashDemo
                  label="The same frame, with one pixel changed"
                  text="bodycam-frame-0001.jpg (edited)"
                  hash="0x4d80b1f3c95e26a7048fd3b19c6e5720af83d641e0b2975ca3f8d0e461b5c29a"
                  tone="danger"
                />
              </div>

              <p className="mt-4 font-ui text-xs leading-relaxed text-faint">
                Two digests that share no visible resemblance, from two files that look identical. You
                do not have to compare the files, or trust anybody who has seen them. You compare the
                numbers.
              </p>
            </Reveal>

            <Reveal delay={0.14}>
              <div className="mt-7 grid gap-4 sm:grid-cols-2">
                <IdeaCard
                  icon={<Lock size={17} />}
                  title="It reveals nothing"
                  body="You cannot work backwards from the number to the file. Publishing the digest of a witness statement tells the world nothing about what the witness said, which is why it is safe to put somewhere public."
                />
                <IdeaCard
                  icon={<Fingerprint size={17} />}
                  title="It is computed on your device"
                  body="Your browser or phone does the calculation before anything is uploaded. So the number describes the file as it existed in your hands, and the server can only agree with it or refuse the upload."
                />
              </div>
            </Reveal>
          </section>

          {/* =================================================== bridges */}
          <section id="bridges" className="mt-16 scroll-mt-24">
            <Reveal>
              <SectionHeading
                eyebrow="The three bridges"
                title="Setu means bridge. There are three of them."
              />
              <p className="mt-4 font-ui text-sm leading-relaxed text-muted">
                Each one takes a moment where the record used to rest on an assertion, and replaces
                it with something checkable. They share a case identifier and otherwise work
                independently, so a case can use one without the others.
              </p>
            </Reveal>

            <div className="mt-7 space-y-4">
              <BridgeCard
                icon={Camera}
                name="SaakshyaSetu"
                devanagari="साक्ष्यसेतु"
                subtitle="Evidence Bridge"
                replaces="A custody register that records a transfer happened, not that the item is the same item."
                flow={["Scene", "Laboratory", "Prosecutor", "Court"]}
                body="The digest is computed on the collecting officer's device. At each handover the receiving party re-computes it from what they physically hold and confirms it matches. If it does not, the mismatch is recorded on chain and the transfer is refused, so a rejected tamper attempt leaves a permanent record rather than a conversation nobody can prove happened."
              />
              <BridgeCard
                icon={ScrollText}
                name="SammansSetu"
                devanagari="समन्ससेतु"
                subtitle="Summons Bridge"
                replaces="A process server's endorsement against a flat denial. Cases adjourn for months on exactly this."
                flow={["Issued", "Window open", "Acknowledged, or not"]}
                body="An acknowledgement is a one-time-code-authenticated transaction carrying the time, the coordinates and a device fingerprint. It cannot be produced without the recipient and cannot be back-dated, because the timestamp belongs to the blockchain and not to any server. After 72 hours without one, the status reads NOT DELIVERED on its own."
              />
              <BridgeCard
                icon={Scale}
                name="JaminSetu"
                devanagari="जमानतसेतु"
                subtitle="Bail Bridge"
                replaces="A bail order as a PDF that nobody monitors until something has already gone wrong."
                flow={["Conditions set", "Check-ins", "Breach detected"]}
                body="Conditions are stored on chain and every check-in is a transaction carrying coordinates. The distance calculation runs inside the contract, so a geo-fence breach is reproducible by anyone reading the chain rather than asserted by a server. A missed check-in is computed from the passage of time, because a blockchain cannot react to something that did not happen."
              />
            </div>
          </section>

          {/* ===================================================== roles */}
          <section id="roles" className="mt-16 scroll-mt-24">
            <Reveal>
              <SectionHeading eyebrow="Your role, step by step" title="What you actually do" />
              <p className="mt-4 font-ui text-sm leading-relaxed text-muted">
                Seven roles, seven different screens. Pick yours. Each walkthrough ends with what
                that role deliberately cannot do, because the boundaries are as much a part of the
                design as the capabilities.
              </p>
            </Reveal>

            <Reveal delay={0.06}>
              <div className="mt-6 -mx-4 overflow-x-auto px-4 no-scrollbar sm:mx-0 sm:px-0">
                <div className="flex gap-2 pb-1">
                  {ROLE_GUIDES.map((entry) => {
                    const active = entry.role === activeRole;
                    return (
                      <button
                        key={entry.role}
                        type="button"
                        onClick={() => setActiveRole(entry.role)}
                        className={`inline-flex shrink-0 items-center gap-2 rounded-full border px-4 py-2.5 font-ui text-xs font-semibold transition ${
                          active
                            ? "border-primary bg-primary-soft text-primary"
                            : "border-border text-muted hover:border-border-strong hover:text-text"
                        }`}
                      >
                        <entry.icon size={14} />
                        {ROLE_LABEL[entry.role]}
                        {user?.role === entry.role && (
                          <span className="rounded-full bg-primary px-1.5 py-0.5 text-[9px] font-bold uppercase text-on-primary">
                            You
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </Reveal>

            <div key={activeRole} className="mt-6 animate-menu-in">
              <div className="panel p-6">
                <div className="flex items-start gap-4">
                  <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-primary-soft text-primary">
                    <guide.icon size={22} />
                  </span>
                  <div className="min-w-0">
                    <h3 className="font-display text-2xl leading-tight text-text">
                      {ROLE_LABEL[guide.role]}
                    </h3>
                    <p className="mt-1.5 font-ui text-sm leading-relaxed text-text">
                      {guide.oneLine}
                    </p>
                    <p className="mt-2 font-ui text-xs leading-relaxed text-muted">
                      {guide.whatYouSee}
                    </p>
                  </div>
                </div>
              </div>

              <ol className="mt-5 space-y-4">
                {guide.steps.map((step, index) => (
                  <li key={step.title} className="relative flex gap-4">
                    {index < guide.steps.length - 1 && (
                      <span
                        aria-hidden="true"
                        className="absolute left-[15px] top-9 h-[calc(100%-0.5rem)] w-px bg-border"
                      />
                    )}
                    <span className="relative z-10 mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full border border-primary bg-surface font-ui text-xs font-bold text-primary">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1 pb-1">
                      <h4 className="font-ui text-sm font-semibold text-text">{step.title}</h4>
                      <p className="mt-1.5 font-ui text-sm leading-relaxed text-muted">{step.body}</p>

                      {step.note && (
                        <div className="mt-2.5 flex gap-2.5 rounded-lg border border-primary-ring bg-primary-soft px-3 py-2.5">
                          <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-primary" />
                          <p className="font-ui text-xs leading-relaxed text-text">{step.note}</p>
                        </div>
                      )}

                      {step.warning && (
                        <div className="mt-2.5 flex gap-2.5 rounded-lg border border-warning-soft bg-warning-soft px-3 py-2.5">
                          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />
                          <p className="font-ui text-xs leading-relaxed text-text">{step.warning}</p>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>

              <div className="mt-5 rounded-card border border-border bg-surface-2 p-5">
                <p className="mb-3 flex items-center gap-2 font-ui text-sm font-semibold text-text">
                  <Ban size={15} className="text-faint" />
                  What this role cannot do, by design
                </p>
                <ul className="space-y-2">
                  {guide.cannot.map((item) => (
                    <li key={item} className="flex gap-2.5">
                      <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-faint" />
                      <span className="font-ui text-xs leading-relaxed text-muted">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>

          {/* =================================================== reading */}
          <section id="reading" className="mt-16 scroll-mt-24">
            <Reveal>
              <SectionHeading
                eyebrow="Reading the interface"
                title="What the badges mean"
              />
              <p className="mt-4 font-ui text-sm leading-relaxed text-muted">
                Colour never carries meaning on its own here: every state has an icon and a word as
                well, because roughly one man in twelve cannot reliably separate red from green. Green
                is used only for something that was actually verified, never for probably fine.
              </p>
            </Reveal>

            <Reveal delay={0.06}>
              <div className="mt-6 divide-y divide-border overflow-hidden rounded-panel border border-border">
                {BADGES.map((badge, index) => (
                  <div key={index} className="flex flex-col gap-2.5 bg-surface p-4 sm:flex-row sm:items-start sm:gap-5">
                    <div className="sm:w-48 sm:shrink-0">{badge.chip}</div>
                    <p className="font-ui text-xs leading-relaxed text-muted">{badge.meaning}</p>
                  </div>
                ))}
              </div>
            </Reveal>
          </section>

          {/* ===================================================== codes */}
          <section id="codes" className="mt-16 scroll-mt-24">
            <Reveal>
              <SectionHeading
                eyebrow="The two one-time codes"
                title="Two codes, two different questions"
              />
              <p className="mt-4 font-ui text-sm leading-relaxed text-muted">
                You will meet one-time codes twice, and they are not the same mechanism. Confusing
                them is the easiest way to misunderstand what this system proves.
              </p>
            </Reveal>

            <Reveal delay={0.06}>
              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <div className="panel edge-brand h-full p-5 transition-transform duration-300 ease-smooth hover:-translate-y-1">
                  <span className="mb-3 inline-grid h-10 w-10 place-items-center rounded-2xl bg-info-soft text-info">
                    <Mail size={18} />
                  </span>
                  <h3 className="font-display text-lg text-text">Signing in</h3>
                  <p className="mt-1 font-jakarta text-2xs font-bold uppercase tracking-[0.12em] text-info">
                    By email
                  </p>
                  <p className="mt-3 font-ui text-sm leading-relaxed text-muted">
                    After your password, a six digit code goes to your registered email address. It
                    answers: is this really the person who holds this account?
                  </p>
                  <ul className="mt-4 space-y-2">
                    <Bullet>Valid for ten minutes, once.</Bullet>
                    <Bullet>
                      Tied to the browser that supplied the password, so it cannot be redeemed
                      elsewhere even if somebody reads your inbox.
                    </Bullet>
                    <Bullet>
                      This one is genuinely real: a working mail server delivers it.
                    </Bullet>
                  </ul>
                </div>

                <div className="panel edge-brand h-full p-5 transition-transform duration-300 ease-smooth hover:-translate-y-1">
                  <span className="mb-3 inline-grid h-10 w-10 place-items-center rounded-2xl bg-primary-soft text-primary">
                    <KeyRound size={18} />
                  </span>
                  <h3 className="font-display text-lg text-text">Acting on a case</h3>
                  <p className="mt-1 font-jakarta text-2xs font-bold uppercase tracking-[0.12em] text-primary">
                    By Aadhaar
                  </p>
                  <p className="mt-3 font-ui text-sm leading-relaxed text-muted">
                    Acknowledging a summons or filing a bail check-in needs a code sent to the mobile
                    registered against your Aadhaar. It answers a different question: did this
                    specific person perform this specific legal act?
                  </p>
                  <ul className="mt-4 space-y-2">
                    <Bullet>Bound to one action, so a code for a check-in cannot acknowledge a summons.</Bullet>
                    <Bullet>Five minutes, three attempts, then dead.</Bullet>
                    <Bullet>
                      On this deployment it is <strong className="text-text">simulated</strong>. Reaching
                      the real Aadhaar service needs a government licence that this deployment does not
                      hold, and the interface says so wherever a code appears.
                    </Bullet>
                  </ul>
                </div>
              </div>
            </Reveal>

            <Reveal delay={0.12}>
              <div className="mt-4 flex gap-3 rounded-card border border-border bg-surface-2 p-4">
                <Info size={17} className="mt-0.5 shrink-0 text-muted" />
                <p className="font-ui text-xs leading-relaxed text-muted">
                  Where a simulated code is shown on screen, that is not a bug and it is not hidden.
                  A system that quietly faked an identity check would be worse than one that does not
                  have it, so the notice is deliberate and stays visible.
                </p>
              </div>
            </Reveal>
          </section>

          {/* ======================================================= faq */}
          <section id="faq" className="mt-16 scroll-mt-24">
            <Reveal>
              <SectionHeading eyebrow="Common questions" title="What people ask first" />
            </Reveal>

            <Reveal delay={0.06}>
              <div className="mt-6 space-y-2.5">
                {FAQ.map((item) => (
                  <details
                    key={item.q}
                    className="group edge-brand rounded-card border border-border bg-surface p-4 transition-all duration-300 hover:border-border-strong"
                  >
                    <summary className="flex cursor-pointer list-none items-start justify-between gap-3">
                      <span className="font-ui text-sm font-semibold text-text">{item.q}</span>
                      <ChevronRight
                        size={16}
                        className="mt-0.5 shrink-0 text-faint transition group-open:rotate-90"
                      />
                    </summary>
                    <p className="mt-3 font-ui text-sm leading-relaxed text-muted">{item.a}</p>
                  </details>
                ))}
              </div>
            </Reveal>
          </section>

          {/* ================================================== glossary */}
          <section id="glossary" className="mt-16 scroll-mt-24">
            <Reveal>
              <SectionHeading eyebrow="Glossary" title="Words you will see, in plain English" />
            </Reveal>

            <Reveal delay={0.06}>
              <dl className="mt-6 grid gap-px overflow-hidden rounded-panel border border-border bg-border sm:grid-cols-2">
                {GLOSSARY.map((entry) => (
                  <div key={entry.term} className="bg-surface p-4">
                    <dt className="font-ui text-sm font-semibold text-text">{entry.term}</dt>
                    <dd className="mt-1.5 font-ui text-xs leading-relaxed text-muted">
                      {entry.plain}
                    </dd>
                  </div>
                ))}
              </dl>
            </Reveal>
          </section>

          {/* =================================================== trouble */}
          <section id="trouble" className="mt-16 scroll-mt-24">
            <Reveal>
              <SectionHeading
                eyebrow="When something goes wrong"
                title="What to check, in order"
              />
              <p className="mt-4 font-ui text-sm leading-relaxed text-muted">
                Most problems here are one of five things, and the system tries to tell you which.
                Work down this list before escalating.
              </p>
            </Reveal>

            <Reveal delay={0.06}>
              <div className="mt-6 space-y-3">
                <Trouble
                  symptom="A screen says a required service is not configured"
                  meaning="The blockchain, evidence storage or the model service is not reachable. Your work is not lost; the thing that needs it is unavailable."
                  action="Ask a court administrator to check the system overview, which names the exact subsystem."
                />
                <Trouble
                  symptom="My one-time code never arrived"
                  meaning="Either the mail server rejected it, or the address on your account is wrong."
                  action="If the sign-in screen shows a warning about the mail server, that is the cause. Otherwise ask an administrator to confirm the address on your account."
                />
                <Trouble
                  symptom="A hash mismatch when I accept custody"
                  meaning="The file you hold is not the file that was registered. This is the system working, not failing."
                  action="Submit it anyway so the discrepancy is recorded, then find out which file is the right one. Do not look for a way to bypass the check."
                />
                <Trouble
                  symptom="I cannot see a case I know exists"
                  meaning="Access comes from case assignment, not from your role. Being a judge is not sufficient."
                  action="Ask a court administrator or the presiding judge to assign you to the case."
                />
                <Trouble
                  symptom="A location fix will not complete"
                  meaning="Either permission was refused, or the device cannot see enough satellites."
                  action="Allow location in your browser or phone settings, then move somewhere with a clearer view of the sky. A weak fix is flagged before you submit, so you are not caught out by it."
                />
              </div>
            </Reveal>

            <Reveal delay={0.12}>
              <div className="mt-8 rounded-panel border border-border bg-grad-surface p-6">
                <h3 className="font-display text-xl text-text">That is the whole handbook</h3>
                <p className="mt-2.5 font-ui text-sm leading-relaxed text-muted">
                  If you remember one thing, remember the digest: a short number computed from a file
                  on your own device, stored where nobody in the case can change it. Every screen in
                  this platform is an interface to that one fact.
                </p>
                <div className="mt-5 flex flex-wrap gap-3">
                  <Link
                    to={user ? ROLE_HOME[user.role] : "/login"}
                    className="btn-sheen inline-flex items-center gap-2 rounded-full bg-primary-fill px-5 py-2.5 font-ui text-xs font-bold uppercase tracking-wide text-on-primary transition-all duration-300 hover:-translate-y-0.5 hover:shadow-glow"
                  >
                    {user ? "Back to my portal" : "Sign in and try it"}
                    <ArrowRight size={14} />
                  </Link>
                  <Link
                    to="/"
                    className="inline-flex items-center gap-2 rounded-full border border-border px-5 py-2.5 font-ui text-xs font-semibold uppercase tracking-wide text-muted transition hover:border-border-strong hover:text-text"
                  >
                    <ArrowLeft size={14} />
                    About NyaySetu
                  </Link>
                </div>
              </div>
            </Reveal>
          </section>
        </main>
      </div>
    </div>
  );
}

/* ========================================================= sub-components == */

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <>
      <p className="mb-3 font-jakarta text-2xs font-bold uppercase tracking-[0.16em] text-primary">
        {eyebrow}
      </p>
      <h2 className="font-display text-2xl leading-tight text-text sm:text-3xl">{title}</h2>
    </>
  );
}

function HashDemo({
  label,
  text,
  hash,
  tone,
}: {
  label: string;
  text: string;
  hash: string;
  tone: "success" | "danger";
}) {
  const border = tone === "success" ? "border-success-soft" : "border-danger-soft";
  const colour = tone === "success" ? "text-success" : "text-danger";

  return (
    <div className={`rounded-card border ${border} bg-surface-2 p-4`}>
      <p className="font-ui text-2xs font-semibold uppercase tracking-wider text-faint">{label}</p>
      <p className="mt-1.5 font-mono text-xs text-text">{text}</p>
      <div className="mt-2.5 flex items-start gap-2">
        <span className="mt-0.5 font-ui text-2xs text-faint">SHA-256</span>
        <code className={`hash flex-1 ${colour}`}>{hash}</code>
      </div>
    </div>
  );
}

function IdeaCard({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="panel edge-brand h-full p-5 transition-transform duration-300 ease-smooth hover:-translate-y-1">
      <span className="mb-3 inline-grid h-10 w-10 place-items-center rounded-2xl bg-primary-soft text-primary">
        {icon}
      </span>
      <h3 className="font-display text-lg leading-snug text-text">{title}</h3>
      <p className="mt-2 font-ui text-sm leading-relaxed text-muted">{body}</p>
    </div>
  );
}

function BridgeCard({
  icon: Icon,
  name,
  devanagari,
  subtitle,
  replaces,
  flow,
  body,
}: {
  icon: typeof Camera;
  name: string;
  devanagari: string;
  subtitle: string;
  replaces: string;
  flow: string[];
  body: string;
}) {
  return (
    <article className="panel edge-brand grid gap-6 p-6 transition-transform duration-300 ease-smooth hover:-translate-y-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
      <div>
        <span className="mb-3 inline-grid h-11 w-11 place-items-center rounded-2xl bg-primary-soft text-primary">
          <Icon size={20} />
        </span>
        <h3 className="font-display text-xl leading-tight text-text">{name}</h3>
        <p className="mt-0.5 font-body text-base text-muted">{devanagari}</p>
        <p className="mt-1.5 font-jakarta text-2xs font-bold uppercase tracking-[0.12em] text-primary">
          {subtitle}
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          {flow.map((stage, index) => (
            <span key={stage} className="flex items-center gap-1.5">
              <span className="rounded-md border border-border bg-surface-2 px-2 py-1 font-ui text-2xs text-muted">
                {stage}
              </span>
              {index < flow.length - 1 && <ChevronRight size={11} className="text-faint" />}
            </span>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-3 flex gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2.5">
          <MapPin size={13} className="mt-0.5 shrink-0 text-faint" />
          <span className="font-ui text-xs leading-relaxed text-muted">
            <strong className="text-text">Replaces:</strong> {replaces}
          </span>
        </p>
        <p className="font-ui text-sm leading-relaxed text-muted">{body}</p>
      </div>
    </article>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />
      <span className="font-ui text-xs leading-relaxed text-muted">{children}</span>
    </li>
  );
}

function Trouble({
  symptom,
  meaning,
  action,
}: {
  symptom: string;
  meaning: string;
  action: string;
}) {
  return (
    <div className="edge-brand rounded-card border border-border bg-surface p-4 transition-transform duration-300 ease-smooth hover:-translate-y-0.5">
      <p className="font-ui text-sm font-semibold text-text">{symptom}</p>
      <p className="mt-2 font-ui text-xs leading-relaxed text-muted">
        <strong className="text-text">What it means.</strong> {meaning}
      </p>
      <p className="mt-1.5 font-ui text-xs leading-relaxed text-muted">
        <strong className="text-text">What to do.</strong> {action}
      </p>
    </div>
  );
}
