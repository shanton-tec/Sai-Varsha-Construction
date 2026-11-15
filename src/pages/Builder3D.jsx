"use client";
/**
 * Builder3D.jsx — Coohom-style house builder in one file (React + three.js, no CSS framework).
 *
 *   npm i three
 *   import Builder3D from "./Builder3D";   <Builder3D />     (fills 100vh; style={{height:700}} to override)
 *
 * Three workspaces (switch in the top bar):
 *   Floor plan  – draw rooms (rectangles), walls, doors and windows on a snapping 2D plan, move/resize everything,
 *                 drop furniture, see room names, areas and dimensions.
 *   Interior    – 3D walk-around of every room with the furniture gizmo, material editor, replace model, etc.
 *   Exterior    – the same plan extruded into a house: storeys, roof style, colours, fence, lawn, trees, driveway.
 * Every room type has a "Furnish room" preset.
 *
 * Upgrade notes (what was added on top of the original builder):
 *   Plan     – dimension labels on every wall, overall dimensions, measurement units (mm/cm/m/ft/in), configurable grid
 *              snapping, alignment guides (to walls, rooms, furniture and the floor below), edge resize handles, per-wall
 *              and per-room thickness, numeric wall/edge lengths, door/window offsets + swing/hinge/style, copy/cut/paste/
 *              duplicate, arrow-key nudging, item rotation handle.
 *   3D       – adjustable storey height + per-wall height, stair openings cut in upper slabs, real pitched roofs (gable, hip,
 *              shed) with pitch/overhang/ridge/material, roofs follow the top-floor footprint, terrace slabs, door & window
 *              frames with styles, skirting, ceilings in walk mode, click-to-select walls/doors/windows/floors/furniture,
 *              hover highlight, scale gizmo, snapping, align tools.
 *   Render   – procedural PBR-style wall/floor/roof/wood/concrete textures, physically based glass, sky + sun model with a
 *              24-hour day/night cycle, lit windows and interior lights at night, exposure + quality controls.
 *   Walk     – wall collision, stairs climbing between floors, ceilings, minimap and an automatic room tour.
 *   Estimate – structured bill of quantities (structure / envelope / finishes / site / furniture), editable unit rates,
 *              contingency, overhead and tax, currency choice, richer CSV export.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import {
  WALK_DEFAULTS, BASE_LOOK, sanitizeWalk, loadWalk, saveWalk, applyLook, lookDir, lookFromDir, moveVector, stepVelocity, bobOffset,
  furnitureSolids, resolveMove, recoverPosition, isBlocked, groundHeight, spiralParams, STRAIGHT_RISERS,
} from "../walkPhysics.js";

/* ================================================================== */
/* Constants                                                           */
/* ================================================================== */
const MM = 0.001;
const WALL_H = 2800;
export const STORE_KEY = "builder3d.design.v2";
const uid = (p = "i") => p + Math.random().toString(36).slice(2, 9);
const norm = (d) => ((d % 360) + 360) % 360;
const sn = (v, g = 100) => Math.round(v / g) * g;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const svgDataUri = (svg) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);

/* Measurement units. Geometry is always stored in millimetres; the unit only changes how lengths are shown and typed. */
export const UNITS = { mm: { f: 1, dp: 0, label: "mm" }, cm: { f: 10, dp: 1, label: "cm" }, m: { f: 1000, dp: 2, label: "m" }, ft: { f: 304.8, dp: 2, label: "ft" }, in: { f: 25.4, dp: 1, label: "in" } };
export const fmtLen = (mm, unit = "mm") => {
  const v = Number(mm) || 0;
  if (unit === "ft") {
    const total = Math.round(Math.abs(v) / 25.4), ft = Math.floor(total / 12), inch = total % 12;
    return (v < 0 ? "-" : "") + ft + "\u2032 " + inch + "\u2033";
  }
  if (unit === "in") return (v / 25.4).toFixed(1) + "\u2033";
  if (unit === "m") return (v / 1000).toFixed(2) + " m";
  if (unit === "cm") return String(Number((v / 10).toFixed(1))) + " cm";
  return Math.round(v) + " mm";
};
export const fmtArea = (m2, unit = "mm", dp = 1) => ((unit === "ft" || unit === "in") ? (m2 * 10.7639).toFixed(dp) + " ft\u00b2" : m2.toFixed(dp) + " m\u00b2");
const UnitCtx = createContext("mm");
const SWATCHES = ["#e7e7e5", "#d9cfc0", "#a8978a", "#8b5e48", "#6a4636", "#7d7f84", "#3b3f46", "#2f4f6f", "#5f7f62", "#b4553f"];
const EXT_WALL = ["#e8e2d6", "#f4f4f2", "#d9c7a8", "#b9c4b0", "#a7b5c4", "#c98f77", "#8e8a85", "#3f4650"];
const EXT_ROOF = ["#8a4b3c", "#4a4f57", "#6b5a4a", "#9aa0a6", "#2f4f3a", "#b4553f"];
const EXT_FINISHES = [["stucco", "Stucco"], ["brick", "Brick"], ["stone", "Stone"], ["siding", "Siding"], ["concrete", "Concrete"], ["timber", "Timber"]];
const EXT_FINISH_PRICE = { stucco: 28, brick: 70, stone: 120, siding: 55, concrete: 60, timber: 85 }; // per m2 of external wall
const INT_FINISHES = [["paint", "Paint"], ["plaster", "Plaster"], ["concrete", "Concrete"], ["brick", "Brick"], ["wood", "Wood panel"]];
const ROOF_MATS = [["tile", "Clay tile"], ["shingle", "Shingle"], ["metal", "Standing seam"], ["concrete", "Concrete"]];
const ROOF_STYLES = [["gable", "Gable"], ["hip", "Hip"], ["flat", "Flat"], ["shed", "Shed"]];
const ROOF_RATE = { flat: 85, gable: 70, hip: 78, shed: 66 }; // per m2 of roof surface
const ROOF_MAT_MULT = { tile: 1.15, shingle: 0.9, metal: 1.1, concrete: 1 };
const FRAMES = [["pvc", "White PVC"], ["alu", "Aluminium"], ["timber", "Timber"]];
const DOOR_STYLES = [["panel", "Panelled"], ["flush", "Flush"], ["glass", "Glazed"], ["double", "Double"], ["sliding", "Sliding glass"]];
const WINDOW_STYLES = [["casement", "Casement"], ["fixed", "Fixed"], ["sliding", "Sliding"]];
const CURRENCIES = ["$", "€", "£", "₹", "¥", "AED", "R"];
const DEFAULT_COST = { cur: "$", cont: 5, over: 8, tax: 0, rates: {} };

const ROOM_TYPES = {
  bedroom: { label: "Bedroom", fill: "#e6edfb", floor: "wood" },
  nursery: { label: "Nursery", fill: "#f7eaf0", floor: "wood" },
  stairwell: { label: "Stairwell", fill: "#e7e8e9", floor: "wood" },
  parking: { label: "Parking / garage", fill: "#dbe0e5", floor: "concrete" },
  living: { label: "Living room", fill: "#e6f4e6", floor: "wood" },
  media: { label: "Media room", fill: "#e7e9f2", floor: "wood" },
  dining: { label: "Dining room", fill: "#fcefd8", floor: "wood" },
  kitchen: { label: "Kitchen", fill: "#fce6de", floor: "tile" },
  bathroom: { label: "Bathroom", fill: "#dff1f6", floor: "tile" },
  laundry: { label: "Laundry room", fill: "#e5f0f1", floor: "tile" },
  prayer: { label: "Prayer room", fill: "#f6efd9", floor: "marble" },
  study: { label: "Study", fill: "#eee7f7", floor: "wood" },
  balcony: { label: "Balcony", fill: "#edf1de", floor: "concrete" },
  hall: { label: "Hall", fill: "#f0f0f0", floor: "marble" },
  void: { label: "Stairwell / void", fill: "#ffffff", floor: "none" },
};
const FLOOR_SIZE = { wood: 1200, tile: 1200, marble: 2000, concrete: 2000, parquet: 1200, carpet: 2000, stone: 1600 };
// Placeholder rates for the cost estimate. Change the currency and prices to match your market.
const CURRENCY = "$"; // default; the Cost tab lets you change it per project
const PRICES = { wardrobe: 650, bed: 700, singleBed: 450, bunkBed: 850, crib: 420, dresser: 420, shoeRack: 160, bench: 180, coatRack: 75, sofa: 800, armchair: 340, ottoman: 120, tvunit: 280, rug: 150, coffee: 140, sidetable: 70, dining: 450, chair: 60, barStool: 80, kitchen: 2400, island: 950, wallcab: 900, fridge: 850, oven: 480, microwave: 140, kitchenSink: 180, washer: 520, hamper: 45, puja: 480, bath: 550, wc: 220, vanity: 380, shower: 300, desk: 260, shelf: 180, plant: 40, planter: 55, vase: 25, lamp: 90, tableLamp: 45, ceilingLight: 70, ceilingFan: 180, mirror: 90, wallArt: 80, curtains: 120, outdoorTable: 240, patioChair: 85, grill: 180, mailbox: 60, stairs: 1800 };
const FLOOR_PRICE = { wood: 55, tile: 40, marble: 120, concrete: 30, parquet: 85, carpet: 35, stone: 95 }; // per m2
const PAINT_PRICE = 6, DOOR_PRICE = 250, WINDOW_PRICE = 220, ROOF_PRICE = 70, STOREY_PRICE = 650; // per m2 except doors
// Structural / site rates used by the bill of quantities (editable per project in the Cost tab).
const BOQ = { excavation: 18, footing: 95, groundSlab: 150, upperSlab: 120, wallExt: 310, wallInt: 290, ceiling: 14, skirting: 8, electrical: 48, plumbing: 1900, fence: 95, lawn: 6, driveway: 48, tree: 220, porch: 2400, entranceLight: 85, solar: 420, parkingBay: 55 };
const download = (href, name) => { const a = document.createElement("a"); a.href = href; a.download = name; a.click(); };
const CATEGORIES = [["popular", "Popular"], ["bedroom", "Bedroom"], ["nursery", "Nursery"], ["living", "Living room"], ["media", "Media room"], ["dining", "Dining room"], ["kitchen", "Kitchen"], ["bathroom", "Bathroom"], ["laundry", "Laundry"], ["prayer", "Prayer room"], ["study", "Study"], ["stairs", "Stairs"], ["parking", "Parking"], ["decor", "Decor"], ["outdoor", "Outdoor"], ["fav", "Favourites"]];

/* ================================================================== */
/* Furniture catalog (procedural models)                               */
/* ================================================================== */
const V = (label, main, second = main, n) => ({ label, main, second, n });
export const CATALOG = [
  { type: "wardrobe", name: "Wardrobe", rooms: ["bedroom"], size: [2038, 600, 2470], variants: [V("Graphite", "#b4b6ba", "#7d7f84", 4), V("Oak cream", "#efe9de", "#d9cfc0", 2), V("Walnut", "#8b5e48", "#6a4636", 3), V("Matte white", "#f7f7f6", "#e1e1df", 2)] },
  { type: "dresser", name: "Chest of drawers", rooms: ["bedroom", "nursery"], size: [1200, 500, 900], variants: [V("Oak", "#c9a56b", "#8b6b3f"), V("White", "#f1f1ef", "#d6d6d4"), V("Walnut", "#6a4636", "#2b2d31")] },
  { type: "shoeRack", name: "Shoe rack", rooms: ["hall", "decor"], size: [900, 350, 900], variants: [V("Oak", "#c9a56b", "#8b6b3f"), V("White", "#f1f1ef", "#d6d6d4")] },
  { type: "bench", name: "Entry bench", rooms: ["hall", "bedroom"], size: [1200, 450, 480], variants: [V("Oak", "#c9a56b", "#8b6b3f"), V("Walnut", "#6a4636", "#2b2d31")] },
  { type: "coatRack", name: "Coat rack", rooms: ["hall", "decor"], size: [450, 450, 1750], variants: [V("Oak", "#c9a56b", "#8b6b3f"), V("Black", "#2b2d31", "#7d7f84")] },
  { type: "bed", name: "Double bed", rooms: ["bedroom"], size: [1800, 2000, 1100], variants: [V("Taupe", "#a8978a", "#d8cfc5"), V("Sage", "#9fb59f", "#e8e4da"), V("Navy", "#3f5675", "#d9dde3"), V("Linen", "#e4dccf", "#b9a58e")] },
  { type: "singleBed", name: "Single bed", rooms: ["bedroom", "nursery"], size: [1000, 2000, 900], variants: [V("Oak linen", "#c9a56b", "#e4dccf"), V("Sage", "#9fb59f", "#e8e4da")] },
  { type: "bunkBed", name: "Bunk bed", rooms: ["bedroom", "nursery"], size: [1000, 2100, 1800], variants: [V("Natural oak", "#c9a56b", "#f1eee9"), V("White", "#f1f1ef", "#b9bfc6")] },
  { type: "crib", name: "Baby cot", rooms: ["nursery"], size: [1400, 800, 1100], variants: [V("Natural oak", "#c9a56b", "#f1eee9"), V("White", "#f1f1ef", "#d9cfc0"), V("Sage", "#8fa690", "#e9e7e1")] },
  { type: "sofa", name: "Sofa", rooms: ["living", "media"], size: [2000, 900, 800], variants: [V("Stone", "#b7aca0", "#cfc6bb"), V("Moss", "#6f8266", "#8da283"), V("Ink", "#3b3f46", "#555a63"), V("Blush", "#c79a94", "#dcb7b1")] },
  { type: "armchair", name: "Armchair", rooms: ["living", "media", "bedroom"], size: [900, 900, 900], variants: [V("Stone", "#b7aca0", "#cfc6bb"), V("Moss", "#6f8266", "#8da283"), V("Rust", "#b4553f", "#d28f7d")] },
  { type: "ottoman", name: "Ottoman", rooms: ["living", "bedroom"], size: [700, 700, 450], variants: [V("Stone", "#b7aca0"), V("Moss", "#6f8266"), V("Rust", "#b4553f")] },
  { type: "tvunit", name: "TV unit", rooms: ["living", "bedroom", "media"], size: [1800, 400, 1300], variants: [V("Oak", "#c9a56b"), V("White", "#f1f1ef"), V("Walnut", "#6a4636")] },
  { type: "rug", name: "Area rug", rooms: ["bedroom", "living"], size: [2000, 1400, 20], variants: [V("Sand", "#cdbfae"), V("Grey", "#9a9a9a"), V("Rust", "#b4553f"), V("Ivory", "#efe9de")] },
  { type: "coffee", name: "Coffee table", rooms: ["living"], size: [1000, 600, 400], variants: [V("Oak", "#c9a56b", "#2b2d31"), V("Walnut", "#6a4636", "#2b2d31"), V("White", "#f1f1ef", "#b4b6ba")] },
  { type: "sidetable", name: "Side table", rooms: ["bedroom", "living"], size: [500, 500, 550], variants: [V("Oak", "#c9a56b"), V("White", "#f1f1ef"), V("Walnut", "#6a4636")] },
  { type: "dining", name: "Dining table", rooms: ["dining"], size: [1600, 900, 750], variants: [V("Oak", "#c9a56b", "#8b6b3f"), V("Walnut", "#6a4636", "#2b2d31"), V("White", "#f1f1ef", "#b4b6ba")] },
  { type: "chair", name: "Chair", rooms: ["dining", "study"], size: [500, 520, 900], variants: [V("Oak", "#c9a56b"), V("Black", "#2b2d31"), V("Olive", "#7d8a52")] },
  { type: "barStool", name: "Bar stool", rooms: ["kitchen", "dining"], size: [450, 450, 750], variants: [V("Oak", "#c9a56b", "#2b2d31"), V("Black", "#2b2d31", "#7d7f84")] },
  { type: "kitchen", name: "Kitchen run", rooms: ["kitchen"], size: [2400, 600, 900], variants: [V("Sage", "#8fa690", "#e9e7e1"), V("Navy", "#3f5675", "#e9e7e1"), V("White", "#f1f1ef", "#3b3f46"), V("Oak", "#c9a56b", "#d8d6d0")] },
  { type: "island", name: "Kitchen island", rooms: ["kitchen"], size: [1500, 800, 900], variants: [V("Oak", "#c9a56b", "#e9e7e1"), V("Sage", "#8fa690", "#e9e7e1")] },
  { type: "wallcab", name: "Wall cabinets", rooms: ["kitchen"], size: [2400, 350, 700], elev: 1400, variants: [V("Sage", "#8fa690"), V("Navy", "#3f5675"), V("White", "#f1f1ef"), V("Oak", "#c9a56b")] },
  { type: "fridge", name: "Fridge", rooms: ["kitchen"], size: [700, 700, 1800], variants: [V("Steel", "#c3c7cc"), V("White", "#f4f4f4"), V("Black", "#2b2d31")] },
  { type: "oven", name: "Freestanding oven", rooms: ["kitchen"], size: [600, 600, 900], variants: [V("Steel", "#c3c7cc", "#2b2d31"), V("Black", "#2b2d31", "#7d7f84")] },
  { type: "microwave", name: "Microwave", rooms: ["kitchen"], size: [500, 400, 300], elev: 1100, variants: [V("Steel", "#c3c7cc", "#2b2d31"), V("White", "#f1f1ef", "#7d7f84")] },
  { type: "kitchenSink", name: "Kitchen sink", rooms: ["kitchen"], size: [800, 550, 250], elev: 880, variants: [V("Stainless steel", "#b9bfc6", "#7d7f84"), V("Black", "#2b2d31", "#555a63")] },
  { type: "washer", name: "Washing machine", rooms: ["laundry"], size: [650, 650, 850], variants: [V("White", "#f1f1ef", "#b9bfc6"), V("Graphite", "#3b3f46", "#aeb4bb")] },
  { type: "hamper", name: "Laundry hamper", rooms: ["laundry", "bathroom"], size: [500, 500, 650], variants: [V("Woven", "#c9a56b", "#8b5e48"), V("White", "#f1f1ef", "#b9bfc6")] },
  { type: "puja", name: "Prayer altar", rooms: ["prayer"], size: [1000, 450, 1500], variants: [V("Teak", "#8b5e48", "#c9a56b"), V("Natural oak", "#c9a56b", "#f1eee9"), V("White", "#f1f1ef", "#c9a56b")] },
  { type: "bath", name: "Bathtub", rooms: ["bathroom"], size: [1700, 750, 550], variants: [V("White", "#f6f7f8")] },
  { type: "shower", name: "Shower enclosure", rooms: ["bathroom"], size: [900, 900, 2100], variants: [V("Chrome glass", "#b9bfc6", "#9fc6e0"), V("Black frame", "#2b2d31", "#9fc6e0")] },
  { type: "wc", name: "Toilet", rooms: ["bathroom"], size: [400, 650, 800], variants: [V("White", "#f6f7f8")] },
  { type: "vanity", name: "Vanity & basin", rooms: ["bathroom"], size: [800, 500, 900], variants: [V("Oak", "#f2f2f0", "#c9a56b"), V("Walnut", "#f2f2f0", "#6a4636"), V("Grey", "#f2f2f0", "#7d7f84")] },
  { type: "desk", name: "Desk", rooms: ["study", "bedroom"], size: [1400, 700, 750], variants: [V("Oak", "#c9a56b", "#e7e1d6"), V("White", "#f1f1ef", "#d6d6d4"), V("Walnut", "#6a4636", "#4a3228")] },
  { type: "shelf", name: "Bookshelf", rooms: ["study", "living"], size: [800, 300, 1900], variants: [V("Oak", "#c9a56b", "#8b6b3f"), V("White", "#f1f1ef", "#d6d6d4"), V("Black", "#3b3f46", "#2b2d31")] },
  { type: "stairs", name: "Straight stairs", rooms: ["living", "stairwell", "stairs", "decor"], size: [1200, 4200, 2800], variants: [V("Oak", "#c9a56b", "#3b3f46"), V("White", "#f1f1ef", "#b4b6ba"), V("Walnut", "#6a4636", "#2b2d31")] },
  { type: "plant", name: "Potted plant", rooms: ["decor"], size: [400, 400, 1200], variants: [V("Fern", "#5f8f5f", "#c9c2b8"), V("Olive", "#7d8a52", "#8b5e48"), V("Deep green", "#3d6b4f", "#2f3338")] },
  { type: "planter", name: "Long planter", rooms: ["decor", "outdoor"], size: [900, 350, 650], variants: [V("Terracotta", "#b4553f", "#5f8f5f"), V("Stone", "#a7a7a0", "#6f9f62")] },
  { type: "vase", name: "Decorative vase", rooms: ["decor"], size: [300, 300, 500], variants: [V("Ceramic blue", "#3f5675"), V("Terracotta", "#b4553f"), V("Ivory", "#efe9de")] },
  { type: "lamp", name: "Floor lamp", rooms: ["decor", "living"], size: [350, 350, 1600], variants: [V("Warm", "#f6e7c8"), V("White", "#f6f6f6"), V("Rattan", "#c9a56b")] },
  { type: "tableLamp", name: "Table lamp", rooms: ["decor", "bedroom", "living"], size: [300, 300, 500], variants: [V("Warm brass", "#c9a56b", "#fff0c9"), V("Black", "#2b2d31", "#fff0c9")] },
  { type: "ceilingLight", name: "Pendant light", rooms: ["decor", "living", "dining"], size: [400, 400, 300], elev: 2450, variants: [V("Brass", "#c9a56b", "#fff0c9"), V("Black", "#2b2d31", "#fff0c9"), V("White", "#f1f1ef", "#fff5d8")] },
  { type: "ceilingFan", name: "Ceiling fan", rooms: ["decor", "bedroom", "living"], size: [1200, 1200, 350], elev: 2350, variants: [V("White", "#f1f1ef", "#b9bfc6"), V("Walnut", "#6a4636", "#b9bfc6")] },
  { type: "mirror", name: "Wall mirror", rooms: ["decor", "bedroom", "bathroom"], size: [700, 80, 1100], elev: 1000, variants: [V("Brass frame", "#c9a56b", "#a8c7d6"), V("Black frame", "#2b2d31", "#a8c7d6")] },
  { type: "wallArt", name: "Framed wall art", rooms: ["decor", "living", "bedroom"], size: [900, 80, 650], elev: 1500, variants: [V("Botanical", "#8fa690", "#d9cfc0"), V("Abstract", "#b4553f", "#d9cfc0"), V("Coastal", "#3f5675", "#d9cfc0")] },
  { type: "curtains", name: "Window curtains", rooms: ["decor", "bedroom", "living"], size: [1600, 100, 2000], elev: 800, variants: [V("Linen", "#e4dccf", "#c9a56b"), V("Sage", "#9fb59f", "#c9a56b"), V("Navy", "#3f5675", "#c9a56b")] },
  { type: "car", name: "Parked car", rooms: ["parking", "outdoor"], size: [4300, 1900, 1500], variants: [V("Deep blue", "#315b78", "#9bbbc8"), V("Silver", "#aeb4bb", "#73909e"), V("Forest green", "#49634d", "#9bbbc8")] },
  { type: "outdoorTable", name: "Patio table set", rooms: ["outdoor"], size: [1600, 1600, 750], variants: [V("Teak", "#8b5e48", "#3b3f46"), V("White", "#f1f1ef", "#3b3f46")] },
  { type: "patioChair", name: "Patio chair", rooms: ["outdoor", "balcony"], size: [600, 650, 900], variants: [V("Teak", "#8b5e48", "#3b3f46"), V("White", "#f1f1ef", "#3b3f46")] },
  { type: "grill", name: "Outdoor grill", rooms: ["outdoor"], size: [900, 550, 1100], variants: [V("Steel", "#7d7f84", "#2b2d31"), V("Black", "#2b2d31", "#7d7f84")] },
  { type: "mailbox", name: "Mailbox", rooms: ["outdoor"], size: [350, 350, 1200], variants: [V("Black", "#2b2d31", "#c9a56b"), V("Green", "#49634d", "#c9a56b")] },
];
export const CAT = Object.fromEntries(CATALOG.map((c) => [c.type, c]));

const BOX = new RoundedBoxGeometry(1, 1, 1, 3, 0.012);
const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 28);
const SPH = new THREE.SphereGeometry(0.5, 22, 16);
const DARK = "#2b2d31";

function P(g, kind, pos, size, color, role, o = {}) {
  const geo = kind === "box" ? BOX : kind === "cyl" ? CYL : SPH;
  const m = new THREE.MeshStandardMaterial({ color, roughness: o.r ?? 0.7, metalness: o.m ?? 0 });
  if (o.e) { m.emissive = new THREE.Color(o.e); m.emissiveIntensity = 0.7; }
  m.userData.role = role || null;
  const mesh = new THREE.Mesh(geo, m);
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.scale.set(size[0], size[1], size[2]);
  mesh.castShadow = mesh.receiveShadow = true;
  g.add(mesh);
  return mesh;
}

const BUILD = {
  wardrobe(g, v) {
    const n = v.n;
    P(g, "box", [0, 0.5, 0], [1, 1, 1], v.second, "second");
    for (let i = 0; i < n; i++) {
      const x = -0.5 + (i + 0.5) / n;
      P(g, "box", [x, 0.5, 0.503], [1 / n - 0.008, 0.97, 0.01], v.main, "main", { r: 0.55 });
      const hx = x + (i % 2 === 0 ? 1 : -1) * (0.5 / n - 0.03);
      P(g, "box", [hx, 0.5, 0.512], [0.006, 0.14, 0.012], DARK, null, { m: 0.6, r: 0.3 });
    }
  },
  dresser(g, v) {
    P(g, "box", [0, 0.46, 0], [1, 0.92, 1], v.main, "main");
    for (let row = 0; row < 3; row++) {
      const y = 0.18 + row * 0.29;
      P(g, "box", [0, y, 0.51], [0.94, 0.25, 0.025], v.second, "second");
      P(g, "cyl", [0, y, 0.54], [0.06, 0.06, 0.025], "#b9bfc6", null, { m: 0.7 });
    }
  },
  shoeRack(g, v) {
    P(g, "box", [0, 0.04, 0], [1, 0.08, 1], v.main, "main");
    P(g, "box", [0, 0.96, 0], [1, 0.08, 1], v.main, "main");
    [-0.48, 0.48].forEach((x) => P(g, "box", [x, 0.5, 0], [0.05, 0.92, 1], v.main, "main"));
    [0.34, 0.66].forEach((y) => P(g, "box", [0, y, 0], [0.95, 0.04, 0.96], v.second, "second"));
  },
  bench(g, v) {
    P(g, "box", [0, 0.76, 0], [1, 0.16, 1], v.main, "main");
    [-0.4, 0.4].forEach((x) => [-0.38, 0.38].forEach((z) => P(g, "box", [x, 0.38, z], [0.08, 0.72, 0.08], v.second, "second")));
  },
  coatRack(g, v) {
    P(g, "cyl", [0, 0.5, 0], [0.08, 1, 0.08], v.main, "main");
    P(g, "cyl", [0, 0.04, 0], [0.5, 0.08, 0.5], v.second, "second");
    for (let i = 0; i < 6; i++) {
      const angle = (i * Math.PI) / 3, x = Math.cos(angle) * 0.3, z = Math.sin(angle) * 0.3;
      P(g, "cyl", [x * 0.65, 0.78, z * 0.65], [0.04, 0.42, 0.04], v.second, "second");
      P(g, "cyl", [x, 0.99, z], [0.13, 0.05, 0.05], v.second, "second");
    }
  },
  bed(g, v) {
    P(g, "box", [0, 0.15, 0], [1, 0.3, 1], "#5d4d40");
    P(g, "box", [0, 0.4, 0.02], [0.96, 0.2, 0.94], "#f1eee9", null, { r: 0.9 });
    P(g, "box", [0, 0.55, -0.49], [1.04, 0.9, 0.05], v.main, "main", { r: 0.9 });
    P(g, "box", [-0.24, 0.54, -0.36], [0.4, 0.08, 0.16], "#fbfaf8", null, { r: 0.95 });
    P(g, "box", [0.24, 0.54, -0.36], [0.4, 0.08, 0.16], "#fbfaf8", null, { r: 0.95 });
    P(g, "box", [0, 0.5, 0.17], [0.98, 0.06, 0.62], v.second, "second", { r: 0.95 });
  },
  singleBed(g, v) {
    P(g, "box", [0, 0.13, 0], [1, 0.26, 1], v.second, "second");
    P(g, "box", [0, 0.34, 0.02], [0.96, 0.14, 0.94], "#f1eee9", null, { r: 0.95 });
    P(g, "box", [0, 0.52, -0.47], [1.02, 0.68, 0.06], v.main, "main");
    P(g, "box", [0, 0.45, 0.2], [0.95, 0.06, 0.5], v.main, "main", { r: 0.95 });
    P(g, "box", [0, 0.42, -0.34], [0.55, 0.07, 0.2], "#fbfaf8", null, { r: 0.95 });
  },
  bunkBed(g, v) {
    [0.3, 0.82].forEach((y) => {
      P(g, "box", [0, y, 0], [1, 0.08, 1], v.main, "main");
      P(g, "box", [0, y + 0.08, 0], [0.94, 0.05, 0.94], "#f1eee9", null, { r: 0.95 });
    });
    [-0.47, 0.47].forEach((x) => P(g, "box", [x, 0.5, 0], [0.06, 1, 1], v.second, "second"));
    P(g, "box", [0, 0.94, -0.47], [1, 0.1, 0.06], v.main, "main");
    for (let i = 0; i < 6; i++) P(g, "box", [-0.42, 0.13 + i * 0.14, 0.25], [0.05, 0.12, 0.05], v.second, "second");
  },
  crib(g, v) {
    P(g, "box", [0, 0.22, 0], [1, 0.44, 1], v.second, "second", { r: 0.9 });
    P(g, "box", [0, 0.47, -0.48], [1, 0.5, 0.06], v.main, "main");
    P(g, "box", [0, 0.47, 0.48], [1, 0.5, 0.06], v.main, "main");
    [-0.48, 0.48].forEach((x) => {
      P(g, "box", [x, 0.47, 0], [0.06, 0.5, 1], v.main, "main");
      for (let z = -0.35; z <= 0.36; z += 0.18) P(g, "box", [x, 0.48, z], [0.04, 0.46, 0.04], v.second, "second");
    });
  },
  sofa(g, v) {
    P(g, "box", [0, 0.28, 0], [1, 0.3, 1], v.main, "main", { r: 0.9 });
    P(g, "box", [0, 0.68, -0.4], [1, 0.56, 0.2], v.main, "main", { r: 0.9 });
    P(g, "box", [-0.455, 0.45, 0], [0.09, 0.6, 1], v.main, "main", { r: 0.9 });
    P(g, "box", [0.455, 0.45, 0], [0.09, 0.6, 1], v.main, "main", { r: 0.9 });
    [-0.23, 0.23].forEach((x) => {
      P(g, "box", [x, 0.5, 0.08], [0.43, 0.14, 0.76], v.second, "second", { r: 0.95 });
      P(g, "box", [x, 0.7, -0.22], [0.43, 0.34, 0.14], v.second, "second", { r: 0.95 });
    });
    [[-0.45, -0.42], [0.45, -0.42], [-0.45, 0.42], [0.45, 0.42]].forEach(([x, z]) => P(g, "cyl", [x, 0.06, z], [0.04, 0.12, 0.04], DARK));
  },
  armchair(g, v) {
    P(g, "box", [0, 0.3, 0], [0.9, 0.3, 0.9], v.main, "main", { r: 0.9 });
    P(g, "box", [0, 0.68, -0.38], [0.9, 0.55, 0.16], v.main, "main", { r: 0.9 });
    [-0.42, 0.42].forEach((x) => {
      P(g, "box", [x, 0.48, 0], [0.12, 0.48, 0.88], v.second, "second", { r: 0.9 });
      [-0.36, 0.36].forEach((z) => P(g, "cyl", [x * 0.88, 0.06, z], [0.05, 0.12, 0.05], DARK));
    });
  },
  ottoman(g, v) {
    P(g, "box", [0, 0.42, 0], [1, 0.82, 1], v.main, "main", { r: 0.9 });
    P(g, "box", [0, 0.86, 0], [1.02, 0.12, 1.02], v.second, "second", { r: 0.9 });
  },
  tvunit(g, v) {
    P(g, "box", [0, 0.18, 0], [1, 0.36, 1], v.main, "main");
    P(g, "box", [0, 0.7, -0.3], [0.72, 0.42, 0.03], "#101114", null, { r: 0.2, m: 0.3 });
    P(g, "box", [0, 0.46, -0.3], [0.08, 0.1, 0.05], DARK);
  },
  rug(g, v) { P(g, "box", [0, 0.5, 0], [1, 1, 1], v.main, "main", { r: 1 }); },
  coffee(g, v) {
    P(g, "box", [0, 0.92, 0], [1, 0.16, 1], v.main, "main");
    [[-0.44, -0.4], [0.44, -0.4], [-0.44, 0.4], [0.44, 0.4]].forEach(([x, z]) => P(g, "box", [x, 0.42, z], [0.05, 0.84, 0.07], v.second, "second", { m: 0.4 }));
  },
  sidetable(g, v) {
    P(g, "cyl", [0, 0.94, 0], [1, 0.12, 1], v.main, "main");
    P(g, "cyl", [0, 0.45, 0], [0.1, 0.9, 0.1], DARK, null, { m: 0.5 });
    P(g, "cyl", [0, 0.02, 0], [0.6, 0.04, 0.6], DARK, null, { m: 0.5 });
  },
  dining(g, v) {
    P(g, "box", [0, 0.95, 0], [1, 0.1, 1], v.main, "main");
    [[-0.45, -0.42], [0.45, -0.42], [-0.45, 0.42], [0.45, 0.42]].forEach(([x, z]) => P(g, "box", [x, 0.45, z], [0.05, 0.9, 0.07], v.second, "second"));
  },
  chair(g, v) {
    [[-0.42, -0.42], [0.42, -0.42], [-0.42, 0.42], [0.42, 0.42]].forEach(([x, z]) => P(g, "box", [x, 0.23, z], [0.07, 0.46, 0.07], DARK));
    P(g, "box", [0, 0.5, 0], [1, 0.08, 1], v.main, "main");
    P(g, "box", [0, 0.76, -0.46], [1, 0.5, 0.08], v.main, "main");
  },
  barStool(g, v) {
    P(g, "cyl", [0, 0.82, 0], [0.78, 0.12, 0.78], v.main, "main");
    P(g, "cyl", [0, 0.42, 0], [0.1, 0.72, 0.1], v.second, "second");
    P(g, "cyl", [0, 0.05, 0], [0.68, 0.1, 0.68], v.second, "second");
    P(g, "cyl", [0, 0.38, 0], [0.55, 0.05, 0.55], DARK);
  },
  kitchen(g, v) {
    P(g, "box", [0, 0.05, -0.02], [0.98, 0.1, 0.9], DARK);
    P(g, "box", [0, 0.5, 0], [1, 0.8, 1], v.main, "main", { r: 0.55 });
    for (let i = 1; i < 6; i++) P(g, "box", [-0.5 + i / 6, 0.5, 0.501], [0.002, 0.78, 0.004], DARK);
    P(g, "box", [0, 0.95, 0.02], [1.005, 0.1, 1.04], v.second, "second", { r: 0.35 });
    P(g, "box", [-0.2, 1.003, 0], [0.22, 0.008, 0.55], "#17181b", null, { r: 0.2 });
    P(g, "box", [0.22, 1.003, 0], [0.16, 0.008, 0.6], "#a9aeb4", null, { r: 0.3, m: 0.7 });
  },
  island(g, v) {
    P(g, "box", [0, 0.48, 0], [0.94, 0.9, 0.94], v.main, "main");
    P(g, "box", [0, 0.96, 0], [1.06, 0.08, 1.06], v.second, "second", { r: 0.35 });
    P(g, "box", [0, 0.5, 0.49], [0.9, 0.7, 0.02], v.second, "second");
    [-0.25, 0.25].forEach((x) => P(g, "box", [x, 0.5, 0.51], [0.02, 0.58, 0.02], v.main, "main"));
  },
  oven(g, v) {
    P(g, "box", [0, 0.5, 0], [1, 1, 1], v.main, "main", { m: 0.25, r: 0.35 });
    P(g, "box", [0, 0.5, 0.51], [0.78, 0.48, 0.02], v.second, "second", { r: 0.25 });
    P(g, "box", [0, 0.83, 0.53], [0.82, 0.08, 0.04], DARK, null, { m: 0.45 });
    P(g, "box", [0, 0.92, 0.5], [0.8, 0.08, 0.04], "#b9bfc6", null, { m: 0.65 });
  },
  microwave(g, v) {
    P(g, "box", [0, 0.5, 0], [1, 1, 1], v.main, "main", { m: 0.25, r: 0.35 });
    P(g, "box", [-0.08, 0.5, 0.51], [0.72, 0.76, 0.025], v.second, "second", { r: 0.25 });
    P(g, "box", [0.38, 0.5, 0.53], [0.08, 0.58, 0.03], DARK);
  },
  kitchenSink(g, v) {
    P(g, "box", [0, 0.88, 0], [1, 0.12, 1], v.main, "main", { m: 0.7, r: 0.25 });
    P(g, "box", [0, 0.95, 0], [0.58, 0.015, 0.62], DARK, null, { r: 0.2, m: 0.5 });
    P(g, "cyl", [0, 0.82, -0.34], [0.045, 0.28, 0.045], v.second, "second", { m: 0.75 });
    P(g, "cyl", [0, 0.95, -0.22], [0.045, 0.045, 0.28], v.second, "second", { m: 0.75 });
  },
  wallcab(g, v) {
    P(g, "box", [0, 0.5, 0], [1, 1, 1], v.main, "main", { r: 0.55 });
    for (let i = 1; i < 6; i++) P(g, "box", [-0.5 + i / 6, 0.5, 0.501], [0.002, 0.96, 0.004], DARK);
  },
  fridge(g, v) {
    P(g, "box", [0, 0.5, 0], [1, 1, 1], v.main, "main", { m: 0.5, r: 0.35 });
    P(g, "box", [0, 0.64, 0.502], [0.98, 0.004, 0.004], DARK);
    P(g, "box", [0.4, 0.8, 0.51], [0.03, 0.14, 0.03], DARK, null, { m: 0.6 });
    P(g, "box", [0.4, 0.5, 0.51], [0.03, 0.1, 0.03], DARK, null, { m: 0.6 });
  },
  washer(g, v) {
    P(g, "box", [0, 0.5, 0], [1, 1, 1], v.main, "main", { r: 0.4, m: 0.15 });
    P(g, "box", [0, 0.88, 0.51], [0.9, 0.16, 0.02], v.second, "second", { r: 0.35 });
    P(g, "cyl", [0, 0.43, 0.51], [0.64, 0.64, 0.05], v.second, "second", { r: 0.25, m: 0.2 });
    P(g, "cyl", [0, 0.43, 0.545], [0.5, 0.5, 0.05], "#7d9aa3", null, { r: 0.2, m: 0.2 });
    [-0.3, 0, 0.3].forEach((x) => P(g, "cyl", [x, 0.88, 0.535], [0.06, 0.06, 0.03], DARK));
  },
  hamper(g, v) {
    P(g, "cyl", [0, 0.48, 0], [0.82, 0.9, 0.82], v.main, "main", { r: 0.9 });
    P(g, "cyl", [0, 0.94, 0], [0.9, 0.08, 0.9], v.second, "second");
    for (let y = 0.2; y < 0.85; y += 0.2) P(g, "cyl", [0, y, 0], [0.84, 0.025, 0.84], v.second, "second");
  },
  puja(g, v) {
    P(g, "box", [0, 0.36, 0], [1, 0.72, 1], v.main, "main");
    P(g, "box", [0, 0.76, 0.02], [1.06, 0.08, 1.04], v.second, "second");
    P(g, "box", [0, 0.43, 0.51], [0.94, 0.52, 0.03], v.main, "main");
    P(g, "box", [0, 0.94, -0.3], [0.9, 0.28, 0.06], v.second, "second");
    P(g, "cyl", [0, 1.14, -0.25], [0.24, 0.12, 0.24], "#e5a63b", null, { e: "#ffbb55", r: 0.35 });
    P(g, "cyl", [-0.34, 0.89, 0.02], [0.07, 0.18, 0.07], "#d2a24a", null, { m: 0.35 });
    P(g, "cyl", [0.34, 0.89, 0.02], [0.07, 0.18, 0.07], "#d2a24a", null, { m: 0.35 });
  },
  bath(g, v) {
    P(g, "box", [0, 0.5, 0], [1, 1, 1], v.main, "main", { r: 0.25 });
    P(g, "box", [0, 0.98, 0], [0.92, 0.1, 0.84], "#dbe3ea", null, { r: 0.2 });
    P(g, "cyl", [-0.44, 1.12, 0], [0.03, 0.2, 0.03], "#b9bfc6", null, { m: 0.8 });
  },
  shower(g, v) {
    const frame = "#9ba6ad";
    const glass = new THREE.MeshStandardMaterial({ color: v.second, transparent: true, opacity: 0.38, roughness: 0.12, metalness: 0.12, side: THREE.DoubleSide });
    const panel = (position, scale) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...scale), glass);
      mesh.position.set(...position);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      g.add(mesh);
    };
    P(g, "box", [0, 0.04, 0], [1, 0.08, 1], "#e7eaec", null, { r: 0.24 });
    panel([0, 0.53, -0.47], [0.96, 0.9, 0.018]);
    panel([-0.47, 0.53, 0], [0.018, 0.9, 0.96]);
    panel([-0.23, 0.53, 0.47], [0.48, 0.9, 0.018]);
    panel([0.25, 0.53, 0.47], [0.44, 0.9, 0.018]);
    [[-0.47, -0.47], [0.47, -0.47], [-0.47, 0.47], [0.47, 0.47]].forEach(([x, z]) => P(g, "box", [x, 0.53, z], [0.025, 0.98, 0.025], frame, null, { m: 0.58, r: 0.32 }));
    P(g, "box", [0, 1.01, 0.47], [0.98, 0.025, 0.025], frame, null, { m: 0.58, r: 0.32 });
    P(g, "cyl", [0.39, 0.54, 0.49], [0.025, 0.15, 0.025], frame, null, { m: 0.65, r: 0.3 });
    P(g, "cyl", [0.31, 0.92, -0.34], [0.08, 0.08, 0.08], frame, null, { m: 0.72, r: 0.28 });
  },
  wc(g, v) {
    P(g, "box", [0, 0.68, -0.38], [0.95, 0.64, 0.24], v.main, "main", { r: 0.25 });
    P(g, "sph", [0, 0.28, 0.1], [0.95, 0.55, 0.8], v.main, "main", { r: 0.25 });
    P(g, "cyl", [0, 0.55, 0.1], [0.8, 0.04, 0.68], "#e9edf0", null, { r: 0.3 });
  },
  vanity(g, v) {
    P(g, "box", [0, 0.4, 0], [1, 0.78, 1], v.second, "second");
    P(g, "box", [0, 0.82, 0], [1.02, 0.06, 1.02], v.main, "main", { r: 0.3 });
    P(g, "cyl", [0, 0.86, 0.05], [0.5, 0.03, 0.5], "#ffffff", null, { r: 0.2 });
    P(g, "cyl", [0, 0.94, -0.36], [0.03, 0.12, 0.03], "#b9bfc6", null, { m: 0.8 });
  },
  desk(g, v) {
    P(g, "box", [0, 0.96, 0], [1, 0.06, 1], v.main, "main");
    P(g, "box", [-0.48, 0.45, 0], [0.04, 0.9, 0.9], v.second, "second");
    P(g, "box", [0.48, 0.45, 0], [0.04, 0.9, 0.9], v.second, "second");
    P(g, "box", [0, 0.68, -0.45], [0.92, 0.4, 0.02], v.second, "second");
  },
  shelf(g, v) {
    P(g, "box", [0, 0.5, -0.49], [0.98, 1, 0.02], v.second, "second");
    [-0.49, 0.49].forEach((x) => P(g, "box", [x, 0.5, 0], [0.02, 1, 1], v.main, "main"));
    [0.01, 0.25, 0.5, 0.75, 0.99].forEach((y) => P(g, "box", [0, y, 0], [0.96, 0.02, 0.98], v.main, "main"));
    const cols = ["#b4553f", "#2f4f6f", "#5f7f62", "#d9cfc0", "#8b5e48"];
    [0.13, 0.38, 0.63].forEach((y, r) => { for (let i = 0; i < 5; i++) P(g, "box", [-0.34 + i * 0.12 + r * 0.02, y + 0.03, 0], [0.08, 0.2, 0.7], cols[(i + r) % 5]); });
  },
  /* Straight stairs. Built in the unit cube that the caller scales to (width L, height H, length W), so every thickness is divided by the
     real size (dim = [L, W, H] in mm) and the sloped parts are sheared boxes instead of rotated ones. A rotation inside a non-uniformly
     scaled group shears the part (this was the cause of the plank-like rails and the posts that missed the rail). */
  stairs(g, v, dim = [1200, 4200, 2800]) {
    const [L, W, H] = dim, n = STRAIGHT_RISERS, rise = 1 / n, pitch = 1 / n, tread = pitch * 1.06;
    const sx = (mm) => mm / L, sy = (mm) => mm / H, sz = (mm) => mm / W;
    const sheared = (wx, ty, len, slope) => { const geo = new THREE.BoxGeometry(wx, ty, len); geo.applyMatrix4(new THREE.Matrix4().set(1, 0, 0, 0, 0, 1, slope, 0, 0, 0, 1, 0, 0, 0, 0, 1)); geo.computeVertexNormals(); return geo; };
    const S = (geo, pos, color, role, o = {}) => { const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: o.r ?? 0.7, metalness: o.m ?? 0 })); m.material.userData.role = role; m.position.set(pos[0], pos[1], pos[2]); m.castShadow = m.receiveShadow = true; g.add(m); return m; };
    for (let i = 0; i < n; i++) {
      const z = -0.5 + (i + 0.5) / n, top = (i + 1) * rise;
      P(g, "box", [0, top - sy(20), z], [1 - sx(60), sy(40), tread], v.main, "main");              // tread 40 mm thick, top at the true step height
      P(g, "box", [0, top - rise / 2 - sy(20), z + pitch / 2 - sz(12)], [1 - sx(80), rise - sy(40), sz(24)], v.second, "second"); // riser
    }
    const run = 1 - pitch, zA = -0.5 + pitch / 2, hRail = 900, tRail = 50;
    [-1, 1].forEach((side) => {
      const x = side * (0.5 - sx(35));
      // stringer: a sloped board under the treads (tread nose line is y = z + 0.5 + pitch/2, slope 1 in unit space)
      S(sheared(sx(40), sy(220), run, 1), [x, 0.5 + sy(-110) + pitch / 2 - 0.0, 0], v.second, "second");
      // handrail parallel to the nosing line, hRail above it
      S(sheared(sx(60), sy(tRail), run, 1), [x, 0.5 + pitch / 2 + sy(hRail), 0], v.main, "main");
      // balusters: vertical, 2 per tread pitch step, each ends exactly under the rail
      for (let i = 0; i < n; i += 2) {
        const z = -0.5 + (i + 0.5) / n + pitch * 0.25, y0 = (i + 1) * rise + 0 , y1 = z + 0.5 + pitch / 2 + sy(hRail);
        P(g, "box", [x, (y0 + y1) / 2, z], [sx(25), y1 - y0, sz(25)], v.second, "second");
      }
      // newel posts at both ends
      [zA, 0.5 - pitch / 2].forEach((zz) => { const yb = zz + 0.5 + pitch / 2, yt = yb + sy(hRail + 60); P(g, "box", [x, yt / 2 - sy(0), zz], [sx(60), yt, sz(60)], v.second, "second"); });
    });
  },
  spiralStairs(g, v, dim = [1900, 1900, 2800]) {
    // footprint is a square (L = W), so a rotation about y keeps every tread undistorted by the group scale.
    // Unit space: y 0..1 is one storey (about 2.8 m), so 0.32 is a 0.9 m handrail height.
    const sp = spiralParams({ size: { L: 1, W: 1, H: 1 } }, dim[2]), n = sp.n, rise = 1 / n, RAIL = 0.32;
    P(g, "cyl", [0, 0.5, 0], [0.05, 1, 0.05], v.second, "second", { r: 0.5 });
    const top = [];
    for (let i = 0; i < n; i++) {
      const a = sp.a0 + ((i + 0.5) / n) * sp.sweep, y = (i + 1) * rise;
      const t = P(g, "box", [Math.sin(a) * 0.27, y - 0.012, Math.cos(a) * 0.27], [(sp.sweep / n) * 0.34, 0.024, 0.46], v.main, "main");
      t.rotation.y = a;
      const px = Math.sin(a) * 0.46, pz = Math.cos(a) * 0.46;
      P(g, "cyl", [px, y + RAIL / 2, pz], [0.012, RAIL, 0.012], v.second, "second", { r: 0.5 });
      top.push([px, y + RAIL, pz]);
    }
    for (let i = 0; i < top.length - 1; i++) {
      const A = top[i], B = top[i + 1], len = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]);
      const seg = P(g, "box", [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2], [0.018, 0.012, len], v.main, "main");
      seg.lookAt(new THREE.Vector3(B[0], B[1], B[2]));
    }
  },
  plant(g, v) {
    P(g, "cyl", [0, 0.11, 0], [0.8, 0.22, 0.8], v.second, "second", { r: 0.8 });
    P(g, "sph", [0, 0.45, 0], [0.9, 0.5, 0.9], v.main, "main", { r: 0.9 });
    P(g, "sph", [0.05, 0.72, 0], [0.64, 0.42, 0.64], v.main, "main", { r: 0.9 });
    P(g, "sph", [-0.05, 0.92, 0.05], [0.4, 0.3, 0.4], v.main, "main", { r: 0.9 });
  },
  planter(g, v) {
    P(g, "box", [0, 0.25, 0], [1, 0.5, 1], v.main, "main", { r: 0.8 });
    P(g, "box", [0, 0.52, 0], [1.06, 0.06, 1.06], v.second, "second");
    [-0.3, 0, 0.3].forEach((x) => P(g, "sph", [x, 0.75, 0], [0.35, 0.58, 0.35], v.second, "second", { r: 0.9 }));
  },
  vase(g, v) {
    P(g, "cyl", [0, 0.48, 0], [0.72, 0.86, 0.72], v.main, "main", { r: 0.3 });
    P(g, "cyl", [0, 0.91, 0], [0.34, 0.12, 0.34], v.main, "main", { r: 0.3 });
  },
  lamp(g, v) {
    P(g, "cyl", [0, 0.01, 0], [0.5, 0.02, 0.5], DARK, null, { m: 0.5 });
    P(g, "cyl", [0, 0.45, 0], [0.04, 0.9, 0.04], DARK, null, { m: 0.5 });
    P(g, "cyl", [0, 0.86, 0], [1, 0.26, 1], v.main, "main", { e: "#ffd9a0", r: 0.9 });
  },
  tableLamp(g, v) {
    P(g, "cyl", [0, 0.08, 0], [0.62, 0.12, 0.62], v.second, "second", { m: 0.45 });
    P(g, "cyl", [0, 0.42, 0], [0.08, 0.62, 0.08], v.main, "main");
    P(g, "cyl", [0, 0.8, 0], [0.8, 0.38, 0.8], v.second, "second", { e: "#ffe2a0", r: 0.9 });
  },
  ceilingLight(g, v) {
    P(g, "cyl", [0, 0.94, 0], [0.025, 0.12, 0.025], v.second, "second", { m: 0.5 });
    P(g, "cyl", [0, 0.48, 0], [0.72, 0.38, 0.72], v.main, "main", { e: "#ffe7a6", r: 0.35 });
    P(g, "cyl", [0, 0.27, 0], [0.52, 0.06, 0.52], "#fff0c9", null, { e: "#fff0c9", r: 0.25 });
  },
  ceilingFan(g, v) {
    P(g, "cyl", [0, 0.92, 0], [0.05, 0.16, 0.05], v.second, "second", { m: 0.4 });
    P(g, "cyl", [0, 0.82, 0], [0.28, 0.1, 0.28], v.main, "main", { m: 0.35 });
    for (let i = 0; i < 4; i++) {
      const blade = P(g, "box", [0, 0.79, -0.31], [0.16, 0.035, 0.46], v.main, "main");
      blade.rotation.y = i * Math.PI / 2;
    }
  },
  mirror(g, v) {
    P(g, "box", [0, 0.5, 0], [1, 1, 0.08], v.main, "main");
    P(g, "box", [0, 0.5, 0.06], [0.88, 0.9, 0.025], v.second, "second", { m: 0.45, r: 0.12 });
  },
  wallArt(g, v) {
    P(g, "box", [0, 0.5, 0], [1, 1, 0.08], v.second, "second");
    P(g, "box", [0, 0.5, 0.06], [0.84, 0.84, 0.025], v.main, "main");
    P(g, "box", [-0.16, 0.54, 0.08], [0.2, 0.5, 0.012], "#e9e4da");
    P(g, "box", [0.16, 0.44, 0.08], [0.2, 0.3, 0.012], "#3f5675");
  },
  curtains(g, v) {
    P(g, "cyl", [0, 0.96, 0], [0.035, 0.035, 1.05], v.second, "second", { m: 0.4 });
    [-0.32, 0.32].forEach((x) => {
      const panel = P(g, "box", [x, 0.48, 0], [0.35, 0.92, 0.08], v.main, "main", { r: 0.95 });
      panel.rotation.z = x < 0 ? -0.04 : 0.04;
    });
  },
  outdoorTable(g, v) {
    P(g, "cyl", [0, 0.94, 0], [1, 0.12, 1], v.main, "main");
    P(g, "cyl", [0, 0.46, 0], [0.12, 0.88, 0.12], v.second, "second");
    P(g, "cyl", [0, 0.04, 0], [0.65, 0.08, 0.65], v.second, "second");
    [-0.46, 0.46].forEach((x) => {
      const chair = P(g, "box", [x, 0.38, 0], [0.38, 0.08, 0.42], v.second, "second");
      P(g, "box", [x, 0.58, -0.19], [0.38, 0.38, 0.06], v.second, "second");
    });
  },
  patioChair(g, v) {
    [[-0.4, -0.38], [0.4, -0.38], [-0.4, 0.38], [0.4, 0.38]].forEach(([x, z]) => P(g, "box", [x, 0.22, z], [0.06, 0.44, 0.06], v.second, "second"));
    P(g, "box", [0, 0.48, 0], [1, 0.08, 1], v.main, "main");
    P(g, "box", [0, 0.74, -0.45], [1, 0.5, 0.08], v.second, "second");
  },
  grill(g, v) {
    P(g, "cyl", [0, 0.65, 0], [1, 0.4, 1], v.main, "main", { r: 0.45, m: 0.3 });
    P(g, "cyl", [0, 0.88, 0], [1.05, 0.08, 1.05], v.second, "second", { m: 0.5 });
    P(g, "cyl", [0, 0.91, 0], [1.05, 0.04, 1.05], DARK, null, { m: 0.5 });
    [-0.35, 0.35].forEach((x) => P(g, "cyl", [x, 0.26, 0], [0.06, 0.52, 0.06], DARK));
  },
  mailbox(g, v) {
    P(g, "box", [0, 0.72, 0], [1, 0.46, 0.86], v.main, "main");
    P(g, "box", [0, 0.55, 0.45], [0.55, 0.04, 0.02], v.second, "second");
    P(g, "box", [0, 0.24, 0], [0.12, 0.5, 0.12], DARK);
    P(g, "box", [0, 0.04, 0], [0.46, 0.08, 0.46], DARK);
  },
  car(g, v) {
    const glass = "#536d7a", chrome = "#c5c9cc";
    P(g, "box", [0, 0.16, 0], [0.82, 0.1, 0.72], DARK, null, { r: 0.55 });
    P(g, "box", [0.2, 0.28, 0], [0.54, 0.2, 0.82], v.main, "main", { r: 0.28, m: 0.22 });
    P(g, "box", [-0.3, 0.28, 0], [0.38, 0.2, 0.82], v.main, "main", { r: 0.3, m: 0.2 });
    P(g, "box", [-0.035, 0.48, 0], [0.55, 0.27, 0.68], v.main, "main", { r: 0.28, m: 0.18 });
    P(g, "box", [-0.035, 0.635, 0], [0.37, 0.035, 0.58], v.second, "second", { r: 0.24, m: 0.15 });
    [-1, 1].forEach((side) => {
      const z = side * 0.348;
      P(g, "box", [-0.155, 0.51, z], [0.19, 0.13, 0.014], glass, null, { r: 0.16, m: 0.2 });
      P(g, "box", [0.085, 0.51, z], [0.19, 0.13, 0.014], glass, null, { r: 0.16, m: 0.2 });
      P(g, "box", [-0.035, 0.51, z * 1.035], [0.025, 0.16, 0.02], v.main, "main", { r: 0.3 });
      P(g, "box", [0.275, 0.43, side * 0.43], [0.12, 0.06, 0.1], v.main, "main", { r: 0.25 });
      P(g, "box", [-0.12, 0.34, side * 0.42], [0.12, 0.025, 0.018], chrome, null, { m: 0.7, r: 0.28 });
    });
    const windshield = P(g, "box", [0.24, 0.505, 0], [0.018, 0.17, 0.57], glass, null, { r: 0.14, m: 0.22 });
    windshield.rotation.z = -0.28;
    const rearGlass = P(g, "box", [-0.31, 0.505, 0], [0.018, 0.15, 0.56], glass, null, { r: 0.14, m: 0.22 });
    rearGlass.rotation.z = 0.32;
    [-0.29, 0.29].forEach((z) => {
      P(g, "box", [0.495, 0.3, z], [0.022, 0.075, 0.16], "#fff0c9", null, { e: "#fff0c9", r: 0.24 });
      P(g, "box", [-0.495, 0.3, z], [0.022, 0.075, 0.16], "#a8443f", null, { r: 0.3 });
      P(g, "box", [0.506, 0.17, z], [0.018, 0.035, 0.13], "#f2f1e9", null, { m: 0.25, r: 0.3 });
      P(g, "box", [-0.506, 0.17, z], [0.018, 0.035, 0.13], "#d6d8da", null, { m: 0.6, r: 0.3 });
    });
    P(g, "box", [0.506, 0.27, 0], [0.02, 0.105, 0.36], "#252a2d", null, { m: 0.45, r: 0.3 });
    P(g, "box", [-0.507, 0.24, 0], [0.025, 0.085, 0.32], chrome, null, { m: 0.72, r: 0.28 });
    P(g, "box", [-0.509, 0.24, 0], [0.028, 0.035, 0.17], "#30343a", null, { r: 0.3 });
    P(g, "box", [-0.51, 0.12, 0], [0.02, 0.07, 0.24], "#f4f4f2", null, { r: 0.3 });
    [-0.31, 0.31].forEach((x) => [-0.415, 0.415].forEach((z) => {
      const tire = P(g, "cyl", [x, 0.14, z], [0.24, 0.12, 0.24], "#202225", null, { r: 0.94 });
      tire.rotation.x = Math.PI / 2;
      const rim = P(g, "cyl", [x, 0.14, z * 1.055], [0.15, 0.126, 0.15], "#aeb4bb", null, { m: 0.72, r: 0.26 });
      rim.rotation.x = Math.PI / 2;
      const center = P(g, "cyl", [x, 0.14, z * 1.07], [0.055, 0.13, 0.055], "#59616a", null, { m: 0.7, r: 0.28 });
      center.rotation.x = Math.PI / 2;
      for (let spoke = 0; spoke < 5; spoke++) {
        const angle = (spoke * Math.PI * 2) / 5;
        const detail = P(g, "box", [x + Math.cos(angle) * 0.055, 0.14 + Math.sin(angle) * 0.055, z * 1.075], [0.014, 0.055, 0.012], "#e1e3e4", null, { m: 0.65, r: 0.28 });
        detail.rotation.z = angle;
      }
    }));
  },
};
export function buildModel(type, variant, spiral = false, size = null) {
  const g = new THREE.Group();
  const c = CAT[type];
  BUILD[spiral && type === "stairs" ? "spiralStairs" : type](g, c.variants[variant] || c.variants[0], type === "stairs" && size ? [size.L, size.W, size.H] : undefined);
  return g;
}
export function paint(g, v, override) {
  g.traverse((o) => {
    const role = o.material && o.material.userData && o.material.userData.role;
    if (role === "main") o.material.color.set(override || v.main);
    else if (role === "second") o.material.color.set(v.second);
  });
}

/* ================================================================== */
/* Procedural textures (colour + bump maps, seeded so they never flicker) */
/* ================================================================== */
function rng(seed = 1) {
  let s = Math.floor(seed) % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}
function canvasTex(draw, size = 512, opts = {}) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  draw(c.getContext("2d"), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (!opts.linear && THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = opts.aniso ?? 8;
  return t;
}
const g8 = (v) => { const n = Math.round(clamp(v, 0, 255)); return `rgb(${n},${n},${n})`; };
/* Sprinkle small marks over a canvas. tone: function(R) -> css colour. */
function speckle(x, s, R, count, tone, wMax = 3, hMax = 3) {
  for (let i = 0; i < count; i++) { x.fillStyle = tone(R); x.fillRect(R() * s, R() * s, 1 + R() * wMax, 1 + R() * hMax); }
}
/* Soft blotches (large, very transparent discs) give surfaces their uneven, hand-finished look. */
function blotches(x, s, R, count, rgb, aMax = 0.06, rMin = 20, rMax = 90) {
  for (let i = 0; i < count; i++) {
    const px = R() * s, py = R() * s, r = rMin + R() * (rMax - rMin), gr = x.createRadialGradient(px, py, 0, px, py, r);
    gr.addColorStop(0, `rgba(${rgb},${aMax * (0.4 + R() * 0.6)})`); gr.addColorStop(1, `rgba(${rgb},0)`);
    x.fillStyle = gr; x.fillRect(px - r, py - r, r * 2, r * 2);
    // wrap so the texture still tiles
    [[s, 0], [-s, 0], [0, s], [0, -s]].forEach(([ox, oy]) => { if (px + ox > -r && px + ox < s + r && py + oy > -r && py + oy < s + r) { const g2 = x.createRadialGradient(px + ox, py + oy, 0, px + ox, py + oy, r); g2.addColorStop(0, `rgba(${rgb},${aMax * 0.5})`); g2.addColorStop(1, `rgba(${rgb},0)`); x.fillStyle = g2; x.fillRect(px + ox - r, py + oy - r, r * 2, r * 2); } });
  }
}
const pair = (drawColor, drawBump, size = 512) => ({ map: canvasTex(drawColor, size), bump: canvasTex(drawBump, size, { linear: true }) });
const TEX_CACHE = new Map();
/* Shared, cached texture sets: built once, never disposed with the scene graph. */
function sharedTex(key, make) {
  if (!TEX_CACHE.has(key)) { const t = make(); [t.map, t.bump].forEach((q) => { if (q) q.userData.shared = true; }); TEX_CACHE.set(key, t); }
  return TEX_CACHE.get(key);
}

/* ---- floors ---- */
export function makeFloorTextures() {
  const out = {};
  const add = (kind, color, bump) => { const p = pair(color, bump); out[kind] = p.map; out[kind + ":b"] = p.bump; };
  const woodTones = ["#c9a47c", "#c19b72", "#cdaa84", "#b98f66", "#c6a07a", "#bf9a70"];
  const planks = (x, s, bumpMode, seedBase) => {
    const R = rng(seedBase), rows = 8, ph = s / rows, pw = s / 4;
    if (bumpMode) { x.fillStyle = g8(175); x.fillRect(0, 0, s, s); }
    for (let i = 0; i < rows; i++) for (let j = -1; j < 5; j++) {
      const px = j * pw + (i % 2) * (pw / 2) + (R() - 0.5) * 6, py = i * ph;
      if (!bumpMode) {
        x.fillStyle = woodTones[Math.floor(R() * woodTones.length)]; x.fillRect(px, py, pw, ph);
        for (let k = 0; k < 10; k++) {
          x.strokeStyle = `rgba(${70 + R() * 40},${42 + R() * 25},22,${0.05 + R() * 0.11})`; x.lineWidth = 0.6 + R() * 1.3;
          const gy = py + R() * ph; x.beginPath(); x.moveTo(px, gy); x.bezierCurveTo(px + pw * 0.3, gy + (R() - 0.5) * 6, px + pw * 0.6, gy + (R() - 0.5) * 6, px + pw, gy + (R() - 0.5) * 4); x.stroke();
        }
        if (R() < 0.18) { const kx = px + R() * pw, ky = py + ph / 2; x.strokeStyle = "rgba(80,50,25,.35)"; x.lineWidth = 1.2; x.beginPath(); x.ellipse(kx, ky, 5 + R() * 4, 2.5, 0, 0, Math.PI * 2); x.stroke(); }
      } else {
        for (let k = 0; k < 7; k++) { x.strokeStyle = g8(150 + R() * 70); x.globalAlpha = 0.3; x.lineWidth = 0.8; const gy = py + R() * ph; x.beginPath(); x.moveTo(px, gy); x.lineTo(px + pw, gy + (R() - 0.5) * 3); x.stroke(); x.globalAlpha = 1; }
      }
    }
    x.strokeStyle = bumpMode ? g8(25) : "rgba(55,34,18,.6)"; x.lineWidth = bumpMode ? 3 : 1.6;
    for (let i = 0; i <= rows; i++) { x.beginPath(); x.moveTo(0, i * ph); x.lineTo(s, i * ph); x.stroke(); }
    for (let i = 0; i < rows; i++) for (let j = -1; j < 5; j++) { const px = j * pw + (i % 2) * (pw / 2); x.beginPath(); x.moveTo(px, i * ph); x.lineTo(px, i * ph + ph); x.stroke(); }
  };
  add("wood", (x, s) => planks(x, s, false, 7), (x, s) => planks(x, s, true, 7));
  const tiles = (x, s, bumpMode) => {
    const R = rng(11);
    x.fillStyle = bumpMode ? g8(190) : "#e8ebee"; x.fillRect(0, 0, s, s);
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      if (!bumpMode) { x.fillStyle = `rgba(${150 + R() * 40},${160 + R() * 40},${170 + R() * 40},.12)`; x.fillRect(i * s / 2, j * s / 2, s / 2, s / 2); }
    }
    if (!bumpMode) { speckle(x, s, R, 900, (r) => `rgba(120,125,135,${0.05 + r() * 0.08})`, 2, 2); blotches(x, s, R, 10, "255,255,255", 0.12, 30, 120); }
    x.strokeStyle = bumpMode ? g8(30) : "#aeb4bb"; x.lineWidth = bumpMode ? 7 : 4;
    for (let i = 0; i <= 2; i++) { x.beginPath(); x.moveTo(i * s / 2, 0); x.lineTo(i * s / 2, s); x.stroke(); x.beginPath(); x.moveTo(0, i * s / 2); x.lineTo(s, i * s / 2); x.stroke(); }
  };
  add("tile", (x, s) => tiles(x, s, false), (x, s) => tiles(x, s, true));
  const marble = (x, s, bumpMode) => {
    const R = rng(23);
    x.fillStyle = bumpMode ? g8(200) : "#f2f1ee"; x.fillRect(0, 0, s, s);
    if (!bumpMode) {
      blotches(x, s, R, 18, "190,190,195", 0.1, 40, 150);
      for (let i = 0; i < 16; i++) {
        x.strokeStyle = `rgba(${95 + R() * 40},${95 + R() * 40},${105 + R() * 40},${0.18 + R() * 0.25})`; x.lineWidth = 0.6 + R() * 1.8;
        x.beginPath(); let px = R() * s, py = 0; x.moveTo(px, py); while (py < s) { px += (R() - 0.5) * 46; py += 22 + R() * 30; x.lineTo(px, py); } x.stroke();
      }
    }
    x.strokeStyle = bumpMode ? g8(150) : "rgba(150,150,155,.5)"; x.lineWidth = bumpMode ? 3 : 1.5;
    x.beginPath(); x.moveTo(s / 2, 0); x.lineTo(s / 2, s); x.moveTo(0, s / 2); x.lineTo(s, s / 2); x.stroke();
  };
  add("marble", (x, s) => marble(x, s, false), (x, s) => marble(x, s, true));
  const concrete = (x, s, bumpMode) => {
    const R = rng(31);
    x.fillStyle = bumpMode ? g8(150) : "#b9bcc0"; x.fillRect(0, 0, s, s);
    if (!bumpMode) blotches(x, s, R, 26, "90,95,100", 0.09, 30, 140);
    speckle(x, s, R, bumpMode ? 5000 : 3500, (r) => (bumpMode ? g8(90 + r() * 140) : `rgba(${80 + r() * 100},${80 + r() * 100},${85 + r() * 100},.2)`), 3, 3);
    if (!bumpMode) for (let i = 0; i < 90; i++) { x.fillStyle = "rgba(60,62,66,.35)"; x.beginPath(); x.arc(R() * s, R() * s, 0.6 + R() * 1.3, 0, Math.PI * 2); x.fill(); }
  };
  add("concrete", (x, s) => concrete(x, s, false), (x, s) => concrete(x, s, true));
  const parquet = (x, s, bumpMode) => {
    const R = rng(41), cell = s / 4, pl = cell / 4;
    x.fillStyle = bumpMode ? g8(170) : "#b88c62"; x.fillRect(0, 0, s, s);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) {
      const horiz = (i + j) % 2 === 0, px = i * cell + (horiz ? 0 : k * pl), py = j * cell + (horiz ? k * pl : 0), w = horiz ? cell : pl, h = horiz ? pl : cell;
      if (!bumpMode) {
        x.fillStyle = woodTones[Math.floor(R() * woodTones.length)]; x.fillRect(px, py, w, h);
        for (let n = 0; n < 4; n++) { x.strokeStyle = `rgba(70,42,22,${0.06 + R() * 0.1})`; x.lineWidth = 0.8; x.beginPath(); if (horiz) { const gy = py + R() * h; x.moveTo(px, gy); x.lineTo(px + w, gy); } else { const gx = px + R() * w; x.moveTo(gx, py); x.lineTo(gx, py + h); } x.stroke(); }
      }
      x.strokeStyle = bumpMode ? g8(30) : "rgba(55,34,18,.6)"; x.lineWidth = bumpMode ? 3 : 1.4; x.strokeRect(px, py, w, h);
    }
  };
  add("parquet", (x, s) => parquet(x, s, false), (x, s) => parquet(x, s, true));
  const carpet = (x, s, bumpMode) => {
    const R = rng(53);
    x.fillStyle = bumpMode ? g8(140) : "#b6afa4"; x.fillRect(0, 0, s, s);
    for (let i = 0; i < 9000; i++) {
      const px = R() * s, py = R() * s, a = R() * Math.PI, l = 2 + R() * 4;
      x.strokeStyle = bumpMode ? g8(80 + R() * 150) : `rgba(${130 + R() * 90},${124 + R() * 86},${112 + R() * 80},.35)`; x.lineWidth = 1;
      x.beginPath(); x.moveTo(px, py); x.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l); x.stroke();
    }
  };
  add("carpet", (x, s) => carpet(x, s, false), (x, s) => carpet(x, s, true));
  const stone = (x, s, bumpMode) => {
    const R = rng(67);
    x.fillStyle = bumpMode ? g8(40) : "#8f8c86"; x.fillRect(0, 0, s, s);
    let y = 0;
    while (y < s - 4) {
      const h = Math.min(s - y, 110 + R() * 60); let px = -R() * 80;
      while (px < s) {
        const w = 130 + R() * 130, tone = 205 + R() * 40;
        if (!bumpMode) { x.fillStyle = `rgb(${tone},${tone - 6 + R() * 6},${tone - 14 + R() * 8})`; x.fillRect(px + 3, y + 3, w - 6, h - 6); speckle(x, s, R, 0, () => ""); }
        else { x.fillStyle = g8(170 + R() * 60); x.fillRect(px + 3, y + 3, w - 6, h - 6); }
        px += w;
      }
      y += h;
    }
    if (!bumpMode) { blotches(x, s, R, 22, "70,66,60", 0.1, 30, 120); speckle(x, s, R, 1800, (r) => `rgba(60,58,54,${0.06 + r() * 0.1})`, 2, 2); }
  };
  add("stone", (x, s) => stone(x, s, false), (x, s) => stone(x, s, true));
  return out;
}

/* ---- wall finishes (exterior + interior). White-based so the chosen colour tints them. tile = metres per texture repeat. ---- */
const WALL_TILE = { stucco: 2, brick: 1, stone: 1.2, siding: 1, concrete: 2, timber: 1, paint: 2, plaster: 2, wood: 1 };
export function wallTexture(finish) {
  return sharedTex("wall:" + finish, () => {
    const draw = (x, s, bumpMode) => {
      const R = rng(101 + finish.length * 13 + finish.charCodeAt(0));
      const base = (c, b) => { x.fillStyle = bumpMode ? g8(b) : c; x.fillRect(0, 0, s, s); };
      const line = (x0, y0, x1, y1, w, c, b) => { x.strokeStyle = bumpMode ? g8(b) : c; x.lineWidth = w; x.beginPath(); x.moveTo(x0, y0); x.lineTo(x1, y1); x.stroke(); };
      if (finish === "brick") {
        const rows = 12, ph = s / rows, bw = s / 4;
        base("#b5aea2", 25);
        for (let r = 0; r < rows; r++) for (let c = -1; c < 4; c++) {
          const px = c * bw + (r % 2) * (bw / 2) + 2, py = r * ph + 2, tone = 232 + R() * 23;
          x.fillStyle = bumpMode ? g8(190 + R() * 40) : `rgb(${tone},${tone - 4 - R() * 8},${tone - 8 - R() * 12})`; x.fillRect(px, py, bw - 4, ph - 4);
        }
        if (!bumpMode) blotches(x, s, R, 14, "70,50,40", 0.08, 20, 80);
      } else if (finish === "stone") {
        base("#9c978f", 30);
        let y = 0;
        while (y < s - 4) {
          const h = Math.min(s - y, 90 + R() * 70); let px = -R() * 90;
          while (px < s) { const w = 110 + R() * 150, tone = 214 + R() * 36; x.fillStyle = bumpMode ? g8(165 + R() * 70) : `rgb(${tone},${tone - 4},${tone - 10})`; x.fillRect(px + 3, y + 3, w - 6, h - 6); px += w; }
          y += h;
        }
        if (!bumpMode) { blotches(x, s, R, 16, "60,58,52", 0.1, 20, 90); speckle(x, s, R, 1400, (r) => `rgba(50,48,44,${0.05 + r() * 0.1})`, 2, 2); }
      } else if (finish === "siding" || finish === "timber" || finish === "wood") {
        const vertical = finish !== "siding", n = finish === "siding" ? 10 : finish === "wood" ? 8 : 6, step = s / n;
        base(finish === "siding" ? "#f4f4f4" : "#d9c3a2", 160);
        for (let i = 0; i < n; i++) {
          const tone = 205 + R() * 40;
          if (!bumpMode) { x.fillStyle = finish === "siding" ? `rgb(${tone + 5},${tone + 5},${tone + 5})` : `rgb(${tone},${tone - 22},${tone - 52})`; vertical ? x.fillRect(i * step + 1, 0, step - 2, s) : x.fillRect(0, i * step, s, step - 1); }
          for (let k = 0; k < 7; k++) { const o = R() * step; if (vertical) line(i * step + o, 0, i * step + o + (R() - 0.5) * 6, s, 0.9, `rgba(90,60,35,${0.06 + R() * 0.12})`, 130 + R() * 60); else line(0, i * step + o, s, i * step + o + (R() - 0.5) * 4, 0.9, `rgba(90,60,35,${0.04 + R() * 0.06})`, 150 + R() * 40); }
          if (vertical) line(i * step, 0, i * step, s, 2.2, "rgba(40,28,16,.55)", 20); else { line(0, i * step + step - 1, s, i * step + step - 1, 3, "rgba(30,28,26,.38)", 20); line(0, i * step + 1, s, i * step + 1, 1.5, "rgba(255,255,255,.35)", 230); }
        }
      } else if (finish === "concrete") {
        base("#e4e4e2", 150);
        if (!bumpMode) blotches(x, s, R, 30, "80,84,88", 0.1, 30, 130);
        speckle(x, s, R, bumpMode ? 5000 : 2600, (r) => (bumpMode ? g8(100 + r() * 130) : `rgba(${100 + r() * 90},${100 + r() * 90},${104 + r() * 90},.18)`), 3, 3);
        line(0, 1, s, 1, 2.5, "rgba(60,62,66,.55)", 40); line(1, 0, 1, s, 2.5, "rgba(60,62,66,.55)", 40); line(s / 2, 0, s / 2, s, 1.6, "rgba(60,62,66,.4)", 70);
        for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) { x.fillStyle = bumpMode ? g8(40) : "rgba(50,52,56,.55)"; x.beginPath(); x.arc(s * 0.125 + a * s / 4, s * 0.125 + b * s / 4, 3.2, 0, Math.PI * 2); x.fill(); }
      } else if (finish === "plaster") {
        base("#f6f5f2", 170);
        if (!bumpMode) blotches(x, s, R, 24, "110,100,90", 0.06, 25, 110);
        for (let i = 0; i < 70; i++) { const px = R() * s, py = R() * s, r = 14 + R() * 40; x.strokeStyle = bumpMode ? g8(130 + R() * 90) : `rgba(120,110,100,${0.03 + R() * 0.05})`; x.lineWidth = 1 + R() * 2; x.beginPath(); x.arc(px, py, r, R() * 6, R() * 6 + 1.3); x.stroke(); }
      } else if (finish === "paint") {
        base("#ffffff", 170);
        if (!bumpMode) { blotches(x, s, R, 10, "120,120,120", 0.035, 40, 160); speckle(x, s, R, 900, (r) => `rgba(120,120,120,${0.02 + r() * 0.03})`, 1.5, 1.5); } else speckle(x, s, R, 2500, (r) => g8(150 + r() * 50), 1.5, 1.5);
      } else {
        base("#ffffff", 170);
        if (!bumpMode) { blotches(x, s, R, 22, "90,84,70", 0.06, 20, 90); x.fillStyle = "rgba(80,75,65,.08)"; for (let y = 8; y < s; y += 23) for (let xx = (y % 3) * 7; xx < s; xx += 29) x.fillRect(xx, y, 2, 2); }
        speckle(x, s, R, bumpMode ? 4500 : 1500, (r) => (bumpMode ? g8(110 + r() * 110) : `rgba(90,84,74,${0.04 + r() * 0.08})`), 2, 2);
      }
    };
    return pair((x, s) => draw(x, s, false), (x, s) => draw(x, s, true));
  });
}

/* ---- roofing (1 m per repeat; colour is tinted by the roof colour) ---- */
export function roofTexture(kind) {
  return sharedTex("roof:" + kind, () => {
    const draw = (x, s, bumpMode) => {
      const R = rng(211 + kind.charCodeAt(0));
      if (kind === "tile") {
        const rows = 8, ph = s / rows, cols = 5, cw = s / cols;
        x.fillStyle = bumpMode ? g8(40) : "#8c8c8c"; x.fillRect(0, 0, s, s);
        for (let r = 0; r < rows; r++) for (let c = -1; c < cols; c++) {
          const px = c * cw + (r % 2) * (cw / 2), py = r * ph, tone = 205 + R() * 50;
          if (bumpMode) { const gr = x.createLinearGradient(px, 0, px + cw, 0); gr.addColorStop(0, g8(110)); gr.addColorStop(0.5, g8(235)); gr.addColorStop(1, g8(110)); x.fillStyle = gr; x.fillRect(px + 1, py, cw - 2, ph - 2); }
          else { const gr = x.createLinearGradient(0, py, 0, py + ph); gr.addColorStop(0, `rgb(${tone},${tone},${tone})`); gr.addColorStop(0.82, `rgb(${tone * 0.86},${tone * 0.86},${tone * 0.86})`); gr.addColorStop(1, `rgb(${tone * 0.45},${tone * 0.45},${tone * 0.45})`); x.fillStyle = gr; x.fillRect(px + 1, py, cw - 2, ph - 1); }
        }
        if (!bumpMode) { blotches(x, s, R, 18, "40,40,40", 0.1, 20, 80); speckle(x, s, R, 900, (r) => `rgba(30,30,30,${0.05 + r() * 0.1})`, 2, 2); }
      } else if (kind === "shingle") {
        const rows = 10, ph = s / rows;
        x.fillStyle = bumpMode ? g8(40) : "#777"; x.fillRect(0, 0, s, s);
        for (let r = 0; r < rows; r++) { let px = -R() * 90; while (px < s) { const w = 70 + R() * 50, tone = 190 + R() * 60; x.fillStyle = bumpMode ? g8(150 + R() * 80) : `rgb(${tone},${tone},${tone})`; x.fillRect(px + 1, r * ph, w - 2, ph - 3); px += w; } if (!bumpMode) { x.fillStyle = "rgba(0,0,0,.25)"; x.fillRect(0, r * ph + ph - 4, s, 4); } }
        if (!bumpMode) speckle(x, s, R, 2500, (r) => `rgba(20,20,20,${0.05 + r() * 0.12})`, 2, 2);
      } else if (kind === "metal") {
        const seam = s / 2;
        x.fillStyle = bumpMode ? g8(110) : "#d6d8da"; x.fillRect(0, 0, s, s);
        for (let i = 0; i < 2; i++) {
          x.fillStyle = bumpMode ? g8(250) : "#f1f2f3"; x.fillRect(i * seam - 5, 0, 10, s);
          x.fillStyle = bumpMode ? g8(30) : "rgba(60,64,70,.55)"; x.fillRect(i * seam + 5, 0, 3, s);
        }
        if (!bumpMode) { for (let i = 0; i < 90; i++) { x.fillStyle = `rgba(${R() < 0.5 ? "255,255,255" : "70,75,80"},${0.03 + R() * 0.05})`; x.fillRect(R() * s, 0, 1 + R() * 3, s); } }
        x.fillStyle = bumpMode ? g8(60) : "rgba(60,64,70,.35)"; x.fillRect(0, s - 2, s, 2);
      } else {
        x.fillStyle = bumpMode ? g8(150) : "#c4c5c4"; x.fillRect(0, 0, s, s);
        if (!bumpMode) blotches(x, s, R, 24, "70,72,74", 0.1, 30, 120);
        speckle(x, s, R, bumpMode ? 5000 : 4000, (r) => (bumpMode ? g8(90 + r() * 150) : `rgba(${90 + r() * 110},${90 + r() * 110},${90 + r() * 110},.25)`), 3, 3);
        x.fillStyle = bumpMode ? g8(40) : "rgba(50,50,50,.4)"; x.fillRect(0, 0, s, 2); x.fillRect(0, 0, 2, s);
      }
    };
    return pair((x, s) => draw(x, s, false), (x, s) => draw(x, s, true));
  });
}
/* Wood-grain texture reused for doors, stair treads and timber frames (tinted by the item colour). */
function woodGrainTexture() {
  return sharedTex("grain", () => pair((x, s) => {
    const R = rng(307);
    x.fillStyle = "#e8d2b0"; x.fillRect(0, 0, s, s);
    for (let i = 0; i < 160; i++) { x.strokeStyle = `rgba(${90 + R() * 40},${58 + R() * 24},${30},${0.06 + R() * 0.16})`; x.lineWidth = 0.6 + R() * 2; const gx = R() * s; x.beginPath(); x.moveTo(gx, 0); x.bezierCurveTo(gx + (R() - 0.5) * 18, s * 0.33, gx + (R() - 0.5) * 18, s * 0.66, gx + (R() - 0.5) * 10, s); x.stroke(); }
    blotches(x, s, R, 10, "120,80,40", 0.08, 30, 120);
  }, (x, s) => {
    const R = rng(307);
    x.fillStyle = g8(170); x.fillRect(0, 0, s, s);
    for (let i = 0; i < 130; i++) { x.strokeStyle = g8(90 + R() * 130); x.lineWidth = 0.6 + R() * 1.4; const gx = R() * s; x.beginPath(); x.moveTo(gx, 0); x.lineTo(gx + (R() - 0.5) * 14, s); x.stroke(); }
  }));
}
/* Scale a BoxGeometry's UVs to real-world metres so patterns keep their true size on any wall length.
   (w, h, d) are the box dimensions in metres; (ox, oy) offset the pattern so neighbouring pieces line up. */
function tileBoxUV(geo, w, h, d, tileM, ox = 0, oy = 0) {
  const uv = geo.attributes && geo.attributes.uv;
  if (!uv || !uv.setXY) return geo;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]], s = 1 / tileM;
  for (let f = 0; f < 6; f++) for (let i = 0; i < 4; i++) {
    const k = f * 4 + i, front = f >= 4;
    uv.setXY(k, (uv.getX(k) * dims[f][0] + (front ? ox : 0)) * s, (uv.getY(k) * dims[f][1] + (front ? oy : 0)) * s);
  }
  uv.needsUpdate = true;
  return geo;
}

/* ================================================================== */
/* Plan data helpers                                                   */
/* ================================================================== */
const polyBox = (poly) => { const xs = poly.map((q) => q[0]), zs = poly.map((q) => q[1]); const x = Math.min(...xs), z = Math.min(...zs); return { x, z, w: Math.max(...xs) - x, d: Math.max(...zs) - z }; };
const withBox = (r) => ({ ...r, ...polyBox(r.poly) });
import { holeShareInRoom } from "./stairSpec.js";
const rectPoly = (r) => r.poly || [[r.x, r.z], [r.x + r.w, r.z], [r.x + r.w, r.z + r.d], [r.x, r.z + r.d]];
export const roomArea = (r) => { const P = rectPoly(r); let a = 0; P.forEach((q, i) => { const n = P[(i + 1) % P.length]; a += q[0] * n[1] - n[0] * q[1]; }); return Math.abs(a) / 2 / 1e6; };
export const buildRoomDetails = (design) => design.rooms.map((room) => {
  const points = rectPoly(room), level = room.lv || 0, wallIds = room.wallIds || [], designWalls = design.walls || [];
  const walls = points.map((start, index) => {
    const end = points[(index + 1) % points.length];
    const wall = designWalls.find((candidate) => candidate.id === wallIds[index]);
    return {
      index: index + 1,
      length: Math.hypot(end[0] - start[0], end[1] - start[1]),
      thickness: wall?.t || design.wallT || 150,
      height: wall?.wh || storeyH(design),
      start,
      end,
    };
  });
  const openings = (design.openings || [])
    .filter((opening) => wallIds.includes(opening.wallId))
    .map((opening) => {
      const wallIndex = wallIds.indexOf(opening.wallId);
      const wall = walls[wallIndex];
      const styles = opening.type === "door" ? DOOR_STYLES : WINDOW_STYLES;
      return {
        type: opening.type,
        style: styles.find(([key]) => key === opening.style)?.[1] || (opening.type === "door" ? "Panelled" : "Casement"),
        width: opening.width,
        height: opening.h,
        sill: opening.sill || 0,
        distanceFromWallStart: wall.length * opening.pos - opening.width / 2,
        wall: wallIndex + 1,
        hinge: opening.hinge || "l",
        swingReversed: Boolean(opening.flip),
        panes: opening.panes || 0,
        color: opening.color || "",
      };
    });
  const items = (design.items || [])
    .filter((item) => (item.lv || 0) === level && inPoly([item.x, item.z], points))
    .map((item) => ({
      name: item.name || CAT[item.type]?.name || item.type,
      type: CAT[item.type]?.name || item.type,
      variant: CAT[item.type]?.variants?.[item.variant || 0]?.label || "",
      size: item.size || item.base || {},
      x: item.x,
      z: item.z,
      elevation: item.elev || 0,
      rotation: item.rot || 0,
      color: item.color || "",
      hidden: Boolean(item.hidden),
      locked: Boolean(item.locked),
    }));
  const bounds = polyBox(points);
  return {
    name: room.name || ROOM_TYPES[room.type]?.label || room.type,
    type: ROOM_TYPES[room.type]?.label || room.type,
    floor: level + 1,
    area: roomArea(room),
    perimeter: walls.reduce((total, wall) => total + wall.length, 0),
    width: bounds.w,
    depth: bounds.d,
    x: bounds.x,
    z: bounds.z,
    height: storeyH(design),
    floorFinish: room.floor || ROOM_TYPES[room.type]?.floor || "none",
    wallFinish: design.ext?.insideFinish || "paint",
    wallColor: design.ext?.inside || "#f4f4f2",
    walls,
    openings,
    items,
  };
});
export const polyCentroid = (P) => {
  let a = 0, cx = 0, cz = 0;
  P.forEach((q, i) => { const n = P[(i + 1) % P.length], f = q[0] * n[1] - n[0] * q[1]; a += f; cx += (q[0] + n[0]) * f; cz += (q[1] + n[1]) * f; });
  if (Math.abs(a) < 1) { const b = polyBox(P); return { x: b.x + b.w / 2, z: b.z + b.d / 2 }; }
  return { x: cx / (3 * a), z: cz / (3 * a) };
};
export const isRectRoom = (r) => { const P = rectPoly(r); return P.length === 4 && P.every((q, i) => { const n = P[(i + 1) % 4]; return Math.abs(q[0] - n[0]) < 2 || Math.abs(q[1] - n[1]) < 2; }); };
const inPoly = (pt, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, zi] = P[i], [xj, zj] = P[j]; if (zi > pt[1] !== zj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - zi)) / (zj - zi) + xi) c = !c; } return c; };
export const inRect = (it, r) => (it.lv || 0) === (r.lv || 0) && inPoly([it.x, it.z], rectPoly(r));
export const roomWalls = (r, t = 150) => { const P = rectPoly(r); return P.map((q, k) => ({ id: r.wallIds[k], a: q, b: P[(k + 1) % P.length], t, lv: r.lv || 0 })); };
export const rectWalls = roomWalls;
export const makePolyRoom = (poly, type, name, lv = 0, t = 150) => {
  const room = withBox({ id: uid("r"), name: name || ROOM_TYPES[type].label, type, lv, poly, floor: null, wallIds: poly.map(() => uid("w")) });
  return { room, walls: roomWalls(room, t) };
};
export const makeRoom = (x, z, w, d, type, name, lv = 0, t = 150) => makePolyRoom([[x, z], [x + w, z], [x + w, z + d], [x, z + d]], type, name, lv, t);
/* Storey height (floor to floor) for a design; falls back to the standard 2.8 m. */
export const storeyH = (D) => { const h = D && D.wallH; return h >= 2000 && h <= 6000 ? h : WALL_H; };
export const mk = (type, x, z, rot = 0, extra = {}) => {
  const c = CAT[type];
  return { id: uid("f"), type, name: c.name, variant: 0, size: { L: c.size[0], W: c.size[1], H: c.size[2] }, base: c.size, x, z, elev: c.elev || 0, rot, color: null, mirror: false, locked: false, hidden: false, fav: false, prop: false, lv: 0, ...extra };
};
export function automaticStairs(rooms, floor, existingItems = [], wallH = WALL_H) {
  const candidates = rooms
    .filter((r) => (r.lv || 0) === floor && r.type !== "void" && ((r.w >= 1570 && r.d >= 4570) || (r.w >= 4570 && r.d >= 1570) || (r.w >= 2570 && r.d >= 3270) || (r.w >= 3270 && r.d >= 2570)))
    .sort((a, b) => Number(b.type === "stairwell") - Number(a.type === "stairwell") || roomArea(b) - roomArea(a));
  for (const r of candidates) {
    const alongZ = r.d >= r.w;
    const length = Math.min(4200, (alongZ ? r.d : r.w) - 340);
    const width = Math.min(1200, (alongZ ? r.w : r.d) - 340);
    const rotation = alongZ ? 0 : 90;
    const halfX = rotation ? length / 2 : width / 2, halfZ = rotation ? width / 2 : length / 2;
    const xMin = r.x + halfX + 170, xMax = r.x + r.w - halfX - 170;
    const zMin = r.z + halfZ + 170, zMax = r.z + r.d - halfZ - 170;
    const positions = [];
    for (let x = xMin; x <= xMax; x += 400) for (let z = zMin; z <= zMax; z += 400) positions.push([x, z]);
    positions.push([r.x + r.w / 2, r.z + r.d / 2]);
    positions.sort((a, b) => Math.hypot(a[0] - r.x - r.w / 2, a[1] - r.z - r.d / 2) - Math.hypot(b[0] - r.x - r.w / 2, b[1] - r.z - r.d / 2));
    let best = null, fewestOverlaps = Infinity;
    for (const [x, z] of positions) {
      const item = mk("stairs", Math.round(x), Math.round(z), rotation, { lv: floor, autoFloorLink: true, size: { L: width, W: length, H: wallH } });
      const corners = [[x - halfX, z - halfZ], [x + halfX, z - halfZ], [x + halfX, z + halfZ], [x - halfX, z + halfZ]];
      if (!corners.every((pt) => inPoly(pt, rectPoly(r)))) continue;
      const overlaps = overlapIds([...existingItems.filter((i) => (i.lv || 0) === floor), item]);
      const count = overlaps.has(item.id) ? overlaps.size - 1 : 0;
      if (count < fewestOverlaps) { best = item; fewestOverlaps = count; }
      if (count === 0) return item;
    }
    if (best) return best;
  }
  return null;
}
const axisOf = (w) => (Math.abs(w.a[1] - w.b[1]) < 2 ? "h" : Math.abs(w.a[0] - w.b[0]) < 2 ? "v" : null);
const wallLen = (w) => Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
export const opAt = (w, abs, spec) => {
  const ax = axisOf(w) === "h" ? 0 : 1;
  const pos = (abs - w.a[ax]) / (w.b[ax] - w.a[ax]);
  const door = spec.type === "door";
  return { id: uid("o"), wallId: w.id, lv: w.lv || 0, pos, type: spec.type, width: spec.width || (door ? 900 : 1500), h: spec.h || (door ? 2100 : 1200), sill: door ? 0 : spec.sill ?? 900, color: spec.color || "#a9835b", hinge: spec.hinge || "l", flip: !!spec.flip, style: spec.style || (door ? "panel" : "casement"), panes: spec.panes || 0 };
};

export function bboxOf(D) {
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  D.walls.forEach((w) => [w.a, w.b].forEach(([x, z]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }));
  D.rooms.forEach((r) => { x0 = Math.min(x0, r.x); x1 = Math.max(x1, r.x + r.w); z0 = Math.min(z0, r.z); z1 = Math.max(z1, r.z + r.d); });
  if (x0 > x1) return { x0: -2500, x1: 2500, z0: -2500, z1: 2500, empty: true };
  return { x0, x1, z0, z1, empty: false };
}

export function bboxOfLevel(D, lv) {
  return bboxOf({ walls: D.walls.filter((w) => (w.lv || 0) === lv), rooms: D.rooms.filter((r) => (r.lv || 0) === lv) });
}

/* Merge collinear / overlapping axis-aligned walls so shared walls render once; map openings onto the merged runs.
   Each merged run keeps its `members` (original wall ids with their start/end along the run) so a click in 3D can be
   traced back to the wall that was actually drawn, and walls of different heights are never merged. */
export function mergeWalls(D) {
  const segs = [];
  const lines = new Map();
  D.walls.forEach((w) => {
    const ax = axisOf(w);
    if (!ax) { segs.push({ a: w.a, b: w.b, t: w.t, wh: w.h || 0, ops: [], ids: [w.id], members: [{ id: w.id, s: 0, e: wallLen(w) }], axis: false, lv: w.lv || 0 }); return; }
    const h = ax === "h";
    const coord = h ? (w.a[1] + w.b[1]) / 2 : (w.a[0] + w.b[0]) / 2;
    const s = h ? Math.min(w.a[0], w.b[0]) : Math.min(w.a[1], w.b[1]);
    const e = h ? Math.max(w.a[0], w.b[0]) : Math.max(w.a[1], w.b[1]);
    const k = (w.lv || 0) + (h ? "h" : "v") + Math.round(coord / 10) + "|" + (w.h || 0);
    if (!lines.has(k)) lines.set(k, { h, coord, wh: w.h || 0, list: [], merged: [], lv: w.lv || 0 });
    lines.get(k).list.push({ s, e, t: w.t, id: w.id });
  });
  lines.forEach((L) => {
    L.list.sort((p, q) => p.s - q.s);
    let cur = null;
    L.list.forEach((it) => {
      if (cur && it.s <= cur.e + 2) { cur.e = Math.max(cur.e, it.e); cur.t = Math.max(cur.t, it.t); cur.members.push({ id: it.id, s: it.s, e: it.e }); }
      else { cur = { s: it.s, e: it.e, t: it.t, members: [{ id: it.id, s: it.s, e: it.e }] }; L.merged.push(cur); }
    });
    L.merged.forEach((m) => segs.push({ a: L.h ? [m.s, L.coord] : [L.coord, m.s], b: L.h ? [m.e, L.coord] : [L.coord, m.e], t: m.t, wh: L.wh, ops: [], members: m.members, axis: true, h: L.h, lv: L.lv }));
  });
  const byId = Object.fromEntries(D.walls.map((w) => [w.id, w]));
  D.openings.forEach((o) => {
    const w = byId[o.wallId];
    if (!w) return;
    const cx = w.a[0] + (w.b[0] - w.a[0]) * o.pos, cz = w.a[1] + (w.b[1] - w.a[1]) * o.pos;
    const ax = axisOf(w);
    if (!ax) { const sg = segs.find((q) => q.ids && q.ids[0] === w.id); if (sg) sg.ops.push(o); return; }
    const h = ax === "h", coord = h ? cz : cx, along = h ? cx : cz;
    const sg = segs.find((q) => q.axis && (q.lv || 0) === (w.lv || 0) && q.h === h && (q.wh || 0) === (w.h || 0) && Math.abs((h ? q.a[1] : q.a[0]) - coord) < 10 && along >= (h ? q.a[0] : q.a[1]) - 1 && along <= (h ? q.b[0] : q.b[1]) + 1);
    if (!sg) return;
    const s0 = h ? sg.a[0] : sg.a[1], e0 = h ? sg.b[0] : sg.b[1];
    sg.ops.push({ ...o, pos: (along - s0) / (e0 - s0) });
  });
  return segs;
}

/* Snap an axis-aligned item flush to the nearest wall face (within 160 mm). */
export function snapToWalls(it, walls) {
  const r = Math.round(it.rot);
  if (r % 90 !== 0) return { x: it.x, z: it.z };
  const q = Math.abs(r / 90) % 2 === 1;
  const hx = (q ? it.size.W : it.size.L) / 2, hz = (q ? it.size.L : it.size.W) / 2;
  let x = it.x, z = it.z, bx = 160, bz = 160;
  walls.forEach((w) => {
    const ax = axisOf(w);
    if (!ax || (w.lv || 0) !== (it.lv || 0)) return;
    const t = w.t / 2;
    if (ax === "v") {
      const wx = (w.a[0] + w.b[0]) / 2, lo = Math.min(w.a[1], w.b[1]), hi = Math.max(w.a[1], w.b[1]);
      if (it.z + hz < lo - 100 || it.z - hz > hi + 100) return;
      const d1 = Math.abs(it.x - hx - (wx + t)), d2 = Math.abs(wx - t - (it.x + hx));
      if (d1 < bx) { bx = d1; x = wx + t + hx; }
      if (d2 < bx) { bx = d2; x = wx - t - hx; }
    } else {
      const wz = (w.a[1] + w.b[1]) / 2, lo = Math.min(w.a[0], w.b[0]), hi = Math.max(w.a[0], w.b[0]);
      if (it.x + hx < lo - 100 || it.x - hx > hi + 100) return;
      const d1 = Math.abs(it.z - hz - (wz + t)), d2 = Math.abs(wz - t - (it.z + hz));
      if (d1 < bz) { bz = d1; z = wz + t + hz; }
      if (d2 < bz) { bz = d2; z = wz - t - hz; }
    }
  });
  return { x, z };
}

/* Ids of furniture whose boxes overlap (rugs are ignored; heights are respected). */
export function overlapIds(items) {
  const boxes = items.filter((i) => !i.hidden && i.type !== "rug").map((i) => {
    const a = (i.rot * Math.PI) / 180, c = Math.abs(Math.cos(a)), s2 = Math.abs(Math.sin(a));
    const ex = (c * i.size.L + s2 * i.size.W) / 2, ez = (s2 * i.size.L + c * i.size.W) / 2;
    return { id: i.id, lv: i.lv || 0, x0: i.x - ex, x1: i.x + ex, z0: i.z - ez, z1: i.z + ez, y0: i.elev, y1: i.elev + i.size.H };
  });
  const out = new Set(), e = 12;
  for (let p = 0; p < boxes.length; p++) for (let q = p + 1; q < boxes.length; q++) {
    const A = boxes[p], B = boxes[q];
    if (A.lv === B.lv && A.x0 + e < B.x1 && B.x0 + e < A.x1 && A.z0 + e < B.z1 && B.z0 + e < A.z1 && A.y0 + e < B.y1 && B.y0 + e < A.y1) { out.add(A.id); out.add(B.id); }
  }
  return out;
}

/* ---- snapping, alignment and edge geometry (pure, exported for tests) ---- */
/* Snap a plan point: 1) an existing corner, 2) alignment with other corners (x and z independently), 3) the grid. */
export function snapPoint(p, o = {}) {
  const tol = o.tol ?? 100, atol = o.alignTol ?? tol, pts = o.pts || [], grid = o.grid || 100;
  let best = null;
  pts.forEach(([x, z]) => { const d = Math.hypot(p.x - x, p.z - z); if (d < tol && (!best || d < best.d)) best = { d, x, z }; });
  if (best) return { x: best.x, z: best.z, guides: [], kind: "point" };
  let gx = null, gz = null, bx = atol, bz = atol;
  if (o.guides !== false) {
    pts.forEach(([qx, qz]) => {
      const dx = Math.abs(p.x - qx), dz = Math.abs(p.z - qz);
      if (dx < bx) { bx = dx; gx = [qx, qz]; }
      if (dz < bz) { bz = dz; gz = [qx, qz]; }
    });
  }
  const free = (v) => (o.gridOn === false ? Math.round(v) : sn(v, grid));
  const x = gx ? gx[0] : free(p.x), z = gz ? gz[1] : free(p.z), guides = [];
  if (gx) guides.push({ axis: "x", at: gx[0], from: Math.min(z, gx[1]), to: Math.max(z, gx[1]) });
  if (gz) guides.push({ axis: "z", at: gz[1], from: Math.min(x, gz[0]), to: Math.max(x, gz[0]) });
  return { x, z, guides, kind: gx || gz ? "align" : "grid" };
}
/* Constrain a point so the line from `from` to it sits on a multiple of `stepDeg`, keeping the length (rounded to the grid). */
export function angleSnapPoint(from, to, stepDeg = 15, grid = 0) {
  const dx = to.x - from.x, dz = to.z - from.z, len = Math.hypot(dx, dz);
  if (len < 1) return { x: to.x, z: to.z };
  const step = (stepDeg * Math.PI) / 180, a = Math.round(Math.atan2(dz, dx) / step) * step, l = grid ? Math.max(grid, Math.round(len / grid) * grid) : Math.round(len);
  return { x: Math.round(from.x + Math.cos(a) * l), z: Math.round(from.z + Math.sin(a) * l) };
}
/* Nudge a box so its edges line up with nearby points (used when dragging rooms and walls). */
export function alignBox(b, pts, tol = 60) {
  let dx = 0, dz = 0, bx = tol, bz = tol, gx = null, gz = null;
  pts.forEach(([px, pz]) => {
    [b.x, b.x + b.w].forEach((ex) => { const d = px - ex; if (Math.abs(d) < bx) { bx = Math.abs(d); dx = d; gx = [px, pz]; } });
    [b.z, b.z + b.d].forEach((ez) => { const d = pz - ez; if (Math.abs(d) < bz) { bz = Math.abs(d); dz = d; gz = [px, pz]; } });
  });
  const guides = [];
  if (gx) guides.push({ axis: "x", at: gx[0], from: Math.min(b.z + dz, gx[1]), to: Math.max(b.z + b.d + dz, gx[1]) });
  if (gz) guides.push({ axis: "z", at: gz[1], from: Math.min(b.x + dx, gz[0]), to: Math.max(b.x + b.w + dx, gz[0]) });
  return { dx, dz, guides };
}
const itemExt = (i) => { const a = (i.rot * Math.PI) / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a)); return [(c * i.size.L + s * i.size.W) / 2, (s * i.size.L + c * i.size.W) / 2]; };
/* Align a dragged item to other furniture on the same floor: edges, centres, and flush "abutting" edges. */
export function alignItem(it, others, tol = 40) {
  const [ex, ez] = itemExt(it);
  let x = it.x, z = it.z, bx = tol, bz = tol, gx = null, gz = null;
  others.forEach((o) => {
    if (o.id === it.id || o.hidden || (o.lv || 0) !== (it.lv || 0)) return;
    const [ox, oz] = itemExt(o);
    [[-ex, o.x - ox], [0, o.x], [ex, o.x + ox], [ex, o.x - ox], [-ex, o.x + ox]].forEach(([off, t]) => { const d = Math.abs(it.x + off - t); if (d < bx) { bx = d; x = t - off; gx = { at: t, o, oz }; } });
    [[-ez, o.z - oz], [0, o.z], [ez, o.z + oz], [ez, o.z - oz], [-ez, o.z + oz]].forEach(([off, t]) => { const d = Math.abs(it.z + off - t); if (d < bz) { bz = d; z = t - off; gz = { at: t, o, ox }; } });
  });
  const guides = [];
  if (gx) guides.push({ axis: "x", at: gx.at, from: Math.min(z - ez, gx.o.z - gx.oz), to: Math.max(z + ez, gx.o.z + gx.oz) });
  if (gz) guides.push({ axis: "z", at: gz.at, from: Math.min(x - ex, gz.o.x - gz.ox), to: Math.max(x + ex, gz.o.x + gz.ox) });
  return { x, z, guides };
}
/* Unit normal of polygon edge k (pointing out of the room) and a helper to push an edge along it. */
export function edgeNormal(poly, k) {
  const n = poly.length, A = poly[k], B = poly[(k + 1) % n], dx = B[0] - A[0], dz = B[1] - A[1], L = Math.hypot(dx, dz) || 1;
  let nx = -dz / L, nz = dx / L;
  const c = polyCentroid(poly);
  if (nx * ((A[0] + B[0]) / 2 - c.x) + nz * ((A[1] + B[1]) / 2 - c.z) < 0) { nx = -nx; nz = -nz; }
  return [nx, nz];
}
export function moveEdgePoly(poly, k, delta) {
  const n = poly.length, [nx, nz] = edgeNormal(poly, k), j = (k + 1) % n;
  return poly.map((q, i) => (i === k || i === j ? [q[0] + nx * delta, q[1] + nz * delta] : q));
}
export function setEdgeLengthPoly(poly, k, len) {
  const n = poly.length, A = poly[k], B = poly[(k + 1) % n], L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1, f = Math.max(100, len) / L;
  return poly.map((q, i) => (i === (k + 1) % n ? [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f] : q));
}
/* Stairs: travel direction (low -> high) and rotated footprint in plan. */
export const stairDir = (it) => { const a = (it.rot * Math.PI) / 180; return [Math.sin(a), Math.cos(a)]; };
export function stairFootprint(it, grow = 0) {
  const a = (it.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), hl = it.size.L / 2 + grow, hw = it.size.W / 2 + grow;
  return [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]].map(([lx, lz]) => [it.x + lx * c + lz * s, it.z - lx * s + lz * c]);
}
/* Openings cut through an upper floor slab where a staircase from the floor below arrives. */
export function stairHolesFor(D, room) {
  const lv = room.lv || 0;
  if (lv < 1) return [];
  const poly = rectPoly(room), out = [];
  D.items.filter((i) => i.type === "stairs" && (i.lv || 0) === lv - 1 && !i.hidden).forEach((i) => {
    const part = holeShareInRoom(i.spiral ? spiralHole(i, 40) : stairFootprint(i, 40), poly);
    if (part) out.push(part);
  });
  return out;
}
/* Spiral stairs: the slab opening is the swept sector minus the last landing steps, so the top tread meets the upper floor. */
export function spiralHole(it, grow = 0) {
  const sp = spiralParams(it), R = it.size.L / 2 + grow, a1 = sp.a0 + sp.sweep - sp.landing, pts = [[it.x, it.z]], r = (it.rot * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const toPlan = (lx, lz) => [it.x + lx * c + lz * s, it.z - lx * s + lz * c];
  pts.length = 0; pts.push(toPlan(0, 0));
  const steps = 14;
  for (let i = 0; i <= steps; i++) { const a = sp.a0 + ((a1 - sp.a0) * i) / steps; pts.push(toPlan(Math.sin(a) * R, Math.cos(a) * R)); }
  return pts;
}

/* Built-in spiral staircase placed in a room the user picked. Furniture that now collides moves to the nearest free spot in the same room. */
const itemBox = (i, pad = 0) => {
  const a = (i.rot * Math.PI) / 180, c = Math.abs(Math.cos(a)), s2 = Math.abs(Math.sin(a)), ex = (c * i.size.L + s2 * i.size.W) / 2 + pad, ez = (s2 * i.size.L + c * i.size.W) / 2 + pad;
  return { x0: i.x - ex, x1: i.x + ex, z0: i.z - ez, z1: i.z + ez, y0: i.elev || 0, y1: (i.elev || 0) + i.size.H };
};
const boxesHit = (A, B) => A.x0 < B.x1 && B.x0 < A.x1 && A.z0 < B.z1 && B.z0 < A.z1 && A.y0 < B.y1 && B.y0 < A.y1;
export const SPIRAL_D = 1900;
export const spiralFits = (r) => r.type !== "void" && r.w >= SPIRAL_D + 340 && r.d >= SPIRAL_D + 340;
const CEILING_TYPES = new Set(["ceilingLight", "ceilingFan"]);
/* Move the furniture of `room` that collides with `stair` to free spots in the same room. Tries the nearest spots first, keeps the item's
   own rotation first and then turns it by 90 degrees, and relaxes the walking clearance around the stairs from 300 mm to 100 mm if needed. */
function relocateAround(room, items, stair, wallH, repack = false) {
  const lv = room.lv || 0, poly = rectPoly(room), rx0 = room.x, rx1 = room.x + room.w, rz0 = room.z, rz1 = room.z + room.d;
  const solid = { ...itemBox(stair), y0: 0, y1: wallH };
  const mine = items.filter((i) => (i.lv || 0) === lv && inPoly([i.x, i.z], poly) && !i.hidden && i.type !== "rug" && i.type !== "stairs" && i.id !== stair.id);
  const movers = mine.filter((i) => repack || boxesHit(itemBox(i), solid)).sort((a, b) => b.size.L * b.size.W - a.size.L * a.size.W);
  const placed = new Map();
  const pending = new Set(movers.map((i) => i.id));
  const all = () => [...items.filter((i) => (i.lv || 0) === lv && !i.hidden && i.type !== "rug" && i.id !== stair.id && (!pending.has(i.id) || placed.has(i.id))).map((i) => placed.get(i.id) || i), stair];
  let moved = 0, stuck = 0;
  const cands = [];
  for (let x = rx0 + 100; x <= rx1 - 100; x += 150) for (let z = rz0 + 100; z <= rz1 - 100; z += 150) cands.push([x, z]);
  movers.forEach((it) => {
    const wallMounted = (it.elev || 0) > 0 && !CEILING_TYPES.has(it.type);
    const sorted = [...cands].sort((p, q) => Math.hypot(p[0] - it.x, p[1] - it.z) - Math.hypot(q[0] - it.x, q[1] - it.z));
    const others = all().filter((o) => o.id !== it.id).map((o) => itemBox(o));
    for (const clear of [300, 100]) {
      const keepOut = { ...itemBox(stair, clear), y0: 0, y1: wallH };
      for (const [x, z] of sorted) {
        for (const dr of wallMounted ? [0] : [0, 90, 270, 180]) {
          let t = { ...it, x, z, rot: (it.rot + dr) % 360 };
          if (wallMounted) {
            const mn = Math.min(x - rx0, rx1 - x, z - rz0, rz1 - z), rot = mn === z - rz0 ? 0 : mn === rx1 - x ? 270 : mn === rz1 - z ? 180 : 90, depth = it.size.W / 2 + 20;
            t = { ...it, rot, x: rot === 90 ? rx0 + depth : rot === 270 ? rx1 - depth : x, z: rot === 0 ? rz0 + depth : rot === 180 ? rz1 - depth : z };
          }
          const b = itemBox(t);
          if (b.x0 < rx0 + 60 || b.x1 > rx1 - 60 || b.z0 < rz0 + 60 || b.z1 > rz1 - 60 || !inPoly([t.x, t.z], poly) || boxesHit(b, keepOut)) continue;
          if (others.some((o) => boxesHit(b, o))) continue;
          placed.set(it.id, { ...t, x: Math.round(t.x), z: Math.round(t.z) });
          moved++;
          return;
        }
      }
    }
    stuck++;
  });
  return { placed, moved, stuck, total: movers.length };
}
export function placeSpiralStairs(rooms, roomId, items, wallH = WALL_H) {
  const r = rooms.find((q) => q.id === roomId);
  if (!r || !spiralFits(r)) return null;
  const lv = r.lv || 0, poly = rectPoly(r), half = SPIRAL_D / 2, m = 170;
  const x0 = r.x + m + half, x1 = r.x + r.w - m - half, z0 = r.z + m + half, z1 = r.z + r.d - m - half;
  const corners = [[x0, z0], [x1, z0], [x0, z1], [x1, z1]];
  let best = null;
  corners.forEach(([x, z], k) => {
    const st = mk("stairs", Math.round(x), Math.round(z), 0, { lv, autoFloorLink: true, spiral: true, name: "Spiral stairs", size: { L: SPIRAL_D, W: SPIRAL_D, H: wallH } });
    if (!spiralCornersOk(st, poly)) return;
    let res = relocateAround(r, items, st, wallH);
    if (res.stuck) { const alt = relocateAround(r, items, st, wallH, true); if (alt.stuck < res.stuck) res = alt; }
    if (!best || res.stuck < best.res.stuck || (res.stuck === best.res.stuck && res.moved < best.res.moved)) best = { st, res, k };
  });
  if (!best) return null;
  const { st, res } = best;
  return { items: [...items.map((i) => res.placed.get(i.id) || i), st], moved: res.moved, stuck: res.stuck, total: res.total, moverIds: new Set(res.placed.keys()) };
}
/* After furnishing a room that already contains stairs, move whatever landed on the stairs. Returns the same items array when nothing moves. */
export function clearStairsInRoom(room, items, wallH = WALL_H) {
  const poly = rectPoly(room), lv = room.lv || 0;
  let cur = items, stuck = 0, moved = 0;
  items.filter((i) => i.type === "stairs" && !i.hidden && (i.lv || 0) === lv && inPoly([i.x, i.z], poly)).forEach((stair) => {
    let res = relocateAround(room, cur, stair, wallH);
    if (res.stuck) { const alt = relocateAround(room, cur, stair, wallH, true); if (alt.stuck < res.stuck) res = alt; }
    if (res.placed.size) cur = cur.map((i) => res.placed.get(i.id) || i);
    stuck += res.stuck; moved += res.moved;
  });
  return { items: cur, moved, stuck };
}
const spiralCornersOk = (st, poly) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].every(([a, b]) => inPoly([st.x + a * st.size.L / 2, st.z + b * st.size.W / 2], poly));

/* A separate stairwell room beside the building on the current floor (straight stairs inside) plus the same room on the new floor. */
export function planStairwell(D, cur, top, wallH = WALL_H) {
  const onCur = D.rooms.filter((r) => (r.lv || 0) === cur && r.type !== "void");
  const edge = onCur.reduce((b, r) => (!b || r.x + r.w > b.x + b.w ? r : b), null);
  const W = 1800, Dp = 4600, x = edge ? edge.x + edge.w : 0, z = edge ? edge.z : 0;
  const low = makePolyRoom([[x, z], [x + W, z], [x + W, z + Dp], [x, z + Dp]], "stairwell", "Stairwell", cur);
  const up = makePolyRoom([[x, z], [x + W, z], [x + W, z + Dp], [x, z + Dp]], "stairwell", "Stairwell", top);
  low.room.autoStairs = true; up.room.autoStairs = true;
  const stairs = furnishRoom(low.room, wallH).filter((i) => i.type === "stairs").map((i) => ({ ...i, autoFloorLink: true }));
  const door = (w) => opAt(w, z + 1200, { type: "door" });
  const openings = [door(low.walls[3]), door(up.walls[3])];
  return { rooms: [low.room, up.room], walls: [...low.walls, ...up.walls], openings, items: stairs };
}

/* Bill of quantities and cost estimate from the current design. Every line has a stable key so unit rates can be overridden
   per project (D.cost.rates[key]). Walls are classified external when they sit on the floor's outer edge and are not shared. */
const INT_PRICE = { paint: PAINT_PRICE, plaster: 11, concrete: 16, brick: 38, wood: 62 };
export function estimate(D) {
  const cost = { ...DEFAULT_COST, ...(D.cost || {}) }, ov = cost.rates || {}, ex = D.ext || {}, SH = storeyH(D);
  const lines = [];
  const add = (cat, key, label, qty, unit, price) => {
    if (!(qty > 0)) return;
    const rate = ov[key] !== undefined && ov[key] !== "" && !Number.isNaN(+ov[key]) ? +ov[key] : price;
    const q2 = Math.round(qty * 100) / 100;
    if (!(q2 > 0)) return;
    lines.push({ cat, key, label, qty: q2, unit, price: rate, base: price, total: Math.round(q2 * rate) });
  };
  const levels = Math.max(D.levels || 1, 1);
  const real = D.rooms.filter((r) => r.type !== "void");
  const areaAt = (test) => real.filter(test).reduce((a, r) => a + roomArea(r), 0);
  const q = { floorArea: areaAt(() => true), groundArea: areaAt((r) => (r.lv || 0) === 0), upperArea: areaAt((r) => (r.lv || 0) > 0) };

  // ---- walls
  const bbL = {};
  const bbFor = (lv) => (bbL[lv] = bbL[lv] || bboxOfLevel(D, lv));
  let extLen = 0, intLen = 0, extArea = 0, intArea = 0, extVol = 0, intVol = 0, extFootLen = 0;
  mergeWalls(D).forEach((sg) => {
    const len = Math.hypot(sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]) / 1000, h = (sg.wh || SH) / 1000, t = sg.t / 1000;
    let overlapped = 0, union = 0;
    if (sg.axis && sg.members) {
      const iv = [...sg.members].sort((p, q2) => p.s - q2.s);
      let total = 0, cs = null;
      iv.forEach((m) => { total += m.e - m.s; if (cs && m.s <= cs.e) cs.e = Math.max(cs.e, m.e); else { if (cs) union += cs.e - cs.s; cs = { s: m.s, e: m.e }; } });
      if (cs) union += cs.e - cs.s;
      overlapped = Math.max(0, total - union);
    }
    const shared = sg.axis && union > 0 && overlapped >= union * 0.5;
    let external = false;
    if (!sg.axis) external = true;
    else if (!shared) {
      const b = bbFor(sg.lv || 0), tol = 120;
      external = sg.h ? Math.abs(sg.a[1] - b.z0) < tol || Math.abs(sg.a[1] - b.z1) < tol : Math.abs(sg.a[0] - b.x0) < tol || Math.abs(sg.a[0] - b.x1) < tol;
    }
    let gross = len * h, open = 0;
    sg.ops.forEach((o) => { const sill = o.type === "window" ? (o.sill || 0) : 0; open += (o.width / 1000) * (Math.min(o.h, SH - sill - 50) / 1000); });
    const net = Math.max(0, gross - open);
    if (external) { extLen += len; extArea += net; extVol += net * t; if ((sg.lv || 0) === 0) extFootLen += len; }
    else { intLen += len; intArea += net; intVol += net * t; }
  });
  Object.assign(q, { extLen, intLen, extArea, intArea });

  // ---- structure
  add("Structure", "excavation", "Excavation for foundations", q.groundArea * 0.7, "m³", BOQ.excavation);
  add("Structure", "footing", "Strip footing under external walls", extFootLen, "m", BOQ.footing);
  add("Structure", "groundSlab", "Ground floor slab (150 mm RC)", q.groundArea, "m²", BOQ.groundSlab);
  add("Structure", "upperSlab", "Upper floor slabs (RC)", q.upperArea, "m²", BOQ.upperSlab);
  add("Structure", "wallExt", "Masonry walls, external", extVol, "m³", BOQ.wallExt);
  add("Structure", "wallInt", "Masonry walls, internal", intVol, "m³", BOQ.wallInt);

  // ---- envelope: roof, external finish, openings
  const bbAll = bboxOf(D), topLv = levels - 1, massing = Math.max(0, (ex.storeys || 1) - levels);
  const bTop = massing > 0 ? bbAll : (bbFor(topLv).empty ? bbAll : bbFor(topLv));
  const fp = bbAll.empty ? 0 : ((bbAll.x1 - bbAll.x0) * (bbAll.z1 - bbAll.z0)) / 1e6;
  if (!bTop.empty) {
    const ovm = (ex.overhang ?? 450) / 1000, pitch = (clamp(ex.roofPitch ?? 24, 5, 60) * Math.PI) / 180, flat = ex.roof === "flat";
    const plan = ((bTop.x1 - bTop.x0) / 1000 + 2 * ovm) * ((bTop.z1 - bTop.z0) / 1000 + 2 * ovm);
    q.roofArea = flat ? plan : plan / Math.cos(pitch);
    add("Envelope", "roof", "Roof", q.roofArea, "m²", Math.round((ROOF_RATE[ex.roof] ?? ROOF_PRICE) * (flat ? 1 : ROOF_MAT_MULT[ex.roofMat || "tile"] || 1)));
  }
  if (massing > 0 && fp) add("Envelope", "storeys", "Extra storeys", fp * massing, "m²", STOREY_PRICE);
  const perimAll = bbAll.empty ? 0 : (((bbAll.x1 - bbAll.x0) + (bbAll.z1 - bbAll.z0)) * 2) / 1000;
  const extraWall = massing * perimAll * (SH / 1000);
  add("Envelope", "extFinish", "External wall finish: " + (ex.finish || "stucco"), extArea + extraWall, "m²", EXT_FINISH_PRICE[ex.finish || "stucco"] ?? 28);
  const doors = D.openings.filter((o) => o.type === "door");
  const dCount = (f) => doors.filter(f).length;
  add("Envelope", "door", "Doors", dCount((o) => !["double", "sliding", "glass"].includes(o.style)), "pc", DOOR_PRICE);
  add("Envelope", "doorGlass", "Glazed doors", dCount((o) => o.style === "glass"), "pc", Math.round(DOOR_PRICE * 1.6));
  add("Envelope", "doorDouble", "Double doors", dCount((o) => o.style === "double"), "pc", Math.round(DOOR_PRICE * 1.9));
  add("Envelope", "doorSliding", "Sliding glass doors", dCount((o) => o.style === "sliding"), "pc", Math.round(DOOR_PRICE * 2.6));
  const frameMult = { pvc: 1, alu: 1.15, timber: 1.25 }[ex.frame || "pvc"] || 1;
  const win = D.openings.filter((o) => o.type === "window");
  q.windowArea = win.reduce((a, o) => a + (o.width * o.h) / 1e6, 0);
  add("Envelope", "window", "Windows", q.windowArea, "m²", Math.round(WINDOW_PRICE * frameMult));

  // ---- finishes
  const floors = {};
  D.rooms.forEach((r) => { const k = r.floor || ROOM_TYPES[r.type].floor; if (k === "none") return; floors[k] = (floors[k] || 0) + roomArea(r); });
  Object.entries(floors).forEach(([k, a]) => add("Finishes", "floor:" + k, "Flooring: " + k, a, "m²", FLOOR_PRICE[k] ?? 50));
  const inside = ex.insideFinish || "paint";
  add("Finishes", "paint", inside === "paint" ? "Interior wall paint" : "Interior wall finish: " + inside, intArea * 2 + extArea, "m²", INT_PRICE[inside] ?? PAINT_PRICE);
  add("Finishes", "ceiling", "Ceilings (plaster and paint)", q.floorArea, "m²", BOQ.ceiling);
  const perim = real.reduce((a, r) => { const P = rectPoly(r); return a + P.reduce((s, pt, i) => { const n = P[(i + 1) % P.length]; return s + Math.hypot(n[0] - pt[0], n[1] - pt[1]); }, 0); }, 0) / 1000;
  add("Finishes", "skirting", "Skirting boards", Math.max(0, perim - doors.reduce((a, o) => a + o.width / 1000, 0)), "m", BOQ.skirting);

  // ---- services allowances
  add("Services", "electrical", "Electrical allowance", q.floorArea, "m²", BOQ.electrical);
  add("Services", "plumbing", "Plumbing, per wet room", real.filter((r) => ["bathroom", "kitchen", "laundry"].includes(r.type)).length, "room", BOQ.plumbing);

  // ---- site and exterior features
  const w = bbAll.empty ? 0 : (bbAll.x1 - bbAll.x0) / 1000, d = bbAll.empty ? 0 : (bbAll.z1 - bbAll.z0) / 1000;
  if (!bbAll.empty) {
    if (ex.lawn) add("Site", "lawn", "Lawn", Math.max(0, (w + 8) * (d + 15) - fp), "m²", BOQ.lawn);
    if (ex.fence) add("Site", "fence", "Fence and gate", ((w + 8) * 2 + (d + 15) * 2), "m", BOQ.fence);
    if (ex.trees) add("Site", "tree", "Trees", 4, "pc", BOQ.tree);
    if (ex.driveway) add("Site", "driveway", "Driveway and path", 7 * 3 + (w + 3) * 2.8, "m²", BOQ.driveway);
    if (ex.parking) add("Site", "parkingBay", "Parking bay", 3.1 * 5.6, "m²", BOQ.parkingBay);
    if (ex.porch) add("Site", "porch", "Covered entrance porch", 1, "pc", BOQ.porch);
    if (ex.lights) add("Site", "entranceLight", "Entrance lights", 2, "pc", BOQ.entranceLight);
    if (ex.solar) add("Site", "solar", "Solar panels", Math.max(1, Math.min(4, Math.floor(w / 2.4))), "pc", BOQ.solar);
  }

  // ---- furniture and fittings (a customer's car is not part of construction)
  const byType = {};
  D.items.forEach((i) => { (byType[i.type] = byType[i.type] || []).push(i); });
  Object.entries(byType).forEach(([t, arr]) => {
    if (t === "car") return;
    const run = t === "kitchen" || t === "wallcab";
    add(t === "stairs" ? "Structure" : "Furniture & fittings", "item:" + t, CAT[t] ? CAT[t].name : t, arr.reduce((a, i) => a + (run ? i.size.L / 2400 : 1), 0), run ? "run of 2.4 m" : "pc", PRICES[t] ?? 100);
  });

  const subtotal = lines.reduce((a, l) => a + l.total, 0);
  const cont = Math.round((subtotal * (+cost.cont || 0)) / 100), over = Math.round((subtotal * (+cost.over || 0)) / 100);
  const tax = Math.round(((subtotal + cont + over) * (+cost.tax || 0)) / 100);
  const markups = [["cont", "Contingency", cost.cont, cont], ["over", "Overhead and profit", cost.over, over], ["tax", "Tax", cost.tax, tax]].filter((m) => m[3] > 0).map(([key, label, pct, amount]) => ({ key, label, pct: +pct || 0, amount }));
  return { lines, subtotal, markups, total: subtotal + cont + over + tax, cur: cost.cur || CURRENCY, q };
}

/* ================================================================== */
/* 3D structure (walls, floors, openings)                              */
/* ================================================================== */
export function disposeTree(o) {
  o.traverse((n) => {
    if (n.geometry && n.geometry !== BOX && n.geometry !== CYL && n.geometry !== SPH) n.geometry.dispose();
    if (n.material && !n.material.userData.shared) [].concat(n.material).forEach((m) => { ["map", "bumpMap", "roughnessMap", "normalMap"].forEach((k) => { if (m[k] && !(m[k].userData && m[k].userData.shared)) m[k].dispose(); }); m.dispose(); });
  });
}

const FLOOR_BUMP = { wood: 0.004, parquet: 0.004, tile: 0.01, marble: 0.002, concrete: 0.004, carpet: 0.012, stone: 0.012 };
const FLOOR_ROUGH = { wood: 0.55, parquet: 0.5, tile: 0.3, marble: 0.18, concrete: 0.55, carpet: 1, stone: 0.7 };
const FLOOR_COAT = { wood: 0.12, parquet: 0.15, tile: 0.45, marble: 0.7, concrete: 0.1, carpet: 0, stone: 0.05 };
const WALL_BUMP = { brick: 0.012, stone: 0.012, siding: 0.01, timber: 0.01, wood: 0.008, concrete: 0.004, stucco: 0.003, plaster: 0.003, paint: 0.0015 };

/* One wall/ceiling/etc. material: textures are shared and sized in real metres (UVs come from tileBoxUV). */
function finishMaterial(finish, color, extra = {}) {
  const o = { color, roughness: finish === "wood" ? 0.55 : finish === "stone" ? 1 : finish === "concrete" ? 0.9 : 0.88, envMapIntensity: 0.55, ...extra };
  if (typeof document !== "undefined") { const t = wallTexture(finish); o.map = t.map; o.bumpMap = t.bump; o.bumpScale = WALL_BUMP[finish] ?? 0.004; }
  return new THREE.MeshStandardMaterial(o);
}
/* For ExtrudeGeometry / ShapeGeometry (UVs already in metres): clone the shared textures and set the repeat. */
function worldFinishMaterial(finish, color, extra = {}) {
  const m = finishMaterial(finish, color, extra), tile = WALL_TILE[finish] || 2;
  if (m.map) { m.map = m.map.clone(); m.map.needsUpdate = true; m.map.repeat.set(1 / tile, 1 / tile); }
  if (m.bumpMap) { m.bumpMap = m.bumpMap.clone(); m.bumpMap.needsUpdate = true; m.bumpMap.repeat.set(1 / tile, 1 / tile); }
  return m;
}

export function buildStructure(D, bb, ctx) {
  const root = new THREE.Group();
  const wallGroups = [], opGroups = new Map(), floorMeshes = new Map(), glassMats = [], collide = [];
  const H = storeyH(D) * MM, maxL = ctx.maxLevel ?? 99, ext = !!ctx.exterior;
  const hasDoc = typeof document !== "undefined";
  const finish = ext ? ctx.finish || "stucco" : ctx.inFinish || "paint", tileM = WALL_TILE[finish] || 2;

  const wallOptions = { color: ctx.wallColor, roughness: ext ? (finish === "stone" ? 1 : 0.85) : finish === "wood" ? 0.6 : 0.95, transparent: true, opacity: ctx.wallOp, envMapIntensity: 0.55 };
  if (hasDoc) { const wt = wallTexture(finish); wallOptions.map = wt.map; wallOptions.bumpMap = wt.bump; wallOptions.bumpScale = WALL_BUMP[finish] ?? 0.004; }
  const wallMat = new THREE.MeshStandardMaterial(wallOptions);
  const upperWallMat = new THREE.MeshStandardMaterial({ ...wallOptions, color: "#333740", roughness: 0.72 });
  wallMat.depthWrite = ctx.wallOp > 0.95;
  upperWallMat.depthWrite = ctx.wallOp > 0.95;

  // frame material: PVC (default), aluminium or timber
  const frameKind = ctx.frame || "pvc", plain = ctx.trim === "#ffffff";
  const frameOpts = frameKind === "alu" ? { color: ext && !plain ? ctx.trim : "#3a3f45", metalness: 0.85, roughness: 0.32 }
    : frameKind === "timber" ? { color: ext && !plain ? ctx.trim : "#a9835b", roughness: 0.6, metalness: 0 }
      : { color: ctx.trim, roughness: 0.4, metalness: 0.2 };
  if (frameKind === "timber" && hasDoc) { const gt = woodGrainTexture(); frameOpts.map = gt.map; frameOpts.bumpMap = gt.bump; frameOpts.bumpScale = 0.003; }
  const frameMat = new THREE.MeshStandardMaterial(frameOpts);
  const sillMat = new THREE.MeshStandardMaterial({ color: ext ? "#d7d3ca" : ctx.trim, roughness: 0.55 });
  const skirtMat = new THREE.MeshStandardMaterial({ color: "#f1f1ef", roughness: 0.5 });
  const metalMat = new THREE.MeshStandardMaterial({ color: 0xb9bfc6, metalness: 0.85, roughness: 0.28 });
  const grain = hasDoc ? woodGrainTexture() : null;
  // physically based glass: strong environment reflections, low opacity; windows glow warm at night (see time-of-day effect)
  const glassMat = new THREE.MeshPhysicalMaterial({ color: ext ? 0x9fc6d8 : 0xcfe6f2, transparent: true, opacity: ext ? 0.32 : 0.2, roughness: 0.04, metalness: 0, envMapIntensity: ext ? 2 : 1.2, clearcoat: 1, clearcoatRoughness: 0.03, side: THREE.DoubleSide, depthWrite: false, emissive: 0xffd9a0, emissiveIntensity: 0 });
  glassMats.push(glassMat);
  const slabMat = new THREE.MeshStandardMaterial({ color: 0xdadde2, roughness: 1 });
  const ceilMat = new THREE.MeshStandardMaterial({ color: "#f7f7f5", roughness: 0.95, side: THREE.BackSide });

  D.rooms.forEach((r) => {
    const lv = r.lv || 0, kind = r.floor || ROOM_TYPES[r.type].floor;
    if (lv > maxL || kind === "none") return;
    const shape = new THREE.Shape(r.poly.map(([x, z]) => new THREE.Vector2(x * MM, -z * MM)));
    stairHolesFor(D, r).forEach((h) => shape.holes.push(new THREE.Path(h.map(([x, z]) => new THREE.Vector2(x * MM, -z * MM)))));
    const base = ctx.floorTex[kind] || ctx.floorTex.concrete, rep = 1 / ((FLOOR_SIZE[kind] || 1200) * MM);
    const tex = base.clone(); tex.needsUpdate = true; tex.repeat.set(rep, rep);
    const bump = (ctx.floorTex[kind + ":b"] || ctx.floorTex["concrete:b"]).clone(); bump.needsUpdate = true; bump.repeat.set(rep, rep);
    const fm = new THREE.MeshPhysicalMaterial({ map: tex, bumpMap: bump, bumpScale: FLOOR_BUMP[kind] ?? 0.004, roughness: FLOOR_ROUGH[kind] ?? 0.5, metalness: 0, clearcoat: FLOOR_COAT[kind] ?? 0, clearcoatRoughness: 0.2, envMapIntensity: 0.7, transparent: true, opacity: ctx.floorOp, side: THREE.DoubleSide });
    const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), fm);
    m.rotation.x = -Math.PI / 2;
    m.position.y = lv * H + 0.001;
    m.receiveShadow = true;
    m.userData = { kind: "room", id: r.id, level: lv };
    root.add(m);
    floorMeshes.set(r.id, m);
    if (lv > 0) {
      const sm = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.2, bevelEnabled: false }), slabMat);
      sm.rotation.x = -Math.PI / 2;
      sm.position.y = lv * H - 0.2;
      sm.castShadow = sm.receiveShadow = true;
      root.add(sm);
    }
    // ceilings are only drawn for the walkthrough, and only where no floor sits above the room
    if (ctx.ceilings) {
      const c = polyCentroid(r.poly);
      const covered = D.rooms.some((q) => (q.lv || 0) === lv + 1 && q.type !== "void" && inPoly([c.x, c.z], rectPoly(q)));
      if (!covered) {
        const cm = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(r.poly.map(([x, z]) => new THREE.Vector2(x * MM, -z * MM)))), ceilMat);
        cm.rotation.x = -Math.PI / 2; cm.position.y = (lv + 1) * H - 0.003; cm.receiveShadow = true; root.add(cm);
      }
    }
  });
  const sw = (bb.x1 - bb.x0) * MM + 0.5, sd = (bb.z1 - bb.z0) * MM + 0.5;
  const slab = new THREE.Mesh(new THREE.BoxGeometry(sw, 0.116, sd), slabMat);
  slab.position.set(((bb.x0 + bb.x1) / 2) * MM, -0.06, ((bb.z0 + bb.z1) / 2) * MM);
  slab.receiveShadow = true;
  root.add(slab);

  mergeWalls(D).forEach((sg) => {
    const lv = sg.lv || 0;
    if (lv > maxL) return;
    const [ax, az] = sg.a, [bx, bz] = sg.b;
    const L = Math.hypot(bx - ax, bz - az) * MM;
    if (L < 0.05) return;
    const WH = sg.wh ? sg.wh * MM : H, t = sg.t * MM, phi = Math.atan2(bz - az, bx - ax);
    const g = new THREE.Group();
    g.position.set(((ax + bx) / 2) * MM, lv * H, ((az + bz) / 2) * MM);
    g.rotation.y = -phi;
    const ext2 = t / 2 - 0.002, xa = -L / 2 - ext2, xb = L / 2 + ext2;
    const baseWallMat = ext && ctx.facade === "modern" && lv > 0 ? upperWallMat : wallMat;
    const shadow = (m, cast = true) => { m.castShadow = cast; m.receiveShadow = true; return m; };
    const box = (parent, w, h, d, x, y, z, mat, cast = true) => { const m = shadow(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat), cast); m.position.set(x, y, z); parent.add(m); return m; };
    const wb = (x0, x1, y0, y1, mat = baseWallMat) => {
      if (x1 - x0 < 0.002 || y1 - y0 < 0.002) return;
      const geo = new THREE.BoxGeometry(x1 - x0, y1 - y0, t);
      if (mat === baseWallMat && mat.map) tileBoxUV(geo, x1 - x0, y1 - y0, t, tileM, x0 + L / 2, y0);
      const m = shadow(new THREE.Mesh(geo, mat));
      m.position.set((x0 + x1) / 2, (y0 + y1) / 2, 0);
      g.add(m);
    };
    const skirt = (x0, x1) => {
      if (ext || ctx.noSkirting) return;
      const a = Math.max(x0, -L / 2), b = Math.min(x1, L / 2);
      if (b - a < 0.05) return;
      [1, -1].forEach((sd2) => box(g, b - a, 0.1, 0.012, (a + b) / 2, 0.05, sd2 * (t / 2 + 0.006), skirtMat, false));
    };
    const solids = [];   // [x0, x1] spans a walking visitor cannot pass through
    let cur = xa;

    /* ----- door ----- */
    const addDoor = (og, o, l, r, oh) => {
      const w = r - l, fr = 0.055, fd = Math.min(t + 0.03, 0.34), style = o.style || "panel";
      box(og, fr, oh, fd, l + fr / 2, oh / 2, 0, frameMat);
      box(og, fr, oh, fd, r - fr / 2, oh / 2, 0, frameMat);
      box(og, w, fr, fd, (l + r) / 2, oh - fr / 2, 0, frameMat);
      box(og, w - 2 * fr, 0.02, t + 0.02, (l + r) / 2, 0.01, 0, sillMat, false);
      const iw = w - 2 * fr, ih = oh - fr - 0.02, mid = (l + r) / 2;
      const leafMat = new THREE.MeshStandardMaterial({ color: o.color, roughness: 0.55, ...(grain ? { map: grain.map, bumpMap: grain.bump, bumpScale: 0.004 } : {}) });
      const leaf = (lw, lh) => {
        const lg = new THREE.Group();
        if (style === "glass") {
          const st = 0.09;
          box(lg, st, lh, 0.045, st / 2, lh / 2, 0, leafMat); box(lg, st, lh, 0.045, lw - st / 2, lh / 2, 0, leafMat);
          box(lg, lw, 0.26, 0.045, lw / 2, 0.13, 0, leafMat); box(lg, lw, st, 0.045, lw / 2, lh - st / 2, 0, leafMat);
          const gl = new THREE.Mesh(new THREE.PlaneGeometry(lw - 2 * st, lh - 0.26 - st), glassMat); gl.position.set(lw / 2, 0.26 + (lh - 0.26 - st) / 2, 0); lg.add(gl);
        } else {
          box(lg, lw, lh, 0.042, lw / 2, lh / 2, 0, leafMat);
          if (style !== "flush") [[0.7, 0.36, 0.74], [0.7, 0.2, 0.26]].forEach(([fw, fh, fy]) => [1, -1].forEach((sd2) => box(lg, lw * fw, lh * fh, 0.012, lw / 2, lh * fy, sd2 * 0.025, leafMat, false)));
        }
        return lg;
      };
      const handle = (parent, x, y) => [1, -1].forEach((sd2) => { box(parent, 0.012, 0.012, 0.05, x, y, sd2 * 0.05, metalMat, false); box(parent, 0.11, 0.016, 0.016, x - 0.045 * Math.sign(x || 1), y, sd2 * 0.075, metalMat, false); });
      const swing = o.flip ? -1 : 1, ang = 1.15;
      if (style === "sliding") {
        const pw = iw / 2 + 0.03, th = 0.04;
        [[-1, l + fr + pw / 2 - 0.03], [1, r - fr - pw / 2 + 0.03]].forEach(([side, cx2]) => {
          box(og, pw, 0.045, th, cx2, 0.04, side * 0.03, frameMat); box(og, pw, 0.045, th, cx2, ih - 0.02, side * 0.03, frameMat);
          box(og, 0.045, ih, th, cx2 - pw / 2 + 0.0225, ih / 2, side * 0.03, frameMat); box(og, 0.045, ih, th, cx2 + pw / 2 - 0.0225, ih / 2, side * 0.03, frameMat);
          const gl = new THREE.Mesh(new THREE.PlaneGeometry(pw - 0.09, ih - 0.09), glassMat); gl.position.set(cx2, ih / 2, side * 0.03); og.add(gl);
        });
        box(og, 0.02, 0.4, 0.02, mid - 0.04, 1.0, 0.055, metalMat, false);
        return;
      }
      if (style === "double") {
        const lw = iw / 2 - 0.005;
        [["l", l + fr + 0.005, 1], ["r", r - fr - 0.005, -1]].forEach(([, px, dirX]) => {
          const pv = new THREE.Group(); pv.position.set(px, 0.02, 0);
          pv.rotation.y = -ang * dirX * swing;
          const lf = leaf(lw, ih); if (dirX < 0) lf.scale.x = -1; pv.add(lf);
          handle(pv, dirX * (lw - 0.07), 1.0);
          og.add(pv);
        });
        return;
      }
      const dirX = o.hinge === "r" ? -1 : 1, lw = iw - 0.01;
      const pv = new THREE.Group(); pv.position.set(dirX > 0 ? l + fr + 0.005 : r - fr - 0.005, 0.02, 0);
      pv.rotation.y = -ang * dirX * swing;
      const lf = leaf(lw, ih); if (dirX < 0) lf.scale.x = -1; pv.add(lf);
      handle(pv, dirX * (lw - 0.07), 1.0);
      og.add(pv);
    };

    /* ----- window ----- */
    const addWindow = (og, o, l, r, sill, oh) => {
      const w = r - l, fr = ext ? 0.06 : 0.055, fd = Math.min(t * 0.75, 0.11), mid = (l + r) / 2, style = o.style || "casement";
      box(og, w, fr, fd, mid, sill + fr / 2, 0, frameMat); box(og, w, fr, fd, mid, sill + oh - fr / 2, 0, frameMat);
      box(og, fr, oh - 2 * fr, fd, l + fr / 2, sill + oh / 2, 0, frameMat); box(og, fr, oh - 2 * fr, fd, r - fr / 2, sill + oh / 2, 0, frameMat);
      const gw = w - 2 * fr, gh = oh - 2 * fr, gy = sill + oh / 2;
      const pane = (x0, x1, z) => {
        const pw = x1 - x0, sf = 0.035;
        if (pw < 0.1) return;
        const gl = new THREE.Mesh(new THREE.PlaneGeometry(pw - (z ? 0.06 : 0), gh - (z ? 0.06 : 0)), glassMat); gl.position.set((x0 + x1) / 2, gy, z); og.add(gl);
        if (z) { box(og, pw, sf, 0.035, (x0 + x1) / 2, sill + oh - fr - sf / 2, z, frameMat); box(og, pw, sf, 0.035, (x0 + x1) / 2, sill + fr + sf / 2, z, frameMat); box(og, sf, gh, 0.035, x0 + sf / 2, gy, z, frameMat); box(og, sf, gh, 0.035, x1 - sf / 2, gy, z, frameMat); }
      };
      if (style === "sliding") { pane(l + fr, mid + 0.025, -0.02); pane(mid - 0.025, r - fr, 0.02); }
      else {
        const cols = style === "fixed" ? 1 : Math.max(1, Math.min(6, o.panes || (w > 1.1 ? 2 : 1))), pw = gw / cols;
        for (let i = 0; i < cols; i++) {
          pane(l + fr + i * pw, l + fr + (i + 1) * pw, 0);
          if (i > 0) box(og, fr * 0.7, gh, fd * 0.9, l + fr + i * pw, gy, 0, frameMat);
        }
        if (style === "casement" && o.h > 1500) box(og, gw, fr * 0.6, fd * 0.9, mid, sill + oh * 0.72, 0, frameMat);
      }
      box(og, r - l + 0.16, 0.07, t + 0.1, mid, sill - 0.035, 0, sillMat);
      if (ext) box(og, r - l + 0.12, 0.1, t + 0.04, mid, sill + oh + 0.05, 0, sillMat);
    };

    [...sg.ops].sort((p, q) => p.pos - q.pos).forEach((o) => {
      const cx = (o.pos - 0.5) * L, w = o.width * MM, isWin = o.type === "window";
      const sill = (isWin ? o.sill || 0 : 0) * MM;
      const oh = Math.min(o.h * MM, WH - sill - 0.05);
      const l = Math.max(cur, cx - w / 2), r = Math.min(xb, cx + w / 2);
      if (r <= l) return;
      wb(cur, l, 0, WH); wb(l, r, 0, sill); wb(l, r, sill + oh, WH);
      skirt(cur, l); if (sill > 0.15) skirt(l, r);
      solids.push([cur, l]);
      cur = r;
      const og = new THREE.Group();
      og.userData = { kind: "op", id: o.id, level: lv };
      g.add(og);
      opGroups.set(o.id, og);
      if (isWin) { addWindow(og, o, l, r, sill, oh); solids.push([l, r]); }
      else { addDoor(og, o, l, r, oh); if (oh < 1.8) solids.push([l, r]); }
    });
    wb(cur, xb, 0, WH);
    skirt(cur, xb);
    solids.push([cur, xb]);

    // collision spans in world coordinates (metres) for the walkthrough
    const cxw = ((ax + bx) / 2) * MM, czw = ((az + bz) / 2) * MM, cph = Math.cos(phi), sph = Math.sin(phi);
    solids.forEach(([s0, s1]) => { if (s1 - s0 > 0.01) collide.push({ lv, ax: cxw + cph * s0, az: czw + sph * s0, bx: cxw + cph * s1, bz: czw + sph * s1, t }); });

    let edge = null;
    if (sg.axis) {
      if (sg.h && Math.abs(az - bb.z0) < 120) edge = "N";
      else if (sg.h && Math.abs(az - bb.z1) < 120) edge = "S";
      else if (!sg.h && Math.abs(ax - bb.x0) < 120) edge = "W";
      else if (!sg.h && Math.abs(ax - bb.x1) < 120) edge = "E";
    }
    g.userData = { kind: "wall", edge, level: lv, members: sg.members, axis: !!sg.axis, horiz: !!sg.h, start: sg.axis ? (sg.h ? sg.a[0] : sg.a[1]) : 0, L };
    root.add(g);
    wallGroups.push(g);
  });
  return { root, wallGroups, opGroups, floorMeshes, glassMats, collide };
}

/* ================================================================== */
/* Roof geometry (pure) + 3D exterior (storeys, roof, garden)          */
/* ================================================================== */
/* Faces of a pitched roof in a canonical frame: ridge along x, span along z, origin at the eave level in the middle.
   L = length along the ridge, S = span, pitch in radians. Every face is wound counter-clockwise seen from outside. */
export function roofFaces(style, L, S, pitch) {
  const hl = L / 2, hs = S / 2;
  if (style === "shed") {
    const rise = S * Math.tan(pitch);
    return [[[-hl, 0, hs], [hl, 0, hs], [hl, rise, -hs], [-hl, rise, -hs]]];
  }
  const rise = hs * Math.tan(pitch);
  if (style === "hip") {
    const rl = Math.max(0, (L - S) / 2);
    const f = [[[-hl, 0, hs], [hl, 0, hs], [rl, rise, 0], [-rl, rise, 0]], [[hl, 0, -hs], [-hl, 0, -hs], [-rl, rise, 0], [rl, rise, 0]],
      [[hl, 0, hs], [hl, 0, -hs], [rl, rise, 0]], [[-hl, 0, -hs], [-hl, 0, hs], [-rl, rise, 0]]];
    return f;
  }
  return [[[-hl, 0, hs], [hl, 0, hs], [hl, rise, 0], [-hl, rise, 0]], [[hl, 0, -hs], [-hl, 0, -hs], [-hl, rise, 0], [hl, rise, 0]]];
}
/* Effective roof pitch in radians: flat = 0, shed roofs use half the pitch (min 4 deg, max 25 deg). */
export const roofPitchFor = (ext) => {
  if (!ext || ext.roof === "flat") return 0;
  const p = clamp(ext.roofPitch ?? 24, 5, 60);
  return ((ext.roof === "shed" ? clamp(p / 2, 4, 25) : p) * Math.PI) / 180;
};
function facesGeometry(faces, tileM = 1) {
  const pos = [], uv = [], idx = [];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  faces.forEach((f) => {
    const e1 = sub(f[1], f[0]), n = unit(cross(e1, sub(f[2], f[0]))), u = unit(e1), v = cross(n, u), base = pos.length / 3;
    f.forEach((p) => { pos.push(p[0], p[1], p[2]); const d = sub(p, f[0]); uv.push(dot(d, u) / tileM, dot(d, v) / tileM); });
    for (let i = 1; i < f.length - 1; i++) idx.push(base, base + i, base + i + 1);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}
function roofMaterial(e) {
  const kind = e.roof === "flat" ? (e.roofMat === "metal" ? "metal" : "concrete") : e.roofMat || "tile";
  const o = { color: e.roofColor, roughness: kind === "metal" ? 0.38 : kind === "tile" ? 0.7 : 0.88, metalness: kind === "metal" ? 0.7 : 0.02, side: THREE.DoubleSide, envMapIntensity: kind === "metal" ? 1.4 : 0.6 };
  if (typeof document !== "undefined") { const t = roofTexture(kind); o.map = t.map; o.bumpMap = t.bump; o.bumpScale = { tile: 0.01, shingle: 0.008, metal: 0.006, concrete: 0.003 }[kind]; }
  return new THREE.MeshStandardMaterial(o);
}

export function buildExterior(D, bb) {
  const e = D.ext, H = storeyH(D) * MM, g = new THREE.Group();
  const x0 = bb.x0 * MM, x1 = bb.x1 * MM, z0 = bb.z0 * MM, z1 = bb.z1 * MM, w = x1 - x0, d = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const std = (color, r = 0.9) => new THREE.MeshStandardMaterial({ color, roughness: r });
  const add = (geo, mat, x, y, z, ry = 0, shadow = true) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.y = ry; m.castShadow = m.receiveShadow = shadow; g.add(m); return m; };
  const wallM = std(e.wall), darkM = std("#30343a", 0.78), trimM = std(e.trim, 0.5), roofM = roofMaterial(e);

  if (e.lawn) {
    const groundSize = Math.max(90, w + 30, d + 30);
    const grass = canvasTex((ctx, size) => {
      let seed = 91;
      const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
      ctx.fillStyle = "#8daa70";
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 12000; i++) {
        const shade = Math.round(72 + rand() * 80), alpha = 0.12 + rand() * 0.38;
        ctx.fillStyle = `rgba(${shade - 24},${shade},${shade - 35},${alpha})`;
        ctx.fillRect(rand() * size, rand() * size, 1 + rand() * 2, 2 + rand() * 4);
      }
    });
    grass.repeat.set(18, 18);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(groundSize, groundSize), new THREE.MeshStandardMaterial({ color: "#e1ead9", map: grass, bumpMap: grass, bumpScale: 0.035, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(cx, -0.118, cz); ground.receiveShadow = true; g.add(ground);
  }

  for (let s = Math.max(1, D.levels || 1); s < e.storeys; s++) {
    add(new THREE.BoxGeometry(w, H, d), e.facade === "modern" && s > 0 ? darkM : wallM, cx, H * s + H / 2, cz);
    add(new THREE.BoxGeometry(w + 0.34, 0.22, d + 0.34), trimM, cx, H * s, cz);
    const sides = [[w, 0, cz + d / 2 + 0.03, 0], [w, 0, cz - d / 2 - 0.03, Math.PI], [d, cx + w / 2 + 0.03, 0, Math.PI / 2], [d, cx - w / 2 - 0.03, 0, -Math.PI / 2]];
    sides.forEach(([len, px, pz, ry]) => {
      const n = Math.max(1, Math.floor(len / 2));
      for (let i = 0; i < n; i++) {
        const o = (i + 0.5) / n * len - len / 2;
        const wx = ry === 0 || ry === Math.PI ? cx + o : px, wz = ry === 0 || ry === Math.PI ? pz : cz + o;
        const grp = new THREE.Group();
        grp.position.set(wx, H * s + 1.5, wz); grp.rotation.y = ry;
        const fr = new THREE.Mesh(BOX, trimM); fr.scale.set(1.3, 1.3, 0.05); grp.add(fr);
        const gl = new THREE.Mesh(BOX, new THREE.MeshStandardMaterial({ color: 0x9fc6e0, roughness: 0.1, metalness: 0.3 })); gl.scale.set(1.15, 1.15, 0.07); grp.add(gl);
        g.add(grp);
      }
    });
  }

  const levels = Math.max(D.levels || 1, 1), storeysTotal = Math.max(levels, e.storeys || 1), top = H * storeysTotal, massing = storeysTotal > levels;
  const fpOf = (lv) => { const b = bboxOfLevel(D, lv); return b.empty ? bb : b; };
  // the roof sits on the top floor's footprint (not the whole building) unless extra massing storeys were added
  const rb = massing ? bb : fpOf(levels - 1);
  const rw = (rb.x1 - rb.x0) * MM, rd = (rb.z1 - rb.z0) * MM, rcx = ((rb.x0 + rb.x1) / 2) * MM, rcz = ((rb.z0 + rb.z1) / 2) * MM;
  const ov = clamp(e.overhang ?? 450, 0, 1500) * MM, pitch = roofPitchFor(e);

  // terraces: where a lower floor extends past the floor above, close it with a flat slab
  if (!massing && levels > 1) {
    const terraceMat = new THREE.MeshStandardMaterial({ color: "#b4b8bc", roughness: 0.9 });
    const tt = typeof document !== "undefined" ? roofTexture("concrete") : null;
    if (tt) { terraceMat.map = tt.map; terraceMat.bumpMap = tt.bump; terraceMat.bumpScale = 0.003; }
    for (let lvl = 0; lvl < levels - 1; lvl++) {
      const above = D.rooms.filter((q) => (q.lv || 0) === lvl + 1 && q.type !== "void").map(rectPoly);
      D.rooms.filter((r) => (r.lv || 0) === lvl && r.type !== "void").forEach((r) => {
        const b = polyBox(r.poly), step = 200, blocks = [];
        for (let zc = b.z + step / 2; zc < b.z + b.d; zc += step) {
          let run = null;
          for (let xc = b.x + step / 2; xc < b.x + b.w; xc += step) {
            const open = inPoly([xc, zc], r.poly) && !above.some((P2) => inPoly([xc, zc], P2));
            if (!open) { run = null; continue; }
            if (run && Math.abs(run.x1 - (xc - step / 2)) < 1) run.x1 = xc + step / 2;
            else { run = { x0: xc - step / 2, x1: xc + step / 2, z0: zc - step / 2, z1: zc + step / 2 }; blocks.push(run); }
          }
        }
        // merge rows that share the same x-span into taller blocks
        const merged = [];
        blocks.forEach((bk) => { const m = merged.find((q) => Math.abs(q.x0 - bk.x0) < 1 && Math.abs(q.x1 - bk.x1) < 1 && Math.abs(q.z1 - bk.z0) < 1); if (m) m.z1 = bk.z1; else merged.push({ ...bk }); });
        merged.forEach((bk) => {
          const bw = (bk.x1 - bk.x0) * MM, bd = (bk.z1 - bk.z0) * MM;
          const geo = new THREE.BoxGeometry(bw, 0.17, bd);
          if (terraceMat.map) tileBoxUV(geo, bw, 0.17, bd, 1);
          const m = new THREE.Mesh(geo, terraceMat);
          m.position.set(((bk.x0 + bk.x1) / 2) * MM, (lvl + 1) * H - 0.065, ((bk.z0 + bk.z1) / 2) * MM);
          m.castShadow = m.receiveShadow = true; g.add(m);
        });
      });
    }
  }

  if (e.facade === "modern") {
    for (let s = 1; s < storeysTotal; s++) {
      const a = fpOf(Math.min(s - 1, levels - 1)), c = fpOf(Math.min(s, levels - 1)), u = massing ? bb : { x0: Math.min(a.x0, c.x0), x1: Math.max(a.x1, c.x1), z0: Math.min(a.z0, c.z0), z1: Math.max(a.z1, c.z1) };
      add(new THREE.BoxGeometry((u.x1 - u.x0) * MM + 0.42, 0.18, (u.z1 - u.z0) * MM + 0.42), trimM, ((u.x0 + u.x1) / 2) * MM, H * s, ((u.z0 + u.z1) / 2) * MM);
    }
    const finCount = Math.max(4, Math.min(8, Math.floor(H * storeysTotal / 0.55)));
    for (let i = 0; i < finCount; i++) {
      const fx = x1 - 0.24 - i * 0.16;
      add(new THREE.BoxGeometry(0.075, Math.max(1, top - 0.45), 0.11), darkM, fx, Math.max(1, top - 0.45) / 2, z1 + 0.075);
    }
    add(new THREE.BoxGeometry(rw + 0.7, 0.16, rd + 0.7), darkM, rcx, top + 0.04, rcz);
  }
  let roofInfo = { style: e.roof, top, rcx, rcz, rw, rd, ov, pitch };
  if (e.roof === "flat") {
    add(new THREE.BoxGeometry(rw + ov * 2, 0.22, rd + ov * 2), roofM, rcx, top + 0.11, rcz);
    [[rw + ov * 2, 0.15, rcx, rcz + rd / 2 + ov], [rw + ov * 2, 0.15, rcx, rcz - rd / 2 - ov]].forEach(([l, t, px, pz]) => add(new THREE.BoxGeometry(l, 0.4, t), trimM, px, top + 0.35, pz));
    [[0.15, rd + ov * 2, rcx + rw / 2 + ov, rcz], [0.15, rd + ov * 2, rcx - rw / 2 - ov, rcz]].forEach(([t, l, px, pz]) => add(new THREE.BoxGeometry(t, 0.4, l), trimM, px, top + 0.35, pz));
  } else {
    const ridgeX = e.roof === "hip" ? rw >= rd : e.ridge === "x" ? true : e.ridge === "z" ? false : rw >= rd;
    const Lr = (ridgeX ? rw : rd) + 2 * ov, Sr = (ridgeX ? rd : rw) + 2 * ov, Lb = ridgeX ? rw : rd, Sb = ridgeX ? rd : rw;
    const rg = new THREE.Group();
    rg.position.set(rcx, top, rcz);
    rg.rotation.y = ridgeX ? 0 : Math.PI / 2;
    const surface = new THREE.Mesh(facesGeometry(roofFaces(e.roof, Lr, Sr, pitch), 1), roofM);
    surface.castShadow = surface.receiveShadow = true;
    rg.add(surface);
    const fascia = (w2, d2, x, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w2, 0.14, d2), trimM); m.position.set(x, -0.05, z); m.castShadow = true; rg.add(m); };
    fascia(Lr, 0.05, 0, Sr / 2);
    if (e.roof !== "shed") fascia(Lr, 0.05, 0, -Sr / 2);
    if (e.roof === "hip") { fascia(0.05, Sr, Lr / 2, 0); fascia(0.05, Sr, -Lr / 2, 0); }
    // gable / shed roofs leave open triangular or trapezoid ends: fill them with wall
    if (e.roof === "gable" || e.roof === "shed") {
      const gableMat = typeof document !== "undefined" ? worldFinishMaterial(e.finish || "stucco", e.wall) : std(e.wall);
      const h1 = ov * Math.tan(pitch);
      let pts;
      if (e.roof === "gable") pts = [[-Sb / 2, 0], [Sb / 2, 0], [Sb / 2, h1], [0, (Sr / 2) * Math.tan(pitch)], [-Sb / 2, h1]];
      else { const rise = Sr * Math.tan(pitch), yAt = (z) => (rise * (Sr / 2 - z)) / Sr; pts = [[-Sb / 2, 0], [Sb / 2, 0], [Sb / 2, yAt(Sb / 2)], [-Sb / 2, yAt(-Sb / 2)]]; }
      const shape = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(-z, y)));
      [[-1, 0], [1, -0.22]].forEach(([end, off]) => {
        const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.22, bevelEnabled: false });
        geo.rotateY(Math.PI / 2);
        const m = new THREE.Mesh(geo, gableMat);
        m.position.set(end * (Lb / 2) + off, 0, 0);
        m.castShadow = m.receiveShadow = true;
        rg.add(m);
      });
    }
    g.add(rg);
    roofInfo = { ...roofInfo, rg, ridgeX, Lr, Sr };
  }

  const door = D.openings.find((o) => { const wl = D.walls.find((q) => q.id === o.wallId); return o.type === "door" && (o.lv || 0) === 0 && wl && axisOf(wl) === "h" && Math.abs(wl.a[1] - bb.z1) < 120; });
  const baseMat = std(e.facade === "modern" ? "#777b7b" : "#c1b9aa", 0.82);
  const baseH = 0.22, baseD = 0.12;
  add(new THREE.BoxGeometry(w + baseD, baseH, baseD), baseMat, cx, baseH / 2, z0 - baseD / 2);
  add(new THREE.BoxGeometry(baseD, baseH, d + baseD), baseMat, x0 - baseD / 2, baseH / 2, cz);
  add(new THREE.BoxGeometry(baseD, baseH, d + baseD), baseMat, x1 + baseD / 2, baseH / 2, cz);
  if (door) {
    const doorWall = D.walls.find((q) => q.id === door.wallId);
    const doorX = (doorWall.a[0] + (doorWall.b[0] - doorWall.a[0]) * door.pos) * MM;
    const leftWidth = doorX - door.width * MM / 2 - x0;
    const rightWidth = x1 - (doorX + door.width * MM / 2);
    if (leftWidth > 0.1) add(new THREE.BoxGeometry(leftWidth, baseH, baseD), baseMat, x0 + leftWidth / 2, baseH / 2, z1 + baseD / 2);
    if (rightWidth > 0.1) add(new THREE.BoxGeometry(rightWidth, baseH, baseD), baseMat, x1 - rightWidth / 2, baseH / 2, z1 + baseD / 2);
  } else {
    add(new THREE.BoxGeometry(w + baseD, baseH, baseD), baseMat, cx, baseH / 2, z1 + baseD / 2);
  }
  const pipeMat = std("#666b6b", 0.62);
  const pipeHeight = Math.max(0.5, top - 0.16);
  [x0 + 0.1, x1 - 0.1].forEach((px) => {
    add(new THREE.BoxGeometry(0.075, pipeHeight, 0.075), pipeMat, px, pipeHeight / 2, z1 + 0.065);
    add(new THREE.BoxGeometry(0.12, 0.075, 0.12), pipeMat, px, 0.09, z1 + 0.08);
  });
  if (door) {
    const wl = D.walls.find((q) => q.id === door.wallId);
    const dx = (wl.a[0] + (wl.b[0] - wl.a[0]) * door.pos) * MM;
    if (e.driveway) {
      const pathWidth = Math.min(4.2, Math.max(2.6, door.width * MM + 1.4));
      add(new THREE.BoxGeometry(pathWidth, 0.1, 7), std("#b9bcc0", 1), dx, -0.1, z1 + 3.5 + 0.2);
      add(new THREE.BoxGeometry(w + 3, 0.1, 2.8), std("#c9ccd0", 1), cx, -0.1, z1 + 8.5);
      const jointMat = std("#9da2a6", 1);
      for (let i = 1; i < 6; i++) add(new THREE.BoxGeometry(pathWidth, 0.012, 0.025), jointMat, dx, -0.04, z1 + i * 1.1);
    }
    if (e.porch) {
      const porchWidth = e.facade === "modern" ? Math.min(w * 0.62, Math.max(door.width * MM + 2.2, 3.8)) : door.width * MM + 1.2;
      const canopyDepth = e.facade === "modern" ? 2.2 : 1.8;
      const canopyY = e.facade === "modern" ? 2.85 : 2.45;
      add(new THREE.BoxGeometry(porchWidth, 0.2, canopyDepth), e.facade === "modern" ? darkM : trimM, dx, canopyY, z1 + canopyDepth / 2);
      if (e.facade === "modern") add(new THREE.BoxGeometry(porchWidth - 0.18, 0.055, canopyDepth - 0.14), trimM, dx, canopyY - 0.128, z1 + canopyDepth / 2);
      [-porchWidth / 2 + 0.14, porchWidth / 2 - 0.14].forEach((x) => add(new THREE.BoxGeometry(0.14, canopyY - 0.35, 0.14), e.facade === "modern" ? darkM : trimM, dx + x, (canopyY - 0.35) / 2, z1 + canopyDepth - 0.12));
      add(new THREE.BoxGeometry(door.width * MM + 0.9, 0.12, 0.7), std("#c9ccd0", 1), dx, 0.06, z1 + 0.35);
      add(new THREE.BoxGeometry(door.width * MM + 1.1, 0.12, 0.4), std("#c9ccd0", 1), dx, 0.0, z1 + 0.85);
      if (e.facade === "modern") {
        for (let i = 0; i < 3; i++) add(new THREE.BoxGeometry(door.width * MM + 1.15 + i * 0.2, 0.12, 0.42), std("#b8b7b2", 1), dx, 0.06 + 0.12 * i, z1 + 0.35 + i * 0.42);
      }
    }
    if (e.lights) {
      const lightMat = new THREE.MeshStandardMaterial({ color: "#ffe5a3", emissive: "#ffb84d", emissiveIntensity: 1.6, roughness: 0.3 });
      [-1, 1].forEach((side) => {
        const lx = dx + side * (door.width * MM / 2 + 0.28);
        add(new THREE.BoxGeometry(0.12, 0.32, 0.12), trimM, lx, 2.05, z1 + 0.12);
        add(new THREE.SphereGeometry(0.11, 12, 10), lightMat, lx, 2.12, z1 + 0.22);
      });
    }
  }
  if (e.driveway && !door) {
    add(new THREE.BoxGeometry(2.6, 0.1, 7), std("#b9bcc0", 1), cx, -0.1, z1 + 3.7);
    add(new THREE.BoxGeometry(w + 3, 0.1, 2.8), std("#c9ccd0", 1), cx, -0.1, z1 + 8.5);
  }
  if (e.facade === "modern" && e.lawn) {
    const planterMat = std("#777c79", 0.92), soilMat = std("#554639", 1);
    [-1, 1].forEach((side) => {
      const px = cx + side * Math.max(0, w / 2 - 0.65);
      const pz = z1 + (e.driveway ? 2.1 : 1.25);
      add(new THREE.BoxGeometry(1.25, 0.34, 1.45), planterMat, px, 0.17, pz);
      add(new THREE.BoxGeometry(1.04, 0.055, 1.22), soilMat, px, 0.36, pz);
      for (let j = 0; j < 3; j++) {
        const shrub = add(new THREE.IcosahedronGeometry(0.34, 1), std(j === 1 ? "#55784f" : "#66895b", 0.96), px + (j - 1) * 0.3, 0.67, pz);
        shrub.scale.y = 0.75;
      }
    });
  }
  if (e.parking) {
    const px = x1 + 2.2, pz = z1 + 3.2, asphalt = std("#777d81", 1);
    add(new THREE.BoxGeometry(3.1, 0.1, 5.6), asphalt, px, -0.095, pz);
    [-1.35, 1.35].forEach((side) => add(new THREE.BoxGeometry(0.045, 0.012, 5.2), std("#f4e4a4", 0.8), px + side, -0.035, pz, 0, false));
    const car = buildModel("car", 0);
    car.scale.set(4.3, 1.5, 1.9);
    car.rotation.y = Math.PI / 2;
    car.position.set(px, 0.005, pz);
    g.add(car);
  }
  if (e.solar) {
    const panelMat = new THREE.MeshStandardMaterial({ color: "#243b55", roughness: 0.22, metalness: 0.4, emissive: "#0a1725", emissiveIntensity: 0.25, envMapIntensity: 1.4 });
    if (e.roof === "flat") {
      const count = Math.max(1, Math.min(4, Math.floor(rw / 2.4)));
      for (let i = 0; i < count; i++) add(new THREE.BoxGeometry(1.55, 0.06, Math.min(1.25, rd * 0.22)), panelMat, rcx + (i - (count - 1) / 2) * 1.8, top + 0.24, rcz);
    } else if (roofInfo.rg) {
      // panels sit on the slope that faces the front of the plot, in the roof's own frame (ridge along x, slope toward +z)
      const { rg, Lr, Sr } = roofInfo, rise = e.roof === "shed" ? Sr * Math.tan(pitch) : (Sr / 2) * Math.tan(pitch);
      const count = Math.max(1, Math.min(4, Math.floor(Lr / 2.4))), slopeLen = (e.roof === "shed" ? Sr : Sr / 2) / Math.cos(pitch);
      const zc = e.roof === "shed" ? 0 : Sr / 4, yc = e.roof === "shed" ? rise / 2 : rise / 2;
      const spread = e.roof === "hip" ? Math.max(0, Lr - Sr) / 2 : Lr / 2 - 0.6;
      for (let i = 0; i < count; i++) {
        const px = count === 1 ? 0 : -spread + (2 * spread * i) / (count - 1);
        const m = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.06, Math.min(1.25, slopeLen * 0.55)), panelMat);
        m.position.set(px, yc + 0.07, zc);
        m.rotation.x = pitch;
        m.castShadow = true;
        rg.add(m);
      }
    }
  }

  if (e.fence) {
    const gx0 = x0 - 4, gx1 = x1 + 4, gz0 = z0 - 4, gz1 = z1 + 11, fm = std("#f1f1ef", 0.7);
    const run = (ax, az, bx, bz) => {
      const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(L / 1.6));
      for (let i = 0; i <= n; i++) {
        const px = ax + ((bx - ax) * i) / n, pz = az + ((bz - az) * i) / n;
        if (Math.abs(pz - gz1) < 0.01 && Math.abs(px - cx) < 1.6) continue;
        add(new THREE.BoxGeometry(0.1, 1.1, 0.1), fm, px, 0.55, pz);
      }
      const rail = add(new THREE.BoxGeometry(L, 0.07, 0.04), fm, (ax + bx) / 2, 0.9, (az + bz) / 2, -Math.atan2(bz - az, bx - ax));
      rail.castShadow = false;
    };
    run(gx0, gz0, gx1, gz0); run(gx1, gz0, gx1, gz1); run(gx1, gz1, gx0, gz1); run(gx0, gz1, gx0, gz0);
  }
  if (e.trees) {
    [[x0 - 2.2, z0 - 2.4, 1.1], [x1 + 2.6, z0 - 2.8, 1.3], [x0 - 2.8, z1 + 2.5, 0.9], [x0 - 2.5, cz, 1.0]].forEach(([tx, tz, s]) => {
      add(new THREE.CylinderGeometry(0.1 * s, 0.14 * s, 1.8 * s, 10), std("#6a4a35"), tx, 0.9 * s, tz);
      const canopy = [[0, 2.65, 0, 0.9], [-0.55, 2.25, 0.12, 0.62], [0.48, 2.3, -0.1, 0.7], [0.05, 3.05, -0.4, 0.62], [-0.18, 2.55, 0.55, 0.58], [0.45, 2.75, 0.4, 0.55]];
      canopy.forEach(([ox, oy, oz, size], i) => {
        const greens = ["#4f764b", "#5f8a52", "#6d9759", "#557f4d"];
        const crown = add(new THREE.SphereGeometry(size * s, 12, 9), std(greens[i % greens.length], 0.95), tx + ox * s, oy * s, tz + oz * s);
        crown.scale.set(1, 0.82, 0.94);
      });
    });
    for (let x = x0 + 0.6; x < x1 - 0.4; x += 1.4) {
      if (Math.abs(x - cx) < 1.5) continue;
      add(new THREE.SphereGeometry(0.4, 12, 10), std("#6f9f62"), x, 0.3, z1 + 0.7);
    }
  }
  return g;
}

/* ================================================================== */
/* Room furnishing presets                                             */
/* ================================================================== */
export function furnishRoom(r, wallH = WALL_H) {
  if (!(wallH >= 2000 && wallH <= 6000)) wallH = WALL_H; // guards against Array.flatMap passing the index here
  const m = 170, ix = r.x + m, iz = r.z + m, iw = r.w - 2 * m, id = r.d - 2 * m, cx = r.x + r.w / 2, cz = r.z + r.d / 2;
  const out = [];
  const add = (type, x, z, rot = 0, ex = {}) => out.push(mk(type, Math.round(x), Math.round(z), rot, { lv: r.lv || 0, ...ex }));
  const N = (W) => iz + W / 2, Sx = (W) => iz + id - W / 2, Wx = (W) => ix + W / 2, Ex = (W) => ix + iw - W / 2;
  const diningSet = (x, z) => {
    add("dining", x, z);
    [-400, 400].forEach((o) => { add("chair", x + o, z - 720, 0); add("chair", x + o, z + 720, 180); });
    add("chair", x - 1060, z, 90); add("chair", x + 1060, z, 270);
  };
  switch (r.type) {
    case "bedroom":
      add("rug", cx, cz);
      add("bed", cx, N(2000));
      if (iw >= 3000) { add("sidetable", cx - 1180, N(500), 0, { variant: 1 }); add("sidetable", cx + 1180, N(500), 0, { variant: 1 }); }
      if (id >= 2100 && iw >= 3400) add("wardrobe", Ex(600), cz + (id > 2800 ? 300 : 0), 270);
      add("plant", Wx(400), Sx(400));
      break;
    case "nursery":
      add("crib", cx, N(800), 0, { variant: 1 });
      add("rug", cx, cz, 0, { size: { L: Math.min(1600, iw - 400), W: Math.min(1200, id - 400), H: 20 } });
      add("sidetable", Ex(500), Sx(500), 0, { variant: 1 });
      add("plant", Wx(400), Sx(400));
      break;
    case "stairwell": {
      const alongZ = r.d >= r.w, shortSide = alongZ ? r.w : r.d, longSide = alongZ ? r.d : r.w;
      if (shortSide >= 1400 && longSide >= 4400) {
        add("stairs", cx, cz, alongZ ? 0 : 90, { size: { L: Math.min(1200, shortSide - 200), W: Math.min(4200, longSide - 200), H: wallH } });
      }
      break;
    }
    case "living": {
      const wide = iw >= 5200, lx = wide ? ix + iw * 0.35 : cx;
      add("rug", lx, cz);
      add("tvunit", lx, N(400));
      add("coffee", lx, cz - 100);
      add("sofa", lx, cz + 800, 180);
      add("lamp", Math.max(ix + 200, lx - 1450), N(350));
      add("plant", Wx(400), Sx(400));
      if (wide) diningSet(ix + iw * 0.78, cz);
      break;
    }
    case "media":
      add("tvunit", cx, N(400));
      add("rug", cx, cz, 0, { size: { L: Math.min(2600, iw - 400), W: Math.min(1800, id - 400), H: 20 } });
      add("coffee", cx, cz);
      add("sofa", cx, Sx(900), 0, { variant: 2 });
      add("lamp", Wx(350), Sx(350));
      break;
    case "dining": diningSet(cx, cz); add("plant", Wx(400), Sx(400)); break;
    case "kitchen": {
      const L = Math.max(900, Math.min(2400, iw - 720));
      add("kitchen", ix + L / 2, N(600), 0, { size: { L, W: 600, H: 900 } });
      add("wallcab", ix + L / 2, N(350), 0, { size: { L, W: 350, H: 700 } });
      add("fridge", ix + L + 360, N(700));
      break;
    }
    case "laundry": {
      const washerZ = N(650);
      add("washer", cx - 400, washerZ);
      add("washer", cx + 400, washerZ, 0, { variant: 1 });
      add("shelf", Ex(300), cz, 270);
      break;
    }
    case "prayer":
      add("puja", cx, N(450));
      add("rug", cx, Sx(1400), 0, { size: { L: Math.min(1800, iw - 400), W: Math.min(1200, id - 400), H: 20 }, variant: 3 });
      break;
    case "bathroom":
      add("bath", ix + 850, N(750));
      add("wc", Wx(650), iz + 1100, 90);
      add("vanity", Ex(800) - 20, Sx(500), 180);
      break;
    case "study":
      add("desk", cx, N(700));
      add("chair", cx, N(700) + 640, 180, { variant: 1 });
      add("shelf", Ex(300), cz, 270);
      add("plant", Wx(400), Sx(400));
      break;
    case "balcony":
      add("chair", cx - 600, cz, 0, { variant: 1 }); add("chair", cx + 600, cz, 0, { variant: 1 });
      add("sidetable", cx, cz); add("plant", Wx(400), N(400)); add("plant", Ex(400), N(400), 0, { variant: 1 });
      break;
    case "parking":
      if (Math.min(iw, id) >= 2050 && Math.max(iw, id) >= 4500) add("car", cx, cz, r.d >= r.w ? 90 : 0);
      break;
    case "void": break;
    default: add("plant", Wx(400), N(400)); add("sidetable", cx, N(500));
  }
  return out.filter((i) => inPoly([i.x, i.z], rectPoly(r)));
}

/* ================================================================== */
/* Default / sample house                                              */
/* ================================================================== */
const defaultExt = () => ({ storeys: 1, roof: "flat", facade: "modern", finish: "stucco", wall: EXT_WALL[0], trim: "#ffffff", roofColor: "#2b2d31", fence: true, trees: true, lawn: true, driveway: true, parking: false, porch: true, lights: false, solar: false, inside: "#f4f4f2", roofPitch: 24, overhang: 450, ridge: "auto", roofMat: "tile", insideFinish: "paint", frame: "pvc" });
export function sampleHouse() {
  const R1 = makeRoom(0, 0, 4200, 3900, "bedroom", "Master bedroom");
  const R2 = makeRoom(4200, 0, 2200, 1800, "bathroom", "Bathroom");
  const R3 = makeRoom(4200, 1800, 2200, 2100, "kitchen", "Kitchen");
  const R4 = makeRoom(0, 3900, 6400, 3200, "living", "Living & dining");
  const all = [R1, R2, R3, R4];
  const W = (R, k) => R.walls[k];
  const openings = [
    opAt(W(R1, 3), 1500, { type: "window", width: 2400, sill: 300, h: 2000 }),
    opAt(W(R1, 2), 3300, { type: "door", width: 900 }),
    opAt(W(R1, 0), 2100, { type: "window", width: 1600, sill: 900, h: 1200 }),
    opAt(W(R2, 3), 900, { type: "door", width: 800 }),
    opAt(W(R2, 1), 900, { type: "window", width: 600, sill: 1500, h: 600 }),
    opAt(W(R3, 1), 2850, { type: "window", width: 1400, sill: 900, h: 1200 }),
    opAt(W(R4, 2), 3200, { type: "door", width: 1000, color: "#6a4636" }),
    opAt(W(R4, 2), 900, { type: "window", width: 1600 }),
    opAt(W(R4, 2), 5400, { type: "window", width: 1600 }),
    opAt(W(R4, 3), 5500, { type: "window", width: 2000, sill: 300, h: 2000 }),
  ];
  return { rooms: all.map((a) => a.room), walls: all.flatMap((a) => a.walls), openings, items: all.flatMap((a) => furnishRoom(a.room)), ext: defaultExt(), levels: 1 };
}
export const normalizeD = (d) => {
  const rooms = (d.rooms || []).map((r) => withBox({ lv: 0, ...r, poly: r.poly || [[r.x, r.z], [r.x + r.w, r.z], [r.x + r.w, r.z + r.d], [r.x, r.z + r.d]] }));
  const items = (d.items || []).filter((i) => CAT[i.type]);
  const top = Math.max(0, ...rooms.map((r) => r.lv || 0), ...(d.walls || []).map((w) => w.lv || 0), ...items.map((i) => i.lv || 0));
  const openings = (d.openings || []).map((o) => ({ hinge: "l", flip: false, panes: 0, style: o.type === "door" ? "panel" : "casement", ...o }));
  return { views: [], dims: [], ...d, openings, levels: Math.max(d.levels || 1, top + 1), rooms, items, ext: { ...defaultExt(), ...(d.ext || {}) }, cost: { ...DEFAULT_COST, ...(d.cost || {}), rates: { ...((d.cost && d.cost.rates) || {}) } } };
};
/* An empty design that keeps the project's settings (units, storey height, wall thickness, cost sheet). */
export const blankD = (d = {}) => ({ rooms: [], walls: [], openings: [], items: [], ext: defaultExt(), ...["unit", "wallH", "wallT", "cost"].reduce((a, k) => (d[k] !== undefined ? { ...a, [k]: d[k] } : a), {}) });
const loadD = () => {
  try {
    if (typeof window !== "undefined") {
      const raw = window.localStorage.getItem(STORE_KEY);
      if (raw) { const d = JSON.parse(raw); if (d && d.rooms && d.walls) return normalizeD(d); }
    }
  } catch (e) { /* ignore */ }
  return sampleHouse();
};

/* ================================================================== */
/* Thumbnails                                                          */
/* ================================================================== */
function makeThumbs() {
  const out = {};
  let r;
  try {
    r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setPixelRatio(1); r.setSize(128, 128);
    if ("outputColorSpace" in r) r.outputColorSpace = THREE.SRGBColorSpace;
    const sc = new THREE.Scene();
    sc.add(new THREE.HemisphereLight(0xffffff, 0xb8bcc4, 1.1));
    const dl = new THREE.DirectionalLight(0xffffff, 1.5); dl.position.set(2, 4, 3); sc.add(dl);
    const cam = new THREE.PerspectiveCamera(32, 1, 0.05, 50);
    CATALOG.forEach((c) => c.variants.forEach((v, vi) => {
      let g;
      try {
        g = buildModel(c.type, vi, false, { L: c.size[0], W: c.size[1], H: c.size[2] });
        paint(g, v, null);
        const [L, W, H] = c.size;
        g.scale.set(L * MM, H * MM, W * MM);
        sc.add(g);
        const md = Math.max(L, W, H) * MM;
        cam.position.set(md * 1.9, (H * MM) / 2 + md * 0.9, md * 2.4);
        cam.lookAt(0, (H * MM) / 2, 0);
        r.render(sc, cam);
        out[c.type + ":" + vi] = r.domElement.toDataURL("image/png");
      } catch (error) {
        console.error(`Could not render ${c.name} (${v.label}) preview`, error);
      } finally {
        if (g) { sc.remove(g); disposeTree(g); }
      }
    }));
  } catch (error) {
    console.error("Could not initialize furniture previews", error);
  } finally {
    if (r) r.dispose();
  }
  return out;
}

/* ================================================================== */
/* Icons + small pieces                                                */
/* ================================================================== */
const ICON = {
  move: "M5 9l-3 3 3 3 M9 5l3-3 3 3 M15 19l-3 3-3-3 M19 9l3 3-3 3 M2 12h20 M12 2v20",
  scale: "M15 3h6v6 M9 21H3v-6 M21 3l-7.5 7.5 M3 21l7.5-7.5",
  rotate: "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8 M21 3v5h-5",
  mirror: "M8 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h3 M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3 M12 20v2 M12 14v2 M12 8v2 M12 2v2",
  swap: "m17 2 4 4-4 4 M3 11v-1a4 4 0 0 1 4-4h14 m7 22-4-4 4-4 M21 13v1a4 4 0 0 1-4 4H3",
  copy: ["M11 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"],
  eyeoff: "M9.88 9.88a3 3 0 1 0 4.24 4.24 M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68 M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61 M2 2l20 20",
  eye: ["M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"],
  star: "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z",
  trash: "M3 6h18 M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
  undo: "M3 7v6h6 M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13",
  redo: "M21 7v6h-6 M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13",
  save: "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z M17 21v-8H7v8 M7 3v5h8",
  clear: "M18 6 6 18 M6 6l12 12",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6",
  search: ["M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z", "m21 21-4.3-4.3"],
  plus: "M12 5v14 M5 12h14",
  minus: "M5 12h14",
  home: "M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10",
  lock: ["M5 11h14v10H5z", "M8 11V7a4 4 0 0 1 8 0v4"],
  chevron: "m9 18 6-6-6-6",
  layers: "M12 2 2 7l10 5 10-5-10-5z M2 17l10 5 10-5 M2 12l10 5 10-5",
  cursor: "M4 3l7 17 2.5-7.5L21 10z",
  room: "M3 5h18v14H3z",
  wall: "M3 8h18v8H3z M9 8v8 M15 8v8",
  door: ["M5 21V3h9l5 3v15", "M5 21h14", "M12 12h.01"],
  window: "M4 4h16v16H4z M12 4v16 M4 12h16",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
  ruler: "M3 17L17 3l4 4L7 21z M7 13l2 2 M10 10l2 2 M13 7l2 2",
  poly: "M4 18l3-12 10-2 3 10-7 6z",
  sliders: "M4 6h10 M18 6h2 M4 12h4 M12 12h8 M4 18h12 M20 18h0 M14 4v4 M8 10v4 M16 16v4",
};
const Ic = ({ n, size = 18, fill }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill={fill || "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {(Array.isArray(ICON[n]) ? ICON[n] : [ICON[n]]).map((p, i) => <path key={i} d={p} />)}
  </svg>
);
function Row({ label, value, min, max, step = 1, unit = "mm", onChange, onStart, disabled, dp: dps = 0 }) {
  // Lengths are stored in mm; "mm" rows follow the project's display unit (typing 2.5 in m stores 2500).
  const U = useContext(UnitCtx), conv = unit === "mm" ? UNITS[U] || UNITS.mm : null;
  const f = conv ? conv.f : 1, dp = conv ? conv.dp : dps, v = dps ? value : Math.round(value);
  const shown = conv ? Number((value / f).toFixed(dp)) : dps ? Number(value.toFixed(dps)) : v;
  return (
    <div className="b3d-row">
      <label>{label}</label>
      <input type="range" min={min} max={max} step={step} value={Math.min(max, Math.max(min, v))} disabled={disabled} onPointerDown={onStart} onChange={(e) => onChange(+e.target.value)} />
      <div className="b3d-num">
        <input type="number" step={conv ? Math.pow(10, -dp) : 1} value={shown} disabled={disabled} onFocus={onStart} onChange={(e) => onChange(e.target.value === "" ? 0 : +e.target.value * f)} />
        <span>{conv ? conv.label : unit}</span>
      </div>
    </div>
  );
}
/* A length field that shows and accepts the project's display unit (value is always millimetres). */
function LenInput({ label, value, onChange, onStart }) {
  const U = useContext(UnitCtx), cv = UNITS[U] || UNITS.mm;
  const shown = Number((value / cv.f).toFixed(cv.dp + (cv.dp ? 1 : 0)));
  return (
    <label className="b3d-field b3d-lenfield">
      <span>{label}</span>
      <div className="b3d-num">
        <input type="number" step={Math.pow(10, -cv.dp)} value={shown} onFocus={onStart} onChange={(e) => { if (e.target.value !== "") onChange(+e.target.value * cv.f); }} />
        <span>{cv.label}</span>
      </div>
    </label>
  );
}
const Swatches = ({ list, value, onPick }) => (
  <div className="b3d-sw">
    {list.map((c) => <button key={c} aria-label={c} style={{ background: c }} className={value === c ? "on" : ""} onClick={() => onPick(c)} />)}
  </div>
);

/* Cost tab: bill of quantities grouped by trade, with editable unit rates and project-wide markups. */
const COST_ORDER = ["Structure", "Envelope", "Finishes", "Services", "Site", "Furniture & fittings"];
function CostPanel({ D, est, onCost, onRate, onStart }) {
  const cost = { ...DEFAULT_COST, ...(D.cost || {}) }, cur = est.cur;
  const cats = [];
  est.lines.forEach((l) => {
    let c = cats.find((x) => x.name === l.cat);
    if (!c) { c = { name: l.cat, lines: [], total: 0 }; cats.push(c); }
    c.lines.push(l); c.total += l.total;
  });
  cats.sort((a, b) => COST_ORDER.indexOf(a.name) - COST_ORDER.indexOf(b.name));
  const money = (v) => cur + Math.round(v).toLocaleString();
  return (
    <div className="b3d-props b3d-cost">
      <h4>Estimate</h4>
      <div className="b3d-cost-set">
        <label className="b3d-field">Currency
          <select className="b3d-select" value={cost.cur} aria-label="Currency" onChange={(e) => onCost({ cur: e.target.value })}>{CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}</select>
        </label>
        <div className="b3d-pcts">
          {[["cont", "Contingency"], ["over", "Overhead + profit"], ["tax", "Tax"]].map(([k, l]) => (
            <label key={k} className="b3d-field"><span>{l}</span>
              <div className="b3d-num"><input type="number" min={0} max={100} step={0.5} aria-label={l + " percent"} value={cost[k]} onFocus={onStart} onChange={(e) => onCost({ [k]: clamp(+e.target.value || 0, 0, 100) })} /><span>%</span></div>
            </label>
          ))}
        </div>
      </div>
      {!cats.length && <p className="b3d-note">Draw some rooms and the quantities appear here.</p>}
      {cats.map((c) => (
        <section key={c.name} aria-label={c.name}>
          <h5 className="b3d-costh"><span>{c.name}</span><b>{money(c.total)}</b></h5>
          <table className="b3d-table b3d-costtbl"><tbody>
            {c.lines.map((l) => (
              <tr key={l.key}>
                <td>{l.label}<br /><small>{l.qty} {l.unit} × {cur}</small>
                  <input className="b3d-rate" type="number" min={0} step="any" value={l.price} aria-label={"Rate for " + l.label} onFocus={onStart} onChange={(e) => onRate(l.key, e.target.value === "" ? 0 : +e.target.value)} />
                  {l.price !== l.base && <button className="b3d-rate-reset" title={"Reset to default rate (" + cur + l.base + ")"} aria-label={"Reset rate for " + l.label} onClick={() => onRate(l.key, null)}>↺</button>}
                </td>
                <td>{money(l.total)}</td>
              </tr>
            ))}
          </tbody></table>
        </section>
      ))}
      <table className="b3d-table b3d-totals"><tbody>
        <tr><td>Subtotal</td><td>{money(est.subtotal)}</td></tr>
        {est.markups.map((m) => <tr key={m.key}><td>{m.label} ({m.pct}%)</td><td>{money(m.amount)}</td></tr>)}
        <tr><td><strong>Total</strong></td><td><strong>{money(est.total)}</strong></td></tr>
      </tbody></table>
      <p className="b3d-note">Quantities are measured from your drawing: wall areas net of openings, roof area from the pitch and overhang, slabs from room areas. Rates are placeholders; type your local price in any rate box. File, Export estimate saves a CSV.</p>
    </div>
  );
}

/* ================================================================== */
/* Component                                                           */
/* ================================================================== */
function Builder3DInner({ style, initial = {} }) {
  const hostRef = useRef(null);
  const tbRef = useRef(null);
  const svgRef = useRef(null);
  const planWrap = useRef(null);
  const fileInput = useRef(null);
  const S = useRef({ groups: new Map(), wallGroups: [], cut: "cut", mode: "interior" });
  const drag = useRef(null);
  const rootRef = useRef(null);
  const lastTap = useRef({});
  const pointers = useRef(new Map());
  const glbInput = useRef(null);
  const traceInput = useRef(null);

  const [D, setDState] = useState(() => (initial.design ? normalizeD(initial.design) : loadD()));
  const dRef = useRef(D);
  const pastRef = useRef([]);
  const futureRef = useRef([]);
  const [, bump] = useState(0);

  const [mode, setMode] = useState(initial.mode || "interior"); // plan | interior | exterior
  const [interiorView, setInteriorView] = useState(initial.interiorView || "top");
  const [exteriorTab, setExteriorTab] = useState(initial.exteriorTab || "structure");
  const [selection, setSelection] = useState(initial.selection || null); // {kind:'item'|'room'|'wall'|'op'|'dim', id}
  /* Studio link: share the selected furniture id with the Ultra-Realistic 3D Studio (studio/Studio3D.jsx) through localStorage, in both directions. */
  useEffect(() => { try { if (selection && selection.kind === "item") window.localStorage.setItem("builder3d.selection.v1", JSON.stringify({ id: selection.id, t: Date.now(), from: "plan" })); } catch (e) { /* storage unavailable */ } }, [selection]);
  useEffect(() => {
    const h = (e) => { if (e.key !== "builder3d.selection.v1" || !e.newValue) return; try { const v = JSON.parse(e.newValue); if (v && v.id && dRef.current.items.some((i) => i.id === v.id)) setSelection({ kind: "item", id: v.id }); } catch (err) { /* ignore */ } };
    window.addEventListener("storage", h); return () => window.removeEventListener("storage", h);
  }, []);
  const [tool, setTool] = useState("translate");
  const [ptool, setPtool] = useState(initial.ptool || "select");
  const [rtype, setRtype] = useState("bedroom");
  const [draft, setDraft] = useState(null);
  const [hover, setHover] = useState(null);
  const [snapCur, setSnapCur] = useState(null);
  const [pv, setPv] = useState({ tx: 200, ty: 120, k: 0.1 });
  const [pSize, setPSize] = useState({ w: 800, h: 600 });
  const [rtab, setRtab] = useState(initial.rtab || "props");
  const [cat, setCat] = useState("popular");
  const [query, setQuery] = useState("");
  const [live, setLive] = useState(true);
  const [cut, setCut] = useState("cut");
  const [menu, setMenu] = useState(null);
  const [matOpen, setMatOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [fileOpen, setFileOpen] = useState(false);
  const [wallOp, setWallOp] = useState(100);
  const [floorOp, setFloorOp] = useState(100);
  const [zoomPct, setZoomPct] = useState(100);
  const [thumbs, setThumbs] = useState({});
  const [thumbsReady, setThumbsReady] = useState(false);
  const [msg, setMsg] = useState("");
  const [hour, setHour] = useState(14);
  const [walk, setWalk] = useState(!!initial.walk);
  const [trace, setTrace] = useState(null);
  const [vw, setVw] = useState(1280);
  const [coarse, setCoarse] = useState(!!initial.coarse);
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [lv, setLv] = useState(initial.lv || 0);
  const lvRef = useRef(initial.lv || 0);
  lvRef.current = lv;
  const unit = UNITS[D.unit] ? D.unit : "mm";
  const [snapOn, setSnapOn] = useState(true);
  const [gridSize, setGridSize] = useState(100);
  const [guidesOn, setGuidesOn] = useState(true);
  const [showDims, setShowDims] = useState(true);
  const [angleSnap, setAngleSnap] = useState(false);
  const [guides, setGuides] = useState([]);
  const [planSet, setPlanSet] = useState(!!initial.planSet);
  const [itemSnap, setItemSnap] = useState(true);
  const [tour, setTour] = useState(false);
  const [render, setRender] = useState({ quality: "high", exposure: 1, lights: true });
  const clipRef = useRef(null);
  const guideKey = useRef("");
  const tipRef = useRef(null), miniRef = useRef(null), unitRef = useRef("mm"), selRef = useRef(null), pendSel = useRef(null), prevCut = useRef(null);
  unitRef.current = unit;
  selRef.current = selection;
  const [walkLv, setWalkLv] = useState(0);
  const [fade, setFade] = useState(false);
  const [tourLabel, setTourLabel] = useState("");
  // walkthrough camera/input preferences: persisted, validated, and kept apart from the saved design geometry
  const [walkSet, setWalkSet] = useState(() => { try { return loadWalk(window.localStorage); } catch (e) { return { ...WALK_DEFAULTS }; } });
  const walkRef = useRef(walkSet);
  walkRef.current = walkSet;
  const [walkPanel, setWalkPanel] = useState(!!initial.walkPanel);
  const [floorDlg, setFloorDlg] = useState(!!initial.floorDlg);
  const [floorOpt, setFloorOpt] = useState(initial.floorOpt || "room");
  const [floorCopy, setFloorCopy] = useState(initial.floorCopy !== false);
  const [spiralRoom, setSpiralRoom] = useState(initial.spiralRoom || "");
  const [shareOpen, setShareOpen] = useState(false);
  const [shareStage, setShareStage] = useState("contact");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [shareError, setShareError] = useState("");
  const [shareFile, setShareFile] = useState(null);
  const [shareFileName, setShareFileName] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  useEffect(() => () => { if (shareUrl) URL.revokeObjectURL(shareUrl); }, [shareUrl]);
  const [lockOn, setLockOn] = useState(false);
  const [runOn, setRunOn] = useState(false);
  const patchWalk = (p) => setWalkSet((w) => sanitizeWalk({ ...w, ...p }));
  const lockSupported = typeof document !== "undefined" && "pointerLockElement" in document;
  const showGuides = (list) => { const k = JSON.stringify(list); if (k !== guideKey.current) { guideKey.current = k; setGuides(list); } };

  const selId = selection && selection.kind === "item" ? selection.id : null;
  const setSelId = useCallback((id) => setSelection(id ? { kind: "item", id } : null), []);
  const sel = D.items.find((i) => i.id === selId) || null;
  const selRoom = selection && selection.kind === "room" ? D.rooms.find((r) => r.id === selection.id) : null;
  const selWall = selection && selection.kind === "wall" ? D.walls.find((w) => w.id === selection.id) : null;
  const selOp = selection && selection.kind === "op" ? D.openings.find((o) => o.id === selection.id) : null;
  const selDim = selection && selection.kind === "dim" ? (D.dims || []).find((o) => o.id === selection.id) : null;
  const wallById = useMemo(() => Object.fromEntries(D.walls.map((w) => [w.id, w])), [D.walls]);
  const hiddenCount = D.items.filter((i) => i.hidden).length;
  const nL = D.levels || 1;
  const compact = vw < 1000, tapR = coarse ? 2 : 1;
  const compactRef = useRef(false);
  compactRef.current = compact;
  const rootCls = "b3d" + (vw < 640 ? " b3d-sm" : vw < 1000 ? " b3d-md" : vw < 1200 ? " b3d-lg" : "") + (compact ? " b3d-compact" : "") + (coarse ? " b3d-coarse" : "");
  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(""), 1700); };
  const flashRef = useRef(flash);
  flashRef.current = flash;

  /* ---------- state helpers ---------- */
  const setD = useCallback((n) => { dRef.current = n; setDState(n); }, []);
  const snapshot = useCallback(() => {
    pastRef.current.push(JSON.stringify(dRef.current));
    if (pastRef.current.length > 100) pastRef.current.shift();
    futureRef.current = [];
    bump((n) => n + 1);
  }, []);
  const commit = useCallback((fn) => { snapshot(); setD(fn(dRef.current)); }, [snapshot, setD]);
  const patchItem = useCallback((id, p) => setD({ ...dRef.current, items: dRef.current.items.map((i) => (i.id === id ? { ...i, ...p } : i)) }), [setD]);
  const patchWall = useCallback((id, p) => setD({ ...dRef.current, walls: dRef.current.walls.map((i) => (i.id === id ? { ...i, ...p } : i)) }), [setD]);
  const patchOp = useCallback((id, p) => setD({ ...dRef.current, openings: dRef.current.openings.map((i) => (i.id === id ? { ...i, ...p } : i)) }), [setD]);
  const patchExt = (p) => commit((d) => ({ ...d, ext: { ...d.ext, ...p } }));
  const setExt = (p) => setD({ ...dRef.current, ext: { ...dRef.current.ext, ...p } }); // live (sliders): pair with onStart={snapshot}
  const rectPatch = useCallback((roomId, p) => {
    const d = dRef.current, r = d.rooms.find((q) => q.id === roomId);
    if (!r) return;
    const nb = { x: p.x ?? r.x, z: p.z ?? r.z, w: Math.max(1000, p.w ?? r.w), d: Math.max(1000, p.d ?? r.d) };
    const poly = r.poly.map(([px, pz]) => [nb.x + ((px - r.x) / (r.w || 1)) * nb.w, nb.z + ((pz - r.z) / (r.d || 1)) * nb.d]);
    const nr = withBox({ ...r, poly });
    const dx = nr.x - r.x, dz = nr.z - r.z, nw = roomWalls(nr);
    setD({
      ...d,
      rooms: d.rooms.map((q) => (q.id === roomId ? nr : q)),
      walls: d.walls.map((w) => { const f = nw.find((q) => q.id === w.id); return f ? { ...w, a: f.a, b: f.b } : w; }),
      items: dx || dz ? d.items.map((i) => (inRect(i, r) ? { ...i, x: i.x + dx, z: i.z + dz } : i)) : d.items,
    });
  }, [setD]);
  const undo = useCallback(() => { const s = pastRef.current.pop(); if (!s) return; futureRef.current.push(JSON.stringify(dRef.current)); setD(JSON.parse(s)); bump((n) => n + 1); }, [setD]);
  const redo = useCallback(() => { const s = futureRef.current.pop(); if (!s) return; pastRef.current.push(JSON.stringify(dRef.current)); setD(JSON.parse(s)); bump((n) => n + 1); }, [setD]);

  const dropPoint = () => {
    const r = selRoom || (selId && null);
    if (r) return { x: r.x + r.w / 2, z: r.z + r.d / 2 };
    if (mode === "plan") return { x: (pSize.w / 2 - pv.tx) / pv.k, z: (pSize.h / 2 - pv.ty) / pv.k };
    const bb = bboxOf(dRef.current);
    return { x: (bb.x0 + bb.x1) / 2, z: (bb.z0 + bb.z1) / 2 };
  };
  const addItem = useCallback((type, at, variant = 0) => {
    const p = at || dropPoint();
    const n = dRef.current.items.length;
    const it = mk(type, Math.round(p.x + (at ? 0 : (n % 3) * 150)), Math.round(p.z + (at ? 0 : (n % 3) * 150)), 0, { variant, lv: lvRef.current });
    commit((d) => ({ ...d, items: [...d.items, it] }));
    setSelId(it.id);
    if (compactRef.current) setLeftOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commit, setSelId, selRoom, mode, pv, pSize]);
  const duplicate = useCallback((id) => {
    const it = dRef.current.items.find((i) => i.id === id);
    if (!it) return;
    const copy = { ...it, id: uid("f"), x: it.x + 300, z: it.z + 300, size: { ...it.size }, locked: false };
    commit((d) => ({ ...d, items: [...d.items, copy] }));
    setSelId(copy.id);
  }, [commit, setSelId]);
  const arrayItem = useCallback((id) => {
    const it = dRef.current.items.find((i) => i.id === id);
    if (!it) return;
    const r = (it.rot * Math.PI) / 180, step = it.size.L + 50;
    commit((d) => ({ ...d, items: [...d.items, ...[1, 2, 3].map((k) => ({ ...it, id: uid("f"), size: { ...it.size }, locked: false, x: it.x + Math.cos(r) * step * k, z: it.z - Math.sin(r) * step * k }))] }));
  }, [commit]);
  const deleteSelection = useCallback(() => {
    if (!selection) return;
    commit((d) => {
      if (selection.kind === "item") return { ...d, items: d.items.filter((i) => i.id !== selection.id) };
      if (selection.kind === "dim") return { ...d, dims: (d.dims || []).filter((o) => o.id !== selection.id) };
      if (selection.kind === "op") return { ...d, openings: d.openings.filter((o) => o.id !== selection.id) };
      if (selection.kind === "wall") return { ...d, walls: d.walls.filter((w) => w.id !== selection.id), openings: d.openings.filter((o) => o.wallId !== selection.id) };
      const r = d.rooms.find((q) => q.id === selection.id);
      if (!r) return d;
      return { ...d, rooms: d.rooms.filter((q) => q.id !== r.id), walls: d.walls.filter((w) => !r.wallIds.includes(w.id)), openings: d.openings.filter((o) => !r.wallIds.includes(o.wallId)) };
    });
    setSelection(null);
  }, [selection, commit]);
  const addRoom = (x, z, w, d, type) => {
    const n = dRef.current.rooms.filter((r) => r.type === type).length + 1;
    const { room, walls } = makeRoom(x, z, w, d, type, ROOM_TYPES[type].label + " " + n, lvRef.current, newT());
    commit((s) => ({ ...s, rooms: [...s.rooms, room], walls: [...s.walls, ...walls] }));
    setSelection({ kind: "room", id: room.id });
  };
  const finishPoly = (pts) => {
    setDraft(null);
    if (pts.length < 3) return;
    const poly = pts.map((q) => [q.x, q.z]);
    if (roomArea({ poly }) < 1) return;
    const n = dRef.current.rooms.filter((r) => r.type === rtype).length + 1;
    const { room, walls } = makePolyRoom(poly, rtype, ROOM_TYPES[rtype].label + " " + n, lvRef.current, newT());
    commit((d) => ({ ...d, rooms: [...d.rooms, room], walls: [...d.walls, ...walls] }));
    setSelection({ kind: "room", id: room.id });
    setPtool("select");
  };
  const moveVertex = (roomId, idx, c) => {
    const d = dRef.current, r = d.rooms.find((q) => q.id === roomId);
    if (!r) return;
    const n = r.poly.length, pt = [c.x, c.z];
    const poly = r.poly.map((q, i) => (i === idx ? pt : q));
    const wA = r.wallIds[idx], wB = r.wallIds[(idx - 1 + n) % n];
    setD({ ...d, rooms: d.rooms.map((q) => (q.id === roomId ? withBox({ ...q, poly }) : q)), walls: d.walls.map((w) => (w.id === wA ? { ...w, a: pt } : w.id === wB ? { ...w, b: pt } : w)) });
  };
  const insertVertex = (e, roomId, k) => {
    const d = dRef.current, r = d.rooms.find((q) => q.id === roomId);
    if (!r) return;
    const n = r.poly.length, A = r.poly[k], B = r.poly[(k + 1) % n], M = [sn((A[0] + B[0]) / 2, 100), sn((A[1] + B[1]) / 2, 100)];
    const wid = r.wallIds[k], nid = uid("w");
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1, f = Math.min(0.95, Math.max(0.05, Math.hypot(M[0] - A[0], M[1] - A[1]) / len));
    snapshot();
    const poly = [...r.poly.slice(0, k + 1), M, ...r.poly.slice(k + 1)];
    const wallIds = [...r.wallIds.slice(0, k + 1), nid, ...r.wallIds.slice(k + 1)];
    const walls = d.walls.flatMap((w) => (w.id === wid ? [{ ...w, a: A, b: M }, { id: nid, a: M, b: B, t: w.t, lv: w.lv || 0 }] : [w]));
    const openings = d.openings.map((o) => (o.wallId !== wid ? o : o.pos < f ? { ...o, pos: o.pos / f } : { ...o, wallId: nid, pos: (o.pos - f) / (1 - f) }));
    setD({ ...d, rooms: d.rooms.map((q) => (q.id === roomId ? withBox({ ...q, poly, wallIds }) : q)), walls, openings });
    begin(e, { kind: "rvert", id: roomId, idx: k + 1 });
    drag.current.snap = true;
  };
  const removeVertex = (roomId, idx) => {
    const d = dRef.current, r = d.rooms.find((q) => q.id === roomId);
    if (!r || r.poly.length <= 3) return;
    snapshot();
    const n = r.poly.length, prev = (idx - 1 + n) % n, wPrev = r.wallIds[prev], wCur = r.wallIds[idx], next = r.poly[(idx + 1) % n];
    const poly = r.poly.filter((_, i) => i !== idx), wallIds = r.wallIds.filter((_, i) => i !== idx);
    setD({ ...d, rooms: d.rooms.map((q) => (q.id === roomId ? withBox({ ...q, poly, wallIds }) : q)), walls: d.walls.filter((w) => w.id !== wCur).map((w) => (w.id === wPrev ? { ...w, b: next } : w)), openings: d.openings.filter((o) => o.wallId !== wCur) });
  };
  const addFloor = () => {
    const d = dRef.current, cur = lvRef.current;
    const hasPlan = d.rooms.some((r) => (r.lv || 0) === cur) || d.walls.some((w) => (w.lv || 0) === cur);
    const fits = d.rooms.filter((r) => (r.lv || 0) === cur && spiralFits(r));
    setFloorCopy(hasPlan);
    setFloorOpt("room");
    setSpiralRoom(fits.length ? fits.sort((a, b) => roomArea(b) - roomArea(a))[0].id : "");
    setFloorDlg(true);
  };
  const confirmAddFloor = (pickId) => {
    const d = dRef.current, top = d.levels || 1, cur = lvRef.current;
    snapshot();
    let next = { ...d, levels: top + 1 };
    if (floorCopy) {
      const wm = {};
      const walls = d.walls.filter((w) => (w.lv || 0) === cur).map((w) => { const id = uid("w"); wm[w.id] = id; return { ...w, id, lv: top }; });
      const rooms = d.rooms.filter((r) => (r.lv || 0) === cur).map((r) => ({ ...r, id: uid("r"), lv: top, wallIds: r.wallIds.map((i) => wm[i] || i), autoStairs: false }));
      const openings = d.openings.filter((o) => wm[o.wallId]).map((o) => ({ ...o, id: uid("o"), wallId: wm[o.wallId], lv: top }));
      next = { ...next, walls: [...d.walls, ...walls], rooms: [...d.rooms, ...rooms], openings: [...d.openings, ...openings] };
    }
    if (floorOpt === "room") {
      const sw = planStairwell(next, cur, top, storeyH(next));
      next = { ...next, rooms: [...next.rooms, ...sw.rooms], walls: [...next.walls, ...sw.walls], openings: [...next.openings, ...sw.openings], items: [...next.items, ...sw.items] };
      flash("Floor added with a separate stairwell room");
    } else if (floorOpt === "spiral") {
      const res = placeSpiralStairs(d.rooms, pickId || spiralRoom, next.items, storeyH(next));
      if (res) {
        next = { ...next, items: res.items };
        flash("Floor added with spiral stairs" + (res.total ? " · " + res.moved + " of " + res.total + " furniture items moved" + (res.stuck ? ", " + res.stuck + " had no free spot" : "") : ""));
      } else flash("That room is too small for spiral stairs (needs about 2.3 × 2.3 m). Floor added without stairs.");
    } else flash("Floor added");
    setD(next);
    setLv(top);
    setFloorDlg(false);
  };
  const removeTopFloor = () => {
    const d = dRef.current, top = (d.levels || 1) - 1;
    if (top < 1) return;
    const keep = (e) => (e.lv || 0) !== top;
    const has = [d.rooms, d.walls, d.openings, d.items, d.dims || []].some((a) => a.some((e) => !keep(e)));
    if (has && !window.confirm("Delete everything on " + (top + 1) + "F?")) return;
    snapshot();
    const auto = d.rooms.filter((r) => r.autoStairs && (r.lv || 0) === top - 1), autoW = new Set(auto.flatMap((r) => r.wallIds)), keepLow = (e) => keep(e) && !auto.includes(e);
    setD({ ...d, levels: top, rooms: d.rooms.filter(keepLow), walls: d.walls.filter((w) => keep(w) && !autoW.has(w.id)), openings: d.openings.filter((o) => keep(o) && !autoW.has(o.wallId)), items: d.items.filter((item) => keep(item) && !(item.type === "stairs" && item.autoFloorLink && (item.lv || 0) === top - 1)), dims: (d.dims || []).filter(keep) });
    if (lvRef.current >= top) setLv(top - 1);
  };
  const furnish = (room) => commit((d) => ({ ...d, items: clearStairsInRoom(room, [...d.items, ...furnishRoom(room, storeyH(d))], storeyH(d)).items }));
  const clearRoom = (room) => commit((d) => ({ ...d, items: d.items.filter((i) => !inRect(i, room)) }));
  const setDim = (it, k, val) => {
    val = Math.max(10, Math.min(6000, +val || 10));
    let s = { ...it.size };
    if (it.prop) { const r = val / s[k]; s = { L: s.L * r, W: s.W * r, H: s.H * r }; }
    s[k] = val;
    patchItem(it.id, { size: s });
  };

  /* ---------- precise editing: edges, wall lengths, openings, clipboard ---------- */
  const newT = () => dRef.current.wallT || 150;
  const setRoomPoly = (roomId, poly) => {
    const d = dRef.current, r = d.rooms.find((q) => q.id === roomId);
    if (!r) return;
    const byId = {};
    r.wallIds.forEach((id, i) => { byId[id] = [poly[i], poly[(i + 1) % poly.length]]; });
    setD({ ...d, rooms: d.rooms.map((q) => (q.id === roomId ? withBox({ ...q, poly }) : q)), walls: d.walls.map((w) => (byId[w.id] ? { ...w, a: byId[w.id][0], b: byId[w.id][1] } : w)) });
  };
  const roomOf = (id) => dRef.current.rooms.find((r) => r.id === id);
  const setEdgeLength = (roomId, k, len) => { const r = roomOf(roomId); if (r) setRoomPoly(roomId, setEdgeLengthPoly(r.poly, k, len)); };
  const wallRoom = (wall) => dRef.current.rooms.find((r) => r.wallIds.includes(wall.id));
  const setWallEnd = (wall, end, pt) => {
    const room = wallRoom(wall);
    if (room) { const k = room.wallIds.indexOf(wall.id); moveVertex(room.id, end === "a" ? k : (k + 1) % room.poly.length, { x: pt[0], z: pt[1] }); }
    else patchWall(wall.id, { [end]: pt });
  };
  const setWallLength = (wall, len) => {
    const L = wallLen(wall) || 1, f = Math.max(100, len) / L;
    setWallEnd(wall, "b", [Math.round(wall.a[0] + (wall.b[0] - wall.a[0]) * f), Math.round(wall.a[1] + (wall.b[1] - wall.a[1]) * f)]);
  };
  const setRoomThickness = (room, t) => setD({ ...dRef.current, walls: dRef.current.walls.map((w) => (room.wallIds.includes(w.id) ? { ...w, t: clamp(t || 80, 80, 600) } : w)) });
  const setOpOffset = (o, fromStart) => {
    const w = dRef.current.walls.find((q) => q.id === o.wallId);
    if (!w) return;
    const L = wallLen(w) || 1, half = o.width / 2;
    patchOp(o.id, { pos: clamp((fromStart + half) / L, half / L, 1 - half / L) });
  };
  const setOpWidth = (o, width) => {
    const w = dRef.current.walls.find((q) => q.id === o.wallId), L = w ? wallLen(w) : 4000;
    const wd = clamp(width || 400, 300, Math.max(400, L - 100)), half = wd / 2 / L;
    patchOp(o.id, { width: wd, pos: clamp(o.pos, half, 1 - half) });
  };

  const copySelection = (cut) => {
    const d = dRef.current;
    if (!selection) return false;
    let clip = null;
    if (selection.kind === "item") { const item = d.items.find((i) => i.id === selection.id); if (item) clip = { kind: "item", item }; }
    else if (selection.kind === "room") { const r = d.rooms.find((q) => q.id === selection.id); if (r) clip = { kind: "room", room: r, walls: d.walls.filter((w) => r.wallIds.includes(w.id)), openings: d.openings.filter((o) => r.wallIds.includes(o.wallId)), items: d.items.filter((i) => (i.lv || 0) === (r.lv || 0) && inRect(i, r)) }; }
    else if (selection.kind === "wall") { const w = d.walls.find((q) => q.id === selection.id); if (w) clip = { kind: "wall", wall: w, openings: d.openings.filter((o) => o.wallId === w.id) }; }
    else if (selection.kind === "op") { const o = d.openings.find((q) => q.id === selection.id); if (o) clip = { kind: "op", op: o }; }
    else if (selection.kind === "dim") { const m = (d.dims || []).find((q) => q.id === selection.id); if (m) clip = { kind: "dim", dim: m }; }
    if (!clip) return false;
    clipRef.current = { ...clip, n: cut ? -1 : 0 };
    if (cut) deleteSelection();
    flash(cut ? "Cut" : "Copied");
    bump((n) => n + 1);
    return true;
  };
  const pasteClipboard = () => {
    const c = clipRef.current;
    if (!c) { flash("Nothing to paste yet"); return; }
    c.n += 1;
    const off = c.n * 500, L = lvRef.current, d = dRef.current;
    if (c.kind === "item") {
      const copy = { ...c.item, id: uid("f"), x: c.item.x + off, z: c.item.z + off, lv: L, size: { ...c.item.size }, locked: false };
      commit((s) => ({ ...s, items: [...s.items, copy] })); setSelId(copy.id);
    } else if (c.kind === "room") {
      const wm = {};
      c.walls.forEach((w) => { wm[w.id] = uid("w"); });
      const room = withBox({ ...c.room, id: uid("r"), lv: L, wallIds: c.room.wallIds.map((i) => wm[i] || i), poly: c.room.poly.map(([x, z]) => [x + off, z + off]) });
      const walls = c.walls.map((w) => ({ ...w, id: wm[w.id], lv: L, a: [w.a[0] + off, w.a[1] + off], b: [w.b[0] + off, w.b[1] + off] }));
      const openings = c.openings.map((o) => ({ ...o, id: uid("o"), wallId: wm[o.wallId], lv: L }));
      const items = c.items.map((i) => ({ ...i, id: uid("f"), x: i.x + off, z: i.z + off, lv: L, size: { ...i.size }, locked: false }));
      commit((s) => ({ ...s, levels: Math.max(s.levels || 1, L + 1), rooms: [...s.rooms, room], walls: [...s.walls, ...walls], openings: [...s.openings, ...openings], items: [...s.items, ...items] }));
      setSelection({ kind: "room", id: room.id });
    } else if (c.kind === "wall") {
      const id = uid("w"), wall = { ...c.wall, id, lv: L, a: [c.wall.a[0] + off, c.wall.a[1] + off], b: [c.wall.b[0] + off, c.wall.b[1] + off] };
      const openings = c.openings.map((o) => ({ ...o, id: uid("o"), wallId: id, lv: L }));
      commit((s) => ({ ...s, walls: [...s.walls, wall], openings: [...s.openings, ...openings] })); setSelection({ kind: "wall", id });
    } else if (c.kind === "op") {
      const w = d.walls.find((q) => q.id === c.op.wallId);
      if (!w) { flash("The wall for this opening no longer exists"); return; }
      const len = wallLen(w) || 1, step = (c.op.width + 150) / len * c.n, half = c.op.width / 2 / len;
      const o = { ...c.op, id: uid("o"), pos: clamp(c.op.pos + step > 1 - half ? c.op.pos - step : c.op.pos + step, half, 1 - half) };
      commit((s) => ({ ...s, openings: [...s.openings, o] })); setSelection({ kind: "op", id: o.id });
    } else if (c.kind === "dim") {
      const m = { ...c.dim, id: uid("m"), lv: L, a: [c.dim.a[0] + off, c.dim.a[1] + off], b: [c.dim.b[0] + off, c.dim.b[1] + off] };
      commit((s) => ({ ...s, dims: [...(s.dims || []), m] })); setSelection({ kind: "dim", id: m.id });
    }
  };
  const duplicateSelection = () => { if (copySelection(false)) pasteClipboard(); };
  /* arrow-key nudging: grid step, Shift = x10, Alt = 10 mm */
  const nudge = (dx, dz) => {
    const d = dRef.current;
    if (!selection) return false;
    const it = d.items.find((i) => i.id === selection.id), r = d.rooms.find((q) => q.id === selection.id), w = d.walls.find((q) => q.id === selection.id), o = d.openings.find((q) => q.id === selection.id), m = (d.dims || []).find((q) => q.id === selection.id);
    snapshot();
    if (selection.kind === "item" && it) patchItem(it.id, { x: it.x + dx, z: it.z + dz });
    else if (selection.kind === "room" && r) rectPatch(r.id, { x: r.x + dx, z: r.z + dz });
    else if (selection.kind === "wall" && w) { const room = wallRoom(w); if (room) { const k = room.wallIds.indexOf(w.id); setRoomPoly(room.id, moveEdgePoly(room.poly, k, 0).map((q, i) => (i === k || i === (k + 1) % room.poly.length ? [q[0] + dx, q[1] + dz] : q))); } else patchWall(w.id, { a: [w.a[0] + dx, w.a[1] + dz], b: [w.b[0] + dx, w.b[1] + dz] }); }
    else if (selection.kind === "op" && o) { const ww = d.walls.find((q) => q.id === o.wallId); if (ww) { const L = wallLen(ww) || 1, half = o.width / 2 / L; patchOp(o.id, { pos: clamp(o.pos + (dx + dz) / L, half, 1 - half) }); } }
    else if (selection.kind === "dim" && m) setD({ ...d, dims: d.dims.map((q) => (q.id === m.id ? { ...q, a: [q.a[0] + dx, q.a[1] + dz], b: [q.b[0] + dx, q.b[1] + dz] } : q)) });
    else return false;
    return true;
  };
  const setStoreyH = (v) => {
    const d = dRef.current, old = storeyH(d), nv = clamp(Math.round(v || 2800), 2000, 6000);
    // staircases that span exactly one storey follow the new height
    setD({ ...d, wallH: nv, items: d.items.map((i) => (i.type === "stairs" && Math.abs(i.size.H - old) < 1 ? { ...i, size: { ...i.size, H: nv } } : i)) });
  };
  /* furniture alignment helpers */
  const alignSel = (how) => {
    const d = dRef.current, it = d.items.find((i) => i.id === selId);
    if (!it) return;
    const room = d.rooms.find((r) => (r.lv || 0) === (it.lv || 0) && inRect(it, r));
    snapshot();
    if (how === "wall") { const q = snapToWalls(it, d.walls.filter((w) => (w.lv || 0) === (it.lv || 0))); patchItem(it.id, { x: q.x, z: q.z }); }
    else if (how === "cx" && room) patchItem(it.id, { x: polyCentroid(room.poly).x });
    else if (how === "cz" && room) patchItem(it.id, { z: polyCentroid(room.poly).z });
    else if (how === "square") patchItem(it.id, { rot: norm(Math.round(it.rot / 90) * 90) });
    else if (how === "floor") patchItem(it.id, { elev: 0 });
  };

  /* ---------- responsive: container width + touch detection ---------- */
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const upd = () => setVw(el.clientWidth || 1280);
    upd();
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    const mq = window.matchMedia ? window.matchMedia("(pointer: coarse)") : null;
    const mc = () => setCoarse(!!(mq && mq.matches));
    mc();
    if (mq && mq.addEventListener) mq.addEventListener("change", mc);
    return () => { ro.disconnect(); if (mq && mq.removeEventListener) mq.removeEventListener("change", mc); };
  }, []);

  /* ---------- three.js init (once) ---------- */
  useEffect(() => {
    const host = hostRef.current, s = S.current;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    const coarseNow = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, coarseNow ? 1.5 : 2));
    if ("outputColorSpace" in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf1f3f6);
    const hemi = new THREE.HemisphereLight(0xffffff, 0xcfd3da, 1.0);
    scene.add(hemi);
    // image-based lighting: a soft room environment indoors, regenerated from the sky model outdoors
    const pmrem = new THREE.PMREMGenerator(renderer);
    let envRoom = null;
    try {
      if ("environmentIntensity" in scene) { envRoom = pmrem.fromScene(new RoomEnvironment(), 0.04); scene.environment = envRoom.texture; scene.environmentIntensity = 0.35; }
    } catch (e) { /* the soft reflections are optional */ }
    const mkSky = (scale) => {
      const sk = new Sky();
      sk.scale.setScalar(scale);
      const u = sk.material.uniforms;
      u.turbidity.value = 4; u.rayleigh.value = 1.3; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.82;
      return sk;
    };
    let sky = null, envSky = null, envScene = null, stars = null;
    try {
      sky = mkSky(900); sky.visible = false; scene.add(sky);
      envScene = new THREE.Scene(); envSky = mkSky(50); envScene.add(envSky);
      const sp = new Float32Array(900 * 3);
      for (let i = 0; i < 900; i++) { const a = Math.random() * Math.PI * 2, v = Math.acos(Math.random() * 0.96 + 0.04); sp[i * 3] = 700 * Math.sin(v) * Math.cos(a); sp[i * 3 + 1] = 700 * Math.cos(v); sp[i * 3 + 2] = 700 * Math.sin(v) * Math.sin(a); }
      const sg = new THREE.BufferGeometry();
      sg.setAttribute("position", new THREE.Float32BufferAttribute(sp, 3));
      stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false }));
      stars.visible = false; scene.add(stars);
    } catch (e) { sky = null; envSky = null; envScene = null; stars = null; }
    const dir = new THREE.DirectionalLight(0xffffff, 1.7);
    dir.castShadow = true;
    dir.shadow.mapSize.set(coarseNow ? 1024 : 2048, coarseNow ? 1024 : 2048);
    dir.shadow.bias = -0.0003;
    dir.shadow.normalBias = 0.02;
    scene.add(dir, dir.target);
    const moon = new THREE.DirectionalLight(0x8fa8d8, 0);
    scene.add(moon, moon.target);
    // a fixed pool of warm room lights (their strength follows the time of day) so shaders never recompile
    const lamps = Array.from({ length: 6 }, () => { const l = new THREE.PointLight(0xffd7a8, 0, 8, 2); scene.add(l); return l; });
    const grid = new THREE.GridHelper(60, 120, 0xd9dce1, 0xe7e9ed);
    grid.position.y = -0.125;
    scene.add(grid);

    const furn = new THREE.Group();
    scene.add(furn);

    const persp = new THREE.PerspectiveCamera(42, 1, 0.08, 2000);
    const oc = new OrbitControls(persp, renderer.domElement);
    oc.maxPolarAngle = Math.PI / 2 - 0.03;
    oc.minDistance = 1.2;
    oc.maxDistance = 90;

    const tc = new TransformControls(persp, renderer.domElement);
    tc.setSize(coarseNow ? 1.3 : 0.9);
    scene.add(tc.getHelper ? tc.getHelper() : tc);
    tc.addEventListener("dragging-changed", (e) => {
      oc.enabled = !e.value; s.dragging = e.value;
      if (e.value) snapshot();
      else if (tc.object) {
        const it = dRef.current.items.find((i) => i.id === tc.object.userData.id);
        if (it && tc.mode === "translate") { const q = snapToWalls(it, dRef.current.walls); if (q.x !== it.x || q.z !== it.z) patchItem(it.id, q); }
      }
    });
    tc.addEventListener("objectChange", () => {
      const g = tc.object;
      if (!g) return;
      if (tc.mode === "scale") {
        // the gizmo scales the model's group; read the new size back (mirroring uses a negative x scale)
        const sc = (v) => clamp(Math.abs(v) / MM, 10, 6000);
        patchItem(g.userData.id, { size: { L: sc(g.scale.x), H: sc(g.scale.y), W: sc(g.scale.z) } });
      } else patchItem(g.userData.id, { x: g.position.x / MM, z: g.position.z / MM, rot: norm((g.rotation.y * 180) / Math.PI) });
    });
    const box = new THREE.BoxHelper(new THREE.Object3D(), 0x2f6df0);
    box.visible = false;
    scene.add(box);
    const hoverBox = new THREE.BoxHelper(new THREE.Object3D(), 0xff9d2e);
    hoverBox.visible = false;
    scene.add(hoverBox);

    Object.assign(s, { renderer, scene, dir, hemi, pmrem, envRoom, sky, envSky, envScene, stars, moon, lamps, keys: new Set(), grid, furn, persp, oc, tc, box, floorTex: makeFloorTextures(), struct: null, ext: null, boxTarget: null, dragging: false, bb: bboxOf(dRef.current), homeDist: 10 });

    const sizeIt = () => {
      const w = host.clientWidth, h = host.clientHeight;
      if (w < 2 || h < 2) return;
      renderer.setSize(w, h);
      persp.aspect = w / h;
      persp.updateProjectionMatrix();
    };
    sizeIt();
    const ro = new ResizeObserver(sizeIt);
    ro.observe(host);

    let lastZoom = 100;
    oc.addEventListener("change", () => {
      if (s.mode === "plan") return;
      const z = Math.round((100 * s.homeDist) / persp.position.distanceTo(oc.target));
      if (z !== lastZoom) { lastZoom = z; setZoomPct(z); }
    });

    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    s.pick = (cx, cy) => {
      if (s.mode !== "interior") return null;
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, persp);
      const hit = ray.intersectObjects([...s.groups.values()].filter((g) => g.visible && (g.userData.level || 0) === lvRef.current), true)[0];
      if (!hit) return null;
      let o = hit.object;
      while (o && !o.userData.id) o = o.parent;
      return o ? o.userData.id : null;
    };
    /* Click-to-select anything: furniture, doors, windows, walls and (indoors) floors. Walls report the exact wall that was drawn. */
    const classify = (hit) => {
      let q = hit.object;
      while (q && !(q.userData && (q.userData.id || q.userData.kind))) q = q.parent;
      if (!q) return null;
      const u = q.userData;
      if (u.kind === "op") return { kind: "op", id: u.id, obj: q, level: u.level };
      if (u.kind === "room") return { kind: "room", id: u.id, obj: q, level: u.level };
      if (u.kind === "wall") {
        const local = q.worldToLocal(hit.point.clone()), along = u.start + (local.x + u.L / 2) / MM;
        const m = u.members.find((mm) => along >= mm.s - 5 && along <= mm.e + 5) || u.members[0];
        return { kind: "wall", id: m.id, obj: q, level: u.level };
      }
      return { kind: "item", id: u.id, obj: q, level: u.level || 0 };
    };
    s.pickAny = (cx, cy) => {
      if (s.mode === "plan" || s.walk) return null;
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, persp);
      const hits = ray.intersectObjects([...s.groups.values(), s.struct].filter(Boolean), true);
      for (const h of hits) {
        let vis = true;
        for (let q = h.object; q; q = q.parent) if (q.visible === false) { vis = false; break; }
        if (!vis) continue;
        const c = classify(h);
        if (!c) continue;
        if (s.mode === "interior" && c.level !== lvRef.current) continue;
        if (s.mode === "exterior" && c.kind === "room") continue;
        return c;
      }
      return null;
    };
    let down = null, onGizmo = false;
    const dom = renderer.domElement;
    const act = new Set();
    let multi = false, press = null;
    const onDown = (e) => {
      act.add(e.pointerId);
      if (act.size > 1) multi = true;
      down = { x: e.clientX, y: e.clientY };
      onGizmo = !!tc.axis;
      clearTimeout(press);
      if (e.pointerType === "touch" && act.size === 1) {
        press = setTimeout(() => {
          if (!down || multi || s.dragging) return;
          const id = s.pick(down.x, down.y);
          if (id) { const r = host.getBoundingClientRect(); setSelId(id); setMenu({ x: down.x - r.left, y: down.y - r.top, id }); down = null; }
        }, 550);
      }
    };
    let hoverRaf = 0, lastMove = null;
    const hoverTick = () => {
      hoverRaf = 0;
      const tip = tipRef.current, m = lastMove;
      const hide = () => { s.hoverTarget = null; if (tip) tip.style.visibility = "hidden"; };
      if (!m || s.dragging || s.walk || s.mode === "plan" || act.size > 0) { hide(); return; }
      const h = s.pickAny(m.x, m.y), cur = selRef.current;
      if (!h || (cur && cur.kind === h.kind && cur.id === h.id)) { hide(); return; }
      s.hoverTarget = h.obj;
      if (!tip) return;
      const d = dRef.current, u = unitRef.current;
      let txt = "";
      if (h.kind === "item") { const it = d.items.find((i) => i.id === h.id); txt = it ? it.name : ""; }
      else if (h.kind === "wall") { const w = d.walls.find((q) => q.id === h.id); txt = w ? "Wall · " + fmtLen(wallLen(w), u) + " long, " + fmtLen(w.t, u) + " thick" : ""; }
      else if (h.kind === "op") { const o = d.openings.find((q) => q.id === h.id); txt = o ? (o.type === "door" ? "Door " : "Window ") + fmtLen(o.width, u) + " × " + fmtLen(o.h, u) : ""; }
      else { const r = d.rooms.find((q) => q.id === h.id); txt = r ? r.name + " · " + fmtArea(roomArea(r), u) : ""; }
      const r0 = host.getBoundingClientRect();
      tip.textContent = txt;
      tip.style.left = m.x - r0.left + 14 + "px";
      tip.style.top = m.y - r0.top + 16 + "px";
      tip.style.visibility = txt ? "visible" : "hidden";
    };
    const onMove = (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) clearTimeout(press);
      lastMove = { x: e.clientX, y: e.clientY };
      if (e.pointerType === "mouse" && !hoverRaf) hoverRaf = requestAnimationFrame(hoverTick);
    };
    const onLeave = () => { lastMove = null; s.hoverTarget = null; if (tipRef.current) tipRef.current.style.visibility = "hidden"; };
    const onUp = (e) => {
      clearTimeout(press);
      act.delete(e.pointerId);
      const wasMulti = multi;
      if (!act.size) multi = false;
      if (!down || e.button !== 0) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
      if (!moved && !onGizmo && !wasMulti) {
        const h = s.pickAny(e.clientX, e.clientY);
        if (h && h.kind === "item") setSelId(h.id);
        else if (h) setSelection({ kind: h.kind, id: h.id });
        else setSelection(null);
        setMenu(null); setMatOpen(false);
      }
      down = null;
    };
    const onCancel = (e) => { clearTimeout(press); act.delete(e.pointerId); if (!act.size) multi = false; down = null; };
    const onCtx = (e) => {
      e.preventDefault();
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      const id = s.pick(e.clientX, e.clientY);
      if (id) { const r = host.getBoundingClientRect(); setSelId(id); setMenu({ x: e.clientX - r.left, y: e.clientY - r.top, id }); } else setMenu(null);
    };
    dom.addEventListener("pointerdown", onDown);
    dom.addEventListener("pointerup", onUp);
    dom.addEventListener("pointermove", onMove);
    dom.addEventListener("pointercancel", onCancel);
    dom.addEventListener("contextmenu", onCtx);
    dom.addEventListener("pointerleave", onLeave);
    const kd = (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable) return; // typing in a field is never movement
      if (e.ctrlKey || e.metaKey || e.altKey) return; // Ctrl+S, Cmd+C... must not register as W/A/S/D
      const k = e.key.toLowerCase();
      s.keys.add(k);
      if (s.walk && k.startsWith("arrow")) e.preventDefault(); // arrows walk instead of scrolling the page
      if (s.tour && ["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) setTour(false); // taking the controls ends the tour
    };
    const ku = (e) => { s.keys.delete(e.key.toLowerCase()); if (e.key === "Meta") s.keys.clear(); };
    // no stuck keys after Alt+Tab, tab switches, or the window losing focus
    const clearKeys = () => { s.keys.clear(); s.joy = null; };
    const onVis = () => { if (document.hidden) clearKeys(); };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    window.addEventListener("blur", clearKeys);
    document.addEventListener("visibilitychange", onVis);

    // first-person look: mouse drag, touch drag, or (optionally) Pointer Lock. Mouse right = look right, mouse up = look up.
    let lookId = null, lx = 0, ly = 0;
    const lookDown = (e) => {
      if (!s.walk || lookId !== null || (e.pointerType === "mouse" && e.button !== 0)) return;
      lookId = e.pointerId; lx = e.clientX; ly = e.clientY;
      try { dom.setPointerCapture(e.pointerId); } catch (err) { /* capture is optional */ }
      if (e.pointerType === "mouse" && walkRef.current.pointerLock && dom.requestPointerLock && document.pointerLockElement !== dom) {
        try { const pr = dom.requestPointerLock(); if (pr && pr.catch) pr.catch(() => flashRef.current("Mouse capture was blocked by the browser. Drag to look instead.")); } catch (err) { flashRef.current("This browser can't capture the mouse. Drag to look instead."); }
      }
    };
    const lookMove = (e) => {
      if (!s.walk) return;
      const ws = walkRef.current, h = host.clientHeight || 1;
      if (document.pointerLockElement === dom) { s.look = applyLook(s.look || { yaw: 0, pitch: 0 }, e.movementX || 0, e.movementY || 0, h, ws); return; }
      if (e.pointerId !== lookId) return;
      const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
      s.look = applyLook(s.look || { yaw: 0, pitch: 0 }, dx, dy, h, ws, e.pointerType !== "mouse");
    };
    const lookEnd = (e) => { if (e.pointerId === lookId) { lookId = null; try { dom.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ } } };
    const lockChange = () => setLockOn(document.pointerLockElement === dom);
    const lockError = () => flashRef.current("Mouse capture was blocked by the browser. Drag to look instead.");
    dom.addEventListener("pointerdown", lookDown);
    dom.addEventListener("pointermove", lookMove);
    dom.addEventListener("pointerup", lookEnd);
    dom.addEventListener("pointercancel", lookEnd);
    document.addEventListener("pointerlockchange", lockChange);
    document.addEventListener("pointerlockerror", lockError);

    const v3 = new THREE.Vector3(), bb3 = new THREE.Box3();
    /* ---- walkthrough physics lives in walkPhysics.js (capsule-style collision against walls, furniture and stairs) ---- */
    const seen = (o) => { for (let q = o; q; q = q.parent) if (q.visible === false) return false; return true; };
    let raf = 0, frame = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (s.mode === "plan") return;
      frame++;
      if (s.walk) {
        const ws = walkRef.current, now = performance.now(), dt = Math.min(0.05, (now - (s.t || now)) / 1000);
        s.t = now;
        const d0 = dRef.current, Hm = storeyH(d0) * MM, lvlNow = s.walkLv || 0, nLv = d0.levels || 1;
        if (!s.look) s.look = { yaw: 0, pitch: 0 };
        if (s.lastY === undefined || Math.abs(persp.position.y - s.lastY) > 1e-6) s.baseY = persp.position.y; // the tour (or a teleport) moved the camera
        if (s.solidsItems !== d0.items || s.solidsLv !== lvlNow) { s.solids = furnitureSolids(d0.items, lvlNow, storeyH(d0)); s.solidsItems = d0.items; s.solidsLv = lvlNow; }
        const feet0 = s.baseY - ws.eye, gy0 = groundHeight(persp.position.x, persp.position.z, feet0, d0.items, Hm, nLv);
        const cx = { walls: s.collide || [], solids: s.solids, stairs: d0.items.filter((i) => i.type === "stairs" && !i.hidden), lv: lvlNow, feetY: Math.max(feet0, gy0), storeyH: Hm, free: ws.freeCam };
        let speed = 0;
        if (s.tour) {
          s.tourAngle = (s.tourAngle || 0) + dt * 0.42;
          oc.target.set(persp.position.x + Math.cos(s.tourAngle) * 0.05, persp.position.y - 0.004, persp.position.z + Math.sin(s.tourAngle) * 0.05);
          s.look = lookFromDir(oc.target.x - persp.position.x, oc.target.y - persp.position.y, oc.target.z - persp.position.z);
          s.vel = [0, 0];
        } else {
          const kk = s.keys, joy = s.joy || { x: 0, y: 0 };
          const fw = clamp((kk.has("w") || kk.has("arrowup") ? 1 : 0) - (kk.has("s") || kk.has("arrowdown") ? 1 : 0) - joy.y, -1, 1);
          const st = clamp((kk.has("d") || kk.has("arrowright") ? 1 : 0) - (kk.has("a") || kk.has("arrowleft") ? 1 : 0) + joy.x, -1, 1);
          const sp = kk.has("shift") || s.runBtn ? ws.runSpeed : ws.walkSpeed;
          const wish = moveVector(s.look.yaw, fw, st);
          s.vel = stepVelocity(s.vel || [0, 0], [wish[0] * sp, wish[1] * sp], dt, ws.smooth);
          const ox = persp.position.x, oz = persp.position.z;
          if (Math.hypot(s.vel[0], s.vel[1]) > 1e-4) {
            const np = resolveMove([ox, oz], [s.vel[0] * dt, s.vel[1] * dt], cx);
            persp.position.x = np[0]; persp.position.z = np[1];
            s.vel = [(np[0] - ox) / Math.max(dt, 1e-4), (np[1] - oz) / Math.max(dt, 1e-4)]; // pushing into a wall must not build up speed
          } else s.vel = [0, 0];
          if (!ws.freeCam) { // if edits left the player inside a wall or furniture, move to the nearest free spot
            const free = recoverPosition([persp.position.x, persp.position.z], { ...cx, stairs: [] });
            if (free[0] !== persp.position.x || free[1] !== persp.position.z) { persp.position.x = free[0]; persp.position.z = free[1]; s.vel = [0, 0]; }
          }
          speed = Math.hypot(s.vel[0], s.vel[1]);
        }
        const feet = s.baseY - ws.eye, gy = groundHeight(persp.position.x, persp.position.z, feet, d0.items, Hm, nLv);
        s.baseY += (gy + ws.eye - s.baseY) * (1 - Math.exp(-12 * dt));
        s.bobPh = (s.bobPh || 0) + speed * dt * 5.5;
        persp.position.y = s.baseY + bobOffset(s.bobPh, speed, ws, s.prefersReduced);
        s.lastY = persp.position.y;
        if (!s.tour) { const dv = lookDir(s.look); oc.target.set(persp.position.x + dv[0] * 0.05, persp.position.y + dv[1] * 0.05, persp.position.z + dv[2] * 0.05); }
        const lvl = clamp(Math.floor((feet + 0.25) / Hm), 0, Math.max(0, nLv - 1));
        if (lvl !== s.walkLv) { s.walkLv = lvl; setWalkLv(lvl); if (s.updateLamps) s.updateLamps(); }
        const mm = miniRef.current, mi = s.mini;
        if (mm && mi && frame % 3 === 0) mm.setAttribute("transform", `translate(${mi.ox + persp.position.x * 1000 * mi.k} ${mi.oz + persp.position.z * 1000 * mi.k}) rotate(${(s.look.yaw * 180) / Math.PI})`);
        s.lampT = (s.lampT || 0) + dt;
        if (s.lampT > 0.5) { s.lampT = 0; if (s.updateLamps) s.updateLamps(); }
      } else s.t = null;
      oc.update();
      // wall cut-away
      const cp = persp.position, b = s.bb;
      s.wallGroups.forEach((g) => {
        let vis = true, sy = 1;
        if (s.mode === "interior") {
          if (s.cut === "low") sy = 0.12;
          else if (s.cut === "cut") {
            const e = g.userData.edge;
            vis = !((e === "N" && cp.z < b.z0 * MM) || (e === "S" && cp.z > b.z1 * MM) || (e === "W" && cp.x < b.x0 * MM) || (e === "E" && cp.x > b.x1 * MM));
          }
        }
        g.visible = vis; g.scale.y = sy;
      });
      if (s.boxTarget && seen(s.boxTarget)) { box.setFromObject(s.boxTarget); box.visible = true; } else box.visible = false;
      if (s.hoverTarget && s.hoverTarget.parent && !s.dragging && seen(s.hoverTarget)) { hoverBox.setFromObject(s.hoverTarget); hoverBox.visible = true; } else hoverBox.visible = false;
      const tb = tbRef.current;
      if (tb) {
        if (s.boxTarget && !s.dragging && seen(s.boxTarget)) {
          bb3.setFromObject(s.boxTarget); bb3.getCenter(v3); v3.y = bb3.max.y; v3.project(persp);
          const w = host.clientWidth, h = host.clientHeight;
          tb.style.visibility = v3.z < 1 ? "visible" : "hidden";
          tb.style.left = Math.max(150, Math.min(w - 150, ((v3.x + 1) / 2) * w)) + "px";
          tb.style.top = Math.max(70, ((1 - v3.y) / 2) * h - 14) + "px";
        } else tb.style.visibility = "hidden";
      }
      renderer.render(scene, persp);
    };
    loop();
    const thumbT = setTimeout(() => { setThumbs(makeThumbs()); setThumbsReady(true); }, 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => {
      cancelAnimationFrame(raf); cancelAnimationFrame(hoverRaf); clearTimeout(thumbT); ro.disconnect();
      dom.removeEventListener("pointerleave", onLeave);
      dom.removeEventListener("pointerdown", onDown); dom.removeEventListener("pointerup", onUp); dom.removeEventListener("pointermove", onMove); dom.removeEventListener("pointercancel", onCancel); dom.removeEventListener("contextmenu", onCtx); window.removeEventListener("keydown", kd); window.removeEventListener("keyup", ku);
      window.removeEventListener("blur", clearKeys); document.removeEventListener("visibilitychange", onVis);
      dom.removeEventListener("pointerdown", lookDown); dom.removeEventListener("pointermove", lookMove); dom.removeEventListener("pointerup", lookEnd); dom.removeEventListener("pointercancel", lookEnd);
      document.removeEventListener("pointerlockchange", lockChange); document.removeEventListener("pointerlockerror", lockError);
      try { if (document.pointerLockElement === dom) document.exitPointerLock(); } catch (err) { /* ignore */ }
      tc.dispose(); oc.dispose();
      try { if (s.envSkyRT) s.envSkyRT.dispose(); if (envRoom) envRoom.dispose(); pmrem.dispose(); } catch (e) { /* ignore */ }
      renderer.dispose();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
      s.groups.clear(); s.scene = null;
    };
  }, []);

  // the stair openings in upper slabs depend on where the staircases are, so rebuild when they move (but not for other furniture)
  const stairSig = useMemo(() => D.items.filter((i) => i.type === "stairs" && !i.hidden).map((i) => [i.id, Math.round(i.x), Math.round(i.z), i.rot, i.lv || 0, Math.round(i.size.L), Math.round(i.size.W)].join(",")).join("|"), [D.items]);
  /* ---------- rebuild walls / floors / exterior ---------- */
  useEffect(() => {
    const s = S.current;
    s.mode = mode; s.cut = cut;
    if (!s.scene || mode === "plan") return;
    if (s.struct) { s.scene.remove(s.struct); disposeTree(s.struct); s.struct = null; }
    if (s.ext) { s.scene.remove(s.ext); disposeTree(s.ext); s.ext = null; }
    const bb = bboxOf(D);
    s.bb = bb;
    const ex = mode === "exterior", walkOn = walk && mode === "interior", showAll = ex || walkOn;
    const out = buildStructure(D, bb, { maxLevel: showAll ? 99 : lv, floorTex: s.floorTex, wallColor: ex ? D.ext.wall : (D.ext.inside || "#f4f4f2"), trim: ex ? D.ext.trim : "#ffffff", finish: D.ext.finish, inFinish: D.ext.insideFinish || "paint", frame: D.ext.frame || "pvc", facade: D.ext.facade, exterior: ex, ceilings: walkOn, wallOp: showAll ? 1 : wallOp / 100, floorOp: showAll ? 1 : floorOp / 100 });
    s.struct = out.root; s.wallGroups = out.wallGroups; s.opGroups = out.opGroups; s.floorMeshes = out.floorMeshes; s.glassMats = out.glassMats; s.collide = out.collide; s.scene.add(out.root);
    if (ex) { s.ext = buildExterior(D, bb); s.scene.add(s.ext); }
    if (s.applyEnv) { s.applyEnv(); s.applyNight(); s.updateLamps(); }
    const size = Math.max((bb.x1 - bb.x0) * MM, (bb.z1 - bb.z0) * MM, 4);
    const cx = ((bb.x0 + bb.x1) / 2) * MM, cz = ((bb.z0 + bb.z1) / 2) * MM, sh = s.dir.shadow.camera, ext = size * 0.8 + (ex ? 8 : 0);
    s.dir.position.set(cx - size * 0.6, size * 1.1 + 5, cz + size * 0.4);
    s.dir.target.position.set(cx, 0, cz);
    Object.assign(sh, { left: -ext, right: ext, top: ext, bottom: -ext, near: 0.5, far: size * 3 + 30 });
    sh.updateProjectionMatrix();
  }, [D.walls, D.rooms, D.openings, D.ext, D.levels, D.wallH, stairSig, lv, mode, wallOp, floorOp, cut, walk]);

  /* ---------- camera per mode ---------- */
  const aimCamera = useCallback((m) => {
    const s = S.current;
    if (!s.scene) return;
    s.persp.up.set(0, 1, 0);
    const bb = bboxOf(dRef.current), size = Math.max((bb.x1 - bb.x0) * MM, (bb.z1 - bb.z0) * MM, 4);
    const cx = ((bb.x0 + bb.x1) / 2) * MM, cz = ((bb.z0 + bb.z1) / 2) * MM;
    const buildingHeight = Math.max(dRef.current.levels || 1, dRef.current.ext.storeys || 1) * storeyH(dRef.current) * MM;
    const tgt = new THREE.Vector3(cx, m === "exterior" ? buildingHeight * 0.46 : 0.6 + lvRef.current * (storeyH(dRef.current) * MM), cz);
    const off = m === "exterior" ? new THREE.Vector3(size * 0.9, size * 0.5 + 2 + buildingHeight * 0.55, size * 1.25 + 3) : new THREE.Vector3(size * 0.75, size * 0.85 + 1.5, size * 0.95 + 1);
    s.oc.target.copy(tgt);
    s.persp.position.copy(tgt).add(off);
    s.homeDist = off.length();
    s.oc.update();
  }, []);
  const aimInteriorTop = useCallback(() => {
    const s = S.current;
    if (!s.scene) return;
    const design = dRef.current;
    const bounds = bboxOfLevel(design, lvRef.current);
    const width = Math.max((bounds.x1 - bounds.x0) * MM, 2);
    const depth = Math.max((bounds.z1 - bounds.z0) * MM, 2);
    const aspect = Math.max(s.persp.aspect || 1, 0.1);
    const halfFov = THREE.MathUtils.degToRad(s.persp.fov) / 2;
    const distance = Math.max(depth, width / aspect) / (2 * Math.tan(halfFov)) * 1.2;
    const target = new THREE.Vector3(
      ((bounds.x0 + bounds.x1) / 2) * MM,
      lvRef.current * storeyH(design) * MM + 0.08,
      ((bounds.z0 + bounds.z1) / 2) * MM,
    );
    s.persp.up.set(0, 0, -1);
    s.oc.target.copy(target);
    s.persp.position.copy(target).add(new THREE.Vector3(0, distance, 0));
    s.homeDist = distance;
    s.oc.update();
  }, []);
  const setExteriorCamera = useCallback((view) => {
    const s = S.current;
    if (!s.scene) return;
    const bb = bboxOf(dRef.current), w = Math.max((bb.x1 - bb.x0) * MM, 4), d = Math.max((bb.z1 - bb.z0) * MM, 4);
    const height = Math.max(dRef.current.levels || 1, dRef.current.ext.storeys || 1) * storeyH(dRef.current) * MM;
    const size = Math.max(w, d, height, 4);
    const target = new THREE.Vector3(((bb.x0 + bb.x1) / 2) * MM, height * 0.46, ((bb.z0 + bb.z1) / 2) * MM);
    const directions = {
      front: new THREE.Vector3(0, 0.16, 1),
      angle: new THREE.Vector3(0.68, 0.34, 1),
      side: new THREE.Vector3(1, 0.16, 0),
      roof: new THREE.Vector3(0.38, 1.25, 0.5),
    };
    const distance = size * (view === "roof" ? 2.5 : 2.35);
    s.oc.target.copy(target);
    s.persp.position.copy(target).add(directions[view].normalize().multiplyScalar(distance));
    s.homeDist = distance;
    s.oc.update();
  }, []);
  useEffect(() => {
    const s = S.current;
    if (!s.scene) return;
    s.mode = mode;
    s.scene.background.set(mode === "exterior" ? 0xdbe9f6 : 0xf1f3f6);
    s.grid.visible = mode === "interior";
    s.furn.visible = mode === "interior";
    s.renderer.domElement.style.visibility = mode === "plan" ? "hidden" : "visible";
    if (mode === "interior" && interiorView === "top") aimInteriorTop();
    else if (mode !== "plan") aimCamera(mode);
    setMenu(null); setMatOpen(false);
  }, [mode, interiorView, aimCamera, aimInteriorTop]);

  /* ---------- walk mode ---------- */
  useEffect(() => {
    const s = S.current;
    if (!s.scene) return;
    const on = walk && mode === "interior";
    s.walk = on;
    if (on) {
      const H = storeyH(dRef.current) * MM, L = lvRef.current;
      const b = bboxOf(dRef.current), r = selRoom && (selRoom.lv || 0) === L ? polyCentroid(selRoom.poly) : { x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2 };
      s.walkLv = L; setWalkLv(L);
      const ws = walkRef.current, eyeY = ws.eye + L * H;
      s.persp.position.set(r.x * MM, eyeY, r.z * MM);
      s.oc.target.set(r.x * MM, eyeY, r.z * MM - 0.05);
      // Look is driven by our own yaw/pitch controller (per-axis inversion + Pointer Lock), so orbit rotation is off while walking.
      // rotateSpeed is kept POSITIVE: the old -0.4 is what made the mouse look the wrong way.
      s.oc.minDistance = 0.01; s.oc.maxPolarAngle = Math.PI * 0.97; s.oc.enablePan = false; s.oc.enableZoom = false; s.oc.enableRotate = false; s.oc.rotateSpeed = BASE_LOOK * ws.sens;
      s.look = { yaw: 0, pitch: 0 }; s.vel = [0, 0]; s.baseY = eyeY; s.lastY = eyeY; s.bobPh = 0; s.runBtn = false; s.joy = null; setRunOn(false);
      s.walkStart = { x: r.x * MM, y: eyeY, z: r.z * MM, lv: L };
      s.prefersReduced = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      s.persp.fov = ws.fov;
      prevCut.current = s.cut || "cut";
      setCut("full");
    } else {
      s.oc.minDistance = 1.2; s.oc.maxPolarAngle = Math.PI / 2 - 0.03; s.oc.enablePan = true; s.oc.enableZoom = true; s.oc.enableRotate = true; s.oc.rotateSpeed = 1; // normal orbit speed restored
      s.persp.fov = 42;
      s.keys.clear(); s.joy = null; s.runBtn = false; setRunOn(false); setWalkPanel(false);
      try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) { /* ignore */ }
      if (prevCut.current) { setCut(prevCut.current); prevCut.current = null; }
      if (mode === "interior" && walk === false && s.wasWalking) {
        if (interiorView === "top") aimInteriorTop();
        else aimCamera("interior");
      }
    }
    s.wasWalking = on;
    s.persp.updateProjectionMatrix();
    s.oc.update();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walk, mode]);

  /* ---------- walk settings: persist, and apply live without touching the design ---------- */
  useEffect(() => { try { saveWalk(window.localStorage, walkSet); } catch (e) { /* storage unavailable: settings still apply for this session */ } }, [walkSet]);
  useEffect(() => {
    const s = S.current;
    if (!s.scene || !s.walk) return;
    s.persp.fov = walkSet.fov; s.persp.updateProjectionMatrix(); s.oc.rotateSpeed = BASE_LOOK * walkSet.sens;
  }, [walkSet]);
  const resetWalk = () => {
    const s = S.current, w = s.walkStart;
    if (!s.scene || !s.walk || !w) return;
    s.persp.position.set(w.x, w.y, w.z); s.baseY = w.y; s.lastY = w.y; s.look = { yaw: 0, pitch: 0 }; s.vel = [0, 0];
    s.walkLv = w.lv; setWalkLv(w.lv); setTour(false); flash("Back at the start");
  };
  const resetRef = useRef(resetWalk);
  resetRef.current = resetWalk;

  /* ---------- guided tour: a slow look-around in every room, fading between them ---------- */
  useEffect(() => {
    const s = S.current;
    if (!s.scene) return undefined;
    const active = tour && walk && mode === "interior";
    if (!active) { s.tour = false; if (tour) setTour(false); return undefined; }
    const rooms = dRef.current.rooms.filter((r) => r.type !== "void").sort((a, b) => (a.lv || 0) - (b.lv || 0) || a.x - b.x);
    if (!rooms.length) { setTour(false); return undefined; }
    s.tour = true;
    let i = 0;
    const timers = [];
    const go = () => {
      const r = rooms[i % rooms.length];
      i++;
      setFade(true);
      timers.push(setTimeout(() => {
        const c = polyCentroid(r.poly), H = storeyH(dRef.current) * MM;
        s.persp.position.set(c.x * MM, 1.6 + (r.lv || 0) * H, c.z * MM);
        s.tourAngle = Math.random() * Math.PI * 2;
        s.walkLv = r.lv || 0; setWalkLv(r.lv || 0);
        setTourLabel(r.name); setFade(false);
        timers.push(setTimeout(go, 6500));
      }, 380));
    };
    go();
    return () => { timers.forEach(clearTimeout); s.tour = false; setFade(false); setTourLabel(""); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tour, walk, mode]);

  /* ---------- time of day: sun, sky, reflections, window glow and room lights ---------- */
  useEffect(() => {
    const s = S.current;
    if (!s.scene) return;
    const ex = mode === "exterior", a = ((hour - 6) / 12) * Math.PI, sunUp = hour < 6 || hour > 18 ? 0 : Math.sin(a);
    const day = clamp((Math.sin(a) + 0.08) / 0.4, 0, 1), night = 1 - day;
    const ac = clamp(a, 0.03, Math.PI - 0.03); // the shadow-casting sun never dips below the horizon
    const bb = bboxOf(dRef.current), size = Math.max((bb.x1 - bb.x0) * MM, (bb.z1 - bb.z0) * MM, 4), R = size * 1.6 + 8;
    const cx = ((bb.x0 + bb.x1) / 2) * MM, cz = ((bb.z0 + bb.z1) / 2) * MM;
    s.night = night; s.lampsOn = render.lights;
    s.dir.position.set(cx - Math.cos(ac) * R, Math.sin(ac) * R * 0.85 + 1.5, cz + R * 0.35);
    s.dir.target.position.set(cx, 0, cz);
    s.dir.intensity = 0.12 * day + 1.6 * sunUp;
    s.dir.color.copy(new THREE.Color(0xffa860).lerp(new THREE.Color(0xffffff), Math.min(1, sunUp * 2.2)));
    s.hemi.intensity = 0.08 + 0.22 * day + 0.7 * sunUp;
    s.hemi.color.set(0xffffff).lerp(new THREE.Color(0x6d7fa8), night * 0.8);
    s.hemi.groundColor.set(0xcfd3da).lerp(new THREE.Color(0x2a2f3c), night * 0.85);
    s.moon.intensity = 0.28 * night;
    s.moon.position.set(cx + R * 0.5, R * 0.9, cz - R * 0.4);
    s.moon.target.position.set(cx, 0, cz);
    s.scene.background.copy(ex ? new THREE.Color(0x1a2233).lerp(new THREE.Color(0xdbe9f6), Math.min(1, sunUp * 1.6)) : new THREE.Color(0xf1f3f6).lerp(new THREE.Color(0x161b27), night * 0.92));
    s.renderer.toneMappingExposure = render.exposure * (ex ? 0.8 : 1) * (1 + 0.5 * night);
    const sunV = new THREE.Vector3(-Math.cos(a), Math.sin(a) * 0.85, 0.35).normalize();
    if (s.sky) { s.sky.visible = ex; s.sky.material.uniforms.sunPosition.value.copy(sunV); }
    if (s.stars) { s.stars.visible = ex && night > 0.15; s.stars.material.opacity = night; }
    // reflections: outdoors from the sky model (rebuilt a moment after the slider stops), indoors from a soft room
    const useSky = ex && s.envSky && s.pmrem;
    if (useSky) {
      clearTimeout(s.envT);
      s.envT = setTimeout(() => {
        try {
          s.envSky.material.uniforms.sunPosition.value.copy(sunV);
          const rt = s.pmrem.fromScene(s.envScene, 0, 0.1, 100), old = s.envSkyRT;
          s.envSkyRT = rt; s.scene.environment = rt.texture;
          if ("environmentIntensity" in s.scene) s.scene.environmentIntensity = 0.05 + 0.5 * (0.25 + 0.75 * day);
          if (old) old.dispose();
          s.applyEnv();
        } catch (e) { /* reflections are optional */ }
      }, 120);
    } else if (s.envRoom) {
      clearTimeout(s.envT);
      s.scene.environment = s.envRoom.texture;
      if ("environmentIntensity" in s.scene) s.scene.environmentIntensity = 0.12 + 0.23 * day;
    }
    // materials that were built with an explicit reflection strength pick up whichever environment is current
    s.applyEnv = () => {
      const env = s.scene.environment;
      if (!env) return;
      [s.struct, s.ext].forEach((root) => root && root.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => { if (m.isMeshStandardMaterial && m.envMapIntensity !== 1 && m.envMap !== env) { m.envMap = env; m.needsUpdate = true; } }); }));
    };
    s.applyNight = () => {
      const on = s.lampsOn !== false;
      (s.glassMats || []).forEach((m) => { if (m.userData.base === undefined) m.userData.base = m.opacity; m.emissiveIntensity = on ? (s.night || 0) * 0.8 : 0; m.opacity = m.userData.base + (on ? (s.night || 0) * 0.22 : 0); });
    };
    s.updateLamps = () => {
      const d = dRef.current, H = storeyH(d) * MM, nt = s.night || 0, rooms = d.rooms.filter((r) => r.type !== "void" && r.type !== "balcony");
      let list;
      if (s.walk) { const p = s.persp.position; list = rooms.map((r) => { const c = polyCentroid(r.poly); return { r, d: Math.hypot(c.x * MM - p.x, c.z * MM - p.z) + Math.abs((r.lv || 0) * H + 1.6 - p.y) * 2 }; }).sort((x, y) => x.d - y.d).map((q) => q.r); }
      else if (s.mode === "interior") list = rooms.filter((r) => (r.lv || 0) === lvRef.current).sort((x, y) => roomArea(y) - roomArea(x));
      else list = [...rooms].sort((x, y) => (x.lv || 0) - (y.lv || 0) || roomArea(y) - roomArea(x));
      s.lamps.forEach((l, i) => {
        const r = list[i];
        if (!r || s.lampsOn === false || nt < 0.02) { l.intensity = 0; return; }
        const c = polyCentroid(r.poly);
        l.position.set(c.x * MM, (r.lv || 0) * H + H - 0.35, c.z * MM);
        l.intensity = 11 * nt * clamp(roomArea(r) / 12, 0.7, 1.8);
      });
    };
    s.applyEnv(); s.applyNight(); s.updateLamps();
    return () => clearTimeout(s.envT);
  }, [hour, mode, D.walls, D.rooms, D.wallH, render.exposure, render.lights, lv, walk]);

  /* ---------- furniture sync ---------- */
  useEffect(() => {
    const s = S.current;
    if (!s.scene) return;
    const seen = new Set();
    D.items.forEach((it) => {
      seen.add(it.id);
      const c = CAT[it.type];
      if (!c) return;
      const v = c.variants[it.variant] || c.variants[0], sig = it.type + ":" + it.variant + (it.spiral ? ":sp" : "") + (it.type === "stairs" ? ":" + Math.round(it.size.L) + "x" + Math.round(it.size.W) + "x" + Math.round(it.size.H) : "");
      let g = s.groups.get(it.id);
      if (g && g.userData.sig !== sig) { if (s.tc.object === g) s.tc.detach(); s.furn.remove(g); s.groups.delete(it.id); g = null; }
      if (!g) { g = buildModel(it.type, it.variant, !!it.spiral, it.size); g.userData = { id: it.id, sig }; s.furn.add(g); s.groups.set(it.id, g); }
      paint(g, v, it.color);
      g.userData.level = it.lv || 0;
      g.position.set(it.x * MM, (it.elev + (it.lv || 0) * storeyH(D)) * MM, it.z * MM);
      g.rotation.y = (it.rot * Math.PI) / 180;
      g.scale.set((it.mirror ? -1 : 1) * it.size.L * MM, it.size.H * MM, it.size.W * MM);
      g.visible = !it.hidden && (it.lv || 0) <= (walk && mode === "interior" ? 99 : lv);
    });
    s.groups.forEach((g, id) => { if (!seen.has(id)) { if (s.tc.object === g) s.tc.detach(); s.furn.remove(g); s.groups.delete(id); } });
    const it = D.items.find((i) => i.id === selId), g = it && s.groups.get(it.id);
    if (g && !it.hidden && !it.locked && mode === "interior" && !walk) { if (s.tc.object !== g) s.tc.attach(g); } else if (s.tc.object) s.tc.detach();
  }, [D.items, D.wallH, selId, mode, lv, walk]);

  /* highlight box (and floating toolbar anchor) for whatever is selected in 3D: furniture, wall, door, window or floor */
  useEffect(() => {
    const s = S.current;
    if (!s.scene) return;
    let t = null;
    if (selection && mode !== "plan" && !walk) {
      if (selection.kind === "item") { const it = D.items.find((i) => i.id === selection.id), g = it && s.groups.get(it.id); if (g && !it.hidden && mode === "interior") t = g; }
      else if (selection.kind === "wall") t = (s.wallGroups || []).find((g) => g.userData.members.some((m) => m.id === selection.id)) || null;
      else if (selection.kind === "op") t = (s.opGroups && s.opGroups.get(selection.id)) || null;
      else if (selection.kind === "room" && mode === "interior") t = (s.floorMeshes && s.floorMeshes.get(selection.id)) || null;
    }
    s.boxTarget = t;
  }, [selection, D, mode, lv, walk, wallOp, floorOp, cut]);

  useEffect(() => { if (lv >= nL) setLv(nL - 1); }, [nL, lv]);
  const lvFirst = useRef(true);
  useEffect(() => { if (lvFirst.current) { lvFirst.current = false; return; } setSelection(pendSel.current); pendSel.current = null; }, [lv]);
  /* select something that lives on another floor: switch floor first without losing the selection */
  const goPlan = () => {
    const sl = selection, d = dRef.current, lists = { item: d.items, room: d.rooms, wall: d.walls, op: d.openings };
    const lvl = sl ? ((lists[sl.kind] || []).find((x) => x.id === sl.id) || {}).lv || 0 : lvRef.current;
    if (sl && lvl !== lvRef.current) { pendSel.current = sl; setLv(lvl); }
    setMode("plan");
  };
  const selectAt = (sel, level) => { if (level !== lvRef.current) { pendSel.current = sel; setLv(level); } else setSelection(sel); };
  useEffect(() => {
    if (mode !== "interior" || walk) return;
    if (interiorView === "top") aimInteriorTop();
    else aimCamera("interior");
    /* eslint-disable-next-line */
  }, [lv]);

  useEffect(() => {
    const tc = S.current.tc;
    if (!tc) return;
    tc.setMode(tool);
    tc.showX = tool !== "rotate"; tc.showY = tool === "rotate" || tool === "scale"; tc.showZ = tool !== "rotate";
    try { tc.setTranslationSnap(itemSnap ? 0.05 : null); tc.setRotationSnap(itemSnap ? THREE.MathUtils.degToRad(15) : null); } catch (e) { /* older builds */ }
  }, [tool, selId, itemSnap]);
  useEffect(() => { setMatOpen(false); setReplaceOpen(false); }, [selection]);
  useEffect(() => {
    if (!selection) return;
    const lists = { item: D.items, room: D.rooms, wall: D.walls, op: D.openings, dim: D.dims || [] };
    if (!(lists[selection.kind] || []).some((x) => x.id === selection.id)) setSelection(null);
  }, [D, selection]);
  useEffect(() => {
    const s = S.current;
    if (!s.scene) return;
    s.renderer.shadowMap.enabled = live; s.dir.castShadow = live;
    s.renderer.toneMapping = live ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    s.scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => { m.needsUpdate = true; }); });
  }, [live]);

  /* ---------- render quality: shadow resolution, softness and pixel ratio ---------- */
  useEffect(() => {
    const s = S.current;
    if (!s.scene) return;
    const hi = render.quality === "high", sz = hi ? (coarse ? 2048 : 4096) : coarse ? 1024 : 2048;
    if (s.dir.shadow.mapSize.x !== sz) { s.dir.shadow.mapSize.set(sz, sz); if (s.dir.shadow.map) { s.dir.shadow.map.dispose(); s.dir.shadow.map = null; } }
    s.dir.shadow.radius = hi ? 4 : 2;
    s.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, hi ? (coarse ? 1.5 : 2) : 1.25));
    const h = hostRef.current;
    if (h && h.clientWidth > 1 && h.clientHeight > 1) s.renderer.setSize(h.clientWidth, h.clientHeight);
  }, [render.quality, coarse]);

  /* ---------- plan sizing / fit ---------- */
  useEffect(() => {
    const el = planWrap.current;
    if (!el) return;
    const upd = () => setPSize({ w: el.clientWidth || 800, h: el.clientHeight || 600 });
    upd();
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fitPlan = useCallback(() => {
    const el = planWrap.current, W = (el && el.clientWidth) || pSize.w, Hh = (el && el.clientHeight) || pSize.h;
    const bb = bboxOf(dRef.current), w = Math.max(bb.x1 - bb.x0, 3000), h = Math.max(bb.z1 - bb.z0, 3000);
    const mx = Math.min(200, W * 0.1), my = Math.min(220, Hh * 0.22);
    const k = Math.min((W - mx) / w, (Hh - my) / h, 0.3);
    setPv({ k, tx: W / 2 - ((bb.x0 + bb.x1) / 2) * k, ty: Hh / 2 - ((bb.z0 + bb.z1) / 2) * k + 16 });
  }, [pSize]);
  useEffect(() => { if (mode === "plan") fitPlan(); /* eslint-disable-next-line */ }, [mode, pSize.w > pSize.h]);

  /* minimap for the walkthrough: the current floor's walls fitted into a small square; the player marker is moved by the render loop */
  const mini = useMemo(() => {
    if (!walk) return null;
    const b = bboxOf({ walls: D.walls, rooms: D.rooms });
    if (b.empty) return null;
    const W = 150, pad = 9, bw = Math.max(b.x1 - b.x0, 1), bh = Math.max(b.z1 - b.z0, 1), k = Math.min((W - pad * 2) / bw, (W - pad * 2) / bh);
    return { W, k, ox: pad + ((W - pad * 2) - bw * k) / 2 - b.x0 * k, oz: pad + ((W - pad * 2) - bh * k) / 2 - b.z0 * k, walls: D.walls.filter((w) => (w.lv || 0) === walkLv), rooms: D.rooms.filter((r) => (r.lv || 0) === walkLv && r.type !== "void") };
  }, [walk, walkLv, D.walls, D.rooms]);
  S.current.mini = mini;
  const teleport = (x, z) => {
    const s = S.current;
    if (!s.scene || !s.walk) return;
    const dx = x * MM - s.persp.position.x, dz = z * MM - s.persp.position.z;
    s.persp.position.x += dx; s.persp.position.z += dz; s.oc.target.x += dx; s.oc.target.z += dz;
    if (s.tour) setTour(false);
    if (s.updateLamps) s.updateLamps();
  };

  /* ---------- zoom helpers ---------- */
  const zoomBy = (f) => {
    if (mode === "plan") {
      setPv((p) => { const k = Math.min(1.2, Math.max(0.02, p.k / f)); const cx = (pSize.w / 2 - p.tx) / p.k, cz = (pSize.h / 2 - p.ty) / p.k; return { k, tx: pSize.w / 2 - cx * k, ty: pSize.h / 2 - cz * k }; });
    } else { const s = S.current; s.persp.position.sub(s.oc.target).multiplyScalar(f).add(s.oc.target); s.oc.update(); }
  };
  const fit = () => (mode === "plan" ? fitPlan() : mode === "interior" && interiorView === "top" ? aimInteriorTop() : aimCamera(mode));
  const zoomBox = (b) => {
    const s = S.current, c = b.getCenter(new THREE.Vector3()), sz = b.getSize(new THREE.Vector3());
    const dv = s.persp.position.clone().sub(s.oc.target).normalize();
    s.oc.target.copy(c); s.persp.position.copy(c).addScaledVector(dv, Math.max(sz.x, sz.y, sz.z) * 2.2 + 1.5); s.oc.update();
  };
  const zoomSelection = (id) => { const g = S.current.groups.get(id); if (g) zoomBox(new THREE.Box3().setFromObject(g)); };
  const focusRoom = (r) => {
    setSelection({ kind: "room", id: r.id });
    if (mode === "interior") zoomBox(new THREE.Box3(new THREE.Vector3(r.x * MM, 0, r.z * MM), new THREE.Vector3((r.x + r.w) * MM, 1.2, (r.z + r.d) * MM)));
  };

  /* ---------- keyboard ---------- */
  const save = () => {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(dRef.current)); flash("Design saved"); return true; }
    catch (e) { flash("Could not save in this browser"); return false; }
  };
  const saveAndShare = () => {
    if (!save()) return;
    setShareError("");
    setShareFile(null);
    setShareStage("contact");
    setShareOpen(true);
  };
  const prepareShareBooklet = async () => {
    const phone = ownerPhone.replace(/\D/g, "");
    if (phone.length < 8 || phone.length > 15) {
      setShareError("Enter the owner’s WhatsApp number with country code (8–15 digits).");
      return;
    }

    setShareError("");
    setShareStage("generating");
    const original = { mode, walk, lv };
    const design = normalizeD(JSON.parse(JSON.stringify(dRef.current)));
    const settle = () => new Promise((resolve) => window.setTimeout(resolve, 180));
    const capture3D = () => {
      const s = S.current;
      if (!s.renderer || !s.scene || !s.persp) throw new Error("The 3D view is not ready yet.");
      s.renderer.render(s.scene, s.persp);
      return s.renderer.domElement.toDataURL("image/png");
    };

    try {
      setWalk(false);
      setMode("interior");
      setLv(Math.min(original.lv, (design.levels || 1) - 1));
      await settle();
      const interiorImage = capture3D();

      setWalk(true);
      await settle();
      const walkImage = capture3D();

      setWalk(false);
      setMode("exterior");
      await settle();
      setExteriorCamera("angle");
      await settle();
      const exteriorImage = capture3D();

      setMode("plan");
      const plans = [];
      for (let level = 0; level < (design.levels || 1); level += 1) {
        setLv(level);
        await settle();
        const svg = svgRef.current;
        if (!svg) throw new Error("The floor plan view is not ready yet.");
        const clone = svg.cloneNode(true);
        const bounds = bboxOf(design), pad = 1200;
        const width = Math.max(bounds.x1 - bounds.x0 + pad * 2, 2400);
        const height = Math.max(bounds.z1 - bounds.z0 + pad * 2, 2400);
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        clone.setAttribute("viewBox", `${bounds.x0 - pad} ${bounds.z0 - pad} ${width} ${height}`);
        clone.setAttribute("width", "1600");
        clone.setAttribute("height", String(Math.round(1600 * height / width)));
        clone.removeAttribute("class");
        clone.removeAttribute("style");
        const group = clone.querySelector("g");
        if (group) group.setAttribute("transform", "");
        plans.push({ level: level + 1, image: svgDataUri(new XMLSerializer().serializeToString(clone)) });
      }

      const bill = estimate(design);
      const roomCards = buildRoomDetails(design).map((room) => {
        const wallRows = room.walls.map((wall) => (
          `<tr><td>Wall ${wall.index}</td><td>${escapeHtml(fmtLen(wall.length, design.unit))}</td><td>${escapeHtml(fmtLen(wall.thickness, design.unit))}</td><td>${escapeHtml(fmtLen(wall.height, design.unit))}</td><td>${escapeHtml(fmtLen(wall.start[0], design.unit))}, ${escapeHtml(fmtLen(wall.start[1], design.unit))} → ${escapeHtml(fmtLen(wall.end[0], design.unit))}, ${escapeHtml(fmtLen(wall.end[1], design.unit))}</td></tr>`
        )).join("");
        const openingRows = room.openings.map((opening) => (
          `<tr><td>${escapeHtml(opening.type)}</td><td>${escapeHtml(opening.style)}</td><td>${escapeHtml(fmtLen(opening.width, design.unit))} × ${escapeHtml(fmtLen(opening.height, design.unit))}</td><td>${opening.type === "window" ? escapeHtml(fmtLen(opening.sill, design.unit)) : "—"}</td><td>Wall ${opening.wall}, ${escapeHtml(fmtLen(opening.distanceFromWallStart, design.unit))} from start</td><td>${opening.type === "door" ? `${opening.hinge === "r" ? "Right" : "Left"} hinge${opening.swingReversed ? " · reverse swing" : ""}` : `${opening.panes ? `${opening.panes} panes` : "Automatic panes"}${opening.color ? ` · ${escapeHtml(opening.color)}` : ""}`}</td></tr>`
        )).join("");
        const itemRows = room.items.map((item) => (
          `<tr><td>${escapeHtml(item.name)}${item.variant ? ` · ${escapeHtml(item.variant)}` : ""}${item.color ? ` · ${escapeHtml(item.color)}` : ""}</td><td>${escapeHtml(item.type)}${item.hidden ? " · Hidden" : ""}${item.locked ? " · Locked" : ""}</td><td>${escapeHtml(fmtLen(item.size.L || 0, design.unit))} × ${escapeHtml(fmtLen(item.size.W || 0, design.unit))} × ${escapeHtml(fmtLen(item.size.H || 0, design.unit))}</td><td>${escapeHtml(fmtLen(item.x, design.unit))}, ${escapeHtml(fmtLen(item.z, design.unit))}</td><td>${escapeHtml(fmtLen(item.elevation, design.unit))}; ${escapeHtml(item.rotation)}°</td></tr>`
        )).join("");
        const vertexRows = room.walls.map((wall) => (
          `<li>Point ${wall.index}: X ${escapeHtml(fmtLen(wall.start[0], design.unit))}, Z ${escapeHtml(fmtLen(wall.start[1], design.unit))}</li>`
        )).join("");
        return `<article class="room-card"><h3>${escapeHtml(room.name)}</h3>
<dl class="room-facts"><div><dt>Room type</dt><dd>${escapeHtml(room.type)}</dd></div><div><dt>Floor</dt><dd>${room.floor}</dd></div><div><dt>Area</dt><dd>${escapeHtml(fmtArea(room.area, design.unit, 2))}</dd></div><div><dt>Perimeter</dt><dd>${escapeHtml(fmtLen(room.perimeter, design.unit))}</dd></div><div><dt>Overall dimensions</dt><dd>${escapeHtml(fmtLen(room.width, design.unit))} × ${escapeHtml(fmtLen(room.depth, design.unit))}</dd></div><div><dt>Storey height</dt><dd>${escapeHtml(fmtLen(room.height, design.unit))}</dd></div><div><dt>Floor finish</dt><dd>${escapeHtml(room.floorFinish)}</dd></div><div><dt>Interior wall finish</dt><dd>${escapeHtml(room.wallFinish)} · ${escapeHtml(room.wallColor)}</dd></div><div><dt>Plan position</dt><dd>X ${escapeHtml(fmtLen(room.x, design.unit))}, Z ${escapeHtml(fmtLen(room.z, design.unit))}</dd></div></dl>
<h4>Room boundary</h4><ul class="room-points">${vertexRows}</ul>
<h4>Wall segments</h4><div class="table-scroll"><table><thead><tr><th>Segment</th><th>Length</th><th>Thickness</th><th>Height</th><th>Start → end (X, Z)</th></tr></thead><tbody>${wallRows}</tbody></table></div>
<h4>Doors and windows</h4>${openingRows ? `<div class="table-scroll"><table><thead><tr><th>Opening</th><th>Style</th><th>Width × height</th><th>Sill</th><th>Position</th><th>Operation / panes</th></tr></thead><tbody>${openingRows}</tbody></table></div>` : "<p>No doors or windows assigned to this room.</p>"}
<h4>Furniture and fixtures</h4>${itemRows ? `<div class="table-scroll"><table><thead><tr><th>Item</th><th>Type</th><th>Length × width × height</th><th>Position (X, Z)</th><th>Elevation; rotation</th></tr></thead><tbody>${itemRows}</tbody></table></div>` : "<p>No furniture or fixtures placed in this room.</p>"}
</article>`;
      }).join("");
      const billRows = bill.lines.map((line) => (
        `<tr><td>${escapeHtml(line.label)}</td><td>${escapeHtml(line.qty)} ${escapeHtml(line.unit)}</td><td>${escapeHtml(bill.cur)} ${Number(line.total).toLocaleString()}</td></tr>`
      )).join("");
      const furniture = [...new Set(design.items.map((item) => CAT[item.type]?.name || item.type))];
      const date = new Date().toLocaleDateString();
      const image = (src, alt) => `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`;
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>House design booklet</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f4f1eb;color:#25221e;font:16px/1.55 Arial,sans-serif}.book{max-width:1000px;margin:auto;background:#fff;padding:clamp(20px,5vw,56px)}header{border-bottom:3px solid #c89d51;padding-bottom:22px;margin-bottom:28px}h1,h2{font-family:Georgia,serif;line-height:1.15}h1{font-size:clamp(30px,6vw,48px);margin:0 0 8px}h2{font-size:26px;margin:34px 0 12px}p{color:#625d56}.view{margin:12px 0 22px;padding:12px;border:1px solid #e5dfd4;border-radius:12px;break-inside:avoid}.view img{display:block;width:100%;max-height:70vh;object-fit:contain;background:#f4f5f6;border-radius:6px}.view h3{margin:4px 0 10px;font-size:17px}.room-card{margin:16px 0;padding:18px;border:1px solid #e5dfd4;border-radius:12px;break-inside:avoid-page}.room-card h3{font-size:21px;margin:0 0 14px}.room-card h4{font-size:15px;margin:18px 0 6px}.room-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin:0}.room-facts div{padding:9px 11px;background:#f7f4ef;border-radius:8px;min-width:0}.room-facts dt{font-size:12px;color:#746e65}.room-facts dd{margin:3px 0 0;font-weight:600;overflow-wrap:anywhere}.room-points{margin:0;padding-left:22px;columns:2}.room-points li{break-inside:avoid}.table-scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;margin:8px 0 18px;font-size:13px}th,td{text-align:left;padding:8px;border-bottom:1px solid #e8e3db;vertical-align:top}th{background:#f7f4ef;white-space:nowrap}td{overflow-wrap:anywhere}.total{font-size:20px;font-weight:bold;color:#674c1d}.note{font-size:13px;color:#746e65;border-top:1px solid #e5dfd4;padding-top:16px}@media(max-width:600px){.room-points{columns:1}.room-card{padding:12px}table{font-size:12px}th,td{padding:7px}}@media print{body{background:#fff}.book{padding:0}h2{break-after:avoid}.view,.room-card{break-inside:avoid}}
</style></head><body><main class="book"><header><h1>House design booklet</h1><p>Prepared ${escapeHtml(date)} · ${design.levels || 1} floor${(design.levels || 1) === 1 ? "" : "s"} · ${design.rooms.length} rooms</p></header>
<h2>Walkthrough view</h2><p>A first-person preview from inside the design.</p><section class="view">${image(walkImage, "First-person walkthrough preview")}</section>
<h2>3D interior view</h2><section class="view">${image(interiorImage, "3D interior view")}</section>
<h2>Exterior look</h2><section class="view">${image(exteriorImage, "3D exterior view")}</section>
<h2>Floor plans</h2>${plans.map((plan) => `<section class="view"><h3>Floor ${plan.level}</h3>${image(plan.image, `Floor ${plan.level} plan`)}</section>`).join("")}
<h2>Room-by-room details</h2><p>Complete room schedule, including dimensions, wall segments, finishes, openings, and placed furniture and fixtures.</p>${roomCards || "<p>No rooms have been added to the design yet.</p>"}
<h2>Materials and estimate</h2><p>Furniture and fixtures in this design: ${escapeHtml(furniture.length ? furniture.join(", ") : "None added")}.</p>${billRows ? `<table><thead><tr><th>Work / material</th><th>Quantity</th><th>Estimate</th></tr></thead><tbody>${billRows}</tbody></table>` : "<p>No quantity items are available yet.</p>"}
<p class="total">Estimated total: ${escapeHtml(bill.cur)} ${Number(bill.total).toLocaleString()}</p><p class="note">Concept design and preliminary quantities only. Confirm dimensions, materials, structural details, local approvals and final pricing with a qualified architect/engineer and the construction team before building.</p>
</main></body></html>`;
      const name = `house-design-${new Date().toISOString().slice(0, 10)}.html`;
      const file = new File([html], name, { type: "text/html" });
      const url = URL.createObjectURL(file);
      setShareFile(file);
      setShareFileName(name);
      setShareUrl(url);
      setShareStage("ready");
    } catch (error) {
      setShareError(`The design was saved, but the booklet could not be created: ${error.message}`);
      setShareStage("contact");
    } finally {
      setWalk(original.walk);
      setMode(original.mode);
      setLv(original.lv);
    }
  };
  const shareOnWhatsApp = async () => {
    const phone = ownerPhone.replace(/\D/g, "");
    const message = `I’ve prepared the house design booklet (${shareFileName}). It includes every room’s dimensions, finishes, walls, openings and furniture, plus the floor plans, 3D views and preliminary estimate.`;
    const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
    if (shareFile && navigator.share && navigator.canShare && navigator.canShare({ files: [shareFile] })) {
      try {
        await navigator.share({ files: [shareFile], title: "House design booklet", text: message });
        setShareOpen(false);
      } catch (error) {
        if (error.name === "AbortError") return;
        setShareError(`Direct file sharing was unavailable. Open WhatsApp and attach ${shareFileName}; download the booklet first if needed.`);
        window.open(url, "_blank", "noopener,noreferrer");
      }
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
    setShareError(`WhatsApp was opened. Download ${shareFileName}, then attach it as a document so the owner can open it in a browser.`);
  };
  useEffect(() => {
    const onKey = (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      if (mod && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (mod && k === "y") { e.preventDefault(); redo(); }
      else if (mod && k === "s") { e.preventDefault(); save(); }
      else if (mod && k === "c") { if (selection) { e.preventDefault(); copySelection(false); } }
      else if (mod && k === "x") { if (selection) { e.preventDefault(); copySelection(true); } }
      else if (mod && k === "v") { e.preventDefault(); pasteClipboard(); }
      else if (mod && k === "d") { if (selection) { e.preventDefault(); duplicateSelection(); } }
      else if ((e.key === "Delete" || e.key === "Backspace") && selection) deleteSelection();
      else if (e.key === "Escape") { setSelection(null); setMenu(null); setDraft(null); setPtool("select"); setWalk(false); setTour(false); showGuides([]); }
      else if (walk && mode === "interior") { if (k === "r" && !mod) resetRef.current(); } // editor hotkeys (R = rotate tool, G, E...) are off while walking; R returns to the start
      else if (e.key.startsWith("Arrow") && selection && !walk && !mod && mode !== "exterior") {
        const step = e.altKey ? 10 : (e.shiftKey ? 10 : 1) * (snapOn ? gridSize : 50), dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0, dz = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        if (nudge(dx, dz)) e.preventDefault();
      }
      else if ((k === "[" || k === "]") && selId) { const it = dRef.current.items.find((i) => i.id === selId); if (it && !it.locked) { snapshot(); patchItem(it.id, { rot: norm(it.rot + (k === "]" ? 15 : -15)) }); } }
      else if (mode === "plan") { const m = { v: "select", r: "room", w: "wall", d: "door", n: "window", m: "measure", p: "poly" }[k]; if (m && !mod) { setPtool(m); setDraft(null); showGuides([]); } }
      else if (k === "g") setTool("translate");
      else if (k === "r") setTool("rotate");
      else if (k === "e") setTool("scale");
      else if (k === "f" && selId && mode === "interior") zoomSelection(selId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, selId, mode, undo, redo, duplicate, deleteSelection, walk, snapOn, gridSize]);

  /* ---------- file actions ---------- */
  const exportJson = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(dRef.current, null, 2)], { type: "application/json" }));
    a.download = "builder3d-house.json"; a.click(); URL.revokeObjectURL(a.href); setFileOpen(false);
  };
  const importJson = (file) => {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        if (d && d.rooms && d.walls) { snapshot(); setD(normalizeD(d)); setSelection(null); flash("Design imported"); } else flash("That file is not a Builder3D design");
      } catch (e) { flash("That file is not a Builder3D design"); }
    };
    r.readAsText(file); setFileOpen(false);
  };

  /* ---------- exports / imports / views ---------- */
  const exportPng = () => {
    const s = S.current;
    if (mode === "plan") { flash("Open Interior or Exterior to render an image"); return; }
    s.renderer.render(s.scene, s.persp);
    download(s.renderer.domElement.toDataURL("image/png"), "builder3d-" + mode + ".png");
    setFileOpen(false);
  };
  const exportSvg = () => {
    const el = svgRef.current;
    if (mode !== "plan" || !el) { flash("Open the Floor plan to export it"); return; }
    const bb = bboxOf(dRef.current), pad = 1200, w = bb.x1 - bb.x0 + pad * 2, h = bb.z1 - bb.z0 + pad * 2;
    const clone = el.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("viewBox", bb.x0 - pad + " " + (bb.z0 - pad) + " " + w + " " + h);
    clone.setAttribute("width", 1600); clone.setAttribute("height", Math.round((1600 * h) / w));
    clone.removeAttribute("class"); clone.removeAttribute("style");
    const g = clone.querySelector("g");
    if (g) g.setAttribute("transform", "");
    download(URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" })), "builder3d-floor-plan.svg");
    setFileOpen(false);
  };
  const exportGlb = () => {
    const s = S.current;
    if (mode === "plan") { flash("Open Interior or Exterior to export the 3D model"); return; }
    const objs = [s.struct, s.furn, s.ext].filter(Boolean);
    new GLTFExporter().parse(objs, (res) => {
      const bin = res instanceof ArrayBuffer;
      download(URL.createObjectURL(new Blob([bin ? res : JSON.stringify(res)], { type: bin ? "model/gltf-binary" : "model/gltf+json" })), "builder3d-house." + (bin ? "glb" : "gltf"));
    }, () => flash("Export failed"), { binary: true, onlyVisible: false });
    setFileOpen(false);
  };
  const exportCsv = () => {
    const est = estimate(dRef.current);
    const rows = [["Category", "Item", "Qty", "Unit", "Rate (" + est.cur + ")", "Total (" + est.cur + ")"], ...est.lines.map((l) => [l.cat, l.label, l.qty, l.unit, l.price, l.total]), ["", "Subtotal", "", "", "", est.subtotal], ...est.markups.map((m) => ["", m.label + " (" + m.pct + "%)", "", "", "", m.amount]), ["", "Total", "", "", "", est.total]];
    const csv = rows.map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(",")).join("\n");
    download(URL.createObjectURL(new Blob([csv], { type: "text/csv" })), "builder3d-estimate.csv");
    setFileOpen(false);
  };
  const importGlb = (file) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    new GLTFLoader().load(url, (gltf) => {
      URL.revokeObjectURL(url);
      const model = gltf.scene, bb = new THREE.Box3().setFromObject(model), sz = bb.getSize(new THREE.Vector3()), c = bb.getCenter(new THREE.Vector3());
      const maxd = Math.max(sz.x, sz.y, sz.z) || 1, unit = maxd > 50 ? 0.001 : maxd > 6 ? 0.01 : 1;
      const wrap = new THREE.Group();
      model.position.set(-c.x, -bb.min.y, -c.z);
      wrap.add(model);
      wrap.scale.set(1 / (sz.x || 1), 1 / (sz.y || 1), 1 / (sz.z || 1));
      const type = "glb_" + uid("");
      const entry = { type, name: file.name.replace(/\.[^.]+$/, ""), rooms: ["decor"], size: [Math.round(sz.x * unit * 1000), Math.round(sz.z * unit * 1000), Math.round(sz.y * unit * 1000)], variants: [V("Original", "#ffffff")] };
      BUILD[type] = (g) => { const m = wrap.clone(true); m.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; }); g.add(m); };
      CATALOG.push(entry); CAT[type] = entry;
      setCat("decor");
      addItem(type);
      flash("Model imported for this session");
    }, undefined, () => { URL.revokeObjectURL(url); flash("Could not read that model"); });
    setFileOpen(false);
  };
  const importTrace = (file) => {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => { const bb = bboxOf(dRef.current); setTrace({ src: r.result, x: bb.empty ? 0 : bb.x0, z: bb.empty ? 0 : bb.z0, w: Math.max(8000, bb.empty ? 0 : bb.x1 - bb.x0), ar: img.height / img.width, opacity: 0.5 }); setMode("plan"); };
      img.src = r.result;
    };
    r.readAsDataURL(file);
    setFileOpen(false);
  };
  const saveView = () => {
    if (mode === "plan") return;
    const s = S.current;
    const v = { id: uid("v"), name: "View " + ((dRef.current.views || []).length + 1), mode, pos: s.persp.position.toArray(), target: s.oc.target.toArray() };
    commit((d) => ({ ...d, views: [...(d.views || []), v] }));
    flash("View saved");
  };
  const gotoView = (v) => {
    setWalk(false);
    if (v.mode !== mode) setMode(v.mode);
    setTimeout(() => { const s = S.current; s.persp.position.fromArray(v.pos); s.oc.target.fromArray(v.target); s.oc.update(); }, 90);
  };

  /* ---------- drag & drop from library ---------- */
  const onDrop = (e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData("text/plain");
    if (!CAT[type]) return;
    if (mode === "plan") {
      const r = svgRef.current.getBoundingClientRect();
      addItem(type, { x: sn((e.clientX - r.left - pv.tx) / pv.k, 50), z: sn((e.clientY - r.top - pv.ty) / pv.k, 50) });
    } else if (mode === "interior") {
      const s = S.current, r = s.renderer.domElement.getBoundingClientRect(), ray = new THREE.Raycaster(), p = new THREE.Vector3();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), s.persp);
      if (ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p)) addItem(type, { x: p.x / MM, z: p.z / MM }); else addItem(type);
    }
  };

  /* ================================================================ */
  /* Floor plan interaction                                            */
  /* ================================================================ */
  const toWorld = (e) => { const r = svgRef.current.getBoundingClientRect(); return { x: (e.clientX - r.left - pv.tx) / pv.k, z: (e.clientY - r.top - pv.ty) / pv.k }; };
  /* Corner points used for snapping and alignment guides: this floor plus the floors directly above and below,
     so walls stack accurately from one storey to the next. */
  const snapPts = useMemo(() => {
    const out = [];
    D.walls.forEach((w) => { if (Math.abs((w.lv || 0) - lv) <= 1) out.push(w.a, w.b); });
    D.rooms.forEach((r) => { if (Math.abs((r.lv || 0) - lv) <= 1) r.poly.forEach((q) => out.push(q)); });
    return out;
  }, [D.walls, D.rooms, lv]);
  const ptsExcept = (wallIds) => {
    const d = dRef.current, L = lvRef.current, skip = new Set(wallIds), out = [];
    d.walls.forEach((w) => { if (!skip.has(w.id) && Math.abs((w.lv || 0) - L) <= 1) out.push(w.a, w.b); });
    return out;
  };
  const alignTolMm = () => clamp((10 * tapR) / pv.k, 20, 120);
  const snapPt = (p, o = {}) => {
    const pts = o.skip || o.extra ? [...ptsExcept(o.skip || []), ...(o.extra || [])] : snapPts;
    const s = snapPoint(p, { pts, tol: (14 * tapR) / pv.k, alignTol: (9 * tapR) / pv.k, grid: gridSize, gridOn: snapOn, guides: guidesOn });
    showGuides(s.guides);
    return s;
  };
  const draftPts = () => (draft && draft.pts ? draft.pts.map((q) => [q.x, q.z]) : []);
  /* keep a new wall on an axis (within 150 mm), or on a multiple of 15 degrees when angle snap is on */
  const constrainWall = (pt, last) => {
    if (!snapOn) return pt;
    if (angleSnap && pt.kind !== "point") { const q = angleSnapPoint(last, pt, 15, gridSize); return { ...pt, x: q.x, z: q.z, guides: [] }; }
    let c = pt;
    if (Math.abs(c.x - last.x) < 150) c = { ...c, x: last.x };
    if (Math.abs(c.z - last.z) < 150) c = { ...c, z: last.z };
    return c;
  };
  const nearestWall = (p) => {
    let best = null;
    dRef.current.walls.filter((w) => (w.lv || 0) === lvRef.current).forEach((w) => {
      const dx = w.b[0] - w.a[0], dz = w.b[1] - w.a[1], L2 = dx * dx + dz * dz;
      if (L2 < 1) return;
      const t = Math.max(0, Math.min(1, ((p.x - w.a[0]) * dx + (p.z - w.a[1]) * dz) / L2));
      const dist = Math.hypot(p.x - (w.a[0] + dx * t), p.z - (w.a[1] + dz * t));
      if (dist < Math.max(260, (14 * tapR) / pv.k) && (!best || dist < best.dist)) best = { w, t, dist, L: Math.sqrt(L2) };
    });
    return best;
  };
  const opSpec = { door: { type: "door", width: 900, h: 2100, sill: 0, color: "#a9835b" }, window: { type: "window", width: 1500, h: 1200, sill: 900 } };
  const ghostOf = (b, kind) => { const sp = opSpec[kind], half = sp.width / 2 / b.L; return { wallId: b.w.id, pos: Math.max(half, Math.min(1 - half, b.t)), ...sp }; };

  const begin = (e, d) => { e.stopPropagation(); svgRef.current.setPointerCapture(e.pointerId); drag.current = { ...d, sx: e.clientX, sy: e.clientY, snap: false }; };
  const onPDown = (e) => {
    svgRef.current.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      drag.current = { kind: "pinch", d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, k0: pv.k, tx: pv.tx, ty: pv.ty, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      setDraft(null);
      return;
    }
    if (e.button === 1 || e.button === 2) { drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, tx: pv.tx, ty: pv.ty }; return; }
    const p = toWorld(e);
    if (ptool === "poly") {
      const pt = snapPt(p, { extra: draftPts() });
      if (draft && draft.kind === "poly") {
        const first = draft.pts[0];
        if (draft.pts.length >= 3 && Math.hypot(pt.x - first.x, pt.z - first.z) < (14 * tapR) / pv.k + 1) { finishPoly(draft.pts); return; }
        if (Math.hypot(pt.x - draft.cur.x, pt.z - draft.cur.z) < 50 && draft.pts.length > 1) return;
        setDraft({ kind: "poly", pts: [...draft.pts, pt], cur: pt });
      } else setDraft({ kind: "poly", pts: [pt], cur: pt });
      return;
    }
    if (ptool === "measure") {
      const pt = snapPt(p, { extra: draftPts() });
      if (draft && draft.kind === "measure") {
        if (Math.hypot(pt.x - draft.a.x, pt.z - draft.a.z) > 50) commit((d) => ({ ...d, dims: [...(d.dims || []), { id: uid("m"), lv: lvRef.current, a: [draft.a.x, draft.a.z], b: [pt.x, pt.z] }] }));
        setDraft(null);
      } else setDraft({ kind: "measure", a: pt, b: pt });
      return;
    }
    if (ptool === "room") { const a = snapPt(p); drag.current = { kind: "rdraw", a }; setDraft({ kind: "room", a, b: a }); return; }
    if (ptool === "wall") {
      let pt = snapPt(p, { extra: draftPts() });
      if (draft && draft.kind === "wall") {
        const last = draft.pts[0];
        pt = constrainWall(pt, last);
        if (Math.hypot(pt.x - last.x, pt.z - last.z) < 80) return;
        const at = pt;
        commit((d) => ({ ...d, walls: [...d.walls, { id: uid("w"), lv: lvRef.current, a: [last.x, last.z], b: [at.x, at.z], t: newT() }] }));
      }
      setDraft({ kind: "wall", pts: [pt], cur: pt });
      return;
    }
    if (ptool === "door" || ptool === "window") {
      const b = nearestWall(p);
      if (b) { const g = ghostOf(b, ptool), o = { id: uid("o"), ...g, lv: b.w.lv || 0 }; commit((d) => ({ ...d, openings: [...d.openings, o] })); setSelection({ kind: "op", id: o.id }); setPtool("select"); }
      return;
    }
    drag.current = { kind: "bg", sx: e.clientX, sy: e.clientY, tx: pv.tx, ty: pv.ty, moved: false };
  };
  const onPMove = (e) => {
    const dr = drag.current;
    const p = toWorld(e);
    const ensure = () => { if (!dr.snap) { snapshot(); dr.snap = true; } };
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (dr && dr.kind === "pinch" && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()], r = svgRef.current.getBoundingClientRect();
      const k = Math.min(1.2, Math.max(0.02, dr.k0 * (Math.hypot(a.x - b.x, a.y - b.y) / dr.d0)));
      const wx = (dr.mx - r.left - dr.tx) / dr.k0, wz = (dr.my - r.top - dr.ty) / dr.k0;
      setPv({ k, tx: (a.x + b.x) / 2 - r.left - wx * k, ty: (a.y + b.y) / 2 - r.top - wz * k });
      return;
    }
    if (!dr) {
      if (ptool === "wall" && draft && draft.kind === "wall") {
        const c = constrainWall(snapPt(p, { extra: draftPts() }), draft.pts[0]);
        setDraft({ ...draft, cur: c }); setSnapCur(c);
      } else if (ptool === "poly" && draft && draft.kind === "poly") { const c = snapPt(p, { extra: draftPts() }); setDraft({ ...draft, cur: c }); setSnapCur(c);
      } else if (ptool === "measure" && draft && draft.kind === "measure") { const c = snapPt(p, { extra: draftPts() }); setDraft({ ...draft, b: c }); setSnapCur(c);
      } else if (ptool === "room" || ptool === "wall" || ptool === "poly" || ptool === "measure") { setSnapCur(snapPt(p));
      } else if (ptool === "door" || ptool === "window") { const b = nearestWall(p); setHover(b ? ghostOf(b, ptool) : null); }
      return;
    }
    switch (dr.kind) {
      case "pan": setPv((v) => ({ ...v, tx: dr.tx + e.clientX - dr.sx, ty: dr.ty + e.clientY - dr.sy })); break;
      case "bg": if (dr.moved || Math.hypot(e.clientX - dr.sx, e.clientY - dr.sy) > 4) { dr.moved = true; setPv((v) => ({ ...v, tx: dr.tx + e.clientX - dr.sx, ty: dr.ty + e.clientY - dr.sy })); } break;
      case "rdraw": setDraft({ kind: "room", a: dr.a, b: snapPt(p) }); break;
      case "item": {
        ensure();
        const cur = dRef.current.items.find((i) => i.id === dr.id);
        if (!cur) break;
        const g = snapOn ? 50 : 1;
        let q = { x: sn(dr.ox + p.x - dr.p0.x, g), z: sn(dr.oz + p.z - dr.p0.z, g) }, gl = [];
        if (!e.altKey && guidesOn) { const a = alignItem({ ...cur, ...q }, dRef.current.items, alignTolMm()); q = { x: a.x, z: a.z }; gl = a.guides; }
        if (!e.altKey) q = snapToWalls({ ...cur, ...q }, dRef.current.walls);
        showGuides(gl);
        patchItem(dr.id, q);
        break;
      }
      case "irot": {
        ensure();
        const cur = dRef.current.items.find((i) => i.id === dr.id);
        if (!cur) break;
        const a = (Math.atan2(-(p.x - cur.x), -(p.z - cur.z)) * 180) / Math.PI;
        patchItem(dr.id, { rot: norm(e.altKey || !snapOn ? Math.round(a) : Math.round(a / 15) * 15) });
        break;
      }
      case "room": {
        ensure();
        const rm = dRef.current.rooms.find((q) => q.id === dr.id);
        if (!rm) break;
        const g = snapOn ? gridSize : 1;
        let nx = sn(dr.r0.x + p.x - dr.p0.x, g), nz = sn(dr.r0.z + p.z - dr.p0.z, g), gl = [];
        if (guidesOn && !e.altKey) { const a = alignBox({ x: nx, z: nz, w: rm.w, d: rm.d }, ptsExcept(rm.wallIds), alignTolMm()); nx += a.dx; nz += a.dz; gl = a.guides; }
        showGuides(gl);
        rectPatch(dr.id, { x: nx, z: nz });
        break;
      }
      case "redge": {
        ensure();
        const [nx, nz] = edgeNormal(dr.poly0, dr.k), g = snapOn ? gridSize : 1;
        let delta = (p.x - dr.p0.x) * nx + (p.z - dr.p0.z) * nz, gl = [];
        delta = sn(delta, g);
        const A = dr.poly0[dr.k];
        if (guidesOn && !e.altKey && Math.abs(nx) + Math.abs(nz) > 0.99 && (Math.abs(nx) > 0.99 || Math.abs(nz) > 0.99)) {
          const coord = Math.abs(nx) > 0.99 ? A[0] + delta * nx : A[1] + delta * nz, idx = Math.abs(nx) > 0.99 ? 0 : 1;
          let best = null;
          ptsExcept(roomOf(dr.id) ? roomOf(dr.id).wallIds : []).forEach((q) => { const d2 = Math.abs(q[idx] - coord); if (d2 < alignTolMm() && (!best || d2 < best.d)) best = { d: d2, v: q[idx] }; });
          if (best) { delta += (best.v - coord) * (idx === 0 ? nx : nz); gl = [{ axis: idx === 0 ? "x" : "z", at: best.v, from: -1e5, to: 1e5 }]; }
        }
        showGuides(gl);
        setRoomPoly(dr.id, moveEdgePoly(dr.poly0, dr.k, delta));
        break;
      }
      case "rvert": ensure(); { const rm = roomOf(dr.id), n = rm ? rm.poly.length : 0; moveVertex(dr.id, dr.idx, snapPt(p, { skip: rm ? [rm.wallIds[dr.idx], rm.wallIds[(dr.idx - 1 + n) % n]] : [] })); } break;
      case "wall": {
        ensure();
        const g = snapOn ? gridSize : 1;
        let dx = sn(p.x - dr.p0.x, g), dz = sn(p.z - dr.p0.z, g), gl = [];
        if (guidesOn && !e.altKey) {
          const ax = dr.a0[0] + dx, az = dr.a0[1] + dz, bx2 = dr.b0[0] + dx, bz2 = dr.b0[1] + dz;
          const a = alignBox({ x: Math.min(ax, bx2), z: Math.min(az, bz2), w: Math.abs(bx2 - ax), d: Math.abs(bz2 - az) }, ptsExcept([dr.id]), alignTolMm());
          dx += a.dx; dz += a.dz; gl = a.guides;
        }
        showGuides(gl);
        patchWall(dr.id, { a: [dr.a0[0] + dx, dr.a0[1] + dz], b: [dr.b0[0] + dx, dr.b0[1] + dz] });
      } break;
      case "wend": {
        ensure();
        const w0 = dRef.current.walls.find((q) => q.id === dr.id);
        if (!w0) break;
        let c = snapPt(p, { skip: [dr.id] });
        const other = dr.end === "a" ? w0.b : w0.a;
        if (snapOn && angleSnap && c.kind !== "point") c = angleSnapPoint({ x: other[0], z: other[1] }, c, 15, gridSize);
        setWallEnd(w0, dr.end, [c.x, c.z]);
      } break;
      case "op": ensure(); {
        const w = wallById[dr.wallId], o = dRef.current.openings.find((q) => q.id === dr.id);
        if (!w || !o) break;
        const dx = w.b[0] - w.a[0], dz = w.b[1] - w.a[1], L = Math.hypot(dx, dz), half = o.width / 2 / L;
        let centre = ((p.x - w.a[0]) * dx + (p.z - w.a[1]) * dz) / L;
        if (snapOn) centre = Math.abs(centre - L / 2) < 60 ? L / 2 : sn(centre, 50);
        patchOp(dr.id, { pos: Math.max(half, Math.min(1 - half, centre / L)) });
      } break;
      case "opw": {
        ensure();
        const w = wallById[dr.wallId], o = dRef.current.openings.find((q) => q.id === dr.id);
        if (!w || !o) break;
        const dx = w.b[0] - w.a[0], dz = w.b[1] - w.a[1], L = Math.hypot(dx, dz) || 1;
        let along = clamp(((p.x - w.a[0]) * dx + (p.z - w.a[1]) * dz) / L, 0, L);
        if (snapOn) along = sn(along, 50);
        const left = o.pos * L - o.width / 2, right = o.pos * L + o.width / 2;
        const nl = dr.end === "a" ? Math.min(along, right - 400) : left, nr = dr.end === "b" ? Math.max(along, left + 400) : right;
        patchOp(dr.id, { width: Math.round(nr - nl), pos: (nl + nr) / 2 / L });
      } break;
      default:
    }
  };
  const onPUp = (e) => {
    pointers.current.delete(e.pointerId);
    const dr = drag.current;
    drag.current = null;
    showGuides([]);
    try { svgRef.current.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (!dr) return;
    if (dr.kind === "bg" && !dr.moved) setSelection(null);
    if (dr.kind === "rdraw") {
      const d = draft;
      setDraft(null);
      if (d) {
        const x = Math.min(d.a.x, d.b.x), z = Math.min(d.a.z, d.b.z), w = Math.abs(d.a.x - d.b.x), h = Math.abs(d.a.z - d.b.z);
        if (w >= 1000 && h >= 1000) { addRoom(x, z, w, h, rtype); setPtool("select"); }
      }
    }
  };
  const onWheel = (e) => {
    const r = svgRef.current.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setPv((p) => { const k = Math.min(1.2, Math.max(0.02, p.k * f)), wx = (mx - p.tx) / p.k, wz = (my - p.ty) / p.k; return { k, tx: mx - wx * k, ty: my - wz * k }; });
  };
  const finishWall = () => { if (draft && draft.kind === "wall") setDraft(null); else if (draft && draft.kind === "poly") finishPoly(draft.pts); };

  /* ---------- derived ---------- */
  const favTypes = useMemo(() => new Set(D.items.filter((i) => i.fav).map((i) => i.type)), [D.items]);
  const list = CATALOG.filter((c) => {
    if (query && !c.name.toLowerCase().includes(query.toLowerCase())) return false;
    if (cat === "popular") return true;
    if (cat === "fav") return favTypes.has(c.type);
    return c.rooms.includes(cat);
  });
  const menuItem = menu && D.items.find((i) => i.id === menu.id);
  const totalArea = D.rooms.reduce((a, r) => a + (r.type === "void" ? 0 : roomArea(r)), 0);
  const doors = D.openings.filter((o) => o.type === "door").length;
  const windows = D.openings.length - doors;
  const fs = 13 / pv.k;
  const hasBuilding = D.walls.length > 0;
  const clash = useMemo(() => overlapIds(D.items), [D.items]);
  const LD = useMemo(() => { const f = (a) => (a || []).filter((e) => (e.lv || 0) === lv); return { rooms: f(D.rooms), walls: f(D.walls), openings: f(D.openings), items: f(D.items), dims: f(D.dims) }; }, [D, lv]);
  const below = useMemo(() => (lv > 0 ? { rooms: D.rooms.filter((r) => (r.lv || 0) === lv - 1), walls: D.walls.filter((w) => (w.lv || 0) === lv - 1) } : null), [D, lv]);

  /* ---------- plan rendering ---------- */
  const planSvg = () => {
    const k = pv.k;
    const perim = (poly) => poly.reduce((a, q, i) => { const n = poly[(i + 1) % poly.length]; return a + Math.hypot(n[0] - q[0], n[1] - q[1]); }, 0);
    const opDraw = (o, w, ghost) => {
      const dx = w.b[0] - w.a[0], dz = w.b[1] - w.a[1], L = Math.hypot(dx, dz) || 1, ux = dx / L, uz = dz / L, nx = -uz, nz = ux;
      const cx = w.a[0] + dx * o.pos, cz = w.a[1] + dz * o.pos, hw = o.width / 2;
      const p1 = [cx - ux * hw, cz - uz * hw], p2 = [cx + ux * hw, cz + uz * hw], t = w.t;
      const isSel = selOp && selOp.id === o.id && !ghost;
      const sgn = o.flip ? -1 : 1, style = o.style || (o.type === "door" ? "panel" : "casement");
      // a door leaf drawn open at 90 degrees: hinge H, far end of the opening E, leaf length len
      const leaf = (H, E, len, key) => {
        const tip = [H[0] + nx * sgn * len, H[1] + nz * sgn * len];
        const sweep = (tip[0] - H[0]) * (E[1] - H[1]) - (tip[1] - H[1]) * (E[0] - H[0]) > 0 ? 1 : 0;
        return (
          <g key={key}>
            <line x1={H[0]} y1={H[1]} x2={tip[0]} y2={tip[1]} stroke="#374151" strokeWidth={30} />
            <path d={`M ${tip[0]} ${tip[1]} A ${len} ${len} 0 0 ${sweep} ${E[0]} ${E[1]}`} fill="none" stroke="#6b7280" strokeWidth={14} />
          </g>
        );
      };
      const seg = (a, b, wdt, col, off = 0, key) => <line key={key} x1={a[0] + nx * off} y1={a[1] + nz * off} x2={b[0] + nx * off} y2={b[1] + nz * off} stroke={col} strokeWidth={wdt} />;
      let sym;
      if (o.type === "door") {
        if (style === "double") sym = <>{leaf(p1, [cx, cz], hw, "l")}{leaf(p2, [cx, cz], hw, "r")}</>;
        else if (style === "sliding") sym = <>{seg(p1, [cx, cz], t * 0.32, "#374151", -t * 0.2, "a")}{seg([cx, cz], p2, t * 0.32, "#374151", t * 0.2, "b")}{seg(p1, p2, t * 0.12, "#cfe6f2", 0, "c")}</>;
        else sym = o.hinge === "r" ? leaf(p2, p1, o.width, "s") : leaf(p1, p2, o.width, "s");
      } else if (style === "sliding") sym = <>{seg(p1, p2, t * 0.9, "#374151", 0, "a")}{seg(p1, [cx + ux * 40, cz + uz * 40], t * 0.3, "#cfe6f2", -t * 0.22, "b")}{seg([cx - ux * 40, cz - uz * 40], p2, t * 0.3, "#cfe6f2", t * 0.22, "c")}</>;
      else sym = <>{seg(p1, p2, t * 0.9, "#374151", 0, "a")}{seg(p1, p2, t * 0.45, "#cfe6f2", 0, "b")}</>;
      // dimension tags + resize handles when selected
      let tags = null;
      if (isSel) {
        const d1 = o.pos * L - hw, d2 = L - o.pos * L - hw, off = t / 2 + 26 / k;
        let rot = (Math.atan2(dz, dx) * 180) / Math.PI;
        if (rot > 90 || rot < -90) rot += 180;
        const lab = (a, b, text, key) => {
          const mx = (a[0] + b[0]) / 2 + nx * off, mz = (a[1] + b[1]) / 2 + nz * off, tk = 5 / k;
          return (
            <g key={key} style={{ pointerEvents: "none" }} stroke="#2d6cdf" strokeWidth={1.2 / k}>
              <line x1={a[0] + nx * off} y1={a[1] + nz * off} x2={b[0] + nx * off} y2={b[1] + nz * off} />
              <line x1={a[0] + nx * (off - tk)} y1={a[1] + nz * (off - tk)} x2={a[0] + nx * (off + tk)} y2={a[1] + nz * (off + tk)} />
              <line x1={b[0] + nx * (off - tk)} y1={b[1] + nz * (off - tk)} x2={b[0] + nx * (off + tk)} y2={b[1] + nz * (off + tk)} />
              <text transform={`rotate(${rot} ${mx} ${mz})`} x={mx} y={mz - 5 / k} fontSize={fs * 0.8} textAnchor="middle" fill="#2d6cdf" stroke="none">{text}</text>
            </g>
          );
        };
        tags = (
          <>
            {d1 > 80 && lab(w.a, p1, fmtLen(d1, unit), "d1")}
            {lab(p1, p2, fmtLen(o.width, unit), "dw")}
            {d2 > 80 && lab(p2, w.b, fmtLen(d2, unit), "d2")}
            {[["a", p1], ["b", p2]].map(([end, pt]) => (
              <rect key={end} x={pt[0] - (6 * tapR) / k} y={pt[1] - (6 * tapR) / k} width={(12 * tapR) / k} height={(12 * tapR) / k} fill="#fff" stroke="#2d6cdf" strokeWidth={2 / k} style={{ cursor: "ew-resize" }}
                onPointerDown={(e) => begin(e, { kind: "opw", id: o.id, wallId: o.wallId, end })} />
            ))}
          </>
        );
      }
      return (
        <g key={o.id || "ghost"} opacity={ghost ? 0.7 : 1} style={ghost ? { pointerEvents: "none" } : undefined}
          onPointerDown={(e) => { if (ptool !== "select" || ghost) return; setSelection({ kind: "op", id: o.id }); begin(e, { kind: "op", id: o.id, wallId: o.wallId }); }}>
          <line x1={p1[0]} y1={p1[1]} x2={p2[0]} y2={p2[1]} stroke="#fff" strokeWidth={t + 10} />
          {sym}
          <line x1={p1[0]} y1={p1[1]} x2={p2[0]} y2={p2[1]} stroke="transparent" strokeWidth={Math.max(t + 80, (14 * tapR) / k)} />
          {isSel && <circle cx={cx} cy={cz} r={9 / k} fill="none" stroke="#2d6cdf" strokeWidth={2 / k} />}
          {tags}
        </g>
      );
    };
    /* dimension lines along every wall (outside the room), plus overall dimensions of this floor */
    const dimLayer = () => {
      if (!showDims || k < 0.03) return null;
      const seen = new Set(), out = [];
      LD.walls.forEach((w) => {
        const L = wallLen(w);
        if (L < 500) return;
        const key = [w.a, w.b].map((q) => q.map((v) => Math.round(v / 20)).join(",")).sort().join("|");
        if (seen.has(key)) return;
        seen.add(key);
        const dx = w.b[0] - w.a[0], dz = w.b[1] - w.a[1], room = D.rooms.find((r) => r.wallIds.includes(w.id));
        const n = room ? edgeNormal(room.poly, room.wallIds.indexOf(w.id)) : [-dz / L, dx / L], off = w.t / 2 + 20 / k, tk = 4 / k;
        const a2 = [w.a[0] + n[0] * off, w.a[1] + n[1] * off], b2 = [w.b[0] + n[0] * off, w.b[1] + n[1] * off], mx = (a2[0] + b2[0]) / 2, mz = (a2[1] + b2[1]) / 2;
        let ang = (Math.atan2(dz, dx) * 180) / Math.PI;
        if (ang > 90 || ang < -90) ang += 180;
        out.push(
          <g key={w.id} style={{ pointerEvents: "none" }} stroke="#94a3b8" strokeWidth={1 / k}>
            <line x1={a2[0]} y1={a2[1]} x2={b2[0]} y2={b2[1]} />
            <line x1={a2[0] - n[0] * tk} y1={a2[1] - n[1] * tk} x2={a2[0] + n[0] * tk} y2={a2[1] + n[1] * tk} />
            <line x1={b2[0] - n[0] * tk} y1={b2[1] - n[1] * tk} x2={b2[0] + n[0] * tk} y2={b2[1] + n[1] * tk} />
            <text transform={`rotate(${ang} ${mx} ${mz})`} x={mx} y={mz - 4 / k} fontSize={fs * 0.78} textAnchor="middle" fill="#64748b" stroke="none">{fmtLen(L, unit)}</text>
          </g>
        );
      });
      const b = bboxOf({ walls: LD.walls, rooms: LD.rooms });
      if (!b.empty && b.x1 - b.x0 > 1500) {
        const y = b.z0 - 56 / k, tk = 5 / k;
        out.push(<g key="ovw" style={{ pointerEvents: "none" }} stroke="#0f766e" strokeWidth={1.4 / k}><line x1={b.x0} y1={y} x2={b.x1} y2={y} /><line x1={b.x0} y1={y - tk} x2={b.x0} y2={y + tk} /><line x1={b.x1} y1={y - tk} x2={b.x1} y2={y + tk} /><text x={(b.x0 + b.x1) / 2} y={y - 5 / k} fontSize={fs * 0.9} textAnchor="middle" fill="#0f766e" stroke="none" fontWeight="600">{fmtLen(b.x1 - b.x0, unit)}</text></g>);
      }
      if (!b.empty && b.z1 - b.z0 > 1500) {
        const x = b.x0 - 56 / k, tk = 5 / k, my = (b.z0 + b.z1) / 2;
        out.push(<g key="ovd" style={{ pointerEvents: "none" }} stroke="#0f766e" strokeWidth={1.4 / k}><line x1={x} y1={b.z0} x2={x} y2={b.z1} /><line x1={x - tk} y1={b.z0} x2={x + tk} y2={b.z0} /><line x1={x - tk} y1={b.z1} x2={x + tk} y2={b.z1} /><text transform={`rotate(-90 ${x - 5 / k} ${my})`} x={x - 5 / k} y={my} fontSize={fs * 0.9} textAnchor="middle" fill="#0f766e" stroke="none" fontWeight="600">{fmtLen(b.z1 - b.z0, unit)}</text></g>);
      }
      return <g>{out}</g>;
    };
    return (
      <svg ref={svgRef} className="b3d-plansvg" style={{ cursor: ptool === "select" ? "default" : "crosshair" }}
        onPointerDown={onPDown} onPointerMove={onPMove} onPointerUp={onPUp} onPointerCancel={onPUp} onWheel={onWheel} onDoubleClick={finishWall} onContextMenu={(e) => { e.preventDefault(); finishWall(); }}>
        <defs>
          <pattern id="b3dgridm" width={gridSize} height={gridSize} patternUnits="userSpaceOnUse"><path d={`M${gridSize} 0H0V${gridSize}`} fill="none" stroke="#eef0f3" strokeWidth="1" vectorEffect="non-scaling-stroke" /></pattern>
          <pattern id="b3dgrid" width="500" height="500" patternUnits="userSpaceOnUse"><path d="M500 0H0V500" fill="none" stroke="#e3e6ea" strokeWidth="1" vectorEffect="non-scaling-stroke" /></pattern>
          <pattern id="b3dgrid2" width="2500" height="2500" patternUnits="userSpaceOnUse"><path d="M2500 0H0V2500" fill="none" stroke="#cfd4da" strokeWidth="1" vectorEffect="non-scaling-stroke" /></pattern>
        </defs>
        <g transform={`translate(${pv.tx} ${pv.ty}) scale(${k})`}>
          <rect x={-60000} y={-60000} width={120000} height={120000} fill="#fff" />
          {snapOn && gridSize * k >= 7 && <rect x={-60000} y={-60000} width={120000} height={120000} fill="url(#b3dgridm)" />}
          <rect x={-60000} y={-60000} width={120000} height={120000} fill="url(#b3dgrid)" />
          <rect x={-60000} y={-60000} width={120000} height={120000} fill="url(#b3dgrid2)" />
          {trace && <image href={trace.src} x={trace.x} y={trace.z} width={trace.w} height={trace.w * trace.ar} opacity={trace.opacity} preserveAspectRatio="none" style={{ pointerEvents: "none" }} />}

          {below && (
            <g style={{ pointerEvents: "none" }} opacity={0.4}>
              {below.rooms.map((r) => <polygon key={r.id} points={r.poly.map((q) => q.join(",")).join(" ")} fill="none" stroke="#9aa3af" strokeWidth={2 / k} strokeDasharray={(6 / k) + " " + (4 / k)} />)}
              {below.walls.map((w) => <line key={w.id} x1={w.a[0]} y1={w.a[1]} x2={w.b[0]} y2={w.b[1]} stroke="#c3c9d1" strokeWidth={w.t} />)}
            </g>
          )}
          {LD.rooms.map((r) => {
            const t = ROOM_TYPES[r.type], isSel = selRoom && selRoom.id === r.id, c = polyCentroid(r.poly), rect = isRectRoom(r);
            return (
              <g key={r.id} onPointerDown={(e) => { if (ptool !== "select") return; setSelection({ kind: "room", id: r.id }); begin(e, { kind: "room", id: r.id, r0: { x: r.x, z: r.z }, p0: toWorld(e) }); }}>
                <polygon points={r.poly.map((q) => q.join(",")).join(" ")} fill={t.fill} stroke={isSel ? "#2d6cdf" : r.type === "void" ? "#9aa3af" : "none"} strokeWidth={isSel ? 6 / k : 2 / k} strokeDasharray={r.type === "void" && !isSel ? (6 / k) + " " + (4 / k) : undefined} />
                <g style={{ pointerEvents: "none", userSelect: "none" }} fontSize={fs} textAnchor="middle" fill="#4b5563">
                  <text x={c.x} y={c.z - fs * 0.2} fontWeight="600" fill="#1f2937">{r.name}</text>
                  <text x={c.x} y={c.z + fs * 1.2} fontSize={fs * 0.9}>{r.type === "void" ? "open to below" : fmtArea(roomArea(r), unit)}</text>
                  {isSel && r.type !== "void" && <text x={c.x} y={c.z + fs * 2.35} fontSize={fs * 0.8} fill="#2d6cdf">{"perimeter " + fmtLen(perim(r.poly), unit)}</text>}
                  {rect && !showDims && <text x={r.x + r.w / 2} y={r.z + r.d - fs * 0.7} fontSize={fs * 0.85} fill="#7b8491">{fmtLen(r.w, unit)}</text>}
                  {rect && !showDims && <text x={r.x + fs * 0.9} y={r.z + r.d / 2} fontSize={fs * 0.85} fill="#7b8491" transform={`rotate(-90 ${r.x + fs * 0.9} ${r.z + r.d / 2})`}>{fmtLen(r.d, unit)}</text>}
                  {isSel && !rect && !showDims && r.poly.map((q, i) => { const n = r.poly[(i + 1) % r.poly.length]; return <text key={i} x={(q[0] + n[0]) / 2} y={(q[1] + n[1]) / 2 - fs * 0.5} fontSize={fs * 0.85} fill="#2d6cdf">{fmtLen(Math.hypot(n[0] - q[0], n[1] - q[1]), unit)}</text>; })}
                </g>
              </g>
            );
          })}

          {[...LD.items].sort((a, b) => (a.type === "rug" ? -1 : 0) - (b.type === "rug" ? -1 : 0)).map((it) => (
            <g key={it.id} transform={`translate(${it.x} ${it.z}) rotate(${-it.rot})`} opacity={it.hidden ? 0.25 : 1}
              onPointerDown={(e) => { if (ptool !== "select") return; setSelId(it.id); begin(e, { kind: "item", id: it.id, ox: it.x, oz: it.z, p0: toWorld(e) }); }} style={{ cursor: "move" }}>
              <rect x={-it.size.L / 2} y={-it.size.W / 2} width={it.size.L} height={it.size.W} rx={30}
                fill={it.id === selId ? "#cfe0ff" : it.type === "rug" ? "#ece6dc" : "#fff"} fillOpacity={it.type === "rug" ? 0.8 : 0.95}
                stroke={it.id === selId ? "#2d6cdf" : clash.has(it.id) ? "#e5484d" : "#7b8491"} strokeWidth={it.id === selId || clash.has(it.id) ? 4 / k : 1.5 / k} />
              <line x1={-it.size.L / 2} y1={it.size.W / 2 - 40} x2={it.size.L / 2} y2={it.size.W / 2 - 40} stroke={it.id === selId ? "#2d6cdf" : "#9aa3af"} strokeWidth={1.5 / k} />
              {it.type === "stairs" && it.spiral && (() => {
                const R = it.size.L / 2, sp = spiralParams(it), n = sp.n;
                return (
                  <g style={{ pointerEvents: "none" }} stroke="#9aa3af" strokeWidth={1.2 / k} fill="none">
                    <circle cx={0} cy={0} r={R - 20} />
                    {Array.from({ length: n }, (_, i) => { const a = sp.a0 + (i / n) * sp.sweep; return <line key={i} x1={Math.sin(a) * 90} y1={Math.cos(a) * 90} x2={Math.sin(a) * (R - 20)} y2={Math.cos(a) * (R - 20)} />; })}
                    <circle cx={0} cy={0} r={90} fill="#9aa3af" stroke="none" />
                    <path d={`M ${Math.sin(sp.a0 + 0.3) * R * 0.62} ${Math.cos(sp.a0 + 0.3) * R * 0.62} A ${R * 0.62} ${R * 0.62} 0 1 1 ${Math.sin(sp.a0 + sp.sweep - 0.5) * R * 0.62} ${Math.cos(sp.a0 + sp.sweep - 0.5) * R * 0.62}`} stroke="#2d6cdf" strokeWidth={3 / k} />
                    <text x={0} y={R * 0.3} fontSize={fs * 0.85} textAnchor="middle" fill="#2d6cdf" stroke="none" fontWeight="600" transform={`rotate(${it.rot} 0 ${R * 0.3})`}>UP</text>
                  </g>
                );
              })()}
              {it.type === "stairs" && !it.spiral && (() => {
                const n = Math.max(5, Math.round(it.size.W / 280)), step = it.size.W / n, y0 = -it.size.W / 2, y1 = it.size.W / 2 - 120;
                return (
                  <g style={{ pointerEvents: "none" }} stroke="#9aa3af" strokeWidth={1.2 / k}>
                    {Array.from({ length: n - 1 }, (_, i) => <line key={i} x1={-it.size.L / 2} x2={it.size.L / 2} y1={y0 + (i + 1) * step} y2={y0 + (i + 1) * step} />)}
                    <line x1={0} y1={y0 + 140} x2={0} y2={y1} stroke="#2d6cdf" strokeWidth={3 / k} />
                    <polygon points={`${-110},${y1 - 150} ${110},${y1 - 150} 0,${y1 + 60}`} fill="#2d6cdf" stroke="none" />
                    <text transform={`rotate(${it.rot} 0 ${y0 + 330})`} x={0} y={y0 + 330} fontSize={fs * 0.85} textAnchor="middle" fill="#2d6cdf" stroke="none" fontWeight="600">UP</text>
                  </g>
                );
              })()}
            </g>
          ))}

          {LD.walls.map((w) => (
            <g key={w.id} onPointerDown={(e) => {
              if (ptool !== "select") return;
              setSelection({ kind: "wall", id: w.id });
              const room = D.rooms.find((r) => r.wallIds.includes(w.id));
              // a wall that belongs to a room pushes that room's edge (keeps the room and its walls in step); free walls move freely
              if (room) begin(e, { kind: "redge", id: room.id, k: room.wallIds.indexOf(w.id), p0: toWorld(e), poly0: room.poly });
              else begin(e, { kind: "wall", id: w.id, a0: w.a, b0: w.b, p0: toWorld(e) });
            }}>
              <line x1={w.a[0]} y1={w.a[1]} x2={w.b[0]} y2={w.b[1]} stroke={selWall && selWall.id === w.id ? "#2d6cdf" : "#374151"} strokeWidth={w.t} strokeLinecap="square" />
              <line x1={w.a[0]} y1={w.a[1]} x2={w.b[0]} y2={w.b[1]} stroke="transparent" strokeWidth={Math.max(w.t + 60, (12 * tapR) / k)} />
            </g>
          ))}
          {LD.openings.map((o) => (wallById[o.wallId] ? opDraw(o, wallById[o.wallId], false) : null))}
          {dimLayer()}
          {LD.dims.map((m) => {
            const dx = m.b[0] - m.a[0], dz = m.b[1] - m.a[1], L = Math.hypot(dx, dz) || 1, nx = (-dz / L) * (8 / k), nz = (dx / L) * (8 / k);
            const on = selDim && selDim.id === m.id, col = on ? "#2d6cdf" : "#0f766e";
            return (
              <g key={m.id} onPointerDown={(e) => { if (ptool !== "select") return; e.stopPropagation(); setSelection({ kind: "dim", id: m.id }); }} style={{ cursor: "pointer" }}>
                <line x1={m.a[0]} y1={m.a[1]} x2={m.b[0]} y2={m.b[1]} stroke={col} strokeWidth={2 / k} />
                <line x1={m.a[0] - nx} y1={m.a[1] - nz} x2={m.a[0] + nx} y2={m.a[1] + nz} stroke={col} strokeWidth={2 / k} />
                <line x1={m.b[0] - nx} y1={m.b[1] - nz} x2={m.b[0] + nx} y2={m.b[1] + nz} stroke={col} strokeWidth={2 / k} />
                <line x1={m.a[0]} y1={m.a[1]} x2={m.b[0]} y2={m.b[1]} stroke="transparent" strokeWidth={14 / k} />
                <text x={(m.a[0] + m.b[0]) / 2} y={(m.a[1] + m.b[1]) / 2 - fs * 0.7} fontSize={fs} textAnchor="middle" fill={col} style={{ pointerEvents: "none", userSelect: "none" }}>{fmtLen(L, unit)}</text>
              </g>
            );
          })}
          {hover && (ptool === "door" || ptool === "window") && wallById[hover.wallId] && opDraw(hover, wallById[hover.wallId], true)}

          {selWall && (
            <g>
              {[["a", selWall.a], ["b", selWall.b]].map(([end, pt]) => (
                <circle key={end} cx={pt[0]} cy={pt[1]} r={(7 * tapR) / k} fill="#fff" stroke="#2d6cdf" strokeWidth={2 / k} style={{ cursor: "pointer" }}
                  onPointerDown={(e) => { begin(e, { kind: "wend", id: selWall.id, end }); }} />
              ))}
              <text x={(selWall.a[0] + selWall.b[0]) / 2} y={(selWall.a[1] + selWall.b[1]) / 2 - 130} fontSize={fs} textAnchor="middle" fill="#2d6cdf" style={{ pointerEvents: "none" }}>{fmtLen(wallLen(selWall), unit) + " · t " + fmtLen(selWall.t, unit)}</text>
            </g>
          )}
          {selRoom && (selRoom.lv || 0) === lv && selRoom.poly.map((q, idx) => {
            const nx = selRoom.poly[(idx + 1) % selRoom.poly.length];
            return (
              <g key={idx}>
                <circle cx={(q[0] + nx[0]) / 2} cy={(q[1] + nx[1]) / 2} r={(5 * tapR) / k} fill="#2d6cdf" fillOpacity={0.25} stroke="#2d6cdf" strokeWidth={1.5 / k} style={{ cursor: "copy" }} onPointerDown={(e) => insertVertex(e, selRoom.id, idx)} />
                <circle cx={q[0]} cy={q[1]} r={(7 * tapR) / k} fill="#fff" stroke="#2d6cdf" strokeWidth={2 / k} style={{ cursor: "move" }} onPointerDown={(e) => {
                  const now = Date.now(), lt = lastTap.current;
                  if (lt.id === selRoom.id && lt.idx === idx && now - lt.t < 350) { e.stopPropagation(); lastTap.current = {}; removeVertex(selRoom.id, idx); return; }
                  lastTap.current = { id: selRoom.id, idx, t: now };
                  begin(e, { kind: "rvert", id: selRoom.id, idx });
                }} />
              </g>
            );
          })}

          {selRoom && (selRoom.lv || 0) === lv && selRoom.poly.map((q, idx) => {
            const nb = selRoom.poly[(idx + 1) % selRoom.poly.length];
            if (Math.hypot(nb[0] - q[0], nb[1] - q[1]) < 700) return null;
            const nrm = edgeNormal(selRoom.poly, idx), hx = (q[0] + nb[0]) / 2 + (nrm[0] * 26 * tapR) / k, hz = (q[1] + nb[1]) / 2 + (nrm[1] * 26 * tapR) / k, horiz = Math.abs(nrm[0]) > Math.abs(nrm[1]), s2 = (9 * tapR) / k;
            return (
              <g key={"edge" + idx} style={{ cursor: Math.abs(nrm[0]) > 0.99 || Math.abs(nrm[1]) > 0.99 ? (horiz ? "ew-resize" : "ns-resize") : "move" }}
                onPointerDown={(e) => begin(e, { kind: "redge", id: selRoom.id, k: idx, p0: toWorld(e), poly0: selRoom.poly })}>
                <rect x={hx - s2} y={hz - s2} width={s2 * 2} height={s2 * 2} rx={3 / k} fill="#fff" stroke="#2d6cdf" strokeWidth={1.6 / k} />
                <line x1={hx - nrm[0] * s2 * 0.55} y1={hz - nrm[1] * s2 * 0.55} x2={hx + nrm[0] * s2 * 0.55} y2={hz + nrm[1] * s2 * 0.55} stroke="#2d6cdf" strokeWidth={1.6 / k} />
              </g>
            );
          })}
          {sel && ptool === "select" && mode === "plan" && (sel.lv || 0) === lv && !sel.hidden && (
            <g transform={`translate(${sel.x} ${sel.z}) rotate(${-sel.rot})`}>
              <line x1={0} y1={-sel.size.W / 2} x2={0} y2={-sel.size.W / 2 - (30 * tapR) / k} stroke="#2d6cdf" strokeWidth={1.5 / k} />
              <circle cx={0} cy={-sel.size.W / 2 - (30 * tapR) / k} r={(7 * tapR) / k} fill="#fff" stroke="#2d6cdf" strokeWidth={2 / k} style={{ cursor: "grab" }}
                onPointerDown={(e) => begin(e, { kind: "irot", id: sel.id })} />
            </g>
          )}

          {draft && draft.kind === "room" && (() => {
            const x = Math.min(draft.a.x, draft.b.x), z = Math.min(draft.a.z, draft.b.z), w = Math.abs(draft.a.x - draft.b.x), h = Math.abs(draft.a.z - draft.b.z);
            return (
              <g style={{ pointerEvents: "none" }}>
                <rect x={x} y={z} width={w} height={h} fill={ROOM_TYPES[rtype].fill} fillOpacity={0.7} stroke="#2d6cdf" strokeWidth={3 / k} strokeDasharray={`${8 / k} ${5 / k}`} />
                <text x={x + w / 2} y={z + h / 2} fontSize={fs} textAnchor="middle" fill="#2d6cdf">{fmtLen(w, unit)} × {fmtLen(h, unit)}</text>
                <text x={x + w / 2} y={z + h / 2 + fs * 1.3} fontSize={fs * 0.9} textAnchor="middle" fill="#2d6cdf">{fmtArea((w * h) / 1e6, unit)}</text>
              </g>
            );
          })()}
          {draft && draft.kind === "poly" && (
            <g style={{ pointerEvents: "none" }}>
              <polyline points={[...draft.pts, draft.cur].map((q) => q.x + "," + q.z).join(" ")} fill={ROOM_TYPES[rtype].fill} fillOpacity={0.6} stroke="#2d6cdf" strokeWidth={3 / k} strokeDasharray={(8 / k) + " " + (5 / k)} />
              {draft.pts.map((q, i) => <circle key={i} cx={q.x} cy={q.z} r={(i === 0 ? 8 : 5) / k} fill={i === 0 ? "#2d6cdf" : "#fff"} stroke="#2d6cdf" strokeWidth={2 / k} />)}
              <text x={(draft.pts[draft.pts.length - 1].x + draft.cur.x) / 2} y={(draft.pts[draft.pts.length - 1].z + draft.cur.z) / 2 - fs * 0.8} fontSize={fs} textAnchor="middle" fill="#2d6cdf">{fmtLen(Math.hypot(draft.cur.x - draft.pts[draft.pts.length - 1].x, draft.cur.z - draft.pts[draft.pts.length - 1].z), unit)}</text>
            </g>
          )}
          {draft && draft.kind === "measure" && (
            <g style={{ pointerEvents: "none" }}>
              <line x1={draft.a.x} y1={draft.a.z} x2={draft.b.x} y2={draft.b.z} stroke="#0f766e" strokeWidth={2 / k} strokeDasharray={(6 / k) + " " + (4 / k)} />
              <text x={(draft.a.x + draft.b.x) / 2} y={(draft.a.z + draft.b.z) / 2 - fs * 0.8} fontSize={fs} textAnchor="middle" fill="#0f766e">{fmtLen(Math.hypot(draft.b.x - draft.a.x, draft.b.z - draft.a.z), unit)}</text>
            </g>
          )}
          {draft && draft.kind === "wall" && (
            <g style={{ pointerEvents: "none" }}>
              <line x1={draft.pts[0].x} y1={draft.pts[0].z} x2={draft.cur.x} y2={draft.cur.z} stroke="#2d6cdf" strokeWidth={150} strokeOpacity={0.45} />
              <circle cx={draft.pts[0].x} cy={draft.pts[0].z} r={6 / k} fill="#2d6cdf" />
              <text x={(draft.pts[0].x + draft.cur.x) / 2} y={(draft.pts[0].z + draft.cur.z) / 2 - 170} fontSize={fs} textAnchor="middle" fill="#2d6cdf">{fmtLen(Math.hypot(draft.cur.x - draft.pts[0].x, draft.cur.z - draft.pts[0].z), unit) + " · " + Math.round((Math.atan2(-(draft.cur.z - draft.pts[0].z), draft.cur.x - draft.pts[0].x) * 180) / Math.PI + 360) % 360 + "°"}</text>
            </g>
          )}
          {guides.map((g, i) => (g.axis === "x"
            ? <line key={i} x1={g.at} x2={g.at} y1={g.from - 300} y2={g.to + 300} stroke="#e5484d" strokeWidth={1.2 / k} strokeDasharray={`${6 / k} ${4 / k}`} style={{ pointerEvents: "none" }} />
            : <line key={i} y1={g.at} y2={g.at} x1={g.from - 300} x2={g.to + 300} stroke="#e5484d" strokeWidth={1.2 / k} strokeDasharray={`${6 / k} ${4 / k}`} style={{ pointerEvents: "none" }} />))}
          {snapCur && ["room", "wall", "poly", "measure"].includes(ptool) && (
            <g style={{ pointerEvents: "none" }} stroke={snapCur.kind === "point" ? "#16a34a" : "#2d6cdf"} strokeWidth={1.6 / k} fill="none">
              <circle cx={snapCur.x} cy={snapCur.z} r={(snapCur.kind === "point" ? 9 : 6) / k} />
              <line x1={snapCur.x - 14 / k} x2={snapCur.x + 14 / k} y1={snapCur.z} y2={snapCur.z} />
              <line x1={snapCur.x} x2={snapCur.x} y1={snapCur.z - 14 / k} y2={snapCur.z + 14 / k} />
            </g>
          )}
        </g>
      </svg>
    );
  };

  const hints = { select: coarse ? "Tap to select, drag to move. Pinch to zoom, drag empty space to pan." : "Click to select, drag to move. Drag a corner dot to reshape a room, or a square handle to push an edge. Arrow keys nudge. Ctrl+C / V copy and paste.", room: "Drag on the plan to draw a room. It gets its own walls and floor.", wall: "Click to place wall points. Double-click or press Esc to finish.", door: "Click a wall to place a door.", window: "Click a wall to place a window.", poly: "Click corners for any shape. Click the first point or double-click to close it.", measure: "Click two points to add a dimension line. Snaps to wall ends. Esc cancels." };

  /* ================================================================ */
  return (
    <div ref={rootRef} className={rootCls} style={style} onClick={() => setFileOpen(false)}>
      <style>{CSS}</style>

      <header className="b3d-top">
        <div className="b3d-logo b3d-hide-sm">Builder3D</div>
        <div className="b3d-sep b3d-hide-sm" />
        <div className="b3d-actions" role="group" aria-label="Design actions">
        <div className="b3d-menu">
          <button className="b3d-tb" aria-label="Open file menu" title="File" onClick={(e) => { e.stopPropagation(); setFileOpen((o) => !o); }}><Ic n="file" /><span>File</span></button>
          {fileOpen && (
            <div className="b3d-drop" onClick={(e) => e.stopPropagation()}>
              <button onClick={exportPng}>Export render (PNG)</button>
              <button onClick={exportSvg}>Export floor plan (SVG)</button>
              <button onClick={exportGlb}>Export 3D model (GLB)</button>
              <button onClick={exportCsv}>Export estimate (CSV)</button>
              <button onClick={exportJson}>Save design file (.json)</button>
              <button onClick={() => glbInput.current && glbInput.current.click()}>Import furniture model (GLB)…</button>
              <button onClick={() => traceInput.current && traceInput.current.click()}>Trace over image…</button>
              <button onClick={() => fileInput.current && fileInput.current.click()}>Import design…</button>
              <button onClick={() => { snapshot(); setD(sampleHouse()); setSelection(null); setFileOpen(false); }}>Load sample house</button>
              <button onClick={() => { snapshot(); setD(blankD(dRef.current)); setSelection(null); setFileOpen(false); setMode("plan"); }}>New empty plan</button>
              <button onClick={() => { setLive((v) => !v); setFileOpen(false); }}>{live ? "Turn live render off" : "Turn live render on"}</button>
              <button onClick={() => { setFileOpen(false); if ((D.items.length || D.walls.length) && window.confirm("Remove everything from this design?")) { commit(() => blankD(dRef.current)); setSelection(null); } }}>Clear everything</button>
            </div>
          )}
          <input ref={fileInput} type="file" accept="application/json" hidden onChange={(e) => importJson(e.target.files[0])} />
          <input ref={glbInput} type="file" accept=".glb,.gltf,model/gltf-binary" hidden onChange={(e) => { importGlb(e.target.files[0]); e.target.value = ""; }} />
          <input ref={traceInput} type="file" accept="image/*" hidden onChange={(e) => { importTrace(e.target.files[0]); e.target.value = ""; }} />
        </div>
        <button className="b3d-tb b3d-save-share" aria-label="Save design and prepare WhatsApp booklet" title="Save design and prepare WhatsApp booklet" onClick={saveAndShare}><Ic n="save" /><span>Save &amp; share</span></button>
        <div className="b3d-history" role="group" aria-label="History">
          <button className="b3d-tb" aria-label="Undo" title="Undo" onClick={undo} disabled={!pastRef.current.length}><Ic n="undo" /><span>Undo</span></button>
          <button className="b3d-tb" aria-label="Redo" title="Redo" onClick={redo} disabled={!futureRef.current.length}><Ic n="redo" /><span>Redo</span></button>
        </div>
        <button className="b3d-tb b3d-clear b3d-hide-sm" aria-label="Clear design" title="Clear design" onClick={() => { if ((D.items.length || D.walls.length) && window.confirm("Remove everything from this design?")) { commit(() => blankD(dRef.current)); setSelection(null); } }}><Ic n="clear" /><span>Clear</span></button>
        </div>
        <div className="b3d-grow" />
        <div className="b3d-modes" role="tablist" aria-label="Workspace">
          {[["plan", "Floor plan"], ["interior", "Interior"], ["exterior", "Exterior"]].map(([k, l]) => <button key={k} role="tab" aria-selected={mode === k} className={mode === k ? "on" : ""} onClick={() => setMode(k)}>{l}</button>)}
        </div>
        <div className="b3d-grow" />
        <button className={"b3d-live b3d-hide-sm" + (live ? " on" : "")} onClick={() => setLive((v) => !v)} aria-pressed={live}><span>Live render</span><i /></button>
        {msg && <div className="b3d-msg" role="status">{msg}</div>}
      </header>

      {shareOpen && (
        <div className="b3d-modalbg" role="presentation" onPointerDown={() => setShareOpen(false)}>
          <div className="b3d-modal b3d-share-modal" role="dialog" aria-modal="true" aria-labelledby="b3d-share-title" onPointerDown={(event) => event.stopPropagation()}>
            <div className="b3d-share-head">
              <b id="b3d-share-title">Share design with the owner</b>
              <button className="b3d-x" aria-label="Close" onClick={() => setShareOpen(false)}><Ic n="clear" size={16} /></button>
            </div>
            {shareStage === "contact" && <>
              <p className="b3d-note">Your design is saved. Enter the owner’s WhatsApp number to prepare a browser-viewable design booklet.</p>
              <label className="b3d-field">Owner’s WhatsApp number, including country code
                <input className="b3d-share-phone" type="tel" autoComplete="tel" placeholder="e.g. 919876543210" value={ownerPhone} onChange={(event) => setOwnerPhone(event.target.value)} />
              </label>
              <p className="b3d-share-includes">The booklet includes every room’s dimensions, boundary walls, finishes, doors/windows, and placed furniture and fixtures, along with each floor plan, 3D previews and the preliminary estimate.</p>
              <div className="b3d-btns">
                <button onClick={() => setShareOpen(false)}>Cancel</button>
                <button className="b3d-primary" onClick={prepareShareBooklet}>Create booklet</button>
              </div>
            </>}
            {shareStage === "generating" && <p className="b3d-note" role="status">Capturing the walkthrough, 3D views and floor plans… Keep this editor open for a moment.</p>}
            {shareStage === "ready" && <>
              <p className="b3d-note">Your complete room-by-room booklet is ready as <b>{shareFileName}</b>. Download it, then share it as a WhatsApp document. The owner can open it in a regular web browser without VS Code.</p>
              <div className="b3d-btns">
                <button onClick={() => setShareOpen(false)}>Done</button>
                <a className="b3d-download" href={shareUrl} download={shareFileName}><Ic n="save" size={15} /> Download booklet</a>
                <button className="b3d-primary" onClick={shareOnWhatsApp}><Ic n="send" size={15} /> Share on WhatsApp</button>
              </div>
            </>}
            {shareError && <p className="b3d-share-error" role="alert">{shareError}</p>}
          </div>
        </div>
      )}

      <div className="b3d-main">
        {compact && (leftOpen || rightOpen) && <div className="b3d-backdrop" onClick={() => { setLeftOpen(false); setRightOpen(false); }} />}
        {/* ------------- left ------------- */}
        <aside className={"b3d-left" + (leftOpen ? " open" : "")}>
          {compact && <button className="b3d-dclose" onClick={() => setLeftOpen(false)} aria-label="Close library"><Ic n="clear" size={16} /></button>}
          {mode === "exterior" ? (
            <div className="b3d-lib b3d-scroll">
              <div className="b3d-lib-h"><strong>Exterior studio</strong><span className="b3d-ex-hint">Edit the house and site</span></div>
              <div className="b3d-cats b3d-ex-tabs" role="tablist" aria-label="Exterior settings">
                {[["structure", "Structure"], ["finishes", "Finishes"], ["site", "Site"]].map(([k, label]) => (
                  <button key={k} role="tab" aria-selected={exteriorTab === k} className={exteriorTab === k ? "on" : ""} onClick={() => setExteriorTab(k)}>{label}</button>
                ))}
              </div>
              {exteriorTab === "structure" && <>
                <h5 className="b3d-h5">Facade style</h5>
                <div className="b3d-cats">{[["modern", "Modern"], ["classic", "Classic"]].map(([k, label]) => <button key={k} aria-pressed={D.ext.facade === k} className={D.ext.facade === k ? "on" : ""} onClick={() => patchExt({ facade: k })}>{label}</button>)}</div>
                <h5 className="b3d-h5">Storeys</h5>
                <div className="b3d-cats">{[1, 2, 3].map((n) => <button key={n} aria-pressed={D.ext.storeys === n} className={D.ext.storeys === n ? "on" : ""} onClick={() => patchExt({ storeys: n })}>{n} {n === 1 ? "floor" : "floors"}</button>)}</div>
                <p className="b3d-note b3d-ex-note">Your floor-plan levels keep their rooms; extra storeys are shown as exterior massing.</p>
                <h5 className="b3d-h5">Roof style</h5>
                <div className="b3d-cats">{ROOF_STYLES.map(([k, l]) => <button key={k} aria-pressed={D.ext.roof === k} className={D.ext.roof === k ? "on" : ""} onClick={() => patchExt({ roof: k })}>{l}</button>)}</div>
                <div className="b3d-ex-rows">
                  {D.ext.roof !== "flat" && <Row label="Pitch" value={D.ext.roofPitch ?? 24} min={5} max={60} unit="°" onStart={snapshot} onChange={(v) => setExt({ roofPitch: clamp(v || 24, 5, 60) })} />}
                  <Row label="Overhang" value={D.ext.overhang ?? 450} min={0} max={1500} step={50} onStart={snapshot} onChange={(v) => setExt({ overhang: clamp(v || 0, 0, 1500) })} />
                </div>
                {D.ext.roof === "shed" && <p className="b3d-note b3d-ex-note">Shed roofs use half the pitch, so the high side stays at a sensible height.</p>}
                {D.ext.roof === "gable" && (<><h5 className="b3d-h5">Ridge direction</h5><div className="b3d-cats">{[["auto", "Automatic"], ["x", "Along width"], ["z", "Along depth"]].map(([k, l]) => <button key={k} aria-pressed={(D.ext.ridge || "auto") === k} className={(D.ext.ridge || "auto") === k ? "on" : ""} onClick={() => patchExt({ ridge: k })}>{l}</button>)}</div></>)}
                <p className="b3d-note b3d-ex-note">The roof follows the footprint of your top floor. Lower floors that extend past it get a flat terrace slab.</p>
              </>}
              {exteriorTab === "finishes" && <>
                <h5 className="b3d-h5">Facade finish</h5>
                <div className="b3d-cats">{EXT_FINISHES.map(([k, l]) => <button key={k} aria-pressed={D.ext.finish === k} className={D.ext.finish === k ? "on" : ""} onClick={() => patchExt({ finish: k })}>{l}</button>)}</div>
                <h5 className="b3d-h5">Roof material</h5>
                <div className="b3d-cats">{ROOF_MATS.map(([k, l]) => <button key={k} aria-pressed={(D.ext.roofMat || "tile") === k} className={(D.ext.roofMat || "tile") === k ? "on" : ""} onClick={() => patchExt({ roofMat: k })}>{l}</button>)}</div>
                <h5 className="b3d-h5">Window and door frames</h5>
                <div className="b3d-cats">{FRAMES.map(([k, l]) => <button key={k} aria-pressed={(D.ext.frame || "pvc") === k} className={(D.ext.frame || "pvc") === k ? "on" : ""} onClick={() => patchExt({ frame: k })}>{l}</button>)}</div>
                {[["Wall colour", "wall", EXT_WALL], ["Roof colour", "roofColor", EXT_ROOF], ["Trim and window frames", "trim", ["#ffffff", "#2b2b2b", "#8b5e48", "#7d7f84"]]].map(([label, key, swatches]) => (
                  <section className="b3d-ex-color" key={key}>
                    <h5 className="b3d-h5">{label}</h5>
                    <Swatches list={swatches} value={D.ext[key]} onPick={(c) => patchExt({ [key]: c })} />
                    <label className="b3d-color-pick"><span>Custom colour</span><input type="color" aria-label={`Custom ${label.toLowerCase()}`} value={D.ext[key]} onChange={(e) => patchExt({ [key]: e.target.value })} /></label>
                  </section>
                ))}
              </>}
              {exteriorTab === "site" && <>
                <h5 className="b3d-h5">Landscape and exterior details</h5>
                <div className="b3d-ex-features">{[["lawn", "Lawn"], ["fence", "Fence and gate"], ["trees", "Trees and shrubs"], ["driveway", "Driveway"], ["parking", "Parking bay with car"], ["porch", "Covered entrance porch"], ["lights", "Entrance lights"], ["solar", "Solar panels"]].map(([k, l]) => (
                  <label key={k} className="b3d-chk"><input type="checkbox" checked={D.ext[k]} onChange={(e) => patchExt({ [k]: e.target.checked })} /><span>{l}</span></label>
                ))}</div>
              </>}
              {!hasBuilding && <p className="b3d-note">Draw rooms in Floor plan first. The house is built from your plan.</p>}
            </div>
          ) : replaceOpen && sel ? (
            <div className="b3d-lib">
              <div className="b3d-lib-h"><strong>Replace model</strong><button className="b3d-x" onClick={() => setReplaceOpen(false)} aria-label="Close"><Ic n="clear" size={16} /></button></div>
              <div className="b3d-grid">
                {CAT[sel.type].variants.map((v, i) => (
                  <button key={i} className={"b3d-card" + (sel.variant === i ? " on" : "")} onClick={() => commit((d) => ({ ...d, items: d.items.map((x) => (x.id === sel.id ? { ...x, variant: i, color: null } : x)) }))}>
                    <div className="b3d-thumb">{thumbs[sel.type + ":" + i] ? <img alt="" src={thumbs[sel.type + ":" + i]} /> : <span className="b3d-thumb-fallback">{thumbsReady ? "Preview unavailable" : "Loading preview..."}</span>}</div>
                    <span>{v.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="b3d-lib">
              <div className="b3d-search"><Ic n="search" size={15} /><input placeholder="Search furniture" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
              <div className="b3d-cats" role="tablist">{CATEGORIES.map(([k, l]) => <button key={k} role="tab" aria-selected={cat === k} className={cat === k ? "on" : ""} onClick={() => setCat(k)}>{l}</button>)}</div>
              <div className="b3d-grid">
                {list.map((c) => (
                  <button key={c.type} className="b3d-card" draggable onDragStart={(e) => e.dataTransfer.setData("text/plain", c.type)} onClick={() => addItem(c.type)} title="Click to add (into the selected room), or drag into the plan or room">
                    <div className="b3d-thumb">{thumbs[c.type + ":0"] ? <img alt="" src={thumbs[c.type + ":0"]} /> : <span className="b3d-thumb-fallback">{thumbsReady ? "Preview unavailable" : "Loading preview..."}</span>}</div>
                    <span>{c.name}</span><small>{c.size[0]} × {c.size[1]} mm</small>
                  </button>
                ))}
                {!list.length && <p className="b3d-empty">{cat === "fav" ? "Star an item in the room to find it here." : "No furniture matches that search."}</p>}
              </div>
            </div>
          )}
        </aside>

        {/* ------------- centre ------------- */}
        <section className="b3d-view" onDragOver={(e) => e.preventDefault()} onDrop={onDrop} onClick={() => setMenu(null)}>
          <div ref={hostRef} className="b3d-canvas" />
          {mode === "interior" && !walk && D.rooms.length > 0 && (
            <div className="b3d-ex-views b3d-int-views" role="group" aria-label={`Interior camera views for floor ${lv + 1}`}>
              <span className="b3d-int-view-label">Floor {lv + 1} · all rooms</span>
              <button type="button" aria-pressed={interiorView === "top"} className={interiorView === "top" ? "on" : ""} onClick={() => { setInteriorView("top"); aimInteriorTop(); }}>Top view</button>
              <button type="button" aria-pressed={interiorView === "room"} className={interiorView === "room" ? "on" : ""} onClick={() => { setInteriorView("room"); aimCamera("interior"); }}>3D room view</button>
            </div>
          )}
          <div ref={tipRef} className="b3d-tip" style={{ visibility: "hidden" }} role="tooltip" />
          {mode === "exterior" && hasBuilding && (
            <div className="b3d-ex-views" role="group" aria-label="Exterior camera views">
              {[["front", "Front"], ["angle", "3D view"], ["side", "Side"], ["roof", "Roof"]].map(([view, label]) => (
                <button key={view} onClick={() => setExteriorCamera(view)}>{label}</button>
              ))}
            </div>
          )}
          <div ref={planWrap} className="b3d-plan" style={{ display: mode === "plan" ? "block" : "none" }}>
            {planSvg()}
            <div className="b3d-ptools" onPointerDown={(e) => e.stopPropagation()}>
              {[["select", "cursor", "Select (V)"], ["room", "room", "Room (R)"], ["wall", "wall", "Wall (W)"], ["door", "door", "Door (D)"], ["window", "window", "Window (N)"], ["poly", "poly", "Polygon (P)"], ["measure", "ruler", "Measure (M)"]].map(([k, ic, t]) => (
                <button key={k} className={ptool === k ? "on" : ""} title={t} onClick={() => { setPtool(k); setDraft(null); setHover(null); showGuides([]); setSnapCur(null); }}><Ic n={ic} /><span>{t.split(" ")[0]}</span></button>
              ))}
              <button className={planSet ? "on" : ""} title="Plan settings: units, snapping, dimensions" aria-expanded={planSet} onClick={() => setPlanSet((o) => !o)}><Ic n="sliders" /><span>Settings</span></button>
              {planSet && (
                <div className="b3d-pop b3d-setpop" role="dialog" aria-label="Plan settings" onPointerDown={(e) => e.stopPropagation()}>
                  <label className="b3d-field">Measurement units
                    <select className="b3d-select" value={unit} onChange={(e) => setD({ ...dRef.current, unit: e.target.value })}>
                      {[["mm", "Millimetres (mm)"], ["cm", "Centimetres (cm)"], ["m", "Metres (m)"], ["ft", "Feet and inches"], ["in", "Inches"]].map(([u, l]) => <option key={u} value={u}>{l}</option>)}
                    </select>
                  </label>
                  <label className="b3d-chk"><input type="checkbox" checked={snapOn} onChange={(e) => setSnapOn(e.target.checked)} /><span>Snap to grid</span></label>
                  <label className="b3d-field">Grid size
                    <select className="b3d-select" value={gridSize} onChange={(e) => setGridSize(+e.target.value)}>
                      {[25, 50, 100, 250, 500].map((g) => <option key={g} value={g}>{fmtLen(g, unit)}</option>)}
                    </select>
                  </label>
                  <label className="b3d-chk"><input type="checkbox" checked={guidesOn} onChange={(e) => setGuidesOn(e.target.checked)} /><span>Alignment guides</span></label>
                  <label className="b3d-chk"><input type="checkbox" checked={showDims} onChange={(e) => setShowDims(e.target.checked)} /><span>Dimension lines on walls</span></label>
                  <label className="b3d-chk"><input type="checkbox" checked={angleSnap} onChange={(e) => setAngleSnap(e.target.checked)} /><span>Draw walls at 15° steps</span></label>
                  <LenInput label="New wall thickness" value={D.wallT || 150} onChange={(v) => setD({ ...dRef.current, wallT: clamp(Math.round(v), 80, 600) })} />
                </div>
              )}
              {ptool === "room" && (
                <select className="b3d-select" value={rtype} onChange={(e) => setRtype(e.target.value)} aria-label="Room type">
                  {Object.entries(ROOM_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              )}
            </div>
            <div className="b3d-phint">{hints[ptool]}</div>
            {((draft && (draft.kind === "wall" || draft.kind === "poly")) || (!draft && (selection || clipRef.current))) && (
              <div className="b3d-pact">
                {draft && draft.kind === "poly" && draft.pts.length >= 3 && <button className="b3d-primary" onClick={() => finishPoly(draft.pts)}>Close shape</button>}
                {draft && draft.kind === "wall" && <button className="b3d-primary" onClick={() => setDraft(null)}>Done</button>}
                {draft && <button onClick={() => setDraft(null)}>Cancel</button>}
                {!draft && <button disabled={!selection} title="Copy (Ctrl+C)" onClick={() => copySelection(false)}><Ic n="copy" size={15} /> Copy</button>}
                {!draft && <button disabled={!selection} title="Cut (Ctrl+X)" onClick={() => copySelection(true)}>Cut</button>}
                {!draft && <button disabled={!clipRef.current} title="Paste (Ctrl+V)" onClick={pasteClipboard}>Paste</button>}
                {!draft && <button disabled={!selection} title="Duplicate (Ctrl+D)" onClick={duplicateSelection}>Duplicate</button>}
                {!draft && <button disabled={!selection} title="Delete (Del)" onClick={deleteSelection}><Ic n="trash" size={15} /> Delete</button>}
              </div>
            )}
            {(() => {
              const steps = unit === "ft" || unit === "in" ? [305, 610, 1524, 3048, 6096, 15240, 30480] : [200, 500, 1000, 2000, 5000, 10000];
              let len = steps[0];
              steps.forEach((o) => { if (o * pv.k <= 140) len = o; });
              return <div className="b3d-scale-bar" style={{ width: len * pv.k }}><span>{fmtLen(len, unit)}</span></div>;
            })()}
            {!D.rooms.length && !draft && <div className="b3d-hint">Start with the Room tool, then drag out your first room.</div>}
          </div>

          <div ref={tbRef} className="b3d-float" style={{ visibility: "hidden" }} onPointerDown={(e) => e.stopPropagation()}>
            {sel && mode === "interior" && (
              <>
                <button className="b3d-chip" onClick={() => setMatOpen((o) => !o)}>Material editor <Ic n="chevron" size={13} /></button>
                <div className="b3d-bar">
                  <button className={tool === "translate" ? "on" : ""} title="Move (G)" onClick={() => setTool("translate")}><Ic n="move" /></button>
                  <button className={tool === "rotate" ? "on" : ""} title="Rotate (R)" onClick={() => setTool("rotate")}><Ic n="rotate" /></button>
                  <button className={tool === "scale" ? "on" : ""} title="Scale (E)" onClick={() => setTool("scale")}><Ic n="scale" /></button>
                  <button title="Mirror" onClick={() => commit((d) => ({ ...d, items: d.items.map((x) => (x.id === sel.id ? { ...x, mirror: !x.mirror } : x)) }))}><Ic n="mirror" /></button>
                  <button title="Replace model" onClick={() => setReplaceOpen(true)}><Ic n="swap" /></button>
                  <button title="Duplicate (Ctrl+D)" onClick={() => duplicate(sel.id)}><Ic n="copy" /></button>
                  <button title="Hide" onClick={() => { commit((d) => ({ ...d, items: d.items.map((x) => (x.id === sel.id ? { ...x, hidden: true } : x)) })); setSelection(null); }}><Ic n="eyeoff" /></button>
                  <button title="Favourite" className={sel.fav ? "on" : ""} onClick={() => commit((d) => ({ ...d, items: d.items.map((x) => (x.id === sel.id ? { ...x, fav: !x.fav } : x)) }))}><Ic n="star" fill={sel.fav ? "currentColor" : "none"} /></button>
                  <button title="Delete" onClick={deleteSelection}><Ic n="trash" /></button>
                </div>
                {matOpen && (
                  <div className="b3d-pop">
                    <p>Colour</p>
                    <Swatches list={SWATCHES} value={sel.color} onPick={(c) => commit((d) => ({ ...d, items: d.items.map((x) => (x.id === sel.id ? { ...x, color: c } : x)) }))} />
                    <button className="b3d-link" onClick={() => commit((d) => ({ ...d, items: d.items.map((x) => (x.id === sel.id ? { ...x, color: null } : x)) }))}>Use original colour</button>
                  </div>
                )}
              </>
            )}
            {!sel && selection && selection.kind !== "dim" && mode !== "plan" && !walk && (
              <div className="b3d-bar b3d-bar-sel">
                <span className="b3d-bar-label">{selection.kind === "wall" ? "Wall" : selection.kind === "room" ? "Floor" : ((D.openings.find((o) => o.id === selection.id) || {}).type === "door" ? "Door" : "Window")}</span>
                <button title="Edit on the floor plan" onClick={goPlan}><Ic n="home" /></button>
                <button title="Copy (Ctrl+C)" onClick={() => copySelection(false)}><Ic n="copy" /></button>
                <button title="Delete" onClick={deleteSelection}><Ic n="trash" /></button>
              </div>
            )}
          </div>

          {menu && menuItem && mode === "interior" && (
            <div className="b3d-ctx" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
              <button onClick={() => { commit((d) => ({ ...d, items: d.items.map((x) => (x.id === menu.id ? { ...x, locked: !x.locked } : x)) })); setMenu(null); }}><Ic n="lock" size={15} />{menuItem.locked ? "Unlock" : "Lock"}</button>
              <button onClick={() => { arrayItem(menu.id); setMenu(null); }}><Ic n="layers" size={15} />Array (3 copies)</button>
              <button onClick={() => { setMode("plan"); setMenu(null); }}><Ic n="home" size={15} />View on floor plan</button>
              <button onClick={() => { zoomSelection(menu.id); setMenu(null); }}><Ic n="search" size={15} />Zoom selection</button>
            </div>
          )}

          <div className="b3d-bottom">
            {compact && (
              <>
                <button className="b3d-pill b3d-btn" onClick={() => { setLeftOpen(true); setRightOpen(false); }}><Ic n="plus" size={15} /> Library</button>
                <button className={"b3d-pill b3d-btn" + (selection ? " b3d-on" : "")} onClick={() => { setRightOpen(true); setLeftOpen(false); }}><Ic n="sliders" size={15} /> {selection ? "Edit" : "Info"}</button>
              </>
            )}
            {mode !== "exterior" && <div className="b3d-seg" role="group" aria-label="Floor">
              {Array.from({ length: nL }, (_, i) => <button key={i} className={lv === i ? "on" : ""} onClick={() => setLv(i)}>{i + 1}F</button>)}
              <button title="Add a floor" aria-label="Add floor" onClick={addFloor}><Ic n="plus" size={14} /></button>
              {nL > 1 && <button title="Remove the top floor" aria-label="Remove top floor" onClick={removeTopFloor}><Ic n="minus" size={14} /></button>}
            </div>}
            {floorDlg && (() => {
              const cur = lv, fits = D.rooms.filter((r) => (r.lv || 0) === cur && spiralFits(r)), hasPlan = D.rooms.some((r) => (r.lv || 0) === cur);
              const pickId = fits.some((r) => r.id === spiralRoom) ? spiralRoom : fits[0] && fits[0].id;
              const sel = D.rooms.find((r) => r.id === pickId), crowd = sel ? D.items.filter((i) => inRect(i, sel) && !i.hidden && i.type !== "rug").length : 0;
              return (
                <div className="b3d-modalbg" role="presentation" onPointerDown={() => setFloorDlg(false)}>
                  <div className="b3d-modal" role="dialog" aria-label="Add a floor" onPointerDown={(e) => e.stopPropagation()}>
                    <b>Add floor {nL + 1}</b>
                    <p className="b3d-note">How should people get up from floor {cur + 1}?</p>
                    <label className="b3d-opt"><input type="radio" name="fl-opt" checked={floorOpt === "room"} onChange={() => setFloorOpt("room")} /><span><b>Separate stairwell room</b><br />Builds a 1.8 × 4.6 m stairwell beside the house with straight stairs, on both floors, joined by a door.</span></label>
                    <label className="b3d-opt"><input type="radio" name="fl-opt" checked={floorOpt === "spiral"} onChange={() => setFloorOpt("spiral")} /><span><b>Built-in spiral stairs in a room I choose</b><br />Fits into a corner of that room. Furniture in it is rearranged to other places.</span></label>
                    {floorOpt === "spiral" && (fits.length ? (
                      <div className="b3d-field"><label>Room for the spiral stairs
                        <select className="b3d-select" aria-label="Room for the spiral stairs" value={pickId} onChange={(e) => setSpiralRoom(e.target.value)}>
                          {fits.map((r) => <option key={r.id} value={r.id}>{r.name} ({(r.w / 1000).toFixed(1)} × {(r.d / 1000).toFixed(1)} m)</option>)}
                        </select></label>
                        <p className="b3d-note">{crowd ? crowd + " furniture item" + (crowd === 1 ? "" : "s") + " in this room will be checked and moved if they are in the way." : "This room is empty, nothing needs to move."}</p>
                      </div>
                    ) : <p className="b3d-note">No room on this floor is large enough (about 2.3 × 2.3 m). Choose a stairwell room instead.</p>)}
                    <label className="b3d-opt"><input type="radio" name="fl-opt" checked={floorOpt === "none"} onChange={() => setFloorOpt("none")} /><span><b>No stairs for now</b></span></label>
                    {hasPlan && <label className="b3d-chk"><input type="checkbox" checked={floorCopy} onChange={(e) => setFloorCopy(e.target.checked)} /><span>Copy this floor&apos;s rooms, walls, doors and windows to the new floor</span></label>}
                    <div className="b3d-btns">
                      <button onClick={() => setFloorDlg(false)}>Cancel</button>
                      <button className="b3d-primary" disabled={floorOpt === "spiral" && !fits.length} onClick={() => { if (floorOpt === "spiral" && pickId !== spiralRoom) setSpiralRoom(pickId); confirmAddFloor(pickId); }}>Add floor</button>
                    </div>
                  </div>
                </div>
              );
            })()}
            {mode === "interior" && (
              <div className="b3d-seg" role="group" aria-label="Wall display">
                {[["cut", "Cut-away"], ["full", "Full walls"], ["low", "Low walls"]].map(([k, l]) => <button key={k} className={cut === k ? "on" : ""} onClick={() => setCut(k)}>{l}</button>)}
              </div>
            )}
            <div className="b3d-grow" />
            {mode === "interior" && <button className={"b3d-pill b3d-btn" + (walk ? " b3d-on" : "")} onClick={() => setWalk((w) => !w)} aria-pressed={walk} title="First-person walk (WASD, Shift to run, drag to look, Esc to exit)">Walk</button>}
            {mode === "interior" && hasBuilding && <button className={"b3d-pill b3d-btn" + (tour ? " b3d-on" : "")} onClick={() => { if (!walk) { setWalk(true); setTour(true); } else setTour((t) => !t); }} aria-pressed={tour} title="Automatic tour: a look-around in every room">Tour</button>}
            {hiddenCount > 0 && <button className="b3d-pill b3d-btn" onClick={() => commit((d) => ({ ...d, items: d.items.map((x) => ({ ...x, hidden: false })) }))}><Ic n="eye" size={15} /> Show {hiddenCount} hidden</button>}
            <button className="b3d-icon" title="Fit to view" onClick={fit}><Ic n="home" size={16} /></button>
            <button className="b3d-icon" title="Zoom out" onClick={() => zoomBy(1.2)}><Ic n="minus" size={16} /></button>
            <span className="b3d-zoom">{mode === "plan" ? Math.round((pv.k / 0.1) * 100) : zoomPct}</span>
            <button className="b3d-icon" title="Zoom in" onClick={() => zoomBy(1 / 1.2)}><Ic n="plus" size={16} /></button>
          </div>
          {walk && mode === "interior" && (
            <>
              <div className="b3d-phint" role="note">
                {coarse ? "Drag the stick to move and drag anywhere else to look." : "WASD or arrow keys to move (Shift to run), drag to look" + (walkSet.pointerLock && lockSupported ? " (click captures the mouse, Esc releases it)" : "") + ", R restarts at the entrance, Esc exits."}
                {lockOn && !coarse ? " Mouse captured." : ""}
                <button className="b3d-link" style={{ marginLeft: 8, color: "#9ec1ff" }} onClick={() => setWalkPanel((v) => !v)} aria-expanded={walkPanel}>Look and move settings</button>
                <button className="b3d-link" style={{ marginLeft: 8, color: "#9ec1ff" }} onClick={() => setWalk(false)}>Exit</button>
              </div>
              {walkPanel && (
                <div className="b3d-wp" role="dialog" aria-label="Walkthrough settings">
                  <div className="b3d-wp-h"><b>Walkthrough settings</b><button className="b3d-icon" aria-label="Close walkthrough settings" onClick={() => setWalkPanel(false)}>×</button></div>
                  {[["sens", "Mouse sensitivity", 0.2, 3, 0.05, ""], ["touchSens", "Touch look sensitivity", 0.2, 3, 0.05, ""], ["walkSpeed", "Walking speed", 0.5, 5, 0.1, " m/s"], ["runSpeed", "Running speed", 1, 9, 0.1, " m/s"], ["eye", "Camera height", 1, 2, 0.05, " m"], ["fov", "Field of view", 50, 100, 1, "°"], ["bob", "Camera bobbing", 0, 1, 0.05, ""], ["smooth", "Movement smoothing", 0, 1, 0.05, ""], ["touchScale", "Touch control size", 0.8, 1.6, 0.05, ""]].map(([k, label, mn, mx, st, u]) => (
                    <label key={k} className="b3d-wp-r"><span>{label}</span><input type="range" min={mn} max={mx} step={st} value={walkSet[k]} onChange={(e) => patchWalk({ [k]: parseFloat(e.target.value) })} aria-label={label} /><em>{Number(walkSet[k]).toFixed(st < 1 ? (st < 0.1 ? 2 : 1) : 0)}{u}</em></label>
                  ))}
                  {[["invertH", "Invert horizontal look"], ["invertV", "Invert vertical look"], ["reduceMotion", "Reduce motion (no camera bobbing)"], ["touchRight", "Move stick on the right (touch)"]].map(([k, label]) => (
                    <label key={k} className="b3d-wp-c"><input type="checkbox" checked={!!walkSet[k]} onChange={(e) => patchWalk({ [k]: e.target.checked })} /> {label}</label>
                  ))}
                  <label className="b3d-wp-c"><input type="checkbox" checked={walkSet.pointerLock && lockSupported} disabled={!lockSupported} onChange={(e) => patchWalk({ pointerLock: e.target.checked })} /> Capture the mouse while walking{lockSupported ? "" : " (not supported in this browser)"}</label>
                  <label className="b3d-wp-c"><input type="checkbox" checked={walkSet.freeCam} onChange={(e) => patchWalk({ freeCam: e.target.checked })} /> Free camera (collision off)</label>
                  <p className="b3d-note">Walkthrough mode keeps walls, furniture and stairs solid, like walking through the real house. Free camera turns collision off so you can pass through walls to inspect the model. These settings only change the camera, never your design.</p>
                  <button className="b3d-btn" onClick={() => setWalkSet({ ...WALK_DEFAULTS })}>Reset to defaults</button>
                </div>
              )}
              {mini && (
                <div className="b3d-mini" role="img" aria-label={"Minimap, floor " + (walkLv + 1)}>
                  <svg width={mini.W} height={mini.W} viewBox={"0 0 " + mini.W + " " + mini.W} onPointerDown={(e) => { const r = e.currentTarget.getBoundingClientRect(); teleport((e.clientX - r.left - mini.ox) / mini.k, (e.clientY - r.top - mini.oz) / mini.k); }}>
                    {mini.rooms.map((r) => <polygon key={r.id} points={r.poly.map((q) => (mini.ox + q[0] * mini.k).toFixed(1) + "," + (mini.oz + q[1] * mini.k).toFixed(1)).join(" ")} fill={ROOM_TYPES[r.type].fill} stroke="none" />)}
                    {mini.walls.map((w) => <line key={w.id} x1={mini.ox + w.a[0] * mini.k} y1={mini.oz + w.a[1] * mini.k} x2={mini.ox + w.b[0] * mini.k} y2={mini.oz + w.b[1] * mini.k} stroke="#374151" strokeWidth={Math.max(1.2, w.t * mini.k)} strokeLinecap="square" />)}
                    <g ref={miniRef}><circle r="9" fill="rgba(45,108,223,.2)" /><polygon points="0,-8 5,6 0,3 -5,6" fill="#2d6cdf" /></g>
                  </svg>
                  <span>{walkLv + 1}F · click to jump</span>
                </div>
              )}
              {tourLabel && <div className="b3d-tourlabel" role="status">{tourLabel}</div>}
              <div className={"b3d-fade" + (fade ? " on" : "")} aria-hidden="true" />
              {coarse && (
                <div className={"b3d-touch" + (walkSet.touchRight ? " r" : "")} style={{ "--ts": walkSet.touchScale }}>
                  <Joystick label="Move stick: drag to walk" onChange={(v) => { S.current.joy = v; }} />
                  <div className="b3d-tbtns">
                    <button className={"b3d-tb" + (runOn ? " on" : "")} aria-pressed={runOn} aria-label="Run" onClick={() => { const v = !S.current.runBtn; S.current.runBtn = v; setRunOn(v); }}>Run</button>
                    <button className="b3d-tb" aria-label="Back to the start position" onClick={() => resetWalk()}>Start</button>
                    <button className="b3d-tb" aria-label="Walkthrough settings" onClick={() => setWalkPanel((v) => !v)}>Set</button>
                    <button className="b3d-tb" aria-label="Exit walkthrough" onClick={() => setWalk(false)}>Exit</button>
                  </div>
                </div>
              )}
            </>
          )}
          {mode !== "plan" && !hasBuilding && <div className="b3d-hint">There is no house yet. Open Floor plan and draw a room.</div>}
        </section>

        {/* ------------- right ------------- */}
        <aside className={"b3d-right" + (rightOpen ? " open" : "")}>
          {compact && <button className="b3d-dclose" onClick={() => setRightOpen(false)} aria-label="Close properties"><Ic n="clear" size={16} /></button>}
          <div className="b3d-tabs" role="tablist">
            {[["props", "Properties"], ["rooms", "Rooms"], ["sched", "Schedule"], ["cost", "Cost"], ["views", "Views"]].map(([k, l]) => <button key={k} role="tab" aria-selected={rtab === k} className={rtab === k ? "on" : ""} onClick={() => setRtab(k)}>{l}</button>)}
          </div>

          {rtab === "props" && (
            <div className="b3d-props">
              {sel && (
                <>
                  <div className="b3d-ph">
                    <div className="b3d-thumb sm">{thumbs[sel.type + ":" + sel.variant] ? <img alt="" src={thumbs[sel.type + ":" + sel.variant]} /> : <span className="b3d-thumb-fallback">{thumbsReady ? "N/A" : "..."}</span>}</div>
                    <div><strong>{sel.name}</strong><small>{CAT[sel.type].variants[sel.variant].label}{sel.locked ? " · Locked" : ""}</small></div>
                  </div>
                  <h5>Size</h5>
                  <Row label="Length" value={sel.size.L} min={50} max={4000} onStart={snapshot} onChange={(v) => setDim(sel, "L", v)} />
                  <Row label="Width" value={sel.size.W} min={50} max={4000} onStart={snapshot} onChange={(v) => setDim(sel, "W", v)} />
                  <Row label="Height" value={sel.size.H} min={10} max={3000} onStart={snapshot} onChange={(v) => setDim(sel, "H", v)} />
                  <div className="b3d-scale">
                    <label><input type="checkbox" checked={sel.prop} onChange={(e) => patchItem(sel.id, { prop: e.target.checked })} /> Proportional scale</label>
                    <button onClick={() => commit((d) => ({ ...d, items: d.items.map((x) => (x.id === sel.id ? { ...x, size: { L: x.base[0], W: x.base[1], H: x.base[2] } } : x)) }))}>Reset</button>
                  </div>
                  <h5>Align</h5>
                  <div className="b3d-btns b3d-align" style={{ marginTop: 4 }}>
                    <button onClick={() => alignSel("wall")} title="Move flush against the nearest wall">To wall</button>
                    <button onClick={() => alignSel("cx")} title="Centre in its room, left to right">Centre X</button>
                    <button onClick={() => alignSel("cz")} title="Centre in its room, front to back">Centre Z</button>
                    <button onClick={() => alignSel("square")} title="Round the angle to the nearest 90 degrees">Square up</button>
                    <button onClick={() => alignSel("floor")} title="Set the distance to floor to zero">Drop to floor</button>
                  </div>
                  <label className="b3d-chk"><input type="checkbox" checked={itemSnap} onChange={(e) => setItemSnap(e.target.checked)} /><span>Snap while moving in 3D (50 mm, 15°)</span></label>
                  <h5>Location</h5>
                  <Row label="Distance to floor" value={sel.elev} min={0} max={2500} onStart={snapshot} onChange={(v) => patchItem(sel.id, { elev: Math.max(0, v || 0) })} />
                  <Row label="Angle" value={sel.rot} min={0} max={360} unit="°" onStart={snapshot} onChange={(v) => patchItem(sel.id, { rot: norm(v || 0) })} />
                  <Row label="Position X" value={sel.x} min={-2000} max={14000} onStart={snapshot} onChange={(v) => patchItem(sel.id, { x: v || 0 })} />
                  <Row label="Position Z" value={sel.z} min={-2000} max={14000} onStart={snapshot} onChange={(v) => patchItem(sel.id, { z: v || 0 })} />
                </>
              )}

              {selRoom && (
                <>
                  <h4>Room</h4>
                  <label className="b3d-field">Name<input value={selRoom.name} onFocus={snapshot} onChange={(e) => setD({ ...dRef.current, rooms: dRef.current.rooms.map((r) => (r.id === selRoom.id ? { ...r, name: e.target.value } : r)) })} /></label>
                  <label className="b3d-field">Type
                    <select className="b3d-select" value={selRoom.type} onChange={(e) => commit((d) => ({ ...d, rooms: d.rooms.map((r) => (r.id === selRoom.id ? { ...r, type: e.target.value, floor: null } : r)) }))}>
                      {Object.entries(ROOM_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                    </select>
                  </label>
                  <label className="b3d-field">Floor finish
                    <select className="b3d-select" value={selRoom.floor || ROOM_TYPES[selRoom.type].floor} onChange={(e) => commit((d) => ({ ...d, rooms: d.rooms.map((r) => (r.id === selRoom.id ? { ...r, floor: e.target.value } : r)) }))}>
                      {Object.keys(FLOOR_SIZE).map((k) => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}
                      <option value="none">None (open to below)</option>
                    </select>
                  </label>
                  <dl className="b3d-dl"><dt>Area</dt><dd>{fmtArea(roomArea(selRoom), unit, 2)}</dd><dt>Perimeter</dt><dd>{fmtLen(selRoom.poly.reduce((a, q, i) => { const n = selRoom.poly[(i + 1) % selRoom.poly.length]; return a + Math.hypot(n[0] - q[0], n[1] - q[1]); }, 0), unit)}</dd></dl>
                  <Row label="Width" value={selRoom.w} min={1000} max={12000} step={100} onStart={snapshot} onChange={(v) => rectPatch(selRoom.id, { w: v })} />
                  <Row label="Depth" value={selRoom.d} min={1000} max={12000} step={100} onStart={snapshot} onChange={(v) => rectPatch(selRoom.id, { d: v })} />
                  <Row label="Position X" value={selRoom.x} min={-2000} max={14000} step={100} onStart={snapshot} onChange={(v) => rectPatch(selRoom.id, { x: v })} />
                  <Row label="Position Z" value={selRoom.z} min={-2000} max={14000} step={100} onStart={snapshot} onChange={(v) => rectPatch(selRoom.id, { z: v })} />
                  <Row label="Wall thickness" value={(D.walls.find((w) => w.id === selRoom.wallIds[0]) || {}).t || 150} min={80} max={600} step={10} onStart={snapshot} onChange={(v) => setRoomThickness(selRoom, v)} />
                  {!isRectRoom(selRoom) && (
                    <>
                      <h5>Edge lengths</h5>
                      {selRoom.poly.map((q, i) => { const nb = selRoom.poly[(i + 1) % selRoom.poly.length]; return <LenInput key={i} label={"Edge " + (i + 1)} value={Math.hypot(nb[0] - q[0], nb[1] - q[1])} onStart={snapshot} onChange={(v) => setEdgeLength(selRoom.id, i, v)} />; })}
                    </>
                  )}
                  <p className="b3d-note" style={{ marginTop: 6 }}>{selRoom.poly.length} corners. On the plan: drag a corner, drag a square handle to push an edge, click the small dot on an edge to add a corner, double-click a corner to remove it. Width and Depth scale the whole shape.</p>
                  <div className="b3d-btns">
                    <button className="b3d-primary" onClick={() => furnish(selRoom)}><Ic n="sparkle" size={15} /> Furnish room</button>
                    <button onClick={() => clearRoom(selRoom)}>Clear furniture</button>
                    <button onClick={deleteSelection}>Delete room</button>
                  </div>
                </>
              )}

              {selWall && (
                <>
                  <h4>Wall</h4>
                  <LenInput label="Length" value={wallLen(selWall)} onStart={snapshot} onChange={(v) => setWallLength(selWall, v)} />
                  <Row label="Thickness" value={selWall.t} min={80} max={600} step={10} onStart={snapshot} onChange={(v) => patchWall(selWall.id, { t: v })} />
                  <Row label="Height" value={selWall.h || storeyH(D)} min={500} max={6000} step={50} onStart={snapshot} onChange={(v) => patchWall(selWall.id, { h: v })} />
                  <dl className="b3d-dl"><dt>Storey height</dt><dd>{fmtLen(storeyH(D), unit)}</dd><dt>Floor</dt><dd>{(selWall.lv || 0) + 1}F</dd><dt>Doors and windows</dt><dd>{D.openings.filter((o) => o.wallId === selWall.id).length}</dd></dl>
                  <div className="b3d-btns">
                    {selWall.h ? <button onClick={() => commit((d) => ({ ...d, walls: d.walls.map((w) => (w.id === selWall.id ? { ...w, h: 0 } : w)) }))}>Reset height</button> : null}
                    {wallRoom(selWall) && <button onClick={() => { snapshot(); setRoomThickness(wallRoom(selWall), selWall.t); }}>Use this thickness for the room</button>}
                    <button onClick={deleteSelection}>Delete wall</button>
                  </div>
                  <p className="b3d-note">Drag the white dots on the plan to change the ends. A room's wall pushes that edge of the room. Use the Door and Window tools to add openings.</p>
                </>
              )}

              {selOp && (() => {
                const ow = wallById[selOp.wallId], oL = ow ? wallLen(ow) : 0, isDoor = selOp.type === "door";
                const start = selOp.pos * oL - selOp.width / 2, end = oL - selOp.pos * oL - selOp.width / 2, style = selOp.style || (isDoor ? "panel" : "casement");
                const setOp = (patch) => commit((d) => ({ ...d, openings: d.openings.map((o) => (o.id === selOp.id ? { ...o, ...patch } : o)) }));
                return (
                  <>
                    <h4>{isDoor ? "Door" : "Window"}</h4>
                    <LenInput label="Distance from wall start" value={start} onStart={snapshot} onChange={(v) => setOpOffset(selOp, v)} />
                    <LenInput label="Distance from wall end" value={end} onStart={snapshot} onChange={(v) => setOpOffset(selOp, oL - v - selOp.width)} />
                    <div className="b3d-btns" style={{ marginTop: 6 }}><button onClick={() => setOp({ pos: 0.5 })}>Centre on wall</button></div>
                    <Row label="Width" value={selOp.width} min={400} max={3600} step={50} onStart={snapshot} onChange={(v) => setOpWidth(selOp, v)} />
                    <Row label="Height" value={selOp.h} min={400} max={2800} step={50} onStart={snapshot} onChange={(v) => patchOp(selOp.id, { h: v })} />
                    {!isDoor && <Row label="Sill height" value={selOp.sill} min={0} max={1600} step={50} onStart={snapshot} onChange={(v) => patchOp(selOp.id, { sill: v })} />}
                    <label className="b3d-field">Style
                      <select className="b3d-select" value={style} onChange={(e) => setOp({ style: e.target.value })}>{(isDoor ? DOOR_STYLES : WINDOW_STYLES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                    </label>
                    {isDoor && style !== "double" && style !== "sliding" && (
                      <div className="b3d-btns" style={{ marginTop: 6 }}>
                        <button onClick={() => setOp({ hinge: selOp.hinge === "r" ? "l" : "r" })}>Hinge: {selOp.hinge === "r" ? "right" : "left"} (flip)</button>
                        <button onClick={() => setOp({ flip: !selOp.flip })}>Swing the other way</button>
                      </div>
                    )}
                    {isDoor && style === "double" && <div className="b3d-btns" style={{ marginTop: 6 }}><button onClick={() => setOp({ flip: !selOp.flip })}>Swing the other way</button></div>}
                    {!isDoor && style === "casement" && (
                      <label className="b3d-field">Panes across
                        <select className="b3d-select" value={selOp.panes || 0} onChange={(e) => setOp({ panes: +e.target.value })}>{[[0, "Automatic"], [1, "1"], [2, "2"], [3, "3"], [4, "4"], [6, "6"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                      </label>
                    )}
                    {isDoor && (<><h5>Door colour</h5><Swatches list={["#a9835b", "#6a4636", "#f1f1ef", "#2b2d31", "#3f5675", "#5f7f62"]} value={selOp.color} onPick={(c) => setOp({ color: c })} /></>)}
                    <div className="b3d-btns"><button onClick={deleteSelection}>Delete {selOp.type}</button></div>
                    <p className="b3d-note">Drag it along its wall on the plan, or drag a square end handle to resize it. Click it in 3D to select it there too.</p>
                  </>
                );
              })()}

              {selDim && (
                <>
                  <h4>Dimension</h4>
                  <dl className="b3d-dl"><dt>Length</dt><dd>{fmtLen(Math.hypot(selDim.b[0] - selDim.a[0], selDim.b[1] - selDim.a[1]), unit)}</dd></dl>
                  <div className="b3d-btns"><button onClick={deleteSelection}>Delete dimension</button></div>
                </>
              )}

              {!selection && (
                <>
                  <h4>House</h4>
                  <dl className="b3d-dl">
                    <dt>Floors</dt><dd>{nL}</dd><dt>Rooms</dt><dd>{D.rooms.length}</dd>
                    <dt>Total floor area</dt><dd>{fmtArea(totalArea, unit)}</dd>
                    <dt>Doors</dt><dd>{doors}</dd>
                    <dt>Windows</dt><dd>{windows}</dd>
                    <dt>Furniture</dt><dd>{D.items.length}</dd>
                  </dl>
                  <h5>Building</h5>
                  <Row label="Storey height" value={storeyH(D)} min={2000} max={6000} step={50} onStart={snapshot} onChange={setStoreyH} />
                  <LenInput label="New wall thickness" value={D.wallT || 150} onChange={(v) => setD({ ...dRef.current, wallT: clamp(Math.round(v), 80, 600) })} />
                  <dl className="b3d-dl">{Array.from({ length: nL }, (_, i) => <React.Fragment key={i}><dt>Floor {i + 1} level</dt><dd>{fmtLen(i * storeyH(D), unit)}</dd></React.Fragment>)}</dl>
                  {mode !== "exterior" && (<><h5>Opacity</h5><Row label="Wall" value={wallOp} min={0} max={100} unit="%" onChange={setWallOp} /><Row label="Floor" value={floorOp} min={0} max={100} unit="%" onChange={setFloorOp} /><h5>Interior wall paint</h5><Swatches list={["#f4f4f2", "#e9e4da", "#dfe6df", "#dde6ee", "#efe0dc", "#d9d9d9"]} value={D.ext.inside} onPick={(c) => patchExt({ inside: c })} />
                    <h5>Interior wall finish</h5>
                    <div className="b3d-cats">{INT_FINISHES.map(([k, l]) => <button key={k} aria-pressed={(D.ext.insideFinish || "paint") === k} className={(D.ext.insideFinish || "paint") === k ? "on" : ""} onClick={() => patchExt({ insideFinish: k })}>{l}</button>)}</div></>)}
                  {mode !== "plan" && (
                    <>
                      <h5>Lighting</h5>
                      <Row label="Time of day" value={hour} min={0} max={24} step={0.25} unit="h" dp={1} onChange={setHour} />
                      <div className="b3d-cats" role="group" aria-label="Time presets">{[["Dawn", 6.5], ["Noon", 12.5], ["Sunset", 18], ["Night", 22]].map(([l, h]) => <button key={l} className={Math.abs(hour - h) < 0.01 ? "on" : ""} onClick={() => setHour(h)}>{l}</button>)}</div>
                      <Row label="Exposure" value={Math.round(render.exposure * 100)} min={40} max={200} unit="%" onChange={(v) => setRender({ ...render, exposure: v / 100 })} />
                      <label className="b3d-chk"><input type="checkbox" checked={render.lights} onChange={(e) => setRender({ ...render, lights: e.target.checked })} /><span>Room lights and lit windows after dark</span></label>
                      <h5>Render quality</h5>
                      <div className="b3d-cats" role="group" aria-label="Render quality">{[["standard", "Standard"], ["high", "High"]].map(([k, l]) => <button key={k} aria-pressed={render.quality === k} className={render.quality === k ? "on" : ""} onClick={() => setRender({ ...render, quality: k })}>{l}</button>)}</div>
                    </>
                  )}
                  {trace && (
                    <>
                      <h5>Trace image</h5>
                      <Row label="Width" value={trace.w} min={1000} max={40000} step={100} onChange={(v) => setTrace({ ...trace, w: v })} />
                      <Row label="Position X" value={trace.x} min={-20000} max={40000} step={100} onChange={(v) => setTrace({ ...trace, x: v })} />
                      <Row label="Position Z" value={trace.z} min={-20000} max={40000} step={100} onChange={(v) => setTrace({ ...trace, z: v })} />
                      <Row label="Opacity" value={Math.round(trace.opacity * 100)} min={5} max={100} unit="%" onChange={(v) => setTrace({ ...trace, opacity: v / 100 })} />
                      <div className="b3d-btns"><button onClick={() => setTrace(null)}>Remove image</button></div>
                    </>
                  )}
                  {D.rooms.some((r) => r.type !== "void" && !D.items.some((i) => inRect(i, r))) && (
                    <div className="b3d-btns"><button className="b3d-primary" onClick={() => commit((d) => ({ ...d, items: d.rooms.filter((r) => r.type !== "void" && !d.items.some((i) => inRect(i, r))).reduce((acc, r) => clearStairsInRoom(r, [...acc, ...furnishRoom(r, storeyH(d))], storeyH(d)).items, d.items) }))}><Ic n="sparkle" size={15} /> Furnish all empty rooms</button></div>
                  )}
                  <p className="b3d-note">Select a room, wall, door, window or piece of furniture to edit it.</p>
                </>
              )}
            </div>
          )}

          {rtab === "rooms" && (
            <div className="b3d-props">
              <h4>Rooms</h4>
              {!D.rooms.length && <p className="b3d-note">No rooms yet. Use the Room tool on the floor plan.</p>}
              <table className="b3d-table"><tbody>
                {LD.rooms.map((r) => (
                  <tr key={r.id} className={selRoom && selRoom.id === r.id ? "on" : ""} onClick={() => focusRoom(r)}>
                    <td><strong>{r.name}</strong><br /><small>{ROOM_TYPES[r.type].label}</small></td>
                    <td>{fmtArea(roomArea(r), unit)}</td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          )}

          {rtab === "cost" && (
            <CostPanel D={D} est={estimate(D)} onStart={snapshot}
              onCost={(patch) => setD({ ...dRef.current, cost: { ...DEFAULT_COST, ...(dRef.current.cost || {}), ...patch } })}
              onRate={(key, v) => { const cur = { ...DEFAULT_COST, ...(dRef.current.cost || {}) }, rates = { ...(cur.rates || {}) }; if (v === null) delete rates[key]; else rates[key] = v; if (v === null) snapshot(); setD({ ...dRef.current, cost: { ...cur, rates } }); }} />
          )}

          {rtab === "views" && (
            <div className="b3d-props">
              <h4>Saved views</h4>
              <div className="b3d-btns" style={{ marginTop: 0 }}><button className="b3d-primary" onClick={saveView} disabled={mode === "plan"}>Save current view</button></div>
              {!(D.views || []).length && <p className="b3d-note">Orbit to a spot in Interior or Exterior, then save it here.</p>}
              <table className="b3d-table"><tbody>
                {(D.views || []).map((v) => (
                  <tr key={v.id} onClick={() => gotoView(v)}>
                    <td>{v.name}<br /><small>{v.mode}</small></td>
                    <td><button className="b3d-x" aria-label="Delete view" onClick={(e) => { e.stopPropagation(); commit((d) => ({ ...d, views: (d.views || []).filter((x) => x.id !== v.id) })); }}><Ic n="clear" size={14} /></button></td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          )}

          {rtab === "sched" && (
            <div className="b3d-props">
              <h4>Furniture</h4>
              {!D.items.length && <p className="b3d-note">Nothing placed yet.</p>}
              <table className="b3d-table"><tbody>
                {D.items.map((i) => (
                  <tr key={i.id} className={i.id === selId ? "on" : ""} onClick={() => setSelId(i.id)}>
                    <td>{i.name}</td><td>{fmtLen(i.size.L, unit)} × {fmtLen(i.size.W, unit)} × {fmtLen(i.size.H, unit)}</td>
                  </tr>
                ))}
              </tbody></table>
              <h4 style={{ marginTop: 18 }}>Doors and windows</h4>
              <table className="b3d-table"><tbody>
                {D.openings.map((o) => {
                  const ow = wallById[o.wallId], oL = ow ? wallLen(ow) : 0;
                  return (
                    <tr key={o.id} className={selOp && selOp.id === o.id ? "on" : ""} onClick={() => selectAt({ kind: "op", id: o.id }, o.lv || 0)}>
                      <td>{(o.type === "door" ? "Door" : "Window") + " · " + ((o.lv || 0) + 1) + "F"}<br /><small>{o.style || (o.type === "door" ? "panel" : "casement")}, {fmtLen(o.pos * oL - o.width / 2, unit)} from wall start</small></td>
                      <td>{fmtLen(o.width, unit)} × {fmtLen(o.h, unit)}</td>
                    </tr>
                  );
                })}
              </tbody></table>
              <h4 style={{ marginTop: 18 }}>Walls</h4>
              {!D.walls.length && <p className="b3d-note">No walls yet.</p>}
              <table className="b3d-table"><tbody>
                {D.walls.map((w) => (
                  <tr key={w.id} className={selWall && selWall.id === w.id ? "on" : ""} onClick={() => selectAt({ kind: "wall", id: w.id }, w.lv || 0)}>
                    <td>{"Wall · " + ((w.lv || 0) + 1) + "F"}<br /><small>thickness {fmtLen(w.t, unit)}, height {fmtLen(w.h || storeyH(D), unit)}</small></td>
                    <td>{fmtLen(wallLen(w), unit)}</td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/* ================================================================== */
/* Styles                                                              */
/* ================================================================== */
/* Virtual movement stick for touch screens: pointer-captured, multitouch-safe (the look pointer lives on the canvas), cancel-safe. */
function Joystick({ onChange, label }) {
  const base = useRef(null), id = useRef(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const upd = (e) => {
    const r = base.current.getBoundingClientRect(), R = r.width / 2;
    let dx = e.clientX - (r.left + R), dy = e.clientY - (r.top + R);
    const m = Math.hypot(dx, dy);
    if (m > R) { dx *= R / m; dy *= R / m; }
    setKnob({ x: dx, y: dy }); onChange({ x: dx / R, y: dy / R });
  };
  const end = (e) => { if (id.current !== e.pointerId) return; id.current = null; setKnob({ x: 0, y: 0 }); onChange({ x: 0, y: 0 }); };
  return (
    <div ref={base} className="b3d-joy" role="application" aria-label={label}
      onPointerDown={(e) => { if (id.current !== null) return; id.current = e.pointerId; try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* optional */ } e.stopPropagation(); upd(e); }}
      onPointerMove={(e) => { if (id.current === e.pointerId) upd(e); }}
      onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
      <div className="b3d-joyk" style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }} />
    </div>
  );
}

const CSS = `
.b3d{--blue:#2d6cdf;--blue-soft:#e8f0fe;--ink:#1f2937;--mute:#6b7280;--line:#e5e7eb;position:relative;display:flex;flex-direction:column;height:100vh;height:100dvh;min-height:320px;padding:0 env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);-webkit-tap-highlight-color:transparent;-webkit-touch-callout:none;overscroll-behavior:none;user-select:none;-webkit-user-select:none;background:#f3f4f6;color:var(--ink);font:13px/1.35 "Inter","Segoe UI",system-ui,-apple-system,sans-serif;overflow:hidden}
.b3d *{box-sizing:border-box}
.b3d button{font:inherit;color:inherit;cursor:pointer;background:none;border:0;padding:0}
.b3d button:disabled{opacity:.35;cursor:default}
.b3d button:focus-visible,.b3d input:focus-visible,.b3d select:focus-visible{outline:2px solid var(--blue);outline-offset:1px}
.b3d-grow{flex:1}
.b3d-top{min-height:48px;height:auto;flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;padding:4px 10px;background:#fff;border-bottom:1px solid var(--line);position:relative;z-index:5}
.b3d-logo{font-weight:700;font-size:15px;padding:0 8px;color:var(--blue)}
.b3d-sep{width:1px;height:22px;background:var(--line);margin:0 6px}
.b3d-tb{display:flex;flex:none;flex-direction:column;align-items:center;gap:1px;min-width:40px;padding:4px 9px;border-radius:6px;font-size:11px;color:#374151;white-space:nowrap}
.b3d-save-share{color:var(--blue)}
.b3d-tb:hover:not(:disabled){background:#f3f4f6}
.b3d-actions{display:flex;align-items:center;gap:3px;padding:3px;background:#f8fafc;border:1px solid var(--line);border-radius:10px}
.b3d-actions .b3d-tb{min-width:48px;min-height:40px;padding:5px 9px;gap:3px;border-radius:7px}
.b3d-actions .b3d-save-share{background:var(--blue-soft);font-weight:700}
.b3d-history{display:flex;align-items:center;gap:2px;padding-left:3px;border-left:1px solid #dfe3e8}
.b3d-actions .b3d-clear{margin-left:2px;border-left:1px solid #dfe3e8;border-radius:0 7px 7px 0}
.b3d-menu{position:relative}
.b3d-drop{position:absolute;top:44px;left:0;min-width:210px;background:#fff;border:1px solid var(--line);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.12);padding:4px;z-index:10}
.b3d-drop button{display:block;width:100%;text-align:left;padding:8px 10px;border-radius:5px}
.b3d-drop button:hover{background:#f3f4f6}
.b3d-modes{display:flex;background:#f3f4f6;border-radius:8px;padding:3px}
.b3d-modes button{padding:6px 16px;border-radius:6px;font-weight:600;color:#4b5563}
.b3d-modes button.on{background:#fff;color:var(--blue);box-shadow:0 1px 3px rgba(0,0,0,.12)}
.b3d-live{display:flex;align-items:center;gap:8px;padding:5px 10px 5px 12px;border-radius:999px;background:#e8f0fe;color:var(--blue);font-weight:600}
.b3d-live i{width:30px;height:16px;border-radius:999px;background:#c7d2e5;position:relative;transition:background .15s}
.b3d-live i:after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;transition:transform .15s}
.b3d-live.on i{background:var(--blue)}
.b3d-live.on i:after{transform:translateX(14px)}
.b3d-msg{position:absolute;right:14px;top:56px;background:#111827;color:#fff;padding:5px 12px;border-radius:6px;font-size:12px;z-index:20}
.b3d-main{flex:1;display:flex;min-height:0}
.b3d-left{width:272px;flex:none;background:#fff;border-right:1px solid var(--line);display:flex;min-height:0}
.b3d-lib{flex:1;display:flex;flex-direction:column;min-height:0;padding:10px 10px 0}
.b3d-scroll{overflow:auto;padding-bottom:16px}
.b3d-lib-h{display:flex;align-items:center;justify-content:space-between;padding:2px 2px 10px;font-size:14px}
.b3d-ex-hint{font-size:11px;color:var(--mute);font-weight:400}
.b3d-ex-tabs{position:sticky;top:0;z-index:2;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));background:#fff;padding:6px 0 10px}
.b3d-ex-tabs button{min-height:38px;padding:7px 5px;border-radius:8px}
.b3d-ex-note{margin:2px 0 10px;font-size:12px;line-height:1.45}
.b3d-ex-color{padding-bottom:6px;border-bottom:1px solid var(--line)}
.b3d-color-pick{display:flex;align-items:center;justify-content:space-between;min-height:40px;color:#4b5563}
.b3d-color-pick input{width:48px;height:34px;padding:2px;border:1px solid var(--line);border-radius:7px;background:#fff}
.b3d-ex-features{padding:4px 0 16px}
.b3d-ex-features .b3d-chk{align-items:center;min-height:44px;border-bottom:1px solid #f1f2f4}
.b3d-ex-features .b3d-chk input{width:20px;height:20px}
.b3d-ex-views{position:absolute;left:50%;top:12px;transform:translateX(-50%);z-index:4;display:flex;gap:4px;max-width:calc(100% - 20px);padding:4px;background:rgba(255,255,255,.95);border:1px solid rgba(229,231,235,.95);border-radius:11px;box-shadow:0 2px 10px rgba(0,0,0,.1);overflow-x:auto;scrollbar-width:none;touch-action:pan-x}
.b3d-ex-views::-webkit-scrollbar{display:none}
.b3d-ex-views button{min-height:36px;padding:0 12px;border-radius:8px;color:#4b5563;font-weight:600;white-space:nowrap}
.b3d-ex-views button:hover,.b3d-ex-views button:focus-visible{background:var(--blue-soft);color:var(--blue)}
.b3d-ex-views button.on{background:var(--blue);color:#fff}
.b3d-int-view-label{align-self:center;padding:0 7px;color:#6b7280;font-size:11px;font-weight:600;white-space:nowrap}
.b3d-x{padding:4px;border-radius:5px;color:var(--mute)}
.b3d-x:hover{background:#f3f4f6}
.b3d-search{display:flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:7px;padding:0 9px;height:34px;color:var(--mute);background:#f9fafb}
.b3d-search input{flex:1;border:0;background:none;font:inherit;color:var(--ink);outline:none;min-width:0}
.b3d-cats{display:flex;flex-wrap:wrap;gap:4px;padding:10px 0}
.b3d-cats button{padding:4px 9px;border-radius:999px;border:1px solid var(--line);font-size:12px;color:#4b5563}
.b3d-cats button.on{background:var(--blue);border-color:var(--blue);color:#fff}
.b3d-h5{margin:12px 0 0;font-size:12px;color:var(--mute);font-weight:600}
.b3d .b3d-chk{display:grid;grid-template-columns:18px minmax(0,1fr);justify-content:initial;align-items:start;gap:8px;width:100%;padding:5px 0;text-align:left;line-height:1.4}
.b3d .b3d-chk input{width:16px;height:16px;margin:2px 0 0;justify-self:start}
.b3d .b3d-chk span{min-width:0;text-align:left}
.b3d-grid{flex:1;overflow:auto;display:grid;grid-template-columns:1fr 1fr;gap:8px;align-content:start;padding:2px 0 12px}
.b3d-card{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:6px;border:1px solid var(--line);border-radius:8px;text-align:left;background:#fff}
.b3d-card:hover{border-color:#b7c9ee;background:#fafcff}
.b3d-card.on{border-color:var(--blue);box-shadow:0 0 0 1px var(--blue)}
.b3d-card span{font-weight:600;font-size:12px}
.b3d-card small{color:var(--mute);font-size:11px}
.b3d-thumb{width:100%;aspect-ratio:1;background:#f3f4f6;border-radius:6px;overflow:hidden;display:grid;place-items:center}
.b3d-thumb img{width:100%;height:100%;object-fit:contain}
.b3d-thumb-fallback{padding:6px;color:var(--mute);font-size:10px;text-align:center}
.b3d-thumb.sm{width:44px;height:44px;flex:none}
.b3d-empty{grid-column:1/-1;color:var(--mute);padding:12px 4px}
.b3d-view{position:relative;flex:1;min-width:0;background:#f1f3f6}
.b3d-canvas{position:absolute;inset:0}
.b3d-plan{position:absolute;inset:0;background:#fff}
.b3d-plansvg{position:absolute;inset:0;width:100%;height:100%;touch-action:none;user-select:none}
.b3d-ptools{position:absolute;left:50%;top:12px;transform:translateX(-50%);display:flex;align-items:center;gap:2px;background:#fff;border:1px solid var(--line);border-radius:10px;padding:4px;box-shadow:0 2px 10px rgba(0,0,0,.08)}
.b3d-ptools button{display:flex;flex-direction:column;align-items:center;gap:1px;padding:5px 11px;border-radius:7px;font-size:11px;color:#4b5563}
.b3d-ptools button:hover{background:#f3f4f6}
.b3d-ptools button.on{background:var(--blue);color:#fff}
.b3d-phint{position:absolute;left:50%;top:70px;transform:translateX(-50%);background:rgba(17,24,39,.85);color:#fff;padding:5px 12px;border-radius:6px;font-size:12px;pointer-events:none;max-width:90%;text-align:center}
.b3d-select{height:30px;border:1px solid var(--line);border-radius:6px;padding:0 8px;background:#fff;font:inherit;color:var(--ink)}
.b3d-float{position:absolute;z-index:4;transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:flex-start}
.b3d-chip{display:flex;align-items:center;gap:3px;background:#2b2d33;color:#fff;font-size:12px;padding:3px 9px;border-radius:5px 5px 0 0}
.b3d-bar{display:flex;background:#2b2d33;border-radius:0 6px 6px 6px;padding:3px;gap:1px}
.b3d-bar button{width:32px;height:30px;display:grid;place-items:center;border-radius:5px;color:#e5e7eb}
.b3d-bar button:hover{background:#444851}
.b3d-bar button.on{background:var(--blue);color:#fff}
.b3d-modalbg{position:fixed;inset:0;background:rgba(15,20,30,.38);z-index:50;display:flex;align-items:center;justify-content:center;padding:12px}
.b3d-modal{background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.25);padding:16px;width:min(520px,100%);max-width:100%;max-height:90vh;overflow:auto;text-align:left}
.b3d-opt{display:grid;grid-template-columns:18px minmax(0,1fr);gap:10px;align-items:start;margin:8px 0;padding:10px;border:1px solid var(--line);border-radius:8px;cursor:pointer;font-size:13px;line-height:1.45}
.b3d-opt input{width:16px;height:16px;margin:3px 0 0}
.b3d-opt span{display:block;min-width:0;text-align:left;overflow-wrap:anywhere}
.b3d-pop{position:absolute;top:100%;left:0;margin-top:6px;width:210px;background:#fff;border:1px solid var(--line);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.14);padding:10px}
.b3d-pop p{margin:0 0 7px;font-weight:600}
.b3d-sw{display:grid;grid-template-columns:repeat(5,1fr);gap:7px;padding:6px 0}
.b3d-sw button{aspect-ratio:1;border-radius:50%;border:1px solid rgba(0,0,0,.18)}
.b3d-sw button.on{outline:2px solid var(--blue);outline-offset:2px}
.b3d-link{margin-top:9px;color:var(--blue);font-size:12px}
.b3d-ctx{position:absolute;z-index:6;min-width:190px;background:#fff;border:1px solid var(--line);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.16);padding:4px}
.b3d-ctx button{display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:8px 10px;border-radius:5px}
.b3d-ctx button:hover{background:#f3f4f6}
.b3d-bottom{position:absolute;left:12px;right:12px;bottom:12px;display:flex;align-items:center;gap:8px;pointer-events:none;z-index:3}
.b3d-bottom>*{pointer-events:auto}
.b3d-pill{display:flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:7px;background:#fff;border:1px solid var(--line);font-weight:600}
.b3d-btn:hover{border-color:#b7c9ee}
.b3d-seg{display:flex;background:#fff;border:1px solid var(--line);border-radius:7px;padding:2px}
.b3d-seg button{height:26px;padding:0 11px;border-radius:5px;font-weight:600;color:#4b5563}
.b3d-seg button.on{background:var(--blue);color:#fff}
.b3d-icon{width:32px;height:32px;display:grid;place-items:center;border-radius:7px;background:#fff;border:1px solid var(--line)}
.b3d-icon:hover{border-color:#b7c9ee}
.b3d-zoom{min-width:34px;text-align:center;font-variant-numeric:tabular-nums;color:#4b5563}
.b3d-hint{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:#fff;border:1px solid var(--line);padding:10px 16px;border-radius:8px;color:var(--mute);pointer-events:none}
.b3d-right{width:292px;flex:none;background:#fff;border-left:1px solid var(--line);display:flex;flex-direction:column;min-height:0;overflow:auto}
.b3d-tabs{display:flex;flex:none;border-bottom:1px solid var(--line);position:sticky;top:0;background:#fff;z-index:1}
.b3d-tabs button{flex:1;padding:11px 0;color:var(--mute);font-weight:600;border-bottom:2px solid transparent}
.b3d-tabs button.on{color:var(--blue);border-bottom-color:var(--blue)}
.b3d-props{padding:12px 14px 20px}
.b3d-props h4{margin:0 0 8px;font-size:14px}
.b3d-props h5{margin:14px 0 4px;font-size:12px;color:var(--mute);font-weight:600}
.b3d-ph{display:flex;gap:10px;align-items:center;padding-bottom:12px;margin-bottom:6px;border-bottom:1px solid var(--line)}
.b3d-ph strong{display:block;font-size:13px}
.b3d-ph small{color:var(--mute)}
.b3d-field{display:flex;flex-direction:column;gap:3px;margin:8px 0;color:#4b5563}
.b3d-field input{height:30px;border:1px solid var(--line);border-radius:6px;padding:0 8px;font:inherit;color:var(--ink)}
.b3d-row{display:grid;grid-template-columns:1fr auto;gap:2px 8px;align-items:center;padding:5px 0}
.b3d-row label{grid-column:1/-1;color:#4b5563}
.b3d-row input[type=range]{width:100%;accent-color:var(--blue);margin:0}
.b3d-num{display:flex;align-items:center;justify-content:flex-end;gap:4px;width:112px;min-width:112px;border:1px solid var(--line);border-radius:6px;padding:0 6px;height:26px;background:#fff}
.b3d-num input{flex:1;min-width:0;width:0;border:0;padding:0;font:inherit;text-align:right;outline:none;background:none;color:var(--ink);font-variant-numeric:tabular-nums}
.b3d-num span{color:var(--mute);font-size:11px}
.b3d-scale{display:flex;align-items:center;justify-content:space-between;padding:6px 0}
.b3d-scale label{display:flex;gap:6px;align-items:center;color:#4b5563}
.b3d-scale button,.b3d-btns button{border:1px solid var(--line);border-radius:6px;padding:6px 12px}
.b3d-btns>a{display:flex;align-items:center;gap:6px;padding:6px 12px;border:1px solid var(--line);border-radius:6px;color:var(--blue);white-space:nowrap}
.b3d-scale button:hover,.b3d-btns button:hover{border-color:var(--blue);color:var(--blue)}
.b3d-btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:14px}
.b3d-btns{justify-content:flex-end}
.b3d-btns .b3d-primary{display:flex;align-items:center;gap:6px;background:var(--blue);border-color:var(--blue);color:#fff}
.b3d-btns .b3d-primary:hover{color:#fff;opacity:.92}
.b3d-dl{display:grid;grid-template-columns:1fr auto;gap:6px 10px;margin:6px 0}
.b3d-dl dt{color:var(--mute)}
.b3d-dl dd{margin:0;font-weight:600;text-align:right}
.b3d-note{color:var(--mute);margin:14px 0 0}
.b3d-table{width:100%;border-collapse:collapse}
.b3d-table td{padding:8px 4px;border-bottom:1px solid var(--line);vertical-align:top}
.b3d-table td:last-child{text-align:right;color:var(--mute);font-variant-numeric:tabular-nums}
.b3d-table small{color:var(--mute)}
.b3d-table tr{cursor:pointer}
.b3d-table tr:hover,.b3d-table tr.on{background:var(--blue-soft)}
.b3d input,.b3d select{user-select:text;-webkit-user-select:text}
.b3d-main{position:relative}
.b3d-ptools{max-width:calc(100% - 16px);flex-wrap:wrap;justify-content:center;z-index:5}
.b3d-phint{top:100px;z-index:1}
.b3d-phint button{pointer-events:auto}
.b3d-pact{position:absolute;left:50%;bottom:58px;transform:translateX(-50%);display:flex;gap:8px;z-index:4}
.b3d-pact button{display:flex;align-items:center;gap:6px;height:38px;padding:0 16px;border-radius:999px;background:#fff;border:1px solid var(--line);font-weight:600;box-shadow:0 2px 10px rgba(0,0,0,.12)}
.b3d-pact .b3d-primary{background:var(--blue);border-color:var(--blue);color:#fff}
.b3d-wp{position:absolute;right:12px;top:110px;width:min(320px,calc(100% - 24px));max-height:calc(100% - 190px);overflow:auto;-webkit-overflow-scrolling:touch;background:#fff;border:1px solid var(--line);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.2);padding:10px 12px;z-index:6;font-size:13px}
.b3d-wp-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.b3d-wp-r{display:grid;grid-template-columns:1fr 92px 54px;gap:8px;align-items:center;min-height:34px}
.b3d-wp-r em{font-style:normal;text-align:right;color:#4b5563}
.b3d-wp-c{display:flex;gap:8px;align-items:center;min-height:34px}
.b3d-wp-c input{width:20px;height:20px}
.b3d-joy{position:absolute;left:18px;bottom:78px;width:calc(120px * var(--ts,1));height:calc(120px * var(--ts,1));border-radius:50%;background:rgba(255,255,255,.55);border:2px solid rgba(255,255,255,.9);box-shadow:0 2px 10px rgba(0,0,0,.25);touch-action:none;z-index:4;display:flex;align-items:center;justify-content:center}
.b3d-joyk{width:46%;height:46%;border-radius:50%;background:var(--blue);opacity:.9;pointer-events:none}
.b3d-touch.r .b3d-joy{left:auto;right:18px}
.b3d-tbtns{position:absolute;right:14px;bottom:78px;display:grid;grid-template-columns:repeat(2,calc(56px * var(--ts,1)));gap:8px;z-index:4}
.b3d-touch.r .b3d-tbtns{right:auto;left:14px}
.b3d-tb{min-height:calc(48px * var(--ts,1));border-radius:24px;background:rgba(255,255,255,.94);border:1px solid var(--line);font-size:13px;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,.18);touch-action:manipulation}
.b3d-tb.on{background:var(--blue);color:#fff}
.b3d-dpad{position:absolute;right:14px;bottom:70px;display:grid;grid-template-columns:repeat(3,52px);grid-template-rows:repeat(2,52px);gap:6px;z-index:4}
.b3d-dpad button{border-radius:50%;background:rgba(255,255,255,.92);border:1px solid var(--line);font-size:18px;box-shadow:0 2px 8px rgba(0,0,0,.15);touch-action:none}
.b3d-dpad button:active{background:var(--blue);color:#fff}
.b3d-dp-u{grid-column:2;grid-row:1}.b3d-dp-l{grid-column:1;grid-row:2}.b3d-dp-d{grid-column:2;grid-row:2}.b3d-dp-r{grid-column:3;grid-row:2}
.b3d-dclose,.b3d-backdrop{display:none}
.b3d-lg .b3d-left{width:230px}.b3d-lg .b3d-right{width:260px}
.b3d-compact .b3d-left,.b3d-compact .b3d-right{position:absolute;top:0;bottom:0;z-index:12;box-shadow:0 0 30px rgba(0,0,0,.25);transition:transform .2s ease}
.b3d-compact .b3d-left{left:0;width:min(88%,330px);transform:translateX(-105%)}
.b3d-compact .b3d-right{right:0;width:min(88%,340px);transform:translateX(105%)}
.b3d-compact .b3d-left.open,.b3d-compact .b3d-right.open{transform:none}
.b3d-compact .b3d-left:not(.open),.b3d-compact .b3d-right:not(.open){visibility:hidden;transition:transform .2s ease,visibility 0s .2s}
.b3d-compact .b3d-left.open,.b3d-compact .b3d-right.open{visibility:visible;transition:transform .2s ease}
.b3d-compact .b3d-backdrop{display:block;position:absolute;inset:0;background:rgba(15,23,42,.35);z-index:11}
.b3d-compact .b3d-dclose{display:grid;position:absolute;right:8px;top:8px;z-index:3;width:34px;height:34px;place-items:center;border-radius:8px;background:#f3f4f6}
.b3d-compact .b3d-lib{padding-top:46px}
.b3d-compact .b3d-tabs{padding-right:46px}
.b3d-sm .b3d-left,.b3d-sm .b3d-right{top:auto;left:0;right:0;width:100%;height:58%;border-radius:16px 16px 0 0;border:0;transform:translateY(105%)}
.b3d-sm .b3d-left.open,.b3d-sm .b3d-right.open{transform:none}
.b3d-sm .b3d-grid{grid-template-columns:repeat(3,1fr)}
.b3d-sm .b3d-hide-sm{display:none}
.b3d-sm .b3d-top{height:auto;min-height:78px;flex-wrap:wrap;align-content:center;justify-content:space-between;gap:4px;padding:5px 8px}
.b3d-sm .b3d-top>.b3d-grow{display:none}
.b3d-sm .b3d-actions{gap:2px;padding:2px}
.b3d-sm .b3d-actions .b3d-tb{min-width:40px;min-height:40px;padding:6px 8px}
.b3d-sm .b3d-history{padding-left:2px}
.b3d-sm .b3d-actions .b3d-clear{display:none}
.b3d-sm .b3d-modes{order:5;flex:1 0 100%;justify-content:center}
.b3d-sm .b3d-tb span{display:none}
.b3d-sm .b3d-tb{padding:6px 8px}
.b3d-sm .b3d-modes button{flex:1;max-width:140px;padding:6px 9px;font-size:12px}
.b3d-sm .b3d-ex-views{top:8px;max-width:calc(100% - 16px)}
.b3d-sm .b3d-ex-views button{min-height:42px;padding:0 14px}
.b3d-sm .b3d-ex-tabs button{min-height:44px;font-size:13px}
.b3d-sm .b3d-color-pick{min-height:48px}
.b3d-sm .b3d-color-pick input{width:54px;height:40px}
.b3d-sm .b3d-ex-features .b3d-chk{min-height:48px}
.b3d-sm .b3d-ptools button span{display:none}
.b3d-sm .b3d-bottom{left:6px;right:6px;bottom:max(6px,env(safe-area-inset-bottom));gap:5px;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;padding:4px;background:rgba(255,255,255,.94);border:1px solid rgba(229,231,235,.9);border-radius:10px;scrollbar-width:thin;touch-action:pan-x}
.b3d-sm .b3d-bottom>.b3d-grow{display:none}
.b3d-sm .b3d-bottom>*{flex:none}
.b3d-sm .b3d-bottom .b3d-seg button{padding:0 8px;white-space:nowrap}
.b3d-sm .b3d-zoom{display:none}
.b3d-sm .b3d-pill{padding:0 9px}
.b3d-sm .b3d-phint{top:auto;bottom:100px;font-size:11px}
.b3d-sm .b3d-pact{bottom:100px}
.b3d-sm .b3d-scale-bar{bottom:98px}
.b3d-sm .b3d-dpad{bottom:104px}
.b3d-sm .b3d-msg{top:52px;right:8px}
.b3d-sm,.b3d-sm .b3d-props,.b3d-sm .b3d-card span{font-size:14px}
.b3d-coarse input,.b3d-coarse select,.b3d-sm input,.b3d-sm select{font-size:16px}
.b3d-coarse .b3d-bar button{width:42px;height:40px}
.b3d-coarse .b3d-icon{width:40px;height:40px}
.b3d-coarse .b3d-pill{height:40px}
.b3d-coarse .b3d-seg button{height:34px;padding:0 14px}
.b3d-coarse .b3d-ptools button{padding:7px 12px}
.b3d-coarse .b3d-cats button{padding:8px 13px}
.b3d-coarse .b3d-tabs button{padding:14px 0}
.b3d-sm .b3d-tabs{overflow-x:auto;scrollbar-width:none}
.b3d-sm .b3d-tabs::-webkit-scrollbar{display:none}
.b3d-sm .b3d-tabs button{flex:0 0 auto;padding-inline:11px;white-space:nowrap}
.b3d-coarse .b3d-row input[type=range]{height:30px}
.b3d-coarse .b3d-num{height:36px}
.b3d-coarse .b3d-num{width:112px;min-width:112px}
.b3d-coarse .b3d-ctx button,.b3d-coarse .b3d-drop button{padding:13px 14px}
.b3d-coarse .b3d-scale button,.b3d-coarse .b3d-btns button{padding:10px 14px}
.b3d-coarse .b3d-sw{gap:10px}
.b3d-share-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.b3d-share-phone{width:100%;min-height:38px;border:1px solid var(--line);border-radius:6px;padding:0 10px;background:#fff;color:var(--ink);font:inherit}
.b3d-share-includes{margin:10px 0;color:#4b5563;font-size:12px;line-height:1.5}
.b3d-share-error{margin:12px 0 0;padding:9px 10px;border:1px solid #fecaca;border-radius:7px;background:#fef2f2;color:#b91c1c;font-size:12px;line-height:1.45}
.b3d-share-modal .b3d-btns{position:sticky;bottom:-16px;padding:10px 0 0;background:#fff}
@media (orientation:landscape) and (max-height:520px){
  .b3d-sm .b3d-left,.b3d-sm .b3d-right{height:78%;max-height:calc(100% - 12px)}
  .b3d-sm .b3d-bottom{bottom:4px}
  .b3d-sm .b3d-ex-views{top:5px}
  .b3d-sm .b3d-ex-views button{min-height:38px;padding:0 10px}
  .b3d-sm .b3d-dpad{bottom:62px}
  .b3d-sm .b3d-phint{bottom:64px}
  .b3d-sm .b3d-pact{bottom:64px}
}
@media (prefers-reduced-motion:reduce){.b3d *{transition:none!important}}
.b3d-setpop{left:50%;transform:translateX(-50%);width:272px;max-width:calc(100vw - 24px);max-height:70vh;overflow:auto;z-index:8;text-align:left}
.b3d-setpop .b3d-field{margin:6px 0}
.b3d-setpop select,.b3d-select{width:100%}
.b3d-lenfield{display:grid;grid-template-columns:1fr auto;align-items:center;gap:8px}
.b3d-lenfield>span{color:#4b5563}
.b3d-lenfield .b3d-num{width:116px;min-width:116px}
.b3d-align button{padding:5px 9px;font-size:12px}
.b3d-ex-rows{margin-top:6px}
.b3d-bar-sel{border-radius:6px;align-items:center}
.b3d-bar-label{color:#e5e7eb;font-size:12px;font-weight:600;padding:0 9px}
.b3d-tip{position:absolute;z-index:6;pointer-events:none;max-width:260px;padding:5px 9px;border-radius:6px;background:rgba(31,41,55,.92);color:#fff;font-size:12px;line-height:1.3;box-shadow:0 2px 8px rgba(0,0,0,.25);white-space:nowrap}
.b3d-mini{position:absolute;left:12px;top:12px;z-index:4;background:rgba(255,255,255,.92);border:1px solid var(--line);border-radius:10px;padding:5px;box-shadow:0 2px 10px rgba(0,0,0,.14);display:flex;flex-direction:column;align-items:center;gap:2px;touch-action:none}
.b3d-mini svg{display:block;border-radius:6px;background:#f6f7f9;cursor:crosshair}
.b3d-mini span{font-size:11px;color:var(--mute);font-weight:600}
.b3d-fade{position:absolute;inset:0;background:#000;opacity:0;pointer-events:none;transition:opacity .35s ease;z-index:7}
.b3d-fade.on{opacity:1}
.b3d-tourlabel{position:absolute;left:50%;bottom:92px;transform:translateX(-50%);z-index:8;padding:8px 18px;border-radius:999px;background:rgba(20,24,33,.78);color:#fff;font-weight:600;letter-spacing:.2px;pointer-events:none}
.b3d-costh{display:flex;justify-content:space-between;align-items:baseline;margin:16px 0 2px!important;color:var(--ink)!important;font-size:13px!important;border-bottom:2px solid var(--line);padding-bottom:3px}
.b3d-costh b{font-variant-numeric:tabular-nums}
.b3d-costtbl td:first-child{line-height:1.5}
.b3d-rate{width:78px;height:24px;margin-left:4px;border:1px solid var(--line);border-radius:5px;padding:0 6px;font:inherit;font-size:12px;color:var(--ink);text-align:right;background:#fff;user-select:text}
.b3d-rate-reset{margin-left:4px;color:var(--blue);font-size:14px;line-height:1;padding:2px 4px;border-radius:4px}
.b3d-rate-reset:hover{background:var(--blue-soft)}
.b3d-cost-set{display:grid;gap:4px;margin-bottom:4px}
.b3d-pcts{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.b3d-pcts .b3d-field{margin:2px 0}
.b3d-pcts .b3d-num{width:100%;min-width:0}
.b3d-totals td{border-bottom:0;padding:5px 4px}
.b3d-totals tr:last-child td{border-top:2px solid var(--line);font-size:14px}
.b3d-sm .b3d-mini{top:auto;bottom:112px}
.b3d-sm .b3d-tourlabel{bottom:150px}
.b3d-sm .b3d-setpop{position:fixed;left:8px;right:8px;top:auto;bottom:12px;width:auto;transform:none;max-height:60vh}
.b3d-coarse .b3d-rate{height:34px}
@media (prefers-reduced-motion:reduce){.b3d-fade{transition:none}}
`;


/* ================================================================== */
/* Error boundary + public component                                   */
/* ================================================================== */
class Builder3DBoundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (this.state.err) {
      return (
        <div style={{ height: "100vh", display: "grid", placeItems: "center", font: "14px system-ui, sans-serif", color: "#1f2937", ...(this.props.style || {}) }}>
          <div style={{ maxWidth: 420, textAlign: "center" }}>
            <h3 style={{ margin: "0 0 8px" }}>The 3D builder hit a problem</h3>
            <p style={{ margin: "0 0 14px", color: "#6b7280" }}>{String((this.state.err && this.state.err.message) || this.state.err)}</p>
            <button onClick={() => this.setState({ err: null })} style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid #2d6cdf", background: "#2d6cdf", color: "#fff", cursor: "pointer" }}>Try again</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function Builder3D(props) {
  return (
    <Builder3DBoundary style={props.style}>
      <Builder3DInner {...props} />
    </Builder3DBoundary>
  );
}
