"use strict";

// =============================================================
// DOM
// =============================================================

const canvas = document.getElementById("particleCanvas");
const ctx = canvas.getContext("2d", { alpha: true });
const whaleShark = document.getElementById("whaleshark");
const sharkMotion = document.getElementById("sharkMotion");
const sharkShadow = document.getElementById("sharkShadow");
const oceanBackground = document.getElementById("oceanBackground");
const glideToggle = document.getElementById("glideToggle");

const sharkParts = {
  lower: document.querySelector(".lowerbody"),
  leftFin: document.querySelector(".leftfin"),
  rightFin: document.querySelector(".rightfin"),
  tail: document.querySelector(".tailfin"),
  dorsalA: document.querySelector(".dorsal-a"),
  dorsalB: document.querySelector(".dorsal-b"),
};

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
  dpr = Math.min(window.devicePixelRatio || 1, 1.5);

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
// SHARK CONTROL
// =============================================================

const SHARK_ANGLE_OFFSET = Math.PI * 0.5;

// Shark and fish now live in WORLD coordinates. The browser is only a camera
// looking at a small piece of that world.
let cameraX = 0;
let cameraY = 0;
let sharkX = cameraX + viewWidth * 0.5;
let sharkY = cameraY + viewHeight * 0.5;
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
const SHARK_FOLLOW_GAP = 20;
const SHARK_POSITION_GAIN = 4.6;
const SHARK_VELOCITY_GAIN = 8.5;
const SHARK_POINTER_FEED_FORWARD = 0.18;
const SHARK_MIN_MAX_SPEED = 260;
const SHARK_MAX_MAX_SPEED = 760;
const SHARK_BASE_ACCEL = 1100;
const SHARK_EXTRA_ACCEL = 1700;
const SHARK_MAX_TURN_RATE = 8.5;

// Camera dead-zone. The shark is free to move around the middle of the
// viewport. Once it crosses these thresholds, the camera starts following.
const CAMERA_LEFT_THRESHOLD = 0.30;
const CAMERA_RIGHT_THRESHOLD = 0.70;
const CAMERA_TOP_THRESHOLD = 0.28;
const CAMERA_BOTTOM_THRESHOLD = 0.72;
const CAMERA_FOLLOW_RATE = 5.2;

// Glide is ON by default, matching the Figma toggle. When ON, camera
// navigation is automatic. When OFF, the camera is completely locked and
// the shark can only roam inside the dead-zone.
let glideEnabled = true;

window.addEventListener("pointermove", (event) => {
  const now = event.timeStamp || performance.now();
  const dt = clamp((now - lastPointerTime) / 1000, 1 / 240, 0.08);

  const rawVX = (event.clientX - lastPointerX) / dt;
  const rawVY = (event.clientY - lastPointerY) / dt;

  // Smooth pointer velocity so one noisy browser event cannot snap the shark.
  pointerVX += (rawVX - pointerVX) * 0.34;
  pointerVY += (rawVY - pointerVY) * 0.34;

  pointerX = event.clientX;
  pointerY = event.clientY;
  lastPointerX = pointerX;
  lastPointerY = pointerY;
  lastPointerTime = now;
});

glideToggle.addEventListener("click", () => {
  glideEnabled = !glideEnabled;
  glideToggle.classList.toggle("is-on", glideEnabled);
  glideToggle.setAttribute("aria-checked", String(glideEnabled));

  // When Glide is turned off, stop camera momentum immediately. The camera
  // itself is position-based, so no additional camera velocity needs reset.
});

function updateShark(dt) {
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
  if (!glideEnabled) {
    const minTargetX = cameraX + viewWidth * CAMERA_LEFT_THRESHOLD;
    const maxTargetX = cameraX + viewWidth * CAMERA_RIGHT_THRESHOLD;
    const minTargetY = cameraY + viewHeight * CAMERA_TOP_THRESHOLD;
    const maxTargetY = cameraY + viewHeight * CAMERA_BOTTOM_THRESHOLD;

    targetX = clamp(targetX, minTargetX, maxTargetX);
    targetY = clamp(targetY, minTargetY, maxTargetY);
  }

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
  if (!glideEnabled) {
    const screenTargetX = targetX - cameraX;
    const screenTargetY = targetY - cameraY;
    const eps = 0.5;

    if (screenTargetX <= viewWidth * CAMERA_LEFT_THRESHOLD + eps && desiredVX < 0) desiredVX = errorX * SHARK_POSITION_GAIN;
    if (screenTargetX >= viewWidth * CAMERA_RIGHT_THRESHOLD - eps && desiredVX > 0) desiredVX = errorX * SHARK_POSITION_GAIN;
    if (screenTargetY <= viewHeight * CAMERA_TOP_THRESHOLD + eps && desiredVY < 0) desiredVY = errorY * SHARK_POSITION_GAIN;
    if (screenTargetY >= viewHeight * CAMERA_BOTTOM_THRESHOLD - eps && desiredVY > 0) desiredVY = errorY * SHARK_POSITION_GAIN;
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

  // Hard safety clamp while Glide is OFF. This prevents momentum
  // from carrying the shark outside the threshold after a fast pointer move.
  if (!glideEnabled) {
    const minX = cameraX + viewWidth * CAMERA_LEFT_THRESHOLD;
    const maxX = cameraX + viewWidth * CAMERA_RIGHT_THRESHOLD;
    const minY = cameraY + viewHeight * CAMERA_TOP_THRESHOLD;
    const maxY = cameraY + viewHeight * CAMERA_BOTTOM_THRESHOLD;

    if (sharkX < minX) { sharkX = minX; if (sharkVX < 0) sharkVX = 0; }
    if (sharkX > maxX) { sharkX = maxX; if (sharkVX > 0) sharkVX = 0; }
    if (sharkY < minY) { sharkY = minY; if (sharkVY < 0) sharkVY = 0; }
    if (sharkY > maxY) { sharkY = maxY; if (sharkVY > 0) sharkVY = 0; }
  }
}

function updateCamera(dt) {
  if (!glideEnabled) return;

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
}

function renderBackground() {
  // bgtemp.png repeats forever for now. The texture is anchored in world
  // coordinates, so camera movement visibly reveals a different area.
  oceanBackground.style.backgroundPosition =
    `${-cameraX}px ${-cameraY}px`;
}

function renderShark() {
  const screenX = sharkX - cameraX;
  const screenY = sharkY - cameraY;

  whaleShark.style.left = `${screenX}px`;
  whaleShark.style.top = `${screenY}px`;

  // Locomotion stays on the OUTER wrapper. Idle animation happens inside it.
  whaleShark.style.transform =
    `translate(-50%, -50%) rotate(${sharkAngle + SHARK_ANGLE_OFFSET}rad)`;
}

// =============================================================
// IDLE SHARK ANIMATION
// =============================================================
//
// This is the same 4-second asymmetric idle choreography from shark animation v2.
// It turns on only after the locomotion speed has stayed near zero for a moment.
// Moving again blends the parts smoothly back toward their neutral pose.

const IDLE_LOOP_MS = 4000;
const IDLE_SPEED_THRESHOLD = 9;       // px/s
const IDLE_ENTRY_DELAY_MS = 320;      // must actually settle before swaying
const IDLE_BLEND_IN_RATE = 4.5;
const IDLE_BLEND_OUT_RATE = 8.0;

// Same readable browser scaling used in shark animation v2.
const IDLE_ROTATION_VISIBILITY = 4.25;
const IDLE_DRIFT_VISIBILITY = 1.65;

const idleKeyframes = [
  { t:0,    x:0,    y:0,    r:0,      tail:0,     lower:0,     lf:0,      rf:0,      dorsal:0 },
  { t:900,  x:1.2,  y:-0.6, r:0.08,   tail:0.48,  lower:0.20,  lf:0.23,   rf:-0.14,  dorsal:0.02 },
  { t:2050, x:-0.7, y:0.9,  r:-0.06,  tail:-0.62, lower:-0.27, lf:-0.16,  rf:0.26,   dorsal:-0.015 },
  { t:2850, x:0.5,  y:0.3,  r:0.035,  tail:0.28,  lower:0.11,  lf:-0.20,  rf:0.12,   dorsal:0.01 },
  { t:4000, x:0,    y:0,    r:0,      tail:0,     lower:0,     lf:0,      rf:0,      dorsal:0 },
];

let idleEligibleSince = null;
let idlePhaseStart = 0;
let idleBlend = 0;
let idleActive = false;

function idleEaseInOut(t) {
  t = clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
}

function idleLerp(a, b, t) {
  return a + (b - a) * t;
}

function sampleIdleState(loopTime) {
  let a = idleKeyframes[0];
  let b = idleKeyframes[1];

  for (let i = 0; i < idleKeyframes.length - 1; i++) {
    if (loopTime >= idleKeyframes[i].t && loopTime <= idleKeyframes[i + 1].t) {
      a = idleKeyframes[i];
      b = idleKeyframes[i + 1];
      break;
    }
  }

  const u = idleEaseInOut((loopTime - a.t) / (b.t - a.t));

  return {
    x: idleLerp(a.x, b.x, u),
    y: idleLerp(a.y, b.y, u),
    r: idleLerp(a.r, b.r, u),
    tail: idleLerp(a.tail, b.tail, u),
    lower: idleLerp(a.lower, b.lower, u),
    lf: idleLerp(a.lf, b.lf, u),
    rf: idleLerp(a.rf, b.rf, u),
    dorsal: idleLerp(a.dorsal, b.dorsal, u),
  };
}

function updateIdleShark(dt, now) {
  const speed = length2D(sharkVX, sharkVY);
  const settled = speed < IDLE_SPEED_THRESHOLD;

  if (settled) {
    if (idleEligibleSince === null) idleEligibleSince = now;

    if (!idleActive && now - idleEligibleSince >= IDLE_ENTRY_DELAY_MS) {
      idleActive = true;
      idlePhaseStart = now; // always enter the idle loop from exact rest
    }
  } else {
    idleEligibleSince = null;
    idleActive = false;
  }

  const targetBlend = idleActive ? 1 : 0;
  const blendRate = idleActive ? IDLE_BLEND_IN_RATE : IDLE_BLEND_OUT_RATE;
  const blendStep = 1 - Math.exp(-blendRate * dt);
  idleBlend += (targetBlend - idleBlend) * blendStep;

  const phase = idleActive
    ? (now - idlePhaseStart) % IDLE_LOOP_MS
    : 0;

  const s = sampleIdleState(phase);
  const b = idleBlend;

  const x = s.x * IDLE_DRIFT_VISIBILITY * b;
  const y = s.y * IDLE_DRIFT_VISIBILITY * b;
  const bodyR = s.r * IDLE_ROTATION_VISIBILITY * b;

  sharkMotion.style.transform =
    `translate(${x}px, ${y}px) rotate(${bodyR}deg)`;

  sharkParts.tail.style.transform =
    `rotate(${s.tail * IDLE_ROTATION_VISIBILITY * b}deg)`;

  sharkParts.lower.style.transform =
    `rotate(${s.lower * IDLE_ROTATION_VISIBILITY * b}deg)`;

  sharkParts.leftFin.style.transform =
    `rotate(${s.lf * IDLE_ROTATION_VISIBILITY * b}deg)`;

  sharkParts.rightFin.style.transform =
    `rotate(${s.rf * IDLE_ROTATION_VISIBILITY * b}deg)`;

  sharkParts.dorsalA.style.transform =
    `rotate(${s.dorsal * IDLE_ROTATION_VISIBILITY * b}deg)`;

  sharkParts.dorsalB.style.transform =
    `rotate(${s.dorsal * IDLE_ROTATION_VISIBILITY * b}deg)`;

  // Shadow has smaller displacement than the animal, creating depth.
  sharkShadow.style.transform =
    `translate(-50%, -50%) translate(${10 + x * 0.35}px, ${12 + y * 0.35}px) rotate(${-3 + bodyR * 0.30}deg)`;
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
const SHARK_FRONT_ANTICIPATION = 180;
const SHARK_REAR_INFLUENCE = 72;
const SHARK_SIDE_INFLUENCE = 68;
const SHARK_LATERAL_ACCEL = 390;
const SHARK_SPEED_LATERAL_GAIN = 0.58;
const SHARK_NORMAL_ACCEL = 165;
const HARD_BODY_MARGIN = 12;

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

function refreshSharkBodySize() {
  // The locomotion/collision footprint remains exactly 341 x 192.
  // Idle articulation is visual only and does not destabilize the fish field.
  const width = whaleShark.offsetWidth || 341;
  const height = whaleShark.offsetHeight || 192;

  sharkBodyHalfLength = width * 0.3 + HARD_BODY_MARGIN;
  sharkBodyHalfWidth = height * 0.35 + HARD_BODY_MARGIN;
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

    fishAlert[i] = Math.max(
      sharkInfluence,
      fishAlert[i] * Math.exp(-ALERT_DECAY * dt)
    );

    const pressurePermission = 1 - sharkInfluence * 0.82;
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

  refreshSharkBodySize();
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

  updateShark(dt);
  updateCamera(dt);
  updateWorldWindow();
  updateSchool(dt, simulationTime);
  drawSchool();
  renderBackground();
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
refreshSharkBodySize();
updateWorldWindow();
buildSchool();
renderBackground();
renderShark();
updateIdleShark(0, performance.now());
requestAnimationFrame(animate);
