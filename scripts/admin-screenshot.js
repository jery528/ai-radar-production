// 开发期工具：用 CDP 控制无头 Edge 截图已登录的管理后台
// 用法：node scripts/admin-screenshot.js <token> <tab> <输出.png>
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const [token, tab = "overview", outFile = "admin-shot.png"] = process.argv.slice(2);
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9223;

const edge = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + path.join(os.tmpdir(), "edge-cdp-profile"),
  "about:blank",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp() {
  await sleep(2500);
  const targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json());
  console.log("[diag] targets:", targets.map((t) => `${t.type}:${t.url}`).join(" | "));
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  await new Promise((resolve) => (ws.onopen = resolve));
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const msgId = ++id;
      pending.set(msgId, resolve);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  const evalJs = async (expression, awaitPromise = false) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (r.result && r.result.exceptionDetails) {
      return "EXCEPTION: " + JSON.stringify(r.result.exceptionDetails.exception || {}).slice(0, 200);
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send("Page.enable");
  await send("Page.navigate", { url: "http://localhost:3000/admin" });
  await sleep(1500);
  await evalJs(`localStorage.setItem('radar_admin_token', ${JSON.stringify(token)})`);
  console.log("[diag] storage after set:", String(await evalJs(`localStorage.getItem('radar_admin_token')`)).slice(0, 24));
  console.log(
    "[diag] overview status from page:",
    await evalJs(
      `fetch('/api/admin/overview',{headers:{authorization:'Bearer '+localStorage.getItem('radar_admin_token')}}).then(r=>r.status)`,
      true
    )
  );
  await send("Page.reload");
  await sleep(3500);
  console.log("[diag] storage after reload:", String(await evalJs(`localStorage.getItem('radar_admin_token')`)).slice(0, 24));
  console.log(
    "[diag] visibility:",
    await evalJs(`JSON.stringify({loginHidden: document.querySelector('[data-login]').hidden, shellHidden: document.querySelector('[data-shell]').hidden})`)
  );

  if (tab !== "overview") {
    await evalJs(`document.querySelector('[data-tab="${tab}"]').click()`);
    await sleep(2500);
  }
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1300, deviceScaleFactor: 1, mobile: false });
  await sleep(800);
  console.log(
    "[diag] before capture:",
    await evalJs(`JSON.stringify({url: location.pathname, loginHidden: document.querySelector('[data-login]').hidden, shellHidden: document.querySelector('[data-shell]').hidden, panelChars: (document.querySelector('[data-panel]')||{innerHTML:''}).innerHTML.length})`)
  );
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(outFile, Buffer.from(shot.result.data, "base64"));
  console.log("written:", outFile);
  ws.close();
}

cdp()
  .catch((e) => console.error("FAILED:", e.message))
  .finally(() => edge.kill());
