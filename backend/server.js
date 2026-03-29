const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const xml2js = require("xml2js");
const { findModByText, getTierRange } = require("./modMapper");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3001;

async function parsePoB(input) {
  let data = input;
  if (input.includes("pastebin.com")) {
    const id = input.split("/").pop();
    const res = await axios.get(`https://pastebin.com/raw/${id}`);
    data = res.data;
  }
  const parser = new xml2js.Parser();
  const result = await parser.parseStringPromise(data);
  const items = result.PathOfBuilding.Build[0].Items[0].Item.map(item => ({
    name: item.$.Name,
    mods: (item.Mods?.[0]?.Mod || []).map(m => ({
      name: m.$.Name,
      tier: m.$.Tier || null
    }))
  }));
  return items;
}

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
      stats: [{ type: "and", filters }]
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
    const items = await parsePoB(input);
    const results = items.map(item => {
      const query = buildTradeQuery(item);
      return { item: item.name, link: generateTradeLink(query) };
    });
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error parsing PoB or generating links");
  }
});

app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));