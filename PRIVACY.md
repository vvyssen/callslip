# Privacy

paper-fetch has no server of its own, no account, no analytics and no advertising. Nothing is sent to its authors.

## What leaves your browser, and where it goes

| When | What | To |
| --- | --- | --- |
| You search | The title, author and year you typed, or the DOI | Crossref (`api.crossref.org`) |
| You download | The DOI of the paper | OpenAlex (`api.openalex.org`), to look for an open-access copy |
| You download | An ordinary download request for the PDF | The publisher, your library's proxy, or EBSCO |

The download requests are the same ones your browser would make if you clicked the link yourself, and they carry the sessions you are already signed in to. paper-fetch does not read, copy or store your cookies or passwords.

## What is stored, and where

- Your settings (proxy link, EBSCO customer code, download folder, auto-download preferences) are kept in the browser's extension storage on your computer.
- The last search and the last download's progress are kept until you close the browser, so the popup can show them when reopened.

Nothing else is stored. Removing the extension removes all of it.

## Permissions

- `downloads`: save the PDF and check that what arrived is a PDF.
- `storage`: keep the settings above.
- `scripting` on `ebsco.com`: fill in the search box and press the download button on the EBSCO page, in a background tab the extension opens and closes itself.
