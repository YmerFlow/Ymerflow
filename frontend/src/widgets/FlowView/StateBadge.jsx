import React from 'react';

// Shared process/workload state badge — the single source of truth for the badge styling
// consumed by both ProcessNode (FlowView) and QueueCard (ClusterQueueView). 'starting' is the
// admitted-but-pod-coming-up state (bg-info cyan, visually between queued-yellow and
// running-blue). The 'waiting' alias is the legacy Kueue pending state, kept for back-compat;
// the cluster-queues endpoint now emits real ProcessState names (queued/starting/running).
const STATE_BADGES = {
  queued:   { cls: 'bg-warning', label: 'Queued' },
  waiting:  { cls: 'bg-warning', label: 'Waiting' },
  starting: { cls: 'bg-info', label: 'Starting' },
  running:  { cls: 'bg-primary', label: 'Running' },
  done:     { cls: 'bg-success', label: 'Done' },
};

export default function StateBadge({ state }) {
  const badge = STATE_BADGES[state];
  if (!badge) return null;
  return <span className={`badge ${badge.cls}`}>{badge.label}</span>;
}
