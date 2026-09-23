
const ENGINE_VERSION = "07.3";
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"];

const BINANCE_API = "https://data-api.binance.vision/api/v3/klines";
const KRAKEN_API = "https://api.kraken.com/0/public/OHLC";
const KRAKEN_PAIRS = {
  BTCUSDT: "XBTUSD",
  ETHUSDT: "ETHUSD",
  SOLUSDT: "SOLUSD",
  XRPUSDT: "XRPUSD"
};

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

async function backtest(env,params){
  const startMs=Date.parse(params.start);
  const endMs=Date.parse(params.end);
  if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||endMs<=startMs)throw Error("Invalid start/end. Use YYYY-MM-DD.");
  const starting=Number(params.capital||500);
  if(!(starting>0))throw Error("Invalid capital");

  const warm4=220*4*3600000;
  const warm1=210*24*3600000;
  const fetchStart4=startMs-warm4;
  const fetchStart1=startMs-warm1;
  const allTrades=[];
  const bySymbol={};

  for(const symbol of SYMBOLS){
    const [fourh,daily]=await Promise.all([
      fetchRange(symbol,"4h",fetchStart4,endMs+4*3600000),
      fetchRange(symbol,"1d",fetchStart1,endMs+24*3600000)
    ]);
    const r=simulateSymbol(symbol,fourh,daily,startMs,endMs,starting);
    bySymbol[symbol]=r.trades;
    allTrades.push(...r.trades);
  }

  allTrades.sort((a,b)=>a.entryTime-b.entryTime);
  let equity=starting,maxEquity=starting,maxDD=0;
  // Portfolio-level approximation: trades are independently sized from the
  // same 500 USDT starting capital, matching the current per-symbol 20% rule.
  // Aggregate P&L is the sum of closed trade P&L.
  let net=0,wins=0,losses=0;
  for(const t of allTrades){
    net+=t.pnl;
    if(t.pnl>=0)wins++;else losses++;
    equity=starting+net;
    maxEquity=Math.max(maxEquity,equity);
    maxDD=Math.max(maxDD,maxEquity-equity);
  }
  const grossWin=allTrades.filter(t=>t.pnl>0).reduce((a,t)=>a+t.pnl,0);
  const grossLoss=Math.abs(allTrades.filter(t=>t.pnl<0).reduce((a,t)=>a+t.pnl,0));
  const profitFactor=grossLoss?grossWin/grossLoss:(grossWin?Infinity:0);

  return {
    engine_version:ENGINE_VERSION,
    start:params.start,
    end:params.end,
    starting_capital:starting,
    final_equity:starting+net,
    net_pnl:net,
    return_pct:net/starting*100,
    max_drawdown:maxDD,
    max_drawdown_pct:maxDD/starting*100,
    total_trades:allTrades.length,
    wins,losses,
    win_rate:allTrades.length?wins/allTrades.length*100:0,
    profit_factor,
    by_symbol:Object.fromEntries(SYMBOLS.map(s=>[s,{trades:bySymbol[s].length,net_pnl:bySymbol[s].reduce((a,t)=>a+t.pnl,0)}])),
    trades:allTrades.map((t,n)=>({...t,id:n+1,entryTime:new Date(t.entryTime).toISOString(),signalTime:new Date(t.signalTime).toISOString(),exitTime:new Date(t.exitTime).toISOString()}))
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
      u.searchParams.set("endTime",String(endMs));
      u.searchParams.set("limit","1000");

      const r=await fetch(u.toString(),{
        headers:{
          "Accept":"application/json",
          "User-Agent":"CryptoDecisionEngine/0.7"
        }
      });

      if(!r.ok)throw Error(`Binance HTTP ${r.status}`);

      const data=await r.json();
      if(!Array.isArray(data))throw Error("unexpected response");

      const rows=parseBinance(data);
      if(!rows.length)break;

      all.push(...rows);
      const last=rows.at(-1).openTime;

      if(last<=cursor)break;
      cursor=last+stepMs;

      if(rows.length<1000)break;
    } catch (e){
      errors.push(`Binance: ${e.message}`);
      break;
    }
  }

  if(all.length>=50)return dedupe(all);

  // 2) OKX fallback.
  // OKX supports 4H candles and historical pagination through "after".
  // This avoids the HTTP 403 that can occur when Cloudflare Worker
  // egress IPs call Binance.
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
    let before=endMs;
    const rows=[];

    for(let guard=0;guard<100;guard++){
      const u=new URL("https://www.okx.com/api/v5/market/candles");
      u.searchParams.set("instId",instId);
      u.searchParams.set("bar",bar);
      u.searchParams.set("after",String(before));
      u.searchParams.set("limit","300");

      const r=await fetch(u.toString(),{
        headers:{
          "Accept":"application/json",
          "User-Agent":"CryptoDecisionEngine/0.7"
        }
      });

      if(!r.ok)throw Error(`OKX HTTP ${r.status}`);

      const payload=await r.json();
      if(payload.code!=="0")throw Error(`OKX ${payload.code}: ${payload.msg||"API error"}`);

      const data=Array.isArray(payload.data)?payload.data:[];
      if(!data.length)break;

      for(const x of data){
        const openTime=+x[0];
        const closeTime=openTime+stepMs-1;

        if(openTime>=startMs && closeTime<=endMs){
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

      const oldest=Math.min(...data.map(x=>+x[0]));
      if(oldest<=startMs)break;
      if(oldest>=before)break;

      before=oldest-1;
    }

    if(rows.length>=50)return dedupe(rows);
    throw Error(`OKX returned only ${rows.length} usable candles`);
  } catch (e){
    errors.push(`OKX: ${e.message}`);
  }

  throw Error(`Historical data unavailable for ${symbol}/${tf}: ${errors.join(" | ")}`);
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

async function backtest(env,params){
  const startMs=Date.parse(params.start);
  const endMs=Date.parse(params.end);
  if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||endMs<=startMs)throw Error("Invalid start/end. Use YYYY-MM-DD.");
  const starting=Number(params.capital||500);
  if(!(starting>0))throw Error("Invalid capital");

  const warm4=220*4*3600000;
  const warm1=210*24*3600000;
  const fetchStart4=startMs-warm4;
  const fetchStart1=startMs-warm1;
  const allTrades=[];
  const bySymbol={};

  for(const symbol of SYMBOLS){
    const [fourh,daily]=await Promise.all([
      fetchRange(symbol,"4h",fetchStart4,endMs+4*3600000),
      fetchRange(symbol,"1d",fetchStart1,endMs+24*3600000)
    ]);
    const r=simulateSymbol(symbol,fourh,daily,startMs,endMs,starting);
    bySymbol[symbol]=r.trades;
    allTrades.push(...r.trades);
  }

  allTrades.sort((a,b)=>a.entryTime-b.entryTime);
  let equity=starting,maxEquity=starting,maxDD=0;
  // Portfolio-level approximation: trades are independently sized from the
  // same 500 USDT starting capital, matching the current per-symbol 20% rule.
  // Aggregate P&L is the sum of closed trade P&L.
  let net=0,wins=0,losses=0;
  for(const t of allTrades){
    net+=t.pnl;
    if(t.pnl>=0)wins++;else losses++;
    equity=starting+net;
    maxEquity=Math.max(maxEquity,equity);
    maxDD=Math.max(maxDD,maxEquity-equity);
  }
  const grossWin=allTrades.filter(t=>t.pnl>0).reduce((a,t)=>a+t.pnl,0);
  const grossLoss=Math.abs(allTrades.filter(t=>t.pnl<0).reduce((a,t)=>a+t.pnl,0));
  const profitFactor=grossLoss?grossWin/grossLoss:(grossWin?Infinity:0);

  return {
    engine_version:ENGINE_VERSION,
    start:params.start,
    end:params.end,
    starting_capital:starting,
    final_equity:starting+net,
    net_pnl:net,
    return_pct:net/starting*100,
    max_drawdown:maxDD,
    max_drawdown_pct:maxDD/starting*100,
    total_trades:allTrades.length,
    wins,losses,
    win_rate:allTrades.length?wins/allTrades.length*100:0,
    profit_factor,
    by_symbol:Object.fromEntries(SYMBOLS.map(s=>[s,{trades:bySymbol[s].length,net_pnl:bySymbol[s].reduce((a,t)=>a+t.pnl,0)}])),
    trades:allTrades.map((t,n)=>({...t,id:n+1,entryTime:new Date(t.entryTime).toISOString(),signalTime:new Date(t.signalTime).toISOString(),exitTime:new Date(t.exitTime).toISOString()}))
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
