# Satellite wall display

A browser-only wall display for the Bureau of Meteorology's **Infrared + Zehr** and **Lightning + Infrared** products. Open a webpage on the display computer; no browser extensions, installations, account or API key are needed.

**Live viewer:** https://giswatidid.github.io/BOMsatview/

## Publish on GitHub Pages

1. Open [this repository's Pages settings](https://github.com/giswatidid/BOMsatview/settings/pages).
2. Under **Build and deployment → Source**, select **GitHub Actions**.
3. Open [Actions](https://github.com/giswatidid/BOMsatview/actions), select **Test and deploy wall display**, and use **Run workflow** if an earlier run failed because Pages was not enabled.
4. The successful deployment's **github-pages** environment provides the live URL. The expected project URL is `https://giswatidid.github.io/BOMsatview/`.

The workflow validates JavaScript, runs regression tests, packages only the public application files, and deploys the static site. Subsequent pushes to `main` publish automatically. Pull requests run checks without deploying.

## Use on the wall

- Choose **Infrared + Zehr** or **Lightning + Infrared**. These are separate products; the lightning product already includes BoM's infrared background.
- Choose Queensland, South-east Queensland or Australia, or drag/zoom to a custom view.
- Select the last 1, 2 or 4 hours, playback speed, and coast/state/city overlays.
- Use **Wall mode** to hide the control bars. Press **W** or hover near the bottom right for **Show controls**. **Escape** also exits wall mode when the map has keyboard focus.
- Use **Fullscreen**, or the browser's **F11** key. Browser fullscreen normally needs a user gesture; the page does not promise unattended fullscreen entry after a computer restart.
- **Copy link** includes the layer, geographic view, loop, playback, overlays and wall mode. Bookmark that link on the display computer. Settings are also stored in that browser when local storage is permitted.
- Playback starts automatically on a new display. Space toggles play/pause; plus/minus zoom; arrow keys pan when the map has focus. Scrubbing, stepping or **Latest** intentionally pauses. Background image checks continue while paused.

All visible times are **AEST (UTC+10 / Brisbane)**, including when the computer uses another timezone.

## What updates, and how

The page never refreshes itself. It polls the selected product's small `timesteps.json` file every 60 seconds, and again on network recovery or returning to a tab after more than a minute. It uses only published timestamps, so missing source frames are not fabricated.

Completed frames for the current map view remain in a rolling memory buffer. New frames are downloaded and decoded off screen, then enter playback only when every required imagery tile succeeds. A synchronous canvas draw replaces the displayed frame without an intermediate blank canvas. The existing loop continues while new frames load. Unchanged frames are reused; old frames are removed. Pausing, refreshing the timeline or temporarily losing the feed does not reset the selected layer or map view.

Changing product or map view keeps the previous picture on screen until a replacement is ready. The title/time continue to describe that actual picture. Map overlays load separately, so toggling cities or boundaries does not rebuild the satellite animation.

The upper-right panel shows the **newest available source image**, separately from the historical frame currently playing at upper left. BoM's lightning product can arrive later than satellite-only imagery. Source-delay thresholds are 45 minutes for Zehr and 60 minutes for lightning; these are this viewer's display thresholds, not BoM service guarantees. Feed or tile errors are shown and retried automatically. A successful metadata check alone does not mean the latest image has finished loading.

## Network requirements

The work browser must be able to access both:

- The GitHub Pages hosting domain, normally `giswatidid.github.io`.
- `https://d30f2i1nzx9v71.cloudfront.net`, the existing image delivery host used by Satview.

No third-party JavaScript, fonts, maps, analytics, backend, proxy or scheduled GitHub image scraping is used. Metadata permits cross-origin requests. Tiles are displayed using ordinary images and a 2D canvas; they do not consistently have CORS headers, so this viewer does **not** attempt pixel reads, image exports or WebGL texture uploads. Images are loaded directly from the existing public service rather than copied into this repository.

## Development and checks

Node 20+ is needed only for development/CI, not on the display computer. No package installation is required.

```sh
npm run check
npm test
npm run build
```

Serve `dist/` with any static HTTP server when doing local browser testing. Module scripts should be served over HTTP(S), rather than opened with `file://`.

- `core.mjs`: projection, TMS tile URLs, input validation, timelines and ready-frame buffer.
- `viewer.mjs`: canvas display, bounded request concurrency/cache, background updates, controls and persistence.
- `tests/core.test.mjs`: geographic/timestamp correctness, frame readiness/reuse and invalid settings.
- `tests/viewer.test.mjs`: real viewer orchestration with simulated image/network events, including source refresh, failed metadata/tiles, recovery, product changes and paused playback. This is not a substitute for live browser/network testing.
- `.github/workflows/pages.yml`: test, package and deploy.

Memory is bounded to 24 composed frame surfaces, each capped at 1600×1000 pixels, plus a 48-entry tile cache and the visible/overlay canvases. Only six tile requests run concurrently. Closing the page clears the frame buffer; reopening loads current imagery. The browser/OS should be configured to keep the wall-display tab visible and prevent the computer sleeping.

## Source and attribution

Independent viewer; not an official BoM product. Satellite imagery: Japan Meteorological Agency, via the Bureau of Meteorology. Lightning data: Weatherzone Total Lightning Network, as attributed by Satview. Source imagery and overlays retain their respective owners' rights; no claim of ownership is made over them.

- [BoM satellite viewer](http://satview.bom.gov.au/)
- [Product explanations and timestamps](http://satview.bom.gov.au/about.html)
- [Viewer help](http://satview.bom.gov.au/help.html)
- [BoM copyright](http://www.bom.gov.au/other/copyright.shtml)

The public endpoints and legend were verified against Satview's shipped application on 17 October 2026 (Brisbane time). These are the existing viewer's delivery endpoints, rather than a documented versioned API, so future BoM changes may require maintenance.

## Verification — 17 October 2026 (AEST)

- HTTPS timeline retrieval succeeded for both products, with cross-origin metadata access enabled.
- HTTPS satellite tiles at zooms 4, 5 and 6 and static coast/state tiles were retrieved successfully.
- JavaScript checks, the regression suite and the static package build passed locally.
- GitHub Actions independently passed the JavaScript checks, all nine tests, build and Pages deployment. The published site returns HTTP 200.
- The live browser loaded and played a complete 24-frame loop for both Infrared + Zehr and Lightning + Infrared. Switching product retained map centre, zoom, playback and overlay selections. Wall mode and the return to controls worked, with aligned coast/state overlays.
- Verification used a cloud browser, not the user's work network. Access from that network still needs to be checked on the display computer.
