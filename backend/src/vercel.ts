/**
 * The API as a Vercel Function (Express framework preset).
 *
 * Differences from src/index.ts, which runs the API as a long-lived server:
 *   - no app.listen(): Vercel calls the exported app for each request;
 *   - no indexer or scheduler: those loops run in the `worker` daemon
 *     (src/worker.ts), because a function stops between requests.
 * Everything else — routes, sessions, CSRF, rate limits — is the same app.
 */
import { app } from "./app";
import { initChain } from "./lib/chain";
import { reportPosture } from "./config/posture";

initChain();
reportPosture();

export default app;
