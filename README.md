# Hexaflake portfolio

My portfolio at **[noblec.us](https://noblec.us)**: one big snowflake you can zoom into. Every folder of content is a hexagonal plate with arms reaching to what's inside it, and every markdown file is a card. Click a plate to fly into it; scroll out or press Esc to step back.

It's plain HTML, CSS and JavaScript, with no framework, bundler or npm dependencies. The fractal is drawn on a canvas, labels and cards are DOM laid over it, and folders are loaded only as you open them, so the tree can go as deep as the content does. Behind it is a winter landscape built in WebGL with three.js: sky, misty mountains, a forest line, rolling snow and cartoon snow-laden trees, all generated in code, with snow falling through it. Wildlife wanders through: deer stop to graze, squirrels scamper between trees and up the trunks, a white fox stalks them (usually the squirrel gets away; now and then the fox carries one off), cardinals swoop past a snowman, and at night an owl turns up in a frosted tree. The fox, deer and squirrels plant their feet on the slopes with leg IK. A small director keeps it lively but calm: always at least one animal, at most 8 (5 on phones), nothing new while you're reading a card, and no motion at all with reduced motion.

## Where the content comes from

The site reads a virtual file system from the API behind my previous portfolio (API Gateway → Lambda → `vfs.json` in S3). The whole tree arrives in one request, and each folder is revealed as you open it.

- At most **6 entries per folder**. Extras are left out, with a console warning.
- A file's first `# heading` is its label. An `_index.md` inside a folder gives the folder its label and intro line, and isn't shown as a card.
- `vfs-draft/` is the working copy of the content. Number prefixes set the order and are stripped.

```sh
python3 scripts/build_vfs.py vfs-draft vfs-new.json   # build
python3 scripts/vfs.py sync vfs-new.json              # push changed cards (backs up first)
```

`scripts/vfs.py` needs an admin token in `.admin_token` and also does `tree`, `backup`, `add`, `edit`, `mv`, `rm`, `replace` and `restore`. To run the site from the local `content/` folder instead, set `VFS_API` to `null` in `source.js`.

## Run it locally

```sh
docker build -t hexaflake-portfolio .
docker run --rm -p 8080:80 hexaflake-portfolio
```

Then open http://localhost:8080. On localhost, `?vfs=/vfs-new.json` previews a built content file, and `?intro=2900` freezes the opening animation at 2.9 s.

## Deploy

```sh
aws login --region us-east-1
AWS_REGION=us-east-1 ./scripts/deploy.sh
```

This builds `dist/` with fingerprinted assets, syncs it to S3, removes old files, and invalidates CloudFront.

## Credits

3D: [three.js](https://threejs.org). Wildlife models: Quaternius, Kenney and Gobkit (CC0), blam's squirrel (CC-BY 4.0), and mirada's parrot (Apache-2.0); see [`models/CREDITS.md`](models/CREDITS.md). Fonts: Baloo 2 and Bricolage Grotesque (Google Fonts). Markdown: [marked](https://github.com/markedjs/marked). The landscape is modeled on a winter illustration from [Magnific](https://magnific.com).
