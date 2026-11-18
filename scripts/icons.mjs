// Renders the icons to the PNG sizes the manifest lists.
//   node scripts/icons.mjs
// The 128px file keeps an 8px margin, as store icons should.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "../tests/cdp.mjs";

const icons = resolve(dirname(fileURLToPath(import.meta.url)), "../extension/icons");
const svg = readFileSync(join(icons, "icon.svg"), "utf8");
const work = mkdtempSync(join(tmpdir(), "callslip-icons-"));
const browser = await launch({ profile: join(work, "profile"), downloads: join(work, "downloads") });
try {
  const page = await browser.open("about:blank");
  await browser.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } }, page);
  for (const [size, art] of [[16, 16], [32, 32], [48, 48], [128, 112]]) {
    await browser.send("Emulation.setDeviceMetricsOverride", { width: size, height: size, deviceScaleFactor: 1, mobile: false }, page);
    const inset = (size - art) / 2;
    await browser.evaluate(page, `(document.documentElement.innerHTML = ${JSON.stringify(
      `<body style="margin:0;background:transparent"><div style="position:absolute;left:${inset}px;top:${inset}px;width:${art}px;height:${art}px">${svg}</div></body>`,
    )}, true)`);
    await sleep(200);
    const { data } = await browser.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: size, height: size, scale: 1 } }, page);
    writeFileSync(join(icons, `icon${size}.png`), Buffer.from(data, "base64"));
    console.log(`icon${size}.png`);
  }
} finally {
  await browser.close();
  rmSync(work, { recursive: true, force: true });
}
