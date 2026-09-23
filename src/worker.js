
const ENGINE_VERSION = "08.0";
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"];

const BINANCE_API = "https://data-api.binance.vision/api/v3/klines";
const KRAKEN_API = "https://api.kraken.com/0/public/OHLC";
const KRAKEN_PAIRS = {
  BTCUSDT: "XBTUSD",
  ETHUSDT: "ETHUSD",
  SOLUSDT: "SOLUSD",
  XRPUSDT: "XRPUSD"
};

const COINBASE_PRODUCTS = {
  BTCUSDT: "BTC-USD",
  ETHUSDT: "ETH-USD",
  SOLUSDT: "SOL-USD",
  XRPUSDT: "XRP-USD"
};

async function ensureCandleTable(env){
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS historical_candles (
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      open_time INTEGER NOT NULL,
      close_time INTEGER NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL NOT NULL,
      PRIMARY KEY(symbol,timeframe,open_time)
    )
  `).run();
}

async function loadCoinbase1hChunk(env,symbol,startMs,endMs){
  const product=COINBASE_PRODUCTS[symbol];
  if(!product)throw Error(`Unsupported symbol ${symbol}`);

  const maxSpan=300*3600*1000;
  const chunkEnd=Math.min(endMs,startMs+maxSpan-1);

  const u=new URL(`https://api.exchange.coinbase.com/products/${product}/candles`);
  u.searchParams.set("granularity","3600");
  u.searchParams.set("start",new Date(startMs).toISOString());
  u.searchParams.set("end",new Date(chunkEnd).toISOString());

  const r=await fetch(u.toString(),{
    headers:{
      "Accept":"application/json",
      "User-Agent":"CryptoDecisionEngine/0.8"
    }
  });

  if(!r.ok)throw Error(`Coinbase HTTP ${r.status}`);

  const data=await r.json();
  if(!Array.isArray(data))throw Error("Coinbase returned unexpected response");

  const rows=[];
  for(const x of data){
    const openTime=+x[0]*1000;
    if(openTime<startMs||openTime>endMs)continue;

    rows.push({
      symbol,
      timeframe:"1h",
      openTime,
      closeTime:openTime+3600000-1,
      open:+x[3],
      high:+x[2],
      low:+x[1],
      close:+x[4],
      volume:+x[5]
    });
  }

  if(!rows.length)throw Error("Coinbase returned no candles for requested chunk");

  const stmts=rows.map(x=>env.DB.prepare(`
    INSERT OR REPLACE INTO historical_candles
    (symbol,timeframe,open_time,close_time,open,high,low,close,volume)
    VALUES(?,?,?,?,?,?,?,?,?)
  `).bind(
    x.symbol,x.timeframe,x.openTime,x.closeTime,
    x.open,x.high,x.low,x.close,x.volume
  ));

  await env.DB.batch(stmts);

  const next=Math.max(...rows.map(x=>x.openTime))+3600000;

  return {
    symbol,
    inserted:rows.length,
    start:new Date(Math.min(...rows.map(x=>x.openTime))).toISOString(),
    end:new Date(Math.max(...rows.map(x=>x.openTime))).toISOString(),
    next:new Date(next).toISOString(),
    done:next>endMs
  };
}

async function loadHistoricalChunk(env,params){
  await ensureCandleTable(env);

  const symbol=params.symbol;
  const start=Date.parse(params.start);
  const end=Date.parse(params.end);

  if(!COINBASE_PRODUCTS[symbol])throw Error("Invalid symbol");
  if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end){
    throw Error("Invalid start/end");
  }

  return await loadCoinbase1hChunk(env,symbol,start,end);
}

async function historicalRowsFromD1(env,symbol,startMs,endMs){
  await ensureCandleTable(env);

  const result=await env.DB.prepare(`
    SELECT open_time,close_time,open,high,low,close,volume
    FROM historical_candles
    WHERE symbol=? AND timeframe='1h'
      AND open_time>=? AND open_time<=?
    ORDER BY open_time
  `).bind(symbol,startMs,endMs).all();

  return result.results.map(x=>({
    openTime:+x.open_time,
    closeTime:+x.close_time,
    open:+x.open,
    high:+x.high,
    low:+x.low,
    close:+x.close,
    volume:+x.volume
  }));
}

function aggregateHours(rows,hours){
  const span=hours*3600000;
  const out=[];
  let bucket=null;

  for(const x of rows){
    const key=Math.floor(x.openTime/span)*span;

    if(!bucket||bucket.openTime!==key){
      if(bucket)out.push(bucket);
      bucket={
        openTime:key,
        closeTime:key+span-1,
        open:x.open,
        high:x.high,
        low:x.low,
        close:x.close,
        volume:x.volume
      };
    }else{
      bucket.high=Math.max(bucket.high,x.high);
      bucket.low=Math.min(bucket.low,x.low);
      bucket.close=x.close;
      bucket.volume+=x.volume;
    }
  }

  if(bucket)out.push(bucket);
  return out;
}

function aggregateDaily(rows){
  const span=24*3600000;
  const out=[];
  let bucket=null;

  for(const x of rows){
    const key=Math.floor(x.openTime/span)*span;

    if(!bucket||bucket.openTime!==key){
      if(bucket)out.push(bucket);
      bucket={
        openTime:key,
        closeTime:key+span-1,
        open:x.open,
        high:x.high,
        low:x.low,
        close:x.close,
        volume:x.volume
      };
    }else{
      bucket.high=Math.max(bucket.high,x.high);
      bucket.low=Math.min(bucket.low,x.low);
      bucket.close=x.close;
      bucket.volume+=x.volume;
    }
  }

  if(bucket)out.push(bucket);
  return out;
}

async function backtestFromD1(env,params){
  const start=Date.parse(params.start);
  const end=Date.parse(params.end);
  const capital=Number(params.capital||500);

  if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end){
    throw Error("Invalid start/end");
  }
  if(!Number.isFinite(capital)||capital<=0){
    throw Error("Invalid capital");
  }

  const warmup=start-220*24*3600000;
  const markets={};

  for(const symbol of SYMBOLS){
    const raw=await historicalRowsFromD1(env,symbol,warmup,end);

    if(raw.length<300){
      throw Error(
        `Not enough D1 data for ${symbol}. Load ${symbol} first.`
      );
    }

    markets[symbol]={
      fourh:aggregateHours(raw,4),
      daily:aggregateDaily(raw)
    };
  }

  // Reuse the existing strategy/backtest engine, but feed it from D1.
  // The engine below expects historical data in the same candle shape.
  return await runBacktestOnMarkets(markets,start,end,capital);
}

function ema(a,p){let k=2/(p+1),e=a[0];for(let i=1;i<a.length;i++)e=a[i]*k+e*(1-k);return e}
function rsi(a,p=14){let g=0,l=0;for(let i=1;i<=p;i++){let d=a[i]-a[i-1];g+=Math.max(d,0);l+=Math.max(-d,0)}let ag=g/p,al=l/p;for(let i=p+1;i<a.length;i++){let d=a[i]-a[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p}return al===0?(ag===0?50:100):100-100/(1+ag/al)}
function atr(h,l,c,p=14){let t=[];for(let i=1;i<c.length;i++)t.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));let a=t.slice(0,p).reduce((x,y)=>x+y,0)/p;for(let i=p;i<t.length;i++)a=(a*(p-1)+t[i])/p;return a}
function adx(h,l,c,p=14){if(c.length<2*p+2)return NaN;let tr=[],pd=[],md=[];for(let i=1;i<c.length;i++){let up=h[i]-h[i-1],dn=l[i-1]-l[i];tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));pd.push(up>dn&&up>0?up:0);md.push(dn>up&&dn>0?dn:0)}let ts=tr.slice(0,p).reduce((a,b)=>a+b,0),ps=pd.slice(0,p).reduce((a,b)=>a+b,0),ms=md.slice(0,p).reduce((a,b)=>a+b,0),dx=[];for(let i=p;i<tr.length;i++){ts=ts-ts/p+tr[i];ps=ps-ps/p+pd[i];ms=ms-ms/p+md[i];let pi=100*ps/ts,mi=100*ms/ts;dx.push(100*Math.abs(pi-mi)/(pi+mi||1))}if(dx.length<p)return NaN;let x=dx.slice(0,p).reduce((a,b)=>a+b,0)/p;for(let i=p;i<dx.length;i++)x=(x*(p-1)+dx[i])/p;return x}

function parseBinance(raw){
  return raw.map(x=>({open:+x[1],high:+x[2],low:+x[3],close:+x[4],volume:+x[5],openTime:+x[0],closeTime:+x[6]}));
}

async function fetchRange(symbol,tf,startMs,endMs){
  const errors=[];
  const stepMs=tf==="4h"?4*3600000:24*3600000;

  // Binance is currently returning HTTP 403 from the Cloudflare Worker,
  // so for historical backtests we use CryptoCompare CCCAGG first.
  // CryptoCompare supports hourly history with aggregate=4 for 4H
  // candles and up to 2000 returned points per request.
  try{
    const fsym={
      BTCUSDT:"BTC",
      ETHUSDT:"ETH",
      SOLUSDT:"SOL",
      XRPUSDT:"XRP"
    }[symbol];

    if(!fsym)throw Error(`No CryptoCompare symbol mapping for ${symbol}`);

    const endpoint=tf==="4h"?"histohour":"histoday";
    const aggregate=tf==="4h"?4:1;
    const limit=2000;
    const rows=[];
    let toTs=Math.floor(endMs/1000);
    const startSec=Math.floor(startMs/1000);

    for(let guard=0;guard<20;guard++){
      const u=new URL(`https://min-api.cryptocompare.com/data/v2/${endpoint}`);
      u.searchParams.set("fsym",fsym);
      u.searchParams.set("tsym","USD");
      u.searchParams.set("limit",String(limit));
      u.searchParams.set("aggregate",String(aggregate));
      u.searchParams.set("toTs",String(toTs));
      u.searchParams.set("tryConversion","true");

      const r=await fetch(u.toString(),{
        headers:{
          "Accept":"application/json",
          "User-Agent":"CryptoDecisionEngine/0.7.3"
        }
      });

      if(!r.ok)throw Error(`CryptoCompare HTTP ${r.status}`);

      const payload=await r.json();
      if(payload.Response!=="Success"){
        throw Error(payload.Message||"CryptoCompare API error");
      }

      const data=Array.isArray(payload.Data?.Data)?payload.Data.Data:[];
      if(!data.length)break;

      let oldest=Infinity;

      for(const x of data){
        const openTime=+x.time*1000;
        const closeTime=openTime+stepMs-1;
        oldest=Math.min(oldest,openTime);

        if(
          openTime>=startMs &&
          closeTime<=endMs
        ){
          rows.push({
            open:+x.open,
            high:+x.high,
            low:+x.low,
            close:+x.close,
            volume:+(x.volumefrom??0),
            openTime,
            closeTime
          });
        }
      }

      if(oldest<=startMs)break;
      if(oldest>=toTs*1000)break;

      toTs=Math.floor(oldest/1000)-1;

      // The returned batch is already close to the maximum historical
      // window, so only a small number of requests should be needed.
    }

    if(rows.length>=50)return dedupe(rows);

    throw Error(`CryptoCompare returned only ${rows.length} usable candles`);
  }catch(e){
    errors.push(`CryptoCompare: ${e.message}`);
  }

  // Secondary fallback: OKX historical candles.
  try{
    const products={
      BTCUSDT:"BTC-USDT",
      ETHUSDT:"ETH-USDT",
      SOLUSDT:"SOL-USDT",
      XRPUSDT:"XRP-USDT"
    };

    const instId=products[symbol];
    if(!instId)throw Error(`No OKX product mapping for ${symbol}`);

    const bar=tf==="4h"?"4H":"1Dutc";
    let after=endMs+stepMs;
    const rows=[];
    const seen=new Set();

    for(let guard=0;guard<100;guard++){
      const u=new URL("https://www.okx.com/api/v5/market/history-candles");
      u.searchParams.set("instId",instId);
      u.searchParams.set("bar",bar);
      u.searchParams.set("after",String(after));
      u.searchParams.set("limit","100");

      const r=await fetch(u.toString(),{
        headers:{
          "Accept":"application/json",
          "User-Agent":"CryptoDecisionEngine/0.7.3"
        }
      });

      if(!r.ok)throw Error(`OKX HTTP ${r.status}`);

      const payload=await r.json();
      if(payload.code!=="0"){
        throw Error(`OKX ${payload.code}: ${payload.msg||"API error"}`);
      }

      const data=Array.isArray(payload.data)?payload.data:[];
      if(!data.length)break;

      let oldest=Infinity;

      for(const x of data){
        const openTime=+x[0];
        oldest=Math.min(oldest,openTime);
        const closeTime=openTime+stepMs-1;

        if(
          openTime>=startMs &&
          closeTime<=endMs &&
          !seen.has(openTime)
        ){
          seen.add(openTime);
          rows.push({
            open:+x[1],
            high:+x[2],
            low:+x[3],
            close:+x[4],
            volume:+x[5],
            openTime,
            closeTime
          });
        }
      }

      if(oldest<=startMs)break;
      if(oldest>=after)break;
      after=oldest-1;
    }

    if(rows.length>=50)return dedupe(rows);

    throw Error(`OKX returned only ${rows.length} usable candles`);
  }catch(e){
    errors.push(`OKX: ${e.message}`);
  }

  throw Error(
    `Historical data unavailable for ${symbol}/${tf}: ${errors.join(" | ")}`
  );
}
function dedupe(rows){
  const m=new Map();
  for(const x of rows)m.set(x.openTime,x);
  return [...m.values()].sort((a,b)=>a.openTime-b.openTime);
}

async function candles(symbol,tf,limit=300){
  const interval=tf==="4h"?240:tf==="1d"?1440:null;
  if(!interval)throw Error(`Unsupported timeframe ${tf}`);
  const errors=[];
  try{
    const u=new URL(BINANCE_API);
    u.searchParams.set("symbol",symbol);
    u.searchParams.set("interval",tf);
    u.searchParams.set("limit",String(limit));
    const r=await fetch(u.toString(),{headers:{"Accept":"application/json","User-Agent":"CryptoDecisionEngine/0.7"}});
    if(r.ok){
      const d=await r.json();
      if(Array.isArray(d)&&d.length>=50)return parseBinance(d.slice(0,-1));
      errors.push(`Binance ${symbol}: unexpected response`);
    }else errors.push(`Binance ${symbol}: HTTP ${r.status}`);
  } catch (e){errors.push(`Binance ${symbol}: ${e.message}`)}

  try{
    const pair=KRAKEN_PAIRS[symbol];
    const u=new URL(KRAKEN_API);u.searchParams.set("pair",pair);u.searchParams.set("interval",String(interval));
    const r=await fetch(u.toString(),{headers:{"Accept":"application/json","User-Agent":"CryptoDecisionEngine/0.7"}});
    if(!r.ok)throw Error(`HTTP ${r.status}`);
    const d=await r.json();
    if(d.error?.length)throw Error(d.error.join("; "));
    const key=Object.keys(d.result||{}).find(k=>k!=="last"), rows=key?d.result[key]:null;
    if(!Array.isArray(rows)||rows.length<50)throw Error("insufficient OHLC data");
    return rows.slice(0,-1).map(x=>({open:+x[1],high:+x[2],low:+x[3],close:+x[4],volume:+x[6],openTime:+x[0]*1000,closeTime:(+x[0]+interval*60)*1000}));
  } catch (e){errors.push(`Kraken ${symbol}: ${e.message}`)}
  throw Error(`Market data unavailable for ${symbol} (${tf}). ${errors.join(" | ")}`);
}

function indicatorsAt(fourh,i){
  const rows=fourh.slice(0,i+1);
  const c=rows.map(x=>x.close),h=rows.map(x=>x.high),l=rows.map(x=>x.low),v=rows.map(x=>x.volume);
  if(c.length<220)return null;
  const e21=ema(c,21),e50=ema(c,50),e200=ema(c,200),R=rsi(c),A=atr(h,l,c),D=adx(h,l,c),ve=ema(v,20);
  const vr=v.at(-1)/ve,dist=(c.at(-1)/e21-1)*100;
  return {price:c.at(-1),e21,e50,e200,R,A,D,vr,dist};
}

function dailyAt(daily,t){
  let lo=0,hi=daily.length-1,best=-1;
  while(lo<=hi){const m=(lo+hi)>>1;if(daily[m].closeTime<=t){best=m;lo=m+1}else hi=m-1}
  return best;
}

function signalAt(fourh,daily,i){
  const q=indicatorsAt(fourh,i);
  if(!q)return null;
  const di=dailyAt(daily,fourh[i].closeTime);
  if(di<0||di<200)return null;
  const dc=daily.slice(0,di+1).map(x=>x.close);
  const d21=ema(dc,21),d50=ema(dc,50),d200=ema(dc,200);
  const dailyBull=dc.at(-1)>d21&&d21>d50&&d50>d200;
  const fourhBull=q.price>q.e21&&q.e21>q.e50&&q.e50>q.e200;
  const ok=dailyBull&&fourhBull&&q.R>=48&&q.R<=65&&q.dist<=3.5&&q.dist>=-1&&q.vr>=0.8&&q.D>25;
  if(!ok)return null;
  const entry=q.e21;
  const sl=Math.min(q.e21-1.8*q.A,q.e50);
  if(sl>=entry)return null;
  const risk=entry-sl;
  return {entry,sl,tp1:entry+1.8*risk,tp2:entry+3*risk,rsi:q.R,adx:q.D,atr:q.A,volumeRatio:q.vr,signalTime:fourh[i].closeTime,signalIndex:i};
}

function simulateSymbol(symbol,fourh,daily,startMs,endMs,capital){
  const trades=[];
  let cash=capital;
  let position=null;
  for(let i=0;i<fourh.length-1;i++){
    const bar=fourh[i];
    if(bar.closeTime<startMs||bar.openTime>endMs)continue;

    if(position){
      let hit=null;
      if(bar.openTime>position.entryTime){
        if(bar.low<=position.sl&&bar.high>=position.tp1)hit={price:position.sl,reason:"SL_FIRST_AMBIGUOUS"};
        else if(bar.low<=position.sl)hit={price:position.sl,reason:"SL"};
        else if(bar.high>=position.tp1)hit={price:position.tp1,reason:"TP1"};
      }
      if(hit){
        const pnl=(hit.price-position.entry)*position.qty;
        cash+=position.qty*hit.price;
        trades.push({...position,exitTime:bar.openTime,exit:hit.price,pnl,reason:hit.reason,holdingHours:(bar.openTime-position.entryTime)/3600000,result:pnl>=0?"WIN":"LOSS",R:pnl/(position.entry-position.sl)/position.qty});
        position=null;
      }
    }

    if(!position&&bar.closeTime<endMs){
      const sig=signalAt(fourh,daily,i);
      if(sig){
        const next=fourh[i+1];
        const entry=next.open;
        const sl=sig.sl;
        if(entry>sl){
          const allocation=Math.min(cash,capital*0.20);
          if(allocation>0){
            const qty=allocation/entry;
            position={symbol,strategy:"TREND PULLBACK",entry,signalEntry:sig.entry,qty,sl,tp1:entry+1.8*(entry-sl),tp2:entry+3*(entry-sl),entryTime:next.openTime,signalTime:sig.signalTime,rsi:sig.rsi,adx:sig.adx,atr:sig.atr,volumeRatio:sig.volumeRatio};
            cash-=allocation;
          }
        }
      }
    }
  }
  if(position){
    const last=fourh.filter(x=>x.closeTime<=endMs).at(-1);
    if(last){
      const exit=last.close;
      const pnl=(exit-position.entry)*position.qty;
      cash+=position.qty*exit;
      trades.push({...position,exitTime:last.closeTime,exit,pnl,reason:"END_OF_TEST",holdingHours:(last.closeTime-position.entryTime)/3600000,result:pnl>=0?"WIN":"LOSS",R:pnl/(position.entry-position.sl)/position.qty});
    }
  }
  return {trades,cash};
}

async function runBacktestOnMarkets(markets,startMs,endMs,capital){
  const series={};
  for(const symbol of SYMBOLS){
    series[symbol]=markets[symbol].fourh
      .filter(x=>x.closeTime>=startMs-220*24*3600000 && x.closeTime<=endMs);
  }

  const daily={};
  for(const symbol of SYMBOLS){
    daily[symbol]=markets[symbol].daily;
  }

  const positions=[];
  const trades=[];
  let cash=capital;
  let realized=0;
  let peak=capital;
  let maxDrawdown=0;

  const times=[...new Set(
    SYMBOLS.flatMap(s=>series[s].map(x=>x.closeTime))
  )].sort((a,b)=>a-b);

  const indexByTime={};
  for(const symbol of SYMBOLS){
    indexByTime[symbol]=new Map(
      series[symbol].map((x,i)=>[x.closeTime,i])
    );
  }

  for(const t of times){
    if(t<startMs)continue;

    // First evaluate existing positions using only candles after entry.
    for(let p=positions.length-1;p>=0;p--){
      const pos=positions[p];
      if(pos.status!=="OPEN")continue;

      const idx=indexByTime[pos.symbol].get(t);
      if(idx===undefined)continue;

      const c=series[pos.symbol][idx];
      if(c.closeTime<=pos.openedAt)continue;

      let hit=null;

      if(c.low<=pos.sl && c.high>=pos.tp1){
        hit={price:pos.sl,reason:"SL_FIRST_AMBIGUOUS"};
      }else if(c.low<=pos.sl){
        hit={price:pos.sl,reason:"SL"};
      }else if(c.high>=pos.tp1){
        hit={price:pos.tp1,reason:"TP1"};
      }

      if(hit){
        const pnl=(hit.price-pos.entry)*pos.qty;
        cash+=pos.qty*hit.price;
        realized+=pnl;

        pos.status="CLOSED";
        pos.closedAt=t;
        pos.exit=hit.price;
        pos.pnl=pnl;
        pos.reason=hit.reason;

        trades.push({
          symbol:pos.symbol,
          strategy:"TREND PULLBACK",
          entry:pos.entry,
          exit:hit.price,
          qty:pos.qty,
          pnl,
          reason:hit.reason,
          openedAt:pos.openedAt,
          closedAt:t,
          durationHours:(t-pos.openedAt)/3600000
        });
      }
    }

    // Then generate new signals.
    for(const symbol of SYMBOLS){
      if(positions.some(p=>p.symbol===symbol&&p.status==="OPEN"))continue;

      const idx=indexByTime[symbol].get(t);
      if(idx===undefined)continue;

      const signal=signalAt(series[symbol],daily[symbol],idx);
      if(!signal)continue;

      const allocation=Math.min(cash,capital*0.20);
      if(allocation<=0)continue;

      const qty=allocation/signal.entry;
      cash-=allocation;

      positions.push({
        symbol,
        status:"OPEN",
        entry:signal.entry,
        qty,
        sl:signal.sl,
        tp1:signal.tp1,
        tp2:signal.tp2,
        openedAt:t
      });
    }

    let equity=cash;

    for(const pos of positions){
      if(pos.status!=="OPEN")continue;

      const idx=indexByTime[pos.symbol].get(t);
      const mark=idx===undefined?pos.entry:series[pos.symbol][idx].close;
      equity+=pos.qty*mark;
    }

    peak=Math.max(peak,equity);
    const dd=peak>0?(equity/peak-1)*100:0;
    maxDrawdown=Math.min(maxDrawdown,dd);
  }

  // Close remaining positions at final available close.
  for(const pos of positions){
    if(pos.status!=="OPEN")continue;

    const rows=series[pos.symbol];
    const c=rows.filter(x=>x.closeTime<=endMs).at(-1);
    if(!c)continue;

    const pnl=(c.close-pos.entry)*pos.qty;
    cash+=pos.qty*c.close;
    realized+=pnl;

    pos.status="CLOSED";
    pos.closedAt=c.closeTime;
    pos.exit=c.close;
    pos.pnl=pnl;
    pos.reason="END_OF_TEST";

    trades.push({
      symbol:pos.symbol,
      strategy:"TREND PULLBACK",
      entry:pos.entry,
      exit:c.close,
      qty:pos.qty,
      pnl,
      reason:"END_OF_TEST",
      openedAt:pos.openedAt,
      closedAt:c.closeTime,
      durationHours:(c.closeTime-pos.openedAt)/3600000
    });
  }

  const wins=trades.filter(x=>x.pnl>0);
  const losses=trades.filter(x=>x.pnl<0);
  const totalPnl=realized;
  const finalEquity=cash;

  const bySymbol={};
  for(const symbol of SYMBOLS){
    const ts=trades.filter(x=>x.symbol===symbol);
    bySymbol[symbol]={
      trades:ts.length,
      wins:ts.filter(x=>x.pnl>0).length,
      losses:ts.filter(x=>x.pnl<0).length,
      pnl:ts.reduce((a,x)=>a+x.pnl,0)
    };
  }

  return {
    engine_version:ENGINE_VERSION,
    data_source:"Coinbase 1H stored in Cloudflare D1; 4H and 1D aggregated locally",
    start:new Date(startMs).toISOString(),
    end:new Date(endMs).toISOString(),
    startingCapital:capital,
    finalEquity,
    totalPnl,
    returnPct:(finalEquity/capital-1)*100,
    trades:trades.length,
    wins:wins.length,
    losses:losses.length,
    winRate:trades.length?wins.length/trades.length*100:0,
    maxDrawdownPct:maxDrawdown,
    bySymbol,
    tradeList:trades
  };
}

async function closePositions(env,now){
  const open=(await env.DB.prepare("SELECT * FROM positions WHERE status='OPEN'").all()).results;
  for(const pos of open){
    const raw=await candles(pos.symbol,"4h",20);let hit=null;
    for(const x of raw){
      if(x.closeTime<=Date.parse(pos.opened_at))continue;
      if(x.low<=pos.sl&&x.high>=pos.tp1){hit={price:pos.sl,reason:"SL_FIRST_AMBIGUOUS"};break}
      if(x.low<=pos.sl){hit={price:pos.sl,reason:"SL"};break}
      if(x.high>=pos.tp1){hit={price:pos.tp1,reason:"TP1"};break}
    }
    if(hit){
      const pnl=(hit.price-pos.entry)*pos.qty;
      await env.DB.batch([
        env.DB.prepare("UPDATE portfolio SET cash_usdt=cash_usdt+?,realized_pnl=realized_pnl+?,updated_at=? WHERE id=1").bind(pos.qty*hit.price,pnl,now),
        env.DB.prepare("UPDATE positions SET status='CLOSED' WHERE id=?").bind(pos.id),
        env.DB.prepare("INSERT INTO trades(symbol,strategy,entry,exit,qty,pnl,reason,opened_at,closed_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(pos.symbol,pos.strategy,pos.entry,hit.price,pos.qty,pnl,hit.reason,pos.opened_at,now)
      ]);
    }
  }
}

async function run(env){
  const now=new Date().toISOString();
  await closePositions(env,now);
  const scans=[];
  for(const symbol of SYMBOLS)scans.push(await scan(symbol));
  for(const x of scans){
    const existing=await env.DB.prepare("SELECT id FROM positions WHERE symbol=? AND status='OPEN'").bind(x.symbol).first();
    if(x.decision==="BUY"&&!existing){
      const p=await env.DB.prepare("SELECT * FROM portfolio WHERE id=1").first();
      const allocation=Math.min(p.cash_usdt,p.starting_usdt*0.20);
      if(allocation>0){
        const qty=allocation/x.entry;
        await env.DB.batch([
          env.DB.prepare("UPDATE portfolio SET cash_usdt=cash_usdt-?,updated_at=? WHERE id=1").bind(allocation,now),
          env.DB.prepare("INSERT INTO positions(symbol,strategy,entry,qty,sl,tp1,tp2,opened_at) VALUES(?,?,?,?,?,?,?,?)").bind(x.symbol,x.strategy,x.entry,qty,x.sl,x.tp1,x.tp2,now)
        ]);
      }
    }
    await env.DB.prepare("INSERT INTO scans(symbol,timeframe,price,regime,strategy,decision,rsi,adx,atr,ema21,ema50,ema200,entry,sl,tp1,tp2,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(x.symbol,x.timeframe,x.price,x.regime,x.strategy,x.decision,x.rsi,x.adx,x.atr,x.ema21,x.ema50,x.ema200,x.entry,x.sl,x.tp1,x.tp2,now).run();
  }
  const p=await env.DB.prepare("SELECT * FROM portfolio WHERE id=1").first();
  const open=(await env.DB.prepare("SELECT * FROM positions WHERE status='OPEN'").all()).results;
  let equity=p.cash_usdt;for(const pos of open){const s=scans.find(x=>x.symbol===pos.symbol);equity+=pos.qty*(s?.price??pos.entry)}
  await env.DB.prepare("INSERT INTO equity_history(equity,cash,realized_pnl,created_at) VALUES(?,?,?,?)").bind(equity,p.cash_usdt,p.realized_pnl,now).run();
  return await snapshot(env,now,scans,equity);
}

async function scan(symbol){
  const [fourh,daily]=await Promise.all([candles(symbol,"4h",300),candles(symbol,"1d",250)]);
  const c=fourh.map(x=>x.close),h=fourh.map(x=>x.high),l=fourh.map(x=>x.low),v=fourh.map(x=>x.volume),dc=daily.map(x=>x.close);
  const d21=ema(dc,21),d50=ema(dc,50),d200=ema(dc,200),dailyBull=dc.at(-1)>d21&&d21>d50&&d50>d200,dailyBear=dc.at(-1)<d21&&d21<d50&&d50<d200;
  const regime=dailyBull?"BULL TREND":dailyBear?"BEAR TREND":"RANGE / TRANSITION";
  const e21=ema(c,21),e50=ema(c,50),e200=ema(c,200),R=rsi(c),A=atr(h,l,c),D=adx(h,l,c),ve=ema(v,20),vr=v.at(-1)/ve,dist=(c.at(-1)/e21-1)*100;
  const fourhBull=c.at(-1)>e21&&e21>e50&&e50>e200;
  const ok=dailyBull&&fourhBull&&R>=48&&R<=65&&dist<=3.5&&dist>=-1&&vr>=0.8&&D>25;
  let strategy=ok?"TREND PULLBACK":"NO TRADE",decision=ok?"BUY":"NO TRADE",entry=null,sl=null,tp1=null,tp2=null;
  if(ok){entry=e21;sl=Math.min(e21-1.8*A,e50);if(sl>=entry){strategy="NO TRADE";decision="NO TRADE"}else{let risk=entry-sl;tp1=entry+1.8*risk;tp2=entry+3*risk}}
  return {symbol,timeframe:"4h",price:c.at(-1),regime,strategy,decision,rsi:R,adx:D,atr:A,ema21:e21,ema50:e50,ema200:e200,entry,sl,tp1,tp2,volumeRatio:vr,lastClosedCandleAt:new Date(fourh.at(-1).closeTime).toISOString()};
}

async function snapshot(env,now=new Date().toISOString(),scanCache=null,equity=null){
  const p=await env.DB.prepare("SELECT * FROM portfolio WHERE id=1").first();
  const ps=(await env.DB.prepare("SELECT * FROM positions WHERE status='OPEN' ORDER BY id").all()).results;
  const ts=(await env.DB.prepare("SELECT * FROM trades ORDER BY id DESC LIMIT 50").all()).results;
  const sc=scanCache??(await env.DB.prepare("SELECT * FROM scans ORDER BY id DESC LIMIT 4").all()).results;
  if(equity===null){equity=p.cash_usdt;for(const pos of ps)equity+=pos.qty*pos.entry}
  return {engine_version:ENGINE_VERSION,data_sources:["Binance","Kraken fallback"],updated_at:now,portfolio:{...p,equity},positions:ps,trades:ts,scans:sc};
}

function isBudapest08(){const hour=new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/Budapest",hour:"2-digit",hour12:false}).format(new Date());return hour==="08"}

export default {
  async fetch(req,env){
    const u=new URL(req.url);
    try{
      if(req.method==="POST"&&u.pathname==="/api/run")return Response.json(await run(env));
      if(req.method==="GET"&&u.pathname==="/api/state")return Response.json(await snapshot(env));
      if(req.method==="POST"&&u.pathname==="/api/backtest"){
        const body=await req.json();
        return Response.json(await backtest(env,body));
      }
      if(req.method==="GET"&&u.pathname==="/api/load"){
        const symbol=u.searchParams.get("symbol")||"BTCUSDT";
        const start=u.searchParams.get("start");
        const end=u.searchParams.get("end");
        return Response.json(await loadHistoricalChunk(env,{symbol,start,end}));
      }
      if(req.method==="POST"&&u.pathname==="/api/load"){
        const body=await req.json();
        return Response.json(await loadHistoricalChunk(env,body));
      }
      if(req.method==="GET"&&u.pathname==="/api/backtest"){
        const start=u.searchParams.get("start")||"2020-10-01T00:00:00Z";
        const end=u.searchParams.get("end")||"2021-05-31T23:59:59Z";
        const capital=u.searchParams.get("capital")||"500";
        return Response.json(await backtest(env,{start,end,capital}));
      }
      return env.ASSETS.fetch(req);
    } catch (e){return Response.json({error:String(e),engine_version:ENGINE_VERSION},{status:500})}
  },
  async scheduled(event,env,ctx){if(isBudapest08())ctx.waitUntil(run(env));}
};
