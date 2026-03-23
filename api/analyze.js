// Minimal metadata endpoint - hanya noembed, tidak pakai Cobalt
module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS')return res.status(200).end();
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  const {url}=req.body||{};
  if(!url)return res.status(400).json({error:'URL required'});
  try{new URL(url)}catch{return res.status(400).json({error:'Invalid URL'})}
  try{
    const r=await fetch(`https://noembed.com/embed?url=${encodeURIComponent(url)}`,{signal:AbortSignal.timeout(6000)});
    const d=await r.json();
    return res.json({title:d.title||null,author:d.author_name||null,thumb:d.thumbnail_url||null});
  }catch(e){
    return res.json({title:null,author:null,thumb:null,error:e.message});
  }
};
