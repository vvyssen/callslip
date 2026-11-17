import { publisherOf, parseDoi } from "./lib.js";

const $ = (id) => document.getElementById(id);

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const SVG = (path) =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const MARKS = {
  done: SVG('<path d="M3.5 8.5l3 3 6-7"/>'),
  failed: SVG('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
  skipped: SVG('<path d="M5 8h6"/>'),
  running: '<span class="spinner"></span>',
  pending: '<span class="dot"></span>',
};
const CLOSE = SVG('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>');

const TYPE_LABELS = {
  "posted-content": "Preprint",
  "proceedings-article": "Conference",
  "book-chapter": "Chapter",
  book: "Book",
  monograph: "Book",
  dissertation: "Thesis",
  report: "Report",
  dataset: "Dataset",
  "peer-review": "Peer review",
  component: "Supplement",
};

const GUIDE = "Finds the paper on Crossref, then tries the publisher, your library proxy, EBSCO and open access.";
const state = {
  settings: { autoThreshold: 0.9, autoMargin: 0.05, autoDefault: false, proxy: "", ebscoCustomer: "" },
  candidates: [],
  selected: -1,
  searchedKey: null, // the form contents the current list was fetched for
  searching: false,
  starting: false, // download requested, first progress not in yet
  job: null,
  note: "", // one-off message for the action bar
};

// ------------------------------------------------------------------- form

function formQuery() {
  return {
    title: $("title").value.replace(/\s+/g, " ").trim(),
    author: $("author").value.trim(),
    year: $("year").value.trim(),
  };
}

const queryKey = (query) => JSON.stringify([query.title, query.author, query.year]);

// True while the list on screen still answers what is typed in the form.
function listIsCurrent() {
  return state.candidates.length > 0 && queryKey(formQuery()) === state.searchedKey;
}

function fitTitle() {
  const field = $("title");
  field.style.height = "auto";
  field.style.height = `${Math.min(field.scrollHeight, 60)}px`;
  $("clear").hidden = !field.value;
}

function setNotice(text, kind = "") {
  $("notice").textContent = text;
  $("notice").className = "notice" + (kind ? ` ${kind}` : "");
  // Until a library is set up, the opening guidance also points at settings.
  if (text === GUIDE && !state.settings.proxy && !state.settings.ebscoCustomer) {
    const setup = el("button", "link", "Set up library access");
    setup.type = "button";
    setup.addEventListener("click", () => chrome.runtime.openOptionsPage());
    $("notice").append(" Off campus? ", setup, ".");
  }
}

// ---------------------------------------------------------------- matches

function authorLine(candidate) {
  const names = candidate.families?.length
    ? candidate.families
    : (candidate.authors || []).map((name) => name.split(" ").pop());
  if (names.length > 3) return `${names[0]} et al.`;
  if (names.length > 1) return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
  return names[0] || "";
}

function matchRow(candidate, index) {
  const item = el("li", "item");
  item.id = `match-${index}`;
  item.setAttribute("role", "option");
  item.setAttribute("aria-selected", "false");

  const title = el("div", "item-title", candidate.title);
  title.title = candidate.title;

  const value = candidate.score || 0;
  const score = el(
    "span",
    "score " + (value >= 0.9 ? "high" : value >= 0.7 ? "mid" : "low"),
    candidate.exact ? "DOI" : `${Math.round(value * 100)}%`,
  );
  score.title = candidate.exact ? "Looked up by DOI" : "How closely the title matches";

  const meta = el("div", "item-meta");
  meta.append([authorLine(candidate), candidate.year].filter(Boolean).join(" · "));
  if (candidate.journal) {
    if (meta.textContent) meta.append(" · ");
    meta.append(el("i", "", candidate.journal));
  }

  const foot = el("div", "item-foot");
  const publisher = publisherOf(candidate.doi);
  if (publisher) {
    const tag = el("span", "tag pub", publisher.short || publisher.name);
    tag.title = `Direct PDF link known for ${publisher.name}`;
    foot.append(tag);
  }
  if (TYPE_LABELS[candidate.type]) foot.append(el("span", "tag", TYPE_LABELS[candidate.type]));
  const doi = el("a", "doi", candidate.doi);
  doi.href = `https://doi.org/${candidate.doi}`;
  doi.target = "_blank";
  doi.rel = "noopener";
  doi.title = "Open the article page";
  doi.addEventListener("click", (event) => event.stopPropagation());
  foot.append(doi);

  item.append(title, score, meta, foot);
  item.addEventListener("click", () => select(index));
  item.addEventListener("dblclick", () => {
    select(index);
    download();
  });
  return item;
}

function renderMatches() {
  const list = $("results");
  list.textContent = "";
  list.removeAttribute("aria-activedescendant");
  $("matches").hidden = state.candidates.length === 0;
  if (!state.candidates.length) return;
  const count = state.candidates.length;
  $("count").textContent = state.candidates[0].exact
    ? "DOI match"
    : `${count} ${count === 1 ? "match" : "matches"}`;
  list.append(...state.candidates.map(matchRow));
}

function select(index, { keep = false } = {}) {
  if (index < 0 || index >= state.candidates.length) return;
  state.selected = index;
  if (!keep) state.note = "";
  const list = $("results");
  [...list.children].forEach((child, childIndex) => {
    child.setAttribute("aria-selected", String(childIndex === index));
  });
  list.setAttribute("aria-activedescendant", `match-${index}`);
  list.children[index].scrollIntoView({ block: "nearest" });
  chrome.storage.session.set({ selectedDoi: state.candidates[index].doi });
  renderFoot();
}

// --------------------------------------------------------------- download

const jobActive = () => state.starting || state.job?.status === "running";

function renderJob() {
  const box = $("job");
  const job = state.job;
  box.textContent = "";
  box.hidden = !job;
  if (!job) return;
  box.className = `job ${job.status}`;

  const head = el("div", "job-head");
  head.append(
    el(
      "span",
      "job-state",
      { running: "Downloading", done: "Saved", failed: "Couldn't download" }[job.status],
    ),
  );
  if (job.status !== "running") {
    const close = el("button", "icon-btn job-close");
    close.type = "button";
    close.title = "Dismiss";
    close.setAttribute("aria-label", "Dismiss");
    close.innerHTML = CLOSE;
    close.addEventListener("click", () => chrome.storage.session.remove("job"));
    head.append(close);
  }
  const title = el("div", "job-title", job.candidate.title);
  title.title = job.candidate.title;
  box.append(head, title);

  if (job.status === "done") {
    const saved = el("div", "saved");
    const file = el("span", "saved-file", job.filename || "PDF saved");
    file.title = job.filename || "";
    file.append(el("span", "saved-via", `via ${job.provider}`));
    const show = el(
      "button",
      "btn",
      /Mac/i.test(navigator.platform) ? "Show in Finder" : "Show in folder",
    );
    show.type = "button";
    show.addEventListener("click", () => chrome.downloads.show(job.downloadId));
    saved.append(file, show);
    box.append(saved);
    return;
  }

  const steps = el("ul", "steps");
  for (const step of job.steps) {
    const row = el("li", `step ${step.state}`);
    const mark = el("span", "step-mark");
    mark.innerHTML = MARKS[step.state] || MARKS.pending;
    row.append(mark, el("span", "step-name", step.label));
    const detail = el("span", "step-detail", step.detail || "");
    detail.title = step.detail || "";
    row.append(detail);
    if (step.action && /^https:\/\//.test(step.action.url || "")) {
      const action = el("button", "step-action", step.action.label);
      action.type = "button";
      action.addEventListener("click", () => chrome.tabs.create({ url: step.action.url }));
      row.append(action);
    }
    steps.append(row);
  }
  box.append(steps);

  if (job.status === "failed" && /^https:\/\//.test(job.fallback?.url || "")) {
    const fallback = el("div", "job-fallback");
    const open = el("button", "btn", job.fallback.label);
    open.type = "button";
    open.addEventListener("click", () => chrome.tabs.create({ url: job.fallback.url }));
    fallback.append(el("span", "", "Get it by hand:"), open);
    box.append(fallback);
  }
}

function renderFoot() {
  const visible = state.candidates.length > 0;
  $("foot").hidden = !visible;
  if (!visible) return;

  const button = $("download");
  const active = jobActive();
  const retry =
    state.job?.status === "failed" &&
    state.job.candidate.doi === state.candidates[state.selected]?.doi;
  button.disabled = active || state.selected < 0;
  button.textContent = "";
  if (active) button.append(el("span", "spinner"));
  button.append(active ? "Downloading" : retry ? "Try again" : "Download PDF");

  const hint = $("hint");
  hint.textContent = "";
  hint.className = "hint" + (state.note ? " warn" : "");
  if (active) return;
  if (state.note) {
    hint.textContent = state.note;
  } else if (!listIsCurrent()) {
    hint.append(el("kbd", "", "⏎"), " search again");
  } else {
    hint.append(el("kbd", "", "↑"), el("kbd", "", "↓"), " choose", el("span", "sep", "·"), el("kbd", "", "⏎"), " download");
  }
}

async function download() {
  const candidate = state.candidates[state.selected];
  if (!candidate || jobActive()) return;
  state.starting = true;
  state.note = "";
  renderFoot();
  let response;
  try {
    // Resolves when the download ends; progress arrives through storage.
    response = await send({ type: "download", candidate });
  } catch (error) {
    response = { error: error.message };
  }
  state.starting = false;
  if (response?.error) state.note = response.error;
  renderFoot();
}

function isConfident() {
  const [top, second] = state.candidates;
  if (!top) return false;
  const lead = top.score - (second ? second.score : 0);
  return top.score >= state.settings.autoThreshold && lead >= state.settings.autoMargin;
}

// ----------------------------------------------------------------- search

function setSearching(value) {
  state.searching = value;
  const button = $("search");
  button.disabled = value;
  button.textContent = "";
  if (value) button.append(el("span", "spinner"));
  button.append(value ? "Searching" : "Search");
}

function resetList() {
  state.candidates = [];
  state.selected = -1;
  state.searchedKey = null;
  state.note = "";
  renderMatches();
  renderFoot();
}

async function runSearch() {
  if (state.searching) return;
  const query = formQuery();
  if (!query.title) {
    setNotice("Paste a title or DOI first.", "error");
    $("title").focus();
    return;
  }
  resetList();
  if (state.job && state.job.status !== "running") chrome.storage.session.remove("job");
  setSearching(true);
  setNotice("Searching Crossref…", "loading");
  try {
    const response = await send({ type: "search", query });
    if (response?.error) throw new Error(response.error);
    state.candidates = response?.candidates || [];
    state.searchedKey = queryKey(query);
    if (!state.candidates.length) {
      setNotice(
        parseDoi(query.title)
          ? "Crossref doesn't know that DOI. Try the title instead."
          : "No match on Crossref. Check the title, or add an author or year.",
      );
      return;
    }
    setNotice("");
    renderMatches();
    select(0);
    if ($("auto").checked) {
      if (isConfident()) {
        download();
      } else {
        state.note = "No clear winner. Pick one.";
        renderFoot();
      }
    }
  } catch (error) {
    setNotice(error.message, "error");
  } finally {
    setSearching(false);
  }
}

// Enter means "the obvious next step": download when the list on screen is the
// answer to what is typed, search otherwise.
function primaryAction() {
  if (listIsCurrent() && state.selected >= 0) download();
  else runSearch();
}

function moveSelection(delta) {
  if (!state.candidates.length) return;
  const next = state.selected < 0 ? 0 : state.selected + delta;
  select(Math.min(state.candidates.length - 1, Math.max(0, next)));
}

// ------------------------------------------------------------------- init

function bindEvents() {
  const title = $("title");

  $("form").addEventListener("submit", (event) => {
    event.preventDefault();
    runSearch();
  });

  title.addEventListener("input", () => {
    fitTitle();
    renderFoot();
  });
  // Titles copied out of a PDF arrive with line breaks in them.
  title.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text");
    if (!text) return;
    event.preventDefault();
    title.setRangeText(text.replace(/\s+/g, " ").trim(), title.selectionStart, title.selectionEnd, "end");
    title.dispatchEvent(new Event("input", { bubbles: true }));
  });
  title.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      primaryAction();
    } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && listIsCurrent()) {
      event.preventDefault();
      moveSelection(event.key === "ArrowDown" ? 1 : -1);
    }
  });
  for (const id of ["author", "year"]) $(id).addEventListener("input", renderFoot);
  $("year").addEventListener("input", () => {
    $("year").value = $("year").value.replace(/\D/g, "");
  });

  $("clear").addEventListener("click", () => {
    for (const id of ["title", "author", "year"]) $(id).value = "";
    fitTitle();
    resetList();
    setNotice(GUIDE);
    chrome.storage.session.remove(["lastSearch", "selectedDoi"]);
    title.focus();
  });

  $("download").addEventListener("click", download);
  $("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

  $("auto").addEventListener("change", async () => {
    try {
      const response = await send({
        type: "settings:set",
        settings: { autoDefault: $("auto").checked },
      });
      if (response?.settings) state.settings = { ...state.settings, ...response.settings };
    } catch (error) {
      setNotice(`Couldn't save that setting: ${error.message}`, "error");
    }
  });

  // Keys for the list once focus has left the form.
  document.addEventListener("keydown", (event) => {
    const tag = document.activeElement?.tagName || "";
    if (["TEXTAREA", "INPUT", "BUTTON", "A"].includes(tag)) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" && state.selected >= 0) {
      event.preventDefault();
      download();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "session" || !changes.job) return;
    state.job = changes.job.newValue || null;
    renderJob();
    renderFoot();
  });
}

async function init() {
  bindEvents();
  setNotice(GUIDE);

  const [response, session] = await Promise.all([
    send({ type: "settings:get" }),
    chrome.storage.session.get(["lastSearch", "selectedDoi", "job"]),
  ]);
  if (response?.settings) state.settings = { ...state.settings, ...response.settings };
  $("auto").checked = Boolean(state.settings.autoDefault);
  setNotice(GUIDE); // again, now that we know whether a library is set up

  // Pick up where the popup was closed: the last list, and any download that
  // carried on in the background.
  const last = session.lastSearch;
  if (last?.candidates?.length) {
    $("title").value = last.query.title || "";
    $("author").value = last.query.author || "";
    $("year").value = last.query.year || "";
    state.candidates = last.candidates;
    state.searchedKey = queryKey(formQuery());
    setNotice("");
    renderMatches();
    const index = state.candidates.findIndex((candidate) => candidate.doi === session.selectedDoi);
    select(index < 0 ? 0 : index);
  }
  state.job = session.job || null;
  renderJob();
  renderFoot();

  fitTitle();
  $("title").focus();
  $("title").select();
  chrome.storage.local.remove("lastQuery"); // written by versions before 0.2
}

init().catch((error) => setNotice(`Couldn't start: ${error.message}`, "error"));
