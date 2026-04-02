import { MAP_SETTINGS as CUSTOM_MAP_SETTINGS } from './custom_map';

// Fallback object to prevent crashes if custom_map.js is empty or has a circular dependency
export const MAP_SETTINGS = CUSTOM_MAP_SETTINGS || { colors: {}, terrainClusters: 20 };
export { CUSTOM_MAP_SETTINGS };

export const MAX_GRID_DIM = 100;
export const GRID_W = 100;
export const GRID_H = 70;
export const CELL_SIZE = 20;
export const TICK_RATE = 100;
export const FORT_WALL_OFFSET = 10;

export const ASSET_BASE = (import.meta.env.BASE_URL === './' || import.meta.env.BASE_URL === '/') 
  ? '/assets/textures/' 
  : `${import.meta.env.BASE_URL.replace(/\/$/, '')}/assets/textures/`;

export const getTexture = (name) => name.startsWith('/') ? name : `${ASSET_BASE}${name}`;

export const BLDG = {
  factory:   { sprite: 'factory.png', hp:3,  cocoaReward:4,  cost:20,  costKey:'factoryCost',  countKey:'factories',    desc:'Paint /click',   baseMul:1.5, w:2, h:2 },
  farm:      { sprite: 'farm.png', hp:2,  cocoaReward:2,  cost:50,  costKey:'farmCost',     countKey:'farms',        desc:'+10/s',        baseMul:1.5, w:1, h:1 },
  fort:      { sprite: 'fort.png', hp:8,  cocoaReward:8,  cost:300, costKey:'fortCost',     countKey:'forts',        desc:'Wall+block',     baseMul:1.5, w:3, h:3 },
  infra:     { sprite: 'infra.png', hp:4,  cocoaReward:5,  cost:500, costKey:'infraCost',    countKey:'infrastructures', desc:'+20% eff',    baseMul:1.5, w:1, h:1 },
  milbase:   { sprite: 'milbase.png', hp:40, cocoaReward:100, cost:400, costKey:'milbaseCost',  countKey:'milbases',     desc:'Army Command', baseMul:1.8, w:2, h:2 },
  tower:     { sprite: 'tower.png', hp:6,  cocoaReward:7,  cost:600, costKey:'towerCost',   countKey:'towers',       desc:'Auto-fires at units', baseMul:1.5, w:1, h:3 },
  navalport: { sprite: 'navalport.png', hp:20, cocoaReward:60, cost:400, costKey:'navalportCost', countKey:'navalports', desc:'Shipyard', baseMul:1.6, w:2, h:2 },
};

export const UNITS = {
  soldier:  { sprite: 'soldier.png', hp:3, atk:1, cd:10, speed:1, range:1,  cost:150, costKey:'soldierCost',  advanced:false, desc:'Basic fighter' },
  scout:    { sprite: 'scout.png', hp:1, atk:1, cd:4,  speed:3, range:1,  cost:200, costKey:'scoutCost',    advanced:false, desc:'Fast, fragile' },
  demo:     { sprite: 'demo.png', hp:5, atk:4, cd:15, speed:1, range:1,  cost:350, costKey:'demoCost',     advanced:false, desc:'Busts buildings/forts' },
  ranger:   { sprite: 'ranger.png', hp:4, atk:2, cd:20, speed:1, range:3,  cost:500, costKey:'rangerCost',   advanced:true,  desc:'Long-range, hits 3 tiles' },
  commander:{ sprite: 'commander.png', hp:6, atk:1, cd:12, speed:1, range:2,  cost:800, costKey:'commanderCost',advanced:true,  desc:'Boosts nearby allies' },
  frigate:  { sprite: 'frigate.png', hp:30, atk:4, range:4, cd:25, cost:150, costKey:'frigateCost', desc:'Heavy ship', onWater: true },
  troopship:{hp: 40, atk: 0, range: 1, cd: 20, costKey: 'troopshipCost', sprite: 'troopship.png', desc: 'Carries land units', onWater: true},
  battleship:{sprite: 'frigate.png', hp: 60, atk: 8, range: 6, cd: 30, cost: 450, costKey: 'battleshipCost', advanced: true, desc: 'Dominates the seas', onWater: true}
  
};

export const BUCKET_UPGRADES = [
  { radius:1, label:'Basic',  desc:'1×1',  cocoaCost:0  },
  { radius:2, label:'Wide',   desc:'3×3',  cocoaCost:1000  },
  { radius:3, label:'Splash', desc:'5×5',  cocoaCost:2000 },
  { radius:4, label:'Flood',  desc:'7×7',  cocoaCost:4000 },
];

export const COLORS = { 
  0: '#e2e8f0', // Empty background
  1: '#ef4444', // Red (Player 1)
  2: '#3b82f6', // Blue (Bot 2)
  3: '#10b981', // Green (Bot 3)
  4: '#f59e0b', // Yellow (Bot 4)
  5: '#0ea5e9', // Water
  9: '#64748b', // Obstacles/Terrain
  // Fort Wall Colors (FORT_WALL_OFFSET + PlayerID)
  11: '#b91c1c', 
  12: '#1d4ed8',
  13: '#047857',
  14: '#b45309',
  ...(MAP_SETTINGS.colors || {}) 
};
export const PLACEHOLDER_GRAY_RGB = { r: 100, g: 100, b: 100 };