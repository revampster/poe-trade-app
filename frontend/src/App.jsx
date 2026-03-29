import { useState } from "react";
import axios from "axios";

export default function App() {
  const [input, setInput] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Read backend URL from environment variable
  // Vite requires VITE_ prefix for env variables
  const API_URL = import.meta.env.VITE_REACT_APP_API || process.env.REACT_APP_API;

  const handleGenerate = async () => {
    if (!input) {
      setError("Please paste your PoB XML or Pastebin link.");
      return;
    }

    setLoading(true);
    setError("");
    setResults([]);

    try {
      const res = await axios.post(`${API_URL}/generate`, { input });
      if (res.data && res.data.length > 0) {
        setResults(res.data);
      } else {
        setError("No items found or invalid PoB data.");
      }
    } catch (err) {
      console.error("API Error:", err);
      setError("Error generating trade links. Check backend is live and CORS is enabled.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: 20, fontFamily: "Arial, sans-serif" }}>
      <h1>PoE Trade Link Generator</h1>
      <textarea
        rows={15}
        cols={80}
        placeholder="Paste Path of Building XML or Pastebin link here"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        style={{ padding: 10, fontSize: 14 }}
      />
      <br /><br />
      <button onClick={handleGenerate} disabled={loading} style={{ padding: "10px 20px" }}>
        {loading ? "Generating..." : "Generate Links"}
      </button>

      {error && <p style={{ color: "red", marginTop: 20 }}>{error}</p>}

      <div style={{ marginTop: 20 }}>
        {results.map((r, i) => (
          <div key={i}>
            <strong>{r.item}</strong>:{" "}
            <a href={r.link} target="_blank" rel="noopener noreferrer">
              Open Trade
            </a>
            <br /><br />
          </div>
        ))}
      </div>
    </div>
  );
}