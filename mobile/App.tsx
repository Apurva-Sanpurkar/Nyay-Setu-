import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { logout, whoAmI, type User } from "./src/lib/api";
import { LoginScreen } from "./src/screens/LoginScreen";
import { CaptureScreen } from "./src/screens/CaptureScreen";
import { CheckInScreen } from "./src/screens/CheckInScreen";
import { Loading } from "./src/components";
import { colours, styles } from "./src/theme";

/**
 * The field app: two flows, chosen by role.
 *
 *   police   -> evidence capture
 *   accused  -> bail check-in
 *
 * Navigation is a two-tab switch rather than react-navigation. With two screens
 * a navigator would be more dependency than routing, and this app is meant to
 * install and open quickly on a mid-range phone in the field.
 */

type Tab = "capture" | "checkin";

const TABS: Record<Tab, { label: string; glyph: string; roles: string[] }> = {
  capture: { label: "Capture", glyph: "📸", roles: ["police"] },
  checkin: { label: "Check in", glyph: "📍", roles: ["accused"] },
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [tab, setTab] = useState<Tab>("capture");

  useEffect(() => {
    void (async () => {
      const restored = await whoAmI();
      setUser(restored);
      if (restored?.role === "accused") setTab("checkin");
      setRestoring(false);
    })();
  }, []);

  const available = (Object.keys(TABS) as Tab[]).filter((key) =>
    user ? TABS[key].roles.includes(user.role) : false
  );

  const signIn = (signedIn: User) => {
    setUser(signedIn);
    setTab(signedIn.role === "accused" ? "checkin" : "capture");
  };

  const signOut = async () => {
    await logout();
    setUser(null);
  };

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" backgroundColor={colours.bg} />
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        {restoring ? (
          <Loading label="Restoring your session" />
        ) : !user ? (
          <LoginScreen onSignedIn={signIn} />
        ) : (
          <View style={{ flex: 1 }}>
            {/* ------------------------------------------------- header */}
            <View
              style={[
                styles.row,
                {
                  paddingHorizontal: 18,
                  paddingVertical: 12,
                  borderBottomWidth: 1,
                  borderBottomColor: colours.border,
                },
              ]}
            >
              <View style={{ flexShrink: 1 }}>
                <Text style={{ color: colours.text, fontSize: 14, fontWeight: "600" }}>
                  {user.fullName}
                </Text>
                <Text style={styles.small}>{user.designation ?? user.role}</Text>
              </View>
              <Pressable
                onPress={() => void signOut()}
                accessibilityRole="button"
                accessibilityLabel="Sign out"
                style={{
                  borderWidth: 1,
                  borderColor: colours.border,
                  borderRadius: 999,
                  paddingHorizontal: 14,
                  paddingVertical: 7,
                }}
              >
                <Text style={{ color: colours.muted, fontSize: 11, fontWeight: "600" }}>Sign out</Text>
              </Pressable>
            </View>

            {/* ------------------------------------------------- content */}
            <View style={{ flex: 1 }}>
              {available.length === 0 ? (
                <View style={{ padding: 18, gap: 10 }}>
                  <Text style={styles.h2}>Nothing here for your role</Text>
                  <Text style={styles.body}>
                    The field app covers evidence capture for police and bail check-in for the accused.
                    Your role, {user.role}, works from the web portal instead.
                  </Text>
                </View>
              ) : tab === "capture" ? (
                <CaptureScreen user={user} />
              ) : (
                <CheckInScreen />
              )}
            </View>

            {/* ------------------------------------------------- tab bar */}
            {available.length > 1 ? (
              <View style={styles.tabBar}>
                {available.map((key) => {
                  const active = key === tab;
                  return (
                    <Pressable
                      key={key}
                      onPress={() => setTab(key)}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: active }}
                      style={styles.tab}
                    >
                      <Text style={{ fontSize: 18, opacity: active ? 1 : 0.5 }}>
                        {TABS[key].glyph}
                      </Text>
                      <Text
                        style={[
                          styles.tabLabel,
                          { color: active ? colours.primary : colours.faint },
                        ]}
                      >
                        {TABS[key].label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
