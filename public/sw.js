/* QuickSave Service Worker v8.7 */
const CACHE_NAME = "quicksave-v8.7.0";

const STATIC_FILES = [
  "/", "/index.html", "/styles.css", "/app.js",
  "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png"
];

/* Active background downloads track karo */
const activeBgJobs = new Map();

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

  if (type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }

  if (type === "BG_DOWNLOAD") {
    /*
      CRITICAL FIX:
      event.waitUntil ke saath promise pass karo
      Taki SW tab bhi alive rahe jab app background mein ho
    */
    const jobPromise = handleBgDownload(data);
    activeBgJobs.set(data.id, jobPromise);

    event.waitUntil(
      jobPromise.finally(() => {
        activeBgJobs.delete(data.id);
      })
    );
    return;
  }

  if (type === "CANCEL") {
    activeBgJobs.delete(data?.id);
    return;
  }
});

/* ════════════════════════════════════════
   BACKGROUND DOWNLOAD
   
   Key fix: Pure SW mein sab kuch karo
   Client visible ho ya na ho - koi fark nahi
   File cache mein store karo
   Jab client visible ho tab send karo
════════════════════════════════════════ */
async function handleBgDownload({ url: pageUrl, id: dlId }) {
  console.log("[SW] BG start:", dlId, pageUrl.slice(0, 50));

  await broadcast({ type: "BG_STATUS", status: "processing", id: dlId });

  try {
    /* ── Step 1: Inspect ── */
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

    console.log("[SW] Got media:", filename, mediaId);

    await broadcast({
      type: "BG_STATUS", status: "downloading",
      filename, id: dlId
    });

    /* ── Step 2: Download file ── */
    const dlRes = await fetch(`/api/download?id=${encodeURIComponent(mediaId)}`);
    if (!dlRes.ok) throw new Error(`Download failed (${dlRes.status})`);

    const ct        = parseContentType(dlRes.headers.get("content-type"));
    const fileBytes = await dlRes.arrayBuffer();

    if (fileBytes.byteLength < 5000) throw new Error("File too small, try again");

    const sizeMB = (fileBytes.byteLength / 1024 / 1024).toFixed(1);
    console.log("[SW] File ready:", sizeMB + "MB", ct);

    /* ── Step 3: File ko cache mein store karo ── */
    const cacheKey = `qs-file-${dlId}`;
    const bgCache  = await caches.open("qs-bg-files");

    await bgCache.put(
      new Request(`/qs-bg/${dlId}`),
      new Response(fileBytes, {
        headers: {
          "Content-Type":   ct,
          "X-QS-Filename":  filename,
          "X-QS-Size":      String(fileBytes.byteLength)
        }
      })
    );

    /* 1 hour baad clean */
    setTimeout(async () => {
      try {
        const c = await caches.open("qs-bg-files");
        await c.delete(new Request(`/qs-bg/${dlId}`));
        console.log("[SW] Cache cleaned:", dlId);
      } catch {}
    }, 60 * 60 * 1000);

    /* ── Step 4: Client ko send karo ── */
    const sent = await sendToClient({
      type:        "SAVE_FILE",
      filename:    filename,
      contentType: ct,
      sizeMB:      sizeMB,
      dlId:        dlId,
      buffer:      fileBytes
    }, fileBytes);

    if (sent) {
      console.log("[SW] File sent to active client");
    } else {
      /*
        Client nahi mila ya background mein hai
        Cache mein hai - jab client aayega tab milega
        Chrome "Download complete" notification aayegi
        automatically jab file save hogi
      */
      console.log("[SW] No active client, file in cache:", cacheKey);

      /* Pending file track karo */
      await storePendingFile(dlId, filename, ct, sizeMB);
    }

  } catch(err) {
    console.error("[SW] BG failed:", err.message);
    await broadcast({
      type: "BG_STATUS", status: "error",
      msg:  err.message, id: dlId
    });
  }
}

/* ── Client ko file bhejo ── */
async function sendToClient(messageData, transferBuffer) {
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true
  });

  for (const client of clients) {
    try {
      if (new URL(client.url).origin !== self.location.origin) continue;

      /*
        Transferable ArrayBuffer bhejo - zero copy
        Buffer transfer hone ke baad SW mein available nahi rahega
        Isliye pehle cache mein store kiya hai
      */
      const bufferCopy = transferBuffer.slice(0); /* Copy banao transfer ke liye */

      client.postMessage(messageData, [bufferCopy]);
      return true;
    } catch(e) {
      console.log("[SW] Client send failed:", e.message);
    }
  }
  return false;
}

/* ── Pending file info store karo ── */
async function storePendingFile(dlId, filename, contentType, sizeMB) {
  try {
    const cache = await caches.open("qs-bg-files");
    const info  = JSON.stringify({ dlId, filename, contentType, sizeMB, time: Date.now() });
    await cache.put(
      new Request("/qs-pending"),
      new Response(info, { headers: { "Content-Type": "application/json" } })
    );
  } catch {}
}

/* ── Pending file check karo ── */
async function checkPendingFile() {
  try {
    const cache    = await caches.open("qs-bg-files");
    const pending  = await cache.match(new Request("/qs-pending"));
    if (!pending) return null;

    const info = await pending.json();

    /* 30 min se purana? Ignore */
    if (Date.now() - info.time > 30 * 60 * 1000) {
      await cache.delete(new Request("/qs-pending"));
      return null;
    }

    /* Actual file bhi hai? */
    const fileResp = await cache.match(new Request(`/qs-bg/${info.dlId}`));
    if (!fileResp) {
      await cache.delete(new Request("/qs-pending"));
      return null;
    }

    return { info, fileResp };
  } catch {
    return null;
  }
}

/* ── Client visible hone par pending file bhejo ── */
self.addEventListener("message", event => {
  /* Client ne bataya ki wo visible hai */
  if (event.data?.type === "CLIENT_VISIBLE") {
    event.waitUntil(
      checkPendingFile().then(async pending => {
        if (!pending) return;

        const { info, fileResp } = pending;
        const fileBytes = await fileResp.arrayBuffer();

        console.log("[SW] Sending pending file to now-visible client");

        try {
          event.source.postMessage({
            type:        "SAVE_FILE",
            filename:    info.filename,
            contentType: info.contentType,
            sizeMB:      info.sizeMB,
            dlId:        info.dlId,
            buffer:      fileBytes
          }, [fileBytes]);

          /* Pending clear karo */
          const cache = await caches.open("qs-bg-files");
          await cache.delete(new Request("/qs-pending"));
          await cache.delete(new Request(`/qs-bg/${info.dlId}`));

        } catch(e) {
          console.log("[SW] Pending send failed:", e.message);
        }
      })
    );
  }
});

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
