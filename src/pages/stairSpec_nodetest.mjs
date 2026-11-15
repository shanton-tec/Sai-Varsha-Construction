import test from "node:test"; import assert from "node:assert/strict";
import { holeShareInRoom, polyArea } from "./stairSpec.js";
const rect = (x, z, w, d) => [[x, z], [x + w, z], [x + w, z + d], [x, z + d]];
const hole = rect(1000, 1000, 1280, 4280); // stair footprint grown by 40
test("opening fully inside one room is kept whole", () => {
  const h = holeShareInRoom(hole, rect(0, 0, 5000, 6000)); assert.ok(h); assert.ok(Math.abs(Math.abs(polyArea(h)) - 1280 * 4280) < 1);
});
test("TEST D: opening crossing two adjoining rooms is split, not rejected", () => {
  const A = rect(0, 0, 5000, 3000), B = rect(0, 3000, 5000, 3000);
  const a = holeShareInRoom(hole, A), b = holeShareInRoom(hole, B); assert.ok(a && b);
  const total = Math.abs(polyArea(a)) + Math.abs(polyArea(b));
  assert.ok(Math.abs(total - 1280 * 4280) / (1280 * 4280) < 0.01, "shares add up to the full opening");
});
test("room that does not meet the opening gets no hole", () => assert.equal(holeShareInRoom(hole, rect(6000, 0, 3000, 3000)), null));
test("rotated opening still clips", () => {
  const c = Math.cos(0.5), s = Math.sin(0.5), r = hole.map(([x, z]) => [2500 + (x - 1640) * c - (z - 3140) * s, 3140 + (x - 1640) * s + (z - 3140) * c]);
  assert.ok(holeShareInRoom(r, rect(0, 0, 5000, 6000)));
});
