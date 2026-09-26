/* QuickSave Service Worker v8.5 */
const CACHE_NAME = "quicksave-v8.5.0";

const STATIC_FILES = [
  "/", "/index.html", "/styles.css", "/app.js",
  "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png"
];

/* ── Install ── */
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(STATIC_FILES))
      .then(() => self.skipWaiting())
  );
});

/* ── Activate ── */
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ── Fetch ── */
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/") || url.origin !== self.location.origin) {
    event.respondWith(fetch(event.request));
    return;
  }
  event.respondWith(networkFirst(event.request));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const resp = await fetch(req, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) cache.put(req, resp.clone());
    return resp;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    if (req.mode === "navigate") {
      const idx = await cache.match("/index.html");
      if (idx) return idx;
    }
    return new Response("Offline", { status: 503 });
  }
}

/* ── Messages ── */
self.addEventListener("message", event => {
  const { type, data } = event.data || {};
  if (type === "SKIP_WAITING") { self.skipWaiting(); return; }
  if (type === "BG_DOWNLOAD") {
    event.waitUntil(handleBgDownload(data));
  }
});

/* ════════════════════════════════════════
   BACKGROUND DOWNLOAD
════════════════════════════════════════ */
async function handleBgDownload({ url: pageUrl, id: dlId }) {
  console.log("[SW] BG download start:", dlId);

  await broadcast({ type: "BG_STATUS", status: "processing" });

  try {
    /* Step 1: Inspect */
    const inspRes = await fetch("/api/inspect", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ url: pageUrl })
    });

    if (!inspRes.ok) {
      const e = await inspRes.json().catch(() => ({}));
      throw new Error(e.message || "Could not extract video");
    }

    const insp = await inspRes.json();
    if (!insp.ok || !insp.id) throw new Error(insp.message || "Extraction failed");

    const mediaId  = insp.id;
    const filename = insp.filename || "QuickSave_video.mp4";

    await broadcast({ type: "BG_STATUS", status: "downloading", filename });

    /* Step 2: Download bytes */
    const dlRes = await fetch(`/api/download?id=${encodeURIComponent(mediaId)}`);
    if (!dlRes.ok) throw new Error(`Download failed (${dlRes.status})`);

    const ct        = parseContentType(dlRes.headers.get("content-type"));
    const fileBytes = await dlRes.arrayBuffer();

    if (fileBytes.byteLength < 5000) throw new Error("File too small, try again");

    console.log("[SW] Downloaded:", (fileBytes.byteLength/1024/1024).toFixed(1)+"MB");

    /* Step 3: Send to client directly */
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

    for (const client of clients) {
      if (new URL(client.url).origin === self.location.origin) {
        client.postMessage({
          type:        "SAVE_FILE",
          filename:    filename,
          contentType: ct,
          buffer:      fileBytes
        }, [fileBytes]);
        console.log("[SW] File sent to client");
        break;
      }
    }

  } catch(err) {
    console.error("[SW] BG failed:", err.message);
    await broadcast({ type: "BG_STATUS", status: "error", msg: err.message });
  }
}

/* ── Helpers ── */
async function broadcast(data) {
  const clients = await self.clients.matchAll({ type: "window" });
  clients.forEach(c => { try { c.postMessage(data); } catch {} });
}

function parseContentType(ct) {
  if (!ct) return "video/mp4";
  const t = ct.split(";")[0].trim().toLowerCase();
  if (t.startsWith("video/") || t.startsWith("audio/")) return t;
  return "video/mp4";
}
