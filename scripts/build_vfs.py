#!/usr/bin/env python3
"""
Turn a folder of markdown files into a vfs.json for the portfolio.

    python3 scripts/build_vfs.py vfs-draft vfs-new.json

Folder and file names may start with a number prefix ("2-projects", "3-grocerez.md") that sets
their order and is stripped from the name. `_index.md` files describe their folder and are kept
as the folder's first entry (the hexaflake hides them). Each folder may show at most 6 entries.
"""
import json
import random
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

PREFIX = re.compile(r"^\d+-")
NOW = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def new_id():
    return f"{int(time.time()):08x}" + "".join(random.choice("0123456789abcdef") for _ in range(16))


def order(p):
    if p.name == "_index.md":
        return (-1, "")
    m = re.match(r"^(\d+)-", p.name)
    return (int(m.group(1)) if m else 10**6, p.name)


def node(path, parent, problems):
    name = PREFIX.sub("", path.name)
    n = {"id": new_id(), "title": name, "path": f"{parent['path']}/{name}", "parentId": parent["id"]}
    if path.is_dir():
        n.update(type="directory", description=None, metadata={"size": 0, "createdAt": NOW, "updatedAt": NOW})
        kids = sorted((p for p in path.iterdir() if not p.name.startswith(".")), key=order)
        n["children"] = [node(k, n, problems) for k in kids]
        shown = [k for k in n["children"] if k["title"] != "_index.md"]
        if len(shown) > 6:
            problems.append(f"{n['path']} has {len(shown)} entries (max 6)")
        names = [k["title"] for k in n["children"]]
        if len(names) != len(set(names)):
            problems.append(f"{n['path']} has duplicate names after removing prefixes")
    else:
        text = path.read_text()
        n.update(type="file", description=text,
                 metadata={"size": len(text.encode()), "createdAt": NOW, "updatedAt": NOW}, children=[])
    return n


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    root = {"id": new_id(), "title": "root", "type": "directory", "path": "/root", "parentId": None,
            "description": None, "metadata": {"size": 0}, "children": []}
    problems = []
    root["children"] = [node(p, root, problems) for p in sorted(src.iterdir(), key=order) if not p.name.startswith(".")]
    if len([c for c in root["children"] if c["title"] != "_index.md"]) > 6:
        problems.append("root has more than 6 entries")
    if problems:
        sys.exit("Not written:\n  " + "\n  ".join(problems))
    out.write_text(json.dumps(root, indent=2, ensure_ascii=False))

    def count(n):
        return 1 + sum(count(c) for c in n.get("children") or [])
    print(f"Wrote {out}: {count(root) - 1} nodes")


if __name__ == "__main__":
    main()
