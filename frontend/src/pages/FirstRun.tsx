import { useMemo, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { ArrowRight, Check, KeyRound, Lock, ShieldCheck, X } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { api, ApiError } from "../lib/api";
import { ROLE_HOME, ROLE_LABEL } from "../lib/format";
import { Button, Field, Input } from "../components/ui";
import { AuthBackdrop } from "../components/AuthBackdrop";
import { LogoMark } from "../components/Logo";

/**
 * The screen an invited account cannot get past.
 *
 * An invitation carries a password in an email, which means that password is
 * sitting in an inbox, readable by anyone who later reaches that mailbox. So it
 * gets one use. The API refuses every other route until this is done, which makes
 * this screen the gate rather than a suggestion: skipping it by typing a URL
 * produces 403s, not a working portal.
 *
 * The rules below are checked here only so the user sees them before submitting.
 * The server checks the same ones, and the server's answer is the one that counts.
 */

interface Rule {
  label: string;
  ok: (value: string) => boolean;
}

const RULES: Rule[] = [
  { label: "At least 12 characters", ok: (v) => v.length >= 12 },
  { label: "A lowercase letter", ok: (v) => /[a-z]/.test(v) },
  { label: "An uppercase letter", ok: (v) => /[A-Z]/.test(v) },
  { label: "A digit", ok: (v) => /[0-9]/.test(v) },
];

export default function FirstRun() {
  const { user, loading, refresh } = useAuth();
  const navigate = useNavigate();

  const [temporary, setTemporary] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const met = useMemo(() => RULES.map((rule) => rule.ok(next)), [next]);
  const matches = next.length > 0 && next === confirm;
  const distinct = next.length === 0 || next !== temporary;
  const ready = met.every(Boolean) && matches && distinct && temporary.length >= 8;

  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  // Somebody who has already settled their password has no business here.
  if (!user.mustChangePassword) return <Navigate to={ROLE_HOME[user.role]} replace />;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api.post("/api/auth/change-password", {
        currentPassword: temporary,
        newPassword: next,
      });
      // The flag lives on the server, so the local user object has to be reloaded
      // before the router will let anything else render.
      await refresh();
      navigate(ROLE_HOME[user.role], { replace: true });
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Could not change the password. Try again."
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-bg px-5 py-10"
      style={{ minHeight: "100dvh" }}
    >
      <AuthBackdrop />

      <div className="relative z-10 mb-7 flex items-center gap-3">
        <LogoMark size={46} shape="circle" glow />
        <span>
          <span className="block font-display text-xl leading-none text-text">NyaySetu</span>
          <span className="block font-ui text-2xs leading-tight text-muted">न्यायसेतु</span>
        </span>
      </div>

      <form
        onSubmit={submit}
        className="anim relative z-10 w-full max-w-[440px] rounded-panel border border-border bg-surface/95 p-6 shadow-card backdrop-blur-xl"
      >
        <div className="mb-5 flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
            <KeyRound size={18} />
          </span>
          <div className="min-w-0">
            <h1 className="font-display text-xl leading-tight text-text">
              Choose your own password
            </h1>
            <p className="mt-1 font-ui text-xs leading-relaxed text-muted">
              Signed in as <strong className="text-text">{user.fullName}</strong> ·{" "}
              {ROLE_LABEL[user.role]}
            </p>
          </div>
        </div>

        <p className="mb-5 rounded-lg border border-accent-soft bg-accent-soft px-3 py-2.5 font-ui text-xs leading-relaxed text-text">
          The password you were emailed works once. It is in an inbox, so it stops being a secret the
          moment anyone else reaches that mailbox. Nothing else on the platform will open until this
          is replaced.
        </p>

        <div className="space-y-4">
          <Field label="The password from your invitation" required>
            <div className="relative">
              <Lock
                size={15}
                className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint"
              />
              <Input
                type="password"
                required
                autoComplete="current-password"
                autoFocus
                value={temporary}
                onChange={(event) => setTemporary(event.target.value)}
                className="border-border bg-surface pl-10 font-mono text-text placeholder:text-faint"
                placeholder="XXXX-XXXX-XXXX-XXXX"
              />
            </div>
          </Field>

          <Field label="Your new password" required>
            <Input
              type="password"
              required
              autoComplete="new-password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
              className="border-border bg-surface text-text placeholder:text-faint"
              placeholder="••••••••••••"
            />
          </Field>

          <ul className="grid gap-1.5 sm:grid-cols-2">
            {RULES.map((rule, index) => (
              <li
                key={rule.label}
                className={`flex items-center gap-1.5 font-ui text-2xs transition-colors duration-300 ${
                  met[index] ? "text-primary" : "text-faint"
                }`}
              >
                {met[index] ? <Check size={11} /> : <X size={11} />}
                {rule.label}
              </li>
            ))}
          </ul>

          <Field
            label="Type it again"
            required
            hint={
              confirm.length > 0 && !matches
                ? "These two do not match."
                : !distinct
                  ? "This is the password you were emailed. Choose a different one."
                  : undefined
            }
          >
            <Input
              type="password"
              required
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              className={`border-border bg-surface text-text placeholder:text-faint ${
                confirm.length > 0 && !matches ? "border-danger" : ""
              }`}
              placeholder="••••••••••••"
            />
          </Field>
        </div>

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-lg border border-danger-soft bg-danger-soft px-3 py-2.5 font-ui text-xs leading-relaxed text-text"
          >
            {error}
          </p>
        )}

        <Button
          type="submit"
          full
          size="lg"
          className="mt-6"
          loading={pending}
          disabled={!ready}
          iconRight={<ArrowRight size={15} />}
        >
          Set my password and continue
        </Button>

        <p className="mt-4 flex items-start gap-1.5 font-ui text-2xs leading-relaxed text-faint">
          <ShieldCheck size={11} className="mt-0.5 shrink-0" />
          Every other session on this account is signed out when you do this, so an invitation email
          that was forwarded or intercepted cannot be used afterwards.
        </p>
      </form>
    </div>
  );
}
