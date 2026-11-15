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
export const STRAIGHT_RISERS = 18;
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
    pitch: clamp(look.pitch + dy * sensitivity * scale * (settings.invertV ? -1 : 1), -Math.PI * 0.48, Math.PI * 0.48),
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

export function groundHeight(x, z, feetY, items = [], storeyHeight = 2.8, levels = 1) {
  let height = clamp(feetY, 0, Math.max(0, levels - 1) * storeyHeight);
  for (const item of items) {
    if (item.type !== "stairs" || item.hidden) continue;
    const angle = ((item.rot || 0) * Math.PI) / 180;
    const dx = x * 1000 - item.x, dz = z * 1000 - item.z;
    const localX = dx * Math.cos(angle) - dz * Math.sin(angle);
    const localZ = dx * Math.sin(angle) + dz * Math.cos(angle);
    const length = item.size?.L || 4200, width = item.size?.W || 1200;
    if (Math.abs(localX) > width / 2 || Math.abs(localZ) > length / 2) continue;
    const progress = clamp((localZ / length) + 0.5, 0, 1);
    const base = ((item.lv || 0) * storeyHeight * 1000 + (item.elev || 0)) / 1000;
    height = Math.max(height, base + progress * storeyHeight);
  }
  return height;
}

export function spiralParams(item, storeyHeight = item?.size?.H || 2800) {
  const height = Math.max(1, Number(storeyHeight) || 2800);
  const steps = Math.max(12, Math.ceil(height / 175));
  return { n: steps, a0: -Math.PI / 2, sweep: Math.PI * 2, landing: Math.PI / 8 };
}
