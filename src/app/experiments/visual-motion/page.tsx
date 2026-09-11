import type { Metadata } from 'next';
import { ExperimentView } from '@/components/ExperimentView';

export const metadata: Metadata = {
  title: 'Visual motion decision · Connectome Lab',
  description:
    'A connectome-constrained simulation of the Fish1 hindbrain motion integrator driving a virtual larval zebrafish.',
};

export default function VisualMotionExperimentPage() {
  return <ExperimentView />;
}
