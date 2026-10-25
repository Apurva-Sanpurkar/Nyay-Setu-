import { CloudOff, RefreshCw, Terminal } from "lucide-react";
import { apiBaseConfigured, apiOrigin, isDeployedBuild } from "../lib/api";
import { Button } from "./ui";
import { LogoMark } from "./Logo";

/**
 * Shown when the app cannot reach its API at all.
 *
 * This exists because the failure it describes used to be invisible. `/me` would
 * fail for a reason that was not 401, the router would read "no session" and
 * redirect to sign-in, sign-in would fail the same way, and the person looking at
 * it would conclude that the portal was broken. The cause — a missing API
 * address, a CORS list that does not name this site, a sleeping free-tier
 * instance — was only visible in a browser console nobody opens.
 *
 * So the app says which address it tried and what is worth checking, in the order
 * things actually go wrong. A blank screen is never the honest answer.
 */
export function ApiUnreachable({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="grid min-h-screen place-items-center bg-bg px-5 py-10">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex items-center gap-3">
          <LogoMark size={42} />
          <span>
            <span className="block font-display text-lg leading-none text-text">NyaySetu</span>
            <span className="block font-ui text-2xs leading-tight text-muted">न्यायसेतु</span>
          </span>
        </div>

        <div className="panel p-6">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-danger-soft text-danger">
              <CloudOff size={19} />
            </span>
            <div className="min-w-0">
              <h1 className="font-display text-xl leading-tight text-text">
                The API is not answering
              </h1>
              <p className="mt-1.5 font-ui text-xs leading-relaxed text-muted">{message}</p>
            </div>
          </div>

          <dl className="mt-5 space-y-2 rounded-card border border-border bg-surface-raised px-4 py-3">
            <Row label="Requests are going to" value={apiOrigin} mono />
            <Row
              label="VITE_API_BASE"
              value={apiBaseConfigured ? "set" : "not set"}
              tone={apiBaseConfigured || !isDeployedBuild ? "ok" : "bad"}
            />
            <Row label="Build" value={isDeployedBuild ? "production" : "development"} />
          </dl>

          <div className="mt-5">
            <p className="font-ui text-2xs font-semibold uppercase tracking-wider text-faint">
              Worth checking, in this order
            </p>
            <ol className="mt-2.5 space-y-2">
              {(isDeployedBuild ? DEPLOYED_STEPS : LOCAL_STEPS).map((step, index) => (
                <li key={step} className="flex gap-2.5">
                  <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-primary-soft font-ui text-3xs font-bold text-primary">
                    {index + 1}
                  </span>
                  <span className="font-ui text-xs leading-relaxed text-muted">{step}</span>
                </li>
              ))}
            </ol>
          </div>

          <Button className="mt-6" icon={<RefreshCw size={14} />} onClick={onRetry} full>
            Try again
          </Button>
        </div>

        <p className="mt-4 flex items-start gap-2 font-ui text-2xs leading-relaxed text-faint">
          <Terminal size={12} className="mt-0.5 shrink-0" />
          {isDeployedBuild ? (
            <>
              The API reports its own state at <code className="font-mono">/api/health</code>. If that
              answers, the API is fine and the problem is on this side.
            </>
          ) : (
            <>
              Start it with <code className="font-mono">npm run api</code> from the repository root.
            </>
          )}
        </p>
      </div>
    </div>
  );
}

const DEPLOYED_STEPS = [
  "If the API is on a free tier it sleeps when idle. Open its /api/health once in another tab, wait for it to answer, then try again — a cold start can take a minute.",
  "VITE_API_BASE on the site's host must be the API's full HTTPS URL. It is baked in at build time, so changing it needs a redeploy, not just a save.",
  "CORS_ORIGINS on the API must list this site's exact origin. No wildcard: credentials are cookies, and a browser rejects a wildcard with credentials anyway. GET /api/health returns allowedOrigins, so you can see what it actually loaded.",
  "COOKIE_SAMESITE must be none when the site and the API are on different domains, and none requires HTTPS on both.",
];

const LOCAL_STEPS = [
  "Is the API running? npm run api, and it should say it is listening on port 4000.",
  "Is Supabase reachable? The API logs UNREACHABLE at boot if not.",
  "If you set VITE_API_BASE locally, unset it: Vite proxies /api to the API, which keeps everything on one origin.",
];

function Row({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: "ok" | "bad";
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="font-ui text-2xs uppercase tracking-wider text-faint">{label}</dt>
      <dd
        className={`truncate text-right text-xs font-medium ${mono ? "font-mono" : "font-ui"} ${
          tone === "bad" ? "text-danger" : tone === "ok" ? "text-primary" : "text-text"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
