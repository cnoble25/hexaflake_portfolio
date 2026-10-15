/*
 * Hexaflake portfolio.
 *
 * The content is a folder tree (see source.js). Every folder is a hexagon split hexaflake-style
 * into 7 slots: the center slot is the folder's own plate (title + blurb from _index.md), the 6
 * ring slots hold its entries. Markdown files are leaves that open into a card. Folders are only
 * listed when you open them, so the tree can go as deep as the content does.
 *
 * Coordinates: the root hexagon has world radius 1 at (0, 0). The camera maps world to screen
 * with a center (cam.x, cam.y) and a scale cam.s in pixels per world unit.
 */
(() => {
  "use strict";

  // Icy section hues, assigned to top-level entries in order: glacier, frost teal, lilac, sky ice,
  // slate, periwinkle. Neighbors around the ring differ in hue or depth so they stay apart.
  // Deeper entries inherit their section's hue.
  const PALETTE = ["#2F5FA8", "#2A9E9B", "#8D6BC8", "#2E8FC9", "#4F7591", "#5B6FD3"];

  // Which ring slots to use for n children, so partial rings stay symmetric.
  const SLOT_ORDER = [[], [0], [0, 3], [0, 2, 4], [0, 1, 3, 4], [0, 1, 2, 3, 4], [0, 1, 2, 3, 4, 5]];
  const MAX_KIDS = 6;

  // The fractal is drawn as one big snowflake: every node is a hexagonal plate with six arms
  // reaching out to its ring slots, and every slot is a smaller snowflake.
  const MIN_R = 4; // smallest snowflake (CSS px radius) worth drawing
  const PLATE = 0.82; // plate radius as a share of the center slot (R / 3)
  const ARM = 0.04; // arm thickness as a share of the snowflake's radius
  // Decoration this many generations deep or less is drawn from a cached image.
  const SPRITE_MAX_LEVEL = 2;
  // Cached images per level, at sizes 3^(1/4) apart, so they're never shrunk by more than ~25%.
  // That keeps cheap image smoothing sharp; mipmapped smoothing was the main cost per frame.
  const SPRITE_STEPS = 4;
  const LN3 = Math.log(3);

  const source = window.PORTFOLIO_SOURCE;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const darkScheme = matchMedia("(prefers-color-scheme: dark)");
  const noHover = matchMedia("(hover: none)");

  const $ = (sel) => document.querySelector(sel);
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const smooth = (a, b, x) => {
    const t = clamp((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  };
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  // Only touch the DOM when a value actually changes.
  function setStyle(elm, cache, prop, value) {
    if (cache[prop] !== value) {
      cache[prop] = value;
      elm.style[prop] = value;
    }
  }

  // ---------------------------------------------------------------------------
  // Names: "2-projects" sorts second and shows as "Projects". A file's or folder's own
  // heading (in the .md, or the folder's _index.md) replaces the name once it's loaded.

  const stripOrder = (s) => s.replace(/^\d{1,3}[-_.\s]+/, "");
  const baseName = (name) => stripOrder(name).replace(/\.md$/i, "");

  function titleFrom(name) {
    const t = baseName(name).replace(/[-_]+/g, " ").trim();
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  // Labels have to fit on a small plate: drop a trailing "(...)" and calm down ALL-CAPS headings.
  // The card still shows the full heading.
  function labelFrom(title) {
    let t = title.replace(/\s*\([^)]*\)\s*$/, "").trim() || title;
    // Only long all-caps headings; short ones like "AI DJ" are acronyms.
    if (t.length > 10 && t === t.toUpperCase() && /[A-Z]/.test(t)) t = t.charAt(0) + t.slice(1).toLowerCase();
    return t;
  }

  function slug(name) {
    return (
      baseName(name)
        .toLowerCase()
        .replace(/[^a-z0-9+#]+/g, "-")
        .replace(/^-|-$/g, "") || "item"
    );
  }

  const plain = (s) =>
    s
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`>]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  // _index.md: the first heading names the folder, the first paragraph is its blurb.
  function parseIndex(md) {
    const heading = md.match(/^#\s+(.+)$/m);
    const para = md
      .split(/\n\s*\n/)
      .map((b) => b.trim())
      .find((b) => b && !b.startsWith("#"));
    return { title: heading ? plain(heading[1]) : null, blurb: para ? plain(para) : null };
  }

  // ---------------------------------------------------------------------------
  // Colors

  const theme = { paper: [0, 0, 0], plate: [0, 0, 0], ink: [0, 0, 0] };
  const colorCache = new Map();
  const sprites = new Map();
  const nodes = [];

  function rgb(hex) {
    hex = hex.trim().replace("#", "");
    if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
    const v = parseInt(hex, 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  const css = (c) => `rgb(${c.map(Math.round).join(",")})`;
  const mix = (a, b, t) => css(a.map((v, i) => v * t + b[i] * (1 - t)));

  function colorsFor(hue) {
    const key = hue || "ink";
    let c = colorCache.get(key);
    if (!c) {
      const h = hue ? rgb(hue) : theme.ink;
      const p = theme.paper;
      const dark = 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2] < 128;
      c = {
        // Arms that lead to real content; frosted toward white on dark backgrounds.
        flake: dark ? mix(h, [236, 244, 252], 0.72) : mix(h, p, 0.9),
        empty: mix(h, p, dark ? 0.4 : 0.32), // faint frost growing from unused slots
        plate: css(theme.plate),
        stroke: mix(h, theme.plate, 0.9),
        hueCSS: hue || "var(--ink)",
      };
      colorCache.set(key, c);
    }
    return c;
  }

  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    theme.paper = rgb(cs.getPropertyValue("--paper"));
    theme.plate = rgb(cs.getPropertyValue("--plate"));
    theme.ink = rgb(cs.getPropertyValue("--ink"));
    theme.paperCSS = css(theme.paper);
    theme.plateCSS = css(theme.plate);
    theme.inkCSS = css(theme.ink);
    theme.iceCSS = cs.getPropertyValue("--ice").trim();
    colorCache.clear();
    sprites.clear();
    for (const n of nodes) n.c = colorsFor(n.hue);
  }

  // ---------------------------------------------------------------------------
  // Geometry and layout

  const canvas = $("#flake");
  const ctx = canvas.getContext("2d");
  const labelLayer = $("#labels");
  let W = 0, H = 0, dpr = 1;
  let fitR = 1; // screen radius of a node that fills the view
  let cx0 = 0, cy0 = 0; // screen point the focused node is centered on
  let flat = true; // flat-topped hexagons on wide screens, pointy-topped on tall ones
  let narrow = false;
  let fontScale = 1;
  let labelBase = 16; // label font size at rest; labels are scaled from it with transforms
  let blurbsInHex = true;
  let cardW = 0, cardH = 0;
  // Each card sits in a frame covering its hexagon's bounding square. The scroll track runs
  // along the hexagon's right-hand edges, in frame coordinates, top to bottom.
  let frameS = 0;
  let trackPts = [];
  let hexR = 0; // radius of the hexagon the text is laid out in
  let trackLen = 0;
  let root = null;
  const VX = [], VY = [], SX = [], SY = [];

  function setOrientation(isFlat) {
    flat = isFlat;
    // Ring slots sit along the vertex directions, starting top-left and going clockwise.
    const vertex0 = flat ? 0 : 30;
    const slot0 = flat ? -120 : -90;
    for (let k = 0; k < 6; k++) {
      const a = ((vertex0 + 60 * k) * Math.PI) / 180;
      const b = ((slot0 + 60 * k) * Math.PI) / 180;
      VX[k] = Math.cos(a);
      VY[k] = Math.sin(a);
      SX[k] = Math.cos(b);
      SY[k] = Math.sin(b);
    }
  }

  function placeKids(n) {
    n.slots.forEach((c, k) => {
      if (!c) return;
      c.x = n.x + (SX[k] * n.r * 2) / 3;
      c.y = n.y + (SY[k] * n.r * 2) / 3;
      c.r = n.r / 3;
      placeKids(c);
    });
  }

  const labelSize = (n, r) => Math.min(n.parent ? 40 : 46, 0.82 * Math.pow(r, 0.6) * fontScale);

  function measure() {
    W = innerWidth;
    H = innerHeight;
    const newDpr = Math.min(devicePixelRatio || 1, 2);
    if (newDpr !== dpr) sprites.clear();
    dpr = newDpr;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);

    narrow = W < 560;
    const top = narrow ? 60 : 68;
    const bottom = narrow ? 60 : 52;
    const side = narrow ? 10 : 32;
    const aw = W - 2 * side;
    const ah = H - top - bottom;
    const flatFit = Math.min(aw / 2, ah / Math.sqrt(3));
    const pointyFit = Math.min(aw / Math.sqrt(3), ah / 2);
    const wasFlat = flat;
    setOrientation(flatFit >= pointyFit);
    if (wasFlat !== flat) sprites.clear();
    fitR = Math.max(flatFit, pointyFit);
    cx0 = W / 2;
    cy0 = top + ah / 2;
    fontScale = narrow ? 1.15 : 1;

    labelBase = Math.min(40, 0.82 * Math.pow(fitR, 0.6) * fontScale);
    blurbsInHex = fitR >= 330;
    labelLayer.style.setProperty("--label-base", labelBase + "px");
    for (const n of nodes) n.titleW = 0; // remeasure titles at the new base size
    labelLayer.style.setProperty("--blurb-size", clamp(fitR * 0.031, 12.5, 17) + "px");
    labelLayer.style.setProperty("--blurb-width", fitR * 0.4 + "px");

    // Cards are sized for the fully zoomed-in view and scaled on the way there.
    frameS = 2 * fitR;
    const plateR = 0.97 * fitR; // an open leaf's plate
    if (narrow) {
      cardW = W - 24;
      cardH = Math.min(ah - 8, 600);
    } else {
      // A tall text column whose corners sit just inside the plate's slanted edges.
      const half = 0.7 * plateR;
      const across = plateR - half / Math.sqrt(3) - 0.04 * plateR;
      [cardW, cardH] = flat ? [2 * across, 2 * half] : [2 * half, 2 * across];
    }
    hexR = 0.9 * plateR;
    const trackR = plateR - 10;
    trackPts = VX.map((vx, k) => [vx, VY[k]])
      .filter(([vx]) => vx > -0.01)
      .sort((a, b) => a[1] - b[1])
      .map(([vx, vy]) => [fitR + vx * trackR, fitR + vy * trackR]);
    trackLen = 0;
    for (let i = 1; i < trackPts.length; i++) trackLen += Math.hypot(trackPts[i][0] - trackPts[i - 1][0], trackPts[i][1] - trackPts[i - 1][1]);
    for (const n of nodes) if (n.cardEl) sizeCard(n);
    if (root) placeKids(root);
  }

  function sizeCard(n) {
    n.frameEl.style.width = n.frameEl.style.height = frameS + "px";
    n.trackSvg.setAttribute("viewBox", `0 0 ${frameS} ${frameS}`);
    const d = "M" + trackPts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L");
    for (const path of n.trackSvg.children) path.setAttribute("d", d);
    fitCard(n);
  }

  const MIN_K = 0.85; // smallest text scale before a card scrolls instead

  // Lay the text out inside the hexagon if it fits (shrinking it a little if needed);
  // otherwise use a plain scrolling column with the edge scrollbar.
  function fitCard(n) {
    const C = n.cardEl;
    C.scrollTop = 0;
    if (narrow) {
      setRect(n, 1);
      C.style.width = cardW + "px";
      C.style.height = "auto";
      C.style.maxHeight = cardH + "px";
      return updateScroll(n);
    }
    const w = flat ? 2 * hexR : Math.sqrt(3) * hexR;
    const h = flat ? Math.sqrt(3) * hexR : 2 * hexR;
    C.classList.add("is-hex");
    C.classList.toggle("is-flat", flat);
    C.classList.toggle("is-pointy", !flat);
    C.style.width = w + "px";
    C.style.height = C.style.maxHeight = h + "px";
    for (const s of n.shapeEls) {
      s.style.width = (flat ? hexR / 2 : w / 2) + "px";
      s.style.height = h + "px";
      s.style.shapeMargin = hexR * 0.07 + "px";
    }
    const fits = () => C.scrollHeight <= C.clientHeight + 1;
    for (let k = 1; k >= MIN_K - 0.001; k -= 0.05) {
      C.style.setProperty("--k", k.toFixed(2));
      n.spacerEl.style.height = "0px";
      if (!fits()) continue;
      // Center vertically: push the text down by half the free space, backing off if pushing
      // it into the narrower bottom of the hexagon makes it overflow.
      const body = n.cardBody;
      const used = body.offsetTop + body.offsetHeight - n.spacerEl.offsetTop;
      for (let pad = Math.max(0, (h - used) / 2); pad >= 1; pad /= 2) {
        n.spacerEl.style.height = pad + "px";
        if (fits()) break;
        n.spacerEl.style.height = "0px";
      }
      return updateScroll(n);
    }
    setRect(n, 1);
    C.style.width = cardW + "px";
    C.style.height = C.style.maxHeight = cardH + "px";
    updateScroll(n);
  }

  function setRect(n, k) {
    n.cardEl.classList.remove("is-hex", "is-flat", "is-pointy");
    n.cardEl.style.setProperty("--k", k);
  }

  // The hexagon-edge scrollbar: a thumb drawn as a dash sliding along the track.
  function updateScroll(n) {
    const C = n.cardEl;
    const max = C.scrollHeight - C.clientHeight;
    const scrollable = !narrow && max > 2;
    n.frameEl.classList.toggle("is-scrollable", scrollable);
    C.classList.toggle("has-more", max > 2 && C.scrollTop < max - 2);
    if (!scrollable) return;
    n.thumbLen = Math.max(28, (trackLen * C.clientHeight) / C.scrollHeight);
    const offset = (trackLen - n.thumbLen) * (C.scrollTop / max);
    n.thumbEl.style.strokeDasharray = `${n.thumbLen.toFixed(1)} ${(trackLen * 2).toFixed(1)}`;
    n.thumbEl.style.strokeDashoffset = (-offset).toFixed(1);
  }

  // Distance along the track to the point level with y (the track only ever runs downward).
  function trackDistanceAt(y) {
    let dist = 0;
    for (let i = 1; i < trackPts.length; i++) {
      const [x0, y0] = trackPts[i - 1], [x1, y1] = trackPts[i];
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (y <= y1) return dist + len * clamp((y - y0) / (y1 - y0 || 1));
      dist += len;
    }
    return dist;
  }

  // Dragging or clicking on the track scrolls so the thumb centers on the pointer.
  function scrollToPointer(n, e) {
    const box = n.frameEl.getBoundingClientRect();
    const y = ((e.clientY - box.top) / box.height) * frameS;
    const C = n.cardEl;
    const frac = clamp((trackDistanceAt(y) - n.thumbLen / 2) / (trackLen - n.thumbLen));
    C.scrollTop = frac * (C.scrollHeight - C.clientHeight);
  }

  function inHex(dx, dy, r) {
    if (!flat) [dx, dy] = [dy, dx];
    dx = Math.abs(dx);
    dy = Math.abs(dy);
    const h = (r * Math.sqrt(3)) / 2;
    return dy <= h && dx * h + (dy * r) / 2 <= r * h;
  }

  // ---------------------------------------------------------------------------
  // Content tree, loaded lazily one folder at a time

  function makeNode(parent, entry, index, taken) {
    const isDir = entry.type === "dir";
    const n = {
      parent,
      depth: parent ? parent.depth + 1 : 0,
      fsPath: parent ? parent.fsPath + entry.name + (isDir ? "/" : "") : "",
      title: parent ? (entry.title ? labelFrom(entry.title) : titleFrom(entry.name)) : source.siteTitle || "",
      titled: !!entry.title, // the source already named it; don't rename it from the card's heading
      hue: parent ? (parent.depth === 0 ? PALETTE[index % PALETTE.length] : parent.hue) : null,
      leaf: !isDir,
      loaded: false,
      loading: null,
      error: null,
      loadedAt: -Infinity,
      kids: [],
      slots: [null, null, null, null, null, null],
      blurb: null,
      x: 0,
      y: 0,
      r: 1,
    };
    let id = parent ? slug(entry.name) : "";
    if (taken) {
      const base = id;
      for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
      taken.add(id);
    }
    n.id = id;
    n.ids = parent ? parent.ids.concat(id) : [];
    n.hash = "#/" + n.ids.map(encodeURIComponent).join("/");
    n.c = colorsFor(n.hue);
    createLabel(n);
    if (n.leaf) createCard(n);
    nodes.push(n);
    return n;
  }

  let lastChange = -Infinity;

  function load(n) {
    if (n.loaded) return Promise.resolve(n);
    if (n.loading) return n.loading;
    n.error = null;
    n.loading = (n.leaf ? loadFile(n) : loadDir(n))
      .then(
        () => (n.loaded = true),
        (err) => {
          n.error = err;
          console.error(err);
        }
      )
      .then(() => {
        n.loading = null;
        n.loadedAt = lastChange = performance.now();
        afterLoad(n);
        request();
        return n;
      });
    return n.loading;
  }

  async function loadDir(n) {
    const [entries, about] = await Promise.all([
      source.list(n.fsPath),
      source.describe ? source.describe(n.fsPath) : null,
    ]);
    let items = entries.filter((e) => !e.name.startsWith("."));
    // Sources like the VFS API keep their own order; plain folders sort by (numbered) name.
    if (!source.ordered) items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    if (items.length > MAX_KIDS) {
      console.warn(`"/${n.fsPath}" has ${items.length} entries; only the first ${MAX_KIDS} are shown.`);
      items = items.slice(0, MAX_KIDS);
    }

    if (about) {
      const info = parseIndex(about);
      if (info.title) n.title = labelFrom(info.title);
      n.blurb = info.blurb;
    }

    const taken = new Set();
    n.kids = items.map((e, i) => makeNode(n, e, i, taken));
    SLOT_ORDER[n.kids.length].forEach((s, i) => (n.slots[s] = n.kids[i]));
    placeKids(n);
  }

  async function loadFile(n) {
    renderCard(n, await source.read(n.fsPath));
  }

  // ---------------------------------------------------------------------------
  // Labels and cards (DOM layered over the canvas so text stays crisp and accessible)

  // Long titles go on two balanced lines so they can stay larger on a small plate.
  function setTitle(n) {
    const t = n.title;
    const spaces = [...t.matchAll(/ /g)].map((m) => m.index);
    if (t.length <= 12 || !spaces.length) {
      n.titleEl.textContent = t;
    } else {
      const cut = spaces.reduce((best, i) => (Math.abs(i - t.length / 2) < Math.abs(best - t.length / 2) ? i : best));
      n.titleEl.replaceChildren(t.slice(0, cut), el("br"), t.slice(cut + 1));
    }
    n.titleW = 0;
  }

  function createLabel(n) {
    const b = el("button", "node-label" + (n.parent ? "" : " is-root"));
    b.type = "button";
    b.tabIndex = -1;
    b.setAttribute("aria-hidden", "true");
    n.titleEl = el("span", "t");
    setTitle(n);
    n.blurbEl = el("span", "b");
    b.append(n.titleEl, n.blurbEl);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (n === focus) return;
      kbNav = e.detail === 0;
      navigate(n);
    });
    n.labelEl = b;
    n.ls = {};
    n.bs = {};
    labelLayer.append(b);
  }

  function createCard(n) {
    const frame = el("div", "card-frame");
    frame.inert = true;
    frame.style.setProperty("--hue", n.c.hueCSS);
    const a = el("article", "card");
    a.tabIndex = -1;
    a.setAttribute("aria-label", n.title);
    const body = el("div", "card-body");
    body.append(el("h1", null, n.title), el("p", "card-status", "Loading…"));
    n.shapeEls = [el("div", "card-shape l"), el("div", "card-shape r")];
    n.spacerEl = el("div", "card-spacer");
    a.append(...n.shapeEls, n.spacerEl, body);
    a.addEventListener("scroll", () => updateScroll(n), { passive: true });

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "card-track");
    svg.setAttribute("aria-hidden", "true");
    const [rail, thumb, hit] = ["rail", "thumb", "hit"].map((cls) => {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("class", cls);
      svg.append(path);
      return path;
    });
    hit.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      hit.setPointerCapture(e.pointerId);
      const move = (ev) => scrollToPointer(n, ev);
      move(e);
      hit.addEventListener("pointermove", move);
      hit.addEventListener("pointerup", () => hit.removeEventListener("pointermove", move), { once: true });
    });
    hit.addEventListener("click", (e) => e.stopPropagation());

    frame.append(a, svg);
    n.frameEl = frame;
    n.cardEl = a;
    n.cardBody = body;
    n.trackSvg = svg;
    n.thumbEl = thumb;
    n.thumbLen = 0;
    n.cs = {};
    labelLayer.append(frame);
    sizeCard(n);
  }

  function renderCard(n, md) {
    const body = n.cardBody;
    if (window.marked) body.innerHTML = window.marked.parse(md);
    else body.replaceChildren(el("pre", null, md));
    const h1 = body.querySelector("h1");
    if (!h1) body.prepend(el("h1", null, n.title));
    else if (!n.titled) n.title = h1.textContent.trim() || n.title;

    // An italic line right under the title reads as the card's subtitle.
    const sub = body.querySelector("h1 + p");
    if (sub && sub.childElementCount === 1 && sub.firstElementChild.tagName === "EM" && sub.textContent.trim() === sub.firstElementChild.textContent.trim()) {
      sub.classList.add("meta");
    }
    // Lists of bare links become a link row; lists of short items become tags.
    const onlyLink = (li) => li.childElementCount === 1 && li.firstElementChild.tagName === "A" && li.textContent.trim() === li.firstElementChild.textContent.trim();
    for (const ul of body.querySelectorAll("ul")) {
      const items = [...ul.children];
      if (items.every(onlyLink)) ul.classList.add("links");
      else if (items.every((li) => !li.querySelector("ul, ol, p") && li.textContent.trim().length <= 32)) ul.classList.add("tags");
    }
    // Relative links and images resolve against the file's own folder.
    const dir = n.fsPath.slice(0, n.fsPath.lastIndexOf("/") + 1);
    for (const e of body.querySelectorAll("[src], [href]")) {
      const attr = e.hasAttribute("src") ? "src" : "href";
      const v = e.getAttribute(attr);
      if (v && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(v)) e.setAttribute(attr, source.url(dir + v));
    }
    for (const a of body.querySelectorAll("a[href]")) {
      if (/^https?:/.test(a.href) && new URL(a.href).origin !== location.origin) {
        a.target = "_blank";
        a.rel = "noopener";
      }
    }
    fitCard(n);
  }

  function afterLoad(n) {
    if (n === root && !n.title) n.title = source.siteTitle || "Portfolio";
    setTitle(n);
    n.blurbEl.textContent = n.blurb || "";
    if (n.cardEl) n.cardEl.setAttribute("aria-label", n.title);

    if (n.error) {
      if (n.leaf) {
        n.cardBody.replaceChildren(el("h1", null, n.title), el("p", "card-status", `Couldn't load this file. ${n.error.message}`));
      } else {
        setStatus(`Couldn't open ${n === root ? "the portfolio" : n.title}. ${n.error.message}`);
      }
    }
    if (n === focus || n === root) refreshFocusState();
    if (n === focus && kbWaitingForKids && n.kids[0]) {
      kbWaitingForKids = false;
      n.kids[0].labelEl.focus({ preventScroll: true });
    }
  }

  // ---------------------------------------------------------------------------
  // Camera

  const cam = { x: 0, y: 0, s: 1 };
  let anim = null;

  const toScreen = (n) => [(n.x - cam.x) * cam.s + cx0, (n.y - cam.y) * cam.s + cy0, n.r * cam.s];

  function snapTo(n) {
    cam.x = n.x;
    cam.y = n.y;
    cam.s = fitR / n.r;
  }

  // Van Wijk & Nuij smooth zoom (same math as d3.interpolateZoom). Views are [x, y, width].
  function interpolateZoom([ux0, uy0, w0], [ux1, uy1, w1]) {
    const rho = Math.SQRT2, rho2 = 2, rho4 = 4;
    const dx = ux1 - ux0, dy = uy1 - uy0, d2 = dx * dx + dy * dy;
    let i, S;
    if (d2 < 1e-24) {
      S = Math.log(w1 / w0) / rho;
      i = (t) => [ux0 + t * dx, uy0 + t * dy, w0 * Math.exp(rho * t * S)];
    } else {
      const d1 = Math.sqrt(d2);
      const b0 = (w1 * w1 - w0 * w0 + rho4 * d2) / (2 * w0 * rho2 * d1);
      const b1 = (w1 * w1 - w0 * w0 - rho4 * d2) / (2 * w1 * rho2 * d1);
      const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
      const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
      S = (r1 - r0) / rho;
      i = (t) => {
        const s = t * S, c0 = Math.cosh(r0);
        const u = (w0 / (rho2 * d1)) * (c0 * Math.tanh(rho * s + r0) - Math.sinh(r0));
        return [ux0 + u * dx, uy0 + u * dy, (w0 * c0) / Math.cosh(rho * s + r0)];
      };
    }
    i.duration = Math.abs(S) * 1000;
    return i;
  }

  // ---------------------------------------------------------------------------
  // Drawing

  let reveal = reduceMotion.matches ? 1 : 0;
  let revealStart = null;
  let introRunning = false; // the crystal waits to grow until the opening shot hands off
  let revealOverride = null; // only set by the intro preview
  let rootSX = 0, rootSY = 0, rootSR = 1;
  let hover = null;
  let now = 0;

  // The focused node, plus the one we're flying away from, are the only ones allowed to open up.
  const isOpen = (n) => n === focus || (anim && n === anim.from);

  // Children of a folder that just loaded fade in.
  const appear = (n) => (n.parent ? smooth(0, 350, now - n.parent.loadedAt) : 1);

  // The undimmed window follows the camera from the old focus to the new one.
  let hole = [0, 0, 1];
  function updateHole(t) {
    const b = focus, a = anim ? anim.from : b;
    hole = [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.r * Math.pow(b.r / a.r, t)];
  }
  const holeScreen = () => [(hole[0] - cam.x) * cam.s + cx0, (hole[1] - cam.y) * cam.s + cy0, hole[2] * cam.s];

  const offscreen = (x, y, r) => x + r < 0 || x - r > W || y + r < 0 || y - r > H;

  // During the intro, the crystal grows outward from the center.
  function revealScale(x, y) {
    if (reveal >= 1) return 1;
    const d = Math.hypot(x - rootSX, y - rootSY) / rootSR;
    return easeOut(clamp((reveal * 1.35 - d) / 0.35));
  }

  const armWidth = (R) => Math.max(0.6, R * ARM);

  // Works on both a Path2D and a canvas context.
  function hexInto(p, x, y, r) {
    p.moveTo(x + VX[0] * r, y + VY[0] * r);
    for (let k = 1; k < 6; k++) p.lineTo(x + VX[k] * r, y + VY[k] * r);
    p.closePath();
  }

  // A decorative snowflake `levels` generations deep: six arms, each ending in a smaller
  // snowflake. Drawn a generation at a time so each gets its own arm thickness.
  function drawFlake(g, x, y, R, levels) {
    let gen = [[x, y]];
    for (let l = 0, r = R; l <= levels; l++, r /= 3) {
      const d = (r * 2) / 3;
      const next = [];
      g.lineWidth = armWidth(r);
      g.beginPath();
      for (const [px, py] of gen) {
        for (let k = 0; k < 6; k++) {
          const cx = px + VX[k] * d, cy = py + VY[k] * d;
          g.moveTo(px, py);
          g.lineTo(cx, cy);
          next.push([cx, cy]);
        }
      }
      g.stroke();
      // A small plate at every junction, like the nodes of a real dendrite.
      if (r * 0.08 >= 0.6) {
        g.beginPath();
        for (const [px, py] of gen) hexInto(g, px, py, r * 0.08);
        g.fill();
      }
      gen = next;
    }
  }

  // Cached decoration, one image per color, depth and size step.
  function sprite(color, level, step) {
    const key = color + "|" + level + "|" + step;
    let s = sprites.get(key);
    if (s) return s;
    const R = MIN_R * Math.pow(3, level + (step + 1) / SPRITE_STEPS); // CSS px
    const size = Math.ceil(2 * (R + armWidth(R))) + 2;
    const c = document.createElement("canvas");
    c.width = c.height = Math.ceil(size * dpr);
    const g = c.getContext("2d");
    g.scale(dpr, dpr);
    g.strokeStyle = g.fillStyle = color;
    g.lineCap = "round";
    drawFlake(g, size / 2, size / 2, R, level);
    s = { c, R, size };
    sprites.set(key, s);
    return s;
  }

  let lines, fills, plates;

  // Arms and plates of levels you've zoomed well past fade out, so ancestors don't slice across
  // the view as giant slabs.
  const pastFade = (R) => 1 - smooth(1.3, 2.6, R / fitR);

  function line(color, w, alpha, x0, y0, x1, y1) {
    alpha = Math.round(alpha * 20) / 20;
    if (alpha <= 0) return;
    const key = color + "|" + w.toFixed(2) + "|" + alpha;
    let b = lines.get(key);
    if (!b) lines.set(key, (b = { color, w, alpha, p: new Path2D() }));
    b.p.moveTo(x0, y0);
    b.p.lineTo(x1, y1);
  }

  function decor(color, x, y, R) {
    if (R < MIN_R || offscreen(x, y, R + armWidth(R))) return;
    const k = revealScale(x, y);
    if (k <= 0) return;
    const t = Math.log(R / MIN_R) / LN3;
    const level = Math.floor(t);
    if (level <= SPRITE_MAX_LEVEL) {
      const s = sprite(color, level, Math.min(SPRITE_STEPS - 1, Math.floor((t - level) * SPRITE_STEPS)));
      const f = (R * k) / s.R;
      ctx.drawImage(s.c, x - (s.size / 2) * f, y - (s.size / 2) * f, s.size * f, s.size * f);
      return;
    }
    // Too big to cache: draw this generation's arms directly and recurse.
    const d = (R * 2) / 3, w = armWidth(R), fade = pastFade(R);
    for (let j = 0; j < 6; j++) {
      const cx = x + VX[j] * d, cy = y + VY[j] * d;
      line(color, w, fade, x, y, x + (cx - x) * k, y + (cy - y) * k);
      decor(color, cx, cy, R / 3);
    }
    let p = fills.get(color);
    if (!p) fills.set(color, (p = new Path2D()));
    hexInto(p, x, y, R * 0.08 * k);
  }

  function content(n, x, y, R) {
    if (offscreen(x, y, R + armWidth(R))) return;
    // Too small for a readable plate: just its crystal.
    if (R < MIN_R * 9) {
      decor(n.c.flake, x, y, R);
      return;
    }
    // Unopened folders and files grow a full set of arms; opened folders show their entries.
    const r3 = R / 3;
    const opened = !n.leaf && n.loaded;
    const w = armWidth(R), fade = pastFade(R);
    // Arms grow out of this plate once the intro's reveal front reaches it.
    const grow = revealScale(x, y);
    for (let j = 0; j < 6; j++) {
      const sx = x + SX[j] * 2 * r3, sy = y + SY[j] * 2 * r3;
      const c = opened ? n.slots[j] : null;
      const color = c ? c.c.flake : opened ? n.c.empty : n.c.flake;
      if (grow > 0) line(color, w, fade, x, y, x + (sx - x) * grow, y + (sy - y) * grow);
      if (c) content(c, sx, sy, r3);
      else decor(color, sx, sy, r3);
    }
    // A leaf's plate grows to fill its whole hexagon as you zoom in, making room for its card.
    let pr = r3 * PLATE;
    if (n.leaf && isOpen(n)) pr += (0.97 * R - pr) * smooth(0.4, 0.95, R / fitR);
    pr *= grow;
    if (pr >= 0.8) plates.push([n, x, y, pr, smooth(MIN_R * 9, MIN_R * 15, R) * (1 - smooth(1.5, 3, R / fitR))]);
  }

  function hexPath(x, y, r) {
    ctx.beginPath();
    hexInto(ctx, x, y, r);
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingQuality = "low";
    ctx.lineCap = "round";
    lines = new Map();
    fills = new Map();
    plates = [];
    [rootSX, rootSY, rootSR] = toScreen(root);
    content(root, rootSX, rootSY, rootSR);

    for (const { color, w, alpha, p } of lines.values()) {
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.globalAlpha = alpha;
      ctx.stroke(p);
    }
    ctx.globalAlpha = 1;
    for (const [color, p] of fills) {
      ctx.fillStyle = color;
      ctx.fill(p);
    }
    for (const [n, x, y, r, a] of plates) {
      if (a < 0.01) continue;
      hexPath(x, y, r);
      ctx.globalAlpha = a * appear(n);
      ctx.fillStyle = n.c.plate;
      ctx.fill();
      ctx.lineWidth = n === root ? clamp(r * 0.025, 1.5, 3.5) : clamp(r * 0.03, 0.75, 2.5);
      ctx.strokeStyle = n === root ? theme.iceCSS : n.c.stroke;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Fade everything outside the open node so the eye stays on it. Erasing (rather than painting
    // over) lets the background and its falling snow show through untouched.
    const [hx, hy, hr] = holeScreen();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    hexInto(ctx, hx, hy, hr);
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "#000";
    ctx.globalAlpha = 0.6;
    ctx.fill("evenodd");
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    if (hover && !anim) {
      const [x, y, r] = toScreen(hover);
      hexPath(x, y, (r / 3) * PLATE);
      ctx.lineWidth = 2;
      ctx.strokeStyle = theme.inkCSS;
      ctx.globalAlpha = 0.7;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // Labels only ever change transform and opacity per frame, so the browser never re-lays out text.
  function updateLabels() {
    const revealAlpha = smooth(0.55, 1, reveal);
    const [hx, hy, hr] = holeScreen();
    // Measure any new titles in one pass, before this frame writes any styles.
    for (const n of nodes) if (!n.titleW) n.titleW = n.titleEl.offsetWidth || 1;
    const plateSpan = (flat ? 2 : Math.sqrt(3)) * (PLATE / 3) * 0.84;
    for (const n of nodes) {
      const [x, y, r] = toScreen(n);
      const rel = r / fitR;
      const L = n.labelEl, S = n.ls;

      let a = 0, f = 0;
      if (r > 4 && !offscreen(x, y, r * 0.4)) {
        // Titles shrink to fit across their plate, but never below a readable size.
        f = Math.min(labelSize(n, r), Math.max(11.5, (labelBase * plateSpan * r) / n.titleW));
        // Readable size fades in; ancestors we've zoomed past fade out.
        a = smooth(9, 12.5, f) * smooth(MIN_R * 9, MIN_R * 15, r) * (1 - smooth(1.5, 2.4, rel)) * revealAlpha * appear(n);
        if (n.leaf && isOpen(n)) a *= 1 - smooth(0.6, 0.85, rel);
        if (!inHex(x - hx, y - hy, hr * 1.01)) a *= 0.4;
      }

      if (a < 0.01) {
        setStyle(L, S, "visibility", "hidden");
        // The blurb sets its own visibility, so it has to be hidden explicitly too.
        setStyle(n.blurbEl, n.bs, "visibility", "hidden");
      } else {
        const ba = n.blurb && blurbsInHex ? smooth(0.55, 0.9, rel) : 0;
        setStyle(L, S, "visibility", "visible");
        setStyle(L, S, "opacity", a.toFixed(3));
        setStyle(L, S, "pointerEvents", a > 0.5 ? "auto" : "none");
        // Nudge the title up as the blurb appears so the pair stays centered.
        setStyle(L, S, "transform", `translate(${x.toFixed(1)}px, ${(y - ba * r * 0.07).toFixed(1)}px) translate(-50%, -50%) scale(${(f / labelBase).toFixed(4)})`);
        setStyle(n.blurbEl, n.bs, "opacity", ba.toFixed(3));
        setStyle(n.blurbEl, n.bs, "visibility", ba < 0.01 ? "hidden" : "visible");
      }

      if (n.frameEl) {
        const F = n.frameEl, FS = n.cs;
        const ca = isOpen(n) ? smooth(0.82, 0.99, rel) * (1 - smooth(1.3, 1.8, rel)) : 0;
        if (ca < 0.01) {
          setStyle(F, FS, "visibility", "hidden");
        } else {
          setStyle(F, FS, "visibility", "visible");
          setStyle(F, FS, "opacity", ca.toFixed(3));
          setStyle(F, FS, "transform", `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%) scale(${rel.toFixed(4)})`);
        }
        // The frame itself never takes clicks; the card and track do once it's open.
        const live = ca > 0.6;
        if (FS.live !== live) {
          FS.live = live;
          F.classList.toggle("is-live", live);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Frame loop

  let queued = false;

  function request() {
    if (queued || !root) return;
    queued = true;
    requestAnimationFrame(frame);
  }

  function frame(t) {
    queued = false;
    now = performance.now();
    let more = now - lastChange < 400;

    if (revealOverride != null) {
      reveal = revealOverride;
    } else if (reveal < 1 && introRunning) {
      more = true;
    } else if (reveal < 1) {
      if (revealStart == null) revealStart = t;
      reveal = clamp((t - revealStart) / 1500);
      more = true;
      if (reveal >= 1) onRevealDone();
    }

    if (anim) {
      const p = clamp((now - anim.start) / anim.dur);
      const [x, y, w] = anim.i(easeInOut(p));
      cam.x = x;
      cam.y = y;
      cam.s = (2 * fitR) / w;
      if (p >= 1) {
        anim = null;
        onArrive();
      } else {
        more = true;
      }
      updateHole(easeInOut(p));
    } else {
      updateHole(1);
    }

    draw();
    updateLabels();
    updateBackdrop();
    if (more) request();
  }

  // The landscape drifts slightly as you zoom in, for a sense of depth.
  const backdrop = $("#backdrop");
  let backdropScale = 0;
  function updateBackdrop() {
    if (!backdrop) return;
    const depth = Math.max(0, Math.log(cam.s / (fitR / root.r)) / LN3);
    const scale = 1 + Math.min(depth, 4) * 0.025;
    if (Math.abs(scale - backdropScale) < 0.0005) return;
    backdropScale = scale;
    // The 3D landscape dollies forward instead; the flat fallback just scales a little.
    if (window.landscape) window.landscape.setDepth(depth);
    else backdrop.style.setProperty("--drift-scale", scale.toFixed(4));
  }

  // ---------------------------------------------------------------------------
  // Opening shot: the field in focus with snow falling, one snowflake drifts down to the center,
  // then the camera zooms into it (the field defocusing behind) and it becomes the hexaflake.

  const INTRO = { fall: 1700, zoom: 1300, fade: 600 };
  const easeOutQuad = (t) => 1 - (1 - t) * (1 - t);

  function playIntro() {
    const flake = $("#intro-flake");
    const skip =
      !flake || !backdrop || reduceMotion.matches || (location.hash && location.hash !== "#/" && location.hash !== "#");
    if (skip) return;

    introRunning = true;
    document.body.classList.add("is-intro");
    backdrop.style.setProperty("--intro-scale", "1");
    backdrop.style.setProperty("--intro-blur", "0px");

    // End on an angle where the flake's arms line up with the hexaflake's.
    const turns = flat ? 150 : 180;
    const startX = cx0 + Math.min(W * 0.12, 140);
    let start = null; // set from the first frame's timestamp, so both ends use the same clock
    let handedOff = false;
    let done = false;

    function handOff() {
      if (handedOff) return;
      handedOff = true;
      introRunning = false; // the crystal starts growing on the next frame
      document.body.classList.remove("is-intro");
      request();
    }

    function finish() {
      if (done) return;
      done = true;
      handOff();
      flake.style.visibility = "hidden";
      backdrop.style.setProperty("--intro-scale", "1.1");
      backdrop.style.setProperty("--intro-blur", "0.7px");
      for (const type of ["pointerdown", "keydown", "wheel"]) removeEventListener(type, finish, true);
    }
    for (const type of ["pointerdown", "keydown", "wheel"]) addEventListener(type, finish, { capture: true, passive: true });

    // Pose everything for time t (ms). Returns false once the shot is over.
    function pose(t) {
      let x, y, size, rot, opacity = 1;
      if (t < INTRO.fall) {
        // Drift down and in, swaying, getting a little closer.
        const p = t / INTRO.fall;
        const e = easeOutQuad(p);
        x = startX + (cx0 - startX) * e + Math.sin(p * Math.PI * 2.2) * 22 * (1 - e);
        y = -40 + (cy0 + 40) * e;
        size = 30 + 18 * e;
        rot = 100 * e;
      } else {
        // Rush toward it: exponential growth reads as a steady camera move.
        const p = clamp((t - INTRO.fall) / INTRO.zoom);
        const e = easeInOut(p);
        x = cx0;
        y = cy0;
        size = 48 * Math.pow((1.85 * fitR) / 48, e);
        rot = 100 + (turns - 100) * e;
        backdrop.style.setProperty("--intro-scale", (1 + 0.1 * e).toFixed(4));
        backdrop.style.setProperty("--intro-blur", (0.7 * e).toFixed(2) + "px");
        if (p > 0.72) handOff();
        // The real crystal grows out of it while it dissolves.
        opacity = 1 - clamp((t - INTRO.fall - INTRO.zoom * 0.72) / INTRO.fade);
        if (opacity <= 0) return false;
      }
      // Resize the element itself (not a scale transform) so the vector flake is redrawn
      // sharp at every size instead of a small bitmap being stretched.
      flake.style.opacity = opacity.toFixed(3);
      flake.style.width = flake.style.height = size.toFixed(1) + "px";
      flake.style.transform =
        `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%) rotate(${rot.toFixed(1)}deg)`;
      return true;
    }

    // Development aid: on localhost, ?intro=1800 freezes the shot at 1.8 s.
    const previewParam = new URLSearchParams(location.search).get("intro");
    const preview =
      previewParam !== null && ["localhost", "127.0.0.1"].includes(location.hostname) ? Number(previewParam) : NaN;
    if (Number.isFinite(preview) && preview >= 0) {
      for (const type of ["pointerdown", "keydown", "wheel"]) removeEventListener(type, finish, true);
      flake.style.visibility = "visible";
      if (!pose(preview)) finish();
      const handOffAt = INTRO.fall + INTRO.zoom * 0.72;
      if (preview > handOffAt) revealOverride = clamp((preview - handOffAt) / 1500);
      return;
    }

    function step(now) {
      if (done) return;
      if (start == null) {
        start = now;
        flake.style.visibility = "visible";
      }
      if (!pose(now - start)) return finish();
      requestAnimationFrame(step);
    }
    // Let the 3D landscape build and draw its first frame before anything moves, so a slow
    // setup can't stutter the fall (capped, in case WebGL is slow or missing).
    let begun = false;
    const begin = () => {
      if (begun) return;
      begun = true;
      requestAnimationFrame(step);
    };
    if (window.landscapeReady || !document.querySelector('script[src*="landscape"]')) begin();
    else {
      const timer = setTimeout(begin, 1500);
      addEventListener("landscape-ready", () => { clearTimeout(timer); begin(); }, { once: true });
    }
  }

  // ---------------------------------------------------------------------------
  // Navigation

  let focus = null;
  let kbNav = false;
  let kbReturnTo = null;
  let kbWaitingForKids = false;
  let pendingTarget = null;
  let navToken = 0;

  const stage = $("#stage");
  const hint = $("#hint");
  const zoomOutBtn = $("#zoom-out");
  const live = $("#live");
  const caption = $("#caption");
  const statusEl = $("#status");

  function setStatus(msg) {
    statusEl.textContent = msg || "";
    statusEl.hidden = !msg;
  }

  function navigate(n) {
    if (location.hash !== n.hash) location.hash = n.hash;
    else flyTo(n);
  }

  // Walks the URL one folder at a time, loading each folder on the way down.
  async function nodeForHash(hash) {
    const ids = hash
      .replace(/^#\/?/, "")
      .split("/")
      .filter(Boolean)
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      });
    let n = root;
    for (const id of ids) {
      await load(n);
      const next = n.kids.find((k) => k.id === id);
      if (!next) break;
      n = next;
    }
    return n;
  }

  function flyTo(n) {
    const from = focus;
    setFocus(n);
    load(n);
    if (reduceMotion.matches) {
      anim = null;
      snapTo(n);
      onArrive();
      request();
      return;
    }
    const i = interpolateZoom([cam.x, cam.y, (2 * fitR) / cam.s], [n.x, n.y, 2 * n.r]);
    anim = { i, from, start: performance.now(), dur: clamp(i.duration * 0.85, 450, 1300) };
    request();
  }

  function setFocus(n) {
    focus = n;
    hover = null;
    stage.style.cursor = "";
    zoomOutBtn.hidden = n === root;
    document.body.classList.toggle("is-reading", n.leaf);
    if (n !== root) hint.classList.add("is-gone");
    live.textContent = n === root ? root.title : `Opened ${n.title}`;
    if (!n.error) setStatus("");
    refreshFocusState();
  }

  function refreshFocusState() {
    document.title = focus === root ? root.title : `${focus.title} – ${root.title}`;
    caption.textContent = focus.leaf ? "" : focus.blurb || "";
    renderCrumbs();
    for (const m of nodes) {
      const reachable = m.parent === focus;
      m.labelEl.tabIndex = reachable ? 0 : -1;
      m.labelEl.setAttribute("aria-hidden", reachable || m === focus ? "false" : "true");
      m.labelEl.classList.toggle("is-focus", m === focus);
      if (m.frameEl) m.frameEl.inert = m !== focus;
    }
  }

  function onArrive() {
    if (!kbNav) return;
    kbNav = false;
    if (kbReturnTo && kbReturnTo.parent === focus) kbReturnTo.labelEl.focus({ preventScroll: true });
    else if (focus.leaf) {
      focus.cardEl.focus({ preventScroll: true });
    }
    else if (focus.kids[0]) focus.kids[0].labelEl.focus({ preventScroll: true });
    else kbWaitingForKids = true;
    kbReturnTo = null;
  }

  function onRevealDone() {
    if (pendingTarget && pendingTarget !== focus) flyTo(pendingTarget);
    pendingTarget = null;
  }

  function goUp(viaKeyboard) {
    if (!focus.parent) return;
    kbNav = viaKeyboard;
    kbReturnTo = viaKeyboard ? focus : null;
    navigate(focus.parent);
  }

  function renderCrumbs() {
    const ol = $("#crumbs");
    ol.textContent = "";
    const chain = [];
    for (let n = focus; n; n = n.parent) chain.unshift(n);
    chain.forEach((n, i) => {
      const li = el("li");
      const a = el("a", null, n.title);
      a.href = n.hash;
      if (i === chain.length - 1) a.setAttribute("aria-current", "page");
      li.append(a);
      ol.append(li);
    });
  }

  // ---------------------------------------------------------------------------
  // Hit testing: which node would a click at this screen point open?

  function pathAt(px, py) {
    const wx = (px - cx0) / cam.s + cam.x;
    const wy = (py - cy0) / cam.s + cam.y;
    if (!inHex(wx - root.x, wy - root.y, root.r)) return [];
    const path = [root];
    for (let n = root; ; ) {
      // Children are tested as circles so the small gaps between ring hexes still count.
      const next = n.kids.find((c) => Math.hypot(wx - c.x, wy - c.y) <= c.r);
      if (!next) break;
      path.push(next);
      n = next;
    }
    return path;
  }

  function targetAt(px, py) {
    const path = pathAt(px, py);
    if (!path.length) return focus.parent;
    const d = focus.depth;
    // Inside the open node: go one level deeper. Outside it: jump to that sibling or ancestor.
    if (path[d] === focus) return path[d + 1] || null;
    return path[Math.min(path.length - 1, d)];
  }

  // ---------------------------------------------------------------------------
  // Input

  stage.addEventListener("click", (e) => {
    if (e.target.closest(".node-label, .card, .card-track")) return;
    const t = targetAt(e.clientX, e.clientY);
    if (t) navigate(t);
  });

  stage.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" || anim) return;
    const t = e.target.closest(".card, .card-track") ? null : targetAt(e.clientX, e.clientY);
    if (t !== hover) {
      hover = t;
      stage.style.cursor = t ? "pointer" : "";
      request();
    }
  });

  stage.addEventListener("pointerleave", () => {
    hover = null;
    stage.style.cursor = "";
    request();
  });

  // Scroll steps one level in or out instead of free-zooming.
  let wheelAcc = 0;
  let wheelLock = 0;
  stage.addEventListener(
    "wheel",
    (e) => {
      // Over a scrollable card (or its edge track), the wheel scrolls the card.
      const frame = e.target.closest(".card-frame");
      const card = frame && frame.querySelector(".card");
      if (card && card.scrollHeight > card.clientHeight + 2) {
        if (!e.target.closest(".card")) {
          card.scrollTop += e.deltaY;
          e.preventDefault();
        }
        return;
      }
      e.preventDefault();
      const t = performance.now();
      if (t < wheelLock) {
        wheelLock = t + 200; // swallow trackpad momentum
        return;
      }
      wheelAcc += e.deltaY;
      if (Math.abs(wheelAcc) < 40) return;
      const dir = Math.sign(wheelAcc);
      wheelAcc = 0;
      wheelLock = t + 650;
      if (dir > 0) goUp(false);
      else {
        const target = targetAt(e.clientX, e.clientY);
        if (target && target.parent === focus) navigate(target);
      }
    },
    { passive: false }
  );

  const outline = $("#outline");

  addEventListener("keydown", (e) => {
    if (outline.open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      goUp(true);
    }
  });

  zoomOutBtn.addEventListener("click", (e) => goUp(e.detail === 0));

  addEventListener("hashchange", async () => {
    const token = ++navToken;
    const n = await nodeForHash(location.hash);
    if (token === navToken) flyTo(n);
  });

  addEventListener("resize", () => {
    measure();
    anim = null;
    snapTo(focus);
    request();
  });

  darkScheme.addEventListener("change", () => {
    readTheme();
    request();
  });

  // ---------------------------------------------------------------------------
  // Outline: the same tree as a plain nested list. Folders load when you expand them.

  function outlineItem(n) {
    const li = el("li");
    const a = el("a", null, n.title);
    a.href = n.hash;
    a.style.setProperty("--hue", n.c.hueCSS);
    li.append(a);
    if (n.leaf) return li;

    const list = el("ul");
    const fill = () => list.replaceChildren(...n.kids.map(outlineItem));
    if (n === root) {
      fill();
      li.append(list);
      return li;
    }
    const toggle = el("button", "expand", "+");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", `Show what's in ${n.title}`);
    list.hidden = true;
    toggle.addEventListener("click", async () => {
      const open = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = open ? "−" : "+";
      list.hidden = !open;
      if (open) {
        await load(n);
        fill();
      }
    });
    li.append(toggle, list);
    return li;
  }

  $("#outline-open").addEventListener("click", () => {
    const ul = el("ul");
    ul.append(outlineItem(root));
    $("#outline-list").replaceChildren(ul);
    outline.showModal();
  });
  $("#outline-close").addEventListener("click", () => outline.close());
  outline.addEventListener("click", (e) => {
    if (e.target === outline || e.target.closest("a")) outline.close();
  });

  // ---------------------------------------------------------------------------
  // Start

  if (noHover.matches) hint.textContent = "Tap a hexagon to open it.";

  // Text widths change once the web font arrives.
  document.fonts.ready.then(() => {
    for (const n of nodes) {
      n.titleW = 0;
      if (n.cardEl) fitCard(n);
    }
    request();
  });

  readTheme();
  measure();
  root = makeNode(null, { name: "", type: "dir" }, 0, null);
  focus = root;
  snapTo(root);
  setFocus(root);

  // Start drawing straight away: the crystal grows while the content loads.
  playIntro();
  request();
  load(root).then(async () => {
    const initial = await nodeForHash(location.hash);
    if (initial === root) return;
    if (reveal >= 1) flyTo(initial);
    else pendingTarget = initial;
  });
})();
