'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { asLoreId, isLoreId } from '@/core/ids';
import { DEFAULT_DATASET_ID } from '@/datasets/registry';
import { useBrainStore } from '@/state/brainStore';
import { useOrganismStore } from '@/state/organismStore';
import { rendererRef } from '@/state/rendererRef';
import { OrbitCamera } from '@/renderer/camera';
import { BrainViewport } from './BrainViewport';
import { FilterPanel } from './FilterPanel';
import { AnatomyPanel } from './AnatomyPanel';
import { NeuronInspector } from './NeuronInspector';
import { CommandSearch } from './CommandSearch';
import { AppHeader } from './AppHeader';
import { StatusBar } from './StatusBar';

/**
 * The brain explorer.
 *
 * Owns URL <-> state synchronisation so a discovery is shareable:
 *
 *   /brain?dataset=fish1&neuron=173502&cam=...
 *
 * Only small, meaningful state goes in the URL - dataset, selected neuron,
 * camera, and the debug flag. Filters and circuit results stay out of it,
 * because encoding them would produce an unreadable link for no real gain.
 */
export function BrainExplorer() {
  const router = useRouter();
  const params = useSearchParams();

  const [searchOpen, setSearchOpen] = useState(false);
  const restoredCamera = useRef(false);
  /**
   * Whether we have yet attempted to restore ?neuron= from the URL.
   *
   * Until we have, the selection -> URL effect must not run: on first paint the
   * selection is empty while the URL names a neuron, so it would strip the
   * parameter before restoration could read it, silently breaking every shared
   * link.
   */
  const restoredSelection = useRef(false);

  const datasetId = useBrainStore((s) => s.datasetId);
  const display = useBrainStore((s) => s.display);
  const selection = useBrainStore((s) => s.selection);
  const loadStage = useBrainStore((s) => s.load.stage);
  const lookup = useBrainStore((s) => s.loreIdLookup);

  const loadDataset = useBrainStore((s) => s.loadDataset);
  const selectIndex = useBrainStore((s) => s.selectIndex);
  const setDisplay = useBrainStore((s) => s.setDisplay);
  const clearSelection = useBrainStore((s) => s.clearSelection);

  const urlDataset = params.get('dataset') ?? DEFAULT_DATASET_ID;
  const urlNeuron = params.get('neuron');
  const urlCamera = params.get('cam');
  const debug = params.get('debug') === '1';
  /**
   * BRAIN and ORGANISM are modes of ONE route, not separate pages. Changing
   * only the search param keeps this component (and therefore the renderer and
   * its uploaded neuron buffers) mounted, so moving between scales is a camera
   * move rather than a reload. That continuity is the point: the connectome was
   * inside an animal the whole time.
   */
  const view = params.get('view') === 'organism' ? 'organism' : 'brain';
  // Benchmark mode: draw every animation frame instead of skipping idle ones,
  // so sustained render throughput can be measured rather than the browser's
  // tick rate. Off by default; a still camera should cost nothing.
  const continuous = params.get('bench') === '1';

  // Load whenever the URL names a different dataset.
  useEffect(() => {
    if (datasetId === urlDataset) return;
    restoredCamera.current = false;
    void loadDataset(urlDataset);
  }, [urlDataset, datasetId, loadDataset]);

  useEffect(() => {
    setDisplay({ debugOpen: debug });
  }, [debug, setDisplay]);

  useEffect(() => {
    // Goes through the store so it survives the renderer being created after
    // the dataset has already loaded.
    setDisplay({ continuousRendering: continuous });
  }, [continuous, setDisplay]);

  const loadBody = useOrganismStore((s) => s.loadBody);
  const bodyLoaded = useOrganismStore((s) => s.loaded);
  const setDisplayMode = useOrganismStore((s) => s.setDisplayMode);
  const frameWholeFish = useOrganismStore((s) => s.frameWholeFish);
  const frameBrain = useOrganismStore((s) => s.frameBrain);

  // The body asset is fetched lazily: entering /brain never downloads it.
  useEffect(() => {
    if (view !== 'organism' || loadStage !== 'ready') return;
    void loadBody();
  }, [view, loadStage, loadBody]);

  // Entering organism mode reveals the body and pulls the camera out; leaving
  // hides it and dives back to the connectome framing.
  const previousView = useRef(view);
  useEffect(() => {
    if (previousView.current === view) return;
    previousView.current = view;
    if (view === 'organism') {
      if (bodyLoaded) {
        setDisplayMode('tissue');
        frameWholeFish();
      }
    } else {
      setDisplayMode('off');
      frameBrain();
    }
  }, [view, bodyLoaded, setDisplayMode, frameWholeFish, frameBrain]);

  // If the body finishes loading after the mode switch, apply it then.
  useEffect(() => {
    if (view === 'organism' && bodyLoaded) {
      setDisplayMode('tissue');
      frameWholeFish();
    }
  }, [view, bodyLoaded, setDisplayMode, frameWholeFish]);

  // Restore a deep link once the population is present, so the lore ID can be
  // resolved to an index.
  useEffect(() => {
    if (loadStage !== 'ready' || !lookup) return;

    if (urlCamera && !restoredCamera.current) {
      const state = OrbitCamera.deserialize(urlCamera);
      if (state) rendererRef.current?.restoreCamera(state);
      restoredCamera.current = true;
    }

    if (urlNeuron && isLoreId(urlNeuron) && selection.loreId !== urlNeuron) {
      const index = lookup.get(Number(asLoreId(urlNeuron)));
      if (index !== undefined) selectIndex(index);
    }
    // Attempted, whether or not the neuron was present in this export.
    restoredSelection.current = true;
  }, [loadStage, lookup, urlNeuron, urlCamera, selection.loreId, selectIndex]);

  // Push the selection into the URL without adding history entries per click.
  useEffect(() => {
    if (!restoredSelection.current) return;
    const next = new URLSearchParams(params.toString());
    if (selection.loreId) next.set('neuron', selection.loreId);
    else next.delete('neuron');
    if (next.toString() !== params.toString()) {
      router.replace(`/brain?${next.toString()}`, { scroll: false });
    }
  }, [selection.loreId, params, router]);

  const setDataset = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params.toString());
      next.set('dataset', id);
      next.delete('neuron');
      router.replace(`/brain?${next.toString()}`, { scroll: false });
    },
    [params, router],
  );

  const copyLink = useCallback(() => {
    const next = new URLSearchParams(params.toString());
    const camera = rendererRef.current?.camera.serialize();
    if (camera) next.set('cam', camera);
    const url = `${window.location.origin}/brain?${next.toString()}`;
    void navigator.clipboard?.writeText(url);
  }, [params]);

  // Keyboard shortcuts. Ignored while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (typing) return;

      if (e.key === '/') {
        e.preventDefault();
        setSearchOpen(true);
      } else if (e.key === 'Escape') {
        if (searchOpen) setSearchOpen(false);
        else clearSelection();
      } else if (e.key === 'r' || e.key === 'R') {
        rendererRef.current?.resetCamera();
      } else if (e.key === 'f' || e.key === 'F') {
        if (selection.index >= 0) rendererRef.current?.focusIndex(selection.index);
      } else if (e.key === '[') {
        setDisplay({ leftPanelOpen: !display.leftPanelOpen });
      } else if (e.key === ']') {
        setDisplay({ rightPanelOpen: !display.rightPanelOpen });
      } else if (e.key === '\\') {
        // Distraction-free: hide both panels.
        const hide = display.leftPanelOpen || display.rightPanelOpen;
        setDisplay({ leftPanelOpen: !hide, rightPanelOpen: !hide });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [searchOpen, display, selection.index, setDisplay, clearSelection]);

  return (
    <div className="shell">
      <AppHeader
        view={view}
        onSearch={() => setSearchOpen(true)}
        onCopyLink={copyLink}
        onToggleLeft={() => setDisplay({ leftPanelOpen: !display.leftPanelOpen })}
        onToggleRight={() => setDisplay({ rightPanelOpen: !display.rightPanelOpen })}
      />

      <div className="workspace">
        {display.leftPanelOpen ? (
          view === 'organism' ? (
            <AnatomyPanel />
          ) : (
            <FilterPanel onDatasetChange={setDataset} />
          )
        ) : (
          <div />
        )}
        <BrainViewport debug={display.debugOpen} />
        {display.rightPanelOpen ? <NeuronInspector /> : <div />}
      </div>

      <StatusBar />

      <CommandSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
