import Link from 'next/link';
import { AppHeader } from '@/components/AppHeader';
import { PROVENANCE_INFO, PROVENANCE_ORDER } from '@/core/provenance';
import { DATA_ORIGIN_INFO } from '@/core/types';
import { fish1Metadata } from '@/datasets/fish1/server';
import {
  FISH1_CITATION,
  FISH1_RELEASE_URL,
  FISH1_TABLES,
  FISH1_VOXEL_SPACE,
} from '@/datasets/fish1/constants';

/**
 * Data and provenance.
 *
 * Server-rendered so it can report the LIVE Fish1 access status: whether a CAVE
 * token is configured, and which materialization version this deployment would
 * query. That is the fastest way for an operator to find out why Fish1 is or is
 * not working, without opening a console.
 */
export const dynamic = 'force-dynamic';

export default async function DataPage() {
  const fish1 = await fish1Metadata();

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <AppHeader />
      <main className="content">
        <h1>Data &amp; provenance</h1>
        <p>
          This application draws on third-party scientific datasets. It does not own them, and
          it does not redistribute them. Everything below states what each source actually
          contains, what this deployment can currently reach, and how a figure on screen should
          be read.
        </p>

        <h2>Provenance classes</h2>
        <p>
          Every quantity shown anywhere in the interface carries one of these labels. They are
          ordered from strongest to weakest claim.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Class</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            {PROVENANCE_ORDER.map((p) => (
              <tr key={p}>
                <td style={{ color: `var(${PROVENANCE_INFO[p].colorToken})` }}>
                  {PROVENANCE_INFO[p].label}
                </td>
                <td>{PROVENANCE_INFO[p].description}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2>Data origin badges</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Badge</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(DATA_ORIGIN_INFO).map(([key, info]) => (
              <tr key={key}>
                <td
                  style={{ color: info.isRealBiology ? 'var(--prov-measured)' : 'var(--warn)' }}
                >
                  {info.badge}
                </td>
                <td>{info.description}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2>Fish1 — status in this deployment</h2>
        <div className="dataset-card">
          <table className="table">
            <tbody>
              <tr>
                <td>Datastack</td>
                <td>{fish1.version.segmentationTable ?? 'unknown'}</td>
              </tr>
              <tr>
                <td>Materialization</td>
                <td>{fish1.version.label}</td>
              </tr>
              <tr>
                <td>Connectivity</td>
                <td>{fish1.capabilities.connectivity ? 'available' : 'unavailable'}</td>
              </tr>
              <tr>
                <td>Skeletons</td>
                <td>{fish1.capabilities.skeletons ? 'available' : 'unavailable'}</td>
              </tr>
              <tr>
                <td>Whole-brain index</td>
                <td>
                  {fish1.capabilities.neuronIndex
                    ? 'exported'
                    : 'not exported — run pipeline/fish1/export_neurons.py'}
                </td>
              </tr>
              <tr>
                <td>Voxel size</td>
                <td>{FISH1_VOXEL_SPACE.voxelSizeNm.join(' × ')} nm</td>
              </tr>
              <tr>
                <td>Axis orientation</td>
                <td>not documented by the release; no anatomical direction labels are shown</td>
              </tr>
            </tbody>
          </table>

          {fish1.unavailable ? (
            <div className="notice notice--warn" style={{ marginTop: 10 }}>
              <div className="notice__title">{fish1.unavailable.message}</div>
              {fish1.unavailable.remediation ? (
                <div>{fish1.unavailable.remediation}</div>
              ) : null}
            </div>
          ) : null}
        </div>

        <h2>Fish1 — what it contains</h2>
        <p>
          A correlated light and electron microscopy dataset from a 7&nbsp;dpf larval zebrafish,
          covering the brain and anterior spinal cord. It is <strong>structural only</strong>:
          it records anatomy and synaptic connectivity, and contains no neural activity, no
          behaviour, and nothing resembling an internal state.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Table</th>
              <th>Contents</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{FISH1_TABLES.somas}</td>
              <td>
                One row per segmented soma: stable lore ID, cell type (exc / inh / na), current
                root ID, supervoxel, voxel position.
              </td>
            </tr>
            <tr>
              <td>{FISH1_TABLES.synapsesAxDeLabel}</td>
              <td>
                Axon-to-dendrite synapses with pre/post root IDs, positions, and an
                excitatory/inhibitory tag.
              </td>
            </tr>
            <tr>
              <td>{FISH1_TABLES.synapseSize}</td>
              <td>
                Per-synapse bounding boxes, used to filter out small or spurious contacts.
              </td>
            </tr>
          </tbody>
        </table>
        <p>
          Molecular identity comes from genetic labelling: vglut2a+ for excitatory, gad1b+ for
          inhibitory. A cell typed <code>na</code> was simply not annotated — that is not a
          claim that it is neither.
        </p>
        <p>
          Licence: open access. Citation is required. <br />
          <span className="mono" style={{ fontSize: 11 }}>
            {FISH1_CITATION.text}
          </span>{' '}
          <a href={FISH1_CITATION.url} target="_blank" rel="noreferrer">
            paper
          </a>{' '}
          ·{' '}
          <a href={FISH1_RELEASE_URL} target="_blank" rel="noreferrer">
            release
          </a>
        </p>

        <h2>Identifiers</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Identifier</th>
              <th>Behaviour</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>lore ID</td>
              <td>
                Small stable integer naming a soma. Unchanged by proofreading. This is what the
                application persists and what appears in shareable URLs.
              </td>
            </tr>
            <tr>
              <td>root ID</td>
              <td>
                64-bit ID of the current segmentation of a neuron. Changes after merge or split
                edits, and is only meaningful together with a materialization version.
              </td>
            </tr>
            <tr>
              <td>supervoxel ID</td>
              <td>Leaf chunk of the segmentation graph.</td>
            </tr>
          </tbody>
        </table>

        <h2>Other datasets</h2>
        <div className="card-grid">
          <div className="dataset-card">
            <div className="label">ZAPBench</div>
            <p style={{ fontSize: 11.5 }}>
              Whole-brain calcium imaging of over 70,000 neurons under visual stimuli.
              Functional data, published as a forecasting benchmark. Not ingested in this build.
            </p>
            <p style={{ fontSize: 11.5, color: 'var(--warn)' }}>
              A different animal from Fish1. There is no cell-level correspondence between the
              two, and this application will not paint ZAPBench traces onto Fish1 soma.
            </p>
          </div>
          <div className="dataset-card">
            <div className="label">Fish Fire&amp;Wire</div>
            <p style={{ fontSize: 11.5 }}>
              Connectivity and activity from the same individual animal, aligned per cell. This
              is the dataset that would make a genuine stimulus-to-behaviour story possible.
            </p>
            <p style={{ fontSize: 11.5, color: 'var(--warn)' }}>
              Access is restricted. This application holds none of it, downloads none of it, and
              contains no endpoints for it. A typed adapter boundary exists and nothing more.
            </p>
          </div>
          <div className="dataset-card">
            <div className="label">Development sample</div>
            <p style={{ fontSize: 11.5 }}>
              A deterministic synthetic population with the same schema as a real export, shaped
              like a larval zebrafish brain so that rendering and culling behave realistically.
            </p>
            <p style={{ fontSize: 11.5, color: 'var(--warn)' }}>
              Contains no biological measurements. Always badged in the viewport.
            </p>
          </div>
        </div>

        <h2>What this application does not claim</h2>
        <p>
          No dataset here reports what a fish feels, wants, or is thinking about. Terms such as
          escape response or locomotor drive describe <em>circuit and behavioural states</em>,
          and when they eventually appear they will be labelled INFERRED, carry the evidence
          they were computed from, and never be presented as a measurement.
        </p>
        <p>
          Graph distance is not time. If a future view animates signal propagation by traversal
          depth, that is a depth counter, not milliseconds of conduction, and it will be
          labelled as such unless an explicit model produces the timing.
        </p>

        <p style={{ marginTop: 24 }}>
          <Link href="/brain">← Back to the brain</Link>
        </p>
      </main>
    </div>
  );
}
