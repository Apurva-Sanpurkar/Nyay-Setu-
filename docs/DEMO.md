# Demonstration script

About twelve minutes, end to end, on a laptop with the local stack and
optionally a phone. Everything runs locally: a Hardhat chain, an in-memory
database and the web app. No accounts, keys or internet are needed.

## Setup (once, before the audience arrives)

```bash
npm install          # at the repository root, then in backend/, frontend/, contracts/
DEV_SEED_PASSWORD="choose-a-password" npm run local
```

Wait for the line listing the seeded accounts, then open
`http://localhost:5173`. Keep two browser windows: one signed in, one private
window for the public verification page.

| Role | Email |
|---|---|
| Police | `police@nyaysetu.local` |
| Forensic laboratory | `forensic.lab@nyaysetu.local` |
| Prosecutor | `prosecutor@nyaysetu.local` |
| Judge | `judge@nyaysetu.local` |
| Defence | `defence.lawyer@nyaysetu.local` |
| Accused | `accused@nyaysetu.local` |
| Court registry | `court.admin@nyaysetu.local` |

All use the password you chose.

## 1. The problem (1 minute)

Open the landing page and scroll to *What NyaySetu does not prove*. Say what
the system claims and what it does not before showing anything.

## 2. Capture at the scene (2 minutes) — Police

1. Sign in as police. **Register a case** (no FIR needed); note the reference.
2. **Capture evidence**: take a photo with the laptop camera (or the phone app).
   Point out the fingerprint and GPS accuracy shown *before* upload.
3. Open the item: the verification state moves from *Submitted* to
   *Confirmed on chain*; open **State history** to show each step.

## 3. Anyone can check it (2 minutes) — no account

1. Copy the item's public reference, open `/verify/<reference>` in the private
   window. Show what is there (digests, times, custody stages) and what is not
   (no names, no places).
2. Drop the original file: **matches**. Edit one pixel in any image editor,
   drop it again: **does not match**.

## 4. Hand-over with a re-check (2 minutes) — Laboratory

1. Sign in as the laboratory, open the item from the **Laboratory queue**.
2. **Accept custody** with the original file, then **Record intake** with the
   seal intact. The re-check is recorded on chain.
3. **File the report**, then **File a correction**: both versions remain.

## 5. When something is wrong (2 minutes) — Judge

1. Back as police, register another item; as the laboratory, accept it with a
   *different* file. Custody does not move; the item is *Integrity mismatch*.
2. Sign in as the judge: the mismatch is in **Alerts**, with an explanation.
   Resolve it with a reason. Show that release for review needs a second person
   under **Approvals**.

## 6. The person on the other side (1 minute) — Accused

Sign in as the accused, switch the language to हिन्दी or मराठी, and show
**What you need to do** and **Help**: plain words, and the boundary that this
is not legal advice.

## 7. Produce it in court (2 minutes) — Prosecutor or Court registry

1. Show the prosecutor's **Readiness by case**.
2. On the first item, open **Documents → Section 63 certificate**, generate the
   PDF, and read its footer: it is a template to be checked by a legal
   practitioner. Its SHA-256 is shown when it is produced.
3. Download the **Court export bundle** and open its manifest.

End on the certificate: the record, the chain and the court document all
derive from the same fingerprint taken at the scene.

## If something goes wrong

- *An item stays Submitted:* the local chain mines on demand; register anything
  else, press **Check the chain now** on the item, or wait for the tracker
  (every two minutes by default; `SWEEP_INTERVAL_MS`).
- *Camera unavailable:* use **Upload a file** on the capture page instead.
- *Port in use:* stop other Node processes, or see `scripts/local-stack.mjs`.
