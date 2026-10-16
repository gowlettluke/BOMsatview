# Auto-updating BoM satellite viewer

**Live viewer:** https://giswatidid.github.io/BOMsatview/

A wall-display version of the BoM satellite viewer with its original layout, blue animation bar, Layers menu, fonts, icons and legends. Its imagery updates in the background without reloading the page, resetting the selected product or requiring Play to be pressed again. This is an independent hosted viewer, not an official BoM service.

## Options

All five BoM imagery products are available under **Layers +**:

- Day + Night (`IDE00436`)
- Visible Greyscale (`IDE00432`)
- Infrared Greyscale (`IDE00431`)
- Infrared + Zehr (`IDE00433`)
- Lightning (`Lightning`, which includes BoM's infrared background)

The same menu provides **Cities**, **Roads**, **Boundaries**, **Coastal**, **Show Legend** and **Show Coordinates**. As on BoM, the legend option appears for products that have a legend. Coordinates follow the mouse position and display longitude, latitude to two decimal places.

The original animation controls provide slower/faster playback, previous/next frame, play/pause and a timeline slider. Supported speeds match BoM: 1, 2, 4, 8, 16 and 24 frames per second. The header has fullscreen and More; the bottom right has Satellite Notes and the link to BoM warnings. About, Help, Feedback and Standard Viewer link to the corresponding original BoM resources. Satellite Notes are fetched from the same BoM delivery service.

## Use

Open the live URL on the wall-display computer, select the product and overlays, and drag/scroll to position the map. Press the fullscreen icon or F11. The layout fills the window as the original BoM viewer does; the previous custom dashboard/wall-mode interface has been replaced.

Settings and playback state are saved locally when browser storage is permitted. The address also includes settings, so it can be bookmarked. **More → Copy display link** copies that address. Existing links from the first version remain supported. Times use **AEST (UTC+10 / Brisbane)**.

Zoom-out is limited by the satellite coverage and the current window dimensions. The full viewport stays inside that coverage, with map-centre limits preventing panning past its edges. The same constraints apply to mouse/keyboard controls, restored links and window/fullscreen resizing, so an older overly zoomed-out bookmark cannot reintroduce black bands outside the imagery.

New displays start with Day + Night, a full satellite-coverage view and playback enabled. Prior saved choices are retained. Stepping or scrubbing intentionally pauses playback; background checks continue. Space toggles playback, plus/minus zoom and arrow keys pan when the map has focus.

## Background updates

The page polls the selected product's small `timesteps.json` file every minute. It uses published timestamps and keeps a rolling four-hour animation of up to 24 frames. Unchanged rendered frames are reused. New frames are downloaded and decoded off screen and enter playback only once every required satellite tile has loaded. A synchronous canvas draw replaces the image without an intermediate blank canvas.

If downloads fail, the current picture/loaded loop stays visible and failed images are retried. Layer, zoom, map centre, playback speed and overlays survive feed checks. Changing product or view keeps the previous picture until a replacement is ready. Map overlays load separately. Update/loading information is available inside **More**; a source or connection problem produces a BoM-style alert rather than silently displaying stale imagery. Satellite-only data is flagged after 45 minutes; lightning after 60 minutes to allow for its additional source latency. These are this viewer's thresholds, not BoM service guarantees.

The renderer bounds memory to 24 frame surfaces, each at most 1600×1000 pixels, plus a 48-entry tile cache and visible/overlay canvases. The single static overlay uses display resolution (up to 2× pixel ratio, bounded to 4096×2160) so labels and fine lines are not softened by the animation's memory cap. Tile downloads are limited to six concurrent requests. Keep the display computer awake and the tab visible.

Tile selection matches the nearest-resolution rule in the original BoM viewer's OpenLayers code. Imagery uses 512px tiles and map overlays use 256px tiles, with their grid levels selected independently for the same geographic view. Flooring a fractional zoom would enlarge the lower-resolution place names and strokes; the renderer selects the nearest resolution instead. Regression tests cover the supplied comparison screenshot's zoom and the grid-level transition points.

## Work-network access

The browser needs access to `giswatidid.github.io` and `https://d30f2i1nzx9v71.cloudfront.net`, Satview's existing image delivery host. No extensions, installation, account, API key, proxy or backend is needed. Styles, fonts and icons are hosted with this repository; there are no external script, font or analytics dependencies.

Metadata permits cross-origin access. Image tiles do not consistently provide CORS headers; ordinary images may be drawn to the 2D canvas, but this viewer does not read/export its pixels or use WebGL. Imagery is loaded directly from BoM's delivery service and is not copied into the repository.

## Publish and develop

Pages is configured to use **GitHub Actions**. Pushes to `main` run JavaScript checks, regression tests and the static build before publishing; pull requests only run checks. To enable a fresh copy, choose **Settings → Pages → Source → GitHub Actions**.

Node 20+ is needed only for development/CI. No package installation is required:

```sh
npm run check
npm test
npm run build
```

Serve `dist/` with a static HTTP server for local development; module scripts need HTTP(S), not `file://`.

- `core.mjs`: products, projection, TMS URLs, settings validation and ready-frame buffer.
- `viewer.mjs`: rendering, background updates, original BoM controls, notes and saved settings.
- `assets/`: original BoM presentation assets (see `NOTICE.md`).
- `tests/`: projection/timestamp/buffer correctness plus async viewer tests for refresh, failed feeds/tiles, recovery, pausing, all five products, Roads, coordinates, legend toggling, speed controls and notes.
- `.github/workflows/pages.yml`: checks, packaging and GitHub Pages deployment.

The tests use simulated network/image events and do not replace checks on the actual work computer. Live HTTPS feeds and image tiles are verified separately. This uses Satview's existing public delivery endpoints rather than a documented versioned API, so future source changes may require maintenance.

## Attribution

Imagery: Japan Meteorological Agency via Bureau of Meteorology. Lightning: Weatherzone Total Lightning Network. Presentation assets are from BoM's publicly served satellite viewer, retained to match its interface as requested. Their respective owners retain all rights. See `NOTICE.md` for source and third-party notices.

[Original viewer](http://satview.bom.gov.au/) · [Product information](http://satview.bom.gov.au/about.html) · [Help](http://satview.bom.gov.au/help.html) · [BoM copyright](http://www.bom.gov.au/other/copyright.shtml)
