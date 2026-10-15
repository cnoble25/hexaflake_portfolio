/*
 * The winter landscape behind the snowflake, built in WebGL with three.js: a sky gradient,
 * misty mountains, a blue forest line, rolling snow hills and cartoon snow-laden trees.
 * Everything is generated from a fixed seed, so the scene is the same on every visit.
 *
 * main.js tells it how deep the visitor has zoomed (window.landscape.setDepth) and the camera
 * creeps forward to match. Without WebGL the CSS sky gradient on #backdrop shows instead.
 */
import * as THREE from "three";

const host = document.getElementById("backdrop");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const darkScheme = matchMedia("(prefers-color-scheme: dark)");

// ---------------------------------------------------------------------------
// Palettes, sampled from the original illustration (day) and a moonlit take on it (night).

const PALETTES = {
  day: {
    skyTop: 0x2f6fc2, skyHorizon: 0xbcd4ee, glow: 0xe6f0fa,
    mountainFar: 0xa9c0e1, mountainNear: 0x93afd9,
    forestFar: 0x8aa6d8, forestNear: 0x6e8fcd,
    snow: 0xf7fafd, snowShade: 0xd3e2f3,
    needles: 0x173f3c, snowCap: 0xffffff, trunk: 0x7a3f2c,
    hemiSky: 0xd4e5fa, hemiGround: 0xb9cde6, sun: 0xfff4e6, sunIntensity: 1.5, hemiIntensity: 1.05,
  },
  night: {
    skyTop: 0x050b17, skyHorizon: 0x1d3354, glow: 0x2c4a73,
    mountainFar: 0x1f3352, mountainNear: 0x1a2c48,
    forestFar: 0x172943, forestNear: 0x13233b,
    snow: 0x9fb4d0, snowShade: 0x4f6788,
    needles: 0x0d2224, snowCap: 0xc9d8ea, trunk: 0x3a2219,
    hemiSky: 0x5a76a3, hemiGround: 0x22314a, sun: 0xaecbff, sunIntensity: 0.55, hemiIntensity: 1.1,
  },
};
let palette = darkScheme.matches ? PALETTES.night : PALETTES.day;

// Small seeded random generator, so the forest is identical on every load.
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261015);
const between = (a, b) => a + rand() * (b - a);

// Smooth 1D noise from a few summed sines; enough for ridgelines and dunes.
const ridge = (x, seed) =>
  Math.sin(x * 0.021 + seed) * 0.55 + Math.sin(x * 0.053 + seed * 2.3) * 0.3 + Math.sin(x * 0.11 + seed * 4.1) * 0.15;

// ---------------------------------------------------------------------------
// Renderer, scene, camera

let renderer;
try {
  // preserveDrawingBuffer: the scene is often drawn once and left alone (reduced motion, idle
  // tabs), and the browser must be able to recomposite that frame later.
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "low-power", preserveDrawingBuffer: true });
} catch {
  renderer = null;
}

if (renderer && host) {
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.className = "landscape-canvas";
  host.prepend(renderer.domElement);
  host.classList.add("has-landscape");

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(palette.skyHorizon, 70, 320);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 600);
  const CAMERA_HOME = new THREE.Vector3(0, 4.2, 18);
  const LOOK_AT = new THREE.Vector3(0, 7.5, -40);

  const materials = {};
  const mat = (key, make) => (materials[key] ||= make());

  // ---- Sky: a big inverted sphere with a vertical gradient and a soft glow at the horizon.
  const skyUniforms = {
    top: { value: new THREE.Color(palette.skyTop) },
    horizon: { value: new THREE.Color(palette.skyHorizon) },
    glow: { value: new THREE.Color(palette.glow) },
  };
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(500, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: skyUniforms,
      vertexShader: `varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform vec3 top; uniform vec3 horizon; uniform vec3 glow; varying vec3 vDir;
        void main() {
          float h = clamp(vDir.y * 2.6, 0.0, 1.0);
          vec3 col = mix(horizon, top, pow(h, 0.75));
          float g = exp(-pow(vDir.x * 2.2, 2.0)) * exp(-pow(max(vDir.y, 0.0) * 6.0, 2.0));
          col = mix(col, glow, g * 0.55);
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    })
  );
  scene.add(sky);

  // ---- Mountains: flat silhouettes from noisy ridgelines, faded by fog.
  function ridgeShape(width, base, height, seed, z, color) {
    const shape = new THREE.Shape();
    const steps = 90;
    shape.moveTo(-width / 2, base - 20);
    for (let i = 0; i <= steps; i++) {
      const x = -width / 2 + (i / steps) * width;
      shape.lineTo(x, base + (ridge(x, seed) * 0.5 + 0.5) * height);
    }
    shape.lineTo(width / 2, base - 20);
    // Pre-tinted rather than fogged: at this distance fog would erase them.
    const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color, fog: false }));
    mesh.position.z = z;
    mesh.userData.paletteKey = null;
    return mesh;
  }
  const mountainFar = ridgeShape(1100, 2, 70, 1.7, -330, palette.mountainFar);
  const mountainNear = ridgeShape(900, 0, 44, 4.2, -260, palette.mountainNear);
  scene.add(mountainFar, mountainNear);

  // ---- Snow ground: a wide plane with rolling dunes, shaded softly blue in the dips.
  const groundGeo = new THREE.PlaneGeometry(520, 320, 160, 100);
  groundGeo.rotateX(-Math.PI / 2);
  const gpos = groundGeo.attributes.position;
  const groundHeight = (x, z) => {
    const back = THREE.MathUtils.smoothstep(-z, 10, 120); // the far field lifts into a gentle rise
    // Big soft dunes up front, settling into a gentle rise toward the forest.
    return (
      Math.sin(x * 0.05 + 1.3) * 1.8 * (1 - back * 0.6) +
      Math.sin(x * 0.12 + z * 0.07) * 0.7 * (1 - back * 0.5) +
      Math.cos(z * 0.09 + x * 0.025) * 1.2 * (1 - back * 0.4) +
      back * 3.5
    );
  };
  for (let i = 0; i < gpos.count; i++) gpos.setY(i, groundHeight(gpos.getX(i), gpos.getZ(i) - 60));
  groundGeo.translate(0, 0, -60);
  groundGeo.computeVertexNormals();
  const ground = new THREE.Mesh(
    groundGeo,
    new THREE.MeshLambertMaterial({ color: palette.snow, emissive: palette.snowShade, emissiveIntensity: 0.4 })
  );
  scene.add(ground);
  const heightAt = (x, z) => groundHeight(x, z);

  // The snow's height exactly as drawn: interpolated on the ground mesh's own triangles
  // (160 x 100 cells over 520 x 320, shifted 60 back), so feet can rest precisely on it.
  const CELL_X = 520 / 160, CELL_Z = 320 / 100;
  function groundAt(x, z) {
    const fx = (x + 260) / CELL_X, fz = (z + 220) / CELL_Z;
    const ix = Math.floor(fx), iz = Math.floor(fz);
    if (ix < 0 || iz < 0 || ix >= 160 || iz >= 100) return groundHeight(x, z);
    const u = fx - ix, v = fz - iz;
    const x0 = ix * CELL_X - 260, z0 = iz * CELL_Z - 220;
    // PlaneGeometry splits each cell into (a, b, d) and (b, c, d).
    const ha = groundHeight(x0, z0), hb = groundHeight(x0, z0 + CELL_Z);
    const hc = groundHeight(x0 + CELL_X, z0 + CELL_Z), hd = groundHeight(x0 + CELL_X, z0);
    return u + v <= 1 ? ha + (hd - ha) * u + (hb - ha) * v : hc + (hb - hc) * (1 - u) + (hd - hc) * (1 - v);
  }

  // ---- Forest line: rows of simple cone silhouettes, instanced, tinted by distance.
  function forestRow(count, z0, z1, xSpread, scale, color) {
    const geo = new THREE.ConeGeometry(1, 3.2, 6, 1);
    geo.translate(0, 1.6, 0);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color, fog: true }), count);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const x = between(-xSpread, xSpread);
      const z = between(z0, z1);
      const k = scale * between(0.7, 1.35);
      p.set(x, heightAt(x, z) - 0.4, z);
      s.set(k * between(0.8, 1.1), k * between(0.9, 1.5), k);
      mesh.setMatrixAt(i, m.compose(p, q, s));
    }
    return mesh;
  }
  // A dense, low band of small trees on the horizon, like the illustration's misty forest.
  const forestFar = forestRow(1400, -200, -150, 320, 1.6, palette.forestFar);
  const forestNear = forestRow(900, -145, -105, 240, 1.9, palette.forestNear);
  scene.add(forestFar, forestNear);

  // ---- Cartoon pines: stacked tiers of dark needles, each wearing a lumpy cap of snow.
  const needleMat = () => mat("needles", () => new THREE.MeshLambertMaterial({ color: palette.needles }));
  const capMat = () => mat("cap", () => new THREE.MeshLambertMaterial({ color: palette.snowCap, emissive: palette.snowShade, emissiveIntensity: 0.12 }));
  const trunkMat = () => mat("trunk", () => new THREE.MeshLambertMaterial({ color: palette.trunk }));
  const clumpGeo = new THREE.IcosahedronGeometry(1, 1);

  function pine(x, z, h) {
    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(h * 0.035, h * 0.05, h * 0.2, 7), trunkMat());
    trunk.position.y = h * 0.08;
    tree.add(trunk);
    const tiers = 5;
    const clumps = [];
    for (let t = 0; t < tiers; t++) {
      const f = t / (tiers - 1);
      const radius = h * (0.36 - f * 0.25);
      const tierH = h * 0.32;
      const y = h * 0.12 + f * h * 0.66;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(radius, tierH, 9), needleMat());
      cone.position.y = y + tierH / 2;
      tree.add(cone);
      // Snow rests on the upper half of each tier: a pale cone plus a ring of clumps on the rim.
      const cap = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.86, tierH * 0.62, 9), capMat());
      cap.position.y = y + tierH * 0.66;
      tree.add(cap);
      const n = 7 + Math.round(radius * 1.2);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + between(-0.2, 0.2);
        const r = radius * between(0.55, 0.85);
        clumps.push([Math.cos(a) * r, y + tierH * between(0.32, 0.45), Math.sin(a) * r, radius * between(0.16, 0.24)]);
      }
    }
    clumps.push([0, h * 1.07, 0, h * 0.06]);
    const inst = new THREE.InstancedMesh(clumpGeo, capMat(), clumps.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    clumps.forEach(([cx, cy, cz, cr], i) => {
      p.set(cx, cy, cz);
      s.set(cr * 1.25, cr * 0.8, cr * 1.25);
      inst.setMatrixAt(i, m.compose(p, q, s));
    });
    tree.add(inst);
    tree.position.set(x, heightAt(x, z) - 0.2, z);
    tree.rotation.y = between(0, Math.PI * 2);
    return tree;
  }

  // ---- Round frosted trees: bare branches holding puffs of snow.
  function frostTree(x, z, h) {
    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(h * 0.03, h * 0.05, h * 0.5, 6), trunkMat());
    trunk.position.y = h * 0.25;
    tree.add(trunk);
    const puffs = [];
    for (let i = 0; i < 16; i++) {
      const a = rand() * Math.PI * 2;
      const r = h * between(0.05, 0.26);
      puffs.push([Math.cos(a) * r, h * between(0.5, 0.95), Math.sin(a) * r, h * between(0.1, 0.16)]);
    }
    const inst = new THREE.InstancedMesh(clumpGeo, capMat(), puffs.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    puffs.forEach(([px, py, pz, pr], i) => inst.setMatrixAt(i, m.compose(p.set(px, py, pz), q, s.set(pr, pr * 0.85, pr))));
    tree.add(inst);
    tree.position.set(x, heightAt(x, z) - 0.1, z);
    return tree;
  }

  // Trees frame both sides like the illustration, leaving the middle open for the snowflake.
  const trees = new THREE.Group();
  // x is given as a fraction of the half-width the camera sees at that depth, so the framing
  // holds on any wide screen.
  const placements = [
    ["pine", -0.8, -22, 12], ["frost", -0.52, -16, 5], ["pine", -0.96, -40, 13], ["pine", -0.68, -62, 10],
    ["frost", -0.36, -50, 4.2], ["pine", 0.78, -12, 14.5], ["frost", 0.52, -24, 5.5], ["pine", 0.96, -34, 12],
    ["pine", 0.6, -55, 10], ["frost", 0.38, -70, 4], ["pine", -0.25, -88, 7], ["pine", 0.16, -95, 6],
  ];
  const halfWidthAt = (z) => 0.55 * (CAMERA_HOME.z - z);
  const treeSpots = []; // for wildlife: trunks to climb and branches to perch on
  for (const [kind, fx, z, h] of placements) {
    const x = fx * halfWidthAt(z);
    trees.add(kind === "pine" ? pine(x, z, h) : frostTree(x, z, h));
    treeSpots.push({ kind, x, z, h });
  }
  scene.add(trees);

  // ---- Snowfall inside the scene. Each flake's position is a pure function of time, computed
  // in the vertex shader, so thousands of flakes cost the CPU nothing per frame.
  const SNOW = { count: 5000, x: 90, y: 42, z0: 16, z1: -170 };
  const snowGeo = new THREE.BufferGeometry();
  const seeds = new Float32Array(SNOW.count * 4);
  for (let i = 0; i < SNOW.count; i++) {
    seeds.set([rand(), rand(), rand(), rand()], i * 4);
  }
  snowGeo.setAttribute("seed", new THREE.BufferAttribute(seeds, 4));
  // Positions come from the shader; this attribute just gives three.js something to bound.
  snowGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SNOW.count * 3), 3));
  snowGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 20, -70), 400);
  const snowUniforms = {
    time: { value: 0 },
    color: { value: new THREE.Color(palette.snowCap) },
    fogColor: { value: new THREE.Color(palette.skyHorizon) },
    pixelRatio: { value: renderer.getPixelRatio() },
    box: { value: new THREE.Vector4(SNOW.x, SNOW.y, SNOW.z0, SNOW.z1) },
  };
  const snow = new THREE.Points(
    snowGeo,
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: snowUniforms,
      vertexShader: `
        attribute vec4 seed;
        uniform float time; uniform float pixelRatio; uniform vec4 box;
        varying float vFade;
        void main() {
          float speed = 1.6 + seed.w * 2.2;                       // world units per second
          float y = box.y - mod(seed.y * box.y + time * speed, box.y);
          float sway = sin(time * (0.4 + seed.w * 0.6) + seed.x * 40.0) * (0.6 + seed.z);
          vec3 p = vec3((seed.x * 2.0 - 1.0) * box.x + sway, y, mix(box.z, box.w, seed.z * seed.z));
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float dist = -mv.z;
          gl_PointSize = (0.9 + seed.w * 1.3) * pixelRatio * 120.0 / dist;
          // Fade into the haze far away, and out right in front of the lens.
          vFade = (1.0 - smoothstep(60.0, 190.0, dist)) * smoothstep(1.5, 5.0, dist);
        }`,
      fragmentShader: `
        uniform vec3 color; uniform vec3 fogColor;
        varying float vFade;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.15, d) * vFade;
          if (a < 0.01) discard;
          gl_FragColor = vec4(color, a * 0.9);
          #include <colorspace_fragment>
        }`,
    })
  );
  snow.frustumCulled = false;
  scene.add(snow);

  // ---- Light: bright sky fill with a low sun from the upper left, like the drawing.
  const hemi = new THREE.HemisphereLight(palette.hemiSky, palette.hemiGround, palette.hemiIntensity);
  const sun = new THREE.DirectionalLight(palette.sun, palette.sunIntensity);
  sun.position.set(-40, 50, 30);
  scene.add(hemi, sun);

  // ---------------------------------------------------------------------------
  // Theme switching

  function applyPalette() {
    palette = darkScheme.matches ? PALETTES.night : PALETTES.day;
    skyUniforms.top.value.set(palette.skyTop);
    skyUniforms.horizon.value.set(palette.skyHorizon);
    skyUniforms.glow.value.set(palette.glow);
    scene.fog.color.set(palette.skyHorizon);
    mountainFar.material.color.set(palette.mountainFar);
    mountainNear.material.color.set(palette.mountainNear);
    forestFar.material.color.set(palette.forestFar);
    forestNear.material.color.set(palette.forestNear);
    ground.material.color.set(palette.snow);
    ground.material.emissive.set(palette.snowShade);
    materials.needles?.color.set(palette.needles);
    materials.cap?.color.set(palette.snowCap);
    materials.cap?.emissive.set(palette.snowShade);
    materials.trunk?.color.set(palette.trunk);
    hemi.color.set(palette.hemiSky);
    hemi.groundColor.set(palette.hemiGround);
    hemi.intensity = palette.hemiIntensity;
    sun.color.set(palette.sun);
    sun.intensity = palette.sunIntensity;
    snowUniforms.color.value.set(palette.snowCap);
    snowUniforms.fogColor.value.set(palette.skyHorizon);
    requestRender();
  }
  darkScheme.addEventListener("change", applyPalette);

  // ---------------------------------------------------------------------------
  // Camera: a slow sway, plus a dolly forward as the visitor zooms into the snowflake.

  let depth = 0, shownDepth = 0;
  let wildlife = null;
  let lastUpdate = null;
  let needsRender = true;
  let lastFrame = 0;

  function resize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Tall screens need a wider vertical view to keep the hills and trees in frame.
    camera.fov = camera.aspect < 0.8 ? 58 : camera.aspect < 1.2 ? 46 : 38;
    camera.updateProjectionMatrix();
    requestRender();
  }

  function requestRender() {
    needsRender = true;
    if (reduceMotion.matches) frame(performance.now());
  }

  function frame(now) {
    if (!reduceMotion.matches) requestAnimationFrame(frame);
    if (document.hidden) return;
    const moving = !reduceMotion.matches;
    // ~30 fps is plenty for a calm background; animals in motion get the full frame rate.
    const minGap = wildlife?.busy ? 15 : 32;
    if (moving && now - lastFrame < minGap && !needsRender) return;
    lastFrame = now;
    if (wildlife && lastUpdate != null) wildlife.update((now - lastUpdate) / 1000);
    lastUpdate = now;
    shownDepth += (depth - shownDepth) * (moving ? 0.06 : 1);
    const t = moving ? now / 1000 : 0;
    // Reduced motion keeps a still frame of falling snow rather than none.
    snowUniforms.time.value = moving ? t : 12.5;
    camera.position.set(
      CAMERA_HOME.x + Math.sin(t * 0.07) * 1.6,
      CAMERA_HOME.y + Math.sin(t * 0.11) * 0.25,
      CAMERA_HOME.z - shownDepth * 7
    );
    camera.lookAt(LOOK_AT.x + Math.sin(t * 0.05) * 1.2, LOOK_AT.y, LOOK_AT.z);
    renderer.render(scene, camera);
    needsRender = false;
    if (!window.landscapeReady) {
      window.landscapeReady = true;
      dispatchEvent(new Event("landscape-ready"));
      loadWildlife();
    }
  }

  // Animals load only after the first frame, so they never hold up the scene or the intro.
  function loadWildlife() {
    import("wildlife")
      .then(({ createWildlife }) =>
        createWildlife({
          scene, camera, renderer, heightAt: groundAt, halfWidthAt, trees: treeSpots,
          isNight: () => darkScheme.matches,
          motion: !reduceMotion.matches,
        })
      )
      .then((w) => {
        wildlife = w;
        requestRender();
      })
      .catch((err) => console.warn("Wildlife unavailable:", err));
  }

  if (["localhost", "127.0.0.1"].includes(location.hostname)) { window.__ground = { groundAt, mesh: ground }; window.__camera = camera; }
  window.landscape = {
    setDepth(d) {
      depth = Math.max(0, Math.min(d, 4));
      requestRender();
    },
  };

  addEventListener("resize", resize);
  reduceMotion.addEventListener("change", () => requestAnimationFrame(frame));
  resize();
  requestAnimationFrame(frame);
}
