# Repository guide

## Build, test, and run

- Requires Node.js 20 or newer.
- `npm install` installs dependencies; `npx playwright install chromium` installs the browser used by the monitor and web thumbnail providers.
- `npm run build` compiles `src/` and `scripts/` to `dist/`.
- `npm start` runs the compiled app (`dist/src/main.js`); `npm run dev` runs it with `tsx watch`.
- `npm run lint` runs `tsc --noEmit` (there is no separate ESLint command).
- `npm test` runs the Vitest suite. Run one test file with `npm test -- tests/aceDetector.test.ts`, or filter a test by name with `npm test -- tests/aceDetector.test.ts -t "test name"`.
- To exercise the VOD-to-clip flow, use `npx tsx scripts/test-vod.ts --url "<VOD>" --at 01:23:45 --player "<player>"`; see `README.md` for optional upload and metadata flags.

## Architecture

The Node/TypeScript implementation lives in `src/`; `index.py` is the preserved 2021 legacy implementation and is not part of the current runtime.

`src/main.ts` is the supervisor. On each poll it asks `monitor/hltvMonitor.ts` for live HLTV matches, selects a broadcast stream, and starts a bounded set of per-match recorders and trackers. `detector/matchTracker.ts` reads the live scoreboard and feeds kill-count differences to the pure round logic in `detector/aceDetector.ts`. Detected multikills are deduplicated in SQLite (`db.ts`) before clip handling.

`recorder/streamRecorder.ts` resolves stream URLs with `yt-dlp` and writes a circular buffer of MPEG-TS segments with `ffmpeg`. On detection, the supervisor snapshots the selected segments so the circular buffer can continue changing safely. `clipper/clipBuilder.ts` assembles, trims, and renders the clip; thumbnail generation uses a deterministic Sharp composition and can optionally try the ordered AI providers in `clipper/aiThumbnail.ts`. `uploader/youtubeUploader.ts` uploads the clip and thumbnail; uploads default to private for human review. Runtime state, logs, browser profiles, and credentials live outside the source flow, mostly under ignored `data/` and `logs/` paths.

## Repository-specific conventions

- This is an ESM TypeScript project using `NodeNext`. Keep `.js` extensions in relative TypeScript imports; TypeScript resolves them to the `.ts` source and emits runnable ESM.
- Environment variables are parsed and defaulted in `src/config.ts` with Zod. `getConfig()` caches the parsed configuration; test configuration parsing/helpers without relying on real credentials or runtime state.
- Keep parsing, selection, detection, and other deterministic logic as exported pure functions where practical. The Vitest tests under `tests/` exercise these helpers without requiring live HLTV, YouTube, or AI-provider requests.
- Playwright `page.evaluate()` callbacks run in the browser. In `src/detector/matchTracker.ts`, keep these callbacks free of named local helper functions and named arrow-function bindings: the `tsx` transform can inject a `__name` helper that is unavailable in the page context.
- Treat the recorder buffer as mutable and time-bounded: preserve segment ordering/timestamps and use a snapshot before lengthy clip or thumbnail work. `clipBuilder.ts` serializes expensive renders and uses `procRegistry.ts` to track child processes.
- Keep optional thumbnail providers best-effort with the composed thumbnail as the fallback; provider failures must not prevent clip creation. Preserve the current private-by-default upload behavior.
- Do not commit `.env`, YouTube OAuth files, browser profiles, SQLite/runtime data, or local media/tool artifacts; `.gitignore` excludes these paths.
