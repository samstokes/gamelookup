# Can I Play It?

A phone-sized PWA that answers one question about a game: **can I run it on the Linux
laptop (ProtonDB), or stream it on GeForce NOW?**

Type a name, get both answers on one screen. No backend, no build step, no dependencies —
five static files.

## How it gets the two answers

The two sources need completely different treatment, because of CORS:

**GeForce NOW** is queried through the same GraphQL endpoint their own games page uses:

    POST https://api-prod.nvidia.com/services/gfngames/v1/gameList

It sends permissive CORS headers, so the browser can call it directly. Two gotchas: the
request body is a **raw GraphQL document**, not the usual `{"query": …}` envelope (sending
the envelope gets a 500), and pages are capped at 750 items, so the app follows the
`endCursor` — about 8 requests for the full ~5,900-game catalogue.

There is also a static `gfnpc-*.json` file that is far simpler to consume — **don't**. It is
badly stale: 1,550 rows against 5,889 from the API, and it is missing entire games (Mixtape,
for one) along with the whole Install-to-Play category and the membership-tier flag.

The catalogue is condensed to what the UI needs (title, publisher, stores, Steam appid, play
type, membership tier), cached in Cache Storage — 763 KB, refreshed once a day — and searched
locally. That half is instant and works offline.

**ProtonDB** cannot be read from the browser at all:

| Attempt | Why it fails |
| --- | --- |
| `protondb.com/api/v1/reports/summaries/<appid>.json` | `ACAO` is pinned to `https://www.protondb.com` |
| Scraping `protondb.com/search?q=` | Same, and the HTML is a 3 KB empty SPA shell anyway |
| Their search backend (SteamDB's Algolia index) | CORS is open, but the API key is Referer-locked to `protondb.com`, and `Referer` is a forbidden header |

Reading the tier into our own UI would therefore need a server-side proxy. Instead the app
**embeds ProtonDB's own page in an iframe** — they send no `X-Frame-Options` and no
`frame-ancestors`, so framing works, and their page renders the tier badge itself.

97% of catalogue entries carry a Steam appid, so the app almost always deep-links straight to
`/app/<appid>`. Otherwise it frames `/search?q=<name>`, whose results carry tier badges too —
so you still see PLATINUM/GOLD without tapping through.

The trade-off: same-origin policy still stops the app *reading* the frame, so the ProtonDB
verdict is their page as-is rather than a compact badge in the app's own styling. Making it
a native badge means running a proxy.

## Running it

Any static HTTPS host works. Locally:

    python3 -m http.server 8765     # then open http://localhost:8765

`localhost` counts as a secure context, so the service worker and Cache Storage work there.

### On the phone

HTTPS is required for Android to offer *Install app*. GitHub Pages is the least-effort route:

    git add -A && git commit -m "Can I Play It"
    gh repo create gamelookup --public --source=. --push
    gh api -X POST repos/:owner/gamelookup/pages -f build_type=legacy \
      -f 'source[branch]=main' -f 'source[path]=/'

Then open `https://<user>.github.io/gamelookup/` in Chrome on Android and use the **Install**
button in the app bar (or ⋮ → *Add to Home screen*). All paths are relative, so serving from
a subdirectory is fine.

Once installed it also registers as an Android **share target**: share a game name from any
app and it lands straight in the lookup.

## Files

    index.html              markup
    styles.css              styling, dark and light
    app.js                  catalogue fetch/cache, search, rendering
    sw.js                   service worker — offline app shell
    manifest.webmanifest    PWA metadata, icons, share target
    icons/                  generated PNGs

## Notes

- **What the GFN line means.** *Ready to play* streams immediately; *Install-to-play* works
  but installs into the session first. *Premium members only* means the free tier can't
  stream it. Both play types count as available.
- **Region.** The catalogue is region-specific; the app derives `country` from
  `navigator.language` (`en-GB` → `GB`), falling back to `US`.
- **Updating the app.** The service worker serves the cached shell first, so an edit shows
  up on the *second* load. Bump `VERSION` in `sw.js` to push a change out immediately.
- **Catalogue freshness.** It refreshes on first use each day; *Refresh list* in the footer
  forces it. The footer shows how old the data is, and says `(offline)` when serving a stale
  copy.
- **Offline.** The app opens and answers the GFN half with no connection. ProtonDB obviously
  needs one; the app says so instead of framing a browser error page — though it relies on
  `navigator.onLine`, which flags airplane mode reliably but not a dead Wi-Fi.
- **Confidence.** A GFN result is only claimed on an exact or prefix match; looser matches
  are offered as "Did you mean". So "Not found" means genuinely absent from the catalogue
  rather than merely misspelled.
- **Fragility.** Both sources are unofficial. If ProtonDB ever sends `frame-ancestors`, the
  panel goes blank and the *Open ↗* link becomes the fallback. The NVIDIA endpoint is the one
  their own site depends on, but it is not a documented public API — if its shape changes the
  app keeps serving the last cached catalogue and says how old it is.
