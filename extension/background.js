import {
  crossrefSearch,
  crossrefByDoi,
  parseDoi,
  scoreCandidate,
  publisherOf,
  publisherPdfUrl,
  downloadPath,
  openAccess,
  proxied,
  ebscoByDoi,
  ebscoByIssue,
  sleep,
} from "./lib.js";

const DEFAULTS = {
  proxy: "", // the library's proxy sign-in link, e.g. https://login.ezproxy.uni.edu/login?url=
  useEbsco: true, // off for a library without EBSCO databases
  ebscoSeen: false, // set once EBSCO has let this browser through to an article
  autoThreshold: 0.9,
  autoMargin: 0.05,
  autoDefault: false,
  subfolder: "",
};

const JOBS_KEY = "jobs";
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
  // 0.2 kept the proxy link under another name; up to 0.6 EBSCO needed the
  // library's customer code, which its DOI addresses do without.
  const { ezproxy, ebscoCustomer, ...rest } = stored;
  return { ...DEFAULTS, ...(ezproxy ? { proxy: ezproxy } : {}), ...rest };
}

// Writes are read-modify-write, so they run one at a time: two changes landing
// together (the settings page and the popup) would otherwise each start from
// the old value and one would be lost.
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
//
// EBSCO keeps a public address for every article it holds (see ebscoByDoi in
// lib.js). Opened in a tab where you are signed in to EBSCO, it forwards to the
// article: to EBSCO's PDF viewer when your library has the full text, to the
// record's details when it has not. Nothing on those pages is typed into or
// clicked. The viewer asks for the PDF itself; the browser reports which
// address it asked for, that address is saved the way any other link is, and
// the tab is closed, so the PDF is fetched once.

const EBSCO_DOOR = /^https:\/\/openurl\.ebsco\.com\//;
const EBSCO_VIEWER = /^https:\/\/research\.ebsco\.com\/c\/[^/]+\/viewer\/pdf\//;
const EBSCO_APP = /^https:\/\/research\.ebsco\.com\/c\/[^/]+\//;
const EBSCO_LOGIN = /^https:\/\/(login|logon)\.ebsco\./;
const EBSCO_PDF = "https://content.ebscohost.com/cds/retrieve*";

// tabs.update() returns before the navigation starts, while the tab still
// reports the old page as "complete". Wait for the new load to begin first, or
// the caller would go on to read the page it just left.
async function navigate(tabId, url, timeout = 25000) {
  const before = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { url });
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "loading" || tab.url !== before.url) return;
    await sleep(100);
  }
  throw new StepError("page did not start loading");
}

async function inTab(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result?.result;
}

// --- functions below run inside EBSCO's pages; they only read ---

// On EBSCO's door page: "signin" when the visitor is not signed in to EBSCO,
// "missing" when EBSCO has no such article, null while the page is still on its
// way to the article.
function pageEbscoDoor() {
  if (location.pathname.startsWith("/not_found")) return "missing";
  let signedIn = null;
  try {
    signedIn = JSON.parse(document.getElementById("__NEXT_DATA__").textContent).props.isAuthenticated;
  } catch {}
  const text = document.body?.innerText || "";
  if (signedIn === false || /sign in at ebscohost/i.test(text)) return "signin";
  return /item not found/i.test(text) ? "missing" : null;
}

// In EBSCO's PDF viewer: the address the viewer loaded the PDF from, once it
// has. This is the slower way to learn it, kept for a request the browser does
// not report against the tab. The page keeps a list of what it has loaded; that
// list is made longer first so a busy page cannot push the PDF off its end.
function pageEbscoPdf() {
  performance.setResourceTimingBufferSize(1000);
  const loaded = performance
    .getEntriesByType("resource")
    .find((entry) => /^https:\/\/content\.ebscohost\.com\/cds\/retrieve\b/.test(entry.name));
  return loaded ? loaded.name : null;
}

// --- end of in-page functions ---

// Runs a reading function in the tab. When the connection was dropped the tab
// shows the browser's own error page, which cannot be read at all: that is
// reported as what it is instead of being waited out.
async function readEbsco(tabId, func, door) {
  try {
    return await inTab(tabId, func);
  } catch (error) {
    if (/error page/i.test(error?.message || "")) {
      throw new StepError("couldn't reach EBSCO", { label: "Open in EBSCO", url: door });
    }
    return null;
  }
}

// Follows the tab from EBSCO's door to wherever EBSCO sends it. Any page of
// EBSCO's app other than the PDF viewer (the record's details, an HTML-only
// article) means there is no PDF to save; it has to stay put for a moment
// before that is believed, in case the app is only passing through.
async function ebscoArrival(tabId, door, timeout = 40000) {
  const start = Date.now();
  let resting = { url: "", since: 0 };
  while (Date.now() - start < timeout) {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || "";
    if (EBSCO_VIEWER.test(url)) return { viewer: true, url };
    if (tab.status === "complete") {
      if (EBSCO_APP.test(url)) {
        if (resting.url !== url) resting = { url, since: Date.now() };
        else if (Date.now() - resting.since >= 1200) {
          await readEbsco(tabId, () => true, door);
          return { url };
        }
      }
      if (EBSCO_LOGIN.test(url)) return { signIn: true };
      if (EBSCO_DOOR.test(url)) {
        const state = await readEbsco(tabId, pageEbscoDoor, door);
        if (state === "missing") return { missing: true };
        if (state === "signin") return { signIn: true };
      }
    }
    await sleep(300);
  }
  throw new StepError("EBSCO did not open the article", { label: "Open in EBSCO", url: door });
}

// Tells when the given tab asks EBSCO's content server for a PDF, and for which
// address. This only listens to what the browser reports about that tab's
// requests; nothing is held up or changed.
function watchEbscoPdf(tabId) {
  let listener = null;
  const address = new Promise((resolve) => {
    if (!chrome.webRequest) return; // not allowed to listen: the page is read instead
    listener = (details) => resolve(details.url);
    chrome.webRequest.onBeforeRequest.addListener(listener, { urls: [EBSCO_PDF], tabId });
  });
  return {
    address,
    release() {
      if (listener) chrome.webRequest.onBeforeRequest.removeListener(listener);
    },
  };
}

// The address of the PDF in EBSCO's viewer: from the browser's report the
// moment the viewer asks for it, or failing that from the page once it has
// loaded it.
async function ebscoPdfAddress(tabId, reported, stopped, timeout = 40000) {
  let address = null;
  reported.then((url) => {
    address = url;
  });
  const start = Date.now();
  while (Date.now() - start < timeout && !stopped()) {
    if (address) return address;
    try {
      const loaded = await inTab(tabId, pageEbscoPdf);
      if (loaded) return address || loaded;
    } catch {}
    await Promise.race([reported, sleep(300)]);
  }
  return address;
}

async function viaEbsco(candidate, settings, note, race) {
  const halt = stopper();
  const { until } = halt;
  let tabId = null;
  let watch = null;
  const closeTab = () => {
    if (tabId === null) return;
    chrome.tabs.remove(tabId).catch(() => {});
    tabId = null;
  };
  race?.onStop("ebsco", () => {
    halt.stop();
    closeTab();
  });
  const door = ebscoByDoi(candidate.doi);
  try {
    note("opening EBSCO");
    // Not wrapped in until(): the tab has to be known here to be closed again.
    const tab = await chrome.tabs.create({ url: door, active: false });
    tabId = tab.id;
    watch = watchEbscoPdf(tab.id);
    if (halt.stopped) throw new Stopped();
    let found = await until(ebscoArrival(tab.id, door));
    const byIssue = found.missing ? ebscoByIssue(candidate) : null;
    if (byIssue) {
      note("trying volume and page");
      await until(navigate(tab.id, byIssue));
      found = await until(ebscoArrival(tab.id, door));
    }
    if (found.signIn) throw new StepError("sign-in required", { label: "Sign in at EBSCO", url: door });
    // EBSCO knows this browser: the popup can stop pointing at library setup.
    if (!settings.ebscoSeen) setSettings({ ebscoSeen: true }).catch(() => {});
    if (found.missing) throw new StepError("not in EBSCO");
    if (!found.viewer) {
      throw new StepError("no PDF in your library's EBSCO", { label: "Open record", url: found.url });
    }

    note("opening the PDF");
    const pdf = await until(ebscoPdfAddress(tab.id, watch.address, () => halt.stopped));
    if (!pdf) throw new StepError("EBSCO did not show the PDF", { label: "Open in EBSCO", url: found.url });
    // Closing the tab ends the viewer's own request for the file.
    closeTab();
    note("saving");
    return await saveFrom(pdf, candidate, settings, race, "ebsco");
  } catch (error) {
    // Its tab was closed under it: whatever that broke is not worth reporting.
    if (halt.stopped) throw new Stopped();
    throw error;
  } finally {
    watch?.release();
    closeTab();
  }
}

// -------------------------------------------------------------------- jobs
//
// Each paper being fetched is a job, and several can be on their way at once.
// Their progress lives in chrome.storage.session, newest first, so the popup
// can be closed and reopened mid-download and still show where each one is.

const JOBS_KEPT = 8; // finished jobs beyond this many are dropped, oldest first
const inFlight = new Map(); // DOI (lower case) -> job id, for the papers being fetched right now
let jobCount = 0;

// Every change to the stored list goes through here, one at a time. Several
// jobs report at once, and each change has to start from what the last left.
let jobWrites = Promise.resolve();

function changeJobs(change) {
  const write = jobWrites.then(async () => {
    const { [JOBS_KEY]: jobs = [] } = await chrome.storage.session.get(JOBS_KEY);
    const next = change(jobs);
    await chrome.storage.session.set({ [JOBS_KEY]: next });
    return next;
  });
  jobWrites = write.catch(() => {});
  return write;
}

// Writes where a job stands. The state is copied now, so a later change to the
// job cannot overtake this one on its way into storage.
function publishJob(job) {
  const snapshot = structuredClone(job);
  return changeJobs((jobs) => {
    const known = jobs.some((item) => item.id === snapshot.id);
    const list = known ? jobs.map((item) => (item.id === snapshot.id ? snapshot : item)) : [snapshot, ...jobs];
    const kept = [];
    for (const item of list) {
      if (item.status === "running" || kept.length < JOBS_KEPT) kept.push(item);
    }
    return kept;
  }).catch(() => {});
}

// Takes finished jobs off the list: the one named, or all of them except those
// for the papers in `keep`. A job still running is never removed.
function dismissJobs({ id = null, keep = [] } = {}) {
  const wanted = new Set(keep.map((doi) => String(doi).toLowerCase()));
  return changeJobs((jobs) =>
    jobs.filter((job) => {
      if (job.status === "running") return true;
      if (id !== null) return job.id !== id;
      return wanted.has(job.candidate.doi.toLowerCase());
    }),
  );
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
    { key: "ebsco", label: "EBSCO", ...(settings.useEbsco ? { state: "pending" } : skip("turned off")) },
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

// EBSCO takes a browser tab of its own, so the plain links get this much of a
// head start: when one of them answers with the PDF straight away, EBSCO is
// never opened. If they have all failed sooner, it starts sooner.
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

// Fetches the paper for a job that has already been announced.
async function runJob(job, candidate) {
  const settings = await getSettings();
  job.candidate = { doi: candidate.doi, title: candidate.title };
  job.steps = planSteps(candidate, settings);
  const publish = () => publishJob(job);
  await publish();

  // The open-access copy is the last resort: it is often an earlier version of
  // the paper, so it never competes with the routes to the published one. Only
  // the lookup is done ahead of time.
  const free = job.steps.find((step) => step.key === "oa");
  const lookup = openAccess(candidate.doi).catch(() => ({ pdfs: [], page: null, unreachable: true }));

  let won = null;
  let waiting = job.steps.filter((step) => step.state === "pending" && step !== free);
  // A publisher whose papers libraries get only through EBSCO: EBSCO is asked
  // first and alone. The publisher's own site would only refuse, so nothing is
  // requested from it unless EBSCO turns out to have no answer.
  const ebsco = waiting.find((step) => step.key === "ebsco");
  if (ebsco && publisherOf(candidate.doi)?.ebscoFirst) {
    won = (await raceRoutes([ebsco], candidate, settings, publish)).won;
    waiting = waiting.filter((step) => step !== ebsco);
  }
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

// One paper per click is how this is meant to be used, and library licences
// forbid systematic downloading. So there is a ceiling no reader collecting
// papers by hand comes near, and no way to queue, schedule or loop downloads.
// Papers still on their way count towards it.
const PACE = { papers: 30, minutes: 60 };
const PACE_KEY = "savedAt"; // when each of the last papers was saved

async function recentSaves() {
  const { [PACE_KEY]: times = [] } = await chrome.storage.local.get(PACE_KEY);
  const since = Date.now() - PACE.minutes * 60000;
  return times.filter((time) => time > since && time <= Date.now()).sort((a, b) => a - b);
}

// Null when another paper may be fetched now, otherwise why not and until when.
// `underway` is how many other papers are being fetched at this moment.
async function paceLimit(underway = 0) {
  const recent = await recentSaves();
  if (recent.length + underway < PACE.papers) return null;
  const limit = `${PACE.papers} papers an hour is the limit, to stay within library licences.`;
  if (recent.length < PACE.papers) return `${limit} The ones on their way now count; try again when one is done.`;
  const free = new Date(recent[recent.length - PACE.papers] + PACE.minutes * 60000);
  const at = free.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${limit} Next one at ${at}.`;
}

// Also remembered, until the browser is closed: which papers were saved, so
// that auto-download does not fetch one of them a second time by itself.
const SAVED_KEY = "savedDois";

async function noteSave(doi) {
  await chrome.storage.local.set({ [PACE_KEY]: [...(await recentSaves()), Date.now()] });
  const { [SAVED_KEY]: dois = [] } = await chrome.storage.session.get(SAVED_KEY);
  await chrome.storage.session.set({ [SAVED_KEY]: [...dois, doi.toLowerCase()].slice(-200) });
}

// Starts fetching a paper and answers as soon as the job exists; the popup
// hears the rest through storage. The same paper is not fetched twice at once.
async function startDownload(candidate) {
  if (!candidate?.doi) return { error: "Nothing selected." };
  const key = candidate.doi.toLowerCase();
  if (inFlight.has(key)) return { error: "This paper is already downloading." };
  // Its place is taken at once: the check below takes a moment, and a second
  // request for the same paper may arrive meanwhile.
  inFlight.set(key, null);
  let job;
  try {
    const limit = await paceLimit(inFlight.size - 1);
    if (limit) {
      inFlight.delete(key);
      return { error: limit };
    }
    jobCount += 1;
    job = {
      id: `${Date.now()}-${jobCount}`,
      status: "running",
      startedAt: Date.now(),
      candidate: { doi: candidate.doi, title: candidate.title || candidate.doi },
      steps: [],
    };
    inFlight.set(key, job.id);
    await publishJob(job);
  } catch (error) {
    inFlight.delete(key);
    throw error;
  }
  fetchPaper(job, candidate).finally(() => inFlight.delete(key));
  return { id: job.id };
}

async function fetchPaper(job, candidate) {
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
    await runJob(job, candidate);
    if (job.status === "done") await noteSave(candidate.doi);
  } catch (error) {
    // Nothing above is expected to throw; if it does, the job must not be left
    // looking as if it were still running.
    job.status = "failed";
    job.finishedAt = Date.now();
    job.steps = [{ key: "error", label: "Callslip", state: "failed", detail: error?.message || String(error), action: null }];
    await publishJob(job);
  } finally {
    clearInterval(awake);
  }
}

// Jobs still marked "running" when this worker starts belong to a worker that
// was shut down mid-download; nothing is going to finish them.
function sweepStaleJobs() {
  return changeJobs((jobs) =>
    jobs.map((job) => {
      if (job.status !== "running" || inFlight.has(job.candidate.doi.toLowerCase())) return job;
      const steps = job.steps.map((step) => (step.state === "running" ? { ...step, state: "failed", detail: "interrupted" } : step));
      return { ...job, steps, status: "failed", finishedAt: Date.now() };
    }),
  ).catch(() => {});
}

sweepStaleJobs();

// ---------------------------------------------------------------- messages

const HANDLERS = {
  async search(message) {
    const query = message.query || {};
    const candidates = await search(query);
    await chrome.storage.session.set({ [SEARCH_KEY]: { query, candidates } });
    return { candidates };
  },
  download: (message) => startDownload(message.candidate),
  "jobs:dismiss": async (message) => ({ jobs: await dismissJobs({ id: message.id }) }),
  "jobs:clear": async (message) => ({ jobs: await dismissJobs({ keep: message.keep || [] }) }),
  "settings:get": async () => ({ settings: await getSettings() }),
  "settings:set": async (message) => ({ settings: await setSettings(message.settings || {}) }),
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
