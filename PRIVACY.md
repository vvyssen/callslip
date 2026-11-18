# Privacy

Callslip has no server of its own, no account, no analytics and no advertising. Nothing is sent to its authors.

## What leaves your browser, and where it goes

| When | What | To |
| --- | --- | --- |
| You search | The title, author and year you typed, or the DOI | Crossref (`api.crossref.org`) |
| You download | The DOI of the paper | OpenAlex (`api.openalex.org`), to look for an open-access copy |
| You download | An ordinary download request for the PDF | The publisher, your library's proxy, or EBSCO |
| The settings page is open, and you allowed it | Requests to your library proxy's own sign-in address, to see whether you are signed in. Nothing about you is added to them. | Your library's proxy |
| You search for your university in settings | A request for the public list of library proxies. What you type is matched in your browser and is not sent. | libproxy-db.org |

The download requests are the same ones your browser would make if you clicked the link yourself, and they carry the sessions you are already signed in to. Callslip does not read, copy or store your cookies or passwords.

## What it reads

When you click the Callslip button, it reads the page that tab is showing: its address, the tags that name the article (DOI, PDF link) and the article links on the page. This is how it recognises the paper you are looking at. It happens only on that click, only for that tab, and what it reads stays in your browser apart from the DOI lookup above.

## What is stored, and where

- Your settings (proxy link, whether to use EBSCO, download folder, auto-download preferences) are kept in the browser's extension storage on your computer.
- The times at which papers were saved in the last hour are kept there too. They are what the limit of 30 papers an hour is counted from. No titles or DOIs are kept with them.
- The last search, the last download's progress and the DOIs of the papers saved are kept until you close the browser, so the popup can show them when reopened and auto-download does not fetch the same paper twice.

Nothing else is stored. Removing the extension removes all of it.

## Permissions

- Your library proxy's site (optional, asked for the first time you press Sign in in settings): read the proxy's sign-in page, so the settings page can show whether you are signed in and sign you out. If you decline, downloads work the same; only that indicator is missing.
- `activeTab`: read the page you click the button on, as described above. It gives no access to your other tabs or your browsing history.
- `downloads`: save the PDF and check that what arrived is a PDF.
- `storage`: keep the settings above.
- `scripting` on `ebsco.com`: in the background tab the extension opens on the paper's EBSCO page, read whether you are signed in and whether EBSCO has the article (and, only if the browser did not report it, which address EBSCO's viewer loaded the PDF from). Nothing on the page is filled in or clicked, and the tab is closed afterwards.
- `webRequest`, on EBSCO's sites only: while that tab is open, be told which address EBSCO's viewer asks for the PDF at. Requests are only observed; none is blocked or changed.
