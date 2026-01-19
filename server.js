import express from "express";

const app = express();
const PORT = 8787;

/*
  Guardian Futures Engine — MVP Runtime (Professional UI)

  - Local dashboard at http://localhost:8787
  - API endpoint at /api/analyze?symbol=BTCUSDT&equity=200
  - MVP returns NO_TRADE / BLOCKED with clear reasons
  - We will add real trend/pullback logic next
*/

function tradeCard({ symbol, state, reason, equity = 200 }) {
  return {
    ts: Date.now(),
    symbol,
    state, // NO_TRADE | TRADE_AVAILABLE | BLOCKED
    reason,
    trend: { tf: "15m", dir: "NONE" }, // UP | DOWN | NONE (later)
    risk: { equity, mode: "BASE", riskPercent: 0.015 },
    levels: null
  };
}

// ---------- API ----------
app.get("/api/analyze", (req, res) => {
  const symbol = String(req.query.symbol || "BTCUSDT").toUpperCase();
  const equity = Number(req.query.equity || 200);

  if (!["BTCUSDT", "ETHUSDT"].includes(symbol)) {
    return res.json(
      tradeCard({
        symbol,
        equity,
        state: "BLOCKED",
        reason: "Only BTCUSDT and ETHUSDT are supported."
      })
    );
  }

  // MVP behavior: engine online, no trading logic yet
  return res.json(
    tradeCard({
      symbol,
      equity,
      state: "NO_TRADE",
      reason: "Engine online. Trend/pullback logic not implemented yet."
    })
  );
});

// ---------- Professional Dashboard ----------
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Guardian Futures Engine</title>
  <style>
    :root{
      --bg:#0b1020;
      --panel:#101a33;
      --panel2:#0f1730;
      --border:rgba(255,255,255,.10);
      --text:#eaf0ff;
      --muted:rgba(234,240,255,.70);
      --good:#24d18a;
      --warn:#ffd166;
      --bad:#ff5c7a;
      --chip:rgba(255,255,255,.08);
      --shadow: 0 10px 30px rgba(0,0,0,.35);
      --r:18px;
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
      background: radial-gradient(1200px 700px at 20% -10%, rgba(36,209,138,.25), transparent 55%),
                  radial-gradient(1000px 600px at 90% 10%, rgba(255,92,122,.18), transparent 50%),
                  var(--bg);
      color:var(--text);
      padding:28px;
    }
    .wrap{max-width:980px;margin:0 auto}
    .top{
      display:flex; gap:14px; align-items:flex-start; justify-content:space-between;
      margin-bottom:18px;
    }
    h1{font-size:22px;margin:0 0 6px 0;letter-spacing:.2px}
    .sub{color:var(--muted);font-size:13px;line-height:1.4}
    .chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
    .chip{font-size:12px;padding:6px 10px;border-radius:999px;background:var(--chip);border:1px solid var(--border);color:var(--muted)}
    .grid{display:grid;grid-template-columns: 1.2fr .8fr;gap:14px}
    .card{
      background: linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.03));
      border:1px solid var(--border);
      border-radius:var(--r);
      box-shadow:var(--shadow);
      overflow:hidden;
    }
    .cardHeader{
      padding:14px 16px;
      display:flex;align-items:center;justify-content:space-between;gap:12px;
      background: rgba(0,0,0,.12);
      border-bottom:1px solid var(--border);
    }
    .titleRow{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    .badge{
      font-size:12px;padding:6px 10px;border-radius:999px;border:1px solid var(--border);
      background: rgba(255,255,255,.05);color:var(--muted)
    }
    .badge.good{color:rgba(36,209,138,1);border-color:rgba(36,209,138,.35);background:rgba(36,209,138,.10)}
    .badge.warn{color:rgba(255,209,102,1);border-color:rgba(255,209,102,.35);background:rgba(255,209,102,.10)}
    .badge.bad{color:rgba(255,92,122,1);border-color:rgba(255,92,122,.35);background:rgba(255,92,122,.10)}
    .cardBody{padding:16px}
    .controls{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
    select,input{
      background: var(--panel2);
      border:1px solid var(--border);
      color:var(--text);
      padding:10px 12px;
      border-radius:12px;
      outline:none;
      font-size:14px;
    }
    input{width:140px}
    button{
      padding:10px 14px;
      border-radius:12px;
      border:1px solid var(--border);
      background: rgba(255,255,255,.08);
      color:var(--text);
      cursor:pointer;
      font-weight:700;
      letter-spacing:.2px;
    }
    button:hover{background: rgba(255,255,255,.12)}
    button:active{transform: translateY(1px)}
    .kvs{display:grid;grid-template-columns: 1fr 1fr;gap:10px;margin-top:14px}
    .kv{
      padding:12px;border-radius:14px;background: rgba(0,0,0,.16);
      border:1px solid var(--border);
    }
    .kv .k{font-size:12px;color:var(--muted);margin-bottom:6px}
    .kv .v{font-size:16px;font-weight:800}
    .why{
      margin-top:14px;
      padding:12px;border-radius:14px;background: rgba(0,0,0,.16);
      border:1px solid var(--border);
    }
    .why h3{margin:0 0 8px 0;font-size:13px;color:var(--muted);font-weight:800;letter-spacing:.2px}
    ul{margin:0;padding-left:18px;color:var(--text)}
    li{margin:6px 0;color:var(--muted)}
    .mono{
      margin-top:14px;
      padding:12px;border-radius:14px;background: rgba(0,0,0,.22);
      border:1px solid var(--border);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size:12px; color: rgba(234,240,255,.85);
      overflow:auto; max-height:260px;
      white-space:pre;
    }
    .sideNote{color:var(--muted);font-size:13px;line-height:1.45}
    .sideNote strong{color:var(--text)}
    @media (max-width: 900px){ .grid{grid-template-columns:1fr} }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h1>Guardian Futures Engine</h1>
        <div class="sub">Decision-support MVP. Generates a rule-based Trade Card for <strong>BTCUSDT</strong> or <strong>ETHUSDT</strong>. No automation.</div>
        <div class="chips">
          <span class="chip">Local</span>
          <span class="chip">15m trend / 5m execution</span>
          <span class="chip">Partials 30/30/40</span>
          <span class="chip">Protect-from-yourself rules</span>
        </div>
      </div>
      <div class="badge" id="statusBadge">Idle</div>
    </div>

    <div class="grid">
      <div class="card">
        <div class="cardHeader">
          <div class="titleRow">
            <div style="font-weight:900;">Trade Card</div>
            <div class="badge" id="stateBadge">NO_TRADE</div>
            <div class="badge" id="trendBadge">15m: NONE</div>
          </div>
          <div class="controls">
            <select id="symbol">
              <option>BTCUSDT</option>
              <option>ETHUSDT</option>
            </select>
            <input id="equity" type="number" value="200" min="10" step="10" />
            <button onclick="run()">Analyze</button>
          </div>
        </div>
        <div class="cardBody">
          <div class="kvs">
            <div class="kv">
              <div class="k">Symbol</div>
              <div class="v" id="kvSymbol">—</div>
            </div>
            <div class="kv">
              <div class="k">Risk (Base)</div>
              <div class="v" id="kvRisk">1.5%</div>
            </div>
            <div class="kv">
              <div class="k">Action</div>
              <div class="v" id="kvAction">Stand down</div>
            </div>
            <div class="kv">
              <div class="k">Reason</div>
              <div class="v" id="kvReason">—</div>
            </div>
          </div>

          <div class="why">
            <h3>Why</h3>
            <ul id="whyList">
              <li>Engine online.</li>
              <li>Trend/pullback logic not implemented yet.</li>
            </ul>
          </div>

          <div class="mono" id="raw"></div>
        </div>
      </div>

      <div class="card">
        <div class="cardHeader">
          <div class="titleRow">
            <div style="font-weight:900;">How to use</div>
            <div class="badge warn">MVP</div>
          </div>
        </div>
        <div class="cardBody">
          <div class="sideNote">
            <p><strong>1)</strong> Pick BTCUSDT or ETHUSDT and click <strong>Analyze</strong>.</p>
            <p><strong>2)</strong> This MVP proves the engine pipeline. It should mostly return <strong>NO_TRADE</strong> until we add real structure logic.</p>
            <p><strong>3)</strong> Next upgrades:
              <br/>• 15m HH/HL trend detection
              <br/>• 5m pullback + reclaim close trigger
              <br/>• Levels: entry/stop/TP1/TP2/runner
              <br/>• Extension integration (TradingView + Bybit UI)
            </p>
            <p>Endpoint: <span class="chip">/api/analyze?symbol=BTCUSDT&equity=200</span></p>
          </div>
        </div>
      </div>
    </div>
  </div>

<script>
function setBadge(el, text, kind){
  el.textContent = text;
  el.classList.remove("good","warn","bad");
  if(kind) el.classList.add(kind);
}

function renderWhy(reason){
  const list = document.getElementById("whyList");
  list.innerHTML = "";
  const items = [
    "Engine online.",
    reason || "No reason provided."
  ];
  for(const t of items){
    const li = document.createElement("li");
    li.textContent = t;
    list.appendChild(li);
  }
}

async function run(){
  const symbol = document.getElementById("symbol").value;
  const equity = document.getElementById("equity").value || 200;

  setBadge(document.getElementById("statusBadge"), "Fetching…", "warn");

  const r = await fetch("/api/analyze?symbol=" + encodeURIComponent(symbol) + "&equity=" + encodeURIComponent(equity));
  const j = await r.json();

  setBadge(document.getElementById("statusBadge"), "Ready", "good");

  const state = j.state || "NO_TRADE";
  const trendDir = j.trend?.dir || "NONE";

  const stateKind = state === "TRADE_AVAILABLE" ? "good" : (state === "BLOCKED" ? "bad" : "warn");
  setBadge(document.getElementById("stateBadge"), state, stateKind);
  setBadge(document.getElementById("trendBadge"), "15m: " + trendDir, trendDir === "UP" ? "good" : (trendDir === "DOWN" ? "bad" : "warn"));

  document.getElementById("kvSymbol").textContent = j.symbol || symbol;
  document.getElementById("kvRisk").textContent = ((j.risk?.riskPercent ?? 0.015) * 100).toFixed(1) + "%";
  document.getElementById("kvReason").textContent = j.reason || "—";

  const action = state === "TRADE_AVAILABLE" ? "Trade allowed" : (state === "BLOCKED" ? "Trading blocked" : "Stand down");
  document.getElementById("kvAction").textContent = action;

  renderWhy(j.reason);
  document.getElementById("raw").textContent = JSON.stringify(j, null, 2);
}

run();
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log("Guardian Engine running on http://localhost:" + PORT);
});
