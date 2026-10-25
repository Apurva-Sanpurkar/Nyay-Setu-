import { useEffect, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Lock,
  Mail,
  MailCheck,
  ShieldCheck,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { api, ApiError, setCsrfToken, type User } from "../lib/api";
import { ROLE_HOME } from "../lib/format";
import { useQuery } from "../lib/useApi";
import { Button, Field, Input } from "../components/ui";
import { AuthBackdrop } from "../components/AuthBackdrop";
import { LogoMark } from "../components/Logo";
import { ApiUnreachable } from "../components/ApiUnreachable";

/**
 * Sign in, in one or two steps depending on how the deployment is configured.
 *
 * Step 1 is always email and password. If the API reports that email codes are
 * active, it answers `mfaRequired` and no session is created yet; step 2 collects
 * the code that was emailed. The decision is entirely the server's, and this
 * screen reads it from the response rather than guessing from configuration it
 * cannot see.
 */

interface AuthConfig {
  emailOtpEnabled: boolean;
  smtpConfigured: boolean;
  aadhaarProvider: string;
  aadhaarSimulated: boolean;
  environment: string;
}

interface Step1Response {
  mfaRequired: boolean;
  user?: User;
  csrfToken?: string;
  challengeId?: string;
  maskedDestination?: string;
  expiresAt?: string;
  deliveryFailed?: boolean;
  deliveryError?: string;
  /** Present only outside production, and only when delivery failed. */
  otp?: string;
}

export default function Login() {
  const { user, loading: sessionLoading, refresh, unreachable } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const config = useQuery<AuthConfig>("/api/auth/config");

  const [step, setStep] = useState<"password" | "code">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<Step1Response | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  // Countdown on the code step, so nobody sits waiting on an expired code.
  useEffect(() => {
    if (step !== "code" || !challenge?.expiresAt) return;
    const tick = () => {
      const remaining = Math.max(
        0,
        Math.round((new Date(challenge.expiresAt!).getTime() - Date.now()) / 1000)
      );
      setSecondsLeft(remaining);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [step, challenge?.expiresAt]);

  // Same reasoning as the router's: a sign-in form that cannot reach its API is
  // worse than useless, because it invites the conclusion that the password is wrong.
  if (!sessionLoading && unreachable) {
    return <ApiUnreachable message={unreachable} onRetry={() => void refresh()} />;
  }

  if (!sessionLoading && user) {
    if (user.mustChangePassword) return <Navigate to="/first-run" replace />;
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from ?? ROLE_HOME[user.role]} replace />;
  }

  const submitPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await api.post<Step1Response>("/api/auth/login", {
        email: email.trim(),
        password,
      });

      // Present only on the one-factor path, where this response opened a session.
      setCsrfToken(result.csrfToken);

      if (result.mfaRequired) {
        setChallenge(result);
        setStep("code");
        setOtp(result.otp ?? "");
        return;
      }

      // Password-only deployment: the session already exists.
      await refresh();
      navigate(landingFor(result.user), { replace: true });
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not reach the NyaySetu API. Check that the backend is running on port 4000."
      );
    } finally {
      setPending(false);
    }
  };

  const submitCode = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await api.post<{ user: User; csrfToken?: string }>(
        "/api/auth/login/verify",
        { otp }
      );
      // The session this just opened has its own token; without it the first
      // mutating request after sign-in would be refused.
      setCsrfToken(result.csrfToken);
      await refresh();
      navigate(landingFor(result.user), { replace: true });
    } catch (caught) {
      const details = caught instanceof ApiError ? (caught.details as any) : null;
      setError(caught instanceof ApiError ? caught.message : "That code could not be verified.");

      // Exhausted or expired means the pending sign-in is gone; send them back
      // rather than leaving a dead code box on screen.
      if (details?.restart) {
        setStep("password");
        setChallenge(null);
        setOtp("");
      }
    } finally {
      setPending(false);
    }
  };

  const resend = async () => {
    setPending(true);
    setError(null);
    try {
      const result = await api.post<Step1Response>("/api/auth/login/resend");
      setChallenge({ ...result, mfaRequired: true });
      setOtp(result.otp ?? "");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not send another code.");
    } finally {
      setPending(false);
    }
  };

  const startOver = async () => {
    await api.post("/api/auth/login/cancel").catch(() => undefined);
    setStep("password");
    setChallenge(null);
    setOtp("");
    setError(null);
  };

  return (
    <div
      className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-bg px-5 py-10"
      style={{ minHeight: "100dvh" }}
    >
      <AuthBackdrop />

      <Link
        to="/"
        className="relative z-10 mb-7 flex items-center gap-3 transition-transform duration-300 ease-smooth hover:scale-[1.03]"
      >
        <LogoMark size={46} shape="circle" glow />
        <span>
          <span className="block font-display text-xl leading-none text-text">NyaySetu</span>
          <span className="block font-ui text-2xs leading-tight text-muted">न्यायसेतु</span>
        </span>
      </Link>

      <div className="relative z-10 w-full max-w-[420px]">
        {/* ------------------------------------------------ step indicator */}
        {config.data?.emailOtpEnabled && (
          <div className="anim mb-3 flex items-center gap-2" style={{ ["--d" as any]: "0.04s" }}>
            <StepPip active={step === "password"} done={step === "code"} label="Password" />
            <span className="h-px flex-1 bg-border" />
            <StepPip active={step === "code"} done={false} label="Email code" />
          </div>
        )}

        {step === "password" ? (
          <form
            onSubmit={submitPassword}
            className="anim rounded-panel border border-border bg-surface/95 p-6 shadow-card backdrop-blur-xl"
            style={{ ["--d" as any]: "0.08s" }}
          >
            <h1 className="font-display text-2xl leading-tight text-text">Sign in</h1>
            <p className="mt-1.5 font-ui text-xs leading-relaxed text-muted">
              Your role decides which portal opens. Sessions are held server-side, so an account can
              be cut off the moment it is suspended.
            </p>
            <p className="mt-2.5 font-ui text-2xs leading-relaxed text-faint">
              There is no sign-up. Accounts are created by the court registry, which emails you an
              address and a one-time password. If you were told you should have one and it has not
              arrived, ask the registry to send it again.
            </p>

            <div className="mt-6 space-y-4">
              <Field label="Email address" required>
                <div className="relative">
                  <Mail
                    size={15}
                    className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint"
                  />
                  <Input
                    type="email"
                    required
                    autoComplete="username"
                    autoFocus
                    placeholder="you@department.gov.in"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    className="border-border bg-surface pl-10 text-text placeholder:text-faint"
                  />
                </div>
              </Field>

              <Field label="Password" required>
                <div className="relative">
                  <Lock
                    size={15}
                    className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint"
                  />
                  <Input
                    type="password"
                    required
                    autoComplete="current-password"
                    placeholder="••••••••••••"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className="border-border bg-surface pl-10 text-text placeholder:text-faint"
                  />
                </div>
              </Field>
            </div>

            {error && <ErrorNote message={error} />}

            <Button
              type="submit"
              full
              size="lg"
              className="mt-6"
              loading={pending}
              iconRight={<ArrowRight size={15} />}
            >
              {config.data?.emailOtpEnabled ? "Continue" : "Sign in"}
            </Button>

            <div className="mt-4 space-y-1.5">
              <p className="text-center font-ui text-2xs leading-relaxed text-faint">
                Five failed attempts locks the account for fifteen minutes.
              </p>
              {config.data?.emailOtpEnabled && (
                <p className="flex items-center justify-center gap-1.5 text-center font-ui text-2xs text-faint">
                  <ShieldCheck size={11} />
                  A one-time code will be emailed to your registered address.
                </p>
              )}
            </div>
          </form>
        ) : (
          /* ------------------------------------------------------ step 2 */
          <form
            onSubmit={submitCode}
            className="animate-menu-in rounded-panel border border-border bg-surface/95 p-6 shadow-card backdrop-blur-xl"
          >
            <div className="mb-4 flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary-soft text-primary">
                <MailCheck size={18} />
              </span>
              <div className="min-w-0">
                <h1 className="font-display text-xl leading-tight text-text">Check your email</h1>
                <p className="mt-1 font-ui text-xs leading-relaxed text-muted">
                  A six digit code went to{" "}
                  <strong className="text-text">{challenge?.maskedDestination}</strong>.
                </p>
              </div>
            </div>

            {/* Delivery failed: say so instead of leaving them waiting. */}
            {challenge?.deliveryFailed && (
              <div
                role="alert"
                className="mb-4 rounded-lg border border-warning-soft bg-warning-soft px-3 py-2.5"
              >
                <p className="flex items-center gap-1.5 font-ui text-xs font-semibold text-text">
                  <AlertTriangle size={12} /> The mail server refused the message
                </p>
                <p className="mt-1 font-ui text-2xs leading-relaxed text-text">
                  {challenge.deliveryError ??
                    "Check SMTP_USER and SMTP_PASSWORD in backend/.env. For Gmail it must be a 16-character App Password."}
                </p>
                {challenge.otp && (
                  <p className="mt-2 font-ui text-2xs leading-relaxed text-text">
                    Development fallback: the code is{" "}
                    <code className="font-mono text-sm font-bold text-warning">{challenge.otp}</code>
                    , shown here only because delivery failed and this is not production.
                  </p>
                )}
              </div>
            )}

            <Field
              label="Six digit code"
              hint={
                secondsLeft > 0
                  ? `Expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`
                  : "This code has expired. Send another."
              }
            >
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={6}
                placeholder="000000"
                value={otp}
                onChange={(event) => setOtp(event.target.value.replace(/[^0-9]/g, ""))}
                className="border-border bg-surface text-center font-mono text-xl tracking-[0.5em] text-text placeholder:text-faint"
              />
            </Field>

            {error && <ErrorNote message={error} />}

            <Button
              type="submit"
              full
              size="lg"
              className="mt-5"
              loading={pending}
              disabled={otp.length !== 6}
              iconRight={<ArrowRight size={15} />}
            >
              Verify and sign in
            </Button>

            <div className="mt-4 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => void startOver()}
                className="inline-flex items-center gap-1.5 font-ui text-2xs font-semibold text-muted transition hover:text-text"
              >
                <ArrowLeft size={11} /> Use a different account
              </button>
              <button
                type="button"
                onClick={() => void resend()}
                disabled={pending}
                className="font-ui text-2xs font-semibold text-primary transition hover:underline disabled:opacity-40"
              >
                Send another code
              </button>
            </div>

            <p className="mt-4 font-ui text-2xs leading-relaxed text-faint">
              The code is tied to this browser as well as to your account, so it cannot be redeemed
              anywhere else even if somebody else reads your inbox.
            </p>
          </form>
        )}

        {/* ------------------------------------------------ handbook link */}
        <Link
          to="/handbook"
          className="anim mt-4 flex items-center justify-center gap-2 rounded-full px-4 py-2.5 font-ui text-2xs font-semibold text-muted transition hover:text-text"
          style={{ ["--d" as any]: "0.24s" }}
        >
          <BookOpen size={12} />
          New here? Read the handbook first
        </Link>
      </div>
    </div>
  );
}

/**
 * Where a successful sign-in lands.
 *
 * An invited account goes to the password gate, not to its portal: its temporary
 * password has just been spent, and every other route would refuse it anyway.
 */
function landingFor(user: User | undefined): string {
  if (!user) return "/";
  return user.mustChangePassword ? "/first-run" : ROLE_HOME[user.role];
}

function StepPip({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-ui text-2xs font-semibold uppercase tracking-wider transition ${
        active
          ? "border-primary bg-primary-soft text-primary"
          : done
            ? "border-border text-muted"
            : "border-border text-faint"
      }`}
    >
      {done ? <ShieldCheck size={10} /> : null}
      {label}
    </span>
  );
}

function ErrorNote({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="mt-4 rounded-lg border border-danger-soft bg-danger-soft px-3 py-2.5 font-ui text-xs leading-relaxed text-text"
    >
      {message}
    </p>
  );
}
