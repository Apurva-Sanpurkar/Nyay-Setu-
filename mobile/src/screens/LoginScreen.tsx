import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from "react-native";
import { api, ApiError, apiBaseUrl, setCsrfToken, type User } from "../lib/api";
import { Button, Card, Notice } from "../components";
import { colours, styles } from "../theme";

/**
 * Sign in, in one or two steps.
 *
 * The API decides. If it answers `mfaRequired`, no session exists yet and a code
 * has been emailed; the screen switches to collecting it. A deployment with no
 * mail server returns a session straight away and the second step never appears.
 *
 * The API base URL is printed on screen. That is not decoration: the single most
 * common problem when running this app is pointing it at localhost from an
 * emulator, and showing the address it is actually using makes that obvious in
 * two seconds rather than twenty minutes.
 */

/**
 * Why this app refuses an invited account rather than handling it.
 *
 * The temporary password has to be replaced before anything else will work, and
 * building a second password-change screen here would mean a second
 * implementation of the same rules to keep in step with the first. Sending them
 * to the portal once, on the device they were already given, is a smaller thing
 * to get wrong. After that, this app signs them in normally.
 */
const FIRST_RUN_MESSAGE =
  "This account still has the one-time password from its invitation. Open the " +
  "NyaySetu portal in a browser and choose your own password first, then sign in here.";

interface Step1Response {
  mfaRequired: boolean;
  user?: User;
  csrfToken?: string;
  challengeId?: string;
  maskedDestination?: string;
  expiresAt?: string;
  deliveryFailed?: boolean;
  deliveryError?: string;
  otp?: string;
}

export function LoginScreen({ onSignedIn }: { onSignedIn: (user: User) => void }) {
  const [step, setStep] = useState<"password" | "code">("password");
  // Blank, not prefilled. There are no demo accounts to prefill with: an account
  // exists because a court administrator created it and emailed its holder a
  // one-time password.
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");

  const [challenge, setChallenge] = useState<Step1Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (step !== "code" || !challenge?.expiresAt) return;
    const tick = () =>
      setSecondsLeft(
        Math.max(0, Math.round((new Date(challenge.expiresAt!).getTime() - Date.now()) / 1000))
      );
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [step, challenge?.expiresAt]);

  const submitPassword = async () => {
    setPending(true);
    setError(null);
    try {
      const result = await api.post<Step1Response>("/api/auth/login", {
        email: email.trim(),
        password,
      });

      if (result.mfaRequired) {
        setChallenge(result);
        setOtp(result.otp ?? "");
        setStep("code");
        return;
      }

      if (result.user?.mustChangePassword) return setError(FIRST_RUN_MESSAGE);
      if (result.csrfToken) setCsrfToken(result.csrfToken);
      if (result.user) onSignedIn(result.user);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Sign in failed.");
    } finally {
      setPending(false);
    }
  };

  const submitCode = async () => {
    setPending(true);
    setError(null);
    try {
      const result = await api.post<{ user: User; csrfToken: string }>("/api/auth/login/verify", {
        otp,
      });
      if (result.user.mustChangePassword) return setError(FIRST_RUN_MESSAGE);
      setCsrfToken(result.csrfToken);
      onSignedIn(result.user);
    } catch (caught) {
      const details = caught instanceof ApiError ? (caught.details as any) : null;
      setError(caught instanceof ApiError ? caught.message : "That code could not be verified.");
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
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={[styles.scroll, { flexGrow: 1, justifyContent: "center" }]}>
        <View style={{ alignItems: "center", marginBottom: 18, gap: 10 }}>
          <View
            style={{
              width: 56,
              height: 56,
              borderRadius: 999,
              backgroundColor: colours.primary,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ fontSize: 24 }}>⚖️</Text>
          </View>
          <Text style={styles.h1}>NyaySetu</Text>
          <Text style={styles.small}>न्यायसेतु · field app</Text>
        </View>

        {step === "password" ? (
          <Card title="Sign in" subtitle="Evidence capture for police, bail check-in for the accused.">
            <View>
              <Text style={styles.label}>Email</Text>
              <TextInput
                style={styles.input}
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                placeholder="you@department.gov.in"
                placeholderTextColor={colours.faint}
              />
            </View>

            <View>
              <Text style={styles.label}>Password</Text>
              <TextInput
                style={styles.input}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                placeholder="••••••••••••"
                placeholderTextColor={colours.faint}
              />
            </View>

            {error ? <Notice tone="danger" title="Could not sign in" body={error} /> : null}

            <Button
              label="Continue"
              onPress={submitPassword}
              loading={pending}
              disabled={!email || !password}
            />

            <Text style={styles.small}>
              Talking to {apiBaseUrl()}. Change it with EXPO_PUBLIC_API_BASE_URL. An Android emulator
              reaches your laptop at 10.0.2.2, not localhost.
            </Text>
          </Card>
        ) : (
          <Card
            title="Check your email"
            subtitle={`A six digit code went to ${challenge?.maskedDestination ?? "your address"}.`}
          >
            {challenge?.deliveryFailed ? (
              <Notice
                tone="warning"
                title="The mail server refused the message"
                body={
                  challenge.otp
                    ? `Development fallback: the code is ${challenge.otp}. Shown only because delivery failed and this is not production.`
                    : (challenge.deliveryError ??
                      "Check SMTP_USER and SMTP_PASSWORD in backend/.env. For Gmail it must be a 16-character App Password.")
                }
              />
            ) : null}

            <View>
              <Text style={styles.label}>
                Six digit code
                {secondsLeft > 0
                  ? `  ·  expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`
                  : "  ·  expired"}
              </Text>
              <TextInput
                style={[
                  styles.input,
                  {
                    textAlign: "center",
                    fontSize: 22,
                    letterSpacing: 8,
                    fontFamily: "monospace",
                  },
                ]}
                value={otp}
                onChangeText={(value) => setOtp(value.replace(/[^0-9]/g, "").slice(0, 6))}
                keyboardType="number-pad"
                maxLength={6}
                autoFocus
                placeholder="000000"
                placeholderTextColor={colours.faint}
              />
            </View>

            {error ? <Notice tone="danger" title="Could not verify" body={error} /> : null}

            <Button
              label="Verify and sign in"
              onPress={submitCode}
              loading={pending}
              disabled={otp.length !== 6}
            />
            <Button label="Send another code" variant="ghost" onPress={resend} loading={pending} />
            <Button label="Use a different account" variant="ghost" onPress={startOver} />

            <Text style={styles.small}>
              The code is tied to this device as well as to your account, so it cannot be redeemed
              anywhere else even if somebody else reads your inbox.
            </Text>
          </Card>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
