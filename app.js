import * as THREE from './three.module.min.js';

/* ============================================================
   Monster AR
   ・カメラ映像の上に three.js を重ねる
   ・スマホのジャイロでカメラの向きを追跡 → モンスターは部屋の「床」に固定される
   ・WebXR を使わないので iPhone / Android で同じように動く
   ・写真/動画は「映像+3D」を1枚のcanvasに合成して撮る
   ============================================================ */

const DEG = Math.PI / 180;
const CAM_HEIGHT = 1.3;       // スマホを持つ高さ(m)。床の位置の仮定に使う
const BASE_H = 0.4;           // モンスターの高さ(m)
const SPRITE_ASPECT = 240 / 192;
const VIDEO_VFOV = 63;        // 背面カメラの縦画角の目安(度)
const VFOV_FRONT = 66;        // インカメラの縦画角の目安(度)
const POSE_SEQ = [1, 2, 3, 2];
const POSE_FPS = 5;
const MOVE_SPEED = 1.1;       // 移動速度(m/s)
const CHARS = [{ id: 'r' }, { id: 'b' }, { id: 'g' }];

const $ = (s) => document.querySelector(s);
const video = $('#cam');
const glCanvas = $('#gl');
const statusEl = $('#status');

/* ---------- three.js の土台 ---------- */
const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, alpha: true, antialias: true });
renderer.setClearColor(0x000000, 0);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(VIDEO_VFOV, 1, 0.05, 60);
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

const bodyGeo = new THREE.PlaneGeometry(1, 1);
bodyGeo.translate(0, 0.5, 0); // 足元が原点
const flatGeo = new THREE.PlaneGeometry(1, 1);
flatGeo.rotateX(-Math.PI / 2);

function radialTexture(draw) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  draw(c.getContext('2d'));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const shadowTex = radialTexture((g) => {
  const r = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  r.addColorStop(0, 'rgba(0,0,0,0.85)');
  r.addColorStop(0.55, 'rgba(0,0,0,0.38)');
  r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
});
const ringTex = radialTexture((g) => {
  g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineWidth = 5;
  g.beginPath(); g.arc(64, 64, 56, 0, Math.PI * 2); g.stroke();
});

/* ---------- 状態 ---------- */
const mons = [];
let selected = null;
let paused = false;
let animT = 0;
let lightMul = 1;
let started = false;
let floorY = -CAM_HEIGHT;     // 床の高さ(カメラ原点から見た値)。置き直すたびに見えやすい高さへ調整する
let pendingSpawn = false, spawnReqAt = 0;
let facing = 'environment';   // 'environment'=背面 / 'user'=インカメ
let camStream = null;
const curVfov = () => (facing === 'user' ? VFOV_FRONT : VIDEO_VFOV);

const gyro = { has: false, alpha: 0, beta: 0, gamma: 0 };
const devQ = new THREE.Quaternion();
const yawFix = new THREE.Quaternion();
const tmpQ = new THREE.Quaternion();
let needYawInit = true;
let snapCamera = true;

/* ---------- モンスター ---------- */
class Mon {
  constructor(def, idx, textures) {
    this.def = def; this.idx = idx; this.tex = textures[def.id];
    this.group = new THREE.Group();
    this.mat = new THREE.MeshBasicMaterial({ map: this.tex[1], transparent: true, depthWrite: false });
    this.body = new THREE.Mesh(bodyGeo, this.mat);
    this.body.renderOrder = 1;
    this.body.userData.mon = this;
    this.shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false });
    this.shadow = new THREE.Mesh(flatGeo, this.shadowMat);
    this.shadow.position.y = 0.004; this.shadow.renderOrder = 0;
    this.ringMat = new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, depthWrite: false, opacity: 0 });
    this.ring = new THREE.Mesh(flatGeo, this.ringMat);
    this.ring.position.y = 0.006; this.ring.renderOrder = 0;
    this.group.add(this.shadow, this.ring, this.body);
    scene.add(this.group);
    this.pos = this.group.position;
    this.sizeK = 1;
    this.flip = 1; this.flipTo = 1;
    this.target = null; this.dragTarget = null; this.carried = false;
    this.react = 0; this.dropT = 0;
    this.hop = 0; this.hopY = 0; this.carryY = 0;
    this.phase = idx * 0.37;
    this.pose = 2;
  }
  poke() { this.react = 0.7; }
  drop(delay) { this.dropT = 0.55 + delay; }
  setPose(p) {
    if (p !== this.pose) { this.pose = p; this.mat.map = this.tex[p]; }
  }
  update(dt, t, camRight) {
    const kFast = 1 - Math.exp(-dt * 18);
    let moving = false;

    if (this.carried && this.dragTarget) {
      this.pos.x += (this.dragTarget.x - this.pos.x) * kFast;
      this.pos.z += (this.dragTarget.z - this.pos.z) * kFast;
    } else if (this.target) {
      const dx = this.target.x - this.pos.x, dz = this.target.z - this.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.04) { this.target = null; }
      else {
        moving = true;
        const step = Math.min(dist, MOVE_SPEED * dt);
        this.pos.x += dx / dist * step; this.pos.z += dz / dist * step;
        this.hop += dt * 3.4;
        this.flipTo = (dx * camRight.x + dz * camRight.z) > 0 ? -1 : 1;
      }
    }

    // 跳ねる・持ち上げ・リアクション・降下
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

    // ポーズ(ダンス)
    const f = t * POSE_FPS + this.phase * 4;
    let pose;
    if (this.carried || this.react > 0.2) pose = 3;
    else if (moving) pose = (Math.floor(this.hop * 2) % 2 === 0) ? 1 : 2;
    else pose = POSE_SEQ[((Math.floor(f) % 4) + 4) % 4];
    this.setPose(pose);

    const beat = f - Math.floor(f);
    const bounce = (moving || this.carried) ? 0 : Math.sin(Math.PI * beat);
    const lift = (bounce * 0.025 + this.hopY + this.carryY + reactY + dropY) * this.sizeK;

    // 見た目: 常にカメラの方を向く(縦軸まわりだけ回す)=足元は床に立ったまま
    this.flip += (this.flipTo - this.flip) * (1 - Math.exp(-dt * 14));
    const h = BASE_H * this.sizeK;
    const sy = 1 + 0.045 * bounce + squash;
    const sx = (1 - 0.03 * bounce - squash * 0.6) * this.flip;
    this.body.scale.set(h * SPRITE_ASPECT * sx, h * sy, 1);
    this.body.position.y = lift;
    this.body.rotation.y = Math.atan2(-this.pos.x, -this.pos.z);
    this.body.rotation.z = this.carried ? Math.sin(t * 14) * 0.1 : 0;

    // 影: 高く浮くほど小さく薄く
    const air = Math.min(1, (lift / this.sizeK) / 0.5);
    const sw = BASE_H * 1.05 * this.sizeK * (1 - 0.35 * air);
    this.shadow.scale.set(sw, 1, sw);
    this.shadowMat.opacity = 0.42 * (1 - 0.6 * air) * Math.min(1, lightMul + 0.2);
    // 選択リング
    const rs = BASE_H * 1.25 * this.sizeK * (1 + 0.04 * Math.sin(t * 5));
    this.ring.scale.set(rs, 1, rs);
    this.ringMat.opacity = this === selected ? 0.8 : 0;

    this.mat.color.setScalar(lightMul);
  }
}

/* ---------- 床との交点 ---------- */
const _g = new THREE.Vector3();
function setNdc(cx, cy) {
  const x = cx / innerWidth * 2 - 1;
  ndc.set(facing === 'user' ? -x : x, -(cy / innerHeight) * 2 + 1);
}
function groundPoint(cx, cy, out) {
  setNdc(cx, cy);
  raycaster.setFromCamera(ndc, camera);
  const d = raycaster.ray.direction, o = raycaster.ray.origin;
  if (d.y > -0.03) return null;                 // 水平線より上は床ではない
  const hz = Math.hypot(d.x, d.z) || 1e-6;
  let tt = (floorY - o.y) / d.y;
  tt = Math.min(Math.max(tt, 0.7 / hz), 9 / hz);  // 0.7〜9mに収める
  out.copy(o).addScaledVector(d, tt); out.y = floorY;
  return out;
}
function pick(cx, cy) {
  setNdc(cx, cy);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(mons.map((m) => m.body), false);
  return hits.length ? hits[0].object.userData.mon : null;
}
function select(m) { selected = m; }

/* ---------- 配置 ---------- */
function spawnAll() { pendingSpawn = true; spawnReqAt = performance.now(); }
function doSpawn() {
  pendingSpawn = false;
  // いまカメラが向いている方向の、画面の下寄り(高さ約72%)に足元が来るように置く。
  // インカメは床が映らない角度になりがちなので、床の高さを見えやすい位置へ寄せる。
  const f = new THREE.Vector3(); camera.getWorldDirection(f);
  const pitch = Math.asin(Math.max(-1, Math.min(1, f.y)));
  const down = Math.atan(0.44 * Math.tan(camera.fov * DEG / 2));
  const depr = Math.max(down - pitch, 0.14);                  // 足元の水平線からの下向き角
  const d = Math.min(3.6, Math.max(2.0, CAM_HEIGHT / Math.tan(depr)));
  floorY = -Math.min(1.6, Math.max(0.45, d * Math.tan(depr)));
  // 縦画面は横の画角が約30°しかないので、3体が一度に見えるよう近めに並べる(中央のこだけ奥)
  const slots = [[-0.4, d], [0, d + 0.3], [0.4, d]];
  mons.forEach((m, i) => {
    m.pos.set(slots[i][0], floorY, -slots[i][1]);
    m.target = null; m.carried = false; m.dragTarget = null;
    m.drop(i * 0.18);
  });
}

/* ---------- カメラ(ジャイロ) ---------- */
const _zee = new THREE.Vector3(0, 0, 1);
const _euler = new THREE.Euler();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const frontFlipQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  return typeof window.orientation === 'number' ? window.orientation : 0;
}
function deviceQuat(q) {
  _euler.set(gyro.beta * DEG, gyro.alpha * DEG, -gyro.gamma * DEG, 'YXZ');
  q.setFromEuler(_euler);
  q.multiply(_q1);
  q.multiply(_q0.setFromAxisAngle(_zee, -screenAngle() * DEG));
  return q;
}
function initYaw() {
  deviceQuat(devQ);
  const base = devQ.clone();
  if (facing === 'user') base.multiply(frontFlipQ);
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(base);
  let h = f;
  if (Math.abs(f.y) > 0.85) {           // 真下/真上を向いているときは画面の上方向を基準にする
    const u = new THREE.Vector3(0, 1, 0).applyQuaternion(base);
    h = f.y < 0 ? u : u.negate();
  }
  const yaw = Math.atan2(-h.x, -h.z);
  yawFix.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
  needYawInit = false; snapCamera = true;
}
function updateCamera(dt) {
  if (!gyro.has) return;
  if (needYawInit) initYaw();
  deviceQuat(devQ);
  tmpQ.copy(yawFix).multiply(devQ);
  if (facing === 'user') tmpQ.multiply(frontFlipQ);
  if (snapCamera) { camera.quaternion.copy(tmpQ); snapCamera = false; }
  else camera.quaternion.slerp(tmpQ, 1 - Math.exp(-dt * 30));
}
function onOrient(e) {
  if (e.alpha == null || e.beta == null) return;
  gyro.alpha = e.alpha; gyro.beta = e.beta; gyro.gamma = e.gamma || 0; gyro.has = true;
}

/* ---------- 画面サイズ・画角 ---------- */
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  const va = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 9 / 16;
  const sa = w / h;
  // object-fit: cover で映像が上下に切れる場合は、画角も合わせて狭める
  const vf = curVfov();
  camera.fov = sa <= va ? vf
    : 2 * Math.atan(Math.tan(vf * DEG / 2) * va / sa) / DEG;
  camera.aspect = sa;
  camera.updateProjectionMatrix();
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
    const luma = s / 256;
    const target = Math.min(1, Math.max(0.55, 0.5 + 0.8 * luma));
    lightMul += (target - lightMul) * 0.15;
  } catch (e) { /* 取得できないときは補正しない */ }
}

/* ---------- 撮影(映像+3Dを合成) ---------- */
const comp = document.createElement('canvas');
const cctx = comp.getContext('2d');
let compMax = 2400;
function composite() {
  const W = glCanvas.width, H = glCanvas.height;
  const sc = Math.min(1, compMax / Math.max(W, H));
  const cw = Math.max(2, Math.round(W * sc / 2) * 2), ch = Math.max(2, Math.round(H * sc / 2) * 2);
  if (comp.width !== cw || comp.height !== ch) { comp.width = cw; comp.height = ch; }
  const vw = video.videoWidth, vh = video.videoHeight;
  cctx.save();
  if (facing === 'user') { cctx.translate(cw, 0); cctx.scale(-1, 1); }
  if (vw) {
    const s = Math.max(cw / vw, ch / vh);
    cctx.drawImage(video, (cw - vw * s) / 2, (ch - vh * s) / 2, vw * s, vh * s);
  } else { cctx.fillStyle = '#111'; cctx.fillRect(0, 0, cw, ch); }
  cctx.drawImage(glCanvas, 0, 0, cw, ch);
  cctx.restore();
}

let photoReq = false;
let recording = false, recorder = null, chunks = [], recStart = 0, recTimer = 0;
let mode = 'photo';
let resultBlob = null, resultName = '', resultURL = '';

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function pickMime() {
  const c = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  if (!window.MediaRecorder) return '';
  return c.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}
function showResult(kind, blob) {
  if (resultURL) URL.revokeObjectURL(resultURL);
  resultBlob = blob; resultURL = URL.createObjectURL(blob);
  const ext = kind === 'photo' ? 'jpg' : (blob.type.includes('mp4') ? 'mp4' : 'webm');
  resultName = `monsters-${stamp()}.${ext}`;
  const box = $('#resultMedia'); box.textContent = '';
  const el = document.createElement(kind === 'photo' ? 'img' : 'video');
  el.src = resultURL;
  if (kind === 'video') { el.controls = true; el.playsInline = true; el.loop = true; el.autoplay = true; el.muted = true; }
  box.appendChild(el);
  $('#resultNote').textContent = kind === 'photo' ? '画像を長押しして保存もできます。' : '';
  $('#result').hidden = false;
}
function takePhoto() {
  select(null);
  compMax = 2400;
  photoReq = true;
  const fl = $('#flash'); fl.classList.remove('go'); void fl.offsetWidth; fl.classList.add('go');
}
function startRecording() {
  const mime = pickMime();
  if (!window.MediaRecorder || !comp.captureStream) { flash('この端末では動画を撮れません'); return; }
  select(null);
  compMax = 1280;
  composite();
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
  document.body.classList.add('recording');
  $('#rec').classList.add('on');
  recTimer = setInterval(() => {
    const s = Math.floor((performance.now() - recStart) / 1000);
    $('#recTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (s >= 60) stopRecording();
  }, 250);
}
function stopRecording() {
  if (!recording) return;
  recording = false; clearInterval(recTimer);
  document.body.classList.remove('recording');
  $('#rec').classList.remove('on'); $('#recTime').textContent = '0:00';
  try { recorder.stop(); } catch (e) { /* 既に停止 */ }
}

/* ---------- UI ---------- */
let flashTimer = 0;
function flash(msg, ms = 5000) {
  statusEl.textContent = msg; statusEl.classList.add('on');
  clearTimeout(flashTimer);
  if (ms) flashTimer = setTimeout(() => statusEl.classList.remove('on'), ms);
}
function setMode(m) {
  if (recording) return;
  mode = m;
  document.body.classList.toggle('video', m === 'video');
  $('#modePhoto').setAttribute('aria-pressed', String(m === 'photo'));
  $('#modeVideo').setAttribute('aria-pressed', String(m === 'video'));
}
$('#modePhoto').onclick = () => setMode('photo');
$('#modeVideo').onclick = () => setMode('video');
$('#shutter').onclick = () => {
  if (mode === 'photo') takePhoto();
  else recording ? stopRecording() : startRecording();
};
$('#recall').onclick = () => { needYawInit = true; spawnAll(); flash('モンスターを目の前に呼びました', 2500); };
$('#pause').onclick = () => {
  paused = !paused;
  $('#pauseIco').innerHTML = paused ? '<path d="M8 5l11 7-11 7z"/>' : '<path d="M9 5v14M15 5v14"/>';
  $('#pause').setAttribute('aria-label', paused ? 'ダンスを再開' : 'ダンスを一時停止');
};
$('#closeBtn').onclick = () => { $('#result').hidden = true; $('#resultMedia').textContent = ''; };
$('#shareBtn').onclick = async () => {
  if (!resultBlob) return;
  const file = new File([resultBlob], resultName, { type: resultBlob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = resultURL; a.download = resultName;
  document.body.appendChild(a); a.click(); a.remove();
};

/* ---------- 操作(タップ・つまむ・ピンチ) ---------- */
const pointers = new Map();
let drag = null, pinch = null;
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

glCanvas.addEventListener('pointerdown', (e) => {
  if (!started) return;
  glCanvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    const m = pick(e.clientX, e.clientY);
    drag = { mon: m, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false, off: new THREE.Vector3() };
    if (m) {
      select(m); m.poke(); m.carried = true; m.target = null;
      m.dragTarget = m.pos.clone();
      const g = groundPoint(e.clientX, e.clientY, _g);
      if (g) drag.off.set(m.pos.x - g.x, 0, m.pos.z - g.z);
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
      const g = groundPoint(e.clientX, e.clientY, _g);
      if (g) drag.mon.dragTarget.set(g.x + drag.off.x, floorY, g.z + drag.off.z);
    }
  }
});
function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (drag && pointers.size === 0) {
    if (drag.mon) {
      drag.mon.carried = false; drag.mon.dragTarget = null;
    } else if (!drag.moved && performance.now() - drag.t0 < 500 && e.type === 'pointerup') {
      const g = groundPoint(e.clientX, e.clientY, _g);
      if (g) {
        let m = selected;
        if (!m) { // 選択がなければ一番近いモンスターを呼ぶ
          m = mons.reduce((best, c) => (Math.hypot(c.pos.x - g.x, c.pos.z - g.z) < Math.hypot(best.pos.x - g.x, best.pos.z - g.z) ? c : best), mons[0]);
        }
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
let last = 0, initAt = 0;
const _f = new THREE.Vector3(), _right = new THREE.Vector3();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000 || 0.016); last = now;
  updateCamera(dt);
  if (pendingSpawn && (gyro.has || performance.now() - spawnReqAt > 800)) doSpawn();
  if (!initAt) initAt = now;
  if (!paused) animT += dt;

  camera.getWorldDirection(_f);
  _right.set(-_f.z, 0, _f.x).normalize();
  for (const m of mons) m.update(dt, animT, _right);
  sampleLight(now);

  renderer.render(scene, camera);
  if (photoReq || recording) {
    composite();
    if (photoReq) {
      photoReq = false;
      comp.toBlob((b) => { if (b) showResult('photo', b); }, 'image/jpeg', 0.93);
    }
  }
}

/* ---------- カメラ ---------- */
async function openCamera(want) {
  // Androidは前後のカメラを同時に開けないので、先に今のカメラを止めてから開く
  if (camStream) {
    camStream.getTracks().forEach((t) => t.stop());
    camStream = null; video.srcObject = null;
    await new Promise((r) => setTimeout(r, 250));
  }
  const base = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { ...base, facingMode: { exact: want } }, audio: false });
  } catch (e) {
    stream = await navigator.mediaDevices.getUserMedia({ video: { ...base, facingMode: { ideal: want } }, audio: false });
  }
  camStream = stream;
  facing = want;
  document.body.classList.toggle('front', want === 'user');
  video.srcObject = stream;
  await video.play();
  resize();
}
let switching = false;
async function switchCamera() {
  if (switching || recording || !started) return;
  switching = true;
  const prev = facing;
  const want = prev === 'user' ? 'environment' : 'user';
  try {
    await openCamera(want);
    needYawInit = true; spawnAll();
    flash(want === 'user' ? 'インカメラに切り替えました' : '背面カメラに切り替えました', 2500);
  } catch (e) {
    flash(`カメラを切り替えられませんでした(${(e && e.name) || 'エラー'})`, 5000);
    try { await openCamera(prev); } catch (e2) { /* 元のカメラも開けない場合は何もしない */ }
  } finally { switching = false; }
}
$('#flip').onclick = switchCamera;

/* ---------- 起動 ---------- */
function loadTextures() {
  const loader = new THREE.TextureLoader();
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const out = {};
  const jobs = [];
  for (const c of CHARS) {
    out[c.id] = {};
    for (const p of [1, 2, 3]) {
      jobs.push(loader.loadAsync(`${c.id}_${p}.png`).then((t) => {
        t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = aniso; out[c.id][p] = t;
      }));
    }
  }
  return Promise.all(jobs).then(() => out);
}

async function start() {
  const msg = $('#startMsg');
  $('#startBtn').disabled = true;
  // iPhone はジャイロの許可を「タップの中で」直接聞く必要がある
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      await DeviceOrientationEvent.requestPermission();
    }
  } catch (e) { /* 拒否されても続行(固定表示になる) */ }
  addEventListener('deviceorientation', onOrient);

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    msg.textContent = 'カメラを使えません。https のページをスマホのブラウザで開いてください。';
    msg.classList.add('err'); $('#startBtn').disabled = false; return;
  }
  try {
    await openCamera('environment');
  } catch (e) {
    msg.textContent = 'カメラを使えませんでした。ブラウザのサイト設定でカメラを許可して、もう一度お試しください。';
    msg.classList.add('err'); $('#startBtn').disabled = false; return;
  }

  let textures;
  try { textures = await loadTextures(); }
  catch (e) { msg.textContent = '画像の読み込みに失敗しました。ページを開き直してください。'; msg.classList.add('err'); $('#startBtn').disabled = false; return; }

  CHARS.forEach((c, i) => mons.push(new Mon(c, i, textures)));
  resize();
  $('#start').hidden = true;
  started = true;
  needYawInit = true;
  spawnAll();
  requestAnimationFrame(frame);

  try { if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {}); } catch (e) { /* 任意機能 */ }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {});
  });

  flash('床の方へスマホを少し向けてみてください。つまんで運べます。', 6000);
  setTimeout(() => {
    if (!gyro.has) flash('ジャイロが取得できません。スマホで開くとモンスターが床に固定されます。', 0);
  }, 2500);
}
$('#startBtn').onclick = start;

/* テスト用: 開発時に疑似的な向きを与える */
window.__ar = {
  setOrientation(alpha, beta, gamma) { gyro.alpha = alpha; gyro.beta = beta; gyro.gamma = gamma; gyro.has = true; },
  get mons() { return mons.map((m) => ({ x: m.pos.x, z: m.pos.z, size: m.sizeK })); },
  screenOf(i) { const m = mons[i]; const v = new THREE.Vector3(m.pos.x, m.pos.y + 0.18 * m.sizeK, m.pos.z).project(camera); return { x: (v.x + 1) / 2 * innerWidth, y: (1 - v.y) / 2 * innerHeight }; },
  get state() { return { started, facing, gyro: { ...gyro }, fov: camera.fov, light: lightMul }; },
};
