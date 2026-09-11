import type { BrainRenderer } from '@/renderer/BrainRenderer';

/**
 * Module-level handle to the single renderer instance.
 *
 * The renderer owns megabytes of GPU-backed state and must never be copied,
 * diffed, or stored in React state. Store actions reach it through this ref, so
 * the boundary stays one-directional: React tells the renderer what to show;
 * the renderer reports indices and statistics back through callbacks.
 *
 * A singleton is the right shape here because the application has exactly one
 * viewport. Should a second ever exist (the planned virtual-fish view), it gets
 * its own renderer and its own ref rather than sharing this one.
 */
export const rendererRef: { current: BrainRenderer | null } = { current: null };
