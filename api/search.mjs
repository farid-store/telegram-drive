// Pembatas: 40 pencarian/menit/IP (env SEARCH_RATE). Memori per-instance → best-effort; untuk batas ketat aktifkan Vercel Firewall → Rate Limiting.
// /api/search?q=kata+kunci[&c=TOKEN]  → { ok:true, items:[{id,title,channel,dur,views,thumb}], next:"TOKEN"|"" }
// Pencarian video YouTube tanpa API key (endpoint InnerTube publik, tidak resmi). `next` dipakai
// sebagai `c` untuk memuat halaman berikutnya (scroll tanpa batas). Jika YouTube mengubah
// formatnya, perbarui parser `pick`. Cache 10 menit di CDN Vercel.
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CTX={client:{clientName:'WEB',clientVersion:'2.20250925.01.00',hl:'id',gl:'ID'}};
const LIMIT=Number(process.env.SEARCH_RATE)||40;   // pencarian per IP per menit (per instance)
const HITS=new Map();
function limited(key,max){
  const now=Date.now(),e=HITS.get(key);
  if(!e||now>e.t){
    if(HITS.size>5000)for(const[k,v]of HITS)if(now>v.t)HITS.delete(k);
    HITS.set(key,{t:now+60000,n:1});return 0;
  }
  return ++e.n>max?Math.ceil((e.t-now)/1000):0;
}
const txt=o=>o?(o.simpleText||(o.runs||[]).map(r=>r.text).join('')||''):'';

function pick(d){
  const items=[];let next='';
  const scan=arr=>{for(const c of arr||[]){
    if(c.itemSectionRenderer)scan(c.itemSectionRenderer.contents);
    else if(c.videoRenderer&&c.videoRenderer.videoId){
      const v=c.videoRenderer;
      items.push({id:v.videoId,title:txt(v.title),channel:txt(v.ownerText||v.longBylineText),
        dur:txt(v.lengthText),views:txt(v.shortViewCountText||v.viewCountText),
        thumb:'https://i.ytimg.com/vi/'+v.videoId+'/mqdefault.jpg'});
    }else if(c.continuationItemRenderer){
      next=c.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token||next;
    }
  }};
  scan(d?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents);
  for(const a of d?.onResponseReceivedCommands||[])scan(a.appendContinuationItemsAction?.continuationItems);
  return{items,next};
}

export default async function handler(req,res){
  const q=String((req.query&&req.query.q)||'').trim().slice(0,120);
  const sug=!!(req.query&&req.query.s);
  const c=String((req.query&&req.query.c)||'').slice(0,4000);
  res.setHeader('content-type','application/json; charset=utf-8');
  const sf=req.headers['sec-fetch-site'];
  if(sf&&sf!=='same-origin'&&sf!=='none'){res.statusCode=403;res.end(JSON.stringify({ok:false,error:'Forbidden'}));return}
  const ip=String(req.headers['x-forwarded-for']||req.headers['x-real-ip']||'?').split(',')[0].trim();
  const wait=limited(ip+(sug?':s':''),sug?LIMIT*3:LIMIT);
  if(wait){res.setHeader('retry-after',String(wait));res.statusCode=429;res.end(JSON.stringify({ok:false,error:'Terlalu banyak permintaan'}));return}
  if(sug&&q){
    try{
      const r=await fetch('https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=id&q='+encodeURIComponent(q),{headers:{'user-agent':UA}});
      const d=await r.json();
      res.setHeader('cache-control','public, s-maxage=3600');
      res.statusCode=200;res.end(JSON.stringify({ok:true,items:(d[1]||[]).slice(0,8).map(String)}));
    }catch(e){res.statusCode=200;res.end(JSON.stringify({ok:true,items:[]}))}
    return;
  }
  if(!q&&!c){res.statusCode=400;res.end(JSON.stringify({ok:false,error:'Parameter q kosong'}));return}
  try{
    const body=c?{context:CTX,continuation:c}:{context:CTX,query:q,params:'EgIQAQ=='};
    const r=await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false',{
      method:'POST',
      headers:{'content-type':'application/json','user-agent':UA,'accept-language':'id-ID,id;q=0.9,en;q=0.8'},
      body:JSON.stringify(body)
    });
    if(!r.ok)throw new Error('YouTube HTTP '+r.status);
    const {items,next}=pick(await r.json());
    res.setHeader('cache-control','public, s-maxage=600, stale-while-revalidate=60');
    res.statusCode=200;res.end(JSON.stringify({ok:true,q,items,next}));
  }catch(e){
    res.statusCode=502;res.end(JSON.stringify({ok:false,error:String(e&&e.message||e)}));
  }
}
