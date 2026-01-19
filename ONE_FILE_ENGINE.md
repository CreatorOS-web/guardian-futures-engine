# Guardian Futures Engine — Single Source of Truth

This document defines the complete trading system.
Nothing exists outside this file.

The engine is designed to:
- trade BTCUSDT and ETHUSDT futures
- prioritize capital preservation
- protect the trader from emotional behavior
- allow small consistent gains with occasional expansion winners

The system does NOT predict.
It reacts only to confirmed structure.

────────────────────────────────────────
CORE PHILOSOPHY
────────────────────────────────────────

The engine must obey these principles at all times:

- No trade is better than a bad trade
- Capital preservation comes before opportunity
- The engine must block the trader from self-destructive behavior
- If clarity does not exist → NO TRADE
- The system survives first, grows second

The engine is allowed to miss trades.
It is not allowed to blow up.

────────────────────────────────────────
MARKETS
────────────────────────────────────────

Allowed symbols:
- BTCUSDT
- ETHUSDT

Only one open position may exist at any time.

BTC and ETH may never be traded simultaneously.

────────────────────────────────────────
TIMEFRAMES
────────────────────────────────────────

15-minute timeframe:
- trend detection
- structural bias

5-minute timeframe:
- pullback
- entry trigger
- execution logic

No other timeframes are used.

────────────────────────────────────────
ENGINE OUTPUT (TRADE CARD)
────────────────────────────────────────

Every scan must return exactly one Trade Card.

Possible states:
- NO_TRADE
- TRADE_AVAILABLE
- BLOCKED

Each Trade Card must include:
- symbol
- state
- plain-English reason
- 15m trend direction (UP / DOWN / NONE)
- risk mode and risk percent

If TRADE_AVAILABLE, it must also include:
- entry
- stop
- TP1 (+0.5R, 30%)
- TP2 (+1R, 30%)
- runner (40%)

If any required information is missing, the engine has failed.

────────────────────────────────────────
TREND DEFINITION (15m STRUCTURE)
────────────────────────────────────────

UPTREND:
- Higher High
- Higher Low
- At least two confirmed swing cycles

DOWNTREND:
- Lower Low
- Lower High
- At least two confirmed swing cycles

If structure overlaps, compresses, or is unclear:
→ trend = NONE
→ state = NO_TRADE

No trend = no trading.

────────────────────────────────────────
SWING IDENTIFICATION
────────────────────────────────────────

A swing high is confirmed when:
- a candle’s high is higher than the previous two candles
- and higher than the next two candles

A swing low is confirmed when:
- a candle’s low is lower than the previous two candles
- and lower than the next two candles

Only confirmed swings are used.
Unconfirmed structure is ignored.

────────────────────────────────────────
SETUP TYPE
────────────────────────────────────────

Only one setup is allowed:

Trend continuation pullback.

The engine NEVER trades:
- ranges
- chop
- countertrend
- breakouts without pullback

If market is not trending cleanly → NO TRADE.

────────────────────────────────────────
PULLBACK RULES (5m)
────────────────────────────────────────

A valid pullback must:
- move against the 15m trend
- remain inside protected structure
- not break the most recent swing level
- show loss of momentum

If pullback breaks structure:
→ setup invalid
→ NO TRADE

────────────────────────────────────────
ENTRY TRIGGER (5m)
────────────────────────────────────────

Entry is allowed ONLY when:

- price breaks the last minor swing level
- candle CLOSES beyond that level
- direction matches the 15m trend

No wick entries.
No anticipation.
No “almost.”

This is the reclaim-close rule.

If no close → no trade.

────────────────────────────────────────
STOP LOSS
────────────────────────────────────────

Stop is placed at:
- below pullback low for longs
- above pullback high for shorts

The stop defines invalidation.

Stops may NEVER be widened.

────────────────────────────────────────
RISK MODEL
────────────────────────────────────────

BASE RISK:
- 1% to 1.5% per trade

EXPANSION RISK:
- 2% to 3% only if:
  - account is at new equity high
  - previous trade was a win
  - market structure is clean

RECOVERY MODE:
- activated after losses
- risk forced to BASE or lower

Max allowed risk at any time: 3%

────────────────────────────────────────
POSITION SIZING
────────────────────────────────────────

Position size is calculated automatically using:

(account equity × risk %) ÷ stop distance

The trader never chooses position size manually.

────────────────────────────────────────
PROFIT MANAGEMENT
────────────────────────────────────────

TP1:
- +0.5R
- close 30%

TP2:
- +1.0R
- close 30%

Runner:
- 40%
- trails structure using new swing levels

No full take-profits.
Winners are allowed to expand.

────────────────────────────────────────
GUARDIAN PROTECTION RULES
────────────────────────────────────────

These rules override all trade logic.

If any rule triggers:
→ state = BLOCKED
→ reason must be shown clearly

Rules:
- Only one open position at a time
- Cooldown after any losing trade: 15 minutes
- After 2 losses in one day: risk locked to BASE
- Daily max loss: 5% → trading disabled until next day
- Weekly max loss: 10% → trading disabled until next week
- Same setup cannot be immediately re-entered after stop-out
- If uncertainty exists at any step → NO_TRADE

The engine must protect the trader from emotional decisions.

────────────────────────────────────────
MODES
────────────────────────────────────────

Decision Support:
- engine shows Trade Card only
- trader executes manually

Semi-Auto:
- engine prepares trade
- trader must approve

Full Auto (future):
- engine executes entries and exits
- may be toggled on or off

Automation is optional.
Discipline is mandatory.

────────────────────────────────────────
MVP OBJECTIVE
────────────────────────────────────────

The MVP does NOT aim to maximize profit.

The MVP aims to:
- generate clear Trade Cards
- enforce discipline
- prevent overtrading
- produce small consistent gains
- allow occasional larger winners

If the engine cannot explain its decision clearly,
it must not trade.

Clarity > frequency.
Survival > speed.

END OF SYSTEM.
