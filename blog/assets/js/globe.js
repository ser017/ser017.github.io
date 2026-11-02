/* Orthographic globe; all assets are served locally. */
(() => {
  'use strict';
  const element = document.querySelector('#travel-globe');
  if (!element) return;
  const buttons = [...document.querySelectorAll('[data-place]')];
  const places = buttons.map(button => ({ tag: button.dataset.place, id: button.dataset.id, name: button.firstChild.textContent.trim(), coords: [+button.dataset.lon, +button.dataset.lat], small: button.dataset.small === 'true', button }));
  const panels = [...document.querySelectorAll('[data-stories]')];
  const status = document.querySelector('#globe-status');
  const stories = document.querySelector('.travel-stories');
  const closeStories = document.querySelector('.travel-close');
  const noStories = document.querySelector('#travel-no-stories');
  const catalog = JSON.parse(document.querySelector('#globe-country-catalog').textContent);
  let pickVersion=0;
  let selected, projection, render, moveTo, focusPlace;
  panels.forEach(panel => { panel.hidden = true; });
  stories.hidden = true;
  function closePanel() {
    pickVersion++;
    stories.hidden = true;
    const previous = selected;
    selected = null;
    buttons.forEach(button => button.setAttribute('aria-pressed','false'));
    if (projection) { moveTo(projection.rotate()); render(); }
    previous?.button?.focus({preventScroll:true});
  }
  closeStories.addEventListener('click',closePanel);
  document.addEventListener('keydown',event => {
    if (event.key === 'Escape' && !stories.hidden) closePanel();
  });
  function select(place, center = true) {
    pickVersion++;
    selected = place;
    stories.hidden = false;
    document.querySelector('#travel-empty').hidden = true;
    panels.forEach(panel => { panel.hidden = panel.dataset.stories !== place.tag; });
    noStories.hidden=panels.some(panel=>panel.dataset.stories===place.tag);
    document.querySelector('#travel-country-name').textContent=place.name;
    buttons.forEach(button => button.setAttribute('aria-pressed', String(button === place.button)));
    if (projection) {
      if(center)focusPlace(place);
      else moveTo(projection.rotate());
      render();
    }
  }
  places.forEach(place => place.button.addEventListener('click', () => select(place)));
  async function init() {
    if (!window.d3 || !window.topojson) throw new Error('Missing globe libraries');
    const [world,fallbackWorld,region,extraOutlines] = await Promise.all(['countries-50m.json','countries-110m.json','pearl-river-delta.json','country-outlines.json'].map(async name=>{
      const response=await fetch(`/blog/assets/data/${name}`);
      if(!response.ok)throw new Error('Map unavailable');
      return response.json();
    }));
    const svg = d3.select(element);
    projection = d3.geoOrthographic().translate([360, 310]).scale(280).rotate([-90, -30, 0]).clipAngle(90);
    // The map is cached on a texture; only the GPU projection changes each frame.
    // D3 remains responsible for hit testing and rotation.
    const canvas = document.createElement('canvas');
    canvas.className = 'globe-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    element.before(canvas);
    let width = 720, height = 640, baseScale = 280;
    const features = [...topojson.feature(world, world.objects.countries).features,...extraOutlines.features].map(feature=>{
      const detailed=places.some(place=>place.small && +place.id===+feature.id)?region.features.find(detail=>+detail.id===+feature.id):null;
      return {...(detailed||feature),id:String(feature.id??`name:${feature.properties.name}`)};
    });
    const visited = features.filter(feature => places.some(place => +place.id === +feature.id));
    const borders = topojson.mesh(world, world.objects.countries, (a,b) => a !== b);
    const land = topojson.feature(world, world.objects.land);
    const grid = d3.geoGraticule10();
    let detailedHits=[];
    const renderer = createTravelGlobeRenderer(canvas,{land,borders,visited,features,grid,places,fallbackWorld,region,
      onDetailFeatures:features=>{detailedHits=features;},onInvalidate:()=>render()});
    canvas.dataset.renderer = renderer.mode;
    let colors;
    function readColors() {
      const css = getComputedStyle(element);
      const color = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
      colors = { ocean:color('--globe-ocean','#e4edf0'), grid:color('--globe-grid','#ccd9df'), land:color('--globe-land','#fafbfc'), border:color('--globe-border','#a6b5bd') };
      renderer.palette(colors);
    }
    readColors();
    svg.on('click', event => {
      if (event.defaultPrevented) return;
      const point = d3.pointer(event, element);
      const origin = projection.translate();
      if (Math.hypot(point[0]-origin[0], point[1]-origin[1]) > projection.scale()) return;
      const coordinates = projection.invert(point);
      const local=region.features.find(feature=>[344,446].includes(+feature.id) && d3.geoContains(feature,coordinates));
      const coarse=local || features.find(feature=>d3.geoContains(feature,coordinates));
      function selectFeature(feature){
        if(!feature)return;
        const id=String(feature.id??`name:${feature.properties.name}`);
        const place=places.find(place=>String(place.id)===id) || catalog.find(place=>String(place.id)===id);
        select({...place,id,name:place?.name||feature.properties.name,feature},false);
      }
      if(zoom>=3 && renderer.hitTest){
        const version=++pickVersion;
        renderer.hitTest(coordinates).then(feature=>{if(version===pickVersion)selectFeature(feature===undefined?coarse:feature);});
      }else selectFeature(coarse);
    });
    render = () => renderer.draw(projection,selected,zoom);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let rotation = projection.rotate(), target = rotation.slice();
    let zoom = 1, targetZoom = 1, velocity = [0,0], dragging = false;
    let frame = 0, lastFrame = 0, lastDrag = 0;
    const clampLatitude = value => Math.max(-85,Math.min(85,value));
    const stopInertia = () => { velocity = [0,0]; };
    function wake() {
      if (!frame) { lastFrame = performance.now(); frame = requestAnimationFrame(animate); }
    }
    function animate(now) {
      frame = 0;
      const dt = Math.min(100,Math.max(1,now-lastFrame)); lastFrame = now;
      if (!dragging && !reducedMotion.matches) {
        const decay = Math.exp(-dt/150);
        target[0] += velocity[0] * 150 * (1-decay);
        target[1] = clampLatitude(target[1] + velocity[1] * 150 * (1-decay));
        velocity = velocity.map(value => value*decay);
      }
      const blend = reducedMotion.matches ? 1 : 1-Math.exp(-dt/(dragging ? 35 : 65));
      rotation = rotation.map((value,index) => value+(target[index]-value)*blend);
      zoom += (targetZoom-zoom)*blend;
      const moving = rotation.some((value,index) => Math.abs(target[index]-value)>.005) || Math.abs(targetZoom-zoom)>.0001 || Math.hypot(...velocity)>.00005;
      if (!moving) {
        stopInertia(); rotation=target.slice(); zoom=targetZoom;
        // Keep longitude bounded without a discontinuity at the antimeridian.
        rotation[0] = ((rotation[0]+180)%360+360)%360-180;
        target = rotation.slice();
      }
      projection.rotate(rotation).scale(baseScale*zoom); render();
      if (moving) frame = requestAnimationFrame(animate);
    }
    moveTo = next => {
      stopInertia();
      const delta = ((next[0]-rotation[0]+180)%360+360)%360-180;
      target = [rotation[0]+delta,next[1],0]; wake();
    };
    focusPlace = place => {
      if(place.small){
        const bounds=d3.geoBounds(visited.find(feature=>+feature.id===+place.id));
        const radians=Math.PI/180;
        const span=Math.max((bounds[1][0]-bounds[0][0])*Math.cos(place.coords[1]*radians),bounds[1][1]-bounds[0][1])*radians;
        targetZoom=Math.max(1,Math.min(256,Math.min(width,height)*.5/(span*baseScale)));
      }else targetZoom=Math.min(targetZoom,5);
      moveTo([-place.coords[0],-place.coords[1],0]);
    };
    function resize() {
      const bounds = element.getBoundingClientRect();
      width = Math.max(1,bounds.width); height = Math.max(1,bounds.height);
      const ratio = Math.min(window.devicePixelRatio || 1,2);
      renderer.resize(width,height,ratio);
      element.setAttribute('viewBox',`0 0 ${width} ${height}`);
      // Leave room for the header and bottom controls on narrow screens.
      baseScale = Math.min(width*.44,height*(width<600 ? .32 : .41));
      projection.translate([width*.5,height*.52]).scale(baseScale*zoom);
      render();
    }
    new ResizeObserver(resize).observe(element);
    svg.call(d3.drag().clickDistance(4)
      .on('start', () => {
        dragging=true; stopInertia(); target=rotation.slice(); lastDrag=performance.now();
        element.classList.add('is-dragging');
      })
      .on('drag', event => {
        const now=performance.now(), dt=Math.max(8,now-lastDrag), k=60/projection.scale();
        const dx=event.dx*k, previousLat=target[1];
        target[0]+=dx; target[1]=clampLatitude(target[1]-event.dy*k);
        const dy=target[1]-previousLat, blend=1-Math.exp(-dt/40);
        velocity[0]+=(Math.max(-.6,Math.min(.6,dx/dt))-velocity[0])*blend;
        velocity[1]+=(Math.max(-.6,Math.min(.6,dy/dt))-velocity[1])*blend;
        lastDrag=now; wake();
      })
      .on('end', () => {
        dragging=false; element.classList.remove('is-dragging');
        if (performance.now()-lastDrag>80 || reducedMotion.matches) stopInertia();
        wake();
      }));
    const changeZoom = (factor,point) => {
      stopInertia();
      const previous=targetZoom,next=Math.max(1,Math.min(256,previous*factor));
      if(point && next!==previous){
        const view=d3.geoOrthographic().translate(projection.translate()).scale(baseScale*previous).rotate(target);
        const origin=view.translate();
        if(Math.hypot(point[0]-origin[0],point[1]-origin[1])<view.scale()*.98){
          const center=view.invert(origin),anchor=view.invert(point);
          const nextCenter=d3.geoInterpolate(center,anchor)(1-previous/next);
          const delta=(((-nextCenter[0])-rotation[0]+180)%360+360)%360-180;
          target=[rotation[0]+delta,clampLatitude(-nextCenter[1]),0];
        }
      }
      targetZoom=next;wake();
    };
    element.addEventListener('wheel', event => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      const delta = Math.max(-240,Math.min(240,event.deltaY*unit));
      changeZoom(Math.exp(-delta*(event.ctrlKey ? .006 : .002)),d3.pointer(event,element));
    }, {passive:false});
    document.querySelectorAll('[data-globe-zoom]').forEach(button => button.addEventListener('click', () => changeZoom(+button.dataset.globeZoom)));
    document.querySelector('#globe-reset').addEventListener('click', () => { targetZoom=1; moveTo([-90,-30,0]); });
    element.addEventListener('keydown', event => {
      const rotate = target.slice();
      if (event.key === '+' || event.key === '=') changeZoom(1.3);
      else if (event.key === '-') changeZoom(.77);
      else if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) {
        rotate[0] += event.key === 'ArrowLeft' ? -10 : event.key === 'ArrowRight' ? 10 : 0;
        rotate[1] = Math.max(-85,Math.min(85,rotate[1] + (event.key === 'ArrowUp' ? 10 : event.key === 'ArrowDown' ? -10 : 0)));
        moveTo(rotate);
      } else return;
      event.preventDefault();
    });
    new MutationObserver(() => { readColors(); render(); }).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { stopInertia(); cancelAnimationFrame(frame); frame=0; }
      else wake();
    });
    resize();
    status.textContent = 'Тяните, чтобы вращать · колёсико или + / − для масштаба · нажмите на любую страну';
  }
  init().catch(error => { console.error(error); status.textContent = 'Не удалось загрузить глобус. Выберите место кнопками ниже — статьи доступны.'; });
})();
