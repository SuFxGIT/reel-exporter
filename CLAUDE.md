# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Reel Vault is a small self-hosted, Plex-style video player whose only purpose is taking
screenshots and trimming clips from a read-only media library. Docker image
`ghcr.io/sufxgit/reel-vault`, port **7727**, deployed on the user's Unraid server
(`/mnt/user/data/media` read-only, captures to `/mnt/user/data/reel-vault`, config in
`/mnt/user/appdata/reel-vault`).

## Commands

```bash
npm install && npm --prefix web install
npm test                                      # vitest: src/__tests__ (naming rules)
npm run typecheck && npm --prefix web run typecheck
npm --prefix web run build && npm run build   # web/dist then dist/
docker compose -f docker-compose.dev.yml up   # tsx watch inside Alpine with ffmpeg, real paths mounted
docker build -t ghcr.io/sufxgit/reel-vault:latest .
node scripts/unraid-run.mjs --dry-run         # the docker run command Unraid's dockerMan would build
node scripts/unraid-run.mjs --install-template --recreate   # register template + icon, (re)start the container
node scripts/smoke-browser.mjs --probe        # headless Chrome codec probe (browserless/chrome container)
```

There is no ffmpeg on the host; anything that touches media runs in a container.

## Architecture

- `src/index.ts` boots config, ffmpeg capability detection, the library store, routes,
  static serving of `web/dist`, and graceful shutdown (kills every child ffmpeg).
- `src/library/sources.ts` owns `CONFIG_PATH/sources.json`: which mounted folders are
  sources and which folders inside them are libraries (validation, no nesting, name
  disambiguation, config hash). `mounts.ts` parses `/proc/self/mountinfo` to suggest mounts.
- `src/library/naming.ts` is the pure parsing layer (season/episode regexes, title cleaning,
  output file naming). `scanner.ts` walks only the selected library folders with `readdir`
  (FUSE friendly); item ids hash the absolute container path. `store.ts` holds the in-memory
  index and `CONFIG_PATH/library.json` (invalidated by the sources config hash).
- `src/media/hls.ts` is the on-demand HLS transcoder: static VOD playlist, 4 s fMP4 segments
  with absolute timestamps (`-output_ts_offset` plus a 1 s pad, `frag_discont`,
  `use_editlist=0`), restart-on-seek, SIGSTOP throttling, idle cleanup. Do not change the
  ffmpeg flags without re-running the timestamp checks in the README's development notes.
- `src/media/filters.ts` builds the filter chains (deinterlace, scale, zscale+tonemap for
  HDR). `probe.ts` classifies HDR (pq, hlg, dovi-p5, unknown-hdr) from ffprobe JSON.
- `src/media/capture.ts` (screenshots: PNG/JPEG, optional max width), `jobs.ts` (clip queue:
  quality presets, optional max width, audio or none), `peaks.ts` (waveform),
  `frames.ts` (hover and capture thumbnails). All child processes go through
  `ffmpeg.ts`'s `ProcessRegistry`.
- `web/src/lib/export-options.ts` holds the per-browser export choices; the popovers live in
  `web/src/components/player/ExportOptions.tsx`.
- `web/src/components/sources/SourcesDialog.tsx` (+ `FolderBrowser.tsx`, `web/src/lib/sources.ts`)
  is the one management dialog: add/remove sources, browse, tick folders; edits are batched
  and saved with one PUT per source.
- `web/src/hooks/useTimeline.ts` owns wavesurfer.js. It is created only after hls.js emits
  `MEDIA_ATTACHED`, always with peaks and duration, and only ever calls `ws.load()` with the
  video's own `src`; anything else clears the MediaSource.

## House style

- Prettier: no semicolons, double quotes, 2 spaces. Tailwind v4 tokens only, no ad-hoc colours
  (the single accent is amber `--primary`).
- Copy is plain and specific; error messages say what to do next. No em dashes in copy.
- Keep the app to its one job. No settings pages, no auth, no metadata scraping.
