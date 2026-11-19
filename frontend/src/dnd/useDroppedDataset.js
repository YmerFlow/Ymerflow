import { useCallback, useContext, useMemo } from 'react';
import { ProcessContext } from '../ProcessContext';
import { useSearchDatasets } from '../datamodel/useQueries';
import { datasetMatchesMediatypes } from '../jsoneditor/mediatypeMatch';

// Shared helper for dataset drop targets: resolves a dropped item to the cached
// project-dataset dict (by its datasetId) and builds the canDrop media-type
// predicate. The underlying search query is the same one DatasetSelector /
// DatasetColumnCombobox use, so it is already fetched and shared.
//
// `matches` returns false on a cache miss — for a discrete drop action an unknown
// dataset is refused rather than silently accepted (stricter than the list
// filters, which keep unclassifiable datasets visible).
export function useDatasetLookup() {
  const { currentProject } = useContext(ProcessContext);
  const { data: all = [] } = useSearchDatasets('', true, currentProject);
  const byId = useMemo(() => new Map(all.map(d => [d.id, d])), [all]);
  const droppedDict = useCallback(item => byId.get(item.datasetId) || null, [byId]);
  const matches = useCallback(
    (item, spec) => {
      const d = droppedDict(item);
      return d ? datasetMatchesMediatypes(d, spec) : false;
    },
    [droppedDict],
  );
  return { droppedDict, matches };
}
