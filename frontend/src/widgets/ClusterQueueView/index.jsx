import React from 'react';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useClusterQueues } from '../../datamodel/useQueries';
import QueueCard from './QueueCard';

// Cluster Queue widget — live per-cluster Kueue queue view. One cluster at a time, selected
// via a nav-tabs bar; the active cluster is persisted on this widget's own layout node
// (Decision 7) so it survives reload / workspace save. Manual reload only (Decision 6).
export default function ClusterQueueView({ parentUpdate, id, activeClusterId, ...nodeProps }) {
  const isMobile = useIsMobile();
  const { data: clusters = [], isLoading, isError, error, isFetching, refetch } = useClusterQueues();

  // Resolve the active cluster: saved id if still accessible, else the first cluster.
  const active =
    clusters.find(c => c.id === activeClusterId) || clusters[0] || null;

  const selectCluster = (clusterId) => {
    parentUpdate?.('replace', id, { ...nodeProps, id, activeClusterId: clusterId });
  };

  return (
    <div style={isMobile ? { padding: '10px' } : { padding: '10px', height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <i className="fas fa-sync" style={{ marginRight: '4px' }} />
          {isFetching ? 'Reloading…' : 'Reload'}
        </button>
      </div>

      {isLoading && <div className="text-muted">Loading…</div>}
      {isError && <div className="text-danger">Failed to load: {String(error?.message || error)}</div>}

      {!isLoading && !isError && clusters.length === 0 && (
        <div className="text-muted">No clusters available.</div>
      )}

      {clusters.length > 0 && (
        <>
          <ul className="nav nav-tabs" style={{ marginBottom: '10px' }}>
            {clusters.map(cluster => (
              <li className="nav-item" key={cluster.id}>
                <button
                  type="button"
                  className={`nav-link ${active?.id === cluster.id ? 'active' : ''}`}
                  onClick={() => selectCluster(cluster.id)}
                >
                  {cluster.name}
                </button>
              </li>
            ))}
          </ul>

          {active && (
            <div>
              {active.limits && (
                <div className="text-muted small" style={{ marginBottom: '8px' }}>
                  Capacity: {active.limits.max_cpu_cores} CPU · {active.limits.max_memory_gb} GB
                </div>
              )}

              {active.queue_error ? (
                <div className="text-danger small">Queue unavailable: {active.queue_error}</div>
              ) : active.queue.length === 0 ? (
                <div className="text-muted">No jobs queued</div>
              ) : (
                active.queue.map(entry => (
                  <QueueCard key={entry.position} entry={entry} />
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

ClusterQueueView.title = 'Cluster Queue';
