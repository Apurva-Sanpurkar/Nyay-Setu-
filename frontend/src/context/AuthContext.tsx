import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, ApiError, clearCsrfToken, setCsrfToken, type User } from "../lib/api";
import { useTheme } from "./ThemeContext";

interface AuthValue {
  user: User | null;
  /** True until the first /me call settles, so routes do not redirect early. */
  loading: boolean;
  error: string | null;
  /**
   * Set when the API could not be reached at all, as opposed to reaching it and
   * being told there is no session. The two are indistinguishable to a user and
   * have nothing in common as causes, so the router treats them differently:
   * no session means sign in, unreachable means say so.
   */
  unreachable: string | null;
  signIn: (email: string, password: string) => Promise<User>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const { adopt } = useTheme();

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ user: User; csrfToken?: string }>("/api/auth/me");
      // Every mutating request needs this, and this response is the only place it
      // can be read from once the site and the API are on different domains.
      setCsrfToken(result.csrfToken);
      setUser(result.user);
      // The profile preference wins over the local one, so a theme follows the
      // user between the station terminal and their phone.
      if (result.user.theme) adopt(result.user.theme);
      setError(null);
      setUnreachable(null);
    } catch (caught) {
      // A 401 here is the normal "not signed in" case, not a failure.
      if (caught instanceof ApiError && caught.isAuth) {
        setError(null);
        setUnreachable(null);
      } else if (caught instanceof ApiError && caught.isUnreachable) {
        setUnreachable(caught.message);
        setError(caught.message);
      } else {
        setError(caught instanceof Error ? caught.message : "Could not load your session.");
        setUnreachable(null);
      }
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [adopt]);

  useEffect(() => {
    void load();
  }, [load]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const result = await api.post<{ user: User; csrfToken?: string }>("/api/auth/login", {
        email,
        password,
      });
      setCsrfToken(result.csrfToken);
      setUser(result.user);
      if (result.user.theme) adopt(result.user.theme);
      setError(null);
      // Fetch the full profile, which also picks up hasAadhaarToken.
      void load();
      return result.user;
    },
    [adopt, load]
  );

  const signOut = useCallback(async () => {
    try {
      await api.post("/api/auth/logout");
    } finally {
      // Clear locally whatever the server said: a failed sign-out must still end
      // the session in this tab. The token goes with it, so a later request cannot
      // present a credential for a session that is over.
      clearCsrfToken();
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({ user, loading, error, unreachable, signIn, signOut, refresh: load }),
    [user, loading, error, unreachable, signIn, signOut, load]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider.");
  return context;
}
