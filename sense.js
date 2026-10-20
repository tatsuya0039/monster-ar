/* ============================================================
   人の切り抜き(セグメンテーション)と、動きの検出
   ・Segmenter … MediaPipe Selfie Segmentation(同梱の selfie_segmentation* ファイル)で人のマスクを作る
                 重い/動かない端末では自動で止めて、通常表示に戻す
   ・analyzeMask … マスクから「頭の位置・手が頭より上にあるか・人の大きさ」を出す
   ・Gestures  … 近づく / 両手を上げる / 左右にゆれる を検出して名前で知らせる
   ・MotionEnergy … 映像の変化量(人がいないとき・切り抜きなしのときの代わり)
   ============================================================ */

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('load ' + src));
    document.head.appendChild(s);
  });
}

export class Segmenter {
  constructor(video) {
    this.video = video;
    this.ready = false; this.failed = false; this.busy = false;
    this.W = 192; this.H = 256;
    this.mask = document.createElement('canvas');           // アルファに「人らしさ」を入れたマスク(表示用)
    this.mask.width = 192; this.mask.height = 256;          // サイズは固定(テクスチャの作り直しを避ける)。位置は 0..1 で扱う
    this.mctx = this.mask.getContext('2d', { willReadFrequently: true });
    this.src = document.createElement('canvas');            // モデルへ渡す縮小画像
    this.sctx = this.src.getContext('2d');
    this.small = document.createElement('canvas');          // 解析用(さらに小さい)
    this.small.width = 48; this.small.height = 64;
    this.smctx = this.small.getContext('2d', { willReadFrequently: true });
    this.channel = -1;                                       // マスクが入っているチャンネル(自動判定)
    this.onMask = null;                                      // (feature|null) => void
    this.times = []; this.lastSend = 0; this.running = false;
    this.version = 0;
  }
  async init() {
    try {
      await loadScript('selfie_segmentation.js?v=4');
      this.seg = new window.SelfieSegmentation({ locateFile: (f) => f });
      this.seg.setOptions({ modelSelection: 0, selfieMode: false });
      this.seg.onResults((r) => this._results(r));
      await this.seg.initialize();
      this.ready = true;
    } catch (e) { this.failed = true; this.error = e; }
    return this.ready;
  }
  start() { this.running = true; }
  stop() { this.running = false; }
  disable(why) { this.failed = true; this.running = false; this.why = why; if (this.onMask) this.onMask(null); }

  tick(now) {
    if (!this.ready || this.failed || !this.running || this.busy) return;
    const v = this.video;
    if (!v.videoWidth || v.readyState < 2 || now - this.lastSend < 55) return;
    const W = 192, H = Math.max(2, Math.round(W * v.videoHeight / v.videoWidth));
    if (this.src.width !== W || this.src.height !== H) { this.src.width = W; this.src.height = H; }
    this.sctx.drawImage(v, 0, 0, W, H);
    this.busy = true; this.lastSend = now;
    this.seg.send({ image: this.src }).catch((e) => this.disable('send')).finally(() => { this.busy = false; });
  }
  _results(r) {
    const m = r.segmentationMask;
    if (!m) return;
    const W = 192, H = 256;
    // マスクを読み出す(小さいキャンバス経由)
    const t = this.smctx;
    t.clearRect(0, 0, 48, 64); t.drawImage(m, 0, 0, 48, 64);
    const d = t.getImageData(0, 0, 48, 64).data;
    if (this.channel < 0) {                                  // 最初の数回で、どのチャンネルが動いているか決める
      let mnA = 255, mxA = 0, mnR = 255, mxR = 0;
      for (let i = 0; i < d.length; i += 4) { mnA = Math.min(mnA, d[i + 3]); mxA = Math.max(mxA, d[i + 3]); mnR = Math.min(mnR, d[i]); mxR = Math.max(mxR, d[i]); }
      if (mxA - mnA > 20) this.channel = 3; else if (mxR - mnR > 20) this.channel = 0;
    }
    const ch = this.channel < 0 ? 3 : this.channel;
    // 表示用: 解像度の高いマスク(アルファ化)
    this.mctx.clearRect(0, 0, W, H);
    this.mctx.drawImage(m, 0, 0, W, H);
    if (ch === 0) {
      const id = this.mctx.getImageData(0, 0, W, H), p = id.data;
      for (let i = 0; i < p.length; i += 4) { p[i + 3] = p[i]; p[i] = p[i + 1] = p[i + 2] = 255; }
      this.mctx.putImageData(id, 0, 0);
    }
    this.version++;
    this.feature = analyzeMask(d, ch);
    if (this.onMask) this.onMask(this.feature);

    const now = performance.now();
    this.times.push(now);
    if (this.times.length > 24) {
      this.times.shift();
      const fps = 1000 * (this.times.length - 1) / (now - this.times[0]);
      if (fps < 5) this.disable('slow');                      // 遅い端末は切り抜きをやめる
    }
  }
}

/* マスク(48x64, チャンネル ch)から特徴を出す。座標はすべて 0..1(映像の中の位置) */
export function analyzeMask(d, ch) {
  const W = 48, H = 64, th = 110;
  const rows = new Array(H).fill(0), sumX = new Array(H).fill(0);
  let area = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (d[(y * W + x) * 4 + ch] > th) { rows[y]++; sumX[y] += x; area++; }
  }
  const frac = area / (W * H);
  if (frac < 0.02) return null;
  let topAny = -1, topHead = -1;
  for (let y = 0; y < H; y++) {
    if (topAny < 0 && rows[y] >= 1) topAny = y;
    if (rows[y] >= W * 0.17) { topHead = y; break; }          // 頭の幅くらいある最初の行
  }
  if (topHead < 0) topHead = topAny;
  let hx = 0, hn = 0;
  for (let y = topHead; y < Math.min(H, topHead + 8); y++) { hx += sumX[y]; hn += rows[y]; }
  const cx = hn ? hx / hn / W : 0.5;
  let width = 0; for (let y = topHead; y < Math.min(H, topHead + 8); y++) width = Math.max(width, rows[y] / W);
  return { area: frac, top: topHead / H, topAny: topAny / H, cx, headW: width, raised: Math.max(0, (topHead - topAny) / H) };
}

/* 動きの検出。feature は analyzeMask の結果(なければ null) */
export class Gestures {
  constructor(onGesture) {
    this.hist = []; this.cool = {}; this.onGesture = onGesture; this.raisedSince = 0;
  }
  push(f, now) {
    if (!f) { this.hist.length = 0; this.raisedSince = 0; return; }
    this.hist.push({ t: now, ...f });
    while (this.hist.length && now - this.hist[0].t > 2000) this.hist.shift();
    const fire = (name, cd = 5500) => {
      if ((this.cool[name] || 0) > now) return;
      this.cool[name] = now + cd; this.onGesture(name);
    };
    // 両手を上げる: 頭よりはっきり上に細いものが出ている状態が少し続く
    if (f.raised > 0.1) { if (!this.raisedSince) this.raisedSince = now; else if (now - this.raisedSince > 250) fire('raise'); }
    else this.raisedSince = 0;
    // ぐっと近づく: 0.8秒前より人が大きく写る
    const past = this.hist.find((h) => now - h.t < 900 && now - h.t > 450);
    if (past && f.area > 0.12 && f.area / Math.max(past.area, 0.01) > 1.32) fire('close');
    // 左右にゆれる: 1.8秒のうちに頭が左右に往復
    if (this.hist.length > 8) {
      let lo = 1, hi = 0, rev = 0, dirn = 0, ref = this.hist[0].cx;
      for (const h of this.hist) {
        lo = Math.min(lo, h.cx); hi = Math.max(hi, h.cx);
        const dx = h.cx - ref;
        if (Math.abs(dx) > 0.035) { const s = Math.sign(dx); if (dirn && s !== dirn) rev++; dirn = s; ref = h.cx; }
      }
      if (hi - lo > 0.1 && rev >= 2) fire('sway');
    }
  }
}

/* 映像の変化量(0〜1)。人の切り抜きが使えない場面の「大きく動いた」判定に使う */
export class MotionEnergy {
  constructor(video) {
    this.video = video;
    this.c = document.createElement('canvas'); this.c.width = 24; this.c.height = 32;
    this.x = this.c.getContext('2d', { willReadFrequently: true });
    this.prev = null; this.t = 0; this.energy = 0; this.run = 0;
  }
  sample(now, shaky) {
    if (now - this.t < 120 || !this.video.videoWidth) return false;
    this.t = now;
    try {
      this.x.drawImage(this.video, 0, 0, 24, 32);
      const d = this.x.getImageData(0, 0, 24, 32).data, n = d.length / 4;
      const cur = new Float32Array(n);
      for (let i = 0; i < n; i++) cur[i] = (d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11) / 255;
      if (this.prev) {
        let s = 0; for (let i = 0; i < n; i++) s += Math.abs(cur[i] - this.prev[i]);
        this.energy = s / n;
        this.run = (this.energy > 0.05 && !shaky) ? this.run + 1 : 0;
      }
      this.prev = cur;
    } catch (e) { /* 読めないときは何もしない */ }
    return this.run >= 3;
  }
}
