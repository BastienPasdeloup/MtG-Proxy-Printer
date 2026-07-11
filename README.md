# MtG Proxy Printer

A static web app to print Magic: The Gathering proxies from a decklist, hosted on GitHub Pages:
**https://bastienpasdeloup.github.io/MtG-Proxy-Printer/**

## Usage

1. Paste a **Moxfield** (`moxfield.com/decks/…`) or **MTGTop8** (`mtgtop8.com/event?e=…&d=…`) deck URL
   (or paste a plain-text decklist).
2. Pick a **language**, and choose whether to include the sideboard (and, for Moxfield decks,
   the "Considering" board).
3. Click **Load Cards** — card images are fetched from [Scryfall](https://scryfall.com) in the chosen language.
   A **+** tile at the end of the grid lets you add extra cards by name (with autocompletion).
4. Adjust the deck: remove cards, change quantities, pick another printing from the dropdown
   under each card — it lists the chosen language's printings and the English ones (translated
   on the fly when selected), sorted by release date (double-faced cards: click the image to flip).
5. Click **Generate Proxies** — downloads an A4 PDF with 9 cards per page, each 62 × 87 mm, with cut marks.
   If the deck contains double-sided cards, you are asked whether to print backs too.
   Print at **100% scale** (no "fit to page").

## Language fallback

Every card ends up in the chosen language:

- If the card exists in the chosen language, a scan of a real printing is used, preferring
  classic-frame versions over promos/showcase/Universes Beyond (green ✓ badge).
- Otherwise the English scan is used and its **name, type line and text box** are repainted with the
  translation, resolved in this order:
  1. official printed text from Scryfall's localized print data (blue **T** badge),
  2. official Gatherer translations via api.magicthegathering.io (blue **T** badge),
  3. Google Translate machine translation, with official type-word vocabulary (orange **MT** badge).
- Cards with non-standard frames (split, adventure, sagas…) keep the English scan when no localized
  print exists (gray **EN** badge) — the overlay geometry would not match.

## Technical notes

- Pure static HTML/CSS/JS, no build step, no backend. PDF generation via [jsPDF](https://github.com/parallax/jsPDF).
- Scryfall's API is called directly from the browser (CORS-enabled). Moxfield and MTGTop8 do not allow
  cross-origin requests, so those decklists are fetched through public CORS proxies
  (corsproxy.io, allorigins.win, codetabs.com — tried in order). If all proxies are down,
  use the manual paste fallback.

## Legal

Unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards.
Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.
Card data and images courtesy of Scryfall.
