'use strict';

// GeForce NOW: the GraphQL endpoint nvidia.com/geforce-now/games uses itself. It allows any
// origin, so the browser can call it directly — no backend. (The static gfnpc-*.json files are
// simpler but badly stale: 1,550 rows versus 5,889 here, missing whole games like Mixtape.)
// Note the body is a raw GraphQL document, not the usual {"query": …} envelope.
const GFN_API = 'https://api-prod.nvidia.com/services/gfngames/v1/gameList';
const GFN_PAGE_LIMIT = 20; // pages are 750 items; a guard against looping forever

// ProtonDB's API is CORS-locked to their own origin, so their page goes in an iframe instead.
const PDB_APP = 'https://www.protondb.com/app/';
const PDB_SEARCH = 'https://www.protondb.com/search?q=';

// ProtonDB's own search box is backed by SteamDB's Algolia index, reached through a proxy of
// theirs which — unlike everything under /api/ — answers any origin. It is how the app turns
// a bare title into a Steam appid for the ~3% of games the GFN catalogue has never heard of,
// and an appid is the difference between a real verdict page and their search grid. The
// form-urlencoded content type is what their client sends, and it keeps this a simple
// request: no preflight round trip before every lookup.
const STEAM_SEARCH = 'https://www.protondb.com/proxy/steamdb2/query';
const MAX_STEAM_SUGGESTIONS = 4;
const STEAM_DEBOUNCE_MS = 250;

const DATA_CACHE = 'gfn-catalogue-v1';
const CATALOGUE_KEY = './gfn-catalogue.json'; // synthetic Cache Storage key, never fetched
const FETCHED_AT_KEY = 'gfn:fetchedAt';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_SUGGESTIONS = 8;

const STORE_NAMES = {
  STEAM: 'Steam', EPIC: 'Epic', XBOX: 'Xbox', UPLAY: 'Ubisoft Connect',
  BATTLENET: 'Battle.net', EA_APP: 'EA app', GOG: 'GOG', GAIJIN: 'Gaijin',
  WARGAMING: 'Wargaming', NV_BUNDLE: 'NVIDIA bundle', NVIDIA: 'NVIDIA',
};

const el = (id) => document.getElementById(id);
const ui = {
  form: el('search-form'), q: el('q'), clear: el('clear'), suggestions: el('suggestions'),
  install: el('install'), status: el('status'), result: el('result'), empty: el('empty'),
  count: el('count'), title: el('title'), subtitle: el('subtitle'), gfnBadge: el('gfn-badge'),
  gfnDetail: el('gfn-detail'), gfnAlts: el('gfn-alts'), pdbLink: el('pdb-link'),
  pdbDetail: el('pdb-detail'), frame: el('pdb-frame'), frameNote: el('frame-note'),
  freshness: el('freshness'), refresh: el('refresh'),
};

let games = [];
let matches = [];
let cursor = -1;
let frameTimer = null;
let pdbSeq = 0;      // guards the panel against a slow lookup landing after a newer one
let steamTimer = null;
let suggestSeq = 0;

// ---------------------------------------------------------------- text matching

// Two normalised forms per title: spaced (for word-boundary scoring) and compact
// (so "deusex" still finds "Deus Ex"). Both fold accents and drop the ®/™/’ noise.
function spaced(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

const compact = (s) => spaced(s).replace(/ /g, '');

function score(entry, qs, qc) {
  if (entry.spaced === qs) return 0;
  if (entry.spaced.startsWith(qs)) return 1;
  if (entry.spaced.includes(' ' + qs)) return 2;
  if (entry.compact.startsWith(qc)) return 3;
  if (entry.compact.includes(qc)) return 4;
  return -1;
}

function search(query, limit = MAX_SUGGESTIONS) {
  const qs = spaced(query);
  const qc = compact(query);
  if (!qc) return [];

  const hits = [];
  for (const entry of games) {
    const s = score(entry, qs, qc);
    if (s >= 0) hits.push({ entry, s });
  }
  hits.sort((a, b) => a.s - b.s ||
    a.entry.title.length - b.entry.title.length ||
    a.entry.title.localeCompare(b.entry.title));
  return hits.slice(0, limit);
}

// ---------------------------------------------------------------- steam titles

const steamCache = new Map();

// Names and appids only — enough to offer a suggestion and to deep-link ProtonDB.
async function searchSteam(query, limit = MAX_STEAM_SUGGESTIONS) {
  const key = limit + ':' + spaced(query);
  if (steamCache.has(key)) return steamCache.get(key);

  const res = await fetch(STEAM_SEARCH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, // see STEAM_SEARCH
    body: JSON.stringify({
      query,
      hitsPerPage: limit,
      // Without this every result set is padded with DLC, soundtracks and trailers, which
      // have ProtonDB pages of their own that say nothing about the game.
      facetFilters: [['appType:Game']],
      attributesToRetrieve: ['name', 'objectID', 'releaseYear'],
      attributesToHighlight: [],
    }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status); // 429 when we have been too eager

  const hits = ((await res.json()).hits || [])
    .filter((h) => h.name && /^\d+$/.test(String(h.objectID)))
    .map((h) => ({ title: h.name, appid: String(h.objectID), year: h.releaseYear || null }));

  if (steamCache.size > 64) steamCache.clear();
  steamCache.set(key, hits);
  return hits;
}

// ---------------------------------------------------------------- catalogue

// GFN catalogues are region-specific; ask for the user's own where we can tell.
function country() {
  const m = /-([A-Z]{2})$/.exec(navigator.language || '');
  return m ? m[1] : 'US';
}

const catalogueQuery = (after) => `{
  apps(country: "${country()}" language: "en_US" orderBy: "sortName:ASC" after: "${after}") {
    pageInfo { endCursor hasNextPage }
    items {
      title
      gfn { playType minimumMembershipTierLabel }
      variants { appStore publisherName storeUrl }
    }
  }
}`;

// Keep only what the UI needs — it makes the cached copy a fraction of the raw response.
function condense(item) {
  const variants = item.variants || [];
  const stores = [];
  let appid = null;

  for (const v of variants) {
    const name = STORE_NAMES[v.appStore];
    if (name && !stores.includes(name)) stores.push(name);
    if (!appid) {
      const m = /store\.steampowered\.com\/app\/(\d+)/.exec(v.storeUrl || '');
      if (m) appid = m[1];
    }
  }

  return {
    title: item.title,
    publisher: (variants.find((v) => v.publisherName) || {}).publisherName || '',
    stores,
    appid,
    install: (item.gfn || {}).playType === 'INSTALL_TO_PLAY',
    premium: !!(item.gfn || {}).minimumMembershipTierLabel,
  };
}

async function fetchCatalogue(onProgress) {
  const out = [];
  let after = '';

  for (let page = 0; page < GFN_PAGE_LIMIT; page++) {
    const res = await fetch(GFN_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: catalogueQuery(after),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    const apps = ((await res.json()).data || {}).apps;
    if (!apps || !apps.items) throw new Error('unexpected response');

    for (const item of apps.items) out.push(condense(item));
    if (onProgress) onProgress(out.length);

    if (!apps.pageInfo.hasNextPage) break;
    after = apps.pageInfo.endCursor;
  }

  return out;
}

// Normalised forms are derived, not cached — recomputing is far cheaper than storing them.
function prepare(list) {
  for (const entry of list) {
    entry.spaced = spaced(entry.title);
    entry.compact = compact(entry.title);
  }
  return list;
}

async function loadGames({ force = false, onProgress } = {}) {
  // Cache Storage needs a secure context; without it we just refetch each time.
  const cache = 'caches' in window ? await caches.open(DATA_CACHE) : null;
  const cached = cache ? await cache.match(CATALOGUE_KEY) : null;
  const fetchedAt = Number(localStorage.getItem(FETCHED_AT_KEY) || 0);
  const fresh = Date.now() - fetchedAt < MAX_AGE_MS;

  if (cached && fresh && !force) return { list: await cached.json(), fetchedAt };

  try {
    const list = await fetchCatalogue(onProgress);
    if (cache) {
      await cache.put(CATALOGUE_KEY, new Response(JSON.stringify(list), {
        headers: { 'Content-Type': 'application/json' },
      }));
    }
    const now = Date.now();
    localStorage.setItem(FETCHED_AT_KEY, String(now));
    return { list, fetchedAt: now };
  } catch (err) {
    // Offline or NVIDIA is down: yesterday's catalogue beats no catalogue.
    if (cached) return { list: await cached.json(), fetchedAt, stale: true };
    throw err;
  }
}

function describeAge(fetchedAt, stale) {
  if (!fetchedAt) return '';
  const mins = Math.round((Date.now() - fetchedAt) / 60000);
  const when = mins < 60 ? `${mins} min ago`
    : mins < 60 * 24 ? `${Math.round(mins / 60)} h ago`
    : `${Math.round(mins / 1440)} d ago`;
  return `${games.length} GFN games · updated ${when}${stale ? ' (offline)' : ''}`;
}

// ---------------------------------------------------------------- share target

function asHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch (err) {
    return null; // not a URL — the ordinary case for a shared text selection
  }
}

// Steam links carry a readable slug next to the appid: /app/1145360/Hollow_Knight_Silksong/
function fromSteam(url) {
  if (!/(^|\.)steampowered\.com$/.test(url.hostname)) return null;
  const m = /^\/app\/(\d+)(?:\/([^/]+))?/.exec(url.pathname);
  return m ? { appid: m[1], name: (m[2] || '').replace(/_+/g, ' ').trim() } : null;
}

// Android hands the share sheet's own label over as the subject; it is never a game.
const CHOOSER_LABEL = /^share(\s+(via|with|to|using))?$/i;

const cleanTitle = (value) => {
  const title = (value || '').trim();
  return CHOOSER_LABEL.test(title) ? '' : title;
};

// Where an incoming query comes from, in priority order:
//   ?q=      a link back into the app
//   ?url=    the shared link, when the sharing app separates it out
//   ?text=   the shared text: a selection, or the link itself, or both together
//   ?title=  last resort only. Sharing a *text selection* on Android puts the share sheet's
//            label ("Share via") in EXTRA_SUBJECT, which arrives here — so reading it ahead
//            of ?text= searches for "Share via" instead of what you actually selected.
// Returns an appid too when a Steam link was shared: that pins the catalogue entry exactly
// rather than guessing from a slug or a page title.
function sharedQuery() {
  const params = new URLSearchParams(location.search);

  const explicit = (params.get('q') || '').trim();
  if (explicit) return { query: explicit };

  const text = (params.get('text') || '').trim();
  const embedded = /\bhttps?:\/\/\S+/.exec(text);
  const link = asHttpUrl(params.get('url') || '') || (embedded && asHttpUrl(embedded[0]));

  // "Check out Hades https://…" shares both; the words are the useful half.
  const selection = text.replace(/\bhttps?:\/\/\S+/g, '').trim();

  if (link) {
    const steam = fromSteam(link);
    if (steam && (steam.appid || steam.name)) {
      return { query: steam.name || selection || cleanTitle(params.get('title')), appid: steam.appid };
    }
    // Some other link: its page title beats showing the raw URL in the search box.
    return { query: selection || cleanTitle(params.get('title')) };
  }

  return { query: selection || cleanTitle(params.get('title')) };
}

async function init({ force = false } = {}) {
  ui.status.hidden = false;
  ui.status.className = 'status';
  ui.status.textContent = 'Loading the GeForce NOW catalogue…';

  try {
    const { list, fetchedAt, stale } = await loadGames({
      force,
      onProgress: (n) => { ui.status.textContent = `Loading the GeForce NOW catalogue… ${n}`; },
    });

    games = prepare(list);
    ui.status.hidden = true;
    ui.freshness.textContent = describeAge(fetchedAt, stale);
    ui.count.textContent = `${games.length} games on GeForce NOW.`;
    ui.q.disabled = false;

    const { query, appid } = sharedQuery();
    // A shared Steam link names the game exactly, so skip the fuzzy match when we can.
    const pinned = appid ? games.find((g) => g.appid === appid) : null;
    if (pinned) {
      ui.q.value = pinned.title;
      lookup(pinned.title, pinned);
    } else if (query || appid) {
      // A slugless Steam link names nothing, but the appid still deep-links ProtonDB.
      const label = query || `Steam app ${appid}`;
      ui.q.value = label;
      lookup(label, null, appid);
    } else {
      showEmpty();
      ui.q.focus();
    }
  } catch (err) {
    ui.status.hidden = false;
    ui.status.className = 'status error';
    ui.status.textContent = `Couldn't load the GeForce NOW catalogue (${err.message}). ` +
      'You can still search ProtonDB.';
    ui.q.disabled = false;
  }
}

// ---------------------------------------------------------------- rendering

function showEmpty() {
  pdbSeq++; // don't let a lookup still in flight frame something behind the empty state
  clearTimeout(frameTimer);
  ui.result.hidden = true;
  ui.empty.hidden = false;
  ui.frame.removeAttribute('src');
}

function renderGfn(entry, query, near) {
  ui.gfnAlts.hidden = true;
  ui.gfnAlts.textContent = '';

  if (!entry) {
    // No catalogue at all is a different answer from "searched it and it isn't there".
    if (!games.length) {
      ui.gfnBadge.className = 'badge warn';
      ui.gfnBadge.textContent = 'Unknown';
      ui.gfnDetail.textContent = 'The GeForce NOW catalogue has not loaded — tap Refresh.';
      return;
    }

    ui.gfnBadge.className = 'badge no';
    ui.gfnBadge.textContent = 'Not found';
    ui.gfnDetail.textContent = `No GeForce NOW match for “${query}”.`;

    if (near.length) {
      ui.gfnAlts.hidden = false;
      const label = document.createElement('li');
      label.className = 'muted';
      label.textContent = 'Did you mean:';
      ui.gfnAlts.append(label);
      for (const { entry: alt } of near.slice(0, 4)) {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = alt.title;
        button.addEventListener('click', () => {
          ui.q.value = alt.title;
          lookup(alt.title, alt);
        });
        li.append(button);
        ui.gfnAlts.append(li);
      }
    }
    return;
  }

  ui.gfnBadge.className = 'badge yes';
  ui.gfnBadge.textContent = 'Available';

  // Both play types are playable; the distinction is whether it installs per session.
  const bits = [entry.install ? 'Install-to-play' : 'Ready to play'];
  if (entry.premium) bits.push('Premium members only');
  if (entry.stores.length) bits.push(entry.stores.join(' · '));
  ui.gfnDetail.textContent = bits.join(' — ');
}

function frameProtonDb(url, note) {
  ui.pdbLink.href = url;
  ui.pdbDetail.textContent = note || '';

  ui.frameNote.hidden = true;
  clearTimeout(frameTimer);

  if (!navigator.onLine) {
    ui.frame.removeAttribute('src');
    ui.frameNote.hidden = false;
    ui.frameNote.textContent = 'Offline — ProtonDB needs a connection.';
    return;
  }

  ui.frame.src = url;
  // ProtonDB is a client-rendered React app, so a blank panel for a beat is normal.
  // If nothing has loaded after 8s, point at the Open link rather than leaving a void.
  frameTimer = setTimeout(() => {
    ui.frameNote.hidden = false;
    ui.frameNote.textContent = 'ProtonDB is slow to load — try Open ↗ above.';
  }, 8000);
}

// `appid` is the fallback for a shared Steam link whose game isn't in the GFN catalogue:
// we know the exact ProtonDB page even without a catalogue entry behind it.
async function renderProtonDb(entry, query, appid) {
  const seq = ++pdbSeq;
  const steamId = (entry && entry.appid) || appid;
  if (steamId) { frameProtonDb(PDB_APP + steamId); return; }

  // No appid anywhere: ask ProtonDB's own search backend for one rather than framing
  // /search?q=. Their results page is a grid of Steam capsule images with no titles under
  // them, and a game too new to have a capsule — Life is Strange: Reunion, say — renders as
  // a broken-image icon over its bare appid. /app/<appid> is the page worth showing.
  ui.pdbLink.href = PDB_SEARCH + encodeURIComponent(query);
  ui.pdbDetail.textContent = 'Looking for it on Steam…';
  ui.frame.removeAttribute('src');
  ui.frameNote.hidden = true;
  clearTimeout(frameTimer);

  if (navigator.onLine) {
    try {
      const [hit] = await searchSteam(query, 1);
      if (seq !== pdbSeq) return; // a newer lookup owns the panel now
      if (hit) {
        // Say which game we landed on unless it is plainly the one that was asked for:
        // the appid is a guess from a title, not something the catalogue vouched for.
        const exact = compact(hit.title) === compact(query);
        frameProtonDb(PDB_APP + hit.appid, exact ? '' : `Closest Steam match: ${hit.title}.`);
        return;
      }
    } catch (err) {
      if (seq !== pdbSeq) return; // fall through to the search page below
    }
  }

  frameProtonDb(PDB_SEARCH + encodeURIComponent(query),
    'No Steam ID known — showing ProtonDB search; tap a result inside the panel.');
}

ui.frame.addEventListener('load', () => {
  clearTimeout(frameTimer);
  ui.frameNote.hidden = true;
});

function lookup(query, entry, appid) {
  query = query.trim();
  if (!query) { showEmpty(); return; }

  const hits = search(query);
  // Only claim a GFN identity on a confident match; anything looser is a "did you mean".
  const best = hits[0];
  const resolved = entry || (best && best.s <= 1 ? best.entry : null);

  ui.empty.hidden = true;
  ui.result.hidden = false;
  ui.title.textContent = resolved ? resolved.title : query;
  ui.subtitle.textContent = resolved ? resolved.publisher : '';

  // Only offer alternatives that share a prefix; a bare substring hit ("hades" inside
  // "Shades of Horror") is noise, not a suggestion.
  renderGfn(resolved, query, resolved ? [] : hits.filter((h) => h.s <= 3));
  renderProtonDb(resolved, query, appid);

  hideSuggestions();
  ui.q.blur();

  const url = new URL(location.href);
  url.searchParams.set('q', query);
  for (const param of ['title', 'text', 'url']) url.searchParams.delete(param);
  history.replaceState(null, '', url);
}

// ---------------------------------------------------------------- suggestions

function hideSuggestions() {
  clearTimeout(steamTimer);
  suggestSeq++; // anything already in flight is stale
  ui.suggestions.hidden = true;
  ui.suggestions.textContent = '';
  ui.q.setAttribute('aria-expanded', 'false');
  matches = [];
  cursor = -1;
}

// Acting on a row, whichever way it was chosen. A Steam row carries its appid so the
// ProtonDB panel skips the guesswork and goes straight to that page.
function choose(match, fallback) {
  if (match && match.entry) {
    ui.q.value = match.entry.title;
    lookup(match.entry.title, match.entry);
  } else if (match && match.steam) {
    ui.q.value = match.steam.title;
    lookup(match.steam.title, null, match.steam.appid);
  } else {
    lookup(fallback);
  }
}

function suggestionRow(text, hint) {
  const li = document.createElement('li');
  li.setAttribute('role', 'option');

  const title = document.createElement('span');
  title.className = 's-title';
  title.textContent = text;

  const note = document.createElement('span');
  note.className = 's-hint';
  note.textContent = hint;

  li.append(title, note);
  li.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus off blur
  return li;
}

// Steam titles the GFN catalogue already covers would just be duplicate rows.
function steamOnly(hits, gfnMatches) {
  const seen = new Set();
  for (const { entry } of gfnMatches) {
    seen.add(entry.compact);
    if (entry.appid) seen.add(entry.appid);
  }
  return hits.filter((h) => !seen.has(compact(h.title)) && !seen.has(h.appid))
    .slice(0, MAX_STEAM_SUGGESTIONS);
}

const sameRow = (a, b) => a.entry === b.entry && a.steam === b.steam && !a.raw === !b.raw;

function renderSuggestions(query, steam = []) {
  // Steam rows arrive a beat after the local ones, so keep whatever the keyboard was on.
  const selected = cursor >= 0 ? matches[cursor] : null;

  matches = search(query);
  ui.suggestions.textContent = '';
  cursor = -1;

  const rows = [];
  for (const { entry } of matches) {
    // Publisher, not a "GFN" tag: every row here is on GFN, and duplicate titles
    // (two different games called Mixtape) are only told apart by publisher.
    const li = suggestionRow(entry.title, entry.publisher);
    li.addEventListener('click', () => choose({ entry }));
    rows.push(li);
  }

  for (const hit of steamOnly(steam, matches)) {
    // These are the ProtonDB half of the answer on their own: Steam knows them, the GFN
    // catalogue does not. Say so, rather than letting them pass for streamable games.
    const hint = [hit.year, games.length ? 'Not on GFN' : 'Steam'].filter(Boolean).join(' · ');
    const li = suggestionRow(hit.title, hint);
    li.addEventListener('click', () => choose({ steam: hit }));
    rows.push(li);
    matches.push({ steam: hit });
  }

  // Always offer the raw query: it is the way to look up anything neither list named.
  const raw = document.createElement('li');
  raw.setAttribute('role', 'option');
  raw.className = 's-raw';
  const strong = document.createElement('strong');
  strong.textContent = query;
  raw.append('Look up ', strong);
  raw.addEventListener('mousedown', (e) => e.preventDefault());
  raw.addEventListener('click', () => lookup(query));
  rows.push(raw);
  matches.push({ entry: null, raw: true });

  ui.suggestions.append(...rows);
  ui.suggestions.hidden = false;
  ui.q.setAttribute('aria-expanded', 'true');

  if (selected) {
    const i = matches.findIndex((m) => sameRow(m, selected));
    if (i >= 0) { cursor = i; rows[i].setAttribute('aria-selected', 'true'); }
  }
}

// Naming the games ProtonDB has and GFN hasn't costs a request, so it waits for a pause in
// typing; the local rows are already on screen by then. Failure just means no extra rows.
function scheduleSteamSuggestions(query) {
  clearTimeout(steamTimer);
  const seq = ++suggestSeq;
  if (!navigator.onLine) return;

  steamTimer = setTimeout(async () => {
    let hits;
    try {
      // Over-fetch: on a query like "life is strange" the first few hits are all games the
      // GFN catalogue already lists, and those rows get dropped as duplicates.
      hits = await searchSteam(query, MAX_STEAM_SUGGESTIONS * 2);
    } catch (err) {
      return;
    }
    if (seq !== suggestSeq || ui.suggestions.hidden || ui.q.value.trim() !== query) return;
    if (hits.length) renderSuggestions(query, hits);
  }, STEAM_DEBOUNCE_MS);
}

function moveCursor(delta) {
  const rows = ui.suggestions.children;
  if (!rows.length) return;
  if (cursor >= 0) rows[cursor].removeAttribute('aria-selected');
  cursor = (cursor + delta + rows.length) % rows.length;
  rows[cursor].setAttribute('aria-selected', 'true');
  rows[cursor].scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------- events

ui.q.addEventListener('input', () => {
  const value = ui.q.value.trim();
  ui.clear.hidden = !value;
  if (value.length < 2) hideSuggestions();
  else { renderSuggestions(value); scheduleSteamSuggestions(value); }
});

ui.q.addEventListener('keydown', (e) => {
  if (ui.suggestions.hidden) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); moveCursor(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveCursor(-1); }
  else if (e.key === 'Escape') hideSuggestions();
});

ui.q.addEventListener('focus', () => {
  const value = ui.q.value.trim();
  if (value.length >= 2) { renderSuggestions(value); scheduleSteamSuggestions(value); }
});

ui.form.addEventListener('submit', (e) => {
  e.preventDefault();
  choose(cursor >= 0 ? matches[cursor] : null, ui.q.value);
});

ui.clear.addEventListener('click', () => {
  ui.q.value = '';
  ui.clear.hidden = true;
  hideSuggestions();
  showEmpty();
  ui.q.focus();
});

document.addEventListener('click', (e) => {
  if (!ui.form.contains(e.target)) hideSuggestions();
});

ui.refresh.addEventListener('click', async () => {
  ui.freshness.textContent = 'Refreshing…';
  await init({ force: true });
});

window.addEventListener('online', () => {
  if (!ui.result.hidden && !ui.frame.getAttribute('src')) lookup(ui.q.value);
});

// Android's install prompt: stash the event and surface our own button.
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  ui.install.hidden = false;
});

ui.install.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  ui.install.hidden = true;
  deferredPrompt.prompt();
  deferredPrompt = null;
});

window.addEventListener('appinstalled', () => { ui.install.hidden = true; });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* fine without offline */ });
  });
}

ui.q.disabled = true;
init();
