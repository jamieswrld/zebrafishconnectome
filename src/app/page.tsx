import Link from 'next/link';
import { FISH1_PUBLISHED_COUNTS } from '@/datasets/fish1/constants';

/**
 * Entry.
 *
 * Restrained on purpose: a few real numbers and a way in. No animation to sit
 * through, no marketing scroll. The product is the brain, and this page exists
 * only to state what the thing is before handing over to it.
 */
export default function HomePage() {
  return (
    <main className="intro">
      <div>
        <h1 className="intro__title">
          A vertebrate brain
          <br />
          in your browser
        </h1>
      </div>

      <div className="intro__facts">
        <Fact label="Dataset" value="Fish1" sub="larval zebrafish" />
        <Fact
          label="Segmented soma"
          value={`${(FISH1_PUBLISHED_COUNTS.somaCount / 1000).toFixed(0)}k+`}
          sub="published"
        />
        <Fact
          label="Synapses"
          value={`~${FISH1_PUBLISHED_COUNTS.synapseCount / 1_000_000}M`}
          sub="published"
        />
        <Fact
          label="Annotated"
          value={`${(FISH1_PUBLISHED_COUNTS.annotatedNeuronCount / 1000).toFixed(0)}k+`}
          sub="molecular identity"
        />
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
        <Link className="btn btn--active" href="/brain" style={{ borderBottom: undefined }}>
          Enter brain
        </Link>
        <Link className="btn" href="/brain?dataset=benchmark-200000&debug=1">
          200k benchmark
        </Link>
        <Link className="btn" href="/data">
          Data &amp; provenance
        </Link>
      </div>

      <p
        className="faint"
        style={{ fontSize: 11, maxWidth: '58ch', margin: 0, lineHeight: 1.6 }}
      >
        Counts above are those published for the Fish1 resource. Whether this deployment is
        showing Fish1 data or a clearly-labelled synthetic stand-in is stated in the viewport
        itself, on every view.
      </p>
    </main>
  );
}

function Fact({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="intro__fact">
      <div className="label">{label}</div>
      <div className="value-lg">{value}</div>
      <div className="faint" style={{ fontSize: 10 }}>
        {sub}
      </div>
    </div>
  );
}
