import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { loadSession, requirePasswordSettled } from "./middleware/auth";
import { csrfProtection } from "./middleware/csrf";
import { generalLimiter } from "./middleware/rateLimit";
import { errorHandler, notFoundHandler } from "./middleware/error";

import healthRoutes from "./routes/health";
import authRoutes from "./routes/auth";
import caseRoutes from "./routes/cases";
import evidenceRoutes from "./routes/evidence";
import summonsRoutes from "./routes/summons";
import bailRoutes from "./routes/bail";
import aiRoutes from "./routes/ai";
import adminRoutes from "./routes/admin";
import referenceRoutes from "./routes/reference";
import reportRoutes from "./routes/reports";
import publicRoutes from "./routes/public";
import deviceRoutes from "./routes/devices";
import uploadRoutes from "./routes/uploads";
import templateRoutes from "./routes/templates";
import policeRoutes from "./routes/police";
import labRoutes from "./routes/lab";
import alertRoutes from "./routes/alerts";
import governanceRoutes from "./routes/governance";
import courtRoutes from "./routes/court";

/**
 * The Express application, without a listening socket or background jobs, so the
 * route tests can drive it directly. index.ts is what boots it.
 */
export const app = express();

// Railway and Vercel sit behind a proxy, so req.ip and Secure cookies need this.
app.set("trust proxy", env.TRUST_PROXY_HOPS);
app.disable("x-powered-by");

app.use(
  helmet({
    // The API serves JSON, not HTML, so a restrictive CSP costs nothing.
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: "same-site" },
    referrerPolicy: { policy: "no-referrer" },
  })
);

app.use(
  cors({
    // Credentials are cookies, so the origin list is explicit. A wildcard here
    // would be rejected by the browser anyway, and would be wrong if it were not.
    origin(origin, callback) {
      if (!origin) return callback(null, true); // curl, mobile app, server-to-server
      if (env.isOriginAllowed(origin)) return callback(null, true);

      // Error, not warn. A browser shows this as "No Access-Control-Allow-Origin"
      // with no hint that a list exists anywhere, so the log has to name both
      // sides of the comparison or the operator has nothing to go on. This is the
      // single most common reason a working API looks like a dead one.
      logger.error(
        "Refused a cross-origin request: this origin is not in CORS_ORIGINS. " +
          "Add it on the API host, exactly, and redeploy.",
        { refused: origin, configured: env.corsOrigins }
      );
      return callback(new Error("Origin not allowed by CORS."));
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "x-csrf-token", "idempotency-key", "x-chunk-sha256"],
    exposedHeaders: ["x-nyaysetu-sha256", "x-nyaysetu-integrity"],
    maxAge: 600,
  })
);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));
app.use(cookieParser());

// Order matters: the session must be loaded before CSRF can compare against it,
// and before the rate limiter can key on a session id.
app.use(loadSession);
app.use(generalLimiter);
app.use(csrfProtection);

app.use("/api/health", healthRoutes);
// The Integrity Passport. Public by design: no session is needed or consulted.
app.use("/api/public", publicRoutes);
// Not behind requirePasswordSettled: this router is how the password is changed.
app.use("/api/auth", authRoutes);

// Everything that does real work waits until an invited account has replaced the
// temporary password it was emailed.
// Reference data, read-only. Behind the password gate like everything else: an
// invited account has nothing to look up until it can act.
app.use("/api/reference", requirePasswordSettled, referenceRoutes);
// Documents. Mounted at /api/reports so a PDF route cannot be mistaken for a
// JSON one by a client that only looks at the prefix.
app.use("/api/reports", requirePasswordSettled, reportRoutes);
app.use("/api/cases", requirePasswordSettled, caseRoutes);
app.use("/api/evidence", requirePasswordSettled, evidenceRoutes);
app.use("/api/summons", requirePasswordSettled, summonsRoutes);
app.use("/api/bail", requirePasswordSettled, bailRoutes);
app.use("/api/ai", requirePasswordSettled, aiRoutes);
app.use("/api/admin", requirePasswordSettled, adminRoutes);
app.use("/api/devices", requirePasswordSettled, deviceRoutes);
app.use("/api/uploads", requirePasswordSettled, uploadRoutes);
app.use("/api/templates", requirePasswordSettled, templateRoutes);
app.use("/api/police", requirePasswordSettled, policeRoutes);
app.use("/api/lab", requirePasswordSettled, labRoutes);
app.use("/api/alerts", requirePasswordSettled, alertRoutes);
app.use("/api/governance", requirePasswordSettled, governanceRoutes);
app.use("/api/court", requirePasswordSettled, courtRoutes);

app.get("/", (_req, res) => {
  res.json({
    name: "NyaySetu API",
    version: "1.0.0",
    modules: {
      SaakshyaSetu: "/api/evidence",
      SammansSetu: "/api/summons",
      JaminSetu: "/api/bail",
    },
    health: "/api/health",
  });
});

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
