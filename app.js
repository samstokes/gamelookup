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

// Cache Storage and localStorage are origin-wide, and branch previews share the origin with
// the real app (see .github/workflows/pages.yml), so both names carry this copy's own path.
// sw.js derives the cache name the same way, to know not to reap it.
const SCOPE = new URL('./', location.href).pathname;
const DATA_CACHE = `gfn-catalogue-v1@${SCOPE}`;
const CATALOGUE_KEY = './gfn-catalogue.json'; // synthetic Cache Storage key, never fetched
const FETCHED_AT_KEY = `gfn:fetchedAt@${SCOPE}`;
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

// `appid` is the fallback for a shared Steam link whose game isn't in the GFN catalogue:
// we know the exact ProtonDB page even without a catalogue entry behind it.
function renderProtonDb(entry, query, appid) {
  const steamId = (entry && entry.appid) || appid;
  const url = steamId ? PDB_APP + steamId : PDB_SEARCH + encodeURIComponent(query);

  ui.pdbLink.href = url;
  ui.pdbDetail.textContent = steamId
    ? ''
    : 'No Steam ID known — showing ProtonDB search; tap a result inside the panel.';

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
  ui.suggestions.hidden = true;
  ui.suggestions.textContent = '';
  ui.q.setAttribute('aria-expanded', 'false');
  matches = [];
  cursor = -1;
}

function renderSuggestions(query) {
  matches = search(query);
  ui.suggestions.textContent = '';
  cursor = -1;

  const rows = [];
  for (const { entry } of matches) {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');

    const title = document.createElement('span');
    title.className = 's-title';
    title.textContent = entry.title;

    // Publisher, not a "GFN" tag: every row here is on GFN, and duplicate titles
    // (two different games called Mixtape) are only told apart by publisher.
    const hint = document.createElement('span');
    hint.className = 's-hint';
    hint.textContent = entry.publisher;

    li.append(title, hint);
    li.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus off blur
    li.addEventListener('click', () => {
      ui.q.value = entry.title;
      lookup(entry.title, entry);
    });
    rows.push(li);
  }

  // Always offer the raw query: plenty of games are on ProtonDB but not GFN.
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
  else renderSuggestions(value);
});

ui.q.addEventListener('keydown', (e) => {
  if (ui.suggestions.hidden) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); moveCursor(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveCursor(-1); }
  else if (e.key === 'Escape') hideSuggestions();
});

ui.q.addEventListener('focus', () => {
  const value = ui.q.value.trim();
  if (value.length >= 2) renderSuggestions(value);
});

ui.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const picked = cursor >= 0 ? matches[cursor] : null;
  if (picked && picked.entry) {
    ui.q.value = picked.entry.title;
    lookup(picked.entry.title, picked.entry);
  } else {
    lookup(ui.q.value);
  }
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
