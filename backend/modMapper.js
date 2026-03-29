const modsData = require("./repoe_data/mods.json");

function findModByText(text) {
  return Object.values(modsData).find(mod =>
    mod.stats?.some(stat =>
      text.toLowerCase().includes(stat.id.toLowerCase())
    )
  );
}

function getTierRange(mod, tierIndex = 0) {
  if (!mod || !mod.stats) return null;
  const stat = mod.stats[0];
  const min = stat.min[tierIndex];
  const max = stat.max[tierIndex];
  return { min, max };
}

module.exports = { findModByText, getTierRange };