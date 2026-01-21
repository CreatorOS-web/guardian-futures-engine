// api/analyze.js
// Guardian Futures Engine — Top 50 Bybit linear perps + single-symbol analysis
// CommonJS export for Vercel Node functions

const BYBIT = "https://api.bybit.com";

// ------- simple in-memory cache (best-effort on serverless) -------
let _tickerCache = { ts: 0, data: null };
async function fetchJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": "guardian-engine/1.0" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function getTickersCached() {
  const now = Date.now();
  if (_tickerCache.data && now - _tickerCache.ts < 15_000) return _tickerCache.data;

  const url = `${BYBIT}/v5/market/tickers?category=linear`;
  const j = await fetchJson(url);

  if (!j || j.retCode !== 0 || !j.result || !Array.isArray(j.result.list)) {
    throw new Error("Bybit tickers malformed");
  }
  _tickerCache = { ts: now, data: j.result.list };
  return _tickerCache.data;
}

async function getTop50Universe() {
  const list = await getTickersCached();

  // Filter: USDT linear perps that are actively trading
  const filtered = list
    .filter(x => typeof x.symbol === "string" && x.symbol.endsWith("USDT"))
    .filter(x => (x.status || "").toUpperCase() === "TRADING" || (x.status || "").toUpperCase() === "TRADINGACTIVE" || (x.status || "").toUpperCase() === "TRADING_ACTIVE" || (x.status || "").toUpperCase() === "TRADING")
    .map(x => ({
      symbol: x.symbol,
      lastPrice: Number(x.lastPrice || 0),
      turnover24h: Number(x.turnover24h || 0),
      volume24h: Number(x.volume24h || 0),
    }))
    .filter(x => Number.isFinite(x.turnover24h) && x.turnover24h > 0);

  filtered.sort((a, b) => b.turnover24h - a.turnover24h);

  // Top 50 by turnover (liquidity proxy)
  return filtered.slice(0, 50);
}

async function getKlines(symbol, interval, limit = 200) {
  // Bybit v5 kline: interval "5" = 5m, "15" = 15m
  const url = `${BYBIT}/v5/market/kline?category=linear&symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(
    interval
  )}&limit=${encodeURIComponent(limit)}`;
  const j = await fetchJson(url);

  if (!j || j.retCode !== 0 || !j.result || !Array.isArray(j.result.list)) {
    throw new Error("Bybit kline malformed");
  }

  // Bybit usually returns newest-first. Normalize oldest-first candles.
  const rows = j.result.list
    .map(r => ({
      t: Number(r[0]),
      o: Number(r[1]),
      h: Number(r[2]),
      l: Number(r[3]),
      c: Number(r[4]),
      v: Number(r[5]),
    }))
    .filter(c => Number.isFinite(c.t) && Number.isFinite(c.h) && Number.isFinite(c.l) && Number.isFinite(c.c))
    .sort((a, b) => a.t - b.t);

  return rows;
}

// ------- swing detection (simple, explainable fractals) -------
function findSwings(candles, leftRight = 2) {
  const highs = [];
  const lows = [];
  for (let i = leftRight; i < candles.length - leftRight; i++) {
    const cur = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= leftRight; k++) {
      if (candles[i - k].h >= cur.h) isHigh = false;
      if (candles[i + k].h >= cur.h) isHigh = false;
      if (candles[i - k].l <= cur.l) isLow = false;
      if (candles[i + k].l <= cur.l) isLow = false;
    }
    if (isHigh) highs.push({ t: cur.t, p: cur.h });
    if (isLow) lows.push({ t: cur.t, p: cur.l });
  }
  return { highs, lows };
}

function last2(arr) {
  if (!arr || arr.length < 2) return null;
  return [arr[arr.length - 2], arr[arr.length - 1]];
}

function fmt(n) {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toFixed(1);
  if (abs >= 100) return n.toFixed(2);
  if (abs >= 1) return n.toFixed(4);
  return n.toFixed(8);
}

function roundDownToStep(x, step) {
  if (!Number.isFinite(x) || !Number.isFinite(step) || step <= 0) return x;
  return Math.floor(x / step) * step;
}

function qtyStepForSymbolPrice(price) {
  // MVP precision heuristic (good enough to avoid ugly decimals)
  if (!Number.isFinite(price) || price <= 0) return 0.001;
  if (price >= 20000) return 0.001;   // BTC-ish
  if (price >= 1000) return 0.01;     // ETH-ish / high alts
  if (price >= 100) return 0.1;
  if (price >= 1) return 1;
  return 10;
}

// ------- core logic: 15m structure + 5m trigger -------
function detectTrend15m(sw) {
  const h2 = last2(sw.highs);
  const l2 = last2(sw.lows);
  if (!h2 || !l2) return { dir: "NONE", why: ["✖ Not enough 15m swings to classify trend."] };

  const [hPrev, hLast] = h2;
  const [lPrev, lLast] = l2;

  // Uptrend: higher high + higher low
  if (hLast.p > hPrev.p && lLast.p > lPrev.p) {
    return {
      dir: "UP",
      why: [
        "✔ 15m swings detected",
        `✔ 15m HH: ${fmt(hPrev.p)} → ${fmt(hLast.p)}`,
        `✔ 15m HL: ${fmt(lPrev.p)} → ${fmt(lLast.p)}`,
      ],
    };
  }

  // Downtrend: lower high + lower low
  if (hLast.p < hPrev.p && lLast.p < lPrev.p) {
    return {
      dir: "DOWN",
      why: [
        "✔ 15m swings detected",
        `✔ 15m LH: ${fmt(hPrev.p)} → ${fmt(hLast.p)}`,
        `✔ 15m LL: ${fmt(lPrev.p)} → ${fmt(lLast.p)}`,
      ],
    };
  }

  return {
    dir: "NONE",
    why: [
      "✔ 15m swings detected",
      `✖ No clean HH/HL or LL/LH (mixed structure).`,
      `ℹ highs: ${fmt(hPrev.p)} → ${fmt(hLast.p)}, lows: ${fmt(lPrev.p)} → ${fmt(lLast.p)}`,
    ],
  };
}

function buildTrade(dir, entry, stop, equity, riskPercent, symbol, lastPrice) {
  const stopDistance = Math.abs(stop - entry);
  if (!Number.isFinite(stopDistance) || stopDistance <= 0) return null;

  const riskUSD = Math.max(0, equity * riskPercent);
  const rawQty = riskUSD / stopDistance;
  const step = qtyStepForSymbolPrice(lastPrice || entry);
  const qtyApprox = roundDownToStep(rawQty, step);

  const notionalUSD = qtyApprox * entry;
  const lev = equity > 0 ? notionalUSD / equity : 0;

  const R = stopDistance;

  // Targets (0.5R and 1.0R)
  const tp1 = dir === "LONG" ? entry + 0.5 * R : entry - 0.5 * R;
  const tp2 = dir === "LONG" ? entry + 1.0 * R : entry - 1.0 * R;

  const levels = {
    dir,
    entry: Number(entry),
    stop: Number(stop),
    tp1: Number(tp1),
    tp2: Number(tp2),
    partials: { tp1Pct: 0.3, tp2Pct: 0.3, runnerPct: 0.4 },
  };

  const orders = {
    symbol,
    entrySide: dir === "LONG" ? "BUY" : "SELL",
    entryType: "MARKET_ON_TRIGGER",
    entryPrice: Number(entry),
    qtyApprox: Number(qtyApprox),
    notionalUSD: Math.round(notionalUSD),
    stopLoss: {
      price: Number(stop),
      side: dir === "LONG" ? "SELL" : "BUY",
    },
    takeProfits: [
      { name: "TP1", price: Number(tp1), pct: 0.3 },
      { name: "TP2", price: Number(tp2), pct: 0.3 },
    ],
    notes: [
      "Set isolated margin if possible.",
      "Confirm order direction matches your position mode (One-way vs Hedge).",
      "If spread is wide or candles are spiking, skip.",
    ],
  };

  const position = {
    riskUSD: Math.round(riskUSD),
    stopDistance: Number(stopDistance),
    lossFrac: equity > 0 ? Number((riskUSD / equity).toFixed(4)) : 0,
    notionalUSD: Math.round(notionalUSD),
    qtyApprox: Number(qtyApprox),
    leverageHint: lev > 1 ? `${lev.toFixed(2)}x (approx)` : "1.00x (spot-sized)",
  };

  return { levels, orders, position };
}

// Attempt: find a valid 5m pullback after latest 15m structure point
function evaluateTrigger(dir, sw15, sw5, candles5) {
  // We use latest 15m swing as protected level & reclaim level:
  const h2 = last2(sw15.highs);
  const l2 = last2(sw15.lows);
  if (!h2 || !l2) return { ok: false, reason: "Not enough 15m swings." };

  const protectedHigh = h2[1].p;
  const protectedLow = l2[1].p;

  // Recent 5m swing highs/lows
  const last5H = sw5.highs[sw5.highs.length - 1];
  const last5L = sw5.lows[sw5.lows.length - 1];
  const lastClose = candles5.length ? candles5[candles5.length - 1].c : NaN;

  if (!last5H || !last5L || !Number.isFinite(lastClose)) {
    return { ok: false, reason: "Not enough 5m structure." };
  }

  // For DOWN: require pullback high < protectedHigh, and trigger on close < reclaim (protectedLow)
  if (dir === "DOWN") {
    if (last5H.p >= protectedHigh) {
      return { ok: false, reason: `Pullback invalid: broke protected high (${fmt(protectedHigh)}).`, why: [`✖ Pullback high ${fmt(last5H.p)} >= protected high ${fmt(protectedHigh)}`] };
    }
    if (lastClose < protectedLow) {
      return { ok: true, trigger: "reclaim close", entry: protectedLow, stop: protectedHigh };
    }
    return { ok: false, reason: `Waiting for reclaim close: 5m close (${fmt(lastClose)}) must be < reclaim (${fmt(protectedLow)}).`, why: [`⏳ Waiting: 5m close < reclaim (${fmt(protectedLow)})`] };
  }

  // For UP: require pullback low > protectedLow, and trigger on close > reclaim (protectedHigh)
  if (dir === "UP") {
    if (last5L.p <= protectedLow) {
      return { ok: false, reason: `Pullback invalid: broke protected low (${fmt(protectedLow)}).`, why: [`✖ Pullback low ${fmt(last5L.p)} <= protected low ${fmt(protectedLow)}`] };
    }
    if (lastClose > protectedHigh) {
      return { ok: true, trigger: "reclaim close", entry: protectedHigh, stop: protectedLow };
    }
    return { ok: false, reason: `Waiting for reclaim close: 5m close (${fmt(lastClose)}) must be > reclaim (${fmt(protectedHigh)}).`, why: [`⏳ Waiting: 5m close > reclaim (${fmt(protectedHigh)})`] };
  }

  return { ok: false, reason: "Trend NONE." };
}

// ------- handler -------
module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  const symbol = String((req.query && req.query.symbol) || "BTCUSDT").toUpperCase();
  const equity = Number((req.query && req.query.equity) || 200);
  const riskPercent = Number((req.query && req.query.riskPercent) || 0.015);
  const test = String((req.query && req.query.test) || "0") === "1";
  const universe = String((req.query && req.query.universe) || "0") === "1";

  try {
    // Universe mode: return top 50 symbols (dynamic)
    if (universe) {
      const top50 = await getTop50Universe();
      return res.status(200).send(
        JSON.stringify({
          ts: Date.now(),
          universe: "BYBIT_LINEAR_TOP50_BY_TURNOVER_24H",
          count: top50.length,
          symbols: top50.map(x => x.symbol),
          top: top50, // includes lastPrice/turnover24h/volume24h
        })
      );
    }

    // Build current top50 and validate symbol
    const top50 = await getTop50Universe();
    const allowed = new Set(top50.map(x => x.symbol));
    const ticker = top50.find(x => x.symbol === symbol);

    if (!allowed.has(symbol)) {
      return res.status(200).send(
        JSON.stringify({
          ts: Date.now(),
          symbol,
          state: "BLOCKED",
          reason: `Symbol not in current Top 50 Bybit linear perps. Try ?universe=1 to view list.`,
          trend: { tf: "15m", dir: "NONE" },
          risk: { equity, mode: "BASE", riskPercent },
          levels: null,
          position: null,
          orders: null,
          why: [
            "✖ Not in Top 50 universe (dynamic by turnover24h).",
            "ℹ Use /api/analyze?universe=1 to see supported symbols right now.",
          ],
        })
      );
    }

    // Test mode: forced trade for UI verification
    if (test) {
      const lastPrice = ticker?.lastPrice || 100;
      const dir = "SHORT";
      const entry = Math.round(lastPrice);
      const stop = Math.round(lastPrice * 1.006); // ~0.6%
      const built = buildTrade(dir, entry, stop, equity, riskPercent, symbol, lastPrice);

      return res.status(200).send(
        JSON.stringify({
          ts: Date.now(),
          symbol,
          trend: { tf: "15m", dir: "DOWN" },
          risk: { equity, mode: "BASE", riskPercent },
          levels: built.levels,
          position: built.position,
          orders: built.orders,
          state: "TRADE_AVAILABLE",
          reason: "TEST MODE: Forced levels for UI verification.",
          why: [
            "✔ TEST MODE enabled",
            "✔ Returning forced TRADE_AVAILABLE",
            "✔ Uses live lastPrice for realistic sizing",
            "✱ Remove test=1 for real mode",
          ],
        })
      );
    }

    // Real mode: fetch klines
    const candles15 = await getKlines(symbol, "15", 220);
    const candles5 = await getKlines(symbol, "5", 220);

    if (candles15.length < 60 || candles5.length < 60) {
      return res.status(200).send(
        JSON.stringify({
          ts: Date.now(),
          symbol,
          state: "NO_TRADE",
          reason: "Not enough candle history returned.",
          trend: { tf: "15m", dir: "NONE" },
          risk: { equity, mode: "BASE", riskPercent },
          levels: null,
          position: null,
          orders: null,
          why: ["✖ Insufficient kline history."],
        })
      );
    }

    const sw15 = findSwings(candles15, 2);
    const sw5 = findSwings(candles5, 2);

    const t15 = detectTrend15m(sw15);
    const why = ["✔ 15m data loaded", ...t15.why];

    if (t15.dir === "NONE") {
      return res.status(200).send(
        JSON.stringify({
          ts: Date.now(),
          symbol,
          trend: { tf: "15m", dir: "NONE" },
          risk: { equity, mode: "BASE", riskPercent },
          levels: null,
          position: null,
          orders: null,
          state: "NO_TRADE",
          reason: "15m trend not clean enough (NONE).",
          why,
        })
      );
    }

    // Trigger logic
    why.push("✔ 5m data loaded");
    const trig = evaluateTrigger(t15.dir, sw15, sw5, candles5);
    if (!trig.ok) {
      const extra = Array.isArray(trig.why) ? trig.why : [];
      return res.status(200).send(
        JSON.stringify({
          ts: Date.now(),
          symbol,
          trend: { tf: "15m", dir: t15.dir },
          risk: { equity, mode: "BASE", riskPercent },
          levels: null,
          position: null,
          orders: null,
          state: "NO_TRADE",
          reason: trig.reason || "Waiting for trigger.",
          why: [...why, ...extra],
        })
      );
    }

    const lastPrice = ticker?.lastPrice || candles5[candles5.length - 1].c;
    const dir = t15.dir === "UP" ? "LONG" : "SHORT";
    const entry = trig.entry;
    const stop = trig.stop;

    const built = buildTrade(dir, entry, stop, equity, riskPercent, symbol, lastPrice);
    if (!built) {
      return res.status(200).send(
        JSON.stringify({
          ts: Date.now(),
          symbol,
          trend: { tf: "15m", dir: t15.dir },
          risk: { equity, mode: "BASE", riskPercent },
          levels: null,
          position: null,
          orders: null,
          state: "NO_TRADE",
          reason: "Could not build levels (bad stop distance).",
          why: [...why, "✖ Invalid entry/stop distance."],
        })
      );
    }

    const entryStopDist = Math.abs(stop - entry);

    return res.status(200).send(
      JSON.stringify({
        ts: Date.now(),
        symbol,
        trend: { tf: "15m", dir: t15.dir },
        risk: { equity, mode: "BASE", riskPercent },
        levels: built.levels,
        position: built.position,
        orders: built.orders,
        state: "TRADE_AVAILABLE",
        reason: `Trigger satisfied: 5m reclaim close → ${dir} allowed.`,
        why: [
          ...why,
          `✔ Trigger: reclaim close`,
          `✔ Entry: ${fmt(entry)} | Stop: ${fmt(stop)} | Dist: ${fmt(entryStopDist)}`,
        ],
      })
    );
  } catch (e) {
    return res.status(200).send(
      JSON.stringify({
        ts: Date.now(),
        symbol,
        trend: { tf: "15m", dir: "NONE" },
        risk: { equity, mode: "BASE", riskPercent },
        levels: null,
        position: null,
        orders: null,
        state: "NO_TRADE",
        reason: `Data fetch failed (${String(e && e.message ? e.message : e)}).`,
        why: ["✖ Bybit request failed or rate limited.", "ℹ Try again in 10–20 seconds."],
      })
    );
  }
};
