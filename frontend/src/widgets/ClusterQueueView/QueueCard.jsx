import React from 'react';
import StateBadge from '../FlowView/StateBadge';
import TagBadge from '../FlowView/TagBadge';

// Parse a k8s CPU quantity string ("1000m", "2") to cores.
function parseCpuCores(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (s.endsWith('m')) return parseInt(s.slice(0, -1), 10) / 1000;
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

// Parse a k8s memory quantity string ("2Gi", "512Mi", "1G") to GiB (Gi≈GB for display).
function parseMemoryGb(value) {
  if (value == null) return null;
  const s = String(value).trim();
  const units = [
    ['Gi', 1], ['G', 1],
    ['Mi', 1 / 1024], ['M', 1 / 1000],
    ['Ki', 1 / (1024 * 1024)],
  ];
  for (const [suffix, factor] of units) {
    if (s.endsWith(suffix)) {
      const n = parseFloat(s.slice(0, -suffix.length));
      return Number.isNaN(n) ? null : n * factor;
    }
  }
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n / (1024 ** 3);
}

// Format deadline_seconds as a human "max run length".
function formatDuration(seconds) {
  if (seconds == null) return null;
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = seconds / 3600;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

export default function QueueCard({ entry }) {
  const cpu = parseCpuCores(entry.resource_requests?.cpu);
  const mem = parseMemoryGb(entry.resource_requests?.memory);
  const maxRun = formatDuration(entry.deadline_seconds);

  const resourceBits = [];
  if (cpu != null) resourceBits.push(`${cpu} CPU`);
  if (mem != null) resourceBits.push(`${mem.toFixed(mem < 10 ? 1 : 0)} GB`);
  if (maxRun != null) resourceBits.push(`≤ ${maxRun}`);

  return (
    <div
      className="card"
      style={{
        minWidth: 150,
        position: 'relative',
        padding: '5px',
        marginBottom: '8px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
        <span className="badge bg-secondary">#{entry.position + 1}</span>
        <StateBadge state={entry.state} />
      </div>

      {entry.member ? (
        <>
          <strong>
            {entry.process_name}
            &nbsp;
            <span className="text-muted">v{entry.version}</span>
          </strong>
          <div className="text-muted small">{entry.project_name}</div>
          <div className="text-muted small">{entry.process_type}</div>
        </>
      ) : (
        <strong className="text-muted">Process</strong>
      )}

      {resourceBits.length > 0 && (
        <div className="text-muted small" style={{ marginTop: '4px' }}>
          {resourceBits.join(' · ')}
        </div>
      )}

      {entry.member && entry.tags?.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px', marginTop: '5px' }}>
          {entry.tags.map(tag => <TagBadge key={tag.id} tag={tag} />)}
        </div>
      )}
    </div>
  );
}
