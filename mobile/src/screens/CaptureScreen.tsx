import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import * as Crypto from "expo-crypto";
import { buildCaptureManifest, type CapturePurpose, type GpsFixInput, type NoGpsReason } from "@nyaysetu/integrity";
import { api, ApiError, type CaseRow, type User } from "../lib/api";
import { hashFile, shortHash } from "../lib/hash";
import { evidenceQueue, forgetFile, keepFile } from "../lib/queue";
import { newItem, type QueueItem } from "../lib/queueCore";
import { deviceId } from "../lib/device";
import { Button, Card, Checklist, Chip, Empty, Loading, Notice } from "../components";
import { colours, styles } from "../theme";

/**
 * Field evidence capture (2.0 · F7, F10, F12).
 *
 *   1. Photograph or record on this phone. Nothing is edited: the bytes taken
 *      are the bytes hashed.
 *   2. The SHA-256 is computed here, a position fix is taken at the moment of
 *      capture, and both go into a capture manifest built by the same shared
 *      package the API verifies it with.
 *   3. The item is saved on the phone first, then sent. With no signal it waits
 *      in the queue and is sent later with the same idempotency key, so it can
 *      never be registered twice.
 */

const MAX_ACCURACY_METRES = 50;
const APP_VERSION = "2.0.0";

type Fix = { input: GpsFixInput | null; reason: NoGpsReason | null };

async function takeFix(): Promise<Fix> {
  try {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) return { input: null, reason: "DENIED" };
    const position = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
    ]);
    if (!position) return { input: null, reason: "TIMEOUT" };
    return {
      input: {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracyMetres: Math.max(0.01, position.coords.accuracy ?? 9999),
        altitudeMetres: position.coords.altitude ?? null,
        takenAtMs: Math.round(position.timestamp),
        mocked: typeof (position as { mocked?: boolean }).mocked === "boolean" ? (position as { mocked?: boolean }).mocked! : null,
      },
      reason: null,
    };
  } catch {
    return { input: null, reason: "UNAVAILABLE" };
  }
}

const STATE_LABEL: Record<QueueItem["state"], { label: string; tone: "neutral" | "warning" | "success" | "danger" }> = {
  QUEUED: { label: "Saved on this phone", tone: "neutral" },
  SENDING: { label: "Sending", tone: "warning" },
  SENT: { label: "Received by the server", tone: "success" },
  NEEDS_ATTENTION: { label: "Needs attention", tone: "danger" },
};

const VERIFICATION_LABEL: Record<string, string> = {
  LOCAL_ONLY: "Saved, not yet on chain",
  SUBMITTED: "Submitted to the blockchain",
  CONFIRMED: "Confirmed on chain",
  SYNC_ERROR: "Anchoring failed; will retry",
  REVIEW_REQUIRED: "Review required",
  INTEGRITY_MISMATCH: "Integrity mismatch",
};

export function CaptureScreen({ user }: { user: User }) {
  const [cases, setCases] = useState<CaseRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [caseId, setCaseId] = useState("");
  const [purpose, setPurpose] = useState<CapturePurpose>("general");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshQueue = useCallback(async () => setQueue(await evidenceQueue.list()), []);
  const flush = useCallback(async () => setQueue(await evidenceQueue.flush()), []);

  useEffect(() => {
    void (async () => {
      try {
        const data = await api.get<{ cases: CaseRow[] }>("/api/cases");
        const writable = data.cases.filter((row) => row.access !== "read");
        setCases(writable);
        if (writable.length === 1) setCaseId(writable[0].id);
      } catch (caught) {
        // Offline is not fatal: queued items still show and send later.
        setCases([]);
        setLoadError(caught instanceof ApiError ? caught.message : "Could not load your cases.");
      }
    })();
    void refreshQueue().then(flush);
    // Try again every 30 s, and whenever the app comes back to the foreground.
    timer.current = setInterval(() => void flush(), 30_000);
    const sub = AppState.addEventListener("change", (s) => s === "active" && void flush());
    return () => {
      if (timer.current) clearInterval(timer.current);
      sub.remove();
    };
  }, [flush, refreshQueue]);

  const capture = async (mode: "photo" | "video") => {
    const selected = cases?.find((c) => c.id === caseId);
    if (!selected) return;
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Camera needed", "NyaySetu needs the camera to record evidence at the scene.");
      return;
    }
    setError(null);
    setBusy("Getting a position fix");
    // The fix is taken as the camera opens, so it is at most seconds old at capture.
    const startFix = takeFix();
    const outcome = await ImagePicker.launchCameraAsync({
      mediaTypes: mode === "video" ? ["videos"] : ["images"],
      allowsEditing: false, // cropping would change the bytes, and the bytes are the point
      quality: 1,
      exif: true,
      videoMaxDuration: 600,
    });
    const returnedAtMs = Date.now();
    if (outcome.canceled || !outcome.assets?.[0]) {
      setBusy(null);
      return;
    }
    const asset = outcome.assets[0];

    try {
      const durationMs = mode === "video" && asset.duration ? Math.round(asset.duration) : null;
      const deviceTimeMs = durationMs ? returnedAtMs - durationMs : returnedAtMs;
      const start = await startFix;
      const end = mode === "video" ? await takeFix() : null;

      setBusy("Hashing on this phone");
      const name = asset.fileName ?? `capture-${new Date(deviceTimeMs).toISOString().replace(/[:.]/g, "-")}.${mode === "video" ? "mp4" : "jpg"}`;
      const mimeType = asset.mimeType ?? (mode === "video" ? "video/mp4" : "image/jpeg");
      const kept = await keepFile(asset.uri, name);
      const hashed = await hashFile(kept, name, mimeType);

      // A fix older than the capture by more than a minute is not used: a stale
      // position must never be recorded as where the item was.
      const usable = (fix: Fix, at: number) => (fix.input && Math.abs(at - fix.input.takenAtMs) <= 60_000 ? fix.input : null);
      const gpsStart = usable(start, deviceTimeMs);
      const manifest = buildCaptureManifest({
        source: "capture",
        mediaKind: mode,
        purpose,
        file: { sha256: hashed.hash, bytes: hashed.sizeBytes, mimeType },
        caseRef: selected.case_reference,
        officerId: user.id,
        deviceId: await deviceId(),
        appVersion: APP_VERSION,
        platform: Platform.OS === "ios" ? "ios" : "android",
        deviceTimeMs,
        durationMs,
        gpsStart,
        gpsEnd: end ? usable(end, deviceTimeMs + (durationMs ?? 0)) : null,
        noFixReason: gpsStart ? null : start.reason ?? "TIMEOUT",
        maxAccuracyMetres: MAX_ACCURACY_METRES,
        nonce: Array.from(Crypto.getRandomBytes(16), (b) => b.toString(16).padStart(2, "0")).join(""),
      });

      const id = Crypto.randomUUID();
      await evidenceQueue.add(
        newItem(
          {
            id,
            idempotencyKey: `mobile-capture:${id}`,
            caseId: selected.id,
            caseReference: selected.case_reference,
            kind: mode,
            file: { uri: kept, name, mimeType, sizeBytes: hashed.sizeBytes, sha256: hashed.hash },
            manifestJson: JSON.stringify(manifest),
            collectedAtIso: new Date(deviceTimeMs).toISOString(),
            notes: notes.trim() || null,
          },
          Date.now()
        )
      );
      setNotes("");
      await refreshQueue();
      setBusy("Sending");
      await flush();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The capture could not be saved.");
    } finally {
      setBusy(null);
    }
  };

  if (cases === null) {
    return (
      <View style={styles.screen}>
        <Loading label="Loading your cases" />
      </View>
    );
  }

  const waiting = queue.filter((i) => i.state !== "SENT").length;

  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <View>
        <Text style={styles.eyebrow}>Evidence</Text>
        <Text style={styles.h1}>Capture at the scene</Text>
        <Text style={[styles.body, { marginTop: 6 }]}>
          Hashed on this phone, with the time and position, before anything is sent. Without signal it is saved here and sent later.
        </Text>
      </View>

      {loadError ? <Notice tone="warning" title="Working offline" body={`${loadError} Items already captured will be sent when the connection returns.`} /> : null}

      {cases.length === 0 && !loadError ? (
        <Empty title="No case with write access" body="Register a case from the web portal, or ask the court registry to give you write access." />
      ) : null}

      {cases.length > 0 ? (
        <>
          <Card title="1 · Case">
            <View style={{ gap: 8 }}>
              {cases.map((row) => {
                const active = row.id === caseId;
                return (
                  <Pressable
                    key={row.id}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active }}
                    onPress={() => setCaseId(row.id)}
                    style={{
                      borderWidth: 1,
                      borderRadius: 12,
                      padding: 12,
                      backgroundColor: active ? colours.primarySoft : colours.surface2,
                      borderColor: active ? colours.primary : colours.border,
                    }}
                  >
                    <Text style={{ color: colours.text, fontSize: 15, fontWeight: "600" }}>{row.title}</Text>
                    <Text style={[styles.mono, { marginTop: 3, color: colours.muted }]}>{row.case_reference}</Text>
                  </Pressable>
                );
              })}
            </View>
          </Card>

          <Card title="2 · Purpose">
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              {(
                [
                  ["general", "General"],
                  ["search_seizure", "Search and seizure"],
                ] as const
              ).map(([value, label]) => (
                <Pressable
                  key={value}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: purpose === value }}
                  onPress={() => setPurpose(value)}
                  style={{
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: purpose === value ? colours.primary : colours.border,
                    backgroundColor: purpose === value ? colours.primarySoft : colours.surface,
                  }}
                >
                  <Text style={{ color: colours.text, fontSize: 14, fontWeight: "600" }}>{label}</Text>
                </Pressable>
              ))}
            </View>
            {purpose === "search_seizure" ? (
              <Text style={styles.small}>Record the whole search as one video; the start and end positions are both kept.</Text>
            ) : null}
          </Card>

          <Card title="3 · Notes" subtitle="Where it was found and its condition. Stored off chain.">
            <TextInput
              style={[styles.input, { minHeight: 80, textAlignVertical: "top" }]}
              multiline
              value={notes}
              onChangeText={setNotes}
              placeholder="Recovered from the rear entrance, bagged and sealed on site."
              placeholderTextColor={colours.faint}
              accessibilityLabel="Notes"
            />
          </Card>

          <Card title="4 · Capture">
            <Checklist items={[{ done: Boolean(caseId), label: "Case selected" }]} />
            {error ? <Notice tone="danger" title="Not saved" body={error} /> : null}
            {busy ? <Loading label={busy} /> : null}
            <Button label="Take a photograph" disabled={!caseId || Boolean(busy)} onPress={() => void capture("photo")} />
            <Button label="Record video" variant="ghost" disabled={!caseId || Boolean(busy)} onPress={() => void capture("video")} />
            <Text style={styles.small}>
              Only fingerprints go on the blockchain. The file, your notes and the exact position stay off chain, visible only to people assigned to the case.
            </Text>
          </Card>
        </>
      ) : null}

      <Card title="On this phone" subtitle={waiting ? `${waiting} item(s) not yet received by the server.` : "Everything captured has been received."}>
        {queue.length === 0 ? (
          <Text style={styles.small}>Nothing captured yet on this phone.</Text>
        ) : (
          <View style={{ gap: 10 }}>
            {[...queue].reverse().map((item) => {
              const state = STATE_LABEL[item.state];
              return (
                <View key={item.id} style={{ borderWidth: 1, borderColor: colours.border, borderRadius: 12, padding: 12, gap: 6, backgroundColor: colours.surface2 }}>
                  <View style={styles.row}>
                    <Text style={{ color: colours.text, fontSize: 14, fontWeight: "600", flexShrink: 1 }} numberOfLines={1}>
                      {item.file.name}
                    </Text>
                    <Chip tone={state.tone} label={state.label} />
                  </View>
                  <Text style={styles.small}>
                    {item.caseReference} · {new Date(item.createdAtMs).toLocaleString()}
                  </Text>
                  <Text style={[styles.mono, { fontSize: 11 }]}>{shortHash(item.file.sha256, 14, 10)}</Text>
                  {item.result?.verificationState ? (
                    <Text style={styles.small}>
                      {VERIFICATION_LABEL[item.result.verificationState] ?? item.result.verificationState}
                      {item.result.publicRef ? ` · ${item.result.publicRef}` : ""}
                    </Text>
                  ) : null}
                  {item.state === "QUEUED" && item.attempts > 0 ? (
                    <Text style={styles.small}>
                      Tried {item.attempts} time(s); next attempt {new Date(item.nextAttemptAtMs).toLocaleTimeString()}. {item.lastError}
                    </Text>
                  ) : null}
                  {item.state === "NEEDS_ATTENTION" ? (
                    <>
                      <Notice tone="danger" title="The server refused this item" body={item.lastError ?? undefined} />
                      <View style={{ flexDirection: "row", gap: 8 }}>
                        <View style={{ flex: 1 }}>
                          <Button label="Try again" variant="ghost" onPress={() => void evidenceQueue.retry(item.id).then(flush)} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Button
                            label="Discard"
                            variant="ghost"
                            onPress={() =>
                              Alert.alert("Discard this item?", "It has not been registered. The file will be deleted from this phone.", [
                                { text: "Keep", style: "cancel" },
                                {
                                  text: "Discard",
                                  style: "destructive",
                                  onPress: () => void evidenceQueue.discard(item.id).then(forgetFile).then(refreshQueue),
                                },
                              ])
                            }
                          />
                        </View>
                      </View>
                    </>
                  ) : null}
                </View>
              );
            })}
            <View style={{ flexDirection: "row", gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Button label="Send now" variant="ghost" disabled={!waiting} onPress={() => void flush()} />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  label="Clear sent"
                  variant="ghost"
                  disabled={!queue.some((i) => i.state === "SENT")}
                  onPress={() =>
                    void (async () => {
                      for (const sent of queue.filter((i) => i.state === "SENT")) await forgetFile(sent);
                      await evidenceQueue.clearSent();
                      await refreshQueue();
                    })()
                  }
                />
              </View>
            </View>
          </View>
        )}
      </Card>
    </ScrollView>
  );
}
