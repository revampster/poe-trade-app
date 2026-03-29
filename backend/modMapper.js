const modsData = require("./data/mods.json");
const statTranslations = require("./data/stat_translations.json");

function stripTags(text) {
  return String(text || "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/\([^)]*\)/g, "")
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

function collectTranslationStrings(statId) {
  const out = [];

  for (const entry of Object.values(statTranslations)) {
    if (!entry?.ids || !entry?.English) continue;
    if (!entry.ids.includes(statId)) continue;

    for (const block of entry.English) {
      if (!block?.string) continue;
      for (const s of block.string) {
        out.push(stripTags(s));
      }
    }
  }

  return out;
}

function score(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 60;

  const aWords = new Set(a.split(" "));
  const bWords = new Set(b.split(" "));
  let overlap = 0;

  for (const w of aWords) {
    if (bWords.has(w)) overlap++;
  }

  return overlap;
}

function isBad(text) {
  const t = normalizeText(text);
  return (
    !t ||
    t.length < 3 ||
    t.includes("passive skills") ||
    t.includes("afflictionjewel") ||
    t.includes("allocates")
  );
}

function findModByText(text) {
  const needle = normalizeText(text);
  if (isBad(needle)) return null;

  let best = null;
  let bestScore = 0;
  let bestIndex = 0;

  for (const mod of Object.values(modsData)) {
    if (!mod?.stats) continue;

    for (let i = 0; i < mod.stats.length; i++) {
      const stat = mod.stats[i];
      if (!stat?.id) continue;

      const candidates = [stat.id, ...collectTranslationStrings(stat.id)];

      for (const c of candidates) {
        const norm = normalizeText(c);
        if (isBad(norm)) continue;

        const s = score(needle, norm);

        if (s > bestScore) {
          bestScore = s;
          best = mod;
          bestIndex = i;
        }
      }
    }
  }

  if (bestScore < 2) return null;

  return {
    mod: best,
    statIndex: bestIndex,
    score: bestScore
  };
}

function getTierRange(found, tierIndex = 0) {
  if (!found?.mod?.stats) return null;

  const stat = found.mod.stats[found.statIndex];
  if (!stat?.min || !stat?.max) return null;

  const i = Math.max(0, Math.min(tierIndex, stat.min.length - 1));

  return {
    statId: stat.id,
    min: stat.min[i],
    max: stat.max[i]
  };
}

module.exports = {
  findModByText,
  getTierRange
};