import type { RendererBackend } from './types';

/**
 * Selection.
 *
 * Picking is done on the GPU: the backend renders neuron indices into an
 * integer attachment and reads back a small neighbourhood around the cursor.
 * Cost is independent of population size - there is no CPU-side raycast against
 * 180,000 objects anywhere in this codebase.
 *
 * Hover is throttled and coalesced. Identifying the neuron under the cursor is
 * deliberately separated from fetching its metadata: the index resolves in
 * about a millisecond and drives the highlight immediately, while the detailed
 * record is fetched asynchronously by the application layer.
 */
export class PickingSystem {
  /** Minimum gap between hover picks, ms. */
  hoverIntervalMs = 45;
  /** Search radius in device pixels, so small soma stay clickable. */
  hoverRadiusPx = 4;
  clickRadiusPx = 7;

  private lastHoverAt = 0;
  private inFlight = false;
  private pendingHover: { x: number; y: number } | null = null;
  private lastHoverIndex = -1;

  constructor(private readonly getBackend: () => RendererBackend | null) {}

  /**
   * Requests a hover pick. Safe to call on every pointermove: calls are
   * throttled, and while a read-back is in flight only the newest position is
   * retained.
   */
  requestHover(xPx: number, yPx: number, onResult: (index: number) => void): void {
    this.pendingHover = { x: xPx, y: yPx };
    void this.drainHover(onResult);
  }

  private async drainHover(onResult: (index: number) => void): Promise<void> {
    if (this.inFlight) return;
    const now = performance.now();
    if (now - this.lastHoverAt < this.hoverIntervalMs) return;
    const pending = this.pendingHover;
    const backend = this.getBackend();
    if (!pending || !backend) return;

    this.pendingHover = null;
    this.inFlight = true;
    this.lastHoverAt = now;
    try {
      const index = await backend.pick(pending.x, pending.y, this.hoverRadiusPx);
      if (index !== this.lastHoverIndex) {
        this.lastHoverIndex = index;
        onResult(index);
      }
    } catch {
      // A failed read-back must never break the frame loop; the next pointer
      // move will try again.
    } finally {
      this.inFlight = false;
    }
  }

  /** A click pick. Not throttled, and uses a larger search radius. */
  async pickAt(xPx: number, yPx: number): Promise<number> {
    const backend = this.getBackend();
    if (!backend) return -1;
    try {
      return await backend.pick(xPx, yPx, this.clickRadiusPx);
    } catch {
      return -1;
    }
  }

  clearHover(): void {
    this.pendingHover = null;
    this.lastHoverIndex = -1;
  }

  currentHoverIndex(): number {
    return this.lastHoverIndex;
  }
}
