/** A preflight refusal: no input was written and the durable queue is intact.
 * Keep this distinct from a failed write, whose delivery may be uncertain. */
export class LiveInputUnavailable extends Error {
  constructor() {
    super("Queued for the next turn. Live steering is unavailable for this session; work continues.");
    this.name = "LiveInputUnavailable";
  }
}
