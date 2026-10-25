import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { ThemeProvider } from "./context/ThemeContext";
import { AuthProvider } from "./context/AuthContext";
import { ToastProvider } from "./context/ToastContext";
import { I18nProvider } from "./i18n";
import { SplashScreen } from "./components/brand";
import { registerServiceWorker } from "./lib/pwa";
import "./styles/index.css";

registerServiceWorker();

/**
 * Provider order matters:
 *   ThemeProvider first, because AuthProvider adopts the theme the profile
 *   returns, and ToastProvider outermost of the two so a sign-in failure can
 *   raise a toast.
 */
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <I18nProvider>
          <ToastProvider>
            <AuthProvider>
              <SplashScreen />
              <App />
            </AuthProvider>
          </ToastProvider>
        </I18nProvider>
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>
);
