const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dash = require('../dashboard.js');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/live-sample.json'), 'utf8'));
const FROZEN_NOW = new Date('2026-11-07T01:12:20Z');

function prices(html) {
  return [...html.matchAll(/class="price(?: missing)?"[^>]*>([^<]+)/g)].map((m) => m[1].trim());
}

function position(symbol) {
  const pos = fixture.account.open_positions.find((p) => p.symbol === symbol);
  const pair = fixture.pairs.find((p) => p.symbol === symbol);
  return dash.positionView(pos, pair);
}

test('tiny prices keep significant digits and never collapse to zero', () => {
  assert.equal(dash.formatExactPrice(4.99e-6), '0.00000499');
  assert.equal(dash.formatExactPrice(5.0898e-6), '0.0000050898');
  assert.equal(dash.formatExactPrice(4.9400999999999995e-6), '0.0000049401');
  assert.equal(dash.formatExactPrice(0), null);
  assert.equal(dash.formatExactPrice(0.0), null);
  assert.equal(dash.formatExactPrice(0.18), '0.18');
  assert.equal(dash.formatExactPrice(1.6), '1.6');
  assert.equal(dash.formatExactPrice(1342.25), '1,342.25');
  assert.equal(dash.formatExactPrice(75927.27), '75,927.27');
  const collapsed = (4.99e-6).toLocaleString('en-US', { maximumFractionDigits: 4 });
  assert.equal(collapsed, '0');
  assert.notEqual(dash.formatExactPrice(4.99e-6), collapsed);
});

test('quantity formatting stays readable', () => {
  assert.equal(dash.formatQty(20020040.080160324), '20,020,040.0802');
  assert.equal(dash.formatQty(0.0754685623201106), '0.07546856');
});

test('ZEC position value and gross P&L use ticker, entry, and qty', () => {
  const view = position('ZECUSDT');
  const pos = fixture.account.open_positions.find((p) => p.symbol === 'ZECUSDT');
  const pair = fixture.pairs.find((p) => p.symbol === 'ZECUSDT');
  assert.equal(view.side, 'long');
  assert.equal(view.currentOk, true);
  assert.equal(view.value, pair.ticker_price * pos.qty);
  assert.equal(view.entryNotional, pos.entry * pos.qty);
  assert.equal(view.pnl, (pair.ticker_price - pos.entry) * pos.qty);
  assert.ok(Math.abs(view.pnlPct - ((pair.ticker_price - pos.entry) / pos.entry) * 100) < 1e-9);
  assert.equal(view.display.entry, '1,323.73');
  assert.equal(view.display.sl, '1,310.4927');
  assert.equal(view.display.tp, '1,350.2046');
  assert.equal(view.display.entryNotional, '99.90 USDT');
  assert.match(view.display.value, /USDT$/);
  assert.match(view.display.pnl, /^\+/);
  assert.equal(view.display.tpVsEntry, '+2.00%');
  assert.equal(view.display.slVsEntry, '-1.00%');
});

test('PEPE keeps entry, stop, and target and refuses a zero ticker', () => {
  const view = position('PEPEUSDT');
  assert.equal(view.side, 'long');
  assert.equal(view.tickerState, 'zero');
  assert.equal(view.currentOk, false);
  assert.equal(view.value, null);
  assert.equal(view.pnl, null);
  assert.equal(view.display.ticker, null);
  assert.equal(view.display.entry, '0.00000499');
  assert.equal(view.display.tp, '0.0000050898');
  assert.equal(view.display.sl, '0.0000049401');
  assert.equal(view.display.qty, '20,020,040.0802');
  assert.equal(view.display.entryNotional, '99.90 USDT');
  assert.equal(view.display.value, null);
  assert.equal(view.display.pnl, null);
});

test('short P&L flips the price difference and still skips fees', () => {
  const view = dash.positionView(
    { symbol: 'TESTUSDT', entry: 100, qty: 2, tp: 90, sl: 110 },
    { symbol: 'TESTUSDT', ticker_price: 95 }
  );
  assert.equal(view.side, 'short');
  assert.equal(view.value, 190);
  assert.equal(view.pnl, 10);
  assert.equal(view.pnlPct, 5);
  assert.equal(dash.inferSide(100, 110, 105), 'unknown');
  const unclear = dash.positionView(
    { symbol: 'TESTUSDT', entry: 100, qty: 1, tp: 110, sl: 105 },
    { symbol: 'TESTUSDT', ticker_price: 101 }
  );
  assert.equal(unclear.side, 'unknown');
  assert.equal(unclear.pnl, null);
  assert.equal(unclear.value, 101);
});

test('Riyadh labels and stale candle versus fresh ticker check', () => {
  const candle = dash.parseFeedTime('2026-11-07 00:45 UTC');
  assert.equal(dash.formatRiyadh(candle.date, false), '07 Nov 2026, 03:45 Asia/Riyadh (UTC+3)');
  const ton = dash.parseFeedTime('2026-06-30 02:45 UTC');
  assert.equal(dash.formatRiyadh(ton.date, false), '30 Jun 2026, 05:45 Asia/Riyadh (UTC+3)');
  const generated = dash.parseFeedTime(fixture.generated_at_riyadh);
  assert.equal(dash.formatRiyadh(generated.date, true).includes('Asia/Riyadh (UTC+3)'), true);
  const tonStatus = dash.pairStatus(fixture.pairs.find((p) => p.symbol === 'TONUSDT'), generated.date);
  const btcStatus = dash.pairStatus(fixture.pairs.find((p) => p.symbol === 'BTCUSDT'), generated.date);
  const pepeStatus = dash.pairStatus(fixture.pairs.find((p) => p.symbol === 'PEPEUSDT'), generated.date);
  assert.equal(tonStatus.candle.stale, true);
  assert.equal(tonStatus.check.recent, true);
  assert.equal(btcStatus.candle.stale, false);
  assert.equal(btcStatus.check.recent, true);
  assert.equal(pepeStatus.tickerState, 'zero');
  assert.equal(pepeStatus.candle.stale, false);
  assert.match(tonStatus.candle.label, /30 Jun 2026, 05:45 Asia\/Riyadh \(UTC\+3\)/);
});

test('rendered snapshot shows positions, fees note, empty history, and no zero prices', () => {
  const html = dash.renderDashboard(fixture, { now: FROZEN_NOW });
  assert.match(html, /PAPER \/ SIMULATED/);
  assert.match(html, /0\.00000499/);
  assert.match(html, /0\.0000050898/);
  assert.match(html, /0\.0000049401/);
  assert.match(html, /20,020,040\.0802/);
  assert.match(html, /99\.90 USDT/);
  assert.match(html, /No estimated exit fee/);
  assert.match(html, /Loading public/);
  assert.doesNotMatch(html, /<path class="line"/);
  assert.match(html, /No closed trades/);
  assert.match(html, /closed_count = 0/);
  assert.match(html, /trades\.csv absent means zero closed trades so far/);
  assert.match(html, /Stale candle/);
  assert.match(html, /TONUSDT/);
  assert.match(html, /Ticker check recent/);
  assert.match(html, /Asia\/Riyadh \(UTC\+3\)/);
  assert.match(html, /rounded to zero/i);
  assert.match(html, /data-range="1H"/);
  assert.doesNotMatch(html, /type="submit"/i);
  assert.doesNotMatch(html, /buy now|sell now|place order|close position/i);
  const shown = prices(html).filter((p) => !p.startsWith('Unavailable'));
  assert.ok(shown.length > 5);
  for (const p of shown) {
    assert.doesNotMatch(p, /^0(?:\.0+)?$/);
  }
  assert.ok(shown.includes('0.00000499'));
  assert.ok(prices(html).includes('Unavailable'));
});

test('snapshot lag and bot-log stale stay distinct', () => {
  const later = new Date(FROZEN_NOW.getTime() + 10 * 60 * 1000);
  const lagged = dash.renderDashboard(fixture, { now: later });
  assert.match(lagged, /Snapshot is old/);
  assert.doesNotMatch(lagged, /Bot log stale/);
  const stalled = JSON.parse(JSON.stringify(fixture));
  stalled.freshness.stale = true;
  stalled.freshness.age_seconds = 400;
  const html = dash.renderDashboard(stalled, { now: FROZEN_NOW });
  assert.match(html, /Bot log stale/);
  assert.match(html, /TONUSDT/);
});

test('feed net P&L is labeled from value, cost, and the 0.1% sell fee', () => {
  const pos = {
    symbol: 'PEPEUSDT',
    entry: 4.99e-6,
    qty: 20020040.080160324,
    tp: 5.0898e-6,
    sl: 4.9400999999999995e-6,
    current_price: 5e-6,
    price_source: 'binance-spot-mirror /api/v3/ticker/price',
    price_fetched_at_riyadh: '2026-11-07 05:30:15 Asia/Riyadh',
    current_value_usdt: 100.10020040080163,
    cost_usdt: 100,
    unrealized_pnl_usdt: 0.00010020040082281412
  };
  const pair = {
    symbol: 'PEPEUSDT',
    ticker_price: 5e-6,
    closed_close: null,
    ema200: null,
    closed_candle_utc: '2026-11-07 02:00 UTC',
    checked_at_riyadh: '2026-11-07 05:29:27 Asia/Riyadh'
  };
  const view = dash.positionView(pos, pair);
  assert.equal(view.pnlKind, 'net');
  assert.equal(view.netReconciled, true);
  assert.equal(view.value, pos.current_value_usdt);
  assert.equal(view.pnl, pos.unrealized_pnl_usdt);
  assert.equal(view.display.ticker, '0.000005');
  assert.equal(view.display.entry, '0.00000499');
  assert.ok(Math.abs(view.gross - (5e-6 - 4.99e-6) * pos.qty) < 1e-9);
  const generated = dash.parseFeedTime('2026-11-07 05:30:14 Asia/Riyadh');
  const status = dash.pairStatus(pair, generated.date);
  assert.equal(status.emaState, 'missing');
  assert.equal(status.closeState, 'missing');
  const html = dash.renderDashboard({
    disclaimer: 'PAPER / SIMULATED',
    mode: 'PAPER',
    generated_at_riyadh: '2026-11-07 05:30:14 Asia/Riyadh',
    bot: { symbols: ['PEPEUSDT'], process: { healthy: true, count: 1, processes: [] } },
    account: { balance_usdt: 800, daily_pnl_usdt: 0, daily_date_utc: '2026-11-07', kill_switch: false, open_positions: [pos], open_position_count: 1 },
    trades: { closed_count: 0, closed: [], note: null },
    freshness: { stale: false, age_seconds: 2, stale_threshold_seconds: 90, last_log_riyadh: '2026-11-07 05:30:12 Asia/Riyadh' },
    pairs: [pair]
  }, { now: new Date('2026-11-07T02:30:20Z'), selected: 'PEPEUSDT' });
  assert.match(html, /0\.1% of current value/);
  assert.match(html, /Not in feed/);
  assert.doesNotMatch(html, /<path class="line"/);
});

test('klines parse real rows and charts do not invent an entry marker', () => {
  const raw = [[1794018540000, '0.00000500', '0.00000500', '0.00000499', '0.00000499', '1', 1794018599999, '1', 1, '1', '1', '0'],
    [1794018600000, '0.00000499', '0.00000501', '0.00000498', '0.00000500', '1', 1794018659999, '1', 1, '1', '1', '0']];
  const parsed = dash.parseKlines(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.candles[1].close, 0.000005);
  assert.equal(dash.klineUrl('PEPEUSDT', '1H'), 'https://data-api.binance.vision/api/v3/klines?symbol=PEPEUSDT&interval=1m&limit=60');
  assert.equal(dash.klineUrl('bad symbol', '1H'), null);
  const view = dash.positionView({ symbol: 'PEPEUSDT', entry: 4.99e-6, qty: 1, tp: 5.0898e-6, sl: 4.9401e-6 }, { ticker_price: 5e-6 });
  const drawn = dash.renderChartSvg(parsed.candles, view, '1H', new Date(1794018700000));
  assert.match(drawn.svg, /<path class="line"/);
  assert.doesNotMatch(drawn.svg, /data-entry-marker/);
  assert.match(drawn.note, /no entry time/i);
  view.entryTimeRaw = new Date(parsed.candles[0].openTime + 1000).toISOString();
  const marked = dash.renderChartSvg(parsed.candles, view, '1H', new Date(parsed.candles[1].closeTime + 1000));
  assert.ok(dash.entryMarker(parsed.candles, view.entryTimeRaw));
  assert.match(marked.svg, /data-entry-marker/);
  const closed = dash.parseFeedTime('2026-11-07T01:32:45+00:00');
  assert.match(dash.formatRiyadh(closed.date, true), /07 Nov 2026, 04:32:45 Asia\/Riyadh \(UTC\+3\)/);
});

test('index keeps the public gist poll and the version marker', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /chart-first-2026-11-07/);
  assert.match(html, /gist\.githubusercontent\.com\/fahadaslam1234\/ef21abfa22d77b6c4e9dcf19faac1289\/raw\/live_data\.json/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8'), /cache:\s*'no-store'/);
  assert.doesNotMatch(html, /<button/i);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8'), /setInterval\(refresh, 10000\)/);
});
