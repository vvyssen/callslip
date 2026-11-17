const STOPWORDS = new Set([
  "a", "an", "the", "of", "for", "on", "in", "to", "with", "and", "or",
  "under", "when", "from", "by", "at", "as", "is", "are", "its", "their",
]);

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeTitle(value) {
  return (value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // accents off: "Cahlíková" -> "Cahlikova"
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[“”‘’]/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokens(value) {
  return normalizeTitle(value)
    .split(" ")
    .filter((word) => word && !STOPWORDS.has(word));
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

export function titleSimilarity(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const edit = 1 - levenshtein(na, nb) / Math.max(na.length, nb.length);
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return Math.max(0, edit);
  let shared = 0;
  for (const word of ta) if (tb.has(word)) shared += 1;
  const jaccard = shared / (ta.size + tb.size - shared);
  // One title containing the other usually means a dropped subtitle. Only trust
  // that when the shorter one is a real share of the longer one; otherwise a
  // one-word title such as "Resilience" would score 0.9 against any query that
  // happens to mention it, which is enough to trigger auto-download.
  let containment = 0;
  if (na.includes(nb) || nb.includes(na)) {
    const share = Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
    containment = 0.9 * Math.min(1, share / 0.5);
  }
  return Math.min(1, Math.max(edit * 0.85, jaccard * 0.95, containment));
}

function lastName(value) {
  const parts = normalizeTitle(value).split(" ").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

export function scoreCandidate(query, candidate) {
  const titleScore = titleSimilarity(query.title, candidate.title);
  let score = titleScore;
  if (query.year && candidate.year) {
    const delta = Math.abs(Number(query.year) - Number(candidate.year));
    if (delta <= 1) score += 0.05;
  }
  if (query.author) {
    const wanted = lastName(query.author);
    const names = (candidate.authors || []).map(lastName);
    if (wanted && names.includes(wanted)) score += 0.05;
  }
  return { score: Math.min(1, score), titleScore };
}

function candidateYear(item) {
  for (const key of ["published-print", "published-online", "issued"]) {
    const part = item[key]?.["date-parts"]?.[0]?.[0];
    if (part) return Number(part);
  }
  return null;
}

// Crossref titles can carry inline markup (<i>, <sub>) and a few entities.
function plainText(value) {
  return (value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function toCandidate(item) {
  const people = item.author || [];
  return {
    doi: item.DOI,
    title: plainText((item.title || [""])[0]),
    authors: people
      .map((entry) => [entry.given, entry.family].filter(Boolean).join(" "))
      .filter(Boolean),
    families: people.map((entry) => entry.family || entry.name).filter(Boolean),
    year: candidateYear(item),
    journal: plainText((item["container-title"] || [""])[0]),
    type: item.type || "",
  };
}

// Returns parsed JSON, or null for 404. Retries only what can succeed on retry.
// No key is sent: this is Crossref's free public pool (one request a second
// per IP at the time of writing), and a search is a single request.
async function crossrefGet(url) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await sleep(1200 * attempt);
    let response;
    try {
      response = await fetch(url, { headers: { Accept: "application/json" } });
    } catch {
      lastError = new Error("Can't reach Crossref. Check your connection.");
      continue;
    }
    if (response.status === 404) return null;
    if (response.ok) return response.json();
    lastError = new Error(
      response.status === 429
        ? "Crossref is rate-limiting requests. Try again in a moment."
        : `Crossref returned HTTP ${response.status}.`,
    );
    if (response.status < 500 && response.status !== 429) break;
  }
  throw lastError;
}

export async function crossrefSearch({ title, author, year, rows = 10 }) {
  const query = [title, author, year].filter(Boolean).join(" ");
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query.bibliographic", query);
  url.searchParams.set("rows", String(rows));
  url.searchParams.set(
    "select",
    "DOI,title,author,issued,published-print,published-online,container-title,type",
  );
  const payload = await crossrefGet(url);
  return (payload?.message?.items || [])
    .map(toCandidate)
    .filter((candidate) => candidate.doi && candidate.title);
}

export async function crossrefByDoi(doi) {
  const payload = await crossrefGet(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
  const candidate = payload?.message ? toCandidate(payload.message) : null;
  return candidate && candidate.doi && candidate.title ? candidate : null;
}

// A DOI or a DOI link pasted in place of a title.
export function parseDoi(value) {
  const match = (value || "").trim().match(/10\.\d{4,9}\/[^\s"'<>]+/i);
  return match ? match[0].replace(/[.,;:)\]]+$/, "") : null;
}

// The DOI in an article page's address, such as /doi/full/10.1287/mnsc.2019.3426
// or /content/pdf/10.1007/s10479-019-03454-4.pdf. Null when there is none.
export function doiFromUrl(value) {
  let path;
  try {
    path = decodeURIComponent(new URL(value).pathname);
  } catch {
    return null;
  }
  const match = path.match(/10\.\d{4,9}\/[^\s"'<>]+/);
  if (!match) return null;
  return match[0]
    .replace(/\/(pdf|epdf|full|abs|abstract|meta|html)$/i, "") // a view of the article, not part of the DOI
    .replace(/\.pdf$/i, "")
    .replace(/[.,;:)\]]+$/, "");
}

// Publishers whose PDF address follows from the DOI alone. `prefixes` are DOI
// prefixes; most of these sites run the same platform and share /doi/pdf/<doi>.
const atypon = (host) => (doi) => `https://${host}/doi/pdf/${doi}`;
const PUBLISHERS = [
  {
    name: "Wiley",
    prefixes: ["10.1111/", "10.1002/"],
    pdf: (doi) => `https://onlinelibrary.wiley.com/doi/pdfdirect/${doi}`,
  },
  { name: "INFORMS", prefixes: ["10.1287/"], pdf: atypon("pubsonline.informs.org") },
  { name: "Sage", prefixes: ["10.1177/"], pdf: atypon("journals.sagepub.com") },
  {
    name: "Springer",
    prefixes: ["10.1007/", "10.1057/"],
    pdf: (doi) => `https://link.springer.com/content/pdf/${doi}.pdf`,
  },
  {
    name: "Taylor & Francis",
    short: "T&F",
    prefixes: ["10.1080/"],
    pdf: atypon("www.tandfonline.com"),
  },
  {
    name: "Nature",
    prefixes: ["10.1038/"],
    pdf: (doi) => `https://www.nature.com/articles/${doi.slice(doi.indexOf("/") + 1)}.pdf`,
  },
  { name: "Science", prefixes: ["10.1126/"], pdf: atypon("www.science.org") },
  { name: "PNAS", prefixes: ["10.1073/"], pdf: atypon("www.pnas.org") },
  { name: "ACS", prefixes: ["10.1021/"], pdf: atypon("pubs.acs.org") },
  { name: "ACM", prefixes: ["10.1145/"], pdf: atypon("dl.acm.org") },
  { name: "SIAM", prefixes: ["10.1137/"], pdf: atypon("epubs.siam.org") },
  { name: "Academy of Management", short: "AOM", prefixes: ["10.5465/"], pdf: atypon("journals.aom.org") },
  { name: "Chicago", prefixes: ["10.1086/"], pdf: atypon("www.journals.uchicago.edu") },
  { name: "Royal Society", prefixes: ["10.1098/"], pdf: atypon("royalsocietypublishing.org") },
  { name: "ASCE", prefixes: ["10.1061/"], pdf: atypon("ascelibrary.org") },
  {
    name: "IOP",
    prefixes: ["10.1088/"],
    pdf: (doi) => `https://iopscience.iop.org/article/${doi}/pdf`,
  },
];

// The publishers we know a direct PDF address for; null for everything else.
export function publisherOf(doi) {
  const value = (doi || "").toLowerCase();
  return PUBLISHERS.find((entry) => entry.prefixes.some((prefix) => value.startsWith(prefix))) || null;
}

export function publisherPdfUrl(doi) {
  const publisher = publisherOf(doi);
  return publisher ? publisher.pdf(doi) : null;
}

// The publisher's PDF address as seen from the page you are on, when that page
// is the publisher's site read through a library proxy. Such proxies rewrite
// pubsonline.informs.org into pubsonline-informs-org.<proxy host>, and the
// session you are signed in to lives on that host. Null when the page is not
// a proxied copy of this DOI's publisher.
export function pdfNear(doi, pageUrl) {
  const direct = publisherPdfUrl(doi);
  if (!direct) return null;
  try {
    const page = new URL(pageUrl);
    const pdf = new URL(direct);
    if (!page.hostname.startsWith(`${pdf.hostname.replaceAll(".", "-")}.`)) return null;
    pdf.protocol = page.protocol;
    pdf.host = page.host;
    return pdf.href;
  } catch {
    return null;
  }
}

// ---- library proxy ----
//
// A library proxy is reached through a sign-in link that takes the address you
// want as its last parameter. EZproxy (the common one, also when hosted at
// idm.oclc.org) takes it as-is after "url="; "qurl=" and the OpenAthens
// redirector want it percent-encoded. "{url}" marks the spot in anything else.

// Turns whatever was pasted into the settings field into such a link: a bare
// host, the sign-in page, or a full proxied link copied from the library site.
export function normalizeProxy(value) {
  let text = (value || "").trim();
  if (!text) return "";
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  if (text.includes("{url}")) return text;
  const upToParameter = text.match(/^.*?[?&]q?url=/i);
  if (upToParameter) return upToParameter[0];
  let url;
  try {
    url = new URL(text);
  } catch {
    return text;
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path || "/login"}?url=`;
}

// The proxy link of the library whose sign-in page this is, or null. EZproxy
// sign-in pages look like <host>/login?url=<the address you wanted>.
export function proxyFromUrl(value) {
  try {
    const url = new URL(value);
    const target = url.searchParams.get("url") || url.searchParams.get("qurl") || "";
    if (!/\/login\/?$/.test(url.pathname) || !/^https?:\/\//i.test(target)) return null;
    return normalizeProxy(value);
  } catch {
    return null;
  }
}

export function proxied(proxy, target) {
  if (proxy.includes("{url}")) return proxy.replace("{url}", encodeURIComponent(target));
  const encoded = /[?&]qurl=$/i.test(proxy) || /\/\/go\.openathens\.net\//i.test(proxy);
  return proxy + (encoded ? encodeURIComponent(target) : target);
}

// The proxy's own name: its sign-in host without the "login." in front. The
// sites it proxies appear as <site>.<this name>.
function proxyName(proxy) {
  try {
    const url = new URL(proxy.replace("{url}", ""));
    if (!/^https?:$/.test(url.protocol) || url.hostname === "go.openathens.net") return null;
    return { url, name: url.hostname.replace(/^login\./, "") };
  } catch {
    return null;
  }
}

// Host patterns covering the proxy's sign-in page and the sites behind it;
// what the extension must be allowed to read to tell whether you are signed
// in. Null for links this cannot be worked out for.
export function proxyScope(proxy) {
  const found = proxyName(proxy);
  if (!found) return null;
  const patterns = [`https://*.${found.name}/*`];
  if (found.url.protocol === "http:") patterns.push(`http://*.${found.name}/*`);
  return patterns;
}

// Sites most libraries proxy, used only to see whether a session exists.
const SESSION_PROBES = [
  "https://onlinelibrary.wiley.com/",
  "https://pubsonline.informs.org/",
  "https://www.jstor.org/",
];

// Whether the browser holds a live session with the library proxy: "in" or
// "out". Needs the permission from proxyScope().
//
// Only things a session alone produces count as "in". The absence of a
// password box does not: libraries with single sign-on answer a signed-out
// visitor with a bare page that forwards to the university's sign-in.
export async function proxySession(proxy) {
  const found = proxyName(proxy);
  if (!found) return "out";
  const { url: login, name } = found;
  const land = async (address) => {
    try {
      const response = await fetch(address, {
        credentials: "include",
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      });
      response.body?.cancel();
      return new URL(response.url);
    } catch {
      return null; // forwarded to a site we may not read (the university's sign-in), or too slow
    }
  };
  const inside = (host) => host === name || host.endsWith(`.${name}`);

  // 1. EZproxy sends someone who is already signed in from /login to /menu.
  const menu = await land(`${login.origin}/login`);
  if (menu && inside(menu.hostname) && /^\/menu\b/.test(menu.pathname)) return "in";

  // 2. Asked for a site it proxies, it hands a signed-in visitor on to the
  //    proxied copy (<site>.<name>); anyone else stays at the sign-in.
  const landings = await Promise.all(SESSION_PROBES.map((target) => land(proxied(proxy, target))));
  const handedOn = landings.some(
    (at) => at && inside(at.hostname) && at.hostname !== name && !at.hostname.startsWith("login."),
  );
  return handedOn ? "in" : "out";
}

export function citeKey(candidate) {
  const family = lastName((candidate.authors || [])[0] || "anon") || "anon";
  const year = String(candidate.year || "nd");
  const word = tokens(candidate.title)[0] || "paper";
  return `${family}${year}${word}`.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

// Path relative to the browser's Downloads folder.
export function downloadPath(candidate, subfolder) {
  const year = String(candidate.year || "nd");
  const key = citeKey(candidate) || "paper";
  const base = (subfolder || "")
    .split(/[\\/]+/)
    .map((part) => part.replace(/[:*?"<>|]+/g, "_").trim())
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  if (!base) return `${key}.pdf`;
  return `${base}/${year}/${key}.pdf`;
}

// Open-access copies of a DOI, from OpenAlex: direct PDF links, best first, and
// the open-access article page for when no location has a direct link. OpenAlex
// often lists only the page for its "best" location while a repository further
// down the list has the file.
export async function openAccess(doi) {
  let work;
  try {
    const response = await fetch(
      `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`,
      { headers: { Accept: "application/json" } },
    );
    if (!response.ok) return { pdfs: [], page: null };
    work = await response.json();
  } catch {
    return { pdfs: [], page: null };
  }
  const locations = [work.best_oa_location, ...(work.locations || [])].filter(
    (location) => location && location.is_oa !== false,
  );
  const pdfs = [...new Set(locations.map((location) => location.pdf_url).filter(Boolean))];
  const page =
    work.open_access?.oa_url ||
    locations.map((location) => location.landing_page_url).find(Boolean) ||
    null;
  return { pdfs, page: pdfs.includes(page) ? null : page };
}
