// Drives a throwaway headless Chrome over the DevTools pipe, with the unpacked
// extension loaded into a fresh profile. Nothing here touches your own browser.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CANDIDATES = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function launch({ profile, downloads, extraArgs = [] }) {
  const chrome = CANDIDATES.find((path) => existsSync(path));
  if (!chrome) throw new Error("Chrome not found. Set CHROME to its binary.");
  rmSync(profile, { recursive: true, force: true });
  rmSync(downloads, { recursive: true, force: true });
  mkdirSync(join(profile, "Default"), { recursive: true });
  mkdirSync(downloads, { recursive: true });
  writeFileSync(
    join(profile, "Default", "Preferences"),
    JSON.stringify({
      download: { default_directory: downloads, prompt_for_download: false },
      plugins: { always_open_pdf_externally: true },
    }),
  );
  const proc = spawn(
    chrome,
    [
      "--headless=new",
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging", // lets Extensions.loadUnpacked work
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...extraArgs,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  const writer = proc.stdio[3];
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  let buffer = Buffer.alloc(0);
  proc.stdio[4].on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let end;
    while ((end = buffer.indexOf(0)) >= 0) {
      const message = JSON.parse(buffer.subarray(0, end).toString("utf8"));
      buffer = buffer.subarray(end + 1);
      const waiter = message.id && pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
        else waiter.resolve(message.result);
      } else {
        for (const listener of listeners) listener(message);
      }
    }
  });

  function send(method, params = {}, sessionId) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      writer.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });
  }

  async function attach(targetId) {
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Runtime.enable", {}, sessionId);
    return sessionId;
  }

  async function open(url) {
    const { targetId } = await send("Target.createTarget", { url });
    return attach(targetId);
  }

  async function evaluate(sessionId, expression) {
    const result = await send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error("page exception: " + (details.exception?.description || details.text));
    }
    return result.result.value;
  }

  async function waitFor(sessionId, expression, timeout = 20000, interval = 200) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const value = await evaluate(sessionId, expression);
        if (value) return value;
      } catch {}
      await sleep(interval);
    }
    throw new Error(`timed out waiting for: ${expression}`);
  }

  async function key(sessionId, name) {
    const code = { Enter: 13, ArrowDown: 40, ArrowUp: 38 }[name];
    for (const type of ["keyDown", "keyUp"]) {
      await send(
        "Input.dispatchKeyEvent",
        { type, key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code },
        sessionId,
      );
    }
  }

  // A popup is as wide as its page asks and as tall as its content, up to
  // 600px. `full` captures the whole page instead (for the settings page).
  async function shot(sessionId, file, { width = 420, maxHeight = 600, dark = false, full = false } = {}) {
    await send(
      "Emulation.setEmulatedMedia",
      { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] },
      sessionId,
    );
    await send(
      "Emulation.setDeviceMetricsOverride",
      { width, height: maxHeight, deviceScaleFactor: 2, mobile: false },
      sessionId,
    );
    await sleep(250);
    const natural = await evaluate(
      sessionId,
      full
        ? "Math.ceil(document.body.getBoundingClientRect().height)"
        : "Math.ceil((document.querySelector('.app') || document.body).getBoundingClientRect().height)",
    );
    const height = full ? natural : Math.min(maxHeight, natural);
    const { data } = await send(
      "Page.captureScreenshot",
      { format: "png", clip: { x: 0, y: 0, width, height, scale: 1 }, captureBeyondViewport: full },
      sessionId,
    );
    writeFileSync(file, Buffer.from(data, "base64"));
  }

  async function loadExtension(path) {
    const { id } = await send("Extensions.loadUnpacked", { path });
    return id;
  }

  const targets = async () => (await send("Target.getTargets")).targetInfos;

  async function close() {
    try {
      await send("Browser.close");
    } catch {}
    await sleep(400);
    proc.kill();
  }

  return {
    send, attach, open, evaluate, waitFor, key, shot, loadExtension, targets, close,
    onEvent: (listener) => listeners.add(listener),
  };
}
