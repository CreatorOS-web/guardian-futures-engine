module.exports = (req, res) => {
  const symbol = String((req.query && req.query.symbol) || "BTCUSDT").toUpperCase();
  const equity = Number((req.query && req.query.equity) || 200);

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  if (!["BTCUSDT", "ETHUSDT"].includes(symbol)) {
    return res.status(200).send(
      JSON.stringify({
        ts: Date.now(),
        symbol,
        state: "BLOCKED",
        reason: "Only BTCUSDT and ETHUSDT are supported.",
        trend: { tf: "15m", dir: "NONE" },
        risk: { equity, mode: "BASE", riskPercent: 0.015 },
        levels: null
      })
    );
  }

  // MVP: alive + consistent output shape (we add real logic next)
  return res.status(200).send(
    JSON.stringify({
      ts: Date.now(),
      symbol,
      state: "NO_TRADE",
      reason: "Engine online on Vercel. Trend/pullback logic not implemented yet.",
      trend: { tf: "15m", dir: "NONE" },
      risk: { equity, mode: "BASE", riskPercent: 0.015 },
      levels: null
    })
  );
};
