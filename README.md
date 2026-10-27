# MtG Proxy Printer

A static web app to print Magic: The Gathering proxies from a decklist, hosted on GitHub Pages:
**https://bastienpasdeloup.github.io/MtG-Proxy-Printer/**

## Usage

1. Paste a **Moxfield** (`moxfield.com/decks/…`), **Archidekt** (`archidekt.com/decks/…`), **MTGTop8**
   (`mtgtop8.com/event?e=…&d=…`) or **CubeCobra** URL and/or paste a plain-text decklist (both load together when both are given). With no input at all,
   **Load Cards** offers to start an empty deck built card by card with the "+" tile.
   A CubeCobra address may be either a drafted deck (`cubecobra.com/cube/deck/…`) or a whole cube
   (`cubecobra.com/cube/overview/…`, `/cube/list/…`, …). A deck belongs to a draft with one seat per
   drafter: the first seat is loaded, and `?seat=N` appended to the URL picks another one.
2. Pick a **card language** (it starts on the interface language, see below), and choose whether to
   include the sideboard, the "Considering" board and the **tokens** (and emblems)
   created by the deck's cards (excluded by default — they appear in their own category at the
   end of the grid, translated like any other card, and disappear automatically when their last
   producing card is removed). Including tokens also brings the **game-aid helper cards** the deck
   calls for: City's Blessing (ascend), The Monarch, the dungeons and their reward tokens
   (venture / initiative), Start Your Engines!, Energy Reserve ({E}) and a Storm counter card.
   Whatever this setting, the token category is always shown, with its own **+** tile to add
   tokens, emblems or game aids by hand (see step 3).
   The "Considering" board is read from Moxfield, from Archidekt's *Maybeboard* and from a
   CubeCobra cube's *Maybeboard* (a CubeCobra deck has a sideboard instead).
   The **Sideboard** and **Considering** dropdowns are only shown when the deck actually has such a
   board: shortly after a deck URL is entered (or a list is pasted) the decklist is read in the
   background — that same read is reused by **Load Cards**, so nothing is fetched twice. Until then
   (and with nothing entered) only **Tokens** is offered, which is always available since tokens are
   not a board of the deck but are created by its own cards.
   For Moxfield, Archidekt and CubeCobra decks (all of which give the printing of each card), a **Preferred version**
   dropdown chooses between keeping the exact printings from the deck page (same artworks, more
   text-overlay translations) or swapping to printings in the chosen language when the deck page's
   one was never printed in it (default).
   The **Translator** and **Preferred version** dropdowns only appear when the card language is not
   English: with English cards there is nothing to translate and the deck page's own printings
   (hence its artworks) are used as they are.
3. Click **Load Cards** — card images are fetched from [Scryfall](https://scryfall.com) in the chosen language.
   A **+** tile at the end of the grid lets you add extra cards by name (with autocompletion),
   typed in English or in the card language: suggestions mix both (localized names show their
   English name alongside), and a localized name resolves to its card ("Foudre" → Lightning Bolt).
   Adding a card already in the list creates a second entry on a **different printing** (so you get
   two artworks); if you instead pick a printing another copy already uses, the version picker flags it
   (⚠, "already added" in its tooltip) and selecting it merges the two copies back into one.
   The token category has its own **+** tile: type a token name (autocompleted among tokens,
   emblems and dungeons, in English or in the card language — since tokens are hardly ever printed
   in other languages, localized names come from the app's own creature-type and game-aid
   vocabulary, e.g. "Soldat" → Soldier) and, when several tokens share it (there are a dozen "Soldier" tokens),
   pick the right one from their thumbnails.
   Every thumbnail, in both pickers, carries the badge the card will get once picked (✓, **T**,
   **MT** or **EN**, see the legend): telling official translations from machine ones only needs
   a dry run of the translation, nothing is machine-translated before a version is chosen. Tokens added this way stay in the list even when no
   card producing them is left.
4. Adjust the deck: remove cards, change quantities, pick another printing with the version button
   under each card — it opens the thumbnails of the chosen language's printings and the English
   ones (translated on the fly when selected), sorted by release date (double-faced cards flip with the arrows
   button at the bottom right of the image). Translated cards show a pencil cursor — click the
   card to edit its name, type line and text manually (only the fields painted on that card
   are offered).
5. Click **Generate Proxies** — downloads an A4 PDF with 9 cards per page, each 62 × 87 mm, with the
   cards' rounded corners squared off for a clean cut. The bottom corners are always black (white on
   white-bordered cards); the top corners take the color of the border right next to them (black,
   white, or the artwork's color on full-art frames) so they blend in. Two checkboxes above the
   button set what is printed (both remembered in the browser):
   - **Cut lines** (on by default): cut marks around the grid and thin grey lines between adjacent
     cards.
   - **Card backs** (off by default): each page of cards is followed by its page of backs, to print
     double-sided **flipping on the long edge** — the backs are mirrored left ↔ right so each one
     lands behind its card. Cards get the regular Magic back, double-faced cards their other face
     (no cut lines are drawn on the backs, where a slight misalignment would show them).
   Without card backs, if the deck contains double-sided cards, you are asked whether to print their
   backs as separate cards. Print at **100% scale** (no "fit to page").
   Every dialog can be dismissed with its **✕** or the **Escape** key, which cancels the action
   (dismissing the double-sided question generates no PDF at all).

Nothing is stored server-side — the app has no backend and keeps everything in the page, so it warns
before you leave once a deck is loaded.

## Interface language

The interface itself is available in the same eleven languages as the cards (English, French, German,
Italian, Spanish, Portuguese, Japanese, Korean, Russian, Simplified and Traditional Chinese). Pick one
with the **flag button** at the top right, next to *Report issue*; it is remembered in the browser's
local storage. On a first visit the browser's preferred language is used when it is one of the eleven,
and English otherwise. The **card language** follows the interface language, until you pick one
yourself in its dropdown — from then on the two are independent.

Translations live in `i18n.js` (`STRINGS[lang]`, one flat key → string map per language, falling back
to English for any missing key). Static markup is annotated with `data-i18n` / `data-i18n-html` /
`data-i18n-title` / `data-i18n-placeholder`; strings built in JS go through `t("key", { placeholders })`.
Adding a language means adding an entry to `UI_LANGS` and a block to `STRINGS`.

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
- Split cards, adventure cards, planeswalkers, sagas and tokens/emblems get dedicated overlay
  layouts (split cards are shown rotated; planeswalkers keep their loyalty count visible; sagas
  translate the reminder and chapter text in the left column). Old (pre-2003) frames get their own
  geometry too. Cards with other non-standard frames (classes, flip cards…) keep the English scan
  when no localized print exists (gray **EN** badge) — the overlay geometry would not match.

## Low-resolution scans

Some printings only exist as a low-resolution scan on Scryfall. Those would print blurry, so they
are automatically enhanced — sharpened at native resolution (a fine + a wider unsharp mask, aimed at
the small rules text), **upscaled 3×**, then sharpened again — and flagged with a purple **HD** badge
under the language badge. Click the badge to switch back to the original image (**LR**), and again to
re-enhance it.

Some scans (notably old French dual lands) show the card inset on a solid colored background instead
of bleeding to the edge; that thin colored border is detected and cropped away so the card fills the
image (black/white borders and full-art edges are left alone).

## Technical notes

- Pure static HTML/CSS/JS, no build step, no backend. `i18n.js` must be loaded before `app.js`. PDF generation via [jsPDF](https://github.com/parallax/jsPDF).
- Scryfall's API is called directly from the browser (CORS-enabled), and so is CubeCobra's public
  cube API (`/cube/api/cubeJSON/…`). Moxfield, Archidekt, MTGTop8 and CubeCobra's deck exports
  do not allow cross-origin requests, so those decklists are fetched through public CORS proxies
  (corsproxy.io, r.jina.ai, allorigins.win, codetabs.com — tried in order). If all proxies are down,
  use the manual paste fallback.

## Legal

Unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards.
Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.
Card data and images courtesy of Scryfall.
