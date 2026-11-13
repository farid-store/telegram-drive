// /api/search?q=kata+kunci[&c=TOKEN]  → { ok:true, items:[{id,title,channel,dur,views,thumb}], next:"TOKEN"|"" }
// Pencarian video YouTube tanpa API key (endpoint InnerTube publik, tidak resmi). `next` dipakai
// sebagai `c` untuk memuat halaman berikutnya (scroll tanpa batas). Jika YouTube mengubah
// formatnya, perbarui parser `pick`. Cache 10 menit di CDN Vercel.
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CTX={client:{clientName:'WEB',clientVersion:'2.20250925.01.00',hl:'id',gl:'ID'}};
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
  const c=String((req.query&&req.query.c)||'').slice(0,4000);
  res.setHeader('content-type','application/json; charset=utf-8');
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
