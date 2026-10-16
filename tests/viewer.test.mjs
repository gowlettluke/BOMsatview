import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { minimumZoom, project, COVERAGE } from '../core.mjs';

// Exercise the real viewer's async orchestration without a network or browser.
// Canvas draws and image loads are observable; failed loads can be injected.
test('Running viewer keeps playing through new frames, failures, and layer changes without reloading', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const listeners = new Map(), intervals = [], images = [], canvasWrites = [];
  let viewport = { width: 1200, height: 700 }, resizeObserverCallback;
  class Element {
    constructor(id = '') { this.id = id; this.style = {}; this.dataset = {}; this.value = ''; this.hidden = false; this.checked = false; this.textContent = ''; this.attributes = {}; this.events = new Map(); this.classList = { toggle() {} }; this.parentElement = { hidden: false }; }
    addEventListener(type, fn) { this.events.set(type, fn); }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key]; }
    querySelector() { return this.icon ||= new Element(); }
    closest() { return null; }
    replaceChildren(...children) { this.children = children; }
    append(...children) { (this.children ||= []).push(...children); }
    setPointerCapture() {}
    getBoundingClientRect() { return { ...viewport, left: 0, top: 0 }; }
    getContext() { return { fillRect() {}, clearRect() {}, drawImage: (...args) => { if (this.id === 'satellite') canvasWrites.push(args); } }; }
    matches() { return false; }
    focus() {}
    click() { this.events.get('click')?.({ target: this, stopPropagation() {} }); }
    change(value) { this.value = value; this.events.get('change')?.({ target: this }); }
  }
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(m => [m[1], new Element(m[1])]));
  const realSetInterval = globalThis.setInterval;
  const realDateNow = Date.now;
  let now = Date.UTC(2026, 9, 16, 22, 20), metadataFails = false, imageFails = false, pageReloads = 0;
  let times = ['202610162140', '202610162150', '202610162200'];
  let notes = 'IDY28000\r\nAustralian Government Bureau of Meteorology\r\nBureau National Operations Centre\r\n\r\nSatellite Notes for 1800UTC Chart\r\nIssued at 6:07 am EDT Saturday on 17 October 2026\r\n\r\nFirst wrapped\r\nparagraph.\r\n\r\nFinal paragraph without a newline.';
  let notesFail = false;
  let holdOverlayLoads = false;
  const pendingOverlays = [];
  const originalGlobals = new Map();
  const install = (key, value) => { originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); };
  const fetchCalls = [];
  const selectorMap = { '.animation-play': ['play', 'play-1', 'play-2'], '.animation-step-backward': ['previous', 'previous-1', 'previous-2'], '.animation-step-forward': ['next', 'next-1', 'next-2'], '.animation-slower': ['slower'], '.animation-faster': ['faster'], '.product-date': ['frame-date'], '.product-time': ['frame-time'] };
  const legendRows = ['ir', 'irzehr', 'lir'].map(id => { const el = new Element(); el.dataset.legendId = id; return el; });
  install('document', {
    getElementById: id => elements.get(id), createElement: () => new Element(), createTextNode: text => ({ textContent: text }),
    body: new Element(), documentElement: new Element(), hidden: false,
    querySelectorAll: selector => selector === '.legend-color-ramp' ? legendRows : (selectorMap[selector] || []).map(id => elements.get(id)),
    addEventListener: (type, fn) => listeners.set(type, fn),
  });
  install('window', { addEventListener: (type, fn) => listeners.set(type, fn) });
  install('location', { hash: '', href: 'https://example.test/BOMsatview/', reload: () => { pageReloads++; } });
  install('history', { replaceState: (_a, _b, value) => { location.hash = value; } });
  install('localStorage', { getItem: () => '{"product":"zehr","speed":2}', setItem() {} });
  install('navigator', { onLine: true });
  install('devicePixelRatio', 1.5);
  install('ResizeObserver', class { constructor(callback) { resizeObserverCallback = callback; } observe() {} });
  install('Image', class {
    set src(value) {
      if (!value) return;
      images.push(value);
      const complete = () => { if (imageFails && value.includes('/himawari/')) this.onerror?.(); else this.onload?.(); };
      if (holdOverlayLoads && value.includes('/tiles/')) pendingOverlays.push(complete);
      else queueMicrotask(complete);
    }
    async decode() {}
  });
  install('fetch', async url => {
    fetchCalls.push(url);
    if (url.endsWith('IDY28000_TEX.txt')) {
      if (notesFail) throw new Error('Notes unavailable');
      return { ok: true, text: async () => notes };
    }
    if (metadataFails) throw new Error('Offline');
    return { ok: true, json: async () => [...times], text: async () => 'Satellite Notes\nCurrent observations' };
  });
  globalThis.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
  Date.now = () => now;
  const settle = async predicate => {
    await new Promise(resolve => setTimeout(resolve, 0));
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Viewer did not reach expected state');
  };
  try {
    await import('../viewer.mjs?integration');
    await settle(() => elements.get('frame-count').textContent === '3 / 3 frames');
    assert.equal(elements.get('initial').hidden, true);
    assert.ok(images.some(url => url.includes('/IDE00433/')));
    const animate = intervals.find(i => i.ms === 16).fn;
    const poll = intervals.find(i => i.ms === 60000).fn;
    const before = canvasWrites.length; now += 1000; animate();
    assert.ok(canvasWrites.length > before);
    times.push('202610162210'); poll();
    await settle(() => elements.get('frame-count').textContent === '4 / 4 frames');
    assert.equal(elements.get('product').value, 'zehr');
    assert.equal(elements.get('play').getAttribute('aria-label'), 'Pause animation');
    assert.equal(elements.get('initial').hidden, true);

    // Metadata failure must leave the existing timeline and canvas running.
    metadataFails = true; poll();
    await settle(() => elements.get('connection').textContent.includes('Feed unavailable'));
    const priorFailureWrites = canvasWrites.length; now += 1000; animate();
    assert.ok(canvasWrites.length > priorFailureWrites);
    assert.equal(elements.get('frame-count').textContent, '4 / 4 frames');

    // Failed new tiles must not enter the playback buffer or erase old images.
    metadataFails = false; imageFails = true; times.push('202610162220'); now += 61000; poll();
    await settle(() => elements.get('connection').textContent.includes('Some images unavailable'));
    assert.equal(elements.get('frame-count').textContent, '4 / 5 frames');
    imageFails = false; now += 61000; poll();
    await settle(() => elements.get('frame-count').textContent === '5 / 5 frames');

    // Switch product while retaining playback and the saved geographic view.
    const priorSettings = new URLSearchParams(location.hash.slice(1));
    elements.get('product').change('lightning');
    await settle(() => elements.get('display-product').textContent === 'Lightning' && elements.get('frame-count').textContent === '5 / 5 frames');
    const afterSettings = new URLSearchParams(location.hash.slice(1));
    assert.equal(afterSettings.get('lon'), priorSettings.get('lon'));
    assert.equal(afterSettings.get('zoom'), priorSettings.get('zoom'));
    assert.equal(elements.get('play').getAttribute('aria-label'), 'Pause animation');
    assert.ok(fetchCalls.some(url => url.includes('/Lightning/')));
    assert.ok(images.some(url => url.includes('/Lightning/')));
    assert.equal(pageReloads, 0);

    // A new frame must not override a deliberate pause.
    elements.get('play').click();
    times.push('202610162230'); now += 61000; poll();
    await settle(() => elements.get('frame-count').textContent === '6 / 6 frames');
    const pausedWrites = canvasWrites.length; now += 1000; animate();
    assert.equal(canvasWrites.length, pausedWrites);
    assert.equal(elements.get('play').getAttribute('aria-label'), 'Play animation');

    // Original BoM menu and all additional products use the same update engine.
    elements.get('layers-button').click(); assert.equal(elements.get('layers-menu').hidden, false);
    elements.get('roads').checked = true; elements.get('roads').change('');
    await settle(() => images.some(url => url.includes('/IDZ10006/')));
    elements.get('coordinates').checked = true; elements.get('coordinates').change('');
    elements.get('map').events.get('pointermove')({ clientX: 600, clientY: 350, pointerId: 1 });
    assert.match(elements.get('mousePosition').textContent, /^\d+\.\d{2}, -?\d+\.\d{2}$/);
    elements.get('legend-toggle').checked = false; elements.get('legend-toggle').change('');
    assert.equal(elements.get('legend').hidden, true);
    for (const product of ['daynight', 'visible', 'infrared']) {
      elements.get(`product-${product}`).change(product);
      await settle(() => elements.get(`product-${product}`).checked && elements.get('frame-count').textContent === '6 / 6 frames');
    }
    elements.get('notes').click();
    await settle(() => elements.get('notes-body').children?.length === 1);
    assert.equal(elements.get('notes-modal').getAttribute('aria-hidden'), 'false');
    let bulletin = elements.get('notes-body').children[0];
    assert.deepEqual(bulletin.children.map(el => el.className), ['hw-note-id', 'hw-note-bomtext', 'hw-note-datetext', 'hw-note-satnotes', 'hw-note-satnotes']);
    assert.equal(bulletin.children[3].children[0].textContent, 'First wrapped paragraph.');
    assert.equal(bulletin.children[4].children[0].textContent, 'Final paragraph without a newline.');
    notes = notes.replace('1800UTC', '0000UTC').replace('Final paragraph', 'Updated final paragraph');
    poll();
    await settle(() => elements.get('notes-body').children[0].children[2].children[0].textContent.includes('0000UTC'));
    notesFail = true; poll();
    await settle(() => elements.get('notes-body').dataset.refreshFailed === 'true');
    assert.equal(elements.get('notes-body').children[0].children[4].children[0].textContent, 'Updated final paragraph without a newline.');
    notesFail = false; poll();
    await settle(() => elements.get('notes-body').dataset.refreshFailed === 'false');
    elements.get('close-notes').click(); assert.equal(elements.get('notes-modal').getAttribute('aria-hidden'), 'true');
    elements.get('faster').click(); assert.equal(elements.get('speed').value, 4);
    elements.get('slower').click(); assert.equal(elements.get('speed').value, 2);

    // Repeated zoom-out clicks stop at a viewport-dependent limit, rather
    // than allowing the black space outside the satellite coverage to appear.
    for (let i = 0; i < 30; i++) elements.get('zoom-out').click();
    let settings = new URLSearchParams(location.hash.slice(1));
    assert.ok(Math.abs(Number(settings.get('zoom')) - minimumZoom(1200, 700)) < 1e-6);
    assert.equal(elements.get('zoom-out').disabled, true);
    const limitedURL = location.hash;
    elements.get('zoom-out').click(); assert.equal(location.hash, limitedURL);
    viewport = { width: 700, height: 1200 }; resizeObserverCallback();
    await settle(() => Number(new URLSearchParams(location.hash.slice(1)).get('zoom')) >= minimumZoom(700, 1200) - 1e-6);
    settings = new URLSearchParams(location.hash.slice(1));
    const world = 512 * 2 ** Number(settings.get('zoom'));
    const [cx, cy] = project(Number(settings.get('lon')), Number(settings.get('lat')), world);
    const [west, north] = project(COVERAGE.west, COVERAGE.north, world);
    const [east, south] = project(COVERAGE.east, COVERAGE.south, world);
    // Settings serialize to six decimals; allow that sub-pixel precision loss.
    assert.ok(cx - 350 >= west - 0.01 && cx + 350 <= east + 0.01);
    assert.ok(cy - 600 >= north - 0.01 && cy + 600 <= south + 0.01);

    // Constrain the actual drag preview, before releasing the pointer. No CSS
    // translation may expose the black canvas background, even at the limit.
    await settle(() => elements.get('frame-count').textContent === '6 / 6 frames' && elements.get('satellite').width === 700 * 1.5);
    const map = elements.get('map'), satellite = elements.get('satellite');
    assert.equal(satellite.width, 700 * 1.5);
    assert.equal(satellite.height, 1200 * 1.5);
    // The original tile atlas is copied straight to device pixels in one draw,
    // rather than downsampling each tile and then enlarging the screen canvas.
    assert.equal(canvasWrites.at(-1).length, 9);
    assert.ok(canvasWrites.at(-1).slice(5).every(Number.isInteger));
    const pointer = (type, x, y) => map.events.get(type)({ type, target: map, button: 0, pointerId: 3, clientX: x, clientY: y });
    holdOverlayLoads = true;
    pointer('pointerdown', 300, 300);
    const beforeDrag = canvasWrites.length;
    for (let i = 1; i <= 20; i++) pointer('pointermove', 300 + i * 5, 300);
    // No async settle: every move must paint immediately, even though optional
    // neighbouring overlay tiles have not completed their network requests.
    assert.equal(canvasWrites.length, beforeDrag + 20);
    await settle(() => pendingOverlays.length > 0);
    pointer('pointermove', 100000, -100000);
    const afterHeldMove = canvasWrites.length;
    assert.ok(afterHeldMove > beforeDrag + 20);
    assert.ok(!satellite.style.transform);
    const duringDrag = canvasWrites.length;
    now += 1000; animate(); assert.equal(canvasWrites.length, duringDrag);
    pointer('pointerup', 100000, -100000);
    holdOverlayLoads = false;
    for (const complete of pendingOverlays.splice(0)) complete();
    await settle(() => elements.get('frame-count').textContent === '6 / 6 frames');
    assert.ok(!satellite.style.transform);
  } finally {
    globalThis.setInterval = realSetInterval; Date.now = realDateNow;
    // Let the debounced overlay work settle before restoring browser globals.
    await new Promise(resolve => setTimeout(resolve, 180));
    for (const [key, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});
