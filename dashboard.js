/* Read-only paper dashboard view model.
   Open positions in the live feed are {symbol, entry, qty, tp, sl} only.
   Unrealized P&L is gross mark-to-market from the pair ticker. The feed has
   no fee rate and no entry/exit fee on open positions, so no exit fee is
   estimated. Pair prices published as 0 are treated as unusable, not as a
   real price of zero (sub-0.01 quotes get rounded away upstream). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PaperDash = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const UI_VERSION = 'position-cards-2026-11-07';
  const CANDLE_STALE_MS = 45 * 60 * 1000;
  const CHECK_RECENT_MS = 3 * 60 * 1000;
  const SNAPSHOT_LAG_MS = 90 * 1000;
  const FEED_URL = 'https://gist.githubusercontent.com/fahadaslam1234/ef21abfa22d77b6c4e9dcf19faac1289/raw/live_data.json';

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function num(n) {
    if (n === null || n === undefined || n === '') return null;
    const x = Number(n);
    return Number.isFinite(x) ? x : null;
  }

  function isUsablePrice(n) {
    const x = num(n);
    return x !== null && x > 0;
  }

  function expandPrecision(s) {
    const m = String(s).toLowerCase().match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/);
    if (!m) return String(s);
    const digits = m[1] + (m[2] || '');
    if (m[3] == null) return m[2] ? m[1] + '.' + m[2] : m[1];
    const exp = Number(m[3]);
    const point = m[1].length + exp;
    if (point <= 0) return '0.' + '0'.repeat(-point) + digits;
    if (point >= digits.length) return digits + '0'.repeat(point - digits.length);
    return digits.slice(0, point) + '.' + digits.slice(point);
  }

  function groupInt(intPart) {
    return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /** Exact-enough price text. Never returns "0" — a numeric zero is unusable. */
  function formatExactPrice(n) {
    const x = num(n);
    if (x === null || x === 0) return null;
    const neg = x < 0;
    let plain = expandPrecision(Math.abs(x).toPrecision(12));
    if (plain.includes('.')) plain = plain.replace(/0+$/, '').replace(/\.$/, '');
    const parts = plain.split('.');
    const body = groupInt(parts[0]) + (parts[1] ? '.' + parts[1] : '');
    return (neg ? '-' : '') + body;
  }

  function formatQty(n) {
    const x = num(n);
    if (x === null) return '—';
    const neg = x < 0;
    const abs = Math.abs(x);
    const digits = abs >= 1 ? 4 : 8;
    let plain = abs.toFixed(digits);
    if (plain.includes('.')) plain = plain.replace(/0+$/, '').replace(/\.$/, '');
    const parts = plain.split('.');
    return (neg ? '-' : '') + groupInt(parts[0]) + (parts[1] ? '.' + parts[1] : '');
  }

  function formatUsdt(n, opts) {
    const x = num(n);
    if (x === null) return '—';
    const sign = opts && opts.sign;
    const abs = Math.abs(x);
    const digits = abs === 0 || abs >= 0.01 ? 2 : (abs >= 0.0001 ? 4 : 8);
    const body = abs.toLocaleString('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
    const prefix = x < 0 ? '-' : (sign && x > 0 ? '+' : '');
    return prefix + body + ' USDT';
  }

  function formatPct(n) {
    const x = num(n);
    if (x === null) return '—';
    const body = Math.abs(x).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    const prefix = x < 0 ? '-' : (x > 0 ? '+' : '');
    return prefix + body + '%';
  }

  function formatRsi(n) {
    const x = num(n);
    if (x === null) return '—';
    return x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms)) return '—';
    const sign = ms < 0 ? '-' : '';
    const s = Math.abs(ms) / 1000;
    if (s < 90) return sign + Math.round(s) + 's';
    const m = s / 60;
    if (m < 90) return sign + Math.round(m) + ' min';
    const h = s / 3600;
    if (h < 48) return sign + Math.round(h) + ' hr';
    return sign + Math.round(s / 86400) + ' days';
  }

  function parseFeedTime(input) {
    if (input == null) return null;
    const raw = String(input).trim();
    const m = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?\s*(UTC|Asia\/Riyadh)?$/i);
    if (!m || !m[4]) return { raw, date: null, hasSeconds: false, zone: null };
    const hasSeconds = m[3] != null;
    const iso = m[1] + 'T' + m[2] + ':' + (m[3] || '00');
    const zone = m[4].toUpperCase() === 'UTC' ? 'UTC' : 'Asia/Riyadh';
    const date = new Date(iso + (zone === 'UTC' ? 'Z' : '+03:00'));
    if (Number.isNaN(date.getTime())) return { raw, date: null, hasSeconds, zone };
    return { raw, date, hasSeconds, zone };
  }

  function formatRiyadh(date, withSeconds) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    const opts = {
      timeZone: 'Asia/Riyadh',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    };
    if (withSeconds) opts.second = '2-digit';
    const body = new Intl.DateTimeFormat('en-GB', opts).format(date);
    return body + ' Asia/Riyadh (UTC+3)';
  }

  function inferSide(entry, tp, sl) {
    if (![entry, tp, sl].every((v) => Number.isFinite(v))) return 'unknown';
    if (tp > entry && sl < entry) return 'long';
    if (tp < entry && sl > entry) return 'short';
    return 'unknown';
  }

  function priceState(n) {
    if (n === null || n === undefined || n === '') return 'missing';
    const x = num(n);
    if (x === null) return 'missing';
    if (x === 0) return 'zero';
    if (x < 0) return 'missing';
    return 'ok';
  }

  function positionView(pos, pair) {
    const entry = num(pos && pos.entry);
    const qty = num(pos && pos.qty);
    const tp = num(pos && pos.tp);
    const sl = num(pos && pos.sl);
    const ticker = pair ? num(pair.ticker_price) : null;
    const tickerState = pair ? priceState(pair.ticker_price) : 'missing';
    const entryOk = isUsablePrice(entry);
    const qtyOk = qty !== null;
    const currentOk = tickerState === 'ok';
    const tpOk = isUsablePrice(tp);
    const slOk = isUsablePrice(sl);
    const side = inferSide(entry, tp, sl);
    const entryNotional = entryOk && qtyOk ? entry * qty : null;
    const value = currentOk && qtyOk ? ticker * qty : null;
    let pnl = null;
    let pnlPct = null;
    if (currentOk && entryOk && qtyOk && (side === 'long' || side === 'short')) {
      const diff = side === 'long' ? (ticker - entry) : (entry - ticker);
      pnl = diff * qty;
      pnlPct = diff / entry * 100;
    }
    const tpVsEntry = entryOk && tpOk ? (tp - entry) / entry * 100 : null;
    const slVsEntry = entryOk && slOk ? (sl - entry) / entry * 100 : null;
    return {
      symbol: pos && pos.symbol ? String(pos.symbol) : '—',
      side,
      entry, qty, tp, sl, ticker,
      entryOk, qtyOk, currentOk, tpOk, slOk,
      tickerState,
      entryNotional, value, pnl, pnlPct, tpVsEntry, slVsEntry,
      display: {
        qty: qtyOk ? formatQty(qty) : '—',
        entry: entryOk ? formatExactPrice(entry) : null,
        ticker: currentOk ? formatExactPrice(ticker) : null,
        tp: tpOk ? formatExactPrice(tp) : null,
        sl: slOk ? formatExactPrice(sl) : null,
        value: value === null ? null : formatUsdt(value),
        entryNotional: entryNotional === null ? null : formatUsdt(entryNotional),
        pnl: pnl === null ? null : formatUsdt(pnl, { sign: true }),
        pnlPct: pnlPct === null ? null : formatPct(pnlPct),
        tpVsEntry: tpVsEntry === null ? null : formatPct(tpVsEntry),
        slVsEntry: slVsEntry === null ? null : formatPct(slVsEntry)
      }
    };
  }

  function pairStatus(pair, generatedDate) {
    const candleParsed = parseFeedTime(pair && pair.closed_candle_utc);
    const checkParsed = parseFeedTime(pair && pair.checked_at_riyadh);
    let candle = {
      stale: false,
      comparable: false,
      label: (pair && pair.closed_candle_utc) || '—',
      source: (pair && pair.closed_candle_utc) || '',
      ageLabel: null,
      ageMs: null,
      note: ''
    };
    if (candleParsed && candleParsed.date && generatedDate) {
      const ageMs = generatedDate.getTime() - candleParsed.date.getTime();
      candle = {
        stale: ageMs > CANDLE_STALE_MS,
        comparable: true,
        label: formatRiyadh(candleParsed.date, candleParsed.hasSeconds),
        source: candleParsed.raw,
        ageLabel: formatDuration(ageMs),
        ageMs,
        note: ageMs < 0 ? 'Candle timestamp is after the snapshot time.' : ''
      };
    } else if (candleParsed && candleParsed.date) {
      candle.label = formatRiyadh(candleParsed.date, candleParsed.hasSeconds);
      candle.source = candleParsed.raw;
      candle.note = 'Snapshot time did not parse, so candle age is not judged.';
    }
    let check = { label: (pair && pair.checked_at_riyadh) || '—', lagLabel: null, recent: null, lagMs: null };
    if (checkParsed && checkParsed.date) {
      check.label = formatRiyadh(checkParsed.date, true);
      if (generatedDate) {
        const lagMs = generatedDate.getTime() - checkParsed.date.getTime();
        check.lagMs = lagMs;
        check.lagLabel = formatDuration(lagMs) + ' before snapshot';
        check.recent = lagMs >= -5000 && lagMs <= CHECK_RECENT_MS;
      }
    }
    return {
      symbol: pair && pair.symbol ? String(pair.symbol) : '—',
      tickerState: priceState(pair && pair.ticker_price),
      closeState: priceState(pair && pair.closed_close),
      emaState: priceState(pair && pair.ema200),
      candle,
      check,
      decision: (pair && pair.decision) || '—',
      rsi: formatRsi(pair && pair.rsi),
      rsiPrev: pair && pair.rsi_prev != null && pair.rsi_prev !== '' ? formatRsi(pair.rsi_prev) : null
    };
  }

  function rangeModel(view) {
    const pts = [];
    const add = (key, label, value, text) => {
      if (!isUsablePrice(value) || !text) return;
      pts.push({ key, label, value, text });
    };
    add('sl', 'SL', view.sl, view.display.sl);
    add('entry', 'Buy', view.entry, view.display.entry);
    if (view.currentOk) add('now', 'Now', view.ticker, view.display.ticker);
    add('tp', 'TP', view.tp, view.display.tp);
    if (pts.length < 2) return null;
    const values = pts.map((p) => p.value);
    let min = Math.min.apply(null, values);
    let max = Math.max.apply(null, values);
    const span = (max - min) || Math.abs(max) * 0.02 || 1e-12;
    min -= span * 0.08;
    max += span * 0.08;
    const pct = (v) => (v - min) / (max - min) * 100;
    const zone = (a, b, cls) => {
      if (!isUsablePrice(a) || !isUsablePrice(b)) return null;
      const p1 = pct(a);
      const p2 = pct(b);
      return { left: Math.min(p1, p2), width: Math.abs(p2 - p1), cls };
    };
    return {
      ticks: pts.map((p) => ({ ...p, pct: pct(p.value) })),
      zones: [zone(view.entry, view.sl, 'loss'), zone(view.entry, view.tp, 'gain')].filter(Boolean)
    };
  }

  function priceHtml(text) {
    if (!text) return '<span class="price missing">Unavailable</span>';
    return '<span class="price">' + esc(text) + '</span>';
  }

  function sideCopy(side) {
    if (side === 'long') return 'Long · inferred (take-profit above entry, stop below). No side field in the feed.';
    if (side === 'short') return 'Short · inferred (take-profit below entry, stop above). No side field in the feed.';
    return 'Side unknown. Stops are not on opposite sides of the entry, and the feed has no side field.';
  }

  function pnlNote(view) {
    if (view.pnl === null && !view.currentOk) {
      return 'P&L is not calculated. The ticker is unusable. Open positions also have no fee rate, so an exit fee is not estimated.';
    }
    if (view.pnl === null) {
      return 'P&L is not calculated because the position side is not clear. No fee is estimated from this feed.';
    }
    const formula = view.side === 'short'
      ? '(entry − ticker) × qty'
      : '(ticker − entry) × qty';
    return 'Gross mark-to-market ' + formula + '. Percent is that price change divided by the buying price. No estimated exit fee is subtracted: the position object has no fee fields.';
  }

  function renderRange(view) {
    const model = rangeModel(view);
    if (!model) return '';
    const zones = model.zones.map((z) =>
      '<i class="zone ' + z.cls + '" style="left:' + z.left.toFixed(4) + '%;width:' + z.width.toFixed(4) + '%"></i>'
    ).join('');
    const ticks = model.ticks.map((t) =>
      '<i class="tick ' + esc(t.key) + '" style="left:' + t.pct.toFixed(4) + '%" title="' + esc(t.label + ' ' + t.text) + '"></i>'
    ).join('');
    const rows = model.ticks.map((t) => {
      let extra = '';
      if (t.key === 'sl' && view.display.slVsEntry) extra = view.display.slVsEntry + ' vs buying price';
      else if (t.key === 'tp' && view.display.tpVsEntry) extra = view.display.tpVsEntry + ' vs buying price';
      else if (t.key === 'entry') extra = 'buying price';
      else if (t.key === 'now' && view.display.pnlPct) extra = view.display.pnlPct + ' vs buying price';
      else if (t.key === 'now') extra = 'ticker';
      return '<li><span class="tag">' + esc(t.label) + '</span>' +
        '<span class="price">' + esc(t.text) + '</span>' +
        (extra ? '<span class="hint">' + esc(extra) + '</span>' : '') +
        '</li>';
    }).join('');
    const omitted = view.currentOk ? '' :
      '<p class="hint">Current price is left off the scale. The ticker is not a usable price.</p>';
    const aria = model.ticks.map((t) => t.label + ' ' + t.text).join(', ');
    return '<div class="range" role="img" aria-label="Price scale, ' + esc(aria) + '">' +
      '<div class="scale"><div class="track">' + zones + '</div>' + ticks + '</div>' +
      '<p class="hint scale-note">Loss band runs between the buying price and the stop. Gain band runs between the buying price and the target.</p>' +
      '<ul class="range-key">' + rows + '</ul>' +
      omitted +
      '</div>';
  }

  function renderPosition(view) {
    const cls = ['pos', view.side !== 'unknown' ? view.side : 'unknown'];
    if (!view.currentOk) cls.push('unusable');
    const pnlCls = view.pnl === null ? '' : (view.pnl > 0 ? ' up' : (view.pnl < 0 ? ' down' : ''));
    const tickerBlock = view.currentOk
      ? priceHtml(view.display.ticker) + '<span class="hint">ticker from the pair log</span>'
      : priceHtml(null) + '<span class="hint">Published ticker is unusable. It was rounded to zero. That is not a price of zero, so it is not shown as one.</span>';
    const valueBlock = view.display.value
      ? priceHtml(view.display.value) + '<span class="hint">qty × ticker</span>'
      : priceHtml(null) + '<span class="hint">Needs a usable ticker. Entry cost is not a substitute.</span>';
    const pnlBlock = view.display.pnl
      ? '<span class="price big">' + esc(view.display.pnl) +
        (view.display.pnlPct ? ' <span class="pct">' + esc(view.display.pnlPct) + '</span>' : '') +
        '</span>'
      : priceHtml(null);
    return '<article class="' + cls.join(' ') + '" data-symbol="' + esc(view.symbol) + '" data-side="' + esc(view.side) + '" data-ticker-state="' + esc(view.tickerState) + '">' +
      '<header class="pos-h"><div><h3>' + esc(view.symbol) + '</h3><p class="side">' + esc(sideCopy(view.side)) + '</p></div>' +
      '<span class="pill quiet">Open paper</span></header>' +
      '<div class="qtyline"><span class="k">Quantity</span><span class="price" title="' + esc(String(view.qty)) + '">' + esc(view.display.qty) + '</span></div>' +
      '<div class="metrics">' +
      '<div><span class="k">Buying price</span>' + priceHtml(view.display.entry) + '<span class="hint">entry</span></div>' +
      '<div><span class="k">Current price</span>' + tickerBlock + '</div>' +
      '<div><span class="k">Value now</span>' + valueBlock + '</div>' +
      '<div><span class="k">Cost at entry</span>' + priceHtml(view.display.entryNotional) + '<span class="hint">qty × entry</span></div>' +
      '<div class="wide pnl' + pnlCls + '"><span class="k">Unrealized P&L</span>' + pnlBlock +
      '<span class="hint">' + esc(pnlNote(view)) + '</span></div>' +
      '<div><span class="k">Stop loss</span>' + priceHtml(view.display.sl) +
      (view.display.slVsEntry ? '<span class="hint">' + esc(view.display.slVsEntry) + ' vs buying price</span>' : '') + '</div>' +
      '<div><span class="k">Take profit</span>' + priceHtml(view.display.tp) +
      (view.display.tpVsEntry ? '<span class="hint">' + esc(view.display.tpVsEntry) + ' vs buying price</span>' : '') + '</div>' +
      '</div>' +
      renderRange(view) +
      '</article>';
  }

  function renderPair(pair, status) {
    const flags = [];
    if (status.candle.stale) flags.push('<span class="pill bad">Stale candle</span>');
    if (status.tickerState === 'zero' || status.closeState === 'zero' || status.emaState === 'zero') {
      flags.push('<span class="pill warn">Price rounded away</span>');
    }
    if (status.check.recent === true) flags.push('<span class="pill ok">Ticker check recent</span>');
    else if (status.check.recent === false) flags.push('<span class="pill warn">Ticker check lagging</span>');
    const candleHint = status.candle.comparable
      ? (status.candle.stale
        ? 'Candle timestamp is ' + status.candle.ageLabel + ' before this snapshot. Shown as published.'
        : 'Candle timestamp is ' + status.candle.ageLabel + ' before this snapshot.')
      : status.candle.note;
    const checkHint = status.check.recent === null
      ? ''
      : (status.check.recent ? 'Check is recent' : 'Check is older than 3 minutes') +
        (status.check.lagLabel ? ' · ' + status.check.lagLabel : '');
    return '<article class="pair' + (status.candle.stale ? ' stale' : '') + '" data-symbol="' + esc(status.symbol) + '">' +
      '<header class="pair-h"><h3>' + esc(status.symbol) + '</h3><div class="flags">' + flags.join('') + '</div></header>' +
      '<p class="decision">' + esc(status.decision) + '</p>' +
      '<dl class="kv">' +
      '<div><dt>Ticker</dt><dd>' + priceHtml(status.tickerState === 'ok' ? formatExactPrice(pair.ticker_price) : null) +
      (status.tickerState === 'zero' ? '<span class="hint">Rounded to zero in the feed. Not shown as a price.</span>' : '') + '</dd></div>' +
      '<div><dt>Closed 15m close</dt><dd>' + priceHtml(status.closeState === 'ok' ? formatExactPrice(pair.closed_close) : null) +
      (status.closeState === 'zero' ? '<span class="hint">Rounded to zero in the feed.</span>' : '') + '</dd></div>' +
      '<div class="wide"><dt>Candle time</dt><dd><span class="time">' + esc(status.candle.label) + '</span>' +
      (status.candle.source ? '<span class="hint">Source stamp ' + esc(status.candle.source) + '</span>' : '') +
      (candleHint ? '<span class="hint">' + esc(candleHint) + '</span>' : '') + '</dd></div>' +
      '<div class="wide"><dt>Ticker checked</dt><dd><span class="time">' + esc(status.check.label) + '</span>' +
      (checkHint ? '<span class="hint">' + esc(checkHint) + '</span>' : '') + '</dd></div>' +
      '<div><dt>EMA200</dt><dd>' + priceHtml(status.emaState === 'ok' ? formatExactPrice(pair.ema200) : null) + '</dd></div>' +
      '<div><dt>RSI</dt><dd><span class="price">' + esc(status.rsi) + '</span>' +
      (status.rsiPrev ? '<span class="hint">prev ' + esc(status.rsiPrev) + '</span>' : '') + '</dd></div>' +
      '</dl></article>';
  }

  function renderPairRow(pair, status) {
    const stale = status.candle.stale ? ' stale' : '';
    const ticker = status.tickerState === 'ok'
      ? '<span class="price">' + esc(formatExactPrice(pair.ticker_price)) + '</span>'
      : '<span class="price missing">Unavailable</span>';
    const close = status.closeState === 'ok'
      ? '<span class="price">' + esc(formatExactPrice(pair.closed_close)) + '</span>'
      : '<span class="price missing">Unavailable</span>';
    const ema = status.emaState === 'ok'
      ? '<span class="price">' + esc(formatExactPrice(pair.ema200)) + '</span>'
      : '<span class="price missing">Unavailable</span>';
    return '<tr class="' + stale.trim() + '" data-symbol="' + esc(status.symbol) + '">' +
      '<td><strong>' + esc(status.symbol) + '</strong>' +
      (status.candle.stale ? '<div class="hint">Stale candle</div>' : '') +
      (status.tickerState === 'zero' ? '<div class="hint">Ticker rounded away</div>' : '') + '</td>' +
      '<td>' + ticker + '</td><td>' + close + '</td>' +
      '<td><span class="time">' + esc(status.candle.label) + '</span>' +
      (status.candle.ageLabel ? '<div class="hint">' + esc(status.candle.ageLabel) + ' before snapshot</div>' : '') +
      '<div class="hint">' + esc(status.candle.source || '') + '</div></td>' +
      '<td>' + ema + '</td>' +
      '<td><span class="price">' + esc(status.rsi) + '</span>' +
      (status.rsiPrev ? '<div class="hint">prev ' + esc(status.rsiPrev) + '</div>' : '') + '</td>' +
      '<td>' + esc(status.decision) + '</td>' +
      '<td><span class="time">' + esc(status.check.label) + '</span>' +
      (status.check.recent === true ? '<div class="hint">Check is recent</div>' : '') +
      (status.check.recent === false ? '<div class="hint">Check is lagging</div>' : '') + '</td></tr>';
  }

  function renderTrades(trades, count) {
    const list = Array.isArray(trades && trades.closed) ? trades.closed : [];
    const reported = num(count);
    const mismatch = reported !== null && reported !== list.length;
    if (!list.length) {
      return '<div class="empty-state">' +
        '<h3>No closed trades</h3>' +
        '<p>The feed reports closed_count = ' + esc(reported === null ? '—' : String(reported)) + ' and the closed list is empty.</p>' +
        '<p class="hint">' + esc((trades && trades.note) || 'An empty history is a real zero, not a hidden list.') + '</p>' +
        (mismatch ? '<p class="hint warn-text">closed_count does not match the list length.</p>' : '') +
        '</div>';
    }
    const rows = list.map((t) => {
      const when = parseFeedTime(t.time);
      const timeText = when && when.date ? formatRiyadh(when.date, when.hasSeconds) : (t.time || '—');
      const pnl = num(t.pnl);
      const pnlCls = pnl === null ? '' : (pnl > 0 ? 'up' : (pnl < 0 ? 'down' : ''));
      return '<tr><td><span class="time">' + esc(timeText) + '</span>' +
        (when && when.raw && when.date ? '<div class="hint">' + esc(when.raw) + '</div>' : '') + '</td>' +
        '<td>' + esc(t.symbol || '—') + '</td>' +
        '<td>' + priceHtml(formatExactPrice(t.entry)) + '</td>' +
        '<td>' + priceHtml(formatExactPrice(t.exit)) + '</td>' +
        '<td><span class="price">' + esc(formatQty(t.qty)) + '</span></td>' +
        '<td><span class="price">' + esc(t.fees == null || t.fees === '' ? '—' : String(t.fees)) + '</span></td>' +
        '<td class="' + pnlCls + '"><span class="price">' + esc(t.pnl == null || t.pnl === '' ? '—' : String(t.pnl)) + '</span></td>' +
        '<td>' + esc(t.reason || '—') + '</td></tr>';
    }).join('');
    return (mismatch ? '<p class="hint warn-text">closed_count is ' + esc(String(reported)) + ' but the list has ' + list.length + ' rows.</p>' : '') +
      '<p class="hint">Order as published. Fees and P&L are the bot fields on each closed row. They are not recomputed here.</p>' +
      '<div class="table-scroll"><table><thead><tr>' +
      '<th scope="col">Time</th><th scope="col">Symbol</th><th scope="col">Entry</th><th scope="col">Exit</th>' +
      '<th scope="col">Qty</th><th scope="col">Fees</th><th scope="col">P&L</th><th scope="col">Reason</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function renderDashboard(data, options) {
    const opts = options || {};
    const now = opts.now instanceof Date ? opts.now : new Date();
    if (!data || typeof data !== 'object') return renderError(opts.fetchError);
    const account = data.account || {};
    const freshness = data.freshness || {};
    const bot = data.bot || {};
    const positions = Array.isArray(account.open_positions) ? account.open_positions : [];
    const pairs = Array.isArray(data.pairs) ? data.pairs : [];
    const generated = parseFeedTime(data.generated_at_riyadh);
    const generatedDate = generated && generated.date;
    const generatedLabel = generatedDate ? formatRiyadh(generatedDate, true) : (data.generated_at_riyadh || '—');
    const snapAgeMs = generatedDate ? now.getTime() - generatedDate.getTime() : null;
    const pairBySymbol = {};
    pairs.forEach((p) => { if (p && p.symbol) pairBySymbol[p.symbol] = p; });
    const views = positions.map((p) => positionView(p, pairBySymbol[p.symbol]));
    const statuses = pairs.map((p) => ({ pair: p, status: pairStatus(p, generatedDate) }));
    const staleCandles = statuses.filter((x) => x.status.candle.stale);
    const zeroPairs = statuses.filter((x) =>
      x.status.tickerState === 'zero' || x.status.closeState === 'zero' || x.status.emaState === 'zero');

    const notices = [];
    if (opts.fetchError) {
      notices.push('<div class="notice bad" role="status">Latest refresh failed (' + esc(opts.fetchError.message || opts.fetchError) + '). Showing the last snapshot that loaded.</div>');
    }
    if (freshness.stale) {
      const last = parseFeedTime(freshness.last_log_riyadh);
      const lastLabel = last && last.date ? formatRiyadh(last.date, true) : (freshness.last_log_riyadh || 'unknown');
      notices.push('<div class="notice bad" role="status"><strong>Bot log stale.</strong> Last log ' + esc(lastLabel) +
        '. Feed age_seconds is ' + esc(freshness.age_seconds ?? '?') + 's, above the ' +
        esc(freshness.stale_threshold_seconds ?? '?') + 's threshold. Figures below are still shown.</div>');
    }
    if (snapAgeMs !== null && snapAgeMs > SNAPSHOT_LAG_MS) {
      notices.push('<div class="notice warn" role="status"><strong>Snapshot is old.</strong> This file was generated ' +
        esc(formatDuration(snapAgeMs)) + ' before this device clock. The bot age_seconds (' +
        esc(freshness.age_seconds ?? '?') + 's) was measured when the file was written, not now. Gist caching can cause this.</div>');
    }
    const candleNotice = staleCandles.length
      ? '<div class="notice warn" role="status"><strong>Stale candle.</strong> ' +
        esc(staleCandles.map((x) => x.status.symbol + ' (' + (x.status.candle.ageLabel || 'old') + ')').join(', ')) +
        '. Candle time and ticker check time are both shown. This 45-minute display check is not the bot log flag.</div>'
      : '';
    if (account.kill_switch) {
      notices.push('<div class="notice bad" role="status"><strong>Kill switch is on</strong> in the paper state. This page still cannot place or cancel anything.</div>');
    }

    const bal = formatUsdt(account.balance_usdt);
    const daily = formatUsdt(account.daily_pnl_usdt, { sign: true });
    const dailyCls = num(account.daily_pnl_usdt) > 0 ? 'up' : (num(account.daily_pnl_usdt) < 0 ? 'down' : '');
    const entrySum = views.reduce((sum, v) => v.entryNotional === null ? sum : sum + v.entryNotional, 0);
    const entryKnown = views.filter((v) => v.entryNotional !== null).length;
    const unrealSum = views.every((v) => v.pnl !== null) && views.length
      ? views.reduce((sum, v) => sum + v.pnl, 0)
      : null;

    const proc = bot.process || {};
    const procList = (proc.processes || []).map((p) => 'pid ' + (p.pid ?? '—') + ' · ' + (p.cmdline || '')).join(' · ') || 'No process row in the feed.';
    let healthPill = '<span class="pill bad">Bot not found</span>';
    if (proc.healthy) healthPill = '<span class="pill ok">Bot process healthy</span>';
    else if (proc.running) healthPill = '<span class="pill warn">Process running</span>';
    const lastLog = parseFeedTime(freshness.last_log_riyadh);
    const stateM = parseFeedTime(freshness.state_mtime_riyadh);
    const logLabel = lastLog && lastLog.date ? formatRiyadh(lastLog.date, true) : (freshness.last_log_riyadh || '—');
    const stateLabel = stateM && stateM.date ? formatRiyadh(stateM.date, true) : (freshness.state_mtime_riyadh || '—');

    const zeroBox = zeroPairs.length ? (
      '<aside class="limit"><strong>Feed limit on tiny prices.</strong> ' +
      esc(zeroPairs.map((x) => {
        const bits = [];
        if (x.status.tickerState === 'zero') bits.push('ticker');
        if (x.status.closeState === 'zero') bits.push('closed close');
        if (x.status.emaState === 'zero') bits.push('EMA200');
        return x.status.symbol + ' ' + bits.join(', ') + ' published as 0';
      }).join('; ')) +
      '. JSON can carry 0.00000499. These fields were rounded before publish, so this page leaves them blank instead of printing a price of 0. Position entry, stop, and target for an open coin still use the position record.</aside>'
    ) : '';

    const fetchedLabel = formatRiyadh(now, true);
    const snapLine = snapAgeMs === null
      ? 'Snapshot age vs this device could not be measured.'
      : 'Device clock: snapshot is ' + formatDuration(snapAgeMs) + ' old.';
    const freshLine = freshness.stale
      ? 'Bot log flag: stale.'
      : 'Bot log flag: not stale (age_seconds ' + (freshness.age_seconds ?? '—') + 's when written, threshold ' + (freshness.stale_threshold_seconds ?? '—') + 's).';

    const posHtml = views.length
      ? '<div class="pos-list">' + views.map(renderPosition).join('') + '</div>'
      : '<div class="empty-state"><h3>No open positions</h3><p>open_position_count is ' + esc(account.open_position_count ?? '—') + '.</p></div>';
    const countMismatch = num(account.open_position_count) !== null && num(account.open_position_count) !== positions.length
      ? '<p class="hint warn-text">open_position_count is ' + esc(String(account.open_position_count)) + ' but the list has ' + positions.length + ' rows.</p>'
      : '';
    const unrealLine = unrealSum === null
      ? (views.length ? '<p class="section-note">Gross unrealized is not totaled. At least one open ticker is missing or the side is unclear.</p>' : '')
      : '<p class="section-note">Gross unrealized across open positions ' + esc(formatUsdt(unrealSum, { sign: true })) + '. Exit fees are not included.</p>';

    const cards = statuses.map((x) => renderPair(x.pair, x.status)).join('');
    const tableRows = statuses.map((x) => renderPairRow(x.pair, x.status)).join('');

    return '<div class="banner" data-ui="' + esc(UI_VERSION) + '">' +
      '<div class="tags"><span class="tag">PAPER / SIMULATED</span><span class="tag ghost">READ ONLY</span></div>' +
      '<p>' + esc(data.disclaimer || 'PAPER / SIMULATED trading only. Not affiliated with Binance. No real orders.') +
      ' This page has no order controls and does not change the bot.</p></div>' +
      notices.join('') +
      '<header class="top"><div><h1>Paper Bot Live Dashboard</h1>' +
      '<p class="lede">Unofficial paper monitor. Not Binance. No real money.</p></div>' +
      '<div class="asof"><span class="k">Feed snapshot</span><strong class="time">' + esc(generatedLabel) + '</strong>' +
      '<span class="hint">' + esc(snapLine) + ' ' + esc(freshLine) + '</span>' +
      '<span class="hint">Fetched by this browser ' + esc(fetchedLabel) + '.</span></div></header>' +
      '<section class="stats" aria-label="Account summary">' +
      '<article class="stat"><span class="k">Cash balance</span><span class="value">' + esc(bal) + '</span><span class="hint">Simulated USDT still in cash. Not marked equity.</span></article>' +
      '<article class="stat"><span class="k">Daily realized P&L</span><span class="value ' + dailyCls + '">' + esc(daily) + '</span>' +
      '<span class="hint">UTC day ' + esc(account.daily_date_utc || '—') + '. Date field, not a clock time.</span></article>' +
      '<article class="stat"><span class="k">Open positions</span><span class="value">' + esc(account.open_position_count ?? positions.length) + '</span>' +
      '<span class="hint">' + (entryKnown ? 'Entry cost of known positions ' + esc(formatUsdt(entrySum)) + '.' : 'No entry cost to sum.') + '</span></article>' +
      '<article class="stat"><span class="k">Closed trades</span><span class="value">' + esc(data.trades && data.trades.closed_count != null ? data.trades.closed_count : '—') + '</span>' +
      '<span class="hint">Zero means an empty history.</span></article></section>' +
      '<section class="block" id="positions"><div class="section-head"><h2>Open positions</h2><span class="pill quiet">' + positions.length + ' shown</span></div>' +
      countMismatch + unrealLine + posHtml + '</section>' +
      zeroBox +
      '<section class="block" id="markets"><div class="section-head"><h2>Markets</h2><span class="pill quiet">Poll 10s</span></div>' +
      candleNotice +
      '<p class="section-note">Ticker is the latest log price. Closed close, EMA, and RSI come from the last closed 15m candle. Candle time and ticker check time are labeled separately.</p>' +
      '<div class="pairs-cards">' + (cards || '<div class="empty-state"><h3>No pairs in the feed</h3></div>') + '</div>' +
      '<div class="pairs-table"><div class="table-scroll"><table><thead><tr>' +
      '<th scope="col">Symbol</th><th scope="col">Ticker</th><th scope="col">Closed close</th><th scope="col">Candle time</th>' +
      '<th scope="col">EMA200</th><th scope="col">RSI</th><th scope="col">Decision</th><th scope="col">Ticker checked</th>' +
      '</tr></thead><tbody>' + (tableRows || '<tr><td colspan="8">No pairs in the feed</td></tr>') + '</tbody></table></div></div></section>' +
      '<section class="block" id="history"><div class="section-head"><h2>Closed trade history</h2></div>' +
      renderTrades(data.trades || {}, data.trades && data.trades.closed_count) + '</section>' +
      '<section class="block health"><div class="section-head"><h2>Process</h2>' + healthPill + '</div>' +
      '<p class="cmd">' + esc(procList) + '</p>' +
      '<p class="hint">Last log ' + esc(logLabel) + ' · state file ' + esc(stateLabel) + ' · process count ' + esc(proc.count ?? '—') +
      ' · data source ' + esc(bot.base_url_hint || '—') + '.</p></section>' +
      '<footer class="footer"><p>Read-only view of the paper bot snapshot. The page polls the public gist every 10 seconds and never invents fills. ' +
      'Times you read as clocks are Asia/Riyadh (UTC+3). The daily figure stays on its UTC date field.</p>' +
      '<p>Unrealized P&L on an open card is gross: long (ticker − entry) × qty, short (entry − ticker) × qty. It excludes an estimated exit fee because open positions are only symbol, entry, qty, tp, and sl. ' +
      'Closed rows, when any exist, show the bot\'s own fees and pnl fields unchanged.</p>' +
      '<p>A candle is marked stale on this page when its timestamp is more than 45 minutes older than the snapshot. That is separate from freshness.stale, which is the bot log flag.</p>' +
      '<p class="feed-url">Feed ' + esc(FEED_URL) + '</p></footer>';
  }

  function renderError(err) {
    const msg = err && err.message ? err.message : (err ? String(err) : 'The gist feed did not load.');
    return '<div class="banner"><div class="tags"><span class="tag">PAPER / SIMULATED</span></div>' +
      '<p>Unofficial paper monitor. Not Binance. No order controls.</p></div>' +
      '<div class="notice bad" role="alert">Could not refresh the public gist feed. ' + esc(msg) + '</div>';
  }

  function start(opts) {
    const options = opts || {};
    const root = document.querySelector(options.root || '#app');
    const feed = options.feed || FEED_URL;
    let last = null;
    async function refresh() {
      try {
        const sep = feed.includes('?') ? '&' : '?';
        const r = await fetch(feed + sep + 't=' + Date.now(), { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        last = data;
        root.innerHTML = renderDashboard(data, { now: new Date() });
      } catch (e) {
        root.innerHTML = renderDashboard(last, { now: new Date(), fetchError: e });
      }
    }
    refresh();
    const timer = setInterval(refresh, 10000);
    return { refresh, stop() { clearInterval(timer); } };
  }

  return {
    UI_VERSION,
    FEED_URL,
    CANDLE_STALE_MS,
    CHECK_RECENT_MS,
    SNAPSHOT_LAG_MS,
    parseFeedTime,
    formatRiyadh,
    formatExactPrice,
    formatQty,
    formatUsdt,
    formatPct,
    formatRsi,
    formatDuration,
    isUsablePrice,
    inferSide,
    positionView,
    pairStatus,
    rangeModel,
    renderDashboard,
    renderError,
    start
  };
});
