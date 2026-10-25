import { StyleSheet } from "react-native";

/**
 * The light palette, with the same values as the web portal's light theme
 * (frontend/src/styles/tokens.css), so the two clients read as one product and
 * share its contrast checks: every text colour here meets WCAG AA on the
 * backgrounds it is used on. Light because it is easier to read outdoors in
 * daylight, and so a phone matches the web portal an officer also uses.
 */
export const colours = {
  bg: "#f5f7fa",
  surface: "#ffffff",
  surface2: "#f1f5f9",
  border: "rgba(15,27,45,0.12)",
  borderStrong: "rgba(15,27,45,0.22)",
  text: "#0f1b2d",
  muted: "#475569",
  faint: "#5b6b80",
  brandGreen: "#009245",
  brandOrange: "#ff751f",
  primary: "#04694c",
  primaryFill: "#04694c",
  primaryStrong: "#034e39",
  primarySoft: "rgba(5,150,105,0.10)",
  onPrimary: "#ffffff",
  success: "#04694c",
  successSoft: "rgba(5,150,105,0.12)",
  warning: "#8a4b00",
  warningSoft: "rgba(217,119,6,0.14)",
  danger: "#b91c1c",
  dangerSoft: "rgba(220,38,38,0.10)",
  info: "#4338ca",
  infoSoft: "rgba(79,70,229,0.10)",
};

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colours.bg },
  scroll: { padding: 18, paddingBottom: 48, gap: 14 },

  eyebrow: {
    color: colours.primary,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  h1: { color: colours.text, fontSize: 26, fontWeight: "700", letterSpacing: -0.5 },
  h2: { color: colours.text, fontSize: 17, fontWeight: "600" },
  body: { color: colours.muted, fontSize: 13, lineHeight: 20 },
  small: { color: colours.faint, fontSize: 11, lineHeight: 17 },
  mono: { color: colours.text, fontSize: 11, fontFamily: "monospace" },

  card: {
    backgroundColor: colours.surface,
    borderColor: colours.border,
    borderWidth: 1,
    borderRadius: 18,
    padding: 16,
    gap: 12,
  },

  label: {
    color: colours.muted,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.9,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  input: {
    backgroundColor: colours.surface2,
    borderColor: colours.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colours.text,
    fontSize: 15,
  },

  button: {
    backgroundColor: colours.primaryFill,
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: {
    color: colours.onPrimary,
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  buttonGhost: {
    backgroundColor: "transparent",
    borderColor: colours.border,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 13,
    alignItems: "center",
  },
  buttonGhostText: { color: colours.text, fontSize: 13, fontWeight: "600" },
  buttonDisabled: { opacity: 0.4 },

  chip: {
    alignSelf: "flex-start",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chipText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.8, textTransform: "uppercase" },

  notice: { borderRadius: 12, borderWidth: 1, padding: 12, gap: 4 },

  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },

  tabBar: {
    flexDirection: "row",
    backgroundColor: colours.surface,
    borderTopColor: colours.border,
    borderTopWidth: 1,
    paddingBottom: 6,
  },
  tab: { flex: 1, alignItems: "center", paddingVertical: 12, gap: 3 },
  tabLabel: { fontSize: 11, fontWeight: "600" },
});
