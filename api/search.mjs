// /api/search?q=kata+kunci  → { ok:true, items:[{id,title,channel,dur,views,thumb}] }
// Pencarian video YouTube tanpa API key (endpoint InnerTube publik). Tidak resmi: bila YouTube
// mengubah formatnya, perbarui parser di bawah. Cache 10 menit di CDN Vercel.
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const txt=o=>o?(o.simpleText||(o.runs||[]).map(r=>r.text).join('')||''):'';

export default async function handler(req,res){
  const q=String((req.query&&req.query.q)||'').trim().slice(0,120);
  res.setHeader('content-type','application/json; charset=utf-8');
  if(!q){res.statusCode=400;res.end(JSON.stringify({ok:false,error:'Parameter q kosong'}));return}
  try{
    const r=await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false',{
      method:'POST',
      headers:{'content-type':'application/json','user-agent':UA,'accept-language':'id-ID,id;q=0.9,en;q=0.8'},
      body:JSON.stringify({context:{client:{clientName:'WEB',clientVersion:'2.20250925.01.00',hl:'id',gl:'ID'}},query:q,params:'EgIQAQ=='})
    });
    if(!r.ok)throw new Error('YouTube HTTP '+r.status);
    const d=await r.json();
    const secs=d?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents||[];
    const items=[];
    for(const s of secs)for(const c of (s.itemSectionRenderer?.contents||[])){
      const v=c.videoRenderer;if(!v||!v.videoId)continue;
      items.push({
        id:v.videoId,
        title:txt(v.title),
        channel:txt(v.ownerText||v.longBylineText),
        dur:txt(v.lengthText),
        views:txt(v.shortViewCountText||v.viewCountText),
        thumb:'https://i.ytimg.com/vi/'+v.videoId+'/mqdefault.jpg'
      });
      if(items.length>=20)break;
    }
    res.setHeader('cache-control','public, s-maxage=600, stale-while-revalidate=60');
    res.statusCode=200;res.end(JSON.stringify({ok:true,q,items}));
  }catch(e){
    res.statusCode=502;res.end(JSON.stringify({ok:false,error:String(e&&e.message||e)}));
  }
}
