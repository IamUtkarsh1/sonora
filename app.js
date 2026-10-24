/* Sonora is a local-first music player with a small, openly licensed streaming catalog. */

const DB_NAME = "sonora-audio";
const DB_VERSION = 1;
const AUDIO_STORE = "audio-files";
const META_KEY = "sonora-library-v1";
const ARCHIVE_SEARCH_URL = "https://archive.org/advancedsearch.php";
const ARCHIVE_METADATA_URL = "https://archive.org/metadata/";
const COMMONS_API_URL = "https://commons.wikimedia.org/w/api.php";
const RADIO_BROWSER_API_URL = "https://de1.api.radio-browser.info/json";
const RADIO_BROWSER_SITE_URL = "https://www.radio-browser.info/";
const HINDI_COMMONS_CATEGORIES = [
  { title: "Category:Hindi-language songs", label: "Hindi-language songs" },
  { title: "Category:Audio files of Hindustani music", label: "Hindustani music" },
  { title: "Category:Songs of India", label: "Songs of India" }
];
const HINDI_RADIO_TAGS = ["bollywood", "hindi"];
const COLORS = [
  ["#7967e9", "#f3a26e"],
  ["#4e88cb", "#8be0c1"],
  ["#d46791", "#8d72df"],
  ["#c87947", "#e8c75b"],
  ["#407f7d", "#9e8fe9"],
  ["#8c5b94", "#f1a182"]
];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const audio = $("#audio");
const content = $("#app-content");
const filePicker = $("#file-picker");
const miniPlayer = $("#mini-player");
const miniTitle = $("#mini-title");
const miniArtist = $("#mini-artist");
const miniArt = $("#mini-art");
const miniProgress = $("#mini-progress-fill");
const miniTogglePath = $("#mini-toggle-path");
const playlistDialog = $("#playlist-dialog");
const playlistForm = $("#playlist-form");
const playlistName = $("#playlist-name");
const addToPlaylistDialog = $("#add-to-playlist-dialog");
const playlistPicker = $("#playlist-picker");
const nowPlayingDialog = $("#now-playing-dialog");
const nowPlayingContent = $("#now-playing-content");
const toast = $("#toast");
const installButton = $("#open-install");
const installDialog = $("#install-dialog");
const installInstructions = $("#install-instructions");

let selectedTrackId = null;
let toastTimer = null;
let currentObjectUrl = null;
let dbPromise = null;
let deferredInstallPrompt = null;
let catalogRequestController = null;
let catalogRequestId = 0;
let catalogState = { status: "idle", query: "", tracks: [], error: "", mode: "catalog" };
let catalogTrackCache = new Map();
let hindiCommonsTracks = null;
let hindiRadioStations = null;
let appState = loadState();
let player = {
  currentId: null,
  queue: [],
  shuffle: Boolean(appState.settings?.shuffle),
  repeat: appState.settings?.repeat || "off"
};

function newLibraryState() {
  return {
    tracks: [],
    playlists: [],
    settings: { shuffle: false, repeat: "off" }
  };
}

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(META_KEY));
    if (!parsed || !Array.isArray(parsed.tracks) || !Array.isArray(parsed.playlists)) return newLibraryState();
    return {
      tracks: parsed.tracks,
      playlists: parsed.playlists,
      settings: parsed.settings || { shuffle: false, repeat: "off" }
    };
  } catch {
    return newLibraryState();
  }
}

function saveState() {
  appState.settings = { shuffle: player.shuffle, repeat: player.repeat };
  localStorage.setItem(META_KEY, JSON.stringify(appState));
}

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(AUDIO_STORE)) {
        request.result.createObjectStore(AUDIO_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open the local music library."));
  });
  return dbPromise;
}

async function saveAudioFile(id, file) {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(AUDIO_STORE, "readwrite");
    transaction.objectStore(AUDIO_STORE).put({ id, blob: file });
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Could not save audio."));
  });
}

async function getAudioFile(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(AUDIO_STORE, "readonly");
    const request = transaction.objectStore(AUDIO_STORE).get(id);
    request.onsuccess = () => resolve(request.result?.blob || null);
    request.onerror = () => reject(request.error || new Error("Could not read audio."));
  });
}

async function removeAudioFile(id) {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(AUDIO_STORE, "readwrite");
    transaction.objectStore(AUDIO_STORE).delete(id);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Could not remove audio."));
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  }[character]));
}

function trackById(id) {
  return appState.tracks.find((track) => track.id === id)
    || catalogState.tracks.find((track) => track.id === id)
    || catalogTrackCache.get(id);
}

function isCatalogSearch(type = appState.searchType) {
  return type === "catalog" || type === "hindi" || type === "radio";
}

function activeCatalogMode() {
  return isCatalogSearch() ? appState.searchType : "catalog";
}

function catalogSourceInfo(mode = activeCatalogMode()) {
  if (mode === "hindi") {
    return {
      name: "Wikimedia Commons",
      title: "Hindi & Hindustani",
      emptyHeading: "Hindi music, ready to stream",
      emptyCopy: "Browse openly licensed Hindi-language songs, Hindustani classics, folk recordings, and Indian music from Wikimedia Commons.",
      loadingCopy: "Loading openly licensed Hindi-language and Hindustani recordings from Wikimedia Commons.",
      note: "Streaming openly licensed Hindi-language and Hindustani recordings from",
      url: "https://commons.wikimedia.org/wiki/Category:Hindi-language_songs",
      quickAction: "refresh-catalog",
      quickLabel: "Show Hindi recordings"
    };
  }
  if (mode === "radio") {
    return {
      name: "Radio Browser",
      title: "Live Hindi radio",
      emptyHeading: "Live Hindi radio, ready to play",
      emptyCopy: "Browse public Hindi and Bollywood radio stations. Each station plays a continuous live broadcast, not a song-on-demand catalog.",
      loadingCopy: "Finding currently available Hindi and Bollywood radio stations.",
      note: "Listening to public live-station streams listed by",
      url: RADIO_BROWSER_SITE_URL,
      quickAction: "refresh-radio",
      quickLabel: "Find live stations"
    };
  }
  return {
    name: "Internet Archive Netlabels",
    title: "Open catalog",
    emptyHeading: "Free music, ready to stream",
    emptyCopy: "Search openly licensed Creative Commons and public-domain music from Internet Archive Netlabels. Nothing is copied into your library unless you add your own file.",
    loadingCopy: "Checking the Internet Archive catalog for openly licensed tracks that can stream here.",
    note: "Streaming Creative Commons/public-domain audio from",
    url: "https://archive.org/",
    quickAction: "catalog-quick-query",
    quickLabel: "Try ambient music"
  };
}

function playlistById(id) {
  return appState.playlists.find((playlist) => playlist.id === id);
}

function uniqueIds(ids) {
  return [...new Set(ids.filter((id) => trackById(id)))];
}

function colorFor(subject) {
  const seed = Number.isInteger(subject?.color) ? subject.color : 0;
  return COLORS[Math.abs(seed) % COLORS.length];
}

function artMarkup(subject, className = "", symbol = "♫") {
  const [a, b] = colorFor(subject);
  return `<span class="cover-art ${className}" style="--a:${a};--b:${b}"><b>${symbol}</b></span>`;
}

function playlistArtMarkup(playlist) {
  const [a, b] = colorFor(playlist);
  return `<span class="playlist-card-art" style="--a:${a};--b:${b}">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l10-7z" /><path d="M4 6h1M4 12h1M4 18h1" /></svg>
  </span>`;
}

function durationText(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "--:--";
  const rounded = Math.floor(seconds);
  const minutes = Math.floor(rounded / 60);
  const secs = String(rounded % 60).padStart(2, "0");
  return `${minutes}:${secs}`;
}

function currentView() {
  const route = window.location.hash.replace(/^#/, "") || "home";
  return route;
}

function isCurrent(track) {
  return player.currentId === track.id;
}

function isPlaying() {
  return Boolean(player.currentId && !audio.paused && !audio.ended);
}

function playIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>`;
}

function pauseIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h3v14H8zM13 5h3v14h-3z" /></svg>`;
}

function addIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>`;
}

function heartIcon(filled = false) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" ${filled ? 'style="fill:currentColor"' : ""}><path d="M20.8 4.7a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.5 1-1a5.5 5.5 0 0 0 0-7.8Z" /></svg>`;
}

function moreIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="19" r="1" fill="currentColor" /></svg>`;
}

function externalIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8" /><path d="M17 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h5" /></svg>`;
}

function searchIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.75" cy="10.75" r="6.75" /><path d="m16 16 4.5 4.5" /></svg>`;
}

function songRows(tracks, options = {}) {
  const { emptyMessage = "No music here yet.", queue = tracks.map((track) => track.id) } = options;
  if (!tracks.length) {
    return `<div class="empty-state"><div><span class="empty-icon">♫</span><h2>${escapeHtml(emptyMessage)}</h2><p>Import songs from your device to start listening offline.</p><button class="button button--small" data-action="open-import" type="button">${addIcon()} Add music</button></div></div>`;
  }
  const queueAttribute = escapeHtml(queue.join(","));
  return `<div class="song-list">${tracks.map((track, index) => {
    const current = isCurrent(track);
    const playing = current && isPlaying();
    const isCatalogTrack = Boolean(track.streamUrl);
    const isLiveStation = Boolean(track.isLive);
    const sourceName = track.sourceName || "Internet Archive";
    const secondary = isCatalogTrack
      ? `${escapeHtml(track.artist || "Open music")} · ${escapeHtml(isLiveStation ? "Live station" : track.licenseLabel || "Open license")}`
      : escapeHtml(track.artist || "Unknown artist");
    const actions = isCatalogTrack
      ? `<a class="icon-button more-button song-action source-link" href="${escapeHtml(track.sourcePage)}" target="_blank" rel="noreferrer" aria-label="View ${escapeHtml(track.title)} on ${escapeHtml(sourceName)}">${externalIcon()}</a>`
      : `<div class="song-menu">
          <button class="icon-button more-button song-action" data-action="toggle-menu" type="button" aria-label="More options for ${escapeHtml(track.title)}">${moreIcon()}</button>
          <div class="song-actions" role="menu">
            <button data-action="toggle-like" data-id="${track.id}" type="button" role="menuitem">${track.loved ? "Remove from favorites" : "Add to favorites"}</button>
            <button data-action="add-to-playlist" data-id="${track.id}" type="button" role="menuitem">Add to playlist</button>
            <button data-action="delete-track" data-id="${track.id}" type="button" role="menuitem">Remove from device</button>
          </div>
        </div>`;
    return `<article class="song-row ${current ? "is-current" : ""}" data-song-id="${track.id}">
      <button class="song-play" data-action="play-track" data-id="${track.id}" data-queue="${queueAttribute}" type="button" aria-label="${playing ? "Pause" : "Play"} ${escapeHtml(track.title)}">
        ${playing ? pauseIcon() : artMarkup(track, "cover-art--small")}
      </button>
      <button class="song-copy" data-action="play-track" data-id="${track.id}" data-queue="${queueAttribute}" type="button">
        <span class="song-title">${escapeHtml(track.title)}</span>
        <span class="song-artist">${secondary}</span>
        ${isCatalogTrack ? `<span class="song-source">${escapeHtml(sourceName)} · ${isLiveStation ? "live radio" : "streaming online"}</span>` : ""}
      </button>
      ${actions}
    </article>`;
  }).join("")}</div>`;
}

function homeMarkup() {
  const hasMusic = appState.tracks.length > 0;
  const recent = [...appState.tracks].sort((a, b) => (b.lastPlayedAt || b.createdAt) - (a.lastPlayedAt || a.createdAt)).slice(0, 6);
  const favorites = appState.tracks.filter((track) => track.loved);
  const playlists = appState.playlists.slice(0, 3);
  const totalMinutes = Math.round(appState.tracks.reduce((sum, track) => sum + (Number(track.duration) || 0), 0) / 60);

  return `<section class="view" aria-labelledby="home-title">
    <div class="hero">
      <div class="hero-copy">
        <p class="eyebrow">Your offline soundtrack</p>
        <h1 id="home-title">Music that stays yours.</h1>
        <p>${hasMusic ? "Your personal library is ready whenever you are — even when your signal is not." : "Add your own music for offline listening, or discover openly licensed tracks to stream online."}</p>
        <div class="hero-actions"><button class="button" data-action="open-import" type="button">${addIcon()} Add music</button><button class="button button--ghost" data-action="open-catalog" type="button">Browse open music</button><button class="button button--ghost" data-action="open-hindi-catalog" type="button">Hindi music</button><button class="button button--ghost" data-action="open-live-radio" type="button">Live Hindi radio</button></div>
      </div>
    </div>

    ${hasMusic ? `<section class="section" aria-label="Your collections">
      <div class="quick-grid">
        <button class="quick-card" data-action="show-library-filter" data-filter="favorites" type="button">
          <span class="quick-cover" style="background:linear-gradient(135deg,#d46791,#f3a26e)"></span><span>Favorites</span>
        </button>
        <button class="quick-card" data-action="show-library-filter" data-filter="songs" type="button">
          <span class="quick-cover" style="background:linear-gradient(135deg,#4e88cb,#8be0c1)"></span><span>All songs</span>
        </button>
        ${playlists.map((playlist) => `<button class="quick-card" data-action="open-playlist" data-id="${playlist.id}" type="button">${playlistArtMarkup(playlist)}<span>${escapeHtml(playlist.name)}</span></button>`).join("")}
      </div>
    </section>
    <section class="section">
      <div class="section-header"><h2 class="section-title">Pick up where you left off</h2><a class="text-link" href="#library">See library</a></div>
      ${songRows(recent, { queue: recent.map((track) => track.id) })}
    </section>
    <section class="section">
      <div class="stat-grid" aria-label="Library summary">
        <div class="stat-card"><strong>${appState.tracks.length}</strong><span>songs stored</span></div>
        <div class="stat-card"><strong>${favorites.length}</strong><span>favorites</span></div>
        <div class="stat-card"><strong>${totalMinutes || "—"}</strong><span>${totalMinutes ? "minutes offline" : "playtime"}</span></div>
      </div>
    </section>` : `<section class="section">
      <div class="empty-state"><div><span class="empty-icon">♫</span><h2>Your music will appear here</h2><p>Choose audio files from your phone or computer. They are stored in this browser, so you can keep listening offline.</p><button class="button" data-action="open-import" type="button">${addIcon()} Import your first song</button></div></div>
    </section>`}
    <section class="section catalog-callout"><div><p class="eyebrow">Listen online</p><h2 class="section-title">Explore free music and live radio</h2><p>Search Creative Commons and public-domain audio from Internet Archive Netlabels, open Hindi/Hindustani recordings from Wikimedia Commons, or tune into live Hindi radio.</p></div><div class="catalog-callout-actions"><button class="button button--small" data-action="open-catalog" type="button">Open catalog</button><button class="button button--small button--ghost" data-action="open-hindi-catalog" type="button">Hindi music</button><button class="button button--small button--ghost" data-action="open-live-radio" type="button">Live radio</button></div></section>
  </section>`;
}

function searchMarkup() {
  const query = appState.searchQuery || "";
  const catalogMode = appState.searchType === "catalog";
  const hindiMode = appState.searchType === "hindi";
  const radioMode = appState.searchType === "radio";
  const catalogSearch = isCatalogSearch();
  const results = filteredTracks(query);
  return `<section class="view" aria-labelledby="search-title">
    <p class="eyebrow">${radioMode ? "Radio Browser" : hindiMode ? "Wikimedia Commons" : catalogMode ? "Internet Archive open music" : "Find your sound"}</p>
    <h1 class="page-title" id="search-title">${radioMode ? "Live Hindi radio" : hindiMode ? "Hindi & Hindustani music" : catalogMode ? "Search open music" : "Search your library"}</h1>
    <form class="search-box" id="music-search-form" role="search">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.75" cy="10.75" r="6.75" /><path d="m16 16 4.5 4.5" /></svg>
      <input id="search-input" class="search-input" value="${escapeHtml(query)}" autocomplete="off" placeholder="${radioMode ? "Station, city, genre, or Bollywood" : hindiMode ? "Hindi title, artist, raga, or folk song" : catalogMode ? "Artist, song, genre, or mood" : "Songs, artists, playlists"}" />
      <button class="search-submit" type="submit" aria-label="${radioMode ? "Search live radio" : catalogSearch ? "Search open music" : "Search your library"}">${searchIcon()}</button>
    </form>
    <div class="filter-row" aria-label="Search filter">
      <button class="chip ${!appState.searchType || appState.searchType === "all" ? "is-active" : ""}" data-action="set-search-type" data-type="all" type="button">Your library</button>
      <button class="chip ${catalogMode ? "is-active" : ""}" data-action="set-search-type" data-type="catalog" type="button">Open catalog</button>
      <button class="chip ${hindiMode ? "is-active" : ""}" data-action="set-search-type" data-type="hindi" type="button">Hindi & Hindustani</button>
      <button class="chip ${radioMode ? "is-active" : ""}" data-action="set-search-type" data-type="radio" type="button">Live Hindi radio</button>
      <button class="chip ${appState.searchType === "favorites" ? "is-active" : ""}" data-action="set-search-type" data-type="favorites" type="button">Favorites</button>
      <button class="chip ${appState.searchType === "playlists" ? "is-active" : ""}" data-action="set-search-type" data-type="playlists" type="button">Playlists</button>
    </div>
    <div id="search-results">${catalogSearch ? catalogResultsMarkup() : searchResultsMarkup(results, query)}</div>
  </section>`;
}

function filteredTracks(query) {
  const lowered = query.trim().toLowerCase();
  let tracks = [...appState.tracks];
  if (appState.searchType === "favorites") tracks = tracks.filter((track) => track.loved);
  if (lowered) tracks = tracks.filter((track) => [track.title, track.artist, track.album].some((field) => String(field || "").toLowerCase().includes(lowered)));
  return tracks.sort((a, b) => a.title.localeCompare(b.title));
}

function searchResultsMarkup(results, query) {
  if (appState.searchType === "playlists") {
    const lowered = query.trim().toLowerCase();
    const playlists = appState.playlists.filter((playlist) => !lowered || playlist.name.toLowerCase().includes(lowered));
    return playlistGridMarkup(playlists, "No playlists match that search.");
  }
  if (!appState.tracks.length) return `<div class="empty-state"><div><span class="empty-icon">⌕</span><h2>Nothing to search yet</h2><p>Import a few tracks, then find them by song title or artist.</p><button class="button button--small" data-action="open-import" type="button">${addIcon()} Add music</button></div></div>`;
  if (!results.length) return `<div class="empty-state"><div><span class="empty-icon">⌕</span><h2>No matches yet</h2><p>Try another title, artist, or playlist.</p></div></div>`;
  return `<section class="section"><div class="section-header"><h2 class="section-title">${query ? `${results.length} result${results.length === 1 ? "" : "s"}` : "All songs"}</h2></div>${songRows(results, { queue: results.map((track) => track.id) })}</section>`;
}

function catalogResultsMarkup() {
  const typedQuery = (appState.searchQuery || "").trim();
  const mode = activeCatalogMode();
  const source = catalogSourceInfo(mode);
  const currentState = catalogState.mode === mode ? catalogState : { status: "idle", query: "", tracks: [], error: "", mode };
  if (currentState.status === "loading") {
    return `<div class="empty-state"><div><span class="empty-icon">♫</span><h2>${mode === "radio" ? "Finding live stations" : "Finding open music"}</h2><p>${escapeHtml(source.loadingCopy)}</p></div></div>`;
  }
  if (currentState.status === "error") {
    return `<div class="empty-state"><div><span class="empty-icon">!</span><h2>${mode === "radio" ? "Radio directory unavailable" : "Catalog unavailable right now"}</h2><p>${escapeHtml(currentState.error)}</p><button class="button button--small" data-action="refresh-catalog" type="button">Try again</button></div></div>`;
  }
  if (!currentState.tracks.length) {
    return `<div class="empty-state"><div><span class="empty-icon">♫</span><h2>${escapeHtml(source.emptyHeading)}</h2><p>${escapeHtml(source.emptyCopy)}</p><button class="button button--small" data-action="${source.quickAction}" type="button">${escapeHtml(source.quickLabel)}</button></div></div>`;
  }
  const needsRefresh = currentState.query !== typedQuery;
  const supportNote = mode === "hindi" ? " Some recordings use OGG or Opus, which depends on your phone browser support." : "";
  const resultLabel = mode === "radio" ? "stations" : "streams";
  const attribution = mode === "radio"
    ? " Stations provide their own broadcasts; availability and rights are managed by each broadcaster. This is live radio, not an on-demand song catalog."
    : " Creator and license details stay with every result.";
  return `<section class="section"><div class="section-header"><h2 class="section-title">${escapeHtml(source.title)}</h2><span class="text-link">${currentState.tracks.length} ${resultLabel}</span></div><p class="catalog-note">${escapeHtml(source.note)} <a href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.name)}</a>.${attribution}${supportNote}</p>${needsRefresh ? `<p class="catalog-refresh">Tap search to update these results.</p>` : ""}${songRows(currentState.tracks, { queue: currentState.tracks.map((track) => track.id) })}</section>`;
}

function cleanCatalogQuery(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9\s-]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
}

function archiveCatalogQuery(query) {
  const clauses = [
    "mediatype:audio",
    "collection:netlabels",
    "(licenseurl:*creativecommons.org* OR licenseurl:*publicdomain*)",
    'format:"VBR MP3"'
  ];
  const terms = cleanCatalogQuery(query);
  if (terms.length) clauses.push(`(${terms.join(" AND ")})`);
  return clauses.join(" AND ");
}

function archiveAudioScore(file) {
  const name = String(file?.name || "");
  if (!/\.(mp3|ogg|opus|m4a|aac|wav|flac)$/i.test(name) || file?.private === "true") return -1;
  const format = String(file?.format || "").toLowerCase();
  let score = 1;
  if (format.includes("vbr mp3")) score += 90;
  else if (format === "mp3" || format.includes("mp3")) score += 80;
  else if (format.includes("ogg") || format.includes("opus")) score += 70;
  else if (format.includes("aac") || format.includes("m4a")) score += 60;
  else if (format.includes("wav") || format.includes("flac")) score += 50;
  if (file.source === "derivative") score += 4;
  return score;
}

function playableArchiveFile(files) {
  return [...files]
    .map((file) => ({ file, score: archiveAudioScore(file) }))
    .filter((candidate) => candidate.score >= 0)
    .sort((a, b) => b.score - a.score)[0]?.file || null;
}

function hashValue(value) {
  let hash = 0;
  for (const character of String(value)) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return Math.abs(hash);
}

function archiveFilePath(fileName) {
  return String(fileName).split("/").map((part) => encodeURIComponent(part)).join("/");
}

function archiveTrackId(identifier, fileName) {
  return `archive-${encodeURIComponent(identifier).replace(/%/g, "_")}-${encodeURIComponent(fileName).replace(/%/g, "_")}`;
}

function openLicenseLabel(url) {
  return /publicdomain/i.test(String(url || "")) ? "Public domain" : "Creative Commons";
}

function plainText(value) {
  const template = document.createElement("template");
  template.innerHTML = String(value || "");
  return (template.content.textContent || "").replace(/\s+/g, " ").trim();
}

function isCommonsAudioFile(page, info) {
  const title = String(page?.title || "");
  const url = String(info?.url || "");
  const mime = String(info?.mime || "").toLowerCase();
  return mime.startsWith("audio/")
    || /application\/(ogg|opus)/.test(mime)
    || /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)(?:$|\?)/i.test(`${title} ${url}`);
}

function commonsPageToTrack(page, category, index) {
  const info = page?.imageinfo?.[0];
  if (!info || !isCommonsAudioFile(page, info)) return null;
  const byteSize = Number(info.size || 0);
  if (byteSize > 50 * 1024 * 1024) return null;
  const metadata = info.extmetadata || {};
  const licenseLabel = plainText(metadata.LicenseShortName?.value || metadata.UsageTerms?.value || "");
  const licenseUrl = plainText(metadata.LicenseUrl?.value || "");
  if (!licenseLabel || /unknown|non-free|fair use/i.test(licenseLabel)) return null;
  const fileTitle = String(page.title || "Untitled Hindi recording")
    .replace(/^File:/i, "")
    .replace(/\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i, "");
  const title = plainText(metadata.ObjectName?.value) || fileTitle;
  const artist = plainText(metadata.Artist?.value) || "Wikimedia Commons contributor";
  const pageId = page.pageid || `${category.title}-${index}-${title}`;
  return {
    id: `commons-${pageId}`,
    title,
    artist,
    album: category.label,
    duration: 0,
    color: hashValue(`commons-${pageId}`),
    streamUrl: String(info.url || ""),
    sourcePage: String(info.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title || "")}`),
    sourceName: "Wikimedia Commons",
    licenseLabel,
    licenseUrl: licenseUrl || String(info.descriptionurl || "")
  };
}

function hindiSearchTerms(query) {
  return String(query || "")
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter((term) => term && !["hindi", "hindustani", "india", "indian", "music", "song", "songs"].includes(term));
}

function filterHindiCommonsTracks(tracks, query) {
  const terms = hindiSearchTerms(query);
  if (!terms.length) return tracks;
  return tracks.filter((track) => {
    const haystack = [track.title, track.artist, track.album].join(" ").toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

async function fetchHindiCommonsCategory(category, signal) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    origin: "*",
    generator: "categorymembers",
    gcmtitle: category.title,
    gcmtype: "file",
    gcmlimit: "100",
    prop: "imageinfo",
    iiprop: "url|mime|size|extmetadata"
  });
  const response = await fetch(`${COMMONS_API_URL}?${params.toString()}`, { signal });
  if (!response.ok) throw new Error("Wikimedia Commons did not respond.");
  const payload = await response.json();
  const pages = Array.isArray(payload?.query?.pages) ? payload.query.pages : Object.values(payload?.query?.pages || {});
  return pages.map((page, index) => commonsPageToTrack(page, category, index)).filter(Boolean);
}

async function archiveDocumentToTrack(document, index, signal) {
  const identifier = String(document.identifier || "");
  if (!identifier) return null;
  const response = await fetch(`${ARCHIVE_METADATA_URL}${encodeURIComponent(identifier)}`, { signal });
  if (!response.ok) return null;
  const item = await response.json();
  const file = playableArchiveFile(item.files || []);
  if (!file) return null;
  const metadata = item.metadata || {};
  const licenseUrl = metadata.licenseurl || document.licenseurl || "";
  const fileName = String(file.name || "");
  return {
    id: archiveTrackId(identifier, `${index}-${fileName}`),
    title: metadata.title || document.title || fileName.replace(/\.[^/.]+$/, "") || "Untitled open track",
    artist: metadata.creator || document.creator || "Internet Archive creator",
    album: metadata.collection || "Open music catalog",
    duration: Number(file.length || file.duration || 0),
    color: hashValue(`${identifier}/${fileName}`),
    streamUrl: `https://archive.org/download/${encodeURIComponent(identifier)}/${archiveFilePath(fileName)}`,
    sourcePage: `https://archive.org/details/${encodeURIComponent(identifier)}`,
    sourceName: "Internet Archive Netlabels",
    licenseLabel: openLicenseLabel(licenseUrl),
    licenseUrl
  };
}

async function searchOpenCatalog(query) {
  const normalizedQuery = String(query || "").trim();
  catalogRequestController?.abort();
  const requestId = ++catalogRequestId;
  const controller = new AbortController();
  catalogRequestController = controller;
  const previousTracks = catalogState.mode === "catalog" ? catalogState.tracks : [];
  catalogState = { status: "loading", query: normalizedQuery, tracks: previousTracks, error: "", mode: "catalog" };
  renderSearchResults();

  try {
    const params = new URLSearchParams({ q: archiveCatalogQuery(normalizedQuery), rows: "16", page: "1", output: "json" });
    ["identifier", "title", "creator", "licenseurl"].forEach((field) => params.append("fl[]", field));
    const response = await fetch(`${ARCHIVE_SEARCH_URL}?${params.toString()}`, { signal: controller.signal });
    if (!response.ok) throw new Error("The open music catalog did not respond.");
    const payload = await response.json();
    const documents = payload?.response?.docs || [];
    const candidates = await Promise.allSettled(documents.slice(0, 12).map((document, index) => archiveDocumentToTrack(document, index, controller.signal)));
    if (requestId !== catalogRequestId) return;
    const tracks = candidates
      .filter((candidate) => candidate.status === "fulfilled" && candidate.value)
      .map((candidate) => candidate.value)
      .slice(0, 8);
    tracks.forEach((track) => catalogTrackCache.set(track.id, track));
    catalogState = { status: "ready", query: normalizedQuery, tracks, error: "", mode: "catalog" };
  } catch (error) {
    if (error?.name === "AbortError" || requestId !== catalogRequestId) return;
    console.error(error);
    catalogState = { status: "error", query: normalizedQuery, tracks: [], error: "Check your connection, then search the catalog again.", mode: "catalog" };
  } finally {
    if (requestId === catalogRequestId) {
      catalogRequestController = null;
      renderSearchResults();
    }
  }
}

async function searchHindiCatalog(query) {
  const normalizedQuery = String(query || "").trim();
  catalogRequestController?.abort();
  const requestId = ++catalogRequestId;
  const controller = new AbortController();
  catalogRequestController = controller;
  const previousTracks = catalogState.mode === "hindi" ? catalogState.tracks : [];
  catalogState = { status: "loading", query: normalizedQuery, tracks: previousTracks, error: "", mode: "hindi" };
  renderSearchResults();

  try {
    if (!hindiCommonsTracks) {
      const batches = await Promise.allSettled(HINDI_COMMONS_CATEGORIES.map((category) => fetchHindiCommonsCategory(category, controller.signal)));
      if (requestId !== catalogRequestId) return;
      const tracks = batches
        .filter((batch) => batch.status === "fulfilled")
        .flatMap((batch) => batch.value);
      if (!tracks.length) throw new Error("No open Hindi recordings were returned.");
      const uniqueTracks = [...new Map(tracks.map((track) => [track.id, track])).values()]
        .sort((a, b) => a.title.localeCompare(b.title));
      hindiCommonsTracks = uniqueTracks;
      uniqueTracks.forEach((track) => catalogTrackCache.set(track.id, track));
    }
    const tracks = filterHindiCommonsTracks(hindiCommonsTracks, normalizedQuery).slice(0, 32);
    catalogState = { status: "ready", query: normalizedQuery, tracks, error: "", mode: "hindi" };
  } catch (error) {
    if (error?.name === "AbortError" || requestId !== catalogRequestId) return;
    console.error(error);
    catalogState = { status: "error", query: normalizedQuery, tracks: [], error: "Check your connection, then try the Hindi catalog again.", mode: "hindi" };
  } finally {
    if (requestId === catalogRequestId) {
      catalogRequestController = null;
      renderSearchResults();
    }
  }
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function radioStationToTrack(station) {
  const streamUrl = safeHttpsUrl(station?.url_resolved);
  const codec = plainText(station?.codec || "").toUpperCase();
  const isCheckedOnline = station?.lastcheckok === true || Number(station?.lastcheckok) === 1;
  if (!streamUrl || !isCheckedOnline || Number(station?.ssl_error || 0) !== 0 || Number(station?.hls || 0) !== 0 || !/^(MP3|AAC\+?|M4A)$/.test(codec)) return null;

  const name = plainText(station?.name || "");
  if (!name) return null;
  const nameText = name.toLocaleLowerCase();
  const tags = plainText(station?.tags || "").toLocaleLowerCase();
  const language = plainText(station?.language || "").toLocaleLowerCase();
  const relevantLabel = /\b(hindi|bollywood|desi|hindustani)\b/.test(`${nameText} ${tags}`);
  const compatibleLanguage = !language || /\b(hindi|urdu|hindustani)\b/.test(language);
  const explicitlyRelevantName = /\b(hindi|bollywood|desi|hindustani)\b/.test(nameText);
  if (!relevantLabel || (!compatibleLanguage && !explicitlyRelevantName)) return null;
  const stationId = String(station?.stationuuid || `${name}-${streamUrl}`);
  const location = [station?.country, station?.state, station?.language]
    .map((value) => plainText(value))
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(" · ");
  const homepage = safeHttpsUrl(station?.homepage) || RADIO_BROWSER_SITE_URL;
  const id = `radio-${hashValue(stationId)}`;
  return {
    id,
    title: name,
    artist: location || "Live Hindi radio",
    album: tags ? `Live radio · ${tags}` : "Live Hindi radio",
    duration: 0,
    color: hashValue(`radio-${stationId}`),
    streamUrl,
    sourcePage: homepage,
    sourceName: "Radio Browser",
    licenseLabel: "Live radio",
    licenseUrl: homepage,
    isLive: true,
    popularity: Number(station?.clickcount || station?.votes || 0),
    radioSearch: [name, location, tags, station?.country, station?.state, station?.language, codec].join(" ").toLocaleLowerCase()
  };
}

function radioSearchTerms(query) {
  return String(query || "")
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter((term) => term && !["hindi", "bollywood", "india", "indian", "radio", "live", "music"].includes(term));
}

function filterHindiRadioStations(stations, query) {
  const terms = radioSearchTerms(query);
  if (!terms.length) return stations;
  return stations.filter((station) => terms.every((term) => station.radioSearch.includes(term)));
}

async function fetchHindiRadioTag(tag, signal) {
  const params = new URLSearchParams({
    tag,
    tagExact: "true",
    hidebroken: "true",
    limit: "50",
    order: "clickcount",
    reverse: "true"
  });
  const response = await fetch(`${RADIO_BROWSER_API_URL}/stations/search?${params.toString()}`, { signal });
  if (!response.ok) throw new Error("Radio Browser did not respond.");
  const stations = await response.json();
  if (!Array.isArray(stations)) throw new Error("Radio Browser returned an unexpected response.");
  return stations.map(radioStationToTrack).filter(Boolean);
}

async function searchHindiRadio(query, { refresh = false } = {}) {
  const normalizedQuery = String(query || "").trim();
  catalogRequestController?.abort();
  const requestId = ++catalogRequestId;
  const controller = new AbortController();
  catalogRequestController = controller;
  const previousTracks = catalogState.mode === "radio" ? catalogState.tracks : [];
  catalogState = { status: "loading", query: normalizedQuery, tracks: previousTracks, error: "", mode: "radio" };
  renderSearchResults();

  try {
    if (!hindiRadioStations || refresh) {
      const batches = await Promise.allSettled(HINDI_RADIO_TAGS.map((tag) => fetchHindiRadioTag(tag, controller.signal)));
      if (requestId !== catalogRequestId) return;
      const stations = batches
        .filter((batch) => batch.status === "fulfilled")
        .flatMap((batch) => batch.value);
      if (!stations.length) throw new Error("No available Hindi radio stations were returned.");
      hindiRadioStations = [...new Map(stations.map((station) => [station.streamUrl, station])).values()]
        .sort((a, b) => b.popularity - a.popularity || a.title.localeCompare(b.title));
      hindiRadioStations.forEach((station) => catalogTrackCache.set(station.id, station));
    }
    const stations = filterHindiRadioStations(hindiRadioStations, normalizedQuery).slice(0, 32);
    catalogState = { status: "ready", query: normalizedQuery, tracks: stations, error: "", mode: "radio" };
  } catch (error) {
    if (error?.name === "AbortError" || requestId !== catalogRequestId) return;
    console.error(error);
    catalogState = { status: "error", query: normalizedQuery, tracks: [], error: "Check your connection, then try the live-radio directory again.", mode: "radio" };
  } finally {
    if (requestId === catalogRequestId) {
      catalogRequestController = null;
      renderSearchResults();
    }
  }
}

function libraryMarkup() {
  const filter = appState.libraryFilter || "all";
  let libraryBody = "";
  if (filter === "playlists") {
    libraryBody = playlistGridMarkup(appState.playlists, "You have not made a playlist yet.");
  } else {
    let tracks = [...appState.tracks];
    if (filter === "favorites") tracks = tracks.filter((track) => track.loved);
    tracks.sort((a, b) => b.createdAt - a.createdAt);
    libraryBody = songRows(tracks, { emptyMessage: filter === "favorites" ? "No favorites yet." : "No songs in your library yet.", queue: tracks.map((track) => track.id) });
  }
  return `<section class="view" aria-labelledby="library-title">
    <div class="library-header">
      <div><p class="eyebrow">Everything in one place</p><h1 class="page-title" id="library-title">Your library</h1></div>
      <button class="button button--small" data-action="open-playlist-dialog" data-source="library" type="button">${addIcon()} Playlist</button>
    </div>
    <div class="filter-row" aria-label="Library filter">
      <button class="chip ${filter === "all" ? "is-active" : ""}" data-action="set-library-filter" data-filter="all" type="button">Songs</button>
      <button class="chip ${filter === "favorites" ? "is-active" : ""}" data-action="set-library-filter" data-filter="favorites" type="button">Favorites</button>
      <button class="chip ${filter === "playlists" ? "is-active" : ""}" data-action="set-library-filter" data-filter="playlists" type="button">Playlists</button>
    </div>
    <div id="library-results">${libraryBody}</div>
  </section>`;
}

function playlistGridMarkup(playlists, emptyMessage) {
  if (!playlists.length) {
    return `<div class="empty-state"><div><span class="empty-icon">▤</span><h2>${escapeHtml(emptyMessage)}</h2><p>Create one for a mood, a trip, or a favorite artist.</p><button class="button button--small" data-action="open-playlist-dialog" data-source="library" type="button">${addIcon()} New playlist</button></div></div>`;
  }
  return `<div class="playlist-grid">${playlists.map((playlist) => `<button class="playlist-card" data-action="open-playlist" data-id="${playlist.id}" type="button">
    ${playlistArtMarkup(playlist)}
    <span class="playlist-card-copy"><strong>${escapeHtml(playlist.name)}</strong><span>${playlist.trackIds.length} ${playlist.trackIds.length === 1 ? "song" : "songs"}</span></span>
  </button>`).join("")}</div>`;
}

function playlistMarkup(playlist) {
  const tracks = uniqueIds(playlist.trackIds).map(trackById).filter(Boolean);
  return `<section class="view" aria-labelledby="playlist-title">
    <button class="text-link" data-action="back-library" type="button">← Library</button>
    <div class="hero" style="margin-top:.45rem">
      <div class="hero-copy">
        <p class="eyebrow">Playlist</p>
        <h1 id="playlist-title">${escapeHtml(playlist.name)}</h1>
        <p>${tracks.length ? `${tracks.length} song${tracks.length === 1 ? "" : "s"} saved for this moment.` : "Add songs from your library using the ••• menu."}</p>
        ${tracks.length ? `<button class="button" data-action="play-playlist" data-id="${playlist.id}" type="button">${playIcon()} Play playlist</button>` : `<button class="button" data-action="open-import" type="button">${addIcon()} Add music</button>`}
      </div>
    </div>
    <section class="section"><div class="section-header"><h2 class="section-title">Tracks</h2><button class="text-link" data-action="delete-playlist" data-id="${playlist.id}" type="button">Delete</button></div>${songRows(tracks, { emptyMessage: "This playlist is waiting for songs.", queue: tracks.map((track) => track.id) })}</section>
  </section>`;
}

function render() {
  const route = currentView();
  let markup;
  if (route.startsWith("playlist/")) {
    const playlist = playlistById(route.slice("playlist/".length));
    markup = playlist ? playlistMarkup(playlist) : `<section class="view"><div class="empty-state"><div><span class="empty-icon">?</span><h2>That playlist is gone</h2><p>It may have been removed from this device.</p><a class="button button--small" href="#library">Back to library</a></div></div></section>`;
  } else if (route === "search") {
    markup = searchMarkup();
  } else if (route === "library") {
    markup = libraryMarkup();
  } else {
    markup = homeMarkup();
  }
  content.innerHTML = markup;
  $$(".nav-link").forEach((link) => link.classList.toggle("is-active", link.dataset.view === (route.startsWith("playlist/") ? "library" : route)));
  updatePlayerUI();
}

function renderSearchResults() {
  const target = $("#search-results");
  if (!target) return;
  target.innerHTML = isCatalogSearch()
    ? catalogResultsMarkup()
    : searchResultsMarkup(filteredTracks(appState.searchQuery || ""), appState.searchQuery || "");
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function isIosDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function syncInstallButton() {
  if (installButton) installButton.hidden = isStandalone();
}

function installSteps(items) {
  return `<ol class="install-steps">${items.map((item) => `<li><span>${item}</span></li>`).join("")}</ol>`;
}

function openInstallDialog() {
  if (isStandalone()) {
    showToast("Sonora is already installed on this phone.");
    return;
  }
  if (deferredInstallPrompt) {
    installInstructions.innerHTML = `<p>Install Sonora to launch it from your home screen and keep its offline library close at hand.</p><button class="button" data-action="run-install" type="button">Install Sonora</button>`;
  } else if (isIosDevice()) {
    installInstructions.innerHTML = `<p>iPhone and iPad install Sonora through Safari. Open this site in Safari first, then:</p>${installSteps(["Tap the Share button in Safari.", "Scroll to <strong>Add to Home Screen</strong>.", "Tap <strong>Add</strong> to place Sonora on your home screen."])}`;
  } else {
    installInstructions.innerHTML = `<p>For the best phone experience, open this site in Chrome or another modern mobile browser, then:</p>${installSteps(["Open your browser menu.", "Choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.", "Open Sonora from the new home-screen icon."])}`;
  }
  installDialog.showModal();
}

async function runInstallPrompt() {
  if (!deferredInstallPrompt) {
    showToast("Use your browser menu to add Sonora to your home screen.");
    return;
  }
  const prompt = deferredInstallPrompt;
  deferredInstallPrompt = null;
  await prompt.prompt();
  const choice = await prompt.userChoice;
  installDialog.close();
  showToast(choice.outcome === "accepted" ? "Sonora is being installed." : "Install canceled — you can try again anytime.");
  syncInstallButton();
}

function cleanTitle(fileName) {
  return fileName.replace(/\.[^/.]+$/, "").replace(/[._]+/g, " ").replace(/\s+/g, " ").trim() || "Untitled track";
}

function readDuration(file) {
  return new Promise((resolve) => {
    const probe = document.createElement("audio");
    const url = URL.createObjectURL(file);
    let settled = false;
    const done = (duration = 0) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(duration) ? duration : 0);
    };
    const timeout = window.setTimeout(() => done(), 7000);
    probe.preload = "metadata";
    probe.onloadedmetadata = () => {
      window.clearTimeout(timeout);
      done(probe.duration);
    };
    probe.onerror = () => {
      window.clearTimeout(timeout);
      done();
    };
    probe.src = url;
  });
}

function looksLikeAudio(file) {
  return file.type.startsWith("audio/") || /\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(file.name);
}

async function importFiles(fileList) {
  const files = [...fileList].filter(looksLikeAudio);
  if (!files.length) {
    showToast("Choose an audio file such as MP3, M4A, WAV, OGG, or FLAC.");
    return;
  }
  const fingerprints = new Set(appState.tracks.map((track) => track.fingerprint));
  const candidates = files.filter((file) => !fingerprints.has(`${file.name}:${file.size}`));
  if (!candidates.length) {
    showToast("Those songs are already in your library.");
    return;
  }
  let imported = 0;
  try {
    for (const file of candidates) {
      const id = crypto.randomUUID ? crypto.randomUUID() : `song-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const duration = await readDuration(file);
      await saveAudioFile(id, file);
      appState.tracks.unshift({
        id,
        title: cleanTitle(file.name),
        artist: "Your music",
        album: "Imported tracks",
        duration,
        createdAt: Date.now() + imported,
        loved: false,
        plays: 0,
        color: appState.tracks.length + imported,
        fingerprint: `${file.name}:${file.size}`
      });
      imported += 1;
    }
    saveState();
    render();
    showToast(`${imported} ${imported === 1 ? "song is" : "songs are"} ready to play offline.`);
  } catch (error) {
    console.error(error);
    showToast("Sonora could not save that music. Check this browser's storage permissions.");
  }
}

async function playTrack(id, requestedQueue = []) {
  const track = trackById(id);
  if (!track) return;

  if (player.currentId === id && audio.src) {
    if (audio.paused) {
      await resumePlayback();
    } else {
      audio.pause();
    }
    return;
  }

  try {
    let source;
    if (track.streamUrl) {
      source = track.streamUrl;
    } else {
      const blob = await getAudioFile(id);
      if (!blob) throw new Error("The audio file is no longer on this device.");
      source = URL.createObjectURL(blob);
    }
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = track.streamUrl ? null : source;
    player.currentId = id;
    player.queue = uniqueIds(requestedQueue.length ? requestedQueue : appState.tracks.map((item) => item.id));
    if (!player.queue.includes(id)) player.queue.unshift(id);
    audio.src = source;
    audio.currentTime = 0;
    if (!track.streamUrl) {
      track.lastPlayedAt = Date.now();
      track.plays = (track.plays || 0) + 1;
      saveState();
    }
    await audio.play();
    updateMediaSession(track);
    render();
    if (nowPlayingDialog.open) renderNowPlaying();
  } catch (error) {
    console.error(error);
    showToast(error.message || "That track could not be played.");
  }
}

async function resumePlayback() {
  if (!player.currentId) return;
  if (!audio.src) {
    await playTrack(player.currentId, player.queue);
    return;
  }
  try {
    await audio.play();
  } catch (error) {
    console.error(error);
    showToast("Your browser stopped playback. Tap play again to continue.");
  }
}

function currentQueue() {
  return player.queue.length ? player.queue.filter((id) => trackById(id)) : appState.tracks.map((track) => track.id);
}

async function nextTrack(fromEnd = false) {
  const queue = currentQueue();
  if (!queue.length) return;
  const index = Math.max(queue.indexOf(player.currentId), 0);
  let nextIndex;
  if (player.shuffle && queue.length > 1) {
    const alternatives = queue.filter((id) => id !== player.currentId);
    nextIndex = queue.indexOf(alternatives[Math.floor(Math.random() * alternatives.length)]);
  } else {
    nextIndex = index + 1;
  }
  if (nextIndex >= queue.length || nextIndex < 0) {
    if (player.repeat === "all" || !fromEnd) nextIndex = 0;
    else {
      audio.pause();
      return;
    }
  }
  await playTrack(queue[nextIndex], queue);
}

async function previousTrack() {
  if (audio.currentTime > 4) {
    audio.currentTime = 0;
    return;
  }
  const queue = currentQueue();
  if (!queue.length) return;
  const index = queue.indexOf(player.currentId);
  const previousIndex = index > 0 ? index - 1 : (player.repeat === "all" ? queue.length - 1 : 0);
  await playTrack(queue[previousIndex], queue);
}

function toggleFavorite(id) {
  const track = trackById(id);
  if (!track) return;
  track.loved = !track.loved;
  saveState();
  render();
  if (nowPlayingDialog.open) renderNowPlaying();
  showToast(track.loved ? "Added to favorites." : "Removed from favorites.");
}

async function deleteTrack(id) {
  const track = trackById(id);
  if (!track) return;
  if (!window.confirm(`Remove “${track.title}” from Sonora on this device?`)) return;
  try {
    if (player.currentId === id) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      player.currentId = null;
      if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }
    await removeAudioFile(id);
    appState.tracks = appState.tracks.filter((item) => item.id !== id);
    appState.playlists.forEach((playlist) => {
      playlist.trackIds = playlist.trackIds.filter((trackId) => trackId !== id);
    });
    player.queue = player.queue.filter((trackId) => trackId !== id);
    saveState();
    render();
    if (nowPlayingDialog.open) renderNowPlaying();
    showToast("Removed from this device.");
  } catch (error) {
    console.error(error);
    showToast("That track could not be removed.");
  }
}

function openPlaylistPicker(trackId) {
  selectedTrackId = trackId;
  if (!appState.playlists.length) {
    playlistPicker.innerHTML = `<div class="empty-state"><div><span class="empty-icon">▤</span><h2>Make your first playlist</h2><p>Then come back to add this song.</p><button class="button button--small" data-action="open-playlist-dialog" type="button">${addIcon()} New playlist</button></div></div>`;
  } else {
    playlistPicker.innerHTML = appState.playlists.map((playlist) => {
      const added = playlist.trackIds.includes(trackId);
      return `<button data-action="toggle-track-in-playlist" data-id="${playlist.id}" type="button"><span>${escapeHtml(playlist.name)}</span><small>${added ? "Remove" : "Add"}</small></button>`;
    }).join("");
  }
  addToPlaylistDialog.showModal();
}

function toggleTrackInPlaylist(playlistId) {
  const playlist = playlistById(playlistId);
  if (!playlist || !selectedTrackId) return;
  if (playlist.trackIds.includes(selectedTrackId)) {
    playlist.trackIds = playlist.trackIds.filter((id) => id !== selectedTrackId);
    showToast(`Removed from ${playlist.name}.`);
  } else {
    playlist.trackIds.push(selectedTrackId);
    showToast(`Added to ${playlist.name}.`);
  }
  saveState();
  addToPlaylistDialog.close();
  render();
}

function createPlaylist(name) {
  const cleaned = name.trim();
  if (!cleaned) return;
  const playlist = {
    id: crypto.randomUUID ? crypto.randomUUID() : `playlist-${Date.now()}`,
    name: cleaned,
    trackIds: selectedTrackId ? [selectedTrackId] : [],
    createdAt: Date.now(),
    color: appState.playlists.length + 2
  };
  appState.playlists.unshift(playlist);
  saveState();
  playlistForm.reset();
  playlistDialog.close();
  if (addToPlaylistDialog.open) addToPlaylistDialog.close();
  showToast(selectedTrackId ? `Created ${cleaned} and added this song.` : `Created ${cleaned}.`);
  selectedTrackId = null;
  render();
}

function deletePlaylist(id) {
  const playlist = playlistById(id);
  if (!playlist) return;
  if (!window.confirm(`Delete the playlist “${playlist.name}”? Your music files will stay in Sonora.`)) return;
  appState.playlists = appState.playlists.filter((item) => item.id !== id);
  saveState();
  window.location.hash = "library";
  showToast("Playlist deleted. Your music is still here.");
}

function toggleShuffle() {
  player.shuffle = !player.shuffle;
  saveState();
  updatePlayerUI();
  if (nowPlayingDialog.open) renderNowPlaying();
}

function cycleRepeat() {
  player.repeat = player.repeat === "off" ? "all" : player.repeat === "all" ? "one" : "off";
  saveState();
  updatePlayerUI();
  if (nowPlayingDialog.open) renderNowPlaying();
  showToast(player.repeat === "off" ? "Repeat off." : player.repeat === "all" ? "Repeat queue." : "Repeat this song.");
}

function updatePlayerUI() {
  const track = trackById(player.currentId);
  miniPlayer.hidden = !track;
  if (!track) return;
  const [a, b] = colorFor(track);
  miniArt.style.setProperty("--a", a);
  miniArt.style.setProperty("--b", b);
  miniTitle.textContent = track.title;
  miniArtist.textContent = track.artist || "Your music";
  miniTogglePath.setAttribute("d", isPlaying() ? "M8 5h3v14H8zM13 5h3v14h-3z" : "M8 5v14l11-7z");
  const duration = audio.duration || track.duration || 0;
  const progress = duration ? Math.min(100, Math.max(0, audio.currentTime / duration * 100)) : 0;
  miniProgress.style.width = `${progress}%`;
  if (nowPlayingDialog.open) updateNowPlayingProgress();
}

function renderNowPlaying() {
  const track = trackById(player.currentId);
  if (!track) return;
  const queue = currentQueue().map(trackById).filter(Boolean);
  const [a, b] = colorFor(track);
  const isCatalogTrack = Boolean(track.streamUrl);
  const isLiveStation = Boolean(track.isLive);
  const sourceName = track.sourceName || "Internet Archive";
  const topAction = isCatalogTrack
    ? `<a class="icon-button" href="${escapeHtml(track.sourcePage)}" target="_blank" rel="noreferrer" aria-label="View source on ${escapeHtml(sourceName)}">${externalIcon()}</a>`
    : `<button class="icon-button" data-action="add-to-playlist" data-id="${track.id}" type="button" aria-label="Add to playlist">${addIcon()}</button>`;
  const sourceDetails = isCatalogTrack
    ? `<a class="catalog-now-source" href="${escapeHtml(track.licenseUrl || track.sourcePage)}" target="_blank" rel="noreferrer">${escapeHtml(track.licenseLabel || "Open license")} · ${escapeHtml(sourceName)}</a>`
    : "";
  const favoriteControl = isCatalogTrack
    ? ""
    : `<button class="icon-button heart-button ${track.loved ? "is-loved" : ""}" data-action="toggle-like" data-id="${track.id}" type="button" aria-label="${track.loved ? "Remove from favorites" : "Add to favorites"}">${heartIcon(track.loved)}</button>`;
  const timingControls = isLiveStation
    ? `<div class="time-row"><span>Live broadcast</span><span>Station stream</span></div>`
    : `<input id="now-scrubber" class="scrubber" type="range" min="0" max="100" value="0" step="0.1" aria-label="Song position" />
      <div class="time-row"><span id="now-current-time">0:00</span><span id="now-duration">${durationText(audio.duration || track.duration)}</span></div>`;
  nowPlayingContent.innerHTML = `<div class="now-top">
    <button class="icon-button" data-action="close-now-playing" type="button" aria-label="Close now playing"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button>
    <p>Now playing</p>
    ${topAction}
  </div>
  <span id="now-art" class="cover-art cover-art--large" style="--a:${a};--b:${b}"><b>♫</b></span>
  <div class="now-info">
    <div><h1 id="now-playing-title">${escapeHtml(track.title)}</h1><p>${escapeHtml(track.artist || "Your music")}</p>${sourceDetails}</div>
    ${favoriteControl}
  </div>
  ${timingControls}
  <div class="transport" aria-label="Playback controls">
    <button class="icon-button ${player.shuffle ? "is-on" : ""}" data-action="toggle-shuffle" type="button" aria-label="${player.shuffle ? "Turn shuffle off" : "Turn shuffle on"}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h3l10 10h3M17 7h3M4 17h3l3-3M14 10l3-3" /></svg></button>
    <button class="icon-button" data-action="previous-track" type="button" aria-label="Previous track"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 5v14l-9-7zM5 5v14" /></svg></button>
    <button class="icon-button now-toggle" data-action="toggle-playback" type="button" aria-label="${isPlaying() ? "Pause" : "Play"}" id="now-toggle">${isPlaying() ? pauseIcon() : playIcon()}</button>
    <button class="icon-button" data-action="next-track" type="button" aria-label="Next track"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 5 9 7-9 7zM19 5v14" /></svg></button>
    <button class="icon-button ${player.repeat !== "off" ? "is-on" : ""}" data-action="cycle-repeat" type="button" aria-label="Repeat ${player.repeat}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4" />${player.repeat === "one" ? '<path d="M12 11v4M11 12h1" />' : ""}</svg></button>
  </div>
  <section class="now-queue"><div class="section-header"><h2 class="section-title">Up next</h2><span class="text-link">${Math.max(queue.length - 1, 0)} queued</span></div>${songRows(queue.filter((item) => item.id !== track.id).slice(0, 4), { emptyMessage: "This is the last track in the queue.", queue: queue.map((item) => item.id) })}</section>`;
  updateNowPlayingProgress();
}

function updateNowPlayingProgress() {
  const scrubber = $("#now-scrubber");
  if (!scrubber) return;
  const track = trackById(player.currentId);
  const duration = audio.duration || track?.duration || 0;
  const progress = duration ? Math.min(100, Math.max(0, audio.currentTime / duration * 100)) : 0;
  scrubber.value = String(progress);
  const nowCurrentTime = $("#now-current-time");
  const nowDuration = $("#now-duration");
  if (nowCurrentTime) nowCurrentTime.textContent = durationText(audio.currentTime);
  if (nowDuration) nowDuration.textContent = durationText(duration);
  const nowToggle = $("#now-toggle");
  if (nowToggle) {
    nowToggle.innerHTML = isPlaying() ? pauseIcon() : playIcon();
    nowToggle.setAttribute("aria-label", isPlaying() ? "Pause" : "Play");
  }
}

function openNowPlaying() {
  if (!player.currentId) {
    showToast("Choose a song to start listening.");
    return;
  }
  renderNowPlaying();
  nowPlayingDialog.showModal();
}

function updateMediaSession(track) {
  if (!("mediaSession" in navigator)) return;
  if ("MediaMetadata" in window) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist || "Your music",
      album: track.album || "Sonora"
    });
  }
}

function installMediaSessionHandlers() {
  if (!("mediaSession" in navigator)) return;
  const safeHandler = (action, handler) => {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported action */ }
  };
  safeHandler("play", () => resumePlayback());
  safeHandler("pause", () => audio.pause());
  safeHandler("previoustrack", () => previousTrack());
  safeHandler("nexttrack", () => nextTrack());
  safeHandler("seekbackward", (details) => { audio.currentTime = Math.max(0, audio.currentTime - (details.seekOffset || 10)); });
  safeHandler("seekforward", (details) => { audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + (details.seekOffset || 10)); });
  safeHandler("seekto", (details) => { if (Number.isFinite(details.seekTime)) audio.currentTime = details.seekTime; });
}

function closeOpenMenus(except = null) {
  $$(".song-menu.is-open").forEach((menu) => {
    if (menu !== except) menu.classList.remove("is-open");
  });
}

async function handleAction(action, button) {
  const id = button.dataset.id;
  switch (action) {
    case "open-import":
      filePicker.click();
      break;
    case "play-track": {
      const queue = (button.dataset.queue || "").split(",").filter(Boolean);
      await playTrack(id, queue);
      break;
    }
    case "toggle-menu": {
      const menu = button.closest(".song-menu");
      const wasOpen = menu.classList.contains("is-open");
      closeOpenMenus(menu);
      menu.classList.toggle("is-open", !wasOpen);
      break;
    }
    case "toggle-like":
      toggleFavorite(id);
      break;
    case "add-to-playlist":
      openPlaylistPicker(id);
      break;
    case "delete-track":
      await deleteTrack(id);
      break;
    case "set-search-type":
      appState.searchType = button.dataset.type;
      render();
      $("#search-input")?.focus();
      if (appState.searchType === "catalog") await searchOpenCatalog(appState.searchQuery || "");
      if (appState.searchType === "hindi") await searchHindiCatalog(appState.searchQuery || "");
      if (appState.searchType === "radio") await searchHindiRadio(appState.searchQuery || "");
      break;
    case "open-catalog":
      appState.searchType = "catalog";
      window.location.hash = "search";
      render();
      $("#search-input")?.focus();
      await searchOpenCatalog(appState.searchQuery || "");
      break;
    case "catalog-quick-query":
      appState.searchType = "catalog";
      appState.searchQuery = button.dataset.query || "";
      window.location.hash = "search";
      render();
      $("#search-input")?.focus();
      await searchOpenCatalog(appState.searchQuery);
      break;
    case "open-hindi-catalog":
      appState.searchType = "hindi";
      window.location.hash = "search";
      render();
      $("#search-input")?.focus();
      await searchHindiCatalog(appState.searchQuery || "");
      break;
    case "open-live-radio":
      appState.searchType = "radio";
      appState.searchQuery = "";
      window.location.hash = "search";
      render();
      $("#search-input")?.focus();
      await searchHindiRadio("");
      break;
    case "refresh-catalog":
      if (appState.searchType === "hindi") await searchHindiCatalog(appState.searchQuery || catalogState.query || "");
      else if (appState.searchType === "radio") await searchHindiRadio(appState.searchQuery || catalogState.query || "", { refresh: true });
      else await searchOpenCatalog(appState.searchQuery || catalogState.query || "");
      break;
    case "refresh-radio":
      await searchHindiRadio(appState.searchQuery || catalogState.query || "", { refresh: true });
      break;
    case "set-library-filter":
      appState.libraryFilter = button.dataset.filter;
      render();
      break;
    case "show-library-filter":
      appState.libraryFilter = button.dataset.filter === "songs" ? "all" : button.dataset.filter;
      window.location.hash = "library";
      break;
    case "open-playlist-dialog":
      if (button.dataset.source === "library") selectedTrackId = null;
      if (addToPlaylistDialog.open) addToPlaylistDialog.close();
      playlistDialog.showModal();
      setTimeout(() => playlistName.focus(), 0);
      break;
    case "open-playlist":
      window.location.hash = `playlist/${id}`;
      break;
    case "back-library":
      window.location.hash = "library";
      break;
    case "play-playlist": {
      const playlist = playlistById(id);
      const queue = uniqueIds(playlist?.trackIds || []);
      if (queue.length) await playTrack(queue[0], queue);
      break;
    }
    case "delete-playlist":
      deletePlaylist(id);
      break;
    case "toggle-track-in-playlist":
      toggleTrackInPlaylist(id);
      break;
    case "toggle-shuffle":
      toggleShuffle();
      break;
    case "cycle-repeat":
      cycleRepeat();
      break;
    case "previous-track":
      await previousTrack();
      break;
    case "next-track":
      await nextTrack();
      break;
    case "toggle-playback":
      if (isPlaying()) audio.pause(); else await resumePlayback();
      break;
    case "close-now-playing":
      nowPlayingDialog.close();
      break;
    case "run-install":
      await runInstallPrompt();
      break;
    default:
      break;
  }
}

document.addEventListener("click", async (event) => {
  const actionButton = event.target.closest("[data-action]");
  if (actionButton) {
    event.preventDefault();
    await handleAction(actionButton.dataset.action, actionButton);
    return;
  }
  const closeButton = event.target.closest("[data-close-dialog]");
  if (closeButton) {
    closeButton.closest("dialog")?.close();
    return;
  }
  if (!event.target.closest(".song-menu")) closeOpenMenus();
});

document.addEventListener("submit", async (event) => {
  if (event.target.id !== "music-search-form") return;
  event.preventDefault();
  if (appState.searchType === "catalog") {
    await searchOpenCatalog(appState.searchQuery || "");
  } else if (appState.searchType === "hindi") {
    await searchHindiCatalog(appState.searchQuery || "");
  } else if (appState.searchType === "radio") {
    await searchHindiRadio(appState.searchQuery || "");
  } else {
    renderSearchResults();
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id === "search-input") {
    appState.searchQuery = event.target.value;
    renderSearchResults();
  }
  if (event.target.id === "now-scrubber") {
    const duration = audio.duration || trackById(player.currentId)?.duration || 0;
    if (duration) audio.currentTime = Number(event.target.value) / 100 * duration;
  }
});

$("#open-import-top").addEventListener("click", () => filePicker.click());
installButton.addEventListener("click", openInstallDialog);
$("#open-now-playing").addEventListener("click", openNowPlaying);
$("#open-now-playing-copy").addEventListener("click", openNowPlaying);
$("#mini-toggle").addEventListener("click", async () => {
  if (isPlaying()) audio.pause(); else await resumePlayback();
});

filePicker.addEventListener("change", async () => {
  if (filePicker.files?.length) await importFiles(filePicker.files);
  filePicker.value = "";
});

playlistForm.addEventListener("submit", (event) => {
  event.preventDefault();
  createPlaylist(playlistName.value);
});

audio.addEventListener("play", () => {
  updatePlayerUI();
  renderNowPlayingIfOpen();
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
});
audio.addEventListener("pause", () => {
  updatePlayerUI();
  renderNowPlayingIfOpen();
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
});
audio.addEventListener("timeupdate", () => {
  updatePlayerUI();
  if ("mediaSession" in navigator && Number.isFinite(audio.duration) && audio.duration > 0) {
    try { navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, audio.duration) }); } catch { /* older browser */ }
  }
});
audio.addEventListener("loadedmetadata", updatePlayerUI);
audio.addEventListener("ended", async () => {
  if (player.repeat === "one") {
    audio.currentTime = 0;
    await resumePlayback();
  } else {
    await nextTrack(true);
  }
});
audio.addEventListener("error", () => {
  if (player.currentId && audio.error) showToast("This audio format could not be played by this browser.");
});

function renderNowPlayingIfOpen() {
  if (nowPlayingDialog.open) renderNowPlaying();
}

window.addEventListener("hashchange", () => {
  closeOpenMenus();
  render();
  content.focus({ preventScroll: true });
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("service-worker.js").catch((error) => console.warn("Service worker registration failed", error)));
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  syncInstallButton();
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  syncInstallButton();
  showToast("Sonora is now on your home screen.");
});

installMediaSessionHandlers();
syncInstallButton();
render();
