# Privacy

Paper Fetch has no server of its own, no account, no analytics and no advertising. Nothing is sent to its authors.

## What leaves your browser, and where it goes

| When | What | To |
| --- | --- | --- |
| You search | The title, author and year you typed, or the DOI | Crossref (`api.crossref.org`) |
| You download | The DOI of the paper | OpenAlex (`api.openalex.org`), to look for an open-access copy |
| You download | An ordinary download request for the PDF | The publisher, your library's proxy, or EBSCO |
| You search for your university in settings | A request for the public list of library proxies. What you type is matched in your browser and is not sent. | libproxy-db.org |

The download requests are the same ones your browser would make if you clicked the link yourself, and they carry the sessions you are already signed in to. Paper Fetch does not read, copy or store your cookies or passwords.

## What it reads

When you click the Paper Fetch button, it reads the page that tab is showing: its address, the tags that name the article (DOI, PDF link) and the article links on the page. This is how it recognises the paper you are looking at. It happens only on that click, only for that tab, and what it reads stays in your browser apart from the DOI lookup above.

## What is stored, and where

- Your settings (proxy link, EBSCO customer code, download folder, auto-download preferences) are kept in the browser's extension storage on your computer.
- The last search and the last download's progress are kept until you close the browser, so the popup can show them when reopened.

Nothing else is stored. Removing the extension removes all of it.

## Permissions

- `activeTab`: read the page you click the button on, as described above. It gives no access to your other tabs or your browsing history.
- `downloads`: save the PDF and check that what arrived is a PDF.
- `storage`: keep the settings above.
- `scripting` on `ebsco.com`: fill in the search box and press the download button on the EBSCO page, in a background tab the extension opens and closes itself.
