const express = require("express");
const cors = require("cors");
const axios = require("axios");
const xml2js = require("xml2js");
const zlib = require("zlib");
const { findModByText, getTierRange } = require("./modMapper");

const app = express();
const PORT = process.env.PORT || 3001;

const allowedOrigins = [
  "https://poe-trade-app.vercel.app",
  "https://poe-trade-app-git-main-revampsters-projects.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000"
];

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "PoE Trade backend is live"
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
      headers: {
        "User-Agent": "poe-trade-app/1.0"
      }
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
      headers: {
        "User-Agent": "poe-trade-app/1.0"
      }
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
      line.includes("Rarity:") ||
      line === "Corrupted" ||
      line === "Unidentified" ||
      line.startsWith("Note:")
    ) {
      continue;
    }

    if (line.startsWith("{") && line.endsWith("}")) {
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
      line.includes("less ")
    ) {
      reachedMods = true;
    }

    if (!reachedMods) continue;

    mods.push({
      name: line,
      tier: null
    });
  }

  return mods;
}

function extractItemName(item, fallbackIndex) {
  if (item?.$?.Name) return item.$.Name;
  if (item?.$?.name) return item.$.name;

  const text = extractItemText(item);
  if (!text) return `Item ${fallbackIndex + 1}`;

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines[0]?.startsWith("Rarity:")) {
    if (lines[1] && lines[2]) {
      return `${lines[1]} ${lines[2]}`;
    }
    if (lines[1]) {
      return lines[1];
    }
  }

  return lines[0] || `Item ${fallbackIndex + 1}`;
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
    const name = extractItemName(item, index);
    const mods = parseModsFromItemText(itemText);

    return {
      name,
      mods
    };
  });
}

async function parsePoB(input) {
  try {
    const rawData = await fetchPoBData(input);
    const xmlData = maybeDecodePoB(rawData);

    const parser = new xml2js.Parser({
      explicitArray: true,
      mergeAttrs: false
    });

    const result = await parser.parseStringPromise(xmlData);
    return normalizeItemsFromXml(result);
  } catch (err) {
    console.error("PoB Parsing Error:", err.message);
    throw new Error(`Failed to parse PoB data: ${err.message}`);
  }
}

function normalizeTierIndex(tier) {
  if (!tier || typeof tier !== "string") return 0;
  const match = tier.match(/^T(\d+)$/i);
  if (!match) return 0;
  return Math.max(parseInt(match[1], 10) - 1, 0);
}

function buildTradeQuery(item) {
  const filters = [];
  let matchedMods = 0;

  for (const mod of item.mods) {
    const found = findModByText(mod.name);
    if (!found || !found.stats || !found.stats[0]) continue;

    const tierIndex = normalizeTierIndex(mod.tier);
    const range = getTierRange(found, tierIndex);
    if (!range) continue;

    filters.push({
      id: found.stats[0].id,
      value: {
        min: range.min,
        max: range.max
      }
    });

    matchedMods += 1;
  }

  return {
    matchedMods,
    query: {
      query: {
        status: { option: "online" },
        name: item.name,
        stats: filters.length ? [{ type: "and", filters }] : []
      }
    }
  };
}

function generateTradeLink(query) {
  const encoded = encodeURIComponent(JSON.stringify(query));
  return `https://www.pathofexile.com/trade/search/Settlers?q=${encoded}`;
}

app.post("/generate", async (req, res) => {
  try {
    const { input } = req.body;

    if (!input || !input.trim()) {
      return res.status(400).json({ error: "No PoB input provided." });
    }

    const items = await parsePoB(input);

    console.log("Parsed items preview:");
    for (const item of items.slice(0, 5)) {
      console.log({
        name: item.name,
        modCount: item.mods.length,
        mods: item.mods.slice(0, 5)
      });
    }

    const results = items.map((item) => {
      const built = buildTradeQuery(item);

      return {
        item: item.name,
        link: generateTradeLink(built.query),
        matchedMods: built.matchedMods,
        totalMods: item.mods.length,
        upgradeScore:
          item.mods.length > 0
            ? Math.round((built.matchedMods / item.mods.length) * 100)
            : 0
      };
    });

    results.sort((a, b) => b.upgradeScore - a.upgradeScore);

    return res.json(results);
  } catch (err) {
    console.error("Generate Error:", err.message);
    return res.status(500).json({
      error: err.message || "Failed to generate trade links."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend running on port ${PORT}`);
});