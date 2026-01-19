export default function handler(req, res) {
  const symbol = String(req.query?.symbol || "BTCUSDT").toUpperCase();
  const equity = Number(req.query?.equity || 200);

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  const base = {
    ts: Date.now(),
    symbol,
    trend: { tf: "15m", dir: "NONE" },
    risk: { equity, mode: "BASE", riskPercent: 0.015 },
    levels: null
  };

  if (!["BTCUSDT", "ETHUSDT"].includes(symbol)) {
    return res.status(200).end(
      JSON.stringify({
        ...base,
        state: "BLOCKED",
        reason: "Only BTCUSDT and ETHUSDT are supported."
      })
    );
  }

  return res.status(200).end(
    JSON.stringify({
      ...base,
      state: "NO_TRADE",
      reason: "Engine online on Vercel. Trend/pullback logic not implemented yet."
    })
  );
}
