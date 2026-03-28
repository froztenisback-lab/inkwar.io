import React, { useState, useEffect, useRef, useCallback } from 'react';
import { PaintBucket, Trophy, Play, Skull, Shield, Settings, Clock, ChevronDown, ChevronUp, Sword, Building2, ShoppingBag, Star, X, ArrowUp } from 'lucide-react';

// ─── Grid & Tick ─────────────────────────────────────────────────────────────
const GRID_W = 60, GRID_H = 40, CELL_SIZE = 20, TICK_RATE = 100;

const COLORS = { 0:'#f1f5f9', 1:'#3b82f6', 2:'#ef4444', 3:'#10b981', 4:'#f59e0b', 9:'#334155' };
// Fort-wall tiles: value 10+ownerId (11,12,13,14) — impassable to enemies, walkable for owner
const FORT_WALL_OFFSET = 10;

// ─── Buildings ────────────────────────────────────────────────────────────────
// Replaced emoji with sprite paths. Ensure these sprites are in public/sprites.
// width/height: size in grid cells (1x1, 2x2, etc.)
const BLDG = {
  factory:   { sprite: 'factory.png', hp:3,  cocoaReward:4,  cost:20,  costKey:'factoryCost',  countKey:'factories',    desc:'Paint /click',   baseMul:1.5, w:2, h:2 },
  farm:      { sprite: 'farm.png', hp:2,  cocoaReward:2,  cost:50,  costKey:'farmCost',     countKey:'farms',        desc:'+10/s',        baseMul:1.5, w:1, h:1 },
  fort:      { sprite: 'fort.png', hp:8,  cocoaReward:8,  cost:300, costKey:'fortCost',     countKey:'forts',        desc:'Wall+block',     baseMul:1.5, w:3, h:3 },
  infra:     { sprite: 'infra.png', hp:4,  cocoaReward:5,  cost:500, costKey:'infraCost',    countKey:'infrastructures', desc:'+20% eff',    baseMul:1.5, w:1, h:1 },
  milbase:   { sprite: 'milbase.png', hp:10, cocoaReward:12, cost:400, costKey:'milbaseCost',  countKey:'milbases',     desc:'Train units',    baseMul:2.0, w:2, h:2 },
  tower:     { sprite: 'tower.png', hp:6,  cocoaReward:7,  cost:600, costKey:'towerCost',   countKey:'towers',       desc:'Auto-fires at units', baseMul:1.5, w:1, h:3 },
};

// ─── Units ────────────────────────────────────────────────────────────────────
// Replaced emoji with sprite paths. Ensure these sprites are in public/sprites.
const UNITS = {
  soldier:  { sprite: 'soldier.png', hp:3, atk:1, cd:10, speed:1, range:1,  cost:150, costKey:'soldierCost',  advanced:false, desc:'Basic fighter' },
  scout:    { sprite: 'scout.png', hp:1, atk:1, cd:4,  speed:3, range:1,  cost:200, costKey:'scoutCost',    advanced:false, desc:'Fast, fragile' },
  demo:     { sprite: 'demo.png', hp:5, atk:4, cd:15, speed:1, range:1,  cost:350, costKey:'demoCost',     advanced:false, desc:'Busts buildings/forts' },
  ranger:   { sprite: 'ranger.png', hp:4, atk:2, cd:20, speed:1, range:3,  cost:500, costKey:'rangerCost',   advanced:true,  desc:'Long-range, hits 3 tiles' },
  commander:{ sprite: 'commander.png', hp:6, atk:1, cd:12, speed:1, range:2,  cost:800, costKey:'commanderCost',advanced:true,  desc:'Boosts nearby allies' },
};

const BUCKET_UPGRADES = [
  { radius:1, label:'Basic',  desc:'1×1',  cocoaCost:0  },
  { radius:2, label:'Wide',   desc:'3×3',  cocoaCost:8  },
  { radius:3, label:'Splash', desc:'5×5',  cocoaCost:20 },
  { radius:4, label:'Flood',  desc:'7×7',  cocoaCost:45 },
];

const fmt = n => n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':String(n);
const clamp = (v,lo,hi) => Math.max(lo, Math.min(hi, v));
const rnd = n => Math.floor(Math.random()*n);

// ─── Helpers ─────────────────────────────────────────────────────────────────
const isOwned = (cell, id) => cell===id || cell===FORT_WALL_OFFSET+id;
const isFortWall = cell => cell >= FORT_WALL_OFFSET+1 && cell <= FORT_WALL_OFFSET+4;
const fortWallOwner = cell => cell - FORT_WALL_OFFSET;

const findTiles = (grid, id) => {
  const t=[];
  for(let y=0;y<GRID_H;y++) for(let x=0;x<GRID_W;x++) if(isOwned(grid[y][x],id)) t.push({x,y});
  return t;
};

// Check if a building of given width/height can be placed at (x,y)
// Pass existing buildings array to also check for overlaps with placed buildings
const canPlaceBuilding = (grid, x, y, w, h, id, buildings = []) => {
  for(let dy=0;dy<h;dy++) for(let dx=0;dx<w;dx++){
    const nx=x+dx, ny=y+dy;
    if(nx>=GRID_W||ny>=GRID_H||!isOwned(grid[ny][nx],id)) return false;
  }
  // Check against every existing building's full footprint
  for(const b of buildings){
    const bw = BLDG[b.type].w || 1;
    const bh = BLDG[b.type].h || 1;
    // AABB overlap test between [x, x+w) x [y, y+h) and [b.x, b.x+bw) x [b.y, b.y+bh)
    if(x < b.x+bw && x+w > b.x && y < b.y+bh && y+h > b.y) return false;
  }
  return true;
};

const findBorderTile = (grid, id) => {
  const DIRS=[[-1,0],[1,0],[0,-1],[0,1]]; const b=[];
  for(let y=0;y<GRID_H;y++) for(let x=0;x<GRID_W;x++)
    if(isOwned(grid[y][x],id))
      for(const[dy,dx]of DIRS){const ny=y+dy,nx=x+dx;
        if(ny>=0&&ny<GRID_H&&nx>=0&&nx<GRID_W&&!isOwned(grid[ny][nx],id)&&grid[ny][nx]!==9){b.push({x,y});break;}}
  return b.length?b[rnd(b.length)]:null;
};

// Generic perimeter helper for buildings of any size
const getBuildingPerimeter = (bx, by, bw, bh) => {
  const t = [];
  for (let dy = -1; dy <= bh; dy++) {
    for (let dx = -1; dx <= bw; dx++) {
      const isInside = dx >= 0 && dx < bw && dy >= 0 && dy < bh;
      if (!isInside) {
        const nx = bx + dx, ny = by + dy;
        if (nx >= 0 && nx < GRID_W && ny >= 0 && ny < GRID_H) t.push({ x: nx, y: ny });
      }
    }
  }
  return t;
};

// Build initial entity
const makeEnt = (id,name) => ({
  id, name, color:COLORS[id],
  potatoes:id===1?10:0, paintUnits:4, pixels:9,
  factories:0, factoryCost:20, farms:0, farmCost:50,
  forts:0, fortCost:300, infrastructures:0, infraCost:500,
  milbases:0, milbaseCost:400, milbaseAdvanced:false,
  towers:0, towerCost:600,
  soldierCost:150, scoutCost:200, demoCost:350, rangerCost:500, commanderCost:800,
});

const createInitialState = settings => {
  const g = Array.from({length:GRID_H},()=>Array(GRID_W).fill(0));
  for(let i=0;i<18;i++){
    const ox=rnd(GRID_W),oy=rnd(GRID_H),r=rnd(3)+1;
    for(let y=oy-r;y<=oy+r;y++) for(let x=ox-r;x<=ox+r;x++)
      if(x>=0&&x<GRID_W&&y>=0&&y<GRID_H&&Math.random()>0.4) g[y][x]=9;
  }
  // Always spawn a 3x3 cluster for the player and bots
  const spawn=(id,cx,cy)=>{
    // Clear a 5x5 area
    for(let y=cy-2;y<=cy+2;y++) for(let x=cx-2;x<=cx+2;x++) if(x>=0&&x<GRID_W&&y>=0&&y<GRID_H) g[y][x]=0;
    // Set a 3x3 cluster
    for(let y=cy-1;y<=cy+1;y++) for(let x=cx-1;x<=cx+1;x++) if(x>=0&&x<GRID_W&&y>=0&&y<GRID_H) g[y][x]=id;
  };
  spawn(1,5,5);
  const bots=[];
  if(settings.botCount>=1){spawn(2,GRID_W-6,GRID_H-6);bots.push(makeEnt(2,'Alpha'));}
  if(settings.botCount>=2){spawn(3,GRID_W-6,5);bots.push(makeEnt(3,'Beta'));}
  if(settings.botCount>=3){spawn(4,5,GRID_H-6);bots.push(makeEnt(4,'Gamma'));}
  return {grid:g,tickCount:0,settings,player:makeEnt(1,'You'),bots,buildings:[],units:[]};
};

// Helper to convert hex color to RGB object
const hexToRgb = hex => {
  const bigint = parseInt(hex.slice(1), 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return { r, g, b };
};

// The specific gray in your pixel art to be replaced (#646464)
const PLACEHOLDER_GRAY_RGB = { r: 100, g: 100, b: 100 };

// Helper to generate a recolored version of a sprite once
const createRecoloredCanvas = (image, ownerColorHex, placeholderRgb) => {
  if (!image || image.width === 0) return null;
  
  const ownerColorRgb = hexToRgb(ownerColorHex);
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = image.width;
  tempCanvas.height = image.height;
  const tempCtx = tempCanvas.getContext('2d');

  tempCtx.drawImage(image, 0, 0);

  const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
  const pixels = imageData.data;

  for (let i = 0; i < pixels.length; i += 4) {
    if (
      pixels[i] === placeholderRgb.r && 
      pixels[i + 1] === placeholderRgb.g && 
      pixels[i + 2] === placeholderRgb.b
    ) {
      pixels[i] = ownerColorRgb.r; 
      pixels[i + 1] = ownerColorRgb.g; 
      pixels[i + 2] = ownerColorRgb.b;
    }
  }
  tempCtx.putImageData(imageData, 0, 0);
  return tempCanvas;
};

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [cocoaBeans,setCocoaBeans]   = useState(()=>Number(localStorage.getItem('cocoaBeans')||0));
  const [activeBucket,setActiveBucket] = useState(()=>Number(localStorage.getItem('activeBucket')||0));
  const [unlockedBucket,setUnlockedBucket] = useState(()=>Number(localStorage.getItem('unlockedBucket')||0));
  const [gameStatus,setGameStatus]   = useState('menu');
  const [settings,setSettings]       = useState({duration:0,botCount:3,difficulty:'normal'});
  const [menuTab,setMenuTab]         = useState('setup');
  // Popup: { type:'milbase', building: {...} } or null
  const [popup,setPopup]             = useState(null);

  const canvasRef  = useRef(null);
  const gridCanvasRef = useRef(null); // Off-screen cache for the grid
  const requestRef = useRef(null);
  const stateRef   = useRef(null);
  const [loadedImages, setLoadedImages] = useState({});
  // Cache for recolored versions: "spritePath-color" -> HTMLCanvasElement
  const spriteCache = useRef(new Map());
  
  const [imagesLoaded, setImagesLoaded] = useState(false);
  const isMouseDown= useRef(false);
  const bucketRef  = useRef(activeBucket);
  useEffect(()=>{bucketRef.current=activeBucket;},[activeBucket]);

  // Initialize off-screen canvas
  useEffect(() => {
    const off = document.createElement('canvas');
    off.width = GRID_W * CELL_SIZE;
    off.height = GRID_H * CELL_SIZE;
    gridCanvasRef.current = off;
  }, []);

  const PANELS = { units:false, buildings:false };
  const [panelOpen,setPanelOpen] = useState(PANELS);

  useEffect(()=>{localStorage.setItem('cocoaBeans',cocoaBeans);},[cocoaBeans]);
  useEffect(()=>{localStorage.setItem('activeBucket',activeBucket);},[activeBucket]);
  useEffect(()=>{localStorage.setItem('unlockedBucket',unlockedBucket);},[unlockedBucket]);

  // Load all sprite images
  useEffect(() => {
    const allSpritePaths = [
      ...Object.values(BLDG).map(b => b.sprite),
      ...Object.values(UNITS).map(u => u.sprite),
    ];
    const images = {};
    let loadedCount = 0;
    const totalImages = allSpritePaths.length;

    if (totalImages === 0) { setImagesLoaded(true); return; }

    allSpritePaths.forEach(path => {
      const img = new Image();
      // Required for getImageData/pixel manipulation
      img.crossOrigin = "anonymous"; 
      // Use absolute path from public folder
      img.src = `/Assets/Textures/${path}`;

      img.onload = () => {
        images[path] = img;
        loadedCount++;
        if (loadedCount === totalImages) { setLoadedImages(images); setImagesLoaded(true); }
      };
      img.onerror = () => {
        console.error(`Failed to load sprite at: /Assets/Textures/${path}. Check if file is in public/Assets/Textures/`);
        loadedCount++; if (loadedCount === totalImages) { setLoadedImages(images); setImagesLoaded(true); }
      };
    });
  }, []);

  const addCocoa = useCallback(n=>{
    setCocoaBeans(p=>{const nv=p+n; return nv;});
  },[]);

  // Fast draw using the cache
  const drawSprite = (ctx, path, x, y, ownerId, w, h, anim = { scaleX:1, scaleY:1, rotation:0, offsetY:0 }) => {
    const color = COLORS[ownerId];
    const cacheKey = `${path}-${color}`;
    
    if (!spriteCache.current.has(cacheKey)) {
      const recolored = createRecoloredCanvas(loadedImages[path], color, PLACEHOLDER_GRAY_RGB);
      if (recolored) spriteCache.current.set(cacheKey, recolored);
    }
    
    const cached = spriteCache.current.get(cacheKey);
    if (cached) {
      const targetW = w * CELL_SIZE;
      const targetH = h * CELL_SIZE;
      const imgW = cached.width;
      const imgH = cached.height;

      // Aspect-Fit: Calculate a scale that fits the image within the target cells
      // without stretching and without bleeding out of bounds.
      const scale = Math.min(targetW / imgW, targetH / imgH);
      const drawW = imgW * scale;
      const drawH = imgH * scale;

      ctx.save();
      // Move to center of footprint to allow rotation/scaling from center
      ctx.translate(x + targetW / 2, y + targetH / 2 + anim.offsetY);
      ctx.rotate(anim.rotation);
      ctx.drawImage(cached, -drawW / 2, -drawH / 2, drawW, drawH);
      ctx.restore();
    }
  };

  // ── UI State ───────────────────────────────────────────────────────────────
  const [ui,setUi] = useState({
    potatoes:0,paintUnits:0,pixels:0,tickCount:0,leaderboard:[],
    factories:0,factoryCost:0,farms:0,farmCost:0,forts:0,fortCost:0,
    infrastructures:0,infraCost:0,milbases:0,milbaseCost:0,milbaseAdvanced:false,
    towers:0,towerCost:0,
    soldierCost:0,scoutCost:0,demoCost:0,rangerCost:0,commanderCost:0,
    unitCounts:{soldier:0,scout:0,demo:0,ranger:0,commander:0},
    buildings:[],
  });

  const syncUI = useCallback(()=>{
    if(!stateRef.current)return;
    const s=stateRef.current; const all=[s.player,...s.bots];
    const uc={soldier:0,scout:0,demo:0,ranger:0,commander:0};
    s.units.filter(u=>u.ownerId===1).forEach(u=>{if(uc[u.type]!==undefined)uc[u.type]++;});
    setUi({
      potatoes:s.player.potatoes,paintUnits:s.player.paintUnits,pixels:s.player.pixels,
      tickCount:s.tickCount,
      factories:s.player.factories,factoryCost:s.player.factoryCost,
      farms:s.player.farms,farmCost:s.player.farmCost,
      forts:s.player.forts,fortCost:s.player.fortCost,
      infrastructures:s.player.infrastructures,infraCost:s.player.infraCost,
      milbases:s.player.milbases,milbaseCost:s.player.milbaseCost,milbaseAdvanced:s.player.milbaseAdvanced,
      towers:s.player.towers,towerCost:s.player.towerCost,
      soldierCost:s.player.soldierCost,scoutCost:s.player.scoutCost,demoCost:s.player.demoCost,
      rangerCost:s.player.rangerCost,commanderCost:s.player.commanderCost,
      unitCounts:uc,
      buildings:s.buildings.filter(b=>b.ownerId===1).map(b=>({...b})),
      leaderboard:all.filter(x=>x.pixels>0).sort((a,b)=>b.pixels-a.pixels)
        .map(x=>({id:x.id,name:x.name,pixels:x.pixels,color:x.color}))
    });
  },[]);

  // Redraw the static-ish grid layer to the off-screen cache
  const updateGridCache = useCallback(() => {
    if (!gridCanvasRef.current || !stateRef.current) return;
    const gCtx = gridCanvasRef.current.getContext('2d');
    const { grid } = stateRef.current;
    const CS = CELL_SIZE;

    gCtx.fillStyle = COLORS[0];
    gCtx.fillRect(0, 0, GRID_W * CS, GRID_H * CS);

    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const c = grid[y][x];
        if (c === 0) continue;
        if (c === 9) { gCtx.fillStyle = COLORS[9]; gCtx.fillRect(x * CS, y * CS, CS, CS); continue; }
        if (isFortWall(c)) {
          const ownId = fortWallOwner(c);
          gCtx.fillStyle = COLORS[ownId];
          gCtx.fillRect(x * CS, y * CS, CS, CS);
          gCtx.fillStyle = 'rgba(0,0,0,0.2)';
          gCtx.fillRect(x * CS, y * CS, CS, CS);
          continue;
        }
        gCtx.fillStyle = COLORS[c];
        gCtx.fillRect(x * CS, y * CS, CS, CS);
      }
    }
    // Grid lines
    gCtx.strokeStyle = 'rgba(0,0,0,0.03)'; gCtx.lineWidth = 0.5; gCtx.beginPath();
    for (let y = 0; y <= GRID_H; y++) { gCtx.moveTo(0, y * CS); gCtx.lineTo(GRID_W * CS, y * CS); }
    for (let x = 0; x <= GRID_W; x++) { gCtx.moveTo(x * CS, 0); gCtx.lineTo(x * CS, GRID_H * CS); }
    gCtx.stroke();
  }, []);

  // ── Draw ───────────────────────────────────────────────────────────────────
  const drawCanvas = useCallback(()=>{
    if(!canvasRef.current||!stateRef.current||!gridCanvasRef.current)return;
    const ctx=canvasRef.current.getContext('2d',{alpha:false});
    const {buildings,units}=stateRef.current;
    const CS = CELL_SIZE;
    const time = performance.now();

    if (!imagesLoaded) return;
    ctx.imageSmoothingEnabled = false;

    // Draw the cached grid (Super Fast!)
    ctx.drawImage(gridCanvasRef.current, 0, 0);

    // Buildings
    for(const b of buildings){
      const px=b.x*CS,py=b.y*CS;
      const bw = BLDG[b.type].w || 1;
      const bh = BLDG[b.type].h || 1;
      drawSprite(ctx, BLDG[b.type].sprite, px, py, b.ownerId, bw, bh);

      // Draw health bar spanning the building width
      const barW = (CS * bw) - 2;
      const barY = py + (CS * bh) - 4;
      const hf=b.hp/BLDG[b.type].hp;
      ctx.fillStyle='rgba(0,0,0,0.35)';ctx.fillRect(px+1,barY,barW,3);
      ctx.fillStyle=hf>0.6?'#22c55e':hf>0.3?'#f59e0b':'#ef4444';
      ctx.fillRect(px+1,barY,Math.floor(barW*hf),3);
      if(b.damageFlash>0){
        ctx.save();ctx.globalAlpha=b.damageFlash/6;ctx.fillStyle='#ffffff';
        ctx.fillRect(px,py,CS*bw,CS*bh);ctx.restore();b.damageFlash--;
      }
    }

    // Units
    for(const u of units){
      // Initialize visual coordinates if they don't exist
      if (u.visualX === undefined) { u.visualX = u.x; u.visualY = u.y; }

      const dx = u.x - u.visualX;
      const dy = u.y - u.visualY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const isMoving = dist > 0.05;

      // ── Sprint vs Walk Logic ──
      // If distance is large or unit is a scout, move faster (Sprint)
      const isSprinting = dist > 4 || u.type === 'scout';
      const lerpSpeed = isSprinting ? 0.15 : 0.06;

      u.visualX += dx * lerpSpeed;
      u.visualY += dy * lerpSpeed;

      const ux = u.visualX * CS;
      const uy = u.visualY * CS;

      // ── Procedural Animation ──
      // Animation is strong when moving, subtle "breathing" when idle
      const animIntensity = isMoving ? 1.0 : 0.2;
      const bob = Math.sin(time / 150 + u.id) * (isMoving ? 3 : 0.5);
      const squash = 1 + Math.sin(time / 150 + u.id) * (0.08 * animIntensity);
      const tilt = isMoving ? Math.sin(time / 100 + u.id) * 0.15 : 0;

      drawSprite(ctx, UNITS[u.type].sprite, ux, uy, u.ownerId, 1, 1, {
        scaleX: 1 / squash, scaleY: squash, rotation: tilt, offsetY: bob
      });

      const maxHp=UNITS[u.type].hp; const hf=u.hp/maxHp;
      ctx.fillStyle='rgba(0,0,0,0.4)';ctx.fillRect(ux,uy,CS,2);
      ctx.fillStyle=hf>0.5?'#4ade80':'#f87171';
      ctx.fillRect(ux,uy,Math.floor(CS*hf),2);
      if(u.shootFlash>0){
        ctx.save();ctx.globalAlpha=u.shootFlash/5;ctx.fillStyle=COLORS[u.ownerId];
        const[dy,dx]=u.dir||[0,1];
        ctx.beginPath();ctx.arc((u.x+dx)*CS+CS/2,(u.y+dy)*CS+CS/2,CS/2,0,Math.PI*2);
        ctx.fill();ctx.restore();u.shootFlash=Math.max(0,u.shootFlash-1);
      }
    }
  }, [imagesLoaded, loadedImages]);

  // ── Game Logic ─────────────────────────────────────────────────────────────
  const updateLogic = useCallback(()=>{
    const state=stateRef.current; state.tickCount++;
    const all=[state.player,...state.bots];
    const DIRS=[[-1,0],[1,0],[0,-1],[0,1]];

    // Count pixels (own territory + fort walls)
    const counts={1:0,2:0,3:0,4:0};
    for(let y=0;y<GRID_H;y++) for(let x=0;x<GRID_W;x++){
      const c=state.grid[y][x];
      if(c>=1&&c<=4)counts[c]++;
      else if(isFortWall(c))counts[fortWallOwner(c)]=(counts[fortWallOwner(c)]||0)+1;
    }
    state.player.pixels=counts[1]||0;
    state.bots.forEach(b=>b.pixels=counts[b.id]||0);

    if(state.player.pixels===0){setGameStatus('gameover');return;}
    if(state.bots.filter(b=>b.pixels>0).length===0){setGameStatus('victory');return;}
    if(state.settings.duration>0&&state.tickCount>=state.settings.duration*10){setGameStatus('timeup');return;}

    const easy=state.settings.difficulty==='easy',hard=state.settings.difficulty==='hard';
    const expandInt=easy?10:hard?3:5,craftInt=easy?30:hard?8:15,purchaseInt=easy?30:hard?10:20;
    const diffMul=easy?0.005:hard?0.02:0.01,baseLimit=easy?1:hard?3:2;

    // ── Income ─────────────────────────────────────────────────────────────
    if(state.tickCount%10===0)
      all.forEach(e=>{if(e.pixels>0){const m=1+0.2*e.infrastructures;e.potatoes+=Math.floor((e.pixels+e.farms*10)*m);}});

    // ── Damage helper ──────────────────────────────────────────────────────
    const damageBuilding=(bldIdx,attackerId)=>{
      const b=state.buildings[bldIdx]; b.hp--; b.damageFlash=6;
      if(b.hp<=0){
        if(attackerId===1)addCocoa(BLDG[b.type].cocoaReward);
        // Remove fort walls if a fort is destroyed
        if(b.type==='fort'){
          const bw = BLDG.fort.w, bh = BLDG.fort.h;
          for(const{x,y}of getBuildingPerimeter(b.x, b.y, bw, bh)){
            if(state.grid[y][x]===FORT_WALL_OFFSET+b.ownerId) state.grid[y][x]=b.ownerId;
          }
          all.find(e=>e.id===b.ownerId).forts=Math.max(0,all.find(e=>e.id===b.ownerId).forts-1);
        }
        state.buildings.splice(bldIdx,1); return true;
      }
      return false;
    };

    // ── Bot purchases ──────────────────────────────────────────────────────
    if(state.tickCount%purchaseInt===0)
      state.bots.forEach(b=>{
        if(b.pixels<=0)return;
        const place=(type,extra={})=>{
          const t=findTiles(state.grid,b.id); if(!t.length)return;
          const bw = BLDG[type].w || 1;
          const bh = BLDG[type].h || 1;
          // Try to find a valid placement spot
          let placed = false;
          for(let attempt=0;attempt<30&&!placed;attempt++){
            const tile=t[rnd(t.length)];
            if(canPlaceBuilding(state.grid,tile.x,tile.y,bw,bh,b.id,state.buildings)){
              const bld={x:tile.x,y:tile.y,type,ownerId:b.id,hp:BLDG[type].hp,damageFlash:0,...extra};
              state.buildings.push(bld);
              placed=true;
              if(type==='fort'){
                for(const{x,y}of getBuildingPerimeter(tile.x, tile.y, bw, bh)){
                  if(state.grid[y][x]===b.id) state.grid[y][x]=FORT_WALL_OFFSET+b.id;
                }
              }
            }
          }
        };
        const spawnUnit=(type)=>{
          const t=findBorderTile(state.grid,b.id)||findTiles(state.grid,b.id)[0]; if(!t)return;
          state.units.push({
            x:t.x, 
            y:t.y, 
            visualX: t.x, 
            visualY: t.y, 
            ownerId:b.id, 
            type, 
            hp:UNITS[type].hp, 
            dir:[0,1], 
            cd:0, 
            shootFlash:0, 
            id:Math.random()
          });
        };
        // Bot AI purchase priority
        const botUnits=state.units.filter(u=>u.ownerId===b.id);
        if(b.milbases===0&&b.potatoes>=b.milbaseCost){b.potatoes-=b.milbaseCost;b.milbases++;b.milbaseCost=Math.floor(b.milbaseCost*2);place('milbase');}
        else if(b.milbases>0&&botUnits.length<6&&b.potatoes>=b.soldierCost){b.potatoes-=b.soldierCost;b.soldierCost=Math.floor(b.soldierCost*1.4);spawnUnit(Math.random()<0.3?'demo':'soldier');}
        else if(b.potatoes>=b.towerCost&&b.towers<3){b.potatoes-=b.towerCost;b.towers++;b.towerCost=Math.floor(b.towerCost*1.5);place('tower');}
        else if(b.potatoes>=b.fortCost&&b.forts<4){b.potatoes-=b.fortCost;b.forts++;b.fortCost=Math.floor(b.fortCost*1.5);place('fort');}
        else if(b.potatoes>=b.infraCost&&b.infrastructures<Math.floor(b.factories/2)){b.potatoes-=b.infraCost;b.infrastructures++;b.infraCost=Math.floor(b.infraCost*1.5);place('infra');}
        else if(b.potatoes>=b.farmCost&&b.farms<b.factories+1){b.potatoes-=b.farmCost;b.farms++;b.farmCost=Math.floor(b.farmCost*1.5);place('farm');}
        else if(b.potatoes>=b.factoryCost){b.potatoes-=b.factoryCost;b.factories++;b.factoryCost=Math.floor(b.factoryCost*1.5);place('factory');}
      });

    // ── Bot craft paint ────────────────────────────────────────────────────
    if(state.tickCount%craftInt===0)
      state.bots.forEach(b=>{if(b.pixels>0){const m=1+0.2*b.infrastructures;b.paintUnits+=Math.floor(4*(1+b.factories)*m);}});

    // ── Defense Towers auto-fire at enemy units ────────────────────────────
    for(const tower of state.buildings.filter(b=>b.type==='tower')){
      if(!tower.towerCd) tower.towerCd=0;
      tower.towerCd--;
      if(tower.towerCd<=0){
        tower.towerCd=12;
        // Find nearest enemy unit within range 4
        let best=null,bestDist=999;
        for(const u of state.units){
          if(u.ownerId===tower.ownerId)continue;
          const d=Math.abs(u.x-tower.x)+Math.abs(u.y-tower.y);
          if(d<=4&&d<bestDist){bestDist=d;best=u;}
        }
        if(best){best.hp-=2;best.damageFlash=4;if(best.hp<=0){state.units=state.units.filter(u=>u!==best);}}
      }
    }

    // ── Unit logic ─────────────────────────────────────────────────────────
    // Commander aura: units adjacent to a commander (same team) get -3 cd bonus
    const commanderPositions=state.units.filter(u=>u.type==='commander').map(u=>({x:u.x,y:u.y,ownerId:u.ownerId}));
    const hasCommanderNearby=(u)=>commanderPositions.some(c=>c.ownerId===u.ownerId&&Math.abs(c.x-u.x)<=3&&Math.abs(c.y-u.y)<=3);

    // Remove dead units & orphaned (tile captured)
    state.units=state.units.filter(u=>{
      if(u.hp<=0)return false;
      if(!isOwned(state.grid[u.y]?.[u.x],u.ownerId))return false;
      return true;
    });

    for(const u of state.units){
      if(u.damageFlash>0)u.damageFlash--;
      u.cd--;
      const cdBonus=hasCommanderNearby(u)?3:0;
      const effCd=Math.max(1,UNITS[u.type].cd-cdBonus);

      if(u.cd<=0){
        u.cd=effCd;
        const uData=UNITS[u.type];
        const range=uData.range;

        // Collect tiles in attack range
        let tgts=[];
        for(let dy=-range;dy<=range;dy++) for(let dx=-range;dx<=range;dx++){
          if(dy===0&&dx===0)continue;
          const ny=u.y+dy,nx=u.x+dx;
          if(ny<0||ny>=GRID_H||nx<0||nx>=GRID_W)continue;
          const cell=state.grid[ny][nx];
          // Can attack enemy territory, fort walls (demo only breaks walls), neutral
          if(!isOwned(cell,u.ownerId)&&cell!==9) tgts.push({y:ny,x:nx,dy,dx});
        }

        if(tgts.length>0){
          // Demo units prefer buildings/forts
          if(u.type==='demo'){
            tgts.sort((a,b)=>{
              const ba=state.buildings.some(bd=>bd.x===a.x&&bd.y===a.y);
              const bb=state.buildings.some(bd=>bd.x===b.x&&bd.y===b.y);
              const wa=isFortWall(state.grid[a.y][a.x]);
              const wb=isFortWall(state.grid[b.y][b.x]);
              return (bb||wb?1:0)-(ba||wa?1:0);
            });
          }

          // How many tiles to hit (ranger hits 3)
          const shots=u.type==='ranger'?3:1;
          let hit=0;
          for(let i=0;i<tgts.length&&hit<shots;i++){
            const t=tgts[i];
            const cell=state.grid[t.y][t.x];

            // Fort wall: only demo can break through (others are blocked)
            if(isFortWall(cell)){
              if(u.type==='demo'){
                // Damage the fort building itself
                const fortBldIdx=state.buildings.findIndex(b=>{
                  if(b.type !== 'fort' || b.ownerId !== fortWallOwner(cell)) return false;
                  const bw = BLDG.fort.w, bh = BLDG.fort.h;
                  // Check if this specific wall tile is part of this fort's perimeter
                  return t.x >= b.x - 1 && t.x <= b.x + bw && t.y >= b.y - 1 && t.y <= b.y + bh;
                });
                if(fortBldIdx>=0)damageBuilding(fortBldIdx,u.ownerId);
              }
              // Non-demo units are blocked by fort walls
              continue;
            }

            // Check for building on tile
            const bldIdx=state.buildings.findIndex(b => {
              const bw = BLDG[b.type].w || 1;
              const bh = BLDG[b.type].h || 1;
              return b.ownerId !== u.ownerId && t.x >= b.x && t.x < b.x + bw && t.y >= b.y && t.y < b.y + bh;
            });
            if(bldIdx>=0){
              // Tower defense shoots back!
              if(state.buildings[bldIdx].type==='tower'){
                u.hp-=1;
                state.buildings[bldIdx].damageFlash=4;
              }
              damageBuilding(bldIdx,u.ownerId);
              hit++;
            } else {
              // Attack enemy unit on tile
              const enemyUnit=state.units.find(eu=>eu.x===t.x&&eu.y===t.y&&eu.ownerId!==u.ownerId);
              if(enemyUnit){
                enemyUnit.hp-=uData.atk;
                enemyUnit.damageFlash=4;
                if(enemyUnit.hp<=0)state.units=state.units.filter(eu=>eu!==enemyUnit);
              } else {
                // Paint the tile
                state.grid[t.y][t.x]=u.ownerId;
              }
              hit++;
            }
            u.dir=[t.dy,t.dx]; u.shootFlash=5;
          }

          // Move toward border (scouts move faster)
          const movePct=u.type==='scout'?0.8:0.3;
          if(Math.random()<movePct){
            const bt=findBorderTile(state.grid,u.ownerId);
            if(bt){u.x=bt.x;u.y=bt.y;}
          }
        } else {
          const bt=findBorderTile(state.grid,u.ownerId);
          if(bt){u.x=bt.x;u.y=bt.y;}
        }
      }
    }

    // ── Bot expansion ──────────────────────────────────────────────────────
    if(state.tickCount%expandInt===0)
      state.bots.forEach(b=>{
        if(b.pixels<=0||b.paintUnits<=0)return;
        const tgts=[];
        for(let y=0;y<GRID_H;y++) for(let x=0;x<GRID_W;x++)
          if(isOwned(state.grid[y][x],b.id)) for(const[dy,dx]of DIRS){
            const ny=y+dy,nx=x+dx;
            if(ny>=0&&ny<GRID_H&&nx>=0&&nx<GRID_W&&!isOwned(state.grid[ny][nx],b.id)&&state.grid[ny][nx]!==9)
              tgts.push({y:ny,x:nx});
          }
        if(!tgts.length)return;
        for(let i=tgts.length-1;i>0;i--){const j=rnd(i+1);[tgts[i],tgts[j]]=[tgts[j],tgts[i]];}
        let limit=Math.floor(b.pixels*diffMul)+baseLimit,used=0;
        for(let i=0;i<tgts.length&&used<limit&&b.paintUnits>0;i++){
          const t=tgts[i]; const cell=state.grid[t.y][t.x];
          // Bots CANNOT spread over fort walls
          if(isFortWall(cell))continue;
          const bldIdx=state.buildings.findIndex(bd => {
            const bw = BLDG[bd.type].w || 1;
            const bh = BLDG[bd.type].h || 1;
            return bd.ownerId !== b.id && t.x >= bd.x && t.x < bd.x + bw && t.y >= bd.y && t.y < bd.y + bh;
          });
          if(bldIdx>=0){damageBuilding(bldIdx,b.id);}
          else{state.grid[t.y][t.x]=b.id;b.paintUnits--;used++;}
        }
      });

    // Orphan-check buildings
    state.buildings=state.buildings.filter(b=>isOwned(state.grid[b.y]?.[b.x],b.ownerId));

    if(state.tickCount%2===0){ syncUI(); updateGridCache(); }
  },[syncUI,addCocoa]);

  // ── Engine ─────────────────────────────────────────────────────────────────
  useEffect(()=>{
    if(gameStatus!=='playing')return;
    const ti=setInterval(updateLogic,TICK_RATE);
    const rf=()=>{drawCanvas();requestRef.current=requestAnimationFrame(rf);};
    requestRef.current=requestAnimationFrame(rf);
    const up=()=>{isMouseDown.current=false;};
    window.addEventListener('mouseup',up);
    return()=>{clearInterval(ti);cancelAnimationFrame(requestRef.current);window.removeEventListener('mouseup',up);};
  },[gameStatus,updateLogic,drawCanvas]);

  // ── Canvas click - paint + milbase popup ──────────────────────────────────
  const handleCanvasClick = useCallback((e,isDown)=>{
    if(gameStatus!=='playing')return;
    const rect=canvasRef.current.getBoundingClientRect();
    const sx=canvasRef.current.width/rect.width,sy=canvasRef.current.height/rect.height;
    const cx=Math.floor(((e.clientX-rect.left)*sx)/CELL_SIZE);
    const cy=Math.floor(((e.clientY-rect.top)*sy)/CELL_SIZE);
    if(cx<0||cx>=GRID_W||cy<0||cy>=GRID_H)return;
    const state=stateRef.current;

    // Check if clicking a player milbase — show popup
    if(isDown){
      const milbase=state.buildings.find(b=>b.type==='milbase'&&b.ownerId===1&&b.x===cx&&b.y===cy);
      if(milbase){setPopup({type:'milbase',building:milbase});return;}
    }

    // Paint
    if(!isMouseDown.current&&!isDown)return;
    if(state.player.paintUnits<=0)return;
    const span=BUCKET_UPGRADES[bucketRef.current].radius;
    const painted=[];
    for(let dy=-(span-1);dy<=(span-1);dy++) for(let dx=-(span-1);dx<=(span-1);dx++){
      const x=cx+dx,y=cy+dy;
      if(x<0||x>=GRID_W||y<0||y>=GRID_H)continue;
      if(isOwned(state.grid[y][x],1))continue;
      if(state.grid[y][x]===9)continue;
      if(state.player.paintUnits<=0)break;
      // Fort walls block player paint (unless demo unit later breaks them)
      if(isFortWall(state.grid[y][x]))continue;
      let adj=false;
      for(const[ay,ax]of[[-1,0],[1,0],[0,-1],[0,1]]){
        const ny2=y+ay,nx2=x+ax;
        if(ny2>=0&&ny2<GRID_H&&nx2>=0&&nx2<GRID_W&&isOwned(state.grid[ny2][nx2],1)){adj=true;break;}
      }
      if(!adj&&painted.length>0)for(const p of painted)if(Math.abs(p.x-x)<=1&&Math.abs(p.y-y)<=1){adj=true;break;}
      if(!adj)continue;
      const bldIdx=state.buildings.findIndex(b => {
        const bw = BLDG[b.type].w || 1;
        const bh = BLDG[b.type].h || 1;
        return b.ownerId !== 1 && x >= b.x && x < b.x + bw && y >= b.y && y < b.y + bh;
      });
      if(bldIdx>=0){
        const bld=state.buildings[bldIdx];
        bld.hp--;bld.damageFlash=6;
        if(bld.hp<=0){
          addCocoa(BLDG[bld.type].cocoaReward);
          if(bld.type==='fort')for(const{x:wx,y:wy}of getBuildingPerimeter(bld.x, bld.y, BLDG.fort.w, BLDG.fort.h))
            if(state.grid[wy][wx]===FORT_WALL_OFFSET+bld.ownerId)state.grid[wy][wx]=bld.ownerId;
          state.buildings.splice(bldIdx,1);
        }
        state.player.paintUnits--;
      } else {
        state.grid[y][x]=1;state.player.paintUnits--;painted.push({x,y});
      }
    }
    if(painted.length>0){
      const ctx=canvasRef.current.getContext('2d');
      ctx.fillStyle=COLORS[1];
      for(const p of painted)ctx.fillRect(p.x*CELL_SIZE,p.y*CELL_SIZE,CELL_SIZE,CELL_SIZE);
      syncUI();
    }
  },[gameStatus,syncUI,addCocoa]);

  // ── Purchase helpers ───────────────────────────────────────────────────────
  const handleCraftPaint=()=>{
    if(gameStatus!=='playing')return;
    const p=stateRef.current.player;
    p.paintUnits+=Math.floor(4*(1+p.factories)*(1+0.2*p.infrastructures));
    syncUI();
  };

  const buyBuilding=(type)=>{
    const p=stateRef.current.player;
    const def=BLDG[type]; const costK=def.costKey; const cntK=def.countKey;
    if(p.potatoes<p[costK])return;
    p.potatoes-=p[costK]; p[cntK]++; p[costK]=Math.floor(p[costK]*def.baseMul);
    const tiles=findTiles(stateRef.current.grid,1);
    if(!tiles.length)return;
    const bw = def.w || 1;
    const bh = def.h || 1;
    // Try to find a valid placement spot
    let placed = false;
    for(let attempt=0;attempt<30&&!placed;attempt++){
      const tile=tiles[rnd(tiles.length)];
      if(canPlaceBuilding(stateRef.current.grid,tile.x,tile.y,bw,bh,1,stateRef.current.buildings)){
        const bld={x:tile.x,y:tile.y,type,ownerId:1,hp:def.hp,damageFlash:0};
        stateRef.current.buildings.push(bld);
        placed=true;
        if(type==='fort'){
          for(const{x,y}of getBuildingPerimeter(tile.x, tile.y, bw, bh)){
            if(stateRef.current.grid[y][x]===1) stateRef.current.grid[y][x]=FORT_WALL_OFFSET+1;
          }
        }
      }
    }
    syncUI();
  };

  const deployUnit=(type)=>{
    const p=stateRef.current.player;
    if(p.milbases===0)return; // Require military base
    const uDef=UNITS[type]; const costK=uDef.costKey;
    if(p.potatoes<p[costK])return;
    if(uDef.advanced&&!p.milbaseAdvanced)return; // Require advanced base
    p.potatoes-=p[costK]; p[costK]=Math.floor(p[costK]*1.4);
    const t=findBorderTile(stateRef.current.grid,1)||findTiles(stateRef.current.grid,1)[0];
    if(!t)return;
    stateRef.current.units.push({
      x:t.x, 
      y:t.y, 
      visualX: t.x, 
      visualY: t.y, 
      ownerId:1, 
      type, 
      hp:uDef.hp, 
      dir:[0,1], 
      cd:0, 
      shootFlash:0, 
      damageFlash:0, 
      id:Math.random()
    });
    syncUI();
  };

  const upgradeMilbase=()=>{
    const p=stateRef.current.player;
    if(p.milbaseAdvanced)return;
    const cost=600;
    if(p.potatoes<cost)return;
    p.potatoes-=cost; p.milbaseAdvanced=true;
    setPopup(null); syncUI();
  };

  const buyBucketUpgrade=()=>{
    const next=bucketLevel+1; if(next>=BUCKET_UPGRADES.length)return;
    const cost=BUCKET_UPGRADES[next].cocoaCost; if(cocoaBeans<cost)return;
    setCocoaBeans(p=>{const nv=p-cost;localStorage.setItem('cocoaBeans',nv);return nv;});
    setBucketLevel(next);
  };

  const startGame=()=>{stateRef.current=createInitialState(settings);setGameStatus('playing');syncUI();};
  const formatTime=t=>{const s=Math.max(0,settings.duration-Math.floor(t/10));return`${Math.floor(s/60)}:${(s%60).toString().padStart(2,'0')}`;};
  const togglePanel=p=>setPanelOpen(prev=>({units:false,buildings:false,[p]:!prev[p]}));
  const paintPerClick=Math.floor(4*(1+ui.factories)*(1+0.2*ui.infrastructures));
  const canBuyAdvanced=ui.milbases>0&&!ui.milbaseAdvanced;

  return (
    <div style={{fontFamily:"'Segoe UI',system-ui,sans-serif"}} className="min-h-screen bg-slate-100 text-slate-800 flex flex-col p-3 md:p-5">

      {/* Header */}
      <header className="mb-3 flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-black text-blue-600 flex items-center gap-2">
          <PaintBucket size={24} strokeWidth={2.5}/> PaintBlitz.io
        </h1>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="bg-amber-50 border border-amber-200 px-3 py-1 rounded-full flex items-center gap-1.5 text-sm font-bold text-amber-700">🫘 {fmt(cocoaBeans)}</div>
          {gameStatus==='playing'&&settings.duration>0&&(
            <span className="bg-white px-3 py-1 rounded-full text-sm font-bold shadow-sm border border-slate-200 flex items-center gap-1"><Clock size={13}/> {formatTime(ui.tickCount)}</span>
          )}
          {gameStatus==='playing'&&(
            <span className="bg-white px-3 py-1 rounded-full text-sm font-bold shadow-sm border border-slate-200 text-slate-500">{ui.pixels} px</span>
          )}
        </div>
      </header>

      <div className="flex flex-col lg:flex-row gap-4 items-start max-w-[1400px] mx-auto w-full">

        {/* Sidebar */}
        <aside className="w-full lg:w-72 shrink-0 flex flex-col gap-3">

          {/* Stats */}
          <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-200">
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-slate-50 p-3 rounded-xl flex flex-col items-center border border-slate-100">
                <span className="text-slate-400 text-[10px] font-bold uppercase tracking-wider mb-1">Potatoes</span>
                <span className="text-xl font-black text-slate-700">{fmt(ui.potatoes)} 🥔</span>
                <span className="text-[10px] text-emerald-500 font-bold bg-emerald-50 px-2 py-0.5 rounded-full mt-1">
                  +{Math.floor((ui.pixels+ui.farms*10)*(1+0.2*ui.infrastructures))}/s
                </span>
              </div>
              <div className="bg-blue-50 p-3 rounded-xl flex flex-col items-center border border-blue-100">
                <span className="text-blue-400 text-[10px] font-bold uppercase tracking-wider mb-1">Paint</span>
                <span className="text-xl font-black text-blue-600">{fmt(ui.paintUnits)} 🪣</span>
                  {ui.paintUnits===0&&gameStatus==='playing'&&<span className="text-[10px] text-red-500 font-bold mt-1 animate-pulse">EMPTY!</span>}
              </div>
            </div>
              {unlockedBucket>0&&(
              <div className="mt-2 flex items-center justify-center gap-1.5 bg-purple-50 border border-purple-200 rounded-xl px-3 py-1.5">
                <span className="text-sm">🪣</span>
                  <span className="text-xs font-bold text-purple-700">{BUCKET_UPGRADES[activeBucket].label} Bucket · {BUCKET_UPGRADES[activeBucket].desc}</span>
              </div>
            )}
          </div>

          {/* Produce Paint */}
          <button onClick={handleCraftPaint} disabled={gameStatus!=='playing'}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-bold py-3 rounded-xl shadow active:scale-[0.98] transition-all flex flex-col items-center border-b-4 border-blue-800 active:border-b-0 active:translate-y-1">
            <div className="flex items-center gap-2 text-base"><PaintBucket size={18}/> Produce Paint</div>
            <span className="text-blue-200 text-xs">+{paintPerClick} uses</span>
          </button>

          {/* ── Units Panel ── */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
            <button onClick={()=>togglePanel('units')} className="w-full flex items-center justify-between px-4 py-3 font-bold text-slate-700 hover:bg-slate-50 transition-colors">
              <span className="flex items-center gap-2 text-sm">
                <Sword size={15} className="text-red-500"/> Army Units {/* Changed 🏢 to text */}
                {ui.milbases===0&&gameStatus==='playing'&&<span className="bg-orange-100 text-orange-600 text-[10px] font-bold px-2 py-0.5 rounded-full">Needs 🏢</span>}
              </span>
              {panelOpen.units?<ChevronUp size={15}/>:<ChevronDown size={15}/>}
            </button>
            {panelOpen.units&&(
              <div className="px-3 pb-4 border-t border-slate-100">
                {ui.milbases===0&&(
                  <div className="mt-3 bg-orange-50 border border-orange-200 rounded-xl p-3 text-xs text-orange-700 font-medium text-center">
                    Build a 🏢 Military Base first to train units!
                  </div>
                )}
                <div className="mt-3 grid grid-cols-1 gap-2">
                  {Object.entries(UNITS).map(([type,uDef])=>{
                    const cost=ui[uDef.costKey]; const count=ui.unitCounts[type]||0;
                    const locked=uDef.advanced&&!ui.milbaseAdvanced;
                    const noBase=ui.milbases===0;
                    const canBuy=gameStatus==='playing'&&!locked&&!noBase&&ui.potatoes>=cost;
                    return(
                      <div key={type} className={`flex items-center gap-3 p-2.5 rounded-xl border transition-all ${locked?'border-purple-200 bg-purple-50':noBase?'border-slate-200 bg-slate-50':'border-slate-200 bg-slate-50'}`}>
                        <img src={`/Assets/Textures/${uDef.sprite}`} alt={type} className="w-6 h-6 object-contain" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-black text-slate-700 capitalize">{type}</span>
                            {uDef.advanced&&<span className="bg-purple-100 text-purple-600 text-[9px] font-bold px-1.5 rounded-full">ADV</span>}
                            {count>0&&<span className="bg-slate-200 text-slate-600 text-[9px] font-bold px-1.5 rounded-full">{count} out</span>}
                          </div>
                          <div className="text-[9px] text-slate-400">{uDef.desc} · ❤️{uDef.hp} atk:{uDef.atk}</div>
                          {locked&&<div className="text-[9px] text-purple-500 font-bold">Upgrade base to unlock</div>}
                        </div>
                        <button onClick={()=>deployUnit(type)} disabled={!canBuy}
                          className={`shrink-0 text-[10px] font-bold px-2 py-1.5 rounded-lg transition-all ${canBuy?'bg-red-500 hover:bg-red-600 text-white':'bg-slate-200 text-slate-400 cursor-not-allowed'}`}>
                          {fmt(cost)}🥔
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* ── Buildings Panel ── */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
            <button onClick={()=>togglePanel('buildings')} className="w-full flex items-center justify-between px-4 py-3 font-bold text-slate-700 hover:bg-slate-50 transition-colors">
              <span className="flex items-center gap-2 text-sm"><Building2 size={15} className="text-emerald-500"/> Buildings</span>
              {panelOpen.buildings?<ChevronUp size={15}/>:<ChevronDown size={15}/>}
            </button>
            {panelOpen.buildings&&(
              <div className="px-3 pb-4 border-t border-slate-100">
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {[
                    {type:'factory',color:'emerald',cb:()=>buyBuilding('factory')},
                    {type:'farm',   color:'amber',  cb:()=>buyBuilding('farm')},
                    {type:'fort',   color:'slate',  cb:()=>buyBuilding('fort')},
                    {type:'infra',  color:'indigo', cb:()=>buyBuilding('infra')},
                    {type:'milbase',color:'purple', cb:()=>buyBuilding('milbase')},
                    {type:'tower',  color:'rose',   cb:()=>buyBuilding('tower')},
                  ].map(({type,color,cb})=>{
                    const def=BLDG[type]; const cost=ui[def.costKey]; const lvl=ui[def.countKey];
                    const canBuy=gameStatus==='playing'&&ui.potatoes>=cost;
                    const cls={emerald:'bg-emerald-500 hover:bg-emerald-600 border-emerald-700',amber:'bg-amber-500 hover:bg-amber-600 border-amber-700',slate:'bg-slate-600 hover:bg-slate-700 border-slate-800',indigo:'bg-indigo-500 hover:bg-indigo-600 border-indigo-700',purple:'bg-purple-600 hover:bg-purple-700 border-purple-800',rose:'bg-rose-500 hover:bg-rose-600 border-rose-700'};
                    return(
                      <button key={type} onClick={cb} disabled={!canBuy}
                        className={`flex flex-col items-center p-3 rounded-xl border-b-4 transition-all active:translate-y-1 active:border-b-0 ${canBuy?cls[color]+' text-white':'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'}`}>
                        <img src={`/Assets/Textures/${def.sprite}`} alt={type} className="w-8 h-8 mb-1 object-contain" />
                        <span className="text-[11px] font-black capitalize">{type==='milbase'?'Mil.Base':type}</span>
                        <span className="text-[9px] opacity-80">{def.desc}</span>
                        <span className="text-[9px] opacity-50 mb-1">HP:{def.hp}</span>
                        <div className="bg-black/10 px-2 py-0.5 rounded-full text-[10px] font-bold w-full text-center">{fmt(cost)}🥔</div>
                        {lvl>0&&<span className="text-[9px] mt-1 opacity-70">×{lvl}</span>}
                        {type==='milbase'&&ui.milbaseAdvanced&&<span className="text-[9px] mt-0.5 text-yellow-200 font-bold">⭐ ADV</span>}
                        {type==='milbase'&&!ui.milbaseAdvanced&&ui.milbases>0&&<span className="text-[9px] mt-0.5 opacity-60">tap to upgrade</span>}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-2 bg-blue-50 border border-blue-200 rounded-xl p-2 text-[10px] text-blue-600">
                  💡 <b>Fort</b>: creates impassable wall tiles — only 💣 Demo units can breach them. <b>Click any fort emoji</b> on the map to see details.
                </div>
              </div>
            )}
          </div>

          {/* Leaderboard */}
          <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-200">
            <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-2"><Trophy size={13}/> Leaderboard</h2>
            <div className="flex flex-col gap-1.5">
              {ui.leaderboard.map((e,i)=>(
                <div key={e.id} className="flex justify-between items-center px-2 py-1.5 rounded-lg bg-slate-50">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span className="text-xs text-slate-400 w-3">{i+1}.</span>
                    <div className="w-2.5 h-2.5 rounded-full" style={{backgroundColor:e.color}}/>
                    <span className={e.id===1?'text-blue-600 font-bold':'text-slate-600'}>{e.name}</span>
                  </div>
                  <span className="text-xs font-bold text-slate-700">{fmt(e.pixels)}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>

        {/* Canvas */}
        <main className="flex-1 relative rounded-2xl overflow-hidden shadow-lg border-4 border-white bg-white">
          <canvas ref={canvasRef} width={GRID_W*CELL_SIZE} height={GRID_H*CELL_SIZE}
            className="w-full h-auto cursor-crosshair touch-none"
            onMouseDown={e=>{isMouseDown.current=true;handleCanvasClick(e,true);}}
            onMouseMove={e=>{if(isMouseDown.current)handleCanvasClick(e,false);}}
            onMouseLeave={()=>{isMouseDown.current=false;}}
            onMouseUp={()=>{isMouseDown.current=false;}}/>

          {/* In-Canvas Milbase upgrade UI */}
          {popup?.type==='milbase'&&(
            <div className="absolute top-4 right-4 w-72 bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden z-40 animate-in fade-in zoom-in duration-200">
              <div className="bg-slate-800 p-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <img src="/Assets/Textures/milbase.png" alt="Milbase" className="w-6 h-6"/>
                  <span className="text-white font-bold text-sm">Military Ops</span>
                </div>
                <button onClick={()=>setPopup(null)} className="text-slate-400 hover:text-white"><X size={18}/></button>
              </div>
              <div className="p-4 space-y-3">
                <div className="bg-slate-50 rounded-xl p-2.5 text-[10px] space-y-1.5 border border-slate-100">
                  <div className="font-bold text-slate-500 uppercase tracking-tight">Available Units:</div>
                  {Object.entries(UNITS).map(([k,v])=>(
                    <div key={k} className={`flex items-center gap-2 ${v.advanced&&!ui.milbaseAdvanced?'opacity-40':''}`}>
                      <img src={`/Assets/Textures/${v.sprite}`} alt={k} className="w-3.5 h-3.5"/>
                      <span className="font-bold text-slate-700">{k}</span>
                      {v.advanced&&<span className="text-[8px] text-purple-500 font-bold">[ADV]</span>}
                    </div>
                  ))}
                </div>
                {!ui.milbaseAdvanced?(
                  <button onClick={upgradeMilbase} disabled={ui.potatoes<600}
                    className="w-full bg-purple-600 hover:bg-purple-700 disabled:bg-slate-200 disabled:text-slate-400 text-white font-bold py-2 rounded-xl flex items-center justify-center gap-2 text-xs transition-all">
                    <ArrowUp size={14}/> Upgrade Base (600 🥔)
                  </button>
                ):(
                  <div className="text-center py-2 bg-purple-50 text-purple-600 font-bold text-[10px] rounded-lg border border-purple-100">⭐ Advanced Base Active</div>
                )}
              </div>
            </div>
          )}

          {/* Menu */}
          {gameStatus==='menu'&&(
            <div className="absolute inset-0 bg-slate-900/85 backdrop-blur-sm flex items-center justify-center p-4 z-50">
              <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden">
                <div className="flex border-b border-slate-200">
                  <button onClick={()=>setMenuTab('setup')} className={`flex-1 py-3.5 text-sm font-bold flex items-center justify-center gap-2 transition-colors ${menuTab==='setup'?'text-blue-600 border-b-2 border-blue-600 bg-blue-50/40':'text-slate-500 hover:bg-slate-50'}`}>
                    <Settings size={14}/> Game Setup
                  </button>
                  <button onClick={()=>setMenuTab('upgrade')} className={`flex-1 py-3.5 text-sm font-bold flex items-center justify-center gap-2 transition-colors ${menuTab==='upgrade'?'text-amber-600 border-b-2 border-amber-500 bg-amber-50/40':'text-slate-500 hover:bg-slate-50'}`}>
                    <ShoppingBag size={14}/> Upgrade Shop
                    <span className="bg-amber-100 text-amber-700 text-[10px] font-black px-1.5 py-0.5 rounded-full">🫘{fmt(cocoaBeans)}</span>
                  </button>
                </div>
                <div className="p-6">
                  {menuTab==='setup'&&(
                    <>
                      <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200 mb-5 space-y-3">
                        {[
                          {label:'Duration',icon:<Clock size={14}/>,key:'duration',opts:[{v:0,l:'Endless'},{v:120,l:'2 min'},{v:300,l:'5 min'}]},
                          {label:'Bots',icon:<Settings size={14}/>,key:'botCount',opts:[{v:1,l:'1 Enemy'},{v:2,l:'2 Enemies'},{v:3,l:'3 Enemies'}]},
                          {label:'Difficulty',icon:<Shield size={14}/>,key:'difficulty',opts:[{v:'easy',l:'Easy'},{v:'normal',l:'Normal'},{v:'hard',l:'Hard'}]},
                        ].map(({label,icon,key,opts})=>(
                          <div key={key} className="flex items-center justify-between">
                            <label className="font-bold text-slate-600 flex items-center gap-2 text-sm">{icon} {label}</label>
                            <select value={settings[key]} onChange={e=>setSettings({...settings,[key]:isNaN(Number(e.target.value))?e.target.value:Number(e.target.value)})}
                              className="bg-white border border-slate-300 text-slate-700 rounded-lg px-2 py-1.5 text-sm font-medium focus:outline-none focus:border-blue-500">
                              {opts.map(o=><option key={o.v} value={o.v}>{o.l}</option>)}
                            </select>
                          </div>
                        ))}
                      </div>
                      {unlockedBucket>0&&<div className="mb-4 flex items-center gap-2 bg-purple-50 border border-purple-200 rounded-xl px-3 py-2 text-xs font-bold text-purple-700"><Star size={12}/> Active: {BUCKET_UPGRADES[activeBucket].label} Bucket — {BUCKET_UPGRADES[activeBucket].desc}</div>}
                      <button onClick={startGame} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-black text-lg py-3.5 rounded-xl shadow-lg flex justify-center items-center gap-2">
                        <Play fill="currentColor" size={18}/> START PAINTING
                      </button>
                    </>
                  )}
                  {menuTab==='upgrade'&&(
                    <div className="space-y-4">
                      <p className="text-xs text-slate-400">Earn <span className="font-bold text-amber-600">🫘 Cocoa Beans</span> by destroying enemy buildings. Upgrades persist between games.</p>
                      <div className="bg-slate-50 rounded-2xl border border-slate-200 p-4">
                        <div className="flex items-center gap-3 mb-3"><span className="text-3xl">🪣</span><div><div className="font-black text-slate-800">Paint Bucket Upgrade</div><div className="text-xs text-slate-400">Larger radius = more area painted per stroke</div></div></div>
                        <div className="grid grid-cols-4 gap-1.5 mb-4"> {/* Bucket emojis are kept as they were not part of the request */}
                          {BUCKET_UPGRADES.map((u,i)=>{
                            const isUnlocked = i <= unlockedBucket;
                            const isActive = i === activeBucket;
                            return (
                              <div key={i} 
                                onClick={() => isUnlocked && setActiveBucket(i)}
                                className={`flex flex-col items-center p-2.5 rounded-xl border-2 cursor-pointer transition-all ${isActive?'border-blue-500 bg-blue-50 shadow-sm':isUnlocked?'border-slate-300 bg-white hover:border-blue-300':'border-slate-200 bg-slate-100 opacity-60 cursor-default'}`}>
                                <span className="text-xl mb-1">{['🪣','🪣💧','🪣💦','🪣🌊'][i]}</span>
                                <span className="text-[10px] font-black text-slate-700 text-center">{u.label}</span>
                                {isActive ? (
                                  <span className="text-[9px] font-bold text-blue-600 mt-1">Equipped</span>
                                ) : isUnlocked ? (
                                  <span className="text-[9px] font-bold text-slate-400 mt-1 italic">Equip</span>
                                ) : (
                                  <span className="text-[9px] font-bold text-amber-600 mt-1">🫘{u.cocoaCost}</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        {unlockedBucket < BUCKET_UPGRADES.length - 1 ? (
                          <button onClick={() => {
                            const next = unlockedBucket + 1;
                            if (cocoaBeans >= BUCKET_UPGRADES[next].cocoaCost) {
                              setCocoaBeans(p => p - BUCKET_UPGRADES[next].cocoaCost);
                              setUnlockedBucket(next);
                              setActiveBucket(next);
                            }
                          }} disabled={cocoaBeans < BUCKET_UPGRADES[unlockedBucket+1].cocoaCost}
                            className="w-full bg-amber-500 hover:bg-amber-600 disabled:bg-slate-200 disabled:text-slate-400 text-white font-bold py-2.5 rounded-xl text-sm flex items-center justify-center gap-2 border-b-4 border-amber-700 active:border-b-0 active:translate-y-1 disabled:border-slate-300">
                            <Star size={14}/> Buy Next: {BUCKET_UPGRADES[unlockedBucket+1].label}
                            <span className="bg-black/15 px-2 py-0.5 rounded-lg">🫘{BUCKET_UPGRADES[unlockedBucket+1].cocoaCost}</span>
                          </button>
                        ):(
                          <div className="w-full bg-gradient-to-r from-purple-500 to-blue-500 text-white font-bold py-2.5 rounded-xl text-sm flex items-center justify-center gap-2">
                            <Star size={14} fill="currentColor"/> MAX LEVEL!
                          </div>
                        )}
                      </div>
                      <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                        <div className="font-bold text-amber-800 text-xs mb-2">🫘 Cocoa Bean Rewards</div>
                        <div className="space-y-1">
                          {Object.entries(BLDG).map(([type,def])=>(
                            <div key={type} className="flex justify-between text-xs text-amber-700">
                              <span className="flex items-center gap-1.5"><img src={`/Assets/Textures/${def.sprite}`} alt={type} className="w-3 h-3" /> Destroy {type}</span>
                              <span className="font-bold">+{def.cocoaReward} 🫘</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {gameStatus==='gameover'&&<Overlay bg="bg-red-900/90" icon={<Skull size={52} className="text-red-400 mx-auto mb-3"/>} title="WIPED OUT" sub="An enemy painted over your last territory." btnColor="bg-white text-red-600" onBack={()=>setGameStatus('menu')}/>}
          {gameStatus==='victory'&&<Overlay bg="bg-blue-900/90" icon={<Trophy size={52} className="text-yellow-400 mx-auto mb-3"/>} title="DOMINATION" sub="You painted the whole map!" btnColor="bg-yellow-400 text-yellow-900" onBack={()=>setGameStatus('menu')}/>}
          {gameStatus==='timeup'&&<Overlay bg="bg-indigo-900/90" icon={<Clock size={52} className="text-indigo-300 mx-auto mb-3"/>} title="TIME'S UP!" sub={ui.leaderboard[0]?.id===1?'You won!':`${ui.leaderboard[0]?.name} won!`} btnColor="bg-white text-indigo-900" onBack={()=>setGameStatus('menu')}/>}
        </main>
      </div>
    </div>
  );
}

function Overlay({bg,icon,title,sub,btnColor,onBack}){
  return(
    <div className={`absolute inset-0 ${bg} backdrop-blur-md flex items-center justify-center p-4 z-50`}>
      <div className="text-center">{icon}
        <h2 className="text-4xl font-black text-white mb-2">{title}</h2>
        <p className="text-white/70 mb-6 font-medium">{sub}</p>
        <button onClick={onBack} className={`${btnColor} font-bold py-2.5 px-8 rounded-full shadow-lg hover:scale-105 transition-transform`}>Back to Menu</button>
      </div>
    </div>
  );
}