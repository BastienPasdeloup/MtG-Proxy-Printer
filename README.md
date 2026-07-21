# MtG Proxy Printer

A static web app to print Magic: The Gathering proxies from a decklist, hosted on GitHub Pages:
**https://bastienpasdeloup.github.io/MtG-Proxy-Printer/**

## Usage

1. Paste a **Moxfield** (`moxfield.com/decks/…`) or **MTGTop8** (`mtgtop8.com/event?e=…&d=…`) deck URL
   and/or paste a plain-text decklist (both load together when both are given). With no input at all,
   **Load Cards** offers to start an empty deck built card by card with the "+" tile.
2. Pick a **language**, and choose whether to include the sideboard, the **tokens** (and emblems)
   created by the deck's cards (excluded by default — they appear in their own category at the
   end of the grid, translated like any other card, and disappear automatically when their last
   producing card is removed) and, for Moxfield decks,
   the "Considering" board. Including tokens also brings the **game-aid helper cards** the deck
   calls for: City's Blessing (ascend), The Monarch, the dungeons and their reward tokens
   (venture / initiative), Start Your Engines!, Energy Reserve ({E}) and a Storm counter card.
   For Moxfield decks, a **Preferred version** dropdown chooses between
   keeping the exact printings from the Moxfield page (same artworks, more text-overlay
   translations) or swapping to printings in the chosen language when the Moxfield one
   was never printed in it (default).
3. Click **Load Cards** — card images are fetched from [Scryfall](https://scryfall.com) in the chosen language.
   A **+** tile at the end of the grid lets you add extra cards by name (with autocompletion).
   Adding a card already in the list creates a second entry on a **different printing** (so you get
   two artworks); if you instead pick a printing another copy already uses, the dropdown flags it
   (⚠ "already added") and selecting it merges the two copies back into one.
4. Adjust the deck: remove cards, change quantities, pick another printing from the dropdown
   under each card — it lists the chosen language's printings and the English ones (translated
   on the fly when selected), sorted by release date (double-faced cards flip with the arrows
   button at the bottom right of the image). Translated cards show a pencil cursor — click the
   card to edit its name, type line and text manually (only the fields painted on that card
   are offered).
5. Click **Generate Proxies** — downloads an A4 PDF with 9 cards per page, each 62 × 87 mm, with cut
   marks, thin grey lines between adjacent cards, and the cards' rounded corners squared off for a
   clean cut — in black for black-bordered cards, white for white-bordered ones, and left untouched
   on full-art / borderless frames so no artwork is covered. If the deck contains double-sided cards,
   you are asked whether to print backs too. Print at **100% scale** (no "fit to page").

Nothing is stored server-side — the app has no backend and keeps everything in the page, so it warns
before you leave once a deck is loaded.

## Language fallback

Every card ends up in the chosen language:

- If the card exists in the chosen language, a scan of a real printing is used, preferring
  classic-frame versions over promos/showcase/Universes Beyond (green ✓ badge). Scans are
  verified: when Scryfall wrongly attached the English image to a localized print (it happens),
  the app detects it by comparing the text box with the English scan pixel-wise and applies
  the translation overlay instead.
- Otherwise the English scan is used and its **name, type line and text box** are repainted with the
  translation. Each repainted box picks up the color of the frame area it covers (a dark title bar
  gets a dark box with light text, not a cream rectangle). The translation is resolved in this order:
  1. official printed text from Scryfall's localized print data (blue **T** badge),
  2. official Gatherer translations via api.magicthegathering.io (blue **T** badge),
  3. machine translation — an MtG-aware AI translator (default), Google Translate, Microsoft Translator or MyMemory, selectable in the UI —
     with official type-word vocabulary (orange **MT** badge).
- Split cards, adventure cards and tokens/emblems get dedicated overlay layouts (split cards are
  shown rotated). Cards with other non-standard frames (sagas, classes, flip cards…) keep the
  English scan when no localized print exists (gray **EN** badge) — the overlay geometry would
  not match.

## Low-resolution scans

Some printings only exist as a low-resolution scan on Scryfall. Those would print blurry, so they
are automatically enhanced — sharpened at native resolution (a fine + a wider unsharp mask, aimed at
the small rules text), **upscaled 3×**, then sharpened again — and flagged with a purple **HD** badge
under the language badge. Click the badge to switch back to the original image (**LR**), and again to
re-enhance it.

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
