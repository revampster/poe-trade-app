const express = require("express");
const cors = require("cors");
const axios = require("axios");
const xml2js = require("xml2js");
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
      validateStatus: () => true
    });

    if (res.status !== 200) {
      throw new Error(`Failed to fetch pastebin build (${res.status})`);
    }

    data = res.data;
  }

  if (input.includes("pobb.in")) {
    const id = extractPobbId(input);
    const res = await axios.get(`https://pobb.in/${id}/raw`, {
      validateStatus: () => true
    });

    if (res.status !== 200) {
      throw new Error(`Failed to fetch pobb.in build (${res.status})`);
    }

    data = res.data;
  }

  return data;
}

function normalizeItemsFromXml(result) {
  const itemsNode =
    result?.PathOfBuilding?.Build?.[0]?.Items?.[0]?.Item ||
    result?.PathOfBuilding?.Items?.[0]?.Item;

  if (!itemsNode || !Array.isArray(itemsNode)) {
    throw new Error("Invalid PoB XML structure or no items found.");
  }

  return itemsNode.map((item, index) => {
    const itemName =
      item?.$?.Name ||
      item?.$?.name ||
      `Item ${index + 1}`;

    const mods =
      (item?.Mods?.[0]?.Mod || []).map((m) => ({
        name: m?.$?.Name || m?.$?.name || "",
        tier: m?.$?.Tier || m?.$?.tier || null
      }))
      .filter((m) => m.name);

    return {
      name: itemName,
      mods
    };
  });
}

async function parsePoB(input) {
  try {
    const data = await fetchPoBData(input);

    const parser = new xml2js.Parser({
      explicitArray: true,
      mergeAttrs: false
    });

    const result = await parser.parseStringPromise(data);
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
        stats: filters.length
          ? [{ type: "and", filters }]
          : []
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

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});