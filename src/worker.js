const ENGINE_VERSION = "06";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"];

const BINANCE_API = "https://data-api.binance.vision/api/v3/klines";
const KRAKEN_API = "https://api.kraken.com/0/public/OHLC";

const KRAKEN_PAIRS = {
  BTCUSDT: "XBTUSD",
  ETHUSDT: "ETHUSD",
  SOLUSDT: "SOLUSD",
  XRPUSDT: "XRPUSD"
};


// =========================
// INDICATORS
// =========================

function ema(a, p) {
  let k = 2 / (p + 1);
  let e = a[0];

  for (let i = 1; i < a.length; i++) {
    e = a[i] * k + e * (1 - k);
  }

  return e;
}


function rsi(a, p = 14) {
  let g = 0;
  let l = 0;

  for (let i = 1; i <= p; i++) {
    let d = a[i] - a[i - 1];

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
