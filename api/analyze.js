// api/analyze.js
// Guardian Futures Engine — STAGE_TRIGGER_V2 (Binance Futures candles)

const ENGINE_VERSION = "STAGE_TRIGGER_V2";

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
function round(n, d = 4) { const p = 10 ** d; return Math.round(n * p) / p; }

async function fetchKlines(symbol, interval, limit) {
  const url = `${BINANCE_FAPI}?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`Binance HTTP ${r.status}`);
  const data = await r.json();
  return data.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
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
    sum += tr; count++;
  }
  return count ? (sum / count) : null;
}

function detectSwings(candles, look = 2) {
  const highs = [], lows = [];
  for (let i = look; i < candles.length - look; i++) {
    const h = candles[i].h, l = candles[i].l;
    let isHigh = true, isLow = true;
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
  if (!H || !L) return { dir: "NONE", meta: null, why: ["✖ Not enough swings yet"] };

  const HH = H.last.price > H.prev.price;
  const HL = L.last.price > L.prev.price;
  const LH = H.last.price < H.prev.price;
  const LL = L.last.price < L.prev.price;

  if (LH && LL) return {
    dir: "DOWN",
    meta: { protectedHigh: H.last.price, reclaim: L.last.price },
    why: [
      "✔ 15m swings detected",
      `✔ 15m LH: ${round(H.prev.price,2)} → ${round(H.last.price,2)}`,
      `✔ 15m LL: ${round(L.prev.price,2)} → ${round(L.last.price,2)}`
    ]
  };

  if (HH && HL) return {
    dir: "UP",
    meta: { protectedLow: L.last.price, reclaim: H.last.price },
    why: [
      "✔ 15m swings detected",
      `✔ 15m HH: ${round(H.prev.price,2)} → ${round(H.last.price,2)}`,
      `✔ 15m HL: ${round(L.prev.price,2)} → ${round(L.last.price,2)}`
    ]
  };

  return { dir: "NONE", meta: null, why: ["✔ 15m swings detected", "✖ Structure not clean"] };
}

function maxHigh(candles){ let m=-Infinity; for(const c of candles) if(c.h>m) m=c.h; return m; }
function minLow(candles){ let m= Infinity; for(const c of candles) if(c.l<m) m=c.l; return m; }

module.exports = async (req, res) => {
  const q = req.query || {};
  const symbol = String(q.symbol || "BTCUSDT").toUpperCase();
  const equity = Number(q.equity || 200);
  const universeMode = String(q.universe || "0") === "1";

  if (universeMode) {
    return sendJSON(res, {
      ts: Date.now(),
      source: "hardcoded-top50-linear-perps",
      top: TOP50_LINEAR_PERPS.map((s,i)=>({symbol:s,rank:i+1}))
    });
  }

  if (!TOP50_SET.has(symbol)) {
    return sendJSON(res, {
      ts: Date.now(),
      symbol,
      trend: { tf: "15m", dir: "NONE" },
      risk: { equity, mode: "BASE", riskPercent: 0.015 },
      levels: null, position: null, orders: null,
      state: "BLOCKED",
      reason: "Symbol not in Guardian Top 50 allowlist (linear perps).",
      why: ["✖ Symbol not allowed in MVP universe", "✔ Universe list: /api/analyze?universe=1"]
    });
  }

  try {
    const [c15, c5] = await Promise.all([
      fetchKlines(symbol, "15m", 220),
      fetchKlines(symbol, "5m", 220)
    ]);

    const atr15 = calcATR(c15, 14);
    const atrPct = atr15 ? (atr15 / c15[c15.length-1].c) : null;

    const MIN_ATR_PCT = 0.0009; // 0.09%
    if (!atr15 || !atrPct || atrPct < MIN_ATR_PCT) {
      return sendJSON(res, {
        ts: Date.now(),
        symbol,
        trend: { tf: "15m", dir: "NONE" },
        risk: { equity, mode: "BASE", riskPercent: 0.015 },
        levels: null, position: null, orders: null,
        state: "NO_TRADE",
        reason: `Chop filter: ATR too low (${round(atrPct*100,3)}%).`,
        why: ["✔ Data loaded", `✖ ATR% < ${round(MIN_ATR_PCT*100,3)}%`]
      });
    }

    const t15 = trendFromSwings(detectSwings(c15, 2));
    const last5 = c5[c5.length - 1];
    const recent5 = c5.slice(-24);

    if (t15.dir === "DOWN" && t15.meta) {
      const protectedHigh = t15.meta.protectedHigh;
      const reclaim = t15.meta.reclaim;

      const pullbackHigh = maxHigh(recent5);
      if (pullbackHigh >= protectedHigh) {
        return sendJSON(res, {
          ts: Date.now(),
          symbol,
          trend: { tf: "15m", dir: "DOWN" },
          risk: { equity, mode: "BASE", riskPercent: 0.015 },
          levels: null, position: null, orders: null,
          state: "NO_TRADE",
          reason: `Pullback invalid: broke protected high (${round(protectedHigh,4)}).`,
          why: ["✔ 15m data loaded", ...t15.why, `✖ Pullback high ${round(pullbackHigh,4)} >= protected high ${round(protectedHigh,4)}`]
        });
      }

      // Stage A: sweep reclaim intrabar
      const swept = last5.l < reclaim;

      // Stage B: confirm close below reclaim with a small buffer
      const triggerBuffer = atr15 * 0.05;
      const closeConfirm = last5.c < (reclaim - triggerBuffer);
      const candleConfirm = last5.c < last5.o;

      if (swept && (!closeConfirm || !candleConfirm)) {
        return sendJSON(res, {
          ts: Date.now(),
          symbol,
          trend: { tf: "15m", dir: "DOWN" },
          risk: { equity, mode: "BASE", riskPercent: 0.015 },
          levels: null, position: null, orders: null,
          state: "SETUP_WATCH",
          reason: `Reclaim swept intrabar (5m low ${round(last5.l,4)} < ${round(reclaim,4)}). Waiting for close confirm.`,
          why: [
            "✔ 15m data loaded",
            ...t15.why,
            "✔ 5m data loaded",
            `✔ Protected high: ${round(protectedHigh,4)}`,
            `✔ Reclaim: ${round(reclaim,4)}`,
            `✔ Stage A: swept reclaim (low ${round(last5.l,4)} < reclaim ${round(reclaim,4)})`,
            `⏳ Stage B: close < ${round(reclaim - triggerBuffer,4)} AND red candle`
          ]
        });
      }

      if (!closeConfirm || !candleConfirm) {
        return sendJSON(res, {
          ts: Date.now(),
          symbol,
          trend: { tf: "15m", dir: "DOWN" },
          risk: { equity, mode: "BASE", riskPercent: 0.015 },
          levels: null, position: null, orders: null,
          state: "NO_TRADE",
          reason: `Waiting: 5m close < ${round(reclaim - triggerBuffer,4)} and red candle. (close ${round(last5.c,4)})`,
          why: [
            "✔ 15m data loaded",
            ...t15.why,
            "✔ 5m data loaded",
            `✔ Protected high: ${round(protectedHigh,4)}`,
            `✔ Reclaim: ${round(reclaim,4)}`,
            `⏳ Need: close < ${round(reclaim - triggerBuffer,4)} + red candle`
          ]
        });
      }

      // If confirmed, we keep it simple for now (levels/position/orders can be re-added next)
      return sendJSON(res, {
        ts: Date.now(),
        symbol,
        trend: { tf: "15m", dir: "DOWN" },
        risk: { equity, mode: "BASE", riskPercent: 0.015 },
        levels: { dir:"SHORT", entry: round(reclaim,4), stop: round(protectedHigh + atr15*0.10,4) },
        position: null,
        orders: null,
        state: "TRADE_AVAILABLE",
        reason: `Trigger confirmed: 5m close ${round(last5.c,4)} < ${round(reclaim - triggerBuffer,4)}.`,
        why: ["✔ 15m data loaded", ...t15.why, "✅ Stage B confirm: buffered close + red candle"]
      });
    }

    return sendJSON(res, {
      ts: Date.now(),
      symbol,
      trend: { tf: "15m", dir: t15.dir },
      risk: { equity, mode: "BASE", riskPercent: 0.015 },
      levels: null, position: null, orders: null,
      state: "NO_TRADE",
      reason: "No trade (UP or NONE case not shown in this shortened v2 demo).",
      why: ["✔ 15m data loaded", ...t15.why]
    });

  } catch (e) {
    return sendJSON(res, {
      ts: Date.now(),
      symbol,
      trend: { tf: "15m", dir: "NONE" },
      risk: { equity, mode: "BASE", riskPercent: 0.015 },
      levels: null, position: null, orders: null,
      state: "NO_TRADE",
      reason: `Data fetch failed (Binance): ${String(e?.message || e)}`,
      why: ["✖ Candle fetch failed"]
    });
  }
};
