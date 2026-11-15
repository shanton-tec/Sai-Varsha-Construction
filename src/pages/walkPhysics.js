export const WALK_DEFAULTS = {
  sens: 1,
  touchSens: 1,
  walkSpeed: 1.6,
  runSpeed: 3.6,
  eye: 1.65,
  fov: 75,
  bob: 0.12,
  smooth: 0.72,
  touchScale: 1,
  invertH: false,
  invertV: false,
  reduceMotion: false,
  touchRight: false,
  pointerLock: false,
  freeCam: false,
};

export const BASE_LOOK = 0.002;
const SETTINGS_KEY = "builder3d.walk.v1";
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function sanitizeWalk(value = {}) {
  const next = { ...WALK_DEFAULTS };
  for (const key of Object.keys(WALK_DEFAULTS)) {
    if (typeof WALK_DEFAULTS[key] === "boolean") next[key] = Boolean(value[key]);
    else {
      const number = Number(value[key]);
      if (Number.isFinite(number)) next[key] = number;
    }
  }
  next.sens = clamp(next.sens, 0.2, 3);
  next.touchSens = clamp(next.touchSens, 0.2, 3);
  next.walkSpeed = clamp(next.walkSpeed, 0.5, 5);
  next.runSpeed = clamp(next.runSpeed, 1, 9);
  next.eye = clamp(next.eye, 1, 2);
  next.fov = clamp(next.fov, 50, 100);
  next.bob = clamp(next.bob, 0, 1);
  next.smooth = clamp(next.smooth, 0, 1);
  next.touchScale = clamp(next.touchScale, 0.8, 1.6);
  return next;
}

export function loadWalk(storage) {
  try {
    const stored = storage.getItem(SETTINGS_KEY);
    return stored ? sanitizeWalk(JSON.parse(stored)) : { ...WALK_DEFAULTS };
  } catch {
    return { ...WALK_DEFAULTS };
  }
}

export function saveWalk(storage, value) {
  storage.setItem(SETTINGS_KEY, JSON.stringify(sanitizeWalk(value)));
}

export function applyLook(look, dx, dy, height, settings = WALK_DEFAULTS, touch = false) {
  const sensitivity = (touch ? settings.touchSens : settings.sens) * BASE_LOOK;
  const scale = touch ? 1 : Math.max(0.5, 600 / Math.max(1, height));
  return {
    yaw: look.yaw + dx * sensitivity * scale * (settings.invertH ? -1 : 1),
    // mouse: moving down looks down (FPS convention); touch keeps its drag-the-world feel (dragging down looks up)
    pitch: clamp(look.pitch + dy * sensitivity * scale * (touch ? 1 : -1) * (settings.invertV ? -1 : 1), -Math.PI * 0.48, Math.PI * 0.48),
  };
}

export function lookDir(look) {
  const horizontal = Math.cos(look.pitch);
  return [Math.sin(look.yaw) * horizontal, Math.sin(look.pitch), -Math.cos(look.yaw) * horizontal];
}

export function lookFromDir(x, y, z) {
  const length = Math.hypot(x, y, z) || 1;
  return { yaw: Math.atan2(x, -z), pitch: Math.asin(clamp(y / length, -1, 1)) };
}

export function moveVector(yaw, forward, strafe) {
  const length = Math.hypot(forward, strafe) || 1;
  const f = forward / Math.max(1, length), s = strafe / Math.max(1, length);
  return [Math.sin(yaw) * f + Math.cos(yaw) * s, -Math.cos(yaw) * f + Math.sin(yaw) * s];
}

export function stepVelocity(current, target, dt, smoothing = WALK_DEFAULTS.smooth) {
  const amount = 1 - Math.pow(clamp(smoothing, 0, 1), Math.max(0, dt) * 60);
  return [current[0] + (target[0] - current[0]) * amount, current[1] + (target[1] - current[1]) * amount];
}

export function bobOffset(phase, speed, settings = WALK_DEFAULTS, prefersReduced = false) {
  if (prefersReduced || settings.reduceMotion || speed < 0.05) return 0;
  return Math.sin(phase) * clamp(settings.bob, 0, 1) * Math.min(speed, 3) * 0.012;
}

export function furnitureSolids(items = [], level = 0, storeyHeight = 2800) {
  const nonBlocking = new Set(["stairs", "rug", "ceilingLight", "ceilingFan", "wallArt", "mirror", "curtains"]);
  return items.filter((item) => !item.hidden && (item.lv || 0) === level && !nonBlocking.has(item.type)).map((item) => {
    const angle = ((item.rot || 0) * Math.PI) / 180;
    const cos = Math.abs(Math.cos(angle)), sin = Math.abs(Math.sin(angle));
    const length = item.size?.L || 500, width = item.size?.W || 500;
    const halfX = (cos * length + sin * width) / 2000;
    const halfZ = (sin * length + cos * width) / 2000;
    const bottom = ((item.lv || 0) * storeyHeight + (item.elev || 0)) / 1000;
    return {
      x0: item.x / 1000 - halfX,
      x1: item.x / 1000 + halfX,
      z0: item.z / 1000 - halfZ,
      z1: item.z / 1000 + halfZ,
      y0: bottom,
      y1: bottom + (item.size?.H || 1000) / 1000,
    };
  });
}

const segmentDistance = (x, z, ax, az, bx, bz) => {
  const dx = bx - ax, dz = bz - az;
  const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1), 0, 1);
  return Math.hypot(x - (ax + t * dx), z - (az + t * dz));
};

export function isBlocked(position, context = {}) {
  if (context.free) return false;
  const [x, z] = position, radius = context.radius ?? 0.24;
  const feet = context.feetY ?? ((context.lv || 0) * (context.storeyH || 2.8));
  const head = feet + 1.8;
  if ((context.walls || []).some((wall) => {
    if ((wall.lv || 0) !== (context.lv || 0)) return false;
    return segmentDistance(x, z, wall.ax, wall.az, wall.bx, wall.bz) < radius + (wall.t || 0.1) / 2;
  })) return true;
  return (context.solids || []).some((solid) => {
    if (solid.y1 < feet + 0.05 || solid.y0 > head) return false;
    const closestX = clamp(x, solid.x0, solid.x1), closestZ = clamp(z, solid.z0, solid.z1);
    return Math.hypot(x - closestX, z - closestZ) < radius;
  });
}

export function resolveMove(position, delta, context = {}) {
  if (context.free) return [position[0] + delta[0], position[1] + delta[1]];
  const distance = Math.hypot(delta[0], delta[1]);
  const steps = Math.max(1, Math.ceil(distance / 0.08));
  const stepX = delta[0] / steps, stepZ = delta[1] / steps;
  let x = position[0], z = position[1];
  for (let index = 0; index < steps; index++) {
    if (!isBlocked([x + stepX, z], context)) x += stepX;
    if (!isBlocked([x, z + stepZ], context)) z += stepZ;
  }
  return [x, z];
}

export function recoverPosition(position, context = {}) {
  if (context.free || !isBlocked(position, context)) return [...position];
  const step = Math.max(0.08, (context.radius || 0.24) * 0.65);
  for (let ring = 1; ring <= 32; ring++) {
    const radius = ring * step;
    const count = Math.max(8, Math.ceil((Math.PI * 2 * radius) / step));
    for (let index = 0; index < count; index++) {
      const angle = (index / count) * Math.PI * 2;
      const candidate = [position[0] + Math.cos(angle) * radius, position[1] + Math.sin(angle) * radius];
      if (!isBlocked(candidate, context)) return candidate;
    }
  }
  return [...position];
}

export const STRAIGHT_RISERS = 18; // must match the riser count of the straight-stair model in Builder3D
/* Tread-top height (m, above the stair's own base) under plan point (x, z) metres, or null when the point is not on this staircase.
   Uses the same footprint convention as the model: L = width (local x), W = length (local z, travel direction), H = total rise. */
export function stairTreadHeight(item, x, z, storeyHeight = 2.8) {
  const angle = ((item.rot || 0) * Math.PI) / 180, dx = x * 1000 - item.x, dz = z * 1000 - item.z;
  const localX = dx * Math.cos(angle) - dz * Math.sin(angle), localZ = dx * Math.sin(angle) + dz * Math.cos(angle);
  const width = item.size?.L || 1200, length = item.size?.W || 4200, rise = (item.size?.H || storeyHeight * 1000) / 1000;
  if (item.spiral) {
    const R = width / 2, r = Math.hypot(localX, localZ);
    if (r > R || r < 60) return null;
    const sp = spiralParams(item, item.size?.H || storeyHeight * 1000), TAU = Math.PI * 2;
    let rel = (Math.atan2(localX, localZ) - sp.a0) % TAU; if (rel < 0) rel += TAU;
    if (rel > sp.sweep) return null;
    return (Math.min(sp.n - 1, Math.floor((rel / sp.sweep) * sp.n)) + 1) * (rise / sp.n);
  }
  if (Math.abs(localX) > width / 2 || Math.abs(localZ) > length / 2) return null;
  const idx = Math.min(STRAIGHT_RISERS - 1, Math.max(0, Math.floor((localZ / length + 0.5) * STRAIGHT_RISERS)));
  return (idx + 1) * (rise / STRAIGHT_RISERS);
}
/* Height of the walking surface under the player. The old version took max(feetY, stair) so the player could never go back down, and
   it swapped the stair's width and length. Now the surface is the stair tread the player stands on when it is within step reach of the
   feet (up or down), otherwise the storey floor beneath the feet. */
export function groundHeight(x, z, feetY, items = [], storeyHeight = 2.8, levels = 1) {
  const top = Math.max(0, levels - 1) * storeyHeight;
  let height = clamp(Math.floor((feetY + 0.25) / storeyHeight) * storeyHeight, 0, top), best = null;
  for (const item of items) {
    if (item.type !== "stairs" || item.hidden) continue;
    const t = stairTreadHeight(item, x, z, storeyHeight);
    if (t === null) continue;
    const y = ((item.lv || 0) * storeyHeight * 1000 + (item.elev || 0)) / 1000 + t;
    if (Math.abs(y - feetY) <= 0.45 && (best === null || Math.abs(y - feetY) < Math.abs(best - feetY))) best = y;
  }
  return best === null ? height : clamp(best, 0, top);
}

export function spiralParams(item, storeyHeight = item?.size?.H || 2800) {
  const height = Math.max(1, Number(storeyHeight) || 2800);
  const steps = Math.max(12, Math.ceil(height / 175));
  return { n: steps, a0: -Math.PI / 2, sweep: Math.PI * 2, landing: Math.PI / 8 };
}
