/**
 * Test environment. Imported FIRST by every test file, before anything that reads
 * config/env.ts, so these values win over backend/.env (dotenv never overrides a
 * variable that is already set, even to an empty string).
 *
 * Every external service is switched off explicitly. A test must never write to
 * the real Supabase project, send a real email or spend testnet gas.
 */
const blanks = [
  "CHAIN_RPC_URL",
  "CHAIN_PRIVATE_KEY",
  "EVIDENCE_CHAIN_ADDRESS",
  "SUMMONS_CHAIN_ADDRESS",
  "BAIL_CHAIN_ADDRESS",
  "DEPLOYED_ARTIFACT",
  "PINATA_JWT",
  "PINATA_API_KEY",
  "PINATA_API_SECRET",
  "AI_SERVICE_URL",
  "AI_SERVICE_KEY",
  "SMTP_HOST",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "SMTP_FROM",
  "BREVO_API_KEY",
  "RESEND_API_KEY",
  "CRON_SECRET",
  "COOKIE_DOMAIN",
  "UIDAI_BASE_URL",
  "UIDAI_CLIENT_ID",
  "UIDAI_CLIENT_SECRET",
  "UIDAI_AUA_CODE",
  "LOGIN_CHALLENGE_SECRET",
];

for (const key of blanks) process.env[key] = process.env[`TEST_${key}`] ?? "";

Object.assign(process.env, {
  NODE_ENV: "test",
  NYAY_DB: "memory",
  SUPABASE_URL: "http://memory.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "memory-service-role-key-not-a-secret",
  AADHAAR_TOKEN_PEPPER: "test-pepper-0123456789abcdef0123456789abcdef",
  EVIDENCE_ENCRYPTION_KEY: "11".repeat(32),
  CHAIN_NETWORK: process.env.TEST_CHAIN_NETWORK ?? "localhost",
  INDEXER_ENABLED: "false",
  SCHEDULER_ENABLED: "false",
  LOGIN_OTP_ENABLED: "false",
  EMAIL_NOTIFICATIONS_ENABLED: "false",
  OTP_PROVIDER: "sandbox",
  OTP_ECHO_IN_RESPONSE: "true",
  COOKIE_SAMESITE: "strict",
  CORS_ORIGINS: "http://localhost:5173",
  PUBLIC_APP_URL: "http://localhost:5173",
  // High enough that the general limiter never trips in a test that is not about it.
  RATE_LIMIT_MAX: "100000",
  AUTH_RATE_LIMIT_MAX: "100000",
  OTP_RATE_LIMIT_MAX: "100000",
  WRITE_RATE_LIMIT_MAX: "100000",
  PUBLIC_RATE_LIMIT_MAX: process.env.TEST_PUBLIC_RATE_LIMIT_MAX ?? "100000",
  LOCAL_BLOB_DIR: "test/.blobs",
  NOTIFY_PROVIDER: "sandbox",
  LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "error",
});
