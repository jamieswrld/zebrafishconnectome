import { Suspense } from 'react';
import { BrainExplorer } from '@/components/BrainExplorer';

// The explorer reads the URL for dataset, selection and camera, so it must be
// client-rendered; a static shell would have nothing useful to prerender.
export const dynamic = 'force-dynamic';

export default function BrainPage() {
  return (
    <Suspense
      fallback={
        <div className="boot">
          <div className="hud__sub mono">LOADING SHELL</div>
        </div>
      }
    >
      <BrainExplorer />
    </Suspense>
  );
}
