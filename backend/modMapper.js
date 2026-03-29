const modsData = require("./data/mods.json");
const statTranslations = require("./data/stat_translations.json");

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\{[^}]*\}/g, "")
    .replace(/\d+/g, "#")
    .replace(/[+%]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 🔥 PREBUILD INDEX (runs once on startup)
 */
const MOD_INDEX = {};

function buildIndex() {
  for (const mod of Object.values(modsData)) {
    if (!mod?.stats) continue;

    for (const stat of mod.stats) {
      if (!stat?.id) continue;

      // index stat id
      const normId = normalize(stat.id);
      if (!MOD_INDEX[normId]) {
        MOD_INDEX[normId] = { mod, stat };
      }

      // index translation strings
      for (const entry of Object.values(statTranslations)) {
        if (!entry?.ids?.includes(stat.id)) continue;

        for (const block of entry.English || []) {
          for (const str of block.string || []) {
            const norm = normalize(str);
            if (!MOD_INDEX[norm]) {
              MOD_INDEX[norm] = { mod, stat };
            }
          }
        }
      }
    }
  }

  console.log("Mod index built:", Object.keys(MOD_INDEX).length);
}

buildIndex();

/**
 * ⚡ FAST LOOKUP
 */
function findModByText(text) {
  const key = normalize(text);

  if (MOD_INDEX[key]) {
    return {
      mod: MOD_INDEX[key].mod,
      statIndex: 0,
      score: 100
    };
  }

  // fallback (light fuzzy, NOT full scan)
  const keys = Object.keys(MOD_INDEX);

  for (const k of keys) {
    if (k.includes(key) || key.includes(k)) {
      return {
        mod: MOD_INDEX[k].mod,
        statIndex: 0,
        score: 60
      };
    }
  }

  return null;
}

function getTierRange(found, tierIndex = 0) {
  if (!found?.mod?.stats) return null;

  const stat = found.mod.stats[0];
  if (!stat?.min || !stat?.max) return null;

  return {
    statId: stat.id,
    min: stat.min[0],
    max: stat.max[0]
  };
}

module.exports = {
  findModByText,
  getTierRange
};