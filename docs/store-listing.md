# Chrome Web Store listing

Text to paste into the developer dashboard. Screenshots there must be 1280×800
or 640×400; the ones in `docs/screenshots` are popup-sized and need a backdrop.

## Name

Callslip (Chinese listing: 取经 Callslip)

## Summary (132 characters max)

One-click download of INFORMS articles through your library. Other papers via the publisher, library proxy, EBSCO or open access.

Chinese: INFORMS 文章一键下载，用的是你自己学校图书馆的权限。其他论文可经出版社、图书馆代理、EBSCO 或开放获取下载。

## Description

On an article in Management Science, Operations Research, M&SOM or any other INFORMS journal, click Callslip and press Enter: the paper is recognised from the page and saved as a properly named PDF. With Auto-download switched on, the click alone does it. On an issue or a search results page, the papers on the page are listed for you to pick from.

It works for other papers too. Open it on another publisher's article page, or paste any title or DOI; the paper is looked up on Crossref and the matches are listed.

It uses the access you already have. The routes to the published paper are tried at the same time and the first that answers with a PDF is downloaded; open access is the fallback:
• the PDF link of the page you are on
• the publisher's site, if you are on campus or on the university VPN
• your library's proxy (EZproxy), if you are signed in
• EBSCO, if your library has the paper there and you are signed in (it opens the paper's EBSCO page by DOI; it does not search or click there)
• an open-access copy found through OpenAlex

Files are named by first author, year and first title word, for example tukamuhabwa2015supply.pdf.

When no route works, the popup says what each one ran into and gives you a link to open the article through your library.

Why it exists: on the INFORMS site, signing in through the author's university no longer leads to a download, so every paper meant a detour through the library's databases. Callslip makes that detour for you.

Disclaimer: Callslip works only through the university sign-in you complete yourself. It is not a download service: it does not supply papers, share access, or download on anyone's behalf. Do not use it for bulk downloading; publisher licences forbid it. It saves one paper per click, has no queue or "download all", and stops at 30 papers an hour. It has no server and no analytics, and it never sees your password. Not affiliated with INFORMS, EBSCO, Crossref or OpenAlex.

Setup: on campus it needs none. Off campus, type your university's name in settings and pick it from the list of about 1,500 libraries.

## Category

Workflow & Planning (or Education)

## Single purpose

Download the PDF of a scholarly paper, recognised from the page the user is on or found by title or DOI, through the user's existing access.

## Permission justifications

- activeTab: when the user clicks the toolbar button, reads the current page's address, its article meta tags (DOI, PDF link) and article links, to recognise the paper on that page.
- downloads: saves the paper's PDF, and checks the finished download so that a sign-in page is not kept as if it were the paper.
- storage: keeps the user's settings (library proxy link, whether to use EBSCO, download folder, auto-download preferences), the last search, and the times of the papers saved in the last hour, which enforce the limit of 30 papers an hour.
- scripting: on the user's request the extension opens the paper's EBSCO page in a background tab. It reads there whether the visitor is signed in and whether the article was found. As a fallback, should the request below not be reported, it also reads the address EBSCO's own PDF viewer loaded the PDF from. It only reads: nothing on the page is filled in or clicked.
- webRequest: while that tab is open, the extension listens for the one request in which EBSCO's PDF viewer asks EBSCO's content server for the PDF, to learn its address at once instead of waiting for the viewer to finish loading it. The file is then saved from that address and the tab closed, so it is fetched once. Requests are observed only; none is blocked, redirected or modified.
- Host permissions `https://*.ebsco.com/*` and `https://content.ebscohost.com/*`: the reading and listening described above are limited to EBSCO's sites.
- Optional host permissions (`https://*/*`, `http://*/*`): never requested as a whole. When the user presses Sign in in settings, the extension asks for the one site of their own library's proxy, to read its sign-in page and show whether they are signed in. Libraries differ per user, so the site cannot be listed in advance.

## Data usage

Collects no user data. The search text goes to Crossref and the DOI to OpenAlex to perform the lookup the user asked for; the settings page fetches a public list of library proxies from libproxy-db.org when the user searches for their university. Nothing is sent to the developer. No remote code.

## Privacy policy

Link to PRIVACY.md in the public repository.
