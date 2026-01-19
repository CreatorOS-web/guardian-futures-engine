import express from "express";

const app = express();
const PORT = 8787;

/*
  Guardian Futures Engine — MVP Runtime

  This file does ONE job:
  - return a Trade Card
  - always obey ONE_FILE_ENGINE.md

  No trading yet.
  No automation yet.
*/

function tradeCard({ symbol, state, reason }) {
  return {
    ts: Date.now(),
    symbol,
    state,
    reason,
    trend: { tf: "15m", dir: "NONE" },
    risk: { mode: "BASE", riskPercent: 0.015 },
    levels: null
  };
}

// API endpoint
app.get("/api/analyze", (req, res) => {
  const symbol = String(req.query.symbol || "BTCUSDT").toUpperCase();

  if (!["BTCUSDT", "ETHUSDT"].includes(symbol)) {
    return res.json(
      tradeCard({
        symbol,
        state: "BLOCKED",
        reason: "Only BTCUSDT and ETHUSDT are supported."
      })
    );
  }

  // MVP behavior: engine alive, no logic yet
  return res.json(
    tradeCard({
      symbol,
      state: "NO_TRADE",
      reason: "Engine online. Trend logic not implemented yet."
    })
  );
});

// simple homepage
app.get("/", (_req, res) => {
  res.send(`
    <html>
      <body style="font-family: sans-serif; padding: 40px;">
        <h2>Guardian Futures Engine</h2>
        <p>Engine running.</p>
        <p>Try:</p>
        <code>/api/analyze?symbol=BTCUSDT</code>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log("Guardian Engine running on http://localhost:" + PORT);
});
