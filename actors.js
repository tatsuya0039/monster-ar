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
  chochin:  { name: '提灯',     img: ['chochin'],  h: 0.30, zone: 'sky',    layer: 'back',  motion: 'float',   life: 11,  w: { morning: .3, day: .3, evening: 3, night: 3 } },
  hitodama: { name: '人玉',     img: ['hitodama'], h: 0.22, zone: 'sky',    layer: 'back',  motion: 'drift',   speed: .55, w: { morning: 0, day: .2, evening: 1.5, night: 3 } },
  kasa:     { name: 'からかさ', img: ['kasa'],     h: 0.52, zone: 'ground', layer: 'front', motion: 'hop',     life: 11,  w: { morning: 1.5, day: 2, evening: 1, night: .5 } },
  usagi:    { name: 'ウサギ',   img: ['rabbit'],   h: 0.30, zone: 'ground', layer: 'front', motion: 'hophop',  life: 10,  w: { morning: 3, day: 2, evening: .8, night: .2 } },
  tanuki:   { name: '狸',       img: ['tanuki'],   h: 0.36, zone: 'edge',   layer: 'front', motion: 'peek',    life: 7.5, w: { morning: 1, day: 1, evening: 3, night: 2 } },
  kitsune:  { name: '狐',       img: ['kitsune'],  h: 0.34, zone: 'edge',   layer: 'front', motion: 'peek',    life: 7.5, w: { morning: 0, day: 0, evening: 0, night: 0 } },
  hyakume:  { name: '百目',     img: ['hyakume'],  h: 0.34, zone: 'ground', layer: 'front', motion: 'crawl',   life: 12,  w: { morning: .2, day: .4, evening: 1, night: 2 } },
  umibozu:  { name: '海坊主',   img: ['umibozu'],  h: 1.30, zone: 'center', layer: 'back',  motion: 'startle', life: 4.6, w: { morning: .3, day: .3, evening: .5, night: .5 } },
  kappa:    { name: '河童',     img: ['kappa1', 'kappa2', 'kappa3'], h: 0.36, zone: 'ground', layer: 'front', motion: 'walk', life: 11, w: { morning: 2, day: 2, evening: 1, night: .4 } },
  yellow:   { name: '黄色いの', img: ['yellow'],   h: 0.17, zone: 'ground', layer: 'front', motion: 'slither', speed: .20, w: { morning: 1, day: 2, evening: 1, night: .6 } },
  wheel:    { name: '車輪',     img: ['wheel'],    h: 0.38, zone: 'ground', layer: 'front', motion: 'spin',    life: 10,  w: { morning: .3, day: .5, evening: 1.5, night: 2 } },
  kuchi:    { name: '口',       img: ['kuchi'],    h: 0.28, zone: 'ground', layer: 'front', motion: 'walk',    life: 11,  w: { morning: .5, day: 2, evening: 1.5, night: .8 } },
};
export const IMG_KEYS = [...new Set(Object.values(GUEST_DEFS).flatMap((d) => d.img))];

export function period(hour = new Date().getHours()) {
  if (hour >= 5 && hour < 10) return 'morning';
  if (hour >= 10 && hour < 16) return 'day';
  if (hour >= 16 && hour < 19) return 'evening';
  return 'night';
}
/* 時間帯に合わせて、いま出やすいおばけを重み付きで選ぶ(pairは狸+狐を同時に出す印) */
export function pickByTime(exclude = [], hour) {
  const p = period(hour);
  const list = [];
  for (const [k, d] of Object.entries(GUEST_DEFS)) {
    if (k === 'kitsune' || exclude.includes(k)) continue;
    const w = d.w[p] || 0;
    if (w > 0) list.push([k, w]);
  }
  let r = Math.random() * list.reduce((s, [, w]) => s + w, 0);
  for (const [k, w] of list) { r -= w; if (r <= 0) return k; }
  return list.length ? list[0][0] : 'chochin';
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
    const IN = 1.4, OUT = 1.2, edge = g.hw + g.W * 0.6, rest = g.hw - g.W * 0.38;
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

const slugGeo = () => { const g = new THREE.PlaneGeometry(1, 1, 28, 1); g.translate(0, 0.5, 0); return g; };
const feetGeo = (() => { const g = new THREE.PlaneGeometry(1, 1); g.translate(0, 0.5, 0); return g; })();

export class Guest {
  /* ctx: {scene, mode, lightMul(), anchor(zone,layer)->{c,right,hw,k,depth}, shadowTex, renderOrder} */
  constructor(ctx, key, tex, opt = {}) {
    const def = GUEST_DEFS[key];
    this.ctx = ctx; this.key = key; this.def = def; this.dead = false;
    const a = ctx.anchor(def.zone, def.layer);
    this.c = a.c; this.right = a.right; this.hw = a.hw; this.k = a.k;
    this.H = def.h * a.k; this.aspect = tex.image.width / tex.image.height; this.W = this.H * this.aspect;
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
    this.group.add(this.body);
    if (ctx.mode() === 'rear' && def.zone !== 'sky') {
      this.shadowMat = new THREE.MeshBasicMaterial({ map: ctx.shadowTex, transparent: true, depthWrite: false, depthTest: false, opacity: 0 });
      this.shadow = new THREE.Mesh(ctx.flatGeo, this.shadowMat);
      this.shadow.position.y = 0.004; this.shadow.renderOrder = 4;
      this.group.add(this.shadow);
    }
    this.group.visible = false;
    ctx.scene.add(this.group);
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
    this.body.scale.set(W, H, 1);
    this.body.rotation.z = this.rz;
    this.body.position.set(hc * Math.sin(this.rz) * 0, this.y + hc * (1 - Math.cos(this.rz)), 0);
    this.body.position.x = hc * Math.sin(this.rz);   // 傾きは体の中心まわり
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
    if (this.def.motion === 'slither') this.geo.dispose();
    if (this.shadowMat) this.shadowMat.dispose();
  }
}
