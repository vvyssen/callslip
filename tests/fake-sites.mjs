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
//   research.ebsco.com              the EBSCO search app
//   libproxy-db.org                 the public directory of library proxies
//
// The stand-ins carry the same handles the extension looks for on the real
// sites: Dublin Core / citation_* meta tags, /doi/ links, EBSCO's search box
// id, its "Search"/"Download" buttons and the format radios in its dialog.
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
  "research.ebsco.com",
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

function informsArticle(doi) {
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
     <meta name="dc.Identifier" scheme="doi" content="${doi}">`,
  );
}

function informsIssue() {
  const items = INFORMS.map(
    (item) => `<div class="issue-item">
      <h5 class="issue-item__title"><a href="/doi/${item.doi}">${item.title}</a></h5>
      <a href="/doi/abs/${item.doi}">Abstract</a> <a href="/doi/pdf/${item.doi}">PDF</a> <a href="/doi/epdf/${item.doi}">Full text PDF</a>
    </div>`,
  ).join("");
  return page("Management Science: Vol 66, No 1", `<h1>Management Science</h1>${items}`);
}

export async function startFakeSites({ dir, port, ebscoTitle }) {
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=paper-fetch-test",
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
  ], { stdio: "ignore" });
  const hits = [];

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
      // What INFORMS serves, whichever host it is reached on.
      const informs = (pdfAllowed) => {
        if (path.startsWith("/toc/")) return send(informsIssue());
        if (path.startsWith("/doi/pdf/")) return pdfAllowed ? pdf("informs.pdf") : paywall();
        const doi = path.match(/10\.1287\/[^/]+$/);
        return doi ? send(informsArticle(doi[0])) : paywall();
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

      if (host === "research.ebsco.com") {
        if (path === "/") return redirect("/c/test1/search");
        if (path === "/c/test1/search" || path === "/c/test1/search/advanced") {
          // Results render in place, like the real single-page app. A DOI finds
          // nothing, so the extension has to fall back to the title.
          return send(page("EBSCO", `
            <textarea id="search-autocomplete-1-input"></textarea>
            <button id="go">Search</button>
            <div id="out"></div>
            <script>
              document.getElementById('go').addEventListener('click', () => {
                const q = document.getElementById('search-autocomplete-1-input').value;
                history.pushState({}, '', '/c/test1/search/results?q=' + encodeURIComponent(q));
                const out = document.getElementById('out');
                if (/^10\\./.test(q)) { out.textContent = '0 total results'; return; }
                setTimeout(() => {
                  out.innerHTML = '<a href="/c/test1/search/details/wrong1">An unrelated paper about something else</a><br>'
                    + '<span>PDF Full Text</span> <a href="/c/test1/search/details/right1">${ebscoTitle}</a>';
                }, 600);
              });
            </script>`));
        }
        if (path.startsWith("/c/test1/search/details/")) {
          const id = path.split("/").pop();
          // The full-text marker appears late, and the dialog opens with a
          // format other than PDF selected.
          return send(page("EBSCO record", `
            <h1>${id === "right1" ? ebscoTitle : "An unrelated paper"}</h1>
            <div id="ft"></div>
            <button id="open">Download</button>
            <div id="modal" hidden>
              <label><input type="radio" name="fmt" value="epub" checked> EPUB</label>
              <label><input type="radio" name="fmt" value="pdf"> PDF</label>
              <button id="confirm">Download</button>
            </div>
            <script>
              setTimeout(() => { document.getElementById('ft').textContent = 'PDF Full Text'; }, 500);
              document.getElementById('open').addEventListener('click', () => { document.getElementById('modal').hidden = false; });
              document.getElementById('confirm').addEventListener('click', () => {
                const a = document.createElement('a');
                a.href = '/file/${id}?fmt=' + document.querySelector('input[name=fmt]:checked').value;
                a.download = '';
                document.body.append(a);
                a.click();
              });
            </script>`));
        }
        if (path.startsWith("/file/")) {
          if (url.searchParams.get("fmt") === "pdf") return pdf("EBSCO-FullText.pdf");
          return send(Buffer.alloc(30000, 1), "application/epub+zip", { "Content-Disposition": 'attachment; filename="wrong.epub"' });
        }
      }

      res.writeHead(404);
      res.end("not found");
    },
  );
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    hits,
    close: () => server.close(),
    // Sends every stand-in host to this server and everything else straight to
    // the network (a system proxy would look the names up itself).
    chromeArgs: [
      `--host-resolver-rules=${HOSTS.map((name) => `MAP ${name} 127.0.0.1:${port}`).join(", ")}`,
      "--no-proxy-server",
      "--ignore-certificate-errors",
    ],
  };
}
