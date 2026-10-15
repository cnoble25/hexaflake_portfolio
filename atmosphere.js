/*
 * Temporary snowy atmosphere: snow and fog drifting down over the winter field.
 *
 * Purely decorative. To remove it, delete this script tag and the #snow-back and #snow-front
 * canvases from index.html.
 *
 * Three depths move at different speeds for parallax: far specks and small turning flakes
 * behind the fractal, and a few big out-of-focus flakes in front of it. Fog banks drift up
 * behind everything. With reduced motion, a single still frame is drawn instead.
 */
(() => {
  "use strict";

  const back = document.getElementById("snow-back");
  const front = document.getElementById("snow-front");
  if (!back || !front) return;
  const bctx = back.getContext("2d");
  const fctx = front.getContext("2d");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const darkScheme = matchMedia("(prefers-color-scheme: dark)");

  // density: per 100,000 square pixels. size: radius in px. speed: px per second, downward.
  const LAYERS = [
    { name: "far", density: 9, size: [0.8, 1.7], speed: [14, 28], sway: 4, alpha: [0.35, 0.65], ctx: bctx },
    { name: "mid", density: 2.6, size: [4, 8], speed: [45, 85], sway: 10, alpha: [0.6, 0.9], ctx: bctx },
    { name: "near", density: 0.3, size: [20, 44], speed: [170, 270], sway: 18, alpha: [0.16, 0.3], ctx: fctx },
  ];
  const FOG_BANKS = 5;

  const rand = (a, b) => a + Math.random() * (b - a);

  let W = 0, H = 0, dpr = 1;
  let flakes = [];
  let fog = [];
  let running = false;
  let last = 0;
  let snowColor = "#fff";
  let shadeColor = "#fff";
  let fogAlpha = 0.3;
  let flakeSprite = null;
  let softSprite = null;

  // A small six-armed crystal, drawn once and stamped for every mid-depth flake.
  function makeFlakeSprite(color, edge) {
    const size = 64;
    const c = document.createElement("canvas");
    c.width = c.height = size * dpr;
    const g = c.getContext("2d");
    g.scale(dpr, dpr);
    g.translate(size / 2, size / 2);
    g.strokeStyle = color;
    g.lineCap = "round";
    g.shadowColor = edge;
    g.shadowBlur = 4;
    const R = size * 0.4;
    for (let k = 0; k < 6; k++) {
      g.save();
      g.rotate((k * Math.PI) / 3);
      g.lineWidth = 3.2;
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(R, 0);
      g.stroke();
      g.lineWidth = 2.4;
      g.beginPath();
      for (const [d, b] of [[0.45, 0.32], [0.72, 0.2]]) {
        g.moveTo(R * d + R * b * 0.5, -R * b * 0.87);
        g.lineTo(R * d, 0);
        g.lineTo(R * d + R * b * 0.5, R * b * 0.87);
      }
      g.stroke();
      g.restore();
    }
    return { c, size };
  }

  // A soft round blur, used for out-of-focus flakes and fog.
  function makeSoftSprite(color) {
    const size = 128;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    g.fillStyle = color;
    g.fillRect(0, 0, size, size);
    // Keep the color, fade its opacity from the center out to the rim.
    g.globalCompositeOperation = "destination-in";
    const mask = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    mask.addColorStop(0, "rgba(0,0,0,1)");
    mask.addColorStop(0.4, "rgba(0,0,0,0.75)");
    mask.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = mask;
    g.fillRect(0, 0, size, size);
    return { c, size };
  }

  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    snowColor = cs.getPropertyValue("--snow").trim() || "#fff";
    shadeColor = cs.getPropertyValue("--snow-shade").trim() || snowColor;
    const dark = darkScheme.matches;
    // On a pale sky, white flakes need a blue-grey edge to show; on a night sky they glow.
    flakeSprite = makeFlakeSprite(snowColor, dark ? "rgba(200,230,255,0.6)" : hexAlpha(shadeColor, 1));
    // Distant specks and out-of-focus flakes take the shade color, which is white at night.
    softSprite = makeSoftSprite(shadeColor);
    fogAlpha = dark ? 0.07 : 0.32;
  }

  function hexAlpha(hex, a) {
    const v = parseInt(hex.replace("#", ""), 16);
    return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
  }

  function spawnFlake(layer, anywhere) {
    return {
      layer,
      x: Math.random() * W,
      y: anywhere ? Math.random() * H : -layer.size[1] * 2,
      r: rand(...layer.size),
      vy: rand(...layer.speed),
      sway: layer.sway * rand(0.5, 1),
      phase: Math.random() * Math.PI * 2,
      freq: rand(0.08, 0.2),
      alpha: rand(...layer.alpha),
      angle: Math.random() * Math.PI,
      spin: rand(-0.6, 0.6),
    };
  }

  function spawnFog(anywhere) {
    const h = rand(0.22, 0.4) * H;
    return {
      x: rand(-0.2, 1.2) * W,
      y: anywhere ? rand(0, H) : -h,
      w: rand(0.8, 1.4) * W,
      h,
      vy: rand(7, 14),
      drift: rand(-6, 6),
      alpha: rand(0.6, 1),
    };
  }

  function resize() {
    W = innerWidth;
    H = innerHeight;
    dpr = Math.min(devicePixelRatio || 1, 2);
    for (const c of [back, front]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    flakes = [];
    for (const layer of LAYERS) {
      const count = Math.round((layer.density * W * H) / 100000);
      for (let i = 0; i < count; i++) flakes.push(spawnFlake(layer, true));
    }
    fog = Array.from({ length: FOG_BANKS }, () => spawnFog(true));
    readTheme();
  }

  function step(dt) {
    for (const f of flakes) {
      f.y += f.vy * dt;
      f.phase += f.freq * dt * Math.PI * 2;
      f.angle += f.spin * dt;
      if (f.y > H + f.r * 3) Object.assign(f, spawnFlake(f.layer, false));
    }
    for (const b of fog) {
      b.y += b.vy * dt;
      b.x += b.drift * dt;
      if (b.y > H + b.h) Object.assign(b, spawnFog(false));
    }
  }

  function render() {
    for (const g of [bctx, fctx]) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, W * dpr, H * dpr);
    }

    // Fog banks, furthest back.
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const b of fog) {
      bctx.globalAlpha = fogAlpha * b.alpha;
      bctx.drawImage(softSprite.c, b.x - b.w / 2, b.y - b.h / 2, b.w, b.h);
    }

    bctx.fillStyle = shadeColor;
    for (const f of flakes) {
      const g = f.layer.ctx;
      const x = f.x + Math.sin(f.phase) * f.sway;
      g.globalAlpha = f.alpha;
      if (f.layer.name === "far") {
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.beginPath();
        g.arc(x, f.y, f.r, 0, Math.PI * 2);
        g.fill();
      } else if (f.layer.name === "mid") {
        const cos = Math.cos(f.angle) * dpr, sin = Math.sin(f.angle) * dpr;
        g.setTransform(cos, sin, -sin, cos, x * dpr, f.y * dpr);
        const s = (f.r * 2 * flakeSprite.size) / (flakeSprite.size * 0.8);
        g.drawImage(flakeSprite.c, -s / 2, -s / 2, s, s);
      } else {
        // Near flakes rush past out of focus, smeared a little along their motion.
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        const w = f.r * 2, h = f.r * 2 * 1.25;
        g.drawImage(softSprite.c, x - w / 2, f.y - h / 2, w, h);
      }
    }
    bctx.globalAlpha = fctx.globalAlpha = 1;
  }

  function tick(t) {
    if (!running) return;
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    step(dt);
    render();
    requestAnimationFrame(tick);
  }

  function start() {
    if (reduceMotion.matches) {
      running = false;
      render(); // one still frame of the storm
      return;
    }
    if (running) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(tick);
  }

  reduceMotion.addEventListener("change", () => {
    running = false;
    start();
  });
  darkScheme.addEventListener("change", () => {
    readTheme();
    if (!running) render();
  });
  addEventListener("resize", () => {
    resize();
    if (!running) render();
  });

  resize();
  start();
})();
