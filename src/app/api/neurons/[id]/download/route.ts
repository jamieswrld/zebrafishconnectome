import { asLoreId, isLoreId } from '@/core/ids';
import { FISH1_CITATION, FISH1_DATASET_ID } from '@/datasets/fish1/constants';
import {
  fish1GetConnections,
  fish1GetNeuron,
  fish1GetSkeletonSwcText,
} from '@/datasets/fish1/server';
import { TRAVERSAL_LIMITS } from '@/core/types';
import { badRequest, errorResponse } from '../../../http';

/**
 * Downloads for a selected neuron.
 *
 * Only formats the source can actually produce are offered:
 *   metadata  JSON as returned by the dataset
 *   csv       one row per partner, aggregated synapse counts
 *   swc       the upstream skeleton, passed through unmodified
 *
 * Every artefact carries the dataset, the materialization version and the
 * required citation in its header, so a file that leaves this application
 * remains attributable.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const params = new URL(request.url).searchParams;
    const format = params.get('format') ?? 'metadata';
    const dataset = params.get('dataset') ?? FISH1_DATASET_ID;

    if (!isLoreId(id)) return badRequest(`"${id}" is not a valid lore ID.`);
    if (dataset !== FISH1_DATASET_ID) {
      return badRequest(`Dataset "${dataset}" has no download service.`);
    }
    const loreId = asLoreId(id);

    if (format === 'metadata') {
      const neuron = await fish1GetNeuron(loreId, { checkLatestRoot: true });
      const body = JSON.stringify(
        {
          source: 'Fish1',
          citation: FISH1_CITATION.text,
          exportedAt: new Date().toISOString(),
          neuron,
        },
        null,
        2,
      );
      return fileResponse(body, 'application/json', `fish1_neuron_${loreId}.json`);
    }

    if (format === 'connectivity') {
      const connections = await fish1GetConnections(loreId, {
        direction: 'both',
        minSynapses: 1,
        topN: TRAVERSAL_LIMITS.maxPartnersPerHop,
        resolvePartnerIdentities: true,
      });
      const lines: string[] = [
        `# Fish1 connectivity for lore ID ${loreId}`,
        `# root_id=${connections.rootId ?? 'unknown'} materialization=${connections.version.materializationVersion}`,
        `# ${FISH1_CITATION.text}`,
        connections.truncated ? `# TRUNCATED: ${connections.truncationReason}` : '# complete',
        'direction,partner_lore_id,partner_root_id,synapse_count,excitatory_synapses,inhibitory_synapses,partner_cell_type',
      ];
      for (const p of connections.partners) {
        lines.push(
          [
            p.direction,
            p.loreId ?? '',
            p.rootId ?? '',
            p.synapseCount,
            p.synapsesByPolarity?.excitatory ?? '',
            p.synapsesByPolarity?.inhibitory ?? '',
            p.partnerCellType,
          ].join(','),
        );
      }
      return fileResponse(lines.join('\n'), 'text/csv', `fish1_connectivity_${loreId}.csv`);
    }

    if (format === 'swc') {
      const { swc, rootId } = await fish1GetSkeletonSwcText(loreId);
      // Passed through byte-for-byte apart from a provenance header, so the
      // file matches what the upstream service produced.
      const header = [
        `# Fish1 skeleton, lore ID ${loreId}, root ID ${rootId}`,
        `# ${FISH1_CITATION.text}`,
        `# Retrieved ${new Date().toISOString()}`,
      ].join('\n');
      return fileResponse(`${header}\n${swc}`, 'text/plain', `fish1_skeleton_${loreId}.swc`);
    }

    return badRequest(
      `Unknown download format "${format}".`,
      'Supported formats: metadata, connectivity, swc.',
    );
  } catch (e) {
    return errorResponse(e);
  }
}

function fileResponse(body: string, contentType: string, filename: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': `${contentType}; charset=utf-8`,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, max-age=60',
    },
  });
}
