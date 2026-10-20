import * as THREE from './three.module.min.js';
import { D0, GUEST_DEFS, IMG_KEYS, Guest, pickByTime } from './actors.js?v=4';
import { Segmenter, Gestures, MotionEnergy } from './sense.js?v=4';

/* ============================================================
   Monster AR  v4
   ・おに3匹はいつもいる。ほかのおばけは「時間帯」か「撮られている人の動き」で出てくる
   ・自分で撮る(インカメ) … 画面に固定。人を切り抜いて、おにが肩の後ろからのぞく/頭にのる
   ・撮ってもらう(外カメ) … ジャイロで床に固定(これまでと同じ)
   ============================================================ */

const DEG = Math.PI / 180;
const CAM_HEIGHT = 1.3;
const BASE_H = 0.4;               // おに(外カメ)の高さ m
const FRONT_ONI_H = 0.36;         // おに(自撮り)の高さ m @D0
const SPRITE_ASPECT = 240 / 192;
const VIDEO_VFOV = 63, VFOV_FRONT = 66;
const POSE_SEQ = [1, 2, 3, 2], POSE_FPS = 5, MOVE_SPEED = 1.1;
const ONI = ['r', 'b', 'g'];
const BACK_D = 2.2, FRONT_D = 1.15;       // 自撮りでの奥行き(人の後ろ/前)
const MAX_GUESTS = 5;

const $ = (s) => document.querySelector(s);
const video = $('#cam'), glCanvas = $('#gl'), statusEl = $('#status'), hintEl = $('#hint');

/* ---------- three.js ---------- */
const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, alpha: true, antialias: true });
renderer.setClearColor(0x000000, 0);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(VIDEO_VFOV, 1, 0.05, 60);
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const bodyGeo = new THREE.PlaneGeometry(1, 1); bodyGeo.translate(0, 0.5, 0);
const flatGeo = new THREE.PlaneGeometry(1, 1); flatGeo.rotateX(-Math.PI / 2);

function radialTexture(draw) {
  const c = document.createElement('canvas'); c.width = c.height = 128; draw(c.getContext('2d'));
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const shadowTex = radialTexture((g) => {
  const r = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  r.addColorStop(0, 'rgba(0,0,0,0.85)'); r.addColorStop(0.55, 'rgba(0,0,0,0.38)'); r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
});
const ringTex = radialTexture((g) => {
  g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineWidth = 5; g.beginPath(); g.arc(64, 64, 56, 0, Math.PI * 2); g.stroke();
});

/* ---------- 状態 ---------- */
let mode = null;                       // 'front' | 'rear'
const isFront = () => mode === 'front';
const mons = [];                       // おに
const guests = [];                     // ゲストのおばけ
const gtex = {};                       // ゲストのテクスチャ
let selected = null, paused = false, animT = 0, lightMul = 1, started = false;
let floorY = -CAM_HEIGHT, rearD = 2.6;
let pendingSpawn = false, spawnReqAt = 0;
let camStream = null, facing = 'environment';
const curVfov = () => (isFront() ? VFOV_FRONT : VIDEO_VFOV);

const gyro = { has: false, alpha: 0, beta: 0, gamma: 0 };
const devQ = new THREE.Quaternion(), yawFix = new THREE.Quaternion(), tmpQ = new THREE.Quaternion();
let needYawInit = true, snapCamera = true, motionAsked = false;

/* ---------- 人の切り抜き(自撮りだけ) ---------- */
const seg = new Segmenter(video);
const maskTex = new THREE.CanvasTexture(seg.mask);
const videoTex = new THREE.VideoTexture(video);
videoTex.colorSpace = THREE.NoColorSpace;
const personMat = new THREE.ShaderMaterial({
  transparent: true, depthTest: false, depthWrite: false,
  uniforms: { uVideo: { value: videoTex }, uMask: { value: maskTex }, uCrop: { value: new THREE.Vector2(1, 1) } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `uniform sampler2D uVideo; uniform sampler2D uMask; uniform vec2 uCrop; varying vec2 vUv;
    void main(){ vec2 uv = (vUv - 0.5) * uCrop + 0.5;
      float a = smoothstep(0.30, 0.72, texture2D(uMask, uv).a);
      gl_FragColor = vec4(texture2D(uVideo, uv).rgb, a); }`,
});
const personMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), personMat);
personMesh.frustumCulled = false; personMesh.renderOrder = 20; personMesh.visible = false;
scene.add(personMesh);
let segActive = false, feature = null, headNdc = null;

function videoToNdc(u, v) {          // 映像内の位置(0..1, 上が0) → 画面のNDC(左右反転前の座標)
  const c = personMat.uniforms.uCrop.value;
  return { x: ((u - 0.5) / c.x + 0.5) * 2 - 1, y: (((1 - v) - 0.5) / c.y + 0.5) * 2 - 1 };
}
function onMask(f) {
  feature = f;
  maskTex.needsUpdate = true;
  if (f) {
    const top = videoToNdc(f.cx, f.top);
    headNdc = { x: top.x, y: top.y, w: (f.headW / personMat.uniforms.uCrop.value.x) * 2 };
  } else headNdc = null;
  gestures.push(f, performance.now());
}
seg.onMask = (f) => { if (seg.failed) { setSegActive(false); return; } onMask(f); };
function setSegActive(on) {
  segActive = on && seg.ready && !seg.failed && isFront();
  personMesh.visible = segActive;
  if (segActive) seg.start(); else { seg.stop(); feature = null; headNdc = null; }
}

/* ---------- 動き(ジェスチャー) ---------- */
let lastGesture = 0;
const gestures = new Gestures((name) => triggerGesture(name));
const motionEn = new MotionEnergy(video);
const GESTURE_NAMES = { raise: '両手を上げた', close: '近づいた', sway: '左右にゆれた', move: '大きく動いた' };
function triggerGesture(name) {
  if (!started || recordingBusy()) return;
  const alive = guests.filter((g) => !g.dead).length;
  if (alive >= MAX_GUESTS + 2) return;
  lastGesture = performance.now();
  if (name === 'raise') { spawnGuest('chochin'); if (Math.random() < 0.6) spawnGuest('hitodama'); }
  else if (name === 'close') spawnGuest('umibozu');
  else if (name === 'sway') spawnPair();
  else if (name === 'move') spawnGuest(pickByTime(['umibozu']));
}
const recordingBusy = () => false;

/* ---------- ステージ(どこに出すか) ---------- */
function ndcToWorld(nx, ny, d, out) {
  const th = Math.tan(camera.fov * DEG / 2);
  return out.set(nx * d * th * camera.aspect, ny * d * th, -d);
}
const _f = new THREE.Vector3(), _right = new THREE.Vector3(), _g = new THREE.Vector3();
function anchor(zone, layer) {
  const th = Math.tan(camera.fov * DEG / 2);
  if (isFront()) {
    const d = zone === 'center' ? 2.3 : zone === 'sky' ? 2.4 : layer === 'front' ? FRONT_D : BACK_D;
    const ny = { ground: -0.80, sky: 0.55, center: -1.0, edge: -0.50 }[zone];
    return { c: new THREE.Vector3(0, ny * d * th, -d), right: new THREE.Vector3(1, 0, 0), hw: d * th * camera.aspect, k: d / D0 };
  }
  camera.getWorldDirection(_f); _f.y = 0;
  if (_f.lengthSq() < 1e-4) _f.set(0, 0, -1);
  _f.normalize();
  const c = _f.clone().multiplyScalar(rearD); c.y = floorY + (zone === 'sky' ? 0.85 : 0);
  return { c, right: new THREE.Vector3(-_f.z, 0, _f.x), hw: rearD * th * camera.aspect, k: 1 };
}
const ctx = {
  scene, flatGeo, shadowTex, mode: () => mode, lightMul: () => lightMul, anchor,
  order: (layer) => (isFront() ? (layer === 'front' ? 30 : 10) : 10),
};

/* ---------- ゲストを出す ---------- */
function spawnGuest(key, opt = {}) {
  const def = GUEST_DEFS[key];
  if (!def) return null;
  const alive = guests.filter((g) => !g.dead).length;
  const n = key === 'chochin' ? 2 + (Math.random() < 0.5 ? 1 : 0) : key === 'hitodama' ? 1 + (Math.random() < 0.5 ? 1 : 0) : 1;
  const imgKey = def.img[Math.floor(Math.random() * def.img.length)];
  const tex = gtex[imgKey];
  if (!tex || alive + n > MAX_GUESTS + 2) return null;
  const made = [];
  for (let i = 0; i < n; i++) {
    const o = { ...opt, delay: i * 0.45 };
    if (key === 'chochin') { o.s0 = (i - (n - 1) / 2) * 0.6 + (Math.random() - 0.5) * 0.15; o.ph = i * 2.1; }
    if (key === 'umibozu') o.xc = headNdc ? THREE.MathUtils.clamp(headNdc.x + (Math.random() < 0.5 ? -0.5 : 0.5), -0.7, 0.7) : 0;
    const g = new Guest(ctx, key, tex, o);
    guests.push(g); made.push(g);
  }
  if (!opt.quiet) toast(`${def.name}が出てきた`);
  seen.add(key); updateCount();
  return made;
}
function spawnPair() {
  const side = Math.random() < 0.5 ? -1 : 1;
  if (!gtex.tanuki || !gtex.kitsune) return;
  guests.push(new Guest(ctx, 'tanuki', gtex.tanuki, { side, dir: side }));
  guests.push(new Guest(ctx, 'kitsune', gtex.kitsune, { side, dir: side, delay: 0.5, ph: 1.7 }));
  seen.add('tanuki'); seen.add('kitsune'); updateCount();
  toast('狸と狐が出てきた');
}
const seen = new Set();
function updateCount() { $('#count').textContent = `おばけ ${seen.size}/${Object.keys(GUEST_DEFS).length}`; }
let toastTimer = 0;
function toast(msg) {
  statusEl.textContent = msg; statusEl.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => statusEl.classList.remove('on'), 2200);
}

/* 時間帯に合わせて、ときどき勝手に出てくる */
let nextAmbient = 0;
function ambient(now) {
  if (now < nextAmbient) return;
  nextAmbient = now + 7000 + Math.random() * 6000;
  const alive = guests.filter((g) => !g.dead).length;
  if (alive >= 2) return;
  const key = pickByTime();
  if (key === 'tanuki') spawnPair(); else spawnGuest(key);
}

/* ---------- おに ---------- */
class Mon {
  constructor(id, idx, textures) {
    this.id = id; this.idx = idx; this.tex = textures[id];
    this.group = new THREE.Group();
    this.mat = new THREE.MeshBasicMaterial({ map: this.tex[1], transparent: true, depthWrite: false, depthTest: false });
    this.body = new THREE.Mesh(bodyGeo, this.mat);
    this.body.renderOrder = 10; this.body.userData.mon = this;
    this.shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, depthTest: false });
    this.shadow = new THREE.Mesh(flatGeo, this.shadowMat);
    this.shadow.position.y = 0.004; this.shadow.renderOrder = 4;
    this.ringMat = new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, depthWrite: false, depthTest: false, opacity: 0 });
    this.ring = new THREE.Mesh(flatGeo, this.ringMat);
    this.ring.position.y = 0.006; this.ring.renderOrder = 4;
    this.group.add(this.shadow, this.ring, this.body);
    scene.add(this.group);
    this.pos = this.group.position;
    this.sizeK = id === 'g' ? 0.85 : 1;
    this.flip = 1; this.flipTo = 1;
    this.target = null; this.dragTarget = null; this.carried = false;
    this.react = 0; this.dropT = 0; this.hop = 0; this.hopY = 0; this.carryY = 0;
    this.phase = idx * 0.37; this.pose = 2;
    // 自撮り: 画面上の位置(NDC)
    this.nx = 0; this.ny = -0.5; this.hx = 0; this.hy = -0.5; this.ux = 0; this.uy = 0;
  }
  poke() { this.react = 0.7; }
  drop(delay) { this.dropT = 0.55 + delay; }
  setPose(p) { if (p !== this.pose) { this.pose = p; this.mat.map = this.tex[p]; } }
  update(dt, t, camRight) {
    const kFast = 1 - Math.exp(-dt * 18);
    const front = isFront();
    let moving = false;
    let d = BACK_D, depthK = 1;
    if (front) {
      d = BACK_D; depthK = d / D0;
      const kk = 1 - Math.exp(-dt * 5);
      this.nx += (this.hx + this.ux - this.nx) * kk; this.ny += (this.hy + this.uy - this.ny) * kk;
      ndcToWorld(this.nx, this.ny, d, this.pos);
    } else if (this.carried && this.dragTarget) {
      this.pos.x += (this.dragTarget.x - this.pos.x) * kFast; this.pos.z += (this.dragTarget.z - this.pos.z) * kFast;
    } else if (this.target) {
      const dx = this.target.x - this.pos.x, dz = this.target.z - this.pos.z, dist = Math.hypot(dx, dz);
      if (dist < 0.04) this.target = null;
      else {
        moving = true;
        const step = Math.min(dist, MOVE_SPEED * dt);
        this.pos.x += dx / dist * step; this.pos.z += dz / dist * step;
        this.hop += dt * 3.4;
        this.flipTo = (dx * camRight.x + dz * camRight.z) > 0 ? -1 : 1;
      }
    }
    const hopTarget = moving ? Math.abs(Math.sin(Math.PI * this.hop)) * 0.13 : 0;
    this.hopY += (hopTarget - this.hopY) * (moving ? 0.6 : kFast);
    if (!moving) this.hop = 0;
    this.carryY += ((this.carried ? 0.13 : 0) - this.carryY) * kFast;

    let reactY = 0, squash = 0;
    if (this.react > 0) {
      this.react = Math.max(0, this.react - dt);
      const u = 1 - this.react / 0.7;
      reactY = 0.26 * Math.sin(Math.PI * u);
      squash = u < 0.15 ? -(1 - u / 0.15) * 0.1 : u > 0.85 ? -((u - 0.85) / 0.15) * 0.1 : 0.06;
    }
    let dropY = 0;
    if (this.dropT > 0) {
      this.dropT -= dt;
      dropY = 1.4 * Math.pow(Math.max(0, Math.min(1, this.dropT / 0.7)), 2);
      if (this.dropT <= 0) this.react = 0.4;
    }
    const f = t * POSE_FPS + this.phase * 4;
    let pose;
    if (this.carried || this.react > 0.2) pose = 3;
    else if (moving) pose = (Math.floor(this.hop * 2) % 2 === 0) ? 1 : 2;
    else pose = POSE_SEQ[((Math.floor(f) % 4) + 4) % 4];
    this.setPose(pose);

    const beat = f - Math.floor(f);
    const bounce = (moving || this.carried) ? 0 : Math.sin(Math.PI * beat);
    const baseH = front ? FRONT_ONI_H : BASE_H;
    const sz = this.sizeK * depthK;
    const lift = (bounce * 0.025 * baseH / BASE_H + this.hopY + this.carryY + reactY + dropY) * sz;

    this.flip += (this.flipTo - this.flip) * (1 - Math.exp(-dt * 14));
    const h = baseH * sz;
    const sy = 1 + 0.045 * bounce + squash;
    const sx = (1 - 0.03 * bounce - squash * 0.6) * this.flip;
    this.body.scale.set(h * SPRITE_ASPECT * sx, h * sy, 1);
    this.body.position.y = lift;
    this.group.rotation.y = 0;
    this.body.rotation.y = Math.atan2(-this.pos.x, -this.pos.z);
    this.body.rotation.z = this.carried ? Math.sin(t * 14) * 0.1 : 0;

    this.shadow.visible = !front; this.ring.visible = !front;
    if (!front) {
      const air = Math.min(1, (lift / sz) / 0.5);
      const sw = baseH * 1.05 * sz * (1 - 0.35 * air);
      this.shadow.scale.set(sw, 1, sw);
      this.shadowMat.opacity = 0.42 * (1 - 0.6 * air) * Math.min(1, lightMul + 0.2);
      const rs = baseH * 1.25 * sz * (1 + 0.04 * Math.sin(t * 5));
      this.ring.scale.set(rs, 1, rs);
      this.ringMat.opacity = this === selected ? 0.8 : 0;
    }
    this.mat.color.setScalar(lightMul);
  }
}

/* ---------- 床との交点 / 画面との交点 ---------- */
function setNdc(cx, cy) {
  const x = cx / innerWidth * 2 - 1;
  ndc.set(isFront() ? -x : x, -(cy / innerHeight) * 2 + 1);
}
function groundPoint(cx, cy, out) {
  setNdc(cx, cy);
  raycaster.setFromCamera(ndc, camera);
  const dd = raycaster.ray.direction, o = raycaster.ray.origin;
  if (dd.y > -0.03) return null;
  const hz = Math.hypot(dd.x, dd.z) || 1e-6;
  let tt = (floorY - o.y) / dd.y;
  tt = Math.min(Math.max(tt, 0.7 / hz), 9 / hz);
  out.copy(o).addScaledVector(dd, tt); out.y = floorY;
  return out;
}
function pick(cx, cy) {
  setNdc(cx, cy);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(mons.map((m) => m.body), false);
  return hits.length ? hits[0].object.userData.mon : null;
}
const select = (m) => { selected = m; };

/* ---------- おにの置き場所 ---------- */
function defaultHomes() {
  return [[-0.58, -0.42], [0.58, -0.42], [0.0, -0.62]];
}
function updateHomes() {
  if (!isFront()) return;
  const clampX = (x) => Math.max(-0.82, Math.min(0.82, x));
  if (headNdc && segActive) {
    const { x, y } = headNdc;
    const homes = [[x - 0.55, y - 0.55], [x + 0.55, y - 0.55], [x + 0.02, y - 0.1]];
    mons.forEach((m, i) => { m.hx = clampX(homes[i][0]); m.hy = Math.max(-0.9, Math.min(0.85, homes[i][1])); });
  } else {
    const h = defaultHomes();
    mons.forEach((m, i) => { m.hx = h[i][0]; m.hy = h[i][1]; });
  }
}
function spawnAll() { pendingSpawn = true; spawnReqAt = performance.now(); }
function doSpawn() {
  pendingSpawn = false;
  if (isFront()) {
    updateHomes();
    mons.forEach((m, i) => { m.nx = m.hx; m.ny = m.hy; m.ux = m.uy = 0; m.target = null; m.carried = false; m.drop(i * 0.18); });
    return;
  }
  camera.getWorldDirection(_f);
  const pitch = Math.asin(Math.max(-1, Math.min(1, _f.y)));
  const down = Math.atan(0.44 * Math.tan(camera.fov * DEG / 2));
  const depr = Math.max(down - pitch, 0.14);
  const d = Math.min(3.6, Math.max(2.0, CAM_HEIGHT / Math.tan(depr)));
  floorY = -Math.min(1.6, Math.max(0.45, d * Math.tan(depr)));
  rearD = d;
  const slots = [[-0.4, d], [0, d + 0.3], [0.4, d]];
  mons.forEach((m, i) => {
    m.pos.set(slots[i][0], floorY, -slots[i][1]);
    m.target = null; m.carried = false; m.dragTarget = null; m.drop(i * 0.18);
  });
}

/* ---------- カメラ(ジャイロ。外カメだけ) ---------- */
const _zee = new THREE.Vector3(0, 0, 1), _euler = new THREE.Euler(), _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  return typeof window.orientation === 'number' ? window.orientation : 0;
}
function deviceQuat(q) {
  _euler.set(gyro.beta * DEG, gyro.alpha * DEG, -gyro.gamma * DEG, 'YXZ');
  q.setFromEuler(_euler); q.multiply(_q1); q.multiply(_q0.setFromAxisAngle(_zee, -screenAngle() * DEG));
  return q;
}
function initYaw() {
  deviceQuat(devQ);
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(devQ);
  let h = f;
  if (Math.abs(f.y) > 0.85) { const u = new THREE.Vector3(0, 1, 0).applyQuaternion(devQ); h = f.y < 0 ? u : u.negate(); }
  yawFix.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.atan2(-h.x, -h.z));
  needYawInit = false; snapCamera = true;
}
function updateCamera(dt) {
  if (isFront()) { camera.quaternion.identity(); return; }
  if (!gyro.has) return;
  if (needYawInit) initYaw();
  deviceQuat(devQ);
  tmpQ.copy(yawFix).multiply(devQ);
  if (snapCamera) { camera.quaternion.copy(tmpQ); snapCamera = false; }
  else camera.quaternion.slerp(tmpQ, 1 - Math.exp(-dt * 30));
}
addEventListener('deviceorientation', (e) => {
  if (e.alpha == null || e.beta == null) return;
  gyro.alpha = e.alpha; gyro.beta = e.beta; gyro.gamma = e.gamma || 0; gyro.has = true;
});
async function askMotion() {
  if (motionAsked) return;
  motionAsked = true;
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') await DeviceOrientationEvent.requestPermission();
  } catch (e) { /* 拒否されても続行 */ }
}

/* ---------- 画面サイズ・画角 ---------- */
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  const va = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 9 / 16;
  const sa = w / h, vf = curVfov();
  camera.fov = sa <= va ? vf : 2 * Math.atan(Math.tan(vf * DEG / 2) * va / sa) / DEG;
  camera.aspect = sa; camera.updateProjectionMatrix();
  personMat.uniforms.uCrop.value.set(sa <= va ? sa / va : 1, sa <= va ? 1 : va / sa);
}
addEventListener('resize', resize);
video.addEventListener('loadedmetadata', resize);
video.addEventListener('resize', resize);

/* ---------- 明るさを背景に合わせる ---------- */
const lc = document.createElement('canvas'); lc.width = lc.height = 16;
const lctx = lc.getContext('2d', { willReadFrequently: true });
let lightT = 0;
function sampleLight(now) {
  if (now - lightT < 400 || !video.videoWidth) return;
  lightT = now;
  try {
    lctx.drawImage(video, 0, 0, 16, 16);
    const d = lctx.getImageData(0, 0, 16, 16).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    lightMul += (Math.min(1, Math.max(0.55, 0.5 + 0.8 * s / 256)) - lightMul) * 0.15;
  } catch (e) { /* 補正しない */ }
}

/* ---------- 撮影(映像+3Dを合成) ---------- */
const comp = document.createElement('canvas'), cctx = comp.getContext('2d');
let compMax = 2400;
function composite() {
  const W = glCanvas.width, H = glCanvas.height;
  const sc = Math.min(1, compMax / Math.max(W, H));
  const cw = Math.max(2, Math.round(W * sc / 2) * 2), ch = Math.max(2, Math.round(H * sc / 2) * 2);
  if (comp.width !== cw || comp.height !== ch) { comp.width = cw; comp.height = ch; }
  const vw = video.videoWidth, vh = video.videoHeight;
  cctx.save();
  if (isFront()) { cctx.translate(cw, 0); cctx.scale(-1, 1); }
  if (vw) { const s = Math.max(cw / vw, ch / vh); cctx.drawImage(video, (cw - vw * s) / 2, (ch - vh * s) / 2, vw * s, vh * s); }
  else { cctx.fillStyle = '#111'; cctx.fillRect(0, 0, cw, ch); }
  cctx.drawImage(glCanvas, 0, 0, cw, ch);
  cctx.restore();
}
let photoReq = false, recording = false, recorder = null, chunks = [], recStart = 0, recTimer = 0, capMode = 'photo';
let resultBlob = null, resultName = '', resultURL = '';
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function pickMime() {
  if (!window.MediaRecorder) return '';
  return ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
}
function showResult(kind, blob) {
  if (resultURL) URL.revokeObjectURL(resultURL);
  resultBlob = blob; resultURL = URL.createObjectURL(blob);
  resultName = `monsters-${stamp()}.${kind === 'photo' ? 'jpg' : (blob.type.includes('mp4') ? 'mp4' : 'webm')}`;
  const box = $('#resultMedia'); box.textContent = '';
  const el = document.createElement(kind === 'photo' ? 'img' : 'video');
  el.src = resultURL;
  if (kind === 'video') { el.controls = true; el.playsInline = true; el.loop = true; el.autoplay = true; el.muted = true; }
  box.appendChild(el);
  $('#resultNote').textContent = kind === 'photo' ? '画像を長押しして保存もできます。' : '';
  $('#result').hidden = false;
}
function takePhoto() {
  select(null); compMax = 2400; photoReq = true;
  const fl = $('#flash'); fl.classList.remove('go'); void fl.offsetWidth; fl.classList.add('go');
}
function startRecording() {
  const mime = pickMime();
  if (!window.MediaRecorder || !comp.captureStream) { flash('この端末では動画を撮れません'); return; }
  select(null); compMax = 1280; composite();
  const stream = comp.captureStream(30);
  try { recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6_000_000 } : undefined); }
  catch (e) { flash('動画の録画を開始できませんでした'); return; }
  chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    const type = recorder.mimeType || mime || 'video/webm';
    stream.getTracks().forEach((t) => t.stop());
    if (chunks.length) showResult('video', new Blob(chunks, { type }));
  };
  recorder.start(400);
  recording = true; recStart = performance.now();
  document.body.classList.add('recording'); $('#rec').classList.add('on');
  recTimer = setInterval(() => {
    const s = Math.floor((performance.now() - recStart) / 1000);
    $('#recTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (s >= 60) stopRecording();
  }, 250);
}
function stopRecording() {
  if (!recording) return;
  recording = false; clearInterval(recTimer);
  document.body.classList.remove('recording'); $('#rec').classList.remove('on'); $('#recTime').textContent = '0:00';
  try { recorder.stop(); } catch (e) { /* 既に停止 */ }
}

/* ---------- UI ---------- */
let flashTimer = 0;
function flash(msg, ms = 5000) {
  statusEl.textContent = msg; statusEl.classList.add('on');
  clearTimeout(flashTimer); clearTimeout(toastTimer);
  if (ms) flashTimer = setTimeout(() => statusEl.classList.remove('on'), ms);
}
function setCapMode(m) {
  if (recording) return;
  capMode = m; document.body.classList.toggle('video', m === 'video');
  $('#modePhoto').setAttribute('aria-pressed', String(m === 'photo'));
  $('#modeVideo').setAttribute('aria-pressed', String(m === 'video'));
}
$('#modePhoto').onclick = () => setCapMode('photo');
$('#modeVideo').onclick = () => setCapMode('video');
$('#shutter').onclick = () => { if (capMode === 'photo') takePhoto(); else recording ? stopRecording() : startRecording(); };
$('#recall').onclick = () => { needYawInit = true; spawnAll(); flash('おにを集め直しました', 2200); };
$('#pause').onclick = () => {
  paused = !paused;
  $('#pauseIco').innerHTML = paused ? '<path d="M8 5l11 7-11 7z"/>' : '<path d="M9 5v14M15 5v14"/>';
};
$('#closeBtn').onclick = () => { $('#result').hidden = true; $('#resultMedia').textContent = ''; };
$('#shareBtn').onclick = async () => {
  if (!resultBlob) return;
  const file = new File([resultBlob], resultName, { type: resultBlob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = resultURL; a.download = resultName;
  document.body.appendChild(a); a.click(); a.remove();
};

/* ヒント: 見つけ方を、ゆっくり入れ替えて見せる */
const HINTS = {
  front: ['両手を上げてみて', 'ぐっと近づいてみて', '左右にゆれてみて', 'おにをつまんで動かせるよ'],
  rear: ['おにをタップすると動くよ', 'おにをつまんで運べるよ', 'スマホをゆっくり動かしてみて'],
};
let hintIdx = 0, hintAt = 0;
function hintTick(now) {
  if (!started) return;
  if (now - lastGesture < 9000) { hintEl.classList.add('off'); return; }
  if (now - hintAt > 7000) {
    hintAt = now;
    const list = HINTS[mode];
    hintEl.textContent = list[hintIdx++ % list.length];
    hintEl.classList.remove('off');
  } else if (now - hintAt > 5000) hintEl.classList.add('off');
}

/* ---------- 操作(タップ・つまむ・ピンチ) ---------- */
const pointers = new Map();
let drag = null, pinch = null;
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function ptrNdc(cx, cy) { const x = cx / innerWidth * 2 - 1; return { x: isFront() ? -x : x, y: -(cy / innerHeight) * 2 + 1 }; }

glCanvas.addEventListener('pointerdown', (e) => {
  if (!started) return;
  glCanvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    const m = pick(e.clientX, e.clientY);
    drag = { mon: m, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false, off: new THREE.Vector3(), go: { x: 0, y: 0 } };
    if (m) {
      select(m); m.poke(); m.carried = true; m.target = null;
      if (isFront()) { const p = ptrNdc(e.clientX, e.clientY); drag.go = { x: m.nx - p.x, y: m.ny - p.y }; }
      else {
        m.dragTarget = m.pos.clone();
        const g = groundPoint(e.clientX, e.clientY, _g);
        if (g) drag.off.set(m.pos.x - g.x, 0, m.pos.z - g.z);
      }
    }
  } else if (pointers.size === 2) {
    if (drag && drag.mon) { drag.mon.carried = false; drag.mon.dragTarget = null; }
    drag = null;
    const [a, b] = [...pointers.values()];
    pinch = { d0: dist2(a, b) || 1, mon: selected, base: selected ? selected.sizeK : 1, all: mons.map((m) => m.sizeK) };
  }
});
glCanvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const k = dist2(a, b) / pinch.d0;
    if (pinch.mon) pinch.mon.sizeK = Math.min(3, Math.max(0.4, pinch.base * k));
    else mons.forEach((m, i) => { m.sizeK = Math.min(3, Math.max(0.4, pinch.all[i] * k)); });
  } else if (drag) {
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 10) drag.moved = true;
    if (drag.mon && drag.moved) {
      if (isFront()) {
        const p = ptrNdc(e.clientX, e.clientY), m = drag.mon;
        m.ux = p.x + drag.go.x - m.hx; m.uy = p.y + drag.go.y - m.hy;
      } else {
        const g = groundPoint(e.clientX, e.clientY, _g);
        if (g) drag.mon.dragTarget.set(g.x + drag.off.x, floorY, g.z + drag.off.z);
      }
    }
  }
});
function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (drag && pointers.size === 0) {
    if (drag.mon) { drag.mon.carried = false; drag.mon.dragTarget = null; }
    else if (!isFront() && !drag.moved && performance.now() - drag.t0 < 500 && e.type === 'pointerup') {
      const g = groundPoint(e.clientX, e.clientY, _g);
      if (g) {
        let m = selected;
        if (!m) m = mons.reduce((best, c) => (Math.hypot(c.pos.x - g.x, c.pos.z - g.z) < Math.hypot(best.pos.x - g.x, best.pos.z - g.z) ? c : best), mons[0]);
        m.target = g.clone();
      }
    }
    drag = null;
  }
  if (pinch && pointers.size < 2) pinch = null;
}
glCanvas.addEventListener('pointerup', endPointer);
glCanvas.addEventListener('pointercancel', endPointer);

/* ---------- メインループ ---------- */
let last = 0, shakeQ = new THREE.Quaternion(), shaky = false, shakeT = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000 || 0.016); last = now;
  updateCamera(dt);
  if (pendingSpawn && (isFront() || gyro.has || performance.now() - spawnReqAt > 800)) doSpawn();
  if (!paused) animT += dt;

  camera.getWorldDirection(_f);
  _right.set(-_f.z, 0, _f.x).normalize();
  updateHomes();
  for (const m of mons) m.update(dt, animT, _right);
  for (let i = guests.length - 1; i >= 0; i--) { const g = guests[i]; if (!paused) g.update(dt); if (g.dead) guests.splice(i, 1); }
  sampleLight(now);

  // 動きの検出: 切り抜きが使えるときは seg 側、そうでなければ映像の変化量
  seg.tick(now);
  if (now - shakeT > 120) { shaky = camera.quaternion.angleTo(shakeQ) > 0.06; shakeQ.copy(camera.quaternion); shakeT = now; }
  if (started && !segActive && motionEn.sample(now, shaky) && now - lastGesture > 6500) triggerGesture('move');
  if (started) ambient(now);
  hintTick(now);

  renderer.render(scene, camera);
  if (photoReq || recording) {
    composite();
    if (photoReq) { photoReq = false; comp.toBlob((b) => { if (b) showResult('photo', b); }, 'image/jpeg', 0.93); }
  }
}

/* ---------- カメラ ---------- */
async function openCamera(want) {
  if (camStream) {                           // Androidは前後を同時に開けない
    camStream.getTracks().forEach((t) => t.stop()); camStream = null; video.srcObject = null;
    await new Promise((r) => setTimeout(r, 250));
  }
  const base = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { ...base, facingMode: { exact: want } }, audio: false }); }
  catch (e) { stream = await navigator.mediaDevices.getUserMedia({ video: { ...base, facingMode: { ideal: want } }, audio: false }); }
  camStream = stream; facing = want;
  document.body.classList.toggle('front', want === 'user');
  video.srcObject = stream;
  await video.play();
  resize();
}
/* モードを切り替える(自撮り↔外カメ)。おばけは一度片付けて、おにだけ置き直す */
function enterMode(m) {
  mode = m;
  guests.forEach((g) => g.dispose()); guests.length = 0;
  for (const mo of mons) { mo.carried = false; mo.target = null; mo.ux = mo.uy = 0; mo.group.visible = true; }
  resize();
  setSegActive(m === 'front' && seg.ready && !seg.failed);
  nextAmbient = performance.now() + 4500; hintAt = 0; hintIdx = 0; lastGesture = 0;
  needYawInit = true; snapCamera = true;
  spawnAll();
}
let segInitStarted = false;
function ensureSeg() {                    // 切り抜きは裏で準備。できるまでは通常表示
  if (segInitStarted || seg.failed) return;
  segInitStarted = true;
  if (isFront()) flash('おばけを準備中…', 0);
  seg.init().then((ok) => {
    if (statusEl.textContent === 'おばけを準備中…') statusEl.classList.remove('on');
    if (ok && isFront()) setSegActive(true);
  });
}
let switching = false;
async function switchCamera() {
  if (switching || recording || !started) return;
  switching = true;
  const prevMode = mode, want = prevMode === 'front' ? 'rear' : 'front';
  try {
    if (want === 'rear') await askMotion();
    await openCamera(want === 'front' ? 'user' : 'environment');
    enterMode(want);
    if (want === 'front') { if (seg.ready) setSegActive(true); else ensureSeg(); }
    flash(want === 'front' ? 'インカメラ' : '外カメラ(スマホを少し床へ向けてね)', 2600);
  } catch (e) {
    flash(`カメラを切り替えられませんでした(${(e && e.name) || 'エラー'})`, 5000);
    try { await openCamera(prevMode === 'front' ? 'user' : 'environment'); } catch (e2) { /* 元にも戻せない */ }
  } finally { switching = false; }
}
$('#flip').onclick = switchCamera;

/* ---------- 起動 ---------- */
async function loadAll() {
  const loader = new THREE.TextureLoader(), aniso = renderer.capabilities.getMaxAnisotropy();
  const prep = (t) => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = aniso; return t; };
  const out = {};
  await Promise.all(ONI.flatMap((id) => { out[id] = {}; return [1, 2, 3].map((p) => loader.loadAsync(`${id}_${p}.png`).then((t) => { out[id][p] = prep(t); })); }));
  return out;
}
function loadGuestTextures() {            // 起動後に裏で読み込む(待たせない)
  const loader = new THREE.TextureLoader(), aniso = renderer.capabilities.getMaxAnisotropy();
  for (const k of IMG_KEYS) loader.loadAsync(`y_${k}.png?v=4`).then((t) => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = aniso; gtex[k] = t; }).catch(() => {});
}

async function start(want) {
  const msg = $('#startMsg');
  $('#startSelf').disabled = $('#startOther').disabled = true;
  const fail = (t) => { msg.textContent = t; msg.classList.add('err'); $('#startSelf').disabled = $('#startOther').disabled = false; };
  if (want === 'rear') await askMotion();              // iPhoneはタップの中で許可を聞く
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return fail('カメラを使えません。https のページをスマホのブラウザで開いてください。');
  try { await openCamera(want === 'front' ? 'user' : 'environment'); }
  catch (e) { return fail('カメラを使えませんでした。ブラウザのサイト設定でカメラを許可して、もう一度お試しください。'); }

  let textures;
  try { textures = await loadAll(); } catch (e) { return fail('画像の読み込みに失敗しました。ページを開き直してください。'); }
  ONI.forEach((id, i) => mons.push(new Mon(id, i, textures)));
  loadGuestTextures();
  updateCount();
  $('#start').hidden = true;
  started = true;
  enterMode(want);
  requestAnimationFrame(frame);

  if (want === 'front') ensureSeg();
  else {
    flash('床の方へスマホを少し向けてみてください。', 5000);
    setTimeout(() => { if (!gyro.has && isFront() === false) flash('ジャイロが取得できません。スマホで開くと床に固定されます。', 0); }, 2500);
  }
  try { if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {}); } catch (e) { /* 任意 */ }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {}); });
}
$('#startSelf').onclick = () => start('front');
$('#startOther').onclick = () => start('rear');

/* テスト用 */
window.__ar = {
  setOrientation(a, b, g) { gyro.alpha = a; gyro.beta = b; gyro.gamma = g; gyro.has = true; },
  spawn: (k) => spawnGuest(k), pair: () => spawnPair(), gesture: (n) => triggerGesture(n),
  feed(f) { onMask(f); }, seg, personMat, personMesh, setSeg(on) { seg.ready = true; setSegActive(on); },
  get guests() { return guests.map((g) => ({ k: g.key, s: +g.s.toFixed(2), u: +g.u.toFixed(1), dead: g.dead })); },
  get mons() { return mons.map((m) => ({ nx: +m.nx.toFixed(2), ny: +m.ny.toFixed(2), x: m.pos.x, z: m.pos.z })); },
  get state() { return { started, mode, facing, fov: camera.fov, segActive, headNdc, seen: [...seen], gtex: Object.keys(gtex) }; },
};
