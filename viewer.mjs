import { PRODUCTS, PRESETS, COVERAGE, project, unproject, timestampMs, selectTimes, tileURL, overlayURL, timelineURL, fitBounds, minimumZoom, constrainView, tilesForView, normalizeSettings, FrameBuffer } from './core.mjs';

const $ = id => document.getElementById(id);
const STORAGE_KEY = 'bom-satellite-wall-v1';
let saved = {};
try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { /* Storage may be disabled at work. */ }
const link = Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
const hasView = ['lon', 'lat', 'zoom'].every(key => key in link || key in saved);
let state = normalizeSettings({ ...saved, ...link });
const map = $('map'), satellite = $('satellite'), overlayCanvas = $('overlays');
const buffer = new FrameBuffer();
const formatTime = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', hour: '2-digit', minute: '2-digit', hour12: false });
const formatDate = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const bomDate = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const bomTime = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', hour: '2-digit', minute: '2-digit', hour12: true });
const all = selector => document.querySelectorAll(selector);
let width = 1, height = 1, ratio = 1, revision = 0, displayed = null;
let available = [], ready = [], timelineProduct = null, currentTime = null;
let lastCheck = null, lastError = '', overlayError = '', warming = false, refreshing = false, refreshAgain = false;
let toastTimer, resizeTimer, viewTimer, metadataController;
const imageCache = new Map(), failedFrames = new Map();
let activeRequests = 0;
const waitingRequests = [];
const viewKey = () => [width, height, state.lon.toFixed(6), state.lat.toFixed(6), state.zoom.toFixed(6)].join('/');

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* Still usable without saved settings. */ }
  const params = new URLSearchParams(Object.entries(state).map(([k, v]) => [k, typeof v === 'number' ? String(Math.round(v * 1000000) / 1000000) : String(v)]));
  try { history.replaceState(null, '', `#${params}`); } catch { /* Embedded browser policies may block URL changes. */ }
}
function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000);
}
function syncControls() {
  for (const key of ['product', 'speed', 'hours']) $(key).value = state[key];
  for (const key of ['boundaries', 'cities', 'coast', 'roads', 'coordinates']) $(key).checked = state[key];
  $('legend-toggle').checked = state.legend;
  for (const product of Object.keys(PRODUCTS)) $(`product-${product}`).checked = state.product === product;
  for (const button of all('.animation-play')) {
    button.querySelector('i').textContent = state.playing ? 'pause' : 'play_arrow';
    button.setAttribute('aria-label', state.playing ? 'Pause animation' : 'Play animation');
  }
  const speedIndex = [1, 2, 4, 8, 16, 24].indexOf(state.speed);
  for (const button of all('.animation-slower')) button.disabled = speedIndex === 0;
  for (const button of all('.animation-faster')) button.disabled = speedIndex === 5;
  $('mousePosition').hidden = !state.coordinates;
  if (!displayed) $('display-product').textContent = PRODUCTS[state.product].name;
}
function renderLegend(product) {
  $('lightning-credit').hidden = product !== 'lightning';
  const legend = PRODUCTS[product].legend;
  $('legend').hidden = !state.legend || !legend;
  for (const row of all('.legend-color-ramp')) row.classList.toggle('hide', row.dataset.legendId !== legend);
  $('legend-toggle').parentElement.hidden = !legend;
}
function status() {
  const latest = available.at(-1);
  const newestAge = latest ? Math.max(0, Math.floor((Date.now() - timestampMs(latest)) / 60000)) : null;
  const sourceStale = newestAge !== null && newestAge > (state.product === 'lightning' ? 60 : 45);
  const displayAge = displayed ? Math.max(0, Math.floor((Date.now() - timestampMs(displayed.stamp)) / 60000)) : null;
  const wrongProduct = displayed && displayed.product !== state.product;
  const catchingUp = Boolean(latest && !buffer.frames.has(latest));
  const stale = sourceStale || Boolean(lastError) || catchingUp || wrongProduct;
  $('live-status').classList.toggle('stale', Boolean(stale));
  $('live-status').textContent = !latest ? 'CONNECTING' : lastError ? 'CONNECTION ISSUE' : sourceStale ? 'SOURCE DELAYED' : wrongProduct ? 'SWITCHING LAYER' : catchingUp ? 'LOADING LATEST' : 'AUTO UPDATING';
  $('freshness').textContent = latest ? `Newest available: ${formatTime.format(timestampMs(latest))} AEST · ${newestAge}m ago` : 'Checking available images';
  // The newest available time and the currently displayed frame are deliberately
  // separate. Looping older history must not be mistaken for a stalled feed.
  $('frame-count').textContent = `${ready.length} / ${available.length || '—'} frames`;
  $('connection').textContent = lastError || overlayError || (warming ? 'Loading frames in the background…' : `Auto updates on · ${state.playing ? 'Loop playing' : 'Paused'}`);
  $('checked').textContent = lastCheck ? `Feed checked ${formatTime.format(lastCheck)} AEST` : 'Background updates every minute';
  if (displayAge !== null) $('frame-time').title = `Displayed frame is ${displayAge} minutes old. Newest available frame is listed at the upper right.`;
  const message = lastError || overlayError || (sourceStale ? `Current images are delayed. The newest available image is ${newestAge} minutes old.` : '');
  $('source-alert').hidden = !message || !displayed;
  $('source-alert').textContent = message;
}

function acquireSlot() {
  return new Promise(resolve => {
    const enter = () => { activeRequests++; resolve(() => { activeRequests--; waitingRequests.shift()?.(); }); };
    if (activeRequests < 6) enter(); else waitingRequests.push(enter);
  });
}
async function loadImage(url) {
  if (imageCache.has(url)) {
    const entry = imageCache.get(url); imageCache.delete(url); imageCache.set(url, entry);
    return entry;
  }
  const promise = (async () => {
    const release = await acquireSlot();
    try {
      return await new Promise((resolve, reject) => {
        const image = new Image();
        // These public tiles do not consistently send CORS headers. Drawing an
        // ordinary Image is allowed; this viewer never reads/exports its pixels.
        image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
        const timeout = setTimeout(() => { image.src = ''; reject(new Error('Image request timed out')); }, 20000);
        image.onload = async () => {
          clearTimeout(timeout);
          try { if (image.decode) await image.decode(); } catch { /* onload already confirms a usable image. */ }
          resolve(image);
        };
        image.onerror = () => { clearTimeout(timeout); reject(new Error('Image tile unavailable')); };
        image.src = url;
      });
    } finally { release(); }
  })();
  imageCache.set(url, promise);
  promise.catch(() => { if (imageCache.get(url) === promise) imageCache.delete(url); });
  // Frame surfaces keep the loop in memory. Tile images are a small LRU only.
  while (imageCache.size > 48) imageCache.delete(imageCache.keys().next().value);
  return promise;
}
function makeSurface(scale = ratio) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
  return canvas;
}
async function renderFrame(product, stamp, view, w, h, r, token) {
  const tiles = tilesForView(view, w, h);
  if (!tiles.length) throw new Error('Move the map back into the Australian satellite coverage');
  const images = await Promise.all(tiles.map(tile => loadImage(tileURL(product, stamp, tile.z, tile.x, tile.y))));
  if (token !== revision) return null;
  const surface = makeSurface(), ctx = surface.getContext('2d', { alpha: false });
  ctx.fillStyle = '#060d13'; ctx.fillRect(0, 0, surface.width, surface.height);
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    ctx.drawImage(images[i], tile.dx * r, tile.dy * r, tile.size * r + 0.5, tile.size * r + 0.5);
  }
  return surface;
}
let overlayRevision = 0;
async function renderOverlays() {
  const token = ++overlayRevision, vToken = revision;
  // This single overlay surface need not share the animation's memory cap.
  // Keep text and thin roads sharp on large/high-DPI wall displays.
  const r = Math.min(globalThis.devicePixelRatio || 1, 2, 4096 / width, 2160 / height);
  const view = { ...state }, w = width, h = height;
  const layers = [state.roads && 'IDZ10006', state.boundaries && 'IDZ10030', state.coast && 'World', state.cities && 'IDM00013'].filter(Boolean);
  const surface = makeSurface(r), ctx = surface.getContext('2d');
  const tiles = tilesForView(view, w, h, true);
  let failed = 0;
  for (const layer of layers) {
    const results = await Promise.allSettled(tiles.map(tile => loadImage(overlayURL(layer, tile.z, tile.x, tile.y))));
    if (token !== overlayRevision || vToken !== revision) return;
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        const tile = tiles[i]; ctx.drawImage(result.value, tile.dx * r, tile.dy * r, tile.size * r + 0.5, tile.size * r + 0.5);
      } else failed++;
    });
  }
  if (token !== overlayRevision || vToken !== revision) return;
  overlayCanvas.width = surface.width; overlayCanvas.height = surface.height;
  overlayCanvas.getContext('2d').drawImage(surface, 0, 0);
  overlayCanvas.dataset.view = viewKey();
  if (displayed?.view === viewKey()) overlayCanvas.style.visibility = '';
  overlayError = failed ? 'Some map overlays unavailable; imagery is still updating' : '';
  status();
}
function showFrame(stamp) {
  const surface = buffer.frames.get(stamp);
  if (!surface) return;
  // One synchronous canvas draw: users never see an empty canvas between frames.
  if (satellite.width !== surface.width || satellite.height !== surface.height) {
    satellite.width = surface.width; satellite.height = surface.height;
  }
  satellite.getContext('2d', { alpha: false }).drawImage(surface, 0, 0);
  satellite.style.transform = ''; overlayCanvas.style.transform = '';
  if (overlayCanvas.dataset.view !== viewKey()) overlayCanvas.style.visibility = 'hidden';
  else overlayCanvas.style.visibility = '';
  displayed = { stamp, product: buffer.product, view: buffer.viewKey };
  currentTime = stamp;
  $('display-product').textContent = PRODUCTS[buffer.product].short;
  const date = timestampMs(stamp);
  const parts = Object.fromEntries(bomDate.formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  for (const el of all('.product-date')) el.textContent = `${parts.weekday}, ${parts.day} ${parts.month} ${parts.year}`;
  for (const el of all('.product-time')) el.textContent = `${bomTime.format(date)} AEST`;
  for (const el of all('.product-date-short')) el.textContent = formatDate.format(date);
  for (const el of all('.product-time-short')) el.textContent = `${bomTime.format(date)} AEST`;
  renderLegend(buffer.product);
  $('initial').hidden = true;
  updateSlider();
}
function updateSlider() {
  $('timeline').max = Math.max(0, ready.length - 1);
  $('timeline').value = Math.max(0, ready.indexOf(currentTime));
  $('range-start').textContent = ready.length ? formatTime.format(timestampMs(ready[0])) : '—';
  $('range-end').textContent = ready.length ? `${formatTime.format(timestampMs(ready.at(-1)))} AEST` : '—';
}
let warmingToken = null;
async function warmFrames() {
  if (!available.length || timelineProduct !== state.product) return;
  const token = revision;
  if (warmingToken === token) return;
  warmingToken = token; warming = true;
  const product = state.product, key = viewKey(), view = { ...state }, w = width, h = height, r = ratio;
  buffer.reset(product, key); buffer.setTimeline(available);
  status();
  let failures = 0;
  try {
    // Recompute the queue after every awaited frame: a new timeline can arrive
    // during preloading, without starting a second worker or losing new times.
    while (token === revision) {
      const stamp = buffer.missingTimes().find(t => (failedFrames.get(`${product}/${key}/${t}`) || 0) < Date.now() - 45000);
      if (!stamp) break;
      try {
        const surface = await renderFrame(product, stamp, view, w, h, r, token);
        if (!surface || token !== revision) return;
        buffer.put(stamp, surface);
        failedFrames.delete(`${product}/${key}/${stamp}`);
        ready = buffer.readyTimes();
        if (!displayed || displayed.product !== product || displayed.view !== key || !ready.includes(currentTime)) showFrame(stamp);
        updateSlider();
      } catch {
        if (token !== revision) return;
        failedFrames.set(`${product}/${key}/${stamp}`, Date.now()); failures++;
        if (!displayed) $('initial-message').textContent = 'An image could not be loaded. Trying the next available frame…';
      }
      status();
    }
  } finally {
    if (warmingToken === token) {
      warmingToken = null; warming = false;
      if (failures) lastError = 'Some images unavailable · retrying automatically';
      if (!displayed) {
        $('initial-message').textContent = 'Unable to load imagery. Your network must allow the BoM image feed at d30f2i1nzx9v71.cloudfront.net. Retrying automatically each minute.';
      }
      status();
    }
  }
}
async function refreshTimeline() {
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true; refreshAgain = false;
  const product = state.product;
  metadataController = new AbortController();
  const timeout = setTimeout(() => metadataController.abort(), 15000);
  try {
    const response = await fetch(timelineURL(product), { cache: 'no-store', signal: metadataController.signal, referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error(`Feed returned HTTP ${response.status}`);
    const times = selectTimes(await response.json(), state.hours);
    if (product !== state.product) { refreshAgain = true; return; }
    available = times; timelineProduct = product; lastCheck = Date.now(); lastError = '';
    if (buffer.product === product && buffer.viewKey === viewKey()) {
      buffer.setTimeline(times); ready = buffer.readyTimes(); updateSlider();
    }
    void warmFrames();
  } catch (error) {
    if (product === state.product) {
      lastError = `Feed unavailable · retrying automatically${navigator.onLine ? '' : ' · offline'}`;
      if (!displayed) $('initial-message').textContent = 'Unable to reach the BoM imagery feed. Check your connection or whether the image delivery domain is allowed on your network. Retrying automatically.';
      // Existing ready imagery is intentionally kept. A metadata failure never
      // clears the map or restarts playback.
      void warmFrames();
    }
  } finally {
    clearTimeout(timeout); refreshing = false; status();
    if (refreshAgain) { refreshAgain = false; void refreshTimeline(); }
  }
}
function changeView() {
  // Applies to buttons, wheel, keyboard, dragging, restored links and resize.
  // A valid centre alone is insufficient: the entire viewport must stay inside
  // the image coverage, otherwise zooming out exposes black bands.
  Object.assign(state, constrainView(state, width, height));
  const min = minimumZoom(width, height);
  $('zoom-out').disabled = state.zoom <= min + 1e-8;
  $('zoom-in').disabled = state.zoom >= Math.max(6, min) - 1e-8;
  revision++;
  // Retain the visible surface while replacing only this view's frame buffer.
  buffer.reset(state.product, viewKey());
  ready = [];
  updateSlider();
  overlayCanvas.style.visibility = 'hidden';
  failedFrames.clear();
  persist();
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => { void warmFrames(); void renderOverlays(); }, 120);
}
function resize() {
  const rect = map.getBoundingClientRect();
  const nextWidth = Math.max(1, Math.round(rect.width)), nextHeight = Math.max(1, Math.round(rect.height));
  if (nextWidth === width && nextHeight === height) return;
  width = nextWidth; height = nextHeight;
  // At most 1600×1000 pixels per surface, 24 surfaces per loop; no unbounded
  // accumulation of old frame canvases during all-day use.
  ratio = Math.min(1, 1600 / width, 1000 / height);
  if (!hasView && !displayed && !available.length) Object.assign(state, fitBounds(COVERAGE, width, height));
  changeView();
}
function setPlaying(playing) { state.playing = playing; syncControls(); persist(); status(); }
function step(direction) {
  if (!ready.length) return;
  setPlaying(false);
  const index = ready.indexOf(currentTime);
  showFrame(ready[(Math.max(0, index) + direction + ready.length) % ready.length]);
}
function setWall() { state.wall = false; syncControls(); persist(); }
function zoom(delta, point = [width / 2, height / 2]) {
  const nextZoom = Math.max(minimumZoom(width, height), Math.min(6, state.zoom + delta));
  if (Math.abs(nextZoom - state.zoom) < 1e-9) return;
  const oldWorld = 512 * 2 ** state.zoom;
  const center = project(state.lon, state.lat, oldWorld);
  const anchor = [(center[0] + point[0] - width / 2) / oldWorld, (center[1] + point[1] - height / 2) / oldWorld];
  state.zoom = nextZoom;
  const newWorld = 512 * 2 ** state.zoom;
  const [lon, lat] = unproject(anchor[0] * newWorld - point[0] + width / 2, anchor[1] * newWorld - point[1] + height / 2, newWorld);
  state.lon = Math.max(85, Math.min(180, lon)); state.lat = Math.max(-55, Math.min(20, lat));
  $('region').value = 'custom'; changeView();
}

function changeProduct() {
  state.product = $('product').value; available = []; ready = []; timelineProduct = null;
  lastCheck = null; lastError = ''; metadataController?.abort();
  changeView(); syncControls(); void refreshTimeline(); status();
}
$('product').addEventListener('change', changeProduct);
for (const key of Object.keys(PRODUCTS)) $(`product-${key}`).addEventListener('change', () => {
  $('product').value = key; changeProduct();
});
$('region').addEventListener('change', () => {
  if (PRESETS[$('region').value]) { Object.assign(state, fitBounds(PRESETS[$('region').value], width, height)); changeView(); }
});
for (const key of ['boundaries', 'cities', 'coast', 'roads']) $(key).addEventListener('change', () => {
  state[key] = $(key).checked; persist(); void renderOverlays();
});
$('legend-toggle').addEventListener('change', () => { state.legend = $('legend-toggle').checked; persist(); renderLegend(displayed?.product || state.product); });
$('coordinates').addEventListener('change', () => { state.coordinates = $('coordinates').checked; persist(); syncControls(); });
$('hours').addEventListener('change', () => { state.hours = Number($('hours').value); persist(); void refreshTimeline(); });
$('speed').addEventListener('change', () => { state.speed = Number($('speed').value); persist(); });
for (const button of all('.animation-play')) button.addEventListener('click', () => setPlaying(!state.playing));
for (const button of all('.animation-step-backward')) button.addEventListener('click', () => step(-1));
for (const button of all('.animation-step-forward')) button.addEventListener('click', () => step(1));
for (const [selector, delta] of [['.animation-slower', -1], ['.animation-faster', 1]]) for (const button of all(selector)) button.addEventListener('click', () => {
  const speeds = [1, 2, 4, 8, 16, 24];
  state.speed = speeds[Math.max(0, Math.min(5, speeds.indexOf(state.speed) + delta))]; syncControls(); persist();
});
$('latest').addEventListener('click', () => { if (ready.length) { setPlaying(false); showFrame(ready.at(-1)); } });
$('timeline').addEventListener('input', () => { setPlaying(false); const stamp = ready[Number($('timeline').value)]; if (stamp) showFrame(stamp); });
$('retry').addEventListener('click', () => { failedFrames.clear(); void refreshTimeline(); });
$('wall').addEventListener('click', () => setWall(!state.wall));
$('exit-wall').addEventListener('click', () => setWall(false));
$('zoom-in').addEventListener('click', () => zoom(0.5));
$('zoom-out').addEventListener('click', () => zoom(-0.5));
$('fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { toast('Fullscreen is unavailable here. Try your browser’s F11 key.'); }
});
document.addEventListener('fullscreenchange', () => {
  const active = Boolean(document.fullscreenElement);
  $('fullscreen').textContent = active ? 'fullscreen_exit' : 'fullscreen';
  $('fullscreen').title = active ? 'Exit Fullscreen' : 'Go Fullscreen';
  $('fullscreen').setAttribute('aria-label', active ? 'Exit Fullscreen' : 'Go Fullscreen');
});
$('share').addEventListener('click', async () => {
  persist();
  try { await navigator.clipboard.writeText(location.href); toast('Display link copied. It includes this view and playback settings.'); }
  catch { toast('Copy the address from your browser. It includes all display settings.'); }
});

function toggleMenu(menuId, buttonIds, force) {
  const menu = $(menuId);
  const open = force ?? menu.hidden;
  menu.hidden = !open; menu.style.display = open ? 'block' : '';
  for (const id of buttonIds) $(id).setAttribute('aria-expanded', String(open));
}
const layerButtons = ['layers-button', 'layers-button-mobile'];
$('layers-menu').hidden = true; $('more-menu').hidden = true;
for (const id of layerButtons) $(id).addEventListener('click', event => {
  event.stopPropagation(); toggleMenu('layers-menu', layerButtons); toggleMenu('more-menu', ['more'], false);
});
$('more').addEventListener('click', event => {
  event.stopPropagation(); toggleMenu('more-menu', ['more']); toggleMenu('layers-menu', layerButtons, false);
});
document.addEventListener('click', event => {
  if (!event.target.closest('.settings-select')) toggleMenu('layers-menu', layerButtons, false);
  if (!event.target.closest('#more-select')) toggleMenu('more-menu', ['more'], false);
});
let notesText = null;
$('notes').addEventListener('click', async () => {
  const modal = $('notes-modal'), body = $('notes-body');
  modal.style.display = 'block'; modal.classList.toggle('in', true); modal.setAttribute('aria-hidden', 'false');
  $('close-notes').focus(); body.textContent = 'Loading Satellite Notes…';
  if (!notesText) {
    try {
      const response = await fetch(`${timelineURL('daynight').split('/himawari/')[0]}/himawari/text/IDY28000_TEX.txt`, { cache: 'no-store', signal: AbortSignal.timeout(15000), referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error('Notes unavailable');
      notesText = await response.text();
    } catch { body.textContent = 'Satellite Notes text is not available. Please check again later.'; return; }
  }
  const text = document.createElement('pre'); text.textContent = notesText;
  body.replaceChildren(text);
});
function closeNotes() {
  $('notes-modal').style.display = 'none'; $('notes-modal').classList.toggle('in', false); $('notes-modal').setAttribute('aria-hidden', 'true'); $('notes').focus();
}
$('close-notes').addEventListener('click', closeNotes);
$('notes-modal').addEventListener('click', event => { if (event.target === $('notes-modal')) closeNotes(); });
let drag = null;
map.addEventListener('pointerdown', event => {
  if (event.button !== 0 || event.target.closest('button, a, input, select')) return;
  map.focus({ preventScroll: true }); map.setPointerCapture(event.pointerId);
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, center: project(state.lon, state.lat, 512 * 2 ** state.zoom) };
});
map.addEventListener('pointermove', event => {
  if (state.coordinates) {
    const rect = map.getBoundingClientRect(), world = 512 * 2 ** state.zoom;
    const [cx, cy] = project(state.lon, state.lat, world);
    const [lon, lat] = unproject(cx + event.clientX - rect.left - width / 2, cy + event.clientY - rect.top - height / 2, world);
    $('mousePosition').textContent = `${lon.toFixed(2)}, ${lat.toFixed(2)}`;
    $('mousePosition').hidden = false;
  }
  if (!drag || drag.id !== event.pointerId) return;
  const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
  satellite.style.transform = `translate(${dx}px,${dy}px)`;
  overlayCanvas.style.transform = `translate(${dx}px,${dy}px)`;
});
map.addEventListener('pointerleave', () => { $('mousePosition').hidden = true; });
function endDrag(event) {
  if (!drag || drag.id !== event.pointerId) return;
  const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
  const [lon, lat] = unproject(drag.center[0] - dx, drag.center[1] - dy, 512 * 2 ** state.zoom);
  drag = null;
  if (Math.abs(dx) + Math.abs(dy) < 3) { satellite.style.transform = ''; overlayCanvas.style.transform = ''; return; }
  state.lon = Math.max(85, Math.min(180, lon)); state.lat = Math.max(-55, Math.min(20, lat));
  $('region').value = 'custom'; changeView();
}
map.addEventListener('pointerup', endDrag);
map.addEventListener('pointercancel', () => { drag = null; satellite.style.transform = ''; overlayCanvas.style.transform = ''; });
map.addEventListener('wheel', event => {
  if (event.target.closest('button, a, input, select')) return;
  event.preventDefault(); const rect = map.getBoundingClientRect();
  zoom(event.deltaY < 0 ? 0.25 : -0.25, [event.clientX - rect.left, event.clientY - rect.top]);
}, { passive: false });
map.addEventListener('dblclick', event => {
  if (event.target.closest('button, a, input, select')) return;
  const rect = map.getBoundingClientRect(); zoom(0.5, [event.clientX - rect.left, event.clientY - rect.top]);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    toggleMenu('layers-menu', layerButtons, false); toggleMenu('more-menu', ['more'], false);
    if ($('notes-modal').style.display === 'block') closeNotes();
    return;
  }
  if (event.target.matches('input, select, textarea, button, a')) return;
  if (event.key === ' ') { event.preventDefault(); setPlaying(!state.playing); }
  else if (event.key.toLowerCase() === 'w') setWall(!state.wall);
  else if (event.key === 'Escape') setWall(false);
  else if (event.key.toLowerCase() === 'f') $('fullscreen').click();
  else if (['+', '='].includes(event.key)) zoom(0.5);
  else if (event.key === '-') zoom(-0.5);
  else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    event.preventDefault(); const world = 512 * 2 ** state.zoom;
    const [x, y] = project(state.lon, state.lat, world);
    const [lon, lat] = unproject(x + (event.key === 'ArrowLeft' ? -80 : event.key === 'ArrowRight' ? 80 : 0), y + (event.key === 'ArrowUp' ? -80 : event.key === 'ArrowDown' ? 80 : 0), world);
    state.lon = Math.max(85, Math.min(180, lon)); state.lat = Math.max(-55, Math.min(20, lat)); $('region').value = 'custom'; changeView();
  }
});
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 120); }).observe(map);
window.addEventListener('online', () => { failedFrames.clear(); void refreshTimeline(); });
window.addEventListener('offline', () => { lastError = 'Offline · keeping loaded imagery'; status(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && (!lastCheck || Date.now() - lastCheck > 60000)) void refreshTimeline(); });
window.addEventListener('hashchange', () => {
  const nextState = normalizeSettings(Object.fromEntries(new URLSearchParams(location.hash.slice(1))));
  const productChanged = nextState.product !== state.product; state = nextState;
  if (productChanged) { available = []; timelineProduct = null; metadataController?.abort(); }
  syncControls(); changeView(); void refreshTimeline();
});
let lastAdvance = 0;
setInterval(() => {
  if (!state.playing || drag || ready.length < 2 || Date.now() - lastAdvance < 1000 / state.speed) return;
  const elapsed = Date.now() - lastAdvance;
  lastAdvance = Date.now() - elapsed % (1000 / state.speed);
  const index = ready.indexOf(currentTime);
  showFrame(ready[(index + 1) % ready.length]);
}, 16);
setInterval(() => { void refreshTimeline(); }, 60000);
setInterval(() => { $('clock').textContent = `${formatTime.format(Date.now())} AEST`; status(); }, 1000);
syncControls(); resize(); renderLegend(state.product); void refreshTimeline();
