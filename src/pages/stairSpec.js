/* Pure geometry helpers shared by the slab builder, 2D plan and tests (no three / DOM). */
export const polyArea = (P) => { let a = 0; for (let i = 0, j = P.length - 1; i < P.length; j = i++) a += (P[j][0] * P[i][1] - P[i][0] * P[j][1]); return a / 2; };
export function isConvex(P) {
  let sign = 0;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length], c = P[(i + 2) % P.length];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < 1e-6) continue;
    if (!sign) sign = Math.sign(cr); else if (Math.sign(cr) !== sign) return false;
  }
  return true;
}
/* Sutherland-Hodgman: clip `subject` (any simple polygon) against a CONVEX `clip` polygon. */
export function clipToConvex(subject, clip) {
  const ccw = polyArea(clip) > 0, cl = ccw ? clip : [...clip].reverse();
  let out = subject;
  for (let i = 0; i < cl.length && out.length; i++) {
    const A = cl[i], B = cl[(i + 1) % cl.length], inp = out; out = [];
    const side = (p) => (B[0] - A[0]) * (p[1] - A[1]) - (B[1] - A[1]) * (p[0] - A[0]);
    for (let k = 0; k < inp.length; k++) {
      const P = inp[k], Q = inp[(k + 1) % inp.length], sp = side(P), sq = side(Q);
      if (sp >= 0) out.push(P);
      if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]); }
    }
  }
  return out;
}
const pointInPoly = (pt, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, zi] = P[i], [xj, zj] = P[j]; if (zi > pt[1] !== zj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - zi)) / (zj - zi) + xi) c = !c; } return c; };
const inset = (P, d) => { const c = P.reduce((a, q) => [a[0] + q[0] / P.length, a[1] + q[1] / P.length], [0, 0]); return P.map((q) => { const dx = c[0] - q[0], dz = c[1] - q[1], L = Math.hypot(dx, dz) || 1; return [q[0] + (dx / L) * Math.min(d, L * 0.5), q[1] + (dz / L) * Math.min(d, L * 0.5)]; }); };
/* The part of `hole` that lies in `roomPoly`. Returns null when the room owns less than minShare of the hole (it belongs to a neighbour),
   otherwise a polygon strictly inside the room so the slab triangulation stays valid. Openings that straddle two rooms are cut
   in each room's slab by exactly its share, so together they form one continuous opening and no room gets an unsupported hole. */
export function holeShareInRoom(hole, roomPoly, minShare = 0.02, edgeInset = 1) {
  const full = Math.abs(polyArea(hole)); if (full < 1) return null;
  let part;
  if (isConvex(roomPoly)) part = clipToConvex(hole, roomPoly);
  else part = hole.every((q) => pointInPoly(q, roomPoly)) ? hole : []; // concave rooms: only whole openings (no robust boolean here)
  if (part.length < 3) return null;
  const a = Math.abs(polyArea(part)); if (a / full < minShare || a < 2500) return null;
  const touches = part.some((q) => !pointInPoly(q, roomPoly) || roomPoly.some((r, i) => { const s = roomPoly[(i + 1) % roomPoly.length], dx = s[0] - r[0], dz = s[1] - r[1], L2 = dx * dx + dz * dz || 1; let t = ((q[0] - r[0]) * dx + (q[1] - r[1]) * dz) / L2; t = Math.max(0, Math.min(1, t)); return Math.hypot(q[0] - (r[0] + dx * t), q[1] - (r[1] + dz * t)) < edgeInset + 0.5; }));
  return touches ? inset(part, edgeInset + 0.5) : part;
}
