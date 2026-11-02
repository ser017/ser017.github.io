/* Detailed geographic painting stays off the animation/UI thread. */
importScripts('/blog/assets/vendor/d3.min.js','/blog/assets/vendor/topojson-client.min.js');
const size=2048,canvas=new OffscreenCanvas(size,size),ctx=canvas.getContext('2d');
let latest=null,scheduled=false,entries,visitedIds;
// v2 uses validated ring winding and Kazakhstan with the lease-area cutout
// dissolved, consistently for painting and hit testing.
const ready=fetch('/blog/assets/data/countries-10m.json?v=2').then(r=>{if(!r.ok)throw new Error('Detailed atlas unavailable');return r.json();}).then(world=>{
  const features=topojson.feature(world,world.objects.countries).features.map(feature=>({...feature,id:String(feature.id??`name:${feature.properties.name}`)}));
  entries=features.flatMap(feature=>(feature.geometry.type==='Polygon'?[feature.geometry.coordinates]:feature.geometry.coordinates).map(coordinates=>{
    const outer=coordinates[0];let west=180,east=-180,south=90,north=-90;
    outer.forEach(([lon,lat])=>{west=Math.min(west,lon);east=Math.max(east,lon);south=Math.min(south,lat);north=Math.max(north,lat);});
    return {id:feature.id,bounds:[west,south,east,north],shape:{type:'Polygon',coordinates}};
  }));
  return features;
});
function schedule(){
  if(scheduled)return;scheduled=true;
  setTimeout(async()=>{
    try{
      const features=await ready,job=latest;latest=null;
      if(!job){scheduled=false;return;}
      if(!visitedIds){visitedIds=new Set(job.visited);postMessage({type:'features',features:features.filter(f=>visitedIds.has(String(f.id)))});}
      const [west,south,east,north]=job.bounds,lonSpan=east-west,latSpan=north-south;
      const centerLon=(west+east)/2,centerLat=(south+north)/2,vertical=lonSpan/latSpan;
      const projection=d3.geoEquirectangular().rotate([-centerLon,0]).center([0,centerLat]).scale(size/(lonSpan*Math.PI/180)).translate([size/2,size/(2*vertical)]).clipExtent([[0,0],[size,size/vertical]]).precision(.15);
      ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle=job.colors.ocean;ctx.fillRect(0,0,size,size);
      ctx.setTransform(1,0,0,vertical,0,0);ctx.lineJoin='round';
      const path=d3.geoPath(projection,ctx);
      // Fill first, then stroke shared borders. Bbox filtering avoids walking
      // unrelated islands and coastlines while painting a small visible region.
      const visible=entries.filter(entry=>{
        const [w,s,e,n]=entry.bounds;
        return n>=south && s<=north && [-360,0,360].some(offset=>e+offset>=west && w+offset<=east);
      });
      for(const entry of visible){
        ctx.beginPath();path(entry.shape);
        ctx.fillStyle=String(entry.id)===job.selected?(visitedIds.has(String(entry.id))?'#ab292c':'#86b3e6'):visitedIds.has(String(entry.id))?'#df514c':job.colors.land;
        ctx.fill();
      }
      ctx.strokeStyle=job.colors.border;ctx.lineWidth=.9/Math.max(1,vertical);
      for(const entry of visible){
        const unvisitedSelection=String(entry.id)===job.selected && !visitedIds.has(String(entry.id));
        ctx.strokeStyle=unvisitedSelection?'#2563a6':job.colors.border;
        ctx.lineWidth=(unvisitedSelection?2.2:.9)/Math.max(1,vertical);
        ctx.beginPath();path(entry.shape);ctx.stroke();
      }
      ctx.setTransform(1,0,0,1,0,0);
      const bitmap=canvas.transferToImageBitmap();
      postMessage({type:'region',id:job.id,bounds:job.bounds,selected:job.selected,palette:job.palette,bitmap},[bitmap]);
    }catch(error){postMessage({type:'error',message:String(error)});}
    scheduled=false;if(latest)schedule();
  },20);
}
onmessage=event=>{
  if(event.data.type==='hit'){
    const {id,coordinates}=event.data;
    ready.then(features=>postMessage({type:'hit',id,feature:features.find(feature=>d3.geoContains(feature,coordinates))||null})).catch(()=>postMessage({type:'hit',id,feature:undefined}));
    return;
  }
  latest=event.data;schedule();
};
