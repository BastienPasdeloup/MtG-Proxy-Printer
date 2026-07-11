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
async function fetchRetry(url, opts = undefined, tries = 6) {
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
    await sleep(Math.min(30000, 1000 * 2 ** i));
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
      // Remember the exact printing chosen on the Moxfield page
      const print = info.card?.set
        ? { set: String(info.card.set).toLowerCase(), cn: String(info.card.cn ?? "") }
        : null;
      entries.push({ name, qty: info.quantity || 1, section, print });
    }
  };
  addBoard(data.commanders, "commander");
  addBoard(data.companions, "commander");
  addBoard(data.mainboard, "mainboard");
  addBoard(data.sideboard, "sideboard");
  addBoard(data.maybeboard, "maybeboard"); // "Considering" in the Moxfield UI
  if (entries.length === 0) throw new Error("Moxfield deck appears to be empty");
  return { title: data.name || "Moxfield deck", entries, sortByType: true };
}

async function loadMtgTop8(url) {
  const m = url.match(/[?&]d=(\d+)/);
  if (!m) throw new Error("Could not extract deck ID (d=…) from MTGTop8 URL");
  const text = await fetchWithProxies(`https://mtgtop8.com/mtgo?d=${m[1]}`);
  const parsed = parseDeckText(text);
  if (parsed.entries.length === 0) throw new Error("MTGTop8 deck appears to be empty");
  parsed.title = "MTGTop8 deck";
  parsed.sortByType = true;
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
        const s = sanitizePrintedFields({
          name: f.printed_name || (i === 0 ? p.printed_name : null),
          type: f.printed_type_line || (i === 0 ? p.printed_type_line : null),
          text: f.printed_text || (i === 0 ? p.printed_text : null),
          artist: f.artist || p.artist,
        });
        fields[i].name = fields[i].name || s.name;
        fields[i].type = fields[i].type || s.type;
        fields[i].text = fields[i].text || s.text;
      });
    }
    result.set(oracleId, { prints: usable, fields });
  }
  return result;
}

// Scryfall's printed_* fields are sometimes mis-segmented OCR (notably on
// split-card faces): the artist credit leaks into the rules text, and the
// "type line" contains the first rules sentence. Repair what we can.
function sanitizePrintedFields({ name, type, text, artist }) {
  const artists = (artist || "").split(/\s*&\s*/).map((a) => a.trim()).filter(Boolean);
  if (text && artists.length) {
    text = text.split("\n")
      .filter((line) => !artists.includes(line.trim()))
      .join("\n").trim() || null;
  }
  // A real type line never ends with sentence punctuation — this is a rules
  // sentence that slipped into the wrong field: move it back to the text.
  if (type && /[.!?…]\s*$/.test(type)) {
    text = text ? `${type.trim()}\n${text}` : type.trim();
    type = null;
  }
  return { name, type, text };
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
/* Machine-translation providers (all free and CORS-enabled). The one chosen
 * in the "Translator" dropdown is tried first; the others act as fallback. */

const GOOGLE_LANG = {
  fr: "fr", de: "de", it: "it", es: "es", pt: "pt", ja: "ja", ko: "ko",
  ru: "ru", zhs: "zh-CN", zht: "zh-TW",
};
const BING_LANG = {
  fr: "fr", de: "de", it: "it", es: "es", pt: "pt", ja: "ja", ko: "ko",
  ru: "ru", zhs: "zh-Hans", zht: "zh-Hant",
};
const MYMEMORY_LANG = {
  fr: "fr", de: "de", it: "it", es: "es", pt: "pt-BR", ja: "ja", ko: "ko",
  ru: "ru", zhs: "zh-CN", zht: "zh-TW",
};

async function googleTranslateImpl(text, lang) {
  const url = "https://translate.googleapis.com/translate_a/single" +
    `?client=gtx&sl=en&tl=${GOOGLE_LANG[lang]}&dt=t&q=${encodeURIComponent(text)}`;
  const resp = await fetchRetry(url, undefined, 3);
  if (!resp.ok) throw new Error(`Google Translate error (HTTP ${resp.status})`);
  const data = await resp.json();
  return (data[0] || []).map((seg) => seg[0]).join("");
}

// Microsoft Translator, via the token endpoint used by the Edge browser
let bingToken = null;
let bingTokenTime = 0;
async function bingTranslateImpl(text, lang) {
  if (!bingToken || Date.now() - bingTokenTime > 8 * 60 * 1000) {
    const auth = await fetchRetry("https://edge.microsoft.com/translate/auth", undefined, 2);
    if (!auth.ok) throw new Error("Microsoft Translator auth failed");
    bingToken = await auth.text();
    bingTokenTime = Date.now();
  }
  const url = "https://api-edge.cognitive.microsofttranslator.com/translate" +
    `?api-version=3.0&from=en&to=${BING_LANG[lang]}`;
  const resp = await fetchRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${bingToken}` },
    body: JSON.stringify([{ Text: text }]),
  }, 2);
  if (!resp.ok) throw new Error(`Microsoft Translator error (HTTP ${resp.status})`);
  const data = await resp.json();
  const out = data?.[0]?.translations?.[0]?.text;
  if (!out) throw new Error("Microsoft Translator: empty result");
  return out;
}

function decodeHtmlEntities(s) {
  const el = document.createElement("textarea");
  el.innerHTML = s;
  return el.value;
}

async function myMemoryTranslateImpl(text, lang) {
  // MyMemory rejects long queries: translate in <=450-char line groups
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current && (current.length + line.length + 1) > 450) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);

  const out = [];
  for (const chunk of chunks) {
    const url = "https://api.mymemory.translated.net/get" +
      `?q=${encodeURIComponent(chunk)}&langpair=en|${MYMEMORY_LANG[lang]}`;
    const resp = await fetchRetry(url, undefined, 2);
    if (!resp.ok) throw new Error(`MyMemory error (HTTP ${resp.status})`);
    const data = await resp.json();
    const t = data.responseData?.translatedText;
    if (!t || data.responseStatus !== 200) throw new Error("MyMemory: no translation");
    out.push(decodeHtmlEntities(t));
    await sleep(150);
  }
  return out.join("\n");
}

const DEEPL_LANG = {
  fr: "FR", de: "DE", it: "IT", es: "ES", pt: "PT-BR", ja: "JA", ko: "KO",
  ru: "RU", zhs: "ZH-HANS", zht: "ZH-HANT",
};

// DeepL needs a (free) API key and does not allow browser CORS,
// so the request goes through a CORS proxy when the direct call fails.
async function deeplTranslateImpl(text, lang) {
  const key = $("deepl-key").value.trim();
  if (!key) throw new Error("DeepL API key missing — get a free one at deepl.com/pro-api");
  const host = key.endsWith(":fx") ? "api-free.deepl.com" : "api.deepl.com";
  const target = `https://${host}/v2/translate`;
  const body = new URLSearchParams({
    auth_key: key, text, source_lang: "EN", target_lang: DEEPL_LANG[lang],
  }).toString();

  const attempts = [target, `https://corsproxy.io/?url=${encodeURIComponent(target)}`];
  let lastError = null;
  for (const url of attempts) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!resp.ok) { lastError = new Error(`DeepL error (HTTP ${resp.status})`); continue; }
      const data = await resp.json();
      const out = data?.translations?.[0]?.text;
      if (out) return out;
      lastError = new Error("DeepL: empty result");
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error("DeepL failed");
}

const MT_PROVIDERS = {
  google: { label: "Google Translate", fn: googleTranslateImpl },
  bing: { label: "Microsoft Translator", fn: bingTranslateImpl },
  mymemory: { label: "MyMemory", fn: myMemoryTranslateImpl },
  deepl: { label: "DeepL", fn: deeplTranslateImpl },
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
  if (!official) return { text: await machineTranslate(typeLine, lang), mt: true };
  if (!subtypes) return { text: official, mt: false };
  const sub = await machineTranslate(subtypes, lang);
  return { text: official + (TYPE_SEP[lang] || " — ") + sub, mt: true };
}

// Machine-translate with the provider chosen in the "Translator" dropdown,
// falling back to the other providers if it fails.
async function machineTranslate(text, lang) {
  const selected = $("translator").value || "google";
  const order = [selected, ...Object.keys(MT_PROVIDERS).filter((k) => k !== selected)];
  let lastError = null;
  for (const key of order) {
    try {
      return await MT_PROVIDERS[key].fn(text, lang);
    } catch (e) {
      console.warn(`${MT_PROVIDERS[key].label} failed:`, e);
      lastError = e;
    }
  }
  throw lastError || new Error("All translators failed");
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
      if (!t.name) { t.name = await machineTranslate(face.name, lang); usedMT = true; }
      if (!t.type && face.type_line) {
        const tl = await translateTypeLine(face.type_line, lang);
        t.type = tl.text;
        usedMT = usedMT || tl.mt;
      }
      if (!t.text && face.oracle_text) { t.text = await machineTranslate(face.oracle_text, lang); usedMT = true; }
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


/* ------------------------------------------------------------
 * Mana / game symbols: "{T}", "{2}{G}", "{W/U}"… are rendered with
 * Scryfall's official symbol SVGs, rasterized once and cached.
 * ---------------------------------------------------------- */

const symbolCache = new Map();

function symbolKey(code) {
  return code.toUpperCase().replace(/\//g, "");
}

async function loadSymbolImage(code) {
  const key = symbolKey(code);
  if (symbolCache.has(key)) return;
  let result = null;
  try {
    const resp = await fetchRetry(
      `https://svgs.scryfall.io/card-symbols/${encodeURIComponent(key)}.svg`, undefined, 2);
    if (resp.ok) {
      const url = URL.createObjectURL(await resp.blob());
      try {
        const img = await new Promise((resolve, reject) => {
          const i = new Image();
          i.onload = () => resolve(i);
          i.onerror = reject;
          i.src = url;
        });
        const c = document.createElement("canvas");
        c.width = c.height = 64;
        c.getContext("2d").drawImage(img, 0, 0, 64, 64);
        result = c;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  } catch { /* unknown symbol: keep the {X} text form */ }
  symbolCache.set(key, result);
}

function symbolFor(code) {
  return symbolCache.get(symbolKey(code)) || null;
}

async function preloadSymbols(texts) {
  const codes = new Set();
  for (const t of texts || []) {
    for (const m of (t?.text || "").matchAll(/\{([^}]+)\}/g)) codes.add(m[1]);
  }
  await Promise.all([...codes].map(loadSymbolImage));
}

// Split a paragraph into wrappable atoms of {text}/{sym} segments.
// `glue` means "no space before this atom" (used for CJK, split per char).
function atomize(paragraph) {
  const segs = [];
  let last = 0;
  for (const m of paragraph.matchAll(/\{([^}]+)\}/g)) {
    if (m.index > last) segs.push({ text: paragraph.slice(last, m.index) });
    segs.push({ sym: m[1] });
    last = m.index + m[0].length;
  }
  if (last < paragraph.length) segs.push({ text: paragraph.slice(last) });

  const hasSpaces = paragraph.includes(" ");
  const atoms = [];
  let current = { segs: [], glue: false };
  const flush = (glueNext) => {
    if (current.segs.length) atoms.push(current);
    current = { segs: [], glue: !!glueNext };
  };
  for (const seg of segs) {
    if (seg.sym) { current.segs.push(seg); continue; }
    if (hasSpaces) {
      seg.text.split(" ").forEach((word, i) => {
        if (i > 0) flush(false);
        if (word) current.segs.push({ text: word });
      });
    } else {
      for (const ch of seg.text) {
        flush(true);
        current.segs.push({ text: ch });
      }
    }
  }
  flush();
  return atoms;
}

function paintParchment(ctx, W, x0, y0, x1, y1) {
  ctx.fillStyle = "#f3eedf"; // fully opaque or the English text ghosts through
  ctx.strokeStyle = "rgba(60, 50, 30, 0.65)";
  ctx.lineWidth = Math.max(1, 0.003 * W);
  ctx.beginPath();
  ctx.roundRect(x0, y0, x1 - x0, y1 - y0, 0.01 * W);
  ctx.fill();
  ctx.stroke();
}

// Single line, shrunk to fit, vertically centered in its bar
function paintBarText(ctx, W, text, x0, y0, x1, y1, style) {
  paintParchment(ctx, W, x0, y0, x1, y1);
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
}

// Wrapped rules text, shrunk to fit its box, with {X} tokens drawn as
// game symbols (call preloadSymbols() on the text beforehand).
function paintTextBox(ctx, W, baseFontSize, text, x0, y0, x1, y1) {
  const pad = 0.018 * W;
  paintParchment(ctx, W, x0, y0, x1, y1);
  const boxW = x1 - x0 - 2 * pad;
  const boxH = y1 - y0 - 2 * pad;

  const atomWidth = (segs, symW) => {
    let w = 0;
    for (const s of segs) {
      w += s.sym
        ? (symbolFor(s.sym) ? symW : ctx.measureText(`{${s.sym}}`).width)
        : ctx.measureText(s.text).width;
    }
    return w;
  };

  // Wrap into lines of atoms, shrinking the font until the text fits
  let fontSize = baseFontSize;
  let lines;
  for (;;) {
    ctx.font = `${fontSize}px Georgia, "Times New Roman", serif`;
    const symW = fontSize * 1.02;
    const spaceW = ctx.measureText(" ").width;
    lines = [];
    for (const paragraph of text.split("\n")) {
      if (!paragraph.trim()) { lines.push([]); continue; }
      let line = [], lineW = 0;
      for (const atom of atomize(paragraph)) {
        const aw = atomWidth(atom.segs, symW);
        const gap = line.length && !atom.glue ? spaceW : 0;
        if (line.length && lineW + gap + aw > boxW) {
          lines.push(line);
          line = [{ ...atom, glue: true }];
          lineW = aw;
        } else {
          line.push(atom);
          lineW += gap + aw;
        }
      }
      lines.push(line);
    }
    if (lines.length * fontSize * 1.25 <= boxH || fontSize < baseFontSize * 0.35) break;
    fontSize *= 0.93;
  }

  ctx.fillStyle = "#141210";
  ctx.textBaseline = "top";
  const symW = fontSize * 1.02;
  const spaceW = ctx.measureText(" ").width;
  let y = y0 + pad;
  for (const line of lines) {
    let x = x0 + pad;
    line.forEach((atom, i) => {
      if (i > 0 && !atom.glue) x += spaceW;
      for (const seg of atom.segs) {
        if (seg.sym) {
          const img = symbolFor(seg.sym);
          if (img) {
            ctx.drawImage(img, x, y + fontSize * 0.06, symW, symW);
            x += symW;
          } else {
            const t = `{${seg.sym}}`;
            ctx.fillText(t, x, y);
            x += ctx.measureText(t).width;
          }
        } else {
          ctx.fillText(seg.text, x, y);
          x += ctx.measureText(seg.text).width;
        }
      }
    });
    y += fontSize * 1.25;
  }
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

  if (tr.name) {
    // Leave the mana cost (right side of the title bar) fully visible
    const x1 = (manaSymbols > 0 ? 0.925 - manaSymbols * 0.052 - 0.012 : 0.93) * W;
    paintBarText(ctx, W, tr.name, 0.068 * W, 0.048 * H, x1, 0.100 * H, "bold ");
  }
  if (tr.type) {
    // Leave the set symbol (right side of the type bar) visible
    paintBarText(ctx, W, tr.type, 0.068 * W, 0.563 * H, 0.872 * W, 0.610 * H, "bold ");
  }
  if (tr.text) {
    paintTextBox(ctx, W, 0.034 * H, tr.text, 0.07 * W, 0.615 * H, 0.93 * W, 0.925 * H);
  }

  return canvas.toDataURL("image/jpeg", 0.92);
}

// Split cards, drawn on the rotated (landscape) scan: each half is a small
// card frame. Region fractions calibrated on Scryfall "large" split scans;
// the pre-2003 frame has its type band and text box noticeably higher.
const SPLIT_GEOM = {
  old: { typeY: [0.487, 0.548], textY: [0.553, 0.945] },      // 1993/1997 frames
  modern: { typeY: [0.540, 0.600], textY: [0.605, 0.950] },   // 2003/2015 frames
};

function drawSplitOverlay(ctx, W, H, texts, engFaces, frame) {
  const HALVES = [
    { x0: 0.048, x1: 0.492 },
    { x0: 0.525, x1: 0.958 },
  ];
  const g = (frame === "1997" || frame === "1993") ? SPLIT_GEOM.old : SPLIT_GEOM.modern;
  for (let i = 0; i < HALVES.length; i++) {
    const tr = texts[i];
    if (!tr) continue;
    const h = HALVES[i];
    const mana = (engFaces[i]?.mana_cost || "").match(/{[^}]+}/g)?.length || 0;
    // Text box first: it also covers any type-line text that sits lower on
    // some split frames; the type bar is then painted at its true position.
    if (tr.text) {
      paintTextBox(ctx, W, 0.036 * H, tr.text,
        (h.x0 + 0.004) * W, g.textY[0] * H, (h.x1 - 0.008) * W, g.textY[1] * H);
    }
    if (tr.type) {
      // Leave the set symbol (right end of the type bar) visible
      paintBarText(ctx, W, tr.type, (h.x0 + 0.004) * W, g.typeY[0] * H, (h.x1 - 0.058) * W, g.typeY[1] * H, "bold ");
    }
    if (tr.name) {
      // Leave the mana cost fully visible
      const x1 = (mana > 0 ? h.x1 - mana * 0.054 - 0.012 : h.x1 - 0.005) * W;
      paintBarText(ctx, W, tr.name, (h.x0 + 0.004) * W, 0.060 * H, x1, 0.140 * H, "bold ");
    }
  }
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

// Layouts whose frame geometry supports the translation overlay: standard
// frames, plus split cards (drawn rotated with per-half regions).
// Others (flip, adventure, saga, class…) keep the English scan.
const OVERLAY_LAYOUTS = new Set(["normal", "transform", "modal_dfc", "meld", "split"]);

async function buildCardEntry(englishCard, lang, loc, eng, prefPrint, versionMode = "language") {
  const langPrints = lang === "en" ? [] : (loc?.prints || []);
  const engPrints = eng?.prints?.length ? eng.prints : [englishCard];

  // The dropdown offers the chosen language's printings AND the English
  // ones (translated on the fly), oldest release first.
  const prints = [...langPrints, ...engPrints]
    .sort((a, b) => (a.released_at || "").localeCompare(b.released_at || ""));

  // Default print selection. With a deck-page printing (Moxfield):
  // - "language" mode: that printing in the chosen language, else any print
  //   in the chosen language, else that printing in English (overlay).
  // - "moxfield" mode: that printing in the chosen language (same artwork),
  //   else that printing in English (overlay).
  // Without a preferred printing: best print in the language, else English.
  const bestOf = (pool) => pool.slice().sort((a, b) => printScore(a) - printScore(b))[0];
  let best = null;
  if (prefPrint) {
    const match = (p, l) =>
      p.set === prefPrint.set && p.collector_number === prefPrint.cn && p.lang === l;
    best = prints.find((p) => match(p, lang));
    if (!best && versionMode === "language" && langPrints.length) {
      best = bestOf(langPrints);
    }
    if (!best) best = prints.find((p) => match(p, "en"));
  }
  if (!best) {
    best = bestOf(langPrints.length ? langPrints : engPrints);
  }

  const entry = {
    lang, english: englishCard, loc,
    prints, printIndex: Math.max(0, prints.indexOf(best)),
    overlayTexts: null, usedMT: false,
    rotated: englishCard.layout === "split",
  };
  entry.faces = await buildFaces(entry);
  entry.status = computeStatus(entry);
  const faceName = (i) => loc?.fields?.[i]?.name || entry.overlayTexts?.[i]?.name ||
    langPrints[0]?.card_faces?.[i]?.printed_name || null;
  if (englishCard.card_faces?.length === 2 && faceName(0) && faceName(1)) {
    entry.printedName = `${faceName(0)} // ${faceName(1)}`;
  } else {
    entry.printedName = faceName(0) || langPrints[0]?.printed_name || englishCard.name;
  }
  return entry;
}

// Whether the selected print could take a translation overlay (regardless
// of the user's "keep English" choice).
function printTranslatable(entry) {
  const print = entry.prints[entry.printIndex];
  return entry.lang !== "en" && print.lang !== entry.lang &&
    OVERLAY_LAYOUTS.has(entry.english.layout);
}

function printNeedsOverlay(entry) {
  return printTranslatable(entry) && !entry.forceEnglish;
}

function computeStatus(entry) {
  const print = entry.prints[entry.printIndex];
  if (entry.lang === "en" || print.lang === entry.lang) return "localized";
  if (entry.forceEnglish) return "english";
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
  if (needsOverlay) await preloadSymbols(entry.overlayTexts);

  // Split cards: rotate the scan 90° clockwise so both halves read
  // horizontally (displayed landscape; rotated back at PDF time).
  if (entry.rotated) {
    const bitmap = await loadImage(urls[0]);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.height;
    canvas.height = bitmap.width;
    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.translate(canvas.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(bitmap, 0, 0);
    ctx.restore();
    bitmap.close?.();
    if (needsOverlay && entry.overlayTexts) {
      drawSplitOverlay(ctx, canvas.width, canvas.height, entry.overlayTexts,
        entry.english.card_faces || [], print.frame);
    }
    return [canvas.toDataURL("image/jpeg", 0.92)];
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

// Deck-page display order: commanders first, then type groups as shown on
// Moxfield, alphabetical within each group.
const SECTION_RANK = { commander: 0, mainboard: 1, sideboard: 2, maybeboard: 3 };

function typeRank(card) {
  const tl = (card?.type_line || "").split("//")[0].toLowerCase();
  if (tl.includes("creature")) return 0;
  if (tl.includes("land")) return 7;
  if (tl.includes("planeswalker")) return 1;
  if (tl.includes("instant")) return 2;
  if (tl.includes("sorcery")) return 3;
  if (tl.includes("artifact")) return 4;
  if (tl.includes("enchantment")) return 5;
  if (tl.includes("battle")) return 6;
  return 8;
}

// Resolve and build the given entries, appending successes to `cards`.
// Returns the entries that could not be loaded.
async function loadEntries(entries, lang, sortByType = false) {
  setStatus(`Resolving ${entries.length} cards on Scryfall…`, 0.02);
  const uniqueNames = [...new Set(entries.map((e) => e.name))];
  const { found } = await resolveCards(uniqueNames);

  if (sortByType) {
    entries = entries.slice().sort((a, b) =>
      ((SECTION_RANK[a.section] ?? 1) - (SECTION_RANK[b.section] ?? 1)) ||
      (typeRank(found.get(a.name.toLowerCase())) - typeRank(found.get(b.name.toLowerCase()))) ||
      a.name.localeCompare(b.name));
  }

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

  const versionMode = $("preferred-version").value || "language";
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
        localizedMap.get(englishCard.oracle_id), englishMap.get(englishCard.oracle_id),
        entry.print, versionMode);
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
    if ($("include-maybeboard").value === "no") {
      entries = entries.filter((e) => e.section !== "maybeboard");
    }

    // Merge duplicates by name across all boards: a card can appear in both
    // the main deck and the sideboard — print the total number of copies.
    const merged = new Map();
    for (const e of entries) {
      const key = e.name.toLowerCase();
      if (merged.has(key)) merged.get(key).qty += e.qty;
      else merged.set(key, { ...e });
    }
    entries = [...merged.values()];

    currentLang = $("language").value;
    failedEntries = await loadEntries(entries, currentLang, !!deck.sortByType);
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
  mt: { cls: "badge-mt", label: "MT", title: "No official translation found — machine-translated with the selected translator" },
  english: { cls: "badge-english", label: "EN", title: "Kept in English" },
};

function renderGrid() {
  window.__cards__ = cards; // exposed for debugging / testing
  const grid = $("card-grid");
  grid.innerHTML = "";

  for (const card of cards) {
    grid.appendChild(makeTile(card));
  }
  grid.appendChild(makeAddTile());

  const totalCards = cards.reduce((s, c) => s + c.qty, 0);
  const totalSlots = cards.reduce((s, c) => s + c.qty * c.faces.length, 0);
  const pages = Math.ceil(totalSlots / 9);
  $("deck-name").textContent = deckTitle;
  $("deck-stats").textContent =
    `${totalCards} cards · ${totalSlots} proxies · ${pages} A4 page${pages > 1 ? "s" : ""}`;
  $("deck-section").classList.toggle("hidden", cards.length === 0);
}

function updateBadge(badgeEl, card) {
  const badge = BADGES[card.status];
  badgeEl.className = `badge ${badge.cls}`;
  badgeEl.textContent = badge.label;
  badgeEl.title = badge.title;
  if (printTranslatable(card)) {
    badgeEl.classList.add("badge-click");
    badgeEl.title = card.forceEnglish
      ? "English text kept — click to translate"
      : `${badge.title} — click to keep the English text instead`;
  }
}

function makeTile(card) {
  const tile = document.createElement("div");
  tile.className = "card-tile";

  const badgeEl = document.createElement("span");
  updateBadge(badgeEl, card);
  badgeEl.addEventListener("click", async () => {
    if (!printTranslatable(card) || badgeEl.dataset.busy) return;
    badgeEl.dataset.busy = "1";
    card.forceEnglish = !card.forceEnglish;
    img.style.opacity = "0.4";
    try {
      card.faces = await buildFaces(card);
      img.src = card.faces[0];
      card.status = computeStatus(card);
      updateBadge(badgeEl, card);
    } catch (e) {
      console.error(e);
      setStatus(`Could not update ${card.name}: ${e.message}`, null, true);
    }
    img.style.opacity = "";
    delete badgeEl.dataset.busy;
  });
  tile.appendChild(badgeEl);

  tile.classList.toggle("wide", !!card.rotated);

  const imgWrap = document.createElement("div");
  imgWrap.className = "img-wrap";
  const img = document.createElement("img");
  img.src = card.faces[0];
  img.alt = card.name;
  img.loading = "lazy";
  imgWrap.appendChild(img);
  if (card.faces.length > 1) {
    let face = 0;
    const flip = () => {
      face = (face + 1) % card.faces.length;
      img.src = card.faces[face];
    };
    img.style.cursor = "pointer";
    img.title = "Click to flip";
    img.addEventListener("click", flip);
    const flipBtn = document.createElement("button");
    flipBtn.className = "flip-btn";
    flipBtn.title = "Show the other side";
    flipBtn.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>';
    flipBtn.addEventListener("click", (e) => { e.stopPropagation(); flip(); });
    imgWrap.appendChild(flipBtn);
  }
  tile.appendChild(imgWrap);

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
        updateBadge(badgeEl, card);
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
 * "+" tile: add an extra card by name (Scryfall autocomplete)
 * ---------------------------------------------------------- */

let autocompleteTimer = null;

function makeAddTile() {
  const tile = document.createElement("div");
  tile.className = "card-tile add-tile";

  const plus = document.createElement("button");
  plus.className = "add-plus";
  plus.textContent = "+";
  plus.title = "Add a card to the list";

  const form = document.createElement("div");
  form.className = "add-form hidden";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Card name…";
  input.setAttribute("list", "card-name-suggestions");
  let datalist = $("card-name-suggestions");
  if (!datalist) {
    datalist = document.createElement("datalist");
    datalist.id = "card-name-suggestions";
    document.body.appendChild(datalist);
  }
  const qtyInput = document.createElement("input");
  qtyInput.type = "number";
  qtyInput.min = "1";
  qtyInput.value = "1";
  qtyInput.className = "add-qty";
  qtyInput.title = "Number of copies";
  const addBtn = document.createElement("button");
  addBtn.className = "primary";
  addBtn.textContent = "Add";
  const row = document.createElement("div");
  row.className = "add-row";
  row.append(qtyInput, addBtn);
  form.append(input, row);

  plus.addEventListener("click", () => {
    plus.classList.add("hidden");
    form.classList.remove("hidden");
    input.focus();
  });

  input.addEventListener("input", () => {
    clearTimeout(autocompleteTimer);
    const q = input.value.trim();
    if (q.length < 2) return;
    autocompleteTimer = setTimeout(async () => {
      try {
        const resp = await fetch(`${SCRYFALL}/cards/autocomplete?q=${encodeURIComponent(q)}`);
        if (!resp.ok) return;
        const data = await resp.json();
        datalist.innerHTML = "";
        for (const name of (data.data || []).slice(0, 12)) {
          const opt = document.createElement("option");
          opt.value = name;
          datalist.appendChild(opt);
        }
      } catch { /* suggestions are best-effort */ }
    }, 250);
  });

  const submit = async () => {
    const name = input.value.trim();
    if (!name) return;
    const qty = Math.max(1, parseInt(qtyInput.value, 10) || 1);
    input.disabled = true;
    qtyInput.disabled = true;
    addBtn.disabled = true;
    try {
      await addCustomCard(name, qty);
    } catch (e) {
      console.error(e);
      setStatus(`Could not add "${name}": ${e.message}`, null, true);
      input.disabled = false;
      qtyInput.disabled = false;
      addBtn.disabled = false;
    }
  };
  addBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

  tile.append(plus, form);
  return tile;
}

async function addCustomCard(name, qty = 1) {
  setStatus(`Adding ${name}…`, null);
  const resp = await fetchRetry(`${SCRYFALL}/cards/named?fuzzy=${encodeURIComponent(name)}`);
  if (!resp.ok) throw new Error("card not found on Scryfall");
  const englishCard = await resp.json();

  // Already in the list? Just bump the quantity.
  const existing = cards.find((c) => c.english.oracle_id === englishCard.oracle_id);
  if (existing) {
    existing.qty += qty;
    hideStatus();
    renderGrid();
    return;
  }

  const lang = currentLang;
  const loc = lang !== "en"
    ? (await findLocalizedBatch([englishCard.oracle_id], lang)).get(englishCard.oracle_id)
    : undefined;
  const eng = (await findLocalizedBatch([englishCard.oracle_id], "en")).get(englishCard.oracle_id);
  const built = await buildCardEntry(englishCard, lang, loc, eng);
  cards.push({ name: englishCard.name, qty, section: "mainboard", ...built });
  hideStatus();
  renderGrid();
}

/* ------------------------------------------------------------
 * PDF generation: A4, 3 x 3 grid, 62 x 87 mm cards
 * ---------------------------------------------------------- */

// Rotate a landscape face (split card) back to portrait for printing.
async function rotateToPortrait(dataUrl) {
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.height;
  canvas.height = img.width;
  const ctx = canvas.getContext("2d");
  ctx.translate(0, canvas.height);
  ctx.rotate(-Math.PI / 2);
  ctx.drawImage(img, 0, 0);
  return canvas.toDataURL("image/jpeg", 0.92);
}

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

    // Flatten: each copy of each printed face is one slot. Split cards are
    // stored landscape for display — rotate them back to portrait here.
    const slots = [];
    for (const card of cards) {
      const faces = includeBacks ? card.faces : card.faces.slice(0, 1);
      for (let i = 0; i < card.qty; i++) {
        for (const f of faces) slots.push({ url: f, rotated: !!card.rotated });
      }
    }
    const portraitCache = new Map();
    for (const s of slots) {
      if (s.rotated && !portraitCache.has(s.url)) {
        portraitCache.set(s.url, await rotateToPortrait(s.url));
      }
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

    slots.forEach((slot, i) => {
      const posOnPage = i % (COLS * ROWS);
      if (i > 0 && posOnPage === 0) doc.addPage();
      if (posOnPage === 0) drawCutMarks();
      const col = posOnPage % COLS;
      const row = Math.floor(posOnPage / COLS);
      const x = MARGIN_X + col * CARD_W;
      const y = MARGIN_Y + row * CARD_H;
      const dataUrl = slot.rotated ? portraitCache.get(slot.url) : slot.url;
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
// DeepL needs an API key: show the field only when selected, remember the key
$("translator").addEventListener("change", () => {
  $("deepl-key-wrap").classList.toggle("hidden", $("translator").value !== "deepl");
});
$("deepl-key").value = localStorage.getItem("deeplKey") || "";
$("deepl-key").addEventListener("input", () => {
  localStorage.setItem("deeplKey", $("deepl-key").value.trim());
});

// The "Considering" board and version preference only exist on Moxfield
$("deck-url").addEventListener("input", () => {
  const isMoxfield = /moxfield\.com/i.test($("deck-url").value);
  for (const el of document.querySelectorAll(".moxfield-only")) {
    el.classList.toggle("hidden", !isMoxfield);
  }
});
