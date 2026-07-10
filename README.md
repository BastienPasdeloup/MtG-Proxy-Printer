# MtG Proxy Printer

A static web app to print Magic: The Gathering proxies from a decklist, hosted on GitHub Pages:
**https://bastienpasdeloup.github.io/MtG-Proxy-Printer/**

## Usage

1. Paste a **Moxfield** (`moxfield.com/decks/…`) or **MTGTop8** (`mtgtop8.com/event?e=…&d=…`) deck URL
   (or paste a plain-text decklist).
2. Pick a **language**.
3. Click **Load Cards** — card images are fetched from [Scryfall](https://scryfall.com) in the chosen language.
4. Adjust the deck: remove cards, change quantities (double-faced cards: click to flip).
5. Click **Generate Proxies** — downloads an A4 PDF with 9 cards per page, each 62 × 87 mm, with cut marks.
   Print at **100% scale** (no "fit to page").

## Language fallback

- If the card exists in the chosen language, that printing's most recent scan is used (green badge).
- If the card was printed in the language but Scryfall has no usable scan, the English card is used and
  its text box is replaced with the **official translated text** from Scryfall's printed-card data (blue badge).
- If the card was never printed in the chosen language, no official translation exists;
  the English card is used as-is (gray badge).

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
