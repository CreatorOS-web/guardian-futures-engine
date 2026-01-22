// api/analyze.js
// Guardian Futures Engine — FULL STAGE_TRIGGER_V2 (Binance Futures candles)
//
// States:
// - NO_TRADE: structure ok but waiting / or filtered out
// - SETUP_WATCH: reclaim swept intrabar (early alert), waiting for close confirmation
// - TRADE_AVAILABLE: close confirmation + candle confirmation
//
// Endpoints:
// - Universe: /api/analyze?universe=1
// - Analyze:  /api/analyze?symbol=ETCUSDT&equity=200
// - Test:     /api/analyze?symbol=BTCUSDT&equity=200&test=1

const ENGINE_VERSION = "FULL_STAGE_TRIGGER_V2";

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

const BINANCE_FAPI = "https://fapi.binance.com/fapi/v1/klines";

function sendJSON(res, obj, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ engineVersion: ENGINE_VERSION, ...obj }));
}

function round(n, d = 4) {
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

function qtyStep(symbol) {
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

  const notionalUSD = round(riskUSD / lossFrac, 2);
  const rawQty = notionalUSD / entry;

  const step = qtyStep(symbol);
  const qtyApprox = floorToStep(rawQty, step) || step;

  const leverageHint =
    notionalUSD > equity ? `${round(notionalUSD / equity, 2)}x (approx)` : "1.00x";

  return {
    riskUSD,
    stopDistance: round(stopDistance, 4),
    lossFrac: round(lossFrac, 4),
    notionalUSD,
    qtyApprox: round(qtyApprox, 6),
    leverageHint
  };
}

async function fetchKlines(symbol, interval, limit) {
  const url = `${BINANCE_FAPI}?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`Binance HTTP ${r.status}`);
  const data = await r.json();
  return data.map(k => ({
    t: +k[0],
    o: +k[1],
    h: +k[2],
    l: +k[3],
    c: +k[4]
  }));
}

function calcATR(candles, len = 14) {
  if (!candles || candles.length < len + 2) return null;
  let sum = 0;
  let count = 0;
  for (let i = candles.length - len; i < candles.length; i++) {
    if (i <= 0) continue;
    const prevClose = candles[i - 1].c;
    const hi = candles[i].h;
    const lo = candles[i].l;
    const tr = Math.max(hi - lo, Math.abs(hi - prevClose), Math.abs(lo - prevClose));
    sum += tr;
    count++;
  }
  return count ? (sum / count) : null;
}

function detectSwings(candles, look = 2) {
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
    if (isHigh) highs.push({ price: h });
    if (isLow) lows.push({ price: l });
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
  if (!H || !L) {
    return { dir: "NONE", meta: null, why: ["✖ Not enough swings yet (need 2 highs + 2 lows)."] };
  }

  const HH = H.last.price > H.prev.price;
  const HL = L.last.price > L.prev.price;
  const LH = H.last.price < H.prev.price;
  const LL = L.last.price < L.prev.price;

  if (LH && LL) {
    return {
      dir: "DOWN",
      meta: { protectedHigh: H.last.price, reclaim: L.last.price },
      why: [
        "✔ 15m swings detected",
        `✔ 15m LH: ${round(H.prev.price, 2)} → ${round(H.last.price, 2)}`,
        `✔ 15m LL: ${round(L.prev.price, 2)} → ${round(L.last.price, 2)}`
      ]
    };
  }

  if (HH && HL) {
    return {
      dir: "UP",
      meta: { protectedLow: L.last.price, reclaim: H.last.price },
      why: [
        "✔ 15m swings detected",
        `✔ 15m HH: ${round(H.prev.price, 2)} → ${round(H.last.price, 2)}`,
        `✔ 15m HL: ${round(L.prev.price, 2)} → ${round(L.last.price, 2)}`
      ]
    };
  }

  return {
    dir: "NONE",
    meta: null,
    why: ["✔ 15m swings detected", "✖ Structure not clean (no HH+HL or LH+LL)."]
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

function buildLevels(dir, entry, protectedLevel, atr15) {
  const stopBuffer = atr15 * 0.10; // 10% ATR
  let stop, R, tp1, tp2;

  if (dir === "SHORT") {
    stop = protectedLevel + stopBuffer;
    R = stop - entry;
    tp1 = entry - 0.5 * R;
    tp2 = entry - 1.0 * R;
  } else {
    stop = protectedLevel - stopBuffer;
    R = entry - stop;
    tp1 = entry + 0.5 * R;
    tp2 = entry + 1.0 * R;
  }

  return {
    dir,
    entry: round(entry, 4),
    stop: round(stop, 4),
    tp1: round(tp1, 4),
    tp2: round(tp2, 4),
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
      "Stage A = sweep intrabar (watch). Stage B = close confirm (trade allowed).",
      "Use reduce-only for TP/SL if supported.",
      "Runner is manual trail in MVP."
    ]
  };
}

module.exports = async (req, res) => {
  const q = req.query || {};
  const symbol = String(q.symbol || "BTCUSDT").toUpperCase();
  const equity = Number(q.equity || 200);
  const riskPercent = 0.015;

  const testMode = String(q.test || "0") === "1";
  const universeMode = String(q.universe || "0") === "1";

  if (universeMode) {
    return sendJSON(res, {
      ts: Date.now(),
      source: "hardcoded-top50-linear-perps",
      top: TOP50_LINEAR_PERPS.map((s, i) => ({ symbol: s, rank: i + 1 }))
    });
  }

  if (!TOP50_SET.has(symbol)) {
    return sendJSON(res, {
      ts: Date.now(),
      symbol,
      trend: { tf: "15m", dir: "NONE" },
      risk: { equity, mode: "BASE", riskPercent },
      levels: null,
      position: null,
      orders: null,
      state: "BLOCKED",
      reason: "Symbol not in Guardian Top 50 allowlist (linear perps).",
      why: ["✖ Symbol not allowed in MVP universe", "✔ Universe list: /api/analyze?universe=1"]
    });
  }

  if (testMode) {
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
      why: ["✔ TEST MODE enabled", "✔ Returning forced TRADE_AVAILABLE (levels+position+orders)", "✱ Remove test=1 for real mode"]
    });
  }

  try {
    const [c15, c5] = await Promise.all([
      fetchKlines(symbol, "15m", 240),
      fetchKlines(symbol, "5m", 240)
    ]);

    if (!c15.length || !c5.length) throw new Error("Empty candle data");

    const atr15 = calcATR(c15, 14);
    const atrPct = atr15 ? (atr15 / c15[c15.length - 1].c) : null;

    // avoid dead chop
    const MIN_ATR_PCT = 0.0009; // 0.09%
    if (!atr15 || !atrPct || atrPct < MIN_ATR_PCT) {
      return sendJSON(res, {
        ts: Date.now(),
        symbol,
        trend: { tf: "15m", dir: "NONE" },
        risk: { equity, mode: "BASE", riskPercent },
        levels: null,
        position: null,
        orders: null,
        state: "NO_TRADE",
        reason: `Chop filter: ATR too low (${round(atrPct * 100, 3)}%).`,
        why: ["✔ Data loaded (15m/5m)", `✖ ATR% < ${round(MIN_ATR_PCT * 100, 3)}%`]
      });
    }

    const t15 = trendFromSwings(detectSwings(c15, 2));
    const last5 = c5[c5.length - 1];
    const recent5 = c5.slice(-24);

    if (!t15.meta || t15.dir === "NONE") {
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
        why: ["✔ 15m data loaded", ...t15.why]
      });
    }

    const triggerBuffer = atr15 * 0.05; // smaller buffer to catch more confirms

    // DOWN branch
    if (t15.dir === "DOWN") {
      const protectedHigh = t15.meta.protectedHigh;
      const reclaim = t15.meta.reclaim;

      const pullbackHigh = maxHigh(recent5);
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
          reason: `Pullback invalid: broke protected high (${round(protectedHigh, 4)}).`,
          why: ["✔ 15m data loaded", ...t15.why, `✖ Pullback high ${round(pullbackHigh, 4)} >= protected high ${round(protectedHigh, 4)}`]
        });
      }

      const swept = last5.l < reclaim; // Stage A
      const closeConfirm = last5.c < (reclaim - triggerBuffer); // Stage B
      const candleConfirm = last5.c < last5.o;

      if (swept && (!closeConfirm || !candleConfirm)) {
        return sendJSON(res, {
          ts: Date.now(),
          symbol,
          trend: { tf: "15m", dir: "DOWN" },
          risk: { equity, mode: "BASE", riskPercent },
          levels: null,
          position: null,
          orders: null,
          state: "SETUP_WATCH",
          reason: `Reclaim swept intrabar (5m low ${round(last5.l, 4)} < ${round(reclaim, 4)}). Waiting for close confirm.`,
          why: [
            "✔ 15m data loaded",
            ...t15.why,
            "✔ 5m data loaded",
            `✔ Protected high: ${round(protectedHigh, 4)}`,
            `✔ Reclaim: ${round(reclaim, 4)}`,
            `✔ Stage A: sweep (low ${round(last5.l, 4)} < reclaim ${round(reclaim, 4)})`,
            `⏳ Stage B: close < ${round(reclaim - triggerBuffer, 4)} AND red candle`
          ]
        });
      }

      if (!closeConfirm || !candleConfirm) {
        return sendJSON(res, {
          ts: Date.now(),
          symbol,
          trend: { tf: "15m", dir: "DOWN" },
          risk: { equity, mode: "BASE", riskPercent },
          levels: null,
          position: null,
          orders: null,
          state: "NO_TRADE",
          reason: `Waiting: 5m close < ${round(reclaim - triggerBuffer, 4)} and red candle. (close ${round(last5.c, 4)})`,
          why: [
            "✔ 15m data loaded",
            ...t15.why,
            "✔ 5m data loaded",
            `✔ Protected high: ${round(protectedHigh, 4)}`,
            `✔ Reclaim: ${round(reclaim, 4)}`,
            `⏳ Need: close < ${round(reclaim - triggerBuffer, 4)} + red candle`
          ]
        });
      }

      // TRADE_AVAILABLE
      const levels = buildLevels("SHORT", reclaim, protectedHigh, atr15);
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
        reason: `Trigger confirmed: 5m close ${round(last5.c, 4)} < ${round(reclaim - triggerBuffer, 4)}.`,
        why: [
          "✔ 15m data loaded",
          ...t15.why,
          "✔ 5m data loaded",
          `✔ Stage B confirm: close < ${round(reclaim - triggerBuffer, 4)} and red candle`
        ]
      });
    }

    // UP branch
    if (t15.dir === "UP") {
      const protectedLow = t15.meta.protectedLow;
      const reclaim = t15.meta.reclaim;

      const pullbackLow = minLow(recent5);
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
          reason: `Pullback invalid: broke protected low (${round(protectedLow, 4)}).`,
          why: ["✔ 15m data loaded", ...t15.why, `✖ Pullback low ${round(pullbackLow, 4)} <= protected low ${round(protectedLow, 4)}`]
        });
      }

      const swept = last5.h > reclaim; // Stage A
      const closeConfirm = last5.c > (reclaim + triggerBuffer); // Stage B
      const candleConfirm = last5.c > last5.o;

      if (swept && (!closeConfirm || !candleConfirm)) {
        return sendJSON(res, {
          ts: Date.now(),
          symbol,
          trend: { tf: "15m", dir: "UP" },
          risk: { equity, mode: "BASE", riskPercent },
          levels: null,
          position: null,
          orders: null,
          state: "SETUP_WATCH",
          reason: `Reclaim swept intrabar (5m high ${round(last5.h, 4)} > ${round(reclaim, 4)}). Waiting for close confirm.`,
          why: [
            "✔ 15m data loaded",
            ...t15.why,
            "✔ 5m data loaded",
            `✔ Protected low: ${round(protectedLow, 4)}`,
            `✔ Reclaim: ${round(reclaim, 4)}`,
            `✔ Stage A: sweep (high ${round(last5.h, 4)} > reclaim ${round(reclaim, 4)})`,
            `⏳ Stage B: close > ${round(reclaim + triggerBuffer, 4)} AND green candle`
          ]
        });
      }

      if (!closeConfirm || !candleConfirm) {
        return sendJSON(res, {
          ts: Date.now(),
          symbol,
          trend: { tf: "15m", dir: "UP" },
          risk: { equity, mode: "BASE", riskPercent },
          levels: null,
          position: null,
          orders: null,
          state: "NO_TRADE",
          reason: `Waiting: 5m close > ${round(reclaim + triggerBuffer, 4)} and green candle. (close ${round(last5.c, 4)})`,
          why: [
            "✔ 15m data loaded",
            ...t15.why,
            "✔ 5m data loaded",
            `✔ Protected low: ${round(protectedLow, 4)}`,
            `✔ Reclaim: ${round(reclaim, 4)}`,
            `⏳ Need: close > ${round(reclaim + triggerBuffer, 4)} + green candle`
          ]
        });
      }

      // TRADE_AVAILABLE
      const levels = buildLevels("LONG", reclaim, protectedLow, atr15);
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
        reason: `Trigger confirmed: 5m close ${round(last5.c, 4)} > ${round(reclaim + triggerBuffer, 4)}.`,
        why: [
          "✔ 15m data loaded",
          ...t15.why,
          "✔ 5m data loaded",
          `✔ Stage B confirm: close > ${round(reclaim + triggerBuffer, 4)} and green candle`
        ]
      });
    }

    return sendJSON(res, {
      ts: Date.now(),
      symbol,
      trend: { tf: "15m", dir: "NONE" },
      risk: { equity, mode: "BASE", riskPercent },
      levels: null,
      position: null,
      orders: null,
      state: "NO_TRADE",
      reason: "Unexpected trend state.",
      why: ["✖ Unexpected trend state"]
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
      why: ["✖ Candle fetch failed"]
    });
  }
};
