/**
 * The whole platform on one machine, with no accounts anywhere:
 *
 *   npm run local
 *
 *   1. a Hardhat node on 127.0.0.1:8545
 *   2. the three contracts deployed to it, every role granted to the local keeper
 *   3. the API on :4000 against the in-memory database, seeded with one account
 *      per role (credentials printed once)
 *   4. the web app on :5173
 *
 * Nothing here talks to Supabase, Sepolia, Pinata or a mail server. Everything
 * is discarded when you press Ctrl+C. Use it to try every flow, to rehearse a
 * demonstration, or as the fallback when a public testnet is slow.
 *
 * The keeper key is Hardhat's first default account, which is published in
 * Hardhat's own documentation and worthless off this machine.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Ports are configurable so the local stack can run beside another copy of the
// API or web app (for example your own `npm run api`).
const API_PORT = Number(process.env.LOCAL_API_PORT ?? 4000);
const WEB_PORT = Number(process.env.LOCAL_WEB_PORT ?? 5173);
const HARDHAT_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const children = [];
const skipWeb = process.argv.includes("--no-web");

function run(label, command, args, options) {
  const child = spawn(command, args, { shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"], ...options });
  const prefix = `[${label}]`.padEnd(9);
  const relay = (stream, out) =>
    stream.on("data", (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) out.write(`${prefix} ${line}\n`);
    });
  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stderr);
  children.push(child);
  return child;
}

/** Resolves true if nothing is listening on the port (checked over IPv4 and IPv6). */
async function portFree(port) {
  for (const host of ["127.0.0.1", "::1"]) {
    const taken = await new Promise((resolve) => {
      const socket = net.connect(port, host);
      socket.once("connect", () => (socket.destroy(), resolve(true)));
      socket.once("error", () => resolve(false));
    });
    if (taken) return false;
  }
  return true;
}

async function requireFree(port, what, variable) {
  if (!(await portFree(port))) {
    fatal(new Error(`Port ${port} is already in use, so the ${what} cannot start. Stop whatever is using it, or run with ${variable}=<another port>.`));
  }
}

/** Resolves once something accepts connections on the port, over IPv4 or IPv6. */
function waitForPort(port, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  let flip = false;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      // Vite binds "localhost", which Windows resolves to ::1; Hardhat binds
      // 127.0.0.1. Alternate between the two rather than guessing.
      flip = !flip;
      const socket = net.connect(port, flip ? "127.0.0.1" : "::1");
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", async () => {
        socket.destroy();
        if (Date.now() > until) return reject(new Error(`Nothing listening on ${port} after ${timeoutMs} ms`));
        await sleep(500);
        attempt();
      });
    };
    attempt();
  });
}

function shutdown(code = 0) {
  for (const child of children) {
    try {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
function fatal(error) {
  console.error(error instanceof Error ? error.message : error);
  shutdown(1);
}
process.on("unhandledRejection", (error) => {
  console.error(error instanceof Error ? error.message : error);
  shutdown(1);
});

const roleBlanks = Object.fromEntries(
  ["POLICE", "FORENSIC", "PROSECUTOR", "JUDGE", "DEFENCE", "ACCUSED", "COURT_ADMIN", "KEEPER"].map((r) => [`${r}_ADDRESSES`, ""])
);

console.log("Starting a local Hardhat chain…");
run("chain", "npx", ["hardhat", "node"], { cwd: join(root, "contracts") });
// The first start compiles the contracts, which can take a few minutes.
await waitForPort(8545, 300_000).catch(fatal);

console.log("Deploying the contracts to it…");
const deploy = run("deploy", "npx", ["hardhat", "run", "scripts/deploy.ts", "--network", "localhost"], {
  cwd: join(root, "contracts"),
  env: { ...process.env, ...roleBlanks, BAIL_GRACE_PERIOD_SECONDS: "0" },
});
const deployed = await new Promise((resolve) => deploy.on("exit", resolve));
if (deployed !== 0) {
  console.error("Deployment failed.");
  shutdown(1);
}

await requireFree(API_PORT, "API", "LOCAL_API_PORT");
if (!skipWeb) await requireFree(WEB_PORT, "web app", "LOCAL_WEB_PORT");
console.log("Starting the API on the in-memory database…");
run("api", "npx", ["tsx", ...(process.argv.includes("--watch") ? ["watch"] : []), "src/index.ts"], {
  cwd: join(root, "backend"),
  env: {
    ...process.env,
    NODE_ENV: "development",
    NYAY_DB: "memory",
    DEV_SEED: "true",
    PORT: String(API_PORT),
    SUPABASE_URL: "http://memory.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "memory-service-role-key-not-a-secret",
    AADHAAR_TOKEN_PEPPER: process.env.AADHAAR_TOKEN_PEPPER ?? "local-pepper-0123456789abcdef0123456789",
    EVIDENCE_ENCRYPTION_KEY: process.env.EVIDENCE_ENCRYPTION_KEY ?? "22".repeat(32),
    CHAIN_RPC_URL: "http://127.0.0.1:8545",
    CHAIN_PRIVATE_KEY: HARDHAT_KEY_0,
    CHAIN_NETWORK: "localhost",
    DEPLOYED_ARTIFACT: "",
    EVIDENCE_CHAIN_ADDRESS: "",
    SUMMONS_CHAIN_ADDRESS: "",
    BAIL_CHAIN_ADDRESS: "",
    PINATA_JWT: "",
    PINATA_API_KEY: "",
    PINATA_API_SECRET: "",
    LOCAL_BLOB_DIR: "storage/local-stack",
    SMTP_HOST: "",
    SMTP_USER: "",
    SMTP_PASSWORD: "",
    BREVO_API_KEY: "",
    RESEND_API_KEY: "",
    LOGIN_OTP_ENABLED: "false",
    EMAIL_NOTIFICATIONS_ENABLED: "false",
    AI_SERVICE_URL: process.env.LOCAL_AI_SERVICE_URL ?? "",
    INDEXER_MAX_RANGE: "2000",
    SWEEP_INTERVAL_MS: "15000",
    CORS_ORIGINS: `http://localhost:${WEB_PORT},http://127.0.0.1:${WEB_PORT}`,
    COOKIE_SAMESITE: "strict",
    COOKIE_DOMAIN: "",
    OTP_PROVIDER: "sandbox",
    OTP_ECHO_IN_RESPONSE: "true",
    CRON_SECRET: "",
    PUBLIC_APP_URL: `http://localhost:${WEB_PORT}`,
  },
});
await waitForPort(API_PORT, 180_000).catch(fatal);

if (!skipWeb) {
  console.log("Starting the web app…");
  run("web", "npx", ["vite", "--port", String(WEB_PORT), "--strictPort"], {
    cwd: join(root, "frontend"),
    env: { ...process.env, VITE_API_BASE: "", VITE_API_PROXY: `http://127.0.0.1:${API_PORT}` },
  });
  await waitForPort(WEB_PORT, 180_000).catch(fatal);
}

console.log(
  [
    "",
    "  NyaySetu is running locally.",
    skipWeb ? "" : `    Web app   http://localhost:${WEB_PORT}`,
    `    API       http://localhost:${API_PORT}/api/health`,
    "    Chain     http://127.0.0.1:8545  (Hardhat, chain 31337)",
    "  The accounts and their password are printed above by [api]. Ctrl+C stops everything.",
    "",
  ].join("\n")
);
