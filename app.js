"use strict";

/* ============================================================
 * MtG Proxy Printer
 * - Load a decklist from Moxfield or MTGTop8 (or pasted text)
 * - Fetch card images from Scryfall in a chosen language
 * - Fallback: English image + official translated text overlay
 * - Generate an A4 PDF, 9 cards per page, 62 x 87 mm each
 * ============================================================ */

const SCRYFALL = "https://api.scryfall.com";

// Proxies tried in order (Moxfield / MTGTop8 do not send CORS headers).
// - corsproxy.io works for MTGTop8 but is blocked by Moxfield's Cloudflare.
// - r.jina.ai reaches Moxfield too; it wraps the response in a markdown
//   preamble ("Markdown Content:") that gets stripped by `post`.
const PROXIES = [
  { wrap: (u) => u },
  { wrap: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}` },
  { wrap: (u) => `https://r.jina.ai/${u}`, post: stripJinaPreamble },
  { wrap: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
  { wrap: (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` },
];

function stripJinaPreamble(text) {
  const marker = "Markdown Content:";
  const i = text.indexOf(marker);
  return i === -1 ? text : text.slice(i + marker.length).trimStart();
}

// Layouts whose faces have separate images (both faces get printed as proxies).
const TWO_IMAGE_LAYOUTS = new Set([
  "transform", "modal_dfc", "double_faced_token", "reversible_card", "meld",
]);

// State: list of {name, qty, section, status, faces: [dataURL], printedName}
let cards = [];
let deckTitle = "";

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------
 * Small utilities
 * ---------------------------------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setStatus(text, frac = null, isError = false) {
  $("status").classList.remove("hidden");
  const st = $("status-text");
  st.textContent = text;
  st.classList.toggle("error", isError);
  if (frac !== null) {
    $("progress-bar").style.width = `${Math.round(frac * 100)}%`;
  }
}

function hideStatus() {
  $("status").classList.add("hidden");
  $("progress-bar").style.width = "0%";
}

async function fetchWithProxies(url, { json = false } = {}) {
  let lastError = null;
  for (const { wrap, post } of PROXIES) {
    try {
      const resp = await fetch(wrap(url), { signal: AbortSignal.timeout(45000) });
      if (!resp.ok) { lastError = new Error(`HTTP ${resp.status}`); continue; }
      let text = await resp.text();
      if (post) text = post(text);
      if (!json) return text;
      // Be tolerant of proxies that add wrappers around the JSON body
      const start = text.indexOf("{");
      if (start === -1) { lastError = new Error("No JSON in response"); continue; }
      return JSON.parse(text.slice(start, text.lastIndexOf("}") + 1));
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error("All fetch attempts failed");
}

/* ------------------------------------------------------------
 * Decklist loading (Moxfield / MTGTop8 / pasted text)
 * Returns { title, entries: [{name, qty, section}] }
 * ---------------------------------------------------------- */

function parseDeckText(text) {
  const entries = [];
  let section = "mainboard";
  let sawMain = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (sawMain) section = "sideboard";
      continue;
    }
    if (/^(sideboard|side\b|sb:?)\b/i.test(line)) { section = "sideboard"; continue; }
    if (/^(deck|mainboard|maindeck|main\b)\b:?$/i.test(line)) { section = "mainboard"; continue; }
    if (/^(commander|companion)\b:?$/i.test(line)) { section = "mainboard"; continue; }
    if (/^\/\//.test(line)) continue; // comments
    const m = line.match(/^(?:SB:\s*)?(\d+)x?\s+(.+)$/i);
    if (m) {
      const explicitSB = /^SB:/i.test(line);
      // Strip trailing set/collector info like "(M21) 155" or "[M21]"
      let name = m[2].replace(/\s*[([][A-Z0-9]{2,6}[)\]]\s*\S*\s*$/i, "").trim();
      entries.push({ name, qty: parseInt(m[1], 10), section: explicitSB ? "sideboard" : section });
      if (section === "mainboard" && !explicitSB) sawMain = true;
    }
  }
  return { title: "Pasted decklist", entries };
}

async function loadMoxfield(url) {
  const m = url.match(/moxfield\.com\/decks\/([A-Za-z0-9_-]+)/i);
  if (!m) throw new Error("Could not extract deck ID from Moxfield URL");
  const api = `https://api2.moxfield.com/v2/decks/all/${m[1]}`;
  const data = await fetchWithProxies(api, { json: true });

  const entries = [];
  const addBoard = (board, section) => {
    if (!board) return;
    for (const [name, info] of Object.entries(board)) {
      entries.push({ name, qty: info.quantity || 1, section });
    }
  };
  addBoard(data.commanders, "mainboard");
  addBoard(data.companions, "mainboard");
  addBoard(data.mainboard, "mainboard");
  addBoard(data.sideboard, "sideboard");
  if (entries.length === 0) throw new Error("Moxfield deck appears to be empty");
  return { title: data.name || "Moxfield deck", entries };
}

async function loadMtgTop8(url) {
  const m = url.match(/[?&]d=(\d+)/);
  if (!m) throw new Error("Could not extract deck ID (d=…) from MTGTop8 URL");
  const text = await fetchWithProxies(`https://mtgtop8.com/mtgo?d=${m[1]}`);
  const parsed = parseDeckText(text);
  if (parsed.entries.length === 0) throw new Error("MTGTop8 deck appears to be empty");
  parsed.title = "MTGTop8 deck";
  return parsed;
}

async function loadDecklist() {
  const url = $("deck-url").value.trim();
  const pasted = $("deck-text").value.trim();

  if (url) {
    if (/moxfield\.com/i.test(url)) return loadMoxfield(url);
    if (/mtgtop8\.com/i.test(url)) return loadMtgTop8(url);
    throw new Error("Unrecognized URL — please use a Moxfield or MTGTop8 deck URL");
  }
  if (pasted) {
    const parsed = parseDeckText(pasted);
    if (parsed.entries.length === 0) throw new Error("Could not parse any card from the pasted text");
    return parsed;
  }
  throw new Error("Please enter a decklist URL (or paste a decklist)");
}

/* ------------------------------------------------------------
 * Scryfall lookups
 * ---------------------------------------------------------- */

// Resolve unique names to canonical (English) cards, 75 per request.
async function resolveCards(names) {
  const found = new Map(); // lowercased requested name -> card object
  const notFound = [];
  for (let i = 0; i < names.length; i += 75) {
    const chunk = names.slice(i, i + 75);
    const resp = await fetch(`${SCRYFALL}/cards/collection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifiers: chunk.map((name) => ({ name })) }),
    });
    if (!resp.ok) throw new Error(`Scryfall error (HTTP ${resp.status})`);
    const data = await resp.json();
    for (const card of data.data || []) {
      // Match returned card back to the requested name (front-face names count too)
      const keys = [card.name, ...(card.card_faces || []).map((f) => f.name)];
      for (const req of chunk) {
        const reqLower = req.toLowerCase();
        if (keys.some((k) => k.toLowerCase() === reqLower || card.name.toLowerCase() === reqLower)) {
          if (!found.has(reqLower)) found.set(reqLower, card);
        }
      }
    }
    await sleep(100);
  }
  // The bulk endpoint can't resolve some names (notably "Front // Back"
  // double-faced cards); retry those one at a time via the named endpoint.
  for (const name of names) {
    if (found.has(name.toLowerCase())) continue;
    const front = name.split("//")[0].trim();
    try {
      const resp = await fetch(`${SCRYFALL}/cards/named?fuzzy=${encodeURIComponent(front)}`);
      if (resp.ok) {
        found.set(name.toLowerCase(), await resp.json());
      } else {
        notFound.push(name);
      }
    } catch {
      notFound.push(name);
    }
    await sleep(100);
  }
  return { found, notFound };
}

// Find printings of this card in the requested language.
// Returns { imageCard, textCard } — either may be null.
async function findLocalized(card, lang) {
  const q = `oracleid:${card.oracle_id} lang:${lang} game:paper`;
  const url = `${SCRYFALL}/cards/search?q=${encodeURIComponent(q)}` +
    `&unique=prints&order=released&include_multilingual=true`;
  const resp = await fetch(url);
  if (resp.status === 404) return { imageCard: null, textCard: null };
  if (!resp.ok) throw new Error(`Scryfall error (HTTP ${resp.status})`);
  const data = await resp.json();
  const prints = (data.data || []).filter((c) => c.lang === lang);

  const hasGoodImage = (c) =>
    (c.image_status === "highres_scan" || c.image_status === "lowres") &&
    (c.image_uris || (c.card_faces && c.card_faces[0].image_uris));
  const hasText = (c) =>
    c.printed_text || (c.card_faces || []).some((f) => f.printed_text);

  // Among usable prints, prefer plain classic-frame versions over promos,
  // showcase / borderless treatments and Universes Beyond crossovers.
  // Ties keep the released-desc order from the search.
  const printScore = (c) => {
    let s = 0;
    if (c.promo || c.promo_types) s += 2;
    if (c.full_art) s += 2;
    if (c.border_color !== "black") s += 2;
    if ((c.frame_effects || []).length) s += 1;
    if (c.frame !== "2015" && c.frame !== "2003") s += 1;
    if (c.security_stamp === "triangle") s += 1; // Universes Beyond
    if (["funny", "memorabilia", "masterpiece", "promo"].includes(c.set_type)) s += 2;
    if (c.image_status !== "highres_scan") s += 0.5;
    return s;
  };

  const usable = prints.filter(hasGoodImage).sort((a, b) => printScore(a) - printScore(b));
  return {
    imageCard: usable[0] || null,
    textCard: prints.find(hasText) || null,
  };
}

function faceImageUrls(card) {
  if (TWO_IMAGE_LAYOUTS.has(card.layout) && card.card_faces?.[0]?.image_uris) {
    return card.card_faces.map((f) => f.image_uris.large || f.image_uris.normal);
  }
  const uris = card.image_uris || card.card_faces?.[0]?.image_uris;
  return uris ? [uris.large || uris.normal] : [];
}

/* ------------------------------------------------------------
 * Image processing (canvas + translated-text overlay)
 * ---------------------------------------------------------- */

async function loadImage(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Image fetch failed (HTTP ${resp.status})`);
  const blob = await resp.blob();
  return await createImageBitmap(blob);
}

function wrapText(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph.trim()) { lines.push(""); continue; }
    let current = "";
    // CJK languages have no spaces: wrap per character if no spaces found.
    const words = paragraph.includes(" ") ? paragraph.split(" ") : paragraph.split("");
    const joiner = paragraph.includes(" ") ? " " : "";
    for (const word of words) {
      const test = current ? current + joiner + word : word;
      if (ctx.measureText(test).width > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

// Draw the English card, then paint the translated text over the text box.
function drawWithOverlay(bitmap, printedText, printedTypeLine) {
  const W = bitmap.width, H = bitmap.height;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);

  // Text box region of a standard modern frame (fractions of card size)
  const x0 = 0.075 * W, x1 = 0.925 * W;
  const y0 = 0.628 * H, y1 = 0.912 * H;
  const pad = 0.018 * W;

  ctx.fillStyle = "rgba(243, 238, 223, 0.97)";
  ctx.strokeStyle = "rgba(60, 50, 30, 0.65)";
  ctx.lineWidth = Math.max(1, 0.003 * W);
  ctx.beginPath();
  ctx.roundRect(x0, y0, x1 - x0, y1 - y0, 0.01 * W);
  ctx.fill();
  ctx.stroke();

  const fullText = (printedTypeLine ? printedTypeLine + "\n" : "") + (printedText || "");
  const boxW = x1 - x0 - 2 * pad;
  const boxH = y1 - y0 - 2 * pad;

  // Shrink font size until the text fits the box
  let fontSize = 0.034 * H;
  let lines;
  for (;;) {
    ctx.font = `${fontSize}px Georgia, "Times New Roman", serif`;
    lines = wrapText(ctx, fullText, boxW);
    if (lines.length * fontSize * 1.25 <= boxH || fontSize < 0.012 * H) break;
    fontSize *= 0.93;
  }

  ctx.fillStyle = "#141210";
  ctx.textBaseline = "top";
  let y = y0 + pad;
  lines.forEach((line, i) => {
    const isTypeLine = printedTypeLine && i === 0;
    ctx.font = `${isTypeLine ? "italic bold " : ""}${fontSize}px Georgia, "Times New Roman", serif`;
    ctx.fillText(line, x0 + pad, y, boxW);
    y += fontSize * 1.25;
  });

  return canvas.toDataURL("image/jpeg", 0.92);
}

function bitmapToDataUrl(bitmap) {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  return canvas.toDataURL("image/jpeg", 0.92);
}

/* ------------------------------------------------------------
 * Card pipeline: english card + language -> entry with images
 * ---------------------------------------------------------- */

async function buildCardEntry(englishCard, lang) {
  let status = "localized";
  let displayCard = englishCard;
  let textCard = null;

  if (lang !== "en") {
    const localized = await findLocalized(englishCard, lang);
    if (localized.imageCard) {
      displayCard = localized.imageCard;
      status = "localized";
    } else if (localized.textCard) {
      displayCard = englishCard;
      textCard = localized.textCard;
      status = "overlay";
    } else {
      displayCard = englishCard;
      status = "english";
    }
  }

  const urls = faceImageUrls(displayCard);
  if (urls.length === 0) throw new Error(`No image available for ${englishCard.name}`);

  const faces = [];
  for (let i = 0; i < urls.length; i++) {
    const bitmap = await loadImage(urls[i]);
    if (status === "overlay") {
      const face = textCard.card_faces?.[i] || textCard;
      const text = face.printed_text || face.oracle_text || textCard.printed_text || "";
      const typeLine = face.printed_type_line || "";
      if (text) {
        faces.push(drawWithOverlay(bitmap, text, typeLine));
      } else {
        faces.push(bitmapToDataUrl(bitmap));
      }
    } else {
      faces.push(bitmapToDataUrl(bitmap));
    }
    bitmap.close?.();
  }

  const nameSource = textCard || displayCard;
  const printedName = nameSource.printed_name ||
    nameSource.card_faces?.[0]?.printed_name || englishCard.name;
  return { status, faces, printedName };
}

/* ------------------------------------------------------------
 * Main "Load Cards" flow
 * ---------------------------------------------------------- */

async function onLoadCards() {
  const btn = $("load-btn");
  btn.disabled = true;
  $("deck-section").classList.add("hidden");
  cards = [];

  try {
    setStatus("Loading decklist…", 0.02);
    const deck = await loadDecklist();
    deckTitle = deck.title;

    let entries = deck.entries;
    if ($("include-sideboard").value === "no") {
      entries = entries.filter((e) => e.section !== "sideboard");
    }

    // Merge duplicates (same name + section)
    const merged = new Map();
    for (const e of entries) {
      const key = `${e.section}|${e.name.toLowerCase()}`;
      if (merged.has(key)) merged.get(key).qty += e.qty;
      else merged.set(key, { ...e });
    }
    entries = [...merged.values()];

    setStatus(`Resolving ${entries.length} cards on Scryfall…`, 0.05);
    const uniqueNames = [...new Set(entries.map((e) => e.name))];
    const { found, notFound } = await resolveCards(uniqueNames);

    const lang = $("language").value;
    const total = entries.length;
    let done = 0;
    const failed = [...notFound];

    for (const entry of entries) {
      const englishCard = found.get(entry.name.toLowerCase());
      done++;
      if (!englishCard) continue;
      setStatus(`Fetching images (${done}/${total}): ${entry.name}`, 0.05 + 0.95 * (done / total));
      try {
        const built = await buildCardEntry(englishCard, lang);
        cards.push({ name: entry.name, qty: entry.qty, section: entry.section, ...built });
      } catch (e) {
        console.error(`Failed to build ${entry.name}:`, e);
        failed.push(entry.name);
      }
      await sleep(80); // stay well within Scryfall rate limits
    }

    renderGrid();
    if (failed.length > 0) {
      setStatus(`Done, but these cards could not be loaded: ${failed.join(", ")}`, 1, true);
    } else {
      hideStatus();
    }
    if (cards.length === 0) {
      setStatus("No card could be loaded — check the decklist and try again.", 1, true);
    }
  } catch (e) {
    console.error(e);
    setStatus(`Error: ${e.message}`, 1, true);
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------
 * Grid rendering
 * ---------------------------------------------------------- */

const BADGES = {
  localized: { cls: "badge-localized", label: "✓", title: "Found in the chosen language" },
  overlay: { cls: "badge-overlay", label: "T", title: "English scan with official translated text" },
  english: { cls: "badge-english", label: "EN", title: "Never printed in the chosen language" },
};

function renderGrid() {
  window.__cards__ = cards; // exposed for debugging / testing
  const grid = $("card-grid");
  grid.innerHTML = "";

  const sections = [
    ["mainboard", "Mainboard"],
    ["sideboard", "Sideboard"],
  ];

  for (const [key, label] of sections) {
    const sectionCards = cards.filter((c) => c.section === key);
    if (sectionCards.length === 0) continue;
    if (cards.some((c) => c.section === "sideboard")) {
      const el = document.createElement("div");
      el.className = "section-label";
      el.textContent = label;
      grid.appendChild(el);
    }
    for (const card of sectionCards) {
      grid.appendChild(makeTile(card));
    }
  }

  const totalCards = cards.reduce((s, c) => s + c.qty, 0);
  const totalSlots = cards.reduce((s, c) => s + c.qty * c.faces.length, 0);
  const pages = Math.ceil(totalSlots / 9);
  $("deck-name").textContent = deckTitle;
  $("deck-stats").textContent =
    `${totalCards} cards · ${totalSlots} proxies · ${pages} A4 page${pages > 1 ? "s" : ""}`;
  $("deck-section").classList.toggle("hidden", cards.length === 0);
}

function makeTile(card) {
  const tile = document.createElement("div");
  tile.className = "card-tile";

  const badge = BADGES[card.status];
  const badgeEl = document.createElement("span");
  badgeEl.className = `badge ${badge.cls}`;
  badgeEl.textContent = badge.label;
  badgeEl.title = badge.title;
  tile.appendChild(badgeEl);

  const img = document.createElement("img");
  img.src = card.faces[0];
  img.alt = card.name;
  img.loading = "lazy";
  if (card.faces.length > 1) {
    let face = 0;
    img.style.cursor = "pointer";
    img.title = "Click to flip";
    img.addEventListener("click", () => {
      face = (face + 1) % card.faces.length;
      img.src = card.faces[face];
    });
  }
  tile.appendChild(img);

  const nameEl = document.createElement("div");
  nameEl.className = "card-name";
  nameEl.textContent = card.printedName;
  nameEl.title = card.name;
  tile.appendChild(nameEl);

  const controls = document.createElement("div");
  controls.className = "card-controls";

  const minus = document.createElement("button");
  minus.className = "qty-btn";
  minus.textContent = "−";
  minus.title = "One copy less";
  minus.addEventListener("click", () => {
    if (card.qty > 1) { card.qty--; renderGrid(); }
  });

  const qty = document.createElement("span");
  qty.className = "qty-display";
  qty.textContent = `×${card.qty}`;

  const plus = document.createElement("button");
  plus.className = "qty-btn";
  plus.textContent = "+";
  plus.title = "One copy more";
  plus.addEventListener("click", () => { card.qty++; renderGrid(); });

  const remove = document.createElement("button");
  remove.className = "remove-btn";
  remove.textContent = "✕";
  remove.title = "Remove this card";
  remove.addEventListener("click", () => {
    cards = cards.filter((c) => c !== card);
    renderGrid();
  });

  controls.append(minus, qty, plus, remove);
  tile.appendChild(controls);
  return tile;
}

/* ------------------------------------------------------------
 * PDF generation: A4, 3 x 3 grid, 62 x 87 mm cards
 * ---------------------------------------------------------- */

function onGeneratePdf() {
  const btn = $("generate-btn");
  btn.disabled = true;
  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "mm", format: "a4" });

    const PAGE_W = 210, PAGE_H = 297;
    const CARD_W = 62, CARD_H = 87;
    const COLS = 3, ROWS = 3;
    const MARGIN_X = (PAGE_W - COLS * CARD_W) / 2; // 12 mm
    const MARGIN_Y = (PAGE_H - ROWS * CARD_H) / 2; // 18 mm

    // Flatten: each copy of each face is one slot
    const slots = [];
    for (const card of cards) {
      for (let i = 0; i < card.qty; i++) slots.push(...card.faces);
    }

    const drawCutMarks = () => {
      doc.setDrawColor(150);
      doc.setLineWidth(0.1);
      const len = 6;
      for (let c = 0; c <= COLS; c++) {
        const x = MARGIN_X + c * CARD_W;
        doc.line(x, MARGIN_Y - len, x, MARGIN_Y);
        doc.line(x, MARGIN_Y + ROWS * CARD_H, x, MARGIN_Y + ROWS * CARD_H + len);
      }
      for (let r = 0; r <= ROWS; r++) {
        const y = MARGIN_Y + r * CARD_H;
        doc.line(MARGIN_X - len, y, MARGIN_X, y);
        doc.line(MARGIN_X + COLS * CARD_W, y, MARGIN_X + COLS * CARD_W + len, y);
      }
    };

    slots.forEach((dataUrl, i) => {
      const posOnPage = i % (COLS * ROWS);
      if (i > 0 && posOnPage === 0) doc.addPage();
      if (posOnPage === 0) drawCutMarks();
      const col = posOnPage % COLS;
      const row = Math.floor(posOnPage / COLS);
      const x = MARGIN_X + col * CARD_W;
      const y = MARGIN_Y + row * CARD_H;
      doc.addImage(dataUrl, "JPEG", x, y, CARD_W, CARD_H);
    });

    const safeTitle = (deckTitle || "proxies").replace(/[^\w\s-]/g, "").trim()
      .replace(/\s+/g, "_").toLowerCase() || "proxies";
    doc.save(`${safeTitle}_proxies.pdf`);
  } catch (e) {
    console.error(e);
    setStatus(`PDF generation failed: ${e.message}`, 1, true);
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------
 * Wire up
 * ---------------------------------------------------------- */

$("load-btn").addEventListener("click", onLoadCards);
$("generate-btn").addEventListener("click", onGeneratePdf);
$("deck-url").addEventListener("keydown", (e) => {
  if (e.key === "Enter") onLoadCards();
});
