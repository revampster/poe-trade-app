import { useState } from "react";
import axios from "axios";

export default function App() {
  const [input, setInput] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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

    try {
      const res = await axios.post(`${API_URL}/generate`, { input });

      if (Array.isArray(res.data) && res.data.length > 0) {
        setResults(res.data);
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

  return (
    <div
      style={{
        padding: 20,
        fontFamily: "Arial, sans-serif",
        maxWidth: 1000,
        margin: "0 auto"
      }}
    >
      <h1>PoE Trade Link Generator</h1>

      <p>
        Paste a Path of Building XML export, a pobb.in link, or a Pastebin link.
      </p>

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
              marginBottom: 12,
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

            <a href={r.link} target="_blank" rel="noopener noreferrer">
              Open Trade Search
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}