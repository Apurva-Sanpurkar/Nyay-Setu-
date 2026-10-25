# Jan-Sahayak: plain-language help

Jan-Sahayak is how NyaySetu explains status to people who are not lawyers or
officers, chiefly an accused person or a witness, in English, Hindi and
Marathi.

## What it is

- **Rule-based, not a language model.** Every explanation is fixed text chosen
  by a rule from the record's state (`packages/integrity/src/explain.ts`). The
  same state always gives the same words; nothing is generated, and nothing can
  be talked into giving advice.
- **Process and status only.** Each screen that uses it shows the boundary:
  *"This explains status and process only. It is not legal advice."*, with a
  pointer to the District Legal Services Authority for free legal aid.
- **Three languages throughout.** The whole web interface has English, Hindi
  and Marathi dictionaries (`frontend/src/i18n`). They are typed against the
  English one, so the build fails if a string is missing in any language.

## Accessibility

- Language and text size are chosen in the sidebar and remembered.
- The page's `lang` attribute follows the chosen language, so screen readers
  use the right voice; Devanagari text uses Noto Sans Devanagari.
- The build checks every text and background colour pair against WCAG AA in
  both themes (`frontend/scripts/checkContrast.mjs`).
- `npm run ui:smoke` (frontend) signs in as every role, opens every page, and
  fails on any serious or critical axe-core violation; run it with `--lang=hi`
  and `--mobile` too. At the time of writing all 45 pages pass in English,
  Hindi and at phone width.
- State is never shown by colour alone: every status chip has a word and an icon.

## What has not been done

- **The Hindi and Marathi text has not been reviewed by native speakers.** It
  was written carefully, but legal and administrative terms in particular need
  review by someone who uses them daily. Until that review is recorded here,
  treat the translations as drafts.
- No screen-reader user has tested the application.
- Audio (spoken) explanations are not provided.

## Reviewing the translations

1. Run the app with the language set to Hindi or Marathi and work through the
   accused person's screens: obligations, summons, check-in, help.
2. Compare against `frontend/src/i18n/en.ts`; the keys are the same in each file.
3. Edit `hi.ts` or `mr.ts`, then run `npm run typecheck` in `frontend/`.
4. Record the reviewer's role (not name), date and scope below.

| Date | Language | Reviewer's role | Scope |
|---|---|---|---|
| — | — | — | Not yet reviewed |
