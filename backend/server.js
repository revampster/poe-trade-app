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
const SEARCH_DELAY_MS = 300;
const MAX_SEARCH_RETRIES = 2;
const ENABLE_DEBUG = true;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const POE_HEADERS = {
  "User-Agent": "poe-trade-app/1.0",
  "Content-Type": "application/json",
  Accept: "application/json"
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function sanitizeLeagueName(league) {
  const cleaned = String(league || "").trim();
  return cleaned || DEFAULT_TRADE_LEAGUE;
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "PoE Trade backend is live",
    defaultTradeLeague: DEFAULT_TRADE_LEAGUE,
    tradeStats: getTradeStatsStatus()
  });
});

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
  if (typeof item?._ === "string") return item._;
  if (Array.isArray(item) && typeof item[0] === "string") return item[0];
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

function isPassiveCountLine(line) {
  const lower = stripPobTags(line).toLowerCase();
  return /^adds\s+\d+\s+passive skills$/.test(lower);
}

function shouldSkipModLine(line) {
  const lower = stripPobTags(line).toLowerCase();

  return (
    isPassiveCountLine(lower) ||
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
  if (isPassiveCountLine(noTags)) return null;

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

function detectClusterBaseType(lines) {
  const joined = lines.join("\n").toLowerCase();

  if (joined.includes("large cluster jewel")) return "Large Cluster Jewel";
  if (joined.includes("medium cluster jewel")) return "Medium Cluster Jewel";
  if (joined.includes("small cluster jewel")) return "Small Cluster Jewel";

  return "";
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
      searchType: "",
      rawLines: [],
      isClusterJewel: false
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

  const clusterType = detectClusterBaseType(lines);
  const isClusterJewel = !!clusterType;

  if (rarity === "Unique") {
    searchName = lines[1] || "";
    searchType = lines[2] || "";
    displayName = [searchName, searchType].filter(Boolean).join(" ") || searchName || searchType || displayName;
  } else if (rarity === "Rare") {
    const rareName = lines[1] || "";
    searchType = lines[2] || "";
    displayName = [rareName, searchType].filter(Boolean).join(" ") || rareName || searchType || displayName;
  } else if (rarity === "Magic") {
    const magicName = lines[1] || "";
    const maybeBase = lines[2] || "";

    if (clusterType) {
      searchType = clusterType;
      displayName = [magicName, clusterType].filter(Boolean).join(" ");
    } else if (maybeBase) {
      searchType = maybeBase;
      displayName = [magicName, maybeBase].filter(Boolean).join(" ");
    } else {
      searchType = magicName;
      displayName = magicName || displayName;
    }
  } else {
    if (clusterType) {
      searchType = clusterType;
      displayName = clusterType;
    } else {
      searchType = lines[1] || lines[0] || "";
      displayName = searchType || displayName;
    }
  }

  return {
    rarity,
    displayName,
    searchName,
    searchType,
    rawLines: lines,
    isClusterJewel
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
      rawLines: meta.rawLines,
      isClusterJewel: meta.isClusterJewel,
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

function buildStatsGroup(filters = []) {
  return [
    {
      type: "and",
      filters
    }
  ];
}

function buildWebsiteFallbackLink(item, league) {
  const finalLeague = encodeURIComponent(sanitizeLeagueName(league));
  const text = [item.searchName, item.searchType].filter(Boolean).join(" ").trim() || item.displayName;
  const query = encodeURIComponent(text);
  return `https://www.pathofexile.com/trade/search/${finalLeague}?q=${query}`;
}

function buildBaseQuery(item, variant = "default") {
  const query = {
    query: {
      status: { option: "online" },
      stats: buildStatsGroup([])
    },
    sort: { price: "asc" }
  };

  const type = String(item.searchType || "").trim();
  const name = String(item.searchName || "").trim();

  if (variant === "status-only") {
    return query;
  }

  if (item.isClusterJewel) {
    query.query.type = type || "Large Cluster Jewel";
    return query;
  }

  if (item.rarity === "Unique") {
    if (variant === "unique-name-type") {
      if (name) query.query.name = name;
      if (type) query.query.type = type;
      return query;
    }

    if (variant === "type-only" && type) {
      query.query.type = type;
      return query;
    }

    if (variant === "name-only" && name) {
      query.query.name = name;
      return query;
    }
  } else {
    if (variant === "type-only" && type) {
      query.query.type = type;
      return query;
    }

    if (variant === "name-only" && name) {
      query.query.name = name;
      return query;
    }
  }

  if (type) query.query.type = type;
  else if (name) query.query.name = name;

  return query;
}

function getBaseQueryCandidates(item) {
  const candidates = [];

  if (item.isClusterJewel) {
    candidates.push({ label: "cluster-type-only", query: buildBaseQuery(item, "type-only") });
    candidates.push({ label: "cluster-status-only", query: buildBaseQuery(item, "status-only") });
  } else if (item.rarity === "Unique") {
    candidates.push({ label: "unique-name-type", query: buildBaseQuery(item, "unique-name-type") });
    candidates.push({ label: "unique-type-only", query: buildBaseQuery(item, "type-only") });
    candidates.push({ label: "unique-name-only", query: buildBaseQuery(item, "name-only") });
    candidates.push({ label: "unique-status-only", query: buildBaseQuery(item, "status-only") });
  } else {
    candidates.push({ label: "type-only", query: buildBaseQuery(item, "type-only") });
    candidates.push({ label: "name-only", query: buildBaseQuery(item, "name-only") });
    candidates.push({ label: "status-only", query: buildBaseQuery(item, "status-only") });
  }

  const seen = new Set();
  return candidates.filter((c) => {
    const key = JSON.stringify(c.query);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function submitTradeSearch(queryObject, league) {
  const searchUrl = `https://www.pathofexile.com/api/trade/search/${encodeURIComponent(
    sanitizeLeagueName(league)
  )}`;

  let attempt = 0;
  let last = null;

  while (attempt <= MAX_SEARCH_RETRIES) {
    if (attempt > 0) {
      await sleep(700 * attempt);
    }

    const res = await axios.post(searchUrl, queryObject, {
      headers: POE_HEADERS,
      validateStatus: () => true,
      timeout: 12000
    });

    last = res;

    if (res.status !== 429) {
      return {
        status: res.status,
        data: res.data,
        headers: {
          "retry-after": res.headers["retry-after"] || null
        }
      };
    }

    const retryAfter = Number(res.headers["retry-after"]);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      await sleep(retryAfter * 1000);
    } else {
      await sleep(1500 * (attempt + 1));
    }

    attempt += 1;
  }

  return {
    status: last?.status || 429,
    data: last?.data || null,
    headers: {
      "retry-after": last?.headers?.["retry-after"] || null
    }
  };
}

function sanitizeDebugResponse(data) {
  if (data == null) return null;
  if (typeof data === "string") return data.slice(0, 800);
  try {
    const cloned = JSON.parse(JSON.stringify(data));
    if (cloned.error) return { error: cloned.error };
    return cloned;
  } catch {
    return { note: "unserializable response" };
  }
}

async function tryQuery(label, query, league, debugAttempts) {
  const result = await submitTradeSearch(query, league);

  debugAttempts.push({
    label,
    status: result.status,
    searchId: result?.data?.id || null,
    query: safeClone(query),
    response: sanitizeDebugResponse(result.data)
  });

  return result;
}

function buildTradeResultLink(league, searchId) {
  const finalLeague = encodeURIComponent(sanitizeLeagueName(league));
  return `https://www.pathofexile.com/trade/search/${finalLeague}/${encodeURIComponent(searchId)}`;
}

async function resolveTradeQuery(item, league) {
  const debugAttempts = [];
  const mapped = mapModsToTradeFilters(item.mods.slice(0, MAX_MODS_PER_ITEM));
  const strictCandidates = mapped.filters.filter((f) => isValidTradeStatId(f.id));
  const matchedDetails = mapped.debug.selected.filter((m) => isValidTradeStatId(m.id));

  let acceptedBase = null;
  let acceptedBaseLabel = null;
  let acceptedSearchId = null;

  for (const candidate of getBaseQueryCandidates(item)) {
    const result = await tryQuery(candidate.label, candidate.query, league, debugAttempts);
    if (result.status === 200 && result?.data?.id) {
      acceptedBase = candidate.query;
      acceptedBaseLabel = candidate.label;
      acceptedSearchId = result.data.id;
      break;
    }
    await sleep(SEARCH_DELAY_MS);
  }

  if (!acceptedBase) {
    const websiteFallbackLink = buildWebsiteFallbackLink(item, league);

    return {
      link: websiteFallbackLink,
      searchId: null,
      queryMode: "website-fallback",
      strictAccepted: false,
      fallbackAccepted: false,
      matchedMods: mapped.debug.selected.length,
      totalMods: item.mods.length,
      matchedFilters: [],
      matchedDetails,
      allMatchedMods: mapped.debug.allMatches,
      unmatchedMods: mapped.debug.unmatched,
      tradeStatsReady: mapped.debug.tradeStatsReady,
      tradeQuery: null,
      debug: {
        itemMeta: {
          rarity: item.rarity,
          displayName: item.displayName,
          searchName: item.searchName,
          searchType: item.searchType,
          isClusterJewel: item.isClusterJewel
        },
        acceptedBaseLabel: null,
        websiteFallbackLink,
        attempts: debugAttempts
      }
    };
  }

  let acceptedQuery = safeClone(acceptedBase);
  let queryMode = "fallback";

  if (!item.isClusterJewel && strictCandidates.length > 0) {
    const acceptedFilters = [];

    for (const filter of strictCandidates) {
      const nextQuery = safeClone(acceptedQuery);
      nextQuery.query.stats = buildStatsGroup([
        ...acceptedFilters,
        { id: filter.id, disabled: false }
      ]);

      const result = await tryQuery(
        `strict-add-${filter.id}`,
        nextQuery,
        league,
        debugAttempts
      );

      if (result.status === 200 && result?.data?.id) {
        acceptedFilters.push({ id: filter.id, disabled: false });
        acceptedQuery = nextQuery;
        acceptedSearchId = result.data.id;
        queryMode = "strict";
      }

      await sleep(SEARCH_DELAY_MS);
    }
  }

  return {
    link: buildTradeResultLink(league, acceptedSearchId),
    searchId: acceptedSearchId,
    queryMode,
    strictAccepted: queryMode === "strict",
    fallbackAccepted: true,
    matchedMods: mapped.debug.selected.length,
    totalMods: item.mods.length,
    matchedFilters:
      queryMode === "strict"
        ? (acceptedQuery.query.stats?.[0]?.filters || [])
        : [],
    matchedDetails,
    allMatchedMods: mapped.debug.allMatches,
    unmatchedMods: mapped.debug.unmatched,
    tradeStatsReady: mapped.debug.tradeStatsReady,
    tradeQuery: acceptedQuery,
    debug: {
      itemMeta: {
        rarity: item.rarity,
        displayName: item.displayName,
        searchName: item.searchName,
        searchType: item.searchType,
        isClusterJewel: item.isClusterJewel
      },
      acceptedBaseLabel,
      websiteFallbackLink: null,
      attempts: debugAttempts
    }
  };
}

app.post("/debug/validate-query", async (req, res) => {
  try {
    const { league, query } = req.body || {};
    if (!query) {
      return res.status(400).json({ error: "Missing query" });
    }

    const result = await submitTradeSearch(query, sanitizeLeagueName(league));
    return res.json({
      ok: result.status === 200 && !!result?.data?.id,
      status: result.status,
      searchId: result?.data?.id || null,
      response: sanitizeDebugResponse(result.data),
      query
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "debug validate failed" });
  }
});

app.post("/debug/item-query", async (req, res) => {
  try {
    await initTradeStats();

    const { item, league } = req.body || {};
    if (!item) {
      return res.status(400).json({ error: "Missing item" });
    }

    const resolved = await resolveTradeQuery(item, sanitizeLeagueName(league));
    return res.json(resolved);
  } catch (err) {
    return res.status(500).json({ error: err.message || "debug item query failed" });
  }
});

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

    const results = [];

    for (const item of items) {
      const t0 = Date.now();
      const resolved = await resolveTradeQuery(item, selectedLeague);

      console.log("buildTradeQuery done", {
        item: item.displayName,
        matchedMods: resolved.matchedMods,
        totalMods: resolved.totalMods,
        ms: Date.now() - t0,
        queryMode: resolved.queryMode,
        debugAttempts: resolved.debug.attempts.map((a) => ({
          label: a.label,
          status: a.status,
          searchId: a.searchId
        }))
      });

      results.push({
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
        tradeQuery: resolved.tradeQuery,
        debug: ENABLE_DEBUG ? resolved.debug : undefined
      });

      await sleep(SEARCH_DELAY_MS);
    }

    console.log("END /generate", {
      totalMs: Date.now() - started,
      finalCount: results.length
    });

    return res.json({
      league: selectedLeague,
      tradeStats: getTradeStatsStatus(),
      results
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