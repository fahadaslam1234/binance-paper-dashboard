# Paper bot LIVE dashboard (SIMULATED / PAPER only)

Not affiliated with Binance. Read-only monitor. No order controls.

The public page is [fahadaslam1234.github.io/binance-paper-dashboard](https://fahadaslam1234.github.io/binance-paper-dashboard/). It re-reads the existing gist every 10 seconds. The publisher writes a snapshot about once a minute, so many reads repeat the same file:

`https://gist.githubusercontent.com/fahadaslam1234/ef21abfa22d77b6c4e9dcf19faac1289/raw/live_data.json`

`data.json` in this repo is an old snapshot. The page does not read it.

## Chart

The selected symbol's chart is public Binance spot history from `https://data-api.binance.vision/api/v3/klines`. The browser calls it directly. 1H is 1-minute candles, 4H is 5-minute candles, and 24H is 15-minute candles. A failed request leaves the chart empty. There is no stand-in series. A buy marker is drawn only when the open position includes a real entry time (`entry_time`, `opened_at`, `entry_at`, or `bought_at`). Horizontal lines are the paper entry, stop, and target.

## What the cards calculate

Open positions may include `current_price`, `price_source`, `price_fetched_at_riyadh`, `current_value_usdt`, `cost_usdt`, and `unrealized_pnl_usdt` in addition to `symbol`, `entry`, `qty`, `tp`, and `sl`.

- Buying price, stop, and take-profit are the position fields.
- When `current_price` is present it is the mark. Otherwise the page uses `pairs[].ticker_price`.
- Value now is `current_value_usdt` when the feed sends it, otherwise `qty × mark`.
- Invested is `cost_usdt` when present. `qty × entry` is shown beside it when both exist.
- Side is inferred only when take-profit and stop sit on opposite sides of the entry.
- When `unrealized_pnl_usdt`, `current_value_usdt`, and `cost_usdt` are all present, the card shows that net figure. On the current book it matches `current value − cost − 0.1% of current value` (estimated sell fee). Gross price P&L, `(mark − entry) × qty` for a long, is stated next to it.
- Snapshots that lack those fields stay gross, and the card says no exit fee was estimated.
- Closed rows show the bot's `fees` and `pnl`. When the numbers match `(exit − entry) × qty − fees`, the row says so.
- A null EMA or closed close is "Not in feed". A published price of `0` is not rendered as a price.

Clocks are shown in Asia/Riyadh (UTC+3). The daily P&L date stays on the UTC date field. A candle more than 45 minutes older than the snapshot is marked stale on the page. That check is separate from `freshness.stale`, which is the bot log flag, and from the ticker check time.

## Feed changes that would fill the remaining gaps

A buy marker needs `open_positions[].entry_time` (or `opened_at`, `entry_at`, `bought_at`) as a real timestamp. The current feed does not include one, so the chart draws price levels only. PEPE `ema200` and `closed_close` are null in the feed and stay blank.

## Tests

```bash
node --test test/dashboard.test.js
```
