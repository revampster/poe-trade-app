const express = require("express");
const cors = require("cors");
const axios = require("axios");
const xml2js = require("xml2js");
const zlib = require("zlib");
const {
  initTradeStats,
  getTradeStatsStatus,
  mapModsToTradeFilters,
  buildTradeStats,
  isValidTradeStatId
} = require("./modMapper");

const app = express();
const PORT = process.env.PORT || 3001;
const DEFAULT_TRADE_LEAGUE = process.env.TRADE_LEAGUE || "Mirage";

const MAX_ITEMS_TO_PROCESS = 8;
const MAX_MODS_PER_ITEM = 10;
const SEARCH_DELAY_MS = 350;
const MAX_SEARCH_RETRIES = 2;

app.use(cors());
app.use(express.json());

const POE_HEADERS = {
  "User-Agent": "poe-trade-app/1.0",
  "Content-Type": "application/json",
  Accept: "application/json"
};

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "PoE Trade backend is live",
    defaultTradeLeague: DEFAULT_TRADE_LEAGUE,
    tradeStats: getTradeStatsStatus()
  });
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeLeagueName(league) {
  const cleaned = String(league || "").trim();
  return cleaned || DEFAULT_TRADE_LEAGUE;
}

function extractPobbId(url) {
  const clean = url.trim().replace(/\/+$/, "");
  const parts = clean.split("/");
  return parts[parts.length - 1];
}

async function fetchPoBData(input) {
  let data = input;

  if (input.includes("pastebin.com")) {
    const id = input.trim().split("/").pop();
    const res = await axios.get(`https://pastebin.com/raw/${id}`, {
      validateStatus: () => true,
      headers: { "User-Agent": "poe-trade-app/1.0" },
      timeout: 10000
    });

    if (res.status !== 200) {
      throw new Error(`Failed to fetch pastebin build (${res.status})`);
    }

    data = res.data;
  }

  if (input.includes("pobb.in")) {
    const id = extractPobbId(input);
    const res = await axios.get(`https://pobb.in/${id}/raw`, {
      validateStatus: () => true,
      headers: { "User-Agent": "poe-trade-app/1.0" },
      timeout: 10000
    });

    if (res.status !== 200) {
      throw new Error(`Failed to fetch pobb.in build (${res.status})`);
    }

    data = res.data;
  }

  return typeof data === "string" ? data.trim() : data;
}

function maybeDecodePoB(data) {
  if (typeof data !== "string") {
    throw new Error("PoB data is not a string.");
  }

  const trimmed = data.trim();

  if (trimmed.startsWith("<")) {
    return trimmed;
  }

  try {
    const compressed = Buffer.from(trimmed, "base64");

    try {
      return zlib.inflateRawSync(compressed).toString("utf8");
    } catch {
      return zlib.inflateSync(compressed).toString("utf8");
    }
  } catch {
    throw new Error("Fetched build was not XML and could not be decoded as a PoB code.");
  }
}

function extractItemText(item) {
  if (typeof item?._ === "string") {
    return item._;
  }

  if (Array.isArray(item) && typeof item[0] === "string") {
    return item[0];
  }

  return "";
}

function stripPobTags(text) {
  return String(text || "")
    .replace(/\{[^}]*\}/g, "")
    .trim();
}

function normalizeSpaces(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCaseWords(text) {
  return String(text || "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function decodeClusterInternalMod(line) {
  const cleaned = stripPobTags(line);

  const direct = {
    AfflictionJewelSmallPassivesHaveIncreasedEffect2:
      "Added Small Passive Skills have increased Effect",
    AfflictionJewelSmallPassivesGrantDex3_:
      "Added Small Passive Skills also grant: +# to Dexterity",
    AfflictionJewelSmallPassivesGrantLife3:
      "Added Small Passive Skills also grant: +# to Maximum Life",
    AfflictionJewelSmallPassivesGrantMinionAttackAndCastSpeed3:
      "Added Small Passive Skills also grant: Minions have increased Attack and Cast Speed",
    AfflictionJewelSmallPassivesGrantMinionDamage3:
      "Added Small Passive Skills also grant: Minions deal increased Damage",
    AfflictionJewelSmallPassivesGrantAllRes3:
      "Added Small Passive Skills also grant: +#% to all Elemental Resistances"
  };

  const directKey = cleaned
    .replace(/^Prefix:\s*/i, "")
    .replace(/^Suffix:\s*/i, "")
    .trim();

  if (direct[directKey]) {
    return direct[directKey];
  }

  if (/^Prefix:\s*AfflictionJewel/i.test(cleaned) || /^Suffix:\s*AfflictionJewel/i.test(cleaned)) {
    return titleCaseWords(
      cleaned
        .replace(/^Prefix:\s*/i, "")
        .replace(/^Suffix:\s*/i, "")
        .replace(/^AfflictionJewel/i, "")
    );
  }

  return null;
}

function shouldSkipModLine(line) {
  const lower = stripPobTags(line).toLowerCase();

  return (
    lower.includes("adds # passive skills") ||
    lower.includes("passive skills are jewel sockets") ||
    lower.includes("allocates ") ||
    lower.includes("selection:") ||
    lower.includes("catalystquality") ||
    lower.includes("basepercentile") ||
    lower.includes("armourbasepercentile") ||
    lower.includes("evasionbasepercentile") ||
    lower.includes("energyshieldbasepercentile") ||
    /^quality:/.test(lower) ||
    /^armour:\s*\d+$/.test(lower) ||
    /^evasion:\s*\d+$/.test(lower) ||
    /^energy shield:\s*\d+$/.test(lower) ||
    /^ward:\s*\d+$/.test(lower)
  );
}

function classifyMod(line) {
  const raw = normalizeSpaces(line);
  const noTags = normalizeSpaces(stripPobTags(line));

  if (!raw) return null;

  if (/^Enchant:/i.test(noTags)) {
    return {
      text: noTags.replace(/^Enchant:\s*/i, "").trim(),
      kind: "enchant"
    };
  }

  if (/^Implicit:/i.test(noTags)) {
    return {
      text: noTags.replace(/^Implicit:\s*/i, "").trim(),
      kind: "implicit"
    };
  }

  const clusterDecoded = decodeClusterInternalMod(raw);
  if (clusterDecoded) {
    return {
      text: clusterDecoded,
      kind: "explicit"
    };
  }

  if (/^Prefix:/i.test(noTags) || /^Suffix:/i.test(noTags)) {
    return {
      text: noTags.replace(/^Prefix:\s*/i, "").replace(/^Suffix:\s*/i, "").trim(),
      kind: "explicit"
    };
  }

  return {
    text: noTags,
    kind: "explicit"
  };
}

function parseModsFromItemText(itemText) {
  if (!itemText) return [];

  const lines = itemText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const mods = [];
  let reachedMods = false;

  for (const line of lines) {
    if (
      line.startsWith("Requirements:") ||
      line.startsWith("Sockets:") ||
      line.startsWith("LevelReq:") ||
      line.startsWith("Implicits:") ||
      line.startsWith("Quality:") ||
      line.startsWith("Item Level:") ||
      line.startsWith("Level:") ||
      line.startsWith("Radius:") ||
      line.startsWith("Limited to:")
    ) {
      continue;
    }

    if (
      line.startsWith("Rarity:") ||
      line === "--------" ||
      line === "Corrupted" ||
      line === "Unidentified" ||
      line.startsWith("Note:")
    ) {
      continue;
    }

    if (
      line.includes("+") ||
      line.includes("%") ||
      line.includes("Minions") ||
      line.includes("Trigger") ||
      line.includes("Adds ") ||
      line.includes("Gain ") ||
      line.includes("Recover ") ||
      line.includes("increased ") ||
      line.includes("reduced ") ||
      line.includes("more ") ||
      line.includes("less ") ||
      line.includes("Chance to ") ||
      line.includes("Damage") ||
      line.includes("Life") ||
      line.includes("Mana") ||
      line.includes("Resistance") ||
      line.includes("Armour") ||
      line.includes("Evasion") ||
      line.includes("Energy Shield") ||
      line.includes("Suppression") ||
      line.includes("Movement Speed") ||
      line.includes("Lucky") ||
      line.includes("Block") ||
      line.includes("Prefix:") ||
      line.includes("Suffix:") ||
      line.includes("Implicit:") ||
      line.includes("Enchant:")
    ) {
      reachedMods = true;
    }

    if (!reachedMods) continue;
    if (shouldSkipModLine(line)) continue;

    const classified = classifyMod(line);
    if (!classified || !classified.text) continue;

    mods.push({
      name: classified.text,
      text: classified.text,
      tier: null,
      kind: classified.kind
    });
  }

  return mods;
}

function extractItemMeta(item, fallbackIndex) {
  const text = extractItemText(item);

  if (!text) {
    return {
      rarity: "Unknown",
      displayName: `Item ${fallbackIndex + 1}`,
      searchName: "",
      searchType: ""
    };
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const rarityLine = lines.find((line) => line.startsWith("Rarity:"));
  const rarity = rarityLine ? rarityLine.replace("Rarity:", "").trim() : "Unknown";

  let searchName = "";
  let searchType = "";
  let displayName = `Item ${fallbackIndex + 1}`;

  if (rarity === "Unique") {
    searchName = lines[1] || "";
    searchType = lines[2] || "";
    displayName = [searchName, searchType].filter(Boolean).join(" ") || searchName || searchType || displayName;
  } else if (rarity === "Rare") {
    const rareName = lines[1] || "";
    searchType = lines[2] || "";
    displayName = [rareName, searchType].filter(Boolean).join(" ") || rareName || searchType || displayName;
  } else if (rarity === "Magic") {
    // Magic items may have either:
    // lines[1] = full magic name
    // lines[2] = base type
    // If base type exists, prefer it for trade type.
    const magicName = lines[1] || "";
    const maybeBase = lines[2] || "";

    if (maybeBase) {
      searchType = maybeBase;
      displayName = [magicName, maybeBase].filter(Boolean).join(" ");
    } else {
      searchType = magicName;
      displayName = magicName || displayName;
    }
  } else {
    searchType = lines[1] || lines[0] || "";
    displayName = searchType || displayName;
  }

  return {
    rarity,
    displayName,
    searchName,
    searchType
  };
}

function normalizeItemsFromXml(result) {
  const itemsNode =
    result?.PathOfBuilding?.Build?.[0]?.Items?.[0]?.Item ||
    result?.PathOfBuilding?.Items?.[0]?.Item;

  if (!itemsNode || !Array.isArray(itemsNode)) {
    throw new Error("Invalid PoB XML structure or no items found.");
  }

  return itemsNode.map((item, index) => {
    const itemText = extractItemText(item);
    const meta = extractItemMeta(item, index);
    const mods = parseModsFromItemText(itemText);

    return {
      rarity: meta.rarity,
      displayName: meta.displayName,
      searchName: meta.searchName,
      searchType: meta.searchType,
      mods
    };
  });
}

async function parsePoB(input) {
  const rawData = await fetchPoBData(input);
  const xmlData = maybeDecodePoB(rawData);

  const parser = new xml2js.Parser({
    explicitArray: true,
    mergeAttrs: false
  });

  const result = await parser.parseStringPromise(xmlData);
  return normalizeItemsFromXml(result);
}

function buildEmptyStatsGroup() {
  return [
    {
      type: "and",
      filters: []
    }
  ];
}

function buildFallbackQuery(item) {
  const query = {
    query: {
      status: { option: "online" },
      stats: buildEmptyStatsGroup()
    },
    sort: { price: "asc" }
  };

  if (item.rarity === "Unique" && item.searchName) {
    query.query.name = item.searchName;
    if (item.searchType) query.query.type = item.searchType;
  } else if (item.searchType) {
    query.query.type = item.searchType;
  }

  return query;
}

function buildStrictCandidateQuery(item) {
  const mapped = mapModsToTradeFilters(item.mods.slice(0, MAX_MODS_PER_ITEM));
  const validStrictFilters = mapped.filters.filter((f) => isValidTradeStatId(f.id));

  const strictQuery = buildFallbackQuery(item);
  strictQuery.query.stats = buildTradeStats(validStrictFilters);

  return {
    query: strictQuery,
    matchedFilters: validStrictFilters,
    matchedDetails: mapped.debug.selected.filter((m) => isValidTradeStatId(m.id)),
    allMatchedMods: mapped.debug.allMatches,
    unmatchedMods: mapped.debug.unmatched,
    matchedMods: mapped.debug.selected.length,
    totalMods: item.mods.length,
    tradeStatsReady: mapped.debug.tradeStatsReady,
    canTryStrict: validStrictFilters.length > 0
  };
}

async function submitTradeSearch(queryObject, league) {
  const searchUrl = `https://www.pathofexile.com/api/trade/search/${encodeURIComponent(
    sanitizeLeagueName(league)
  )}`;

  let attempt = 0;
  let lastRes = null;

  while (attempt <= MAX_SEARCH_RETRIES) {
    if (attempt > 0) {
      await sleep(600 * attempt);
    }

    const res = await axios.post(searchUrl, queryObject, {
      headers: POE_HEADERS,
      validateStatus: () => true,
      timeout: 12000
    });

    lastRes = res;

    if (res.status !== 429) {
      return {
        status: res.status,
        data: res.data
      };
    }

    const retryAfter = Number(res.headers["retry-after"]);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      await sleep(retryAfter * 1000);
    } else {
      await sleep(1200 * (attempt + 1));
    }

    attempt += 1;
  }

  return {
    status: lastRes?.status || 429,
    data: lastRes?.data || null
  };
}

function buildTradeResultLink(league, searchId) {
  const finalLeague = encodeURIComponent(sanitizeLeagueName(league));
  return `https://www.pathofexile.com/trade/search/${finalLeague}/${encodeURIComponent(searchId)}`;
}

async function resolveTradeQuery(item, league) {
  const fallbackQuery = buildFallbackQuery(item);
  const strictCandidate = buildStrictCandidateQuery(item);

  let strictAttempt = null;
  let fallbackAttempt = null;

  if (strictCandidate.canTryStrict) {
    strictAttempt = await submitTradeSearch(strictCandidate.query, league);
    const strictId = strictAttempt?.data?.id;

    if (strictAttempt.status === 200 && strictId) {
      return {
        chosenQuery: strictCandidate.query,
        queryMode: "strict",
        link: buildTradeResultLink(league, strictId),
        searchId: strictId,
        strictAccepted: true,
        fallbackAccepted: false,
        matchedMods: strictCandidate.matchedMods,
        totalMods: strictCandidate.totalMods,
        matchedFilters: strictCandidate.matchedFilters,
        matchedDetails: strictCandidate.matchedDetails,
        allMatchedMods: strictCandidate.allMatchedMods,
        unmatchedMods: strictCandidate.unmatchedMods,
        tradeStatsReady: strictCandidate.tradeStatsReady,
        strictStatus: strictAttempt.status,
        fallbackStatus: null
      };
    }

    await sleep(SEARCH_DELAY_MS);
  }

  fallbackAttempt = await submitTradeSearch(fallbackQuery, league);
  const fallbackId = fallbackAttempt?.data?.id;

  if (fallbackAttempt.status === 200 && fallbackId) {
    return {
      chosenQuery: fallbackQuery,
      queryMode: "fallback",
      link: buildTradeResultLink(league, fallbackId),
      searchId: fallbackId,
      strictAccepted: false,
      fallbackAccepted: true,
      matchedMods: strictCandidate.matchedMods,
      totalMods: strictCandidate.totalMods,
      matchedFilters: strictCandidate.matchedFilters,
      matchedDetails: strictCandidate.matchedDetails,
      allMatchedMods: strictCandidate.allMatchedMods,
      unmatchedMods: strictCandidate.unmatchedMods,
      tradeStatsReady: strictCandidate.tradeStatsReady,
      strictStatus: strictAttempt ? strictAttempt.status : null,
      fallbackStatus: fallbackAttempt.status
    };
  }

  return {
    chosenQuery: fallbackQuery,
    queryMode: "failed",
    link: null,
    searchId: null,
    strictAccepted: false,
    fallbackAccepted: false,
    matchedMods: strictCandidate.matchedMods,
    totalMods: strictCandidate.totalMods,
    matchedFilters: strictCandidate.matchedFilters,
    matchedDetails: strictCandidate.matchedDetails,
    allMatchedMods: strictCandidate.allMatchedMods,
    unmatchedMods: strictCandidate.unmatchedMods,
    tradeStatsReady: strictCandidate.tradeStatsReady,
    strictStatus: strictAttempt ? strictAttempt.status : null,
    fallbackStatus: fallbackAttempt ? fallbackAttempt.status : null
  };
}

app.post("/generate", async (req, res) => {
  const started = Date.now();

  try {
    await initTradeStats();

    const { input, league } = req.body;

    console.log("START /generate", {
      league,
      hasInput: !!input,
      tradeStats: getTradeStatsStatus()
    });

    if (!input || !input.trim()) {
      return res.status(400).json({ error: "No PoB input provided." });
    }

    const selectedLeague = sanitizeLeagueName(league);

    const parsedItems = await parsePoB(input);
    console.log("parsePoB done", {
      itemCount: parsedItems.length,
      elapsed: Date.now() - started
    });

    const items = parsedItems
      .slice(0, MAX_ITEMS_TO_PROCESS)
      .map((item) => ({
        ...item,
        mods: item.mods.slice(0, MAX_MODS_PER_ITEM)
      }));

    console.log("processing limited items", {
      itemCount: items.length,
      maxModsPerItem: MAX_MODS_PER_ITEM
    });

    const finalResults = [];

    for (const item of items) {
      const t0 = Date.now();
      const resolved = await resolveTradeQuery(item, selectedLeague);

      console.log("buildTradeQuery done", {
        item: item.displayName,
        matchedMods: resolved.matchedMods,
        totalMods: resolved.totalMods,
        ms: Date.now() - t0,
        queryMode: resolved.queryMode,
        strictStatus: resolved.strictStatus,
        fallbackStatus: resolved.fallbackStatus,
        matchedFilters: resolved.matchedDetails.map((m) => ({
          mod: m.mod,
          id: m.id,
          score: m.score,
          type: m.type
        }))
      });

      finalResults.push({
        item: item.displayName,
        rarity: item.rarity,
        searchName: item.searchName,
        searchType: item.searchType,
        link: resolved.link,
        searchId: resolved.searchId,
        matchedMods: resolved.matchedMods,
        totalMods: resolved.totalMods,
        upgradeScore:
          resolved.totalMods > 0
            ? Math.round((resolved.matchedMods / resolved.totalMods) * 100)
            : 0,
        matchedFilters: resolved.matchedFilters,
        matchedDetails: resolved.matchedDetails,
        allMatchedMods: resolved.allMatchedMods,
        unmatchedMods: resolved.unmatchedMods,
        queryMode: resolved.queryMode,
        strictAccepted: resolved.strictAccepted,
        fallbackAccepted: resolved.fallbackAccepted,
        tradeStatsReady: resolved.tradeStatsReady,
        strictStatus: resolved.strictStatus,
        fallbackStatus: resolved.fallbackStatus,
        tradeQuery: resolved.chosenQuery
      });

      await sleep(SEARCH_DELAY_MS);
    }

    console.log("END /generate", {
      totalMs: Date.now() - started,
      finalCount: finalResults.length
    });

    return res.json({
      league: selectedLeague,
      tradeStats: getTradeStatsStatus(),
      results: finalResults
    });
  } catch (err) {
    console.error("Generate Error:", err);
    return res.status(500).json({
      error: err.message || "Failed to generate trade links."
    });
  }
});

initTradeStats().catch((err) => {
  console.error("Trade stats init failed:", err.message);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend running on port ${PORT}`);
});