export const ORIGIN = 'https://d30f2i1nzx9v71.cloudfront.net';
export const PRODUCTS = {
  daynight: { id: 'IDE00436', name: 'Day + Night', short: 'Day + Night' },
  visible: { id: 'IDE00432', name: 'Visible Greyscale', short: 'Visible Greyscale' },
  infrared: { id: 'IDE00431', name: 'Infrared Greyscale', short: 'Infrared Greyscale', legend: 'ir' },
  zehr: { id: 'IDE00433', name: 'Infrared + Zehr', short: 'Infrared + Zehr', legend: 'irzehr' },
  lightning: { id: 'Lightning', name: 'Lightning', short: 'Lightning', legend: 'lir' },
};
export const COVERAGE = { west: 85, east: 180, north: 20, south: -55 };
export const PRESETS = {
  australia: { west: 108, east: 157, north: -9, south: -45 },
  queensland: { west: 136, east: 155, north: -9, south: -30 },
  southeast: { west: 149, east: 155, north: -23, south: -30 },
};
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
export function project(lon, lat, size = 1) {
  const phi = clamp(lat, -85, 85) * Math.PI / 180;
  return [(lon + 180) / 360 * size, (1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2 * size];
}
export function unproject(x, y, size = 1) {
  return [x / size * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / size))) * 180 / Math.PI];
}
export function timestampMs(stamp) {
  if (!/^\d{12}$/.test(stamp)) return NaN;
  const [y, m, d, h, min] = [stamp.slice(0, 4), stamp.slice(4, 6), stamp.slice(6, 8), stamp.slice(8, 10), stamp.slice(10, 12)].map(Number);
  const date = Date.UTC(y, m - 1, d, h, min);
  return new Date(date).toISOString().replace(/[-:T]/g, '').slice(0, 12) === stamp ? date : NaN;
}
export function selectTimes(data, hours = 4) {
  if (!Array.isArray(data)) throw new Error('Unexpected image timeline');
  const times = [...new Set(data.filter(t => typeof t === 'string' && Number.isFinite(timestampMs(t))))].sort();
  if (!times.length) throw new Error('No valid image times are available');
  const cutoff = timestampMs(times.at(-1)) - hours * 3600000;
  return times.filter(t => timestampMs(t) > cutoff).slice(-24);
}
export function tileURL(product, stamp, z, x, y) {
  if (!PRODUCTS[product] || !Number.isFinite(timestampMs(stamp))) throw new Error('Invalid image product or time');
  return `${ORIGIN}/himawari/${PRODUCTS[product].id}/Himawari/${stamp}/${z}/${x}/${2 ** z - y - 1}.jpg`;
}
export function overlayURL(id, z, x, y) {
  return `${ORIGIN}/tiles/${id}/GoogleMapsCompatible/000/${z}/${x}/${2 ** z - y - 1}.png`;
}
export function timelineURL(product) {
  return `${ORIGIN}/himawari/${PRODUCTS[product].id}/Himawari/timesteps.json`;
}
export function fitBounds(bounds, width, height) {
  const [west, north] = project(bounds.west, bounds.north);
  const [east, south] = project(bounds.east, bounds.south);
  const world = Math.min(width / (east - west), height / (south - north)) * 0.9;
  const [lon, lat] = unproject((west + east) / 2, (north + south) / 2);
  return { lon, lat, zoom: clamp(Math.log2(world / 512), 0, 6) };
}
export function minimumZoom(width, height) {
  const [west, north] = project(COVERAGE.west, COVERAGE.north);
  const [east, south] = project(COVERAGE.east, COVERAGE.south);
  // Cover the viewport in both dimensions. A tiny inset avoids floating-point
  // rounding exposing a one-pixel strip at the coverage edge.
  const world = Math.max(Math.max(1, width) / (east - west), Math.max(1, height) / (south - north));
  return Math.max(0, Math.log2(world / 512) + 1e-10);
}
export function constrainView(view, width, height) {
  const min = minimumZoom(width, height);
  const zoom = clamp(view.zoom, min, Math.max(6, min));
  const world = 512 * 2 ** zoom;
  const [west, north] = project(COVERAGE.west, COVERAGE.north, world);
  const [east, south] = project(COVERAGE.east, COVERAGE.south, world);
  const [cx, cy] = project(view.lon, view.lat, world);
  const x = clamp(cx, west + width / 2, east - width / 2);
  const y = clamp(cy, north + height / 2, south - height / 2);
  const [lon, lat] = unproject(x, y, world);
  return { lon, lat, zoom };
}
export function tilesForView(view, width, height, overlay = false) {
  // Match Satview's OpenLayers grid: choose the nearest *resolution*, rather
  // than flooring zoom. Static overlays use 256px tiles; imagery uses 512px.
  // The switch lies at log2(4/3) of a zoom step, not at a half-step. Flooring
  // enlarged city names and strokes by up to 2x at intermediate map zooms.
  const sourceZoom = view.zoom + (overlay ? 1 : 0);
  const lower = Math.floor(sourceZoom);
  const nearest = 2 ** (sourceZoom - lower) >= 4 / 3 ? lower + 1 : lower;
  const z = clamp(nearest, 0, overlay ? 7 : 6);
  const world = 512 * 2 ** view.zoom;
  const step = world / 2 ** z;
  const [cx, cy] = project(view.lon, view.lat, world);
  const left = cx - width / 2, top = cy - height / 2;
  const [bx0, by0] = project(COVERAGE.west, COVERAGE.north, 2 ** z);
  const [bx1, by1] = project(COVERAGE.east, COVERAGE.south, 2 ** z);
  const out = [];
  const x0 = Math.max(0, Math.floor(left / step), Math.floor(bx0));
  const y0 = Math.max(0, Math.floor(top / step), Math.floor(by0));
  const x1 = Math.min(2 ** z - 1, Math.ceil((left + width) / step) - 1, Math.ceil(bx1) - 1);
  const y1 = Math.min(2 ** z - 1, Math.ceil((top + height) / step) - 1, Math.ceil(by1) - 1);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    out.push({ z, x, y, dx: x * step - left, dy: y * step - top, size: step });
  }
  return out;
}
export function normalizeSettings(input = {}) {
  const num = (value, fallback, min, max) => Number.isFinite(Number(value)) && value !== null && value !== '' ? clamp(Number(value), min, max) : fallback;
  return {
    product: Object.hasOwn(PRODUCTS, input.product) ? input.product : 'daynight',
    lon: num(input.lon, 145, 85, 180), lat: num(input.lat, -22, -55, 20),
    zoom: num(input.zoom, 3.6, 0, 6),
    speed: [1, 2, 4, 8, 16, 24].includes(Number(input.speed)) ? Number(input.speed) : 4,
    hours: [1, 2, 4].includes(Number(input.hours)) ? Number(input.hours) : 4,
    playing: input.playing !== false && input.playing !== 'false',
    wall: input.wall === true || input.wall === 'true',
    cities: input.cities === true || input.cities === 'true',
    roads: input.roads === true || input.roads === 'true',
    legend: input.legend !== false && input.legend !== 'false',
    coordinates: input.coordinates === true || input.coordinates === 'true',
    boundaries: input.boundaries === true || input.boundaries === 'true',
    coast: input.coast === true || input.coast === 'true',
  };
}

// DOM-independent buffer: failed/in-flight frames never enter playback, and
// a refreshed timeline reuses ready frames with the same view and timestamp.
export class FrameBuffer {
  constructor() { this.frames = new Map(); this.times = []; this.product = null; this.viewKey = null; }
  reset(product, viewKey) {
    if (product !== this.product || viewKey !== this.viewKey) {
      this.frames.clear(); this.times = []; this.product = product; this.viewKey = viewKey;
    }
  }
  setTimeline(times) {
    this.times = times;
    const wanted = new Set(times);
    for (const key of this.frames.keys()) if (!wanted.has(key)) this.frames.delete(key);
  }
  put(stamp, surface) { if (this.times.includes(stamp)) this.frames.set(stamp, surface); }
  readyTimes() { return this.times.filter(t => this.frames.has(t)); }
  missingTimes() { return [...this.times].reverse().filter(t => !this.frames.has(t)); }
}
