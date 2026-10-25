# User testing kit

Everything needed to run a short, honest usability study of NyaySetu with
police, laboratory, court and legal-aid participants. Nothing in this kit has
been run yet; record results in `docs/metrics/` when it is.

## Before the session

- Run the local stack: `npm run local` at the repository root (see the README).
  It prints one account per role and the shared password.
- Use a fresh browser profile, and a phone on the same network for the field
  tasks (`EXPO_PUBLIC_API_BASE_URL` set to the laptop's LAN address).
- Read the participant the consent text below and record their answer.
- Never use real case data. The tasks use invented cases only.

### Consent text

> We are testing the software, not you. You can stop at any time without giving
> a reason. We will note what you do and say, but not your name; nothing you do
> today is recorded against a real case. Is it all right to continue?

## Tasks

Give each task as written, then stay silent. Note time taken, whether it was
completed without help, and every point of hesitation.

| # | Role | Task | Success means |
|---|---|---|---|
| 1 | Police | Register a new case for a burglary at a shop. | A case reference is shown. |
| 2 | Police | On the phone, photograph an object for that case. Then switch on aeroplane mode and photograph another. Switch it off. | Both items appear on the web portal; the second arrives after the network returns. |
| 3 | Police | Record a seizure memo for the two items, with two witnesses, and download the memo. | The PDF opens. |
| 4 | Forensic lab | Accept custody of one item and record its intake, saying the seal was intact. | The intake shows "Re-check matched the chain". |
| 5 | Forensic lab | File a report on the item, then file a correction to it. | Two versions are listed, the second superseding the first. |
| 6 | Defence | Without signing in, check whether a file you were given is the registered one. Then try a copy with one pixel changed. | The first matches; the second does not. |
| 7 | Judge | Find the item that needs attention and decide what to do about it. | The alert is resolved with a reason. |
| 8 | Accused | Find out when your next check-in is due, in Hindi or Marathi. | Participant states the time correctly. |
| 9 | Prosecutor | Say which of your cases is ready for court, and why the others are not. | Participant names the case and the reason. |
| 10 | Court registry | Generate the Section 63 certificate for an item and say what the footer warns. | Participant reads the template caution. |

## System Usability Scale

After the tasks, ask the participant to rate each statement from 1 (strongly
disagree) to 5 (strongly agree).

1. I think that I would like to use this system frequently.
2. I found the system unnecessarily complex.
3. I thought the system was easy to use.
4. I think that I would need the support of a technical person to be able to use this system.
5. I found the various functions in this system were well integrated.
6. I thought there was too much inconsistency in this system.
7. I would imagine that most people would learn to use this system very quickly.
8. I found the system very cumbersome to use.
9. I felt very confident using the system.
10. I needed to learn a lot of things before I could get going with this system.

**Scoring:** for odd items subtract 1 from the rating; for even items subtract
the rating from 5. Add the ten results and multiply by 2.5 for a score from 0
to 100. Around 68 is average; report the mean, the range and the number of
participants, never a single score.

## Practitioner feedback form

For legal practitioners and senior officers, after a demonstration rather than
the tasks.

1. Your role and years of experience (no name).
2. Would the Integrity Passport change how you challenge or rely on digital
   evidence? How?
3. Is the Section 63 certificate template complete for your court's practice?
   What is missing or wrong?
4. Which screen or term was unclear?
5. What would stop your office from using this?
6. Anything in the Hindi or Marathi text that reads wrongly? (Quote it.)

## Recording results

| Field | Example |
|---|---|
| Participant id | P04 |
| Role | Police sub-inspector, 6 years |
| Device | Android 13, mid-range |
| Tasks completed unaided | 8 of 10 |
| SUS score | 72.5 |
| Top three problems | … |

Summarise findings with counts ("3 of 5 participants could not find …"), and
link each problem to the change made in response.
