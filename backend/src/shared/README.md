# Generated — do not edit

`integrity/` is a byte-for-byte copy of `packages/integrity/src`, made by
`npm run integrity:sync` at the repository root. Edit the package, then sync.
`npm run integrity:check` fails the build if this copy has drifted.

It exists because the API's Docker build context is `backend/` alone and cannot
reach `../packages`. See `docs/DECISIONS.md` D-07.
