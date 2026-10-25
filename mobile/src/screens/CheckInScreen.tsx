import { useEffect, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import * as Location from "expo-location";
import { api, ApiError, type BailOrder, type OtpDispatch } from "../lib/api";
import { distanceMetres, formatDuration, formatMetres, shortHash } from "../lib/hash";
import { Button, Card, Chip, Empty, Loading, Notice } from "../components";
import { colours, styles } from "../theme";

/**
 * Bail check-in.
 *
 * Two things have to be true before the contract will accept it: a position fix,
 * and a one-time code sent to the mobile registered against the accused's
 * Aadhaar. Neither can be supplied by anyone else, which is what makes the record
 * worth having.
 *
 * The distance to the permitted centre is shown BEFORE the code is verified, and
 * the button says plainly that checking in from outside the fence will record a
 * breach. Nobody should discover that after the fact.
 */
export function CheckInScreen() {
  const [orders, setOrders] = useState<BailOrder[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [fix, setFix] = useState<Location.LocationObjectCoords | null>(null);
  const [locating, setLocating] = useState(false);

  const [dispatch, setDispatch] = useState<OtpDispatch | null>(null);
  const [otp, setOtp] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    withinFence: boolean;
    distanceMetres: number | null;
    violations: string[];
    score: number | null;
    txHash: string;
  } | null>(null);

  const order = orders?.[0] ?? null;

  const load = async () => {
    try {
      const data = await api.get<{ orders: BailOrder[] }>("/api/bail/mine");
      setOrders(data.orders);
    } catch (caught) {
      setLoadError(caught instanceof ApiError ? caught.message : "Could not load your bail order.");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const locate = async () => {
    setLocating(true);
    setError(null);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        setError(
          "Location permission was refused. A check-in cannot be recorded without coordinates, because the court verifies where it came from."
        );
        return;
      }
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setFix(position.coords);
    } catch {
      setError("Could not get a position fix. Try again in a moment.");
    } finally {
      setLocating(false);
    }
  };

  const requestOtp = async () => {
    if (!order) return;
    setRequesting(true);
    setError(null);
    try {
      setDispatch(await api.post<OtpDispatch>(`/api/bail/case/${order.case_id}/otp`));
      setOtp("");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not send a code.");
    } finally {
      setRequesting(false);
    }
  };

  const submit = async () => {
    if (!order || !dispatch || !fix) return;
    setSubmitting(true);
    setError(null);
    try {
      const outcome = await api.post<{
        withinFence: boolean;
        distanceMetres: number | null;
        violations: { reason: string }[];
        compliance: { score: number } | null;
        chain: { txHash: string };
      }>(`/api/bail/case/${order.case_id}/checkin`, {
        challengeId: dispatch.challengeId,
        otp,
        gpsLat: fix.latitude,
        gpsLng: fix.longitude,
        platform: "mobile",
      });

      setResult({
        withinFence: outcome.withinFence,
        distanceMetres: outcome.distanceMetres,
        violations: outcome.violations.map((v) => v.reason),
        score: outcome.compliance?.score ?? null,
        txHash: outcome.chain.txHash,
      });
      setDispatch(null);
      setOtp("");
      void load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The check-in failed.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loadError) {
    return (
      <ScrollView contentContainerStyle={styles.scroll}>
        <Notice tone="danger" title="Could not load your bail order" body={loadError} />
      </ScrollView>
    );
  }

  if (orders === null) {
    return (
      <View style={styles.screen}>
        <Loading label="Loading your bail order" />
      </View>
    );
  }

  const fence =
    order?.centre_lat !== null && order?.centre_lat !== undefined && order?.centre_lng !== null
      ? { lat: order.centre_lat, lng: order.centre_lng!, radius: order.radius_metres }
      : null;

  const distance = fix && fence ? distanceMetres(fence.lat, fence.lng, fix.latitude, fix.longitude) : null;
  const inside = distance !== null && fence ? distance <= fence.radius : null;

  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <View>
        <Text style={styles.eyebrow}>JaminSetu</Text>
        <Text style={styles.h1}>Bail check-in</Text>
        <Text style={[styles.body, { marginTop: 6 }]}>
          Your position plus a one-time code. The contract decides whether it is compliant.
        </Text>
      </View>

      {!order ? (
        <Empty title="No active bail order" body="There is nothing for you to check in against." />
      ) : (
        <>
          {result ? (
            <Card
              title={result.withinFence ? "Check-in recorded" : "Recorded, with a breach"}
              borderColor={result.withinFence ? colours.successSoft : colours.dangerSoft}
            >
              <Notice
                tone={result.withinFence ? "success" : "danger"}
                title={
                  result.withinFence
                    ? `${formatMetres(result.distanceMetres)} from your declared residence`
                    : `${formatMetres(result.distanceMetres)} away: outside the permitted area`
                }
                body={
                  result.violations.length > 0
                    ? `Recorded on chain: ${result.violations.join(", ")}`
                    : "Inside the permitted area. Nothing has been flagged."
                }
              />
              {result.score !== null ? (
                <Text style={styles.body}>Compliance score is now {result.score} of 100.</Text>
              ) : null}
              <Text style={styles.mono}>{shortHash(result.txHash, 14, 10)}</Text>
              <Button label="Done" variant="ghost" onPress={() => setResult(null)} />
            </Card>
          ) : null}

          <Card title="Your order" subtitle={order.cases?.case_reference}>
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              <Chip
                tone={
                  order.live
                    ? order.live.overdue
                      ? "danger"
                      : order.live.score >= 85
                        ? "success"
                        : "warning"
                    : "neutral"
                }
                label={`Score ${order.live?.score ?? order.compliance_score ?? "—"}`}
              />
              {order.live?.overdue ? <Chip tone="danger" label="Overdue" /> : null}
            </View>

            <Row
              label="Next check-in"
              value={
                order.live
                  ? order.live.overdue
                    ? "overdue now"
                    : formatDuration(order.live.secondsUntilNextCheckIn)
                  : "—"
              }
            />
            <Row
              label="Stay within"
              value={order.radius_metres ? formatMetres(order.radius_metres) : "no restriction"}
            />
            <Row label="Order expires" value={new Date(order.expiry_at).toLocaleDateString("en-IN")} />

            <View style={{ gap: 6, marginTop: 4 }}>
              <Text style={styles.label}>Your conditions</Text>
              {order.conditions.map((condition, index) => (
                <Text key={index} style={styles.small}>
                  · {condition}
                </Text>
              ))}
            </View>
          </Card>

          <Card title="1 · Position">
            {fix ? (
              <>
                <Row
                  label="Coordinates"
                  value={`${fix.latitude.toFixed(5)}, ${fix.longitude.toFixed(5)}`}
                />
                <Row label="Accuracy" value={`±${Math.round(fix.accuracy ?? 0)} m`} />

                {fence && distance !== null ? (
                  <Notice
                    tone={inside ? "success" : "danger"}
                    title={`${formatMetres(distance)} from the permitted centre`}
                    body={
                      inside
                        ? "Inside the permitted area."
                        : "Outside the permitted area. Checking in from here will record a geo-fence breach on chain."
                    }
                  />
                ) : null}

                {(fix.accuracy ?? 0) > 100 && fence ? (
                  <Notice
                    tone="warning"
                    title="Weak position fix"
                    body={`This fix is only accurate to about ${Math.round(
                      fix.accuracy ?? 0
                    )} m. Wait for a better one before checking in.`}
                  />
                ) : null}

                <Button label="Refresh fix" variant="ghost" loading={locating} onPress={() => void locate()} />
              </>
            ) : (
              <Button label="Capture position" loading={locating} onPress={() => void locate()} />
            )}
          </Card>

          <Card title="2 · Aadhaar OTP" subtitle="Sent to the mobile registered against your Aadhaar.">
            {!dispatch ? (
              <Button
                label="Send me a code"
                loading={requesting}
                disabled={!fix}
                onPress={() => void requestOtp()}
              />
            ) : (
              <>
                <Text style={styles.small}>
                  Sent to {dispatch.maskedDestination}. Valid until{" "}
                  {new Date(dispatch.expiresAt).toLocaleTimeString("en-IN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  .
                </Text>

                {dispatch.otp ? (
                  <Notice
                    tone="warning"
                    title={`Sandbox code: ${dispatch.otp}`}
                    body="A real deployment sends this by SMS through a licensed AUA. It is shown here because this deployment does not hold UIDAI authorisation."
                  />
                ) : null}

                <View>
                  <Text style={styles.label}>Six digit code</Text>
                  <TextInput
                    style={[
                      styles.input,
                      { textAlign: "center", fontSize: 22, letterSpacing: 8, fontFamily: "monospace" },
                    ]}
                    value={otp}
                    onChangeText={(value) => setOtp(value.replace(/[^0-9]/g, "").slice(0, 6))}
                    keyboardType="number-pad"
                    maxLength={6}
                    placeholder="000000"
                    placeholderTextColor={colours.faint}
                  />
                </View>

                <Button
                  label={inside === false ? "Check in anyway" : "Verify and check in"}
                  loading={submitting}
                  disabled={otp.length !== 6 || !fix}
                  onPress={() => void submit()}
                />
                <Button label="Resend code" variant="ghost" loading={requesting} onPress={() => void requestOtp()} />
              </>
            )}

            {!fix ? (
              <Text style={[styles.small, { color: colours.warning }]}>
                Capture your position first. A check-in without coordinates proves nothing.
              </Text>
            ) : null}

            {error ? <Notice tone="danger" title="Could not check in" body={error} /> : null}
          </Card>
        </>
      )}
    </ScrollView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={{ color: colours.text, fontSize: 12, fontWeight: "500" }}>{value}</Text>
    </View>
  );
}
