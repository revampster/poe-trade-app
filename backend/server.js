// backend/server.js
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const xml2js = require("xml2js");
const { findModByText, getTierRange } = require("./modMapper");

const app = express();
const PORT = process.env.PORT || 3001;

// Allow requests only from your frontend
app.use(cors({
  origin: "https://poe-trade-app.vercel.app", 
}));

app.use(bodyParser.json());

// Parse PoB XML or links (Pastebin / pobb.in)
async function parsePoB(input) {
  let data = input;

  try {
    // Pastebin links
    if (input.includes("pastebin.com")) {
      const id = input.split("/").pop();
      const res = await axios.get(`https://pastebin.com/raw/${id}`);
      data = res.data;
    }

    // POBB.in links
    if (input.includes("pobb.in")) {
      const id = input.split("/").pop();
      const res = await axios.get(`https://pobb.in/${id}/raw`);
      data = res.data;
    }

    // Parse XML
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(data);

    if (!result?.PathOfBuilding?.Build?.[0]?.Items?.[0]?.Item) {
      throw new Error("Invalid PoB XML structure");
    }

    const items = result.PathOfBuilding.Build[0].Items[0].Item.map(item => ({
      name: item.$.Name,
      mods: (item.Mods?.[0]?.Mod || []).map(m => ({
        name: m.$.Name,
        tier: m.$.Tier || null
      }))
    }));

    return items;
  } catch (err) {
    console.error("PoB Parsing Error:", err.message);
    throw new Error("Failed to parse PoB data. Make sure your link or XML is correct.");
  }
}

// Build trade query from mods
function buildTradeQuery(item) {
  const filters = [];
  item.mods.forEach(mod => {
    const found = findModByText(mod.name);
    if (!found) return;

    const tierIndex = mod.tier ? parseInt(mod.tier.replace("T", "")) - 1 : 0;
    const range = getTierRange(found, tierIndex);
    if (!range) return;

    filters.push({
      id: found.stats[0].id,
      value: { min: range.min, max: range.max }
    });
  });

  return {
    query: {
      status: { option: "online" },
      name: item.name,
      stats: filters.length > 0 ? [{ type: "and", filters }] : []
    }
  };
}

// Generate trade link for Path of Exile
function generateTradeLink(query) {
  const encoded = encodeURIComponent(JSON.stringify(query));
  return `https://www.pathofexile.com/trade/search/Settlers?q=${encoded}`;
}

// API endpoint
app.post("/generate", async (req, res) => {
  try {
    const { input } = req.body;

    if (!input) {
      return res.status(400).json({ error: "No PoB input provided" });
    }

    const items = await parsePoB(input);
    const results = items.map(item => {
      const query = buildTradeQuery(item);
      return { item: item.name, link: generateTradeLink(query) };
    });

    res.json(results);
  } catch (err) {
    console.error("Generate Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));