/**
 * Measures what the passenger could actually see: time counts only while the media is running AND the page is visible,
 * and muted time is tracked separately (muted video is never a qualified view under VALIDATION_POLICY_V1).
 */
export class Exposure {
  readonly startedAt = new Date();
  private visible = 0;
  private muted = 0;
  private last = performance.now();
  private running = false;
  constructor(private readonly media: HTMLMediaElement | null) {}
  private tick() {
    const now = performance.now();
    if (this.running && document.visibilityState === 'visible') {
      const d = now - this.last;
      this.visible += d;
      if (this.media && (this.media.muted || this.media.volume === 0)) this.muted += d;
    }
    this.last = now;
  }
  set(running: boolean) { this.tick(); this.running = running; }
  finish() {
    this.tick();
    this.running = false;
    const visibleMs = Math.round(this.visible);
    return { startedAt: this.startedAt.toISOString(), endedAt: new Date().toISOString(), visibleMs, mutedMs: Math.min(visibleMs, Math.round(this.muted)) };
  }
}
