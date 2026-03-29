const express = require("express");
const cors = require("cors");
const axios = require("axios");
const xml2js = require("xml2js");
const zlib = require("zlib");

const { findModByText, getTierRange } = require("./modMapper");

const app = express();
const PORT = process.env.PORT || 3001;
const DEFAULT_LEAGUE = process.env.TRADE_LEAGUE || "Mirage";

app.use(cors());
app.use(express.json());

function generateTradeLink(query, league) {
  const encoded = encodeURIComponent(JSON.stringify(query));
  return `https://www.pathofexile.com/trade/search/${league}?q=${encoded}`;
}

function normalizeTierIndex(tier) {
  if (!tier) return 0;
  const match = tier.match(/^T(\d+)/i);
  return match ? parseInt(match[1]) - 1 : 0;
}

function shouldSkip(line) {
  const l = line.toLowerCase();

  return (
    l.includes("afflictionjewel") ||
    l.includes("passive skills") ||
    l.includes("catalystquality") ||
    l.includes("percentile") ||
    l.includes("basepercentile") ||
    l.match(/^\w+: \d+$/)
  );
}

function parseMods(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const mods = [];

  for (const line of lines) {
    if (shouldSkip(line)) continue;

    if (
      line.includes("+") ||
      line.includes("%") ||
      line.includes("increased") ||
      line.includes("reduced") ||
      line.includes("more") ||
      line.includes("less")
    ) {
      mods.push({ name: line, tier: null });
    }
  }

  return mods;
}

function extractItems(xml) {
  const items =
    xml?.PathOfBuilding?.Build?.[0]?.Items?.[0]?.Item || [];

  return items.map((item, i) => {
    const text = item._ || "";
    const name = `Item ${i + 1}`;

    return {
      name,
      mods: parseMods(text)
    };
  });
}

async function parsePoB(input) {
  let data = input;

  if (input.includes("pobb.in")) {
    const id = input.split("/").pop();
    const res = await axios.get(`https://pobb.in/${id}/raw`);
    data = res.data;
  }

  if (!data.startsWith("<")) {
    const buffer = Buffer.from(data, "base64");
    data = zlib.inflateSync(buffer).toString();
  }

  const parser = new xml2js.Parser();
  const result = await parser.parseStringPromise(data);

  return extractItems(result);
}

function buildQuery(item) {
  const filters = [];
  let matched = 0;

  for (const mod of item.mods) {
    const found = findModByText(mod.name);
    if (!found) continue;

    const range = getTierRange(found, 0);
    if (!range) continue;

    filters.push({
      id: range.statId,
      value: { min: range.min, max: range.max }
    });

    matched++;
  }

  return {
    matchedMods: matched,
    totalMods: item.mods.length,
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

app.post("/generate", async (req, res) => {
  try {
    const { input, league } = req.body;

    const selectedLeague = league || DEFAULT_LEAGUE;

    const items = await parsePoB(input);

    const results = items.map(item => {
      const built = buildQuery(item);

      return {
        item: item.name,
        link: generateTradeLink(built.query, selectedLeague),
        matchedMods: built.matchedMods,
        totalMods: built.totalMods,
        upgradeScore:
          built.totalMods > 0
            ? Math.round(
                (built.matchedMods / built.totalMods) * 100
              )
            : 0
      };
    });

    res.json({ league: selectedLeague, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});