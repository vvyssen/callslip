import { downloadPath, normalizeProxy } from "./lib.js";

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

const SAMPLE = { authors: ["Alex Smith"], year: 2018, title: "Supply chain resilience" };
const EBSCO_HINT = $("ebscoNote").innerHTML;

let savedTimer = null;

function flash(text, isError = false) {
  const note = $("saved");
  note.textContent = text;
  note.className = "saved-note show" + (isError ? " error" : "");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => note.classList.remove("show"), isError ? 6000 : 1600);
}

function ebscoNote(text, kind) {
  const note = $("ebscoNote");
  if (text) note.textContent = text;
  else note.innerHTML = EBSCO_HINT;
  note.className = "hint" + (kind ? ` ${kind}` : "");
}

function showPreview() {
  $("preview").textContent = `Downloads/${downloadPath(SAMPLE, $("subfolder").value)}`;
}

// Whole percent in the field's [min, max]; the fallback covers an emptied field.
function percent(id, fallback) {
  const field = $(id);
  const value = field.value.trim() === "" ? NaN : Number(field.value);
  const clamped = Number.isFinite(value)
    ? Math.min(Number(field.max), Math.max(Number(field.min), Math.round(value)))
    : fallback;
  field.value = String(clamped);
  return clamped / 100;
}

// Each control reads and writes one setting. Saving is per control, never the
// whole page: the popup and a download in progress change settings too (the
// auto-download switch, a detected EBSCO code), and a page that has been open
// for a while must not write its stale copy over those.
const CONTROLS = {
  proxy: {
    show: (settings) => ($("proxy").value = settings.proxy || ""),
    read: () => ({ proxy: ($("proxy").value = normalizeProxy($("proxy").value)) }),
  },
  customer: {
    show: (settings) => ($("customer").value = settings.ebscoCustomer || ""),
    read: () => ({ ebscoCustomer: $("customer").value.trim() }),
  },
  subfolder: {
    show: (settings) => ($("subfolder").value = settings.subfolder || ""),
    read: () => ({ subfolder: $("subfolder").value.trim() }),
  },
  threshold: {
    show: (settings) => ($("threshold").value = String(Math.round((settings.autoThreshold ?? 0.9) * 100))),
    read: () => ({ autoThreshold: percent("threshold", 90) }),
  },
  margin: {
    show: (settings) => ($("margin").value = String(Math.round((settings.autoMargin ?? 0.05) * 100))),
    read: () => ({ autoMargin: percent("margin", 5) }),
  },
  autoDefault: {
    show: (settings) => ($("autoDefault").checked = Boolean(settings.autoDefault)),
    read: () => ({ autoDefault: $("autoDefault").checked }),
  },
};

function show(settings) {
  for (const [id, control] of Object.entries(CONTROLS)) {
    if (document.activeElement !== $(id)) control.show(settings); // not under the cursor
  }
  showPreview();
}

async function save(id) {
  const response = await send({ type: "settings:set", settings: CONTROLS[id].read() });
  if (response?.error) throw new Error(response.error);
  showPreview();
  flash("Saved");
}

async function detect() {
  const button = $("detect");
  button.disabled = true;
  ebscoNote("Looking for your EBSCO session…");
  try {
    const response = await send({ type: "settings:detect" });
    if (response?.code) {
      $("customer").value = response.code;
      ebscoNote(`Found your library: ${response.code}`, "ok");
      await save("customer");
    } else {
      ebscoNote("Not signed in to EBSCO yet. Open EBSCO, sign in, then Detect again.", "error");
    }
  } catch (error) {
    ebscoNote(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

// ---- find the proxy link by university name ----
//
// libproxy-db.org keeps a public list of library proxy links. It is fetched
// once, when the search box is first used, and searched here in the page; what
// is typed is not sent anywhere.

const DIRECTORY = "https://libproxy-db.org/proxies.json";
let directory = null;
let shown = []; // the schools currently listed
let marked = -1;

function loadDirectory() {
  directory ||= fetch(DIRECTORY)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then((entries) =>
      entries
        .map((entry) => ({
          name: String(entry.name || "").trim(),
          country: String(entry.country || "").trim(),
          link: String(entry.url || "").replace(/\$@$/, ""), // "$@" stands for the target address
        }))
        // Only the plain "…url=" kind, which is what the proxy field takes.
        .filter((school) => school.name && /^https?:\/\/[^\s]+[?&]q?url=$/i.test(school.link)),
    )
    .catch((error) => {
      directory = null; // try again on the next keystroke
      throw error;
    });
  return directory;
}

function matchSchools(schools, typed) {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  const ranked = [];
  for (const school of schools) {
    const name = school.name.toLowerCase();
    if (!words.every((word) => name.includes(word) || school.country.toLowerCase().includes(word))) continue;
    ranked.push({ school, rank: name.startsWith(words[0]) ? 0 : 1 });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || a.school.name.localeCompare(b.school.name))
    .slice(0, 8)
    .map((entry) => entry.school);
}

function listSchools(schools, emptyText = "") {
  const list = $("schools");
  shown = schools;
  marked = schools.length ? 0 : -1;
  list.textContent = "";
  for (const [index, school] of schools.entries()) {
    const row = document.createElement("li");
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(index === marked));
    const name = document.createElement("span");
    name.textContent = school.name;
    const where = document.createElement("span");
    where.className = "where";
    where.textContent = school.country;
    row.append(name, where);
    // mousedown, so the pick lands before the field loses focus and the list closes
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      pickSchool(school);
    });
    list.append(row);
  }
  if (!schools.length && emptyText) {
    const row = document.createElement("li");
    row.className = "none";
    row.textContent = emptyText;
    list.append(row);
  }
  list.hidden = !list.childElementCount;
  $("school").setAttribute("aria-expanded", String(!list.hidden));
}

function markSchool(index) {
  if (!shown.length) return;
  marked = (index + shown.length) % shown.length;
  [...$("schools").children].forEach((row, rowIndex) => {
    row.setAttribute("aria-selected", String(rowIndex === marked));
  });
  $("schools").children[marked].scrollIntoView({ block: "nearest" });
}

async function pickSchool(school) {
  listSchools([]);
  $("school").value = school.name;
  $("proxy").value = school.link;
  try {
    await save("proxy");
    $("proxyNote").textContent = `Proxy link set for ${school.name}. Press Sign in to check it opens your library's sign-in page.`;
    $("proxyNote").className = "hint ok";
  } catch (error) {
    flash(`Not saved: ${error.message}`, true);
  }
}

async function searchSchools() {
  const typed = $("school").value.trim();
  if (typed.length < 2) {
    listSchools([]);
    return;
  }
  try {
    const schools = await loadDirectory();
    if ($("school").value.trim() !== typed) return; // typed on while it loaded
    listSchools(matchSchools(schools, typed), "Not in the list. Paste your library's proxy link below.");
  } catch {
    listSchools([], "Couldn't load the university list. Paste your library's proxy link below.");
  }
}

$("school").addEventListener("input", searchSchools);
$("school").addEventListener("focus", searchSchools);
$("school").addEventListener("blur", () => listSchools([]));
$("school").addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    markSchool(marked + (event.key === "ArrowDown" ? 1 : -1));
  } else if (event.key === "Enter" && shown[marked]) {
    event.preventDefault();
    pickSchool(shown[marked]);
  } else if (event.key === "Escape") {
    listSchools([]);
  }
});

for (const id of Object.keys(CONTROLS)) {
  $(id).addEventListener("change", () => {
    save(id).catch((error) => flash(`Not saved: ${error.message}`, true));
  });
}
$("subfolder").addEventListener("input", showPreview);
$("customer").addEventListener("input", () => ebscoNote());
$("detect").addEventListener("click", detect);
$("openEbsco").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://research.ebsco.com/" });
});
$("openProxy").addEventListener("click", () => {
  // "<proxy>/login?url=" without a target is the proxy's own sign-in page.
  let url;
  try {
    url = new URL(normalizeProxy($("proxy").value).replace("{url}", ""));
  } catch {
    flash("Enter your library's proxy link first", true);
    return;
  }
  if (url.hostname === "go.openathens.net") url = new URL("https://my.openathens.net/");
  else url.search = "";
  chrome.tabs.create({ url: url.href });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings?.newValue) {
    send({ type: "settings:get" }).then((response) => show(response.settings));
  }
});

send({ type: "settings:get" })
  .then((response) => show(response?.settings || {}))
  .catch((error) => flash(error.message, true));
