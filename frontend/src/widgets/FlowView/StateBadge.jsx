import React from 'react';

// Shared process/workload state badge — the single source of truth for the badge styling
// consumed by both ProcessNode (FlowView) and QueueCard (ClusterQueueView). The 'waiting'
// alias is Kueue's pending state, shown identically to 'queued'.
const STATE_BADGES = {
  queued:  { cls: 'bg-warning', label: 'Queued' },
  waiting: { cls: 'bg-warning', label: 'Waiting' },
  running: { cls: 'bg-primary', label: 'Running' },
  done:    { cls: 'bg-success', label: 'Done' },
};

export default function StateBadge({ state }) {
  const badge = STATE_BADGES[state];
  if (!badge) return null;
  return <span className={`badge ${badge.cls}`}>{badge.label}</span>;
}
