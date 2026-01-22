// api/analyze.js
// Guardian Futures Engine — REAL MODE (Binance Futures candles)
// - Universe endpoint: /api/analyze?universe=1
// - Analyze: /api/analyze?symbol=BTCUSDT&equity=200
// - Test mode: /api/analyze?symbol=BTCUSDT&equity=200&test=1
//
// Logic (MVP):
// 1) Get 15m candles -> detect swings -> trend = UP / DOWN / NONE (HH/HL or LL/LH)
// 2) If trend UP: wait for 5m close > reclaim (last 15m swing high)
//    If trend DOWN: wait for 5m close < reclaim (last 15m swing low)
// 3) Pullback invalidation:
//    - DOWN: if recent 5m pullback high >= protectedHigh -> NO_TRADE
//    - UP:   if recent 5m pullback low  <= protectedLow  -> NO_TRADE
// 4) When trigger confirms: output Levels + Position sizing + Orders

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

// Binance USDT-M futures klines (public)
const BINANCE_FAPI = "https://fapi.binance.com/fapi/v1/klines";

function sendJSON(res, obj, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

function round(n, d = 2) {
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

function qtyStep(symbol) {
  // MVP precision
  if (symbol === "BTCUSDT") return 0.001;
  if (symbol === "ETHUSDT") return 0.01;
  if (symbol === "SOLUSDT") return 0.1;
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

// --- Candle fetching ---
async function fetchKlines(symbol, interval, limit) {
  const url = `${BINANCE_FAPI}?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`Binance HTTP ${r.status}`);
  const data = await r.json();
  // kline: [openTime, open, high, low, close, volume, closeTime, ...]
  return data.map(k => ({
    t: Number(k[0]),
    o: Number(k[1]),
    h: Number(k[2]),
    l: Number(k[3]),
    c: Number(k[4])
  }));
}

// --- Swing detection (simple fractal) ---
function detectSwings(candles, look = 2) {
  // returns arrays of {i, t, price}
  const highs = [];
  const lows = [];
  for (let i = look; i < candles.length - look; i++) {
    const h = candles[i].h;
    const l = candles[i].l;

    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= look; j++) {
      if (candles[i - j].h >= h || candles[i + j].h >= h) isHigh = false;
      if (candles[i - j].l <= l || candles[i + j].l <= l) isLow = false;
      if (!isHigh && !isLow) break;
    }

    if (isHigh) highs.push({ i, t: candles[i].t, price: h });
    if (isLow) lows.push({ i, t: candles[i].t, price: l });
  }
  return { highs, lows };
}

function lastTwo(arr) {
  if (!arr || arr.length < 2) return null;
  return { prev: arr[arr.length - 2], last: arr[arr.length - 1] };
}

function trendFromSwings(sw) {
  const H = lastTwo(sw.highs);
  const L = lastTwo(sw.lows);
  if (!H || !L) return { dir: "NONE", why: ["✖ Not enough swing points yet (need 2 highs + 2 lows)."], meta: null };

  const HH = H.last.price > H.prev.price;
  const HL = L.last.price > L.prev.price;
  const LH = H.last.price < H.prev.price;
  const LL = L.last.price < L.prev.price;

  if (HH && HL) {
    return {
      dir: "UP",
      why: [
        "✔ 15m swings detected",
        `✔ 15m HH: ${round(H.prev.price, 2)} → ${round(H.last.price, 2)}`,
        `✔ 15m HL: ${round(L.prev.price, 2)} → ${round(L.last.price, 2)}`
      ],
      meta: { highPrev: H.prev.price, highLast: H.last.price, lowPrev: L.prev.price, lowLast: L.last.price }
    };
  }
  if (LH && LL) {
    return {
      dir: "DOWN",
      why: [
        "✔ 15m swings detected",
        `✔ 15m LH: ${round(H.prev.price, 2)} → ${round(H.last.price, 2)}`,
        `✔ 15m LL: ${round(L.prev.price, 2)} → ${round(L.last.price, 2)}`
      ],
      meta: { highPrev: H.prev.price, highLast: H.last.price, lowPrev: L.prev.price, lowLast: L.last.price }
    };
  }

  return {
    dir: "NONE",
    why: [
      "✔ 15m swings detected",
      "✖ Structure not clean (no HH+HL or LH+LL)."
    ],
    meta: { highPrev: H.prev.price, highLast: H.last.price, lowPrev: L.prev.price, lowLast: L.last.price }
  };
}

function maxHigh(candles) {
  let m = -Infinity;
  for (const c of candles) if (c.h > m) m = c.h;
  return m;
}
function minLow(candles) {
  let m = Infinity;
  for (const c of candles) if (c.l < m) m = c.l;
  return m;
}

function buildLevels(dir, reclaim, protectedLevel) {
  // entry uses reclaim as the trigger level (reclaim close confirmation)
  const entry = reclaim;

  let stop, R, tp1, tp2;
  if (dir === "SHORT") {
    stop = protectedLevel;
    R = stop - entry;
    tp1 = entry - 0.5 * R;
    tp2 = entry - 1.0 * R;
  } else {
    stop = protectedLevel;
    R = entry - stop;
    tp1 = entry + 0.5 * R;
    tp2 = entry + 1.0 * R;
  }

  return {
    dir,
    entry: round(entry, 2),
    stop: round(stop, 2),
    tp1: round(tp1, 2),
    tp2: round(tp2, 2),
    partials: { tp1Pct: 0.3, tp2Pct: 0.3, runnerPct: 0.4 }
  };
}

function buildOrders(symbol, levels, position) {
  if (!levels || !position) return null;

  const isShort = levels.dir === "SHORT";
  const entrySide = isShort ? "SELL" : "BUY";
  const exitSide = isShort ? "BUY" : "SELL";

  return {
    symbol,
    entrySide,
    entryType: "MARKET_ON_TRIGGER",
    entryPrice: levels.entry,
    qtyApprox: position.qtyApprox,
    notionalUSD: position.notionalUSD,
    stopLoss: { price: levels.stop, side: exitSide },
    takeProfits: [
      { name: "TP1", price: levels.tp1, qtyPct: 0.3, side: exitSide },
      { name: "TP2", price: levels.tp2, qtyPct: 0.3, side: exitSide }
    ],
    runner: { qtyPct: 0.4, plan: "Trail structure (next swings)" },
    notes: [
      "Trigger is a CLOSE beyond reclaim (confirm candle close).",
      "Use reduce-only for TP/SL if supported.",
      "Runner is manual trail in MVP."
    ]
  };
}

module.exports = async (req, res) => {
  const q = req.query || {};
  const symbol = String(q.symbol || "BTCUSDT").toUpperCase();
  const equity = Number(q.equity || 200);
  const testMode = String(q.test || "0") === "1";
  const universeMode = String(q.universe || "0") === "1";

  // Universe endpoint (always works)
  if (universeMode) {
    return sendJSON(res, {
      ts: Date.now(),
      source: "hardcoded-top50-linear-perps",
      top: TOP50_LINEAR_PERPS.map((s, i) => ({ symbol: s, rank: i + 1 }))
    });
  }

  // Allowlist
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
        "✔ Universe list: /api/analyze?universe=1"
      ]
    });
  }

  // TEST MODE (forced levels)
  if (testMode) {
    const riskPercent = 0.015;
    const forced = {
      dir: "SHORT",
      entry: 93000,
      stop: 93600,
      tp1: 92700,
      tp2: 92400,
      partials: { tp1Pct: 0.3, tp2Pct: 0.3, runnerPct: 0.4 }
    };
    const position = calcPosition(symbol, equity, riskPercent, forced.entry, forced.stop);
    const orders = buildOrders(symbol, forced, position);

    return sendJSON(res, {
      ts: Date.now(),
      symbol,
      trend: { tf: "15m", dir: "DOWN" },
      risk: { equity, mode: "BASE", riskPercent },
      levels: forced,
      position,
      orders,
      state: "TRADE_AVAILABLE",
      reason: "TEST MODE: Forced levels for UI verification.",
      why: [
        "✔ TEST MODE enabled",
        "✔ Returning forced TRADE_AVAILABLE (levels + position + orders)",
        "✱ Remove test=1 for real mode"
      ]
    });
  }

  const riskPercent = 0.015;

  // REAL MODE (Binance candles)
  try {
    const [c15, c5] = await Promise.all([
      fetchKlines(symbol, "15m", 220),
      fetchKlines(symbol, "5m", 220)
    ]);

    if (!c15.length || !c5.length) {
      return sendJSON(res, {
        ts: Date.now(),
        symbol,
        trend: { tf: "15m", dir: "NONE" },
        risk: { equity, mode: "BASE", riskPercent },
        levels: null,
        position: null,
        orders: null,
        state: "NO_TRADE",
        reason: "Candle feed returned empty data.",
        why: ["✖ Empty candle set from feed"]
      });
    }

    const sw15 = detectSwings(c15, 2);
    const t = trendFromSwings(sw15);

    const baseWhy = ["✔ 15m data loaded", ...t.why];

    if (t.dir === "NONE" || !t.meta) {
      return sendJSON(res, {
        ts: Date.now(),
        symbol,
        trend: { tf: "15m", dir: "NONE" },
        risk: { equity, mode: "BASE", riskPercent },
        levels: null,
        position: null,
        orders: null,
        state: "NO_TRADE",
        reason: "15m structure not clean enough (stand down).",
        why: baseWhy
      });
    }

    // last close on 5m
    const last5 = c5[c5.length - 1];
    const last5Close = last5.c;

    // recent 5m window (for pullback validation)
    const recent5 = c5.slice(-24); // last ~2 hours

    if (t.dir === "DOWN") {
      const protectedHigh = t.meta.highLast; // most recent 15m swing high
      const reclaim = t.meta.lowLast;        // most recent 15m swing low
      const pullbackHigh = maxHigh(recent5);

      const why = [
        ...baseWhy,
        "✔ 5m data loaded",
        `✔ Protected high (15m swing high): ${round(protectedHigh, 2)}`,
        `✔ Reclaim (15m swing low): ${round(reclaim, 2)}`,
        `✔ Recent 5m pullback high: ${round(pullbackHigh, 2)}`
      ];

      if (pullbackHigh >= protectedHigh) {
        return sendJSON(res, {
          ts: Date.now(),
          symbol,
          trend: { tf: "15m", dir: "DOWN" },
          risk: { equity, mode: "BASE", riskPercent },
          levels: null,
          position: null,
          orders: null,
          state: "NO_TRADE",
          reason: `Pullback invalid: broke protected high (${round(protectedHigh, 2)}).`,
          why: [...why, `✖ Pullback high ${round(pullbackHigh, 2)} >= protected high ${round(protectedHigh, 2)}`]
        });
      }

      if (last5Close >= reclaim) {
        return sendJSON(res, {
          ts: Date.now(),
          symbol,
          trend: { tf: "15m", dir: "DOWN" },
          risk: { equity, mode: "BASE", riskPercent },
          levels: null,
          position: null,
          orders: null,
          state: "NO_TRADE",
          reason: `Waiting for reclaim close: 5m close (${round(last5Close, 2)}) must be < reclaim (${round(reclaim, 2)}).`,
          why: [...why, `⏳ Waiting: 5m close < reclaim (${round(reclaim, 2)})`]
        });
      }

      // Trigger confirmed -> TRADE_AVAILABLE
      const levels = buildLevels("SHORT", reclaim, protectedHigh);
      const position = calcPosition(symbol, equity, riskPercent, levels.entry, levels.stop);
      const orders = buildOrders(symbol, levels, position);

      return sendJSON(res, {
        ts: Date.now(),
        symbol,
        trend: { tf: "15m", dir: "DOWN" },
        risk: { equity, mode: "BASE", riskPercent },
        levels,
        position,
        orders,
        state: "TRADE_AVAILABLE",
        reason: `Trigger confirmed: 5m close (${round(last5Close, 2)}) < reclaim (${round(reclaim, 2)}).`,
        why: [...why, "✅ Trigger: 5m close < reclaim (confirmed)"]
      });
    }

    // UP trend
    if (t.dir === "UP") {
      const protectedLow = t.meta.lowLast;  // most recent 15m swing low
      const reclaim = t.meta.highLast;      // most recent 15m swing high
      const pullbackLow = minLow(recent5);

      const why = [
        ...baseWhy,
        "✔ 5m data loaded",
        `✔ Protected low (15m swing low): ${round(protectedLow, 2)}`,
        `✔ Reclaim (15m swing high): ${round(reclaim, 2)}`,
        `✔ Recent 5m pullback low: ${round(pullbackLow, 2)}`
      ];

      if (pullbackLow <= protectedLow) {
        return sendJSON(res, {
          ts: Date.now(),
          symbol,
          trend: { tf: "15m", dir: "UP" },
          risk: { equity, mode: "BASE", riskPercent },
          levels: null,
          position: null,
          orders: null,
          state: "NO_TRADE",
          reason: `Pullback invalid: broke protected low (${round(protectedLow, 2)}).`,
          why: [...why, `✖ Pullback low ${round(pullbackLow, 2)} <= protected low ${round(protectedLow, 2)}`]
        });
      }

      if (last5Close <= reclaim) {
        return sendJSON(res, {
          ts: Date.now(),
          symbol,
          trend: { tf: "15m", dir: "UP" },
          risk: { equity, mode: "BASE", riskPercent },
          levels: null,
          position: null,
          orders: null,
          state: "NO_TRADE",
          reason: `Waiting for reclaim close: 5m close (${round(last5Close, 2)}) must be > reclaim (${round(reclaim, 2)}).`,
          why: [...why, `⏳ Waiting: 5m close > reclaim (${round(reclaim, 2)})`]
        });
      }

      const levels = buildLevels("LONG", reclaim, protectedLow);
      const position = calcPosition(symbol, equity, riskPercent, levels.entry, levels.stop);
      const orders = buildOrders(symbol, levels, position);

      return sendJSON(res, {
        ts: Date.now(),
        symbol,
        trend: { tf: "15m", dir: "UP" },
        risk: { equity, mode: "BASE", riskPercent },
        levels,
        position,
        orders,
        state: "TRADE_AVAILABLE",
        reason: `Trigger confirmed: 5m close (${round(last5Close, 2)}) > reclaim (${round(reclaim, 2)}).`,
        why: [...why, "✅ Trigger: 5m close > reclaim (confirmed)"]
      });
    }

    // fallback
    return sendJSON(res, {
      ts: Date.now(),
      symbol,
      trend: { tf: "15m", dir: "NONE" },
      risk: { equity, mode: "BASE", riskPercent },
      levels: null,
      position: null,
      orders: null,
      state: "NO_TRADE",
      reason: "No trade (unexpected trend state).",
      why: baseWhy
    });

  } catch (e) {
    return sendJSON(res, {
      ts: Date.now(),
      symbol,
      trend: { tf: "15m", dir: "NONE" },
      risk: { equity, mode: "BASE", riskPercent },
      levels: null,
      position: null,
      orders: null,
      state: "NO_TRADE",
      reason: `Data fetch failed (Binance): ${String(e?.message || e)}`,
      why: ["✖ Candle fetch failed", "✱ Try again in 30–60s or confirm symbol is valid on Binance Futures."]
    });
  }
};
