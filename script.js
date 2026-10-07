"use strict";

// =============================================================
// DOM
// =============================================================

const canvas = document.getElementById("particleCanvas");
const ctx = canvas.getContext("2d", { alpha: true });
const reefShark = document.getElementById("reefShark");
const sharkMotion = document.getElementById("sharkMotion");
const sharkVideo = document.getElementById("sharkVideo");
const worldBackground = document.getElementById("worldBackground");
const animalLayer = document.getElementById("animalLayer");
const modeButtons = [...document.querySelectorAll(".mode-option")];
const miniMapCanvas = document.getElementById("miniMapCanvas");
const miniMapCtx = miniMapCanvas.getContext("2d");

const mantaRay = document.getElementById("mantaRay");
const whaleSharkAnimal = document.getElementById("whaleSharkAnimal");
const cuttlefish = document.getElementById("cuttlefish");
const narwhal = document.getElementById("narwhal");


// =============================================================
// DESIGN IDEA
// =============================================================
//
// This is intentionally NOT a conventional loose-boids simulation.
// The school behaves more like a deformable moving sheet:
//
//   1. A slow flow field moves the school as a whole.
//   2. Nearby fish strongly align their velocity.
//   3. Temporary neighbour-to-neighbour springs preserve spacing.
//   4. A density-pressure field repairs holes without sending fish
//      back to fixed "home" coordinates.
//   5. The shark is a moving elliptical obstacle with a wide
//      anticipation zone. Fish peel sideways around it instead of
//      exploding radially away from its centre.
//   6. A hard body boundary guarantees no fish can overlap the shark.
//
// There are no homeX/homeY values anywhere in the system.
// Recovery means "restore local structure", not "return to old place".

// =============================================================
// CANVAS / VIEWPORT
// =============================================================

let viewWidth = window.innerWidth;
let viewHeight = window.innerHeight;
let dpr = 1;

function resizeCanvas() {
  viewWidth = window.innerWidth;
  viewHeight = window.innerHeight;

  // A capped DPR keeps tens of thousands of marks affordable while
  // remaining crisp on common high-density displays.
  dpr = Math.min(window.devicePixelRatio || 1, 1.25);

  canvas.width = Math.round(viewWidth * dpr);
  canvas.height = Math.round(viewHeight * dpr);
  canvas.style.width = `${viewWidth}px`;
  canvas.style.height = `${viewHeight}px`;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// =============================================================
// MATH HELPERS
// =============================================================

const TAU = Math.PI * 2;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function length2D(x, y) {
  return Math.sqrt(x * x + y * y);
}

function wrapAngle(angle) {
  while (angle > Math.PI) angle -= TAU;
  while (angle < -Math.PI) angle += TAU;
  return angle;
}

function smoothstep01(t) {
  t = clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
}

function wrapValue(value, min, max) {
  const size = max - min;
  while (value < min) value += size;
  while (value >= max) value -= size;
  return value;
}

function wrappedDelta(delta, size) {
  if (delta > size * 0.5) delta -= size;
  if (delta < -size * 0.5) delta += size;
  return delta;
}


// =============================================================
// FIXED WORLD
// =============================================================

const VIEWPORT_REFERENCE_WIDTH = 1920;
const VIEWPORT_REFERENCE_HEIGHT = 1080;

const WORLD_COLS = 4;
const WORLD_ROWS = 4;
const WORLD_WIDTH = 7680;
const WORLD_HEIGHT = 4320;

const HERO_START_X = 3840;
const HERO_START_Y = 2160;

// Locked biological display scale: 125 px = 1 metre.
//
// Each animal keeps the previously locked anchor coordinate, but now has its
// own locomotion character. `heading` is a world-space forward direction in
// radians. `nativeForwardAngle` describes how the artwork points before CSS
// rotation, so motion can turn naturally without changing the source video.
const WORLD_ANIMALS = [
  {
    id: "manta",
    element: mantaRay,
    anchorX: 2100,
    anchorY: 900,
    displayAxis: "width",
    displaySize: 650,               // 5.2 m wingspan
    nativeForwardAngle: -Math.PI / 2,
    bodyHalfLength: 225,            // nose-to-tail collision footprint
    bodyHalfWidth: 325,             // wingtip-to-wingtip footprint
    playbackRate: 0.86,
    currentX: 2100,
    currentY: 900,
    prevX: 2100,
    prevY: 900,
    vx: 0,
    vy: 0,
    heading: -Math.PI / 2,
    phase: 0.35,
    visible: null
  },
  {
    id: "whaleshark",
    element: whaleSharkAnimal,
    anchorX: 5450,
    anchorY: 1650,
    displayAxis: "height",
    displaySize: 1715,              // 45 ft ≈ 13.716 m
    nativeForwardAngle: -Math.PI / 2,
    bodyHalfLength: 858,
    bodyHalfWidth: 430,
    playbackRate: 0.66,
    currentX: 5450,
    currentY: 1650,
    prevX: 5450,
    prevY: 1650,
    vx: 0,
    vy: 0,
    heading: -Math.PI / 2,
    phase: 1.7,
    visible: null
  },
  {
    id: "cuttlefish",
    element: cuttlefish,
    anchorX: 1450,
    anchorY: 3350,
    displayAxis: "width",
    displaySize: 63,                // 0.5 m
    nativeForwardAngle: 0,
    bodyHalfLength: 32,
    bodyHalfWidth: 24,
    playbackRate: 0.82,
    currentX: 1450,
    currentY: 3350,
    prevX: 1450,
    prevY: 3350,
    vx: 0,
    vy: 0,
    heading: 0,
    phase: 2.4,
    visible: null
  },
  {
    id: "narwhal",
    element: narwhal,
    anchorX: 6000,
    anchorY: 3500,
    displayAxis: "height",
    displaySize: 675,               // 475 px body + 200 px tusk
    nativeForwardAngle: -Math.PI / 2,
    bodyHalfLength: 338,
    bodyHalfWidth: 105,
    playbackRate: 0.80,
    currentX: 6000,
    currentY: 3500,
    prevX: 6000,
    prevY: 3500,
    vx: 0,
    vy: 0,
    heading: -Math.PI / 2,
    phase: 3.1,
    visible: null
  }
];

function buildMirroredBackground() {
  worldBackground.innerHTML = "";

  for (let row = 0; row < WORLD_ROWS; row++) {
    for (let col = 0; col < WORLD_COLS; col++) {
      const tile = document.createElement("div");
      tile.className = "ocean-tile";
      tile.style.left = `${col * VIEWPORT_REFERENCE_WIDTH}px`;
      tile.style.top = `${row * VIEWPORT_REFERENCE_HEIGHT}px`;

      const img = document.createElement("img");
      img.src = "assets/bgtemp.png";
      img.alt = "";
      img.draggable = false;

      const sx = col % 2 === 1 ? -1 : 1;
      const sy = row % 2 === 1 ? -1 : 1;
      img.style.transform = `scale(${sx}, ${sy})`;

      tile.appendChild(img);
      worldBackground.appendChild(tile);
    }
  }
}

function sizeWorldAnimals() {
  for (const animal of WORLD_ANIMALS) {
    const el = animal.element;
    if (!el) continue;

    if (animal.displayAxis === "width") {
      el.style.width = `${animal.displaySize}px`;
      el.style.height = "auto";
    } else {
      el.style.height = `${animal.displaySize}px`;
      el.style.width = "auto";
    }
  }
}

function safePlay(video) {
  if (!video || !video.paused) return;
  video.play().catch(() => {});
}

function prepareWorldAnimalVideos() {
  for (const animal of WORLD_ANIMALS) {
    const video = animal.element;
    if (!video) continue;

    const applyRate = () => {
      video.playbackRate = animal.playbackRate;
      safePlay(video);
    };

    video.addEventListener("loadedmetadata", applyRate, { once: true });
    if (video.readyState >= 1) applyRate();
  }
}

function smoothHeading(current, target, maxTurn) {
  const error = wrapAngle(target - current);
  return current + clamp(error, -maxTurn, maxTurn);
}

function updateWorldAnimals(dt, timeSeconds) {
  for (const animal of WORLD_ANIMALS) {
    let nextX = animal.anchorX;
    let nextY = animal.anchorY;
    let forcedHeading = null;

    if (animal.id === "manta") {
      // Broad, slow pelagic glide: one large looping path with a smaller
      // secondary drift so it never feels mechanically circular.
      const t = timeSeconds;
      nextX =
        animal.anchorX +
        Math.sin(t * 0.125) * 500 +
        Math.sin(t * 0.043) * 70;
      nextY =
        animal.anchorY +
        Math.sin(t * 0.105) * 300 +
        Math.sin(t * 0.031) * 42;

    } else if (animal.id === "whaleshark") {
      // Deliberately almost stationary. The WebM supplies the swimming/body
      // motion; translation is only suspended-water float and a tiny yaw.
      const t = timeSeconds;
      nextX = animal.anchorX + Math.sin(t * 0.115) * 18;
      nextY = animal.anchorY + Math.sin(t * 0.087) * 11;
      forcedHeading =
        -Math.PI / 2 + Math.sin(t * 0.055 + animal.phase) * 0.035;

    } else if (animal.id === "cuttlefish") {
      // A hovering cephalopod can wander without long straight runs. Two
      // slow frequencies create a broad, non-repeating floating territory.
      const t = timeSeconds;
      nextX =
        animal.anchorX +
        Math.sin(t * 0.105) * 250 +
        Math.sin(t * 0.037) * 55;
      nextY =
        animal.anchorY +
        Math.sin(t * 0.083) * 155 +
        Math.sin(t * 0.029) * 48;

    } else if (animal.id === "narwhal") {
      // Smooth purposeful swimming with long arcs rather than jitter or
      // point-to-point turns.
      const t = timeSeconds;
      nextX =
        animal.anchorX +
        Math.sin(t * 0.145) * 215 +
        Math.sin(t * 0.041) * 35;
      nextY =
        animal.anchorY +
        Math.sin(t * 0.118) * 135 +
        Math.sin(t * 0.054) * 24;
    }

    const safeDt = dt > 0.00001 ? dt : 1 / 60;
    animal.vx = (nextX - animal.currentX) / safeDt;
    animal.vy = (nextY - animal.currentY) / safeDt;
    animal.prevX = animal.currentX;
    animal.prevY = animal.currentY;
    animal.currentX = nextX;
    animal.currentY = nextY;

    if (forcedHeading !== null) {
      animal.heading = forcedHeading;
    } else {
      const speed = length2D(animal.vx, animal.vy);
      if (speed > 0.25) {
        const targetHeading = Math.atan2(animal.vy, animal.vx);
        const turnRate = animal.id === "cuttlefish" ? 1.0 : 0.72;
        animal.heading = smoothHeading(
          animal.heading,
          targetHeading,
          turnRate * safeDt
        );
      }
    }
  }
}

function renderWorldAnimals() {
  for (const animal of WORLD_ANIMALS) {
    const el = animal.element;
    if (!el) continue;

    const screenX = animal.currentX - cameraX;
    const screenY = animal.currentY - cameraY;
    const rotation = animal.heading - animal.nativeForwardAngle;

    el.style.left = `${screenX}px`;
    el.style.top = `${screenY}px`;
    el.style.transform =
      `translate(-50%, -50%) rotate(${rotation}rad) translateZ(0)`;

    // Keep the decoding workload small: off-screen encounter videos pause,
    // while their world motion continues numerically in the background.
    const margin = Math.max(1200, animal.displaySize * 0.75);
    const visible =
      screenX > -margin &&
      screenX < viewWidth + margin &&
      screenY > -margin &&
      screenY < viewHeight + margin;

    if (visible !== animal.visible) {
      animal.visible = visible;
      el.style.visibility = visible ? "visible" : "hidden";
      if (visible) safePlay(el);
      else el.pause();
    }
  }
}

function clampCameraToWorld() {
  const maxX = Math.max(0, WORLD_WIDTH - viewWidth);
  const maxY = Math.max(0, WORLD_HEIGHT - viewHeight);

  cameraX = clamp(cameraX, 0, maxX);
  cameraY = clamp(cameraY, 0, maxY);
}


// =============================================================
// MINI MAP V1
// =============================================================
//
// The minimap does not show the full 4×4 world at once.
// It shows a 75%-wide × 75%-high world window:
//   5760 × 3240 world pixels = exactly 3×3 reference viewports.
// That window follows the hero and clamps cleanly at world edges.
//
// Red dots = encounter creatures.
// Blue dot = hero reef shark.
// Thin rectangle = current browser camera viewport.

const MINI_MAP_WORLD_FRACTION = 0.75;
const MINI_MAP_VIEW_WIDTH = WORLD_WIDTH * MINI_MAP_WORLD_FRACTION;   // 5760
const MINI_MAP_VIEW_HEIGHT = WORLD_HEIGHT * MINI_MAP_WORLD_FRACTION; // 3240

function getMiniMapWindow() {
  let x = sharkX - MINI_MAP_VIEW_WIDTH * 0.5;
  let y = sharkY - MINI_MAP_VIEW_HEIGHT * 0.5;

  x = clamp(x, 0, WORLD_WIDTH - MINI_MAP_VIEW_WIDTH);
  y = clamp(y, 0, WORLD_HEIGHT - MINI_MAP_VIEW_HEIGHT);

  return {
    x,
    y,
    width: MINI_MAP_VIEW_WIDTH,
    height: MINI_MAP_VIEW_HEIGHT
  };
}

function drawMiniMapDot(ctx2d, x, y, radius, fill) {
  ctx2d.beginPath();
  ctx2d.arc(x, y, radius, 0, TAU);
  ctx2d.fillStyle = fill;
  ctx2d.fill();
}

function renderMiniMap() {
  if (!miniMapCanvas || !miniMapCtx) return;

  const cssWidth = miniMapCanvas.clientWidth || 320;
  const cssHeight = miniMapCanvas.clientHeight || 180;
  const mapDpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const pixelWidth = Math.max(1, Math.round(cssWidth * mapDpr));
  const pixelHeight = Math.max(1, Math.round(cssHeight * mapDpr));

  if (miniMapCanvas.width !== pixelWidth || miniMapCanvas.height !== pixelHeight) {
    miniMapCanvas.width = pixelWidth;
    miniMapCanvas.height = pixelHeight;
  }

  miniMapCtx.setTransform(mapDpr, 0, 0, mapDpr, 0, 0);
  miniMapCtx.clearRect(0, 0, cssWidth, cssHeight);

  const windowArea = getMiniMapWindow();
  const pad = 10;
  const mapX = pad;
  const mapY = pad;
  const mapW = cssWidth - pad * 2;
  const mapH = cssHeight - pad * 2;

  // Dark translucent ocean field.
  miniMapCtx.fillStyle = "rgba(0, 28, 48, 0.78)";
  miniMapCtx.fillRect(mapX, mapY, mapW, mapH);

  // Subtle 3×3 reference viewport grid inside the 75% world window.
  miniMapCtx.strokeStyle = "rgba(255, 255, 255, 0.10)";
  miniMapCtx.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    const gx = mapX + (mapW * i) / 3;
    const gy = mapY + (mapH * i) / 3;

    miniMapCtx.beginPath();
    miniMapCtx.moveTo(gx, mapY);
    miniMapCtx.lineTo(gx, mapY + mapH);
    miniMapCtx.stroke();

    miniMapCtx.beginPath();
    miniMapCtx.moveTo(mapX, gy);
    miniMapCtx.lineTo(mapX + mapW, gy);
    miniMapCtx.stroke();
  }

  const toMapX = worldX =>
    mapX + ((worldX - windowArea.x) / windowArea.width) * mapW;

  const toMapY = worldY =>
    mapY + ((worldY - windowArea.y) / windowArea.height) * mapH;

  const inside = (worldX, worldY) =>
    worldX >= windowArea.x &&
    worldX <= windowArea.x + windowArea.width &&
    worldY >= windowArea.y &&
    worldY <= windowArea.y + windowArea.height;

  // Current camera footprint.
  const cameraLeft = clamp(cameraX, windowArea.x, windowArea.x + windowArea.width);
  const cameraTop = clamp(cameraY, windowArea.y, windowArea.y + windowArea.height);
  const cameraRight = clamp(cameraX + viewWidth, windowArea.x, windowArea.x + windowArea.width);
  const cameraBottom = clamp(cameraY + viewHeight, windowArea.y, windowArea.y + windowArea.height);

  if (cameraRight > cameraLeft && cameraBottom > cameraTop) {
    miniMapCtx.strokeStyle = "rgba(255, 255, 255, 0.52)";
    miniMapCtx.lineWidth = 1.25;
    miniMapCtx.strokeRect(
      toMapX(cameraLeft),
      toMapY(cameraTop),
      Math.max(1, toMapX(cameraRight) - toMapX(cameraLeft)),
      Math.max(1, toMapY(cameraBottom) - toMapY(cameraTop))
    );
  }

  // Encounter creatures.
  for (const animal of WORLD_ANIMALS) {
    const x = animal.currentX ?? animal.anchorX;
    const y = animal.currentY ?? animal.anchorY;
    if (!inside(x, y)) continue;

    drawMiniMapDot(
      miniMapCtx,
      toMapX(x),
      toMapY(y),
      4.2,
      "#ff4b45"
    );
  }

  // Hero reef shark.
  if (inside(sharkX, sharkY)) {
    drawMiniMapDot(
      miniMapCtx,
      toMapX(sharkX),
      toMapY(sharkY),
      4.8,
      "#32a7ff"
    );

    // Small white core makes the hero easier to track without increasing size.
    drawMiniMapDot(
      miniMapCtx,
      toMapX(sharkX),
      toMapY(sharkY),
      1.5,
      "rgba(255,255,255,0.92)"
    );
  }

  // Border.
  miniMapCtx.strokeStyle = "rgba(255, 255, 255, 0.38)";
  miniMapCtx.lineWidth = 1;
  miniMapCtx.strokeRect(mapX + 0.5, mapY + 0.5, mapW - 1, mapH - 1);
}

// =============================================================
// SHARK CONTROL
// =============================================================

// The source WebM is drawn head-right, so its native forward direction is +X.
// No 90-degree correction is needed.
const SHARK_ANGLE_OFFSET = 0.12;

// Shark and fish now live in WORLD coordinates. The browser is only a camera
// looking at a small piece of that world.
let sharkX = HERO_START_X;
let sharkY = HERO_START_Y;
let cameraX = clamp(sharkX - viewWidth * 0.5, 0, Math.max(0, WORLD_WIDTH - viewWidth));
let cameraY = clamp(sharkY - viewHeight * 0.5, 0, Math.max(0, WORLD_HEIGHT - viewHeight));
let sharkVX = 0;
let sharkVY = 0;
let sharkAngle = 0;

// Pointer coordinates stay in SCREEN space. They are converted to world
// coordinates every frame by adding the camera position.
let pointerX = viewWidth * 0.5;
let pointerY = viewHeight * 0.5;
let pointerVX = 0;
let pointerVY = 0;
let lastPointerX = pointerX;
let lastPointerY = pointerY;
let lastPointerTime = performance.now();

// Firm pursuit. The offset is intentionally small so the shark follows
// the pointer closely without feeling glued to it.
const SHARK_FOLLOW_GAP = 200;
const SHARK_POSITION_GAIN = 15;
const SHARK_VELOCITY_GAIN = 10.0;
const SHARK_POINTER_FEED_FORWARD = 0.15;
const SHARK_MIN_MAX_SPEED = 350;
const SHARK_MAX_MAX_SPEED = 600;
const SHARK_BASE_ACCEL = 575;
const SHARK_EXTRA_ACCEL = 50;
const SHARK_MAX_TURN_RATE = 18;

// Camera dead-zone. The shark is free to move around the middle of the
// viewport. Once it crosses these thresholds, the camera starts following.
const CAMERA_LEFT_THRESHOLD = 0.30;
const CAMERA_RIGHT_THRESHOLD = 0.70;
const CAMERA_TOP_THRESHOLD = 0.28;
const CAMERA_BOTTOM_THRESHOLD = 0.72;
const CAMERA_FOLLOW_RATE = 5.2;

// Three-state navigation:
// OFF   = reef shark is frozen in place.
// GLIDE = shark follows the pointer, camera stays fixed.
// MOVE  = shark follows the pointer and camera can travel through the 4×4 world.
let movementMode = "move";

function setMovementMode(nextMode) {
  if (!["off", "glide", "move"].includes(nextMode)) return;

  movementMode = nextMode;

  for (const button of modeButtons) {
    const active = button.dataset.mode === movementMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }

  if (movementMode === "off") {
    sharkVX = 0;
    sharkVY = 0;
  }
}

for (const button of modeButtons) {
  button.addEventListener("click", () => setMovementMode(button.dataset.mode));
}

window.addEventListener("pointermove", (event) => {
  const now = event.timeStamp || performance.now();
  const dt = clamp((now - lastPointerTime) / 1000, 1 / 240, 0.08);

  const rawVX = (event.clientX - lastPointerX) / dt;
  const rawVY = (event.clientY - lastPointerY) / dt;

  pointerVX += (rawVX - pointerVX) * 0.34;
  pointerVY += (rawVY - pointerVY) * 0.34;

  pointerX = event.clientX;
  pointerY = event.clientY;
  lastPointerX = pointerX;
  lastPointerY = pointerY;
  lastPointerTime = now;
});

const HERO_ANIMAL_CLEARANCE = 100;
const HERO_COLLISION_HALF_LENGTH = 158;
const HERO_COLLISION_HALF_WIDTH = 64;

function heroSupportRadiusAlong(normalX, normalY) {
  const fx = Math.cos(sharkAngle);
  const fy = Math.sin(sharkAngle);
  const sx = -fy;
  const sy = fx;

  const forwardDot = normalX * fx + normalY * fy;
  const sideDot = normalX * sx + normalY * sy;

  return Math.sqrt(
    (HERO_COLLISION_HALF_LENGTH * forwardDot) ** 2 +
    (HERO_COLLISION_HALF_WIDTH * sideDot) ** 2
  );
}

function expandedAnimalAxes(animal, worldX, worldY) {
  const dx = worldX - animal.currentX;
  const dy = worldY - animal.currentY;
  const d = length2D(dx, dy) || 1;
  const nx = dx / d;
  const ny = dy / d;
  const heroRadius = heroSupportRadiusAlong(nx, ny);
  const expansion = HERO_ANIMAL_CLEARANCE + heroRadius;

  return {
    halfLength: animal.bodyHalfLength + expansion,
    halfWidth: animal.bodyHalfWidth + expansion
  };
}

function worldToAnimalLocal(animal, worldX, worldY) {
  const dx = worldX - animal.currentX;
  const dy = worldY - animal.currentY;
  const c = Math.cos(animal.heading);
  const s = Math.sin(animal.heading);

  return {
    x: dx * c + dy * s,
    y: -dx * s + dy * c,
    c,
    s
  };
}

function constrainHeroTargetAgainstAnimals(targetX, targetY) {
  let bestT = 1;

  for (const animal of WORLD_ANIMALS) {
    // Use the segment midpoint to estimate the hero's directional support.
    const midX = (sharkX + targetX) * 0.5;
    const midY = (sharkY + targetY) * 0.5;
    const axes = expandedAnimalAxes(animal, midX, midY);
    const c = Math.cos(animal.heading);
    const s = Math.sin(animal.heading);

    const startDX = sharkX - animal.currentX;
    const startDY = sharkY - animal.currentY;
    const endDX = targetX - animal.currentX;
    const endDY = targetY - animal.currentY;

    const sx = startDX * c + startDY * s;
    const sy = -startDX * s + startDY * c;
    const ex = endDX * c + endDY * s;
    const ey = -endDX * s + endDY * c;
    const dx = ex - sx;
    const dy = ey - sy;

    const a2 = axes.halfLength * axes.halfLength;
    const b2 = axes.halfWidth * axes.halfWidth;

    const startQ = (sx * sx) / a2 + (sy * sy) / b2;
    if (startQ <= 1) continue;

    const A = (dx * dx) / a2 + (dy * dy) / b2;
    if (A < 1e-9) continue;

    const B = 2 * ((sx * dx) / a2 + (sy * dy) / b2);
    const C = startQ - 1;
    const disc = B * B - 4 * A * C;
    if (disc < 0) continue;

    const root = Math.sqrt(disc);
    const t1 = (-B - root) / (2 * A);
    const t2 = (-B + root) / (2 * A);
    const hitT =
      t1 >= 0 && t1 <= 1 ? t1 :
      t2 >= 0 && t2 <= 1 ? t2 : null;

    if (hitT !== null) bestT = Math.min(bestT, Math.max(0, hitT - 0.006));
  }

  return {
    x: sharkX + (targetX - sharkX) * bestT,
    y: sharkY + (targetY - sharkY) * bestT,
    blocked: bestT < 0.999
  };
}

function resolveHeroAnimalCollisions() {
  let collided = false;

  for (const animal of WORLD_ANIMALS) {
    const local = worldToAnimalLocal(animal, sharkX, sharkY);
    const axes = expandedAnimalAxes(animal, sharkX, sharkY);
    const q = Math.sqrt(
      (local.x * local.x) / (axes.halfLength * axes.halfLength) +
      (local.y * local.y) / (axes.halfWidth * axes.halfWidth)
    );

    if (q >= 1) continue;

    let localX = local.x;
    let localY = local.y;

    if (q < 0.0001) {
      localX = axes.halfLength * 1.004;
      localY = 0;
    } else {
      const scale = 1.004 / q;
      localX *= scale;
      localY *= scale;
    }

    sharkX = animal.currentX + localX * local.c - localY * local.s;
    sharkY = animal.currentY + localX * local.s + localY * local.c;
    collided = true;
  }

  if (collided) {
    // The requested behaviour is a stop, not a ricochet or sliding collision.
    sharkVX = 0;
    sharkVY = 0;
  }
}

function updateShark(dt) {
  if (movementMode === "off") {
    sharkVX = 0;
    sharkVY = 0;
    pointerVX *= Math.exp(-7.5 * dt);
    pointerVY *= Math.exp(-7.5 * dt);
    return;
  }

  // Pointer speed naturally decays when the pointer stops producing events.
  const pointerDecay = Math.exp(-7.5 * dt);
  pointerVX *= pointerDecay;
  pointerVY *= pointerDecay;

  const pointerSpeed = length2D(pointerVX, pointerVY);

  const pointerWorldX = cameraX + pointerX;
  const pointerWorldY = cameraY + pointerY;

  // The shark always aims at the pointer, even once it has stopped moving.
  const toPointerX = pointerWorldX - sharkX;
  const toPointerY = pointerWorldY - sharkY;
  const toPointerLength = length2D(toPointerX, toPointerY);

  let dirX = Math.cos(sharkAngle);
  let dirY = Math.sin(sharkAngle);

  if (toPointerLength > 0.001) {
    dirX = toPointerX / toPointerLength;
    dirY = toPointerY / toPointerLength;

    const targetAngle = Math.atan2(dirY, dirX);
    const angleError = wrapAngle(targetAngle - sharkAngle);
    const maxTurn = SHARK_MAX_TURN_RATE * dt;
    sharkAngle += clamp(angleError, -maxTurn, maxTurn);
  }

  // Stop a fixed distance behind the pointer instead of merging with it.
  let targetX = pointerWorldX - dirX * SHARK_FOLLOW_GAP;
  let targetY = pointerWorldY - dirY * SHARK_FOLLOW_GAP;

  // When Glide is OFF, the camera is locked. The shark may roam only
  // inside the dead-zone and stops at its boundary even if the pointer
  // continues farther toward the edge of the screen.
  if (movementMode === "glide") {
    const minTargetX = cameraX + 90;
    const maxTargetX = cameraX + viewWidth - 90;
    const minTargetY = cameraY + 90;
    const maxTargetY = cameraY + viewHeight - 90;

    targetX = clamp(targetX, minTargetX, maxTargetX);
    targetY = clamp(targetY, minTargetY, maxTargetY);
  }

  const safeTarget = constrainHeroTargetAgainstAnimals(targetX, targetY);
  targetX = safeTarget.x;
  targetY = safeTarget.y;

  const errorX = targetX - sharkX;
  const errorY = targetY - sharkY;

  let desiredVX =
    errorX * SHARK_POSITION_GAIN +
    pointerVX * SHARK_POINTER_FEED_FORWARD;

  let desiredVY =
    errorY * SHARK_POSITION_GAIN +
    pointerVY * SHARK_POINTER_FEED_FORWARD;

  // When the shark is clamped at the dead-zone edge, pointer feed-forward
  // should not keep pushing it past that boundary.
  if (movementMode === "glide") {
    const screenTargetX = targetX - cameraX;
    const screenTargetY = targetY - cameraY;
    const eps = 0.5;

    if (screenTargetX <= 90 + eps && desiredVX < 0) desiredVX = errorX * SHARK_POSITION_GAIN;
    if (screenTargetX >= viewWidth - 90 - eps && desiredVX > 0) desiredVX = errorX * SHARK_POSITION_GAIN;
    if (screenTargetY <= 90 + eps && desiredVY < 0) desiredVY = errorY * SHARK_POSITION_GAIN;
    if (screenTargetY >= viewHeight - 90 - eps && desiredVY > 0) desiredVY = errorY * SHARK_POSITION_GAIN;
  }

  const desiredSpeed = length2D(desiredVX, desiredVY);
  const dynamicMaxSpeed = clamp(
    SHARK_MIN_MAX_SPEED + pointerSpeed * 0.48,
    SHARK_MIN_MAX_SPEED,
    SHARK_MAX_MAX_SPEED
  );

  if (desiredSpeed > dynamicMaxSpeed && desiredSpeed > 0.001) {
    const scale = dynamicMaxSpeed / desiredSpeed;
    desiredVX *= scale;
    desiredVY *= scale;
  }

  let accelX = (desiredVX - sharkVX) * SHARK_VELOCITY_GAIN;
  let accelY = (desiredVY - sharkVY) * SHARK_VELOCITY_GAIN;

  const accelLength = length2D(accelX, accelY);
  const accelLimit =
    SHARK_BASE_ACCEL +
    Math.min(SHARK_EXTRA_ACCEL, pointerSpeed * 1.0);

  if (accelLength > accelLimit && accelLength > 0.001) {
    const scale = accelLimit / accelLength;
    accelX *= scale;
    accelY *= scale;
  }

  sharkVX += accelX * dt;
  sharkVY += accelY * dt;

  sharkX += sharkVX * dt;
  sharkY += sharkVY * dt;

  // Reef shark cannot leave the fixed 7680 × 4320 world.
  const worldEdgeMargin = 80;
  if (sharkX < worldEdgeMargin) { sharkX = worldEdgeMargin; if (sharkVX < 0) sharkVX = 0; }
  if (sharkX > WORLD_WIDTH - worldEdgeMargin) { sharkX = WORLD_WIDTH - worldEdgeMargin; if (sharkVX > 0) sharkVX = 0; }
  if (sharkY < worldEdgeMargin) { sharkY = worldEdgeMargin; if (sharkVY < 0) sharkVY = 0; }
  if (sharkY > WORLD_HEIGHT - worldEdgeMargin) { sharkY = WORLD_HEIGHT - worldEdgeMargin; if (sharkVY > 0) sharkVY = 0; }

  resolveHeroAnimalCollisions();

  // Hard safety clamp while Glide is OFF. This prevents momentum
  // from carrying the shark outside the threshold after a fast pointer move.
  if (movementMode === "glide") {
    const minX = cameraX + 90;
    const maxX = cameraX + viewWidth - 90;
    const minY = cameraY + 90;
    const maxY = cameraY + viewHeight - 90;

    if (sharkX < minX) { sharkX = minX; if (sharkVX < 0) sharkVX = 0; }
    if (sharkX > maxX) { sharkX = maxX; if (sharkVX > 0) sharkVX = 0; }
    if (sharkY < minY) { sharkY = minY; if (sharkVY < 0) sharkVY = 0; }
    if (sharkY > maxY) { sharkY = maxY; if (sharkVY > 0) sharkVY = 0; }
  }
}

function updateCamera(dt) {
  if (movementMode !== "move") {
    clampCameraToWorld();
    return;
  }

  const sharkScreenX = sharkX - cameraX;
  const sharkScreenY = sharkY - cameraY;

  const left = viewWidth * CAMERA_LEFT_THRESHOLD;
  const right = viewWidth * CAMERA_RIGHT_THRESHOLD;
  const top = viewHeight * CAMERA_TOP_THRESHOLD;
  const bottom = viewHeight * CAMERA_BOTTOM_THRESHOLD;

  let targetCameraX = cameraX;
  let targetCameraY = cameraY;

  if (sharkScreenX > right) targetCameraX = sharkX - right;
  if (sharkScreenX < left) targetCameraX = sharkX - left;
  if (sharkScreenY > bottom) targetCameraY = sharkY - bottom;
  if (sharkScreenY < top) targetCameraY = sharkY - top;

  const follow = 1 - Math.exp(-CAMERA_FOLLOW_RATE * dt);
  cameraX += (targetCameraX - cameraX) * follow;
  cameraY += (targetCameraY - cameraY) * follow;
  clampCameraToWorld();
}

function renderBackground() {
  worldBackground.style.transform =
    `translate3d(${-cameraX}px, ${-cameraY}px, 0)`;
}

function renderShark() {
  const screenX = sharkX - cameraX;
  const screenY = sharkY - cameraY;

  reefShark.style.left = `${screenX}px`;
  reefShark.style.top = `${screenY}px`;

  // Locomotion stays on the OUTER wrapper. Idle animation happens inside it.
  reefShark.style.transform =
    `translate(-50%, -50%) rotate(${sharkAngle + SHARK_ANGLE_OFFSET}rad)`;
}

// =============================================================
// VIDEO SWIM / IDLE STATE
// =============================================================
//
// MOVING: the transparent WebM runs at normal speed, so the generated
// body-wave animation provides the actual swimming motion.
//
// IDLE: the shark stays in place, but the same video continues at a very
// low playback rate. That gives the tail/body a tiny living movement rather
// than freezing on one frame. A very small wrapper sway adds suspended-water
// drift without making the shark look like it is still travelling.

const IDLE_SPEED_THRESHOLD = 2;
const IDLE_ENTRY_DELAY_MS = 10;
const IDLE_PLAYBACK_RATE = 0.80;
const SWIM_PLAYBACK_RATE_MIN = 0.82;
const SWIM_PLAYBACK_RATE_MAX = 1.40;
const SWIM_SPEED_FOR_MAX_RATE = 520;

let idleEligibleSince = null;
let idleActive = true;
let currentPlaybackRate = IDLE_PLAYBACK_RATE;

// Muted autoplay should work in modern browsers. If a browser delays it,
// the first pointer movement retries playback automatically.
function ensureSharkVideoPlaying() {
  if (sharkVideo.paused) {
    sharkVideo.play().catch(() => {});
  }
}

sharkVideo.addEventListener("loadedmetadata", () => {
  sharkVideo.playbackRate = IDLE_PLAYBACK_RATE;
  ensureSharkVideoPlaying();
});

window.addEventListener("pointermove", ensureSharkVideoPlaying, { passive: true });

function updateIdleShark(dt, now) {
  const speed = length2D(sharkVX, sharkVY);
  const settled = speed < IDLE_SPEED_THRESHOLD;

  if (settled) {
    if (idleEligibleSince === null) idleEligibleSince = now;
    if (now - idleEligibleSince >= IDLE_ENTRY_DELAY_MS) idleActive = true;
  } else {
    idleEligibleSince = null;
    idleActive = false;
  }

  let targetRate;

  if (idleActive) {
    targetRate = IDLE_PLAYBACK_RATE;
  } else {
    const swimT = clamp(speed / SWIM_SPEED_FOR_MAX_RATE, 0, 1);
    targetRate =
      SWIM_PLAYBACK_RATE_MIN +
      (SWIM_PLAYBACK_RATE_MAX - SWIM_PLAYBACK_RATE_MIN) * swimT;
  }

  // Smooth the rate change so the animation never visibly snaps between
  // "swimming" and "resting".
  const rateBlend = 1 - Math.exp(-(idleActive ? 3.5 : 7.5) * dt);
  currentPlaybackRate += (targetRate - currentPlaybackRate) * rateBlend;
  sharkVideo.playbackRate = clamp(currentPlaybackRate, 0.08, 1.35);
  ensureSharkVideoPlaying();

  if (idleActive) {
    // Tiny, deliberately asymmetric suspension movement. The actual body/tail
    // motion still comes from the slowed WebM.
    const t = now * 0.001;
    const swayX = Math.sin(t * 0.92) * 0.8 + Math.sin(t * 0.37 + 1.1) * 0.35;
    const swayY = Math.sin(t * 0.71 + 0.8) * 0.65;
    const swayR = Math.sin(t * 0.58 + 0.25) * 0.22;

    sharkMotion.style.transform =
      `translate(${swayX}px, ${swayY}px) rotate(${swayR}deg)`;

  } else {
    // While travelling, keep the video locked cleanly to the locomotion
    // wrapper. The body-wave animation itself is enough.
    sharkMotion.style.transform = "translate(0px, 0px) rotate(0deg)";
  }
}

// =============================================================
// SCHOOL SETTINGS
// =============================================================

// At 1920 x 1080, 11px hex spacing creates roughly twenty thousand
// visible fish, plus an off-screen reserve around the viewport.
const FISH_SPACING = 11;
const HEX_ROW_HEIGHT = FISH_SPACING * 0.8660254;
const WORLD_MARGIN = 220;

const GRID_CELL_SIZE = 22;

// Global / local school behaviour.
const FLOW_ADHERENCE = 1.35;
const ALIGNMENT_RATE = 4.8;
const PRESSURE_STRENGTH = 6.5;

// Temporary local elastic structure. These are NOT permanent bonds.
const SPRING_RADIUS = FISH_SPACING * 1.58;
const SPRING_RADIUS_SQ = SPRING_RADIUS * SPRING_RADIUS;
const MIN_SPACING = FISH_SPACING * 0.82;
const SPRING_STRENGTH = 16;
const SEPARATION_STRENGTH = 95;
const PAIR_DAMPING = 1.15;
const MAX_PAIR_FORCE = 250;

// Fish are calm by default, but can briefly accelerate around the shark.
const BASE_FISH_MAX_SPEED = 34;
const ALERT_FISH_EXTRA_SPEED = 84;
const BASE_FISH_MAX_ACCEL = 185;
const ALERT_FISH_EXTRA_ACCEL = 480;
const ALERT_DECAY = 0.72;

// Shark avoidance. The field is deliberately wider than the body so fish
// anticipate the shark and form channels rather than exploding on contact.
const SHARK_FRONT_ANTICIPATION = 220;
const SHARK_REAR_INFLUENCE = 70;
const SHARK_SIDE_INFLUENCE = 58;
const SHARK_LATERAL_ACCEL = 1;
const SHARK_SPEED_LATERAL_GAIN = 1;
const SHARK_NORMAL_ACCEL = 800;
const HARD_BODY_MARGIN = 7.5;

// =============================================================
// SCHOOL STATE
// =============================================================

let worldMinX = cameraX - WORLD_MARGIN;
let worldMinY = cameraY - WORLD_MARGIN;
let worldMaxX = cameraX + viewWidth + WORLD_MARGIN;
let worldMaxY = cameraY + viewHeight + WORLD_MARGIN;
let worldWidth = worldMaxX - worldMinX;
let worldHeight = worldMaxY - worldMinY;

let fishCount = 0;
let fishX = null;
let fishY = null;
let fishVX = null;
let fishVY = null;
let fishAX = null;
let fishAY = null;
let fishAlert = null;
let fishTone = null;
let fishCell = null;
let nextFish = null;

let gridCols = 0;
let gridRows = 0;
let gridCount = 0;
let gridHead = null;
let gridPopulation = null;
let gridVelocityX = null;
let gridVelocityY = null;
let gridDensity = null;
let gridFlowX = null;
let gridFlowY = null;

function wrappedCellX(cx) {
  cx %= gridCols;
  if (cx < 0) cx += gridCols;
  return cx;
}

function wrappedCellY(cy) {
  cy %= gridRows;
  if (cy < 0) cy += gridRows;
  return cy;
}

function cellIndex(cx, cy) {
  return wrappedCellY(cy) * gridCols + wrappedCellX(cx);
}

function positionToCell(x, y) {
  let cx = Math.floor((x - worldMinX) / GRID_CELL_SIZE);
  let cy = Math.floor((y - worldMinY) / GRID_CELL_SIZE);

  cx = wrappedCellX(cx);
  cy = wrappedCellY(cy);

  return cy * gridCols + cx;
}

function buildSchool() {
  worldMinX = cameraX - WORLD_MARGIN;
  worldMinY = cameraY - WORLD_MARGIN;
  worldMaxX = cameraX + viewWidth + WORLD_MARGIN;
  worldMaxY = cameraY + viewHeight + WORLD_MARGIN;
  worldWidth = worldMaxX - worldMinX;
  worldHeight = worldMaxY - worldMinY;

  gridCols = Math.max(1, Math.ceil(worldWidth / GRID_CELL_SIZE));
  gridRows = Math.max(1, Math.ceil(worldHeight / GRID_CELL_SIZE));
  gridCount = gridCols * gridRows;

  const points = [];
  let row = 0;

  for (
    let y = worldMinY;
    y < worldMaxY;
    y += HEX_ROW_HEIGHT
  ) {
    const rowOffset = row % 2 === 0 ? 0 : FISH_SPACING * 0.5;
    let col = 0;

    for (
      let x = worldMinX + rowOffset;
      x < worldMaxX;
      x += FISH_SPACING
    ) {
      // Very small deterministic jitter breaks a perfect synthetic lattice
      // without turning the school into random sand.
      const jitterX = Math.sin(row * 12.9898 + col * 78.233) * 0.85;
      const jitterY = Math.sin(row * 39.3467 + col * 11.135) * 0.65;

      points.push(x + jitterX, y + jitterY, row, col);
      col += 1;
    }

    row += 1;
  }

  fishCount = points.length / 4;

  fishX = new Float32Array(fishCount);
  fishY = new Float32Array(fishCount);
  fishVX = new Float32Array(fishCount);
  fishVY = new Float32Array(fishCount);
  fishAX = new Float32Array(fishCount);
  fishAY = new Float32Array(fishCount);
  fishAlert = new Float32Array(fishCount);
  fishTone = new Uint8Array(fishCount);
  fishCell = new Int32Array(fishCount);
  nextFish = new Int32Array(fishCount);

  gridHead = new Int32Array(gridCount);
  gridPopulation = new Uint16Array(gridCount);
  gridVelocityX = new Float32Array(gridCount);
  gridVelocityY = new Float32Array(gridCount);
  gridDensity = new Float32Array(gridCount);
  gridFlowX = new Float32Array(gridCount);
  gridFlowY = new Float32Array(gridCount);

  computeFlowField(0);

  for (let i = 0; i < fishCount; i++) {
    const x = points[i * 4];
    const y = points[i * 4 + 1];
    const rowIndex = points[i * 4 + 2];
    const colIndex = points[i * 4 + 3];

    fishX[i] = wrapValue(x, worldMinX, worldMaxX);
    fishY[i] = wrapValue(y, worldMinY, worldMaxY);

    const c = positionToCell(fishX[i], fishY[i]);
    fishVX[i] = gridFlowX[c];
    fishVY[i] = gridFlowY[c];

    // Broad coherent tone bands travel with the school and deform with it.
    // This makes the dense school read more like a ribbon with depth/light.
    const toneWave =
      Math.sin(rowIndex * 0.115 + colIndex * 0.037) +
      0.45 * Math.sin(rowIndex * 0.041 - colIndex * 0.063);

    fishTone[i] = toneWave > 0.52 ? 2 : toneWave < -0.35 ? 0 : 1;
  }
}

// =============================================================
// MOVING SCHOOL FLOW FIELD
// =============================================================

function computeFlowField(timeSeconds) {
  for (let cy = 0; cy < gridRows; cy++) {
    const y = worldMinY + (cy + 0.5) * GRID_CELL_SIZE;

    for (let cx = 0; cx < gridCols; cx++) {
      const x = worldMinX + (cx + 0.5) * GRID_CELL_SIZE;
      const index = cy * gridCols + cx;

      // Large slow bends establish the direction of the school.
      const angle =
        0.08 +
        0.34 * Math.sin(y * 0.00145 + timeSeconds * 0.085) +
        0.17 * Math.sin(x * 0.00115 - timeSeconds * 0.055);

      const baseSpeed =
        18 +
        2.8 * Math.sin(x * 0.0016 + y * 0.0011 + timeSeconds * 0.07);

      // A small divergence-resistant curl component makes broad curves
      // without making individual fish wander randomly.
      const px = x * 0.0030 + timeSeconds * 0.11;
      const py = y * 0.0036 - timeSeconds * 0.085;
      const curlX = 4.2 * Math.cos(py) * Math.sin(px);
      const curlY = -4.2 * Math.cos(px) * Math.sin(py);

      gridFlowX[index] = Math.cos(angle) * baseSpeed + curlX;
      gridFlowY[index] = Math.sin(angle) * baseSpeed + curlY;
    }
  }
}

// =============================================================
// SPATIAL GRID
// =============================================================

function rebuildSpatialGrid() {
  gridHead.fill(-1);
  gridPopulation.fill(0);
  gridVelocityX.fill(0);
  gridVelocityY.fill(0);

  for (let i = 0; i < fishCount; i++) {
    const c = positionToCell(fishX[i], fishY[i]);
    fishCell[i] = c;

    nextFish[i] = gridHead[c];
    gridHead[c] = i;

    gridPopulation[c] += 1;
    gridVelocityX[c] += fishVX[i];
    gridVelocityY[c] += fishVY[i];
  }

  // Smooth density over a 3x3 cell neighbourhood. A hole left by the
  // shark therefore becomes a real low-density region that the school can
  // later refill from its edges.
  for (let cy = 0; cy < gridRows; cy++) {
    for (let cx = 0; cx < gridCols; cx++) {
      let density = 0;

      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          density += gridPopulation[cellIndex(cx + ox, cy + oy)];
        }
      }

      gridDensity[cy * gridCols + cx] = density;
    }
  }
}

// =============================================================
// TEMPORARY NEIGHBOUR SPRINGS
// =============================================================

function applyNeighbourStructure() {
  // Equal-and-opposite pair forces preserve local spacing without binding
  // any fish permanently to another fish. Neighbours can change naturally.
  for (let i = 0; i < fishCount; i++) {
    const cell = fishCell[i];
    const baseCX = cell % gridCols;
    const baseCY = Math.floor(cell / gridCols);

    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const neighbourCell = cellIndex(baseCX + ox, baseCY + oy);

        for (let j = gridHead[neighbourCell]; j !== -1; j = nextFish[j]) {
          if (j <= i) continue;

          let dx = fishX[j] - fishX[i];
          let dy = fishY[j] - fishY[i];

          dx = wrappedDelta(dx, worldWidth);
          dy = wrappedDelta(dy, worldHeight);

          const distSq = dx * dx + dy * dy;

          if (distSq <= 0.0001 || distSq >= SPRING_RADIUS_SQ) continue;

          const dist = Math.sqrt(distSq);
          const ux = dx / dist;
          const uy = dy / dist;

          let force = (dist - FISH_SPACING) * SPRING_STRENGTH;

          if (dist < MIN_SPACING) {
            force -= (MIN_SPACING - dist) * SEPARATION_STRENGTH;
          }

          const relativeSpeedAlongPair =
            (fishVX[j] - fishVX[i]) * ux +
            (fishVY[j] - fishVY[i]) * uy;

          force += relativeSpeedAlongPair * PAIR_DAMPING;
          force = clamp(force, -MAX_PAIR_FORCE, MAX_PAIR_FORCE);

          const fx = ux * force;
          const fy = uy * force;

          fishAX[i] += fx;
          fishAY[i] += fy;
          fishAX[j] -= fx;
          fishAY[j] -= fy;
        }
      }
    }
  }
}

// =============================================================
// SHARK OBSTACLE FIELD
// =============================================================

let sharkBodyHalfLength = 122;
let sharkBodyHalfWidth = 50;

// Geometry bridge for the current horizontal transparent WebM.
// The schooling / pressure / spring / avoidance logic below is copied from
// the reference version; this adapter only tells that logic the visible body size.
const SHARK_VISIBLE_WIDTH_RATIO = 0.85;
const SHARK_VISIBLE_HEIGHT_RATIO = 0.65;

function refreshSharkBodySize() {
  const width = reefShark.offsetWidth || 426;
  const height = reefShark.offsetHeight || 240;

  // Local X is forward/back along the shark heading.
  // Local Y is side-to-side across the body.
  sharkBodyHalfLength =
    width * SHARK_VISIBLE_WIDTH_RATIO * 0.5 + HARD_BODY_MARGIN;
  sharkBodyHalfWidth =
    height * SHARK_VISIBLE_HEIGHT_RATIO * 0.5 + HARD_BODY_MARGIN;
}

function applySharkField(
  i,
  sharkCos,
  sharkSin,
  sharkSpeed,
  bodyHalfLength,
  bodyHalfWidth,
  timeSeconds
) {
  const dx = fishX[i] - sharkX;
  const dy = fishY[i] - sharkY;

  // Local x follows the shark's direction of travel.
  const localX = dx * sharkCos + dy * sharkSin;
  const localY = -dx * sharkSin + dy * sharkCos;

  const frontExtra =
    SHARK_FRONT_ANTICIPATION + Math.min(115, sharkSpeed * 0.16);

  const influenceHalfLength =
    bodyHalfLength + (localX >= 0 ? frontExtra : SHARK_REAR_INFLUENCE);

  const influenceHalfWidth =
    bodyHalfWidth + SHARK_SIDE_INFLUENCE + Math.min(34, sharkSpeed * 0.045);

  const nx = localX / influenceHalfLength;
  const ny = localY / influenceHalfWidth;
  const q = Math.sqrt(nx * nx + ny * ny);

  if (q >= 1) return 0;

  const penetration = 1 - q;
  const weight = smoothstep01(penetration);

  // Fish in the same local patch choose the same side because localY is
  // spatially coherent. Very near the centre line, use a broad deterministic
  // field rather than per-fish randomness so neighbouring fish still agree.
  let side;

  if (Math.abs(localY) > 2.5) {
    side = localY >= 0 ? 1 : -1;
  } else {
    const sideField =
      Math.sin(fishY[i] * 0.014 + fishX[i] * 0.0045 + timeSeconds * 0.05);
    side = sideField >= 0 ? 1 : -1;
  }

  // Perpendicular to shark heading. This is the crucial "peel around" force.
  const perpX = -sharkSin * side;
  const perpY = sharkCos * side;

  const lateralAccel =
    (SHARK_LATERAL_ACCEL + sharkSpeed * SHARK_SPEED_LATERAL_GAIN) * weight;

  fishAX[i] += perpX * lateralAccel;
  fishAY[i] += perpY * lateralAccel;

  // A weaker ellipse normal keeps the school from collapsing inward, but it
  // is intentionally secondary to tangential / lateral steering.
  let normalLocalX = localX / (influenceHalfLength * influenceHalfLength);
  let normalLocalY = localY / (influenceHalfWidth * influenceHalfWidth);
  const normalLength = length2D(normalLocalX, normalLocalY) || 1;

  normalLocalX /= normalLength;
  normalLocalY /= normalLength;

  const normalWorldX = normalLocalX * sharkCos - normalLocalY * sharkSin;
  const normalWorldY = normalLocalX * sharkSin + normalLocalY * sharkCos;

  const normalAccel = SHARK_NORMAL_ACCEL * weight * penetration;

  fishAX[i] += normalWorldX * normalAccel;
  fishAY[i] += normalWorldY * normalAccel;

  // A little of the shark's forward momentum makes the school wrap along the
  // moving body instead of behaving like a static wall.
  fishAX[i] += sharkVX * 0.24 * weight;
  fishAY[i] += sharkVY * 0.24 * weight;

  return weight;
}

function getActiveWorldAnimalObstacles() {
  const obstacles = [];

  for (const animal of WORLD_ANIMALS) {
    const influenceRadius =
      Math.max(animal.bodyHalfLength, animal.bodyHalfWidth) + 170;

    if (
      animal.currentX + influenceRadius < worldMinX ||
      animal.currentX - influenceRadius > worldMaxX ||
      animal.currentY + influenceRadius < worldMinY ||
      animal.currentY - influenceRadius > worldMaxY
    ) {
      continue;
    }

    obstacles.push({
      animal,
      x: animal.currentX,
      y: animal.currentY,
      vx: animal.vx,
      vy: animal.vy,
      heading: animal.heading,
      cos: Math.cos(animal.heading),
      sin: Math.sin(animal.heading),
      bodyHalfLength: animal.bodyHalfLength,
      bodyHalfWidth: animal.bodyHalfWidth,
      speed: length2D(animal.vx, animal.vy),
      broadRadiusSq: influenceRadius * influenceRadius
    });
  }

  return obstacles;
}

function applyWorldAnimalField(i, obstacle, timeSeconds) {
  const dx = fishX[i] - obstacle.x;
  const dy = fishY[i] - obstacle.y;

  if (dx * dx + dy * dy > obstacle.broadRadiusSq) return 0;

  const localX = dx * obstacle.cos + dy * obstacle.sin;
  const localY = -dx * obstacle.sin + dy * obstacle.cos;

  let frontExtra = 78;
  let rearExtra = 46;
  let sideExtra = 42;
  let lateralBase = 255;
  let normalBase = 135;

  if (obstacle.animal.id === "whaleshark") {
    frontExtra = 125;
    rearExtra = 82;
    sideExtra = 88;
    lateralBase = 290;
    normalBase = 155;
  } else if (obstacle.animal.id === "manta") {
    frontExtra = 95;
    rearExtra = 62;
    sideExtra = 72;
    lateralBase = 275;
    normalBase = 150;
  } else if (obstacle.animal.id === "cuttlefish") {
    frontExtra = 42;
    rearExtra = 28;
    sideExtra = 30;
    lateralBase = 210;
    normalBase = 120;
  }

  const influenceHalfLength =
    obstacle.bodyHalfLength + (localX >= 0 ? frontExtra : rearExtra);
  const influenceHalfWidth =
    obstacle.bodyHalfWidth + sideExtra + Math.min(24, obstacle.speed * 0.08);

  const nx = localX / influenceHalfLength;
  const ny = localY / influenceHalfWidth;
  const q = Math.sqrt(nx * nx + ny * ny);
  if (q >= 1) return 0;

  const penetration = 1 - q;
  const weight = smoothstep01(penetration);

  let side;
  if (Math.abs(localY) > 2.0) {
    side = localY >= 0 ? 1 : -1;
  } else {
    const sideField =
      Math.sin(fishY[i] * 0.013 + fishX[i] * 0.005 + timeSeconds * 0.04);
    side = sideField >= 0 ? 1 : -1;
  }

  const perpX = -obstacle.sin * side;
  const perpY = obstacle.cos * side;
  const lateralAccel = (lateralBase + obstacle.speed * 0.30) * weight;
  fishAX[i] += perpX * lateralAccel;
  fishAY[i] += perpY * lateralAccel;

  let normalLocalX = localX / (influenceHalfLength * influenceHalfLength);
  let normalLocalY = localY / (influenceHalfWidth * influenceHalfWidth);
  const normalLength = length2D(normalLocalX, normalLocalY) || 1;
  normalLocalX /= normalLength;
  normalLocalY /= normalLength;

  const normalWorldX = normalLocalX * obstacle.cos - normalLocalY * obstacle.sin;
  const normalWorldY = normalLocalX * obstacle.sin + normalLocalY * obstacle.cos;
  const normalAccel = normalBase * weight * penetration;
  fishAX[i] += normalWorldX * normalAccel;
  fishAY[i] += normalWorldY * normalAccel;

  // Moving animals carry a small wake influence so fish bend around the body
  // rather than acting as if the obstacle were a static sticker.
  fishAX[i] += obstacle.vx * 0.16 * weight;
  fishAY[i] += obstacle.vy * 0.16 * weight;

  return weight;
}

function keepFishOutsideWorldAnimal(i, obstacle) {
  const dx = fishX[i] - obstacle.x;
  const dy = fishY[i] - obstacle.y;

  let localX = dx * obstacle.cos + dy * obstacle.sin;
  let localY = -dx * obstacle.sin + dy * obstacle.cos;

  const halfLength = obstacle.bodyHalfLength + 4;
  const halfWidth = obstacle.bodyHalfWidth + 4;
  const nx = localX / halfLength;
  const ny = localY / halfWidth;
  const q = Math.sqrt(nx * nx + ny * ny);

  if (q >= 1) return;

  if (q < 0.0001) {
    localX = halfLength;
    localY = 0;
  } else {
    const scale = 1.018 / q;
    localX *= scale;
    localY *= scale;
  }

  const worldX = localX * obstacle.cos - localY * obstacle.sin;
  const worldY = localX * obstacle.sin + localY * obstacle.cos;
  fishX[i] = obstacle.x + worldX;
  fishY[i] = obstacle.y + worldY;

  let normalLocalX = localX / (halfLength * halfLength);
  let normalLocalY = localY / (halfWidth * halfWidth);
  const normalLength = length2D(normalLocalX, normalLocalY) || 1;
  normalLocalX /= normalLength;
  normalLocalY /= normalLength;

  const normalWorldX = normalLocalX * obstacle.cos - normalLocalY * obstacle.sin;
  const normalWorldY = normalLocalX * obstacle.sin + normalLocalY * obstacle.cos;
  const relVX = fishVX[i] - obstacle.vx;
  const relVY = fishVY[i] - obstacle.vy;
  const outwardRelativeSpeed = relVX * normalWorldX + relVY * normalWorldY;

  if (outwardRelativeSpeed < 28) {
    const correction = 28 - outwardRelativeSpeed;
    fishVX[i] += normalWorldX * correction;
    fishVY[i] += normalWorldY * correction;
  }
}

function keepFishOutsideShark(i, sharkCos, sharkSin, bodyHalfLength, bodyHalfWidth) {
  const dx = fishX[i] - sharkX;
  const dy = fishY[i] - sharkY;

  let localX = dx * sharkCos + dy * sharkSin;
  let localY = -dx * sharkSin + dy * sharkCos;

  const nx = localX / bodyHalfLength;
  const ny = localY / bodyHalfWidth;
  const q = Math.sqrt(nx * nx + ny * ny);

  if (q >= 1) return;

  if (q < 0.0001) {
    localX = bodyHalfLength;
    localY = 0;
  } else {
    const scale = 1.015 / q;
    localX *= scale;
    localY *= scale;
  }

  const worldX = localX * sharkCos - localY * sharkSin;
  const worldY = localX * sharkSin + localY * sharkCos;

  fishX[i] = sharkX + worldX;
  fishY[i] = sharkY + worldY;

  // Remove velocity heading into the body and give the fish a small outward
  // component so it cannot immediately re-enter on the next frame.
  let normalLocalX = localX / (bodyHalfLength * bodyHalfLength);
  let normalLocalY = localY / (bodyHalfWidth * bodyHalfWidth);
  const normalLength = length2D(normalLocalX, normalLocalY) || 1;

  normalLocalX /= normalLength;
  normalLocalY /= normalLength;

  const normalWorldX = normalLocalX * sharkCos - normalLocalY * sharkSin;
  const normalWorldY = normalLocalX * sharkSin + normalLocalY * sharkCos;

  const relVX = fishVX[i] - sharkVX;
  const relVY = fishVY[i] - sharkVY;
  const outwardRelativeSpeed = relVX * normalWorldX + relVY * normalWorldY;

  if (outwardRelativeSpeed < 36) {
    const correction = 36 - outwardRelativeSpeed;
    fishVX[i] += normalWorldX * correction;
    fishVY[i] += normalWorldY * correction;
  }
}

// Keep a fixed-size simulation window around the camera instead of making
// a gigantic 20,000px-wide fish array. Fish that leave the reserve wrap
// around off-screen, so the school can continue indefinitely.
function updateWorldWindow() {
  worldMinX = cameraX - WORLD_MARGIN;
  worldMinY = cameraY - WORLD_MARGIN;
  worldMaxX = cameraX + viewWidth + WORLD_MARGIN;
  worldMaxY = cameraY + viewHeight + WORLD_MARGIN;
  worldWidth = worldMaxX - worldMinX;
  worldHeight = worldMaxY - worldMinY;
}

// =============================================================
// SCHOOL UPDATE
// =============================================================

function updateSchool(dt, timeSeconds) {
  computeFlowField(timeSeconds);
  rebuildSpatialGrid();

  fishAX.fill(0);
  fishAY.fill(0);

  const sharkCos = Math.cos(sharkAngle);
  const sharkSin = Math.sin(sharkAngle);
  const sharkSpeed = length2D(sharkVX, sharkVY);
  const activeAnimalObstacles = getActiveWorldAnimalObstacles();

  // -----------------------------------------------------------
  // FIELD, ALIGNMENT, DENSITY PRESSURE, SHARK
  // -----------------------------------------------------------

  for (let i = 0; i < fishCount; i++) {
    const cell = fishCell[i];
    const cx = cell % gridCols;
    const cy = Math.floor(cell / gridCols);

    // 1) The school follows a slow moving field.
    fishAX[i] += (gridFlowX[cell] - fishVX[i]) * FLOW_ADHERENCE;
    fishAY[i] += (gridFlowY[cell] - fishVY[i]) * FLOW_ADHERENCE;

    // 2) Strong local velocity alignment.
    let neighbours = 0;
    let neighbourVX = 0;
    let neighbourVY = 0;

    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const c = cellIndex(cx + ox, cy + oy);
        neighbours += gridPopulation[c];
        neighbourVX += gridVelocityX[c];
        neighbourVY += gridVelocityY[c];
      }
    }

    if (neighbours > 0) {
      const averageVX = neighbourVX / neighbours;
      const averageVY = neighbourVY / neighbours;
      const alertBoost = 1 + fishAlert[i] * 0.72;

      fishAX[i] +=
        (averageVX - fishVX[i]) * ALIGNMENT_RATE * alertBoost;

      fishAY[i] +=
        (averageVY - fishVY[i]) * ALIGNMENT_RATE * alertBoost;
    }

    // 3) Density pressure heals holes. It has no concept of original position.
    const densityLeft = gridDensity[cellIndex(cx - 1, cy)];
    const densityRight = gridDensity[cellIndex(cx + 1, cy)];
    const densityUp = gridDensity[cellIndex(cx, cy - 1)];
    const densityDown = gridDensity[cellIndex(cx, cy + 1)];

    const pressureX = -(densityRight - densityLeft) * PRESSURE_STRENGTH;
    const pressureY = -(densityDown - densityUp) * PRESSURE_STRENGTH;

    // While the shark is physically present, obstacle avoidance gets priority;
    // immediately afterwards this pressure resumes and closes the channel.
    const sharkInfluence = applySharkField(
      i,
      sharkCos,
      sharkSin,
      sharkSpeed,
      sharkBodyHalfLength,
      sharkBodyHalfWidth,
      timeSeconds
    );

    let encounterInfluence = 0;
    for (let o = 0; o < activeAnimalObstacles.length; o++) {
      encounterInfluence = Math.max(
        encounterInfluence,
        applyWorldAnimalField(i, activeAnimalObstacles[o], timeSeconds)
      );
    }

    const obstacleInfluence = Math.max(sharkInfluence, encounterInfluence);

    fishAlert[i] = Math.max(
      obstacleInfluence,
      fishAlert[i] * Math.exp(-ALERT_DECAY * dt)
    );

    const pressurePermission = 1 - obstacleInfluence * 0.82;
    fishAX[i] += pressureX * pressurePermission;
    fishAY[i] += pressureY * pressurePermission;
  }

  // 4) Local elastic structure / collision avoidance.
  applyNeighbourStructure();

  // -----------------------------------------------------------
  // INTEGRATE
  // -----------------------------------------------------------

  for (let i = 0; i < fishCount; i++) {
    const alert = fishAlert[i];

    const maxAccel =
      BASE_FISH_MAX_ACCEL + ALERT_FISH_EXTRA_ACCEL * alert;

    const accelLength = length2D(fishAX[i], fishAY[i]);

    if (accelLength > maxAccel && accelLength > 0.001) {
      const scale = maxAccel / accelLength;
      fishAX[i] *= scale;
      fishAY[i] *= scale;
    }

    fishVX[i] += fishAX[i] * dt;
    fishVY[i] += fishAY[i] * dt;

    const maxSpeed =
      BASE_FISH_MAX_SPEED + ALERT_FISH_EXTRA_SPEED * alert;

    const speed = length2D(fishVX[i], fishVY[i]);

    if (speed > maxSpeed && speed > 0.001) {
      const scale = maxSpeed / speed;
      fishVX[i] *= scale;
      fishVY[i] *= scale;
    }

    fishX[i] += fishVX[i] * dt;
    fishY[i] += fishVY[i] * dt;

    // Continuous world. Fish can leave the screen because the simulated
    // school extends beyond the viewport. Wrapping happens off-screen.
    fishX[i] = wrapValue(fishX[i], worldMinX, worldMaxX);
    fishY[i] = wrapValue(fishY[i], worldMinY, worldMaxY);

    keepFishOutsideShark(
      i,
      sharkCos,
      sharkSin,
      sharkBodyHalfLength,
      sharkBodyHalfWidth
    );

    for (let o = 0; o < activeAnimalObstacles.length; o++) {
      keepFishOutsideWorldAnimal(i, activeAnimalObstacles[o]);
    }
  }
}

// =============================================================
// RENDER SCHOOL
// =============================================================

const TONE_STYLES = [
  { stroke: "rgba(8, 27, 78, 0.44)", width: 1.15, length: 3.7 },
  { stroke: "rgba(7, 25, 74, 0.64)", width: 1.35, length: 4.2 },
  { stroke: "rgba(5, 22, 68, 0.82)", width: 1.55, length: 4.6 }
];

function drawSchool() {
  ctx.clearRect(0, 0, viewWidth, viewHeight);
  ctx.lineCap = "round";

  const paths = [new Path2D(), new Path2D(), new Path2D()];

  for (let i = 0; i < fishCount; i++) {
    const x = fishX[i] - cameraX;
    const y = fishY[i] - cameraY;

    // Fish are simulated in world space, then projected into screen space.
    if (x < -8 || x > viewWidth + 8 || y < -8 || y > viewHeight + 8) {
      continue;
    }

    let vx = fishVX[i];
    let vy = fishVY[i];
    let speed = length2D(vx, vy);

    if (speed < 0.01) {
      const c = fishCell[i];
      vx = gridFlowX[c];
      vy = gridFlowY[c];
      speed = length2D(vx, vy) || 1;
    }

    const ux = vx / speed;
    const uy = vy / speed;
    const tone = fishTone[i];
    const len = TONE_STYLES[tone].length + fishAlert[i] * 0.65;
    const half = len * 0.5;

    const path = paths[tone];
    path.moveTo(x - ux * half, y - uy * half);
    path.lineTo(x + ux * half, y + uy * half);
  }

  for (let tone = 0; tone < 3; tone++) {
    ctx.strokeStyle = TONE_STYLES[tone].stroke;
    ctx.lineWidth = TONE_STYLES[tone].width;
    ctx.stroke(paths[tone]);
  }
}

// =============================================================
// RESIZE
// =============================================================

function rebuildSimulation() {
  resizeCanvas();

  pointerX = clamp(pointerX, 0, viewWidth);
  pointerY = clamp(pointerY, 0, viewHeight);

  clampCameraToWorld();
  refreshSharkBodySize();
  sizeWorldAnimals();
  buildSchool();
}

window.addEventListener("resize", rebuildSimulation);

// =============================================================
// ANIMATION LOOP
// =============================================================

let previousFrameTime = performance.now();
let simulationTime = 0;
let paused = false;

function animate(now) {
  if (paused) return;

  // Clamp large frame gaps so switching tabs cannot explode the simulation.
  const dt = clamp((now - previousFrameTime) / 1000, 1 / 240, 1 / 24);
  previousFrameTime = now;
  simulationTime += dt;

  updateWorldAnimals(dt, simulationTime);
  updateShark(dt);
  updateCamera(dt);
  updateWorldWindow();
  updateSchool(dt, simulationTime);
  drawSchool();
  renderBackground();
  renderWorldAnimals();
  renderMiniMap();
  renderShark();
  updateIdleShark(dt, now);

  requestAnimationFrame(animate);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    paused = true;
    return;
  }

  previousFrameTime = performance.now();
  paused = false;
  requestAnimationFrame(animate);
});

// =============================================================
// START
// =============================================================

resizeCanvas();
buildMirroredBackground();
sizeWorldAnimals();
prepareWorldAnimalVideos();
updateWorldAnimals(1 / 60, 0);
refreshSharkBodySize();
clampCameraToWorld();
updateWorldWindow();
buildSchool();
renderBackground();
renderWorldAnimals();
renderMiniMap();
renderShark();
setMovementMode("move");
updateIdleShark(0, performance.now());
requestAnimationFrame(animate);
