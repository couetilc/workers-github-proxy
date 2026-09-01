export function classifyReplay({ before, desired, observed, available = true }) {
  if (!available) return "verification_required";
  if (observed === desired) return "synced";
  if (observed === before) return "pending_sync";
  return "needs_review";
}
