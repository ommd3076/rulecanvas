# RuleCanvas Performance & Optimization Guide

## Bundle Architecture
- **Vite 6 Bundler**: Compiles React 19 JSX with zero runtime JSX overhead.
- **Tailwind CSS v4 Engine**: Pre-calculated atomic utility styles without runtime parsing.

## Canvas Render Benchmarks
- Graph canvas pan and zoom operates at 60 FPS via CSS transforms.
- Connection drag line calculates SVG path coordinates in equestAnimationFrame.
