const axios = require("axios");

const TRADE_STATS_URL = "https://www.pathofexile.com/api/trade/data/stats";
const TRADE_STATS_REFRESH_MS = 1000 * 60 * 60 * 6; // 6 hours

const TRADE_ID_RE =
  /^(explicit|implicit|enchant|fractured|crafted|pseudo|rune|monster|veiled|delve)\.(stat|pseudo)_[A-Za-z0-9_]+$/;

const state = {
  initialized: false,
  loading: null,
  loadedAt: 0,
  entryCount: 0,
  entries: []
};

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

/* ---------------- TRADE STATS LOADING ---------------- */

function extractEntryTexts(entry) {
  const texts = [];

  if (typeof entry?.text === "string") texts.push(entry.text);

  if (Array.isArray(entry?.option?.options)) {
    for (const opt of entry.option.options) {
      if (typeof opt?.text === "string") texts.push(opt.text);
    }
  }

  return uniq(texts.map(normalize).filter(Boolean));
}

function buildTradeStatEntries(payload) {
  const groups = Array.isArray(payload?.result) ? payload.result : [];
  const out = [];

  for (const group of groups) {
    const groupId = String(group?.id || "");
    const entries = Array.isArray(group?.entries) ? group.entries : [];

    for (const entry of entries) {
      const id = String(entry?.id || "");
      const type = String(entry?.type || groupId || "");

      if (!isValidTradeStatId(id)) continue;

      const texts = extractEntryTexts(entry);
      if (!texts.length) continue;

      out.push({
        id,
        type,
        texts
      });
    }
  }

  return out;
}

async function refreshTradeStats() {
  const res = await axios.get(TRADE_STATS_URL, {
    timeout: 15000,
    headers: {
      "User-Agent": "poe-trade-app/1.0",
      "Accept": "application/json"
    },
    validateStatus: () => true
  });

  if (res.status !== 200 || !res.data) {
    throw new Error(`Failed to load trade stats (${res.status})`);
  }

  const entries = buildTradeStatEntries(res.data);

  if (!entries.length) {
    throw new Error("Trade stats loaded but contained no valid trade stat entries.");
  }

  state.entries = entries;
  state.entryCount = entries.length;
  state.loadedAt = Date.now();
  state.initialized = true;

  console.log("TRADE STAT ENTRIES:", state.entryCount);
}

async function initTradeStats(force = false) {
  const freshEnough =
    state.initialized &&
    Date.now() - state.loadedAt < TRADE_STATS_REFRESH_MS;

  if (!force && freshEnough) {
    return getTradeStatsStatus();
  }

  if (state.loading) {
    return state.loading;
  }

  state.loading = (async () => {
    try {
      await refreshTradeStats();
      return getTradeStatsStatus();
    } finally {
      state.loading = null;
    }
  })();

  return state.loading;
}

function getTradeStatsStatus() {
  return {
    initialized: state.initialized,
    loadedAt: state.loadedAt,
    entryCount: state.entryCount
  };
}

/* ---------------- MATCHING ---------------- */

function score(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 100;

  const ta = tokens(a);
  const tb = tokens(b);

  if (!ta.length || !tb.length) return 0;

  let overlap = 0;
  for (const t of ta) {
    if (tb.includes(t)) overlap++;
  }

  const overlapScore = overlap / Math.max(ta.length, tb.length);

  if (a.includes(b) || b.includes(a)) {
    return Math.max(overlapScore, 0.92);
  }

  return overlapScore;
}

function inferCategory(modObj, hitType) {
  const kind = typeof modObj === "object" ? modObj?.kind : null;
  const t = String(
    typeof modObj === "string"
      ? modObj
      : modObj?.text || modObj?.name || ""
  ).toLowerCase();

  if (kind === "implicit" || hitType === "implicit" || t.includes("implicit")) {
    return "implicit";
  }

  if (kind === "enchant" || hitType === "enchant" || t.includes("enchant")) {
    return "enchant";
  }

  return "explicit";
}

function findBestTradeStat(text) {
  if (!state.initialized || !state.entries.length) {
    return null;
  }

  const norm = normalize(text);
  if (!norm) return null;

  let best = null;

  for (const entry of state.entries) {
    for (const candidate of entry.texts) {
      const s = score(norm, candidate);

      if (!best || s > best.score) {
        best = {
          id: entry.id,
          type: entry.type,
          score: s,
          match: candidate
        };
      }
    }
  }

  if (!best) return null;

  if (best.score < 0.55) return null;
  if (!isValidTradeStatId(best.id)) return null;

  return best;
}

/* ---------------- FILTER SELECTION ---------------- */

function dedupeMatches(matches) {
  const seen = new Set();
  const out = [];

  for (const m of matches.sort((a, b) => b.score - a.score)) {
    if (!m?.id || seen.has(m.id)) continue;
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
    buckets[m.category || "explicit"].push(m);
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
  if (!state.initialized || !state.entries.length) {
    return {
      useStrict: false,
      filters: [],
      debug: {
        allMatches: [],
        selected: [],
        unmatched: (mods || []).map((m) =>
          typeof m === "string" ? m : m?.text || m?.name || ""
        ).filter(Boolean),
        tradeStatsReady: false
      }
    };
  }

  const matches = [];
  const unmatched = [];

  for (const mod of mods || []) {
    const text =
      typeof mod === "string"
        ? mod
        : mod?.text || mod?.name || "";

    if (!text) continue;

    const hit = findBestTradeStat(text);
    if (!hit) {
      unmatched.push(text);
      continue;
    }

    matches.push({
      mod: text,
      id: hit.id,
      score: hit.score,
      match: hit.match,
      type: hit.type,
      category: inferCategory(mod, hit.type)
    });
  }

  const selected = selectBestFilters(matches);

  const filters = selected
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
      selected,
      unmatched,
      tradeStatsReady: true
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
  initTradeStats,
  getTradeStatsStatus,
  mapModsToTradeFilters,
  buildTradeStats,
  isValidTradeStatId,
  normalize
};