const modsData = require("./repoe_data/mods.json");

function cleanModText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\{[^}]*\}/g, "") // remove {crafted}, {range}, etc
    .replace(/\([^)]*\)/g, "") // remove (12-20)
    .replace(/\d+/g, "#") // normalize numbers
    .replace(/[+%]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(a, b) {
  if (!a || !b) return 0;

  if (a === b) return 100;

  if (a.includes(b) || b.includes(a)) return 50;

  const aWords = a.split(" ");
  const bWords = b.split(" ");

  let score = 0;

  for (const word of aWords) {
    if (bWords.includes(word)) score++;
  }

  return score;
}

function findModByText(text) {
  const cleaned = cleanModText(text);

  let best = null;
  let bestScore = 0;

  for (const mod of Object.values(modsData)) {
    if (!mod.stats || !Array.isArray(mod.stats)) continue;

    for (const stat of mod.stats) {
      if (!stat.id) continue;

      const statText = cleanModText(stat.id);

      const score = similarity(cleaned, statText);

      if (score > bestScore) {
        bestScore = score;
        best = mod;
      }
    }
  }

  // require minimum match strength
  if (bestScore < 2) return null;

  return best;
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