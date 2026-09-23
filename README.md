# Crypto Decision Engine 04 — Cloudflare

Paper-trading engine with persistent D1 state, Binance public OHLCV, 1D regime filter and 4H execution.

## Current rules
- Symbols: BTC, ETH, SOL, XRP
- 1D regime: BULL TREND required
- 4H: Price > EMA21 > EMA50 > EMA200
- RSI 48–65
- Distance from EMA21: -1% to +3.5%
- ADX > 25
- Volume / EMA20(volume) >= 0.80
- Entry: EMA21
- SL: min(EMA21 - 1.8 ATR, EMA50)
- TP1: 1.8R
- TP2: 3R (stored for later management)
- Allocation: max 20% of the original 500 USDT per symbol
- Spot paper trading only
- If one candle touches SL and TP1, SL is treated as first (conservative)

The Worker checks only 4H candles whose close time is after the position's open time, preventing old candles from closing a newly opened position.

## Deployment
Connect this repository to Cloudflare Workers Builds. Cloudflare supports importing an existing GitHub repository and automatically deploying on push. The project already contains `wrangler.toml` with the D1 binding and asset configuration.
