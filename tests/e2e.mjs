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
import { startFakeSites, PROXY_LINK, OTHER_PROXY_LINK, PAGE_PERMISSIONS, INFORMS, NO_PATTERN } from "./fake-sites.mjs";

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

const work = mkdtempSync(join(tmpdir(), "callslip-e2e-"));
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

const fake = await startFakeSites({ dir: work, port: 8443, ebscoDoi: IN_EBSCO.doi });
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
const listed = (page) =>
  waitFor(page, "!document.getElementById('search').disabled && document.querySelectorAll('#results .item').length > 0", 40000).catch(async (error) => {
    const seen = await evaluate(page, "JSON.stringify({ notice: document.getElementById('notice').textContent, title: document.getElementById('title').value, url: location.search })").catch(() => "?");
    throw new Error(`${error.message} | popup shows ${seen}`);
  });

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
  async function popupOn(url, { loaded = true } = {}) {
    const page = await browser.open(url);
    // A new tab starts out as about:blank, which is "complete" too.
    const arrived = "location.href !== 'about:blank' && " + (loaded ? "document.readyState === 'complete'" : "document.title.length > 0");
    await waitFor(page, arrived, 15000);
    const find = `chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === ${JSON.stringify(url)})?.id ?? null)`;
    await waitFor(popup, `${find}.then((id) => id !== null)`, 8000);
    const tabId = await evaluate(popup, find);
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
  check("a paper EBSCO does not hold is reported as such", stepOf(result, "ebsco").state === "failed" && stepOf(result, "ebsco").detail === "not in EBSCO", stepOf(result, "ebsco").detail);
  check("nothing but PDFs left in Downloads", saved().every(isPdf), JSON.stringify(saved()));
  if (result.status === "failed") {
    check("failure offers the article page", result.fallback?.url === `https://doi.org/${PAYWALLED.doi}`, JSON.stringify(result.fallback));
  }
  check("EBSCO needs no setup: being let through once is remembered", (await message(popup, { type: "settings:get" })).settings.ebscoSeen === true);
  check("and it is switched on in settings", await evaluate(options, "document.getElementById('useEbsco').checked"));

  // ------------------------------------------------ three ways to set the proxy
  // 1. Opening the popup on the library's own sign-in page.
  const onSignIn = await popupOn(`${PROXY_LINK}https://pubsonline.informs.org/doi/${INFORMS[0].doi}`);
  await waitFor(onSignIn, "!document.getElementById('offer').hidden", 8000);
  await evaluate(onSignIn, "(document.querySelector('#offer .link').click(), true)");
  await sleep(500);
  let settings = (await message(options, { type: "settings:get" })).settings;
  check("sign-in page is offered as the proxy and saved in one click", settings.proxy === PROXY_LINK, settings.proxy);
  check("saving one setting leaves the others alone", settings.ebscoSeen === true && settings.useEbsco === true, JSON.stringify(settings));

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
  const proxyButton = () => evaluate(options, "document.getElementById('openProxy').textContent + (document.getElementById('openProxy').classList.contains('danger') ? ' (red)' : '')");
  const waitButton = (label) => waitFor(options, `document.getElementById('openProxy').textContent === '${label}'`, 15000).then(() => true, () => false);
  await waitFor(options, "!document.getElementById('proxyState').hidden", 10000).catch(() => {});
  check("signed out: the button says Sign in, though the sign-in page has no password box", (await proxyButton()) === "Sign in" && (await text(options, "proxyState")) === "Not signed in", `${await proxyButton()} / ${await text(options, "proxyState")}`);

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

  // ------------------------------------------------ signed-in state in settings
  // Signed out for a moment, to go through the button: it opens the library's sign-in tab.
  await evaluate(options, "fetch('https://login.ezproxy.test-uni.edu/logout', { credentials: 'include' }).then(() => true)");
  await evaluate(options, "(window.dispatchEvent(new Event('focus')), true)");
  await waitButton("Sign in");
  await click(options, "openProxy");
  await sleep(1200);
  const signInTab = (await browser.targets()).find((target) => target.type === "page" && target.url === "https://login.ezproxy.test-uni.edu/login");
  check("Sign in opens the library's sign-in page", Boolean(signInTab));
  // The person signs in there and closes the tab; nothing is clicked in settings.
  const signInPage = await browser.attach(signInTab.targetId);
  await evaluate(signInPage, "fetch('/login?signin=1', { credentials: 'include' }).then(() => true)");
  await browser.send("Target.closeTarget", { targetId: signInTab.targetId });
  check("after signing in, the button turns into a red Sign out by itself", (await waitButton("Sign out")) && (await proxyButton()) === "Sign out (red)" && (await text(options, "proxyState")) === "Signed in to your library", `${await proxyButton()} / ${await text(options, "proxyState")}`);
  await snap(options, "settings-signed-in.png", { width: 720, maxHeight: 1000, full: true });
  await snap(options, "reset.png", { width: 720, maxHeight: 1000 });
  fake.hits.length = 0;
  await click(options, "openProxy");
  check("Sign out ends the session and the button goes back to Sign in", (await waitButton("Sign in")) && fake.hits.includes("login.ezproxy.test-uni.edu/logout"), await proxyButton());

  // A proxy that shows no menu page: being handed on to a proxied site is the evidence.
  await message(options, { type: "settings:set", settings: { proxy: OTHER_PROXY_LINK } });
  await waitFor(options, `document.getElementById('proxy').value === '${OTHER_PROXY_LINK}' && !document.getElementById('proxyState').hidden`, 10000);
  check("another library, signed out", (await proxyButton()) === "Sign in");
  const otherSignIn = await browser.open("https://login.ezproxy.other-uni.edu/login?signin=1");
  await waitFor(otherSignIn, "document.title === 'Signed in'", 10000);
  await evaluate(options, "(window.dispatchEvent(new Event('focus')), true)");
  check("signed in there is recognised without a menu page", await waitButton("Sign out"), await proxyButton());

  // Back to the first library, signed in, for the rest of the run.
  await message(options, { type: "settings:set", settings: { proxy: PROXY_LINK } });
  const again = await browser.open("https://login.ezproxy.test-uni.edu/login?signin=1");
  await waitFor(again, "document.title === 'Signed in'", 10000);
  await evaluate(options, "(window.dispatchEvent(new Event('focus')), true)");
  check("switching libraries follows the saved link", await waitButton("Sign out"), await proxyButton());

  // ------------------------------------------------ routes run side by side
  // A publisher that takes six seconds to say no must not hold up the proxy.
  fake.behave["www.tandfonline.com"] = { delay: 6000 };
  let began = Date.now();
  result = await download(popup, () => click(popup, "download"));
  let took = Date.now() - began;
  check("a slow refusal does not hold up a working route", result.status === "done" && result.provider === "Library proxy" && took < 4500, `${took}ms ${routes(result)}`);
  check("the route that was overtaken is stopped, not waited for", stepOf(result, "publisher").state === "skipped" && stepOf(result, "publisher").detail === "not needed", routes(result));
  check("EBSCO is not opened when a plain link delivers at once", stepOf(result, "ebsco").state === "skipped", routes(result));
  delete fake.behave["www.tandfonline.com"];

  // The proxy answers late: EBSCO has started by then, and is called off.
  fake.behave["www-tandfonline-com.ezproxy.test-uni.edu"] = { delay: 2800, pdf: true };
  fake.hits.length = 0;
  result = await download(popup, () => click(popup, "download"));
  check("EBSCO starts when the plain links are slow", fake.hits.some((hit) => hit.startsWith("openurl.ebsco.com/contentitem/doi:")), routes(result));
  check("and is called off when another route gets the paper first", result.status === "done" && result.provider === "Library proxy" && stepOf(result, "ebsco").state === "skipped", routes(result));
  await sleep(500);
  check("its tab is closed", !(await browser.targets()).some((target) => target.type === "page" && target.url.includes("ebsco")));

  // The first route to answer with a PDF drops the connection half-way: the
  // route that was stopped for it is tried again.
  fake.behave["www.tandfonline.com"] = { cut: true };
  fake.behave["www-tandfonline-com.ezproxy.test-uni.edu"] = { delay: 700, pdf: true };
  result = await download(popup, () => click(popup, "download"));
  check("a winner that breaks off is replaced by the route it stopped", result.status === "done" && result.provider === "Library proxy" && stepOf(result, "publisher").state === "failed", routes(result));
  check("and the break is named in plain words", stepOf(result, "publisher").detail === "download cut off", stepOf(result, "publisher").detail);
  delete fake.behave["www.tandfonline.com"];
  delete fake.behave["www-tandfonline-com.ezproxy.test-uni.edu"];
  check("nothing but PDFs left in Downloads", saved().every(isPdf), JSON.stringify(saved()));

  // A library without EBSCO switches it off, and it is then left alone.
  await evaluate(options, "(document.getElementById('useEbsco').click(), true)");
  await sleep(400);
  fake.hits.length = 0;
  result = await download(popup, () => click(popup, "download"));
  check("EBSCO switched off in settings is not opened", stepOf(result, "ebsco").state === "skipped" && stepOf(result, "ebsco").detail === "turned off" && !fake.hits.some((hit) => hit.includes("ebsco")), routes(result));
  await evaluate(options, "(document.getElementById('useEbsco').click(), true)");
  await sleep(400);

  // ------------------------------------------------ opened on an article page
  // INFORMS, auto-download off: the paper is recognised and waits for Enter.
  const informsPage = `https://pubsonline.informs.org/doi/${INFORMS[0].doi}`;
  await evaluate(popup, "chrome.storage.session.remove('job')");
  let onPage = await popupOn(informsPage);
  await listed(onPage);
  check("an INFORMS article page is recognised", (await text(onPage, "count")) === "On this page" && (await evaluate(onPage, "document.querySelector('.item-title').textContent")) === INFORMS[0].title, await text(onPage, "count"));
  check("it is marked as an INFORMS paper", (await evaluate(onPage, "document.querySelector('.tag.pub')?.textContent")) === "INFORMS");
  await sleep(1500);
  check("with auto-download off, recognising a page does not download it", (await job(onPage)) === null);
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 600, deviceScaleFactor: 2, mobile: false }, onPage);
  await snap(onPage, "popup-on-page.png");

  // Auto-download on: clicking the toolbar button on the page is the whole request.
  await message(popup, { type: "settings:set", settings: { autoDefault: true } });
  await evaluate(popup, "chrome.storage.session.remove(['job', 'lastSearch'])");
  fake.hits.length = 0;
  onPage = await popupOn(informsPage);
  await waitFor(onPage, "chrome.storage.session.get('job').then((data) => Boolean(data.job) && data.job.status !== 'running')", 150000, 400).catch(() => {});
  result = (await job(onPage)) || { status: "never started", steps: [], candidate: {} };
  check("with auto-download on, clicking the button on an article page saves the paper", result.status === "done" && result.candidate.doi === INFORMS[0].doi && result.filename === INFORMS[0].file && isPdf(INFORMS[0].file), `${result.status} ${result.provider || ""} ${result.filename || ""} ${routes(result)}`);
  check("an INFORMS paper comes from EBSCO", result.provider === "EBSCO", routes(result));
  const askedInforms = fake.hits.filter((hit) => /informs/.test(hit) && hit.includes("/doi/pdf/"));
  check("and nothing is requested from INFORMS's own site for it", askedInforms.length === 0 && stepOf(result, "publisher")?.state === "skipped" && stepOf(result, "proxy")?.state === "skipped", `${JSON.stringify(askedInforms)} ${routes(result)}`);
  check("the page's link is not asked for twice when it is the publisher's", !stepOf(result, "page"), routes(result));

  // Looking at the same page again must not fetch a second copy...
  onPage = await popupOn(informsPage);
  await listed(onPage);
  await sleep(1500);
  check("reopening on the same page shows it again, without a new lookup or a second download", (await text(onPage, "count")) === "On this page" && (await job(onPage))?.id === result.id, `${await text(onPage, "count")} ${(await job(onPage))?.id} ${result.id}`);
  // ...not even after something else was looked up in between.
  await evaluate(popup, "chrome.storage.session.remove('lastSearch')");
  onPage = await popupOn(informsPage);
  await listed(onPage);
  await sleep(1500);
  check("a paper saved earlier is not fetched again by itself, and the popup says why", (await job(onPage)) === null && /Already saved/.test(await text(onPage, "hint")) && saved().filter((name) => name.startsWith("green2019sharp")).length === 1, `${await text(onPage, "hint")} ${JSON.stringify(saved())}`);
  await message(popup, { type: "settings:set", settings: { autoDefault: false } });

  // The same site read through the library proxy: the page's own PDF link works.
  onPage = await popupOn(`https://pubsonline-informs-org.ezproxy.test-uni.edu/doi/full/${INFORMS[1].doi}`);
  await listed(onPage);
  check("a proxied INFORMS page is recognised", (await text(onPage, "count")) === "On this page");
  result = await download(onPage, () => key(onPage, "Enter"));
  // EBSCO has this one without full text, so the other routes get their turn.
  check("an EBSCO record without a PDF is turned down, with a way to open it", stepOf(result, "ebsco").state === "failed" && stepOf(result, "ebsco").detail === "no PDF in your library's EBSCO" && stepOf(result, "ebsco").action?.label === "Open record", JSON.stringify(stepOf(result, "ebsco")));
  // The proxy route leads to the same file and may get there first.
  check("and it is downloaded, with that page's own PDF link among the routes", result.status === "done" && ["This page", "Library proxy"].includes(result.provider) && stepOf(result, "page")?.state !== "failed" && result.filename === INFORMS[1].file, `${result.status} ${result.provider || ""} ${result.filename || ""} ${routes(result)}`);

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
  fake.hits.length = 0;
  result = await download(onPage, () => key(onPage, "Enter"));
  check("a paper picked from the list gets its author and year looked up", result.status === "done" && result.filename === INFORMS[2].file, `${result.status} ${result.filename || ""} ${routes(result)}`);
  check("a record EBSCO holds without its DOI is found by volume and page (live Crossref)", result.provider === "EBSCO" && fake.hits.some((hit) => hit.startsWith("openurl.ebsco.com/openurl?")), `${result.provider || ""} ${JSON.stringify(fake.hits.filter((hit) => hit.includes("openurl")))}`);

  // A slow connection: the page has its title and tags but will not finish
  // loading for a long time. The popup must not wait for it.
  await evaluate(popup, "chrome.storage.session.remove(['job', 'lastSearch'])");
  began = Date.now();
  onPage = await popupOn(`https://pubsonline.informs.org/doi/${INFORMS[0].doi}?slow=1`, { loaded: false });
  const quick = await waitFor(onPage, "document.querySelectorAll('#results .item').length > 0", 12000).then(() => true, () => false);
  check("a page that is still loading is recognised without waiting for it", quick && (await text(onPage, "count")) === "On this page", `${Date.now() - began}ms ${await text(onPage, "notice")}`);

  // A list that arrives in parts: the popup catches up as the page fills in.
  await evaluate(popup, "chrome.storage.session.remove(['job', 'lastSearch'])");
  onPage = await popupOn("https://pubsonline.informs.org/toc/mnsc/66/1?slow=1", { loaded: false });
  const filled = await waitFor(onPage, "document.getElementById('count').textContent === '3 papers on this page'", 12000).then(() => true, () => false);
  check("a list that is still loading fills in as it arrives", filled, await text(onPage, "count"));

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
  check("goes to the paper's own EBSCO address by DOI", fake.hits[0] === `openurl.ebsco.com/contentitem/doi:${encodeURIComponent(IN_EBSCO.doi)}`, fake.hits[0]);
  check("saves the PDF that EBSCO's viewer loaded", fake.hits.filter((hit) => hit === "content.ebscohost.com/cds/retrieve?content=right1").length >= 1, JSON.stringify(fake.hits));
  check("nothing on EBSCO's pages is clicked or typed into", !fake.hits.some((hit) => hit.includes("/touched")), JSON.stringify(fake.hits.filter((hit) => hit.includes("/touched"))));
  check("closes its EBSCO tab", !(await browser.targets()).some((target) => target.type === "page" && target.url.includes("ebsco")));

  result = await download(popup, () => key(popup, "Enter"));
  check("a second copy does not overwrite the first", result.status === "done" && result.filename !== IN_EBSCO.file && saved().includes(IN_EBSCO.file), result.filename);

  // Not signed in to EBSCO: said so, with the paper's EBSCO page one click away.
  fake.behave.ebsco = { signedOut: true };
  result = await download(popup, () => key(popup, "Enter"));
  delete fake.behave.ebsco;
  const signedOut = stepOf(result, "ebsco");
  check("signed out of EBSCO is recognised", signedOut.state === "failed" && signedOut.detail === "sign-in required", JSON.stringify(signedOut));
  check("with the paper's EBSCO page to sign in on", signedOut.action?.label === "Sign in at EBSCO" && signedOut.action?.url === `https://openurl.ebsco.com/contentitem/doi:${encodeURIComponent(IN_EBSCO.doi)}`, JSON.stringify(signedOut.action));
  check("its tab is closed then too", !(await browser.targets()).some((target) => target.type === "page" && target.url.includes("ebsco")));

  // The connection to EBSCO is dropped: said at once, not waited out.
  fake.behave.ebsco = { dropped: true };
  result = await download(popup, () => key(popup, "Enter"));
  delete fake.behave.ebsco;
  const dropped = stepOf(result, "ebsco");
  const sinceStart = result.finishedAt - result.startedAt;
  check("a dropped connection to EBSCO is reported as such", dropped.state === "failed" && dropped.detail === "couldn't reach EBSCO" && dropped.action?.label === "Open in EBSCO", JSON.stringify(dropped));
  console.log("      ", `job took ${sinceStart}ms in all (EBSCO failed first, then open access was tried)`);

  // The viewer's own copy of the PDF trickles in for eight seconds here. The
  // save must start when the viewer asks for the file, not when it has it.
  fake.behave.ebsco = { slowViewer: true };
  fake.hits.length = 0;
  result = await download(popup, () => key(popup, "Enter"));
  delete fake.behave.ebsco;
  took = result.finishedAt - result.startedAt;
  check("the PDF is saved as soon as EBSCO's viewer asks for it, without waiting for the viewer", result.status === "done" && result.provider === "EBSCO" && took < 5000, `${took}ms ${routes(result)}`);
  await sleep(500);
  check("and closing the tab cuts the viewer's own request short", fake.hits.includes("content.ebscohost.com/abandoned?content=right1"), JSON.stringify(fake.hits.filter((hit) => hit.includes("content."))));

  // ------------------------------------------------ the hourly ceiling
  const savedSoFar = await evaluate(popup, "chrome.storage.local.get('savedAt').then((data) => (data.savedAt || []).length)");
  check("every saved paper is counted", savedSoFar >= 8, String(savedSoFar));
  await evaluate(popup, "chrome.storage.local.set({ savedAt: Array.from({ length: 30 }, (_, i) => Date.now() - 60000 - i * 1000) }).then(() => true)");
  await evaluate(popup, "chrome.storage.session.remove('job')");
  await key(popup, "Enter");
  await waitFor(popup, "/limit/.test(document.getElementById('hint').textContent)", 8000).catch(() => {});
  check("after 30 papers in an hour the next one is refused, with the time it frees up", /^30 papers an hour is the limit.*Next one at \d/.test(await text(popup, "hint")) && (await job(popup)) === null, await text(popup, "hint"));
  await evaluate(popup, `chrome.storage.local.set({ savedAt: Array.from({ length: 30 }, () => Date.now() - 61 * 60000) }).then(() => true)`);
  result = await download(popup, () => key(popup, "Enter"));
  check("and an hour later it is possible again", result.status === "done", `${result.status} ${routes(result)}`);

  // A short title: Crossref's whole-reference search buries the paper itself
  // under longer titles and puts a working-paper version first.
  await search(popup, "Bargaining Chains");
  const firstDoi = await evaluate(popup, "document.querySelector('#results .item .doi').textContent");
  check("a short title finds the published paper first (live)", firstDoi === "10.1287/mnsc.1100.1251", firstDoi);

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
