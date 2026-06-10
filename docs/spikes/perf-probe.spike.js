// SPIKE (throwaway): de-risk the client FPS proxy (P1b) under WORST-CASE load.
// Boots the real server (config temporarily patched: 25-kart grid + forced
// stacked brutal round), creates an AI-filled PREVIEW room (skips the lobby
// rally straight to a race), loads the real client headless, times each rAF
// callback's work (the per-frame CPU budget), then re-runs under 4x CPU
// throttle. Restores config on exit. Not committed to the build.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const PORT = 28910;
const ORIGIN = `http://localhost:${PORT}`;
const CONFIG = path.join(__dirname, "server", "config.json");
const MAP_FILE = path.join(__dirname, "client", "maps", "4Suns!.json");

function pct(arr, p) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const f = (n) => (Number.isFinite(n) ? n.toFixed(2) : "n/a");

// Temporarily force the worst-case load in config; return a restore fn.
function patchConfig() {
  const orig = fs.readFileSync(CONFIG, "utf8");
  const c = JSON.parse(orig);
  c.chanceOfBrutalRound = 100;        // every round is brutal
  c.chanceForAdditionalBrutal = 100;  // stack additional brutal types
  c.maxTotalBrutals = 4;              // up to 4 stacked (volcano/hockey/cloudy/...)
  c.aiRacers.minGrid = 25;
  c.aiRacers.maxGrid = 25;            // botTarget=25 -> 24 bots + 1 human = 25 karts
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 4));
  return () => fs.writeFileSync(CONFIG, orig);
}

function bootServer() {
  return new Promise((resolve, reject) => {
    const srv = spawn("node", ["index.js"], {
      cwd: __dirname,
      env: { ...process.env, PORT: String(PORT), NODE_ENV: "development" },
    });
    let out = "";
    const onData = (d) => { out += d.toString(); if (/listening on/i.test(out)) resolve(srv); };
    srv.stdout.on("data", onData);
    srv.stderr.on("data", onData);
    srv.on("exit", (c) => reject(new Error(`server exited early (${c}):\n${out}`)));
    setTimeout(() => reject(new Error(`server boot timeout:\n${out}`)), 20000);
  });
}

const SAMPLER = `(() => {
  window.__frames = [];
  const orig = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) {
    return orig(function (ts) {
      const t0 = performance.now();
      try { cb(ts); } finally { window.__frames.push(performance.now() - t0); }
    });
  };
  window.__resetFrames = () => { window.__frames.length = 0; };
})();`;

async function waitFor(page, fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const snap = await page.evaluate(fn);
    if (JSON.stringify(snap) !== JSON.stringify(last)) {
      console.log(`    ${label}: ${JSON.stringify(snap)}`);
      last = snap;
    }
    if (snap && snap.done) return snap;
    await page.waitForTimeout(500);
  }
  return null;
}

async function sample(page, label, seconds) {
  await page.evaluate(() => window.__resetFrames());
  await page.waitForTimeout(seconds * 1000);
  const d = await page.evaluate(() => ({
    frames: window.__frames.slice(),
    heap: (performance && performance.memory) ? performance.memory.usedJSHeapSize : null,
    karts: window.playerList ? Object.keys(window.playerList).length : null,
    projectiles: window.projectileList ? Object.keys(window.projectileList).length : null,
    state: window.currentState,
    brutal: (window.gameBoard && window.gameBoard.brutalRoundConfig) ? window.gameBoard.brutalRoundConfig : (typeof window.brutalRoundConfig !== "undefined" ? window.brutalRoundConfig : null),
  }));
  const fr = d.frames;
  console.log(`\n  ${label} (${seconds}s):`);
  console.log(`    karts=${d.karts}  projectiles=${d.projectiles}  brutal=${JSON.stringify(d.brutal)}`);
  console.log(`    frames sampled : ${fr.length}`);
  console.log(`    frame-work ms  : p50=${f(pct(fr, 50))}  p95=${f(pct(fr, 95))}  p99=${f(pct(fr, 99))}  max=${f(Math.max(...fr))}`);
  console.log(`    implied FPS@p95: ${f(1000 / pct(fr, 95))}   JS heap: ${d.heap ? (d.heap / 1048576).toFixed(1) + " MB" : "n/a"}`);
  return { p50: pct(fr, 50), p95: pct(fr, 95), count: fr.length, karts: d.karts };
}

(async () => {
  const restore = patchConfig();
  let srv, browser;
  const errors = [];
  try {
    console.log("[1/5] Patched config (25-kart grid, forced 4x-stacked brutal). Booting server ...");
    srv = await bootServer();
    console.log("      server listening on :" + PORT);

    console.log("[2/5] Launching headless Chromium (iPad-ish: 1194x834, DPR 2, touch) ...");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1194, height: 834 }, deviceScaleFactor: 2, hasTouch: true,
      userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    });
    await context.addInitScript(SAMPLER);
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });

    console.log("[3/5] Creating AI-filled preview room via the editor socket ...");
    const mapJson = fs.readFileSync(MAP_FILE, "utf8");
    await page.goto(`${ORIGIN}/create.html`, { waitUntil: "domcontentloaded" });
    await waitFor(page, () => ({ done: !!(window.server && window.server.connected) }), 15000, "socket");
    const gameID = await page.evaluate((mj) => new Promise((res, rej) => {
      const t = setTimeout(() => rej("no previewRoomCreated"), 10000);
      window.server.on("previewRoomCreated", (p) => { clearTimeout(t); res(p.gameID); });
      window.server.on("previewRejected", (p) => { clearTimeout(t); rej("rejected: " + p.reason); });
      sessionStorage.setItem("previewMap", mj);
      window.server.emit("createPreviewRoom", JSON.stringify({ map: JSON.parse(mj), enableAI: true }));
    }), mapJson);
    console.log("      preview room gameID=" + gameID);

    console.log("[4/5] Loading client into the race (preview skips lobby) ...");
    await page.goto(`${ORIGIN}/play.html?gameid=${gameID}&preview=1`, { waitUntil: "domcontentloaded" });
    const reached = await waitFor(page, () => {
      const racing = (window.config && window.config.stateMap) ? window.config.stateMap.racing : null;
      return { state: window.currentState, racing, karts: window.playerList ? Object.keys(window.playerList).length : 0, done: racing != null && window.currentState === racing };
    }, 45000, "state");
    if (!reached) {
      console.log("\n  [!] Never reached racing.");
      if (errors.length) console.log("  page errors:\n   - " + errors.slice(0, 8).join("\n   - "));
      throw new Error("never reached racing");
    }
    console.log("      RACING reached with " + reached.karts + " karts.");

    console.log("[5/5] Sampling frame-work under load ...");
    const base = await sample(page, "BASELINE (no throttle)", 12);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    console.log("\n  Applied CDP CPU throttle 4x ...");
    const thr = await sample(page, "THROTTLED (4x CPU)", 12);

    const scale = thr.p95 / base.p95;
    console.log("\n=== SPIKE VERDICT (worst-case load) ===");
    console.log(`  Reached racing headless (no manual input) . YES`);
    console.log(`  Karts under load .......................... ${base.karts}`);
    console.log(`  Per-frame work measurable ................. YES (${base.count}+${thr.count} frames)`);
    console.log(`  CPU throttle scales the metric ............ ${Number.isFinite(scale) ? scale.toFixed(2) + "x (p95)" : "n/a"}`);
    if (errors.length) console.log(`  NOTE: ${errors.length} page error(s); first: ${errors[0]}`);
    console.log("=======================================");
  } catch (e) {
    console.error("\nSPIKE FAILED:", e.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (srv) srv.kill("SIGKILL");
    restore();
    console.log("\n(config restored)");
  }
})();
