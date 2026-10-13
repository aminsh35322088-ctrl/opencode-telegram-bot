// Telegram's getUpdates contract is at-least-once: an update is owed to a
// client until that client acknowledges it by asking for a higher offset —
// writing a response to a socket is not an acknowledgement.
//
// This matters in practice. Run 38372649512 lost both updates of its W7
// restart: the Bot was SIGTERM'd while a long-poll was open, the driver
// enqueued `/start` and the Topic prompt into that window, and the stub served
// them to the already-dead process (`telegram-api.jsonl`:
// `10:41:20.853 note=update:1000004+1` to a process that had exited). Under
// consume-on-delivery they were dropped forever; the new Bot's first poll then
// saw an empty queue (`note=update:none`) and waited two 30 s timeouts before
// anything else woke it.
//
// serveBatch therefore never removes an entry on delivery — only the caller's
// offset does. A dead consumer changes nothing; a live consumer that acks gets
// exactly its own progress back with no duplicates.
//
//   entries - all unacked updates, in arrival order
//   offset  - the client's next-wanted update_id (NaN = "I have acked nothing")
//   limit   - getUpdates limit (0 = everything)
//
// Returns the batch to hand over and the queue that must survive that handover.
export function serveBatch(entries, offset, limit) {
  let acked = 0;
  if (Number.isFinite(offset)) {
    while (acked < entries.length && entries[acked].update_id < offset) acked += 1;
  }
  const queue = entries.slice(acked);
  const count = limit > 0 ? Math.min(limit, queue.length) : queue.length;
  return { batch: queue.slice(0, count), queue };
}
