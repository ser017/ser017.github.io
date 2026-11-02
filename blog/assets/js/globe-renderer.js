/* Cache the global atlas; prepare detailed closeups off the animation thread. */
'use strict';
window.createTravelGlobeRenderer = function(canvas, {land,borders,visited,features=visited,grid,places,fallbackWorld,region,onDetailFeatures,onInvalidate}) {
  const isVisited=selected=>places.some(place=>String(place.id)===String(selected?.id));
  const selectionColor=selected=>isVisited(selected)?'#ab292c':'#86b3e6';
  const selectionBorder=selected=>isVisited(selected)?null:'#2563a6';
  const regionFeatures=region?.features || [];
  const regionBounds=region?.bounds || [112,20,116,24];
  const gl = canvas.getContext('webgl', {alpha:true,antialias:false,depth:false,stencil:false,powerPreference:'high-performance'});
  if (!gl) {
    // Low-detail vector fallback also keeps the CPU workload small without WebGL.
    const ctx = canvas.getContext('2d');
    const lowLand = topojson.feature(fallbackWorld,fallbackWorld.objects.land);
    const lowBorders = topojson.mesh(fallbackWorld,fallbackWorld.objects.countries,(a,b)=>a!==b);
    const lowVisited = topojson.feature(fallbackWorld,fallbackWorld.objects.countries).features.filter(f=>places.some(p=>+p.id===+f.id));
    let width,height,colors;
    const paint=(path,shape,fill,stroke) => {
      ctx.beginPath();path(shape);
      if(fill){ctx.fillStyle=fill;ctx.fill();}
      if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=.6;ctx.stroke();}
    };
    return {
      mode:'canvas',
      palette(value){colors=value;},
      resize(w,h){width=w;height=h;canvas.width=Math.round(w);canvas.height=Math.round(h);},
      draw(projection,selected,zoom=1){
        const path=d3.geoPath(projection,ctx);
        ctx.clearRect(0,0,width,height);
        paint(path,{type:'Sphere'},colors.ocean);
        paint(path,grid,null,colors.grid);
        paint(path,lowLand,colors.land,colors.border);
        paint(path,lowBorders,null,colors.border);
        lowVisited.forEach(f=>paint(path,f,selected && +selected.id===+f.id?'#ab292c':'#df514c',colors.border));
        const chosen=selected && (selected.feature||features.find(f=>String(f.id)===String(selected.id)));
        if(chosen)paint(path,chosen,selectionColor(selected),selectionBorder(selected)||colors.border);
        if(zoom>8 && regionFeatures.length){
          const [west,south,east,north]=regionBounds;
          paint(path,{type:'Polygon',coordinates:[[[west,south],[west,north],[east,north],[east,south],[west,south]]]},colors.ocean);
          regionFeatures.forEach(f=>paint(path,f,selected && String(selected.id)===String(f.id)?selectionColor(selected):visited.some(v=>+v.id===+f.id)?'#df514c':colors.land,selected && String(selected.id)===String(f.id)?selectionBorder(selected)||colors.border:colors.border));
        }
      }
    };
  }
  const size = gl.getParameter(gl.MAX_TEXTURE_SIZE)>=4096 ? 4096 : 2048;
  const atlas=document.createElement('canvas');atlas.width=size;atlas.height=size/2;
  const ctx=atlas.getContext('2d');
  const atlasProjection=d3.geoEquirectangular().translate([size/2,size/4]).scale(size/(2*Math.PI)).precision(.2);
  const path=d3.geoPath(atlasProjection,ctx);
  // Cache the unselected map. Selection is painted using the same antialiased
  // geometry and resolution as the map, never decoded from blended numeric IDs.
  const baseAtlas=document.createElement('canvas');baseAtlas.width=size;baseAtlas.height=size/2;
  const baseContext=baseAtlas.getContext('2d');
  const localSize=2048;
  const localAtlas=document.createElement('canvas');localAtlas.width=localSize;localAtlas.height=localSize;
  const localContext=localAtlas.getContext('2d');
  const localBase=document.createElement('canvas');localBase.width=localSize;localBase.height=localSize;
  const localBaseContext=localBase.getContext('2d');
  const [west,south,east,north]=regionBounds;
  const localScale=localSize/((east-west)*Math.PI/180);
  const localProjection=d3.geoEquirectangular().scale(localScale).translate([-west*Math.PI/180*localScale,north*Math.PI/180*localScale]).clipExtent([[0,0],[localSize,localSize]]).precision(.1);
  const localPath=d3.geoPath(localProjection,localContext);
  function shader(type,source) {
    const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);
    if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }
  let program,uniforms,colorTexture,localTexture,colors,lastProjection,lastSelected,lastZoom=1,paintedSelection;
  let worker=null,requestId=0,lastRequest=0,detailBounds=regionBounds,detailSelected=null,detailPalette=0,paletteVersion=0,dynamicDetail=false;
  let detailRetry=0;
  let hitId=0;const pendingHits=new Map();
  function hitTest(coordinates){
    if(!worker)return Promise.resolve(undefined);
    return new Promise(resolve=>{
      const id=++hitId;
      const timer=setTimeout(()=>{pendingHits.delete(id);resolve(undefined);},1500);
      pendingHits.set(id,feature=>{clearTimeout(timer);resolve(feature);});
      worker.postMessage({type:'hit',id,coordinates});
    });
  }
  function texture(source,unit,nearest=false) {
    const result=gl.createTexture();gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,result);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,nearest?gl.NEAREST:gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,nearest?gl.NEAREST:gl.LINEAR_MIPMAP_LINEAR);
    if(source)upload(result,source,unit,nearest);
    return result;
  }
  function upload(target,source,unit,nearest=false){
    gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,target);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);
    if(!nearest)gl.generateMipmap(gl.TEXTURE_2D);
  }
  function setup(){
    const vertex=shader(gl.VERTEX_SHADER,`attribute vec2 position; void main(){gl_Position=vec4(position,0.,1.);}`);
    const fragment=shader(gl.FRAGMENT_SHADER,`
      precision highp float;
      uniform vec2 resolution,center;
      uniform float pixelRatio,radius,detail;
      uniform mat3 basis;
      uniform sampler2D atlas,localAtlas;
      uniform vec4 regionBounds;
      void main(){
        vec2 point=(vec2(gl_FragCoord.x,resolution.y-gl_FragCoord.y)/pixelRatio-center)/radius;
        float squared=dot(point,point);
        if(squared>1.0)discard;
        vec3 world=basis*vec3(sqrt(max(0.,1.-squared)),point.x,-point.y);
        vec2 uv=vec2(0.5+atan(world.y,world.x)/6.28318530718,0.5-asin(clamp(world.z,-1.,1.))/3.14159265359);
        vec3 color=texture2D(atlas,uv).rgb;
        vec2 localUv=vec2(fract(uv.x-regionBounds.x+1.)/(regionBounds.z-regionBounds.x),(uv.y-regionBounds.y)/(regionBounds.w-regionBounds.y));
        if(detail>0. && localUv.x<1. && localUv.y>0. && localUv.y<1.){
          float edge=min(min(localUv.x,1.-localUv.x),min(localUv.y,1.-localUv.y));
          color=mix(color,texture2D(localAtlas,localUv).rgb,detail*smoothstep(0.,.025,edge));
        }
        float alpha=clamp((1.-sqrt(squared))*radius*pixelRatio,0.,1.);
        gl_FragColor=vec4(color*alpha,alpha);
      }`);
    program=gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);
    gl.deleteShader(vertex);gl.deleteShader(fragment);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
    const location=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,2,gl.FLOAT,false,0,0);
    uniforms=Object.fromEntries(['resolution','center','pixelRatio','radius','basis','atlas','localAtlas','regionBounds','detail'].map(name=>[name,gl.getUniformLocation(program,name)]));
    colorTexture=texture(null,0);
    localTexture=texture(null,1);
    gl.uniform1i(uniforms.atlas,0);gl.uniform1i(uniforms.localAtlas,1);
    gl.uniform4f(uniforms.regionBounds,.5+west/360,.5-north/180,.5+east/360,.5-south/180);
    gl.disable(gl.DEPTH_TEST);gl.disable(gl.BLEND);gl.clearColor(0,0,0,0);
  }
  function palette(value){
    colors=value;
    paletteVersion++;dynamicDetail=false;detailBounds=regionBounds;lastRequest=0;
    ctx.fillStyle=colors.ocean;ctx.fillRect(0,0,size,size/2);
    const paint=(shape,fill,stroke) => {
      ctx.beginPath();path(shape);
      if(fill){ctx.fillStyle=fill;ctx.fill();}
      if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=size/1700;ctx.stroke();}
    };
    paint(grid,null,colors.grid);paint(land,colors.land,colors.border);paint(borders,null,colors.border);
    visited.forEach(feature=>paint(feature,'#df514c',colors.border));
    localContext.fillStyle=colors.ocean;localContext.fillRect(0,0,localSize,localSize);
    localContext.lineJoin='round';
    regionFeatures.forEach(feature=>{
      localContext.beginPath();localPath(feature);
      localContext.fillStyle=visited.some(v=>+v.id===+feature.id)?'#df514c':colors.land;localContext.fill();
      localContext.strokeStyle=colors.border;localContext.lineWidth=1;localContext.stroke();
    });
    localBaseContext.clearRect(0,0,localSize,localSize);localBaseContext.drawImage(localAtlas,0,0);
    baseContext.clearRect(0,0,size,size/2);
    baseContext.drawImage(atlas,0,0);
    paintedSelection=undefined;
    updateSelection(lastSelected);
  }
  function updateSelection(selected){
    const id=selected?.id || null;
    if(paintedSelection===id)return;
    ctx.clearRect(0,0,size,size/2);
    ctx.drawImage(baseAtlas,0,0);
    const feature=selected && (selected.feature||features.find(feature=>String(feature.id)===String(id)));
    if(feature){
      ctx.beginPath();path(feature);
      ctx.fillStyle=selectionColor(selected);ctx.fill();
      ctx.strokeStyle=selectionBorder(selected)||colors.border;ctx.lineWidth=size/(isVisited(selected)?1700:900);ctx.stroke();
    }
    if(!dynamicDetail){
      localContext.clearRect(0,0,localSize,localSize);localContext.drawImage(localBase,0,0);
      const localFeature=selected && regionFeatures.find(feature=>+feature.id===+id);
      if(localFeature){
        localContext.beginPath();localPath(localFeature);localContext.fillStyle=selectionColor(selected);localContext.fill();
        localContext.strokeStyle=selectionBorder(selected)||colors.border;localContext.lineWidth=isVisited(selected)?1:2;localContext.stroke();
      }
    }
    if(!gl.isContextLost()){upload(colorTexture,atlas,0);if(!dynamicDetail)upload(localTexture,localAtlas,1);}
    paintedSelection=id;
  }
  function requestDetail(projection,selected,zoom){
    if(zoom<3 || typeof Worker==='undefined' || typeof OffscreenCanvas==='undefined')return;
    const center=projection.invert(projection.translate()),radians=180/Math.PI;
    const height=canvas.height/(canvas.width/width);
    const latSpan=Math.max(.5,Math.min(160,height/projection.scale()*radians*1.8));
    const lonSpan=Math.min(360,Math.max(.5,width/projection.scale()*radians*1.8/Math.max(.08,Math.cos(center[1]/radians))));
    const south=Math.max(-90,center[1]-latSpan/2),north=Math.min(90,center[1]+latSpan/2);
    const bounds=[center[0]-lonSpan/2,south,center[0]+lonSpan/2,north];
    const oldLon=(detailBounds[0]+detailBounds[2])/2,oldLat=(detailBounds[1]+detailBounds[3])/2;
    const lonDelta=Math.abs(((center[0]-oldLon+180)%360+360)%360-180);
    const scaleRatio=lonSpan/(detailBounds[2]-detailBounds[0]);
    if(dynamicDetail && lonDelta<(detailBounds[2]-detailBounds[0])*.18 && Math.abs(center[1]-oldLat)<(detailBounds[3]-detailBounds[1])*.18 && scaleRatio>.65 && scaleRatio<1.5 && detailSelected===(selected?.id||null) && detailPalette===paletteVersion)return;
    const delay=180-(performance.now()-lastRequest);
    if(delay>0){
      if(!detailRetry)detailRetry=setTimeout(()=>{detailRetry=0;onInvalidate?.();},delay+1);
      return;
    }
    lastRequest=performance.now();
    if(!worker){
      worker=new Worker('/blog/assets/js/globe-detail-worker.js');
      worker.onmessage=event=>{
        const message=event.data;
        if(message.type==='hit'){pendingHits.get(message.id)?.(message.feature);pendingHits.delete(message.id);return;}
        if(message.type==='features'){onDetailFeatures?.(message.features);return;}
        if(message.type!=='region')return;
        if(message.id!==requestId || message.palette!==paletteVersion || message.selected!==(lastSelected?.id||null)){
          message.bitmap.close();onInvalidate?.();return;
        }
        localContext.clearRect(0,0,localSize,localSize);localContext.drawImage(message.bitmap,0,0);message.bitmap.close();
        detailBounds=message.bounds;detailSelected=message.selected;detailPalette=message.palette;dynamicDetail=true;
        if(!gl.isContextLost())upload(localTexture,localAtlas,1);
        canvas.dataset.detailBounds=JSON.stringify(detailBounds);
        onInvalidate?.();
      };
    }
    worker.postMessage({id:++requestId,bounds,colors,selected:selected?.id||null,palette:paletteVersion,visited:places.map(place=>String(place.id))});
  }
  function draw(projection,selected,zoom=1){
    lastProjection=projection;lastSelected=selected;lastZoom=zoom;
    if(gl.isContextLost())return;
    updateSelection(selected);
    requestDetail(projection,selected,zoom);
    // Inverse D3 rotation supplies the three world-space axes of the view.
    const inverse=d3.geoRotation(projection.rotate()).invert;
    const axes=[[0,0],[90,0],[0,90]].flatMap(point=>{
      const [lon,lat]=inverse(point).map(value=>value*Math.PI/180);
      return [Math.cos(lat)*Math.cos(lon),Math.cos(lat)*Math.sin(lon),Math.sin(lat)];
    });
    const origin=projection.translate();
    gl.useProgram(program);gl.viewport(0,0,canvas.width,canvas.height);gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(uniforms.resolution,canvas.width,canvas.height);
    gl.uniform2f(uniforms.center,origin[0],origin[1]);
    gl.uniform1f(uniforms.pixelRatio,canvas.width/width);
    gl.uniform1f(uniforms.radius,projection.scale());
    const [left,bottom,right,top]=detailBounds;
    gl.uniform4f(uniforms.regionBounds,.5+left/360,.5-top/180,.5+right/360,.5-bottom/180);
    gl.uniform1f(uniforms.detail,dynamicDetail?Math.max(0,Math.min(1,zoom-3)):regionFeatures.length?Math.max(0,Math.min(1,(zoom-8)/8)):0);
    gl.uniformMatrix3fv(uniforms.basis,false,new Float32Array(axes));
    gl.drawArrays(gl.TRIANGLES,0,6);
  }
  let width=720;
  setup();
  canvas.addEventListener('webglcontextlost',event=>event.preventDefault());
  canvas.addEventListener('webglcontextrestored',()=>{setup();palette(colors);if(lastProjection)draw(lastProjection,lastSelected,lastZoom);});
  return {mode:'webgl',palette,draw,hitTest,resize(w,h,ratio){width=w;canvas.width=Math.round(w*ratio);canvas.height=Math.round(h*ratio);}};
};
