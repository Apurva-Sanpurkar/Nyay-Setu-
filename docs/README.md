# Documentation

Five guides. Which one you want depends on what you are trying to do.

| I want to… | Read |
|---|---|
| Get it running on my machine | [../README.md](../README.md) — start there, it is the only one that assumes nothing |
| Know which API keys to get, and where from | [api-keys.md](api-keys.md) |
| Put it online | [hosting.md](hosting.md) — read the first section **before** importing into Vercel |
| Know the per-service environment variables and deploy order | [deployment.md](deployment.md) |
| Understand why it is built this way, and defend it | [design-decisions.md](design-decisions.md) |
| Harden it for something real | [production.md](production.md) |

There is also a **[Handbook](../README.md#the-handbook)** inside the app itself, at
`/handbook`, with no sign-in required. That one is written for the people who will
use the platform — an officer, a judge, an accused person — rather than for
whoever is building it. It explains the one technical idea the whole system rests
on, then walks through what each of the seven roles actually does.

---

## The shape of it, in one paragraph

Three Solidity contracts hold the facts that must be impossible to revise: an
evidence digest, a summons acknowledgement, a bail condition. A Node API holds
everything else and is the only thing that talks to the chain, so a browser never
holds a private key. Postgres holds the readable record with row level security on
every table. A Python service scores anomalies and risk, and says so when it
cannot. Nothing in the system requires you to trust it: every claim about
integrity is a hash you can recompute yourself against a public chain.

The one thing worth knowing before reading any of the above: **a hash is a
fingerprint of a file.** Change one byte and it changes completely. Everything
else follows from that.
