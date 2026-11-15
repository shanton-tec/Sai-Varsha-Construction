import test from "node:test"; import assert from "node:assert/strict";
import { applyLook, lookDir, moveVector, groundHeight, WALK_DEFAULTS } from "./walkPhysics.js";
const L0 = { yaw: 0, pitch: 0 };
test("mouse moved up looks toward the ceiling, down toward the floor", () => {
  assert.ok(lookDir(applyLook(L0, 0, -50, 600, WALK_DEFAULTS)) [1] > 0);
  assert.ok(lookDir(applyLook(L0, 0, 50, 600, WALK_DEFAULTS))[1] < 0);
});
test("forward follows the look direction, strafe right is to the right", () => {
  const f = moveVector(0, 1, 0), d = lookDir(L0); assert.ok(Math.abs(f[0] - d[0]) < 1e-9 && Math.abs(f[1] - d[2]) < 1e-9);
  assert.ok(moveVector(0, 0, 1)[0] > 0);
});
const st = { type: "stairs", x: 2000, z: 3000, rot: 0, lv: 0, elev: 0, size: { L: 1200, W: 4200, H: 2800 } };
test("walking up the stairs raises ground height; walking down lowers it", () => {
  let feet = 0; const up = [];
  for (let z = 0.95; z < 5.05; z += 0.05) { // length 4200 centred on z=3000 -> 0.9..5.1 m
    const g = groundHeight(2, z, feet, [st], 2.8, 2); up.push(g); feet = g;
  }
  assert.ok(up.at(-1) > 2.6, "reaches the upper landing, got " + up.at(-1));
  assert.ok(up.every((v, i) => i === 0 || v >= up[i - 1] - 1e-9), "monotonic up");
  for (let z = 5.05; z > 0.95; z -= 0.05) feet = groundHeight(2, z, feet, [st], 2.8, 2);
  assert.ok(feet < 0.3, "back at the bottom, got " + feet);
});
test("stair width is the short side (old code swapped L and W)", () => {
  assert.equal(groundHeight(2.9, 3, 1.4, [st], 2.8, 2), 0, "1.9 m to the side is off the 1.2 m wide stair");
});
test("upper floor stays at its level away from stairs", () => assert.equal(groundHeight(8, 8, 2.8, [st], 2.8, 2), 2.8));
test("rotated 90 deg", () => {
  const s2 = { ...st, rot: 90 }; // travel along +x
  assert.ok(groundHeight(3.8, 3, 2.5, [s2], 2.8, 2) > 2.5);
});
test("spiral: climbing around the pole rises monotonically to the top", () => {
  const sp = { type: "stairs", spiral: true, x: 0, z: 0, rot: 0, lv: 0, size: { L: 1900, W: 1900, H: 2800 } };
  let feet = 0, prev = 0;
  for (let a = -Math.PI / 2 + 0.05; a < -Math.PI / 2 + 2 * Math.PI - 0.1; a += 0.02) { feet = groundHeight(Math.sin(a) * 0.7, Math.cos(a) * 0.7, feet, [sp], 2.8, 2); assert.ok(feet >= prev - 1e-9); prev = feet; }
  assert.ok(feet > 2.4, "top reached: " + feet);
});
