const ENGINE_VERSION = "07";

const SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "XRPUSDT"
];

const BINANCE_API =
  "https://data-api.binance.vision/api/v3/klines";

const KRAKEN_API =
  "https://api.kraken.com/0/public/OHLC";

const KRAKEN_PAIRS = {
  BTCUSDT: "XBTUSD",
  ETHUSDT: "ETHUSD",
  SOLUSDT: "SOLUSD",
  XRPUSDT: "XRPUSD"
};


// ======================================================
// INDICATORS
// ======================================================

function ema(a, p) {
  if (!a || a.length === 0) return NaN;

  const k = 2 / (p + 1);
  let e = a[0];

  for (let i = 1; i < a.length; i++) {
    e = a[i] * k + e * (1 - k);
  }

  return e;
}


function rsi(a, p = 14) {
  if (a.length <= p) return NaN;

  let g = 0;
  let l = 0;

  for (let i = 1; i <= p; i++) {
    const d = a[i] - a[i - 1];

    g += Math.max(d, 0);
    l += Math.max(-d, 0);
  }

  let ag = g / p;
  let al = l / p;

  for (let i = p + 1; i < a.length; i++) {
    const d = a[i] - a[i - 1];

    ag =
      (ag * (p - 1) + Math.max(d, 0)) /
      p;

    al =
      (al * (p - 1) + Math.max(-d, 0)) /
      p;
  }

  if (al === 0) {
    return ag === 0 ? 50 : 100;
  }

  return 100 - 100 / (1 + ag / al);
}


function atr(h, l, c, p = 14) {
  if (c.length <= p) return NaN;

  const t = [];

  for (let i = 1; i < c.length; i++) {
    t.push(
      Math.max(
        h[i] - l[i],
        Math.abs(h[i] - c[i - 1]),
        Math.abs(l[i] - c[i - 1])
      )
    );
  }

  let a =
    t.slice(0, p)
      .reduce((x, y) => x + y, 0) / p;

  for (let i = p; i < t.length; i++) {
    a =
      (a * (p - 1) + t[i]) / p;
  }

  return a;
}


function adx(h, l, c, p = 14) {

  if (c.length < 2 * p + 2) {
    return NaN;
  }

  const tr = [];
  const pd = [];
  const md = [];

  for (let i = 1; i < c.length; i++) {

    const up =
      h[i] - h[i - 1];

    const dn =
      l[i - 1] - l[i];

    tr.push(
      Math.max(
        h[i] - l[i],
        Math.abs(h[i] - c[i - 1]),
        Math.abs(l[i] - c[i - 1])
      )
    );

    pd.push(
      up > dn && up > 0
        ? up
        : 0
    );

    md.push(
      dn > up && dn > 0
        ? dn
        : 0
    );
  }

  let ts =
    tr.slice(0, p)
      .reduce((a, b) => a + b, 0);

  let ps =
    pd.slice(0, p)
      .reduce((a, b) => a + b, 0);

  let ms =
    md.slice(0, p)
      .reduce((a, b) => a + b, 0);

  const dx = [];

  for (let i = p; i < tr.length; i++) {

    ts =
      ts - ts / p + tr[i];

    ps =
      ps - ps / p + pd[i];

    ms =
      ms - ms / p + md[i];

    const pi =
      100 * ps / ts;

    const mi =
      100 * ms / ts;

    dx.push(
      100 *
      Math.abs(pi - mi) /
      (pi + mi || 1)
    );
  }

  if (dx.length < p) {
    return NaN;
  }

  let x =
    dx.slice(0, p)
      .reduce((a, b) => a + b, 0) / p;

  for (let i = p; i < dx.length; i++) {

    x =
      (x * (p - 1) + dx[i]) /
      p;
  }

  return x;
}


// ======================================================
// CURRENT MARKET DATA
// ======================================================

function parseBinance(raw) {

  return raw
    .slice(0, -1)
    .map(x => ({
      open: +x[1],
      high: +x[2],
      low: +x[3],
      close: +x[4],
      volume: +x[5],
      openTime: +x[0],
      closeTime: +x[6]
    }));
}


async function candles(
  symbol,
  tf,
  limit = 300
) {

  const interval =
    tf === "4h"
      ? 240
      : tf === "1d"
        ? 1440
        : null;

  if (!interval) {
    throw Error(
      `Unsupported timeframe ${tf}`
    );
  }

  const errors = [];

  // ----------------------------------------------------
  // BINANCE
  // ----------------------------------------------------

  try {

    const u =
      new URL(BINANCE_API);

    u.searchParams.set(
      "symbol",
      symbol
    );

    u.searchParams.set(
      "interval",
      tf
    );

    u.searchParams.set(
      "limit",
      String(limit)
    );

    const r =
      await fetch(
        u.toString(),
        {
          headers: {
            "Accept":
              "application/json",
            "User-Agent":
              "CryptoDecisionEngine/0.7"
          }
        }
      );

    if (r.ok) {

      const data =
        await r.json();

      if (
        Array.isArray(data) &&
        data.length >= 50
      ) {
        return parseBinance(data);
      }

      errors.push(
        `Binance ${symbol}: unexpected response`
      );

    } else {

      errors.push(
        `Binance ${symbol}: HTTP ${r.status}`
      );
    }

  } catch (e) {

    errors.push(
      `Binance ${symbol}: ${e.message}`
    );
  }


  // ----------------------------------------------------
  // KRAKEN FALLBACK
  // ----------------------------------------------------

  try {

    const pair =
      KRAKEN_PAIRS[symbol];

    if (!pair) {
      throw Error(
        `No Kraken pair for ${symbol}`
      );
    }

    const u =
      new URL(KRAKEN_API);

    u.searchParams.set(
      "pair",
      pair
    );

    u.searchParams.set(
      "interval",
      String(interval)
    );

    const r =
      await fetch(
        u.toString(),
        {
          headers: {
            "Accept":
              "application/json",
            "User-Agent":
              "CryptoDecisionEngine/0.7"
          }
        }
      );

    if (!r.ok) {
      throw Error(
        `HTTP ${r.status}`
      );
    }

    const data =
      await r.json();

    if (
      data.error &&
      data.error.length
    ) {
      throw Error(
        data.error.join("; ")
      );
    }

    const key =
      Object.keys(
        data.result || {}
      ).find(
        k => k !== "last"
      );

    const rows =
      key
        ? data.result[key]
        : null;

    if (
      !Array.isArray(rows) ||
      rows.length < 50
    ) {
      throw Error(
        "insufficient OHLC data"
      );
    }

    return rows
      .slice(0, -1)
      .map(x => ({
        open: +x[1],
        high: +x[2],
        low: +x[3],
        close: +x[4],
        volume: +x[6],
        openTime: +x[0] * 1000,
        closeTime:
          (+x[0] + interval * 60) *
          1000
      }));

  } catch (e) {

    errors.push(
      `Kraken ${symbol}: ${e.message}`
    );
  }

  throw Error(
    `Market data unavailable for ${symbol} (${tf}). ` +
    errors.join(" | ")
  );
}


// ======================================================
// HISTORICAL BINANCE DATA
// ======================================================

async function historicalKlines(
  symbol,
  interval,
  startMs,
  endMs
) {

  const result = [];

  let cursor = startMs;

  const maxPerRequest = 1000;

  while (cursor < endMs) {

    const u =
      new URL(BINANCE_API);

    u.searchParams.set(
      "symbol",
      symbol
    );

    u.searchParams.set(
      "interval",
      interval
    );

    u.searchParams.set(
      "startTime",
      String(cursor)
    );

    u.searchParams.set(
      "endTime",
      String(endMs)
    );

    u.searchParams.set(
      "limit",
      String(maxPerRequest)
    );

    const r =
      await fetch(
        u.toString(),
        {
          headers: {
            "Accept":
              "application/json",
            "User-Agent":
              "CryptoDecisionEngine/0.7"
          }
        }
      );

    if (!r.ok) {
      throw Error(
        `Historical Binance ${symbol} ${interval}: HTTP ${r.status}`
      );
    }

    const data =
      await r.json();

    if (
      !Array.isArray(data) ||
      data.length === 0
    ) {
      break;
    }

    for (const x of data) {

      const openTime =
        +x[0];

      const closeTime =
        +x[6];

      if (
        closeTime <= endMs &&
        openTime >= startMs
      ) {

        result.push({
          open: +x[1],
          high: +x[2],
          low: +x[3],
          close: +x[4],
          volume: +x[5],
          openTime,
          closeTime
        });
      }
    }

    const last =
      +data[data.length - 1][0];

    if (
      data.length < maxPerRequest ||
      last <= cursor
    ) {
      break;
    }

    cursor =
      last + 1;

    // Safety limit.
    if (result.length > 100000) {
      throw Error(
        "Backtest data limit exceeded"
      );
    }
  }

  return result;
}


// ======================================================
// STRATEGY CALCULATION
// ======================================================

function calculateSignal(
  fourh,
  daily
) {

  if (
    fourh.length < 210 ||
    daily.length < 210
  ) {
    return null;
  }


  // ----------------------------------------------------
  // 4H
  // ----------------------------------------------------

  const c =
    fourh.map(x => x.close);

  const h =
    fourh.map(x => x.high);

  const l =
    fourh.map(x => x.low);

  const v =
    fourh.map(x => x.volume);


  // ----------------------------------------------------
  // DAILY
  // ----------------------------------------------------

  const dc =
    daily.map(x => x.close);


  const d21 =
    ema(dc, 21);

  const d50 =
    ema(dc, 50);

  const d200 =
    ema(dc, 200);


  const dailyBull =
    dc.at(-1) > d21 &&
    d21 > d50 &&
    d50 > d200;


  const dailyBear =
    dc.at(-1) < d21 &&
    d21 < d50 &&
    d50 < d200;


  const regime =
    dailyBull
      ? "BULL TREND"
      : dailyBear
        ? "BEAR TREND"
        : "RANGE / TRANSITION";


  // ----------------------------------------------------
  // 4H INDICATORS
  // ----------------------------------------------------

  const e21 =
    ema(c, 21);

  const e50 =
    ema(c, 50);

  const e200 =
    ema(c, 200);

  const R =
    rsi(c);

  const A =
    atr(h, l, c);

  const D =
    adx(h, l, c);

  const ve =
    ema(v, 20);

  const vr =
    v.at(-1) / ve;

  const price =
    c.at(-1);

  const dist =
    (price / e21 - 1) * 100;


  const fourhBull =
    price > e21 &&
    e21 > e50 &&
    e50 > e200;


  // ----------------------------------------------------
  // CURRENT STRATEGY
  // ----------------------------------------------------

  const ok =
    dailyBull &&
    fourhBull &&
    R >= 48 &&
    R <= 65 &&
    dist <= 3.5 &&
    dist >= -1 &&
    vr >= 0.8 &&
    D > 25;


  if (!ok) {

    return {
      signal: false,
      regime,
      price,
      rsi: R,
      adx: D,
      atr: A,
      ema21: e21,
      ema50: e50,
      ema200: e200,
      volumeRatio: vr
    };
  }


  // ----------------------------------------------------
  // ENTRY / SL / TP
  // ----------------------------------------------------

  const entry =
    e21;


  const sl =
    Math.min(
      e21 - 1.8 * A,
      e50
    );


  if (
    !Number.isFinite(sl) ||
    sl >= entry
  ) {

    return {
      signal: false,
      regime,
      price,
      rsi: R,
      adx: D,
      atr: A,
      ema21: e21,
      ema50: e50,
      ema200: e200,
      volumeRatio: vr
    };
  }


  const risk =
    entry - sl;


  const tp1 =
    entry + 1.8 * risk;


  const tp2 =
    entry + 3 * risk;


  return {

    signal: true,

    strategy:
      "TREND PULLBACK",

    regime,

    price,

    rsi: R,

    adx: D,

    atr: A,

    ema21: e21,

    ema50: e50,

    ema200: e200,

    volumeRatio: vr,

    entry,

    sl,

    tp1,

    tp2,

    risk
  };
}


// ======================================================
// BACKTEST
// ======================================================

async function runBacktest(
  symbol,
  startMs,
  endMs,
  startingCapital
) {

  // ----------------------------------------------------
  // Load enough history BEFORE the requested start.
  // This is required for EMA200 and other indicators.
  // ----------------------------------------------------

  const warmup4h =
    300 * 4 * 60 * 60 * 1000;

  const warmup1d =
    250 * 24 * 60 * 60 * 1000;


  const dataStart4h =
    startMs - warmup4h;

  const dataStart1d =
    startMs - warmup1d;


  const fourh =
    await historicalKlines(
      symbol,
      "4h",
      dataStart4h,
      endMs
    );


  const daily =
    await historicalKlines(
      symbol,
      "1d",
      dataStart1d,
      endMs
    );


  if (
    fourh.length < 250 ||
    daily.length < 210
  ) {

    throw Error(
      `Not enough historical data for ${symbol}`
    );
  }


  let cash =
    startingCapital;


  const positions = [];

  const trades = [];


  let equityPeak =
    startingCapital;

  let maxDrawdown =
    0;


  // ----------------------------------------------------
  // Iterate through CLOSED 4H candles
  // ----------------------------------------------------

  for (
    let i = 210;
    i < fourh.length;
    i++
  ) {

    const candle =
      fourh[i];


    if (
      candle.closeTime < startMs
    ) {
      continue;
    }


    if (
      candle.closeTime > endMs
    ) {
      break;
    }


    // --------------------------------------------------
    // Find daily candles available at this moment.
    // No future daily data allowed.
    // --------------------------------------------------

    const availableDaily =
      daily.filter(
        d =>
          d.closeTime <=
          candle.closeTime
      );


    if (
      availableDaily.length < 210
    ) {
      continue;
    }


    // --------------------------------------------------
    // Only use 4H history up to the CURRENT
    // closed candle.
    // --------------------------------------------------

    const available4h =
      fourh.slice(
        0,
        i + 1
      );


    // --------------------------------------------------
    // First manage existing position.
    // --------------------------------------------------

    for (
      let p = positions.length - 1;
      p >= 0;
      p--
    ) {

      const pos =
        positions[p];


      if (
        pos.status !== "OPEN"
      ) {
        continue;
      }


      // Don't evaluate the entry candle
      // as an exit candle.
      if (
        candle.openTime <=
        pos.entryCandleTime
      ) {
        continue;
      }


      let exitPrice = null;
      let reason = null;


      // ------------------------------------------------
      // Same-candle SL + TP:
      // SL first, conservative assumption.
      // ------------------------------------------------

      if (
        candle.low <= pos.sl &&
        candle.high >= pos.tp1
      ) {

        exitPrice =
          pos.sl;

        reason =
          "SL_FIRST_AMBIGUOUS";

      } else if (
        candle.low <= pos.sl
      ) {

        exitPrice =
          pos.sl;

        reason =
          "SL";

      } else if (
        candle.high >= pos.tp1
      ) {

        exitPrice =
          pos.tp1;

        reason =
          "TP1";
      }


      if (
        exitPrice !== null
      ) {

        const pnl =
          (exitPrice - pos.entry) *
          pos.qty;


        const exitValue =
          pos.qty *
          exitPrice;


        cash +=
          exitValue;


        const riskMoney =
          pos.riskPerUnit *
          pos.qty;


        const R =
          riskMoney > 0
            ? pnl / riskMoney
            : 0;


        const durationMs =
          candle.closeTime -
          pos.entryTime;


        const durationHours =
          durationMs /
          3600000;


        trades.push({

          id:
            trades.length + 1,

          symbol:
            pos.symbol,

          strategy:
            pos.strategy,

          entryTime:
            new Date(
              pos.entryTime
            ).toISOString(),

          exitTime:
            new Date(
              candle.closeTime
            ).toISOString(),

          durationHours:
            Number(
              durationHours.toFixed(2)
            ),

          entry:
            pos.entry,

          sl:
            pos.sl,

          tp1:
            pos.tp1,

          tp2:
            pos.tp2,

          exit:
            exitPrice,

          qty:
            pos.qty,

          pnl:
            Number(
              pnl.toFixed(8)
            ),

          R:
            Number(
              R.toFixed(4)
            ),

          result:
            pnl >= 0
              ? "WIN"
              : "LOSS",

          reason,

          regime:
            pos.regime,

          rsi:
            pos.rsi,

          adx:
            pos.adx,

          volumeRatio:
            pos.volumeRatio
        });


        positions.splice(
          p,
          1
        );
      }
    }


    // --------------------------------------------------
    // If already holding this symbol, no new entry.
    // --------------------------------------------------

    const hasPosition =
      positions.some(
        p =>
          p.symbol === symbol &&
          p.status === "OPEN"
      );


    if (hasPosition) {
      continue;
    }


    // --------------------------------------------------
    // Calculate current signal.
    // --------------------------------------------------

    const signal =
      calculateSignal(
        available4h,
        availableDaily
      );


    if (
      !signal ||
      !signal.signal
    ) {
      continue;
    }


    // --------------------------------------------------
    // IMPORTANT:
    //
    // The old live engine used EMA21 as entry.
    // For this historical simulation we preserve
    // that exact rule.
    //
    // We require the current candle's range to have
    // actually reached the EMA21 before considering
    // the limit entry filled.
    // --------------------------------------------------

    const entry =
      signal.entry;


    if (
      candle.low > entry ||
      candle.high < entry
    ) {

      continue;
    }


    // --------------------------------------------------
    // 20% of ORIGINAL starting capital
    // --------------------------------------------------

    const allocation =
      Math.min(
        cash,
        startingCapital * 0.20
      );


    if (
      allocation <= 0
    ) {
      continue;
    }


    const qty =
      allocation / entry;


    const riskPerUnit =
      entry - signal.sl;


    if (
      riskPerUnit <= 0
    ) {
      continue;
    }


    positions.push({

      status:
        "OPEN",

      symbol,

      strategy:
        "TREND PULLBACK",

      entryTime:
        candle.closeTime,

      entryCandleTime:
        candle.openTime,

      entry,

      qty,

      sl:
        signal.sl,

      tp1:
        signal.tp1,

      tp2:
        signal.tp2,

      riskPerUnit,

      regime:
        signal.regime,

      rsi:
        signal.rsi,

      adx:
        signal.adx,

      volumeRatio:
        signal.volumeRatio
    });


    cash -=
      allocation;


    // --------------------------------------------------
    // Equity / drawdown
    // --------------------------------------------------

    let openValue =
      0;


    for (
      const pos of positions
    ) {

      openValue +=
        pos.qty *
        candle.close;
    }


    const equity =
      cash +
      openValue;


    if (
      equity >
      equityPeak
    ) {

      equityPeak =
        equity;
    }


    const drawdown =
      equityPeak > 0
        ? (
          (equity -
            equityPeak) /
          equityPeak
        ) * 100
        : 0;


    if (
      drawdown <
      maxDrawdown
    ) {

      maxDrawdown =
        drawdown;
    }
  }


  // ----------------------------------------------------
  // Close any positions still open at end of test.
  // ----------------------------------------------------

  if (
    positions.length > 0
  ) {

    const last =
      fourh
        .filter(
          x =>
            x.closeTime >=
              startMs &&
            x.closeTime <=
              endMs
        )
        .at(-1);


    if (last) {

      for (
        const pos of positions
      ) {

        const exitPrice =
          last.close;


        const pnl =
          (
            exitPrice -
            pos.entry
          ) *
          pos.qty;


        const riskMoney =
          pos.riskPerUnit *
          pos.qty;


        const R =
          riskMoney > 0
            ? pnl / riskMoney
            : 0;


        cash +=
          pos.qty *
          exitPrice;


        trades.push({

          id:
            trades.length + 1,

          symbol:
            pos.symbol,

          strategy:
            pos.strategy,

          entryTime:
            new Date(
              pos.entryTime
            ).toISOString(),

          exitTime:
            new Date(
              last.closeTime
            ).toISOString(),

          durationHours:
            Number(
              (
                (
                  last.closeTime -
                  pos.entryTime
                ) /
                3600000
              ).toFixed(2)
            ),

          entry:
            pos.entry,

          sl:
            pos.sl,

          tp1:
            pos.tp1,

          tp2:
            pos.tp2,

          exit:
            exitPrice,

          qty:
            pos.qty,

          pnl:
            Number(
              pnl.toFixed(8)
            ),

          R:
            Number(
              R.toFixed(4)
            ),

          result:
            pnl >= 0
              ? "WIN"
              : "LOSS",

          reason:
            "END_OF_TEST",

          regime:
            pos.regime,

          rsi:
            pos.rsi,

          adx:
            pos.adx,

          volumeRatio:
            pos.volumeRatio
        });
      }
    }
  }


  // ----------------------------------------------------
  // Statistics
  // ----------------------------------------------------

  const wins =
    trades.filter(
      t =>
        t.result === "WIN"
    );


  const losses =
    trades.filter(
      t =>
        t.result === "LOSS"
    );


  const netPnl =
    trades.reduce(
      (sum, t) =>
        sum + t.pnl,
      0
    );


  const grossProfit =
    wins.reduce(
      (sum, t) =>
        sum + t.pnl,
      0
    );


  const grossLoss =
    losses.reduce(
      (sum, t) =>
        sum + Math.abs(t.pnl),
      0
    );


  const profitFactor =
    grossLoss > 0
      ? grossProfit /
        grossLoss
      : grossProfit > 0
        ? Infinity
        : 0;


  const winRate =
    trades.length > 0
      ? wins.length /
        trades.length *
        100
      : 0;


  const avgPnl =
    trades.length > 0
      ? netPnl /
        trades.length
      : 0;


  const avgR =
    trades.length > 0
      ? trades.reduce(
          (sum, t) =>
            sum + t.R,
          0
        ) /
        trades.length
      : 0;


  const maxWin =
    trades.length > 0
      ? Math.max(
          ...trades.map(
            t => t.pnl
          )
        )
      : 0;


  const maxLoss =
    trades.length > 0
      ? Math.min(
          ...trades.map(
            t => t.pnl
          )
        )
      : 0;


  return {

    symbol,

    start:
      new Date(
        startMs
      ).toISOString(),

    end:
      new Date(
        endMs
      ).toISOString(),

    startingCapital,

    finalEquity:
      Number(
        cash.toFixed(8)
      ),

    netPnl:
      Number(
        netPnl.toFixed(8)
      ),

    totalTrades:
      trades.length,

    wins:
      wins.length,

    losses:
      losses.length,

    winRate:
      Number(
        winRate.toFixed(2)
      ),

    profitFactor:
      Number.isFinite(
        profitFactor
      )
        ? Number(
            profitFactor.toFixed(3)
          )
        : "Infinity",

    avgPnl:
      Number(
        avgPnl.toFixed(8)
      ),

    avgR:
      Number(
        avgR.toFixed(4)
      ),

    maxWin:
      Number(
        maxWin.toFixed(8)
      ),

    maxLoss:
      Number(
        maxLoss.toFixed(8)
      ),

    maxDrawdownPct:
      Number(
        maxDrawdown.toFixed(2)
      ),

    trades
  };
}


// ======================================================
// MULTI-COIN BACKTEST
// ======================================================

async function backtest(
  start,
  end,
  capital
) {

  const startMs =
    Date.parse(start);

  const endMs =
    Date.parse(end);


  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs)
  ) {

    throw Error(
      "Invalid start/end date"
    );
  }


  if (
    endMs <= startMs
  ) {

    throw Error(
      "End date must be after start date"
    );
  }


  if (
    capital <= 0 ||
    !Number.isFinite(capital)
  ) {

    throw Error(
      "Invalid capital"
    );
  }


  const results = [];


  for (
    const symbol of SYMBOLS
  ) {

    const result =
      await runBacktest(
        symbol,
        startMs,
        endMs,
        capital
      );


    results.push(
      result
    );
  }


  // ----------------------------------------------------
  // Combined statistics
  // ----------------------------------------------------

  const allTrades =
    results
      .flatMap(
        r => r.trades
      )
      .sort(
        (a, b) =>
          Date.parse(
            a.entryTime
          ) -
          Date.parse(
            b.entryTime
          )
      );


  const wins =
    allTrades.filter(
      t =>
        t.result === "WIN"
    );


  const losses =
    allTrades.filter(
      t =>
        t.result === "LOSS"
    );


  const netPnl =
    allTrades.reduce(
      (sum, t) =>
        sum + t.pnl,
      0
    );


  const grossProfit =
    wins.reduce(
      (sum, t) =>
        sum + t.pnl,
      0
    );


  const grossLoss =
    losses.reduce(
      (sum, t) =>
        sum + Math.abs(t.pnl),
      0
    );


  const profitFactor =
    grossLoss > 0
      ? grossProfit /
        grossLoss
      : grossProfit > 0
        ? Infinity
        : 0;


  const winRate =
    allTrades.length > 0
      ? wins.length /
        allTrades.length *
        100
      : 0;


  return {

    engine_version:
      ENGINE_VERSION,

    type:
      "HISTORICAL BACKTEST",

    strategy:
      "CURRENT TREND PULLBACK",

    start:
      new Date(
        startMs
      ).toISOString(),

    end:
      new Date(
        endMs
      ).toISOString(),

    startingCapital:
      capital,

    finalEquity:
      Number(
        (
          capital +
          netPnl
        ).toFixed(8)
      ),

    netPnl:
      Number(
        netPnl.toFixed(8)
      ),

    totalTrades:
      allTrades.length,

    wins:
      wins.length,

    losses:
      losses.length,

    winRate:
      Number(
        winRate.toFixed(2)
      ),

    profitFactor:
      Number.isFinite(
        profitFactor
      )
        ? Number(
            profitFactor.toFixed(3)
          )
        : "Infinity",

    bySymbol:
      results.map(
        r => ({
          symbol:
            r.symbol,

          trades:
            r.totalTrades,

          wins:
            r.wins,

          losses:
            r.losses,

          winRate:
            r.winRate,

          pnl:
            r.netPnl,

          profitFactor:
            r.profitFactor,

          maxDrawdownPct:
            r.maxDrawdownPct
        })
      ),

    trades:
      allTrades
  };
}


// ======================================================
// PAPER TRADING
// ======================================================

async function scan(symbol) {

  const [
    fourh,
    daily
  ] =
    await Promise.all([
      candles(
        symbol,
        "4h",
        300
      ),

      candles(
        symbol,
        "1d",
        250
      )
    ]);


  const signal =
    calculateSignal(
      fourh,
      daily
    );


  return {

    symbol,

    timeframe:
      "4h",

    price:
      signal?.price ?? null,

    regime:
      signal?.regime ??
      "NO DATA",

    strategy:
      signal?.signal
        ? "TREND PULLBACK"
        : "NO TRADE",

    decision:
      signal?.signal
        ? "BUY"
        : "NO TRADE",

    rsi:
      signal?.rsi ??
      null,

    adx:
      signal?.adx ??
      null,

    atr:
      signal?.atr ??
      null,

    ema21:
      signal?.ema21 ??
      null,

    ema50:
      signal?.ema50 ??
      null,

    ema200:
      signal?.ema200 ??
      null,

    entry:
      signal?.entry ??
      null,

    sl:
      signal?.sl ??
      null,

    tp1:
      signal?.tp1 ??
      null,

    tp2:
      signal?.tp2 ??
      null,

    volumeRatio:
      signal?.volumeRatio ??
      null,

    lastClosedCandleAt:
      new Date(
        fourh.at(-1).closeTime
      ).toISOString()
  };
}


// ======================================================
// CLOSE PAPER POSITIONS
// ======================================================

async function closePositions(
  env,
  now
) {

  const open =
    (
      await env.DB
        .prepare(
          `SELECT *
           FROM positions
           WHERE status='OPEN'`
        )
        .all()
    ).results;


  for (
    const pos of open
  ) {

    const openedMs =
      Date.parse(
        pos.opened_at
      );


    const raw =
      await candles(
        pos.symbol,
        "4h",
        20
      );


    let hit =
      null;


    for (
      const x of raw
    ) {

      if (
        x.closeTime <=
        openedMs
      ) {
        continue;
      }


      if (
        x.low <= pos.sl &&
        x.high >= pos.tp1
      ) {

        hit = {
          price:
            pos.sl,

          reason:
            "SL_FIRST_AMBIGUOUS"
        };

        break;

      } else if (
        x.low <= pos.sl
      ) {

        hit = {
          price:
            pos.sl,

          reason:
            "SL"
        };

        break;

      } else if (
        x.high >= pos.tp1
      ) {

        hit = {
          price:
            pos.tp1,

          reason:
            "TP1"
        };

        break;
      }
    }


    if (hit) {

      const pnl =
        (
          hit.price -
          pos.entry
        ) *
        pos.qty;


      await env.DB.batch([

        env.DB
          .prepare(
            `UPDATE portfolio
             SET cash_usdt =
                   cash_usdt + ?,
                 realized_pnl =
                   realized_pnl + ?,
                 updated_at = ?
             WHERE id = 1`
          )
          .bind(
            pos.qty *
              hit.price,

            pnl,

            now
          ),


        env.DB
          .prepare(
            `UPDATE positions
             SET status='CLOSED'
             WHERE id=?`
          )
          .bind(
            pos.id
          ),


        env.DB
          .prepare(
            `INSERT INTO trades
             (symbol,strategy,entry,exit,qty,pnl,
              reason,opened_at,closed_at)
             VALUES(?,?,?,?,?,?,?,?,?)`
          )
          .bind(
            pos.symbol,
            pos.strategy,
            pos.entry,
            hit.price,
            pos.qty,
            pnl,
            hit.reason,
            pos.opened_at,
            now
          )
      ]);
    }
  }
}


// ======================================================
// PAPER RUN
// ======================================================

async function run(
  env
) {

  const now =
    new Date().toISOString();


  await closePositions(
    env,
    now
  );


  const scans = [];


  for (
    const symbol of SYMBOLS
  ) {

    scans.push(
      await scan(symbol)
    );
  }


  for (
    const x of scans
  ) {

    const existing =
      await env.DB
        .prepare(
          `SELECT id
           FROM positions
           WHERE symbol=?
           AND status='OPEN'`
        )
        .bind(
          x.symbol
        )
        .first();


    if (
      x.decision === "BUY" &&
      !existing
    ) {

      const p =
        await env.DB
          .prepare(
            `SELECT *
             FROM portfolio
             WHERE id=1`
          )
          .first();


      const allocation =
        Math.min(
          p.cash_usdt,
          p.starting_usdt *
            0.20
        );


      if (
        allocation > 0 &&
        x.entry &&
        x.sl &&
        x.tp1
      ) {

        const qty =
          allocation /
          x.entry;


        await env.DB.batch([

          env.DB
            .prepare(
              `UPDATE portfolio
               SET cash_usdt =
                     cash_usdt - ?,
                   updated_at = ?
               WHERE id=1`
            )
            .bind(
              allocation,
              now
            ),


          env.DB
            .prepare(
              `INSERT INTO positions
               (symbol,strategy,entry,qty,
                sl,tp1,tp2,opened_at)
               VALUES(?,?,?,?,?,?,?,?)`
            )
            .bind(
              x.symbol,
              x.strategy,
              x.entry,
              qty,
              x.sl,
              x.tp1,
              x.tp2,
              now
            )
        ]);
      }
    }


    await env.DB
      .prepare(
        `INSERT INTO scans
         (symbol,timeframe,price,regime,
          strategy,decision,rsi,adx,atr,
          ema21,ema50,ema200,
          entry,sl,tp1,tp2,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        x.symbol,
        x.timeframe,
        x.price,
        x.regime,
        x.strategy,
        x.decision,
        x.rsi,
        x.adx,
        x.atr,
        x.ema21,
        x.ema50,
        x.ema200,
        x.entry,
        x.sl,
        x.tp1,
        x.tp2,
        now
      )
      .run();
  }


  const p =
    await env.DB
      .prepare(
        `SELECT *
         FROM portfolio
         WHERE id=1`
      )
      .first();


  const open =
    (
      await env.DB
        .prepare(
          `SELECT *
           FROM positions
           WHERE status='OPEN'`
        )
        .all()
    ).results;


  let equity =
    p.cash_usdt;


  for (
    const pos of open
  ) {

    const s =
      scans.find(
        x =>
          x.symbol ===
          pos.symbol
      );


    equity +=
      pos.qty *
      (
        s?.price ??
        pos.entry
      );
  }


  await env.DB
    .prepare(
      `INSERT INTO equity_history
       (equity,cash,realized_pnl,created_at)
       VALUES(?,?,?,?)`
    )
    .bind(
      equity,
      p.cash_usdt,
      p.realized_pnl,
      now
    )
    .run();


  return snapshot(
    env,
    now,
    scans,
    equity
  );
}


// ======================================================
// SNAPSHOT
// ======================================================

async function snapshot(
  env,
  now =
    new Date().toISOString(),
  scanCache = null,
  equity = null
) {

  const p =
    await env.DB
      .prepare(
        `SELECT *
         FROM portfolio
         WHERE id=1`
      )
      .first();


  const ps =
    (
      await env.DB
        .prepare(
          `SELECT *
           FROM positions
           WHERE status='OPEN'
           ORDER BY id`
        )
        .all()
    ).results;


  const ts =
    (
      await env.DB
        .prepare(
          `SELECT *
           FROM trades
           ORDER BY id DESC
           LIMIT 50`
        )
        .all()
    ).results;


  const sc =
    scanCache ??
    (
      await env.DB
        .prepare(
          `SELECT *
           FROM scans
           ORDER BY id DESC
           LIMIT 4`
        )
        .all()
    ).results;


  if (
    equity === null
  ) {

    equity =
      p.cash_usdt;


    for (
      const pos of ps
    ) {

      equity +=
        pos.qty *
        pos.entry;
    }
  }


  return {

    engine_version:
      ENGINE_VERSION,

    data_sources: [
      "Binance",
      "Kraken fallback"
    ],

    updated_at:
      now,

    portfolio: {
      ...p,
      equity
    },

    positions:
      ps,

    trades:
      ts,

    scans:
      sc
  };
}


// ======================================================
// BUDAPEST TIME
// ======================================================

function isBudapest08() {

  const hour =
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone:
          "Europe/Budapest",

        hour:
          "2-digit",

        hour12:
          false
      }
    ).format(
      new Date()
    );


  return hour === "08";
}


// ======================================================
// CLOUDFLARE WORKER
// ======================================================

export default {

  async fetch(
    req,
    env
  ) {

    const u =
      new URL(req.url);


    try {

      // ------------------------------------------------
      // MANUAL PAPER RUN
      // ------------------------------------------------

      if (
        req.method === "POST" &&
        u.pathname ===
          "/api/run"
      ) {

        return Response.json(
          await run(env)
        );
      }


      // ------------------------------------------------
      // CURRENT STATE
      // ------------------------------------------------

      if (
        req.method === "GET" &&
        u.pathname ===
          "/api/state"
      ) {

        return Response.json(
          await snapshot(env)
        );
      }


      // ------------------------------------------------
      // BACKTEST
      //
      // Example:
      //
      // /api/backtest
      // ?start=2020-10-01T00:00:00Z
      // &end=2021-05-31T23:59:59Z
      // &capital=500
      // ------------------------------------------------

      if (
        req.method === "GET" &&
        u.pathname ===
          "/api/backtest"
      ) {

        const start =
          u.searchParams.get(
            "start"
          );

        const end =
          u.searchParams.get(
            "end"
          );

        const capitalRaw =
          u.searchParams.get(
            "capital"
          );


        const capital =
          capitalRaw
            ? Number(
                capitalRaw
              )
            : 500;


        if (
          !start ||
          !end
        ) {

          return Response.json(
            {
              error:
                "Missing start or end date",

              example:
                "/api/backtest?start=2020-10-01T00:00:00Z&end=2021-05-31T23:59:59Z&capital=500"
            },

            {
              status: 400
            }
          );
        }


        const result =
          await backtest(
            start,
            end,
            capital
          );


        return Response.json(
          result
        );
      }


      // ------------------------------------------------
      // WEBSITE
      // ------------------------------------------------

      return env.ASSETS.fetch(
        req
      );


    } catch (e) {

      return Response.json(

        {
          error:
            String(e),

          engine_version:
            ENGINE_VERSION
        },

        {
          status: 500
        }
      );
    }
  },


  // ====================================================
  // AUTOMATIC SCHEDULE
  // ====================================================

  async scheduled(
    event,
    env,
    ctx
  ) {

    if (
      isBudapest08()
    ) {

      ctx.waitUntil(
        run(env)
      );
    }
  }
};    let d = a[i] - a[i - 1];

    g += Math.max(d, 0);
    l += Math.max(-d, 0);
  }

  let ag = g / p;
  let al = l / p;

  for (let i = p + 1; i < a.length; i++) {
    let d = a[i] - a[i - 1];

    ag = (ag * (p - 1) + Math.max(d, 0)) / p;
    al = (al * (p - 1) + Math.max(-d, 0)) / p;
  }

  return al === 0
    ? (ag === 0 ? 50 : 100)
    : 100 - 100 / (1 + ag / al);
}


function atr(h, l, c, p = 14) {
  let t = [];

  for (let i = 1; i < c.length; i++) {
    t.push(
      Math.max(
        h[i] - l[i],
        Math.abs(h[i] - c[i - 1]),
        Math.abs(l[i] - c[i - 1])
      )
    );
  }

  let a =
    t.slice(0, p).reduce((x, y) => x + y, 0) / p;

  for (let i = p; i < t.length; i++) {
    a = (a * (p - 1) + t[i]) / p;
  }

  return a;
}


function adx(h, l, c, p = 14) {
  if (c.length < 2 * p + 2) return NaN;

  let tr = [];
  let pd = [];
  let md = [];

  for (let i = 1; i < c.length; i++) {
    let up = h[i] - h[i - 1];
    let dn = l[i - 1] - l[i];

    tr.push(
      Math.max(
        h[i] - l[i],
        Math.abs(h[i] - c[i - 1]),
        Math.abs(l[i] - c[i - 1])
      )
    );

    pd.push(
      up > dn && up > 0 ? up : 0
    );

    md.push(
      dn > up && dn > 0 ? dn : 0
    );
  }

  let ts =
    tr.slice(0, p).reduce((a, b) => a + b, 0);

  let ps =
    pd.slice(0, p).reduce((a, b) => a + b, 0);

  let ms =
    md.slice(0, p).reduce((a, b) => a + b, 0);

  let dx = [];

  for (let i = p; i < tr.length; i++) {
    ts = ts - ts / p + tr[i];
    ps = ps - ps / p + pd[i];
    ms = ms - ms / p + md[i];

    let pi = 100 * ps / ts;
    let mi = 100 * ms / ts;

    dx.push(
      100 * Math.abs(pi - mi) / (pi + mi || 1)
    );
  }

  if (dx.length < p) return NaN;

  let x =
    dx.slice(0, p).reduce((a, b) => a + b, 0) / p;

  for (let i = p; i < dx.length; i++) {
    x = (x * (p - 1) + dx[i]) / p;
  }

  return x;
}


// =========================
// DATA PARSING
// =========================

function parse(raw) {
  return raw.slice(0, -1).map(x => ({
    open: +x[1],
    high: +x[2],
    low: +x[3],
    close: +x[4],
    volume: +x[5],
    closeTime: +x[6]
  }));
}


// =========================
// MARKET DATA
// BINANCE -> KRAKEN FALLBACK
// =========================

async function candles(symbol, tf, limit = 300) {

  const interval =
    tf === "4h"
      ? 240
      : tf === "1d"
        ? 1440
        : null;

  if (!interval) {
    throw Error(`Unsupported timeframe ${tf}`);
  }

  const errors = [];


  // =========================
  // PRIMARY: BINANCE
  // =========================

  try {

    const u = new URL(BINANCE_API);

    u.searchParams.set("symbol", symbol);
    u.searchParams.set("interval", tf);
    u.searchParams.set("limit", String(limit));

    const r = await fetch(
      u.toString(),
      {
        headers: {
          "Accept": "application/json",
          "User-Agent": "CryptoDecisionEngine/0.6"
        }
      }
    );


    if (r.ok) {

      const data = await r.json();

      if (
        Array.isArray(data) &&
        data.length >= 50
      ) {
        return parse(data);
      }

      errors.push(
        `Binance ${symbol}: unexpected response`
      );

    } else {

      errors.push(
        `Binance ${symbol}: HTTP ${r.status}`
      );
    }

  } catch (e) {

    errors.push(
      `Binance ${symbol}: ${e.message}`
    );
  }


  // =========================
  // FALLBACK: KRAKEN
  // =========================

  try {

    const pair = KRAKEN_PAIRS[symbol];

    if (!pair) {
      throw Error(
        `No Kraken pair mapping for ${symbol}`
      );
    }


    const u = new URL(KRAKEN_API);

    u.searchParams.set("pair", pair);
    u.searchParams.set(
      "interval",
      String(interval)
    );


    const r = await fetch(
      u.toString(),
      {
        headers: {
          "Accept": "application/json",
          "User-Agent": "CryptoDecisionEngine/0.6"
        }
      }
    );


    if (!r.ok) {
      throw Error(`HTTP ${r.status}`);
    }


    const data = await r.json();


    if (
      data.error &&
      data.error.length
    ) {
      throw Error(
        data.error.join("; ")
      );
    }


    const key =
      Object.keys(data.result || {})
        .find(k => k !== "last");


    const rows =
      key
        ? data.result[key]
        : null;


    if (
      !Array.isArray(rows) ||
      rows.length < 50
    ) {
      throw Error(
        "insufficient OHLC data"
      );
    }


    // Kraken last row = current,
    // not-yet-closed candle.
    return rows
      .slice(0, -1)
      .map(x => ({
        open: +x[1],
        high: +x[2],
        low: +x[3],
        close: +x[4],
        volume: +x[6],
        closeTime:
          (+x[0] + interval * 60) * 1000
      }));


  } catch (e) {

    errors.push(
      `Kraken ${symbol}: ${e.message}`
    );
  }


  // =========================
  // BOTH FAILED
  // =========================

  throw Error(
    `Market data unavailable for ${symbol} (${tf}). ` +
    errors.join(" | ")
  );
}


// =========================
// SCAN ONE SYMBOL
// =========================

async function scan(symbol) {

  const [
    fourh,
    daily
  ] = await Promise.all([
    candles(symbol, "4h", 300),
    candles(symbol, "1d", 250)
  ]);


  // =========================
  // 4H DATA
  // =========================

  const c =
    fourh.map(x => x.close);

  const h =
    fourh.map(x => x.high);

  const l =
    fourh.map(x => x.low);

  const v =
    fourh.map(x => x.volume);


  // =========================
  // DAILY DATA
  // =========================

  const dc =
    daily.map(x => x.close);


  // =========================
  // DAILY REGIME
  // =========================

  const d21 =
    ema(dc, 21);

  const d50 =
    ema(dc, 50);

  const d200 =
    ema(dc, 200);


  const dailyBull =
    dc.at(-1) > d21 &&
    d21 > d50 &&
    d50 > d200;


  const dailyBear =
    dc.at(-1) < d21 &&
    d21 < d50 &&
    d50 < d200;


  const regime =
    dailyBull
      ? "BULL TREND"
      : dailyBear
        ? "BEAR TREND"
        : "RANGE / TRANSITION";


  // =========================
  // 4H INDICATORS
  // =========================

  const e21 =
    ema(c, 21);

  const e50 =
    ema(c, 50);

  const e200 =
    ema(c, 200);

  const R =
    rsi(c);

  const A =
    atr(h, l, c);

  const D =
    adx(h, l, c);

  const ve =
    ema(v, 20);

  const vr =
    v.at(-1) / ve;

  const dist =
    (c.at(-1) / e21 - 1) * 100;


  // =========================
  // 4H TREND
  // =========================

  const fourhBull =
    c.at(-1) > e21 &&
    e21 > e50 &&
    e50 > e200;


  // =========================
  // TREND PULLBACK SETUP
  // =========================

  const ok =
    dailyBull &&
    fourhBull &&
    R >= 48 &&
    R <= 65 &&
    dist <= 3.5 &&
    dist >= -1 &&
    vr >= 0.8 &&
    D > 25;


  let strategy =
    ok
      ? "TREND PULLBACK"
      : "NO TRADE";


  let decision =
    ok
      ? "BUY"
      : "NO TRADE";


  let entry = null;
  let sl = null;
  let tp1 = null;
  let tp2 = null;


  // =========================
  // ENTRY / SL / TP
  // =========================

  if (ok) {

    entry = e21;


    sl =
      Math.min(
        e21 - 1.8 * A,
        e50
      );


    if (sl >= entry) {

      strategy = "NO TRADE";
      decision = "NO TRADE";

    } else {

      const risk =
        entry - sl;


      tp1 =
        entry + 1.8 * risk;


      tp2 =
        entry + 3 * risk;
    }
  }


  return {

    symbol,

    timeframe: "4h",

    price: c.at(-1),

    regime,

    strategy,

    decision,

    rsi: R,

    adx: D,

    atr: A,

    ema21: e21,

    ema50: e50,

    ema200: e200,

    entry,

    sl,

    tp1,

    tp2,

    volumeRatio: vr,

    lastClosedCandleAt:
      new Date(
        fourh.at(-1).closeTime
      ).toISOString()
  };
}


// =========================
// CLOSE OPEN POSITIONS
// =========================

async function closePositions(
  env,
  now
) {

  const open =
    (
      await env.DB
        .prepare(
          "SELECT * FROM positions WHERE status='OPEN'"
        )
        .all()
    ).results;


  for (const pos of open) {

    const openedMs =
      Date.parse(pos.opened_at);


    const raw =
      await candles(
        pos.symbol,
        "4h",
        20
      );


    let hit = null;


    for (const x of raw) {

      if (x.closeTime <= openedMs) {
        continue;
      }


      // If both SL and TP1 were touched
      // inside the same candle, assume SL first.
      if (
        x.low <= pos.sl &&
        x.high >= pos.tp1
      ) {

        hit = {
          price: pos.sl,
          reason: "SL_FIRST_AMBIGUOUS"
        };

        break;
      }


      if (x.low <= pos.sl) {

        hit = {
          price: pos.sl,
          reason: "SL"
        };

        break;
      }


      if (x.high >= pos.tp1) {

        hit = {
          price: pos.tp1,
          reason: "TP1"
        };

        break;
      }
    }


    if (hit) {

      const pnl =
        (hit.price - pos.entry) *
        pos.qty;


      await env.DB.batch([

        env.DB
          .prepare(
            `UPDATE portfolio
             SET cash_usdt = cash_usdt + ?,
                 realized_pnl = realized_pnl + ?,
                 updated_at = ?
             WHERE id = 1`
          )
          .bind(
            pos.qty * hit.price,
            pnl,
            now
          ),


        env.DB
          .prepare(
            `UPDATE positions
             SET status='CLOSED'
             WHERE id=?`
          )
          .bind(pos.id),


        env.DB
          .prepare(
            `INSERT INTO trades
             (symbol,strategy,entry,exit,qty,pnl,reason,opened_at,closed_at)
             VALUES(?,?,?,?,?,?,?,?,?)`
          )
          .bind(
            pos.symbol,
            pos.strategy,
            pos.entry,
            hit.price,
            pos.qty,
            pnl,
            hit.reason,
            pos.opened_at,
            now
          )
      ]);
    }
  }
}


// =========================
// MAIN ENGINE
// =========================

async function run(env) {

  const now =
    new Date().toISOString();


  // First close existing positions.
  await closePositions(
    env,
    now
  );


  const scans = [];


  // Analyse all four coins.
  for (const symbol of SYMBOLS) {

    scans.push(
      await scan(symbol)
    );
  }


  // =========================
  // OPEN NEW POSITIONS
  // =========================

  for (const x of scans) {

    const existing =
      await env.DB
        .prepare(
          `SELECT id
           FROM positions
           WHERE symbol=?
           AND status='OPEN'`
        )
        .bind(x.symbol)
        .first();


    if (
      x.decision === "BUY" &&
      !existing
    ) {

      const p =
        await env.DB
          .prepare(
            "SELECT * FROM portfolio WHERE id=1"
          )
          .first();


      // Maximum 20% of original capital
      // per position.
      const allocation =
        Math.min(
          p.cash_usdt,
          p.starting_usdt * 0.20
        );


      if (
        allocation > 0 &&
        x.entry &&
        x.sl &&
        x.tp1
      ) {

        const qty =
          allocation / x.entry;


        await env.DB.batch([

          env.DB
            .prepare(
              `UPDATE portfolio
               SET cash_usdt = cash_usdt - ?,
                   updated_at = ?
               WHERE id=1`
            )
            .bind(
              allocation,
              now
            ),


          env.DB
            .prepare(
              `INSERT INTO positions
               (symbol,strategy,entry,qty,sl,tp1,tp2,opened_at)
               VALUES(?,?,?,?,?,?,?,?)`
            )
            .bind(
              x.symbol,
              x.strategy,
              x.entry,
              qty,
              x.sl,
              x.tp1,
              x.tp2,
              now
            )
        ]);
      }
    }


    // =========================
    // SAVE SCAN
    // =========================

    await env.DB
      .prepare(
        `INSERT INTO scans
         (symbol,timeframe,price,regime,strategy,decision,
          rsi,adx,atr,ema21,ema50,ema200,
          entry,sl,tp1,tp2,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        x.symbol,
        x.timeframe,
        x.price,
        x.regime,
        x.strategy,
        x.decision,
        x.rsi,
        x.adx,
        x.atr,
        x.ema21,
        x.ema50,
        x.ema200,
        x.entry,
        x.sl,
        x.tp1,
        x.tp2,
        now
      )
      .run();
  }


  // =========================
  // EQUITY
  // =========================

  const p =
    await env.DB
      .prepare(
        "SELECT * FROM portfolio WHERE id=1"
      )
      .first();


  const open =
    (
      await env.DB
        .prepare(
          `SELECT *
           FROM positions
           WHERE status='OPEN'`
        )
        .all()
    ).results;


  let equity =
    p.cash_usdt;


  for (const pos of open) {

    const s =
      scans.find(
        x => x.symbol === pos.symbol
      );


    equity +=
      pos.qty *
      (s?.price ?? pos.entry);
  }


  await env.DB
    .prepare(
      `INSERT INTO equity_history
       (equity,cash,realized_pnl,created_at)
       VALUES(?,?,?,?)`
    )
    .bind(
      equity,
      p.cash_usdt,
      p.realized_pnl,
      now
    )
    .run();


  return await snapshot(
    env,
    now,
    scans,
    equity
  );
}


// =========================
// SNAPSHOT
// =========================

async function snapshot(
  env,
  now = new Date().toISOString(),
  scanCache = null,
  equity = null
) {

  const p =
    await env.DB
      .prepare(
        "SELECT * FROM portfolio WHERE id=1"
      )
      .first();


  const ps =
    (
      await env.DB
        .prepare(
          `SELECT *
           FROM positions
           WHERE status='OPEN'
           ORDER BY id`
        )
        .all()
    ).results;


  const ts =
    (
      await env.DB
        .prepare(
          `SELECT *
           FROM trades
           ORDER BY id DESC
           LIMIT 50`
        )
        .all()
    ).results;


  const sc =
    scanCache ??
    (
      await env.DB
        .prepare(
          `SELECT *
           FROM scans
           ORDER BY id DESC
           LIMIT 4`
        )
        .all()
    ).results;


  if (equity === null) {

    equity =
      p.cash_usdt;


    for (const pos of ps) {

      equity +=
        pos.qty *
        pos.entry;
    }
  }


  return {

    engine_version:
      ENGINE_VERSION,

    data_sources: [
      "Binance",
      "Kraken fallback"
    ],

    updated_at:
      now,

    portfolio: {
      ...p,
      equity
    },

    positions:
      ps,

    trades:
      ts,

    scans:
      sc
  };
}


// =========================
// BUDAPEST TIME
// =========================

function isBudapest08() {

  const hour =
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone: "Europe/Budapest",
        hour: "2-digit",
        hour12: false
      }
    ).format(new Date());


  return hour === "08";
}


// =========================
// CLOUDFLARE WORKER
// =========================

export default {

  async fetch(req, env) {

    const u =
      new URL(req.url);


    try {

      // Manual analysis
      if (
        req.method === "POST" &&
        u.pathname === "/api/run"
      ) {

        return Response.json(
          await run(env)
        );
      }


      // Current state
      if (
        req.method === "GET" &&
        u.pathname === "/api/state"
      ) {

        return Response.json(
          await snapshot(env)
        );
      }


      // Website
      return env.ASSETS.fetch(req);


    } catch (e) {

      return Response.json(
        {
          error: String(e),
          engine_version:
            ENGINE_VERSION
        },
        {
          status: 500
        }
      );
    }
  },


  // =========================
  // AUTOMATIC SCHEDULE
  // =========================

  async scheduled(
    event,
    env,
    ctx
  ) {

    if (isBudapest08()) {

      ctx.waitUntil(
        run(env)
      );
    }
  }
};
