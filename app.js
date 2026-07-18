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
let emptyDeck = false; // "start empty and add cards one by one" mode
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

// The event page's document title is "Archetype - Player @ mtgtop8.com";
// the archetype (the entry selected in the left listing) is what we want.
async function fetchMtgTop8Title(eventUrl) {
  try {
    const md = await fetch(`https://r.jina.ai/${eventUrl}`, { signal: AbortSignal.timeout(45000) })
      .then((r) => (r.ok ? r.text() : ""));
    const line = md.match(/^Title:\s*(.+)$/m)?.[1] || "";
    const name = line.replace(/\s*@\s*mtgtop8\.com\s*$/i, "").trim();
    if (!name) return null;
    // Drop the trailing " - Player" segment, keep the archetype
    const parts = name.split(" - ");
    return parts.length > 1 ? parts.slice(0, -1).join(" - ") : name;
  } catch {
    return null;
  }
}

async function loadMtgTop8(url) {
  const m = url.match(/[?&]d=(\d+)/);
  if (!m) throw new Error("Could not extract deck ID (d=…) from MTGTop8 URL");
  const [text, title] = await Promise.all([
    fetchWithProxies(`https://mtgtop8.com/mtgo?d=${m[1]}`),
    fetchMtgTop8Title(url),
  ]);
  const parsed = parseDeckText(text);
  if (parsed.entries.length === 0) throw new Error("MTGTop8 deck appears to be empty");
  parsed.title = title || "MTGTop8 deck";
  parsed.sortByType = true;
  return parsed;
}

// Returns the combined deck (URL and/or pasted list — both load when both
// are given), or null when neither input is filled.
async function loadDecklist() {
  const url = $("deck-url").value.trim();
  const pasted = $("deck-text").value.trim();

  let deck = null;
  if (url) {
    if (/moxfield\.com/i.test(url)) deck = await loadMoxfield(url);
    else if (/mtgtop8\.com/i.test(url)) deck = await loadMtgTop8(url);
    else throw new Error("Unrecognized URL — please use a Moxfield or MTGTop8 deck URL");
  }
  if (pasted) {
    const parsed = parseDeckText(pasted);
    if (parsed.entries.length === 0 && !deck) {
      throw new Error("Could not parse any card from the pasted text");
    }
    if (deck) deck.entries = deck.entries.concat(parsed.entries);
    else deck = parsed;
  }
  return deck;
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

// LLM-based translator (Pollinations, free and CORS-open): unlike generic
// MT engines it can be contextualized, so the prompt teaches it the official
// MtG vocabulary of the target language.
const LANG_NAME = {
  fr: "French", de: "German", it: "Italian", es: "Spanish",
  pt: "Brazilian Portuguese", ja: "Japanese", ko: "Korean", ru: "Russian",
  zhs: "Simplified Chinese", zht: "Traditional Chinese",
};

const MTG_GLOSSARY = {
  fr: "Official French MTG vocabulary (use these exact terms): " +
    'land = terrain (NEVER "terre"), play a land = jouer un terrain, ' +
    "this land = ce terrain, basic land = terrain de base, " +
    'tap = engager ("{T} :"), untap = dégager, tapped = engagé, ' +
    "target = ciblé(e) (after the noun: 'la créature ciblée'), " +
    "any target = n'importe quelle cible, " +
    "deals N damage = inflige N blessures (damage = blessures, NEVER " +
    '"dégâts"), prevent damage = prévenir les blessures, ' +
    "battlefield = champ de bataille, graveyard = cimetière, " +
    "library = bibliothèque, hand = main, exile = exiler, " +
    "cast = lancer, spell = sort, ability = capacité, " +
    "counter target spell = contrecarrez le sort ciblé, " +
    "+1/+1 counter = marqueur +1/+1, age counter = marqueur « âge », " +
    "draw a card = piochez une carte, discard = se défausser de, " +
    "sacrifice = sacrifier, destroy = détruire, return = renvoyer, " +
    "search your library = cherchez dans votre bibliothèque, " +
    "shuffle = mélanger, reveal = révéler, upkeep = entretien, " +
    "cumulative upkeep = entretien cumulatif, end step = étape de fin, " +
    "at the beginning of = au début de, combat = combat, " +
    "attacking creature = créature attaquante, block = bloquer, " +
    "controller = contrôleur, owner = propriétaire, " +
    "opponent = adversaire, player = joueur, " +
    "gain N life = gagnez N points de vie, lose N life = perdez N " +
    "points de vie, pay N life = payez N points de vie, " +
    "token = jeton, copy = copie, permanent = permanent, " +
    "enters = arrive sur le champ de bataille, leaves = quitte, " +
    "dies = meurt, until end of turn = jusqu'à la fin du tour, " +
    "at end of turn = à la fin du tour, add {C} = ajoutez {C}, " +
    "flying = vol, first strike = initiative, deathtouch = contact " +
    "mortel, trample = piétinement, haste = célérité, " +
    "vigilance = vigilance, lifelink = lien de vie, reach = portée, " +
    "menace = menace, defender = défenseur, flash = flash, " +
    "hexproof = défense talismanique, scry = regard, mill = meuler. " +
    'Creature types: goblin = gobelin (NEVER "gobelins" for the type), ' +
    "elf = elfe, dwarf = nain, wizard = sorcier, rogue = gredin, " +
    "wurm = guivre, drake = drakôn.",
  de: "Official German MTG vocabulary (use these exact terms): " +
    "land = Land, tap = tappen, untap = enttappen, tapped = getappt, " +
    "target creature = Kreatur deiner Wahl, battlefield = Schlachtfeld, " +
    "enters = kommt aufs Schlachtfeld, graveyard = Friedhof, " +
    "library = Bibliothek, hand = Hand, exile = ins Exil schicken, " +
    "cast = wirken, spell = Zauberspruch, ability = Fähigkeit, " +
    "counter target spell = neutralisiere den Zauberspruch deiner Wahl, " +
    "deals N damage = fügt N Schadenspunkte zu (damage = Schadenspunkte), " +
    "draw a card = ziehe eine Karte, discard = abwerfen, " +
    "sacrifice = opfern, destroy = zerstören, token = Spielstein, " +
    "creature = Kreatur, sorcery = Hexerei, instant = Spontanzauber, " +
    "enchantment = Verzauberung, artifact = Artefakt, " +
    "upkeep = Versorgungssegment, end step = Endsegment, " +
    "gain N life = erhältst N Lebenspunkte dazu, opponent = Gegner, " +
    "+1/+1 counter = +1/+1-Marke, controller = Beherrscher.",
  es: "Official Spanish MTG vocabulary (use these exact terms): " +
    "land = tierra, tap = girar, untap = enderezar, tapped = girada, " +
    "target creature = la criatura objetivo, " +
    "battlefield = campo de batalla, graveyard = cementerio, " +
    "library = biblioteca, hand = mano, exile = exiliar, " +
    "cast = lanzar, spell = hechizo, ability = habilidad, " +
    "counter target spell = contrarresta el hechizo objetivo, " +
    "deals N damage = hace N puntos de daño, " +
    "draw a card = roba una carta, discard = descartar, " +
    "sacrifice = sacrificar, destroy = destruir, token = ficha, " +
    "creature = criatura, sorcery = conjuro, instant = instantáneo, " +
    "enchantment = encantamiento, artifact = artefacto, " +
    "upkeep = mantenimiento, end step = paso final, " +
    "gain N life = ganas N vidas, opponent = oponente, " +
    "+1/+1 counter = contador +1/+1, controller = controlador.",
  it: "Official Italian MTG vocabulary (use these exact terms): " +
    "land = terra, tap = TAPpare, untap = STAPpare, tapped = TAPpata, " +
    "target creature = la creatura bersaglio, " +
    "battlefield = campo di battaglia, graveyard = cimitero, " +
    "library = grimorio, hand = mano, exile = esiliare, " +
    "cast = lanciare, spell = magia, ability = abilità, " +
    "counter target spell = neutralizza una magia bersaglio, " +
    "deals N damage = infligge N danni, draw a card = pesca una carta, " +
    "discard = scartare, sacrifice = sacrificare, destroy = distruggere, " +
    "token = pedina, creature = creatura, sorcery = stregoneria, " +
    "instant = istantaneo, enchantment = incantesimo, " +
    "artifact = artefatto, upkeep = mantenimento, " +
    "end step = sottofase finale, gain N life = guadagni N punti vita, " +
    "opponent = avversario, +1/+1 counter = segnalino +1/+1, " +
    "controller = controllore.",
  pt: "Official Portuguese MTG vocabulary (use these exact terms): " +
    "land = terreno, tap = virar, untap = desvirar, tapped = virado, " +
    "target creature = a criatura alvo, battlefield = campo de batalha, " +
    "graveyard = cemitério, library = grimório, hand = mão, " +
    "exile = exilar, cast = conjurar, spell = mágica, " +
    "ability = habilidade, counter target spell = anule a mágica alvo, " +
    "deals N damage = causa N pontos de dano, " +
    "draw a card = compre um card, card = card, discard = descartar, " +
    "sacrifice = sacrificar, destroy = destruir, token = ficha, " +
    "creature = criatura, sorcery = feitiço, " +
    "instant = mágica instantânea, enchantment = encantamento, " +
    "artifact = artefato, upkeep = manutenção, end step = etapa final, " +
    "gain N life = ganhe N pontos de vida, opponent = oponente, " +
    "+1/+1 counter = marcador +1/+1, controller = controlador.",
  ja: "Official Japanese MTG vocabulary (use these exact terms): " +
    "land = 土地, tap = タップ, untap = アンタップ, target = 対象, " +
    "battlefield = 戦場, graveyard = 墓地, library = ライブラリー, " +
    "hand = 手札, exile = 追放, cast = 唱える, spell = 呪文, " +
    "ability = 能力, counter target spell = 対象の呪文を打ち消す, " +
    "deals N damage = N点のダメージを与える, draw a card = カードを1枚引く, " +
    "discard = 捨てる, sacrifice = 生け贄に捧げる, destroy = 破壊する, " +
    "token = トークン, creature = クリーチャー, sorcery = ソーサリー, " +
    "instant = インスタント, enchantment = エンチャント, " +
    "artifact = アーティファクト, upkeep = アップキープ, " +
    "end step = 終了ステップ, gain N life = N点のライフを得る, " +
    "opponent = 対戦相手, +1/+1 counter = +1/+1カウンター.",
};

async function aiTranslateImpl(text, lang, opts = {}) {
  const system = opts.isName
    ? "You are an expert Magic: The Gathering translator. The user gives you " +
      `the NAME (title) of a single MTG card. Translate ONLY that name into ` +
      `${LANG_NAME[lang]}, matching the official localized ${LANG_NAME[lang]} ` +
      "card name. It is a short title, NOT rules text: never output an ability, " +
      "reminder text, mana cost or explanation — only the translated name, on " +
      "one line, with nothing added."
    : "You are an expert Magic: The Gathering card translator. Translate the " +
      `English MTG card text given by the user into ${LANG_NAME[lang]}, using ` +
      "EXACTLY the official game terminology printed on localized " +
      `${LANG_NAME[lang]} MTG cards. ${MTG_GLOSSARY[lang] || ""} ` +
      "Preserve line breaks and symbols in braces like {T}, {2}, {W/U} exactly. " +
      'ALL-CAPS tokens like "CARDNAME" or "DUNGEONNAME0" are placeholders for ' +
      "names: keep them EXACTLY as-is in your output, never drop or replace them. " +
      "Output ONLY the translation, nothing else.";
  const resp = await fetchRetry("https://text.pollinations.ai/openai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai",
      messages: [
        { role: "system", content: system },
        { role: "user", content: text },
      ],
    }),
  }, 2);
  if (!resp.ok) throw new Error(`AI translator error (HTTP ${resp.status})`);
  const data = await resp.json();
  let out = data?.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error("AI translator: empty result");
  out = out.replace(/^["«\s]+|["»\s]+$/g, "");
  if (opts.isName) {
    // A name must stay a short single line — reject the model spilling into
    // rules text (a common failure on famous cards like Ancestral Recall).
    if (out.includes("\n") || out.length > text.length * 2 + 20) {
      throw new Error("AI translator: name looks like rules text");
    }
  } else if (out.length > text.length * 4 + 200) {
    throw new Error("AI translator: implausible output"); // guard against chatting
  }
  return out;
}

const MT_PROVIDERS = {
  ai: { label: "AI (MtG-aware)", fn: aiTranslateImpl },
  google: { label: "Google Translate", fn: googleTranslateImpl },
  bing: { label: "Microsoft Translator", fn: bingTranslateImpl },
  mymemory: { label: "MyMemory", fn: myMemoryTranslateImpl },
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
    "Token Creature": "Créature-jeton", "Token Artifact": "Artefact-jeton",
    "Token Enchantment": "Enchantement-jeton",
    "Token Artifact Creature": "Créature-artefact-jeton",
    "Token Enchantment Creature": "Créature-enchantement-jeton",
    "Token Legendary Creature": "Créature-jeton légendaire",
    "Legendary Token Creature": "Créature-jeton légendaire",
    "Emblem": "Emblème",
  },
  de: {
    "Emblem": "Emblem",
    "Token Creature": "Spielstein-Kreatur", "Token Artifact": "Spielstein-Artefakt",
    "Token Artifact Creature": "Spielstein-Artefaktkreatur",
    "Token Legendary Creature": "Legendäre Spielstein-Kreatur",
    "Land": "Land", "Creature": "Kreatur", "Artifact": "Artefakt",
    "Enchantment": "Verzauberung", "Instant": "Spontanzauber", "Sorcery": "Hexerei",
    "Planeswalker": "Planeswalker", "Basic Land": "Standardland",
    "Legendary Creature": "Legendäre Kreatur", "Legendary Land": "Legendäres Land",
    "Legendary Artifact": "Legendäres Artefakt", "Artifact Creature": "Artefaktkreatur",
  },
  es: {
    "Emblem": "Emblema",
    "Token Creature": "Ficha de criatura", "Token Artifact": "Ficha de artefacto",
    "Token Artifact Creature": "Ficha de criatura artefacto",
    "Token Legendary Creature": "Ficha de criatura legendaria",
    "Land": "Tierra", "Creature": "Criatura", "Artifact": "Artefacto",
    "Enchantment": "Encantamiento", "Instant": "Instantáneo", "Sorcery": "Conjuro",
    "Planeswalker": "Planeswalker", "Basic Land": "Tierra básica",
    "Legendary Creature": "Criatura legendaria", "Legendary Land": "Tierra legendaria",
    "Artifact Creature": "Criatura artefacto",
  },
  it: {
    "Emblem": "Emblema",
    "Token Creature": "Pedina Creatura", "Token Artifact": "Pedina Artefatto",
    "Token Artifact Creature": "Pedina Creatura Artefatto",
    "Token Legendary Creature": "Pedina Creatura Leggendaria",
    "Land": "Terra", "Creature": "Creatura", "Artifact": "Artefatto",
    "Enchantment": "Incantesimo", "Instant": "Istantaneo", "Sorcery": "Stregoneria",
    "Planeswalker": "Planeswalker", "Basic Land": "Terra Base",
    "Legendary Creature": "Creatura Leggendaria", "Artifact Creature": "Creatura Artefatto",
  },
  pt: {
    "Emblem": "Emblema",
    "Token Creature": "Ficha de criatura", "Token Artifact": "Ficha de artefato",
    "Token Artifact Creature": "Ficha de criatura artefato",
    "Token Legendary Creature": "Ficha de criatura lendária",
    "Land": "Terreno", "Creature": "Criatura", "Artifact": "Artefato",
    "Enchantment": "Encantamento", "Instant": "Mágica Instantânea", "Sorcery": "Feitiço",
    "Planeswalker": "Planeswalker", "Basic Land": "Terreno Básico",
    "Legendary Creature": "Criatura Lendária", "Artifact Creature": "Criatura Artefato",
  },
  ja: {
    "Emblem": "紋章",
    "Token Creature": "トークン・クリーチャー", "Token Artifact": "トークン・アーティファクト",
    "Token Artifact Creature": "トークン・アーティファクト・クリーチャー",
    "Land": "土地", "Creature": "クリーチャー", "Artifact": "アーティファクト",
    "Enchantment": "エンチャント", "Instant": "インスタント", "Sorcery": "ソーサリー",
    "Planeswalker": "プレインズウォーカー", "Basic Land": "基本土地",
    "Legendary Creature": "伝説のクリーチャー",
  },
};
// French printed type lines separate subtypes with " : " instead of " — "
const TYPE_SEP = { fr: " : " };

// Official French creature/artifact subtypes (printed lowercase, joined
// with "et"): translated deterministically instead of machine-translated.
const SUBTYPE_DICT = {
  fr: {
    goblin: "gobelin", soldier: "soldat", zombie: "zombie", spirit: "esprit",
    elf: "elfe", dwarf: "nain", giant: "géant", ogre: "ogre", troll: "troll",
    orc: "orque", human: "humain", kor: "kor", merfolk: "ondin",
    vampire: "vampire", skeleton: "squelette", nightmare: "cauchemar",
    imp: "diablotin", devil: "diable", demon: "démon", angel: "ange",
    dragon: "dragon", drake: "drakôn", wurm: "guivre", hydra: "hydre",
    sphinx: "sphinx", griffin: "griffon", pegasus: "pégase", phoenix: "phénix",
    unicorn: "licorne", elemental: "élémental", golem: "golem", myr: "myr",
    thopter: "mécanoptère", construct: "construction", gnome: "gnome",
    gargoyle: "gargouille", illusion: "illusion", avatar: "avatar",
    sliver: "slivoïde", eldrazi: "eldrazi", faerie: "fée", satyr: "satyre",
    knight: "chevalier", warrior: "guerrier", wizard: "sorcier",
    sorcerer: "ensorceleur", cleric: "clerc", rogue: "gredin",
    monk: "moine", shaman: "shamane",
    ninja: "ninja", samurai: "samouraï", pirate: "pirate",
    beast: "bête", bird: "oiseau", cat: "chat", dog: "chien", wolf: "loup",
    bear: "ours", boar: "sanglier", elephant: "éléphant", horse: "cheval",
    goat: "chèvre", snake: "serpent", lizard: "lézard", frog: "grenouille",
    fish: "poisson", whale: "baleine", octopus: "pieuvre", crab: "crabe",
    kraken: "kraken", spider: "araignée", scorpion: "scorpion",
    insect: "insecte", bat: "chauve-souris", rat: "rat", mouse: "souris",
    squirrel: "écureuil", plant: "plante", saproling: "saprobionte",
    wall: "mur", minotaur: "minotaure",
    treasure: "trésor", clue: "indice", food: "nourriture",
    blood: "sang", gold: "or", map: "carte", powerstone: "pierre de puissance",
  },
  de: {
    goblin: "Goblin", soldier: "Soldat", zombie: "Zombie", spirit: "Geist",
    elf: "Elf", dwarf: "Zwerg", giant: "Riese", ogre: "Oger", troll: "Troll",
    human: "Mensch", knight: "Ritter", warrior: "Krieger", wizard: "Zauberer",
    cleric: "Kleriker", skeleton: "Skelett", vampire: "Vampir",
    angel: "Engel", demon: "Dämon", dragon: "Drache", hydra: "Hydra",
    sphinx: "Sphinx", phoenix: "Phönix", unicorn: "Einhorn", wurm: "Wurm",
    elemental: "Elementarwesen", golem: "Golem",
    beast: "Bestie", bird: "Vogel", cat: "Katze", dog: "Hund", wolf: "Wolf",
    bear: "Bär", boar: "Eber", elephant: "Elefant", horse: "Pferd",
    goat: "Ziege", snake: "Schlange", insect: "Insekt", rat: "Ratte",
    mouse: "Maus", squirrel: "Eichhörnchen", spider: "Spinne", fish: "Fisch",
    frog: "Frosch", plant: "Pflanze", wall: "Mauer", saproling: "Saproling",
    treasure: "Schatz", clue: "Hinweis", food: "Nahrung", blood: "Blut",
    gold: "Gold", map: "Karte",
  },
  es: {
    goblin: "Trasgo", soldier: "Soldado", zombie: "Zombie", spirit: "Espíritu",
    elf: "Elfo", dwarf: "Enano", giant: "Gigante", ogre: "Ogro", troll: "Trol",
    human: "Humano", knight: "Caballero", warrior: "Guerrero",
    wizard: "Hechicero", cleric: "Clérigo", skeleton: "Esqueleto",
    vampire: "Vampiro", angel: "Ángel", demon: "Demonio", dragon: "Dragón",
    hydra: "Hidra", sphinx: "Esfinge", phoenix: "Fénix", unicorn: "Unicornio",
    wurm: "Sierpe", elemental: "Elemental", golem: "Gólem",
    beast: "Bestia", bird: "Ave", cat: "Felino", dog: "Perro", wolf: "Lobo",
    bear: "Oso", elephant: "Elefante", horse: "Caballo", goat: "Cabra",
    snake: "Serpiente", insect: "Insecto", rat: "Rata", mouse: "Ratón",
    squirrel: "Ardilla", spider: "Araña", fish: "Pez", frog: "Rana",
    plant: "Planta", wall: "Muro",
    treasure: "Tesoro", clue: "Pista", food: "Comida", blood: "Sangre",
    gold: "Oro", map: "Mapa",
  },
  it: {
    goblin: "Goblin", soldier: "Soldato", zombie: "Zombie", spirit: "Spirito",
    elf: "Elfo", dwarf: "Nano", giant: "Gigante", ogre: "Ogre", troll: "Troll",
    human: "Umano", knight: "Cavaliere", warrior: "Guerriero", wizard: "Mago",
    cleric: "Chierico", skeleton: "Scheletro", vampire: "Vampiro",
    angel: "Angelo", demon: "Demone", dragon: "Drago", hydra: "Idra",
    sphinx: "Sfinge", phoenix: "Fenice", unicorn: "Unicorno",
    elemental: "Elementale", golem: "Golem",
    beast: "Bestia", bird: "Uccello", cat: "Felino", dog: "Cane",
    wolf: "Lupo", bear: "Orso", elephant: "Elefante", horse: "Cavallo",
    goat: "Capra", snake: "Serpente", insect: "Insetto", rat: "Ratto",
    mouse: "Topo", squirrel: "Scoiattolo", spider: "Ragno", fish: "Pesce",
    frog: "Rana", plant: "Pianta", wall: "Muro",
    treasure: "Tesoro", clue: "Indizio", food: "Cibo", blood: "Sangue",
    gold: "Oro", map: "Mappa",
  },
  pt: {
    goblin: "Goblin", soldier: "Soldado", zombie: "Zumbi", spirit: "Espírito",
    elf: "Elfo", dwarf: "Anão", giant: "Gigante", ogre: "Ogro", troll: "Trol",
    human: "Humano", knight: "Cavaleiro", warrior: "Guerreiro", wizard: "Mago",
    cleric: "Clérigo", skeleton: "Esqueleto", vampire: "Vampiro",
    angel: "Anjo", demon: "Demônio", dragon: "Dragão", hydra: "Hidra",
    sphinx: "Esfinge", phoenix: "Fênix", unicorn: "Unicórnio",
    elemental: "Elemental", golem: "Golem",
    beast: "Fera", bird: "Ave", cat: "Felino", dog: "Cão", wolf: "Lobo",
    bear: "Urso", elephant: "Elefante", horse: "Cavalo", goat: "Cabra",
    snake: "Serpente", insect: "Inseto", rat: "Rato",
    squirrel: "Esquilo", spider: "Aranha", fish: "Peixe", frog: "Rã",
    plant: "Planta", wall: "Muro",
    treasure: "Tesouro", clue: "Pista", food: "Comida", blood: "Sangue",
    gold: "Ouro", map: "Mapa",
  },
  ja: {
    goblin: "ゴブリン", soldier: "兵士", zombie: "ゾンビ", spirit: "スピリット",
    elf: "エルフ", dwarf: "ドワーフ", giant: "巨人", ogre: "オーガ", troll: "トロール",
    human: "人間", knight: "騎士", warrior: "戦士", wizard: "ウィザード",
    cleric: "クレリック", skeleton: "スケルトン", vampire: "吸血鬼",
    angel: "天使", demon: "デーモン", dragon: "ドラゴン", hydra: "ハイドラ",
    sphinx: "スフィンクス", phoenix: "フェニックス", unicorn: "ユニコーン",
    elemental: "エレメンタル", golem: "ゴーレム",
    beast: "ビースト", bird: "鳥", cat: "猫", dog: "犬", wolf: "狼",
    bear: "熊", elephant: "象", horse: "馬", snake: "蛇", insect: "昆虫",
    rat: "ネズミ", squirrel: "リス", spider: "蜘蛛", fish: "魚",
    plant: "植物", wall: "壁",
    treasure: "宝物", clue: "手掛かり", food: "食物", blood: "血",
    gold: "金", map: "地図",
  },
};

// Separator between translated subtypes ("Mouse Soldier"): French joins
// with "et", Japanese with the middle dot, other languages with a space.
const SUBTYPE_JOIN = { fr: " et ", ja: "・" };

async function translateTypeLine(typeLine, lang) {
  const [types, subtypes] = typeLine.split(/\s+—\s+/);
  const official = TYPE_DICT[lang]?.[types];
  if (!official) return { text: await machineTranslate(typeLine, lang), mt: true };
  if (!subtypes) return { text: official, mt: false };
  const dict = SUBTYPE_DICT[lang];
  const words = subtypes.split(/\s+/);
  if (dict && words.every((w) => dict[w.toLowerCase()])) {
    const sub = words.map((w) => dict[w.toLowerCase()]).join(SUBTYPE_JOIN[lang] || " ");
    return { text: official + (TYPE_SEP[lang] || " — ") + sub, mt: false };
  }
  const sub = await machineTranslate(subtypes, lang);
  return { text: official + (TYPE_SEP[lang] || " — ") + sub, mt: true };
}

// Text boxes made only of keywords ("Flying", "Flying, deathtouch"…) get
// the official printed wording, never machine translation.
const KEYWORD_DICT = {
  fr: {
    flying: "vol", "first strike": "initiative",
    "double strike": "double initiative", deathtouch: "contact mortel",
    trample: "piétinement", haste: "célérité", vigilance: "vigilance",
    lifelink: "lien de vie", reach: "portée", menace: "menace",
    defender: "défenseur", flash: "flash", indestructible: "indestructible",
    hexproof: "défense talismanique", prowess: "prouesse", fear: "peur",
    shroud: "linceul", changeling: "changeforme",
  },
  de: {
    flying: "Fliegend", "first strike": "Erstschlag",
    "double strike": "Doppelschlag", deathtouch: "Todesberührung",
    trample: "Verursacht Trampelschaden", haste: "Eile",
    vigilance: "Wachsamkeit", lifelink: "Lebensverknüpfung",
    reach: "Reichweite", menace: "Bedrohlich", defender: "Verteidiger",
    flash: "Aufblitzen", indestructible: "Unzerstörbar",
    hexproof: "Fluchsicher", prowess: "Bravour", fear: "Furcht",
  },
  es: {
    flying: "Vuela", "first strike": "Daña primero",
    "double strike": "Daña dos veces", deathtouch: "Toque mortal",
    trample: "Arrolla", haste: "Prisa", vigilance: "Vigilancia",
    lifelink: "Vínculo vital", reach: "Alcance", menace: "Amenaza",
    defender: "Defensor", flash: "Destello", indestructible: "Indestructible",
    hexproof: "Antimaleficio", prowess: "Valentía", fear: "Miedo",
  },
  it: {
    flying: "Volare", "first strike": "Attacco improvviso",
    "double strike": "Doppio attacco", deathtouch: "Tocco letale",
    trample: "Travolgere", haste: "Rapidità", vigilance: "Cautela",
    lifelink: "Legame vitale", reach: "Raggiungere", menace: "Minacciare",
    defender: "Difensore", flash: "Lampo", indestructible: "Indistruttibile",
    prowess: "Prodezza", fear: "Paura",
  },
  pt: {
    flying: "Voar", "first strike": "Iniciativa",
    "double strike": "Golpe duplo", deathtouch: "Toque mortífero",
    trample: "Atropelar", haste: "Ímpeto", vigilance: "Vigilância",
    lifelink: "Vínculo com a vida", reach: "Alcance", menace: "Ameaçar",
    defender: "Defensor", flash: "Lampejo", indestructible: "Indestrutível",
    fear: "Medo",
  },
  ja: {
    flying: "飛行", "first strike": "先制攻撃", "double strike": "二段攻撃",
    deathtouch: "接死", trample: "トランプル", haste: "速攻",
    vigilance: "警戒", lifelink: "絆魂", reach: "到達", menace: "威迫",
    defender: "防衛", flash: "瞬速", indestructible: "破壊不能",
    hexproof: "呪禁", prowess: "果敢",
  },
};

function translateKeywordText(text, lang) {
  const dict = KEYWORD_DICT[lang];
  if (!dict) return null;
  const out = [];
  for (const line of text.split("\n")) {
    const parts = line.split(/,\s*/).map((p) => dict[p.trim().toLowerCase()]);
    if (parts.some((p) => !p)) return null;
    out.push(parts.map((p, i) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p)).join(", "));
  }
  return out.join("\n");
}

// Machine-translate with the provider chosen in the "Translator" dropdown,
// falling back to the other providers if it fails.
async function machineTranslate(text, lang, opts = {}) {
  const selected = $("translator").value || "google";
  const order = [selected, ...Object.keys(MT_PROVIDERS).filter((k) => k !== selected)];
  let lastError = null;
  for (const key of order) {
    try {
      const out = await MT_PROVIDERS[key].fn(text, lang, opts);
      // Some providers emit the two characters "\n" instead of a newline
      return out.replace(/\\n/g, "\n");
    } catch (e) {
      console.warn(`${MT_PROVIDERS[key].label} failed:`, e);
      lastError = e;
    }
  }
  throw lastError || new Error("All translators failed");
}

// Translated name of a deck card (or of one of its faces) whose English
// name is `engName` — used to name emblems after their producing card.
function deckFaceName(engName) {
  for (const c of cards) {
    if (!c.english) continue;
    if (c.english.name === engName) return c.printedName || null;
    const idx = (c.english.card_faces || []).findIndex((f) => f.name === engName);
    if (idx >= 0) {
      const parts = (c.printedName || "").split(" // ");
      return parts[idx] || parts[0] || null;
    }
  }
  return null;
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
      if (!t.name) {
        // Tokens named after their creature type ("Goblin", "Zombie"…)
        // take the official subtype word, not machine translation.
        const sub = /\bToken\b/.test(face.type_line || "") && !face.name.includes(" ")
          ? SUBTYPE_DICT[lang]?.[face.name.toLowerCase()] : null;
        // Emblems are named after the card that produces them: reuse that
        // card's translated name from the deck (the producer may be one
        // face of a double-faced planeswalker).
        const producerName = /^Emblem\b/.test(face.type_line || "")
          ? deckFaceName(face.name.replace(/ Emblem$/, ""))
          : null;
        if (HELPER_NAMES[face.name]?.[lang]) {
          t.name = HELPER_NAMES[face.name][lang];
        } else if (producerName) {
          t.name = producerName;
        } else if (sub) {
          t.name = sub.charAt(0).toUpperCase() + sub.slice(1);
        } else if (/\bDungeon\b/.test(face.type_line || "")) {
          t.name = face.name; // dungeon names are proper nouns
        } else {
          t.name = await machineTranslate(face.name, lang, { isName: true });
          usedMT = true;
        }
      }
      if (!t.type && face.type_line) {
        const tl = await translateTypeLine(face.type_line, lang);
        t.type = tl.text;
        usedMT = usedMT || tl.mt;
      }
      const engText = face.oracle_text || "";
      if (!t.text && engText) {
        // Keyword-only text ("Flying, deathtouch") → official wording
        t.text = translateKeywordText(engText, lang);
      }
      if (!t.text && engText) {
        // Cards referring to themselves: shield the name behind a token
        // that survives translation, then re-inject the translated name
        // (already resolved above).
        let src = engText;
        let substituted = false;
        if (t.name && t.name !== face.name) {
          const short = face.name.split(",")[0].trim();
          if (src.includes(face.name) || (short !== face.name && src.includes(short))) {
            src = src.split(face.name).join("CARDNAME");
            if (short !== face.name) src = src.split(short).join("CARDNAME");
            substituted = true;
          }
        }
        // Dungeon names referenced in the text (e.g. "venture into
        // Undercity" on The Initiative) are proper nouns: shield them too.
        const dungeonNames = faces
          .filter((f) => /\bDungeon\b/.test(f.type_line || "") && src.includes(f.name))
          .map((f) => f.name);
        dungeonNames.forEach((n, j) => { src = src.split(n).join(`DUNGEONNAME${j}`); });
        t.text = await machineTranslate(src, lang);
        if (substituted) {
          t.text = t.text.replace(/cardname/gi, t.name);
        }
        dungeonNames.forEach((n, j) => {
          t.text = t.text.replace(new RegExp(`dungeonname${j}`, "gi"), n);
        });
        usedMT = true;
      }
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
 * Low-resolution scans: Scryfall flags them via image_status
 * ("lowres" / "placeholder" instead of "highres_scan"). They print
 * blurry, so they are upscaled and sharpened — the HD badge on the
 * card lets the user switch back to the original scan.
 * ---------------------------------------------------------- */

// One pass of a separable 3x3 (1-2-1) Gaussian blur; returns a new buffer.
function blur121(src, W, H) {
  const tmp = new Uint8ClampedArray(src.length);
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < H; y++) {
    const row = y * W * 4;
    for (let x = 0; x < W; x++) {
      const i = row + x * 4;
      const l = row + Math.max(0, x - 1) * 4;
      const r = row + Math.min(W - 1, x + 1) * 4;
      tmp[i] = (src[l] + 2 * src[i] + src[r]) / 4;
      tmp[i + 1] = (src[l + 1] + 2 * src[i + 1] + src[r + 1]) / 4;
      tmp[i + 2] = (src[l + 2] + 2 * src[i + 2] + src[r + 2]) / 4;
    }
  }
  for (let y = 0; y < H; y++) {
    const row = y * W * 4;
    const up = Math.max(0, y - 1) * W * 4;
    const dn = Math.min(H - 1, y + 1) * W * 4;
    for (let x = 0; x < W; x++) {
      const i = row + x * 4, u = up + x * 4, d = dn + x * 4;
      out[i] = (tmp[u] + 2 * tmp[i] + tmp[d]) / 4;
      out[i + 1] = (tmp[u + 1] + 2 * tmp[i + 1] + tmp[d + 1]) / 4;
      out[i + 2] = (tmp[u + 2] + 2 * tmp[i + 2] + tmp[d + 2]) / 4;
    }
  }
  return out;
}

// Upscale to ~2x (capped at the size of a highres "large" scan doubled) with
// smooth interpolation, then apply an unsharp mask so edges and text come
// out crisp at print size instead of blurry.
function enhanceBitmap(bitmap) {
  const scale = Math.max(1, Math.min(2, 1344 / bitmap.width));
  const W = Math.round(bitmap.width * scale);
  const H = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, W, H);

  const img = ctx.getImageData(0, 0, W, H);
  const data = img.data;
  // Blur twice: after the 2x upscale the blur radius must exceed the
  // interpolation's own smoothing for the mask to bite.
  const blurred = blur121(blur121(data, W, H), W, H);
  const AMOUNT = 0.8;
  for (let i = 0; i < data.length; i += 4) {
    data[i] += AMOUNT * (data[i] - blurred[i]);
    data[i + 1] += AMOUNT * (data[i + 1] - blurred[i + 1]);
    data[i + 2] += AMOUNT * (data[i + 2] - blurred[i + 2]);
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// A face image of the selected print, enhanced when only a low-resolution
// scan exists — unless the user clicked the HD badge to keep the original.
async function loadFaceImage(entry, url) {
  const bitmap = await loadImage(url);
  if (!entry.lowResScan || entry.useOriginalImage) return bitmap;
  const enhanced = enhanceBitmap(bitmap);
  bitmap.close?.();
  return enhanced;
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

// Borderless parchment fill, for blanking leftover original text
// While buildFaces paints a face, every parchment rectangle is logged here
// (as width/height fractions) — the grid uses it to make exactly the
// repainted areas clickable for manual text editing.
let regionLog = null;
function logRegion(ctx, x0, y0, x1, y1) {
  if (!regionLog) return;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  regionLog.push([x0 / W, y0 / H, x1 / W, y1 / H]);
}

// Dominant color of the card area a box is about to cover, sampled from the
// canvas before painting (downscaled, then a coarse color histogram — the
// text glyphs on top of the background land in their own buckets and are
// outvoted, so the winner is the background of the covered box itself).
function regionBaseColor(ctx, x0, y0, x1, y1) {
  const S = 32;
  const c = document.createElement("canvas");
  c.width = S; c.height = S;
  const cx = c.getContext("2d");
  cx.drawImage(ctx.canvas, x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0), 0, 0, S, S);
  const d = cx.getImageData(0, 0, S, S).data;
  const buckets = new Map();
  for (let i = 0; i < d.length; i += 4) {
    const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    const b = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    b.n++; b.r += d[i]; b.g += d[i + 1]; b.b += d[i + 2];
    buckets.set(key, b);
  }
  let best = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  return { r: best.r / best.n, g: best.g / best.n, b: best.b / best.n };
}

// Fill / border / ink colors for a box, matched to the area it covers so it
// blends with the frame: the dark title bar of a black card gets a dark box
// with light text, not a glaring cream rectangle.
function boxStyle(ctx, x0, y0, x1, y1) {
  let base = null;
  try { base = regionBaseColor(ctx, x0, y0, x1, y1); } catch { /* keep the parchment default */ }
  if (!base) return { fill: "#f3eedf", stroke: "rgba(60, 50, 30, 0.65)", ink: "#141210" };
  const fill = `rgb(${Math.round(base.r)}, ${Math.round(base.g)}, ${Math.round(base.b)})`;
  const lum = 0.299 * base.r + 0.587 * base.g + 0.114 * base.b;
  return lum < 130
    ? { fill, stroke: "rgba(235, 231, 222, 0.55)", ink: "#f3efe6" }
    : { fill, stroke: "rgba(60, 50, 30, 0.65)", ink: "#141210" };
}

function paintPatch(ctx, x0, y0, x1, y1) {
  logRegion(ctx, x0, y0, x1, y1);
  const style = boxStyle(ctx, x0, y0, x1, y1);
  ctx.fillStyle = style.fill; // fully opaque or the English text ghosts through
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  return style;
}

function paintParchment(ctx, W, x0, y0, x1, y1) {
  logRegion(ctx, x0, y0, x1, y1);
  const style = boxStyle(ctx, x0, y0, x1, y1);
  ctx.fillStyle = style.fill; // fully opaque or the English text ghosts through
  ctx.strokeStyle = style.stroke;
  ctx.lineWidth = Math.max(1, 0.003 * W);
  ctx.beginPath();
  ctx.roundRect(x0, y0, x1 - x0, y1 - y0, 0.01 * W);
  ctx.fill();
  ctx.stroke();
  return style;
}

// Single line, shrunk to fit, vertically centered in its bar
// (horizontally centered too with `center` — token frames center the name)
function paintBarText(ctx, W, text, x0, y0, x1, y1, style, center = false) {
  const box = paintParchment(ctx, W, x0, y0, x1, y1);
  const pad = 0.015 * W;
  const maxW = x1 - x0 - 2 * pad;
  let size = (y1 - y0) * 0.62;
  for (;;) {
    ctx.font = `${style}${size}px Georgia, "Times New Roman", serif`;
    if (ctx.measureText(text).width <= maxW || size < (y1 - y0) * 0.3) break;
    size *= 0.94;
  }
  ctx.fillStyle = box.ink;
  ctx.textBaseline = "middle";
  const x = center
    ? x0 + pad + Math.max(0, (maxW - ctx.measureText(text).width) / 2)
    : x0 + pad;
  ctx.fillText(text, x, (y0 + y1) / 2, maxW);
}

// Wrapped rules text, shrunk to fit its box, with {X} tokens drawn as
// game symbols (call preloadSymbols() on the text beforehand).
function paintTextBox(ctx, W, baseFontSize, text, x0, y0, x1, y1) {
  const pad = 0.018 * W;
  const box = paintParchment(ctx, W, x0, y0, x1, y1);
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

  ctx.fillStyle = box.ink;
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

// Draw a mana cost with the official symbol images, right-aligned at xRight.
function drawManaCost(ctx, manaCost, xRight, yCenter, size) {
  const syms = (manaCost || "").match(/\{([^}]+)\}/g) || [];
  let x = xRight - syms.length * size * 1.1;
  for (const s of syms) {
    const img = symbolFor(s.replace(/[{}]/g, ""));
    if (img) ctx.drawImage(img, x, yCenter - size / 2, size, size);
    x += size * 1.1;
  }
}

// Draw the English card, then paint the translated name, type line and
// rules text over their respective areas of a standard modern frame.
// `manaSymbols` = number of mana symbols, kept uncovered in the title bar.
// `hasPT` shrinks the text box so the power/toughness box stays visible.
function drawWithOverlay(bitmap, tr, manaSymbols, hasPT) {
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
    if (hasPT) {
      // Shrink the box above the P/T (kept visible), and blank the original
      // text bottom left of it with a borderless patch
      paintPatch(ctx, 0.07 * W, 0.868 * H, 0.72 * W, 0.922 * H);
      paintTextBox(ctx, W, 0.034 * H, tr.text, 0.07 * W, 0.615 * H, 0.93 * W, 0.885 * H);
    } else {
      paintTextBox(ctx, W, 0.034 * H, tr.text, 0.07 * W, 0.615 * H, 0.93 * W, 0.925 * H);
    }
  }

  return canvas.toDataURL("image/jpeg", 0.92);
}

// Adventure cards: the text area is split into the adventure half (left
// column, with its own name/type/mana) and the creature text (right column).
// Region fractions calibrated on Scryfall "large" adventure scans.
function drawAdventureOverlay(bitmap, texts, engFaces, hasPT) {
  const W = bitmap.width, H = bitmap.height;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);

  const creature = texts[0] || {}, adventure = texts[1] || {};
  const creatureMana = (engFaces[0]?.mana_cost || "").match(/{[^}]+}/g)?.length || 0;

  // Creature: standard name and type bars, text in the right column
  if (creature.name) {
    const x1 = (creatureMana > 0 ? 0.925 - creatureMana * 0.052 - 0.012 : 0.93) * W;
    paintBarText(ctx, W, creature.name, 0.068 * W, 0.048 * H, x1, 0.100 * H, "bold ");
  }
  if (creature.type) {
    paintBarText(ctx, W, creature.type, 0.068 * W, 0.563 * H, 0.872 * W, 0.610 * H, "bold ");
  }
  // Adventure half (left column): name bar with the adventure's own mana
  // cost redrawn beside it, then type bar and text
  if (adventure.name) {
    paintBarText(ctx, W, adventure.name, 0.078 * W, 0.622 * H, 0.512 * W, 0.672 * H, "bold ");
    paintParchment(ctx, W, 0.512 * W, 0.622 * H, 0.640 * W, 0.684 * H);
    drawManaCost(ctx, engFaces[1]?.mana_cost, 0.632 * W, 0.651 * H, 0.034 * H);
  }
  if (adventure.type) {
    paintBarText(ctx, W, adventure.type, 0.078 * W, 0.678 * H, 0.508 * W, 0.726 * H, "bold ");
  }
  if (adventure.text) {
    paintTextBox(ctx, W, 0.028 * H, adventure.text, 0.078 * W, 0.732 * H, 0.505 * W, 0.918 * H);
  }

  // Creature text (right column): starts below the adventure header row —
  // blank the original first line beside the header, and the flavor area
  // above the P/T box
  if (creature.text) {
    paintPatch(ctx, 0.643 * W, 0.618 * H, 0.925 * W, 0.682 * H);
    paintPatch(ctx, 0.52 * W, 0.868 * H, hasPT ? 0.72 * W : 0.925 * W, 0.922 * H);
    const y1 = hasPT ? 0.885 : 0.915;
    paintTextBox(ctx, W, 0.028 * H, creature.text, 0.52 * W, 0.678 * H, 0.925 * W, y1 * H);
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

// Token / emblem frame (M15 token style): centered name in a rounded bar at
// the top, type bar and text box in the lower third (the art window is much
// taller than on a normal card). On textless (vanilla) tokens there is no
// text box at all and the type bar sits just above the P/T box. Region
// fractions calibrated on Scryfall "large" token scans.
function drawTokenOverlay(bitmap, tr, hasPT, textless = false) {
  const W = bitmap.width, H = bitmap.height;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);

  if (tr.name) {
    paintBarText(ctx, W, tr.name, 0.085 * W, 0.057 * H, 0.915 * W, 0.111 * H, "bold ", true);
  }
  if (tr.type) {
    // Leave the set symbol (right side of the type bar) visible
    const typeY = textless ? [0.812, 0.878] : [0.686, 0.744];
    paintBarText(ctx, W, tr.type, 0.075 * W, typeY[0] * H, 0.865 * W, typeY[1] * H, "bold ");
  }
  if (tr.text && !textless) {
    if (hasPT) {
      // Blank the original text left of the P/T box, keep the P/T visible
      paintPatch(ctx, 0.09 * W, 0.895 * H, 0.77 * W, 0.95 * H);
      paintTextBox(ctx, W, 0.030 * H, tr.text, 0.085 * W, 0.762 * H, 0.915 * W, 0.905 * H);
    } else {
      paintTextBox(ctx, W, 0.030 * H, tr.text, 0.085 * W, 0.762 * H, 0.915 * W, 0.945 * H);
    }
  }

  return canvas.toDataURL("image/jpeg", 0.92);
}

// Game-aid helper cards (The Monarch, City's Blessing…): a black rounded
// title bar with a freeform text panel below it, at a different height on
// each card — every known helper has its own calibrated regions (fractions
// of the card height, calibrated on the newest printing, which is the one
// selected by default). `box: null` = full-art helper, name bar only.
// Official localized names for the game-aid helpers — fixed game
// vocabulary, so machine translation (which can drift) is never used.
const HELPER_NAMES = {
  "City's Blessing": { fr: "Agrément de la cité", de: "Segen der Stadt",
    es: "El beneplácito de la ciudad", it: "Benedizione della città",
    pt: "Bênção da cidade", ja: "都市の承認" },
  "The Monarch": { fr: "Le monarque", de: "Der Monarch", es: "El monarca",
    it: "Il monarca", pt: "O monarca", ja: "統治者" },
  "The Initiative": { fr: "L'initiative", de: "Die Initiative",
    es: "La iniciativa", it: "L'iniziativa", pt: "A iniciativa",
    ja: "イニシアチブ" },
  "Energy Reserve": { fr: "Réserve d'énergie", de: "Energiereserve",
    es: "Reserva de energía", it: "Riserva di energia",
    pt: "Reserva de energia" },
};

const HELPER_GEOM = {
  "The Monarch":         { bar: [0.569, 0.621], box: [0.628, 0.922] },
  "City's Blessing":     { bar: [0.680, 0.732], box: null }, // flavor only: kept as printed
  "The Initiative":      { bar: [0.569, 0.621], box: [0.628, 0.922] },
  "Start Your Engines!": { bar: [0.674, 0.730], box: [0.737, 0.922] },
  "Max Speed":           { bar: [0.056, 0.107], box: null },
  "Energy Reserve":      { bar: [0.056, 0.107], box: null },
};

function drawHelperOverlay(bitmap, tr, geom) {
  const W = bitmap.width, H = bitmap.height;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);

  if (tr.name) {
    paintBarText(ctx, W, tr.name, 0.085 * W, geom.bar[0] * H, 0.915 * W, geom.bar[1] * H, "bold ", true);
  }
  if (tr.text && geom.box) {
    paintTextBox(ctx, W, 0.030 * H, tr.text, 0.08 * W, geom.box[0] * H, 0.92 * W, geom.box[1] * H);
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

// Layouts whose frame geometry supports the translation overlay: standard
// frames, split cards (drawn rotated with per-half regions), adventures
// (two-column text area) and tokens/emblems (M15 token frame). Others
// (flip, saga, class…) keep the English scan.
const TOKEN_LAYOUTS = new Set(["token", "double_faced_token", "emblem"]);
const OVERLAY_LAYOUTS = new Set(["normal", "transform", "modal_dfc", "meld", "split", "adventure",
  ...TOKEN_LAYOUTS]);

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
    let pool = langPrints.length ? langPrints : engPrints;
    if (TOKEN_LAYOUTS.has(englishCard.layout)) {
      // The token overlay geometry is calibrated on the M15 token frame
      const modern = pool.filter((p) => p.frame === "2015");
      if (modern.length) pool = modern;
    }
    best = bestOf(pool);
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
// of the user's "keep English" choice). Dungeons are maps with no frame to
// paint on; game-aid helpers (type "Card") are freeform panels, translated
// only when their layout is known (HELPER_GEOM), like The Monarch or
// City's Blessing — others (Storm Counter…) keep their English scan.
function overlayableFace(face) {
  const t = face.type_line || "";
  if (/\bDungeon\b/.test(t)) return false;
  if (/^Card\b/.test(t)) return !!HELPER_GEOM[face.name];
  return true;
}

function printTranslatable(entry) {
  const print = entry.prints[entry.printIndex];
  const faces = entry.english.card_faces?.length ? entry.english.card_faces : [entry.english];
  return entry.lang !== "en" && (print.lang !== entry.lang || print._badScan) &&
    OVERLAY_LAYOUTS.has(entry.english.layout) && faces.some(overlayableFace);
}

function printNeedsOverlay(entry) {
  return printTranslatable(entry) && !entry.forceEnglish;
}

function computeStatus(entry) {
  const print = entry.prints[entry.printIndex];
  if (entry.lang === "en" || (print.lang === entry.lang && !print._badScan)) return "localized";
  if (entry.forceEnglish) return "english";
  if (entry.overlayTexts) return entry.usedMT ? "mt" : "overlay";
  return "english";
}

// Render the faces of the currently selected printing (also used when the
// user picks another printing from the dropdown). Translations are resolved
// lazily, the first time an English print needs the overlay.
// Scryfall sometimes attaches the English scan to a localized print (e.g.
// several ECL French cards). Detect it by comparing the localized scan with
// the English scan of the SAME printing (same artwork): a wrongly-attached
// image is pixel-identical, so both the name bar AND the text box match. We
// require BOTH to match so a genuine localized scan whose text box happens
// to look similar (e.g. a basic land, all art and no rules text) is not
// flagged — its name bar still differs ("Île" vs "Island").
function regionDiff(bmpA, bmpB, [rx, ry, rw, rh]) {
  const W = 64, H = 32;
  const sample = (bmp) => {
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    ctx.drawImage(bmp,
      rx * bmp.width, ry * bmp.height, rw * bmp.width, rh * bmp.height,
      0, 0, W, H);
    return ctx.getImageData(0, 0, W, H).data;
  };
  const da = sample(bmpA), db = sample(bmpB);
  let sum = 0;
  for (let i = 0; i < da.length; i += 4) {
    const la = 0.299 * da[i] + 0.587 * da[i + 1] + 0.114 * da[i + 2];
    const lb = 0.299 * db[i] + 0.587 * db[i + 1] + 0.114 * db[i + 2];
    sum += Math.abs(la - lb);
  }
  return sum / (W * H);
}

async function isEnglishScan(entry, print) {
  try {
    const eng = entry.prints.find((p) => p.lang === "en" &&
      p.set === print.set && p.collector_number === print.collector_number);
    if (!eng) return false;
    const urlA = faceImageUrls(print)[0], urlB = faceImageUrls(eng)[0];
    if (!urlA || !urlB) return false;
    const [a, b] = await Promise.all([loadImage(urlA), loadImage(urlB)]);
    const nameDiff = regionDiff(a, b, [0.08, 0.045, 0.62, 0.055]); // title bar (left of mana)
    const textDiff = regionDiff(a, b, [0.10, 0.62, 0.80, 0.28]);   // text box
    a.close?.(); b.close?.();
    return nameDiff < 6 && textDiff < 8;
  } catch {
    return false; // if in doubt, trust the scan
  }
}

async function buildFaces(entry) {
  const print = entry.prints[entry.printIndex];
  const urls = faceImageUrls(print);
  if (urls.length === 0) throw new Error(`No image available for ${print.name}`);
  const printFaces = print.card_faces?.length ? print.card_faces : [print];

  // Only a low-resolution scan exists for this print: its faces get the
  // upscale + sharpen treatment (see loadFaceImage), flagged by the HD badge.
  entry.lowResScan = !!print.image_status && print.image_status !== "highres_scan";

  // Verify (once per print) that a localized scan really is localized
  if (entry.lang !== "en" && print.lang === entry.lang &&
      print._badScan === undefined && OVERLAY_LAYOUTS.has(entry.english.layout)) {
    print._badScan = await isEnglishScan(entry, print);
  }

  const needsOverlay = printNeedsOverlay(entry);
  if (needsOverlay && !entry.overlayTexts) {
    const { texts, usedMT } = await resolveTranslations(entry.english, entry.lang, entry.loc);
    entry.overlayTexts = texts;
    entry.usedMT = usedMT;
  }
  if (needsOverlay) await preloadSymbols(entry.overlayTexts);
  entry.editRegions = []; // per face, filled while painting (see logRegion)

  // Split cards: rotate the scan 90° clockwise so both halves read
  // horizontally (displayed landscape; rotated back at PDF time).
  if (entry.rotated) {
    const bitmap = await loadFaceImage(entry, urls[0]);
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
      regionLog = [];
      drawSplitOverlay(ctx, canvas.width, canvas.height, entry.overlayTexts,
        entry.english.card_faces || [], print.frame);
      entry.editRegions = [regionLog];
      regionLog = null;
    }
    return [canvas.toDataURL("image/jpeg", 0.92)];
  }

  // Adventure cards: one image, two faces (creature + adventure column)
  if (entry.english.layout === "adventure" && needsOverlay && entry.overlayTexts) {
    const engFaces = entry.english.card_faces || [];
    await preloadSymbols([{ text: engFaces[1]?.mana_cost || "" }]);
    const bitmap = await loadFaceImage(entry, urls[0]);
    const hasPT = engFaces[0]?.power != null;
    regionLog = [];
    const face = drawAdventureOverlay(bitmap, entry.overlayTexts, engFaces, hasPT);
    entry.editRegions = [regionLog];
    regionLog = null;
    bitmap.close?.();
    return [face];
  }

  const engFaces = entry.english.card_faces?.length ? entry.english.card_faces : [entry.english];
  const faces = [];
  for (let i = 0; i < urls.length; i++) {
    const bitmap = await loadFaceImage(entry, urls[i]);
    const tr = needsOverlay ? entry.overlayTexts?.[i] : null;
    regionLog = [];
    if (tr && (tr.name || tr.type || tr.text)) {
      const mana = (printFaces[i]?.mana_cost || "").match(/{[^}]+}/g)?.length || 0;
      const hasPT = engFaces[i]?.power != null;
      if (TOKEN_LAYOUTS.has(entry.english.layout)) {
        const engFace = engFaces[i] || entry.english;
        const geom = HELPER_GEOM[engFace.name];
        if (!overlayableFace(engFace)) {
          faces.push(bitmapToDataUrl(bitmap)); // dungeon map / unknown helper panel
        } else if (geom) {
          faces.push(drawHelperOverlay(bitmap, tr, geom));
        } else {
          faces.push(drawTokenOverlay(bitmap, tr, hasPT, !engFace.oracle_text));
        }
      } else {
        faces.push(drawWithOverlay(bitmap, tr, mana, hasPT));
      }
    } else {
      faces.push(bitmapToDataUrl(bitmap));
    }
    entry.editRegions.push(regionLog);
    regionLog = null;
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
const SECTION_RANK = { commander: 0, mainboard: 1, sideboard: 2, maybeboard: 3, tokens: 4 };

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
// Entries may carry a pre-resolved Scryfall card object in `card` (used for
// tokens, which cannot be resolved by name — a token often shares its name
// with a real card). Returns the entries that could not be loaded.
async function loadEntries(entries, lang, sortByType = false) {
  setStatus(`Resolving ${entries.length} cards on Scryfall…`, 0.02);
  const uniqueNames = [...new Set(entries.filter((e) => !e.card).map((e) => e.name))];
  const { found } = uniqueNames.length ? await resolveCards(uniqueNames) : { found: new Map() };
  const cardOf = (e) => e.card || found.get(e.name.toLowerCase());

  if (sortByType) {
    entries = entries.slice().sort((a, b) =>
      ((SECTION_RANK[a.section] ?? 1) - (SECTION_RANK[b.section] ?? 1)) ||
      (typeRank(cardOf(a)) - typeRank(cardOf(b))) ||
      a.name.localeCompare(b.name));
  }

  const oracleIds = [...new Set(
    entries.map((e) => cardOf(e)?.oracle_id).filter(Boolean)
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
    const englishCard = cardOf(entry);
    if (!englishCard) { failed.push(entry); continue; }
    try {
      const built = await buildCardEntry(englishCard, lang,
        localizedMap.get(englishCard.oracle_id), englishMap.get(englishCard.oracle_id),
        entry.print, versionMode);
      cards.push({ name: entry.name, qty: entry.qty, section: entry.section,
        helper: entry.helper, ...built });
    } catch (e) {
      console.error(`Failed to build ${entry.name}:`, e);
      failed.push(entry);
    }
    await sleep(60); // images come from Scryfall's CDN, which is not rate-limited
  }
  return failed;
}

// Which token/emblem printing id (as referenced in `all_parts`) belongs to
// which token oracle_id — filled by collectTokenEntries, used to detect
// tokens whose last producing card was removed.
const tokenPartOracle = new Map();

// Cards whose rules reference a shared game aid come with the matching
// helper card(s) when tokens are included. Helpers are exact Scryfall card
// names ("Card" / "Dungeon" type game aids, e.g. The Monarch, dungeons).
const MECHANIC_HELPERS = [
  { key: "ascend", test: (c) => (c.keywords || []).includes("Ascend"),
    helpers: ["City's Blessing"] },
  { key: "monarch", test: (c) => /becomes? the monarch/i.test(oracleTextOf(c)),
    helpers: ["The Monarch"] },
  { key: "dungeon", test: (c) => /venture into the dungeon/i.test(oracleTextOf(c)),
    helpers: ["Lost Mine of Phandelver", "Dungeon of the Mad Mage", "Tomb of Annihilation"] },
  { key: "initiative", test: (c) => /takes? the initiative|venture into undercity/i.test(oracleTextOf(c)),
    helpers: ["Undercity // The Initiative"] },
  { key: "engines", test: (c) => /start your engines/i.test(oracleTextOf(c)),
    helpers: ["Start Your Engines! // Max Speed"] },
  { key: "energy", test: (c) => oracleTextOf(c).includes("{E}"),
    helpers: ["Energy Reserve"] },
  { key: "storm", test: (c) => (c.keywords || []).includes("Storm"),
    helpers: ["Storm Counter"] },
];

function oracleTextOf(c) {
  const faces = c.card_faces?.length ? c.card_faces : [c];
  return faces.map((f) => f.oracle_text || "").join("\n");
}

const helperCardCache = new Map();
async function fetchHelperCard(name) {
  if (helperCardCache.has(name)) return helperCardCache.get(name);
  let card = null;
  try {
    const resp = await fetchRetry(`${SCRYFALL}/cards/named?exact=${encodeURIComponent(name)}`);
    if (resp.ok) card = await resp.json();
  } catch (e) {
    console.warn(`Helper card "${name}" could not be fetched:`, e);
  }
  helperCardCache.set(name, card);
  await sleep(100);
  return card;
}

// Tokens (and emblems) that the given English cards can create, as
// loadEntries entries. Scryfall lists them in each card's `all_parts`:
// tokens have component "token"; emblems are "combo_piece" with an Emblem
// type line (the card itself is also listed and must be skipped). Different
// cards reference different printings of the same token, so dedupe by
// oracle_id — including against tokens already in the grid.
async function collectTokenEntries(englishCards) {
  const partIds = new Set();
  const collectParts = (card) => {
    for (const part of card?.all_parts || []) {
      if (part.id === card.id) continue;
      if (part.component === "token" || (part.type_line || "").startsWith("Emblem")) {
        partIds.add(part.id);
      }
    }
  };
  englishCards.forEach(collectParts);

  // Mechanic helper cards (monarch, dungeons, energy reserve…)
  const helpers = [];
  for (const rule of MECHANIC_HELPERS) {
    if (!englishCards.some((c) => rule.test(c))) continue;
    for (const name of rule.helpers) {
      const card = await fetchHelperCard(name);
      if (card) helpers.push({ card, rule: rule.key });
    }
  }
  // Tokens the helper cards themselves create (e.g. dungeon room rewards)
  helpers.forEach((h) => collectParts(h.card));

  if (partIds.size === 0 && helpers.length === 0) return [];

  setStatus(`Fetching ${partIds.size + helpers.length} token(s)…`, 0.02);
  const tokens = [];
  const idList = [...partIds];
  for (let i = 0; i < idList.length; i += 75) {
    const chunk = idList.slice(i, i + 75);
    const resp = await fetchRetry(`${SCRYFALL}/cards/collection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifiers: chunk.map((id) => ({ id })) }),
    });
    if (!resp.ok) throw new Error(`Scryfall error (HTTP ${resp.status})`);
    tokens.push(...((await resp.json()).data || []));
    await sleep(100);
  }

  const already = new Set(cards.map((c) => c.english.oracle_id));
  const byOracle = new Map();
  for (const h of helpers) {
    if (!already.has(h.card.oracle_id) && !byOracle.has(h.card.oracle_id)) {
      byOracle.set(h.card.oracle_id, { card: h.card, helper: h.rule });
    }
  }
  for (const t of tokens) {
    tokenPartOracle.set(t.id, t.oracle_id);
    if (!already.has(t.oracle_id) && !byOracle.has(t.oracle_id)) byOracle.set(t.oracle_id, { card: t });
  }
  return [...byOracle.values()]
    .sort((a, b) => a.card.name.localeCompare(b.card.name) || typeRank(a.card) - typeRank(b.card))
    .map(({ card, helper }) => ({ name: card.name, qty: 1, section: "tokens", card, helper }));
}

// Drop token-category entries whose producing cards have all been removed.
// Matching goes through tokenPartOracle (all_parts holds printing ids, the
// grid holds oracles); parts never seen by collectTokenEntries fall back to
// a name match — over-keeping is safer than wrongly removing. Mechanic
// helper cards stay as long as one remaining card matches their rule, and
// tokens created by surviving helpers (dungeon room rewards) stay with them.
function pruneOrphanTokens() {
  const tokenEntries = cards.filter((c) => c.section === "tokens");
  if (!tokenEntries.length) return;
  const regular = cards.filter((c) => c.section !== "tokens");
  const wantedOracles = new Set();
  const wantedNames = new Set();
  const addParts = (card) => {
    for (const part of card.all_parts || []) {
      if (part.id === card.id) continue;
      if (part.component === "token" || (part.type_line || "").startsWith("Emblem")) {
        const oid = tokenPartOracle.get(part.id);
        if (oid) wantedOracles.add(oid);
        else wantedNames.add(part.name);
      }
    }
  };
  regular.forEach((c) => addParts(c.english));
  const activeRules = new Set(MECHANIC_HELPERS
    .filter((r) => regular.some((c) => r.test(c.english)))
    .map((r) => r.key));
  const keep = (t) => t.helper
    ? activeRules.has(t.helper)
    : wantedOracles.has(t.english.oracle_id) || wantedNames.has(t.english.name);
  tokenEntries.filter(keep).forEach((t) => addParts(t.english));
  cards = cards.filter((c) => c.section !== "tokens" || keep(c));
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
    if (!deck) {
      // Nothing provided: offer to start an empty deck built card by card
      hideStatus();
      if (await askEmptyDeck()) {
        deckTitle = "Custom deck";
        currentLang = $("language").value;
        emptyDeck = true;
        renderGrid();
      }
      return;
    }
    emptyDeck = false;
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

    if ($("include-tokens").value === "yes") {
      const tokenEntries = await collectTokenEntries(cards.map((c) => c.english));
      if (tokenEntries.length) {
        failedEntries.push(...await loadEntries(tokenEntries, currentLang));
      }
    }

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

  // Cards sit under a "Cards" heading; tokens get their own category at the
  // end. The "+" tile (add a card) comes right after the last regular card,
  // not in the token category.
  const regular = cards.filter((c) => c.section !== "tokens");
  const tokens = cards.filter((c) => c.section === "tokens");
  const sectionLabel = (text) => {
    const label = document.createElement("div");
    label.className = "section-label";
    label.textContent = text;
    grid.appendChild(label);
  };
  sectionLabel("Cards");
  for (const card of regular) {
    grid.appendChild(makeTile(card));
  }
  grid.appendChild(makeAddTile());
  if (tokens.length) {
    sectionLabel("Tokens");
    for (const card of tokens) {
      grid.appendChild(makeTile(card));
    }
  }

  const totalCards = cards.reduce((s, c) => s + c.qty, 0);
  const totalSlots = cards.reduce((s, c) => s + c.qty * c.faces.length, 0);
  const pages = Math.ceil(totalSlots / 9);
  $("deck-name").textContent = deckTitle;
  $("deck-stats").textContent =
    `${totalCards} cards · ${totalSlots} proxies · ${pages} A4 page${pages > 1 ? "s" : ""}`;
  $("deck-section").classList.toggle("hidden", cards.length === 0 && !emptyDeck);
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

// Double-click on a translated card: edit its overlay texts in a dialog,
// then repaint the faces with the edited content.
async function openEditDialog(card, img, tile) {
  if (!printNeedsOverlay(card) || !card.overlayTexts) return false;
  const engFaces = card.english.card_faces?.length ? card.english.card_faces : [card.english];
  const wrap = $("edit-fields");
  wrap.innerHTML = "";
  const fields = card.overlayTexts.map((t, i) => {
    const engFace = engFaces[i] || card.english;
    // Offer only the fields the overlay actually paints on this face
    if (!overlayableFace(engFace)) return null; // dungeon map: nothing painted
    const isHelper = /^Card\b/.test(engFace.type_line || "");
    const geom = HELPER_GEOM[engFace.name];
    const showName = true;
    const showType = !isHelper; // helper panels have no type line
    const showText = isHelper
      ? !!(geom?.box && engFace.oracle_text)
      : !!(t.text || engFace.oracle_text); // e.g. no text field on vanilla tokens
    if (!showName && !showType && !showText) return null;

    const fs = document.createElement("fieldset");
    if (card.overlayTexts.length > 1) {
      const lg = document.createElement("legend");
      lg.textContent = engFace.name || `Face ${i + 1}`;
      fs.appendChild(lg);
    }
    const mkField = (label, value, isArea) => {
      const lab = document.createElement("label");
      lab.textContent = label;
      const el = document.createElement(isArea ? "textarea" : "input");
      if (isArea) el.rows = 4; else el.type = "text";
      el.value = value || "";
      lab.appendChild(el);
      fs.appendChild(lab);
      return el;
    };
    const name = showName ? mkField("Name", t.name, false) : null;
    const type = showType ? mkField("Type line", t.type, false) : null;
    const text = showText
      ? mkField("Text — symbols in braces like {T}, {2}, {W} are drawn as icons", t.text, true)
      : null;
    wrap.appendChild(fs);
    return { name, type, text };
  });
  if (fields.every((f) => !f)) return false;

  const dlg = $("edit-dialog");
  const saved = await new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "save"), { once: true });
    dlg.showModal();
  });
  if (!saved) return false;

  card.overlayTexts = card.overlayTexts.map((t, i) => {
    const f = fields[i];
    if (!f) return t;
    return {
      ...t,
      name: f.name ? (f.name.value.trim() || null) : t.name,
      type: f.type ? (f.type.value.trim() || null) : t.type,
      text: f.text ? (f.text.value.trim() || null) : t.text,
    };
  });
  img.style.opacity = "0.4";
  try {
    card.faces = await buildFaces(card);
    img.src = card.faces[0];
    const n0 = card.overlayTexts[0]?.name, n1 = card.overlayTexts[1]?.name;
    card.printedName = n0 && n1 ? `${n0} // ${n1}` : (n0 || card.printedName);
    const nameDiv = tile.querySelector(".card-name");
    if (nameDiv) nameDiv.textContent = card.printedName;
  } catch (e) {
    console.error(e);
    setStatus(`Could not update ${card.name}: ${e.message}`, null, true);
  }
  img.style.opacity = "";
  return true;
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
      face = 0;
    } catch (e) {
      console.error(e);
      setStatus(`Could not update ${card.name}: ${e.message}`, null, true);
    }
    img.style.opacity = "";
    delete badgeEl.dataset.busy;
  });

  tile.classList.toggle("wide", !!card.rotated);

  // HD badge (top left): shown when the selected print only has a
  // low-resolution scan, which the app upscales and sharpens by default —
  // clicking toggles back to the original image.
  const resEl = document.createElement("span");
  resEl.className = "badge badge-res badge-click";
  const updateResBadge = () => {
    resEl.classList.toggle("hidden", !card.lowResScan);
    if (!card.lowResScan) return;
    if (card.useOriginalImage) {
      resEl.textContent = "LR";
      resEl.title = "Low-resolution scan kept as-is — click to enhance it for print";
    } else {
      resEl.textContent = "HD";
      resEl.title = "Only a low-resolution scan exists — enhanced for print (upscaled and sharpened). Click to use the original image instead";
    }
  };
  updateResBadge();
  resEl.addEventListener("click", async () => {
    if (resEl.dataset.busy) return;
    resEl.dataset.busy = "1";
    card.useOriginalImage = !card.useOriginalImage;
    img.style.opacity = "0.4";
    try {
      card.faces = await buildFaces(card);
      img.src = card.faces[0];
      face = 0;
    } catch (e) {
      console.error(e);
      setStatus(`Could not update ${card.name}: ${e.message}`, null, true);
    }
    updateResBadge();
    img.style.opacity = "";
    delete resEl.dataset.busy;
  });

  const imgWrap = document.createElement("div");
  imgWrap.className = "img-wrap";
  imgWrap.appendChild(badgeEl);
  imgWrap.appendChild(resEl);
  const img = document.createElement("img");
  img.src = card.faces[0];
  img.alt = card.name;
  img.loading = "lazy";
  imgWrap.appendChild(img);

  // The repainted (parchment) areas are clickable to edit the translation:
  // pointer cursor when hovering one, click opens the dialog.
  let face = 0; // face currently displayed (flip button below)
  const hitRegion = (e) => {
    if (!printNeedsOverlay(card)) return false;
    const r = img.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const fy = (e.clientY - r.top) / r.height;
    return (card.editRegions?.[face] || []).some(([x0, y0, x1, y1]) =>
      fx >= x0 && fx <= x1 && fy >= y0 && fy <= y1);
  };
  img.addEventListener("mousemove", (e) => {
    const hit = hitRegion(e);
    img.style.cursor = hit ? "pointer" : "";
    img.title = hit ? "Click to edit the translated text" : "";
  });
  img.addEventListener("click", async (e) => {
    if (hitRegion(e) && await openEditDialog(card, img, tile)) face = 0;
  });

  // Flipping a double-sided card happens only via its icon (below the badge)
  if (card.faces.length > 1) {
    const flipBtn = document.createElement("button");
    flipBtn.className = "flip-btn";
    flipBtn.title = "Show the other side";
    flipBtn.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>';
    flipBtn.addEventListener("click", () => {
      face = (face + 1) % card.faces.length;
      img.src = card.faces[face];
    });
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
        updateResBadge(); // the new print may (not) be a low-res scan
        face = 0;
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
    // Removing a card may orphan tokens only that card produced
    if (card.section !== "tokens") pruneOrphanTokens();
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

  input.addEventListener("input", (e) => {
    clearTimeout(autocompleteTimer);
    // Picking a datalist suggestion fires an input event too
    // (inputType "insertReplacementText" / undefined): clear the list and
    // stay quiet until the user actually types again.
    if (!e.inputType || e.inputType === "insertReplacementText") {
      datalist.innerHTML = "";
      return;
    }
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
  // Insert before the token category so display and PDF order match
  const firstToken = cards.findIndex((c) => c.section === "tokens");
  const insertAt = firstToken === -1 ? cards.length : firstToken;
  cards.splice(insertAt, 0, { name: englishCard.name, qty, section: "mainboard", ...built });

  // If tokens are included, also add the tokens/emblems this card creates
  // (skipping any already in the grid).
  if ($("include-tokens").value === "yes") {
    const tokenEntries = await collectTokenEntries([englishCard]);
    if (tokenEntries.length) await loadEntries(tokenEntries, lang);
  }

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
// No decklist given: propose starting an empty deck (cards added via "+").
function askEmptyDeck() {
  return new Promise((resolve) => {
    const dlg = $("empty-dialog");
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "start"), { once: true });
    dlg.showModal();
  });
}

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
// The "Considering" board and version preference only exist on Moxfield
$("deck-url").addEventListener("input", () => {
  const isMoxfield = /moxfield\.com/i.test($("deck-url").value);
  for (const el of document.querySelectorAll(".moxfield-only")) {
    el.classList.toggle("hidden", !isMoxfield);
  }
});
