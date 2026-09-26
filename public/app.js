/* QuickSave app.js v8.6 */
console.log("QuickSave v8.6 loaded");

const AD_DISABLE_CODE = "666666";
const $ = id => document.getElementById(id);

const url            = $("url"),
      paste          = $("paste"),
      go             = $("go"),
      drop           = $("drop"),
      status         = $("status"),
      result         = $("result"),
      mediaName      = $("name"),
      meta           = $("meta"),
      downloadBtn    = $("download"),
      thumb          = $("thumb"),
      progress       = $("progress"),
      bar            = $("bar"),
      progressText   = $("progressText"),
      progressPct    = $("progressPct"),
      install        = $("install"),
      iosInstall     = $("iosInstall"),
      iosDismiss     = $("iosDismiss"),
      autoToggle     = $("autoToggle"),
      autoLabel      = $("autoLabel"),
      retryBtn       = $("retryBtn"),
      adAfterDl      = $("adAfterDl"),
      interstitialAd = $("interstitialAd"),
      closeBtn       = $("closeInterstitial"),
      adTimerEl      = $("adTimer"),
      queueStatus    = $("queueStatus"),
      queueText      = $("queueText"),
      updateBanner   = $("updateBanner"),
      adCodeInput    = $("adCodeInput"),
      adCodeBtn      = $("adCodeBtn"),
      adCodeMsg      = $("adCodeMsg"),
      bgStatus       = $("bgStatus"),
      bgStatusText   = $("bgStatusText"),
      bgStatusIcon   = $("bgStatusIcon");

let current       = null;
let installPrompt = null;
let autoProc      = false;
let lastUrl       = "";
let swReg         = null;
let newSW         = null;

/* ════════════════════════════════════════
   UTILS
════════════════════════════════════════ */
function isPWA() {
  return window.matchMedia("(display-mode: standalone)").matches ||
         navigator.standalone === true ||
         document.referrer.includes("android-app://");
}
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}
function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches ||
         navigator.standalone === true;
}
const SUPPORTED = ["instagram.com","facebook.com","fb.watch","twitter.com","x.com"];
function isSupportedUrl(u) {
  try {
    const h = new URL(u).hostname.replace(/^www\./,"");
    return SUPPORTED.some(p => h.includes(p));
  } catch { return false; }
}
function escH(s) {
  return String(s).replace(/[&<>"']/g,
    m => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
}
function sizeStr(n) {
  if (!n) return "";
  const u = ["B","KB","MB","GB"]; let i = 0;
  while (n >= 1024 && i < 3) { n /= 1024; i++; }
  return `${n.toFixed(i?1:0)} ${u[i]}`;
}
function buildDlUrl(d) {
  return d?.id ? `/api/download?id=${encodeURIComponent(d.id)}` : "#";
}
function msg(t, c="") {
  status.textContent = t;
  status.className   = "status " + c;
  status.classList.toggle("hide", !t);
}

/* ════════════════════════════════════════
   SMART FILENAME
   Same name → video_1.mp4, video_2.mp4
════════════════════════════════════════ */
function getSmartFilename(filename) {
  const key       = "qs_dl_names";
  const usedNames = JSON.parse(localStorage.getItem(key) || "{}");
  const now       = Date.now();

  /* 24 hours se purane entries clean karo */
  Object.keys(usedNames).forEach(k => {
    if (now - usedNames[k] > 24 * 60 * 60 * 1000) delete usedNames[k];
  });

  const ext  = filename.match(/\.[a-z0-9]+$/i)?.[0] || ".mp4";
  const base = filename.replace(/\.[a-z0-9]+$/i, "");

  let finalName = filename;
  let counter   = 0;

  while (usedNames[finalName]) {
    counter++;
    finalName = `${base}_${counter}${ext}`;
  }

  usedNames[finalName] = now;
  localStorage.setItem(key, JSON.stringify(usedNames));
  return finalName;
}

/* ════════════════════════════════════════
   SAVE FILE TO DEVICE
   Blob URL → a.click()
   Chrome automatically shows "Download complete"
   No extra notification needed from our side
════════════════════════════════════════ */
async function saveFileToDevice(buffer, filename, contentType) {
  if (!buffer || buffer.byteLength < 1000) {
    throw new Error("Invalid file data received");
  }

  const smartName = getSmartFilename(filename);
  const mimeType  = contentType?.startsWith("video/") ? contentType
    : contentType?.startsWith("audio/") ? contentType
    : "video/mp4";

  const blob    = new Blob([buffer], { type: mimeType });
  const blobUrl = URL.createObjectURL(blob);

  console.log("[save]", smartName, (blob.size/1024/1024).toFixed(2)+"MB");

  const a         = document.createElement("a");
  a.href          = blobUrl;
  a.download      = smartName;
  a.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0;";

  document.body.appendChild(a);
  a.click();

  /* Cleanup */
  setTimeout(() => {
    try { document.body.removeChild(a); } catch {}
    URL.revokeObjectURL(blobUrl);
  }, 5000);

  return smartName;
}

/* ════════════════════════════════════════
   BG STATUS UI
════════════════════════════════════════ */
function showBg(text, type="processing", icon="⏳") {
  if (!bgStatus) return;
  if (bgStatusText) bgStatusText.textContent = text;
  if (bgStatusIcon) bgStatusIcon.textContent = icon;
  bgStatus.className = `bg-status ${type}`;
  bgStatus.classList.remove("hide");
}
function hideBg(ms=0) {
  if (ms) setTimeout(() => bgStatus?.classList.add("hide"), ms);
  else bgStatus?.classList.add("hide");
}

/* ════════════════════════════════════════
   QUEUE STATUS
════════════════════════════════════════ */
async function updateQ() {
  try {
    const d = await fetch("/api/queue").then(r=>r.json());
    if (!queueStatus || !queueText) return;
    if (d.processing > 0 || d.waiting > 0) {
      queueStatus.classList.remove("hide");
      queueText.textContent = d.available
        ? "Server ready"
        : `${d.processing} processing, ${d.waiting} waiting`;
    } else {
      queueStatus.classList.add("hide");
    }
  } catch {}
}

/* ════════════════════════════════════════
   AD MANAGEMENT
════════════════════════════════════════ */
function isAdsOff() { return localStorage.getItem("qs_ads_disabled") === "true"; }
function setAdsOff(v) {
  localStorage.setItem("qs_ads_disabled", v ? "true" : "false");
  applyAds();
}
function applyAds() {
  const off = isAdsOff();
  document.querySelectorAll(".ad-wrap,.interstitial-overlay,[data-ad]")
    .forEach(el => el.classList.toggle("ads-hidden", off));
  if (adCodeMsg) {
    adCodeMsg.textContent = off ? "✅ Ads disabled" : "";
    adCodeMsg.className   = off ? "code-msg ok" : "code-msg";
  }
}
adCodeBtn?.addEventListener("click", () => {
  const c = (adCodeInput?.value || "").trim();
  if (c === AD_DISABLE_CODE) {
    setAdsOff(true);
    if (adCodeMsg) {
      adCodeMsg.textContent = "✅ Ads disabled!";
      adCodeMsg.className   = "code-msg ok";
    }
  } else if (c === "000000") {
    setAdsOff(false);
    if (adCodeMsg) {
      adCodeMsg.textContent = "Ads enabled.";
      adCodeMsg.className   = "code-msg";
    }
  } else {
    if (adCodeMsg) {
      adCodeMsg.textContent = "❌ Invalid code.";
      adCodeMsg.className   = "code-msg err";
    }
  }
  if (adCodeInput) adCodeInput.value = "";
});
adCodeInput?.addEventListener("keydown", e => {
  if (e.key === "Enter") adCodeBtn?.click();
});

/* ════════════════════════════════════════
   AUTO TOGGLE
════════════════════════════════════════ */
function isAutoOn() { return localStorage.getItem("qs_auto") !== "false"; }
function setAuto(v) {
  localStorage.setItem("qs_auto", v ? "true" : "false");
  autoToggle.checked    = v;
  autoLabel.textContent = v ? "Auto ON" : "Auto OFF";
}
autoToggle.addEventListener("change", () => setAuto(autoToggle.checked));

/* ════════════════════════════════════════
   SW MESSAGES
════════════════════════════════════════ */
function setupSWMessages() {
  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker.addEventListener("message", async event => {
    const d = event.data || {};

    if (d.type === "BG_STATUS") {
      switch(d.status) {
        case "processing":
          showBg("Processing your video...", "processing", "⏳");
          break;
        case "downloading":
          showBg(`Downloading ${d.filename || "video"}...`, "downloading", "⬇");
          break;
        case "error":
          showBg(d.msg || "Download failed. Please try again.", "err", "❌");
          hideBg(5000);
          break;
      }
      return;
    }

    /* SW ne file bheja - save karo */
    if (d.type === "SAVE_FILE") {
      console.log("[App] Saving file:", d.filename);
      showBg(`Saving ${d.filename}...`, "downloading", "⬇");

      try {
        const savedName = await saveFileToDevice(d.buffer, d.filename, d.contentType);

        /* App ke andar status update - NO notification */
        showBg(`✅ "${savedName}" saved!`, "ok", "✅");
        msg("✅ Video saved to Downloads!", "ok");
        hideBg(6000);

      } catch(e) {
        console.error("[App] Save failed:", e.message);
        showBg(`Save failed: ${e.message}`, "err", "❌");
        hideBg(5000);
      }
    }
  });
}

/* ════════════════════════════════════════
   BACKGROUND DOWNLOAD
════════════════════════════════════════ */
async function startBgDownload(pageUrl) {
  if (!swReg?.active) return false;

  const dlId = `dl_${Date.now()}`;
  swReg.active.postMessage({
    type: "BG_DOWNLOAD",
    data: { url: pageUrl, id: dlId }
  });

  showBg("Processing your video. You can go back to your app!", "processing", "⏳");
  return true;
}

/* ════════════════════════════════════════
   SHARE TARGET
════════════════════════════════════════ */
async function handleShare(sharedUrl) {
  if (!isSupportedUrl(sharedUrl)) {
    msg("Only Instagram, Facebook, Twitter/X links supported.", "err");
    return;
  }
  url.value = sharedUrl;

  if (isPWA() && swReg?.active) {
    const ok = await startBgDownload(sharedUrl);
    if (ok) return;
  }
  await processUrl(sharedUrl, true);
}

/* ════════════════════════════════════════
   INTERSTITIAL AD
════════════════════════════════════════ */
function showAd(cb) {
  if (isAdsOff() || !interstitialAd) { cb?.(); return; }
  interstitialAd.classList.remove("hide");
  document.body.style.overflow = "hidden";
  let s = 5;
  if (adTimerEl) adTimerEl.textContent = s;
  const t = setInterval(() => {
    s--;
    if (adTimerEl) adTimerEl.textContent = s;
    if (s <= 0) { clearInterval(t); close(); cb?.(); }
  }, 1000);
  function close() {
    clearInterval(t);
    interstitialAd.classList.add("hide");
    document.body.style.overflow = "";
  }
  if (closeBtn) closeBtn.onclick = () => { close(); cb?.(); };
  interstitialAd.onclick = e => {
    if (e.target === interstitialAd) { close(); cb?.(); }
  };
}

/* ════════════════════════════════════════
   UPDATE
════════════════════════════════════════ */
function showUpdateBanner() {
  updateBanner?.classList.remove("hide");
  $("updateNowBtn")?.addEventListener("click", () => {
    newSW?.postMessage({ type: "SKIP_WAITING" });
    updateBanner?.classList.add("hide");
  }, { once: true });
}
async function checkVersion() {
  try {
    const d  = await fetch("/api/version?t=" + Date.now()).then(r => r.json());
    const sv = localStorage.getItem("qs_sv");
    if (sv && sv !== d.version) {
      localStorage.setItem("qs_sv", d.version);
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      location.reload(true);
    } else {
      localStorage.setItem("qs_sv", d.version);
    }
  } catch {}
}

/* ════════════════════════════════════════
   CLIPBOARD
════════════════════════════════════════ */
async function tryAutoPaste() {
  if (!isAutoOn()) return null;
  try {
    const t = (await navigator.clipboard.readText()).trim();
    if (t && isSupportedUrl(t)) return t;
  } catch {}
  return null;
}

/* ════════════════════════════════════════
   MAIN PROCESS
════════════════════════════════════════ */
async function processUrl(value, autoDownload=false) {
  if (!value || autoProc) return;
  if (!isSupportedUrl(value)) {
    msg("Only Instagram, Facebook, Twitter/X links supported.", "err");
    return;
  }

  autoProc    = true;
  lastUrl     = value;
  url.value   = value;
  go.disabled = true;
  result.classList.add("hide");
  progress.classList.add("hide");
  adAfterDl?.classList.add("hide");

  const btnTxt = [...go.childNodes].find(n => n.nodeType === Node.TEXT_NODE);
  if (btnTxt) btnTxt.textContent = "Checking... ";
  updateQ();

  try {
    msg("Fetching media info...");

    const r = await fetch("/api/inspect", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ url: value })
    });
    const d = await r.json();
    updateQ();

    if (r.status === 503 && d.type === "queue-full")
      throw new Error(`Server busy (${d.queueSize} waiting). Please try in 30 seconds.`);
    if (r.status === 408)
      throw new Error("Request timed out. Please try again.");
    if (!r.ok || !d.ok)
      throw new Error(d.message || "Could not process this link.");
    if (!d.id)
      throw new Error("Server error. Please try again.");

    current = d;
    mediaName.textContent = d.filename || "media.mp4";
    meta.textContent =
      (d.contentType || "media").replace("video/","").toUpperCase() +
      (d.size ? " • " + sizeStr(d.size) : "");
    showPreview(d);
    downloadBtn.href = buildDlUrl(d);
    downloadBtn.setAttribute("download", d.filename || "QuickSave_Media.mp4");
    result.classList.remove("hide");
    msg("Ready! Tap the button below to download.", "ok");

    if (autoDownload && isAutoOn()) {
      setTimeout(() => triggerDownload(d), 600);
    }

  } catch(e) {
    console.error(e);
    msg("❌ " + (e.message || "Something went wrong."), "err");
  } finally {
    go.disabled = false;
    autoProc    = false;
    if (btnTxt) btnTxt.textContent = "Get media ";
    updateQ();
  }
}

/* ════════════════════════════════════════
   DOWNLOAD
   Fetch as blob → a.click()
   Chrome shows its own "Download complete"
   We do NOT show any extra notification
════════════════════════════════════════ */
async function startDownload(d) {
  progress.classList.remove("hide");
  if (adAfterDl && !isAdsOff()) adAfterDl.classList.remove("hide");

  progressText.textContent = "Downloading...";
  bar.style.width          = "15%";
  progressPct.textContent  = "15%";

  if (isIOS()) {
    window.location.href = buildDlUrl(d);
    setTimeout(() => {
      bar.style.width          = "100%";
      progressPct.textContent  = "100%";
      progressText.textContent = "Tap and hold the video to save to Photos.";
    }, 800);
    return;
  }

  try {
    bar.style.width         = "30%";
    progressPct.textContent = "30%";

    const response = await fetch(buildDlUrl(d));
    if (!response.ok) throw new Error(`Download failed (${response.status})`);

    bar.style.width         = "75%";
    progressPct.textContent = "75%";

    const ct     = (response.headers.get("content-type") || "video/mp4").split(";")[0].trim();
    const buffer = await response.arrayBuffer();

    const savedName = await saveFileToDevice(buffer, d.filename || "QuickSave_video.mp4", ct);

    bar.style.width          = "100%";
    progressPct.textContent  = "100%";
    progressText.textContent = `✅ "${savedName}" saved to Downloads!`;
    msg("✅ Video saved!", "ok");

    /* NO notification - Chrome already shows "Download complete" */

  } catch(e) {
    console.error("[download]", e.message);
    progressText.textContent = "Download failed. Please try again.";
    msg("❌ " + e.message, "err");
  }
}

function triggerDownload(d) {
  if (!d?.id) return;
  if (isPWA() && !isAdsOff()) showAd(() => startDownload(d));
  else startDownload(d);
}

/* ════════════════════════════════════════
   PREVIEW
════════════════════════════════════════ */
function showPreview(d) {
  thumb.innerHTML = "";
  thumb.onclick   = () => window.open(`/api/download?id=${d.id}&inline=1`, "_blank");
  if (d.thumbnail) {
    const img = new Image();
    img.src   = d.thumbnail;
    img.style.cssText = "width:100%;height:100%;object-fit:cover;border-radius:12px;";
    img.onload  = () => thumb.appendChild(img);
    img.onerror = () => { thumb.innerHTML = "<span>▶</span>"; };
  } else {
    thumb.innerHTML = "<span>▶</span>";
  }
}

/* ════════════════════════════════════════
   BUTTONS
════════════════════════════════════════ */
paste.onclick = async () => {
  try {
    const t = (await navigator.clipboard.readText()).trim();
    if (t) {
      url.value = t;
      paste.textContent = "✓ Pasted";
      setTimeout(() => (paste.textContent = "Paste"), 1500);
      if (isAutoOn() && isSupportedUrl(t)) processUrl(t, true);
    } else {
      msg("Clipboard is empty. Copy a link first.", "err");
    }
  } catch {
    msg("Clipboard unavailable. Please paste manually.", "err");
    url.focus();
  }
};

go.onclick = () => {
  const v = url.value.trim();
  if (!v) return msg("Please paste a media URL first.", "err");
  processUrl(v, false);
};

url.onkeydown = e => {
  if (e.key === "Enter") {
    const v = url.value.trim();
    if (v) processUrl(v, isAutoOn() && isSupportedUrl(v));
  }
};

downloadBtn.addEventListener("click", e => {
  if (!current?.id) return;
  e.preventDefault();
  if (isPWA() && !isAdsOff()) showAd(() => startDownload(current));
  else startDownload(current);
});

if (retryBtn) retryBtn.onclick = e => {
  e.preventDefault();
  if (lastUrl) processUrl(lastUrl, false);
};

/* ════════════════════════════════════════
   DRAG & DROP
════════════════════════════════════════ */
["dragenter","dragover"].forEach(ev =>
  drop.addEventListener(ev, x => { x.preventDefault(); drop.classList.add("drag"); })
);
["dragleave","drop"].forEach(ev =>
  drop.addEventListener(ev, x => { x.preventDefault(); drop.classList.remove("drag"); })
);
drop.addEventListener("drop", e => {
  const t = e.dataTransfer.getData("text/plain") ||
            e.dataTransfer.getData("text/uri-list");
  if (t) processUrl(t.trim(), isAutoOn() && isSupportedUrl(t.trim()));
});

/* ════════════════════════════════════════
   PWA INSTALL
════════════════════════════════════════ */
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  installPrompt = e;
  if (!isIOS()) install.classList.remove("hidden");
});
install.onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  install.classList.add("hidden");
};
if (iosDismiss) {
  iosDismiss.onclick = () => {
    iosInstall?.classList.add("hidden");
    localStorage.setItem("qs_ios_dismissed", "true");
  };
}

/* ════════════════════════════════════════
   SERVICE WORKER
════════════════════════════════════════ */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      swReg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      console.log("[SW] Registered");

      swReg.addEventListener("updatefound", () => {
        newSW = swReg.installing;
        newSW.addEventListener("statechange", () => {
          if (newSW.state === "installed" && navigator.serviceWorker.controller)
            showUpdateBanner();
        });
      });

      navigator.serviceWorker.addEventListener("controllerchange", () => location.reload());
      setupSWMessages();
      setInterval(() => swReg.update(), 5 * 60 * 1000);

    } catch(e) { console.log("[SW] Failed:", e); }
  });
}

/* ════════════════════════════════════════
   STARTUP
════════════════════════════════════════ */
async function onStartup() {
  setAuto(isAutoOn());
  applyAds();
  checkVersion();
  updateQ();
  setInterval(updateQ, 30000);

  if (isIOS() && !isStandalone() && !localStorage.getItem("qs_ios_dismissed"))
    setTimeout(() => iosInstall?.classList.remove("hidden"), 3000);

  const params = new URLSearchParams(location.search);

  /* Share target */
  const shared = (
    params.get("url") || params.get("text") || params.get("title") || ""
  ).trim();

  if (shared && isSupportedUrl(shared)) {
    history.replaceState({}, "", "/");
    await new Promise(r => setTimeout(r, 600));
    await handleShare(shared);
    return;
  }

  if (params.get("action") === "paste") {
    history.replaceState({}, "", "/");
    setTimeout(() => paste.onclick?.(), 300);
    return;
  }

  /* Auto paste */
  if (isAutoOn()) {
    const auto = await tryAutoPaste();
    if (auto) {
      msg("Link detected. Processing...", "ok");
      await processUrl(auto, true);
      return;
    }
  }
}

/* ════════════════════════════════════════
   VISIBILITY CHANGE
════════════════════════════════════════ */
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || autoProc) return;

  swReg?.update();
  checkVersion();
  updateQ();

  if (!isAutoOn()) return;
  await new Promise(r => setTimeout(r, 400));
  const auto = await tryAutoPaste();
  if (auto && auto !== url.value.trim()) {
    msg("New link detected. Processing...", "ok");
    await processUrl(auto, true);
  }
});

onStartup();
