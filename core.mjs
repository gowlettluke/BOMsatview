export const ORIGIN = 'https://d30f2i1nzx9v71.cloudfront.net';
export const PRODUCTS = {
  zehr: { id: 'IDE00433', name: 'Infrared + Zehr', short: 'INFRARED + ZEHR' },
  lightning: { id: 'Lightning', name: 'Lightning + Infrared', short: 'LIGHTNING + INFRARED' },
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
export function tilesForView(view, width, height, overlay = false) {
  // A tile remains on screen until its complete frame is ready. Lower source
  // zooms on large displays limit requests without altering the selected view.
  const z = clamp(Math.floor(view.zoom + (overlay ? 1 : 0)), 0, overlay ? 7 : 6);
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
    product: Object.hasOwn(PRODUCTS, input.product) ? input.product : 'zehr',
    lon: num(input.lon, 145, 85, 180), lat: num(input.lat, -22, -55, 20),
    zoom: num(input.zoom, 3.6, 0, 6),
    speed: [1, 2, 4, 8].includes(Number(input.speed)) ? Number(input.speed) : 2,
    hours: [1, 2, 4].includes(Number(input.hours)) ? Number(input.hours) : 4,
    playing: input.playing !== false && input.playing !== 'false',
    wall: input.wall === true || input.wall === 'true',
    cities: input.cities === true || input.cities === 'true',
    boundaries: input.boundaries !== false && input.boundaries !== 'false',
    coast: input.coast !== false && input.coast !== 'false',
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
