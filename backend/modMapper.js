const modsData = require("./data/mods.json");
const statTranslations = require("./data/stat_translations.json");

/* ---------------- NORMALIZE ---------------- */

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\{[^}]*\}/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\d+(\.\d+)?/g, "#")
    .replace(/[+%]/g, "")
    .replace(/[^\w#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(str) {
  return normalize(str).split(" ").filter(Boolean);
}

/* ---------------- BUILD VALID STAT INDEX ---------------- */

const VALID_STATS = [];
const VALID_IDS = new Set();

(function buildStatIndex() {
  const entries = Array.isArray(statTranslations)
    ? statTranslations
    : statTranslations.translations || [];

  for (const entry of entries) {
    const ids = entry.ids || [];

    let strings = [];

    if (entry.English) {
      for (const block of entry.English) {
        if (typeof block === "string") strings.push(block);

        if (block?.string) {
          if (Array.isArray(block.string)) {
            strings.push(...block.string);
          } else {
            strings.push(block.string);
          }
        }
      }
    }

    strings = strings.map(normalize).filter(Boolean);

    for (const id of ids) {
      VALID_IDS.add(id);

      VALID_STATS.push({
        id,
        texts: strings
      });
    }
  }

  console.log("VALID TRADE STATS:", VALID_STATS.length);
})();

/* ---------------- SCORING ---------------- */

function score(a, b) {
  if (a === b) return 100;

  const ta = tokens(a);
  const tb = tokens(b);

  let match = 0;
  for (const t of ta) {
    if (tb.includes(t)) match++;
  }

  return match / Math.max(ta.length, tb.length);
}

function findBestStat(text) {
  const norm = normalize(text);

  let best = null;

  for (const stat of VALID_STATS) {
    for (const t of stat.texts) {
      const s = score(norm, t);

      if (!best || s > best.score) {
        best = {
          id: stat.id,
          score: s,
          match: t
        };
      }
    }
  }

  if (!best || best.score < 0.4) return null;

  return best;
}

/* ---------------- CATEGORY DETECTION ---------------- */

function getCategory(modText) {
  const t = modText.toLowerCase();

  if (t.includes("implicit")) return "implicit";
  if (t.includes("enchant")) return "enchant";
  return "explicit";
}

/* ---------------- OPTIMIZED SELECTION ---------------- */

function selectBestFilters(matches) {
  const caps = {
    total: 5,
    explicit: 4,
    implicit: 1,
    enchant: 1
  };

  const buckets = {
    explicit: [],
    implicit: [],
    enchant: []
  };

  for (const m of matches) {
    const cat = getCategory(m.mod);
    buckets[cat].push(m);
  }

  for (const key in buckets) {
    buckets[key].sort((a, b) => b.score - a.score);
  }

  const selected = [];
  const used = new Set();

  function take(list, limit) {
    for (const m of list) {
      if (selected.length >= caps.total) break;
      if (used.has(m.id)) continue;

      selected.push(m);
      used.add(m.id);

      if (
        list.filter(x => used.has(x.id)).length >= limit
      ) break;
    }
  }

  take(buckets.explicit, caps.explicit);
  take(buckets.implicit, caps.implicit);
  take(buckets.enchant, caps.enchant);

  return selected.slice(0, caps.total);
}

/* ---------------- MAIN ---------------- */

function mapModsToTradeFilters(mods) {
  const matches = [];
  const unmatched = [];

  for (const mod of mods || []) {
    const text = typeof mod === "string" ? mod : mod?.text || mod?.name;

    if (!text) continue;

    const hit = findBestStat(text);

    if (!hit || !VALID_IDS.has(hit.id)) {
      unmatched.push(text);
      continue;
    }

    matches.push({
      mod: text,
      id: hit.id,
      score: hit.score
    });
  }

  const best = selectBestFilters(matches);

  const filters = best.map(m => ({
    id: m.id,
    disabled: false
  }));

  return {
    useStrict: filters.length > 0,
    filters,
    debug: {
      allMatches: matches,
      selected: best,
      unmatched
    }
  };
}

function buildTradeStats(filters) {
  if (!filters.length) return [];

  return [
    {
      type: "and",
      filters
    }
  ];
}

module.exports = {
  mapModsToTradeFilters,
  buildTradeStats
};