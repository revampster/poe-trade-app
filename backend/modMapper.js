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

const MOD_INDEX = {};

function buildIndex() {
  for (const mod of Object.values(modsData)) {
    if (!mod?.stats) continue;

    for (let i = 0; i < mod.stats.length; i++) {
      const stat = mod.stats[i];
      if (!stat?.id) continue;

      const keyId = normalize(stat.id);

      MOD_INDEX[keyId] = {
        mod,
        statIndex: i
      };

      for (const entry of Object.values(statTranslations)) {
        if (!entry?.ids?.includes(stat.id)) continue;

        for (const block of entry.English || []) {
          for (const str of block.string || []) {
            const key = normalize(str);

            if (!MOD_INDEX[key]) {
              MOD_INDEX[key] = {
                mod,
                statIndex: i
              };
            }
          }
        }
      }
    }
  }

  console.log("Mod index built:", Object.keys(MOD_INDEX).length);
}

buildIndex();

function findModByText(text) {
  const key = normalize(text);

  if (MOD_INDEX[key]) {
    return {
      mod: MOD_INDEX[key].mod,
      statIndex: MOD_INDEX[key].statIndex,
      score: 100
    };
  }

  // fallback fuzzy (light only)
  for (const k in MOD_INDEX) {
    if (k.includes(key) || key.includes(k)) {
      return {
        mod: MOD_INDEX[k].mod,
        statIndex: MOD_INDEX[k].statIndex,
        score: 60
      };
    }
  }

  return null;
}

function getTierRange(found, tierIndex = 0) {
  if (!found?.mod?.stats) return null;

  const stat = found.mod.stats[found.statIndex];

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