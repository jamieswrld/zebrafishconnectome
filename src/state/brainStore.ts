'use client';

import { create } from 'zustand';
import type { BrainDatasetAdapter, LoadProgress, LoadStage } from '@/core/adapter';
import { DataError, toDataError } from '@/core/errors';
import { asLoreId, type LoreId } from '@/core/ids';
import {
  buildLoreIdLookup,
  computeVisibilityMask,
  defaultFilterState,
  type FilterState,
} from '@/core/filters';
import type {
  CellPolarity,
  ConnectionPartner,
  ConnectionSet,
  DatasetMetadata,
  Neuron,
  NeuronIndex,
  NeuronSkeleton,
} from '@/core/types';
import { resolveAdapter } from '@/datasets/registry';
import type { RendererStats } from '@/renderer/BrainRenderer';
import type { ColorMode, ContextMode } from '@/renderer/types';
import type { CircuitEdgeInput } from '@/renderer/layers/ConnectionLayer';
import { rendererRef } from './rendererRef';

/**
 * Application state.
 *
 * Split by concern, as the architecture requires:
 *   - UI state       selection, filters, panels, display modes
 *   - data cache     dataset metadata, fetched neurons and connectivity
 *   - render state   owned by BrainRenderer, NOT here
 *
 * The one large object stored here is the NeuronIndex, held as an opaque
 * reference. Components select scalars from it (counts, a single neuron's
 * fields); nothing subscribes to its TypedArrays, so a 200k population causes
 * no React work.
 */

export interface LoadState {
  readonly stage: LoadStage;
  readonly message: string;
  readonly fraction: number | null;
  readonly bytesLoaded?: number;
  readonly bytesTotal?: number;
  readonly error: DataError | null;
}

export interface SelectionState {
  /** Index into the loaded population, or -1. */
  readonly index: number;
  readonly loreId: LoreId | null;
  readonly neuron: Neuron | null;
  readonly loading: boolean;
  readonly error: DataError | null;
}

export interface CircuitState {
  readonly loading: boolean;
  readonly error: DataError | null;
  readonly data: ConnectionSet | null;
  readonly depth: number;
  readonly direction: 'incoming' | 'outgoing' | 'both';
  readonly minSynapses: number;
  readonly topN: number;
  readonly isolated: boolean;
}

export interface SkeletonState {
  readonly loading: boolean;
  readonly error: DataError | null;
  readonly data: NeuronSkeleton | null;
}

export interface DisplayState {
  readonly colorMode: ColorMode;
  readonly contextMode: ContextMode;
  readonly showConnections: boolean;
  readonly showAxes: boolean;
  readonly leftPanelOpen: boolean;
  readonly rightPanelOpen: boolean;
  readonly debugOpen: boolean;
  /**
   * Draw every animation frame instead of skipping idle ones. Benchmark only:
   * in normal use a still camera over static data should cost nothing.
   */
  readonly continuousRendering: boolean;
}

interface BrainState {
  datasetId: string;
  adapter: BrainDatasetAdapter | null;
  metadata: DatasetMetadata | null;
  index: NeuronIndex | null;
  loreIdLookup: Map<number, number> | null;

  load: LoadState;
  selection: SelectionState;
  hoverIndex: number;
  circuit: CircuitState;
  skeleton: SkeletonState;
  filters: FilterState;
  visibleCount: number;
  filterElapsedMs: number;
  display: DisplayState;
  stats: RendererStats | null;

  loadDataset: (datasetId: string) => Promise<void>;
  selectIndex: (index: number) => void;
  selectLoreId: (loreId: LoreId) => void;
  clearSelection: () => void;
  setHoverIndex: (index: number) => void;
  setFilters: (update: Partial<FilterState>) => void;
  toggleCellType: (type: CellPolarity) => void;
  resetFilters: () => void;
  requestConnections: (
    options?: Partial<Pick<CircuitState, 'direction' | 'minSynapses' | 'topN'>>,
  ) => Promise<void>;
  clearCircuit: () => void;
  setIsolated: (isolated: boolean) => void;
  requestSkeleton: () => Promise<void>;
  setDisplay: (update: Partial<DisplayState>) => void;
  setStats: (stats: RendererStats) => void;
}

const initialLoad: LoadState = {
  stage: 'idle',
  message: 'IDLE',
  fraction: null,
  error: null,
};

const emptySelection: SelectionState = {
  index: -1,
  loreId: null,
  neuron: null,
  loading: false,
  error: null,
};

const emptyCircuit: CircuitState = {
  loading: false,
  error: null,
  data: null,
  depth: 1,
  direction: 'both',
  minSynapses: 1,
  topN: 50,
  isolated: false,
};

/** Reused across filter passes so a slider drag does not allocate per frame. */
let maskScratch: Uint8Array | null = null;

/** Guards against a slow response for a neuron the user has already moved past. */
let selectionToken = 0;
let circuitToken = 0;
let skeletonToken = 0;

export const useBrainStore = create<BrainState>((set, get) => ({
  datasetId: '',
  adapter: null,
  metadata: null,
  index: null,
  loreIdLookup: null,

  load: initialLoad,
  selection: emptySelection,
  hoverIndex: -1,
  circuit: emptyCircuit,
  skeleton: { loading: false, error: null, data: null },
  filters: defaultFilterState(),
  visibleCount: 0,
  filterElapsedMs: 0,
  display: {
    colorMode: 'cell-type',
    contextMode: 'dim',
    showConnections: true,
    showAxes: true,
    leftPanelOpen: true,
    rightPanelOpen: true,
    debugOpen: false,
    continuousRendering: false,
  },
  stats: null,

  async loadDataset(datasetId) {
    const adapter = resolveAdapter(datasetId);
    set({
      datasetId: adapter.id,
      adapter,
      index: null,
      loreIdLookup: null,
      metadata: null,
      selection: emptySelection,
      circuit: emptyCircuit,
      skeleton: { loading: false, error: null, data: null },
      load: { ...initialLoad, stage: 'manifest', message: 'LOADING DATASET MANIFEST' },
    });

    const onProgress = (p: LoadProgress) =>
      set({
        load: {
          stage: p.stage,
          message: p.message,
          fraction: p.fraction,
          bytesLoaded: p.bytesLoaded,
          bytesTotal: p.bytesTotal,
          error: null,
        },
      });

    try {
      const metadata = await adapter.metadata();
      set({ metadata });

      if (metadata.unavailable && !metadata.capabilities.neuronIndex) {
        // Surface the reason rather than failing with a generic error; the
        // dataset panel explains exactly what the operator must do.
        set({
          load: {
            stage: 'error',
            message: metadata.unavailable.message,
            fraction: null,
            error: new DataError({
              code:
                metadata.unavailable.reason === 'requires-authorization'
                  ? 'auth_missing'
                  : 'unsupported_operation',
              message: metadata.unavailable.message,
              detail: metadata.unavailable.remediation,
              datasetId: adapter.id,
            }),
          },
        });
        return;
      }

      const index = await adapter.neuronIndex({ onProgress });

      set({
        load: {
          stage: 'uploading',
          message: 'UPLOADING SOMA BUFFERS',
          fraction: null,
          error: null,
        },
      });

      rendererRef.current?.setNeuronIndex(index);

      const filters = defaultFilterState();
      maskScratch = new Uint8Array(index.count);
      const result = computeVisibilityMask(index, filters, maskScratch);
      rendererRef.current?.applyVisibilityMask(result.mask);

      set({
        index,
        loreIdLookup: buildLoreIdLookup(index),
        filters,
        visibleCount: result.visibleCount,
        filterElapsedMs: result.elapsedMs,
        load: {
          stage: 'ready',
          message: 'READY',
          fraction: 1,
          error: null,
        },
      });
    } catch (e) {
      const error = toDataError(e);
      set({
        load: { stage: 'error', message: error.message, fraction: null, error },
      });
    }
  },

  selectIndex(index) {
    const adapter = get().adapter;
    const population = get().index;
    rendererRef.current?.setSelectedIndex(index);

    if (index < 0 || !population) {
      set({
        selection: emptySelection,
        circuit: { ...get().circuit, data: null },
        skeleton: { loading: false, error: null, data: null },
      });
      rendererRef.current?.clearCircuit();
      return;
    }

    const loreId = asLoreId(population.loreIds[index]);
    const token = ++selectionToken;
    set({
      selection: { index, loreId, neuron: null, loading: true, error: null },
      circuit: {
        ...emptyCircuit,
        direction: get().circuit.direction,
        minSynapses: get().circuit.minSynapses,
        topN: get().circuit.topN,
      },
      skeleton: { loading: false, error: null, data: null },
    });
    rendererRef.current?.clearCircuit();

    void adapter
      ?.getNeuron(loreId)
      .then((neuron) => {
        if (token !== selectionToken) return;
        set({ selection: { index, loreId, neuron, loading: false, error: null } });
      })
      .catch((e) => {
        if (token !== selectionToken) return;
        set({
          selection: {
            index,
            loreId,
            neuron: null,
            loading: false,
            error: toDataError(e),
          },
        });
      });
  },

  selectLoreId(loreId) {
    const lookup = get().loreIdLookup;
    const index = lookup?.get(Number(loreId));
    if (index === undefined) {
      set({
        selection: {
          index: -1,
          loreId,
          neuron: null,
          loading: false,
          error: new DataError({
            code: 'not_found',
            message: `Lore ID ${loreId} is not present in the loaded population.`,
            detail:
              'It may exist in the dataset but not in this export, or it may belong to a different dataset.',
          }),
        },
      });
      return;
    }
    get().selectIndex(index);
  },

  clearSelection() {
    selectionToken++;
    rendererRef.current?.setSelectedIndex(-1);
    rendererRef.current?.clearCircuit();
    set({
      selection: emptySelection,
      circuit: emptyCircuit,
      skeleton: { loading: false, error: null, data: null },
    });
  },

  setHoverIndex(index) {
    if (get().hoverIndex === index) return;
    set({ hoverIndex: index });
  },

  setFilters(update) {
    const filters = { ...get().filters, ...update };
    applyFilters(filters, set, get);
  },

  toggleCellType(type) {
    const current = new Set(get().filters.cellTypes);
    if (current.has(type)) current.delete(type);
    else current.add(type);
    applyFilters({ ...get().filters, cellTypes: current }, set, get);
  },

  resetFilters() {
    applyFilters(defaultFilterState(), set, get);
  },

  async requestConnections(options) {
    const { adapter, selection } = get();
    if (!adapter?.getConnections || !selection.loreId) return;

    const next = { ...get().circuit, ...options };
    const token = ++circuitToken;
    set({ circuit: { ...next, loading: true, error: null } });

    try {
      const data = await adapter.getConnections(selection.loreId, {
        direction: next.direction,
        minSynapses: next.minSynapses,
        topN: next.topN,
      });
      if (token !== circuitToken) return;
      set({ circuit: { ...next, loading: false, error: null, data } });
      applyCircuitToRenderer(data, get());
    } catch (e) {
      if (token !== circuitToken) return;
      // A failed query must never be shown as "0 connections".
      set({ circuit: { ...next, loading: false, error: toDataError(e), data: null } });
    }
  },

  clearCircuit() {
    circuitToken++;
    rendererRef.current?.clearCircuit();
    rendererRef.current?.setGlobalDim(1);
    set({
      circuit: { ...get().circuit, data: null, error: null, loading: false, isolated: false },
    });
  },

  /**
   * Isolate mode: restrict the visible population to the selected cell and the
   * partners currently displayed. Implemented through the normal filter path
   * (a TypedArray mask), so it composes with the cell-type filters instead of
   * fighting them, and clearing it restores exactly the previous view.
   */
  setIsolated(isolated) {
    const { selection, circuit, loreIdLookup } = get();
    set({ circuit: { ...circuit, isolated } });

    if (!isolated) {
      applyFilters({ ...get().filters, restrictToIndices: null }, set, get);
      return;
    }

    const keep = new Set<number>();
    if (selection.index >= 0) keep.add(selection.index);
    if (circuit.data && loreIdLookup) {
      for (const partner of circuit.data.partners) {
        if (!partner.loreId) continue;
        const idx = loreIdLookup.get(Number(partner.loreId));
        if (idx !== undefined) keep.add(idx);
      }
    }
    applyFilters({ ...get().filters, restrictToIndices: keep }, set, get);
  },

  async requestSkeleton() {
    const { adapter, selection } = get();
    if (!adapter?.getSkeleton || !selection.loreId) return;
    const token = ++skeletonToken;
    set({ skeleton: { loading: true, error: null, data: null } });
    try {
      const data = await adapter.getSkeleton(selection.loreId);
      if (token !== skeletonToken) return;
      set({ skeleton: { loading: false, error: null, data } });
    } catch (e) {
      if (token !== skeletonToken) return;
      set({ skeleton: { loading: false, error: toDataError(e), data: null } });
    }
  },

  setDisplay(update) {
    const display = { ...get().display, ...update };
    set({ display });
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (update.colorMode) renderer.setColorMode(update.colorMode);
    if (update.contextMode) renderer.setContextMode(update.contextMode);
    if (update.showConnections !== undefined)
      renderer.setShowConnections(update.showConnections);
    if (update.showAxes !== undefined) renderer.setShowAxes(update.showAxes);
    if (update.continuousRendering !== undefined) {
      renderer.setContinuousRendering(update.continuousRendering);
    }
  },

  setStats(stats) {
    set({ stats });
  },
}));

type SetState = (partial: Partial<BrainState>) => void;
type GetState = () => BrainState;

function applyFilters(filters: FilterState, set: SetState, get: GetState): void {
  const index = get().index;
  set({ filters });
  if (!index) return;

  if (!maskScratch || maskScratch.length < index.count) {
    maskScratch = new Uint8Array(index.count);
  }
  const result = computeVisibilityMask(index, filters, maskScratch);
  rendererRef.current?.applyVisibilityMask(result.mask);
  set({ visibleCount: result.visibleCount, filterElapsedMs: result.elapsedMs });
}

/**
 * Translates a fetched ConnectionSet into renderer geometry.
 *
 * Partners whose lore ID is absent from the loaded index are skipped for
 * DRAWING only - they remain listed in the inspector, because "this partner
 * exists but is not in the loaded export" is information, not an error.
 */
function applyCircuitToRenderer(data: ConnectionSet, state: BrainState): void {
  const renderer = rendererRef.current;
  const lookup = state.loreIdLookup;
  if (!renderer || !lookup) return;

  const rootIndex = state.selection.index;
  if (rootIndex < 0) return;

  const edges: CircuitEdgeInput[] = [];
  const inputs: number[] = [];
  const outputs: number[] = [];

  for (const partner of data.partners) {
    if (!partner.loreId) continue;
    const partnerIndex = lookup.get(Number(partner.loreId));
    if (partnerIndex === undefined) continue;

    if (partner.direction === 'incoming') inputs.push(partnerIndex);
    else outputs.push(partnerIndex);

    edges.push({
      sourceIndex: partner.direction === 'incoming' ? partnerIndex : rootIndex,
      targetIndex: partner.direction === 'incoming' ? rootIndex : partnerIndex,
      direction: partner.direction,
      synapseCount: partner.synapseCount,
      depth: partner.depth,
    });
  }

  renderer.setCircuit(edges, Int32Array.from(inputs), Int32Array.from(outputs));
}

/**
 * Pushes all current state into a freshly-attached renderer.
 *
 * The renderer is created asynchronously (WebGPU adapter + device requests),
 * while dataset loading runs on its own timeline. Whichever finishes first must
 * not lose: if the index arrived before the GPU was ready, `setNeuronIndex` had
 * nothing to call and the population would never be uploaded. The viewport
 * calls this once the renderer exists to close that gap.
 *
 * Safe to call repeatedly; uploading the same buffers again is idempotent.
 */
export function syncRendererWithState(): void {
  const renderer = rendererRef.current;
  if (!renderer) return;

  const state = useBrainStore.getState();

  renderer.setColorMode(state.display.colorMode);
  renderer.setContextMode(state.display.contextMode);
  renderer.setShowConnections(state.display.showConnections);
  renderer.setShowAxes(state.display.showAxes);
  renderer.setContinuousRendering(state.display.continuousRendering);

  if (!state.index) return;

  renderer.setNeuronIndex(state.index);

  const result = computeVisibilityMask(state.index, state.filters, maskScratch ?? undefined);
  maskScratch = result.mask;
  renderer.applyVisibilityMask(result.mask);

  if (state.selection.index >= 0) renderer.setSelectedIndex(state.selection.index);
  if (state.circuit.data) applyCircuitToRenderer(state.circuit.data, state);
}

/** Partners that could not be located in the loaded population. */
export function unresolvedPartners(
  data: ConnectionSet | null,
  lookup: Map<number, number> | null,
): ConnectionPartner[] {
  if (!data || !lookup) return [];
  return data.partners.filter((p) => !p.loreId || !lookup.has(Number(p.loreId)));
}
