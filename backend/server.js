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
const MAX_PRICE_CHECKS = 2;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "PoE Trade backend is live",
    defaultTradeLeague: DEFAULT_TRADE_LEAGUE,
    tradeStats: getTradeStatsStatus()
  });
});

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
    searchType = lines[1] || "";
    displayName = searchType || displayName;
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

function buildFallbackQuery(item) {
  const query = {
    query: {
      status: { option: "online" },
      stats: []
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

function buildSafeTradeQuery(item) {
  const mapped = mapModsToTradeFilters(item.mods.slice(0, MAX_MODS_PER_ITEM));

  const validStrictFilters = mapped.filters.filter((f) => isValidTradeStatId(f.id));

  const fallbackQuery = buildFallbackQuery(item);
  const strictQuery = buildFallbackQuery(item);

  if (validStrictFilters.length > 0) {
    strictQuery.query.stats = buildTradeStats(validStrictFilters);
  }

  const useStrict = validStrictFilters.length > 0;
  const chosenQuery = useStrict ? strictQuery : fallbackQuery;

  return {
    matchedMods: mapped.debug.selected.length,
    totalMods: item.mods.length,
    matchedFilters: validStrictFilters,
    matchedDetails: mapped.debug.selected.filter((m) => isValidTradeStatId(m.id)),
    allMatchedMods: mapped.debug.allMatches,
    unmatchedMods: mapped.debug.unmatched,
    strictQuery,
    fallbackQuery,
    chosenQuery,
    useStrict,
    tradeStatsReady: mapped.debug.tradeStatsReady
  };
}

function generateTradeLink(query, league) {
  const encoded = encodeURIComponent(JSON.stringify(query));
  const finalLeague = encodeURIComponent(sanitizeLeagueName(league));
  return `https://www.pathofexile.com/trade/search/${finalLeague}?q=${encoded}`;
}

const POE_HEADERS = {
  "User-Agent": "poe-trade-app/1.0",
  "Content-Type": "application/json"
};

async function estimatePrice(tradeQuery, league) {
  try {
    const searchUrl = `https://www.pathofexile.com/api/trade/search/${encodeURIComponent(
      sanitizeLeagueName(league)
    )}`;

    const payload = tradeQuery;

    const searchRes = await axios.post(searchUrl, payload, {
      headers: POE_HEADERS,
      validateStatus: () => true,
      timeout: 8000
    });

    if (searchRes.status !== 200 || !searchRes.data?.id || !Array.isArray(searchRes.data?.result)) {
      return null;
    }

    const ids = searchRes.data.result.slice(0, 10);

    if (!ids.length) {
      return {
        totalListed: 0,
        cheapest: null,
        examples: []
      };
    }

    const fetchUrl =
      `https://www.pathofexile.com/api/trade/fetch/${ids.join(",")}` +
      `?query=${encodeURIComponent(searchRes.data.id)}`;

    const fetchRes = await axios.get(fetchUrl, {
      headers: POE_HEADERS,
      validateStatus: () => true,
      timeout: 8000
    });

    if (fetchRes.status !== 200 || !Array.isArray(fetchRes.data?.result)) {
      return {
        totalListed: searchRes.data.total ?? ids.length,
        cheapest: null,
        examples: []
      };
    }

    const examples = fetchRes.data.result
      .map((entry) => {
        const price = entry?.listing?.price;
        if (!price) return null;

        return {
          amount: price.amount ?? null,
          currency: price.currency ?? null,
          account: entry?.listing?.account?.name ?? null
        };
      })
      .filter(Boolean);

    return {
      totalListed: searchRes.data.total ?? ids.length,
      cheapest: examples[0] || null,
      examples: examples.slice(0, 3)
    };
  } catch {
    return null;
  }
}

app.post("/generate", async (req, res) => {
  const started = Date.now();

  try {
    await initTradeStats();

    const { input, league, estimatePrices = false } = req.body;

    console.log("START /generate", {
      estimatePrices,
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

    const builtResults = [];
    for (const item of items) {
      const t0 = Date.now();
      const built = buildSafeTradeQuery(item);

      console.log("buildTradeQuery done", {
        item: item.displayName,
        matchedMods: built.matchedMods,
        totalMods: built.totalMods,
        ms: Date.now() - t0,
        useStrict: built.useStrict,
        tradeStatsReady: built.tradeStatsReady,
        matchedFilters: built.matchedDetails.map((m) => ({
          mod: m.mod,
          id: m.id,
          score: m.score,
          type: m.type
        }))
      });

      builtResults.push({ item, built });
    }

    const finalResults = await Promise.all(
      builtResults.map(async (entry, index) => {
        const chosenQuery = entry.built.chosenQuery;
        const queryMode = entry.built.useStrict ? "strict" : "fallback";

        let priceEstimate = null;
        if (estimatePrices && index < MAX_PRICE_CHECKS) {
          priceEstimate = await estimatePrice(chosenQuery, selectedLeague);
        }

        return {
          item: entry.item.displayName,
          rarity: entry.item.rarity,
          searchName: entry.item.searchName,
          searchType: entry.item.searchType,
          link: generateTradeLink(chosenQuery, selectedLeague),
          matchedMods: entry.built.matchedMods,
          totalMods: entry.built.totalMods,
          upgradeScore:
            entry.built.totalMods > 0
              ? Math.round((entry.built.matchedMods / entry.built.totalMods) * 100)
              : 0,
          matchedFilters: entry.built.matchedFilters,
          matchedDetails: entry.built.matchedDetails,
          allMatchedMods: entry.built.allMatchedMods,
          unmatchedMods: entry.built.unmatchedMods,
          queryMode,
          tradeStatsReady: entry.built.tradeStatsReady,
          tradeQuery: chosenQuery,
          strictTradeQuery: entry.built.strictQuery,
          fallbackTradeQuery: entry.built.fallbackQuery,
          priceEstimate
        };
      })
    );

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