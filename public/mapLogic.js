import { GRID_W, GRID_H, MAX_GRID_DIM, MAP_SETTINGS } from './constants';
import { seededRnd, makeEnt, hexToRgb } from './utils';

export const createInitialState = (settings, customMap) => {
  const sRnd = seededRnd(settings.seed || Math.random());
  const getRnd = (n) => Math.floor(sRnd() * n);

  const hasExternalGrid = !!customMap;
  
  let w = GRID_W;
  let h = GRID_H;
  if (hasExternalGrid) {
    h = customMap.length;
    w = customMap[0].length;
  }

  const g = hasExternalGrid 
    ? customMap.map(row => [...row]) 
    : Array.from({length:h},()=>Array(w).fill(0));
    
  // If no external grid provided, we simply use the empty grid initialized above.
  // Procedural generation is now handled externally in game.jsx before state creation.
  if(!hasExternalGrid) {
    // Default fallback initialization if needed
  }
  
  const spawn=(id,cx,cy)=>{
    // Clear a wider margin (7×7) around spawn to prevent bots getting trapped by surrounding obstacles
    for(let y=cy-3;y<=cy+3;y++) for(let x=cx-3;x<=cx+3;x++) if(x>=0&&x<w&&y>=0&&y<h && g[y][x]!==5) g[y][x]=0;
    for(let y=cy-1;y<=cy+1;y++) for(let x=cx-1;x<=cx+1;x++) if(x>=0&&x<w&&y>=0&&y<h) g[y][x]=id;
  };

  const playerCount = settings.botCount + 1;

  if (hasExternalGrid) {
    const proceduralPts = [];
    for (let id = 1; id <= playerCount; id++) {
      const tiles = [];
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          if (g[y][x] === id) tiles.push({ x, y });

      if (tiles.length > 0) {
        const cx = Math.round(tiles.reduce((s, t) => s + t.x, 0) / tiles.length);
        const cy = Math.round(tiles.reduce((s, t) => s + t.y, 0) / tiles.length);
        proceduralPts.push({ x: cx, y: cy });
      } else {
        const margin = 8;
        let bestX = 0, bestY = 0, maxDist = -1;
        for (let j = 0; j < 30; j++) {
          const tx = margin + getRnd(w - margin * 2);
          const ty = margin + getRnd(h - margin * 2);
          const minDistToOthers = proceduralPts.length === 0
            ? 100
            : Math.min(...proceduralPts.map(p => Math.hypot(p.x - tx, p.y - ty)));
          const isLand = g[ty][tx] === 0;
          const score = minDistToOthers + (isLand ? 1000 : 0);
          if (score > maxDist) { maxDist = score; bestX = tx; bestY = ty; }
        }
        proceduralPts.push({ x: bestX, y: bestY });
        spawn(id, bestX, bestY);
      }
    }
  } else {
    const pts = [];
    const margin = 8;
    for (let i = 0; i < playerCount; i++) {
      let bestX = 0, bestY = 0, maxDist = -1;
      for (let j = 0; j < 30; j++) {
        const tx = margin + getRnd(w - margin * 2);
        const ty = margin + getRnd(h - margin * 2);
        const minDistToOthers = pts.length === 0 ? 100 : Math.min(...pts.map(p => Math.hypot(p.x - tx, p.y - ty)));
        if (minDistToOthers > maxDist) {
          maxDist = minDistToOthers;
          bestX = tx;
          bestY = ty;
        }
      }
      pts.push({ x: bestX, y: bestY });
      spawn(i + 1, bestX, bestY);
    }
  }

  const bots = [];
  if(settings.botCount>=1) bots.push(makeEnt(2,'Alpha Empire'));
  if(settings.botCount>=2) bots.push(makeEnt(3,'Beta Republic'));
  if(settings.botCount>=3) bots.push(makeEnt(4,'Gamma Sultanate'));

  const isAlly = settings.gameMode === 'teams'
    ? (a, b) => (a === 1 || a === 3) === (b === 1 || b === 3)
    : null;

  return {grid:g, width: w, height: h, tickCount:0, settings, player:makeEnt(1,'You'), bots, buildings:[], units:[], brShrink: 0, isAlly};
};

export const parseImageToGrid = (imgElement, darkThreshold = 60) => {
  let targetW = imgElement.width;
  let targetH = imgElement.height;
  if (targetW > MAX_GRID_DIM || targetH > MAX_GRID_DIM) {
    const scale = Math.min(MAX_GRID_DIM / targetW, MAX_GRID_DIM / targetH);
    targetW = Math.floor(targetW * scale);
    targetH = Math.floor(targetH * scale);
  }
  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width  = targetW;
  tmpCanvas.height = targetH;
  const ctx = tmpCanvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(imgElement, 0, 0, targetW, targetH);
  const { data } = ctx.getImageData(0, 0, targetW, targetH);
  const grid = Array.from({ length: targetH }, (_, y) =>
    Array.from({ length: targetW }, (_, x) => {
      const idx = (y * targetW + x) * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];

      // Detect water first (Blue/Cyan variants)
      // Prioritizing this avoids dark blue water pixels being classified as obstacles
      if (b > r && b > g && b > 40) return 5; 

      const brightness = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (brightness < darkThreshold) return 9; // Obstacle/Wall
      
      return 0; // Empty land
    })
  );
  return grid;
};

export const createRecoloredCanvas = (image, ownerColorHex, placeholderRgb) => {
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
    if (pixels[i] === placeholderRgb.r && pixels[i + 1] === placeholderRgb.g && pixels[i + 2] === placeholderRgb.b) {
      pixels[i] = ownerColorRgb.r; 
      pixels[i + 1] = ownerColorRgb.g; 
      pixels[i + 2] = ownerColorRgb.b;
    }
  }
  tempCtx.putImageData(imageData, 0, 0);
  return tempCanvas;
};