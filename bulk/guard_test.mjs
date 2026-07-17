const GENERIC=new Set(['the','and','for','with','your','you','are','can','how','what','why','does','from','that','this','into','best','top','near','free','cost','price','guide','tips','ideas','service','services','product','products','solution','solutions','company','companies','custom','professional','online','list','types','type','about','more','other','their','they','when','where','which','will','make','made','need','using','used','vs']);
const stem = t => t.replace(/ies$/,'y').replace(/s$/,'');
function inOffering(kw, names){
  if(!names || !names.length) return false;
  const hayToks = names.join(' ').toLowerCase().replace(/[^a-z0-9]+/g,' ').split(' ').filter(Boolean).map(stem);
  const hay = new Set(hayToks), hayStr = ' '+hayToks.join(' ')+' ';
  const toks = String(kw||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').split(' ').filter(t=>t && t.length>=4 && !GENERIC.has(t)).map(stem);
  for(let i=0;i<toks.length-1;i++){ if(hayStr.includes(' '+toks[i]+' '+toks[i+1]+' ')) return true; }
  return toks.some(t => t.length>=4 && hay.has(t));
}
const signs=['Vehicle Wraps','LED Signs','Banners','Sign Installation','Billboard Advertising'];
const skin=['Aloe-ADE Skin Moisturizer & Conditioner — Post-Treatment Skin Conditioner','Bio-Dermal Hydrogel Kit','Aqua-Derm Astringent Skin Cleanser'];
const t=[['purple car wraps',signs,true],['business sign ideas',signs,true],['led sign installation',signs,true],
 ['plumbing repair',signs,false],['best pizza recipes',signs,false],['dog grooming',signs,false],
 ['best post procedure skin care',skin,true],['wholesale cleanser',skin,true],['hydrogel companies',skin,true],
 ['defib gel',skin,false],['physical therapy supplies',skin,false]];
let bad=0;
for(const [kw,names,want] of t){ const got=inOffering(kw,names); if(got!==want) bad++; console.log('  '+(got===want?'ok  ':'FAIL')+' "'+kw+'" keep='+got+' (want '+want+')'); }
console.log(bad? '\n'+bad+' FAILED' : '\nall pass');
