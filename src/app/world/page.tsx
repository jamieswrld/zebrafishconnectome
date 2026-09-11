import { WorldView } from '@/components/WorldView';

// The world runs a live simulation; there is nothing useful to prerender.
export const dynamic = 'force-dynamic';

export default function WorldPage() {
  return <WorldView />;
}
