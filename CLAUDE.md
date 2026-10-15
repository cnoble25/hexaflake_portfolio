# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Carson Noble's portfolio site (live at https://noblec.us). The content is drawn as one big zoomable snowflake fractal (hexaflake geometry): every folder is a hexagonal plate with six arms to its children, and every markdown file is a card. Plain static HTML/CSS/JS: no framework, no bundler, no npm dependencies (`vendor/marked.min.js` and `vendor/three.module.min.js`, three.js r170, are vendored; three is loaded through an import map whose path must start with `./`).

## Commands

```sh
# Local preview (nginx, same as production behavior)
docker build -t hexaflake-portfolio . && docker run -d --rm --name hexaflake-test -p 8080:80 hexaflake-portfolio
# Rebuild after code changes: docker stop hexaflake-test, wait for the name to free up, then rebuild/run.

# Syntax check (there is no test suite or linter)
node --check main.js source.js atmosphere.js

# Production build -> dist/ (fingerprinted assets) and deploy to S3 + CloudFront
python3 scripts/build_dist.py
AWS_REGION=us-east-1 ./scripts/deploy.sh   # needs `aws login --region us-east-1` first
```

Localhost-only URL switches (ignored on the real domain):
- `?vfs=/vfs-new.json` previews a vfs.json file copied into the container instead of the live API.
- `?intro=2900` freezes the opening animation at that many ms. Never treat a missing value as 0.

## Architecture

**Content comes from a live API, not this repo.** `source.js` defines `window.PORTFOLIO_SOURCE` (`list(dir)`, `read(file)`, `url(path)`, optional `describe(dir)`, `ordered`, `siteTitle`). The default is `vfsApiSource`, which fetches the whole tree once from the AWS endpoint (API Gateway → Lambda → `vfs.json` in S3, owned by the separate repo `~/Documents/portfolio`) and answers folder lookups from memory. Setting `VFS_API` to `null` falls back to the local `content/` folder read through nginx's JSON autoindex (`nginx.conf`). The public API strips `type`, so a node with no children is treated as a file.

Content conventions the renderer relies on: at most 6 entries per folder (extras are dropped with a console warning); a child named `_index.md` describes its folder (heading = label, first paragraph = blurb) and is hidden; a file's first `# heading` becomes its label (trailing `(...)` dropped, long ALL-CAPS softened); in cards, an italic line under the h1 becomes the subtitle, lists of bare links become a link row, and lists of short items become tags.

**`main.js`** (single IIFE) does everything else:
- Lazy tree: nodes are created only when their parent folder is loaded (`load` → `loadDir`/`loadFile`), so only one level below the open node exists. URL hashes (`#/projects/software/jarvis`) are resolved by walking and loading folder by folder (`nodeForHash`).
- Layout/camera: the root has world radius 1; children sit at 2/3·R along slot directions with radius R/3. Orientation is flat-topped on wide screens, pointy-topped on tall ones. Navigation uses Van Wijk–Nuij smooth zoom (`interpolateZoom`); clicks resolve to "one level deeper than the focus" (`targetAt`).
- Drawing: canvas. Decorative sub-crystals are cached sprites (`sprite`, stepped sizes so they're never downscaled much). Arms are batched into Path2D by color, width and alpha. This was tuned for performance; avoid per-cell fills or per-frame text layout.
- Labels and cards are DOM over the canvas. Per frame they only change `transform`/`opacity` via `setStyle` (cached to avoid DOM writes). Cards live in a `.card-frame` the size of the hexagon. `fitCard` tries hexagon-shaped text flow (`shape-outside` wedges plus a centering spacer), shrinking `--k` down to 0.85; otherwise it falls back to a scrolling column with the SVG scrollbar drawn along the hexagon's right edges (`updateScroll`). Phones (<560px) use plain rectangles.
- Intro (`playIntro`): one SVG snowflake falls, then the camera zooms into it, handing off to the crystal's reveal (`introRunning` holds the reveal). It's skipped for reduced motion and deep links, and skips on input.

**`landscape.js`** (ES module, three.js): the procedural winter scene inside `#backdrop`, from a seeded RNG so it's identical every load. Day and night palettes follow `prefers-color-scheme`. It renders at about 30 fps, and only once with reduced motion (hence `preserveDrawingBuffer`). Trees are placed as fractions of the visible half-width so the center stays clear. `main.js` calls `window.landscape.setDepth(levels)` and the camera dollies forward. It fires `landscape-ready` after its first frame, and the intro waits for that (up to 1.5 s). Without WebGL, the CSS sky gradient on `#backdrop` shows.

**`wildlife.js`** (ES module, loaded by `landscape.js` with a dynamic `import("wildlife")` after the scene's first frame): GLB models from `models/` (sources and licenses in `models/CREDITS.md`, which includes a CC-BY 4.0 attribution that must stay, also shown in the Outline dialog). Three layers:
- A director: weighted kinds with cooldowns and max counts, at most `MAX_ANIMALS` alive (8, or 5 on phones), always at least one (a new one arrives as soon as the last leaves, ignoring cooldowns), and no spawns while `body.is-reading`.
- One generator "brain" per animal. A brain yields a number to wait that many seconds. Deer roam, graze and bolt from the fox. Squirrels forage and flee up trees. The fox roams, stalks and pounces on grounded squirrels; `CATCH_CHANCE` of pounces succeed: the squirrel's brain freezes (`agent.wait = Infinity`), and `carryOff` swaps it for a limp copy that `follow()`s the fox's head bone after each frame's pose while the fox gallops away. Cardinals perch-hop as a flock. The owl comes out at night, with wing flaps done in code.
- Actors: cloned models normalized by bounding box, facing +Z at heading 0. `SPECIES` holds size, yaw fixes, recolors, turning radius and shadow size.

Movement goes through `stepToward`, which limits turning to a radius and sets the walk clip's speed to the actual pace. `walkTo`, `travel` (detours around obstacles), `turnTo`, `flyTo` and `parallel` build on it. Animals spawn and leave beyond the screen edges and are removed after 120 s. While any are alive, the landscape renders at 60 fps instead of 30.

The fox and deer get leg IK from three's `CCDIKSolver` (`rigLegs`/`solveLegs`). It runs per leg on upper+lower bones toward the rig's IKFrontLeg/IKBackLeg tip. The solver is constrained to a hinge about the body's left-right axis. Planted feet lock to the snow and ease back to the clip pose when released. Each bone's correction is rate-limited (`IK_RATE`). Body tilt and height come from the snow under a fixed footprint, not the moving feet, which would rock the body. Two pitfalls:
- three's mixer only writes a bone when the clip's value changes. `unbendLegs` must therefore restore the clip pose before `mixer.update`, or IK corrections pile up and legs snap.
- Clip loops are made seamless at load time (each track's last key is set to its first).

The squirrel (blam's 3ds Max rig, converted from FBX) has leg IK too, and its clips (`move`, `idle2`) are played faster to match its pace; while it climbs a trunk (`climbing`), IK and tilt pause. Leg chains are per species (`legs` in `SPECIES`); the hinge plane is the clip's own hip-knee-foot plane, and "planted" is relative to how high each foot steps. Off-screen animals skip leg IK. The owl and snowman have none.

Localhost switches: `?wild=deer|squirrel|fox|hunt|birds|owl|lineup`, `?wildspeed=N`, `?ik=0`, `?ikdiag=1`, `?catch=1` (every pounce succeeds). `window.__wildlife` (actors, agents, spawn, `ikStats` with foot error, cost, tilt and pop samples) is exposed for tests. Models were trimmed with glTF-Transform. When removing clips, dispose their channels and samplers, not the accessors (those can be shared), then prune.

**`atmosphere.js`**: falling snow and fog on two canvases (`#snow-back` behind the fractal, `#snow-front` in front, dimmed while a card is open). Independent of `main.js` and removable.

**`styles.css`**: theme tokens on `:root` with a dark-mode override. `--display` is the display face (Baloo 2) for labels and headings; body text uses Bricolage Grotesque. Section hues are the `PALETTE` array in `main.js`, assigned to top-level entries in order. `#backdrop::after` adds the frosted halo behind the flake. The `#intro-flake` rules sit next to `#backdrop` in the stylesheet; if they go missing, the hidden intro flake renders full-screen as a black hexagon.

## Editing content (live site)

Card text changes need no deploy: they go to the VFS through the admin API.
- `scripts/vfs.py` (admin token in `.admin_token`, which expires; get it from the admin portal's localStorage `admin_token`): `tree`, `backup`, `add`, `edit`, `mv`, `rm`, `sync` (update changed and new nodes from a built file), `replace` (swap the whole tree), `restore`. It backs up to `backups/` before every write, paces writes, and retries 429s (API Gateway throttles bursts).
- The working copy of all content is `vfs-draft/` (numbered prefixes set order and are stripped). Build with `python3 scripts/build_vfs.py vfs-draft vfs-new.json`, preview with `?vfs=`, then `python3 scripts/vfs.py sync vfs-new.json`.
- Avoid `~` in markdown: pairs render as strikethrough.

## Hosting

S3 bucket `carson-portfolio-frontend-115439078550` behind CloudFront `E1RRWERRAXBXDL`, aliased to `noblec.us` (DNS at Cloudflare, records DNS-only, ACM cert in us-east-1). `deploy.sh` uploads new files before deleting old ones, then invalidates `/*`. The old terminal frontend is backed up in `backups/old-frontend/`.
