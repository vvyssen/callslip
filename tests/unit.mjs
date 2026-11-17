// Unit checks for the pure helpers in extension/lib.js.  node unit.mjs <extensionDir>
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const lib = await import(pathToFileURL(join(process.argv[2], "lib.js")).href);
let failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};
const near = (name, got, lo, hi) => {
  const ok = got >= lo && got <= hi;
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${got.toFixed(3)}, expected ${lo}..${hi})`);
};

// proxy link clean-up
const P = "https://login.ezproxy.uni.edu/login?url=";
eq("proxy: already a prefix", lib.normalizeProxy(P), P);
eq("proxy: bare host", lib.normalizeProxy("login.ezproxy.uni.edu"), P);
eq("proxy: sign-in page", lib.normalizeProxy("https://login.ezproxy.uni.edu/login"), P);
eq("proxy: full proxied link pasted", lib.normalizeProxy(P + "https://www.jstor.org/stable/1?seq=2&url=x"), P);
eq("proxy: OCLC-hosted", lib.normalizeProxy("https://uni.idm.oclc.org/login?url=https://a.b/c"), "https://uni.idm.oclc.org/login?url=");
eq("proxy: qurl kept", lib.normalizeProxy("https://ezproxy.uni.edu/login?qurl=https%3A%2F%2Fa"), "https://ezproxy.uni.edu/login?qurl=");
eq("proxy: OpenAthens redirector", lib.normalizeProxy("https://go.openathens.net/redirector/uni.edu"), "https://go.openathens.net/redirector/uni.edu?url=");
eq("proxy: template kept", lib.normalizeProxy("https://x.edu/go?to={url}&v=1"), "https://x.edu/go?to={url}&v=1");
eq("proxy: blank", lib.normalizeProxy("   "), "");
const T = "https://onlinelibrary.wiley.com/doi/pdfdirect/10.1111/poms.12848";
eq("proxied: EZproxy raw", lib.proxied(P, T), P + T);
eq("proxied: qurl encoded", lib.proxied("https://e.edu/login?qurl=", T), "https://e.edu/login?qurl=" + encodeURIComponent(T));
eq("proxied: OpenAthens encoded", lib.proxied("https://go.openathens.net/redirector/uni.edu?url=", T), "https://go.openathens.net/redirector/uni.edu?url=" + encodeURIComponent(T));
eq("proxied: template", lib.proxied("https://x.edu/go?to={url}&v=1", T), "https://x.edu/go?to=" + encodeURIComponent(T) + "&v=1");

// publishers
eq("publisher: Wiley", lib.publisherPdfUrl("10.1111/poms.12848"), T);
eq("publisher: Nature strips the prefix", lib.publisherPdfUrl("10.1038/s41586-020-2649-2"), "https://www.nature.com/articles/s41586-020-2649-2.pdf");
eq("publisher: IOP", lib.publisherPdfUrl("10.1088/1674-1137/aea108"), "https://iopscience.iop.org/article/10.1088/1674-1137/aea108/pdf");
eq("publisher: T&F short label", lib.publisherOf("10.1080/00207543.2015.1037934").short, "T&F");
eq("publisher: unknown prefix", lib.publisherPdfUrl("10.1016/j.ijpe.2018.01.001"), null);
eq("publisher: prefix match is case-insensitive", lib.publisherOf("10.1002/ABC").name, "Wiley");

// DOI parsing
eq("doi: link", lib.parseDoi("https://doi.org/10.1371/journal.pone.0115253"), "10.1371/journal.pone.0115253");
eq("doi: trailing punctuation", lib.parseDoi("see doi:10.1111/poms.12848)."), "10.1111/poms.12848");
eq("doi: a title is not a DOI", lib.parseDoi("Supply chain resilience in 10 steps"), null);

// matching
eq("similarity: identical after normalising", lib.titleSimilarity("Supply-Chain Resilience: A Review", "supply chain resilience – a review"), 1);
near("similarity: one-word title inside a long query stays low", lib.titleSimilarity("Supply chain resilience under disruption risk and uncertainty", "Resilience"), 0, 0.5);
near("similarity: dropped subtitle still high", lib.titleSimilarity("Supply chain resilience: definition, review and theoretical foundations", "Supply chain resilience"), 0.55, 0.92);
near("similarity: unrelated", lib.titleSimilarity("Supply chain resilience", "Deep learning for protein folding"), 0, 0.3);
const scored = lib.scoreCandidate({ title: "Supply chain resilience", year: "2015", author: "J. Busby" }, { title: "Supply chain resilience", year: 2015, authors: ["Jerry Busby"] });
eq("score: capped at 1", scored.score, 1);
const bonus = lib.scoreCandidate({ title: "Supply chain resilience review", year: "2015" }, { title: "Supply chain resilience", year: 2016, authors: [] });
near("score: year within one adds the bonus", bonus.score - bonus.titleScore, 0.049, 0.051);

// file names
eq("citekey", lib.citeKey({ authors: ["Benjamin R. Tukamuhabwa"], year: 2015, title: "The supply chain" }), "tukamuhabwa2015supply");
eq("path: no folder", lib.downloadPath({ authors: ["A Smith"], year: 2018, title: "Supply" }, ""), "smith2018supply.pdf");
eq("path: folder adds the year", lib.downloadPath({ authors: ["A Smith"], year: 2018, title: "Supply" }, "Papers"), "Papers/2018/smith2018supply.pdf");
eq("path: cannot climb out of Downloads", lib.downloadPath({ authors: ["A Smith"], year: 2018, title: "Supply" }, "../../etc/./x"), "etc/x/2018/smith2018supply.pdf");
eq("path: no year", lib.downloadPath({ authors: [], year: null, title: "" }, ""), "anonndpaper.pdf");

console.log(failed ? `\n${failed} FAILED` : "\nALL UNIT CHECKS PASSED");
process.exit(failed ? 1 : 0);
