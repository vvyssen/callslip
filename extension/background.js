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

// Thrown inside a route that was stopped because another one got there first.
class Stopped extends Error {}

// ------------------------------------------------------------------- races
//
// The routes to a paper run side by side. The first one whose answer is a PDF
// claims the download, and that stops the others on the spot: their downloads
// are cancelled before any of the file has been saved, and EBSCO's tab is
// closed. So a slow or refusing route no longer holds up a working one.
function createRace() {
  let winner = null;
  const stops = new Map(); // route key -> how to stop it
  return {
    get winner() {
      return winner;
    },
    // True for the first route to call it; false for every route after that.
    claim(key) {
      if (winner !== null) return winner === key;
      winner = key;
      for (const [other, stop] of stops) {
        if (other !== key) stop();
      }
      return true;
    },
    onStop(key, stop) {
      stops.set(key, stop);
      if (winner !== null && winner !== key) stop();
    },
  };
}

// Lets a route drop whatever it is waiting for the moment it is stopped:
// `until(x)` is `x`, except that it throws Stopped as soon as stop() is called.
function stopper() {
  let trip = null;
  let stopped = false;
  const halted = new Promise((resolve, reject) => {
    trip = reject;
  });
  halted.catch(() => {});
  return {
    get stopped() {
      return stopped;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      trip(new Stopped());
    },
    until: (promise) => Promise.race([promise, halted]),
  };
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
  SERVER_CONTENT_LENGTH_MISMATCH: "download cut off",
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

// What the start of a response says about it: null while nothing has arrived,
// { pdf: true } when it may be the paper, { reason } when it cannot be. A web
// page is recognised from its first bytes, so a paywall or a sign-in page is
// turned down at once instead of being downloaded first.
function firstLook(item) {
  const mime = (item.mime || "").toLowerCase();
  if (mime.includes("pdf")) return { pdf: true };
  if (/html|^text\/|json|xml/.test(mime)) {
    const signIn = looksLikeSignIn(item.finalUrl || item.url);
    return { reason: signIn ? "sign-in required" : "got a web page, not a PDF" };
  }
  if (!mime && !item.filename && !item.bytesReceived && item.state === "in_progress") return null;
  return { pdf: true }; // a type that says nothing: let it finish, then judge it
}

// Stops a download wherever it is and leaves nothing of it behind.
async function discardDownload(id) {
  try {
    await chrome.downloads.cancel(id);
  } catch {}
  try {
    await chrome.downloads.removeFile(id);
  } catch {}
  try {
    await chrome.downloads.erase({ id });
  } catch {}
}

// Waits for a download to end and returns it only if it is a PDF. Anything else
// is deleted so no junk file is left behind. In a race, the download has to
// claim the win as soon as it turns out to be a PDF, and gives way if another
// route already has.
async function finishDownload(id, { race = null, key = null, stopped = () => false, stallLimit = 45000 } = {}) {
  let lastBytes = -1;
  let lastProgress = Date.now();
  let looked = false;
  while (Date.now() - lastProgress < stallLimit) {
    if (stopped()) {
      await discardDownload(id);
      throw new Stopped();
    }
    const [item] = await chrome.downloads.search({ id });
    if (!item) throw new StepError("download disappeared");
    if (item.state === "interrupted") {
      await discardDownload(id);
      throw new StepError(INTERRUPT_REASONS[item.error] || `interrupted (${item.error || "unknown"})`);
    }
    if (!looked) {
      const look = firstLook(item);
      if (look?.reason) {
        await discardDownload(id);
        throw new StepError(look.reason);
      }
      if (look?.pdf) {
        looked = true;
        if (race && !race.claim(key)) {
          await discardDownload(id);
          throw new Stopped();
        }
      }
    }
    if (item.state === "complete") {
      const reason = rejectReason(item);
      if (!reason) return item;
      await discardDownload(id);
      throw new StepError(reason);
    }
    if (item.bytesReceived !== lastBytes) {
      lastBytes = item.bytesReceived;
      lastProgress = Date.now();
    }
    await sleep(looked ? 400 : 150);
  }
  await discardDownload(id);
  throw new StepError("timed out");
}

// How long a server gets to start answering. Generous, because the other
// routes are not waiting for this one.
const ANSWER_WAIT = 45000;
const LATE = Symbol("late");

// "uniquify", not "overwrite": a failed attempt must never replace (and then
// take down with it) a good copy saved earlier under the same cite key.
async function saveFrom(url, candidate, settings, race = null, key = null) {
  const halt = stopper();
  race?.onStop(key, halt.stop);
  // downloads.download() answers once the server has, which can take a while.
  const starting = chrome.downloads.download({
    url,
    filename: downloadPath(candidate, settings.subfolder),
    conflictAction: "uniquify",
    saveAs: false,
  });
  // Whenever a download we gave up on does start, it is no longer wanted.
  const disown = () => starting.then(discardDownload, () => {});
  let id;
  try {
    id = await halt.until(Promise.race([starting, sleep(ANSWER_WAIT).then(() => LATE)]));
  } catch (error) {
    if (error instanceof Stopped) {
      disown();
      throw error;
    }
    throw new StepError(error?.message || "download could not start");
  }
  if (id === LATE) {
    disown();
    throw new StepError("no answer from the server");
  }
  const item = await finishDownload(id, { race, key, stopped: () => halt.stopped });
  return { downloadId: id, filename: item.filename };
}

async function viaPage(candidate, settings, note, race) {
  return saveFrom(candidate.pagePdf, candidate, settings, race, "page");
}

async function viaPublisher(candidate, settings, note, race) {
  return saveFrom(publisherPdfUrl(candidate.doi), candidate, settings, race, "publisher");
}

async function viaProxy(candidate, settings, note, race) {
  const url = proxied(settings.proxy, publisherPdfUrl(candidate.doi));
  try {
    return await saveFrom(url, candidate, settings, race, "proxy");
  } catch (error) {
    if (error instanceof Stopped) throw error;
    // Whatever went wrong, the same link opened in a tab shows it: the sign-in
    // form, or the publisher's page as the library sees it.
    const label = error.message === "sign-in required" ? "Sign in" : "Open";
    throw new StepError(error.message, { label, url });
  }
}

// `lookup` is the OpenAlex answer, asked for when the job started so that it is
// already there by the time the library routes have all failed.
async function viaOpenAccess(candidate, settings, note, race, lookup) {
  const { pdfs, page, unreachable } = await (lookup || openAccess(candidate.doi));
  const openPage = page ? { label: "Open page", url: page } : null;
  if (unreachable) throw new StepError("couldn't reach OpenAlex");
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

// True once the page says the search came back empty, so an unknown DOI does
// not have to be waited out.
function pageNoResults() {
  const text = document.body?.innerText || "";
  return /\b0 (total )?results\b|\bno results\b|couldn.t find any results|did not match any/i.test(text);
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
    let empty = false;
    try {
      empty = /\/search\/results/.test(tab.url || "") && (await inTab(tabId, pageNoResults));
    } catch {}
    if (empty) return [];
    await sleep(500);
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
    // Downloads this extension starts itself belong to the other routes.
    if (item.byExtensionId === chrome.runtime.id) return;
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

async function viaEbsco(candidate, settings, note, race) {
  const halt = stopper();
  const { until } = halt;
  let tabId = null;
  race?.onStop("ebsco", () => {
    halt.stop();
    if (tabId !== null) chrome.tabs.remove(tabId).catch(() => {});
  });
  let claim = null;
  try {
    let code = settings.ebscoCustomer;
    if (!code) {
      note("finding your library");
      code = await until(detectEbscoCode());
      if (!code) throw ebscoSignIn();
      await setSettings({ ebscoCustomer: code });
    }
    const searchUrl = `https://research.ebsco.com/c/${code}/search/advanced`;
    note("opening search");
    // Not wrapped in until(): the tab has to be known here to be closed again.
    const tab = await chrome.tabs.create({ url: searchUrl, active: false });
    tabId = tab.id;
    const loaded = await until(waitForTabLoad(tab.id));
    if (EBSCO_LOGIN.test(loaded.url || "")) throw ebscoSignIn();
    if (!(await until(waitInTab(tab.id, pageHasSelector, ["#search-autocomplete-1-input"])))) {
      const current = await until(chrome.tabs.get(tab.id));
      if (!(current.url || "").startsWith("https://research.ebsco.com/c/")) throw ebscoSignIn();
      throw new StepError("search page did not load");
    }

    note("searching");
    let links = candidate.doi ? await until(ebscoSearch(tab.id, candidate.doi, 15000)) : [];
    if (!links.length && candidate.title) {
      await until(navigate(tab.id, searchUrl));
      if (!(await until(waitInTab(tab.id, pageHasSelector, ["#search-autocomplete-1-input"])))) {
        throw new StepError("search page did not load");
      }
      links = await until(ebscoSearch(tab.id, candidate.title));
    }
    if (!links.length) throw new StepError("not in EBSCO");
    const best = links
      .map((link) => ({ ...link, similarity: titleSimilarity(candidate.title, link.title) }))
      .sort((a, b) => b.similarity - a.similarity)[0];
    if (best.similarity < 0.5) throw new StepError("no matching record");

    note("opening record");
    await until(navigate(tab.id, best.href));
    if (!(await until(waitInTab(tab.id, pageHasFullText, [], 10000, 500)))) {
      throw new StepError("no PDF full text for this record");
    }

    note("downloading");
    if (halt.stopped) throw new Stopped();
    claim = claimNextDownload(downloadPath(candidate, settings.subfolder));
    if (!(await until(inTab(tab.id, pageClickButton, ["Download", false])))) {
      throw new StepError("download button not found");
    }
    if (!(await until(waitInTab(tab.id, pageChoosePdf, [], 4000, 300)))) {
      throw new StepError("no PDF option in the download dialog");
    }
    if (!(await until(inTab(tab.id, pageClickButton, ["Download", true])))) {
      throw new StepError("download button not found");
    }
    const id = await until(claim.started);
    const item = await finishDownload(id, { race, key: "ebsco", stopped: () => halt.stopped });
    return { downloadId: id, filename: item.filename };
  } catch (error) {
    // Its tab was closed under it: whatever that broke is not worth reporting.
    if (halt.stopped) throw new Stopped();
    throw error;
  } finally {
    if (claim) claim.release();
    if (tabId !== null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {}
    }
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

function sameAddress(a, b) {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

function planSteps(candidate, settings) {
  const publisher = publisherOf(candidate.doi);
  const skip = (detail) => ({ state: "skipped", detail });
  // On the publisher's own site the page's PDF link is the publisher route:
  // asking for the same address twice would only cost time.
  const fromPage =
    /^https?:\/\//i.test(candidate.pagePdf || "") &&
    !(publisher && sameAddress(candidate.pagePdf, publisherPdfUrl(candidate.doi)))
      ? [{ key: "page", label: "This page", state: "pending" }]
      : [];
  return [
    ...fromPage,
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
  page: viaPage,
  publisher: viaPublisher,
  proxy: viaProxy,
  ebsco: viaEbsco,
  oa: viaOpenAccess,
};

// EBSCO takes a browser tab and a search of its own, so the plain links get
// this much of a head start: when one of them answers with the PDF straight
// away, EBSCO is never opened. If they have all failed sooner, it starts sooner.
const EBSCO_HEAD_START = 2000;

// Runs the given routes side by side. Returns the one that delivered, if any,
// and the ones that were stopped for a winner: if that winner then fails
// (a download cut off half-way), they are the ones still worth trying.
async function raceRoutes(steps, candidate, settings, publish) {
  const race = createRace();
  const stopped = [];
  let won = null;
  const standDown = (step) => {
    step.state = "skipped";
    step.detail = "not needed";
    step.action = null;
    stopped.push(step);
  };
  const run = async (step) => {
    step.state = "running";
    step.detail = "";
    step.action = null;
    publish();
    try {
      const result = await RUNNERS[step.key](
        candidate,
        settings,
        (text) => {
          if (step.state !== "running") return;
          step.detail = text;
          publish();
        },
        race,
      );
      step.state = "done";
      step.detail = "";
      won = { step, result };
    } catch (error) {
      if (error instanceof Stopped) {
        standDown(step);
      } else {
        step.state = "failed";
        step.detail = error?.message || String(error);
        step.action = error?.action || null;
      }
    }
    publish();
  };

  const ebsco = steps.find((step) => step.key === "ebsco");
  const links = steps.filter((step) => step !== ebsco).map(run);
  const tasks = [...links];
  if (ebsco) {
    tasks.push(
      (async () => {
        if (links.length) await Promise.race([Promise.all(links), sleep(EBSCO_HEAD_START)]);
        if (race.winner !== null) {
          standDown(ebsco);
          publish();
          return;
        }
        await run(ebsco);
      })(),
    );
  }
  await Promise.all(tasks);
  return { won, stopped };
}

async function runJob(candidate) {
  const settings = await getSettings();
  const job = {
    id: `${Date.now()}`,
    status: "running",
    startedAt: Date.now(),
    candidate: { doi: candidate.doi, title: candidate.title },
    steps: planSteps(candidate, settings),
  };
  // Progress is written one state at a time, in order, however many routes
  // report at once.
  let writes = Promise.resolve();
  const publish = () => {
    const snapshot = structuredClone(job);
    writes = writes.then(() => chrome.storage.session.set({ [JOB_KEY]: snapshot })).catch(() => {});
    return writes;
  };
  await publish();

  // The open-access copy is the last resort: it is often an earlier version of
  // the paper, so it never competes with the routes to the published one. Only
  // the lookup is done ahead of time.
  const free = job.steps.find((step) => step.key === "oa");
  const lookup = openAccess(candidate.doi).catch(() => ({ pdfs: [], page: null, unreachable: true }));

  let won = null;
  let waiting = job.steps.filter((step) => step.state === "pending" && step !== free);
  while (waiting.length && !won) {
    const round = await raceRoutes(waiting, candidate, settings, publish);
    won = round.won;
    waiting = round.stopped;
  }
  if (!won && free) {
    free.state = "running";
    publish();
    try {
      const result = await viaOpenAccess(candidate, settings, null, null, lookup);
      free.state = "done";
      won = { step: free, result };
    } catch (error) {
      free.state = "failed";
      free.detail = error?.message || String(error);
      free.action = error?.action || null;
    }
  }

  job.finishedAt = Date.now();
  if (won) {
    for (const step of job.steps) {
      if (step.state === "pending") Object.assign(step, { state: "skipped", detail: "not needed" });
    }
    Object.assign(job, {
      status: "done",
      provider: won.step.label,
      downloadId: won.result.downloadId,
      filename: (won.result.filename || "").split(/[\\/]/).pop(),
    });
  } else {
    job.status = "failed";
    // Every route failed: leave the reader one click from the article itself,
    // through the library when there is one, so they can still get it by hand.
    const article = `https://doi.org/${candidate.doi}`;
    job.fallback = settings.proxy
      ? { label: "Open through library", url: proxied(settings.proxy, article) }
      : { label: "Open article page", url: article };
  }
  await publish();
  return job;
}

async function startDownload(candidate) {
  if (!candidate?.doi) return { error: "Nothing selected." };
  if (running) return { error: "A download is already in progress." };
  running = true;
  // Chrome shuts an extension's background worker down after 30 seconds without
  // extension activity, and waiting on a slow server is not activity. A job cut
  // off that way would stay "downloading" for good.
  const awake = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  try {
    // A paper picked from a list on a web page comes with a title only; the
    // file name needs its author and year.
    if (!candidate.authors?.length || !candidate.year) {
      const record = await crossrefByDoi(candidate.doi).catch(() => null);
      if (record) candidate = { ...candidate, ...record };
    }
    return { job: await runJob(candidate) };
  } finally {
    clearInterval(awake);
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
