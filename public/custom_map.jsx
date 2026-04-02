﻿export const MAP_SETTINGS = {
  // Define the colors for teams and terrain
  colors: {
    0: '#f1f5f9', // Empty/Void
    1: '#3b82f6', // Player 1 (Blue)
    2: '#ef4444', // Bot 1 (Red)
    3: '#10b981', // Bot 2 (Green)
    4: '#f59e0b', // Bot 3 (Orange)
    5: '#0ea5e9', // Water (Light Blue)
    9: '#334155'  // Neutral Obstacles
  },
  // Configuration for procedural terrain generation
  terrainClusters: 20,
  assets: {
    background: "map_bg.png",
    water: "seawater.png"
  }
};