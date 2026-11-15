/**
 * studioScene.js — the Three.js layer of the Ultra-Realistic 3D Studio. ONE WebGLRenderer, reusing Builder3D's own
 * geometry builders (buildStructure / buildExterior / buildModel) so rooms, walls, openings and furniture match the plan exactly.
 *
 * Honest rendering notes:
 *  - Real-time mode: PBR (MeshStandard/Physical) + shadow-mapped sun/lights + PMREM image-based lighting from a procedural sky.
 *  - Presentation mode: progressive multi-sample ACCUMULATION (sub-pixel jitter for anti-aliasing, optional lens-disk jitter for
 *    depth of field, many shadow/light samples averaged). This is NOT path tracing and NOT global illumination.
 *  - "GI" option = hemisphere/environment fill + contact shadows (an approximation) — never labelled physically accurate.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { CAT, paint, disposeTree, buildStructure, buildExterior, buildModel, makeFloorTextures, bboxOf, storeyH } from "../Builder3D.jsx";
import { resolveMove, groundHeight, furnitureSolids, applyLook, moveVector, stepVelocity, recoverPosition, lookDir, WALK_DEFAULTS } from "../walkPhysics.js";
import { QUALITY, capPixelRatio, sunPosition, sunKelvin, kelvinToHex, lumensToCandela, LIGHT_TYPES, SKY_PRESETS, sanitizeLight, uvRepeat, MATERIAL_PRESETS, sanitizeMaterial, makeAssetCache, sanitizeCamera } from "./studioCore.js";

const MM = 0.001;
const PHYSICAL_LIGHTS = parseInt(THREE.REVISION, 10) >= 155; // point/spot intensity is candela from r155; older builds use a legacy scale
export const hasWebGL = () => { try { const c = document.createElement("canvas"); return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl"))); } catch (e) { return false; } };

/* ---------- procedural, seeded texture patterns (generated, no third-party assets) ---------- */
const rng = (seed) => { let s = seed % 2147483647 || 1; return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646; };
function patternCanvas(pattern, color, size = 256) {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas"); c.width = c.height = size; const x = c.getContext("2d"), R = rng(7 + pattern.length * 31);
  x.fillStyle = color; x.fillRect(0, 0, size, size);
  const line = (a) => { x.strokeStyle = `rgba(0,0,0,${a})`; };
  if (pattern === "grain") for (let i = 0; i < 90; i++) { line(0.03 + R() * 0.08); x.lineWidth = 0.5 + R() * 1.6; const y = R() * size; x.beginPath(); x.moveTo(0, y); x.bezierCurveTo(size * 0.3, y + (R() - 0.5) * 8, size * 0.6, y + (R() - 0.5) * 8, size, y + (R() - 0.5) * 5); x.stroke(); }
  else if (pattern === "veins") for (let i = 0; i < 9; i++) { x.strokeStyle = `rgba(90,90,95,${0.08 + R() * 0.18})`; x.lineWidth = 0.6 + R() * 1.8; x.beginPath(); let px = R() * size, py = 0; x.moveTo(px, py); for (let k = 0; k < 8; k++) { px += (R() - 0.4) * 50; py += size / 8; x.lineTo(px, py); } x.stroke(); }
  else if (pattern === "speckle" || pattern === "chips" || pattern === "noise") { const n = pattern === "noise" ? 2500 : 1800; for (let i = 0; i < n; i++) { const g = Math.round(R() * 255), a = pattern === "noise" ? 0.05 : 0.3; x.fillStyle = pattern === "chips" ? `hsla(${R() * 360},${R() * 25}%,${45 + R() * 40}%,${a + 0.3})` : `rgba(${g},${g},${g},${a * R()})`; const s = pattern === "chips" ? 1 + R() * 4 : 0.6 + R() * 1.5; x.fillRect(R() * size, R() * size, s, s); } }
  else if (pattern === "weave") for (let i = 0; i < size; i += 2) { line(0.05); x.beginPath(); x.moveTo(i, 0); x.lineTo(i, size); x.stroke(); x.beginPath(); x.moveTo(0, i); x.lineTo(size, i); x.stroke(); }
  else if (pattern === "pebble") for (let i = 0; i < 700; i++) { x.fillStyle = `rgba(0,0,0,${R() * 0.1})`; x.beginPath(); x.arc(R() * size, R() * size, 1 + R() * 3, 0, 7); x.fill(); }
  else if (pattern === "brushed") for (let i = 0; i < 400; i++) { x.strokeStyle = `rgba(${R() > 0.5 ? 255 : 0},${R() > 0.5 ? 255 : 0},${R() > 0.5 ? 255 : 0},${R() * 0.06})`; x.lineWidth = 1; const y = R() * size; x.beginPath(); x.moveTo(0, y); x.lineTo(size, y); x.stroke(); }
  else if (pattern === "grid") { x.strokeStyle = "rgba(0,0,0,0.28)"; x.lineWidth = 3; x.strokeRect(0, 0, size, size); }
  else if (pattern === "stripes") for (let i = 0; i < size; i += 32) { x.fillStyle = "rgba(255,255,255,0.18)"; x.fillRect(i, 0, 14, size); }
  return c;
}
const texCache = new Map();
function patternTexture(pattern, color) {
  if (pattern === "none") return null;
  const k = pattern + color; if (texCache.has(k)) return texCache.get(k);
  const cv = patternCanvas(pattern, color); if (!cv) return null;
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.userData = { shared: true };
  texCache.set(k, t); return t;
}
/** Build a MeshPhysicalMaterial from a sanitized studio material. `surface` (metres) sets real-world texture scale; missing texture => flat colour. */
export function makeThreeMaterial(m, surface = [1, 1]) {
  const s = sanitizeMaterial(m), o = { color: s.color, roughness: s.roughness, metalness: s.metalness, clearcoat: s.clearcoat, clearcoatRoughness: s.clearcoatRoughness, envMapIntensity: s.metalness > 0.5 ? 1.2 : 0.7 };
  if (s.transmission > 0) { o.transmission = s.transmission; o.ior = s.ior; o.thickness = 0.02; o.transparent = false; o.side = THREE.DoubleSide; }
  if (s.opacity < 1) { o.transparent = true; o.opacity = s.opacity; }
  const mat = new THREE.MeshPhysicalMaterial(o); mat.userData.studio = true;
  try {
    const t0 = patternTexture(MATERIAL_PRESETS[s.preset] ? MATERIAL_PRESETS[s.preset].pattern : s.pattern, s.color);
    if (t0) { const t = t0.clone(); t.needsUpdate = true; const [u, v] = uvRepeat(surface[0], surface[1], s.tile); t.repeat.set(u, v); t.rotation = (s.rotation * Math.PI) / 180; t.offset.set(s.offsetU, s.offsetV); t.userData = { ownedByMaterial: true }; mat.map = t; mat.color.set("#ffffff"); mat.color.multiplyScalar(1); mat.color.set(s.color).lerp(new THREE.Color("#ffffff"), 0.0); if (s.bump > 0) { mat.bumpMap = t; mat.bumpScale = s.bump; } }
  } catch (e) { /* missing/failed texture => keep flat colour */ }
  return mat;
}
const disposeMat = (m) => { [].concat(m).forEach((x) => { if (!x) return; ["map", "bumpMap"].forEach((k) => { if (x[k] && x[k].userData && x[k].userData.ownedByMaterial) x[k].dispose(); }); x.dispose(); }); };

/* ---------- extra architectural detail (cornice, curtain rails + pleated curtains, downlight rosettes) ---------- */
function curtainGeometry(w, h, folds) {
  const g = new THREE.PlaneGeometry(w, h, Math.max(8, folds * 8), 1), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setZ(i, Math.sin((p.getX(i) / w) * Math.PI * 2 * folds) * 0.035);
  g.computeVertexNormals(); return g;
}
export function buildDetails(D, studio) {
  const g = new THREE.Group(), H = storeyH(D) * MM, mats = [];
  const std = (c, r = 0.6, m = 0) => { const x = new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m }); mats.push(x); return x; };
  const cornMat = std("#f4f3ef", 0.7), railMat = std("#2b2d31", 0.4, 0.8), curMat = std("#e4dccf", 0.98); curMat.side = THREE.DoubleSide;
  // cornice: 70x70 mm trim following the inside of each room's perimeter, 1 mm below the ceiling plane to avoid z-fighting
  (D.rooms || []).filter((r) => r.type !== "void" && studio.cornice !== false).forEach((r) => {
    const P = r.poly, lv = r.lv || 0; if (!P || P.length < 3) return;
    let area = 0; P.forEach((q, i) => { const n = P[(i + 1) % P.length]; area += q[0] * n[1] - n[0] * q[1]; });
    const sgn = area > 0 ? 1 : -1;
    P.forEach((a, i) => {
      const b = P[(i + 1) % P.length], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz); if (L < 300) return;
      const wall = (D.walls || []).find((w) => w.id === (r.wallIds || [])[i]), t = (wall && wall.t) || 150;
      const nx = (-dz / L) * sgn * -1, nz = (dx / L) * sgn * -1; // inward normal
      const off = t / 2 + 35, cx = (a[0] + b[0]) / 2 + nx * off, cz = (a[1] + b[1]) / 2 + nz * off;
      const m = new THREE.Mesh(new THREE.BoxGeometry(L * MM, 0.07, 0.07), cornMat);
      m.position.set(cx * MM, (lv * storeyH(D) * MM) + H - 0.036 - 0.001, cz * MM); m.rotation.y = -Math.atan2(dz, dx); m.castShadow = false; m.receiveShadow = true;
      m.userData = { detail: "cornice" }; g.add(m);
    });
  });
  // curtain rails + pleated panels over windows flagged curtain:true
  (D.openings || []).filter((o) => o.type === "window" && o.curtain).forEach((o) => {
    const w = (D.walls || []).find((q) => q.id === o.wallId); if (!w) return;
    const dx = w.b[0] - w.a[0], dz = w.b[1] - w.a[1], L = Math.hypot(dx, dz) || 1, ux = dx / L, uz = dz / L, c = (o.pos != null ? o.pos : 0.5) * L;
    const px = w.a[0] + ux * c, pz = w.a[1] + uz * c, lv = o.lv || 0, base = lv * storeyH(D) * MM, width = (o.width + 400) * MM;
    const grp = new THREE.Group(); grp.position.set(px * MM, 0, pz * MM); grp.rotation.y = -Math.atan2(dz, dx);
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, width, 12), railMat); rail.rotation.z = Math.PI / 2; rail.position.set(0, base + H - 0.2, 0.1);
    const top = base + H - 0.2, bottom = base + 0.04, ch = top - bottom;
    const panel = new THREE.Mesh(curtainGeometry(width, ch, Math.max(4, Math.round(width / 0.2))), curMat); panel.position.set(0, bottom + ch / 2, 0.1); panel.castShadow = true;
    grp.add(rail, panel); grp.userData = { detail: "curtain", openingId: o.id }; g.add(grp);
  });
  g.userData.mats = mats; return g;
}

/* ---------- environment (procedural sky => PMREM; studio => RoomEnvironment) ---------- */
function makeEnv(renderer, env, sunDir) {
  const pm = new THREE.PMREMGenerator(renderer); let rt;
  const preset = SKY_PRESETS[env.sky] || SKY_PRESETS.brightDay;
  if (preset.studio) { const room = new RoomEnvironment(renderer); rt = pm.fromScene(room, 0.04); room.dispose && room.dispose(); }
  else {
    const sc = new THREE.Scene(), sky = new Sky(); sky.scale.setScalar(10000); sc.add(sky);
    const u = sky.material.uniforms; u.turbidity.value = preset.turbidity; u.rayleigh.value = env.sky === "night" ? 0.05 : env.sky === "sunset" || env.sky === "goldenHour" ? 3 : 1.4; u.mieCoefficient.value = 0.005; u.mieDirectionalG.value = 0.8;
    u.sunPosition.value.set(sunDir[0], Math.max(sunDir[1], -0.05), sunDir[2]); rt = pm.fromScene(sc, 0.02);
    sky.geometry.dispose(); sky.material.dispose();
  }
  pm.dispose(); return rt;
}

/* ================================================================== */
export function createStudioRenderer(host, opts = {}) {
  const st = { quality: opts.quality || "balanced", project: null, groups: new Map(), lightObjs: new Map(), onPick: opts.onPick || (() => {}), onChange: opts.onChange || (() => {}), onStatus: opts.onStatus || (() => {}), disposed: false, tool: null, selection: [], walk: false, look: { yaw: 0, pitch: 0 }, vel: [0, 0], input: [0, 0], walkSet: { ...WALK_DEFAULTS }, walkLv: 0, rendering: null, raf: 0, frameMs: [] };
  const q = () => QUALITY[st.quality] || QUALITY.balanced;
  const renderer = new THREE.WebGLRenderer({ antialias: q().antialias, powerPreference: "high-performance", preserveDrawingBuffer: false });
  renderer.setPixelRatio(capPixelRatio(window.devicePixelRatio || 1, st.quality));
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.85;
  renderer.shadowMap.enabled = q().shadows !== "off"; renderer.shadowMap.type = q().shadows === "soft" ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  renderer.domElement.style.cssText = "display:block;width:100%;height:100%;touch-action:none;outline:none"; renderer.domElement.tabIndex = 0;
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene(); scene.background = new THREE.Color("#dfe6ee");
  const cam = new THREE.PerspectiveCamera(45, 1, 0.05, 400); cam.position.set(8, 6, 10);
  const oc = new OrbitControls(cam, renderer.domElement); oc.enableDamping = true; oc.dampingFactor = 0.08; oc.maxPolarAngle = Math.PI * 0.495;
  const tc = new TransformControls(cam, renderer.domElement); tc.setSize(0.8); scene.add(tc.getHelper ? tc.getHelper() : tc);
  tc.addEventListener("dragging-changed", (e) => { oc.enabled = !e.value; st.dragging = e.value; if (!e.value) commitTransform(); });
  const sun = new THREE.DirectionalLight(0xffffff, 3); sun.castShadow = true; scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xdfe8f5, 0x9a8f80, 0.25); scene.add(hemi);
  const furn = new THREE.Group(), lightsG = new THREE.Group(), detailG = new THREE.Group(), floorG = new THREE.Group(); scene.add(furn, lightsG, detailG, floorG);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 64), new THREE.MeshStandardMaterial({ color: "#b9c3b0", roughness: 1 })); ground.rotation.x = -Math.PI / 2; ground.position.y = -0.02; ground.receiveShadow = true; scene.add(ground);
  let struct = null, ext = null, envRT = null, sunInfo = null, bb = { x0: 0, x1: 4000, z0: 0, z1: 4000 };
  const assets = makeAssetCache(24), loader = new GLTFLoader(), ray = new THREE.Raycaster(), ptr = new THREE.Vector2(), box = new THREE.BoxHelper(new THREE.Object3D(), 0x2f7df6); box.visible = false; scene.add(box);

  /* ----- environment + sun + exposure ----- */
  function applyEnv() {
    const p = st.project; if (!p) return; const env = p.studio.env, preset = SKY_PRESETS[env.sky] || SKY_PRESETS.brightDay;
    sunInfo = sunPosition(env.hour, env.latitude, env.dayOfYear, env.northRotation);
    const dir = preset.studio ? [0.3, 0.9, 0.3] : sunInfo.dir, size = Math.max((bb.x1 - bb.x0) * MM, (bb.z1 - bb.z0) * MM, 6);
    const cx = ((bb.x0 + bb.x1) / 2) * MM, cz = ((bb.z0 + bb.z1) / 2) * MM;
    sun.position.set(cx + dir[0] * size * 2, Math.max(dir[1], 0.02) * size * 2, cz + dir[2] * size * 2); sun.target.position.set(cx, 0, cz);
    const k = sunKelvin(sunInfo.elevationDeg); sun.color.set(k ? kelvinToHex(k) : "#8aa0ff");
    const above = !preset.studio && sunInfo.up;
    sun.intensity = above ? 4 * preset.sun * env.sunIntensity * Math.min(1, sunInfo.elevationDeg / 12 + 0.15) : 0;
    sun.castShadow = sun.intensity > 0 && q().shadows !== "off";
    const sh = sun.shadow, e = size * 0.9; sh.mapSize.set(q().shadowMap, q().shadowMap); if (sh.map) { sh.map.dispose(); sh.map = null; }
    Object.assign(sh.camera, { left: -e, right: e, top: e, bottom: -e, near: 0.5, far: size * 5 }); sh.camera.updateProjectionMatrix(); sh.bias = -0.0004; sh.normalBias = 0.03; sh.radius = q().shadows === "soft" ? 3 : 1;
    if (envRT) envRT.dispose(); envRT = makeEnv(renderer, env, dir); scene.environment = envRT.texture; scene.environmentIntensity = 0.55 * preset.sky * env.envIntensity; // r163+; older builds ignore this and use per-material envMapIntensity
    hemi.intensity = env.gi === "approx" ? 0.45 : 0.2; renderer.toneMappingExposure = (opts.exposureOverride ?? env.exposure) * (preset.exposure / 0.85);
    scene.background = new THREE.Color(env.sky === "night" ? "#0c1220" : preset.studio ? "#d8d8d8" : "#c9d9ea");
    ground.visible = !preset.studio; ground.material.color.set(env.sky === "night" ? "#1e251e" : "#b9c3b0");
  }

  /* ----- structure ----- */
  function rebuildStructure() {
    const p = st.project; if (!p) return; const D = p.design, studio = p.studio;
    [struct, ext].forEach((o) => { if (o) { scene.remove(o); disposeTree(o); } }); struct = ext = null;
    detailG.children.slice().forEach((c) => { detailG.remove(c); c.traverse((n) => { if (n.geometry) n.geometry.dispose(); }); (c.userData.mats || []).forEach((m) => m.dispose()); });
    bb = bboxOf(D); const mode = st.view === "exterior";
    const out = buildStructure(D, bb, { maxLevel: st.showAll ? 99 : st.level, floorTex: st.floorTex || (st.floorTex = makeFloorTextures()), wallColor: mode ? D.ext.wall : D.ext.inside || "#f4f4f2", trim: mode ? D.ext.trim : "#ffffff", finish: D.ext.finish, inFinish: D.ext.insideFinish || "paint", frame: D.ext.frame || "pvc", facade: D.ext.facade, exterior: mode, ceilings: st.walk, wallOp: 1, floorOp: 1 });
    struct = out.root; st.collide = out.collide; st.floorMeshes = out.floorMeshes; st.wallGroups = out.wallGroups; st.glassMats = out.glassMats; scene.add(struct);
    out.root.traverse((o) => { if (o.isMesh) { o.castShadow = o.castShadow || !!(o.material && !o.material.transparent); o.receiveShadow = true; } });
    if (mode) { ext = buildExterior(D, bb); if (studio.hideLandscape) ext.traverse((o) => { if (o.userData && o.userData.landscape) o.visible = false; }); scene.add(ext); }
    const d = buildDetails(D, studio); detailG.add(d);
    applySurfaces();
  }
  /** Override finishes. Only materials change: geometry (and so every dimension) is untouched. */
  function applySurfaces() {
    const p = st.project; if (!p || !struct) return; const S = p.studio.surfaces || {};
    (p.design.rooms || []).forEach((r) => {
      const fm = st.floorMeshes && st.floorMeshes.get(r.id), key = `room:${r.id}:floor`;
      if (fm && S[key]) { if (fm.userData.studioMat) disposeMat(fm.userData.studioMat); const sz = new THREE.Box3().setFromObject(fm).getSize(new THREE.Vector3()); fm.material = fm.userData.studioMat = makeThreeMaterial(S[key], [sz.x, sz.z]); }
      (r.wallIds || []).forEach((wid, k) => {
        const wk = `room:${r.id}:wall:${k}`; if (!S[wk]) return;
        (st.wallGroups || []).forEach((g) => {
          const mem = (g.userData.members || []).map((m) => (m && m.id) || m); if (!mem.includes(wid)) return;
          let best = null, bv = 0; g.traverse((n) => { if (n.isMesh && n.geometry) { n.geometry.computeBoundingBox(); const s = n.geometry.boundingBox.getSize(new THREE.Vector3()); const v = s.x * s.y * s.z; if (v > bv) { bv = v; best = n; } } });
          if (best) { if (best.userData.studioMat) disposeMat(best.userData.studioMat); const s = new THREE.Box3().setFromObject(best).getSize(new THREE.Vector3()); best.material = best.userData.studioMat = makeThreeMaterial(S[wk], [Math.max(s.x, s.z), s.y]); }
        });
      });
    });
  }

  /* ----- furniture: one group per DESIGN item id (render-only objects never create records) ----- */
  function syncFurniture() {
    const p = st.project; if (!p) return; const D = p.design, seen = new Set(), S = p.studio.surfaces || {}; let missing = 0;
    D.items.forEach((it) => {
      const c = CAT[it.type]; if (!c) return; seen.add(it.id);
      const sig = it.type + ":" + it.variant + (it.spiral ? ":sp" : "") + (it.type === "stairs" ? ":" + Math.round(it.size.L) + "x" + Math.round(it.size.W) + "x" + Math.round(it.size.H) : ""); let g = st.groups.get(it.id);
      if (g && g.userData.sig !== sig) { if (tc.object === g) tc.detach(); furn.remove(g); disposeTree(g); st.groups.delete(it.id); g = null; }
      if (!g) {
        try { g = buildModel(it.type, it.variant, !!it.spiral, it.size); }
        catch (e) { missing++; return; }
        g.userData = { id: it.id, kind: "item", sig, placeholder: !(opts.assetUrls && opts.assetUrls[it.type]) }; g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.userData.rootId = it.id; } });
        furn.add(g); st.groups.set(it.id, g);
        if (opts.assetUrls && opts.assetUrls[it.type]) loadAsset(it, g);
      }
      const v = c.variants[it.variant] || c.variants[0]; paint(g, v, it.color);
      const ov = S["item:" + it.id]; if (ov) { g.traverse((o) => { if (o.isMesh && o.material && o.material.userData && o.material.userData.role === "main") { if (o.userData.studioMat) disposeMat(o.userData.studioMat); o.material = o.userData.studioMat = makeThreeMaterial(ov, [it.size.L * MM, it.size.W * MM]); } }); }
      g.position.set(it.x * MM, ((it.elev || 0) + (it.lv || 0) * storeyH(D)) * MM, it.z * MM); g.rotation.y = ((it.rot || 0) * Math.PI) / 180;
      g.scale.set((it.mirror ? -1 : 1) * it.size.L * MM, it.size.H * MM, it.size.W * MM); g.visible = !it.hidden && (st.showAll || (it.lv || 0) <= st.level);
    });
    st.groups.forEach((g, id) => { if (!seen.has(id)) { if (tc.object === g) tc.detach(); furn.remove(g); disposeTree(g); st.groups.delete(id); } });
    if (missing) st.onStatus({ warn: `${missing} furniture model(s) could not be built; placeholders skipped` });
    updateSelection();
  }
  /** Load a real GLB for a catalog type, fit it into the stored size box (so dimensions stay authoritative). Failure keeps the placeholder and reports it. */
  function loadAsset(it, placeholderGroup) {
    const url = opts.assetUrls[it.type], cached = assets.get(url);
    const fit = (gltf) => {
      if (st.disposed || !st.groups.has(it.id) || st.groups.get(it.id) !== placeholderGroup) return;
      const m = gltf.scene.clone(true), b = new THREE.Box3().setFromObject(m), s = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
      const wrap = new THREE.Group(); m.position.set(-c.x, -b.min.y, -c.z); wrap.add(m); wrap.scale.set(1 / (s.x || 1), 1 / (s.y || 1), 1 / (s.z || 1));
      placeholderGroup.children.slice().forEach((ch) => { placeholderGroup.remove(ch); disposeTree(ch); }); placeholderGroup.add(wrap); placeholderGroup.userData.placeholder = false;
      wrap.traverse((o) => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; o.userData.rootId = it.id; } });
    };
    if (cached) return fit(cached.v);
    loader.load(url, (gltf) => { assets.set(url, gltf, (x) => x.scene && disposeTree(x.scene)); fit(gltf); st.onStatus({ loaded: it.type }); }, undefined, (err) => st.onStatus({ warn: `Could not load model for ${it.type}; showing placeholder` }));
  }

  /* ----- studio lights ----- */
  function syncLights() {
    const p = st.project; if (!p) return; const H = storeyH(p.design) * MM, seen = new Set(), maxL = q().maxLights; let n = 0;
    (p.studio.lights || []).map(sanitizeLight).forEach((l) => {
      seen.add(l.id); const t = LIGHT_TYPES[l.type]; let o = st.lightObjs.get(l.id);
      const want = t.kind === "spot" ? "spot" : "point";
      if (o && o.userData.k !== want) { lightsG.remove(o); o.dispose && o.dispose(); st.lightObjs.delete(l.id); o = null; }
      if (!o) { o = want === "spot" ? new THREE.SpotLight(0xffffff, 1, 0, 0.5, 0.6, 2) : new THREE.PointLight(0xffffff, 1, 0, 2); o.userData = { k: want, id: l.id, kind: "light" }; const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff })); bulb.userData = { rootId: l.id, kind: "light" }; o.add(bulb); lightsG.add(o); st.lightObjs.set(l.id, o); if (want === "spot") lightsG.add(o.target); }
      const live = l.on && !l.hidden && n < maxL; if (live) n++;
      const cd = lumensToCandela(l.lumens, t.kind === "spot" ? "spot" : "point", l.angle); o.intensity = live ? (PHYSICAL_LIGHTS ? cd : cd / 80) : 0; o.color.set(kelvinToHex(l.kelvin)); o.visible = !l.hidden;
      o.position.set(l.x * MM, (l.elev + (l.lv || 0) * storeyH(p.design)) * MM, l.z * MM);
      if (want === "spot") { o.angle = (l.angle * Math.PI) / 360 * 2; o.penumbra = 0.55; o.target.position.set(o.position.x, o.position.y - 1, o.position.z); }
      o.castShadow = live && l.castShadow && q().shadows !== "off" && n <= 4; if (o.shadow) { o.shadow.mapSize.set(Math.min(1024, q().shadowMap), Math.min(1024, q().shadowMap)); o.shadow.bias = -0.0005; }
      const bulb = o.children[0]; if (bulb) { bulb.material.color.set(live ? kelvinToHex(l.kelvin) : "#555"); bulb.visible = !st.walk; }
    });
    st.lightObjs.forEach((o, id) => { if (!seen.has(id)) { lightsG.remove(o); if (o.target) lightsG.remove(o.target); o.dispose && o.dispose(); st.lightObjs.delete(id); } });
    st.lightsOver = Math.max(0, (p.studio.lights || []).filter((l) => l.on).length - maxL);
    if (st.lightsOver) st.onStatus({ warn: `${st.lightsOver} light(s) not rendered in this quality mode (limit ${maxL})` });
  }

  /* ----- selection / picking / transform ----- */
  const groupOf = (sel) => (sel.kind === "item" ? st.groups.get(sel.id) : sel.kind === "light" ? st.lightObjs.get(sel.id) : sel.kind === "room" && st.floorMeshes ? st.floorMeshes.get(sel.id) : null);
  function updateSelection() {
    const first = st.selection[0], g = first && groupOf(first);
    if (g && first.kind === "item" && st.tool && !st.walk) { const it = st.project.design.items.find((i) => i.id === first.id); if (it && !it.locked && !it.hidden) { if (tc.object !== g) tc.attach(g); tc.setMode(st.tool); } else tc.detach(); } else if (g && first.kind === "light" && st.tool === "translate") { tc.attach(g); tc.setMode("translate"); } else tc.detach();
    box.visible = !!g; if (g) { box.setFromObject(g); box.update(); }
  }
  function commitTransform() {
    const g = tc.object; if (!g || !g.userData.id) { if (g && g.userData.kind === "light") st.onChange({ kind: "light", id: g.userData.id, x: Math.round(g.position.x * 1000), z: Math.round(g.position.z * 1000) }); return; }
    const D = st.project.design, it = D.items.find((i) => i.id === g.userData.id); if (!it) return;
    const sH = storeyH(D), grid = st.snap || 0, sn = (v) => (grid ? Math.round(v / grid) * grid : Math.round(v));
    const patch = { kind: "item", id: it.id, x: sn(g.position.x * 1000), z: sn(g.position.z * 1000), rot: Math.round(((((g.rotation.y * 180) / Math.PI) % 360) + 360) % 360), elev: Math.max(0, Math.round(g.position.y * 1000 - (it.lv || 0) * sH)) };
    if (tc.getMode() === "scale") Object.assign(patch, { size: { L: Math.max(50, Math.round(Math.abs(g.scale.x) * 1000)), H: Math.max(20, Math.round(g.scale.y * 1000)), W: Math.max(50, Math.round(g.scale.z * 1000)) } });
    st.onChange(patch);
  }
  function pick(ev) {
    const r = renderer.domElement.getBoundingClientRect(); ptr.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(ptr, cam);
    const targets = [furn, lightsG, struct, ext].filter(Boolean), hit = ray.intersectObjects(targets, true).find((h) => h.object.visible && !h.object.userData.detail);
    if (!hit) return null; let o = hit.object;
    if (o.userData.rootId) return { kind: o.userData.kind || "item", id: o.userData.rootId };
    while (o) { const u = o.userData || {}; if (u.kind === "room" && u.id) return { kind: "room", id: u.id }; if (u.kind === "wall") return { kind: "wall", id: (u.members && ((u.members[0] && u.members[0].id) || u.members[0])) || null }; if (u.id && u.kind) return { kind: u.kind, id: u.id }; o = o.parent; }
    return null;
  }
  let down = null;
  const onDown = (e) => { down = [e.clientX, e.clientY, performance.now()]; };
  const onUp = (e) => { if (!down || st.dragging || st.walk) return; const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]); down = null; if (moved > 5) return; if (tc.axis) return; const sel = pick(e); st.onPick(sel, e.shiftKey || e.ctrlKey || e.metaKey); };
  renderer.domElement.addEventListener("pointerdown", onDown); renderer.domElement.addEventListener("pointerup", onUp);

  /* ----- walkthrough (uses walkPhysics.js unchanged: real walls, furniture and stairs) ----- */
  function walkCtx(feetY) { const D = st.project.design, sH = storeyH(D) * MM; return { walls: st.collide || [], solids: furnitureSolids(D.items, st.walkLv, storeyH(D)), stairs: D.items.filter((i) => i.type === "stairs" && !i.hidden), lv: st.walkLv, storeyH: sH, feetY, radius: 0.24 }; }
  function walkLook(dx, dy, touch) { st.look = applyLook(st.look, dx, dy, host.clientHeight || 600, st.walkSet, touch); }
  function setWalk(on, start) {
    st.walk = !!on; oc.enabled = !on; tc.detach(); box.visible = false; if (!on) { cam.fov = st.camFov || 45; cam.updateProjectionMatrix(); return; }
    const D = st.project.design, sH = storeyH(D) * MM, b = start || { x: ((bb.x0 + bb.x1) / 2) * MM, z: ((bb.z0 + bb.z1) / 2) * MM, lv: st.level };
    st.walkLv = b.lv || 0; st.showAll = true; rebuildStructure(); syncFurniture();
    let pos = recoverPosition([b.x, b.z], walkCtx(st.walkLv * sH)); st.walkPos = pos; st.look = { yaw: b.yaw || 0, pitch: 0 }; st.vel = [0, 0];
    st.camFov = cam.fov; cam.fov = st.walkSet.fov; cam.updateProjectionMatrix();
  }
  function stepWalk(dt) {
    const D = st.project.design, sH = storeyH(D) * MM, s = st.walkSet, feet = (st.walkFeet ?? st.walkLv * sH), run = st.input[2] ? s.runSpeed : s.walkSpeed;
    const wish = moveVector(st.look.yaw, st.input[0], st.input[1]); st.vel = stepVelocity(st.vel, [wish[0] * run, wish[1] * run], dt, s.smooth);
    const ctx = walkCtx(feet); st.walkPos = resolveMove(st.walkPos, [st.vel[0] * dt, st.vel[1] * dt], ctx);
    const gy = groundHeight(st.walkPos[0], st.walkPos[1], feet, D.items, sH, D.levels || 1); st.walkFeet = feet + (gy - feet) * Math.min(1, dt * 12); // smooth, physical climb: no teleport
    st.walkLv = Math.max(0, Math.min((D.levels || 1) - 1, Math.floor((st.walkFeet + 0.3) / sH)));
    cam.position.set(st.walkPos[0], st.walkFeet + s.eye, st.walkPos[1]); const d = lookDir(st.look); cam.lookAt(cam.position.x + d[0], cam.position.y + d[1], cam.position.z + d[2]);
  }

  /* ----- camera / sizing / loop ----- */
  function resize() { const w = host.clientWidth || 1, h = host.clientHeight || 1; renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null; if (ro) ro.observe(host); resize();
  let last = performance.now();
  function loop(now) {
    if (st.disposed) return; st.raf = requestAnimationFrame(loop); if (st.rendering) return; const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (st.walk && st.project) stepWalk(dt); else oc.update();
    if (box.visible) box.update();
    renderer.render(scene, cam);
    st.frameMs.push(dt * 1000); if (st.frameMs.length > 45) { const avg = st.frameMs.reduce((a, b) => a + b, 0) / st.frameMs.length; st.frameMs = []; st.onStatus({ avgMs: avg }); }
  }
  st.raf = requestAnimationFrame(loop);
  const onLost = (e) => { e.preventDefault(); st.onStatus({ contextLost: true }); }, onRestored = () => { st.onStatus({ contextLost: false }); rebuildStructure(); syncFurniture(); syncLights(); applyEnv(); };
  renderer.domElement.addEventListener("webglcontextlost", onLost); renderer.domElement.addEventListener("webglcontextrestored", onRestored);

  /* ----- presentation mode: progressive accumulation ----- */
  async function renderPresentation({ width, height, samples = q().progressiveSamples || 32, dof = null, vignette = 0, onProgress, preview }) {
    if (st.rendering) return null; const cancel = { v: false }; st.rendering = cancel;
    const prevSize = renderer.getSize(new THREE.Vector2()), prevPR = renderer.getPixelRatio(), prevAspect = cam.aspect, prevShadow = sun.shadow.mapSize.x;
    try {
      renderer.setPixelRatio(1); renderer.setSize(width, height, false); cam.aspect = width / height; cam.updateProjectionMatrix();
      const acc = document.createElement("canvas"); acc.width = width; acc.height = height; const ctx = acc.getContext("2d"), base = cam.position.clone(), tgt = oc.target.clone(), right = new THREE.Vector3(), up = new THREE.Vector3();
      cam.matrixWorld.extractBasis(right, up, new THREE.Vector3());
      const focus = dof ? Math.max(0.3, dof.focus) : 0, aperture = dof ? dof.aperture : 0;
      for (let i = 0; i < samples; i++) {
        if (cancel.v) return null;
        const jx = (halton(i + 1, 2) - 0.5), jy = (halton(i + 1, 3) - 0.5);
        cam.setViewOffset(width, height, jx, jy, width, height);
        if (aperture > 0) { const a = halton(i + 1, 5) * Math.PI * 2, r = Math.sqrt(halton(i + 1, 7)) * aperture; cam.position.copy(base).addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r); const dir = tgt.clone().sub(base).normalize(); cam.lookAt(base.clone().addScaledVector(dir, focus)); }
        renderer.render(scene, cam); ctx.globalAlpha = 1 / (i + 1); ctx.drawImage(renderer.domElement, 0, 0);
        if (onProgress && (i % 2 === 1 || i === samples - 1)) { onProgress((i + 1) / samples); if (preview) preview(acc); await new Promise((r) => setTimeout(r, 0)); }
      }
      ctx.globalAlpha = 1;
      if (vignette > 0) { const g = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.35, width / 2, height / 2, Math.hypot(width, height) / 2); g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, `rgba(0,0,0,${Math.min(0.6, vignette)})`); ctx.fillStyle = g; ctx.fillRect(0, 0, width, height); }
      return acc;
    } finally {
      cam.clearViewOffset(); cam.position.copy(oc.object.position); renderer.setPixelRatio(prevPR); renderer.setSize(prevSize.x, prevSize.y, false); cam.aspect = prevAspect; cam.updateProjectionMatrix(); oc.update(); st.rendering = null;
    }
  }
  const halton = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };

  const api = {
    hasWebGL: true, renderer, scene, camera: cam, controls: oc, state: st,
    setProject(project, extra = {}) { const prevDesign = st.project && st.project.design, prevStudio = st.project && st.project.studio; st.project = project; Object.assign(st, extra); const D = project.design, S = project.studio;
      const structDirty = !prevDesign || ["walls", "rooms", "openings", "ext", "levels", "wallH"].some((k) => prevDesign[k] !== D[k]) || (prevStudio && (prevStudio.surfaces !== S.surfaces || prevStudio.hideLandscape !== S.hideLandscape));
      if (structDirty || st.forceRebuild) { st.forceRebuild = false; rebuildStructure(); } if (!prevDesign || prevDesign.items !== D.items || (prevStudio && prevStudio.surfaces !== S.surfaces)) syncFurniture(); syncLights(); if (!prevStudio || prevStudio.env !== S.env || structDirty) applyEnv(); },
    setQuality(key) { st.quality = QUALITY[key] ? key : "balanced"; renderer.setPixelRatio(capPixelRatio(window.devicePixelRatio || 1, st.quality)); renderer.shadowMap.type = q().shadows === "soft" ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap; renderer.shadowMap.needsUpdate = true; resize(); if (st.project) { syncLights(); applyEnv(); } },
    setLevel(lv, showAll = false) { st.level = lv; st.showAll = showAll; st.forceRebuild = true; if (st.project) api.setProject(st.project); },
    setView(v) { st.view = v; st.forceRebuild = true; if (st.project) api.setProject(st.project); },
    setTool(t) { st.tool = t; updateSelection(); }, setSnap(mm) { st.snap = mm; tc.setTranslationSnap(mm ? mm * MM : null); tc.setRotationSnap(mm ? Math.PI / 12 : null); },
    setSelection(list) { st.selection = list || []; updateSelection(); },
    focusSelection() { const g = st.selection[0] && groupOf(st.selection[0]); if (!g) return; st.lastCam = api.getCamera(); const b = new THREE.Box3().setFromObject(g), c = b.getCenter(new THREE.Vector3()), r = Math.max(b.getSize(new THREE.Vector3()).length(), 0.8); oc.target.copy(c); cam.position.copy(c).add(new THREE.Vector3(r * 1.1, r * 0.7, r * 1.3)); oc.update(); },
    restoreCamera() { if (st.lastCam) api.setCamera(st.lastCam); },
    getCamera() { return { pos: cam.position.toArray(), target: oc.target.toArray(), fov: cam.fov }; },
    setCamera(c) { const s = sanitizeCamera(c); cam.position.fromArray(s.pos); oc.target.fromArray(s.target); cam.fov = s.fov; cam.updateProjectionMatrix(); oc.update(); },
    setExposure(e) { renderer.toneMappingExposure = e; }, setFov(f) { cam.fov = Math.max(20, Math.min(100, f)); cam.updateProjectionMatrix(); },
    setWalk, walkLook, setMove(fw, s, run) { st.input = [fw, s, !!run]; }, setWalkSettings(s) { st.walkSet = { ...st.walkSet, ...s }; if (st.walk) { cam.fov = st.walkSet.fov; cam.updateProjectionMatrix(); } },
    walkPosition() { return st.walkPos ? { x: st.walkPos[0], z: st.walkPos[1], lv: st.walkLv, yaw: st.look.yaw } : null },
    renderPresentation, cancelRender() { if (st.rendering) st.rendering.v = true; }, isRendering: () => !!st.rendering,
    snapshot(width, height) { const pr = renderer.getPixelRatio(), s = renderer.getSize(new THREE.Vector2()), a = cam.aspect; renderer.setPixelRatio(1); renderer.setSize(width, height, false); cam.aspect = width / height; cam.updateProjectionMatrix(); renderer.render(scene, cam); const url = renderer.domElement.toDataURL("image/png"); renderer.setPixelRatio(pr); renderer.setSize(s.x, s.y, false); cam.aspect = a; cam.updateProjectionMatrix(); return url; },
    exportGLB() { return new Promise((res, rej) => { const g = new THREE.Group(); [struct, ext, furn, detailG].filter(Boolean).forEach((o) => g.add(o.clone ? o.clone(true) : o)); new GLTFExporter().parse(g, (buf) => res(buf), (e) => rej(e), { binary: true, onlyVisible: true }); }); },
    stats() { const i = renderer.info; return { calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures, cachedAssets: assets.size() }; },
    resize,
    dispose() {
      st.disposed = true; cancelAnimationFrame(st.raf); if (ro) ro.disconnect(); api.cancelRender();
      renderer.domElement.removeEventListener("pointerdown", onDown); renderer.domElement.removeEventListener("pointerup", onUp); renderer.domElement.removeEventListener("webglcontextlost", onLost); renderer.domElement.removeEventListener("webglcontextrestored", onRestored);
      tc.detach(); tc.dispose(); oc.dispose();
      [struct, ext, furn, lightsG, detailG].forEach((o) => o && disposeTree(o)); st.lightObjs.forEach((o) => o.dispose && o.dispose()); assets.clear(); texCache.forEach((t) => t.dispose()); texCache.clear();
      if (envRT) envRT.dispose(); ground.geometry.dispose(); ground.material.dispose(); box.geometry.dispose(); box.material.dispose();
      renderer.dispose(); if (renderer.forceContextLoss) renderer.forceContextLoss(); if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
    },
  };
  return api;
}
