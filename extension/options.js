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
