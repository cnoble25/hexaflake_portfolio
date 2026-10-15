/*
 * Where the portfolio's folders and markdown files come from.
 *
 * A source is an object with:
 *   list(dir)  -> Promise<[{ name, type: "dir" | "file", title? }]>
 *                 dir is "" for the root, otherwise a folder path ending in "/", e.g. "projects/".
 *                 title is an optional display label; otherwise one is made from the name.
 *   read(file) -> Promise<string>   markdown text, file like "projects/software/xr-mail.md"
 *   url(path)  -> string            absolute URL for links and images inside markdown
 * and optionally:
 *   describe(dir) -> Promise<string | null>   markdown describing a folder (title + blurb)
 *   ordered       -> true to keep list() order instead of sorting by name
 *   siteTitle     -> name shown on the center plate when the content doesn't give one
 *
 * To use another backend, define window.PORTFOLIO_SOURCE with the same methods before main.js.
 */
(() => {
  // The portfolio's virtual file system, served by API Gateway + Lambda from vfs.json in S3.
  // Set to null to read the local content/ folder instead.
  const LIVE_VFS = "https://exg0pnvo2f.execute-api.us-east-1.amazonaws.com/default/portfolio-backend-api/api/vfs";
  const SITE_TITLE = "Carson Noble";

  // Local preview of a vfs.json before uploading it: http://localhost:8080/?vfs=/vfs-new.json
  // Only on localhost, and only for files on the same server.
  function previewVfs() {
    const param = new URLSearchParams(location.search).get("vfs");
    if (!param || !["localhost", "127.0.0.1"].includes(location.hostname)) return null;
    const url = new URL(param, location.href);
    return url.origin === location.origin ? url.href : null;
  }
  const VFS_API = previewVfs() || LIVE_VFS;

  // ---------------------------------------------------------------------------
  // VFS API: the whole tree arrives in one request as nested { title, type?, description, children }.
  // It's fetched once and every folder is answered from memory.

  function vfsApiSource(url) {
    let treePromise = null;

    function tree() {
      if (!treePromise) {
        treePromise = fetch(url, { headers: { Accept: "application/json" } })
          .then((res) => {
            if (!res.ok) throw new Error(`The portfolio API answered ${res.status}.`);
            return res.json();
          })
          .catch((err) => {
            treePromise = null; // let the next attempt try again
            throw err instanceof TypeError ? new Error("Couldn't reach the portfolio API.") : err;
          });
      }
      return treePromise;
    }

    // Folders carry type "directory" once the API sends it; until then, anything with children is one.
    const isDir = (n) => (n.type ? n.type === "directory" : (n.children || []).length > 0);

    // A file called _index.md describes its folder (the admin portal can't give folders a
    // description of their own). It isn't shown as a card.
    const INDEX = ["_index.md", "index.md"];
    const isIndex = (n) => !isDir(n) && INDEX.includes(n.title.toLowerCase());

    async function find(path) {
      let node = await tree();
      for (const part of path.split("/").filter(Boolean)) {
        node = (node.children || []).find((c) => c.title === part);
        if (!node) throw new Error(`"${path}" isn't in the portfolio.`);
      }
      return node;
    }

    // A node's own first heading makes a better label than its file name.
    function headingOf(n) {
      const m = (n.description || "").match(/^#\s+(.+)$/m);
      const h = m && m[1].trim();
      return h && h !== n.title ? h : null;
    }

    return {
      ordered: true,
      siteTitle: SITE_TITLE,
      url: (path) => new URL(path, location.href).href,

      async list(dir) {
        const node = await find(dir);
        return (node.children || []).filter((c) => !isIndex(c)).map((c) => {
          // A folder's label comes from its _index.md heading, so it's right before it's opened.
          const index = isDir(c) && (c.children || []).find(isIndex);
          return { name: c.title, type: isDir(c) ? "dir" : "file", title: headingOf(index || c) };
        });
      },

      async read(file) {
        return (await find(file)).description || "";
      },

      async describe(dir) {
        const node = await find(dir);
        const index = (node.children || []).find(isIndex);
        return ((index || node).description || "").trim() || null;
      },
    };
  }

  // ---------------------------------------------------------------------------
  // A real folder (content/) read through the web server's directory listings. Each folder may
  // have an _index.md describing it; only folders and .md files become hexagons.

  const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");

  function httpDirectorySource(base) {
    const baseURL = new URL(base, location.href);
    const resolve = (path) => new URL(encodePath(path), baseURL);

    async function get(path, what) {
      let res;
      try {
        res = await fetch(resolve(path), { headers: { Accept: "application/json, text/html, text/markdown" } });
      } catch {
        throw new Error(
          location.protocol === "file:"
            ? "Browsers block reading folders from file:// pages. Serve the site instead (see README)."
            : `Couldn't reach the server to load ${what}.`
        );
      }
      if (!res.ok) throw new Error(`The server answered ${res.status} for ${what}.`);
      return res.text();
    }

    async function listAll(dir) {
      const text = await get(dir, `/${base}${dir}`);
      // nginx with autoindex_format json
      try {
        return JSON.parse(text).map((e) => ({ name: e.name, type: e.type === "directory" ? "dir" : "file" }));
      } catch {
        // Plain HTML index pages (nginx default, python -m http.server)
        const doc = new DOMParser().parseFromString(text, "text/html");
        return [...doc.querySelectorAll("a[href]")]
          .map((a) => a.getAttribute("href"))
          .filter((h) => h && !/^(\?|\/|\.\.|#|[a-z]+:)/i.test(h))
          .map((h) => decodeURIComponent(h))
          .map((h) => (h.endsWith("/") ? { name: h.slice(0, -1), type: "dir" } : { name: h, type: "file" }));
      }
    }

    const INDEX = ["_index.md", "index.md"];
    const isIndex = (e) => e.type === "file" && INDEX.includes(e.name.toLowerCase());

    return {
      siteTitle: SITE_TITLE,
      url: (path) => resolve(path).href,

      async list(dir) {
        return (await listAll(dir)).filter(
          (e) => !e.name.startsWith(".") && !isIndex(e) && (e.type === "dir" || /\.md$/i.test(e.name))
        );
      },

      read: (file) => get(file, file),

      async describe(dir) {
        const index = (await listAll(dir)).find(isIndex);
        return index ? get(dir + index.name, dir + index.name) : null;
      },
    };
  }

  window.PORTFOLIO_SOURCE =
    window.PORTFOLIO_SOURCE || (VFS_API ? vfsApiSource(VFS_API) : httpDirectorySource("content/"));
})();
