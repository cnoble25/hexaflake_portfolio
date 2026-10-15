#!/usr/bin/env python3
"""
Build the static site into dist/ for S3 + CloudFront.

    python3 scripts/build_dist.py

Scripts and styles get a content hash in their names (main.3f9a1c2b.js) so CloudFront can cache
them for a year; index.html points at the new names and is the only file cached briefly.
The content itself isn't bundled: the site reads it live from the VFS API.
"""
import hashlib
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
ASSETS = [
    "styles.css", "vendor/marked.min.js", "vendor/three.module.min.js",
    "source.js", "main.js", "atmosphere.js", "landscape.js", "wildlife.js",
]
STATIC = ["favicon.svg"]
# Copied as-is: three's add-ons import each other by relative path, and models are fetched by URL.
STATIC_DIRS = ["vendor/three-addons", "models"]


def main():
    if DIST.exists():
        shutil.rmtree(DIST)
    (DIST / "assets").mkdir(parents=True)

    html = (ROOT / "index.html").read_text()
    for rel in ASSETS:
        src = ROOT / rel
        data = src.read_bytes()
        digest = hashlib.sha256(data).hexdigest()[:10]
        name = f"assets/{src.stem}.{digest}{src.suffix}"
        (DIST / name).write_bytes(data)
        # Any quoted reference: src/href attributes and the import map's JSON.
        pattern = re.compile('"(?:\\./)?' + re.escape(rel) + '"')
        html, count = pattern.subn(f'"/{name}"', html)
        if count != 1:
            raise SystemExit(f"index.html should reference {rel} exactly once (found {count})")
    for rel in STATIC_DIRS:
        shutil.copytree(ROOT / rel, DIST / rel)
    for rel in STATIC:
        (DIST / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT / rel, DIST / rel)
    html = html.replace('href="favicon.svg"', 'href="/favicon.svg"')
    (DIST / "index.html").write_text(html)

    files = sorted(p.relative_to(DIST).as_posix() for p in DIST.rglob("*") if p.is_file())
    print(f"Built {DIST.relative_to(ROOT)}/ ({len(files)} files):")
    for f in files:
        print("  " + f)


if __name__ == "__main__":
    main()
