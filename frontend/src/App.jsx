import { useState } from "react";
import axios from "axios";

export default function App() {
  const [input, setInput] = useState("");
  const [results, setResults] = useState([]);

  const handleGenerate = async () => {
    try {
      const res = await axios.post(`${process.env.REACT_APP_API}/generate`, { input });
      setResults(res.data);
    } catch {
      alert("Error generating trade links");
    }
  };

  return (
    <div style={{ padding: 20 }}>
      <h1>PoE Trade Link Generator</h1>
      <textarea
        rows={15}
        cols={80}
        placeholder="Paste PoB XML or Pastebin link here"
        value={input}
        onChange={e => setInput(e.target.value)}
      />
      <br /><br />
      <button onClick={handleGenerate}>Generate Links</button>
      <div style={{ marginTop: 20 }}>
        {results.map((r,i) => (
          <div key={i}>
            <strong>{r.item}</strong>:
            <a href={r.link} target="_blank"> Open Trade</a>
            <br /><br />
          </div>
        ))}
      </div>
    </div>
  );
}