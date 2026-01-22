// api/analyze.js
// Guardian Futures Engine — stable universe allowlist (no external dependency)
// Fixes: "Universe failed → everything BLOCKED"

const TOP50_LINEAR_PERPS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","BNBUSDT",
  "ADAUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","TONUSDT",
  "DOTUSDT","MATICUSDT","TRXUSDT","ATOMUSDT","LTCUSDT",
  "BCHUSDT","ETCUSDT","UNIUSDT","APTUSDT","ARBUSDT",
  "OPUSDT","INJUSDT","SUIUSDT","NEARUSDT","FILUSDT",
  "IMXUSDT","TIAUSDT","SEIUSDT","RUNEUSDT","AAVEUSDT",
  "GALAUSDT","PEPEUSDT","WIFUSDT","BONKUSDT","JUPUSDT",
  "WLDUSDT","RNDRUSDT","FTMUSDT","XLMUSDT","EOSUSDT",
  "KASUSDT","ICPUSDT","CRVUSDT","MKRUSDT","LDOUSDT",
  "STXUSDT","THETAUSDT","FETUSDT","ENSUSDT","FLOWUSDT"
];

const TOP50_SET = new Set(TOP50_LINEAR_PERPS);

function sendJSON(res, obj) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

function round(n, d = 2) {
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

function qtyStep(symbol) {
  // MVP: simple precision rules
  if (symbol === "BTCUSDT") return 0.001;
  if (symbol === "ETHUSDT") return 0.01;
  // many alts allow 1 unit or 0.1; we keep conservative whole units for MVP
  return 1;
}

function floorToStep(x, step) {
  if (!Number.isFinite(x) || x <= 0) return 0;
  return Math.floor(x / step) * step;
}

function calcPosition(symbol, equity, riskPercent, entry, stop) {
  const riskUSD = round(equity * riskPercent, 2);
  const stopDistance = Math.abs(entry - stop);
  if (!Number.isFinite(stopDistance) || stopDistance <= 0) return null;

  const lossFrac = stopDistance / entry;
  if (!Number.isFinite(lossFrac) || lossFrac <= 0) return null;

  // riskUSD ≈ notional * lossFrac
  const notionalUSD = round(riskUSD / lossFrac, 2);
  const rawQty = notionalUSD / entry;

  const step = qtyStep(symbol);
  const qtyApprox = floorToStep(rawQty, step) || step;

  const leverageHint = notionalUSD > equity
    ? `${round(notionalUSD / equity, 2)}x (approx)`
    : "1.00x";

  return {
    riskUSD,
    stopDistance: round(stopDistance, 2),
    lossFrac: round(lossFrac, 4),
    notionalUSD,
    qtyApprox: round(qtyApprox, 6),
    leverageHint
  };
}

module.exports = (req, res) => {
  const q = req.query || {};
  const symbol = String(q.symbol || "BTCUSDT").toUpperCase();
  const equity = Number(q.equity || 200);
  const testMode = String(q.test || "0") === "1";
  const universeMode = String(q.universe || "0") === "1";

  // ✅ Universe endpoint: always works (no Bybit fetch required)
  if (universeMode) {
    return sendJSON(res, {
      ts: Date.now(),
      source: "hardcoded-top50-linear-perps",
      top: TOP50_LINEAR_PERPS.map((s, i) => ({ symbol: s, rank: i + 1 }))
    });
  }

  // ✅ Allowlist check
  if (!TOP50_SET.has(symbol)) {
    return sendJSON(res, {
      ts: Date.now(),
      symbol,
      state: "BLOCKED",
      reason: "Symbol not in Guardian Top 50 allowlist (linear perps).",
      trend: { tf: "15m", dir: "NONE" },
      risk: { equity, mode: "BASE", riskPercent: 0.015 },
      levels: null,
      position: null,
      orders: null,
      why: [
        "✖ Symbol not allowed in MVP universe",
        "✔ Universe list: /api/analyze?universe=1",
        "✱ Expand universe later after core logic is stable"
      ]
    });
  }

  // ✅ TEST MODE: forced trade card for UI verification
  if (testMode) {
    const riskPercent = 0.015;

    const levels = {
      dir: "SHORT",
      entry: 93000,
      stop: 93600,
      tp1: 92700,
      tp2: 92400,
      partials: { tp1Pct: 0.3, tp2Pct: 0.3, runnerPct: 0.4 }
    };

    const position = calcPosition(symbol, equity, riskPercent, levels.entry, levels.stop);

    const orders = {
      symbol,
      entrySide: "SELL",
      entryType: "MARKET_ON_TRIGGER",
      entryPrice: levels.entry,
      qtyApprox: position?.qtyApprox ?? null,
      notionalUSD: position?.notionalUSD ?? null,
      stopLoss: { price: levels.stop, side: "BUY" },
      takeProfits: [
        { name: "TP1", price: levels.tp1, qtyPct: 0.3, side: "BUY" },
        { name: "TP2", price: levels.tp2, qtyPct: 0.3, side: "BUY" }
      ],
      runner: { qtyPct: 0.4, plan: "Trail structure (next swings)" },
      notes: [
        "Set trigger condition manually: reclaim close",
        "Use reduce-only for TP/SL if supported",
        "Runner is managed manually in MVP"
      ]
    };

    return sendJSON(res, {
      ts: Date.now(),
      symbol,
      trend: { tf: "15m", dir: "DOWN" },
      risk: { equity, mode: "BASE", riskPercent },
      levels,
      position,
      orders,
      state: "TRADE_AVAILABLE",
      reason: "TEST MODE: Forced levels for UI verification.",
      why: [
        "✔ TEST MODE enabled",
        "✔ Universe allowlist passed",
        "✔ Forced TRADE_AVAILABLE (levels + position + orders)",
        "✱ Remove test=1 for real mode"
      ]
    });
  }

  // ✅ Real mode placeholder (keeps scanner working)
  return sendJSON(res, {
    ts: Date.now(),
    symbol,
    trend: { tf: "15m", dir: "NONE" },
    risk: { equity, mode: "BASE", riskPercent: 0.015 },
    levels: null,
    position: null,
    orders: null,
    state: "NO_TRADE",
    reason: "Universe stable. Real trend/trigger/data feed will be re-enabled next.",
    why: [
      "✔ Universe allowlist passed (no external dependency)",
      "✔ Endpoint stable for scanner UI",
      "✱ Next: connect reliable price feed + structure/trigger logic"
    ]
  });
};
