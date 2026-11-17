// End-to-end test: loads the real extension into a throwaway headless Chrome
// and drives the popup and settings page the way a person would.
//
//   node tests/e2e.mjs [--shots <dir>]
//
// Sites that need a library login are replaced by stand-ins (fake-sites.mjs).
// Crossref, OpenAlex and two open-access articles are the real thing, so the
// test needs a network connection. Requires Chrome and openssl.
import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "./cdp.mjs";
import { startFakeSites, PROXY_LINK, PAGE_PERMISSIONS, INFORMS, NO_PATTERN } from "./fake-sites.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shotsAt = process.argv.indexOf("--shots");
const shots = shotsAt > 0 ? resolve(process.argv[shotsAt + 1]) : null;
if (shots) mkdirSync(shots, { recursive: true });

const PAYWALLED = {
  title: "Supply chain resilience: definition, review and theoretical foundations for further study",
  doi: "10.1080/00207543.2015.1037934",
  file: "tukamuhabwa2015supply.pdf",
};
const IN_EBSCO = {
  title: "Scholarly Context Not Found: One in Five Articles Suffers from Reference Rot",
  doi: "10.1371/journal.pone.0115253",
  file: "klein2014scholarly.pdf",
};
const OPEN_ACCESS = { doi: "10.1371/journal.pmed.0020124" };
const OPEN_AT_PUBLISHER = { doi: "10.1038/s41586-020-2649-2", publisher: "Nature" };

const work = mkdtempSync(join(tmpdir(), "paper-fetch-e2e-"));
const downloads = join(work, "downloads");
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};
const saved = () => readdirSync(downloads).sort();
const isPdf = (name) => readFileSync(join(downloads, name)).subarray(0, 5).toString() === "%PDF-";

// The extension under test is a copy that may read the stand-in article pages,
// which is what clicking the toolbar button on such a page grants for real.
const extension = join(work, "extension");
cpSync(join(root, "extension"), extension, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extension, "manifest.json"), "utf8"));
manifest.host_permissions.push(...PAGE_PERMISSIONS);
writeFileSync(join(extension, "manifest.json"), JSON.stringify(manifest));

const fake = await startFakeSites({ dir: work, port: 8443, ebscoTitle: IN_EBSCO.title });
const browser = await launch({ profile: join(work, "profile"), downloads, extraArgs: fake.chromeArgs });
const errors = [];
browser.onEvent((message) => {
  if (message.method === "Runtime.exceptionThrown") {
    const details = message.params.exceptionDetails;
    errors.push(details.exception?.description || details.text);
  }
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    errors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
  }
});

const { evaluate, waitFor, key } = browser;
const text = (page, id) => evaluate(page, `document.getElementById('${id}').textContent`);
const click = (page, id) => evaluate(page, `(document.getElementById('${id}').click(), true)`);
const message = (page, payload) => evaluate(page, `chrome.runtime.sendMessage(${JSON.stringify(payload)})`);
const job = (page) => evaluate(page, "chrome.storage.session.get('job').then((data) => data.job || null)");
const stepOf = (result, name) => result.steps.find((step) => step.key === name);
const routes = (result) => JSON.stringify(result.steps.map((step) => [step.key, step.state, step.detail]));
const snap = (page, name, options) => (shots ? browser.shot(page, join(shots, name), options) : null);
const listed = (page) => waitFor(page, "!document.getElementById('search').disabled && document.querySelectorAll('#results .item').length > 0", 40000);

async function type(page, value) {
  await evaluate(page, `(() => { const t = document.getElementById('title'); t.focus(); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await browser.send("Input.insertText", { text: value }, page);
}

async function search(page, value) {
  await type(page, value);
  await key(page, "Enter");
  await listed(page);
  await sleep(200);
}

// Starts a download with `start` and returns the finished job.
async function download(page, start) {
  await evaluate(page, "chrome.storage.session.remove('job')");
  await start();
  await waitFor(page, "chrome.storage.session.get('job').then((data) => Boolean(data.job))", 10000);
  await waitFor(page, "chrome.storage.session.get('job').then((data) => data.job.status !== 'running')", 150000, 400);
  await sleep(300);
  return job(page);
}

try {
  const id = await browser.loadExtension(extension);
  const popupUrl = `chrome-extension://${id}/popup.html`;
  await sleep(1200);
  const worker = (await browser.targets()).find((target) => target.type === "service_worker" && target.url.includes(id));
  check("service worker starts", Boolean(worker));
  await browser.attach(worker.targetId);
  check("first install opens the settings page", (await browser.targets()).some((target) => target.url.endsWith("/options.html")));

  // Opens a web page, then the popup "on" it, as clicking the toolbar button
  // on that page would.
  async function popupOn(url) {
    const page = await browser.open(url);
    await waitFor(page, "document.readyState === 'complete'", 15000);
    const tabId = await evaluate(popup, `chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === ${JSON.stringify(url)})?.id)`);
    return browser.open(`${popupUrl}?tab=${tabId}`);
  }

  // ------------------------------------------------ popup, nothing set up yet
  const popup = await browser.open(popupUrl);
  await waitFor(popup, "document.querySelector('#notice .link')", 8000).catch(() => {});
  check("first run points at library setup", (await text(popup, "notice")).includes("Set up library access"));
  check("title field has focus", await evaluate(popup, "document.activeElement.id === 'title'"));
  await snap(popup, "popup-empty.png");

  // The settings page stays open from here on, as it would in a second tab.
  const options = await browser.open(`chrome-extension://${id}/options.html`);
  await waitFor(options, "document.getElementById('preview').textContent.length > 0");
  await snap(options, "settings.png", { width: 720, maxHeight: 1000, full: true });
  await snap(options, "settings-dark.png", { width: 720, maxHeight: 1000, full: true, dark: true });
  await snap(options, "reset.png", { width: 720, maxHeight: 1000 });

  await search(popup, PAYWALLED.title);
  const meta = await evaluate(popup, "document.querySelector('#results .item-meta').textContent");
  check("match line shows the year", /\b(19|20)\d\d\b/.test(meta), meta);
  check("top match is selected", await evaluate(popup, "document.querySelector('#results .item').getAttribute('aria-selected') === 'true'"));
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 600, deviceScaleFactor: 2, mobile: false }, popup);
  const layout = await evaluate(popup, `(() => {
    const app = document.querySelector('.app').getBoundingClientRect();
    const foot = document.getElementById('foot').getBoundingClientRect();
    return { height: Math.round(app.height), footBottom: Math.round(foot.bottom), pageScrolls: document.documentElement.scrollHeight > 600 };
  })()`);
  check("popup stays within 600px with the action bar visible", layout.height <= 600 && layout.footBottom <= 600 && !layout.pageScrolls, JSON.stringify(layout));
  await snap(popup, "popup-results.png");
  await snap(popup, "popup-results-dark.png", { dark: true });
  await snap(popup, "reset.png");

  await key(popup, "ArrowDown");
  check("arrow keys move the selection from the title field", await evaluate(popup, "document.querySelectorAll('#results .item')[1].getAttribute('aria-selected') === 'true'"));
  await key(popup, "ArrowUp");

  const knob = await evaluate(popup, `(async () => {
    const input = document.getElementById('auto');
    const read = () => getComputedStyle(input.nextElementSibling, '::after').transform;
    const before = read();
    input.click();
    await new Promise((done) => setTimeout(done, 400));
    const after = read();
    input.click();
    await new Promise((done) => setTimeout(done, 400));
    return before !== after;
  })()`);
  check("switch knob moves", knob);

  // ------------------------------------------------ every route refuses
  let result = await download(popup, () => key(popup, "Enter"));
  console.log("      ", routes(result));
  check("a paywall page is not accepted as the paper", stepOf(result, "publisher").state === "failed" && stepOf(result, "publisher").detail === "got a web page, not a PDF", stepOf(result, "publisher").detail);
  check("proxy is skipped until it is set up", stepOf(result, "proxy").state === "skipped");
  check("EBSCO record with another title is not taken", stepOf(result, "ebsco").detail === "no matching record", stepOf(result, "ebsco").detail);
  check("nothing but PDFs left in Downloads", saved().every(isPdf), JSON.stringify(saved()));
  if (result.status === "failed") {
    check("failure offers the article page", result.fallback?.url === `https://doi.org/${PAYWALLED.doi}`, JSON.stringify(result.fallback));
  }
  check("EBSCO customer code found and remembered", (await message(popup, { type: "settings:get" })).settings.ebscoCustomer === "test1");
  check("open settings page picks up the detected code", (await evaluate(options, "document.getElementById('customer').value")) === "test1");

  // ------------------------------------------------ three ways to set the proxy
  // 1. Opening the popup on the library's own sign-in page.
  const onSignIn = await popupOn(`${PROXY_LINK}https://pubsonline.informs.org/doi/${INFORMS[0].doi}`);
  await waitFor(onSignIn, "!document.getElementById('offer').hidden", 8000);
  await evaluate(onSignIn, "(document.querySelector('#offer .link').click(), true)");
  await sleep(500);
  let settings = (await message(options, { type: "settings:get" })).settings;
  check("sign-in page is offered as the proxy and saved in one click", settings.proxy === PROXY_LINK, settings.proxy);
  check("saving one setting leaves the others alone", settings.ebscoCustomer === "test1", settings.ebscoCustomer);

  // 2. Looking the university up by name.
  await message(options, { type: "settings:set", settings: { proxy: "" } });
  await evaluate(options, "(document.getElementById('school').focus(), true)");
  await browser.send("Input.insertText", { text: "test uni" }, options);
  await waitFor(options, "document.querySelectorAll('#schools [role=option]').length > 0", 10000);
  const offered = await evaluate(options, "[...document.querySelectorAll('#schools [role=option]')].map((row) => row.textContent)");
  check("university search lists the match and leaves out unusable entries", offered.length === 1 && offered[0].startsWith("Test University"), JSON.stringify(offered));
  await snap(options, "settings-finder.png", { width: 720, maxHeight: 1000, full: true });
  await snap(options, "reset.png", { width: 720, maxHeight: 1000 });
  await key(options, "Enter");
  await sleep(500);
  settings = (await message(options, { type: "settings:get" })).settings;
  check("picking a university fills in and saves its proxy link", settings.proxy === PROXY_LINK && (await evaluate(options, "document.getElementById('proxy').value")) === PROXY_LINK, settings.proxy);

  // 3. Pasting any link that goes through the proxy.
  await evaluate(options, `(async () => {
    const field = document.getElementById('proxy');
    field.value = 'login.ezproxy.test-uni.edu/login?url=https://www.jstor.org/stable/1';
    field.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((done) => setTimeout(done, 500));
    return true;
  })()`);
  settings = (await message(options, { type: "settings:get" })).settings;
  check("a pasted proxied link is trimmed to the sign-in link", settings.proxy === PROXY_LINK, settings.proxy);

  // signed out of the proxy
  result = await download(popup, () => click(popup, "download"));
  const proxyStep = stepOf(result, "proxy");
  check("proxy sign-in page is recognised", proxyStep.state === "failed" && proxyStep.detail === "sign-in required", proxyStep.detail);
  check("with a one-click way to sign in", proxyStep.action?.url === `${PROXY_LINK}https://www.tandfonline.com/doi/pdf/${PAYWALLED.doi}`, JSON.stringify(proxyStep.action));
  if (result.status === "failed") {
    check("failure offers the article through the library", result.fallback?.url === `${PROXY_LINK}https://doi.org/${PAYWALLED.doi}`, JSON.stringify(result.fallback));
    await snap(popup, "popup-failed.png");
    await snap(popup, "popup-failed-dark.png", { dark: true });
    await snap(popup, "reset.png");
  }
  check("nothing but PDFs left in Downloads", saved().every(isPdf), JSON.stringify(saved()));

  // signed in
  const signIn = await browser.open("https://login.ezproxy.test-uni.edu/login?signin=1");
  await waitFor(signIn, "document.title === 'Signed in'", 10000);
  result = await download(popup, () => click(popup, "download"));
  check("downloads through the library proxy once signed in", result.status === "done" && result.provider === "Library proxy", `${result.status} ${result.provider || ""}`);
  check("file is named by cite key and is a PDF", result.filename === PAYWALLED.file && saved().includes(PAYWALLED.file) && isPdf(PAYWALLED.file), result.filename);
  await snap(popup, "popup-saved.png");

  // ------------------------------------------------ opened on an article page
  // INFORMS, off campus: the paper is recognised, the publisher refuses, the proxy delivers.
  await message(popup, { type: "settings:set", settings: { autoDefault: true } });
  let onPage = await popupOn(`https://pubsonline.informs.org/doi/${INFORMS[0].doi}`);
  await listed(onPage);
  check("an INFORMS article page is recognised", (await text(onPage, "count")) === "On this page" && (await evaluate(onPage, "document.querySelector('.item-title').textContent")) === INFORMS[0].title, await text(onPage, "count"));
  check("it is marked as an INFORMS paper", (await evaluate(onPage, "document.querySelector('.tag.pub')?.textContent")) === "INFORMS");
  await sleep(1500);
  check("recognising a page never downloads by itself, even with auto-download on", (await job(onPage))?.candidate?.doi !== INFORMS[0].doi);
  await message(popup, { type: "settings:set", settings: { autoDefault: false } });
  await evaluate(onPage, "chrome.storage.session.remove('job')");
  onPage = await popupOn(`https://pubsonline.informs.org/doi/${INFORMS[0].doi}`);
  await listed(onPage);
  check("reopening on the same page shows it again without a new lookup", (await text(onPage, "count")) === "On this page");
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 600, deviceScaleFactor: 2, mobile: false }, onPage);
  await snap(onPage, "popup-on-page.png");
  result = await download(onPage, () => key(onPage, "Enter"));
  check("one Enter downloads it", result.status === "done" && result.filename === INFORMS[0].file && isPdf(INFORMS[0].file), `${result.status} ${result.provider || ""} ${result.filename || ""} ${routes(result)}`);
  check("through the proxy, since the publisher's own link is paywalled", result.provider === "Library proxy" && stepOf(result, "publisher").state === "failed", routes(result));

  // The same site read through the library proxy: the page's own PDF link works.
  onPage = await popupOn(`https://pubsonline-informs-org.ezproxy.test-uni.edu/doi/full/${INFORMS[1].doi}`);
  await listed(onPage);
  check("a proxied INFORMS page is recognised", (await text(onPage, "count")) === "On this page");
  result = await download(onPage, () => key(onPage, "Enter"));
  check("and downloaded from that page's own PDF link", result.status === "done" && result.provider === "This page" && result.filename === INFORMS[1].file, `${result.status} ${result.provider || ""} ${result.filename || ""} ${routes(result)}`);

  // An issue page: every article it links to is listed.
  onPage = await popupOn("https://pubsonline.informs.org/toc/mnsc/66/1");
  await waitFor(onPage, "document.querySelectorAll('#results .item').length > 0", 15000);
  const issue = await evaluate(onPage, "[...document.querySelectorAll('.item-title')].map((node) => node.textContent)");
  check("an issue page lists its papers", (await text(onPage, "count")) === "3 papers on this page" && JSON.stringify(issue) === JSON.stringify(INFORMS.map((paper) => paper.title)), JSON.stringify(issue));
  check("the last download's result stays while it is one of the listed papers", await evaluate(onPage, "!document.getElementById('job').hidden"));
  await evaluate(onPage, "chrome.storage.session.remove('job')");
  await sleep(300);
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 600, deviceScaleFactor: 2, mobile: false }, onPage);
  await snap(onPage, "popup-page-list.png");
  await key(onPage, "ArrowDown");
  await key(onPage, "ArrowDown");
  result = await download(onPage, () => key(onPage, "Enter"));
  check("a paper picked from the list gets its author and year looked up", result.status === "done" && result.filename === INFORMS[2].file, `${result.status} ${result.filename || ""} ${routes(result)}`);

  // A publisher we have no address pattern for, but whose page names its PDF.
  onPage = await popupOn(NO_PATTERN.page);
  await listed(onPage);
  result = await download(onPage, () => key(onPage, "Enter"));
  check("a page's citation_pdf_url is used when the publisher is unknown", result.status === "done" && result.provider === "This page" && result.filename === NO_PATTERN.file, `${result.status} ${result.provider || ""} ${result.filename || ""} ${routes(result)}`);

  // ------------------------------------------------ EBSCO route
  fake.hits.length = 0;
  await search(popup, IN_EBSCO.doi);
  check("a DOI is looked up directly", (await text(popup, "count")) === "DOI match");
  result = await download(popup, () => key(popup, "Enter"));
  check("downloads through EBSCO", result.status === "done" && result.provider === "EBSCO", `${result.status} ${result.provider || ""} ${routes(result)}`);
  check("EBSCO file renamed to the cite key", result.filename === IN_EBSCO.file && isPdf(IN_EBSCO.file), result.filename);
  check("falls back from DOI to title search", fake.hits.filter((hit) => hit.endsWith("/c/test1/search/advanced")).length === 2);
  check("opens the record whose title matches", fake.hits.some((hit) => hit.includes("/details/right1")) && !fake.hits.some((hit) => hit.includes("/details/wrong1")));
  check("picks PDF in the download dialog", fake.hits.some((hit) => hit.endsWith("?fmt=pdf")) && !fake.hits.some((hit) => hit.endsWith("?fmt=epub")));
  check("closes its EBSCO tab", !(await browser.targets()).some((target) => target.type === "page" && target.url.includes("ebsco")));

  result = await download(popup, () => key(popup, "Enter"));
  check("a second copy does not overwrite the first", result.status === "done" && result.filename !== IN_EBSCO.file && saved().includes(IN_EBSCO.file), result.filename);

  // ------------------------------------------------ live open-access routes
  await search(popup, OPEN_ACCESS.doi);
  result = await download(popup, () => key(popup, "Enter"));
  check("downloads an open-access copy (live)", result.status === "done" && result.provider === "Open access" && isPdf(result.filename), `${result.status} ${result.provider || ""} ${routes(result)}`);

  await search(popup, OPEN_AT_PUBLISHER.doi);
  result = await download(popup, () => key(popup, "Enter"));
  check("downloads straight from the publisher (live)", result.status === "done" && result.provider === OPEN_AT_PUBLISHER.publisher && isPdf(result.filename), `${result.status} ${result.provider || ""} ${routes(result)}`);

  // ------------------------------------------------ popup closed and reopened
  const reopened = await browser.open(popupUrl);
  await waitFor(reopened, "document.querySelectorAll('#results .item').length > 0", 8000);
  check("matches come back when the popup reopens", (await evaluate(reopened, "document.getElementById('title').value")) === OPEN_AT_PUBLISHER.doi);
  check("download result comes back too", await evaluate(reopened, "!document.getElementById('job').hidden"));
  check("no setup prompt once a library is configured", !(await text(reopened, "notice")).includes("Set up library access"));

  // ------------------------------------------------ remaining popup behaviour
  await click(popup, "clear");
  await sleep(200);
  check("Clear empties the list and brings the guidance back", (await evaluate(popup, "document.getElementById('matches').hidden && document.getElementById('foot').hidden")) && (await text(popup, "notice")).startsWith("On an article page"));

  const pasted = await evaluate(popup, `(() => {
    const field = document.getElementById('title');
    field.focus();
    const data = new DataTransfer();
    data.setData('text', '  Scholarly Context Not Found:\\nOne in Five Articles\\r\\n   Suffers from Reference Rot ');
    field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    return field.value;
  })()`);
  check("line breaks in a pasted title are flattened", pasted === IN_EBSCO.title, JSON.stringify(pasted));

  await click(popup, "auto");
  await sleep(400);
  result = await download(popup, () => key(popup, "Enter"));
  check("auto-download starts on a clear match", result.status === "done", result.status);
  check("settings page follows the popup's switch", await evaluate(options, "document.getElementById('autoDefault').checked"));
  await click(popup, "auto");
  await sleep(300);

  await evaluate(popup, "chrome.storage.session.remove('job')");
  await evaluate(popup, `(() => { const t = document.getElementById('title'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); return true; })()`);
  await browser.send("Input.insertText", { text: " revisited" }, popup);
  await sleep(200);
  check("editing the query turns Enter back into search", /search again/.test(await text(popup, "hint")), await text(popup, "hint"));
  await key(popup, "Enter");
  await sleep(1500);
  check("and Enter then searches instead of downloading", (await job(popup)) === null);
  await waitFor(popup, "!document.getElementById('search').disabled", 40000);

  await type(popup, "zzqx qqzx xqzz vvkq wwqz");
  await key(popup, "Enter");
  await waitFor(popup, "!document.getElementById('search').disabled && /No match/.test(document.getElementById('notice').textContent)", 40000);
  check("says so when nothing matches", true);
  await type(popup, "10.9999/definitely-not-registered");
  await key(popup, "Enter");
  await waitFor(popup, "!document.getElementById('search').disabled && /DOI/.test(document.getElementById('notice').textContent)", 40000);
  check("says so when a DOI is unknown", /doesn't know that DOI/.test(await text(popup, "notice")));

  // ------------------------------------------------ settings page
  await evaluate(options, `(async () => {
    const change = (id, value) => { const field = document.getElementById(id); field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })); };
    change('subfolder', 'Papers');
    change('threshold', '0');
    await new Promise((done) => setTimeout(done, 500));
    return true;
  })()`);
  settings = (await message(options, { type: "settings:get" })).settings;
  check("download folder is saved", settings.subfolder === "Papers");
  check("threshold is clamped to its range", settings.autoThreshold === 0.5, String(settings.autoThreshold));
  check("path preview follows the folder", (await text(options, "preview")) === "Downloads/Papers/2018/smith2018supply.pdf", await text(options, "preview"));

  check("no errors in the extension's consoles", errors.length === 0, errors.join(" | "));
} catch (error) {
  failures.push("aborted");
  console.log(`ABORTED: ${error.message}`);
  if (errors.length) console.log("console:", errors.join(" | "));
} finally {
  await browser.close();
  fake.close();
  rmSync(work, { recursive: true, force: true });
  if (shots) rmSync(join(shots, "reset.png"), { force: true });
}

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join("; ")}` : "\nALL CHECKS PASSED");
process.exit(failures.length ? 1 : 0);
