import * as THREE from './three.module.min.js';

/* ============================================================
   おばけ(ゲスト)の定義と動き
   ・h        … 高さ。画面に対して「基準の距離 D0 で見たとき」の大きさ(m)
   ・zone     … sky(宙) / ground(足元) / center(大きく登場) / edge(画面の端)
   ・layer    … back = 人の後ろ / front = 人の前(自撮りで人物を切り抜けたとき)
   ・w        … 時間帯ごとの出やすさ (morning 5-10時 / day 10-16時 / evening 16-19時 / night 19-5時)
   ・motion   … 下の MOT にある動き方
   動きの速さは「画面の半幅 hw」を基準にしているので、自撮りでも外カメでも同じ見え方になる
   ============================================================ */
export const D0 = 1.7;

export const GUEST_DEFS = {
  chochin:  { name: '提灯',     img: ['chochin'],  h: 0.30, zone: 'sky',    layer: 'back',  motion: 'float',   life: 11, at: ['evening','night'] },
  hitodama: { name: '人玉',     img: ['hitodama'], h: 0.22, zone: 'sky',    layer: 'back',  motion: 'drift',   speed: .55, at: ['night'] },
  kasa:     { name: 'からかさ', img: ['kasa_body'], rig: 'kasa', parts: ['kasa_body', 'kasa_thigh', 'kasa_shin', 'kasa_boot'], h: 0.52, zone: 'ground', layer: 'front', motion: 'hop',     life: 11, at: ['day'] },
  usagi:    { name: 'ウサギ',   img: ['rabbit'],   h: 0.30, zone: 'ground', layer: 'front', motion: 'hophop',  life: 10, at: ['morning'] },
  tanuki:   { name: '狸',       img: ['tanuki'],   h: 0.36, zone: 'edge',   layer: 'front', motion: 'peek',    life: 7.5, at: ['evening'] },
  kitsune:  { name: '狐',       img: ['kitsune'],  h: 0.34, zone: 'edge',   layer: 'front', motion: 'peek',    life: 7.5, at: ['evening'] },
  hyakume:  { name: '百目',     img: ['hyakume'],  h: 0.34, zone: 'ground', layer: 'front', motion: 'crawl',   life: 12, at: ['night'] },
  umibozu:  { name: '海坊主',   img: ['umibozu'],  h: 1.30, zone: 'center', layer: 'back',  motion: 'startle', life: 4.6, at: [] },
  kappa:    { name: '河童',     img: ['kappa1', 'kappa2', 'kappa3'], h: 0.36, zone: 'ground', layer: 'front', motion: 'walk', life: 11, at: ['morning','evening'] },
  yellow:   { name: '黄色いの', img: ['yellow'],   h: 0.17, zone: 'ground', layer: 'front', motion: 'slither', speed: .20, at: ['morning'] },
  wheel:    { name: '車輪',     img: ['wheel'],    h: 0.38, zone: 'ground', layer: 'front', motion: 'spin',    life: 10, at: ['day'] },
  kuchi:    { name: '口',       img: ['kuchi'],    h: 0.28, zone: 'ground', layer: 'front', motion: 'walk',    life: 11, at: ['day'] },
};
export const IMG_KEYS = [...new Set(Object.values(GUEST_DEFS).flatMap((d) => [...d.img, ...(d.parts || [])]))];

/* 時間帯の決め方(端末の時計を使う)。URLに ?hour=21 のように付けると、その時刻として動く(確認用) */
export const BANDS = {
  morning: { label: '朝',   from: 5,  to: 10, text: '5:00〜10:00' },
  day:     { label: '昼',   from: 10, to: 16, text: '10:00〜16:00' },
  evening: { label: '夕方', from: 16, to: 19, text: '16:00〜19:00' },
  night:   { label: '夜',   from: 19, to: 5,  text: '19:00〜翌5:00' },
};
/* 動きで呼べるおばけ。時間帯に関係なく、その動きをすれば出る */
export const GESTURES = [
  { id: 'raise', label: '両手を上げる',   where: '自撮り', yokai: ['chochin', 'hitodama'] },
  { id: 'close', label: 'ぐっと近づく',   where: '自撮り', yokai: ['umibozu'] },
  { id: 'sway',  label: '左右にゆれる',   where: '自撮り', yokai: ['tanuki', 'kitsune'] },
  { id: 'move',  label: '画面が大きく動く', where: '外カメ', yokai: [] },   // いまの時間帯のおばけが1体
];
const hourOverride = (() => { const v = new URLSearchParams(location.search).get('hour'); return v != null && v !== '' && !isNaN(+v) ? (+v % 24) : null; })();
export const nowHour = () => (hourOverride != null ? hourOverride : new Date().getHours());
export function period(hour = nowHour()) {
  for (const [k, b] of Object.entries(BANDS)) {
    if (b.from < b.to ? (hour >= b.from && hour < b.to) : (hour >= b.from || hour < b.to)) return k;
  }
  return 'night';
}
/* いまの時間帯に出ると決めてあるおばけから、同じ確率で1体選ぶ(狸と狐は「狸」でまとめて1組) */
export function pickByTime(exclude = [], hour) {
  const p = period(hour);
  const list = Object.entries(GUEST_DEFS).filter(([k, d]) => k !== 'kitsune' && !exclude.includes(k) && d.at.includes(p)).map(([k]) => k);
  return list.length ? list[Math.floor(Math.random() * list.length)] : 'chochin';
}

const TAU = Math.PI * 2;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const ease = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
const back = (x) => { x = clamp01(x) - 1; return 1 + 2.7 * x * x * x + 1.7 * x * x; };

/* ---------- 動き方 ----------
   g.s=横位置 g.y=浮き量 g.sx/sy=伸び縮み g.rz=傾き  (g.H=体の高さ g.hw=画面の半幅) */
const bounceEdge = (g, lim = 0.78) => { if (g.s > g.hw * lim) g.dir = -1; else if (g.s < -g.hw * lim) g.dir = 1; };
const MOT = {
  float(g, u) {                                  // ふわふわ。複数で
    g.y = g.H * 0.25 * Math.sin(1.7 * u + g.ph);
    g.s = g.s0 + 0.05 * g.hw * Math.sin(0.9 * u + g.ph * 2);
    g.rz = 0.07 * Math.sin(1.3 * u + g.ph);
  },
  drift(g, u) {                                  // 提灯より速く、空を流れていく
    const e = g.hw + g.W * 0.7;
    g.s = g.dir * (-e + 2 * e * (u / g.L));
    g.y = g.H * 0.5 * Math.sin(2.4 * u + g.ph);
    g.rz = g.dir * 0.25 * Math.sin(2.4 * u + g.ph + 1.2);
    g.sx = 1 + 0.08 * Math.sin(4.8 * u);
  },
  hop(g, u, dt) {                                // ぴょんぴょん。着地でつぶれ、跳ぶ前に縮み、空中で伸びる
    const p = (u / 0.85 + g.ph) % 1, A = 0.62;
    if (p < A) {
      const x = p / A;
      g.y = g.H * 0.55 * 4 * x * (1 - x);
      g.sy = 1 + 0.18 * Math.sin(Math.PI * x); g.sx = 1 - 0.1 * Math.sin(Math.PI * x);
      g.s += g.dir * 0.3 * g.hw * dt;
    } else {
      const q = (p - A) / (1 - A);
      g.sy = 1 - 0.24 * Math.sin(Math.PI * q); g.sx = 1 + 0.15 * Math.sin(Math.PI * q);
    }
    g.rz = 0.1 * Math.sin(u * 7.4) * (p < A ? 1 : 0);
    bounceEdge(g);
  },
  hophop(g, u, dt) {                             // ぴょこぴょこ×3、ひと休み
    const T = 2.2, t = u % T;
    if (t < 1.2) {
      const x = (t / 0.4) % 1;
      g.y = g.H * 0.35 * 4 * x * (1 - x);
      g.sy = 1 + 0.12 * Math.sin(Math.PI * x); g.sx = 1 - 0.06 * Math.sin(Math.PI * x);
      g.s += g.dir * 0.2 * g.hw * dt;
    } else { g.sy = 1 + 0.02 * Math.sin(u * 6); }
    bounceEdge(g);
  },
  walk(g, u, dt) {                               // てくてく
    g.s += g.dir * 0.12 * g.hw * dt;
    g.y = g.H * 0.06 * Math.abs(Math.sin(TAU * 0.9 * u * 2 + g.ph));
    g.rz = 0.08 * Math.sin(TAU * 0.9 * u + g.ph);
    bounceEdge(g);
  },
  crawl(g, u, dt) {                              // のし…のし…と這う
    g.s += g.dir * 0.06 * g.hw * dt;
    const w = Math.sin(TAU * 0.8 * u + g.ph);
    g.sx = 1 + 0.08 * w; g.sy = 1 - 0.07 * w;
    g.rz = 0.025 * Math.sin(TAU * 0.4 * u);
    bounceEdge(g);
  },
  slither(g, u, dt) {                            // 蛇のように画面の下を横切る(体の波は update で)
    const e = g.hw + g.W * 0.6;
    g.s = g.dir * (-e + 2 * e * (u / g.L));
    g.wave = u;
  },
  spin(g, u, dt) {                               // くるくる回りながら転がる
    g.s += g.dir * 0.25 * g.hw * dt;
    g.ang = (g.ang || 0) - g.dir * 5.2 * dt;
    g.rz = g.ang;
    g.y = g.H * 0.08 * Math.abs(Math.sin(TAU * 1.4 * u));
    bounceEdge(g);
  },
  startle(g, u) {                                // わっ! と大きく飛び出す
    const k = back(u / 0.32);
    g.sx = g.sy = 0.05 + 0.95 * k;
    const out = clamp01((u - (g.L - 0.7)) / 0.7);
    g.y = -g.H * 0.55 * ease(out);
    g.sx *= 1 + 0.02 * Math.sin(2.6 * u); g.sy *= 1 - 0.02 * Math.sin(2.6 * u);
    g.rz = 0.05 * Math.sin(60 * u) * Math.exp(-4 * u);
  },
  peek(g, u) {                                   // 画面の端からひょこひょこ
    const IN = 1.4, OUT = 1.2, edge = g.hw + g.W * 0.6, rest = g.hw - g.W * 0.12;      // 体の6〜7割だけ見せて、端にとどまる
    let r;
    if (u < IN) r = edge + (rest - edge) * ease(u / IN);
    else if (u > g.L - OUT) r = rest + (edge - rest) * ease((u - (g.L - OUT)) / OUT);
    else r = rest;
    g.s = g.side * r;
    const moving = u < IN || u > g.L - OUT;
    g.y = g.H * (moving ? 0.07 * Math.abs(Math.sin(u * 11 + g.ph)) : 0.04 * Math.abs(Math.sin(u * 5 + g.ph)));
    g.rz = (moving ? 0.1 : 0.13) * Math.sin(u * (moving ? 11 : 5) + g.ph);
    if (!moving) g.sy = 1 + 0.04 * Math.sin(u * 8 + g.ph);
  },
};


/* ---------- からかさ: 体・もも・すね・ブーツに分けて、ひざを曲げ伸ばしする ----------
   単位は元絵のピクセル(y上向き)。足首を地面の基準にして、体の高さから「2本の骨のIK」でひざを曲げる */
const KASA = {
  w: 246, h: 547, s: 0.8,                  // 元絵の大きさ / 足パーツの拡大率
  hipBody: [133, 370],                     // 体パーツの中の「足のつけ根」
  thigh: { pivot: [14, 14], dir: [25, -74] },          // ももの中のつけ根 / つけ根→ひざの向き
  shin: { pivot: [35, 19], dir: [-21, -79], len: 81.7 }, // すねの中のひざ / ひざ→足首の向き
  boot: { pivot: [36, 14] },               // ブーツの中の足首
  ankleH: 85, dRest: 90,                   // 地面から足首までの高さ / 立っているときのつけ根〜足首の距離
};
KASA.L1 = Math.hypot(...KASA.thigh.dir) * KASA.s;
KASA.L2 = KASA.shin.len * KASA.s;
function partMesh(tex, pivot, order, mat) {
  const w = tex.image.width, h = tex.image.height;
  const g = new THREE.PlaneGeometry(w, h); g.translate(w / 2 - pivot[0], pivot[1] - h / 2, 0);
  const m = new THREE.Mesh(g, mat); m.renderOrder = order; return m;
}
const slugGeo = () => { const g = new THREE.PlaneGeometry(1, 1, 28, 1); g.translate(0, 0.5, 0); return g; };
const feetGeo = (() => { const g = new THREE.PlaneGeometry(1, 1); g.translate(0, 0.5, 0); return g; })();

export class Guest {
  /* ctx: {scene, mode, lightMul(), anchor(zone,layer)->{c,right,hw,k,depth}, shadowTex, renderOrder} */
  constructor(ctx, key, tex, opt = {}) {
    const def = GUEST_DEFS[key];
    this.ctx = ctx; this.key = key; this.def = def; this.dead = false;
    const a = ctx.anchor(def.zone, def.layer);
    this.c = a.c; this.right = a.right; this.hw = a.hw; this.k = a.k;
    this.H = def.h * a.k; this.aspect = def.rig ? KASA.w / KASA.h : tex.image.width / tex.image.height; this.W = this.H * this.aspect;
    this.dir = opt.dir || (Math.random() < 0.5 ? -1 : 1); this.side = opt.side || this.dir;
    this.ph = opt.ph != null ? opt.ph : Math.random() * TAU;
    this.s0 = (opt.s0 || 0) * this.hw; this.s = this.s0;
    if (def.zone === 'center' && opt.xc != null) { this.s0 = this.s = opt.xc * this.hw; }
    if (def.motion === 'hop' || def.motion === 'hophop' || def.motion === 'walk' || def.motion === 'crawl' || def.motion === 'spin') this.s = this.s0 = (opt.s0 != null ? opt.s0 : (Math.random() * 1.2 - 0.6)) * this.hw;
    this.y = 0; this.sx = 1; this.sy = 1; this.rz = 0; this.u = -(opt.delay || 0);
    this.L = def.life || (2 * (this.hw + this.W * 0.7)) / ((def.speed || 0.3) * this.hw);
    this.wave = 0;

    this.group = new THREE.Group();
    this.mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
    this.geo = def.motion === 'slither' ? slugGeo() : feetGeo;
    this.body = new THREE.Mesh(this.geo, this.mat);
    this.body.renderOrder = ctx.order(def.layer);
    if (def.rig) this.buildRig(opt.parts); else this.group.add(this.body);
    if (ctx.mode() === 'rear' && def.zone !== 'sky') {
      this.shadowMat = new THREE.MeshBasicMaterial({ map: ctx.shadowTex, transparent: true, depthWrite: false, depthTest: false, opacity: 0 });
      this.shadow = new THREE.Mesh(ctx.flatGeo, this.shadowMat);
      this.shadow.position.y = 0.004; this.shadow.renderOrder = 4;
      this.group.add(this.shadow);
    }
    this.group.visible = false;
    ctx.scene.add(this.group);
  }

  buildRig(parts) {
    this.rig = new THREE.Group();
    const o = this.ctx.order(this.def.layer);
    const mk = () => new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, depthTest: false });
    this.rigMats = [mk(), mk(), mk(), mk()];
    this.rigParts = {
      thigh: partMesh(parts.kasa_thigh, KASA.thigh.pivot, o, this.rigMats[0]),
      shin: partMesh(parts.kasa_shin, KASA.shin.pivot, o + 1, this.rigMats[1]),
      boot: partMesh(parts.kasa_boot, KASA.boot.pivot, o + 2, this.rigMats[2]),
      body: partMesh(parts.kasa_body, KASA.hipBody, o + 3, this.rigMats[3]),
    };
    this.rigParts.thigh.material.map = parts.kasa_thigh; this.rigParts.shin.material.map = parts.kasa_shin;
    this.rigParts.boot.material.map = parts.kasa_boot; this.rigParts.body.material.map = parts.kasa_body;
    for (const m of Object.values(this.rigParts)) this.rig.add(m);
    this.group.add(this.rig);
  }
  updateRig(popK, alpha) {
    const unit = (this.H * popK) / KASA.h, P = this.rigParts;
    const sy = this.sy;
    const d = Math.min(KASA.L1 + KASA.L2 - 1.5, Math.max(52, KASA.dRest + (sy - 1) * 150));   // つぶれるとひざが深く曲がり、伸びるとまっすぐに近づく
    const ax = 0, ay = KASA.ankleH + this.y / unit;
    const hx = 0, hy = ay + d;
    const D = d, c = (KASA.L1 * KASA.L1 + D * D - KASA.L2 * KASA.L2) / (2 * KASA.L1 * D);
    const al = Math.acos(Math.max(-1, Math.min(1, c))), be = -Math.PI / 2;
    const kx = hx + KASA.L1 * Math.cos(be + al), ky = hy + KASA.L1 * Math.sin(be + al);     // ひざは右へ出る
    const ang = (v) => Math.atan2(v[1], v[0]);
    P.thigh.position.set(hx, hy, 0); P.thigh.scale.setScalar(KASA.s);
    P.thigh.rotation.z = Math.atan2(ky - hy, kx - hx) - ang(KASA.thigh.dir);
    P.shin.position.set(kx, ky, 0); P.shin.scale.setScalar(KASA.s);
    P.shin.rotation.z = Math.atan2(ay - ky, ax - kx) - ang(KASA.shin.dir);
    P.boot.position.set(ax, ay, 0); P.boot.rotation.z = this.rz * 0.4;
    P.body.position.set(hx, hy, 0); P.body.rotation.z = this.rz;
    P.body.scale.set(1 + (1 - sy) * 0.18, 1 + (sy - 1) * 0.18, 1);
    this.rig.scale.setScalar(unit);
    this.rig.position.x = -0.0;
    for (const m of this.rigMats) { m.opacity = alpha; m.color.setScalar(this.ctx.lightMul()); }
  }
  update(dt) {
    this.u += dt;
    const u = this.u;
    if (u < 0) return;
    if (u > this.L) { this.dispose(); return; }
    this.group.visible = true;
    this.sx = 1; this.sy = 1; this.rz = 0; this.y = 0;
    const keepS = this.def.motion;
    MOT[keepS](this, u, dt);

    const env = ease(u / 0.35) * ease((this.L - u) / 0.45);
    const popK = this.def.motion === 'startle' ? 1 : 0.35 + 0.65 * env;
    const alpha = this.def.motion === 'startle' ? Math.min(1, u / 0.08) : (this.def.motion === 'drift' || this.def.motion === 'slither' ? 1 : env);
    this.mat.opacity = alpha;
    this.mat.color.setScalar(this.ctx.lightMul());

    const H = this.H * this.sy * popK, W = this.H * this.aspect * this.sx * popK;
    const hc = H / 2;
    this.group.position.copy(this.c).addScaledVector(this.right, this.s);
    this.group.rotation.y = Math.atan2(-this.group.position.x, -this.group.position.z);
    if (this.rig) this.updateRig(popK, alpha);
    else {
      this.body.scale.set(W, H, 1);
      this.body.rotation.z = this.rz;
      this.body.position.set(hc * Math.sin(this.rz), this.y + hc * (1 - Math.cos(this.rz)), 0);   // 傾きは体の中心まわり
    }
    if (this.def.motion === 'slither') {
      const pos = this.geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), by = pos.getY(i) > 0.25 ? 1 : 0;
        pos.setY(i, by * (1 + 0.22 * Math.sin(TAU * (x * 1.4 - 0.7 * this.wave)) + 0.06 * Math.sin(TAU * (x * 3.1 - 1.3 * this.wave))));
      }
      pos.needsUpdate = true;
    }
    if (this.shadow) {
      const air = Math.min(1, this.y / (this.H * 0.6));
      const sw = this.W * 1.0 * (1 - 0.3 * air);
      this.shadow.scale.set(sw, 1, Math.max(sw * 0.6, 0.05));
      this.shadowMat.opacity = 0.4 * env * (1 - 0.55 * air);
    }
  }
  poke() { if (this.def.motion === 'hop' || this.def.motion === 'hophop') this.u += 0.2; }
  dispose() {
    if (this.dead) return;
    this.dead = true;
    this.ctx.scene.remove(this.group);
    this.mat.dispose();
    if (this.rigMats) this.rigMats.forEach((m) => m.dispose());
    if (this.def.motion === 'slither') this.geo.dispose();
    if (this.shadowMat) this.shadowMat.dispose();
  }
}
