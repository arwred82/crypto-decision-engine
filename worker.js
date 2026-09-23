const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"];
const API = "https://api.binance.com/api/v3/klines";

function ema(a,p){let k=2/(p+1),e=a[0];for(let i=1;i<a.length;i++)e=a[i]*k+e*(1-k);return e}
function rsi(a,p=14){let g=0,l=0;for(let i=1;i<=p;i++){let d=a[i]-a[i-1];g+=Math.max(d,0);l+=Math.max(-d,0)}let ag=g/p,al=l/p;for(let i=p+1;i<a.length;i++){let d=a[i]-a[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p}return al===0?(ag===0?50:100):100-100/(1+ag/al)}
function atr(h,l,c,p=14){let t=[];for(let i=1;i<c.length;i++)t.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));let a=t.slice(0,p).reduce((x,y)=>x+y,0)/p;for(let i=p;i<t.length;i++)a=(a*(p-1)+t[i])/p;return a}
function adx(h,l,c,p=14){if(c.length<2*p+2)return NaN;let tr=[],pd=[],md=[];for(let i=1;i<c.length;i++){let up=h[i]-h[i-1],dn=l[i-1]-l[i];tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));pd.push(up>dn&&up>0?up:0);md.push(dn>up&&dn>0?dn:0)}let ts=tr.slice(0,p).reduce((a,b)=>a+b,0),ps=pd.slice(0,p).reduce((a,b)=>a+b,0),ms=md.slice(0,p).reduce((a,b)=>a+b,0),dx=[];for(let i=p;i<tr.length;i++){ts=ts-ts/p+tr[i];ps=ps-ps/p+pd[i];ms=ms-ms/p+md[i];let pi=100*ps/ts,mi=100*ms/ts;dx.push(100*Math.abs(pi-mi)/(pi+mi||1))}if(dx.length<p)return NaN;let x=dx.slice(0,p).reduce((a,b)=>a+b,0)/p;for(let i=p;i<dx.length;i++)x=(x*(p-1)+dx[i])/p;return x}
function parse(raw){return raw.slice(0,-1).map(x=>({open:+x[1],high:+x[2],low:+x[3],close:+x[4],volume:+x[5],closeTime:+x[6]}))}
async function candles(symbol,tf,limit=300){let r=await fetch(`${API}?symbol=${symbol}&interval=${tf}&limit=${limit}`);if(!r.ok)throw Error(`Binance ${symbol} ${r.status}`);return parse(await r.json())}

async function scan(symbol){
 const [fourh,daily]=await Promise.all([candles(symbol,"4h",300),candles(symbol,"1d",250)]);
 const c=fourh.map(x=>x.close),h=fourh.map(x=>x.high),l=fourh.map(x=>x.low),v=fourh.map(x=>x.volume);
 const dc=daily.map(x=>x.close);
 const d21=ema(dc,21),d50=ema(dc,50),d200=ema(dc,200);
 const dailyBull=dc.at(-1)>d21&&d21>d50&&d50>d200;
 const dailyBear=dc.at(-1)<d21&&d21<d50&&d50<d200;
 const regime=dailyBull?"BULL TREND":dailyBear?"BEAR TREND":"RANGE / TRANSITION";
 const e21=ema(c,21),e50=ema(c,50),e200=ema(c,200),R=rsi(c),A=atr(h,l,c),D=adx(h,l,c),ve=ema(v,20),vr=v.at(-1)/ve,dist=(c.at(-1)/e21-1)*100;
 const fourhBull=c.at(-1)>e21&&e21>e50&&e50>e200;
 const ok=dailyBull&&fourhBull&&R>=48&&R<=65&&dist<=3.5&&dist>=-1&&vr>=0.8&&D>25;
 let strategy=ok?"TREND PULLBACK":"NO TRADE",decision=ok?"BUY":"NO TRADE";
 let entry=null,sl=null,tp1=null,tp2=null;
 if(ok){entry=e21;sl=Math.min(e21-1.8*A,e50);if(sl>=entry){strategy="NO TRADE";decision="NO TRADE"}else{let risk=entry-sl;tp1=entry+1.8*risk;tp2=entry+3*risk}}
 return {symbol,timeframe:"4h",price:c.at(-1),regime,strategy,decision,rsi:R,adx:D,atr:A,ema21:e21,ema50:e50,ema200:e200,entry,sl,tp1,tp2,volumeRatio:vr,lastClosedCandleAt:new Date(fourh.at(-1).closeTime).toISOString()};
}

async function closePositions(env,now){
 const open=(await env.DB.prepare("SELECT * FROM positions WHERE status='OPEN'").all()).results;
 for(const pos of open){
   const openedMs=Date.parse(pos.opened_at);
   const raw=await candles(pos.symbol,"4h",20);
   let hit=null;
   for(const x of raw){
     if(x.closeTime<=openedMs)continue;
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

async function snapshot(env,now=new Date().toISOString(),scanCache=null,equity=null){
 const p=await env.DB.prepare("SELECT * FROM portfolio WHERE id=1").first();
 const ps=(await env.DB.prepare("SELECT * FROM positions WHERE status='OPEN' ORDER BY id").all()).results;
 const ts=(await env.DB.prepare("SELECT * FROM trades ORDER BY id DESC LIMIT 50").all()).results;
 const sc=scanCache??(await env.DB.prepare("SELECT * FROM scans ORDER BY id DESC LIMIT 4").all()).results;
 if(equity===null){equity=p.cash_usdt;for(const pos of ps)equity+=pos.qty*pos.entry}
 return {updated_at:now,portfolio:{...p,equity},positions:ps,trades:ts,scans:sc};
}

function isBudapest08(){
 const hour=new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/Budapest",hour:"2-digit",hour12:false}).format(new Date());
 return hour==="08";
}

export default {
 async fetch(req,env){
   const u=new URL(req.url);
   try{
     if(req.method==="POST"&&u.pathname==="/api/run")return Response.json(await run(env));
     if(req.method==="GET"&&u.pathname==="/api/state")return Response.json(await snapshot(env));
     return env.ASSETS.fetch(req);
   }catch(e){return Response.json({error:String(e)},{status:500})}
 },
 async scheduled(event,env,ctx){if(isBudapest08())ctx.waitUntil(run(env));}
};
