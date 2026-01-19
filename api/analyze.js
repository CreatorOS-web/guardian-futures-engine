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

  // ---------- Helpers ----------
  async function fetchCandles(interval, limit = 200) {
    const url = new URL("https://api.bybit.com/v5/market/kline");
    url.searchParams.set("category", "linear");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", String(limit));

    const r = await fetch(url.toString());
    if (!r.ok) throw new Error(`Bybit HTTP ${r.status}`);
    const j = await r.json();
    const list = j?.result?.list;
    if (!Array.isArray(list) || list.length < 50) throw new Error("Not enough candles");

    return list
      .map((c) => ({
        ts: Number(c[0]),
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4])
      }))
      .reverse(); // oldest -> newest
  }

  function findSwings(candles, N = 2) {
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

    return { swingHighs, swingLows };
  }

  function round(n) {
    if (!Number.isFinite(n)) return n;
    // keep reasonable precision for crypto
    return Math.round(n * 100) / 100;
  }

  // ---------- Engine ----------
  try {
    // 1) Trend on 15m (structure)
    const c15 = await fetchCandles("15", 220);
    const s15 = findSwings(c15, 2);

    if (s15.swingHighs.length < 2 || s15.swingLows.length < 2) {
      return res.status(200).end(
        JSON.stringify({
          ...base,
          state: "NO_TRADE",
          reason: "15m trend unclear: not enough confirmed swing points."
        })
      );
    }

    const h1 = s15.swingHighs[s15.swingHighs.length - 2];
    const h2 = s15.swingHighs[s15.swingHighs.length - 1];
    const l1 = s15.swingLows[s15.swingLows.length - 2];
    const l2 = s15.swingLows[s15.swingLows.length - 1];

    const higherHigh = h2.price > h1.price;
    const higherLow = l2.price > l1.price;
    const lowerLow = l2.price < l1.price;
    const lowerHigh = h2.price < h1.price;

    let trendDir = "NONE";
    if (higherHigh && higherLow) trendDir = "UP";
    if (lowerLow && lowerHigh) trendDir = "DOWN";

    if (trendDir === "NONE") {
      return res.status(200).end(
        JSON.stringify({
          ...base,
          trend: { tf: "15m", dir: "NONE" },
          state: "NO_TRADE",
          reason: "15m trend unclear: structure overlapping or mixed."
        })
      );
    }

    // 2) Setup on 5m: pullback + reclaim close trigger
    const c5 = await fetchCandles("5", 300);
    const s5 = findSwings(c5, 2);

    const lastCandle = c5[c5.length - 1];

    // Need enough swings to define pullback + reclaim
    if (s5.swingHighs.length < 2 || s5.swingLows.length < 2) {
      return res.status(200).end(
        JSON.stringify({
          ...base,
          trend: { tf: "15m", dir: trendDir },
          state: "NO_TRADE",
          reason: "5m structure too thin: not enough swings to form a pullback setup."
        })
      );
    }

    if (trendDir === "UP") {
      // Pullback low = most recent swing low
      const pullbackLow = s5.swingLows[s5.swingLows.length - 1];

      // Reclaim level = most recent swing high BEFORE that pullback low
      const reclaimCandidates = s5.swingHighs.filter((x) => x.i < pullbackLow.i);
      if (reclaimCandidates.length === 0) {
        return res.status(200).end(
          JSON.stringify({
            ...base,
            trend: { tf: "15m", dir: trendDir },
            state: "NO_TRADE",
            reason: "No valid reclaim level found on 5m (need a swing high before pullback low)."
          })
        );
      }
      const reclaim = reclaimCandidates[reclaimCandidates.length - 1];

      // Protected structure: last swing low BEFORE the reclaim high
      const protectedLows = s5.swingLows.filter((x) => x.i < reclaim.i);
      const protectedLow = protectedLows.length ? protectedLows[protectedLows.length - 1] : null;

      // Pullback must not break protected low
      if (protectedLow && pullbackLow.price <= protectedLow.price) {
        return res.status(200).end(
          JSON.stringify({
            ...base,
            trend: { tf: "15m", dir: trendDir },
            state: "NO_TRADE",
            reason: `Pullback invalid: broke protected low (${round(protectedLow.price)}).`
          })
        );
      }

      // Trigger: 5m CLOSE above reclaim level
      const triggered = lastCandle.close > reclaim.price;

      if (!triggered) {
        return res.status(200).end(
          JSON.stringify({
            ...base,
            trend: { tf: "15m", dir: trendDir },
            state: "NO_TRADE",
            reason: `Waiting for reclaim close: 5m close (${round(lastCandle.close)}) must be > reclaim (${round(reclaim.price)}).`
          })
        );
      }

      const entry = lastCandle.close; // reclaim close entry (simple MVP)
      const stop = pullbackLow.price;
      const R = entry - stop;

      if (!(R > 0)) {
        return res.status(200).end(
          JSON.stringify({
            ...base,
            trend: { tf: "15m", dir: trendDir },
            state: "NO_TRADE",
            reason: "Invalid risk distance (entry <= stop)."
          })
        );
      }

      const tp1 = entry + 0.5 * R;
      const tp2 = entry + 1.0 * R;

      return res.status(200).end(
        JSON.stringify({
          ...base,
          trend: { tf: "15m", dir: trendDir },
          state: "TRADE_AVAILABLE",
          reason: `LONG available: 15m UP + 5m reclaim close above ${round(reclaim.price)}.`,
          levels: {
            dir: "LONG",
            entry: round(entry),
            stop: round(stop),
            tp1: round(tp1),
            tp2: round(tp2),
            partials: { tp1Pct: 0.30, tp2Pct: 0.30, runnerPct: 0.40 }
          }
        })
      );
    }

    // trendDir === "DOWN"
    {
      // Pullback high = most recent swing high
      const pullbackHigh = s5.swingHighs[s5.swingHighs.length - 1];

      // Reclaim level = most recent swing low BEFORE that pullback high
      const reclaimCandidates = s5.swingLows.filter((x) => x.i < pullbackHigh.i);
      if (reclaimCandidates.length === 0) {
        return res.status(200).end(
          JSON.stringify({
            ...base,
            trend: { tf: "15m", dir: trendDir },
            state: "NO_TRADE",
            reason: "No valid reclaim level found on 5m (need a swing low before pullback high)."
          })
        );
      }
      const reclaim = reclaimCandidates[reclaimCandidates.length - 1];

      // Protected structure: last swing high BEFORE the reclaim low
      const protectedHighs = s5.swingHighs.filter((x) => x.i < reclaim.i);
      const protectedHigh = protectedHighs.length ? protectedHighs[protectedHighs.length - 1] : null;

      // Pullback must not break protected high
      if (protectedHigh && pullbackHigh.price >= protectedHigh.price) {
        return res.status(200).end(
          JSON.stringify({
            ...base,
            trend: { tf: "15m", dir: trendDir },
            state: "NO_TRADE",
            reason: `Pullback invalid: broke protected high (${round(protectedHigh.price)}).`
          })
        );
      }

      // Trigger: 5m CLOSE below reclaim level
      const triggered = lastCandle.close < reclaim.price;

      if (!triggered) {
        return res.status(200).end(
          JSON.stringify({
            ...base,
            trend: { tf: "15m", dir: trendDir },
            state: "NO_TRADE",
            reason: `Waiting for reclaim close: 5m close (${round(lastCandle.close)}) must be < reclaim (${round(reclaim.price)}).`
          })
        );
      }

      const entry = lastCandle.close; // reclaim close entry (simple MVP)
      const stop = pullbackHigh.price;
      const R = stop - entry;

      if (!(R > 0)) {
        return res.status(200).end(
          JSON.stringify({
            ...base,
            trend: { tf: "15m", dir: trendDir },
            state: "NO_TRADE",
            reason: "Invalid risk distance (stop <= entry)."
          })
        );
      }

      const tp1 = entry - 0.5 * R;
      const tp2 = entry - 1.0 * R;

      return res.status(200).end(
        JSON.stringify({
          ...base,
          trend: { tf: "15m", dir: trendDir },
          state: "TRADE_AVAILABLE",
          reason: `SHORT available: 15m DOWN + 5m reclaim close below ${round(reclaim.price)}.`,
          levels: {
            dir: "SHORT",
            entry: round(entry),
            stop: round(stop),
            tp1: round(tp1),
            tp2: round(tp2),
            partials: { tp1Pct: 0.30, tp2Pct: 0.30, runnerPct: 0.40 }
          }
        })
      );
    }
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
