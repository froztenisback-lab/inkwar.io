import { COLORS, FORT_WALL_OFFSET, BLDG } from './constants';

export const fmt = n => n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':String(n);
export const clamp = (v,lo,hi) => Math.max(lo, Math.min(hi, v));
export const rnd = n => Math.floor(Math.random()*n);

export const hashString = str => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
};

export const seededRnd = (s) => {
  const seed = hashString(String(s));
  let t = seed + 0x6D2B79F5;
  return () => {
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
};

export const isOwned = (cell, id) => cell===id || cell===FORT_WALL_OFFSET+id;
export const isFortWall = cell => cell >= FORT_WALL_OFFSET+1 && cell <= FORT_WALL_OFFSET+4;
export const fortWallOwner = cell => cell - FORT_WALL_OFFSET;

export const findTiles = (grid, id) => {
  const t=[];
  const gh = grid.length, gw = grid[0].length;
  for(let y=0;y<gh;y++) for(let x=0;x<gw;x++) if(isOwned(grid[y][x],id)) t.push({x,y});
  return t;
};

export const canPlaceBuilding = (grid, x, y, w, h, id, buildings = [], isNaval = false) => {
  const gh = grid.length, gw = grid[0].length;
  for(let dy=0;dy<h;dy++) for(let dx=0;dx<w;dx++){
    const nx=x+dx, ny=y+dy;
    if(nx>=gw||ny>=gh) return false;
    const cell = grid[ny][nx];
    if (isNaval) { if (cell !== 5) return false; } // Must be on water
    else { if (!isOwned(cell, id)) return false; } // Must be on own land
  }
  for(const b of buildings){
    const bw = BLDG[b.type].w || 1;
    const bh = BLDG[b.type].h || 1;
    if(x < b.x+bw && x+w > b.x && y < b.y+bh && y+h > b.y) return false;
  }
  return true;
};

export const findBorderTile = (grid, id) => {
  const DIRS=[[-1,0],[1,0],[0,-1],[0,1]]; const b=[];
  const gh = grid.length, gw = grid[0].length;
  for(let y=0;y<gh;y++) for(let x=0;x<gw;x++)
    if(isOwned(grid[y][x],id))
      for(const[dy,dx]of DIRS){const ny=y+dy,nx=x+dx;
        if(ny>=0&&ny<gh&&nx>=0&&nx<gw&&!isOwned(grid[ny][nx],id)&&grid[ny][nx]!==9&&grid[ny][nx]!==5){b.push({x,y});break;}}
  return b.length?b[rnd(b.length)]:null;
};

export const getBuildingPerimeter = (bx, by, bw, bh, gw, gh) => {
  const t = [];
  for (let dy = -1; dy <= bh; dy++) {
    for (let dx = -1; dx <= bw; dx++) {
      const isInside = dx >= 0 && dx < bw && dy >= 0 && dy < bh;
      if (!isInside) {
        const nx = bx + dx, ny = by + dy;
        if (nx >= 0 && nx < gw && ny >= 0 && ny < gh) t.push({ x: nx, y: ny });
      }
    }
  }
  return t;
};

export const hexToRgb = hex => {
  const bigint = parseInt(hex.replace('#',''), 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return { r, g, b };
};

export const makeEnt = (id,name) => ({
  id, name, color:COLORS[id],
  potatoes:id===1?10:0, paintUnits:4, pixels:9,
  factories:0, factoryCost:20, farms:0, farmCost:50,
  forts:0, fortCost:300, infrastructures:0, infraCost:500,
  milbases:0, milbaseCost:400, milbaseAdvanced:false,
  navalports:0, navalportCost:400, navalportAdvanced:false,
  towers:0, towerCost:600,
  soldierCost:150, scoutCost:200, demoCost:350, rangerCost:500, commanderCost:800,
  frigateCost:150, troopshipCost:150, battleshipCost:450,
});