# Chrome Web Store listing

Text to paste into the developer dashboard. Screenshots there must be 1280×800
or 640×400; the ones in `docs/screenshots` are popup-sized and need a backdrop.

## Name

Paper Fetch

## Summary (132 characters max)

Paste a paper's title or DOI and save the PDF through your campus network, library proxy, EBSCO, or an open-access copy.

## Description

Paste a paper's title or DOI. Paper Fetch looks it up on Crossref, shows the matches, and saves the PDF using the access you already have.

It tries four routes in order and stops at the first that returns a PDF:
• the publisher's site, if you are on campus or on the university VPN
• your library's proxy (EZproxy), if you are signed in
• EBSCO, if your library subscribes
• an open-access copy found through OpenAlex

Files are named by first author, year and first title word, for example tukamuhabwa2015supply.pdf.

When no route works, the popup says what each one ran into and gives you a link to open the article through your library.

Paper Fetch does not get around paywalls. It only reaches what your own library subscriptions or open access already give you. It has no server and no analytics, and it never sees your password.

Setup: on campus it needs none. Off campus, paste your library's proxy sign-in link into the settings page.

## Category

Workflow & Planning (or Education)

## Single purpose

Find a scholarly paper by title or DOI and download its PDF through the user's existing access.

## Permission justifications

- downloads: saves the paper's PDF, and checks the finished download so that a sign-in page is not kept as if it were the paper.
- storage: keeps the user's settings (library proxy link, EBSCO customer code, download folder, auto-download preferences) and the last search.
- scripting: runs the search and presses the download button on the EBSCO page in a background tab, on the user's request.
- Host permission `https://*.ebsco.com/*`: the scripting above is limited to EBSCO's site.

## Data usage

Collects no user data. The search text goes to Crossref and the DOI to OpenAlex to perform the lookup the user asked for; nothing is sent to the developer. No remote code.

## Privacy policy

Link to PRIVACY.md in the public repository.
