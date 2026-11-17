import {
  crossrefSearch,
  crossrefByDoi,
  parseDoi,
  scoreCandidate,
  publisherOf,
  publisherPdfUrl,
  downloadPath,
  titleSimilarity,
  openAccess,
  proxied,
  sleep,
} from "./lib.js";

const DEFAULTS = {
  ebscoCustomer: "",
  proxy: "", // the library's proxy sign-in link, e.g. https://login.ezproxy.uni.edu/login?url=
  autoThreshold: 0.9,
  autoMargin: 0.05,
  autoDefault: false,
  subfolder: "",
};

const EBSCO_HOME = "https://research.ebsco.com/";
const EBSCO_LOGIN = /login\.ebsco|logon\.ebsco/i;
const JOB_KEY = "job";
const SEARCH_KEY = "lastSearch";

// A provider failure the popup can explain, optionally with a one-click remedy:
// action = { label, url }.
class StepError extends Error {
  constructor(message, action = null) {
    super(message);
    this.action = action;
  }
}

// ---------------------------------------------------------------- settings

async function getSettings() {
  const { settings: stored = {} } = await chrome.storage.local.get("settings");
  const { ezproxy, ...rest } = stored; // 0.2 kept the proxy link under this name
  return { ...DEFAULTS, ...(ezproxy ? { proxy: ezproxy } : {}), ...rest };
}

// Writes are read-modify-write, so they run one at a time: two changes landing
// together (the settings page and the popup, or a detected EBSCO code) would
// otherwise each start from the old value and one would be lost.
let settingsWrites = Promise.resolve();

function setSettings(patch) {
  const write = settingsWrites.then(async () => {
    const next = { ...(await getSettings()), ...patch };
    await chrome.storage.local.set({ settings: next });
    return next;
  });
  settingsWrites = write.catch(() => {});
  return write;
}

// ------------------------------------------------------------------ search

async function search(query) {
  const doi = parseDoi(query.title);
  if (doi) {
    const hit = await crossrefByDoi(doi);
    return hit ? [{ ...hit, score: 1, titleScore: 1, exact: true }] : [];
  }
  const items = await crossrefSearch(query);
  return items
    .map((candidate) => ({ ...candidate, ...scoreCandidate(query, candidate) }))
    .filter((candidate) => candidate.titleScore >= 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

// --------------------------------------------------------------- downloads

const INTERRUPT_REASONS = {
  SERVER_FORBIDDEN: "access denied (403)",
  SERVER_UNAUTHORIZED: "sign-in required",
  SERVER_BAD_CONTENT: "not found (404)",
  SERVER_FAILED: "server error",
  SERVER_UNREACHABLE: "server unreachable",
  NETWORK_FAILED: "network error",
  NETWORK_TIMEOUT: "network timeout",
  NETWORK_DISCONNECTED: "network disconnected",
  USER_CANCELED: "cancelled",
  FILE_ACCESS_DENIED: "can't write to the Downloads folder",
  FILE_NO_SPACE: "disk is full",
};

function looksLikeSignIn(url) {
  try {
    const parsed = new URL(url);
    return /log[io]n|sign-?in|shibboleth|authenticat|(^|[./-])(sso|idp|cas)([./-]|$)/i.test(
      parsed.hostname + parsed.pathname,
    );
  } catch {
    return false;
  }
}

// Why a finished download is not the paper, or null when it looks like a PDF.
// The file name is no evidence: we ask for "<citekey>.pdf" ourselves, so a
// sign-in page saved under that name still ends in .pdf.
function rejectReason(item) {
  const mime = (item.mime || "").toLowerCase();
  if (mime.includes("pdf")) return item.fileSize > 0 ? null : "empty file";
  if (/html|^text\/|json|xml/.test(mime)) {
    return looksLikeSignIn(item.finalUrl || item.url) ? "sign-in required" : "got a web page, not a PDF";
  }
  return item.fileSize >= 20000 ? null : "not a PDF";
}

async function discardDownload(id) {
  try {
    await chrome.downloads.removeFile(id);
  } catch {}
  try {
    await chrome.downloads.erase({ id });
  } catch {}
}

// Waits for a download to end and returns it only if it is a PDF. Anything else
// is deleted so no junk file is left behind.
async function finishDownload(id, stallLimit = 45000) {
  let lastBytes = -1;
  let lastProgress = Date.now();
  while (Date.now() - lastProgress < stallLimit) {
    const [item] = await chrome.downloads.search({ id });
    if (!item) throw new StepError("download disappeared");
    if (item.state === "complete") {
      const reason = rejectReason(item);
      if (!reason) return item;
      await discardDownload(id);
      throw new StepError(reason);
    }
    if (item.state === "interrupted") {
      await discardDownload(id);
      throw new StepError(INTERRUPT_REASONS[item.error] || `interrupted (${item.error || "unknown"})`);
    }
    if (item.bytesReceived !== lastBytes) {
      lastBytes = item.bytesReceived;
      lastProgress = Date.now();
    }
    await sleep(400);
  }
  try {
    await chrome.downloads.cancel(id);
  } catch {}
  await discardDownload(id);
  throw new StepError("timed out");
}

// "uniquify", not "overwrite": a failed attempt must never replace (and then
// take down with it) a good copy saved earlier under the same cite key.
async function saveFrom(url, candidate, settings) {
  let id;
  try {
    id = await chrome.downloads.download({
      url,
      filename: downloadPath(candidate, settings.subfolder),
      conflictAction: "uniquify",
      saveAs: false,
    });
  } catch (error) {
    throw new StepError(error?.message || "download could not start");
  }
  const item = await finishDownload(id);
  return { downloadId: id, filename: item.filename };
}

async function viaPublisher(candidate, settings) {
  return saveFrom(publisherPdfUrl(candidate.doi), candidate, settings);
}

async function viaProxy(candidate, settings) {
  const url = proxied(settings.proxy, publisherPdfUrl(candidate.doi));
  try {
    return await saveFrom(url, candidate, settings);
  } catch (error) {
    // Whatever went wrong, the same link opened in a tab shows it: the sign-in
    // form, or the publisher's page as the library sees it.
    const label = error.message === "sign-in required" ? "Sign in" : "Open";
    throw new StepError(error.message, { label, url });
  }
}

async function viaOpenAccess(candidate, settings) {
  const { pdfs, page } = await openAccess(candidate.doi);
  const openPage = page ? { label: "Open page", url: page } : null;
  if (!pdfs.length) {
    throw new StepError(page ? "free to read, but no direct PDF link" : "no free copy found", openPage);
  }
  let lastError = null;
  for (const url of pdfs.slice(0, 3)) {
    try {
      return await saveFrom(url, candidate, settings);
    } catch (error) {
      lastError = error;
    }
  }
  throw new StepError(lastError.message, openPage);
}

// ------------------------------------------------------------------- EBSCO

function ebscoSignIn() {
  return new StepError("sign-in required", { label: "Open EBSCO", url: EBSCO_HOME });
}

async function detectEbscoCode() {
  const tabs = await chrome.tabs.query({ url: "https://research.ebsco.com/*" });
  for (const tab of tabs) {
    const match = (tab.url || "").match(/\/c\/([^/]+)\//);
    if (match) return match[1];
  }
  const probe = await chrome.tabs.create({ url: EBSCO_HOME, active: false });
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(500);
      const tab = await chrome.tabs.get(probe.id);
      const match = (tab.url || "").match(/\/c\/([^/]+)\//);
      if (match) return match[1];
      if (EBSCO_LOGIN.test(tab.url || "")) return null;
    }
    return null;
  } finally {
    try {
      await chrome.tabs.remove(probe.id);
    } catch {}
  }
}

async function waitForTabLoad(tabId, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return tab;
    await sleep(400);
  }
  throw new StepError("page did not finish loading");
}

// tabs.update() returns before the navigation starts, while the tab still
// reports the old page as "complete". Wait for the new load to begin first, or
// the caller would go on to read the page it just left.
async function navigate(tabId, url, timeout = 25000) {
  const before = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { url });
  const start = Date.now();
  let started = false;
  while (Date.now() - start < timeout) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "loading" || tab.url !== before.url) started = true;
    if (tab.status === "complete" && (started || Date.now() - start > 3000)) return tab;
    await sleep(200);
  }
  throw new StepError("page did not finish loading");
}

async function inTab(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result?.result;
}

async function waitInTab(tabId, func, args = [], timeout = 15000, interval = 400) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    let value = null;
    try {
      value = await inTab(tabId, func, args);
    } catch {}
    if (value) return value;
    await sleep(interval);
  }
  return null;
}

// --- functions below run inside the EBSCO page ---

function pageHasSelector(selector) {
  return Boolean(document.querySelector(selector));
}

function pageFillSearch(query) {
  const element = document.querySelector("#search-autocomplete-1-input");
  if (!element) return false;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  ).set;
  setter.call(element, query);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  const button = [...document.querySelectorAll("button")].find(
    (item) => item.offsetWidth && (item.innerText || "").trim() === "Search",
  );
  if (!button) return false;
  button.click();
  return true;
}

function pageResultLinks() {
  return [...document.querySelectorAll("a")]
    .filter((anchor) => /\/search\/details\//.test(anchor.href))
    .map((anchor) => ({ title: (anchor.innerText || "").trim(), href: anchor.href }));
}

function pageHasFullText() {
  return /PDF Full Text/i.test(document.body?.innerText || "");
}

// Clicks a visible button by its exact label; `last` picks the one in the
// dialog when the page behind it has a button with the same label.
function pageClickButton(label, last) {
  const buttons = [...document.querySelectorAll("button")].filter(
    (item) => item.offsetWidth && (item.innerText || "").trim() === label,
  );
  if (!buttons.length) return false;
  buttons[last ? buttons.length - 1 : 0].click();
  return true;
}

function pageChoosePdf() {
  const radio = document.querySelector('input[type="radio"][value="pdf"]');
  if (!radio) return false;
  if (!radio.checked) radio.click();
  return true;
}

// --- end of in-page functions ---

async function ebscoSearch(tabId, query, timeout = 30000) {
  if (!(await inTab(tabId, pageFillSearch, [query]))) {
    throw new StepError("search form did not respond");
  }
  const start = Date.now();
  while (Date.now() - start < timeout) {
    let links = [];
    try {
      links = (await inTab(tabId, pageResultLinks)) || [];
    } catch {}
    if (links.length) return links;
    const tab = await chrome.tabs.get(tabId);
    if (EBSCO_LOGIN.test(tab.url || "")) throw ebscoSignIn();
    await sleep(600);
  }
  return [];
}

// Claims the next download started in this browser and gives it our file name.
// It has to be armed before the click that starts the download: the download
// can be created before a listener added afterwards exists. Only the claimed
// download is renamed, so anything else the user downloads meanwhile is left
// alone.
function claimNextDownload(filename, timeout = 60000) {
  const armedAt = Date.now();
  let claimed = null;
  let settle = null;
  const started = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  started.catch(() => {});
  const claim = (item) => {
    if (claimed !== null) return;
    const startTime = item.startTime ? Date.parse(item.startTime) : Date.now();
    if (startTime < armedAt - 1000) return;
    claimed = item.id;
    settle.resolve(item.id);
  };
  const onCreated = (item) => claim(item);
  const onFilename = (item, suggest) => {
    claim(item);
    if (item.id === claimed) suggest({ filename, conflictAction: "uniquify" });
  };
  chrome.downloads.onCreated.addListener(onCreated);
  chrome.downloads.onDeterminingFilename.addListener(onFilename);
  const timer = setTimeout(() => settle.reject(new StepError("download did not start")), timeout);
  return {
    started,
    release() {
      clearTimeout(timer);
      chrome.downloads.onCreated.removeListener(onCreated);
      chrome.downloads.onDeterminingFilename.removeListener(onFilename);
    },
  };
}

async function viaEbsco(candidate, settings, note) {
  let code = settings.ebscoCustomer;
  if (!code) {
    note("finding your library");
    code = await detectEbscoCode();
    if (!code) throw ebscoSignIn();
    await setSettings({ ebscoCustomer: code });
  }
  const searchUrl = `https://research.ebsco.com/c/${code}/search/advanced`;
  note("opening search");
  const tab = await chrome.tabs.create({ url: searchUrl, active: false });
  let claim = null;
  try {
    const loaded = await waitForTabLoad(tab.id);
    if (EBSCO_LOGIN.test(loaded.url || "")) throw ebscoSignIn();
    if (!(await waitInTab(tab.id, pageHasSelector, ["#search-autocomplete-1-input"]))) {
      const current = await chrome.tabs.get(tab.id);
      if (!(current.url || "").startsWith("https://research.ebsco.com/c/")) throw ebscoSignIn();
      throw new StepError("search page did not load");
    }

    note("searching");
    let links = candidate.doi ? await ebscoSearch(tab.id, candidate.doi, 15000) : [];
    if (!links.length && candidate.title) {
      await navigate(tab.id, searchUrl);
      if (!(await waitInTab(tab.id, pageHasSelector, ["#search-autocomplete-1-input"]))) {
        throw new StepError("search page did not load");
      }
      links = await ebscoSearch(tab.id, candidate.title);
    }
    if (!links.length) throw new StepError("not in EBSCO");
    const best = links
      .map((link) => ({ ...link, similarity: titleSimilarity(candidate.title, link.title) }))
      .sort((a, b) => b.similarity - a.similarity)[0];
    if (best.similarity < 0.5) throw new StepError("no matching record");

    note("opening record");
    await navigate(tab.id, best.href);
    if (!(await waitInTab(tab.id, pageHasFullText, [], 10000, 500))) {
      throw new StepError("no PDF full text for this record");
    }

    note("downloading");
    claim = claimNextDownload(downloadPath(candidate, settings.subfolder));
    if (!(await inTab(tab.id, pageClickButton, ["Download", false]))) {
      throw new StepError("download button not found");
    }
    if (!(await waitInTab(tab.id, pageChoosePdf, [], 4000, 300))) {
      throw new StepError("no PDF option in the download dialog");
    }
    if (!(await inTab(tab.id, pageClickButton, ["Download", true]))) {
      throw new StepError("download button not found");
    }
    const id = await claim.started;
    const item = await finishDownload(id);
    return { downloadId: id, filename: item.filename };
  } finally {
    if (claim) claim.release();
    try {
      await chrome.tabs.remove(tab.id);
    } catch {}
  }
}

// -------------------------------------------------------------------- jobs
//
// One download at a time. Its progress lives in chrome.storage.session so the
// popup can be closed and reopened mid-download and still show where it is.

let running = false;

async function readJob() {
  return (await chrome.storage.session.get(JOB_KEY))[JOB_KEY] || null;
}

function planSteps(candidate, settings) {
  const publisher = publisherOf(candidate.doi);
  const skip = (detail) => ({ state: "skipped", detail });
  return [
    {
      key: "publisher",
      label: publisher ? publisher.name : "Publisher",
      ...(publisher ? { state: "pending" } : skip("no direct link for this publisher")),
    },
    {
      key: "proxy",
      label: "Library proxy",
      ...(!publisher
        ? skip("needs a direct publisher link")
        : settings.proxy
          ? { state: "pending" }
          : skip("not set up")),
    },
    { key: "ebsco", label: "EBSCO", state: "pending" },
    { key: "oa", label: "Open access", state: "pending" },
  ].map((step) => ({ detail: "", action: null, ...step }));
}

const RUNNERS = {
  publisher: viaPublisher,
  proxy: viaProxy,
  ebsco: viaEbsco,
  oa: viaOpenAccess,
};

async function runJob(candidate) {
  const settings = await getSettings();
  const job = {
    id: `${Date.now()}`,
    status: "running",
    startedAt: Date.now(),
    candidate: { doi: candidate.doi, title: candidate.title },
    steps: planSteps(candidate, settings),
  };
  const publish = () => chrome.storage.session.set({ [JOB_KEY]: job });
  await publish();
  for (const step of job.steps) {
    if (step.state === "skipped") continue;
    step.state = "running";
    await publish();
    try {
      const result = await RUNNERS[step.key](candidate, settings, (text) => {
        step.detail = text;
        publish();
      });
      step.state = "done";
      step.detail = "";
      Object.assign(job, {
        status: "done",
        provider: step.label,
        downloadId: result.downloadId,
        filename: (result.filename || "").split(/[\\/]/).pop(),
        finishedAt: Date.now(),
      });
      await publish();
      return job;
    } catch (error) {
      step.state = "failed";
      step.detail = error?.message || String(error);
      step.action = error?.action || null;
      await publish();
    }
  }
  job.status = "failed";
  job.finishedAt = Date.now();
  // Every route failed: leave the reader one click from the article itself,
  // through the library when there is one, so they can still get it by hand.
  const article = `https://doi.org/${candidate.doi}`;
  job.fallback = settings.proxy
    ? { label: "Open through library", url: proxied(settings.proxy, article) }
    : { label: "Open article page", url: article };
  await publish();
  return job;
}

async function startDownload(candidate) {
  if (!candidate?.doi) return { error: "Nothing selected." };
  if (running) return { error: "A download is already in progress." };
  running = true;
  try {
    return { job: await runJob(candidate) };
  } finally {
    running = false;
  }
}

// A job still marked "running" when this worker starts belongs to a worker that
// was shut down mid-download; nothing is going to finish it.
async function sweepStaleJob() {
  const job = await readJob();
  if (!job || job.status !== "running" || running) return;
  for (const step of job.steps) {
    if (step.state === "running") {
      step.state = "failed";
      step.detail = "interrupted";
    }
  }
  job.status = "failed";
  job.finishedAt = Date.now();
  await chrome.storage.session.set({ [JOB_KEY]: job });
}

sweepStaleJob();

// ---------------------------------------------------------------- messages

const HANDLERS = {
  async search(message) {
    const query = message.query || {};
    const candidates = await search(query);
    await chrome.storage.session.set({ [SEARCH_KEY]: { query, candidates } });
    return { candidates };
  },
  download: (message) => startDownload(message.candidate),
  "settings:get": async () => ({ settings: await getSettings() }),
  "settings:set": async (message) => ({ settings: await setSettings(message.settings || {}) }),
  "settings:detect": async () => ({ code: await detectEbscoCode() }),
};

// First install: land on the settings page, where library access is set up.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = HANDLERS[message?.type];
  if (!handler) {
    sendResponse({ error: "unknown message" });
    return false;
  }
  handler(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error?.message || String(error) }));
  return true;
});
