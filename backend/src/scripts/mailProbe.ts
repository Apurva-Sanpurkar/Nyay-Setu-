/**
 * Answers the one question an SMTP failure never answers by itself: is it the
 * network, or is it the password?
 *
 *   npm run mail:probe                          uses backend/.env
 *   npm run mail:probe -- <host> <user> <pass>   probes something else
 *
 * WHY THIS EXISTS
 *   Every SMTP misconfiguration produces the same shrug from a mail library. A
 *   blocked port, an unroutable address, a wrong username and a wrong password all
 *   surface as "it did not work", and the two halves of that have nothing in common
 *   as fixes: one is a hosting decision, the other is a credential. Hours go into
 *   re-pasting a password that was always correct.
 *
 *   So this tries every port a relay might listen on and reports, for each one,
 *   which of the two happened:
 *
 *     unreachable        the packets did not arrive. The port is blocked. No
 *                        credential will ever fix this one.
 *     credential refused the server answered and said no. The port is fine and the
 *                        username or password is wrong.
 *
 *   A row of "unreachable" means move the API to a host that permits SMTP, or send
 *   over HTTPS. A row of "credential refused" means the network is fine and the
 *   answer is in the provider's dashboard.
 *
 * 2525 is included because it is the one that matters on a container host. It is
 * not a registered SMTP port, so platforms that block 25, 465 and 587 frequently
 * leave it open, and Brevo, Mailgun and SendGrid all listen there for that reason.
 */
import nodemailer from "nodemailer";
import { env } from "../config/env";

const PORTS = [587, 2525, 465, 25];

interface Outcome {
  port: number;
  ok: boolean;
  ms: number;
  reachable: boolean;
  detail: string;
}

async function probe(host: string, port: number, user: string, pass: string): Promise<Outcome> {
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    // IPv4 for the same reason the mailer pins it: smtp hosts publish AAAA records
    // and most containers have no IPv6 route, which fails as ENETUNREACH and would
    // be reported here as "unreachable" for the wrong reason.
    family: 4,
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 12_000,
  } as unknown as Parameters<typeof nodemailer.createTransport>[0]);

  const started = Date.now();
  try {
    await transport.verify();
    return { port, ok: true, ms: Date.now() - started, reachable: true, detail: "authenticated" };
  } catch (error) {
    const err = error as { message?: string; code?: string; responseCode?: number };
    const ms = Date.now() - started;

    // A response code of any kind means the server spoke to us, so the port is
    // open whatever it then said. EAUTH likewise: you cannot fail authentication
    // against a host you never reached.
    const reachable = Boolean(err.responseCode) || err.code === "EAUTH";

    return {
      port,
      ok: false,
      ms,
      reachable,
      detail: reachable
        ? `credential refused — ${err.responseCode ?? ""} ${(err.message ?? "").slice(0, 90)}`.trim()
        : `unreachable — ${err.code ?? ""} ${(err.message ?? "").slice(0, 60)}`.trim(),
    };
  } finally {
    transport.close();
  }
}

function mask(value: string): string {
  if (value.includes("@")) return value.replace(/(.).*(@.*)/, "$1•••$2");
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : "•••";
}

async function main(): Promise<void> {
  const [argHost, argUser, argPass] = process.argv.slice(2);

  const host = argHost ?? env.SMTP_HOST;
  const user = argUser ?? env.SMTP_USER;
  const pass = argPass ?? env.SMTP_PASSWORD;

  if (!host || !user || !pass) {
    console.error(
      [
        "",
        "  Nothing to probe. Either fill in SMTP_HOST, SMTP_USER and SMTP_PASSWORD in",
        "  backend/.env, or pass them directly:",
        "",
        "    npm run mail:probe -- smtp-relay.brevo.com 9a1b2c001@smtp-brevo.com xsmtpsib-…",
        "",
      ].join("\n")
    );
    process.exit(1);
  }

  console.log(`\n  ${host}    login ${mask(user)}    password ${mask(pass)}\n`);

  const outcomes: Outcome[] = [];
  for (const port of PORTS) {
    const outcome = await probe(host, port, user, pass);
    outcomes.push(outcome);

    const status = outcome.ok ? "WORKS" : outcome.reachable ? "reachable" : "blocked";
    console.log(
      `  ${String(port).padEnd(6)} ${status.padEnd(10)} ${String(outcome.ms + "ms").padEnd(8)} ${outcome.detail}`
    );
  }

  const working = outcomes.filter((o) => o.ok);
  const reachable = outcomes.filter((o) => o.reachable);

  console.log("");
  if (working.length > 0) {
    const best = working[0].port;
    console.log(`  Use SMTP_PORT=${best}.`);
    if (best !== env.SMTP_PORT) {
      console.log(`  (backend/.env currently says ${env.SMTP_PORT}.)`);
    }
  } else if (reachable.length > 0) {
    console.log(`  The network is fine — ports ${reachable.map((o) => o.port).join(", ")} answered.`);
    console.log("  The username or password is wrong. Nothing about hosting will change that.");
    if (/brevo|sendinblue/i.test(host)) {
      console.log("");
      console.log("  For Brevo, the SMTP login is NOT your account email. Find it at");
      console.log("  SMTP & API -> SMTP -> the 'Login' field. It usually looks like");
      console.log("  9a1b2c001@smtp-brevo.com, and the password is the xsmtpsib- key.");
    }
  } else {
    console.log("  Every port was blocked. This machine cannot send SMTP at all.");
    console.log("  Run the API somewhere that permits it, or send over HTTPS with an API key.");
  }
  console.log("");

  process.exit(working.length > 0 ? 0 : 1);
}

void main();
