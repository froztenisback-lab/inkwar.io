import React, { useState, useEffect, useRef, useCallback } from 'react';
import { PaintBucket, Trophy, Play, Skull, Shield, Settings, Clock, ChevronDown, ChevronUp, Sword, Building2, ShoppingBag, Star, X, ArrowUp, Ship, Waves, ZoomIn, ZoomOut, LogOut, Maximize, RotateCcw, ChevronLeft, ChevronRight, Target } from 'lucide-react';
import { MAP_SETTINGS } from './custom_map';
import { GRID_W, GRID_H, CELL_SIZE, TICK_RATE, FORT_WALL_OFFSET, getTexture, BLDG, UNITS, BUCKET_UPGRADES, COLORS, PLACEHOLDER_GRAY_RGB } from './constants';
import { fmt, rnd, clamp, isOwned, isFortWall, fortWallOwner, findTiles, canPlaceBuilding, findBorderTile, getBuildingPerimeter, makeEnt, seededRnd } from './utils';
import { createInitialState, parseImageToGrid, createRecoloredCanvas } from './mapLogic';
import Overlay from './Overlay';
import { socket } from './main';

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = src;
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
});

// --- ADD THIS ABOVE YOUR 'const Game = () => {' ---

const PlayerList = () => {
  const { presenceData } = usePresence('paintblitz-global');

  return (
    <div style={{
      position: 'fixed', top: '20px', right: '20px', 
      backgroundColor: 'rgba(0,0,0,0.7)', color: 'white',
      padding: '15px', borderRadius: '8px', zIndex: 100,
      fontFamily: 'sans-serif', minWidth: '150px'
    }}>
      <h4 style={{ margin: '0 0 10px 0', borderBottom: '1px solid #444' }}>Players</h4>
      {presenceData.map((player, i) => (
        <div key={player.clientId || i} style={{ marginBottom: '5px', fontSize: '14px' }}>
          <span style={{ color: player.data?.color || '#fff' }}>●</span> {player.data?.name || 'Joining...'}
        </div>
      ))}
    </div>
  );
};
// ─── Procedural Generation Helpers (Moved outside component) ────────────────

// Value-noise terrain: interpolates a coarse lattice of random values
const generateValueNoise = (w, h, rng, octaves = 3, persistence = 0.5) => {
  const noise = Array.from({ length: h }, () => new Float32Array(w));
  let amplitude = 1, frequency = 1, maxAmp = 0;
  for (let o = 0; o < octaves; o++) {
    const scale = Math.max(2, Math.floor(Math.min(w, h) / (2 * frequency)));
    const lw = Math.ceil(w / scale) + 2;
    const lh = Math.ceil(h / scale) + 2;
    const lattice = Array.from({ length: lh }, () => Float32Array.from({ length: lw }, () => rng()));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const gx = x / scale, gy = y / scale;
        const x0 = Math.floor(gx), y0 = Math.floor(gy);
        const tx = gx - x0, ty = gy - y0;
        const x1 = Math.min(x0 + 1, lw - 1), y1 = Math.min(y0 + 1, lh - 1);
        const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const v = lattice[y0][x0] * (1 - sx) * (1 - sy) + lattice[y0][x1] * sx * (1 - sy) + lattice[y1][x0] * (1 - sx) * sy + lattice[y1][x1] * sx * sy;
        noise[y][x] += v * amplitude;
      }
    }
    maxAmp += amplitude; amplitude *= persistence; frequency *= 2;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) noise[y][x] /= maxAmp;
  return noise;
};

const cellularAutomataPass = (grid, w, h, minNeighbors = 5) => {
  const next = Array.from({ length: h }, () => new Uint8Array(w));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const ny = y + dy, nx = x + dx;
        if (ny < 0 || ny >= h || nx < 0 || nx >= w) count++;
        else if (grid[ny][nx]) count++;
      }
      next[y][x] = count >= minNeighbors ? 1 : 0;
    }
  }
  return next;
};

const generateMaze = (w, h, rng) => {
  const cw = Math.floor((w - 1) / 2), ch = Math.floor((h - 1) / 2);
  const grid = Array.from({ length: h }, () => new Uint8Array(w).fill(1));
  const visited = Array.from({ length: ch }, () => new Uint8Array(cw));
  const stack = [];
  const carve = (cx, cy) => {
    visited[cy][cx] = 1;
    grid[cy * 2 + 1][cx * 2 + 1] = 0;
    stack.push([cx, cy]);
  };
  carve(Math.floor(rng() * cw), Math.floor(rng() * ch));
  const dirs = [[0,-1],[1,0],[0,1],[-1,0]];
  while (stack.length > 0) {
    const [cx, cy] = stack[stack.length - 1];
    const shuffled = [...dirs].sort(() => rng() - 0.5);
    let moved = false;
    for (const [dcx, dcy] of shuffled) {
      const nx = cx + dcx, ny = cy + dcy;
      if (nx >= 0 && nx < cw && ny >= 0 && ny < ch && !visited[ny][nx]) {
        grid[cy * 2 + 1 + dcy][cx * 2 + 1 + dcx] = 0;
        carve(nx, ny); moved = true; break;
      }
    }
    if (!moved) stack.pop();
  }
  return grid;
};

const largestOpenRegion = (grid, w, h) => {
  const visited = Array.from({ length: h }, () => new Uint8Array(w));
  let best = [], bestSize = 0;
  for (let sy = 0; sy < h; sy++) for (let sx = 0; sx < w; sx++) {
    if (grid[sy][sx] !== 0 || visited[sy][sx]) continue;
    const region = [], queue = [[sx, sy]]; visited[sy][sx] = 1;
    while (queue.length) {
      const [x, y] = queue.shift(); region.push([x, y]);
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x+dx, ny = y+dy;
        if (nx>=0&&nx<w&&ny>=0&&ny<h&&!visited[ny][nx]&&grid[ny][nx]===0) { visited[ny][nx]=1; queue.push([nx,ny]); }
      }
    }
    if (region.length > bestSize) { bestSize = region.length; best = region; }
  }
  return best;
};

const buildProceduralGrid = (w, h, settingsObj) => {
  const { terrainType, terrainDensity, seed } = settingsObj;
  const rng = seededRnd(seed || 'default');
  const threshold = terrainDensity / 100;
  let gameGrid = Array.from({ length: h }, () => Array(w).fill(0));

  if (['highlands', 'desert', 'mountainous'].includes(terrainType)) {
    const oct = (terrainType === 'highlands' || terrainType === 'mountainous') ? 5 : 4;
    const noise = generateValueNoise(w, h, rng, oct, 0.45);
    // Centering thresholds around 0.5-0.6 to ensure visibility even at low density
    let limit = 0.75 - (threshold * 0.6); 
    if (terrainType === 'highlands') limit = 0.65 - (threshold * 0.4);
    if (terrainType === 'mountainous') limit = 0.55 - (threshold * 0.5);
    if (terrainType === 'desert') limit = 0.85 - (threshold * 0.3);
    
    for(let y=0; y<h; y++) for(let x=0; x<w; x++) if(noise[y][x] > limit) gameGrid[y][x] = 9;
  } else if (terrainType === 'maze') {
    const raw = generateMaze(w, h, rng);
    for(let y=0; y<h; y++) for(let x=0; x<w; x++) if(raw[y][x]) gameGrid[y][x] = 9;
  } else if (['halo', 'giant_island', 'island_kingdom', 'pangea', 'archipelago', 'sea'].includes(terrainType)) {
    const cx = w/2, cy = h/2;
    const noiseMap = (['archipelago', 'island_kingdom', 'sea'].includes(terrainType)) ? generateValueNoise(w, h, rng, 3, 0.5) : null;
    for(let y=0; y<h; y++) for(let x=0; x<w; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx*dx + dy*dy);
      const normDist = dist / (Math.min(w, h) / 2);

      if (terrainType === 'halo') {
        if (dist < h/4 || dist > h/2.2) gameGrid[y][x] = 5;
      } else if (terrainType === 'pangea') {
        if (normDist > 0.75) gameGrid[y][x] = 5;
      } else if (terrainType === 'giant_island') {
        if (normDist > 0.85) gameGrid[y][x] = 5;
      } else if (terrainType === 'archipelago') {
        if (noiseMap[y][x] < 0.5) gameGrid[y][x] = 5;
        else if (noiseMap[y][x] > 0.82) gameGrid[y][x] = 9;
      } else if (terrainType === 'island_kingdom') {
        if (noiseMap[y][x] < 0.4) gameGrid[y][x] = 5;
      } else if (terrainType === 'sea') {
        if (noiseMap[y][x] < 0.7) gameGrid[y][x] = 5;
      }
    }
  }

// ── Water generation (scattered/grouped/noise-based maps only) ──────────────
// Water-dominant map types generate their own water above, so skip those.
if (!['halo', 'giant_island', 'island_kingdom', 'pangea', 'archipelago', 'sea'].includes(terrainType)) {
  const waterClusters = Math.max(5, Math.floor(threshold * 30));
  const margin = 6;
  for (let i = 0; i < waterClusters; i++) {
    const ox = margin + Math.floor(rng() * (w - margin * 2));
    const oy = margin + Math.floor(rng() * (h - margin * 2));
    const r = Math.floor(rng() * 7) + 4; // Larger radius: 4–11
    for (let y = oy - r; y <= oy + r; y++) {
      for (let x = ox - r; x <= ox + r; x++) {
        if (x >= 0 && x < w && y >= 0 && y < h
            && Math.hypot(x - ox, y - oy) < r
            && gameGrid[y][x] === 0) {  // only place on open land, never over obstacles
          gameGrid[y][x] = 5;
        }
      }
    }
  }
}
// Connect land for non-water shapes: ensure we only have one main continent
if (!['halo', 'giant_island', 'island_kingdom', 'pangea', 'archipelago', 'sea'].includes(terrainType)) {
  const open = new Set(largestOpenRegion(gameGrid.map(r=>r.map(c=>c===0?0:1)), w, h).map(([x,y]) => `${x},${y}`));
  for(let y=0; y<h; y++) for(let x=0; x<w; x++) {
    if(gameGrid[y][x] === 0 && !open.has(`${x},${y}`)) gameGrid[y][x] = 9;
  }
}
  return gameGrid;
};

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [cocoaBeans,setCocoaBeans]   = useState(()=>Number(localStorage.getItem('cocoaBeans')||0));
  const [activeBucket,setActiveBucket] = useState(()=>Number(localStorage.getItem('activeBucket')||0));
  const [unlockedBucket,setUnlockedBucket] = useState(()=>Number(localStorage.getItem('unlockedBucket')||0));
  const [gameStatus,setGameStatus]   = useState('menu');
  const [customMap,setCustomMap]     = useState(()=>{
    const saved = localStorage.getItem('customMap');
    return saved ? JSON.parse(saved) : null;
  });
  const [settings,setSettings]       = useState({
    duration:0,
    botCount:3,
    difficulty:'normal',
    mapType:'procedural',
    gameMode: 'classic',
    online: false,
    seed: Math.random().toString(36).substring(7),
    terrainDensity: 20,
    terrainType: 'pangea',
    darkThreshold: 100,
    worldMap: 'worldmap',
    passableObstacles: false,
    customMapName: 'New Arena',
    colors: { ...MAP_SETTINGS.colors }
  });
  const [myOnlineId, setMyOnlineId] = useState(1);
  const [totalPaintable, setTotalPaintable] = useState(0);
  const [showPeaceVote, setShowPeaceVote] = useState(false);
  const [menuTab,setMenuTab]         = useState('setup');
  const [zoom, setZoom]              = useState(1);
  const [camera, setCamera]          = useState({ x: 0, y: 0 });
  const [editorSubTab, setEditorSubTab] = useState('terrain'); // 'terrain', 'design', 'teams'
  const [editorTool, setEditorTool] = useState('obstacle'); // 'obstacle' | 'water' | 'erase' | 'spawn1' | 'spawn2'
  const [editorBrush, setEditorBrush] = useState(1); // 1, 2, 3 cell radius
  const editorBotCycle = useRef(2); // cycles 2,3,4 for multi-bot spawn placement
  const [dims, setDims] = useState(() => {
    const saved = localStorage.getItem('customMap');
    if (saved) {
      try { const m = JSON.parse(saved); return { w: m[0].length, h: m.length }; } catch { /**/ }
    }
    return { w: GRID_W, h: GRID_H };
  });
  // Popup: { type:'milbase', building: {...} } or null
  const [popup,setPopup]             = useState(null);

  const canvasRef  = useRef(null);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 768px)').matches);
  const gridCanvasRef = useRef(null); // Off-screen cache for the grid
  const viewportRef = useRef(null);
  const requestRef = useRef(null);
  const stateRef   = useRef(null);
  const [loadedImages, setLoadedImages] = useState({});
  // Cache for recolored versions: "spritePath-color" -> HTMLCanvasElement
  const spriteCache = useRef(new Map());
  
  const [imagesLoaded, setImagesLoaded] = useState(false);
  const isMouseDown= useRef(false);
  const [mobileBottomTab, setMobileBottomTab] = useState('units'); // 'units' or 'buildings'
  const panStatus  = useRef({ active: false, x: 0, y: 0 });
  const bucketRef  = useRef(activeBucket);
  useEffect(()=>{bucketRef.current=activeBucket;},[activeBucket]);

  // Camera bounds helper to keep the map visible within the viewport
  const clampCamera = useCallback((x, y, currentZoom) => {
    const v = viewportRef.current;
    const s = stateRef.current;
    if (!v || !s) return { x, y };
    const worldW = s.width * CELL_SIZE * currentZoom;
    const worldH = s.height * CELL_SIZE * currentZoom;
    const viewW = v.clientWidth || window.innerWidth;
    const viewH = v.clientHeight || window.innerHeight;
    return {
      x: worldW > viewW ? clamp(x, 0, worldW - viewW) : (worldW - viewW) / 2,
      y: worldH > viewH ? clamp(y, 0, worldH - viewH) : (worldH - viewH) / 2
    };
  }, []);

  // Reusable Zoom Logic: nextZoom is the target scale, anchorX/Y are viewport-relative pixels
  const performZoom = useCallback((nextZoom, anchorX, anchorY) => {
    setCamera(prev => {
      const worldX = (prev.x + anchorX) / zoom;
      const worldY = (prev.y + anchorY) / zoom;
      const nextX = worldX * nextZoom - anchorX;
      const nextY = worldY * nextZoom - anchorY;
      return clampCamera(nextX, nextY, nextZoom);
    });
    setZoom(nextZoom);
  }, [zoom, clampCamera]);

  const handleWheel = useCallback((e) => {
    const v = viewportRef.current;
    if (!v) return;

    // Block trackpad pinch-to-zoom gestures (sent as wheel events with ctrlKey)
    if (e.ctrlKey) {
      e.preventDefault();
      return;
    }

    e.preventDefault();
    const zoomSpeed = 0.12;
    const factor = 1 + (e.deltaY > 0 ? -1 : 1) * zoomSpeed;
    const nextZoom = clamp(zoom * factor, 0.4, 2.5);
    const rect = v.getBoundingClientRect();
    performZoom(nextZoom, e.clientX - rect.left, e.clientY - rect.top);
  }, [zoom, performZoom]);

  useEffect(() => {
    const v = viewportRef.current;
    if (!v) return;
    v.addEventListener('wheel', handleWheel, { passive: false });
    return () => v.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  // Handle Socket Events
  useEffect(() => {
    socket.on('init_player', ({ playerId }) => {
      setMyOnlineId(playerId);
    });

    socket.on('remote_paint', ({ tiles, ownerId }) => {
      const state = stateRef.current;
      if (!state) return;
      tiles.forEach(t => {
        if (state.grid[t.y] && state.grid[t.y][t.x] !== undefined) {
          state.grid[t.y][t.x] = ownerId;
        }
      });
      updateGridCache();
    });

    return () => { socket.off('init_player'); socket.off('remote_paint'); };
  }, [updateGridCache]);

  // Navigation Pad Continuous Movement Logic
  const navInterval = useRef(null);
  const handleNavMove = (dx, dy) => {
    const move = () => {
      setCamera(prev => clampCamera(prev.x + dx * 20, prev.y + dy * 20, zoom));
    };
    move();
    navInterval.current = setInterval(move, 30);
  };
  const stopNavMove = () => {
    if (navInterval.current) clearInterval(navInterval.current);
  };

  useEffect(() => {
    const mql = window.matchMedia('(max-width: 768px)');
    const handler = (e) => {
      setIsMobile(e.matches);
    };
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);


  const handlePanStart = useCallback((e) => {
    if (e.button === 2) { // Right Click
      setPopup(null);
      // Check for gifting potatoes to teammate in Teams mode
      if (settings.gameMode === 'teams' && gameStatus === 'playing') {
        const rect = canvasRef.current.getBoundingClientRect();
        const sx = canvasRef.current.width / rect.width, sy = canvasRef.current.height / rect.height;
        const cx = Math.floor(((e.clientX - rect.left) * sx) / CELL_SIZE);
        const cy = Math.floor(((e.clientY - rect.top) * sy) / CELL_SIZE);
        const state = stateRef.current;
        if (state && cx >= 0 && cx < state.width && cy >= 0 && cy < state.height) {
          const cell = state.grid[cy] ? state.grid[cy][cx] : 0;
          const owner = isFortWall(cell) ? fortWallOwner(cell) : (cell || 0);
          // Identify if the tile belongs to an ally (Team A is 1 and 3)
          if (state.isAlly && state.isAlly(owner, 1) && owner !== 1) {
            setPopup({ type: 'gift', targetId: owner, gridX: cx, gridY: cy });
            return; // Exit to prevent panning when opening the menu
          }
        }
      }
      panStatus.current = { active: true, x: e.clientX, y: e.clientY };
    }
  }, [settings.gameMode, gameStatus]);

  const handlePanMove = useCallback((e) => {
    if (panStatus.current.active) {
      const dx = e.clientX - panStatus.current.x;
      const dy = e.clientY - panStatus.current.y;
      setCamera(prev => clampCamera(prev.x - dx, prev.y - dy, zoom));
      panStatus.current.x = e.clientX;
      panStatus.current.y = e.clientY;
    }
  }, [zoom, clampCamera]);


  // Reset map on refresh
  useEffect(() => {
    localStorage.removeItem('customMap');
    localStorage.removeItem('customBG');
    setCustomMap(null);
  }, []);

  // Initialize off-screen canvas
  const ensureGridCacheSize = useCallback((w, h) => {
    if (!gridCanvasRef.current || gridCanvasRef.current.width !== w * CELL_SIZE || gridCanvasRef.current.height !== h * CELL_SIZE) {
      const off = document.createElement('canvas');
      off.width = w * CELL_SIZE;
      off.height = h * CELL_SIZE;
      gridCanvasRef.current = off;
    }
  }, []);

  const PANELS = { units:false, buildings:false };
  const [panelOpen,setPanelOpen] = useState(PANELS);

  useEffect(()=>{localStorage.setItem('cocoaBeans',cocoaBeans);},[cocoaBeans]);
  useEffect(()=>{localStorage.setItem('activeBucket',activeBucket);},[activeBucket]);
  useEffect(()=>{localStorage.setItem('unlockedBucket',unlockedBucket);},[unlockedBucket]);
  useEffect(()=>{
    if (customMap) setDims({ w: customMap[0].length, h: customMap.length });
  }, [customMap]);

  // Load all sprite images
  useEffect(() => {
    const spritePaths = [
      ...Object.values(BLDG).map(b => b.sprite),
      ...Object.values(UNITS).map(u => u.sprite),
    ];

    // Prepare a list of all images: sprites and assets use absolute URL strings from the public folder
    const imagesToLoad = [
      ...spritePaths.map(path => ({ key: path, src: getTexture(path) })),
      ...Object.entries(MAP_SETTINGS.assets || {}).map(([key, src]) => ({ key, src: getTexture(src) }))
    ];

    const images = {};
    let loadedCount = 0;
    const totalImages = imagesToLoad.length;

    if (totalImages === 0) { setImagesLoaded(true); return; }

    const finalize = () => { setLoadedImages({...images}); setImagesLoaded(true); };

    imagesToLoad.forEach(({ key, src }) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = src;
      img.onload = () => {
        images[key] = img;
        loadedCount++;
        if (loadedCount === totalImages) finalize();
      };
      img.onerror = () => {
        // Sprite failed to load (missing asset) - continue without it, never block the game
        console.warn(`Asset not found (game will run without it): ${src}`);
        loadedCount++;
        if (loadedCount === totalImages) finalize();
      };
    });
    // Safety net: if all images time out or stall, unblock the game after 3s
    setTimeout(() => { if (!images || loadedCount < totalImages) finalize(); }, 3000);
  }, []);

  const addCocoa = useCallback(n=>{
    setCocoaBeans(p=>{const nv=p+n; return nv;});
  }, []);

  // Simple BFS for unit pathfinding
  const findPath = useCallback((grid, start, isGoal, isPassable) => {
    const queue = [[start]];
    const visited = new Set([`${start.x},${start.y}`]);
    while (queue.length > 0) {
      const path = queue.shift();
      const { x, y } = path[path.length - 1];
      if (isGoal(x, y)) return path;
      for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
        const nx = x + dx, ny = y + dy;
        if (ny >= 0 && ny < grid.length && nx >= 0 && nx < grid[0].length && !visited.has(`${nx},${ny}`) && isPassable(nx, ny)) {
          visited.add(`${nx},${ny}`);
          queue.push([...path, { x: nx, y: ny }]);
        }
      }
    }
    return null;
  }, []);

  // Fast draw using the cache
  const drawSprite = (ctx, path, x, y, ownerId, w, h, anim = { scaleX:1, scaleY:1, rotation:0, offsetY:0 }) => {
    const color = settings.colors[ownerId] || COLORS[ownerId];
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
    infrastructures:0,infraCost:0,milbases:0,milbaseCost:0,milbaseAdvanced:false,navalports:0,navalportCost:0,
    towers:0,towerCost:0, 
    soldierCost:0,scoutCost:0,demoCost:0,rangerCost:0,commanderCost:0,frigateCost:0,troopshipCost:0,
    unitCounts:{soldier:0,scout:0,demo:0,ranger:0,commander:0,frigate:0,troopship:0},
    buildings:[],
  });

  const syncUI = useCallback(()=>{
    if(!stateRef.current)return;
    const s=stateRef.current; const all=[s.player,...s.bots];
    const uc={soldier:0,scout:0,demo:0,ranger:0,commander:0,frigate:0,troopship:0};
    s.units.filter(u=>u.ownerId===1).forEach(u=>{if(uc[u.type]!==undefined)uc[u.type]++;});
    setUi({
      potatoes:s.player.potatoes,paintUnits:s.player.paintUnits,pixels:s.player.pixels,
      tickCount:s.tickCount,
      factories:s.player.factories,factoryCost:s.player.factoryCost,
      farms:s.player.farms,farmCost:s.player.farmCost,
      forts:s.player.forts,fortCost:s.player.fortCost,
      infrastructures:s.player.infrastructures,infraCost:s.player.infraCost,
      milbases:s.player.milbases,milbaseCost:s.player.milbaseCost,milbaseAdvanced:s.player.milbaseAdvanced,
      navalports:s.player.navalports,navalportCost:s.player.navalportCost,navalportAdvanced:s.player.navalportAdvanced,
      towers:s.player.towers,towerCost:s.player.towerCost,
      soldierCost:s.player.soldierCost,scoutCost:s.player.scoutCost,demoCost:s.player.demoCost, 
      rangerCost:s.player.rangerCost,commanderCost:s.player.commanderCost,frigateCost:s.player.frigateCost,troopshipCost:s.player.troopshipCost,battleshipCost:s.player.battleshipCost,
      unitCounts:uc, 
      buildings:s.buildings.filter(b=>b.ownerId===1).map(b=>({...b})),
      leaderboard:all.filter(x=>x.pixels>0).sort((a,b)=>b.pixels-a.pixels)
        .map(x=>({id:x.id,name:x.name,pixels:x.pixels,color:x.color,
          team: s.settings.gameMode==='teams' ? ((x.id===1||x.id===3)?'A':'B') : null
        }))
    });
  }, []);

  // Redraw the static-ish grid layer to the off-screen cache
  const updateGridCache = useCallback(() => {
    if (!gridCanvasRef.current || !stateRef.current) return;
    const state = stateRef.current;
    const { grid, width: gw, height: gh, settings: stateSettings } = state;
    ensureGridCacheSize(gw, gh);
    const gCtx = gridCanvasRef.current.getContext('2d');
    const CS = CELL_SIZE;

    gCtx.imageSmoothingEnabled = false;
    gCtx.fillStyle = stateSettings.colors[0] ?? '#e2e8f0';
    gCtx.fillRect(0, 0, gw * CS, gh * CS);

    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const c = grid[y][x];
        if (c === 0) continue;
        // Inside updateGridCache, find the water check (c === 5)
        if (c === 5) { 
          gCtx.fillStyle = 'rgba(14, 165, 233, 0.1)'; // Very faint blue base
          gCtx.fillStyle = stateSettings.colors[5] || '#0ea5e9';
          gCtx.fillRect(x * CS, y * CS, CS, CS);
          continue;
        }
        if (c === 9) { gCtx.fillStyle = stateSettings.colors[9] ?? '#475569'; gCtx.fillRect(x * CS, y * CS, CS, CS); continue; }
        if (isFortWall(c)) {
          const ownId = fortWallOwner(c);
          gCtx.fillStyle = stateSettings.colors[ownId];
          gCtx.fillRect(x * CS, y * CS, CS, CS);
          gCtx.fillStyle = 'rgba(0,0,0,0.2)';
          gCtx.fillRect(x * CS, y * CS, CS, CS);
          continue;
        }
        gCtx.fillStyle = stateSettings.colors[c];
        gCtx.fillRect(x * CS, y * CS, CS, CS);
      }
    }
    // Draw BR Zone
    if (stateSettings.gameMode === 'br' && state.brShrink > 0) {
      gCtx.fillStyle = 'rgba(239, 68, 68, 0.2)';
      gCtx.fillRect(0, 0, gw * CS, state.brShrink * CS);
    }
    // Grid lines
    gCtx.strokeStyle = 'rgba(0,0,0,0.1)'; gCtx.lineWidth = 0.5; gCtx.beginPath();
    for (let y = 0; y <= gh; y++) { gCtx.moveTo(0, y * CS); gCtx.lineTo(gw * CS, y * CS); }
    for (let x = 0; x <= gw; x++) { gCtx.moveTo(x * CS, 0); gCtx.lineTo(x * CS, gh * CS); }
    gCtx.stroke();
  }, [loadedImages, ensureGridCacheSize]);

  // ── Draw ───────────────────────────────────────────────────────────────────
  const drawCanvas = useCallback(()=>{
    if(!canvasRef.current||!stateRef.current||!gridCanvasRef.current)return;
    const ctx=canvasRef.current.getContext('2d',{alpha:false});
    const {buildings,units}=stateRef.current;
    const CS = CELL_SIZE;
    const time = performance.now();

    ctx.imageSmoothingEnabled = false;

    // Draw the cached grid (Super Fast!) - always draw grid even if sprites are missing
    ctx.drawImage(gridCanvasRef.current, 0, 0);

    if (!imagesLoaded) return; // Sprites not ready - grid still shows

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
        ctx.save();ctx.globalAlpha=u.shootFlash/5;ctx.fillStyle=settings.colors[u.ownerId];
        const[dy,dx]=u.dir||[0,1];
        ctx.beginPath();ctx.arc((u.x+dx)*CS+CS/2,(u.y+dy)*CS+CS/2,CS/2,0,Math.PI*2);
        ctx.fill();ctx.restore();u.shootFlash=Math.max(0,u.shootFlash-1);
      }
    }
  }, [imagesLoaded, loadedImages, settings.colors]);

  // ── Game Logic ─────────────────────────────────────────────────────────────
  const updateLogic = useCallback(()=>{
    const state=stateRef.current; state.tickCount++;
    const all=[state.player,...state.bots];
    const DIRS=[[-1,0],[1,0],[0,-1],[0,1]];

    const gw = state.width, gh = state.height;

    // Count pixels (own territory + fort walls)
    const counts={1:0,2:0,3:0,4:0};
    for(let y=0;y<gh;y++) for(let x=0;x<gw;x++){
      const c=state.grid[y][x];
      if(c>=1&&c<=4)counts[c]++;
      else if(isFortWall(c))counts[fortWallOwner(c)]=(counts[fortWallOwner(c)]||0)+1;
    }
    state.player.pixels=counts[1]||0;
    state.bots.forEach(b=>b.pixels=counts[b.id]||0);

    // Peace Vote logic: only show when victory is nearly 100% (98%)
    if (state.totalPaintable) {
      const teamPixels = (state.settings.gameMode === 'teams' && state.isAlly)
        ? all.filter(e => state.isAlly(e.id, 1)).reduce((sum, e) => sum + e.pixels, 0)
        : state.player.pixels;
      const domRatio = teamPixels / state.totalPaintable;
      const shouldShow = domRatio >= 0.98;
      setShowPeaceVote(current => (current !== shouldShow ? shouldShow : current));
    }

    if(state.player.pixels===0){setGameStatus('gameover');return;}
    // In teams mode, player's team (1+3) wins if all enemies (2+4) are eliminated
    if(state.settings.gameMode==='teams' && state.isAlly){
      const enemyBots=state.bots.filter(b=>!state.isAlly(b.id,1));
      const allyBots=state.bots.filter(b=>state.isAlly(b.id,1));
      if(enemyBots.every(b=>b.pixels===0)){setGameStatus('victory');return;}
      if(allyBots.every(b=>b.pixels===0)&&state.bots.filter(b=>!state.isAlly(b.id,1)).some(b=>b.pixels>0)){
        // All allies dead and enemies remain — gameover
        // (player already checked above)
      }
    } else {
      if(state.bots.filter(b=>b.pixels>0).length===0){setGameStatus('victory');return;}
    }
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
        const owner = all.find(e => e.id === b.ownerId);
        if (owner) {
          const countKey = BLDG[b.type].countKey;
          if (countKey) {
            owner[countKey] = Math.max(0, (owner[countKey] || 0) - 1);
            // Reset upgrades/access if last building of type is lost
            if (owner[countKey] === 0) {
              if (b.type === 'milbase') owner.milbaseAdvanced = false;
              if (b.type === 'navalport') owner.navalportAdvanced = false;
            }
          }
        }
        // Remove fort walls if a fort is destroyed
        if(b.type==='fort'){
          const bw = BLDG.fort.w, bh = BLDG.fort.h;
          for(const{x,y}of getBuildingPerimeter(b.x, b.y, bw, bh, gw, gh)){
            if(state.grid[y][x]===FORT_WALL_OFFSET+b.ownerId) state.grid[y][x]=b.ownerId;
          }
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
          const isNaval = type === 'navalport';
          // For naval ports, find water tiles (5) adjacent to our land. For others, find our land tiles.
          const t = isNaval 
            ? findTiles(state.grid, 5).filter(tile => [[-1,0],[1,0],[0,-1],[0,1]].some(([dy,dx]) => isOwned(state.grid[tile.y+dy]?.[tile.x+dx], b.id)))
            : findTiles(state.grid, b.id);
            
          if(!t.length)return false;
          const bw = BLDG[type].w || 1;
          const bh = BLDG[type].h || 1;
          let placed = false;
          for(let attempt=0;attempt<30&&!placed;attempt++){
            const tile=t[rnd(t.length)];
            if(canPlaceBuilding(state.grid,tile.x,tile.y,bw,bh,b.id,state.buildings, isNaval)){
              const bld={x:tile.x,y:tile.y,type,ownerId:b.id,hp:BLDG[type].hp,damageFlash:0,...extra};
              state.buildings.push(bld);
              placed=true;
              if(type==='fort'){
                for(const{x,y}of getBuildingPerimeter(tile.x, tile.y, bw, bh, gw, gh)){
                  if(state.grid[y][x]===b.id) state.grid[y][x]=FORT_WALL_OFFSET+b.id;
                }
              }
            }
          }
          return placed;
        };
        const spawnUnit=(type)=>{
          const uDef = UNITS[type];
          // Find coastal water for ships, or borders for land units
          const startTile = uDef.onWater ? findTiles(state.grid, 5).find(t => [[-1,0],[1,0],[0,-1],[0,1]].some(([dy,dx]) => isOwned(state.grid[t.y+dy]?.[t.x+dx], b.id))) : findBorderTile(state.grid,b.id)||findTiles(state.grid,b.id)[0];
          if(!startTile)return;
          state.units.push({
            x:startTile.x, 
            y:startTile.y, 
            visualX: startTile.x, 
            visualY: startTile.y, 
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
        const hasWater = findTiles(state.grid, 5).length > 0;
        if(b.milbases===0&&b.potatoes>=b.milbaseCost){ if(place('milbase')){b.potatoes-=b.milbaseCost;b.milbases++;b.milbaseCost=Math.floor(b.milbaseCost*2);} }
        else if(b.milbases>0&&botUnits.length<6&&b.potatoes>=b.soldierCost){b.potatoes-=b.soldierCost;b.soldierCost=Math.floor(b.soldierCost*1.4);spawnUnit(Math.random()<0.3?'demo':'soldier');}
        else if(hasWater && b.navalports===0 && b.potatoes>=b.navalportCost){ if(place('navalport')){b.potatoes-=b.navalportCost; b.navalports++; b.navalportCost=Math.floor(b.navalportCost*2);} }
        else if(b.navalports>0 && botUnits.filter(u=>u.type==='frigate').length < 2 && b.potatoes>=b.frigateCost){b.potatoes-=b.frigateCost; b.frigateCost=Math.floor(b.frigateCost*1.5); spawnUnit('frigate');}
        else if(b.navalports>0 && b.potatoes>=b.troopshipCost && botUnits.filter(u=>u.type==='troopship').length < 1) {
           b.potatoes -= b.troopshipCost;
           b.troopshipCost = Math.floor(b.troopshipCost * 1.5);
           spawnUnit('troopship');
        }
        else if(b.potatoes>=b.towerCost&&b.towers<3){ if(place('tower')){b.potatoes-=b.towerCost;b.towers++;b.towerCost=Math.floor(b.towerCost*1.5);} }
        else if(b.potatoes>=b.fortCost&&b.forts<4){ if(place('fort')){b.potatoes-=b.fortCost;b.forts++;b.fortCost=Math.floor(b.fortCost*1.5);} }
        else if(b.potatoes>=b.infraCost&&b.infrastructures<Math.floor(b.factories/2)){ if(place('infra')){b.potatoes-=b.infraCost;b.infrastructures++;b.infraCost=Math.floor(b.infraCost*1.5);} }
        else if(b.potatoes>=b.farmCost&&b.farms<b.factories+1){ if(place('farm')){b.potatoes-=b.farmCost;b.farms++;b.farmCost=Math.floor(b.farmCost*1.5);} }
        else if(b.potatoes>=b.factoryCost){ if(place('factory')){b.potatoes-=b.factoryCost;b.factories++;b.factoryCost=Math.floor(b.factoryCost*1.5);} }
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
      if(!isOwned(state.grid[u.y]?.[u.x],u.ownerId) && state.grid[u.y]?.[u.x] !== 5) return false;
      return true;
    });

    for(const u of state.units){
      if(u.damageFlash>0)u.damageFlash--;
      u.cd--;
      const cdBonus=hasCommanderNearby(u)?3:0;
      const effCd=Math.max(1,UNITS[u.type].cd-cdBonus);

      // Troopship Logic: Carrying military units
      if (u.type === 'troopship') {
        if (!u.cargo) u.cargo = [];
        const neighbors = [[0,1],[0,-1],[1,0],[-1,0]];
        
        // Pick up friendly units from shore
        if (u.cargo.length < 3) {
          for (const [dy, dx] of neighbors) {
            const landUnit = state.units.find(ou => 
              ou.ownerId === u.ownerId && 
              ou.x === u.x + dx && ou.y === u.y + dy && 
            !UNITS[ou.type]?.onWater && ou.type !== 'troopship' && ou.hp > 0
            );
            if (landUnit) {
              u.cargo.push({ type: landUnit.type, hp: landUnit.hp });
            landUnit.hp = -1; // Mark for removal by the cleanup filter at the start of next tick
              break;
            }
          }
        }
        // Drop off units on non-friendly land
        if (u.cargo.length > 0) {
          for (const [dy, dx] of neighbors) {
            const nx = u.x + dx, ny = u.y + dy;
            if (ny >= 0 && ny < gh && nx >= 0 && nx < gw) {
              const cell = state.grid[ny][nx];
              if (cell !== 5 && cell !== 9 && !isOwned(cell, u.ownerId)) {
                const stored = u.cargo.shift();
                state.grid[ny][nx] = u.ownerId; // Paint the landing tile so the unit survives deployment
                state.units.push({
                  id: Math.random(),
                  type: stored.type,
                  ownerId: u.ownerId,
                  x: nx, y: ny,
                  visualX: u.x, visualY: u.y,
                  hp: stored.hp,
                  dir: [dy, dx],
                  cd: 15,
                  shootFlash: 0,
                  damageFlash: 0
                });
                break;
              }
            }
          }
        }
      }

      if(u.cd<=0){
        u.cd=effCd;
        const uData=UNITS[u.type];
        const range=uData.range;

        // Collect tiles in attack range
        let tgts=[];
        for(let dy=-range;dy<=range;dy++) for(let dx=-range;dx<=range;dx++){
          if(dy===0&&dx===0)continue;
          const ny=u.y+dy,nx=u.x+dx;
          if(ny<0||ny>=gh||nx<0||nx>=gw)continue;
          const cell=state.grid[ny][nx];
          // Can attack enemy territory, fort walls, or neutral. Ignore allies.
          const isAllyTile = state.isAlly ? state.isAlly(cell, u.ownerId) : isOwned(cell, u.ownerId);
          if(!isAllyTile && cell!==5 && (cell!==9 || state.settings.passableObstacles)) tgts.push({y:ny,x:nx,dy,dx});
        }

        if(uData.onWater) {
          // Troopship AI: If empty, go to friendly shores. If carrying, go to enemy shores.
          const needsPickup = u.type === 'troopship' && (u.cargo?.length || 0) === 0;

          // Only pathfind if we aren't already sitting next to an enemy to shoot
          const path = findPath(state.grid, {x: u.x, y: u.y}, 
            (nx, ny) => {
              // Goal: A water tile adjacent to the target land type
              return [[-1,0],[1,0],[0,-1],[0,1]].some(([dy,dx]) => {
                const c = state.grid[ny+dy]?.[nx+dx];
                if (c === undefined || c === 5 || c === 9) return false;
                // If empty troopship, look for friendly land. Otherwise, look for enemy land.
                return needsPickup ? isOwned(c, u.ownerId) : !isOwned(c, u.ownerId);
              });
            },
            (nx, ny) => state.grid[ny][nx] === 5
          );
          if(path && path.length > 1) { u.x = path[1].x; u.y = path[1].y; }
        }

        if(tgts.length>0 || uData.onWater){
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
                const fortBldIdx=state.buildings.findIndex(b => {
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
              const isEnemy = state.isAlly ? !state.isAlly(b.ownerId, u.ownerId) : b.ownerId !== u.ownerId;
              return isEnemy && t.x >= b.x && t.x < b.x + bw && t.y >= b.y && t.y < b.y + bh;
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
              const enemyUnit=state.units.find(eu => {
                const isEnemy = state.isAlly ? !state.isAlly(eu.ownerId, u.ownerId) : eu.ownerId !== u.ownerId;
                return eu.x===t.x&&eu.y===t.y&&isEnemy;
              });
              if(enemyUnit){
                enemyUnit.hp-=uData.atk;
                enemyUnit.damageFlash=4;
                if(enemyUnit.hp<=0)state.units=state.units.filter(eu=>eu!==enemyUnit);
              } else {
                  // Paint the tile, but only if it's not an ally's
                  const currentTile = state.grid[t.y][t.x];
                  const isAllyTile = state.isAlly ? state.isAlly(currentTile, u.ownerId) : false;
                  if (!isAllyTile) {
                    state.grid[t.y][t.x]=u.ownerId;
                  }
              }
              hit++;
            }
            u.dir=[t.dy,t.dx]; u.shootFlash=5;
          }

          // Move toward border (scouts move faster)
          const movePct=u.type==='scout'?0.8:0.3;
          if(!uData.onWater && Math.random()<movePct){
            const bt=findBorderTile(state.grid,u.ownerId);
            if(bt){u.x=bt.x;u.y=bt.y;}
          }
        } else {
          if(!uData.onWater) {
            const bt=findBorderTile(state.grid,u.ownerId);
            if(bt){u.x=bt.x;u.y=bt.y;}
          }
        }
      }
    }

    // ── Bot expansion ──────────────────────────────────────────────────────
    if(state.tickCount%expandInt===0)
      state.bots.forEach(b=>{
        if(b.pixels<=0||b.paintUnits<=0)return;
        const tgts=[];
        for(let y=0;y<gh;y++) for(let x=0;x<gw;x++)
          if(isOwned(state.grid[y][x],b.id)) for(const[dy,dx]of DIRS){
            const ny=y+dy,nx=x+dx;
            if(ny>=0&&ny<gh&&nx>=0&&nx<gw&&!isOwned(state.grid[ny][nx],b.id)&&state.grid[ny][nx]!==9&&state.grid[ny][nx]!==5)
              tgts.push({y:ny,x:nx});
          }
        if(!tgts.length)return;
        for(let i=tgts.length-1;i>0;i--){const j=rnd(i+1);[tgts[i],tgts[j]]=[tgts[j],tgts[i]];}
        let limit=Math.floor(b.pixels*diffMul)+baseLimit,used=0;
        for(let i=0;i<tgts.length&&used<limit&&b.paintUnits>0;i++){
          const t=tgts[i]; const cell=state.grid[t.y][t.x];
          // Bots CANNOT spread over fort walls
          if(isFortWall(cell))continue;
          // Bots CANNOT spread over ally tiles in teams mode
          if(state.isAlly && cell>=1 && cell<=4 && state.isAlly(cell, b.id)) continue;
          const bldIdx=state.buildings.findIndex(bd => {
            const bw = BLDG[bd.type].w || 1;
            const bh = BLDG[bd.type].h || 1;
            const isEnemy = state.isAlly ? !state.isAlly(bd.ownerId, b.id) : bd.ownerId !== b.id;
            return isEnemy && t.x >= bd.x && t.x < bd.x + bw && t.y >= bd.y && t.y < bd.y + bh;
          });
          if(bldIdx>=0){damageBuilding(bldIdx,b.id);}
          else{state.grid[t.y][t.x]=b.id;b.paintUnits--;used++;}
        }
      });

    // Orphan-check buildings (captured territory cleanup)
    const survivingBuildings = [];
    for (const b of state.buildings) {
      const cell = state.grid[b.y]?.[b.x];
      const isStillOwned = isOwned(cell, b.ownerId) || (b.type === 'navalport' && cell === 5);
      
      if (isStillOwned) {
        survivingBuildings.push(b);
      } else {
        // Building was lost due to territory capture
        const owner = all.find(e => e.id === b.ownerId);
        if (owner) {
          const countKey = BLDG[b.type].countKey;
          if (countKey) {
            owner[countKey] = Math.max(0, (owner[countKey] || 0) - 1);
            if (owner[countKey] === 0) {
              if (b.type === 'milbase') owner.milbaseAdvanced = false;
              if (b.type === 'navalport') owner.navalportAdvanced = false;
            }
          }
          if (b.type === 'fort') {
            const bw = BLDG.fort.w, bh = BLDG.fort.h;
            for(const{x,y}of getBuildingPerimeter(b.x, b.y, bw, bh, gw, gh))
              if(state.grid[y][x]===FORT_WALL_OFFSET+b.ownerId) state.grid[y][x]=b.ownerId;
          }
        }
      }
    }
    state.buildings = survivingBuildings;

    if(state.tickCount%2===0){ syncUI(); updateGridCache(); }
  }, [syncUI, addCocoa, updateGridCache]);

  // ── Engine ─────────────────────────────────────────────────────────────────
  useEffect(()=>{
    if(gameStatus!=='playing' && gameStatus!=='editor')return;
    const ti=gameStatus==='playing' ? setInterval(updateLogic,TICK_RATE) : null;
    const rf=()=>{drawCanvas();requestRef.current=requestAnimationFrame(rf);};
    requestRef.current=requestAnimationFrame(rf);
    const up=()=>{
      isMouseDown.current=false;
      panStatus.current.active = false;
    };
    window.addEventListener('mouseup',up);
    return()=>{if(ti)clearInterval(ti);cancelAnimationFrame(requestRef.current);window.removeEventListener('mouseup',up);};
  },[gameStatus,updateLogic,drawCanvas]);

  // ── Canvas click - paint + milbase popup ──────────────────────────────────
  const handleCanvasClick = useCallback((e,isDown)=>{
    if(gameStatus!=='playing' && gameStatus!=='editor')return;
    // If clicking a button/popup, stop propagation should handle it, but we bail if coordinates are invalid
    const state=stateRef.current;
    const gw = state.width, gh = state.height;
    const rect=canvasRef.current.getBoundingClientRect();
    const sx=canvasRef.current.width/rect.width,sy=canvasRef.current.height/rect.height;
    const cx=Math.floor(((e.clientX-rect.left)*sx)/CELL_SIZE);
    const cy=Math.floor(((e.clientY-rect.top)*sy)/CELL_SIZE);
    if(cx<0||cx>=gw||cy<0||cy>=gh)return;

    // PRIORITY: Check building list first to prevent painting over your own structure
    if(isDown){
      const bld = state.buildings.find(b => {
        if (b.ownerId !== 1 || (b.type !== 'milbase' && b.type !== 'navalport')) return false;
        const def = BLDG[b.type];
        return cx >= b.x && cx < b.x + (def.w || 1) && cy >= b.y && cy < b.y + (def.h || 1);
      });
      if (bld) {
        setPopup({ type: bld.type, building: bld });
        isMouseDown.current = false; // Disable paint drag if we opened a menu
        return;
      }
    }

    // Editor Mode
    if(gameStatus==='editor'){
      const brush = editorBrush;
      for(let dy=-(brush-1); dy<=(brush-1); dy++){
        for(let dx=-(brush-1); dx<=(brush-1); dx++){
          const ex=cx+dx, ey=cy+dy;
          if(ex<0||ex>=gw||ey<0||ey>=gh) continue;
          if(editorTool==='obstacle'){
            state.grid[ey][ex] = 9;
          } else if(editorTool==='water'){
            state.grid[ey][ex] = 5;
          } else if(editorTool==='erase'){
            state.grid[ey][ex] = 0;
          } else if(editorTool==='spawn1'){
            // Only paint in the center click (brush ignored for spawn — place 3x3 cluster)
            if(dy===0&&dx===0){
              for(let sy=-1;sy<=1;sy++) for(let sx=-1;sx<=1;sx++){
                const nx2=cx+sx, ny2=cy+sy;
                if(nx2>=0&&nx2<gw&&ny2>=0&&ny2<gh) state.grid[ny2][nx2]=1;
              }
            }
          } else if(editorTool==='spawn2'){
            if(dy===0&&dx===0){
              const botId = editorBotCycle.current;
              for(let sy=-1;sy<=1;sy++) for(let sx=-1;sx<=1;sx++){
                const nx2=cx+sx, ny2=cy+sy;
                if(nx2>=0&&nx2<gw&&ny2>=0&&ny2<gh) state.grid[ny2][nx2]=botId;
              }
              editorBotCycle.current = botId>=4 ? 2 : botId+1;
            }
          }
        }
      }
      updateGridCache();
      return;
    }

    // Paint
    const playerId = settings.online ? myOnlineId : 1;
    if(panStatus.current.active) return; // Prevent painting while moving camera
    if(!isMouseDown.current&&!isDown)return;
    if(state.player.paintUnits<=0)return;
    const span=BUCKET_UPGRADES[bucketRef.current].radius;
    const painted=[];
    
    for(let dy=-(span-1);dy<=(span-1);dy++) for(let dx=-(span-1);dx<=(span-1);dx++){
      const x=cx+dx,y=cy+dy;
      if(x<0||x>=gw||y<0||y>=gh)continue;
      const isAllyTile = state.isAlly ? state.isAlly(state.grid[y][x], playerId) : isOwned(state.grid[y][x], playerId);
      if(isAllyTile || state.grid[y][x] === 5)continue;
      if(state.grid[y][x]===9 && !settings.passableObstacles)continue;
      if(state.player.paintUnits<=0)break;
      // Fort walls block player paint (unless demo unit later breaks them)
      if(isFortWall(state.grid[y][x]))continue;
      let adj=false;
      for(const[ay,ax]of[[-1,0],[1,0],[0,-1],[0,1]]){
        const ny2=y+ay,nx2=x+ax;
        if(ny2>=0&&ny2<gh&&nx2>=0&&nx2<gw&&isOwned(state.grid[ny2][nx2],playerId)){adj=true;break;}
      }
      if(!adj&&painted.length>0)for(const p of painted)if(Math.abs(p.x-x)<=1&&Math.abs(p.y-y)<=1){adj=true;break;}
      if(!adj)continue;
      const bldIdx=state.buildings.findIndex(b => {
        const bw = BLDG[b.type].w || 1;
        const bh = BLDG[b.type].h || 1;
        const isEnemy = state.isAlly ? !state.isAlly(b.ownerId, playerId) : b.ownerId !== playerId;
        return isEnemy && x >= b.x && x < b.x + bw && y >= b.y && y < b.y + bh;
      });
      if(bldIdx>=0){
        const bld=state.buildings[bldIdx];
        bld.hp--;bld.damageFlash=6;
        if(bld.hp<=0){
          addCocoa(BLDG[bld.type].cocoaReward);
          if(bld.type==='fort')for(const{x:wx,y:wy}of getBuildingPerimeter(bld.x, bld.y, BLDG.fort.w, BLDG.fort.h, gw, gh))
            if(state.grid[wy][wx]===FORT_WALL_OFFSET+bld.ownerId)state.grid[wy][wx]=bld.ownerId;
          state.buildings.splice(bldIdx,1);
        }
        state.player.paintUnits--;
      } else {
        state.grid[y][x]=playerId;state.player.paintUnits--;painted.push({x,y});
      }
    }
    if(painted.length>0){
      if (settings.online) {
        socket.emit('paint_action', { tiles: painted, ownerId: playerId });
      }
      const ctx=canvasRef.current.getContext('2d');
      ctx.fillStyle=settings.colors[playerId];
      for(const p of painted)ctx.fillRect(p.x*CELL_SIZE,p.y*CELL_SIZE,CELL_SIZE,CELL_SIZE);
      syncUI();
    }
  },[gameStatus,syncUI,addCocoa,updateGridCache,editorTool,editorBrush]);

  // ── Mobile touch: Direct painting (panning handled by D-Pad) ────────────────
  const touchStartPos = useRef(null);
  const touchHasMoved = useRef(false);

  const handleTouchStart = useCallback((e) => {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      touchStartPos.current = { x: t.clientX, y: t.clientY };
      touchHasMoved.current = false;
      isMouseDown.current = true;
      handleCanvasClick({ clientX: t.clientX, clientY: t.clientY }, true);
    } else {
      // 2+ fingers: cancel everything — pinch zoom disabled
      panStatus.current = { active: false, x: 0, y: 0 };
      isMouseDown.current = false;
      e.preventDefault(); // Prevent browser from handling multi-touch gestures like pinch-to-zoom
      if (e.cancelable) e.preventDefault(); 
    }
  }, [handleCanvasClick]);

  const handleTouchMove = useCallback((e) => {
    if (e.touches.length > 1) {
      if (e.cancelable) e.preventDefault();
      return; // Forcefully block pinch-to-zoom logic
    }
    if (e.cancelable) e.preventDefault();
    if (e.touches.length !== 1) return; // ignore multi-touch
    const t = e.touches[0];

    if (isMouseDown.current) {
      handleCanvasClick({ clientX: t.clientX, clientY: t.clientY }, false);
    }
  }, [handleCanvasClick]);

  const handleTouchEnd = useCallback(() => {
    panStatus.current.active = false;
    isMouseDown.current = false;
    touchStartPos.current = null;
    touchHasMoved.current = false;
  }, []);

  useEffect(() => {
    const v = viewportRef.current;
    if (!v) return;
    v.addEventListener('touchstart', handleTouchStart, { passive: false });
    v.addEventListener('touchmove',  handleTouchMove,  { passive: false });
    v.addEventListener('touchend',   handleTouchEnd);
    return () => {
      v.removeEventListener('touchstart', handleTouchStart);
      v.removeEventListener('touchmove',  handleTouchMove);
      v.removeEventListener('touchend',   handleTouchEnd);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd]);

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
    const cost = p[costK];
    if(p.potatoes<cost)return;
    
    const isNaval = type === 'navalport';
    const tiles=isNaval ? findTiles(stateRef.current.grid, 5).filter(t => [[-1,0],[1,0],[0,-1],[0,1]].some(([dy,dx]) => isOwned(stateRef.current.grid[t.y+dy]?.[t.x+dx], 1))) : findTiles(stateRef.current.grid, 1);
    if(!tiles.length)return;

    const bw = def.w || 1;
    const bh = def.h || 1;
    let placed = false;
    for(let attempt=0;attempt<30&&!placed;attempt++){
      const tile=tiles[rnd(tiles.length)];
      if(canPlaceBuilding(stateRef.current.grid,tile.x,tile.y,bw,bh,1,stateRef.current.buildings, isNaval)){
        p.potatoes-=cost; p[cntK]++; p[costK]=Math.floor(cost*def.baseMul);
        const bld={x:tile.x,y:tile.y,type,ownerId:1,hp:def.hp,damageFlash:0};
        stateRef.current.buildings.push(bld);
        placed=true;
        if(type==='fort'){
          for(const{x,y}of getBuildingPerimeter(tile.x, tile.y, bw, bh, stateRef.current.width, stateRef.current.height)){
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
    const isNaval = uDef.onWater;
    const t=isNaval ? findTiles(stateRef.current.grid, 5).find(t => [[-1,0],[1,0],[0,-1],[0,1]].some(([dy,dx]) => isOwned(stateRef.current.grid[t.y+dy]?.[t.x+dx], 1))) : findBorderTile(stateRef.current.grid,1)||findTiles(stateRef.current.grid,1)[0];
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

  const deployNavalUnit=(type)=>{
    const p=stateRef.current.player;
    if (p.navalports === 0) return;
    const uDef=UNITS[type]; const costK=uDef.costKey;
    if(p.potatoes<p[costK])return;
    p.potatoes-=p[costK]; p[costK]=Math.floor(p[costK]*1.4);
    const t=findTiles(stateRef.current.grid, 5).find(t => [[-1,0],[1,0],[0,-1],[0,1]].some(([dy,dx]) => isOwned(stateRef.current.grid[t.y+dy]?.[t.x+dx], 1)));
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

  const upgradeNavalport=()=>{
    const p=stateRef.current.player;
    if(p.navalportAdvanced)return;
    const cost=600;
    if(p.potatoes<cost)return;
    p.potatoes-=cost; p.navalportAdvanced=true;
    setPopup(null); syncUI();
  };

  const upgradeMilbase=()=>{
    const p=stateRef.current.player;
    if(p.milbaseAdvanced)return;
    const cost=600;
    if(p.potatoes<cost)return;
    p.potatoes-=cost; p.milbaseAdvanced=true;
    setPopup(null); syncUI();
  };

  const giftPotatoes = (amount) => {
    const s = stateRef.current;
    if (s && s.player.potatoes >= amount && popup?.targetId) {
      s.player.potatoes -= amount;
      const teammate = s.bots.find(b => b.id === popup.targetId);
      if (teammate) teammate.potatoes += amount;
      setPopup(null);
      syncUI();
    }
  };

  const startGame=async()=>{
    if (settings.online) {
      socket.emit('join_game', { name: 'Player' });
    }

    // For procedural maps, generate terrain ourselves using proper algorithms
    // then pass it to createInitialState as a custom map so spawn logic still applies.
    let mapToUse = customMap;
    if (settings.mapType === 'procedural' && !customMap) {
      mapToUse = buildProceduralGrid(GRID_W, GRID_H, settings);
    } else if (settings.mapType === 'realistic' && !customMap) {
      try {
        // Expects maps in public/assets/textures/
        const img = await loadImage(getTexture(`${settings.worldMap}.png`));
        mapToUse = parseImageToGrid(img, settings.darkThreshold);
      } catch (err) {
        console.warn("Realistic map failed to load, falling back to procedural:", err);
        mapToUse = buildProceduralGrid(GRID_W, GRID_H, settings);
      }
    }

    stateRef.current = createInitialState(settings, mapToUse);

    if (settings.gameMode === 'teams') {
      stateRef.current.isAlly = (id1, id2) => {
        const getTeam = (id) => (id === 1 || id === 3) ? 'A' : (id === 2 || id === 4) ? 'B' : null;
        const t1 = getTeam(isFortWall(id1) ? fortWallOwner(id1) : id1);
        const t2 = getTeam(isFortWall(id2) ? fortWallOwner(id2) : id2);
        return t1 !== null && t1 === t2;
      };
    }
    
    // Calculate total paintable area for Domination percentage
    let paintable = 0;
    for(let y=0; y<stateRef.current.height; y++) {
      for(let x=0; x<stateRef.current.width; x++) {
        const cell = stateRef.current.grid[y][x];
        if (cell !== 5 && cell !== 9) paintable++;
      }
    }
    stateRef.current.totalPaintable = paintable;
    setTotalPaintable(paintable);
    setShowPeaceVote(false);
    
    // Ensure the troopship cost is initialized if the map logic missed it
    if (stateRef.current.player.troopshipCost === undefined || stateRef.current.player.troopshipCost === 0) 
      stateRef.current.player.troopshipCost = 150;

    const { width: newW, height: newH } = stateRef.current;
    setDims({ w: newW, h: newH });
    // Ensure the off-screen grid canvas is sized BEFORE updateGridCache draws into it
    ensureGridCacheSize(newW, newH);
    setGameStatus('playing');
    syncUI();
    updateGridCache();

    requestAnimationFrame(() => {
      const v = viewportRef.current;
      if (v) {
        setCamera({
          x: (stateRef.current.width * CELL_SIZE * zoom - v.clientWidth) / 2,
          y: (stateRef.current.height * CELL_SIZE * zoom - v.clientHeight) / 2
        });
      }
    });
  };

  const enterEditor=()=>{
    const w = customMap ? customMap[0].length : GRID_W;
    const h = customMap ? customMap.length : GRID_H;
    stateRef.current = { 
      grid: customMap ? customMap.map(r=>[...r]) : Array.from({length:h},()=>Array(w).fill(0)),
      width: w, height: h,
      buildings: [], units: [],
      settings: { ...settings, gameMode: 'classic' }
    };
    setDims({ w, h });
    updateGridCache();
    setGameStatus('editor');
  };

  const saveEditor=()=>{
    const g = stateRef.current.grid;
    setCustomMap(g.map(r=>[...r]));
    localStorage.setItem('customMap', JSON.stringify(g));
    setGameStatus('menu');
  };

  // Upload image and PARSE it into the game grid using pixel brightness
  const handleMapImageUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const base64 = event.target.result;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = base64;
      img.onload = () => {
        // Parse pixel data → grid
        const parsedGrid = parseImageToGrid(img, settings.darkThreshold ?? 60, settings);
        const nw = parsedGrid[0].length;
        const nh = parsedGrid.length;
        setDims({ w: nw, h: nh });
        // Save grid as custom map
        setCustomMap(parsedGrid);
        localStorage.setItem('customMap', JSON.stringify(parsedGrid));
        // Switch to custom map type automatically
        setSettings(s => ({ ...s, mapType: 'custom' }));
      };
    };
    reader.readAsDataURL(file);
  };

  const resetRound = () => {
    localStorage.removeItem('customMap');
    localStorage.removeItem('customBG');
    setCustomMap(null);
    setGameStatus('menu');
  };

  const formatTime=t=>{const s=Math.max(0,settings.duration-Math.floor(t/10));return`${Math.floor(s/60)}:${(s%60).toString().padStart(2,'0')}`;};
  const togglePanel=p=>setPanelOpen(prev=>({units:false,buildings:false,[p]:!prev[p]}));
  const paintPerClick=Math.floor(4*(1+ui.factories)*(1+0.2*ui.infrastructures));
  const canBuyAdvanced=ui.milbases>0&&!ui.milbaseAdvanced;

  return (
    <div className="app-wrapper">

      {/* Header */}
      <header className="game-header">
        <h1 className="text-2xl font-black text-blue-600 flex items-center gap-2">
          <PaintBucket size={24} strokeWidth={2.5}/> inkwar.io
        </h1>
        <div className="flex items-center gap-2 flex-wrap">
          {isMobile && gameStatus === 'playing' && (
            <div className="header-stats-scroll">
              <button onClick={handleCraftPaint} className="header-stat-paint">🪣 {fmt(ui.paintUnits)}</button>
              <div className="header-stat-potatoes">🥔 {fmt(ui.potatoes)}</div>
            </div>
          )}
          <div className="header-stat-beans bg-amber-50 border border-amber-200 px-3 py-1 rounded-full flex items-center gap-1.5 text-sm font-bold text-amber-700">🫘 {fmt(cocoaBeans)}</div>
          {gameStatus==='playing'&&settings.duration>0&&(
            <span className="header-stat-timer bg-white px-3 py-1 rounded-full text-sm font-bold shadow-sm border border-slate-200 flex items-center gap-1"><Clock size={13}/> {formatTime(ui.tickCount)}</span>
          )}
          {gameStatus==='playing'&&(
            <span className="header-stat-pixels bg-white px-3 py-1 rounded-full text-sm font-bold shadow-sm border border-slate-200 text-slate-500">{ui.pixels} px</span>
          )}
        </div>
      </header>

      <div className="game-layout">
          {/* Sidebar (Hidden on mobile, content moved to bottom GUI) */}
        {/* Sidebar */}
        <aside className="sidebar-container">

          {/* Stats */}
          <div className="sidebar-card">
            <div className="grid grid-cols-2 gap-3">
              <div className="income-card bg-slate-50 p-3 rounded-xl flex flex-col items-center border border-slate-100">
                <span className="text-slate-400 text-[10px] font-bold uppercase tracking-wider mb-1">Potatoes</span>
                <span className="text-xl font-black text-slate-700">{fmt(ui.potatoes)} 🥔</span>
                <span className="text-[10px] text-emerald-500 font-bold bg-emerald-50 px-2 py-0.5 rounded-full mt-1">
                  +{Math.floor((ui.pixels+ui.farms*10)*(1+0.2*ui.infrastructures))}/s
                </span>
              </div>
              <div className="paint-status-card bg-blue-50 p-3 rounded-xl flex flex-col items-center border border-blue-100">
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
            className="paint-produce-btn w-full bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-bold py-3 rounded-xl shadow active:scale-[0.98] transition-all flex flex-col items-center border-b-4 border-blue-800 active:border-b-0 active:translate-y-1">
            <div className="flex items-center gap-2 text-base"><PaintBucket size={18}/> Produce Paint</div>
            <span className="text-blue-200 text-xs">+{paintPerClick} uses</span>
          </button>

          {/* ── Units Panel ── */}
          <div className="sidebar-panel">
            <button onClick={()=>togglePanel('units')} className="w-full flex items-center justify-between px-4 py-3 font-bold text-slate-700 hover:bg-slate-50 transition-colors">
              <span className="flex items-center gap-2 text-sm">
                <Sword size={15} className="text-red-500"/> Army Units (Top)
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
                <div className="unit-list mt-3 grid grid-cols-1 gap-2">
                  {Object.entries(UNITS).map(([type,uDef])=>{
                    const cost=ui[uDef.costKey]; const count=ui.unitCounts[type]||0;
                    const locked=uDef.advanced&&!ui.milbaseAdvanced;
                    const noBase=ui.milbases===0;
                    const canBuy=gameStatus==='playing'&&!locked&&!noBase&&ui.potatoes>=cost;
                    return(
                      <div key={type} className={`unit-card ${locked ? 'unit-card--locked' : ''} ${noBase ? 'unit-card--disabled' : ''}`}>
                        <img src={getTexture(uDef.sprite)} alt={type} className="unit-card-icon" />
                        <div className="unit-card-content">
                          <div className="flex items-center gap-1.5">
                            <span className="unit-card-name">{type}</span>
                            {uDef.advanced&&<span className="badge-advanced">ADV</span>}
                            {count>0&&<span className="unit-card-badge">{count} out</span>}
                          </div>
                          <div className="unit-card-stats">{uDef.desc} · ❤️{uDef.hp} atk:{uDef.atk}</div>
                          {locked&&<div className="unit-card-lock-msg">Upgrade base to unlock</div>}
                        </div>
                        <button onClick={()=>deployUnit(type)} disabled={!canBuy} 
                          className={`unit-buy-btn ${canBuy ? 'unit-buy-btn--active' : 'unit-buy-btn--disabled'}`}>
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
          <div className="sidebar-panel">
            <button onClick={()=>togglePanel('buildings')} className="w-full flex items-center justify-between px-4 py-3 font-bold text-slate-700 hover:bg-slate-50 transition-colors">
              <span className="flex items-center gap-2 text-sm"><Building2 size={15} className="text-emerald-500"/> Buildings (Top)</span>
              {panelOpen.buildings?<ChevronUp size={15}/>:<ChevronDown size={15}/>}
            </button>
            {panelOpen.buildings&&(
              <div className="px-3 pb-4 border-t border-slate-100">
                <div className="building-grid mt-3 grid grid-cols-2 gap-2">
                  {[
                    {type:'factory',color:'emerald',cb:()=>buyBuilding('factory')},
                    {type:'farm',   color:'amber',  cb:()=>buyBuilding('farm')},
                    {type:'fort',   color:'slate',  cb:()=>buyBuilding('fort')},
                    {type:'infra',  color:'indigo', cb:()=>buyBuilding('infra')},
                    {type:'milbase',color:'purple', cb:()=>{ if(ui.milbases>0){ const mb=stateRef.current?.buildings.find(b=>b.type==='milbase'&&b.ownerId===1); setPopup({type:'milbase',building:mb||null}); } else buyBuilding('milbase'); }},
                    {type:'navalport', color:'indigo', cb:()=>buyBuilding('navalport')},
                    {type:'tower',  color:'rose',   cb:()=>buyBuilding('tower')},
                  ].filter(item => BLDG[item.type]).map(({type,color,cb})=>{
                    const def=BLDG[type]; const cost=ui[def?.costKey]; const lvl=ui[def?.countKey];
                    // Milbase: always clickable if built (to open upgrade popup), otherwise needs funds
                    const isMilbaseUpgrade = type==='milbase' && ui.milbases>0;
                    const canBuy=gameStatus==='playing' && (isMilbaseUpgrade || (ui.potatoes>=cost && (type!=='navalport' || (stateRef.current && findTiles(stateRef.current.grid, 5).length > 0))));
                    return(
                      <button key={type} onClick={cb} disabled={!canBuy}
                        className={`building-card building-card--${color}`}>
                        <img src={getTexture(def.sprite)} alt={type} className="w-8 h-8 mb-1 object-contain" />
                        <span className="text-[11px] font-black capitalize">{type==='milbase'?'Mil.Base':type}</span>
                        <span className="text-[9px] opacity-80">{def.desc}</span>
                        <span className="text-[9px] opacity-50 mb-1">HP:{def.hp}</span>
                        <div className="bg-black/10 px-2 py-0.5 rounded-full text-[10px] font-bold w-full text-center">{isMilbaseUpgrade?'⚙️ Manage':''+fmt(cost)+'🥔'}</div>
                        {lvl>0&&<span className="text-[9px] mt-1 opacity-70">×{lvl}</span>}
                        {type==='milbase'&&ui.milbaseAdvanced&&<span className="text-[9px] mt-0.5 text-yellow-200 font-bold">⭐ ADV</span>}
                        {type==='milbase'&&!ui.milbaseAdvanced&&ui.milbases>0&&<span className="text-[9px] mt-0.5 opacity-80 font-bold">⬆ Upgrade</span>}
                        {type==='navalport' && stateRef.current && !findTiles(stateRef.current.grid, 5).length && <span className="text-[8px] mt-1 text-red-300">No Water</span>}
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
          <div className="sidebar-card">
            <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-2"><Trophy size={13}/> Leaderboard</h2>
            <div className="flex flex-col gap-1.5">
              {ui.leaderboard.map((e,i)=>(
                <div key={e.id} className="leaderboard-row">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span className="text-xs text-slate-400 w-3">{i+1}.</span>
                    <div className="leaderboard-dot" style={{backgroundColor:e.color}}/>
                    <span className={e.id===1?'text-blue-600 font-bold':'text-slate-600'}>{e.name}</span>
                    {e.team&&<span className={`text-[9px] font-black px-1.5 rounded-full ${e.team==='A'?'bg-blue-100 text-blue-600':'bg-red-100 text-red-600'}`}>T{e.team}</span>}
                  </div>
                  <span className="text-xs font-bold text-slate-700">{fmt(e.pixels)}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>

        {/* Canvas */}
        <main className="canvas-container">
          {/* Top Control Bar: Outside & Above the interaction viewport */}
          {(gameStatus === 'playing' || gameStatus === 'editor') && (
            <div className="canvas-header">
                <button onClick={resetRound}
                  className="exit-button">
                  <LogOut size={14}/> Exit Game
                </button>
            </div>
          )}

          {/* Vertical Zoom Controls positioned center-right */}
          <div className="zoom-vertical-wrapper">
            <div className="zoom-control-panel">
              <button onClick={() => { const v = viewportRef.current; if(v) performZoom(clamp(zoom + 0.2, 0.4, 2.5), v.clientWidth/2, v.clientHeight/2); }} className="zoom-btn" title="Zoom In">
                <ZoomIn size={18}/>
              </button>
              <div className="text-[10px] font-black text-slate-400 select-none py-1">
                {Math.round(zoom * 100)}%
              </div>
              <button onClick={() => { const v = viewportRef.current; if(v) performZoom(clamp(zoom - 0.2, 0.4, 2.5), v.clientWidth/2, v.clientHeight/2); }} className="zoom-btn" title="Zoom Out">
                <ZoomOut size={18}/>
              </button>
              <div className="h-px w-4 bg-slate-100 my-1" />
              <button onClick={()=>setZoom(1)} className="zoom-btn text-blue-500" title="Reset Zoom">
                <RotateCcw size={16}/>
              </button>
            </div>
          </div>

          {/* Navigation D-Pad (The "Something Else" replacement for scrollbars) */}
          {(gameStatus === 'playing' || gameStatus === 'editor') && (
            <div className="nav-pad-wrapper animate-in fade-in">
              <button className="nav-btn" onMouseDown={() => handleNavMove(0, -1)} onTouchStart={() => handleNavMove(0, -1)} onMouseUp={stopNavMove} onMouseLeave={stopNavMove} onTouchEnd={stopNavMove}>
                <ChevronUp size={20}/>
              </button>
              <div className="nav-row">
                <button className="nav-btn" onMouseDown={() => handleNavMove(-1, 0)} onTouchStart={() => handleNavMove(-1, 0)} onMouseUp={stopNavMove} onMouseLeave={stopNavMove} onTouchEnd={stopNavMove}>
                  <ChevronLeft size={20}/>
                </button>
                <button className="nav-btn text-blue-500" onClick={() => {
                  const v = viewportRef.current;
                  if (v) {
                    setCamera({
                      x: (stateRef.current.width * CELL_SIZE * zoom - v.clientWidth) / 2,
                      y: (stateRef.current.height * CELL_SIZE * zoom - v.clientHeight) / 2
                    });
                  }
                }}>
                  <Target size={18}/>
                </button>
                <button className="nav-btn" onMouseDown={() => handleNavMove(1, 0)} onTouchStart={() => handleNavMove(1, 0)} onMouseUp={stopNavMove} onMouseLeave={stopNavMove} onTouchEnd={stopNavMove}>
                  <ChevronRight size={20}/>
                </button>
              </div>
              <button className="nav-btn" onMouseDown={() => handleNavMove(0, 1)} onTouchStart={() => handleNavMove(0, 1)} onMouseUp={stopNavMove} onMouseLeave={stopNavMove} onTouchEnd={stopNavMove}>
                <ChevronDown size={20}/>
              </button>
            </div>
          )}

          {/* Peace Vote Button */}
          {showPeaceVote && gameStatus === 'playing' && (
            <div className="absolute top-20 left-1/2 -translate-x-1/2 z-50 animate-in zoom-in duration-300 w-max">
              <button onClick={() => setGameStatus('victory')} className="peace-vote-btn">
                <Shield size={20}/> {Math.floor((ui.pixels/totalPaintable)*100)}% DOMINATED: CLAIM VICTORY
              </button>
            </div>
          )}

          {/* Canvas Viewport Area */}
          <div 
            ref={viewportRef}
            onMouseDown={handlePanStart}
            onMouseMove={handlePanMove}
            onContextMenu={(e) => e.preventDefault()}
            className="canvas-viewport"
            style={{ touchAction: 'none', position: 'relative', overflow: 'hidden' }}
          >
            <div className="relative shadow-2xl" style={{ 
              width: dims.w * CELL_SIZE, 
              height: dims.h * CELL_SIZE,
              transform: `translate(${-camera.x}px, ${-camera.y}px) scale(${zoom})`,
              transformOrigin: '0 0',
              position: 'absolute',
              top: 0, left: 0
            }}>
            <canvas 
              ref={canvasRef} 
              width={dims.w * CELL_SIZE} 
              height={dims.h * CELL_SIZE}
              style={{ 
                imageRendering: 'pixelated',
                display: 'block'
              }}
              className="cursor-crosshair touch-none bg-white z-0"
              onMouseDown={e=>{if(e.button===0){isMouseDown.current=true;handleCanvasClick(e,true);}}}
              onMouseMove={e=>{if(isMouseDown.current)handleCanvasClick(e,false);}}
              onMouseLeave={()=>{isMouseDown.current=false;}}
              onMouseUp={()=>{isMouseDown.current=false;}}
            />

            {/* Gift Potatoes Button (Desktop - Tethered to World) */}
            {popup?.type === 'gift' && !isMobile && (
              <div 
                className="absolute z-50 pointer-events-auto" 
                style={{ 
                  left: (popup.gridX * CELL_SIZE + CELL_SIZE/2), 
                  top: (popup.gridY * CELL_SIZE),
                  transform: 'translate(-50%, -100%) translateY(-12px)'
                }}
              >
                <button 
                  onMouseDown={e => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); giftPotatoes(100); }}
                  disabled={ui.potatoes < 100}
                  className="flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-600 disabled:bg-slate-200 text-white font-bold py-2.5 px-4 rounded-2xl shadow-2xl transition-all active:scale-95 whitespace-nowrap border-2 border-white animate-in fade-in zoom-in duration-150"
                >
                  <ArrowUp size={16} strokeWidth={3} />
                  <span className="text-xs">Gift 100 🥔</span>
                </button>
              </div>
            )}
          </div>
        </div>

          {/* In-Canvas Milbase upgrade UI */}
          {popup?.type==='milbase' && (
            <div className="popup-overlay--transparent" onMouseDown={() => setPopup(null)}>
              <div onMouseDown={e=>e.stopPropagation()} className="popup-card animate-in zoom-in duration-200">
                <div className="bg-slate-800 p-4 flex items-center justify-between">
                  <div className="popup-headerbox">
                    <img src={getTexture('milbase.png')} alt="Milbase" className="w-8 h-8"/>
                    <span className="popup-title">Military Operations</span>
                  </div>
                  <button onClick={()=>setPopup(null)} className="text-slate-400 hover:text-white transition-colors"><X size={20}/></button>
                </div>
                <div className="p-6 space-y-4">
                  <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100">
                    <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Available Personnel:</div>
                    <div className="grid grid-cols-2 gap-3">
                      {Object.entries(UNITS).filter(([_,v])=>!v.onWater).map(([k,v])=>(
                        <div key={k} className={`flex items-center gap-2 p-2 rounded-lg bg-white border border-slate-100 ${v.advanced&&!ui.milbaseAdvanced?'opacity-40':''}`}>
                          <img src={getTexture(v.sprite)} alt={k} className="w-5 h-5"/>
                          <span className="text-[11px] font-bold text-slate-700 capitalize">{k}</span>
                          {v.advanced&&<span className="text-[8px] text-purple-500 font-bold ml-auto">ADV</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                  {!ui.milbaseAdvanced?(
                    <button onClick={upgradeMilbase} disabled={ui.potatoes<600}
                      className="upgrade-btn">
                      <ArrowUp size={18}/> UPGRADE BASE (600 🥔)
                    </button>
                  ):(
                    <div className="text-center py-3 bg-purple-50 text-purple-600 font-black text-xs rounded-2xl border-2 border-dashed border-purple-200 uppercase tracking-wider">
                      ⭐ Advanced Training Active
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Gift Potatoes Tooltip Popup (Mobile - Fullscreen Modal) */}
          {popup?.type === 'gift' && isMobile && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm p-6" onClick={() => setPopup(null)}>
              <div className="flex flex-col items-center gap-4 animate-in fade-in zoom-in duration-150 w-full max-w-xs" onClick={e => e.stopPropagation()}>
                <button 
                  onClick={() => giftPotatoes(100)}
                  disabled={ui.potatoes < 100}
                  className="w-full flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-600 disabled:bg-slate-200 text-white font-black py-6 rounded-3xl shadow-2xl transition-all active:scale-95 border-4 border-white"
                >
                  <ArrowUp size={18} />
                  <span className="text-sm">Gift 100 🥔</span>
                  <ArrowUp size={24} strokeWidth={4} />
                  <span className="text-lg">GIFT 100 🥔</span>
                </button>
                <button onClick={() => setPopup(null)} className="text-xs font-bold text-slate-400 hover:text-slate-600 p-2">
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {/* In-Canvas Navalport popup UI */}
          {popup?.type==='navalport' && (
            <div className="popup-overlay--transparent" onMouseDown={() => setPopup(null)}>
              <div onMouseDown={e=>e.stopPropagation()} className="popup-card animate-in zoom-in duration-200">
                <div className="bg-blue-800 p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Ship size={24} className="text-white"/>
                    <span className="text-white font-black text-base">Naval Command</span>
                  </div>
                  <button onClick={()=>setPopup(null)} className="text-blue-300 hover:text-white transition-colors"><X size={20}/></button>
                </div>
                <div className="p-6 space-y-4">
                  <div className="space-y-2">
                    {/* Basic Ships */}
                    <div className="grid grid-cols-1 gap-2">
                      {[
                        {type:'frigate', cost:ui.frigateCost, icon: <Waves size={16}/>},
                        {type:'troopship', cost:ui.troopshipCost, icon: <Ship size={16}/>},
                      ].map(s=>(
                        <div key={s.type} className="bg-blue-50 rounded-xl p-3 border border-blue-100 flex items-center gap-3">
                          <div className="text-blue-600">{s.icon}</div>
                          <div className="flex-1">
                            <div className="text-xs font-black text-slate-700 capitalize">{s.type}</div>
                            <div className="text-[9px] text-slate-500">{UNITS[s.type].desc}</div>
                          </div>
                          <button onClick={()=>deployNavalUnit(s.type)} disabled={ui.potatoes < s.cost}
                            className="shrink-0 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 text-white font-bold py-1.5 px-3 rounded-lg text-[10px] shadow-sm">
                            {fmt(s.cost)}🥔
                          </button>
                        </div>
                      ))}
                      {/* Advanced Ships */}
                      {ui.navalportAdvanced && (
                        <div className="bg-indigo-50 rounded-xl p-3 border border-indigo-100 flex items-center gap-3">
                          <div className="text-indigo-600"><Shield size={16}/></div>
                          <div className="flex-1">
                            <div className="text-xs font-black text-slate-700 capitalize">Battleship</div>
                            <div className="text-[9px] text-slate-500">{UNITS.battleship.desc}</div>
                          </div>
                          <button onClick={()=>deployNavalUnit('battleship')} disabled={ui.potatoes < ui.battleshipCost}
                            className="shrink-0 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 text-white font-bold py-1.5 px-3 rounded-lg text-[10px] shadow-sm">
                            {fmt(ui.battleshipCost)}🥔
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {!ui.navalportAdvanced ? (
                    <button onClick={upgradeNavalport} disabled={ui.potatoes < 600}
                      className="upgrade-btn">
                      <ArrowUp size={18}/> UPGRADE SHIPYARD (600 🥔)
                    </button>
                  ) : (
                    <div className="text-center py-3 bg-indigo-50 text-indigo-600 font-black text-xs rounded-2xl border-2 border-dashed border-indigo-200 uppercase tracking-wider">
                      ⭐ Advanced Fleet Unlocked
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Menu */}
          {gameStatus==='menu'&&(
            <div className="menu-overlay">
              <div className="menu-modal">
                <div className="menu-tab-bar">
                  <button onClick={()=>setMenuTab('setup')} className={`menu-tab-btn ${menuTab==='setup' ? 'menu-tab-btn--active' : 'menu-tab-btn--inactive'}`}>
                    <Settings size={14}/> Game Setup
                  </button>
                  <button onClick={()=>setMenuTab('editor')} className={`menu-tab-btn ${menuTab==='editor' ? 'menu-tab-btn--active' : 'menu-tab-btn--inactive'}`}>
                    <Building2 size={14}/> Map Editor
                  </button>
                  <button onClick={()=>setMenuTab('upgrade')} className={`menu-tab-btn ${menuTab==='upgrade' ? 'menu-tab-btn--active' : 'menu-tab-btn--inactive'}`}>
                    <ShoppingBag size={14}/> Upgrade Shop
                    <span className="bg-amber-100 text-amber-700 text-[10px] font-black px-1.5 py-0.5 rounded-full">🫘{fmt(cocoaBeans)}</span>
                  </button>
                </div>
                <div className="p-6">
                  {menuTab==='setup'&&(
                    <>
                      <div className="menu-section-card">
                        {[
                          {label:'Duration',icon:<Clock size={14}/>,key:'duration',opts:[{v:0,l:'Endless'},{v:120,l:'2 min'},{v:300,l:'5 min'}]},
                          {label:'Bots',icon:<Settings size={14}/>,key:'botCount',opts:[{v:1,l:'1 Enemy'},{v:2,l:'2 Enemies'},{v:3,l:'3 Enemies'}]},
                          {label:'Difficulty',icon:<Shield size={14}/>,key:'difficulty',opts:[{v:'easy',l:'Easy'},{v:'normal',l:'Normal'},{v:'hard',l:'Hard'}]},
                          {label:'Map Mode',icon:<Building2 size={14}/>,key:'mapType',opts:[{v:'procedural',l:'Procedural'},{v:'realistic',l:'Realistic'},{v:'custom',l:'Custom Map'}]},
                          {label:'Game Mode',icon:<Star size={14}/>,key:'gameMode',opts:[{v:'classic',l:'Classic'},{v:'br',l:'Battle Royale'},{v:'teams',l:'2v2 Teams'}]},
                          {label:'Match Type',icon:<Play size={14}/>,key:'online',opts:[{v:false,l:'Local (Bots)'},{v:true,l:'Online (Real Players)'}]},
                        ].map(({label,icon,key,opts})=>(
                          <div key={key} className="menu-row">
                            <label className="menu-label">{icon} {label}</label>
                            <select value={settings[key]} onChange={e=>setSettings({...settings,[key]:isNaN(Number(e.target.value))?e.target.value:Number(e.target.value)})}
                              className="menu-select-field">
                              {opts.map(o=><option key={o.v} value={o.v}>{o.l}</option>)}
                            </select>
                          </div>
                        ))}
                      </div>
                      {unlockedBucket>0&&<div className="mb-4 flex items-center gap-2 bg-purple-50 border border-purple-200 rounded-xl px-3 py-2 text-xs font-bold text-purple-700"><Star size={12}/> Active: {BUCKET_UPGRADES[activeBucket].label} Bucket — {BUCKET_UPGRADES[activeBucket].desc}</div>}
                      <button onClick={startGame} className="menu-start-btn">
                        <Play fill="currentColor" size={18}/> START PAINTING
                      </button>
                    </>
                  )}
                  {menuTab==='editor'&&(
                    <div className="space-y-3">
                      {/* Sub-tab Navigation */}
                      <div className="flex bg-slate-100 p-1 rounded-xl">
                        {['terrain', 'configuration'].map(t => (
                          <button key={t} onClick={() => setEditorSubTab(t)} 
                            className={`flex-1 py-2 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all ${editorSubTab === t ? 'bg-white text-emerald-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}>
                            {t === 'terrain' ? 'Terrain & Generation' : 'Configuration'}
                          </button>
                        ))}
                      </div>

                      {editorSubTab === 'terrain' && (
                        <div className="space-y-3 animate-in fade-in slide-in-from-bottom-2">
                          <div className="flex gap-1.5 bg-slate-50 p-1 rounded-xl">
                            {[{id:'procedural',label:'🎲 Procedural'},{id:'realistic',label:'🌍 Realistic'},{id:'custom',label:'✍️ Custom'}].map(m=>(
                              <button key={m.id} onClick={()=>setSettings(s=>({...s,mapType:m.id}))}
                                className={`flex-1 py-1.5 rounded-lg text-[10px] font-black transition-all ${settings.mapType===m.id?'bg-white text-emerald-700 shadow-sm':'text-slate-400 hover:text-slate-600'}`}>
                                {m.label}
                              </button>
                            ))}
                          </div>

                          <div className="bg-white border border-slate-200 rounded-xl p-3">
                            {/* Unique Configuration for Procedural */}
                            {settings.mapType === 'procedural' && (
                              <div className="space-y-3">
                                <div className="grid grid-cols-2 gap-3">
                                  <div className="space-y-1">
                                    <label className="text-[9px] font-black text-slate-400 uppercase">Generation Seed</label>
                                    <input type="text" value={settings.seed} onChange={e=>setSettings(s=>({...s, seed: e.target.value}))} className="w-full bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs font-mono"/>
                                  </div>
                                  <div className="space-y-1">
                                    <label className="text-[9px] font-black text-slate-400 uppercase">Terrain Type</label>
                                    <select value={settings.terrainType} onChange={e=>setSettings(s=>({...s, terrainType: e.target.value}))} className="w-full bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs">
                                      <option value="maze">Maze Pathing</option>
                                      <option value="highlands">Highlands (Rugged)</option>
                                      <option value="desert">Desert (Barren)</option>
                                      <option value="mountainous">Mountainous & Cliffs</option>
                                      <option value="sea">Sea (Island Cluster)</option>
                                      <option value="pangea">Pangea (Center Land)</option>
                                      <option value="archipelago">Archipelago (Islands)</option>
                                      <option value="island_kingdom">Island Kingdom</option>
                                      <option value="giant_island">Giant Island</option>
                                      <option value="halo">Halo Ring</option>
                                    </select>
                                  </div>
                                </div>
                                <div className="space-y-1 border-t border-slate-50 pt-2">
                                  <div className="flex justify-between items-center">
                                    <label className="text-[9px] font-black text-slate-400 uppercase">Obstacle Density</label>
                                    <span className="text-[10px] font-bold text-emerald-600">{settings.terrainDensity}%</span>
                                  </div>
                                  <input type="range" min="5" max="50" value={settings.terrainDensity} onChange={e=>setSettings(s=>({...s, terrainDensity: parseInt(e.target.value)}))} className="w-full accent-emerald-500 h-1.5 bg-slate-100 rounded-lg appearance-none cursor-pointer"/>
                                </div>
                              </div>
                            )}

                            {/* Unique Configuration for Realistic */}
                            {settings.mapType === 'realistic' && (
                              <div className="space-y-3">
                                <div className="grid grid-cols-2 gap-3">
                                  <div className="space-y-1">
                                    <label className="text-[9px] font-black text-slate-400 uppercase">Generation Seed</label>
                                    <input type="text" value={settings.seed} onChange={e=>setSettings(s=>({...s, seed: e.target.value}))} className="w-full bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs font-mono"/>
                                  </div>
                                  <div className="space-y-1">
                                    <label className="text-[9px] font-black text-slate-400 uppercase">World Map</label>
                                    <select value={settings.worldMap} onChange={e=>setSettings(s=>({...s, worldMap: e.target.value}))} className="w-full bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs">
                                      <option value="worldmap">Full World Map</option>
                                      <option value="wm_asia">Asia</option>
                                      <option value="wm_europe">Europe</option>
                                      <option value="wm_africa">Africa</option>
                                      <option value="wm_northamerica">North America</option>
                                      <option value="wm_southamerica">South America</option>
                                    </select>
                                  </div>
                                </div>
                                <div className="space-y-1 border-t border-slate-50 pt-2">
                                  <label className="text-[9px] font-black text-slate-400 uppercase">Landmass Scale</label>
                                  <input type="range" min="5" max="50" value={settings.terrainDensity} onChange={e=>setSettings(s=>({...s, terrainDensity: parseInt(e.target.value)}))} className="w-full accent-emerald-500 h-1.5 bg-slate-100 rounded-lg appearance-none cursor-pointer"/>
                                </div>
                              </div>
                            )}

                            {/* Unique Configuration for Custom Map */}
                            {settings.mapType === 'custom' && (
                              <div className="space-y-3">
                                {/* Primary action: import image as playable map */}
                                <div className="space-y-1.5">
                                  <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Import Image as Map</label>
                                  <p className="text-[9px] text-slate-400 leading-relaxed">Dark pixels → obstacles. Light pixels → open land. Avoid pure black/white.</p>
                                  <label className="w-full cursor-pointer bg-emerald-50 hover:bg-emerald-100 border-2 border-dashed border-emerald-300 rounded-xl py-3 text-xs font-bold text-emerald-700 flex items-center justify-center gap-2 transition-colors">
                                    <ArrowUp size={14}/> {customMap ? '↺ Re-import Image as Map' : '📷 Import Image → Generate Grid'}
                                    <input type="file" accept="image/*" className="hidden" onChange={handleMapImageUpload}/>
                                  </label>
                                </div>

                                {/* Dark threshold slider */}
                                <div className="space-y-1 bg-slate-50 rounded-lg px-3 py-2 border border-slate-100">
                                  <div className="flex justify-between items-center">
                                    <label className="text-[9px] font-black text-slate-400 uppercase">Dark Threshold (obstacles)</label>
                                    <span className="text-[10px] font-bold text-emerald-600">{settings.darkThreshold ?? 60}</span>
                                  </div>
                                  <input type="range" min="20" max="180" value={settings.darkThreshold ?? 60}
                                    onChange={e=>setSettings(s=>({...s, darkThreshold: parseInt(e.target.value)}))}
                                    className="w-full accent-emerald-500 h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer"/>
                                  <div className="flex justify-between text-[8px] text-slate-300 font-bold">
                                    <span>Fewer walls</span><span>More walls</span>
                                  </div>
                                </div>

                                <div className="flex items-center justify-between bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
                                  <label className="flex items-center gap-3 cursor-pointer w-full group">
                                    <input 
                                      type="checkbox" 
                                      checked={settings.passableObstacles} 
                                      onChange={() => setSettings(s => ({ ...s, passableObstacles: !s.passableObstacles }))}
                                      className="w-4 h-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 transition-colors"
                                    />
                                    <span className="text-[10px] font-bold text-slate-700 group-hover:text-slate-900">Obstacles are Passable</span>
                                  </label>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {editorSubTab === 'configuration' && (
                        <div className="space-y-3 animate-in fade-in slide-in-from-bottom-2">
                          <div className="bg-white border border-slate-200 rounded-xl p-4">
                            <div className="space-y-3">
                              <div className="flex flex-col">
                                <label className="text-[9px] font-black text-slate-400 uppercase mb-1">Arena Metadata</label>
                                <input type="text" value={settings.customMapName} onChange={e=>setSettings(s=>({...s, customMapName: e.target.value}))} placeholder="Map Name..." className="w-full text-sm font-bold text-slate-700 focus:outline-none bg-slate-50 px-2 py-1.5 rounded-lg border border-slate-100"/>
                              </div>
                              <div className="flex gap-2">
                                <button onClick={enterEditor} className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-black py-2.5 rounded-xl text-xs flex items-center justify-center gap-1.5 transition-colors shadow-sm">
                                  <Building2 size={14}/> Open Layout Editor
                                </button>
                              </div>
                            </div>

                            <div className="pt-2 border-t border-slate-100">
                              <label className="text-[9px] font-black text-slate-400 uppercase block mb-3">Team Palette</label>
                              <div className="flex gap-3">
                                {[1,2,3,4].map(id=>(
                                  <div key={id} className="flex flex-col items-center gap-1">
                                    <input type="color" value={settings.colors[id]} onChange={e=>setSettings(s=>({...s,colors:{...s.colors,[id]:e.target.value}}))} className="w-8 h-8 rounded-lg cursor-pointer border-2 border-slate-100 p-0.5 bg-white shadow-sm hover:scale-105 transition-transform"/>
                                    <span className="text-[8px] font-black text-slate-400">P{id}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                          
                          {settings.mapType === 'custom' && customMap && (
                            <div className="bg-slate-50 rounded-xl p-2 border border-slate-200 overflow-hidden">
                              <div className="aspect-[60/40] bg-white rounded-lg flex flex-wrap shadow-inner" style={{imageRendering: 'pixelated'}}>
                                {customMap.map((row, y) => y % 4 === 0 && row.map((cell, x) => x % 4 === 0 && (
                                  <div key={`${x}-${y}`} className="w-[6.66%] h-[10%]" style={{backgroundColor: settings.colors[cell] || '#f1f5f9'}}/>
                                )))}
                              </div>
                              <div className="mt-1.5 flex justify-between text-[8px] font-bold text-slate-400 uppercase px-1">
                                <span>Arena Preview</span>
                                <span>{dims.w} × {dims.h}</span>
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {customMap&&<button onClick={()=>{setCustomMap(null);localStorage.removeItem('customMap');}} className="w-full text-[10px] text-slate-400 hover:text-red-500 font-bold transition-colors text-center">✕ Reset custom map</button>}
                    </div>
                  )}
                  {menuTab==='upgrade'&&(
                    <div className="shop-container custom-scrollbar">
                      <p className="text-xs text-slate-400">Earn <span className="font-bold text-amber-600">🫘 Cocoa Beans</span> by destroying enemy buildings. Upgrades persist between games.</p>
                      <div className="menu-section-card">
                        <div className="flex items-center gap-3 mb-3"><span className="text-3xl">🪣</span><div><div className="font-black text-slate-800">Paint Bucket Upgrade</div><div className="text-xs text-slate-400">Larger radius = more area painted per stroke</div></div></div>
                        <div className="grid grid-cols-4 gap-1.5 mb-4">
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
                            className="w-full bg-gradient-to-r from-purple-500 to-blue-500 hover:scale-[1.02] disabled:bg-slate-200 disabled:text-slate-400 text-white font-bold py-2.5 rounded-xl text-sm flex items-center justify-center gap-2 border-b-4 border-blue-800 active:border-b-0 active:translate-y-1 disabled:border-slate-300">
                            <Star size={14}/> Buy Next: {BUCKET_UPGRADES[unlockedBucket+1].label}
                            <span className="bg-black/15 px-2 py-0.5 rounded-lg">🫘{BUCKET_UPGRADES[unlockedBucket+1].cocoaCost}</span>
                          </button>
                        ):(
                          <div className="upgrade-button">
                            <Star size={14} fill="currentColor"/> MAX LEVEL!
                          </div>
                        )}
                      </div>
                      <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                        <div className="font-bold text-amber-800 text-xs mb-2">🫘 Cocoa Bean Rewards</div>
                        <div className="space-y-1">
                          {Object.entries(BLDG).map(([type,def])=>(
                            <div key={type} className="flex justify-between text-xs text-amber-700">
                              <span className="flex items-center gap-1.5"><img src={getTexture(def.sprite)} alt={type} className="w-3 h-3" /> Destroy {type}</span>
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

          {/* Mobile Bottom GUI — slim Antiyoy-style single-row tray */}
          {isMobile && gameStatus === 'playing' && (
            <div className="mobile-bottom-gui">
              {/* Produce Paint pill — left anchor */}
              <button onClick={handleCraftPaint} disabled={gameStatus !== 'playing'} className="antiyoy-paint-btn">
                <PaintBucket size={20}/>
              </button>

              {/* Scrollable item tray */}
              <div className="antiyoy-slider">

                {/* ── Divider: Buildings ── */}
                <span className="antiyoy-divider">🏛</span>
                {[
                  { type: 'factory',   cb: () => buyBuilding('factory') },
                  { type: 'farm',      cb: () => buyBuilding('farm') },
                  { type: 'fort',      cb: () => buyBuilding('fort') },
                  { type: 'infra',     cb: () => buyBuilding('infra') },
                  { type: 'milbase',   cb: () => { if (ui.milbases > 0) { const mb = stateRef.current?.buildings.find(b => b.type === 'milbase' && b.ownerId === 1); setPopup({ type: 'milbase', building: mb || null }); } else buyBuilding('milbase'); } },
                  { type: 'navalport', cb: () => buyBuilding('navalport') },
                  { type: 'tower',     cb: () => buyBuilding('tower') },
                ].filter(item => BLDG[item.type]).map(({ type, cb }) => {
                  const def = BLDG[type];
                  const cost = ui[def?.costKey];
                  const isMilbaseUpgrade = type === 'milbase' && ui.milbases > 0;
                  const canBuy = gameStatus === 'playing' && (isMilbaseUpgrade || (ui.potatoes >= cost && (type !== 'navalport' || (stateRef.current && findTiles(stateRef.current.grid, 5).length > 0))));
                  return (
                    <button key={type} onClick={cb} disabled={!canBuy}
                      className={`antiyoy-item ${!canBuy ? 'antiyoy-item--disabled' : ''}`}>
                      <img src={getTexture(def.sprite)} alt={type} className="antiyoy-icon" />
                      <span className="antiyoy-label">{type === 'milbase' ? 'Base' : type === 'navalport' ? 'Port' : type === 'infra' ? 'Road' : type}</span>
                      <span className="antiyoy-price-tag">{isMilbaseUpgrade ? '⚙️' : fmt(cost)+'🥔'}</span>
                    </button>
                  );
                })}

                {/* ── Divider: Units ── */}
                <span className="antiyoy-divider">⚔️</span>
                {Object.entries(UNITS).map(([type, uDef]) => {
                  const cost = ui[uDef.costKey];
                  const count = ui.unitCounts[type] || 0;
                  const locked = uDef.advanced && !ui.milbaseAdvanced;
                  const noBase = ui.milbases === 0;
                  const canBuy = gameStatus === 'playing' && !locked && !noBase && ui.potatoes >= cost;
                  return (
                    <button key={type} onClick={() => deployUnit(type)} disabled={!canBuy}
                      className={`antiyoy-item ${locked ? 'antiyoy-item--locked' : ''} ${(!canBuy && !locked) ? 'antiyoy-item--disabled' : ''}`}>
                      <img src={getTexture(uDef.sprite)} alt={type} className="antiyoy-icon" />
                      <span className="antiyoy-label">{type}{count > 0 ? ` ×${count}` : ''}</span>
                      <span className="antiyoy-price-tag">{locked ? '🔒' : fmt(cost)+'🥔'}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Editor Mode Overlay */}
          {gameStatus==='editor' && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-white/97 backdrop-blur-sm rounded-2xl shadow-2xl border border-slate-200 z-50 flex flex-col editor-toolbar-responsive">
              {/* Top bar */}
              <div className="flex items-center flex-wrap gap-2 px-4 py-2.5 border-b border-slate-100">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest shrink-0">🗺️ Map Editor</span>
                <div className="hidden sm:block h-4 w-px bg-slate-200"/>
                {/* Tool selector */}
                {[
                  {id:'obstacle', label:'🧱 Obstacle', title:'Draw walls/rocks'},
                  {id:'water',    label:'🌊 Water',    title:'Draw oceans/rivers'},
                  {id:'erase',    label:'🧹 Erase',    title:'Remove any tile'},
                  {id:'spawn1',   label:'🔵 P1 Spawn', title:'Set player 1 start zone'},
                  {id:'spawn2',   label:'🔴 Bot spawn', title:'Set bot start zones'},
                ].map(tool=>(
                  <button key={tool.id} title={tool.title}
                    onClick={()=>setEditorTool(tool.id)}
                    className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${editorTool===tool.id?'bg-slate-800 text-white shadow':'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                    {tool.label}
                  </button>
                ))}
                <div className="hidden sm:block h-4 w-px bg-slate-200"/>
                {/* Brush size */}
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-bold text-slate-400">Brush</span>
                  {[1,2,3].map(s=>(
                    <button key={s} onClick={()=>setEditorBrush(s)}
                      className={`w-6 h-6 rounded-md text-[10px] font-black transition-all ${editorBrush===s?'bg-slate-800 text-white':'bg-slate-100 text-slate-400 hover:bg-slate-200'}`}>
                      {s}
                    </button>
                  ))}
                </div>
                <div className="flex-1"/>
                <button onClick={()=>{
                  const {width, height} = stateRef.current;
                  stateRef.current.grid=Array.from({length:height},()=>Array(width).fill(0));
                  updateGridCache();
                }}
                  className="bg-slate-100 hover:bg-red-100 hover:text-red-600 text-slate-500 font-bold px-3 py-1.5 rounded-xl text-xs transition-colors">Clear</button>
                <button onClick={saveEditor}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold px-4 py-1.5 rounded-xl text-xs shadow transition-colors">Save Map</button>
                <button onClick={()=>setGameStatus('menu')}
                  className="bg-white hover:bg-slate-50 text-slate-400 font-bold px-3 py-1.5 rounded-xl text-xs border border-slate-200 transition-colors">✕ Exit</button>
              </div>
              {/* Status bar */}
              <div className="px-4 py-1.5 text-[10px] text-slate-400 font-medium">
                {{obstacle:'🧱 Click/drag to place obstacles (impassable terrain)',water:'🌊 Click/drag to place water (navigable by ships)',erase:'🧹 Click/drag to erase tiles',spawn1:'🔵 Click to place Player 1 start territory (3×3)',spawn2:'🔴 Click to place bot start territory — each click cycles Bot 1→2→3'}[editorTool]}
              </div>
            </div>
          )}
      </main> 
    </div>

    {/* --- GLOBAL OVERLAYS & POPUPS --- */}
    {popup?.type==='milbase' && (
      <div className="popup-overlay--transparent" onMouseDown={() => setPopup(null)}>
        <div onMouseDown={e=>e.stopPropagation()} className="popup-card animate-in zoom-in duration-200">
          <div className="bg-slate-800 p-4 flex items-center justify-between">
            <div className="popup-headerbox">
              <img src={getTexture('milbase.png')} alt="Milbase" className="w-8 h-8"/>
              <span className="popup-title">Military Operations</span>
            </div>
            <button onClick={()=>setPopup(null)} className="text-slate-400 hover:text-white transition-colors"><X size={20}/></button>
          </div>
          <div className="p-6 space-y-4">
            {/* Milbase content remains identical */}
            <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100">
              <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Available Personnel:</div>
              <div className="grid grid-cols-2 gap-3">
                {Object.entries(UNITS).filter(([_,v])=>!v.onWater).map(([k,v])=>(
                  <div key={k} className={`flex items-center gap-2 p-2 rounded-lg bg-white border border-slate-100 ${v.advanced&&!ui.milbaseAdvanced?'opacity-40':''}`}>
                    <img src={getTexture(v.sprite)} alt={k} className="w-5 h-5"/>
                    <span className="text-[11px] font-bold text-slate-700 capitalize">{k}</span>
                    {v.advanced&&<span className="text-[8px] text-purple-500 font-bold ml-auto">ADV</span>}
                  </div>
                ))}
              </div>
            </div>
            {!ui.milbaseAdvanced?(
              <button onClick={upgradeMilbase} disabled={ui.potatoes<600}
                className="upgrade-btn">
                <ArrowUp size={18}/> UPGRADE BASE (600 🥔)
              </button>
            ):(
              <div className="text-center py-3 bg-purple-50 text-purple-600 font-black text-xs rounded-2xl border-2 border-dashed border-purple-200 uppercase tracking-wider">
                ⭐ Advanced Training Active
              </div>
            )}
          </div>
        </div>
      </div>
    )}

    {popup?.type === 'gift' && isMobile && (
      <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm p-6" onClick={() => setPopup(null)}>
        <div className="flex flex-col items-center gap-4 animate-in fade-in zoom-in duration-150 w-full max-w-xs" onClick={e => e.stopPropagation()}>
          <button onClick={() => giftPotatoes(100)} disabled={ui.potatoes < 100} className="w-full flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-600 disabled:bg-slate-200 text-white font-black py-6 rounded-3xl shadow-2xl transition-all active:scale-95 border-4 border-white">
            <ArrowUp size={18} /><span className="text-sm">Gift 100 🥔</span><ArrowUp size={24} strokeWidth={4} /><span className="text-lg">GIFT 100 🥔</span>
          </button>
          <button onClick={() => setPopup(null)} className="text-xs font-bold text-slate-400 hover:text-slate-600 p-2">Dismiss</button>
        </div>
      </div>
    )}

    {popup?.type==='navalport' && (
      <div className="popup-overlay--transparent" onMouseDown={() => setPopup(null)}>
        <div onMouseDown={e=>e.stopPropagation()} className="popup-card animate-in zoom-in duration-200">
          <div className="bg-blue-800 p-4 flex items-center justify-between">
            <div className="flex items-center gap-3"><Ship size={24} className="text-white"/><span className="text-white font-black text-base">Naval Command</span></div>
            <button onClick={()=>setPopup(null)} className="text-blue-300 hover:text-white transition-colors"><X size={20}/></button>
          </div>
          <div className="p-6 space-y-4">
            {/* Navalport content remains identical */}
          </div>
        </div>
      </div>
    )}

    {gameStatus==='menu' && (
      <div className="menu-overlay">
        <div className="menu-modal">
          <div className="menu-tab-bar">
            <button onClick={()=>setMenuTab('setup')} className={`menu-tab-btn ${menuTab==='setup' ? 'menu-tab-btn--active' : 'menu-tab-btn--inactive'}`}><Settings size={14}/> Game Setup</button>
            <button onClick={()=>setMenuTab('editor')} className={`menu-tab-btn ${menuTab==='editor' ? 'menu-tab-btn--active' : 'menu-tab-btn--inactive'}`}><Building2 size={14}/> Map Editor</button>
            <button onClick={()=>setMenuTab('upgrade')} className={`menu-tab-btn ${menuTab==='upgrade' ? 'menu-tab-btn--active' : 'menu-tab-btn--inactive'}`}><ShoppingBag size={14}/> Upgrade Shop</button>
          </div>
          <div className="p-6">
            {/* All existing menu tab logic (setup, editor, upgrade) remains identical */}
            {menuTab==='setup'&&(
              <>
                <div className="menu-section-card">
                  {[
                    {label:'Duration',icon:<Clock size={14}/>,key:'duration',opts:[{v:0,l:'Endless'},{v:120,l:'2 min'},{v:300,l:'5 min'}]},
                    {label:'Bots',icon:<Settings size={14}/>,key:'botCount',opts:[{v:1,l:'1 Enemy'},{v:2,l:'2 Enemies'},{v:3,l:'3 Enemies'}]},
                    {label:'Difficulty',icon:<Shield size={14}/>,key:'difficulty',opts:[{v:'easy',l:'Easy'},{v:'normal',l:'Normal'},{v:'hard',l:'Hard'}]},
                    {label:'Map Mode',icon:<Building2 size={14}/>,key:'mapType',opts:[{v:'procedural',l:'Procedural'},{v:'realistic',l:'Realistic'},{v:'custom',l:'Custom Map'}]},
                    {label:'Game Mode',icon:<Star size={14}/>,key:'gameMode',opts:[{v:'classic',l:'Classic'},{v:'br',l:'Battle Royale'},{v:'teams',l:'2v2 Teams'}]},
                  ].map(({label,icon,key,opts})=>(
                    <div key={key} className="menu-row">
                      <label className="menu-label">{icon} {label}</label>
                      <select value={settings[key]} onChange={e=>setSettings({...settings,[key]:isNaN(Number(e.target.value))?e.target.value:Number(e.target.value)})}
                        className="menu-select-field">
                        {opts.map(o=><option key={o.v} value={o.v}>{o.l}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
                {unlockedBucket>0&&<div className="mb-4 flex items-center gap-2 bg-purple-50 border border-purple-200 rounded-xl px-3 py-2 text-xs font-bold text-purple-700"><Star size={12}/> Active: {BUCKET_UPGRADES[activeBucket].label} Bucket — {BUCKET_UPGRADES[activeBucket].desc}</div>}
                <button onClick={startGame} className="menu-start-btn">
                  <Play fill="currentColor" size={18}/> START PAINTING
                </button>
              </>
            )}
            {menuTab==='editor'&&(
              <div className="space-y-3">
                {/* Sub-tab Navigation */}
                <div className="flex bg-slate-100 p-1 rounded-xl">
                  {['terrain', 'configuration'].map(t => (
                    <button key={t} onClick={() => setEditorSubTab(t)} 
                      className={`flex-1 py-2 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all ${editorSubTab === t ? 'bg-white text-emerald-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}>
                      {t === 'terrain' ? 'Terrain & Generation' : 'Configuration'}
                    </button>
                  ))}
                </div>

                {editorSubTab === 'terrain' && (
                  <div className="space-y-3 animate-in fade-in slide-in-from-bottom-2">
                    <div className="flex gap-1.5 bg-slate-50 p-1 rounded-xl">
                      {[{id:'procedural',label:'🎲 Procedural'},{id:'realistic',label:'🌍 Realistic'},{id:'custom',label:'✍️ Custom'}].map(m=>(
                        <button key={m.id} onClick={()=>setSettings(s=>({...s,mapType:m.id}))}
                          className={`flex-1 py-1.5 rounded-lg text-[10px] font-black transition-all ${settings.mapType===m.id?'bg-white text-emerald-700 shadow-sm':'text-slate-400 hover:text-slate-600'}`}>
                          {m.label}
                        </button>
                      ))}
                    </div>

                    <div className="bg-white border border-slate-200 rounded-xl p-3">
                      {/* Unique Configuration for Procedural */}
                      {settings.mapType === 'procedural' && (
                        <div className="space-y-3">
                          <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1">
                              <label className="text-[9px] font-black text-slate-400 uppercase">Generation Seed</label>
                              <input type="text" value={settings.seed} onChange={e=>setSettings(s=>({...s, seed: e.target.value}))} className="w-full bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs font-mono"/>
                            </div>
                            <div className="space-y-1">
                              <label className="text-[9px] font-black text-slate-400 uppercase">Terrain Type</label>
                              <select value={settings.terrainType} onChange={e=>setSettings(s=>({...s, terrainType: e.target.value}))} className="w-full bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs">
                                <option value="maze">Maze Pathing</option>
                                <option value="highlands">Highlands (Rugged)</option>
                                <option value="desert">Desert (Barren)</option>
                                <option value="mountainous">Mountainous & Cliffs</option>
                                <option value="sea">Sea (Island Cluster)</option>
                                <option value="pangea">Pangea (Center Land)</option>
                                <option value="archipelago">Archipelago (Islands)</option>
                                <option value="island_kingdom">Island Kingdom</option>
                                <option value="giant_island">Giant Island</option>
                                <option value="halo">Halo Ring</option>
                              </select>
                            </div>
                          </div>
                          <div className="space-y-1 border-t border-slate-50 pt-2">
                            <div className="flex justify-between items-center">
                              <label className="text-[9px] font-black text-slate-400 uppercase">Obstacle Density</label>
                              <span className="text-[10px] font-bold text-emerald-600">{settings.terrainDensity}%</span>
                            </div>
                            <input type="range" min="5" max="50" value={settings.terrainDensity} onChange={e=>setSettings(s=>({...s, terrainDensity: parseInt(e.target.value)}))} className="w-full accent-emerald-500 h-1.5 bg-slate-100 rounded-lg appearance-none cursor-pointer"/>
                          </div>
                        </div>
                      )}

                      {/* Unique Configuration for Realistic */}
                      {settings.mapType === 'realistic' && (
                        <div className="space-y-3">
                          <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1">
                              <label className="text-[9px] font-black text-slate-400 uppercase">Generation Seed</label>
                              <input type="text" value={settings.seed} onChange={e=>setSettings(s=>({...s, seed: e.target.value}))} className="w-full bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs font-mono"/>
                            </div>
                            <div className="space-y-1">
                              <label className="text-[9px] font-black text-slate-400 uppercase">World Map</label>
                              <select value={settings.worldMap} onChange={e=>setSettings(s=>({...s, worldMap: e.target.value}))} className="w-full bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs">
                                <option value="worldmap">Full World Map</option>
                                <option value="wm_asia">Asia</option>
                                <option value="wm_europe">Europe</option>
                                <option value="wm_africa">Africa</option>
                                <option value="wm_northamerica">North America</option>
                                <option value="wm_southamerica">South America</option>
                              </select>
                            </div>
                          </div>
                          <div className="space-y-1 border-t border-slate-50 pt-2">
                            <label className="text-[9px] font-black text-slate-400 uppercase">Landmass Scale</label>
                            <input type="range" min="5" max="50" value={settings.terrainDensity} onChange={e=>setSettings(s=>({...s, terrainDensity: parseInt(e.target.value)}))} className="w-full accent-emerald-500 h-1.5 bg-slate-100 rounded-lg appearance-none cursor-pointer"/>
                          </div>
                        </div>
                      )}

                      {/* Unique Configuration for Custom Map */}
                      {settings.mapType === 'custom' && (
                        <div className="space-y-3">
                          {/* Primary action: import image as playable map */}
                          <div className="space-y-1.5">
                            <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Import Image as Map</label>
                            <p className="text-[9px] text-slate-400 leading-relaxed">Dark pixels → obstacles. Light pixels → open land. Avoid pure black/white.</p>
                            <label className="w-full cursor-pointer bg-emerald-50 hover:bg-emerald-100 border-2 border-dashed border-emerald-300 rounded-xl py-3 text-xs font-bold text-emerald-700 flex items-center justify-center gap-2 transition-colors">
                              <ArrowUp size={14}/> {customMap ? '↺ Re-import Image as Map' : '📷 Import Image → Generate Grid'}
                              <input type="file" accept="image/*" className="hidden" onChange={handleMapImageUpload}/>
                            </label>
                          </div>

                          {/* Dark threshold slider */}
                          <div className="space-y-1 bg-slate-50 rounded-lg px-3 py-2 border border-slate-100">
                            <div className="flex justify-between items-center">
                              <label className="text-[9px] font-black text-slate-400 uppercase">Dark Threshold (obstacles)</label>
                              <span className="text-[10px] font-bold text-emerald-600">{settings.darkThreshold ?? 60}</span>
                            </div>
                            <input type="range" min="20" max="180" value={settings.darkThreshold ?? 60}
                              onChange={e=>setSettings(s=>({...s, darkThreshold: parseInt(e.target.value)}))}
                              className="w-full accent-emerald-500 h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer"/>
                            <div className="flex justify-between text-[8px] text-slate-300 font-bold">
                              <span>Fewer walls</span><span>More walls</span>
                            </div>
                          </div>

                          <div className="flex items-center justify-between bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
                            <label className="flex items-center gap-3 cursor-pointer w-full group">
                              <input 
                                type="checkbox" 
                                checked={settings.passableObstacles} 
                                onChange={() => setSettings(s => ({ ...s, passableObstacles: !s.passableObstacles }))}
                                className="w-4 h-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 transition-colors"
                              />
                              <span className="text-[10px] font-bold text-slate-700 group-hover:text-slate-900">Obstacles are Passable</span>
                            </label>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {editorSubTab === 'configuration' && (
                  <div className="space-y-3 animate-in fade-in slide-in-from-bottom-2">
                    <div className="bg-white border border-slate-200 rounded-xl p-4">
                      <div className="space-y-3">
                        <div className="flex flex-col">
                          <label className="text-[9px] font-black text-slate-400 uppercase mb-1">Arena Metadata</label>
                          <input type="text" value={settings.customMapName} onChange={e=>setSettings(s=>({...s, customMapName: e.target.value}))} placeholder="Map Name..." className="w-full text-sm font-bold text-slate-700 focus:outline-none bg-slate-50 px-2 py-1.5 rounded-lg border border-slate-100"/>
                        </div>
                        <div className="flex gap-2">
                          <button onClick={enterEditor} className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-black py-2.5 rounded-xl text-xs flex items-center justify-center gap-1.5 transition-colors shadow-sm">
                            <Building2 size={14}/> Open Layout Editor
                          </button>
                        </div>
                      </div>

                      <div className="pt-2 border-t border-slate-100">
                        <label className="text-[9px] font-black text-slate-400 uppercase block mb-3">Team Palette</label>
                        <div className="flex gap-3">
                          {[1,2,3,4].map(id=>(
                            <div key={id} className="flex flex-col items-center gap-1">
                              <input type="color" value={settings.colors[id]} onChange={e=>setSettings(s=>({...s,colors:{...s.colors,[id]:e.target.value}}))} className="w-8 h-8 rounded-lg cursor-pointer border-2 border-slate-100 p-0.5 bg-white shadow-sm hover:scale-105 transition-transform"/>
                              <span className="text-[8px] font-black text-slate-400">P{id}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                    
                    {settings.mapType === 'custom' && customMap && (
                      <div className="bg-slate-50 rounded-xl p-2 border border-slate-200 overflow-hidden">
                        <div className="aspect-[60/40] bg-white rounded-lg flex flex-wrap shadow-inner" style={{imageRendering: 'pixelated'}}>
                          {customMap.map((row, y) => y % 4 === 0 && row.map((cell, x) => x % 4 === 0 && (
                            <div key={`${x}-${y}`} className="w-[6.66%] h-[10%]" style={{backgroundColor: settings.colors[cell] || '#f1f5f9'}}/>
                          )))}
                        </div>
                        <div className="mt-1.5 flex justify-between text-[8px] font-bold text-slate-400 uppercase px-1">
                          <span>Arena Preview</span>
                          <span>{dims.w} × {dims.h}</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {customMap&&<button onClick={()=>{setCustomMap(null);localStorage.removeItem('customMap');}} className="w-full text-[10px] text-slate-400 hover:text-red-500 font-bold transition-colors text-center">✕ Reset custom map</button>}
              </div>
            )}
            {menuTab==='upgrade'&&(
              <div className="shop-container custom-scrollbar">
                <p className="text-xs text-slate-400">Earn <span className="font-bold text-amber-600">🫘 Cocoa Beans</span> by destroying enemy buildings. Upgrades persist between games.</p>
                <div className="menu-section-card">
                  <div className="flex items-center gap-3 mb-3"><span className="text-3xl">🪣</span><div><div className="font-black text-slate-800">Paint Bucket Upgrade</div><div className="text-xs text-slate-400">Larger radius = more area painted per stroke</div></div></div>
                  <div className="grid grid-cols-4 gap-1.5 mb-4">
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
                      className="w-full bg-gradient-to-r from-purple-500 to-blue-500 hover:scale-[1.02] disabled:bg-slate-200 disabled:text-slate-400 text-white font-bold py-2.5 rounded-xl text-sm flex items-center justify-center gap-2 border-b-4 border-blue-800 active:border-b-0 active:translate-y-1 disabled:border-slate-300">
                      <Star size={14}/> Buy Next: {BUCKET_UPGRADES[unlockedBucket+1].label}
                      <span className="bg-black/15 px-2 py-0.5 rounded-lg">🫘{BUCKET_UPGRADES[unlockedBucket+1].cocoaCost}</span>
                    </button>
                  ):(
                    <div className="upgrade-button">
                      <Star size={14} fill="currentColor"/> MAX LEVEL!
                    </div>
                  )}
                </div>
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                  <div className="font-bold text-amber-800 text-xs mb-2">🫘 Cocoa Bean Rewards</div>
                  <div className="space-y-1">
                    {Object.entries(BLDG).map(([type,def])=>(
                      <div key={type} className="flex justify-between text-xs text-amber-700">
                        <span className="flex items-center gap-1.5"><img src={getTexture(def.sprite)} alt={type} className="w-3 h-3" /> Destroy {type}</span>
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

    {gameStatus==='gameover'&&<Overlay bg="bg-red-900/90" icon={<Skull size={52} className="text-red-400 mx-auto mb-3"/>} title="WIPED OUT" sub="An enemy painted over your last territory." btnColor="bg-white text-red-600" onBack={resetRound}/>}
    {gameStatus==='victory'&&<Overlay bg="bg-blue-900/90" icon={<Trophy size={52} className="text-yellow-400 mx-auto mb-3"/>} title="DOMINATION" sub="You painted the whole map!" btnColor="bg-yellow-400 text-yellow-900" onBack={resetRound}/>}
    {gameStatus==='timeup'&&<Overlay bg="bg-indigo-900/90" icon={<Clock size={52} className="text-indigo-300 mx-auto mb-3"/>} title="TIME'S UP!" sub={ui.leaderboard[0]?.id===1?'You won!':`${ui.leaderboard[0]?.name} won!`} btnColor="bg-white text-indigo-900" onBack={resetRound}/>}

    </div>
  );
}
