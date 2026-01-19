export default async function handler(req, res) {
  const symbol = String(req.query?.symbol || "BTCUSDT").toUpperCase();
  const equity = Number(req.query?.equity || 200);

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  const base = {
    ts: Date.now(),
    symbol,
    trend: { tf: "15m", dir: "NONE" }, // UP | DOWN | NONE
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

  try {
    // --- 1) Fetch 15m candles from Bybit (public) ---
    // Bybit v5: /v5/market/kline?category=linear&symbol=BTCUSDT&interval=15&limit=200
    const url = new URL("https://api.bybit.com/v5/market/kline");
    url.searchParams.set("category", "linear");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", "15");
    url.searchParams.set("limit", "200");

    const r = await fetch(url.toString());
    if (!r.ok) {
      return res.status(200).end(
        JSON.stringify({
          ...base,
          state: "NO_TRADE",
          reason: `Data fetch failed (Bybit HTTP ${r.status}).`
        })
      );
    }

    const j = await r.json();
    const list = j?.result?.list;
    if (!Array.isArray(list) || list.length < 50) {
      return res.status(200).end(
        JSON.stringify({
          ...base,
          state: "NO_TRADE",
          reason: "Not enough candle data to evaluate structure."
        })
      );
    }

    // Convert to oldest->newest
    const candles = list
      .map((c) => ({
        ts: Number(c[0]),
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4])
      }))
      .reverse();

    // --- 2) Swing detection (N=2) ---
    // swing high at i if high[i] > highs of i-2..i-1 and > highs of i+1..i+2
    // swing low at i if low[i] < lows of i-2..i-1 and < lows of i+1..i+2
    const N = 2;
    const swingHighs = [];
    const swingLows = [];

    for (let i = N; i < candles.length - N; i++) {
      const hi = candles[i].high;
      const lo = candles[i].low;

      let isHigh = true;
      let isLow = true;

      for (let k = 1; k <= N; k++) {
        if (!(hi > candles[i - k].high && hi > candles[i + k].high)) isHigh = false;
        if (!(lo < candles[i - k].low && lo < candles[i + k].low)) isLow = false;
        if (!isHigh && !isLow) break;
      }

      if (isHigh) swingHighs.push({ i, price: hi, ts: candles[i].ts });
      if (isLow) swingLows.push({ i, price: lo, ts: candles[i].ts });
    }

    // Need at least 2 highs + 2 lows to compare structure cycles
    if (swingHighs.length < 2 || swingLows.length < 2) {
      return res.status(200).end(
        JSON.stringify({
          ...base,
          state: "NO_TRADE",
          reason: "15m trend unclear: not enough confirmed swing points."
        })
      );
    }

    // Take most recent two swing highs/lows
    const h1 = swingHighs[swingHighs.length - 2];
    const h2 = swingHighs[swingHighs.length - 1];
    const l1 = swingLows[swingLows.length - 2];
    const l2 = swingLows[swingLows.length - 1];

    const higherHigh = h2.price > h1.price;
    const higherLow = l2.price > l1.price;
    const lowerLow = l2.price < l1.price;
    const lowerHigh = h2.price < h1.price;

    let dir = "NONE";
    let reason = "15m trend unclear: structure overlapping or mixed.";

    if (higherHigh && higherLow) {
      dir = "UP";
      reason = `15m UPTREND (HH/HL): H ${h1.price.toFixed(2)} → ${h2.price.toFixed(2)}, L ${l1.price.toFixed(2)} → ${l2.price.toFixed(2)}.`;
    } else if (lowerLow && lowerHigh) {
      dir = "DOWN";
      reason = `15m DOWNTREND (LL/LH): H ${h1.price.toFixed(2)} → ${h2.price.toFixed(2)}, L ${l1.price.toFixed(2)} → ${l2.price.toFixed(2)}.`;
    }

    // --- 3) Output Trade Card (still NO_TRADE until we add pullback + trigger) ---
    return res.status(200).end(
      JSON.stringify({
        ...base,
        trend: { tf: "15m", dir },
        state: "NO_TRADE",
        reason
      })
    );
  } catch (e) {
    return res.status(200).end(
      JSON.stringify({
        ...base,
        state: "NO_TRADE",
        reason: `Engine error: ${String(e?.message || e)}`
      })
    );
  }
}
