import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Exercise the real viewer's async orchestration without a network or browser.
// Canvas draws and image loads are observable; failed loads can be injected.
test('Running viewer keeps playing through new frames, failures, and layer changes without reloading', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const listeners = new Map(), intervals = [], images = [], canvasWrites = [];
  class Element {
    constructor(id = '') { this.id = id; this.style = {}; this.dataset = {}; this.value = ''; this.hidden = false; this.checked = false; this.textContent = ''; this.attributes = {}; this.events = new Map(); this.classList = { toggle() {} }; this.parentElement = { hidden: false }; }
    addEventListener(type, fn) { this.events.set(type, fn); }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key]; }
    querySelector() { return this.icon ||= new Element(); }
    closest() { return null; }
    replaceChildren(...children) { this.children = children; }
    getBoundingClientRect() { return { width: 1200, height: 700, left: 0, top: 0 }; }
    getContext() { return { fillRect() {}, drawImage: (...args) => { if (this.id === 'satellite') canvasWrites.push(args[0]); } }; }
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
  const originalGlobals = new Map();
  const install = (key, value) => { originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); };
  const fetchCalls = [];
  const selectorMap = { '.animation-play': ['play', 'play-1', 'play-2'], '.animation-step-backward': ['previous', 'previous-1', 'previous-2'], '.animation-step-forward': ['next', 'next-1', 'next-2'], '.animation-slower': ['slower'], '.animation-faster': ['faster'], '.product-date': ['frame-date'], '.product-time': ['frame-time'] };
  const legendRows = ['ir', 'irzehr', 'lir'].map(id => { const el = new Element(); el.dataset.legendId = id; return el; });
  install('document', {
    getElementById: id => elements.get(id), createElement: () => new Element(),
    body: new Element(), documentElement: new Element(), hidden: false,
    querySelectorAll: selector => selector === '.legend-color-ramp' ? legendRows : (selectorMap[selector] || []).map(id => elements.get(id)),
    addEventListener: (type, fn) => listeners.set(type, fn),
  });
  install('window', { addEventListener: (type, fn) => listeners.set(type, fn) });
  install('location', { hash: '', href: 'https://example.test/BOMsatview/', reload: () => { pageReloads++; } });
  install('history', { replaceState: (_a, _b, value) => { location.hash = value; } });
  install('localStorage', { getItem: () => '{"product":"zehr","speed":2}', setItem() {} });
  install('navigator', { onLine: true });
  install('ResizeObserver', class { observe() {} });
  install('Image', class {
    set src(value) {
      if (!value) return;
      images.push(value);
      queueMicrotask(() => { if (imageFails && value.includes('/himawari/')) this.onerror?.(); else this.onload?.(); });
    }
    async decode() {}
  });
  install('fetch', async url => {
    fetchCalls.push(url);
    if (metadataFails) throw new Error('Offline');
    return { ok: true, json: async () => [...times], text: async () => 'Satellite Notes\nCurrent observations' };
  });
  globalThis.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
  Date.now = () => now;
  const settle = async predicate => {
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
    elements.get('close-notes').click(); assert.equal(elements.get('notes-modal').getAttribute('aria-hidden'), 'true');
    elements.get('faster').click(); assert.equal(elements.get('speed').value, 4);
    elements.get('slower').click(); assert.equal(elements.get('speed').value, 2);
  } finally {
    globalThis.setInterval = realSetInterval; Date.now = realDateNow;
    // Let the debounced overlay work settle before restoring browser globals.
    await new Promise(resolve => setTimeout(resolve, 180));
    for (const [key, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});
