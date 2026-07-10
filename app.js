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

// Fetch with retry + exponential backoff. Scryfall throttling can surface
// either as HTTP 429 or as a CORS/network failure (Cloudflare error responses
// carry no CORS headers, so fetch throws), and the block can last several
// seconds — back off up to ~16 s before giving up.
async function fetchRetry(url, opts = undefined, tries = 5) {
  let lastError = null;
  for (let i = 0; i < tries; i++) {
    try {
      const resp = await fetch(url, opts);
      if (resp.status === 429 || resp.status >= 500) {
        lastError = new Error(`HTTP ${resp.status}`);
      } else {
        return resp; // includes 404 etc. — the caller decides
      }
    } catch (e) {
      lastError = e;
    }
    await sleep(Math.min(16000, 1000 * 2 ** i));
  }
  throw lastError || new Error("Request failed");
}

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
    const resp = await fetchRetry(`${SCRYFALL}/cards/collection`, {
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
      const resp = await fetchRetry(`${SCRYFALL}/cards/named?fuzzy=${encodeURIComponent(front)}`);
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

const hasGoodImage = (c) =>
  (c.image_status === "highres_scan" || c.image_status === "lowres") &&
  (c.image_uris || (c.card_faces && c.card_faces[0].image_uris));
const hasPrintedText = (c) =>
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

// Find printings of many cards in the requested language with as few API
// calls as possible: Scryfall's search accepts (oracleid:A or oracleid:B …),
// so ~18 cards fit in one request instead of one request per card (which
// used to trip Scryfall's rate limiting on big decks).
// Returns Map<oracle_id, { prints, fields }>:
// - prints: usable prints (good image), best-looking first
// - fields: per-face official translations merged across ALL prints of that
//   language — old prints often carry printed_name but no printed_text.
async function findLocalizedBatch(oracleIds, lang) {
  const printsById = new Map();
  const CHUNK = 18;
  for (let i = 0; i < oracleIds.length; i += CHUNK) {
    const ids = oracleIds.slice(i, i + CHUNK);
    const q = `(${ids.map((id) => `oracleid:${id}`).join(" or ")}) lang:${lang} game:paper`;
    let url = `${SCRYFALL}/cards/search?q=${encodeURIComponent(q)}` +
      `&unique=prints&order=released&include_multilingual=true`;
    while (url) {
      const resp = await fetchRetry(url);
      if (resp.status === 404) break; // none of this chunk exists in that language
      if (!resp.ok) throw new Error(`Scryfall error (HTTP ${resp.status})`);
      const data = await resp.json();
      for (const c of data.data || []) {
        if (c.lang !== lang) continue;
        if (!printsById.has(c.oracle_id)) printsById.set(c.oracle_id, []);
        printsById.get(c.oracle_id).push(c);
      }
      url = data.has_more ? data.next_page : null;
      await sleep(120);
    }
  }

  const result = new Map();
  for (const [oracleId, prints] of printsById) {
    const usable = prints.filter(hasGoodImage).sort((a, b) => printScore(a) - printScore(b));
    const fields = [];
    for (const p of prints) { // newest first: prefer current wording
      const pFaces = p.card_faces?.length ? p.card_faces : [p];
      pFaces.forEach((f, i) => {
        fields[i] = fields[i] || {};
        fields[i].name = fields[i].name || f.printed_name || (i === 0 ? p.printed_name : null);
        fields[i].type = fields[i].type || f.printed_type_line || (i === 0 ? p.printed_type_line : null);
        fields[i].text = fields[i].text || f.printed_text || (i === 0 ? p.printed_text : null);
      });
    }
    result.set(oracleId, { prints: usable, fields });
  }
  return result;
}

/* ------------------------------------------------------------
 * Translation fallback chain (for cards with no localized scan):
 * Scryfall printed fields -> magicthegathering.io (Gatherer data)
 * -> Google Translate (machine translation, flagged "MT")
 * ---------------------------------------------------------- */

const MTGIO_LANG = {
  fr: "French", de: "German", it: "Italian", es: "Spanish",
  pt: "Portuguese (Brazil)", ja: "Japanese", ko: "Korean", ru: "Russian",
  zhs: "Chinese Simplified", zht: "Chinese Traditional",
};
const GOOGLE_LANG = {
  fr: "fr", de: "de", it: "it", es: "es", pt: "pt", ja: "ja", ko: "ko",
  ru: "ru", zhs: "zh-CN", zht: "zh-TW",
};

async function mtgioLookup(faceName, lang) {
  try {
    const url = "https://api.magicthegathering.io/v1/cards?name=" +
      encodeURIComponent(`"${faceName}"`);
    const resp = await fetchRetry(url, undefined, 2);
    if (!resp.ok) return null;
    const data = await resp.json();
    const target = MTGIO_LANG[lang];
    const best = {};
    for (const c of data.cards || []) {
      if (c.name.toLowerCase() !== faceName.toLowerCase()) continue;
      for (const f of c.foreignNames || []) {
        if (f.language !== target) continue;
        best.name = best.name || f.name;
        best.type = best.type || f.type;
        best.text = best.text || f.text;
      }
    }
    return best.name || best.type || best.text ? best : null;
  } catch {
    return null;
  }
}

// Official translations of common type lines — Google mistranslates game
// vocabulary badly ("Land" becomes the verb "to land"). Keyed by the part
// before the em-dash; subtypes are still machine-translated.
const TYPE_DICT = {
  fr: {
    "Land": "Terrain", "Creature": "Créature", "Artifact": "Artefact",
    "Enchantment": "Enchantement", "Instant": "Éphémère", "Sorcery": "Rituel",
    "Planeswalker": "Planeswalker", "Basic Land": "Terrain de base",
    "Legendary Creature": "Créature légendaire", "Legendary Land": "Terrain légendaire",
    "Legendary Artifact": "Artefact légendaire", "Legendary Enchantment": "Enchantement légendaire",
    "Legendary Planeswalker": "Planeswalker légendaire",
    "Artifact Creature": "Créature-artefact", "Enchantment Creature": "Créature-enchantement",
    "Artifact Land": "Terrain-artefact", "Snow Land": "Terrain neigeux",
    "Legendary Artifact Creature": "Créature-artefact légendaire",
    "World Enchantment": "Enchantement de monde",
  },
  de: {
    "Land": "Land", "Creature": "Kreatur", "Artifact": "Artefakt",
    "Enchantment": "Verzauberung", "Instant": "Spontanzauber", "Sorcery": "Hexerei",
    "Planeswalker": "Planeswalker", "Basic Land": "Standardland",
    "Legendary Creature": "Legendäre Kreatur", "Legendary Land": "Legendäres Land",
    "Legendary Artifact": "Legendäres Artefakt", "Artifact Creature": "Artefaktkreatur",
  },
  es: {
    "Land": "Tierra", "Creature": "Criatura", "Artifact": "Artefacto",
    "Enchantment": "Encantamiento", "Instant": "Instantáneo", "Sorcery": "Conjuro",
    "Planeswalker": "Planeswalker", "Basic Land": "Tierra básica",
    "Legendary Creature": "Criatura legendaria", "Legendary Land": "Tierra legendaria",
    "Artifact Creature": "Criatura artefacto",
  },
  it: {
    "Land": "Terra", "Creature": "Creatura", "Artifact": "Artefatto",
    "Enchantment": "Incantesimo", "Instant": "Istantaneo", "Sorcery": "Stregoneria",
    "Planeswalker": "Planeswalker", "Basic Land": "Terra Base",
    "Legendary Creature": "Creatura Leggendaria", "Artifact Creature": "Creatura Artefatto",
  },
  pt: {
    "Land": "Terreno", "Creature": "Criatura", "Artifact": "Artefato",
    "Enchantment": "Encantamento", "Instant": "Mágica Instantânea", "Sorcery": "Feitiço",
    "Planeswalker": "Planeswalker", "Basic Land": "Terreno Básico",
    "Legendary Creature": "Criatura Lendária", "Artifact Creature": "Criatura Artefato",
  },
  ja: {
    "Land": "土地", "Creature": "クリーチャー", "Artifact": "アーティファクト",
    "Enchantment": "エンチャント", "Instant": "インスタント", "Sorcery": "ソーサリー",
    "Planeswalker": "プレインズウォーカー", "Basic Land": "基本土地",
    "Legendary Creature": "伝説のクリーチャー",
  },
};
// French printed type lines separate subtypes with " : " instead of " — "
const TYPE_SEP = { fr: " : " };

async function translateTypeLine(typeLine, lang) {
  const [types, subtypes] = typeLine.split(/\s+—\s+/);
  const official = TYPE_DICT[lang]?.[types];
  if (!official) return { text: await googleTranslate(typeLine, lang), mt: true };
  if (!subtypes) return { text: official, mt: false };
  const sub = await googleTranslate(subtypes, lang);
  return { text: official + (TYPE_SEP[lang] || " — ") + sub, mt: true };
}

async function googleTranslate(text, lang) {
  const url = "https://translate.googleapis.com/translate_a/single" +
    `?client=gtx&sl=en&tl=${GOOGLE_LANG[lang]}&dt=t&q=${encodeURIComponent(text)}`;
  const resp = await fetchRetry(url);
  if (!resp.ok) throw new Error(`Translation service error (HTTP ${resp.status})`);
  const data = await resp.json();
  return (data[0] || []).map((seg) => seg[0]).join("");
}

// Build per-face {name, type, text} in the target language.
async function resolveTranslations(englishCard, lang, loc) {
  const faces = englishCard.card_faces?.length ? englishCard.card_faces : [englishCard];
  const texts = [];
  let usedMT = false;

  for (let i = 0; i < faces.length; i++) {
    const face = faces[i];
    const official = loc?.fields?.[i] || {};
    const t = {
      name: official.name || null,
      type: official.type || null,
      text: official.text || null,
    };
    if (!t.name || !t.type || (!t.text && face.oracle_text)) {
      const io = await mtgioLookup(face.name, lang);
      if (io) {
        t.name = t.name || io.name;
        t.type = t.type || io.type;
        t.text = t.text || io.text;
      }
    }
    try {
      if (!t.name) { t.name = await googleTranslate(face.name, lang); usedMT = true; }
      if (!t.type && face.type_line) {
        const tl = await translateTypeLine(face.type_line, lang);
        t.type = tl.text;
        usedMT = usedMT || tl.mt;
      }
      if (!t.text && face.oracle_text) { t.text = await googleTranslate(face.oracle_text, lang); usedMT = true; }
    } catch (e) {
      console.error(`Machine translation failed for ${face.name}:`, e);
    }
    texts.push(t);
  }
  return { texts, usedMT };
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
  const resp = await fetchRetry(url);
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

// Draw the English card, then paint the translated name, type line and
// rules text over their respective areas of a standard modern frame.
// `manaSymbols` = number of mana symbols, kept uncovered in the title bar.
function drawWithOverlay(bitmap, tr, manaSymbols) {
  const W = bitmap.width, H = bitmap.height;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);

  const parchment = (x0, y0, x1, y1) => {
    ctx.fillStyle = "#f3eedf"; // fully opaque or the English text ghosts through
    ctx.strokeStyle = "rgba(60, 50, 30, 0.65)";
    ctx.lineWidth = Math.max(1, 0.003 * W);
    ctx.beginPath();
    ctx.roundRect(x0, y0, x1 - x0, y1 - y0, 0.01 * W);
    ctx.fill();
    ctx.stroke();
  };

  // Single line, shrunk to fit, vertically centered in its bar
  const drawBarText = (text, x0, y0, x1, y1, style) => {
    parchment(x0, y0, x1, y1);
    const pad = 0.015 * W;
    const maxW = x1 - x0 - 2 * pad;
    let size = (y1 - y0) * 0.62;
    for (;;) {
      ctx.font = `${style}${size}px Georgia, "Times New Roman", serif`;
      if (ctx.measureText(text).width <= maxW || size < (y1 - y0) * 0.3) break;
      size *= 0.94;
    }
    ctx.fillStyle = "#141210";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x0 + pad, (y0 + y1) / 2, maxW);
  };

  if (tr.name) {
    // Leave the mana cost (right side of the title bar) visible
    const x1 = (0.93 - manaSymbols * 0.048) * W;
    drawBarText(tr.name, 0.068 * W, 0.048 * H, x1, 0.100 * H, "bold ");
  }
  if (tr.type) {
    // Leave the set symbol (right side of the type bar) visible
    drawBarText(tr.type, 0.068 * W, 0.563 * H, 0.872 * W, 0.610 * H, "bold ");
  }

  if (tr.text) {
    const x0 = 0.07 * W, x1 = 0.93 * W;
    const y0 = 0.615 * H, y1 = 0.925 * H;
    const pad = 0.018 * W;
    parchment(x0, y0, x1, y1);

    const boxW = x1 - x0 - 2 * pad;
    const boxH = y1 - y0 - 2 * pad;

    // Shrink font size until the text fits the box
    let fontSize = 0.034 * H;
    let lines;
    for (;;) {
      ctx.font = `${fontSize}px Georgia, "Times New Roman", serif`;
      lines = wrapText(ctx, tr.text, boxW);
      if (lines.length * fontSize * 1.25 <= boxH || fontSize < 0.012 * H) break;
      fontSize *= 0.93;
    }

    ctx.fillStyle = "#141210";
    ctx.textBaseline = "top";
    let y = y0 + pad;
    for (const line of lines) {
      ctx.fillText(line, x0 + pad, y, boxW);
      y += fontSize * 1.25;
    }
  }

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

// Layouts whose frame geometry matches the standard overlay regions.
// Others (split, flip, adventure, saga, class…) keep the English scan.
const OVERLAY_LAYOUTS = new Set(["normal", "transform", "modal_dfc", "meld"]);

async function buildCardEntry(englishCard, lang, loc, eng) {
  const langPrints = lang === "en" ? [] : (loc?.prints || []);
  const engPrints = eng?.prints?.length ? eng.prints : [englishCard];

  // The dropdown offers the chosen language's printings AND the English
  // ones (translated on the fly), newest release first.
  const prints = [...langPrints, ...engPrints]
    .sort((a, b) => (b.released_at || "").localeCompare(a.released_at || ""));

  // Default: best-looking print in the chosen language, else best English
  const pool = langPrints.length ? langPrints : engPrints;
  const best = pool.slice().sort((a, b) => printScore(a) - printScore(b))[0];

  const entry = {
    lang, english: englishCard, loc,
    prints, printIndex: Math.max(0, prints.indexOf(best)),
    overlayTexts: null, usedMT: false,
  };
  entry.faces = await buildFaces(entry);
  entry.status = computeStatus(entry);
  entry.printedName = loc?.fields?.[0]?.name || entry.overlayTexts?.[0]?.name ||
    langPrints[0]?.printed_name || langPrints[0]?.card_faces?.[0]?.printed_name ||
    englishCard.name;
  return entry;
}

function printNeedsOverlay(entry) {
  const print = entry.prints[entry.printIndex];
  return entry.lang !== "en" && print.lang !== entry.lang &&
    OVERLAY_LAYOUTS.has(entry.english.layout);
}

function computeStatus(entry) {
  const print = entry.prints[entry.printIndex];
  if (entry.lang === "en" || print.lang === entry.lang) return "localized";
  if (entry.overlayTexts) return entry.usedMT ? "mt" : "overlay";
  return "english";
}

// Render the faces of the currently selected printing (also used when the
// user picks another printing from the dropdown). Translations are resolved
// lazily, the first time an English print needs the overlay.
async function buildFaces(entry) {
  const print = entry.prints[entry.printIndex];
  const urls = faceImageUrls(print);
  if (urls.length === 0) throw new Error(`No image available for ${print.name}`);
  const printFaces = print.card_faces?.length ? print.card_faces : [print];

  const needsOverlay = printNeedsOverlay(entry);
  if (needsOverlay && !entry.overlayTexts) {
    const { texts, usedMT } = await resolveTranslations(entry.english, entry.lang, entry.loc);
    entry.overlayTexts = texts;
    entry.usedMT = usedMT;
  }

  const faces = [];
  for (let i = 0; i < urls.length; i++) {
    const bitmap = await loadImage(urls[i]);
    const tr = needsOverlay ? entry.overlayTexts?.[i] : null;
    if (tr && (tr.name || tr.type || tr.text)) {
      const mana = (printFaces[i]?.mana_cost || "").match(/{[^}]+}/g)?.length || 0;
      faces.push(drawWithOverlay(bitmap, tr, mana));
    } else {
      faces.push(bitmapToDataUrl(bitmap));
    }
    bitmap.close?.();
  }
  return faces;
}

/* ------------------------------------------------------------
 * Main "Load Cards" flow
 * ---------------------------------------------------------- */

let failedEntries = []; // entries that failed in the last load, for the retry button
let currentLang = "en";

// Resolve and build the given entries, appending successes to `cards`.
// Returns the entries that could not be loaded.
async function loadEntries(entries, lang) {
  setStatus(`Resolving ${entries.length} cards on Scryfall…`, 0.02);
  const uniqueNames = [...new Set(entries.map((e) => e.name))];
  const { found } = await resolveCards(uniqueNames);

  const oracleIds = [...new Set(
    entries.map((e) => found.get(e.name.toLowerCase())?.oracle_id).filter(Boolean)
  )];

  let localizedMap = new Map();
  if (lang !== "en") {
    setStatus(`Looking up ${lang} printings…`, 0.06);
    localizedMap = await findLocalizedBatch(oracleIds, lang);
  }

  // English print lists are always fetched: they fill the printing dropdown
  // (translated on the fly when selected) and are the display fallback for
  // cards without a usable localized scan.
  setStatus("Looking up printings…", 0.09);
  const englishMap = await findLocalizedBatch(oracleIds, "en");

  const total = entries.length;
  let done = 0;
  const failed = [];

  for (const entry of entries) {
    done++;
    setStatus(`Fetching images (${done}/${total}): ${entry.name}`, 0.12 + 0.88 * (done / total));
    const englishCard = found.get(entry.name.toLowerCase());
    if (!englishCard) { failed.push(entry); continue; }
    try {
      const built = await buildCardEntry(englishCard, lang,
        localizedMap.get(englishCard.oracle_id), englishMap.get(englishCard.oracle_id));
      cards.push({ name: entry.name, qty: entry.qty, section: entry.section, ...built });
    } catch (e) {
      console.error(`Failed to build ${entry.name}:`, e);
      failed.push(entry);
    }
    await sleep(60); // images come from Scryfall's CDN, which is not rate-limited
  }
  return failed;
}

function reportLoadResult() {
  renderGrid();
  $("retry-btn").classList.toggle("hidden", failedEntries.length === 0);
  if (failedEntries.length > 0) {
    setStatus(`Done, but ${failedEntries.length} card(s) could not be loaded: ` +
      failedEntries.map((e) => e.name).join(", "), 1, true);
  } else if (cards.length === 0) {
    setStatus("No card could be loaded — check the decklist and try again.", 1, true);
  } else {
    hideStatus();
  }
}

async function onLoadCards() {
  const btn = $("load-btn");
  btn.disabled = true;
  $("retry-btn").classList.add("hidden");
  $("deck-section").classList.add("hidden");
  cards = [];
  failedEntries = [];

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

    currentLang = $("language").value;
    failedEntries = await loadEntries(entries, currentLang);
    reportLoadResult();
  } catch (e) {
    console.error(e);
    setStatus(`Error: ${e.message}`, 1, true);
  } finally {
    btn.disabled = false;
  }
}

async function onRetryFailed() {
  const btn = $("retry-btn");
  btn.disabled = true;
  $("load-btn").disabled = true;
  try {
    failedEntries = await loadEntries(failedEntries, currentLang);
    reportLoadResult();
  } catch (e) {
    console.error(e);
    setStatus(`Error: ${e.message}`, 1, true);
  } finally {
    btn.disabled = false;
    $("load-btn").disabled = false;
  }
}

/* ------------------------------------------------------------
 * Grid rendering
 * ---------------------------------------------------------- */

const BADGES = {
  localized: { cls: "badge-localized", label: "✓", title: "Found in the chosen language" },
  overlay: { cls: "badge-overlay", label: "T", title: "English scan with official translated text" },
  mt: { cls: "badge-mt", label: "MT", title: "No official translation found — machine-translated (Google Translate)" },
  english: { cls: "badge-english", label: "EN", title: "Kept in English (unusual card frame)" },
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

  if (card.prints.length > 1) {
    const sel = document.createElement("select");
    sel.className = "print-select";
    sel.title = "Choose the printing to use";
    card.prints.forEach((p, i) => {
      const opt = document.createElement("option");
      opt.value = i;
      const langTag = card.lang !== "en" ? `${p.lang.toUpperCase()} · ` : "";
      const year = (p.released_at || "").slice(0, 4);
      opt.textContent = `${langTag}${p.set.toUpperCase()} #${p.collector_number} · ${p.set_name}${year ? ` (${year})` : ""}`;
      opt.selected = i === card.printIndex;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", async () => {
      card.printIndex = Number(sel.value);
      sel.disabled = true;
      img.style.opacity = "0.4";
      try {
        card.faces = await buildFaces(card);
        img.src = card.faces[0];
        card.status = computeStatus(card);
        const badge = BADGES[card.status];
        badgeEl.className = `badge ${badge.cls}`;
        badgeEl.textContent = badge.label;
        badgeEl.title = badge.title;
      } catch (e) {
        console.error(e);
        setStatus(`Could not load that printing of ${card.name}: ${e.message}`, null, true);
      }
      img.style.opacity = "";
      sel.disabled = false;
    });
    tile.appendChild(sel);
  }

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

// Ask whether double-sided cards should print both faces or only the front.
function askDfcChoice(count) {
  return new Promise((resolve) => {
    const dlg = $("dfc-dialog");
    $("dfc-count").textContent = count;
    dlg.addEventListener("close", () => resolve(dlg.returnValue !== "front"), { once: true });
    dlg.showModal();
  });
}

async function onGeneratePdf() {
  const btn = $("generate-btn");
  btn.disabled = true;
  try {
    const dfcCount = cards.filter((c) => c.faces.length > 1).length;
    const includeBacks = dfcCount > 0 ? await askDfcChoice(dfcCount) : false;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "mm", format: "a4" });

    const PAGE_W = 210, PAGE_H = 297;
    const CARD_W = 62, CARD_H = 87;
    const COLS = 3, ROWS = 3;
    const MARGIN_X = (PAGE_W - COLS * CARD_W) / 2; // 12 mm
    const MARGIN_Y = (PAGE_H - ROWS * CARD_H) / 2; // 18 mm

    // Flatten: each copy of each printed face is one slot
    const slots = [];
    for (const card of cards) {
      const faces = includeBacks ? card.faces : card.faces.slice(0, 1);
      for (let i = 0; i < card.qty; i++) slots.push(...faces);
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
$("retry-btn").addEventListener("click", onRetryFailed);
$("generate-btn").addEventListener("click", onGeneratePdf);
$("deck-url").addEventListener("keydown", (e) => {
  if (e.key === "Enter") onLoadCards();
});
