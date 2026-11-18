// Stand-ins for the sites that need a library login, so the download routes
// can be run end to end without one. One HTTPS server answers for several
// host names; Chrome is pointed at it with --host-resolver-rules.
//
//   pubsonline.informs.org          INFORMS: article pages, an issue, PDFs behind a paywall
//   www.tandfonline.com             another publisher that answers with a paywall page
//   login.ezproxy.test-uni.edu      an EZproxy sign-in host
//   <site>.ezproxy.test-uni.edu     the publishers above, read through that proxy
//   login.ezproxy.other-uni.edu     a second proxy that never shows a menu page
//   journal.example-press.org       a publisher we have no address pattern for
//   openurl.ebsco.com               EBSCO's public door: one address per article
//   research.ebsco.com              EBSCO's PDF viewer and record pages
//   content.ebscohost.com           where that viewer loads the PDF from
//   libproxy-db.org                 the public directory of library proxies
//
// The stand-ins carry the same handles the extension looks for on the real
// sites: Dublin Core / citation_* meta tags, /doi/ links, and for EBSCO the
// addresses its door forwards to and the sign-in flag in the door page's data.
// EBSCO's pages also report any click or keystroke they receive, so a test can
// show that the extension only reads them.
import https from "node:https";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PROXY_LINK = "https://login.ezproxy.test-uni.edu/login?url=";
export const OTHER_PROXY_LINK = "https://login.ezproxy.other-uni.edu/login?url=";
const PROXY = "ezproxy.test-uni.edu";
// Sends a signed-in visitor of /login to /menu, as EZproxy does by default.
// The other one keeps them on /login, so only being handed on to a proxied
// site shows there is a session.
const PROXIES = { [PROXY]: { menu: true }, "ezproxy.other-uni.edu": { menu: false } };
const HOSTS = [
  "pubsonline.informs.org",
  "www.tandfonline.com",
  `login.${PROXY}`,
  `pubsonline-informs-org.${PROXY}`,
  `www-tandfonline-com.${PROXY}`,
  "login.ezproxy.other-uni.edu",
  "pubsonline-informs-org.ezproxy.other-uni.edu",
  "journal.example-press.org",
  "openurl.ebsco.com",
  "research.ebsco.com",
  "content.ebscohost.com",
  "libproxy-db.org",
];
// A real click on the toolbar button lets the extension read the tab it was
// clicked on. The tests open the popup as a tab instead, so their copy of the
// extension is given these pages outright.
export const PAGE_PERMISSIONS = [
  "https://pubsonline.informs.org/*",
  `https://*.${PROXY}/*`,
  "https://*.ezproxy.other-uni.edu/*",
  "https://journal.example-press.org/*",
];

// Real papers, so that Crossref recognises their DOIs.
export const INFORMS = [
  { doi: "10.1287/mnsc.2018.3063", title: "A Sharp Test of the Portability of Expertise", file: "green2019sharp.pdf" },
  { doi: "10.1287/mnsc.2019.3426", title: "The Uncertain Value of Uncertainty: When Consumers Are Unwilling to Pay for What They Like", file: "moon2020uncertain.pdf" },
  { doi: "10.1287/mnsc.2019.3400", title: "How Stress Affects Performance and Competitiveness Across Gender", file: "cahlikova2020how.pdf" },
];
export const NO_PATTERN = {
  doi: "10.1016/j.ijpe.2017.12.006",
  title: "On technical inefficiency indicators at the industry level",
  page: "https://journal.example-press.org/article/1",
  file: "fare2018technical.pdf",
};

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n% paper-fetch test file\n"), Buffer.alloc(40000, 0x20)]);
const page = (title, body, head = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

function informsArticle(doi, { stalled = false } = {}) {
  const paper = INFORMS.find((item) => item.doi === doi) || { doi, title: "Untitled" };
  const related = INFORMS.filter((item) => item.doi !== doi)
    .map((item) => `<li><a href="/doi/${item.doi}">${item.title}</a></li>`)
    .join("");
  return page(
    `${paper.title} | Management Science`,
    `<h1>${paper.title}</h1>
     <a href="/doi/pdf/${doi}">PDF</a> <a href="/doi/epdf/${doi}">View PDF</a>
     <h2>Related</h2><ul>${related}</ul>`,
    // As on the real site: the first dc.Identifier is not the DOI.
    `<meta name="dc.Title" content="${paper.title}">
     <meta name="dc.Identifier" scheme="publisher-id" content="${doi.split("/")[1]}">
     <meta name="dc.Identifier" scheme="doi" content="${doi}">${stalled ? STALLED_SCRIPT : ""}`,
  );
}

function informsIssue({ stalled = false } = {}) {
  const items = INFORMS.map(
    (item) => `<div class="issue-item">
      <h5 class="issue-item__title"><a href="/doi/${item.doi}">${item.title}</a></h5>
      <a href="/doi/abs/${item.doi}">Abstract</a> <a href="/doi/pdf/${item.doi}">PDF</a> <a href="/doi/epdf/${item.doi}">Full text PDF</a>
    </div>`,
  );
  if (!stalled) return page("Management Science: Vol 66, No 1", `<h1>Management Science</h1>${items.join("")}`);
  return page(
    "Management Science: Vol 66, No 1",
    `<h1>Management Science</h1>${items[0]}<!--more-->${items.slice(1).join("")}${STALLED_SCRIPT}`,
  );
}

// What a slow connection does to a real article page: the tags in <head> are
// there at once, then a script the page waits for holds everything else up, so
// the page stays "loading" long after it has shown its title.
const STALLED_SCRIPT = '<script src="/stalled.js"></script>';

// Reports clicks, keystrokes and form input on an EBSCO stand-in page.
const WATCH = `for (const type of ['click', 'keydown', 'input', 'change', 'submit']) {
  document.addEventListener(type, () => fetch('/touched?by=' + type), true);
}`;
const MANAGEMENT_SCIENCE = ["0025-1909", "1526-5501"];

// What the EBSCO stand-in holds:
//   ebscoDoi     an article with PDF full text, known by its DOI
//   INFORMS[0]   the same
//   INFORMS[1]   a record without full text
//   INFORMS[2]   full text, but the record has no DOI: journal, volume and page find it
export async function startFakeSites({ dir, port, ebscoDoi }) {
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=paper-fetch-test",
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
  ], { stdio: "ignore" });
  const hits = [];
  // Set by a test to make one host's PDF link behave differently for a while:
  //   delay  wait this long before answering
  //   pdf    serve the PDF where a paywall page would be
  //   cut    start sending a PDF, then drop the connection
  // behave.ebsco = { signedOut: true } makes EBSCO treat the visitor as a stranger.
  const behave = {};
  const withPdf = { [ebscoDoi]: "right1", [INFORMS[0].doi]: "informs0" };
  const withoutPdf = { [INFORMS[1].doi]: "nopdf1" };

  const server = https.createServer(
    { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
    (req, res) => {
      const host = req.headers.host;
      const url = new URL(req.url, `https://${host}`);
      const path = decodeURIComponent(url.pathname);
      const proxy = Object.keys(PROXIES).find((name) => host.endsWith(`.${name}`));
      const signedIn = /(^|;\s*)ezproxy=1/.test(req.headers.cookie || "");
      hits.push(`${host}${url.pathname}${url.search}`);
      const send = (body, type = "text/html; charset=utf-8", extra = {}) => {
        res.writeHead(200, { "Content-Type": type, ...extra });
        res.end(body);
      };
      const pdf = (name) => send(PDF, "application/pdf", {
        "Content-Disposition": `attachment; filename="${name}"`,
        "Content-Length": PDF.length,
      });
      const redirect = (to) => {
        res.writeHead(302, { Location: to });
        res.end();
      };
      const paywall = () => send(page("Access options", "<h1>Get access</h1><p>Log in via your institution.</p>"));
      // A script that never arrives within the test.
      if (path === "/stalled.js") return void setTimeout(() => send("", "text/javascript"), 60000);
      const rule = behave[host];
      if (rule && path.startsWith("/doi/pdf/")) {
        return void setTimeout(() => {
          if (rule.cut) {
            res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": PDF.length });
            res.write(PDF.subarray(0, 2000));
            return void setTimeout(() => res.destroy(), 300);
          }
          return rule.pdf ? pdf("direct.pdf") : paywall();
        }, rule.delay || 0);
      }
      // What INFORMS serves, whichever host it is reached on.
      const informs = (pdfAllowed) => {
        if (path.startsWith("/toc/")) {
          if (!url.searchParams.has("slow")) return send(informsIssue());
          // The list arrives in two parts with a pause between them, and the
          // page never finishes loading.
          const [first, rest] = informsIssue({ stalled: true }).split("<!--more-->");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.write(first);
          return void setTimeout(() => res.end(rest), 2500);
        }
        if (path.startsWith("/doi/pdf/")) return pdfAllowed ? pdf("informs.pdf") : paywall();
        const doi = path.match(/10\.1287\/[^/]+$/);
        return doi ? send(informsArticle(doi[0], { stalled: url.searchParams.has("slow") })) : paywall();
      };

      if (host === "pubsonline.informs.org") return informs(false);
      if (host === "www.tandfonline.com") return paywall();

      if (proxy && host === `login.${proxy}`) {
        // What a library with single sign-on answers a signed-out visitor: no
        // password box, just a form that posts itself to the university.
        const signInPage = () => send(page("Library sign-in",
          `<form method="post" action="https://sso.${proxy.split(".").slice(1).join(".")}/idp"><input type="hidden" name="SAMLRequest" value="x"></form>`));
        if (url.searchParams.has("signin")) {
          // No SameSite attribute, like a default EZproxy session cookie.
          return send(page("Signed in", "ok"), "text/html", {
            "Set-Cookie": `ezproxy=1; Path=/; Domain=${proxy}; Secure`,
          });
        }
        if (path === "/logout") {
          return send(page("Signed out", "You have signed out."), "text/html", {
            "Set-Cookie": `ezproxy=; Path=/; Domain=${proxy}; Secure; Max-Age=0`,
          });
        }
        if (!signedIn) return signInPage();
        if (path === "/menu") return send(page("Library databases", '<a href="/logout">Logout</a>'));
        const target = url.search.startsWith("?url=") ? url.search.slice(5) : "";
        if (!target) return PROXIES[proxy].menu ? redirect("/menu") : send(page("Library", "Welcome back."));
        const wanted = new URL(target);
        return redirect(`https://${wanted.hostname.replaceAll(".", "-")}.${proxy}${wanted.pathname}${wanted.search}`);
      }

      if (proxy) {
        if (!signedIn) return redirect(`https://login.${proxy}/login`);
        if (host.startsWith("pubsonline-informs-org.")) return informs(true);
        return path.startsWith("/doi/pdf/") ? pdf("proxied.pdf") : paywall();
      }

      if (host === "journal.example-press.org") {
        if (path === "/files/paper.pdf") return pdf("paper.pdf");
        return send(page(
          NO_PATTERN.title,
          `<h1>${NO_PATTERN.title}</h1>`,
          `<meta name="citation_title" content="${NO_PATTERN.title}">
           <meta name="citation_doi" content="${NO_PATTERN.doi}">
           <meta name="citation_pdf_url" content="https://journal.example-press.org/files/paper.pdf">`,
        ));
      }

      if (host === "libproxy-db.org") {
        return send(JSON.stringify([
          { name: "Another Test College", url: "http://proxy.another-test.edu/login?qurl=$@", country: "Testland" },
          { name: "Odd Proxy Institute", url: "https://odd-proxy.example.edu/menu?option=x", country: "Testland" },
          { name: "Test University", url: `${PROXY_LINK}$@`, country: "Testland" },
        ]), "application/json", { "Access-Control-Allow-Origin": "*" });
      }

      if (path === "/touched") return send("", "text/plain");

      if (host === "openurl.ebsco.com") {
        const signedOut = Boolean(behave.ebsco?.signedOut);
        // Like the real page: the sign-in state is in the page's data, and the
        // page moves on by itself a moment after it has loaded.
        const door = (title, body, then = "") => send(page(title, `
          <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { isAuthenticated: !signedOut } })}</script>
          <p>Connecting you to content on EBSCOhost</p>${body}
          <script>${WATCH}${then}</script>`));
        let target = null;
        if (path.startsWith("/contentitem/doi:")) {
          const doi = path.slice("/contentitem/doi:".length);
          if (withPdf[doi]) target = `/viewer/pdf/${withPdf[doi]}?route=details`;
          else if (withoutPdf[doi]) target = `/search/details/${withoutPdf[doi]}?db=test`;
        } else if (path === "/openurl") {
          const known = MANAGEMENT_SCIENCE.includes(url.searchParams.get("issn")) && url.searchParams.get("volume") && url.searchParams.get("spage");
          if (known) target = "/viewer/pdf/byissue1?route=details";
        }
        if (signedOut) {
          return door("EBSCOhost", "<h1>Access on EBSCOhost through your institution</h1><button>Sign in at EBSCOhost</button>");
        }
        if (!target) {
          return door("Detail - OpenURL Connection - EBSCO", '<p id="state"></p>', `
            setTimeout(() => {
              history.replaceState({}, '', '/not_found/detailv2');
              document.getElementById('state').textContent = 'Item not found';
            }, 700);`);
        }
        return door("Results - OpenURL Connection - EBSCO", "", `
          setTimeout(() => { location.href = 'https://research.ebsco.com/c/test1${target}'; }, 700);`);
      }

      if (host === "research.ebsco.com") {
        if (path === "/") return redirect("/c/test1/search");
        if (path === "/c/test1/search") return send(page("EBSCO", "<h1>EBSCOhost</h1>"));
        const viewer = path.match(/^\/c\/test1\/viewer\/pdf\/([^/]+)$/);
        if (viewer) {
          // The viewer fetches the PDF itself, a moment after the page is up.
          return send(page("EBSCO", `
            <h1>PDF viewer</h1><button>Download</button>
            <script>${WATCH}
              setTimeout(() => fetch('https://content.ebscohost.com/cds/retrieve?content=${viewer[1]}').then((answer) => answer.blob()), 500);
            </script>`));
        }
        if (path.startsWith("/c/test1/search/details/")) {
          return send(page("Record details", `<h1>A record without full text</h1><button>Access options</button><script>${WATCH}</script>`));
        }
      }

      if (host === "content.ebscohost.com" && path === "/cds/retrieve") {
        // As EBSCO sends it: no file name, readable from any page.
        return send(PDF, "application/pdf", { "Content-Length": PDF.length, "Access-Control-Allow-Origin": "*" });
      }

      res.writeHead(404);
      res.end("not found");
    },
  );
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    hits,
    behave,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
    // Sends every stand-in host to this server and everything else straight to
    // the network (a system proxy would look the names up itself).
    chromeArgs: [
      `--host-resolver-rules=${HOSTS.map((name) => `MAP ${name} 127.0.0.1:${port}`).join(", ")}`,
      "--no-proxy-server",
      "--ignore-certificate-errors",
    ],
  };
}
