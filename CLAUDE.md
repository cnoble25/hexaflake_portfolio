# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Carson Noble's portfolio site (live at https://noblec.us). The content is drawn as one big zoomable snowflake fractal (hexaflake geometry): every folder is a hexagonal plate with six arms to its children, and every markdown file is a card. Plain static HTML/CSS/JS: no framework, no bundler, no npm dependencies (`vendor/marked.min.js` is vendored).

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

**`atmosphere.js`**: falling snow and fog on two canvases (`#snow-back` behind the fractal, `#snow-front` in front, dimmed while a card is open). Independent of `main.js` and removable.

**`styles.css`**: theme tokens on `:root` with a dark-mode override. `--display` is the display face (Baloo 2) for labels and headings; body text uses Bricolage Grotesque. Section hues are the `PALETTE` array in `main.js`, assigned to top-level entries in order. The background is `#backdrop` with `images/winter-field-*.jpg` (licensed stock art; the on-page "Background art: Magnific" credit must stay).

## Editing content (live site)

Card text changes need no deploy: they go to the VFS through the admin API.
- `scripts/vfs.py` (admin token in `.admin_token`, which expires; get it from the admin portal's localStorage `admin_token`): `tree`, `backup`, `add`, `edit`, `mv`, `rm`, `sync` (update changed and new nodes from a built file), `replace` (swap the whole tree), `restore`. It backs up to `backups/` before every write, paces writes, and retries 429s (API Gateway throttles bursts).
- The working copy of all content is `vfs-draft/` (numbered prefixes set order and are stripped). Build with `python3 scripts/build_vfs.py vfs-draft vfs-new.json`, preview with `?vfs=`, then `python3 scripts/vfs.py sync vfs-new.json`.
- Avoid `~` in markdown: pairs render as strikethrough.

## Hosting

S3 bucket `carson-portfolio-frontend-115439078550` behind CloudFront `E1RRWERRAXBXDL`, aliased to `noblec.us` (DNS at Cloudflare, records DNS-only, ACM cert in us-east-1). `deploy.sh` uploads new files before deleting old ones, then invalidates `/*`. The old terminal frontend is backed up in `backups/old-frontend/`.
