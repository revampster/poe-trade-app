const modsData = require("./repoe_data/mods.json");

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[+#%]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreMatch(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 75;

  const aWords = new Set(a.split(" "));
  const bWords = new Set(b.split(" "));
  let overlap = 0;

  for (const word of aWords) {
    if (bWords.has(word)) overlap++;
  }

  return overlap;
}

function findModByText(text) {
  const needle = normalizeText(text);
  let bestMod = null;
  let bestScore = 0;

  for (const mod of Object.values(modsData)) {
    if (!mod?.stats || !Array.isArray(mod.stats) || mod.stats.length === 0) {
      continue;
    }

    for (const stat of mod.stats) {
      if (!stat?.id) continue;

      const statText = normalizeText(stat.id);
      const score = scoreMatch(needle, statText);

      if (score > bestScore) {
        bestScore = score;
        bestMod = mod;
      }
    }
  }

  if (bestScore < 2) {
    return null;
  }

  return bestMod;
}

function getTierRange(mod, tierIndex = 0) {
  if (!mod?.stats?.length) return null;

  const stat = mod.stats[0];

  if (!Array.isArray(stat.min) || !Array.isArray(stat.max)) {
    return null;
  }

  const safeIndex = Math.max(
    0,
    Math.min(tierIndex, stat.min.length - 1, stat.max.length - 1)
  );

  return {
    min: stat.min[safeIndex],
    max: stat.max[safeIndex]
  };
}

module.exports = {
  findModByText,
  getTierRange
};