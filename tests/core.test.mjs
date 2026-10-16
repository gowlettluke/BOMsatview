import test from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCTS, project, unproject, timestampMs, selectTimes, tileURL, timelineURL, tilesForView, fitBounds, PRESETS, normalizeSettings, FrameBuffer } from '../core.mjs';

test('BoM tiles use TMS Y coordinates; timeline and image products match', () => {
  assert.match(tileURL('zehr', '202610162200', 4, 14, 9), /IDE00433\/Himawari\/202610162200\/4\/14\/6.jpg$/);
  assert.match(tileURL('lightning', '202610162200', 4, 14, 9), /Lightning\/Himawari\/202610162200/);
  assert.match(timelineURL('lightning'), /^https:.*Lightning\/Himawari\/timesteps.json$/);
});
test('Web Mercator round trips Queensland and Australia views', () => {
  for (const [lon, lat] of [[153.0251, -27.4698], [142, -11], [115.8, -32]]) {
    const result = unproject(...project(lon, lat, 8192), 8192);
    assert.ok(Math.abs(result[0] - lon) < 1e-8);
    assert.ok(Math.abs(result[1] - lat) < 1e-8);
  }
});
test('Timeline rejects malformed times and does not invent missing frames', () => {
  const data = ['202610162200', '202610162110', 'not-a-time', '202610162200', '202610162230', '202613402561', null, '202610162000'];
  assert.deepEqual(selectTimes(data, 1), ['202610162200', '202610162230']);
  assert.equal(timestampMs('202610162200'), Date.UTC(2026, 9, 16, 22));
  assert.ok(Number.isNaN(timestampMs('202602302200')));
  assert.throws(() => selectTimes({}));
  assert.throws(() => selectTimes([]));
});
test('Timeline stays bounded to 24 frames and handles midnight', () => {
  const data = Array.from({ length: 48 }, (_, i) => new Date(Date.UTC(2026, 9, 16, 18, i * 10)).toISOString().replace(/[-:T]/g, '').slice(0, 12));
  const times = selectTimes(data, 4);
  assert.equal(times.length, 24);
  assert.equal(times.at(-1), data.at(-1));
});
test('New times enter playback only after rendering, retaining cached frames', () => {
  const buffer = new FrameBuffer();
  buffer.reset('zehr', 'view-1'); buffer.setTimeline(['a', 'b']);
  const firstSurface = { test: 'surface-a' };
  buffer.put('a', firstSurface); buffer.put('b', { test: 'surface-b' });
  buffer.setTimeline(['a', 'b', 'c']);
  assert.equal(buffer.frames.get('a'), firstSurface);
  assert.deepEqual(buffer.readyTimes(), ['a', 'b']);
  assert.deepEqual(buffer.missingTimes(), ['c']);
  buffer.put('c', { test: 'surface-c' });
  assert.deepEqual(buffer.readyTimes(), ['a', 'b', 'c']);
  buffer.setTimeline(['b', 'c', 'd']);
  assert.equal(buffer.frames.has('a'), false);
  assert.deepEqual(buffer.readyTimes(), ['b', 'c']);
  buffer.put('a', {}); assert.equal(buffer.frames.has('a'), false);
});
test('Switching layer or viewport discards incompatible cached frames', () => {
  const buffer = new FrameBuffer(); buffer.reset('zehr', 'qld'); buffer.setTimeline(['a']); buffer.put('a', {});
  buffer.reset('lightning', 'qld'); assert.equal(buffer.frames.size, 0);
  buffer.setTimeline(['a']); buffer.put('a', {}); buffer.reset('lightning', 'australia');
  assert.equal(buffer.frames.size, 0);
});
test('Region fits and tile requests remain inside valid world coordinates', () => {
  for (const bounds of Object.values(PRESETS)) {
    const view = fitBounds(bounds, 1600, 900), world = 512 * 2 ** view.zoom;
    const a = project(bounds.west, bounds.north, world), b = project(bounds.east, bounds.south, world);
    assert.ok(b[0] - a[0] <= 1600); assert.ok(b[1] - a[1] <= 900);
    for (const tile of tilesForView(view, 1600, 900)) {
      assert.ok(tile.x >= 0 && tile.x < 2 ** tile.z);
      assert.ok(tile.y >= 0 && tile.y < 2 ** tile.z);
      assert.ok(tile.size > 0);
    }
  }
});
test('Overlay resolution matches BoM at the screenshot zoom, without 2x labels', () => {
  const view = { lon: 132.685824, lat: -27.016851, zoom: 3.690915 };
  const tiles = tilesForView(view, 1719, 1263, true);
  assert.ok(tiles.length > 0);
  assert.equal(tiles[0].z, 5);
  // BoM's 256px overlay tile occupies about 207 CSS pixels at this view.
  // The former z=4 selection stretched it to about 413 CSS pixels instead.
  assert.ok(tiles[0].size > 206 && tiles[0].size < 207);
});
test('Tile zoom follows the original OpenLayers nearest-resolution rule', () => {
  // Independent reference from Satview's shipped OpenLayers linear search.
  const expectedZoom = zoom => {
    const resolutions = Array.from({ length: 8 }, (_, z) => 1 / 2 ** z);
    const target = 1 / 2 ** zoom;
    if (target >= resolutions[0]) return 0;
    for (let z = 1; z < resolutions.length; z++) {
      if (resolutions[z] <= target) return resolutions[z - 1] - target < target - resolutions[z] ? z - 1 : z;
    }
    return 7;
  };
  for (const zoom of [0, 0.1, 0.414, 0.416, 0.49, 0.7, 1, 2.4, 3.690915, 4.389345, 5.9, 6]) {
    const view = { lon: 145, lat: -22, zoom };
    assert.equal(tilesForView(view, 1000, 700, true)[0].z, expectedZoom(zoom + 1));
    assert.equal(tilesForView(view, 1000, 700)[0].z, Math.min(6, expectedZoom(zoom)));
  }
});
test('Saved settings and URL input are validated, including explicit false values', () => {
  const s = normalizeSettings({ product: '__proto__', lat: 'NaN', lon: 999, zoom: -20, hours: 100, playing: 'false', wall: 'true', cities: 'false', speed: 200 });
  assert.equal(s.product, 'daynight'); assert.equal(s.lat, -22); assert.equal(s.lon, 180);
  assert.equal(s.zoom, 0); assert.equal(s.hours, 4); assert.equal(s.playing, false);
  assert.equal(s.wall, true); assert.equal(s.cities, false); assert.equal(s.speed, 4);
});
test('Every BoM imagery product has its original product ID and selectable settings', () => {
  assert.deepEqual(Object.values(PRODUCTS).map(p => p.id), ['IDE00436', 'IDE00432', 'IDE00431', 'IDE00433', 'Lightning']);
  for (const product of Object.keys(PRODUCTS)) {
    assert.equal(normalizeSettings({ product }).product, product);
    assert.match(timelineURL(product), new RegExp(PRODUCTS[product].id));
  }
  const settings = normalizeSettings({ roads: 'true', coordinates: 'true', legend: 'false', speed: 24 });
  assert.equal(settings.roads, true); assert.equal(settings.coordinates, true);
  assert.equal(settings.legend, false); assert.equal(settings.speed, 24);
});
