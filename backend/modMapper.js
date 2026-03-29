const modsData = require("./data/mods.json");
const statTranslations = require("./data/stat_translations.json");

/*
  IMPORTANT:
  - stat_translations.json is useful for text matching
  - but its raw ids are NOT guaranteed to be valid trade-site stat ids
  - only ids in the trade format should ever be emitted into a trade query

  Valid trade ids look like:
    explicit.stat_...
    implicit.stat_...
    enchant.stat_...
    fractured.stat_...
    crafted.stat_...
    pseudo.pseudo_...
    rune.stat_...
    monster.stat_...
*/

const TRADE_ID_RE =
  /^(explicit|implicit|enchant|fractured|crafted|pseudo|rune|monster)\.(stat|pseudo)_[A-Za-z0-9_]+$/;

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

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function isValidTradeStatId(id) {
  return TRADE_ID_RE.test(String(id || ""));
}

/* ---------------- BUILD MATCH INDEX ---------------- */

const MATCHABLE_STATS = [];
const VALID_TRADE_IDS = new Set();

/*
  We still load stat_translations for text matching, but we only keep ids that
  already look like actual trade ids.
*/
(function buildStatIndex() {
  const entries = Array.isArray(statTranslations)
    ? statTranslations
    : statTranslations.translations || [];

  for (const entry of entries) {
    const ids = Array.isArray(entry.ids) ? entry.ids : [];

    let strings = [];

    if (Array.isArray(entry.English)) {
      for (const block of entry.English) {
        if (typeof block === "string") {
          strings.push(block);
        }

        if (block && block.string) {
          if (Array.isArray(block.string)) {
            strings.push(...block.string);
          } else if (typeof block.string === "string") {
            strings.push(block.string);
          }
        }
      }
    }

    strings = uniq(strings.map(normalize).filter(Boolean));

    for (const id of ids) {
      if (!isValidTradeStatId(id)) continue;

      VALID_TRADE_IDS.add(id);
      MATCHABLE_STATS.push({
        id,
        texts: strings
      });
    }
  }

  console.log("VALID TRADE-FORMAT STAT IDS:", VALID_TRADE_IDS.size);
})();

/*
  Optional alias support from mods.json:
  We only use aliases to improve text recall, never as a source of trusted ids
  unless the alias already contains a valid trade-format id.
*/
const MOD_ALIASES = [];

(function buildModAliasIndex() {
  const rows = [];

  if (Array.isArray(modsData)) {
    rows.push(...modsData);
  } else if (modsData && typeof modsData === "object") {
    for (const value of Object.values(modsData)) {
      if (Array.isArray(value)) rows.push(...value);
    }
  }

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;

    const aliasTexts = [];

    for (const key of ["text", "name", "stat", "mod", "tradeText", "match"]) {
      if (typeof row[key] === "string") aliasTexts.push(row[key]);
    }

    if (Array.isArray(row.aliases)) {
      aliasTexts.push(...row.aliases.filter((x) => typeof x === "string"));
    }

    const possibleId =
      row.tradeStatId ||
      row.trade_stat_id ||
      row.statId ||
      row.tradeId ||
      row.id ||
      null;

    MOD_ALIASES.push({
      texts: uniq(aliasTexts.map(normalize).filter(Boolean)),
      tradeId: isValidTradeStatId(possibleId) ? possibleId : null
    });
  }
})();

/* ---------------- SCORING ---------------- */

function score(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 100;

  const ta = tokens(a);
  const tb = tokens(b);

  if (!ta.length || !tb.length) return 0;

  let match = 0;
  for (const t of ta) {
    if (tb.includes(t)) match++;
  }

  const overlapScore = match / Math.max(ta.length, tb.length);
  if (a.includes(b) || b.includes(a)) {
    return Math.max(overlapScore, 0.9);
  }

  return overlapScore;
}

function findBestStat(text) {
  const norm = normalize(text);
  let best = null;

  for (const stat of MATCHABLE_STATS) {
    for (const t of stat.texts) {
      const s = score(norm, t);

      if (!best || s > best.score) {
        best = {
          id: stat.id,
          score: s,
          match: t,
          via: "trade-stat-text"
        };
      }
    }
  }

  for (const row of MOD_ALIASES) {
    for (const t of row.texts) {
      const s = score(norm, t);

      if (
        row.tradeId &&
        (!best || s > best.score)
      ) {
        best = {
          id: row.tradeId,
          score: s,
          match: t,
          via: "mods-alias"
        };
      }
    }
  }

  if (!best) return null;

  // Require strong confidence since strict mode is fragile.
  if (best.score < 0.55) return null;

  // Safety check
  if (!isValidTradeStatId(best.id)) return null;

  return best;
}

/* ---------------- CATEGORY DETECTION ---------------- */

function getCategory(modObj) {
  const kind = typeof modObj === "object" ? modObj?.kind : null;
  const text = typeof modObj === "string"
    ? modObj
    : modObj?.text || modObj?.name || "";

  if (kind === "implicit") return "implicit";
  if (kind === "enchant") return "enchant";

  const t = String(text || "").toLowerCase();
  if (t.includes("implicit")) return "implicit";
  if (t.includes("enchant")) return "enchant";

  return "explicit";
}

/* ---------------- OPTIMIZED SELECTION ---------------- */

function dedupeMatches(matches) {
  const seen = new Set();
  const out = [];

  for (const m of matches.sort((a, b) => b.score - a.score)) {
    if (!m?.id) continue;
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }

  return out;
}

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

  for (const m of dedupeMatches(matches)) {
    const cat = m.category || "explicit";
    buckets[cat].push(m);
  }

  for (const key of Object.keys(buckets)) {
    buckets[key].sort((a, b) => b.score - a.score);
  }

  const selected = [];
  const usedIds = new Set();

  function take(list, limit) {
    let taken = 0;

    for (const m of list) {
      if (selected.length >= caps.total) break;
      if (taken >= limit) break;
      if (usedIds.has(m.id)) continue;
      if (!isValidTradeStatId(m.id)) continue;

      selected.push(m);
      usedIds.add(m.id);
      taken += 1;
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
    const text =
      typeof mod === "string"
        ? mod
        : mod?.text || mod?.name || "";

    if (!text) continue;

    const hit = findBestStat(text);
    if (!hit) {
      unmatched.push(text);
      continue;
    }

    if (!isValidTradeStatId(hit.id)) {
      unmatched.push(text);
      continue;
    }

    matches.push({
      mod: text,
      id: hit.id,
      score: hit.score,
      match: hit.match,
      via: hit.via,
      category: getCategory(mod)
    });
  }

  const best = selectBestFilters(matches);

  const filters = best
    .filter((m) => isValidTradeStatId(m.id))
    .map((m) => ({
      id: m.id,
      disabled: false
    }));

  return {
    useStrict: filters.length > 0,
    filters,
    debug: {
      allMatches: matches,
      selected: best,
      unmatched,
      validTradeIdCount: VALID_TRADE_IDS.size
    }
  };
}

function buildTradeStats(filters) {
  const valid = (filters || []).filter((f) => isValidTradeStatId(f.id));

  if (!valid.length) return [];

  return [
    {
      type: "and",
      filters: valid.map((f) => ({
        id: f.id,
        disabled: false
      }))
    }
  ];
}

module.exports = {
  mapModsToTradeFilters,
  buildTradeStats,
  isValidTradeStatId,
  normalize
};