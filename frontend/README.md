# NyaySetu · web client

React + Vite + Tailwind. This is the folder to deploy as the website: set it as the
Root Directory, build with `npm run build`, serve `dist`.

## The one variable it needs

```
VITE_API_BASE=https://your-api-host
```

Nothing else, and nothing secret. Vite inlines every `VITE_`-prefixed variable
into the bundle, so anything set here is readable by anyone who opens the site.
The Supabase key, the Aadhaar pepper and the SMTP password belong to the API and
must never appear in this project's environment.

**Do not set `NODE_ENV` here.** Vite decides its own mode from the command, and
`NODE_ENV=development` on the host produces a deployed bundle that believes it is
running on a developer's laptop.

## Why `vercel.json` looks the way it does

`vercel.json` is validated against a strict schema that rejects unknown keys, so
it carries no comments. Two things in it are deliberate and easy to undo by
accident:

**The catch-all rewrite excludes `assets/`.**

```json
{ "source": "/((?!assets/).*)", "destination": "/index.html" }
```

A single-page app needs every path to return `index.html`, or a refresh on
`/judge/bail` is a 404. But a catch-all that also swallows `/assets/` answers a
request for a hashed file that no longer exists with an HTML document, and the
browser then reports

```
Refused to apply style from '/assets/index-abc123.css' because its MIME type
('text/html') is not a supported stylesheet MIME type
```

which sends you hunting a CSS problem that does not exist. The real cause is a
cached page referencing an older build. Carving the build output out of the
rewrite turns that into an honest 404.

**The headers are not decoration.** `X-Frame-Options: DENY` stops the portals
being framed, which matters because a session cookie plus a clickjacked frame is
an action taken in somebody else's name. `Permissions-Policy` grants geolocation
and camera to this origin only — both are needed, for bail check-ins and scene
capture, and neither should be available to an embedded third party.

## Local development

```bash
npm install
npm run dev        # http://localhost:5173
```

Leave `VITE_API_BASE` empty locally. Vite proxies `/api` to `VITE_API_PROXY`, so
the browser only ever talks to one origin, which is what lets the session cookie
stay `SameSite=Strict` with no CORS relaxation at all.

## The build has a guard in it

```
npm run build   ->  tsc -b && vite build && node scripts/checkCssAnimations.mjs
```

That last step exists because of a real failure. Tailwind only emits a
`@keyframes` block when it sees a matching `animate-*` class in scanned markup, so
an animation referenced from hand-written CSS was tree-shaken away — and the
elements animating toward it stayed at `opacity: 0`. The landing page and the
sign-in form rendered blank, with no error anywhere. The guard parses the built
CSS and fails the build if any `animation` names a keyframe that was not emitted.
