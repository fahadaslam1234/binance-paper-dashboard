# Paper bot LIVE dashboard (SIMULATED / PAPER only)

Not affiliated with Binance. Read-only monitor. No order controls.

The public page is [fahadaslam1234.github.io/binance-paper-dashboard](https://fahadaslam1234.github.io/binance-paper-dashboard/). It polls the existing gist feed every 10 seconds:

`https://gist.githubusercontent.com/fahadaslam1234/ef21abfa22d77b6c4e9dcf19faac1289/raw/live_data.json`

`data.json` in this repo is an old snapshot. The page does not read it.

## What the cards calculate

Open positions in the feed are `symbol`, `entry`, `qty`, `tp`, and `sl` only.

- Buying price, stop, and take-profit are those fields.
- Current price is `pairs[].ticker_price` for the same symbol (the log ticker, not the closed candle).
- Value now is `qty × ticker`. Cost at entry is `qty × entry`.
- Side is inferred only when take-profit and stop sit on opposite sides of the entry. Both current positions are longs.
- Gross unrealized P&L for a long is `(ticker − entry) × qty`. Percent is that price change divided by the entry. No exit fee is subtracted. The feed has no fee rate and no entry or exit fee on open positions, so a fee cannot be applied without inventing one.
- Closed rows, when `trades.closed` is non-empty, show the bot's own `fees` and `pnl` unchanged. `closed_count: 0` with an empty list is an empty history. The feed note says `trades.csv` is absent.

A published price of `0` is not rendered as a price. Sub-0.01 quotes are currently rounded away before they reach this page.

Clocks are shown in Asia/Riyadh (UTC+3). The daily P&L date stays on the UTC date field. A candle more than 45 minutes older than the snapshot is marked stale on the page. That check is separate from `freshness.stale`, which is the bot log flag, and from the ticker check time.

## Feed changes that would fill the remaining gaps

The publisher (not this repo) would need to:

1. Publish `pairs[].ticker_price`, `closed_close`, and `ema200` with full decimal precision. JSON numbers can represent `0.00000499`. Rounding to 2 decimal places turns PEPE into `0`.
2. Optionally add `open_positions[].side`, a mark price, and a fee rate or entry/exit fee amounts if net-of-fee P&L should replace the gross figure.

Until then the page leaves PEPE value and unrealized P&L blank and says so.

## Tests

```bash
node --test test/dashboard.test.js
```
