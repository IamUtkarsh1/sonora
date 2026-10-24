# Sonora

Sonora is an installable, offline-first personal music player. It plays audio files that you own or are allowed to use, and it can also stream openly licensed music from Internet Archive Netlabels and Hindi/Hindustani recordings from Wikimedia Commons. It also includes a separate live Hindi/Bollywood radio directory powered by Radio Browser.

## Use it on your phone

1. Publish this whole `sonora` folder to any HTTPS static host (for example, GitHub Pages, Netlify, Cloudflare Pages, or your own web server).
2. Open the resulting HTTPS link on your phone.
3. Tap Sonora's **Install** button. On iPhone, it will show the steps for Safari's Share → **Add to Home Screen**. On Android Chrome, it will open the native install prompt when available.
4. Open Sonora and tap **Add music**. Imported audio stays in that browser's local storage and is available offline after the app shell has loaded once.

## What works

- Import MP3, M4A, AAC, WAV, OGG, and FLAC when supported by the phone browser.
- Play, pause, seek, skip, shuffle, repeat, favorite tracks, search, and make playlists.
- Persist the library and imported audio locally with IndexedDB.
- Use supported lock-screen/headphone controls through the Media Session API.
- Search open, streamable music from Internet Archive Netlabels and the Hindi & Hindustani shelf from Wikimedia Commons. Catalog tracks stay online, show their source/license context, and are not copied into your library.
- Tune into available Hindi/Bollywood live-radio stations from Radio Browser. Stations are continuous broadcasts, not a searchable on-demand catalog.

## Important

Your music is stored in the browser on that device. Clearing the browser's site data removes it, so keep original copies of your files. Background playback behavior is ultimately controlled by the mobile browser; wrapping this PWA with Capacitor would be the next step if you need app-store delivery or more reliable native background playback.

## Open music catalog

The general catalog uses Internet Archive's public search and metadata endpoints to find Creative Commons or public-domain audio from its Netlabels collection. The Hindi & Hindustani shelf uses Wikimedia Commons' public API to find openly licensed Hindi-language songs, Hindustani classical music, folk recordings, and Songs of India. Sonora streams original files from their source; it does not download, rehost, or claim ownership of catalog audio. Availability, attribution, license terms, and phone-browser format support remain with each source item.

The Live Hindi radio shelf queries Radio Browser's open-source directory for public station streams that are currently checked online and use secure MP3/AAC URLs. Radio Browser is a directory, not the broadcaster or music-rights holder: each station controls its programming, availability, territory, and broadcast rights. Sonora intentionally labels this as live radio rather than an all-songs or on-demand catalog.
