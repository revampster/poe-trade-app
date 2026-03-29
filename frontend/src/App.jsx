import { useState } from "react";
import axios from "axios";

export default function App() {
  const [input, setInput] = useState("");
  const [league, setLeague] = useState("Mirage");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [returnedLeague, setReturnedLeague] = useState("");

  const API_URL = import.meta.env.VITE_REACT_APP_API;

  const handleGenerate = async () => {
    if (!input.trim()) {
      setError("Please paste your PoB XML, pobb.in link, or Pastebin link.");
      return;
    }

    if (!API_URL) {
      setError("Missing VITE_REACT_APP_API environment variable.");
      return;
    }

    setLoading(true);
    setError("");
    setResults([]);
    setReturnedLeague("");

    try {
      const res = await axios.post(`${API_URL}/generate`, {
        input,
        league
      });

      if (res.data && Array.isArray(res.data.results)) {
        setResults(res.data.results);
        setReturnedLeague(res.data.league || league);

        if (res.data.results.length === 0) {
          setError("No items found or no usable mods were matched.");
        }
      } else {
        setError("No items found or invalid PoB data.");
      }
    } catch (err) {
      console.error("API Error:", err);

      const message =
        err?.response?.data?.error ||
        err?.message ||
        "Error generating trade links.";

      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const leagueOptions = [
    "Mirage",
    "Standard",
    "Hardcore",
    "Solo Self-Found",
    "Hardcore Solo Self-Found"
  ];

  return (
    <div
      style={{
        padding: 20,
        fontFamily: "Arial, sans-serif",
        maxWidth: 1100,
        margin: "0 auto"
      }}
    >
      <h1>PoE Trade Link Generator</h1>

      <p>
        Paste a Path of Building XML export, a pobb.in link, or a Pastebin link.
      </p>

      <div style={{ marginBottom: 16 }}>
        <label htmlFor="league-select" style={{ display: "block", marginBottom: 8 }}>
          Trade League
        </label>
        <select
          id="league-select"
          value={league}
          onChange={(e) => setLeague(e.target.value)}
          style={{
            padding: 10,
            fontSize: 14,
            minWidth: 280
          }}
        >
          {leagueOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>

      <textarea
        rows={14}
        cols={80}
        placeholder="Paste Path of Building XML, pobb.in link, or Pastebin link here"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        style={{
          padding: 10,
          fontSize: 14,
          width: "100%",
          maxWidth: "100%",
          boxSizing: "border-box"
        }}
      />

      <br />
      <br />

      <button
        onClick={handleGenerate}
        disabled={loading}
        style={{
          padding: "10px 20px",
          cursor: loading ? "not-allowed" : "pointer"
        }}
      >
        {loading ? "Generating..." : "Generate Links"}
      </button>

      {returnedLeague && !error && (
        <p style={{ marginTop: 16 }}>
          <strong>Using trade league:</strong> {returnedLeague}
        </p>
      )}

      {error && (
        <div
          style={{
            marginTop: 20,
            padding: 12,
            border: "1px solid #cc0000",
            background: "#ffe6e6",
            color: "#990000"
          }}
        >
          <strong>Error:</strong> {error}
        </div>
      )}

      <div style={{ marginTop: 24 }}>
        {results.map((r, i) => (
          <div
            key={i}
            style={{
              border: "1px solid #ddd",
              padding: 16,
              marginBottom: 16,
              borderRadius: 8
            }}
          >
            <h3 style={{ marginTop: 0 }}>{r.item}</h3>

            <p style={{ margin: "6px 0" }}>
              <strong>Matched Mods:</strong> {r.matchedMods} / {r.totalMods}
            </p>

            <p style={{ margin: "6px 0" }}>
              <strong>Upgrade Score:</strong> {r.upgradeScore}%
            </p>

            <p style={{ margin: "10px 0" }}>
              <a href={r.link} target="_blank" rel="noopener noreferrer">
                Open Trade Search
              </a>
            </p>

            <div style={{ marginTop: 12 }}>
              <strong>Matched Details</strong>
              {r.matchedDetails && r.matchedDetails.length > 0 ? (
                <div style={{ marginTop: 8 }}>
                  {r.matchedDetails.map((m, idx) => (
                    <div
                      key={idx}
                      style={{
                        padding: 8,
                        marginBottom: 8,
                        background: "#f7f7f7",
                        borderRadius: 6
                      }}
                    >
                      <div><strong>Input Mod:</strong> {m.inputMod}</div>
                      <div><strong>Stat ID:</strong> {m.statId}</div>
                      <div><strong>Range:</strong> {m.min} - {m.max}</div>
                      <div><strong>Match Score:</strong> {m.score}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ marginTop: 8 }}>No matched details.</p>
              )}
            </div>

            <div style={{ marginTop: 12 }}>
              <strong>Unmatched Mods</strong>
              {r.unmatchedMods && r.unmatchedMods.length > 0 ? (
                <ul style={{ marginTop: 8 }}>
                  {r.unmatchedMods.map((mod, idx) => (
                    <li key={idx}>{mod}</li>
                  ))}
                </ul>
              ) : (
                <p style={{ marginTop: 8 }}>No unmatched mods.</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}