#!/usr/bin/env python3
"""
Edit the live portfolio VFS through the admin API.

    python3 scripts/vfs.py tree                         # show the live tree
    python3 scripts/vfs.py backup                       # save the full tree to backups/
    python3 scripts/vfs.py add  about/hobbies.md --from notes.md   # new file (content from a local file)
    python3 scripts/vfs.py add  experience --dir        # new folder
    python3 scripts/vfs.py edit about/background.md --from new.md  # replace a file's content
    python3 scripts/vfs.py mv   skills/tools.md tools-and-utilities.md   # rename (same folder)
    python3 scripts/vfs.py rm   projects/old-project.md # delete a file or folder (and everything in it)
    python3 scripts/vfs.py sync vfs-new.json           # apply edits and new cards from a built file
    python3 scripts/vfs.py replace vfs-new.json        # swap the whole tree for a built file
    python3 scripts/vfs.py restore backups/vfs-YYYYmmdd-HHMMSS.json  # put a backup back

Paths are relative to the root, e.g. "projects/software/xr-mail.md".
Every command that changes something backs up the whole tree to backups/ first.
Needs the admin portal's token in .admin_token (valid for 7 days).

The API always adds new nodes at the end of their folder and can't move them; to change order
or move something, recreate it where it belongs and delete the original.
"""
import json
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API = "https://exg0pnvo2f.execute-api.us-east-1.amazonaws.com/default/portfolio-backend-api/api"
HERE = Path(__file__).resolve().parent.parent
TOKEN_FILE = HERE / ".admin_token"
BACKUPS = HERE / "backups"

try:
    import certifi

    SSL = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL = ssl.create_default_context()


def token():
    if not TOKEN_FILE.exists() or not TOKEN_FILE.read_text().strip():
        sys.exit(f"No admin token in {TOKEN_FILE}. Copy it from the admin portal (localStorage 'admin_token').")
    return TOKEN_FILE.read_text().strip().strip('"')


# The API Gateway throttles bursts, so writes are paced and rate-limit errors are retried.
WRITE_GAP = 0.4  # seconds between writes
RETRY_DELAYS = [1, 2, 4, 8, 16, 30]


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    for attempt, delay in enumerate([0] + RETRY_DELAYS):
        if delay:
            time.sleep(delay)
        req = urllib.request.Request(API + path, method=method, data=data)
        req.add_header("Accept", "application/json")
        req.add_header("Authorization", f"Bearer {token()}")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=60, context=SSL) as res:
                result = json.loads(res.read() or b"null")
            if method != "GET":
                time.sleep(WRITE_GAP)
            return result
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            if e.code in (429, 502, 503, 504) and attempt < len(RETRY_DELAYS):
                print(f"    (rate limited, retrying in {RETRY_DELAYS[attempt]}s)")
                continue
            if e.code in (401, 403):
                sys.exit(f"The API rejected the admin token ({e.code}): {detail}\nIt may have expired; copy a fresh one.")
            sys.exit(f"{method} {path} failed: {e.code} {detail}")


def tree():
    return call("GET", "/admin/vfs")


def find(root, path):
    node = root
    for part in [p for p in path.strip("/").split("/") if p]:
        match = [c for c in node.get("children") or [] if c["title"] == part]
        if not match:
            sys.exit(f'"{path}" not found (no "{part}" in "{node["path"]}").')
        node = match[0]
    return node


def backup(root=None):
    root = root or tree()
    BACKUPS.mkdir(exist_ok=True)
    path = BACKUPS / f"vfs-{time.strftime('%Y%m%d-%H%M%S')}.json"
    path.write_text(json.dumps(root, indent=2, ensure_ascii=False))
    print(f"Backed up to {path.relative_to(HERE)}")
    return root


def show(node, depth=0):
    kids = node.get("children") or []
    is_dir = node.get("type") == "directory"
    note = "   <-- more than 6 (the hexaflake shows the first 6)" if len(kids) > 6 else ""
    print("  " * depth + node["title"] + ("/" if is_dir else "") + note)
    for c in kids:
        show(c, depth + 1)


def create(nodes, parent_id):
    for n in nodes:
        is_dir = n.get("type") == "directory"
        body = {"name": n["title"], "type": "directory" if is_dir else "file", "parentId": parent_id}
        if not is_dir:
            body["content"] = n.get("description") or ""
        made = call("POST", "/vfs/nodes", body)
        print(f"  created {made['path']}")
        if is_dir:
            create(n.get("children") or [], made["id"])


def main():
    args = sys.argv[1:]
    cmd = args[0] if args else "help"

    if cmd == "tree":
        show(tree())
    elif cmd == "backup":
        backup()
    elif cmd == "add" and len(args) >= 2:
        root = backup()
        path = args[1].strip("/")
        parent_path, _, name = path.rpartition("/")
        parent = find(root, parent_path)
        if "--dir" in args:
            body = {"name": name, "type": "directory", "parentId": parent["id"]}
        else:
            src = args[args.index("--from") + 1] if "--from" in args else None
            body = {"name": name, "type": "file", "parentId": parent["id"],
                    "content": Path(src).read_text() if src else ""}
        made = call("POST", "/vfs/nodes", body)
        visible = [c for c in parent.get("children") or [] if c["title"].lower() not in ("_index.md", "index.md")]
        print(f"Created {made['path']}")
        if len(visible) >= 6 and name.lower() not in ("_index.md", "index.md"):
            print(f'Note: "{parent_path or "root"}" now has more than 6 entries; the hexaflake shows only the first 6.')
    elif cmd == "edit" and len(args) == 4 and args[2] == "--from":
        root = backup()
        node = find(root, args[1])
        call("PUT", f"/vfs/nodes/{node['id']}", {"content": Path(args[3]).read_text()})
        print(f"Updated {node['path']}")
    elif cmd == "mv" and len(args) == 3:
        root = backup()
        node = find(root, args[1])
        res = call("PUT", f"/vfs/nodes/{node['id']}", {"name": args[2]})
        print(f"Renamed to {res['path']}")
    elif cmd == "rm" and len(args) == 2:
        root = backup()
        node = find(root, args[1])
        res = call("DELETE", f"/vfs/nodes/{node['id']}")
        print(f"Deleted {node['path']} ({res.get('deletedCount', 1)} nodes)")
    elif cmd == "sync" and len(args) == 2:
        # Apply a built file without rebuilding everything: update changed files, add new ones.
        # Nothing is deleted; anything live that the file doesn't have is just reported.
        new = json.loads(Path(args[1]).read_text())
        live = backup()
        changes = 0

        def walk(want, have, path):
            nonlocal changes
            have_kids = list(have.get("children") or [])
            for c in want.get("children") or []:
                p = f"{path}/{c['title']}"
                match = next((h for h in have_kids if h["title"] == c["title"]), None)
                if match is None:
                    create([c], have["id"])
                    have_kids.append(c)
                    changes += 1
                elif c.get("type") == "directory":
                    walk(c, match, p)
                elif (match.get("description") or "") != (c.get("description") or ""):
                    call("PUT", f"/vfs/nodes/{match['id']}", {"content": c.get("description") or ""})
                    print(f"  updated {p}")
                    changes += 1
            wanted = [c["title"] for c in want.get("children") or []]
            for h in have_kids:
                if h["title"] not in wanted:
                    print(f"  left alone (not in the file): {path}/{h['title']}")
            if [h["title"] for h in have_kids if h["title"] in wanted] != wanted:
                print(f"  note: {path or '/'} is out of order; run `replace` to reorder it")

        walk(new, live, "")
        print(f"Synced: {changes} change(s)." if changes else "Already up to date.")
    elif cmd == "replace" and len(args) == 2:
        # Swap the whole tree for the one in a file. The new sections are built under temporary
        # names first, so the live site is only incomplete for the moment between deleting the
        # old sections and renaming the new ones.
        new = json.loads(Path(args[1]).read_text())
        current = backup()
        leftovers = [n for n in current.get("children") or [] if n["title"].startswith("__new__")]
        if leftovers:
            print("Clearing leftovers from an interrupted run...")
            for n in leftovers:
                call("DELETE", f"/vfs/nodes/{n['id']}")
                print(f"  deleted {n['title']}")
            current["children"] = [n for n in current["children"] if n not in leftovers]
        print("Building the new sections...")
        temp = []
        for n in new.get("children") or []:
            staged = dict(n, title=f"__new__{n['title']}")
            create([staged], current["id"])
        fresh = tree()
        for n in new.get("children") or []:
            match = [c for c in fresh["children"] if c["title"] == f"__new__{n['title']}"]
            temp.append((match[0]["id"], n["title"]))
        print("Removing the old sections...")
        for n in current.get("children") or []:
            call("DELETE", f"/vfs/nodes/{n['id']}")
            print(f"  deleted {n['title']}")
        print("Moving the new sections into place...")
        for node_id, name in temp:
            call("PUT", f"/vfs/nodes/{node_id}", {"name": name})
            print(f"  {name}")
        print("Replaced.")
    elif cmd == "restore" and len(args) == 2:
        saved = json.loads(Path(args[1]).read_text())
        current = backup()
        print("Removing current top-level nodes...")
        for n in current.get("children") or []:
            call("DELETE", f"/vfs/nodes/{n['id']}")
            print(f"  deleted {n['title']}")
        print(f"Recreating from {args[1]}...")
        create(saved.get("children") or [], current["id"])
        print("Restored.")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
