const modsData = require("./data/mods.json");
const statTranslations = require("./data/stat_translations.json");

function stripTags(text) {
  return String(text || "")
    .replace(/\{[^}]*\}/g, "")     // remove {crafted}, {range}, {variant}, etc
    .replace(/\([^)]*\)/g, "")     // remove (12-20) style ranges
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(text) {
  return stripTags(text)
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/[+%]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function collectTranslationStringsForStat(statId) {
  const out = [];

  for (const entry of Object.values(statTranslations)) {
    if (!entry || !Array.isArray(entry.ids) || !Array.isArray(entry.English)) {
      continue;
    }

    if (!entry.ids.includes(statId)) continue;

    for (const block of entry.English) {
      if (!block || !Array.isArray(block.string)) continue;

      for (const s of block.string) {
        out.push(stripTags(s));
      }
    }
  }

  return out;
}

function scoreMatch(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 60;

  const aWords = new Set(a.split(" "));
  const bWords = new Set(b.split(" "));
  let overlap = 0;

  for (const word of aWords) {
    if (bWords.has(word)) overlap++;
  }

  return overlap;
}

function isBadCandidate(text) {
  const t = normalizeText(text);

  return (
    !t ||
    t.length < 3 ||
    t.includes("adds # passive skills") ||
    t.includes("passive skills are jewel sockets") ||
    t.includes("allocates ")
  );
}

function findModByText(text) {
  const needle = normalizeText(text);

  if (isBadCandidate(needle)) {
    return null;
  }

  let bestMod = null;
  let bestScore = 0;
  let bestStatIndex = 0;

  for (const mod of Object.values(modsData)) {
    if (!mod || !Array.isArray(mod.stats)) continue;

    for (let i = 0; i < mod.stats.length; i++) {
      const stat = mod.stats[i];
      if (!stat || !stat.id) continue;

      const candidates = [
        stat.id,
        ...collectTranslationStringsForStat(stat.id)
      ];

      for (const candidate of candidates) {
        const normalizedCandidate = normalizeText(candidate);
        if (isBadCandidate(normalizedCandidate)) continue;

        const score = scoreMatch(needle, normalizedCandidate);

        if (score > bestScore) {
          bestScore = score;
          bestMod = mod;
          bestStatIndex = i;
        }
      }
    }
  }

  if (bestScore < 2) {
    return null;
  }

  return {
    mod: bestMod,
    statIndex: bestStatIndex,
    score: bestScore
  };
}

function getTierRange(found, tierIndex = 0) {
  if (!found || !found.mod || !Array.isArray(found.mod.stats)) return null;

  const stat = found.mod.stats[found.statIndex];
  if (!stat) return null;

  if (!Array.isArray(stat.min) || !Array.isArray(stat.max)) {
    return null;
  }

  const safeIndex = Math.max(
    0,
    Math.min(tierIndex, stat.min.length - 1, stat.max.length - 1)
  );

  return {
    statId: stat.id,
    min: stat.min[safeIndex],
    max: stat.max[safeIndex]
  };
}

module.exports = {
  findModByText,
  getTierRange,
  normalizeText
};