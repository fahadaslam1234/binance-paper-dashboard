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
  assert.match(html, /No closed trades/);
  assert.match(html, /closed_count = 0/);
  assert.match(html, /trades\.csv absent means zero closed trades so far/);
  assert.match(html, /Stale candle/);
  assert.match(html, /TONUSDT/);
  assert.match(html, /Ticker check recent/);
  assert.match(html, /Asia\/Riyadh \(UTC\+3\)/);
  assert.match(html, /rounded to zero/i);
  assert.doesNotMatch(html, /<button/i);
  assert.doesNotMatch(html, /type="submit"/i);
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

test('index keeps the public gist poll and the version marker', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /position-cards-2026-11-07/);
  assert.match(html, /gist\.githubusercontent\.com\/fahadaslam1234\/ef21abfa22d77b6c4e9dcf19faac1289\/raw\/live_data\.json/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8'), /cache:\s*'no-store'/);
  assert.doesNotMatch(html, /<button/i);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8'), /setInterval\(refresh, 10000\)/);
});
