export default async function handler(req, res) {
  const symbol = String(req.query?.symbol || "BTCUSDT").toUpperCase();
  const equity = Number(req.query?.equity || 200);
  const test = String(req.query?.test || "") === "1";

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  const base = {
    ts: Date.now(),
    symbol,
    trend: { tf: "15m", dir: "NONE" },
    risk: { equity, mode: "BASE", riskPercent: 0.015 },
    levels: null,
    position: null,
    why: []
  };

  if (!["BTCUSDT", "ETHUSDT"].includes(symbol)) {
    return res.status(200).end(
      JSON.stringify({
        ...base,
        state: "BLOCKED",
        reason: "Only BTCUSDT and ETHUSDT are supported.",
        why: ["✖ Unsupported symbol", "✔ Allowed: BTCUSDT, ETHUSDT"]
      })
    );
  }

  function round(n, d = 2) {
    if (!Number.isFinite(n)) return n;
    const p = 10 ** d;
    return Math.round(n * p) / p;
  }

  function qtyDecimalsForSymbol(sym) {
    // Futures qty rules vary per exchange, but for UI clarity:
    // BTC: 4 decimals, ETH: 3 decimals (simple + readable)
    return sym === "BTCUSDT" ? 4 : 3;
  }

  function computePosition({ equity, riskPercent, entry, stop }) {
    const riskUSD = equity * riskPercent;
    const stopDistance = Math.abs(entry - stop);
    if (!(stopDistance > 0) || !(entry > 0)) return null;

    const lossFrac = stopDistance / entry;
    const notionalUSD = riskUSD / lossFrac;
    const qtyApproxRaw = notionalUSD / entry;

    let leverageHint = "1x";
    if (notionalUSD > equity) {
      leverageHint = `${round(notionalUSD / equity, 2)}x (approx)`;
    }

    return {
      riskUSD: round(riskUSD, 2),
      stopDistance: round(stopDistance, 2),
      lossFrac: round(lossFrac, 4),
      notionalUSD: round(notionalUSD, 2),
      qtyApprox: round(qtyApproxRaw, qtyDecimalsForSymbol(symbol)),
      leverageHint
    };
  }

  // ---------- TEST MODE ----------
  if (test) {
    const entry = symbol === "BTCUSDT" ? 93000 : 3200;
    const stop = symbol === "BTCUSDT" ? 93600 : 3230;
    const R = Math.abs(stop - entry);
    const tp1 = entry - 0.5 * R;
    const tp2 = entry - 1.0 * R;

    const position = computePosition({
      equity,
      riskPercent: base.risk.riskPercent,
      entry,
      stop
    });

    return res.status(200).end(
      JSON.stringify({
        ...base,
        trend: { tf: "15m", dir: "DOWN" },
        state: "TRADE_AVAILABLE",
        reason: "TEST MODE: Forced levels for UI verification.",
        levels: {
          dir: "SHORT",
          entry: round(entry, 2),
          stop: round(stop, 2),
          tp1: round(tp1, 2),
          tp2: round(tp2, 2),
          partials: { tp1Pct: 0.30, tp2Pct: 0.30, runnerPct: 0.40 }
        },
        position,
        why: [
          "✔ TEST MODE enabled",
          "✔ Returning forced TRADE_AVAILABLE",
          "✔ Qty precision improved (BTC/ETH)",
          "✱ Remove test=1 for real mode"
        ]
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
      .reverse();
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

  // ---------- Engine ----------
  try {
    const c15 = await fetchCandles("15", 220);
    const s15 = findSwings(c15, 2);

    if (s15.swingHighs.length < 2 || s15.swingLows.length < 2) {
      return res.status(200).end(
        JSON.stringify({
          ...base,
          state: "NO_TRADE",
          reason: "15m trend unclear: not enough confirmed swing points.",
          why: ["✖ Not enough confirmed 15m swings", "✔ Need 2 swing highs + 2 swing lows"]
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
    let trendWhy = ["✔ 15m data loaded", "✔ 15m swings detected"];

    if (higherHigh && higherLow) {
      trendDir = "UP";
      trendWhy.push(`✔ 15m HH: ${round(h1.price)} → ${round(h2.price)}`);
      trendWhy.push(`✔ 15m HL: ${round(l1.price)} → ${round(l2.price)}`);
    } else if (lowerLow && lowerHigh) {
      trendDir = "DOWN";
      trendWhy.push(`✔ 15m LH: ${round(h1.price)} → ${round(h2.price)}`);
      trendWhy.push(`✔ 15m LL: ${round(l1.price)} → ${round(l2.price)}`);
    } else {
      trendWhy.push("✖ Structure mixed/overlapping (no clear HH/HL or LL/LH)");
    }

    if (trendDir === "NONE") {
      return res.status(200).end(
        JSON.stringify({
          ...base,
          trend: { tf: "15m", dir: "NONE" },
          state: "NO_TRADE",
          reason: "15m trend unclear: structure overlapping or mixed.",
          why: trendWhy
        })
      );
    }

    const c5 = await fetchCandles("5", 300);
    const s5 = findSwings(c5, 2);
    const lastCandle = c5[c5.length - 1];

    if (s5.swingHighs.length < 2 || s5.swingLows.length < 2) {
      return res.status(200).end(
        JSON.stringify({
          ...base,
          trend: { tf: "15m", dir: trendDir },
          state: "NO_TRADE",
          reason: "5m structure too thin: not enough swings to form a pullback setup.",
          why: [...trendWhy, "✖ Not enough 5m swings to define pullback + reclaim"]
        })
      );
    }

    if (trendDir === "UP") {
      // (same as before — unchanged logic)
      const pullbackLow = s5.swingLows[s5.swingLows.length - 1];
      const reclaimCandidates = s5.swingHighs.filter((x) => x.i < pullbackLow.i);
      if (reclaimCandidates.length === 0) {
        return res.status(200).end(JSON.stringify({ ...base, trend:{tf:"15m",dir:trendDir}, state:"NO_TRADE", reason:"No valid reclaim level found on 5m.", why:[...trendWhy,"✖ Need a swing high before the pullback low"] }));
      }
      const reclaim = reclaimCandidates[reclaimCandidates.length - 1];
      const protectedLows = s5.swingLows.filter((x) => x.i < reclaim.i);
      const protectedLow = protectedLows.length ? protectedLows[protectedLows.length - 1] : null;
      if (protectedLow && pullbackLow.price <= protectedLow.price) {
        return res.status(200).end(JSON.stringify({ ...base, trend:{tf:"15m",dir:trendDir}, state:"NO_TRADE", reason:`Pullback invalid: broke protected low (${round(protectedLow.price)}).`, why:[...trendWhy,`✖ Pullback low ${round(pullbackLow.price)} <= protected low ${round(protectedLow.price)}`] }));
      }
      const triggered = lastCandle.close > reclaim.price;
      if (!triggered) {
        return res.status(200).end(JSON.stringify({ ...base, trend:{tf:"15m",dir:trendDir}, state:"NO_TRADE", reason:`Waiting for reclaim close: 5m close (${round(lastCandle.close)}) must be > reclaim (${round(reclaim.price)}).`, why:[...trendWhy,"✔ 5m pullback detected", protectedLow ? `✔ Protected low held (${round(protectedLow.price)})` : "✔ No protected low check", `⏳ Waiting: 5m close > reclaim (${round(reclaim.price)})`] }));
      }
      const entry = lastCandle.close;
      const stop = pullbackLow.price;
      const R = entry - stop;
      if (!(R > 0)) {
        return res.status(200).end(JSON.stringify({ ...base, trend:{tf:"15m",dir:trendDir}, state:"NO_TRADE", reason:"Invalid risk distance (entry <= stop).", why:[...trendWhy,`✖ Entry ${round(entry)} <= stop ${round(stop)}`] }));
      }
      const tp1 = entry + 0.5 * R;
      const tp2 = entry + 1.0 * R;

      const levels = { dir:"LONG", entry:round(entry), stop:round(stop), tp1:round(tp1), tp2:round(tp2), partials:{tp1Pct:.30,tp2Pct:.30,runnerPct:.40} };
      const position = computePosition({ equity, riskPercent: base.risk.riskPercent, entry: levels.entry, stop: levels.stop });

      return res.status(200).end(JSON.stringify({ ...base, trend:{tf:"15m",dir:trendDir}, state:"TRADE_AVAILABLE", reason:`LONG available: 15m UP + 5m reclaim close above ${round(reclaim.price)}.`, levels, position, why:[...trendWhy,"✔ 5m pullback valid",`✔ Reclaim close confirmed (> ${round(reclaim.price)})`,`✔ Risk: ~$${position?.riskUSD ?? "?"} (size auto-calc)`] }));
    }

    // DOWN (same as before)
    const pullbackHigh = s5.swingHighs[s5.swingHighs.length - 1];
    const reclaimCandidates = s5.swingLows.filter((x) => x.i < pullbackHigh.i);

    if (reclaimCandidates.length === 0) {
      return res.status(200).end(
        JSON.stringify({
          ...base,
          trend: { tf: "15m", dir: trendDir },
          state: "NO_TRADE",
          reason: "No valid reclaim level found on 5m.",
          why: [...trendWhy, "✖ Need a swing low before the pullback high"]
        })
      );
    }

    const reclaim = reclaimCandidates[reclaimCandidates.length - 1];
    const protectedHighs = s5.swingHighs.filter((x) => x.i < reclaim.i);
    const protectedHigh = protectedHighs.length ? protectedHighs[protectedHighs.length - 1] : null;

    if (protectedHigh && pullbackHigh.price >= protectedHigh.price) {
      return res.status(200).end(
        JSON.stringify({
          ...base,
          trend: { tf: "15m", dir: trendDir },
          state: "NO_TRADE",
          reason: `Pullback invalid: broke protected high (${round(protectedHigh.price)}).`,
          why: [...trendWhy, `✖ Pullback high ${round(pullbackHigh.price)} >= protected high ${round(protectedHigh.price)}`]
        })
      );
    }

    const triggered = lastCandle.close < reclaim.price;

    if (!triggered) {
      return res.status(200).end(
        JSON.stringify({
          ...base,
          trend: { tf: "15m", dir: trendDir },
          state: "NO_TRADE",
          reason: `Waiting for reclaim close: 5m close (${round(lastCandle.close)}) must be < reclaim (${round(reclaim.price)}).`,
          why: [
            ...trendWhy,
            "✔ 5m pullback detected",
            protectedHigh ? `✔ Protected high held (${round(protectedHigh.price)})` : "✔ No protected high check",
            `⏳ Waiting: 5m close < reclaim (${round(reclaim.price)})`
          ]
        })
      );
    }

    const entry = lastCandle.close;
    const stop = pullbackHigh.price;
    const R = stop - entry;

    if (!(R > 0)) {
      return res.status(200).end(
        JSON.stringify({
          ...base,
          trend: { tf: "15m", dir: trendDir },
          state: "NO_TRADE",
          reason: "Invalid risk distance (stop <= entry).",
          why: [...trendWhy, `✖ Stop ${round(stop)} <= entry ${round(entry)}`]
        })
      );
    }

    const tp1 = entry - 0.5 * R;
    const tp2 = entry - 1.0 * R;

    const levels = {
      dir: "SHORT",
      entry: round(entry),
      stop: round(stop),
      tp1: round(tp1),
      tp2: round(tp2),
      partials: { tp1Pct: 0.30, tp2Pct: 0.30, runnerPct: 0.40 }
    };

    const position = computePosition({
      equity,
      riskPercent: base.risk.riskPercent,
      entry: levels.entry,
      stop: levels.stop
    });

    return res.status(200).end(
      JSON.stringify({
        ...base,
        trend: { tf: "15m", dir: trendDir },
        state: "TRADE_AVAILABLE",
        reason: `SHORT available: 15m DOWN + 5m reclaim close below ${round(reclaim.price)}.`,
        levels,
        position,
        why: [
          ...trendWhy,
          "✔ 5m pullback valid",
          `✔ Reclaim close confirmed (< ${round(reclaim.price)})`,
          `✔ Risk: ~$${position?.riskUSD ?? "?"} (size auto-calc)`
        ]
      })
    );
  } catch (e) {
    return res.status(200).end(
      JSON.stringify({
        ...base,
        state: "NO_TRADE",
        reason: `Engine error: ${String(e?.message || e)}`,
        why: ["✖ Engine exception", String(e?.message || e)]
      })
    );
  }
}
