/* Read-only paper dashboard.
   Charts are public Binance spot klines from data-api.binance.vision.
   When a position includes unrealized_pnl_usdt, current_value_usdt, and
   cost_usdt, that P&L is the feed's net figure: value − cost − 0.1% of value.
   Older snapshots without those fields stay gross mark-to-market.
   A published price of 0 is unusable. Null EMA or close is left blank. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PaperDash = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const UI_VERSION = 'chart-first-2026-11-07';
  const KLINE_ORIGIN = 'https://data-api.binance.vision';
  const RANGES = {
    '1H': { interval: '1m', limit: 60, stepMs: 60 * 1000, label: '1H' },
    '4H': { interval: '5m', limit: 48, stepMs: 5 * 60 * 1000, label: '4H' },
    '24H': { interval: '15m', limit: 96, stepMs: 15 * 60 * 1000, label: '24H' }
  };
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
    const digits = opts && opts.digits != null
      ? opts.digits
      : (abs === 0 || abs >= 0.01 ? 2 : (abs >= 0.0001 ? 4 : 8));
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
    const abs = Math.abs(x);
    let digits = 2;
    if (abs > 0 && abs < 0.01) {
      const exp = Math.floor(Math.log10(abs));
      digits = Math.min(6, Math.max(2, -exp + 1));
    }
    const body = abs.toLocaleString('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
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
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(raw)) {
      const date = new Date(raw);
      if (!Number.isNaN(date.getTime())) {
        return { raw, date, hasSeconds: true, zone: /Z$|[+-]00:00$/.test(raw) ? 'UTC' : 'offset' };
      }
    }
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

  function formatRiyadhClock(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '—';
    const body = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Riyadh',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(date);
    return body + ' UTC+3';
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
    const feedPrice = num(pos && pos.current_price);
    const priceFromFeed = isUsablePrice(feedPrice);
    const mark = priceFromFeed ? feedPrice : (currentOk ? ticker : null);
    const markOk = isUsablePrice(mark);
    const feedValue = num(pos && pos.current_value_usdt);
    const feedCost = num(pos && pos.cost_usdt);
    const feedNet = num(pos && pos.unrealized_pnl_usdt);
    const entryNotional = entryOk && qtyOk ? entry * qty : null;
    const computedValue = markOk && qtyOk ? mark * qty : null;
    const value = feedValue !== null ? feedValue : computedValue;
    let gross = null;
    let grossPct = null;
    if (markOk && entryOk && qtyOk && (side === 'long' || side === 'short')) {
      const diff = side === 'long' ? (mark - entry) : (entry - mark);
      gross = diff * qty;
      grossPct = diff / entry * 100;
    }
    let pnl = null;
    let pnlPct = null;
    let pnlKind = null;
    let netReconciled = null;
    if (feedNet !== null) {
      pnl = feedNet;
      pnlKind = 'net';
      pnlPct = feedCost ? (feedNet / feedCost) * 100 : null;
      if (feedValue !== null && feedCost !== null) {
        const expected = feedValue - feedCost - 0.001 * feedValue;
        netReconciled = Math.abs(expected - feedNet) <= 1e-8;
      }
    } else if (gross !== null) {
      pnl = gross;
      pnlPct = grossPct;
      pnlKind = 'gross';
    }
    const entryTimeRaw = (pos && (pos.entry_time || pos.opened_at || pos.entry_at || pos.bought_at)) || null;
    const tpVsEntry = entryOk && tpOk ? (tp - entry) / entry * 100 : null;
    const slVsEntry = entryOk && slOk ? (sl - entry) / entry * 100 : null;
    return {
      symbol: pos && pos.symbol ? String(pos.symbol) : '—',
      side,
      entry, qty, tp, sl, ticker,
      mark, markOk, priceFromFeed,
      priceSource: (pos && pos.price_source) || null,
      priceFetched: (pos && pos.price_fetched_at_riyadh) || null,
      feedValue, feedCost, feedNet,
      entryOk, qtyOk, currentOk, tpOk, slOk,
      tickerState,
      entryNotional, value, pnl, pnlPct, pnlKind, gross, grossPct, netReconciled,
      entryTimeRaw,
      tpVsEntry, slVsEntry,
      display: {
        qty: qtyOk ? formatQty(qty) : '—',
        entry: entryOk ? formatExactPrice(entry) : null,
        ticker: markOk ? formatExactPrice(mark) : null,
        tp: tpOk ? formatExactPrice(tp) : null,
        sl: slOk ? formatExactPrice(sl) : null,
        value: value === null ? null : formatUsdt(value),
        entryNotional: entryNotional === null ? null : formatUsdt(entryNotional),
        cost: feedCost === null ? null : formatUsdt(feedCost),
        pnl: pnl === null ? null : formatUsdt(pnl, { sign: true }),
        pnlPct: pnlPct === null ? null : formatPct(pnlPct),
        gross: gross === null ? null : formatUsdt(gross, { sign: true, digits: 4 }),
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

  function fieldPrice(state, value) {
    if (state === 'ok') return '<span class="price">' + esc(formatExactPrice(value)) + '</span>';
    if (state === 'zero') return '<span class="price missing">Unavailable</span><span class="hint">Rounded to zero in the feed. Not shown as a price.</span>';
    return '<span class="price missing">Not in feed</span>';
  }

  function sideCopy(side) {
    if (side === 'long') return 'Long · inferred (take-profit above entry, stop below). No side field in the feed.';
    if (side === 'short') return 'Short · inferred (take-profit below entry, stop above). No side field in the feed.';
    return 'Side unknown. Stops are not on opposite sides of the entry, and the feed has no side field.';
  }

  function pnlNote(view) {
    if (view.pnlKind === 'net') {
      const grossBit = view.display.gross ? ' Gross price move before that fee is ' + view.display.gross + '.' : '';
      if (view.netReconciled) {
        return 'Net from the feed: current value − cost − 0.1% of current value (estimated sell fee). The published unrealized_pnl_usdt matches that formula.' + grossBit;
      }
      return 'Net unrealized is the feed field unrealized_pnl_usdt. On these numbers it does not match value − cost − 0.1% of value, so it is shown as published.' + grossBit;
    }
    if (view.pnl === null && !view.markOk) {
      return 'P&L is not calculated. The price is unusable. This snapshot has no fee field, so no exit fee is estimated.';
    }
    if (view.pnl === null) {
      return 'P&L is not calculated because the position side is not clear. No fee is estimated from this feed.';
    }
    const formula = view.side === 'short' ? '(entry − price) × qty' : '(price − entry) × qty';
    return 'Gross mark-to-market ' + formula + '. Percent is that price change divided by the buying price. No estimated exit fee is subtracted: this snapshot has no fee fields on the open position.';
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
      '<div><dt>Ticker</dt><dd>' + fieldPrice(status.tickerState, pair.ticker_price) + '</dd></div>' +
      '<div><dt>Closed 15m close</dt><dd>' + fieldPrice(status.closeState, pair.closed_close) + '</dd></div>' +
      '<div class="wide"><dt>Candle time</dt><dd><span class="time">' + esc(status.candle.label) + '</span>' +
      (status.candle.source ? '<span class="hint">Source stamp ' + esc(status.candle.source) + '</span>' : '') +
      (candleHint ? '<span class="hint">' + esc(candleHint) + '</span>' : '') + '</dd></div>' +
      '<div class="wide"><dt>Ticker checked</dt><dd><span class="time">' + esc(status.check.label) + '</span>' +
      (checkHint ? '<span class="hint">' + esc(checkHint) + '</span>' : '') + '</dd></div>' +
      '<div><dt>EMA200</dt><dd>' + fieldPrice(status.emaState, pair.ema200) + '</dd></div>' +
      '<div><dt>RSI</dt><dd><span class="price">' + esc(status.rsi) + '</span>' +
      (status.rsiPrev ? '<span class="hint">prev ' + esc(status.rsiPrev) + '</span>' : '') + '</dd></div>' +
      '</dl></article>';
  }

  function renderPairRow(pair, status) {
    const stale = status.candle.stale ? ' stale' : '';
    const ticker = fieldPrice(status.tickerState, pair.ticker_price);
    const close = fieldPrice(status.closeState, pair.closed_close);
    const ema = fieldPrice(status.emaState, pair.ema200);
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

  function tradeMathNote(t) {
    const entry = num(t.entry);
    const exit = num(t.exit);
    const qty = num(t.qty);
    const fees = num(t.fees);
    const pnl = num(t.pnl);
    if ([entry, exit, qty, fees, pnl].some((v) => v === null)) return 'Shown as published.';
    const net = (exit - entry) * qty - fees;
    if (Math.abs(net - pnl) <= 0.0001) return 'Matches (exit − entry) × qty − fees.';
    return 'Shown as published. It does not match that long-style fee subtraction.';
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
        '<td class="' + pnlCls + '"><span class="price">' + esc(t.pnl == null || t.pnl === '' ? '—' : String(t.pnl)) + '</span>' +
        '<div class="hint">' + esc(tradeMathNote(t)) + '</div></td>' +
        '<td>' + esc(t.reason || '—') + '</td></tr>';
    }).join('');
    return (mismatch ? '<p class="hint warn-text">closed_count is ' + esc(String(reported)) + ' but the list has ' + list.length + ' rows.</p>' : '') +
      '<p class="hint">Order as published. When entry, exit, qty, fees, and pnl are all present, a row whose pnl matches (exit − entry) × qty − fees is labeled that way. Otherwise fees and pnl stay as published.</p>' +
      '<div class="table-scroll"><table><thead><tr>' +
      '<th scope="col">Time</th><th scope="col">Symbol</th><th scope="col">Entry</th><th scope="col">Exit</th>' +
      '<th scope="col">Qty</th><th scope="col">Fees</th><th scope="col">P&L</th><th scope="col">Reason</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function klineUrl(symbol, rangeKey) {
    if (!/^[A-Z0-9]{5,20}$/.test(String(symbol || ''))) return null;
    const spec = RANGES[rangeKey];
    if (!spec) return null;
    return KLINE_ORIGIN + '/api/v3/klines?symbol=' + symbol + '&interval=' + spec.interval + '&limit=' + spec.limit;
  }

  function parseKlines(rows) {
    if (!Array.isArray(rows)) return { ok: false, error: 'Kline payload was not a list.' };
    const candles = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!Array.isArray(row) || row.length < 7) continue;
      const openTime = Number(row[0]);
      const open = Number(row[1]);
      const high = Number(row[2]);
      const low = Number(row[3]);
      const close = Number(row[4]);
      const closeTime = Number(row[6]);
      if (!Number.isFinite(openTime) || !(close > 0)) continue;
      candles.push({ openTime, closeTime, open, high, low, close });
    }
    if (candles.length < 2) return { ok: false, error: 'Public klines returned fewer than 2 prices.' };
    return { ok: true, candles };
  }

  function chartGeometry(candles, levels) {
    const closes = candles.map((c) => c.close);
    let min = Math.min.apply(null, closes);
    let max = Math.max.apply(null, closes);
    const baseSpan = (max - min) || (max * 0.002) || 1e-12;
    const included = [];
    const omitted = [];
    (levels || []).forEach((lv) => {
      if (!isUsablePrice(lv.value)) return;
      if (lv.value >= min - baseSpan * 3 && lv.value <= max + baseSpan * 3) included.push(lv);
      else omitted.push(lv);
    });
    included.forEach((lv) => {
      min = Math.min(min, lv.value);
      max = Math.max(max, lv.value);
    });
    const pad = ((max - min) || baseSpan) * 0.12;
    min -= pad;
    max += pad;
    const W = 1000;
    const H = 460;
    const L = 8;
    const R = 8;
    const T = 28;
    const B = 42;
    const xAt = (i) => L + (candles.length === 1 ? 0 : (i / (candles.length - 1)) * (W - L - R));
    const yAt = (v) => T + ((max - v) / (max - min)) * (H - T - B);
    const line = candles.map((c, i) => (i ? 'L' : 'M') + xAt(i).toFixed(2) + ' ' + yAt(c.close).toFixed(2)).join(' ');
    const area = line + ' L ' + xAt(candles.length - 1).toFixed(2) + ' ' + (H - B).toFixed(2) + ' L ' + xAt(0).toFixed(2) + ' ' + (H - B).toFixed(2) + ' Z';
    const first = candles[0].close;
    const last = candles[candles.length - 1].close;
    const change = (last - first) / first * 100;
    return {
      width: W,
      height: H,
      plotTop: T,
      plotBottom: H - B,
      line,
      area,
      change,
      up: change >= 0,
      first,
      last,
      included: included.map((lv) => ({ ...lv, y: yAt(lv.value) })),
      omitted,
      points: candles.map((c, i) => ({ x: xAt(i), y: yAt(c.close), openTime: c.openTime, closeTime: c.closeTime, close: c.close })),
      start: candles[0].openTime,
      end: candles[candles.length - 1].closeTime
    };
  }

  function entryMarker(candles, entryTimeRaw) {
    const parsed = parseFeedTime(entryTimeRaw);
    if (!parsed || !parsed.date || !candles || candles.length < 2) return null;
    const t = parsed.date.getTime();
    const start = candles[0].openTime;
    const end = candles[candles.length - 1].closeTime;
    if (t < start || t > end) return null;
    return { time: t, label: formatRiyadh(parsed.date, true) };
  }

  function renderChartSvg(candles, view, rangeKey, now) {
    const levels = [];
    if (view) {
      if (view.display.sl) levels.push({ key: 'sl', value: view.sl, label: 'SL ' + view.display.sl });
      if (view.display.entry) levels.push({ key: 'entry', value: view.entry, label: 'Buy ' + view.display.entry });
      if (view.display.tp) levels.push({ key: 'tp', value: view.tp, label: 'TP ' + view.display.tp });
    }
    const geo = chartGeometry(candles, levels);
    const marker = view ? entryMarker(candles, view.entryTimeRaw) : null;
    let markerSvg = '';
    if (marker && geo.points.length) {
      const span = geo.end - geo.start || 1;
      const x = 8 + ((marker.time - geo.start) / span) * (1000 - 16);
      const nearest = geo.points.reduce((best, p) => Math.abs(p.openTime - marker.time) < Math.abs(best.openTime - marker.time) ? p : best, geo.points[0]);
      markerSvg = '<circle class="buy-mark" data-entry-marker="1" cx="' + x.toFixed(2) + '" cy="' + nearest.y.toFixed(2) + '" r="5"/>';
    }
    const grids = [0.25, 0.5, 0.75].map((g) => {
      const y = geo.plotTop + (geo.plotBottom - geo.plotTop) * g;
      return '<line class="grid" x1="8" x2="992" y1="' + y.toFixed(2) + '" y2="' + y.toFixed(2) + '"/>';
    }).join('');
    const levelSvg = geo.included.map((lv) =>
      '<line class="level ' + lv.key + '" x1="8" x2="992" y1="' + lv.y.toFixed(2) + '" y2="' + lv.y.toFixed(2) + '"/>' +
      '<text class="level-label ' + lv.key + '" x="14" y="' + (lv.y - 6).toFixed(2) + '">' + esc(lv.label) + '</text>'
    ).join('');
    const tone = geo.up ? 'up' : 'down';
    const spec = RANGES[rangeKey] || RANGES['1H'];
    const stale = now && (now.getTime() - candles[candles.length - 1].closeTime > spec.stepMs * 3);
    const gid = 'fill-' + tone;
    const aria = (view ? view.symbol : 'Symbol') + ' public spot closes from ' +
      formatExactPrice(geo.first) + ' to ' + formatExactPrice(geo.last) + ', ' + formatPct(geo.change) + ' over ' + spec.label +
      (marker ? ', entry marker at ' + marker.label : '. No entry-time marker');
    return {
      change: geo.change,
      svg: '<svg class="chart-svg ' + tone + '" viewBox="0 0 1000 460" role="img" aria-label="' + esc(aria) + '" data-last-close="' + esc(String(geo.last)) + '">' +
        '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="currentColor" stop-opacity="0.28"/>' +
        '<stop offset="100%" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>' +
        grids +
        '<path class="area" d="' + areaAttr(geo.area) + '" fill="url(#' + gid + ')"/>' +
        '<path class="line" d="' + areaAttr(geo.line) + '" fill="none"/>' +
        levelSvg + markerSvg +
        '<text class="axis" x="8" y="448">' + esc(formatRiyadhClock(new Date(candles[0].openTime))) + '</text>' +
        '<text class="axis end" x="992" y="448" text-anchor="end">' + esc(formatRiyadhClock(new Date(candles[candles.length - 1].closeTime))) + '</text>' +
        '</svg>',
      note: (marker
        ? 'Entry marker uses the recorded entry time in the feed.'
        : 'Horizontal lines are the paper entry, stop, and target. The feed has no entry time, so there is no buy marker on the clock.') +
        (geo.omitted.length ? ' Some levels sit outside this window and stay in the position panel.' : '') +
        (stale ? ' The last public candle ended ' + formatRiyadh(new Date(candles[candles.length - 1].closeTime), true) + ', which is older than a few intervals.' : '')
    };
  }

  function areaAttr(d) {
    return String(d).replace(/"/g, '');
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

    const symbolOrder = [];
    const seenSym = {};
    function addSym(s) {
      if (!s || seenSym[s]) return;
      seenSym[s] = 1;
      symbolOrder.push(String(s));
    }
    positions.forEach((p) => addSym(p.symbol));
    (bot.symbols || []).forEach(addSym);
    pairs.forEach((p) => addSym(p && p.symbol));
    const selected = opts.selected && seenSym[opts.selected] ? opts.selected : (symbolOrder[0] || null);
    const selectedView = views.filter((v) => v.symbol === selected)[0] || null;
    const selectedPair = selected ? pairBySymbol[selected] : null;
    const rangeKey = RANGES[opts.range] ? opts.range : '1H';
    const countMismatch = num(account.open_position_count) !== null && num(account.open_position_count) !== positions.length
      ? '<p class="hint warn-text">open_position_count is ' + esc(String(account.open_position_count)) + ' but the list has ' + positions.length + ' rows.</p>'
      : '';
    const unrealLine = !views.length ? ''
      : (unrealSum === null
        ? '<p class="section-note">Unrealized is not totaled. At least one open price is missing or the side is unclear.</p>'
        : (views.some((v) => v.pnlKind === 'net')
          ? '<p class="section-note">Where the feed sends unrealized_pnl_usdt, that net figure is shown. Otherwise the page uses a gross price move and does not invent a fee.</p>'
          : '<p class="section-note">Gross unrealized across open positions ' + esc(formatUsdt(unrealSum, { sign: true })) + '. No estimated exit fee is subtracted when the snapshot has no fee fields.</p>'));

    function holdingBlock(view) {
      const pnlCls = view.pnl > 0 ? 'up' : (view.pnl < 0 ? 'down' : '');
      const invested = view.display.cost || view.display.entryNotional;
      const investedHint = view.display.cost ? 'feed cost_usdt' : 'qty × entry';
      const valueHtml = view.display.value
        ? '<span class="price big">' + esc(view.display.value) + '</span>'
        : '<span class="price missing">Unavailable</span>';
      const pnlHtml = view.display.pnl
        ? '<span class="price big">' + esc(view.display.pnl) + '</span>' +
          (view.display.pnlPct ? '<span class="pct">' + esc(view.display.pnlPct) + (view.pnlKind === 'net' ? ' of cost' : ' vs entry') + '</span>' : '')
        : '<span class="price missing">Unavailable</span>';
      const costNote = view.display.cost && view.display.entryNotional
        ? '<p class="hint">qty × entry is ' + esc(view.display.entryNotional) + '. Feed cost is a separate number.</p>'
        : '';
      return '<section class="holding" data-symbol="' + esc(view.symbol) + '" data-pnl-kind="' + esc(view.pnlKind || '') + '">' +
        '<div class="holding-main"><div><span class="k">Value now</span>' + valueHtml +
        '<span class="subline"><span class="price">' + esc(view.display.qty) + '</span></span></div>' +
        '<div class="pnl-side ' + pnlCls + '"><span class="k">' + (view.pnlKind === 'net' ? 'Net unrealized' : 'Unrealized') + '</span>' + pnlHtml + '</div></div>' +
        '<div class="holding-sub"><div><span class="k">Invested</span><span class="price">' + esc(invested || '—') + '</span><span class="hint">' + esc(investedHint) + '</span></div>' +
        '<div><span class="k">Avg entry</span>' + priceHtml(view.display.entry) + '<span class="hint">buying price</span></div></div>' +
        '<div class="holding-levels"><div><span class="k">Stop loss</span>' + priceHtml(view.display.sl) +
        (view.display.slVsEntry ? '<span class="hint">' + esc(view.display.slVsEntry) + ' vs buying price</span>' : '') + '</div>' +
        '<div><span class="k">Take profit</span>' + priceHtml(view.display.tp) +
        (view.display.tpVsEntry ? '<span class="hint">' + esc(view.display.tpVsEntry) + ' vs buying price</span>' : '') + '</div></div>' +
        '<p class="hint">' + esc(pnlNote(view)) + '</p>' + costNote + '</section>';
    }

    let heroPrice = '<span class="price missing hero-px">Unavailable</span>';
    let heroSrc = 'No usable price in the feed for this symbol.';
    if (selectedView && selectedView.markOk) {
      heroPrice = '<span class="price hero-px">' + esc(selectedView.display.ticker) + '</span>';
      const fetched = parseFeedTime(selectedView.priceFetched);
      heroSrc = (selectedView.priceFromFeed ? 'Position current_price' : 'Pair ticker') +
        (selectedView.priceSource ? ' · ' + selectedView.priceSource : '') +
        (fetched && fetched.date ? ' · ' + formatRiyadh(fetched.date, true) : '');
    } else if (selectedPair && priceState(selectedPair.ticker_price) === 'ok') {
      heroPrice = '<span class="price hero-px">' + esc(formatExactPrice(selectedPair.ticker_price)) + '</span>';
      heroSrc = (selectedPair.ticker_source ? selectedPair.ticker_source + ' · ' : 'Pair ticker · ') + (selectedPair.ticker_fetched_at_riyadh || selectedPair.checked_at_riyadh || '');
    } else if (selectedPair && priceState(selectedPair.ticker_price) === 'zero') {
      heroSrc = 'Published ticker was rounded to zero. That is not a price of zero, so it is not shown as one.';
    }
    let chartHtml = '';
    let changeHtml = '<p class="chg">Change over ' + esc(rangeKey) + ' appears when public klines load.</p>';
    if (opts.chartError) {
      chartHtml = '<div class="chart-empty" role="status">Public klines did not load (' + esc(opts.chartError) + '). No stand-in series is drawn.</div>';
      changeHtml = '<p class="chg">Window change stays blank because the kline request failed.</p>';
    } else if (opts.candles && opts.candles.length > 1) {
      const drawn = renderChartSvg(opts.candles, selectedView, rangeKey, now);
      const tone = drawn.change >= 0 ? 'up' : 'down';
      chartHtml = drawn.svg + '<p class="hint chart-note">' + esc(drawn.note) + ' ' + esc((RANGES[rangeKey] || {}).interval) + ' candles from data-api.binance.vision.</p>';
      changeHtml = '<p class="chg ' + tone + '">' + esc(formatPct(drawn.change)) + ' over ' + esc(rangeKey) + '</p>';
    } else if (!selected) {
      chartHtml = '<div class="chart-empty">No symbol in the feed.</div>';
    } else {
      chartHtml = '<div class="chart-empty">Loading public ' + esc((RANGES[rangeKey] || {}).interval) + ' klines for ' + esc(selected) + '…</div>';
    }
    const tabs = Object.keys(RANGES).map((key) =>
      '<button type="button" class="seg' + (key === rangeKey ? ' on' : '') + '" data-range="' + key + '">' + key + '</button>'
    ).join('');
    const chips = symbolOrder.map((s) => {
      const on = s === selected ? ' on' : '';
      const held = views.some((v) => v.symbol === s) ? ' held' : '';
      return '<button type="button" class="chip' + on + held + '" data-select="' + esc(s) + '">' + esc(s.replace(/USDT$/, '')) + '</button>';
    }).join('');
    const holding = selectedView
      ? holdingBlock(selectedView)
      : '<section class="holding"><h2>No open paper position</h2><p class="hint">' + esc(selected || 'This symbol') + ' is in the watch list and has no open quantity.</p></section>';
    const others = views.filter((v) => v.symbol !== selected);
    const otherHtml = others.length
      ? '<section class="block"><div class="section-head"><h2>Other open holdings</h2></div>' + others.map(holdingBlock).join('') + '</section>'
      : '';
    const cards = statuses.map((x) => renderPair(x.pair, x.status)).join('');
    const tableRows = statuses.map((x) => renderPairRow(x.pair, x.status)).join('');

    return '<div class="banner" data-ui="' + esc(UI_VERSION) + '">' +
      '<div class="tags"><span class="tag">PAPER / SIMULATED</span><span class="tag ghost">READ ONLY</span></div>' +
      '<p>' + esc(data.disclaimer || 'PAPER / SIMULATED trading only. Not affiliated with Binance. No real orders.') +
      ' No order controls. The book is not changed from this page.</p></div>' +
      notices.join('') +
      '<section class="stage" data-selected="' + esc(selected || '') + '">' +
      '<div class="hero"><div class="hero-name"><h1>' + esc(selected || 'Paper book') + '</h1><span class="pill quiet">Paper</span></div>' +
      heroPrice + changeHtml + '<p class="hint">' + esc(heroSrc) + '</p></div>' +
      '<div class="chart-bleed">' + chartHtml + '</div>' +
      '<div class="tfs" role="tablist">' + tabs + '</div>' +
      '<p class="hint axis-note">Chart clock is Asia/Riyadh (UTC+3). The series is public spot history, not a paper fill.</p>' +
      holding +
      '</section>' +
      '<div class="chips" aria-label="Symbols">' + chips + '</div>' +
      '<p class="hint freshline">' + esc(generatedLabel) + ' · ' + esc(snapLine) + ' ' + esc(freshLine) + ' This browser read the gist at ' + esc(fetchedLabel) + '.</p>' +
      '<section class="stats" aria-label="Account summary">' +
      '<article class="stat"><span class="k">Cash balance</span><span class="value">' + esc(bal) + '</span><span class="hint">Simulated USDT still in cash.</span></article>' +
      '<article class="stat"><span class="k">Daily realized</span><span class="value ' + dailyCls + '">' + esc(daily) + '</span>' +
      '<span class="hint">UTC day ' + esc(account.daily_date_utc || '—') + '.</span></article>' +
      '<article class="stat"><span class="k">Open</span><span class="value">' + esc(account.open_position_count ?? positions.length) + '</span>' +
      '<span class="hint">' + (entryKnown ? 'qty × entry ' + esc(formatUsdt(entrySum)) + '.' : 'No entry cost.') + '</span></article>' +
      '<article class="stat"><span class="k">Closed</span><span class="value">' + esc(data.trades && data.trades.closed_count != null ? data.trades.closed_count : '—') + '</span>' +
      '<span class="hint">Zero is an empty history.</span></article></section>' +
      countMismatch + unrealLine + otherHtml + zeroBox +
      '<section class="block" id="markets"><div class="section-head"><h2>Markets</h2><span class="pill quiet">Gist check 10s</span></div>' +
      candleNotice +
      '<p class="section-note">The publisher writes about once a minute, so a 10s check often repeats the same snapshot. Ticker is the feed price. Closed close, EMA, and RSI come from the bot candle. Null means not in the feed. Candle time and ticker check time stay separate.</p>' +
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
      '<footer class="footer"><p>Read-only paper monitor. The page re-reads the public gist every 10 seconds and does not invent fills. A new snapshot is expected about once a minute, not on every check. Clocks are Asia/Riyadh (UTC+3). The daily date stays on its UTC field.</p>' +
      '<p>Spot charts request data-api.binance.vision klines in the browser. If that request fails, the chart stays empty.</p>' +
      '<p>A bot candle older than 45 minutes versus the snapshot is marked stale here. That is separate from freshness.stale.</p>' +
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
    const ui = { symbol: null, range: '1H', candles: null, chartError: null, chartKey: '', chartAt: 0 };
    let last = null;
    function paint(err) {
      root.innerHTML = renderDashboard(last, {
        now: new Date(),
        fetchError: err,
        selected: ui.symbol,
        range: ui.range,
        candles: ui.candles,
        chartError: ui.chartError
      });
    }
    async function loadChart(force) {
      if (!ui.symbol) return;
      const key = ui.symbol + '|' + ui.range;
      if (!force && ui.candles && ui.chartKey === key && Date.now() - ui.chartAt < 60000) return;
      ui.chartKey = key;
      const url = klineUrl(ui.symbol, ui.range);
      if (!url) {
        ui.candles = null;
        ui.chartError = 'Symbol is not a public spot pair name.';
        if (last) paint(null);
        return;
      }
      try {
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const parsed = parseKlines(await r.json());
        if (ui.chartKey !== key) return;
        if (!parsed.ok) throw new Error(parsed.error);
        ui.candles = parsed.candles;
        ui.chartError = null;
        ui.chartAt = Date.now();
      } catch (e) {
        if (ui.chartKey !== key) return;
        ui.candles = null;
        ui.chartError = e && e.message ? e.message : String(e);
      }
      if (last) paint(null);
    }
    async function refresh() {
      try {
        const sep = feed.includes('?') ? '&' : '?';
        const r = await fetch(feed + sep + 't=' + Date.now(), { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        last = await r.json();
        if (!ui.symbol) {
          const open = (last.account && last.account.open_positions) || [];
          const symbols = (last.bot && last.bot.symbols) || [];
          ui.symbol = (open[0] && open[0].symbol) || symbols[0] || ((last.pairs || [])[0] && last.pairs[0].symbol) || null;
        }
        paint(null);
        loadChart(false);
      } catch (e) {
        paint(e);
      }
    }
    root.addEventListener('click', (ev) => {
      const rangeBtn = ev.target.closest('[data-range]');
      if (rangeBtn) {
        ui.range = rangeBtn.getAttribute('data-range');
        ui.candles = null;
        ui.chartError = null;
        if (last) paint(null);
        loadChart(true);
        return;
      }
      const symBtn = ev.target.closest('[data-select]');
      if (symBtn) {
        ui.symbol = symBtn.getAttribute('data-select');
        ui.candles = null;
        ui.chartError = null;
        if (last) paint(null);
        loadChart(true);
      }
    });
    refresh();
    const timer = setInterval(refresh, 10000);
    return { refresh, stop() { clearInterval(timer); }, loadChart };
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
    RANGES,
    klineUrl,
    parseKlines,
    chartGeometry,
    entryMarker,
    renderChartSvg,
    renderDashboard,
    renderError,
    start
  };
});
