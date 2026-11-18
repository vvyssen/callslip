# Chrome Web Store listing

Text to paste into the developer dashboard. Screenshots there must be 1280×800
or 640×400; the ones in `docs/screenshots` are popup-sized and need a backdrop.

## Name

Paper Fetch

## Summary (132 characters max)

One-click PDFs for INFORMS journals. Other papers through the publisher, your library proxy, EBSCO, or open access.

## Description

On an article in Management Science, Operations Research, M&SOM or any other INFORMS journal, click Paper Fetch and press Enter: the paper is recognised from the page and saved as a properly named PDF. On an issue or a search results page, the papers on the page are listed for you to pick from.

It works for other papers too. Open it on another publisher's article page, or paste any title or DOI; the paper is looked up on Crossref and the matches are listed.

It uses the access you already have. The routes to the published paper are tried at the same time and the first that answers with a PDF is downloaded; open access is the fallback:
• the PDF link of the page you are on
• the publisher's site, if you are on campus or on the university VPN
• your library's proxy (EZproxy), if you are signed in
• EBSCO, if your library subscribes
• an open-access copy found through OpenAlex

Files are named by first author, year and first title word, for example tukamuhabwa2015supply.pdf.

When no route works, the popup says what each one ran into and gives you a link to open the article through your library.

Why it exists: on the INFORMS site, signing in through the author's university no longer leads to a download, so every paper meant a detour through the library's databases. Paper Fetch makes that detour for you.

Disclaimer: Paper Fetch works only through the university sign-in you complete yourself. It is not a download service: it does not supply papers, share access, or download on anyone's behalf. Do not use it for bulk downloading; publisher licences forbid it. It has no server and no analytics, and it never sees your password. Not affiliated with INFORMS, EBSCO, Crossref or OpenAlex.

Setup: on campus it needs none. Off campus, type your university's name in settings and pick it from the list of about 1,500 libraries.

## Category

Workflow & Planning (or Education)

## Single purpose

Download the PDF of a scholarly paper, recognised from the page the user is on or found by title or DOI, through the user's existing access.

## Permission justifications

- activeTab: when the user clicks the toolbar button, reads the current page's address, its article meta tags (DOI, PDF link) and article links, to recognise the paper on that page.
- downloads: saves the paper's PDF, and checks the finished download so that a sign-in page is not kept as if it were the paper.
- storage: keeps the user's settings (library proxy link, EBSCO customer code, download folder, auto-download preferences) and the last search.
- scripting: runs the search and presses the download button on the EBSCO page in a background tab, on the user's request.
- Host permission `https://*.ebsco.com/*`: the scripting above is limited to EBSCO's site.
- Optional host permissions (`https://*/*`, `http://*/*`): never requested as a whole. When the user presses Sign in in settings, the extension asks for the one site of their own library's proxy, to read its sign-in page and show whether they are signed in. Libraries differ per user, so the site cannot be listed in advance.

## Data usage

Collects no user data. The search text goes to Crossref and the DOI to OpenAlex to perform the lookup the user asked for; the settings page fetches a public list of library proxies from libproxy-db.org when the user searches for their university. Nothing is sent to the developer. No remote code.

## Privacy policy

Link to PRIVACY.md in the public repository.
