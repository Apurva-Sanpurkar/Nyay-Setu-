import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { colours, styles } from "./theme";

/* ======================================================== Button ========= */

export function Button({
  label,
  onPress,
  disabled,
  loading,
  variant = "primary",
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: "primary" | "ghost";
}) {
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(inactive), busy: Boolean(loading) }}
      onPress={inactive ? undefined : onPress}
      style={({ pressed }) => [
        variant === "primary" ? styles.button : styles.buttonGhost,
        inactive && styles.buttonDisabled,
        pressed && !inactive && { opacity: 0.85, transform: [{ scale: 0.99 }] },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === "primary" ? colours.onPrimary : colours.primary} />
      ) : (
        <Text style={variant === "primary" ? styles.buttonText : styles.buttonGhostText}>{label}</Text>
      )}
    </Pressable>
  );
}

/* ========================================================== Chip ========= */

type Tone = "success" | "danger" | "warning" | "neutral";

const TONE: Record<Tone, { bg: string; border: string; text: string }> = {
  success: { bg: colours.successSoft, border: colours.successSoft, text: colours.success },
  danger: { bg: colours.dangerSoft, border: colours.dangerSoft, text: colours.danger },
  warning: { bg: colours.warningSoft, border: colours.warningSoft, text: colours.warning },
  neutral: { bg: colours.surface2, border: colours.border, text: colours.muted },
};

export function Chip({ tone, label }: { tone: Tone; label: string }) {
  const palette = TONE[tone];
  return (
    <View style={[styles.chip, { backgroundColor: palette.bg, borderColor: palette.border }]}>
      <Text style={[styles.chipText, { color: palette.text }]}>{label}</Text>
    </View>
  );
}

/* ======================================================== Notice ========= */

export function Notice({
  tone,
  title,
  body,
}: {
  tone: Tone;
  title: string;
  body?: string;
}) {
  const palette = TONE[tone];
  return (
    <View
      accessibilityRole={tone === "danger" ? "alert" : undefined}
      style={[styles.notice, { backgroundColor: palette.bg, borderColor: palette.border }]}
    >
      <Text style={{ color: colours.text, fontSize: 13, fontWeight: "600" }}>{title}</Text>
      {body ? <Text style={styles.small}>{body}</Text> : null}
    </View>
  );
}

/* ========================================================== Card ========= */

export function Card({
  title,
  subtitle,
  children,
  borderColor,
}: {
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
  borderColor?: string;
}) {
  return (
    <View style={[styles.card, borderColor ? { borderColor } : null]}>
      {title ? <Text style={styles.h2}>{title}</Text> : null}
      {subtitle ? <Text style={styles.small}>{subtitle}</Text> : null}
      {children}
    </View>
  );
}

/* ====================================================== KeyValue ========= */

export function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={{ color: colours.text, fontSize: 12, fontWeight: "500", flexShrink: 1, textAlign: "right" }}>
        {value}
      </Text>
    </View>
  );
}

/* ====================================================== Checklist ======== */

export function Checklist({ items }: { items: { done: boolean; label: string }[] }) {
  return (
    <View style={{ gap: 8 }}>
      {items.map((item) => (
        <View key={item.label} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View
            style={{
              width: 20,
              height: 20,
              borderRadius: 999,
              borderWidth: 1,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: item.done ? colours.primary : "transparent",
              borderColor: item.done ? colours.primary : colours.border,
            }}
          >
            {item.done ? (
              <Text style={{ color: colours.onPrimary, fontSize: 11, fontWeight: "700" }}>✓</Text>
            ) : null}
          </View>
          <Text style={{ color: item.done ? colours.text : colours.faint, fontSize: 13 }}>{item.label}</Text>
        </View>
      ))}
    </View>
  );
}

/* ======================================================= Loading ========= */

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <View style={{ paddingVertical: 36, alignItems: "center", gap: 12 }}>
      <ActivityIndicator color={colours.primary} />
      <Text style={styles.small}>{label}…</Text>
    </View>
  );
}

export function Empty({ title, body }: { title: string; body?: string }) {
  return (
    <View
      style={{
        paddingVertical: 32,
        paddingHorizontal: 18,
        alignItems: "center",
        gap: 8,
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: colours.border,
        borderRadius: 16,
      }}
    >
      <Text style={{ color: colours.text, fontSize: 15, fontWeight: "600" }}>{title}</Text>
      {body ? <Text style={[styles.small, { textAlign: "center" }]}>{body}</Text> : null}
    </View>
  );
}
