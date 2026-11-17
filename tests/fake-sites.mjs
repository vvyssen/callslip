// Stand-ins for the sites that need a library login, so the download routes
// can be run end to end without one. One HTTPS server answers for several
// host names; Chrome is pointed at it with --host-resolver-rules.
//
//   www.tandfonline.com                   a publisher that answers with a paywall page
//   login.ezproxy.test-uni.edu            an EZproxy sign-in host
//   www-tandfonline-com.ezproxy.test-uni.edu   the same publisher, through the proxy
//   research.ebsco.com                    the EBSCO search app
//
// The EBSCO stand-in has the same handles the extension drives on the real
// site: the search box id, "Search"/"Download" buttons, /search/details/ links
// and the format radios in the download dialog.
import https from "node:https";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const HOSTS = [
  "www.tandfonline.com",
  "login.ezproxy.test-uni.edu",
  "www-tandfonline-com.ezproxy.test-uni.edu",
  "research.ebsco.com",
];
export const PROXY_LINK = "https://login.ezproxy.test-uni.edu/login?url=";

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n% paper-fetch test file\n"), Buffer.alloc(40000, 0x20)]);
const page = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

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
      const signedIn = /(^|;\s*)ezproxy=1/.test(req.headers.cookie || "");
      hits.push(`${host}${url.pathname}${url.search}`);
      const html = (title, body) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page(title, body));
      };
      const pdf = (name) => {
        res.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${name}"`,
          "Content-Length": PDF.length,
        });
        res.end(PDF);
      };
      const redirect = (to) => {
        res.writeHead(302, { Location: to });
        res.end();
      };

      if (host === "www.tandfonline.com") {
        return html("Access options", "<h1>Get access</h1><p>Log in via your institution.</p>");
      }

      if (host === "login.ezproxy.test-uni.edu") {
        if (url.searchParams.has("signin")) {
          // No SameSite attribute, like a default EZproxy session cookie.
          res.writeHead(200, {
            "Content-Type": "text/html",
            "Set-Cookie": "ezproxy=1; Path=/; Domain=ezproxy.test-uni.edu; Secure",
          });
          return res.end(page("Signed in", "ok"));
        }
        const target = url.search.startsWith("?url=") ? url.search.slice(5) : "";
        if (!signedIn || !target) return html("Library sign-in", "<form><input name='user'><input name='pass' type='password'></form>");
        const wanted = new URL(target);
        return redirect(`https://${wanted.hostname.replaceAll(".", "-")}.ezproxy.test-uni.edu${wanted.pathname}${wanted.search}`);
      }

      if (host === "www-tandfonline-com.ezproxy.test-uni.edu") {
        if (!signedIn) return redirect("https://login.ezproxy.test-uni.edu/login");
        return pdf("proxied.pdf");
      }

      if (host === "research.ebsco.com") {
        if (url.pathname === "/") return redirect("/c/test1/search");
        if (url.pathname === "/c/test1/search" || url.pathname === "/c/test1/search/advanced") {
          // Results render in place, like the real single-page app. A DOI finds
          // nothing, so the extension has to fall back to the title.
          return html("EBSCO", `
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
            </script>`);
        }
        if (url.pathname.startsWith("/c/test1/search/details/")) {
          const id = url.pathname.split("/").pop();
          // The full-text marker appears late, and the dialog opens with a
          // format other than PDF selected.
          return html("EBSCO record", `
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
            </script>`);
        }
        if (url.pathname.startsWith("/file/")) {
          if (url.searchParams.get("fmt") === "pdf") return pdf("EBSCO-FullText.pdf");
          res.writeHead(200, { "Content-Type": "application/epub+zip", "Content-Disposition": 'attachment; filename="wrong.epub"' });
          return res.end(Buffer.alloc(30000, 1));
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
    // Sends every stand-in host to this server; goes straight to the network
    // for everything else (a system proxy would look the names up itself).
    chromeArgs: [
      `--host-resolver-rules=${HOSTS.map((name) => `MAP ${name} 127.0.0.1:${port}`).join(", ")}`,
      "--no-proxy-server",
      "--ignore-certificate-errors",
    ],
  };
}
