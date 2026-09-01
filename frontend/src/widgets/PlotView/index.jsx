import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Plot, DataGroup } from 'gladly-plot';
import { ProcessContext } from '../../ProcessContext';
import { PlotGroupContext } from '../../PlotGroupContext';
import { registerQuantityKinds } from './quantityKinds';
import { loadDataset } from '../../datamodel/dataset';
import { encodeSeg } from '../../datamodel/datasetPath';
import { getKeys, resolveDataPath } from './colorUtils.js';
import { useIsMobile } from '../../hooks/useIsMobile';
import './elements/index.js';

// Register quantity kinds once at module load
registerQuantityKinds();

const PLOT_MARGIN = { top: 50, right: 80, bottom: 60, left: 80 };

export default function PlotView({ layoutConfig, parentUpdate, id, widget, ...rest }) {
  const isMobile = useIsMobile();
  const { fetchedData, datasetsLoading, dataLoading, currentSounding, setCurrentSounding, datasetCollection, processes,
    inMemoryDiffs, applyInMemoryEdit, inUseAction, currentProject } = useContext(ProcessContext);

  // Map of "procName.version.dsName" → raw data object for non-current process datasets
  const [lazilyLoadedData, setLazilyLoadedData] = useState(new Map());
  const { addPlot, removePlot } = useContext(PlotGroupContext);

  const containerRef          = useRef(null);
  const plotRef               = useRef(null);
  const statusCoordsRef       = useRef(null);   // left: live mouse coordinates
  const statusPickRef         = useRef(null);   // right: last clicked point
  const configRef             = useRef(null);   // tracks latest sanitized config for pick resolution
  const fetchedDataRef        = useRef(fetchedData);
  const setCurrentSoundingRef = useRef(setCurrentSounding);
  const inUseActionRef        = useRef(inUseAction);
  const applyInMemoryEditRef  = useRef(applyInMemoryEdit);
  const lastSavedRef          = useRef(null);      // JSON of last config we sent via parentUpdate
  const lastPropConfigRef     = useRef(null);      // JSON of last prop config passed to plot.update()
  const parentUpdateRef       = useRef(parentUpdate);
  useEffect(() => { parentUpdateRef.current = parentUpdate; }, [parentUpdate]);
  useEffect(() => { fetchedDataRef.current = fetchedData; }, [fetchedData]);
  useEffect(() => { setCurrentSoundingRef.current = setCurrentSounding; }, [setCurrentSounding]);
  useEffect(() => { inUseActionRef.current = inUseAction; }, [inUseAction]);
  useEffect(() => { applyInMemoryEditRef.current = applyInMemoryEdit; }, [applyInMemoryEdit]);

  const config = useMemo(
    () => layoutConfig || PlotView.get_default().layoutConfig,
    [layoutConfig],
  );

  // Scan layer parameters for non-current dataset paths and lazily load their data.
  useEffect(() => {
    if (!config?.layers || !processes?.length) return;

    const pathsToLoad = new Set();
    for (const layer of config.layers) {
      if (!layer || typeof layer !== 'object') continue;
      for (const params of Object.values(layer)) {
        if (!params || typeof params !== 'object') continue;
        for (const val of Object.values(params)) {
          if (typeof val !== 'string') continue;
          const parts = val.split('.');
          if (parts.length >= 3 && parts[0] !== 'current') {
            pathsToLoad.add(parts.slice(0, 3).join('.'));
          }
        }
      }
    }

    for (const dsPath of pathsToLoad) {
      if (lazilyLoadedData.has(dsPath)) continue;
      // dsPath segments are encoded — match back to real objects in encoded space.
      const [procNameSeg, verStr, dsNameSeg] = dsPath.split('.');
      const proc = processes.find(p => encodeSeg(p.name) === procNameSeg);
      const ver = (proc?.versions || []).find(v => String(v.version) === verStr);
      const dsKey = Object.keys(ver?.outputs || {}).find(k => encodeSeg(k) === dsNameSeg);
      const dsUrl = dsKey != null ? ver.outputs[dsKey] : undefined;
      if (!dsUrl) continue;

      const dsId = dsUrl.split('/').pop();
      loadDataset(dsId, currentProject)
        .then(dsObj => dsObj.fetchData('all').then(rawData => ({ dsObj, rawData })))
        .then(({ dsObj, rawData }) => {
          setLazilyLoadedData(prev => new Map(prev).set(dsPath, { dsObj, rawData }));
        })
        .catch(err => console.warn(`Failed to lazily load ${dsPath}:`, err));
    }
  }, [config, processes, currentProject]); // eslint-disable-line react-hooks/exhaustive-deps

  // Create / destroy the Plot instance and register gladly event handlers.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const plot = new Plot(container, { margin: PLOT_MARGIN });
    plotRef.current = plot;
    addPlot(id, plot);

    // Show data-space coordinates on the left of the status bar on mousemove.
    const moveHandle = plot.on('mousemove', (e, coords) => {
      const bar = statusCoordsRef.current;
      if (!bar) return;
      // Show only quantity-kind keys (skip axis-name duplicates like xaxis_bottom).
      const parts = Object.entries(coords)
        .filter(([k]) => !k.startsWith('xaxis_') && !k.startsWith('yaxis_'))
        .map(([k, v]) => `${k}: ${Number(v).toPrecision(5)}`);
      bar.textContent = parts.join('   ');
    });

    // On click: GPU-pick the nearest point, update status bar, and set current sounding.
    const clickHandle = plot.on('click', async (e, coords) => {
      const p = plotRef.current;
      if (!p) return;

      const rect = container.getBoundingClientRect();
      let result;
      try {
        result = await p.pick(e.clientX - rect.left, e.clientY - rect.top);
      } catch (err) {
        console.warn('plot.pick() failed:', err);
        return;
      }

      // Update right side of status bar with the picked point's raw attributes.
      const pickBar = statusPickRef.current;
      if (pickBar) {
        if (result) {
          const { configLayerIndex, tile, index, layer } = result;
          const isInstanced = layer.instanceCount !== null;
          const row = Object.fromEntries(
            Object.entries(layer.attributes)
              .filter(([k]) => !isInstanced || (layer.attributeDivisors[k] ?? 0) === 1)
              .map(([k, v]) => [k, Number(Array.isArray(v) ? v[tile]?.[index] : v[index]).toPrecision(5)])
          );
          pickBar.textContent =
            `layer ${configLayerIndex}  tile ${tile}  pt ${index}  ` +
            Object.entries(row).map(([k, v]) => `${k}=${v}`).join('  ');
        } else {
          pickBar.textContent = '';
        }
      }

      // --- Sounding selection ---
      // On xdist-axis plots (ChannelPlot, ResistivityCurtain, etc.) always select by
      // nearest xdist, regardless of what pick() returned. Using the pick vertex index
      // is unreliable here because:
      //   - Instanced layers (ResistivityCurtain) are not GPU-pickable → pick() returns null
      //   - Overlay line layers (sounding marker, topo line) are pickable but their vertex
      //     indices don't map to a meaningful sounding, causing every-other-click toggling
      // For non-xdist plots (FlightlinePlot on lat/lon) fall back to the pick index.
      if (coords?.xdist_m !== undefined) {
        const rawData = plotRef.current?._rawData;
        const layers  = configRef.current?.layers ?? [];
        let bestSounding = null, bestDist = Infinity;
        for (const spec of layers) {
          if (!spec || typeof spec !== 'object') continue;
          const params = Object.values(spec)[0];
          if (!params?.dataset) continue;
          const ds    = resolveDataPath(rawData, params.dataset);
          const xdist = ds?.flightlines?.xdist;
          if (!xdist?.length) continue;
          for (let i = 0; i < xdist.length; i++) {
            const d = Math.abs(Number(xdist[i]) - coords.xdist_m);
            if (d < bestDist) { bestDist = d; bestSounding = i; }
          }
          break; // first dataset with xdist is sufficient
        }
        if (bestSounding !== null) setCurrentSoundingRef.current(bestSounding);
      } else if (result) {
        // Non-xdist plot (e.g. FlightlinePlot on lat/lon): use pick vertex index.
        // For point layers index is the sounding directly; floor(index/2) == index.
        setCurrentSoundingRef.current(Math.floor(result.index / 2));
      }
    });

    console.log('[InUse] plot.selections:', plot.selections, 'inuse_brush:', plot.selections['inuse_brush']);
    const selHandle = plot.selections['inuse_brush'].subscribe(sel => {
      console.log('[InUse] selection callback fired', sel);
      const arrays = sel.arrays;
      if (!arrays) { console.log('[InUse] sel.arrays is null/undefined, returning'); return; }
      console.log('[InUse] arrays size:', arrays.size ?? arrays.length, 'arrays:', arrays);

      const layers  = configRef.current?.layers ?? [];
      const rawData = plotRef.current?._rawData;
      const action  = inUseActionRef.current;
      const apply   = applyInMemoryEditRef.current;
      const value   = action === 'enable' ? 1 : action === 'disable' ? 0 : null;
      console.log('[InUse] action:', action, 'value:', value, 'layers:', layers);

      for (const spec of layers) {
        if (!spec?.ChannelPlot?.inUseMode) {
          console.log('[InUse] skipping layer (no inUseMode):', spec);
          continue;
        }
        const params  = spec.ChannelPlot;
        const dsName  = params.dataset;
        const channel = params.channel || 'Ch01';
        console.log('[InUse] processing layer dsName:', dsName, 'channel:', channel);

        const ds = resolveDataPath(rawData, dsName);
        if (!ds?.layer_data) { console.log('[InUse] no layer_data for ds:', dsName, 'ds:', ds, 'rawData:', rawData); continue; }
        const yDataDict = ds.layer_data[`Gate_${channel}`];
        if (!yDataDict) { console.log('[InUse] no yDataDict for key Gate_' + channel, 'layer_data keys:', Object.keys(ds.layer_data)); continue; }
        const gateKeys = getKeys(yDataDict).sort((a, b) => a - b);
        console.log('[InUse] gateKeys:', gateKeys, 'arrays size:', arrays.size ?? arrays.length);

        // arrays[t] is the selection mask for tile t (= gate t), local indices only.
        // Vertices 2*i and 2*i+1 in a tile correspond to soundings i and i+1.
        // apply_idx maps part-local sounding index → global index in the full dataset
        // (set by libaarhusxyz split_by_line(); absent for the 'all' part where local = global).
        const applyIdx = ds.flightlines?.apply_idx;
        const entries = [];
        arrays.forEach((tileArr, t) => {
          const seen = new Set();
          for (let vi = 0; vi < tileArr.length; vi++) {
            if (tileArr[vi] > 0.5) {
              const si = vi % 2 === 0 ? vi / 2 : (vi + 1) / 2;
              if (!seen.has(si)) {
                seen.add(si);
                entries.push({ soundingIndex: applyIdx ? applyIdx[si] : si, gateIndex: gateKeys[t] });
              }
            }
          }
        });
        console.log('[InUse] entries to apply:', entries.length, entries.slice(0, 5));
        if (entries.length > 0) apply(dsName, channel, entries, value);
        else console.log('[InUse] no entries selected, skipping apply');
      }
      sel.clear();
    });

    return () => {
      selHandle.remove();
      moveHandle.remove();
      clickHandle.remove();
      removePlot(id);
      plot.destroy();
      plotRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Update plot whenever config, data or sounding changes.
  // _currentSounding is merged into the data object so LayerTypes that need it
  // (SoundingMarker, SoundingPlot, ResistivityCurtainLines) can read it from
  // data._currentSounding in their createLayer function.
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot || datasetsLoading || dataLoading) return;

    // rjsf's anyOf merging can leave multiple layer-type keys in one layer spec;
    // gladly iterates all keys so we keep only the first non-null one per spec.
    const sanitizedConfig = {
      ...config,
      interactions: { ...config.interactions, lasso: true },
      layers: (config.layers || []).map(spec => {
        if (!spec || typeof spec !== 'object') return spec;
        const validEntries = Object.entries(spec).filter(([, v]) => v != null);
        let cleanSpec = validEntries.length <= 1 ? spec : Object.fromEntries([validEntries[0]]);
        // Register inUseMode ChannelPlot layers under the 'inuse_brush' selection channel.
        // Only inject when selection is absent (null/undefined); empty string means no selection.
        if (cleanSpec.ChannelPlot?.inUseMode && cleanSpec.ChannelPlot?.selection == null) {
          cleanSpec = { ...cleanSpec, ChannelPlot: { ...cleanSpec.ChannelPlot, selection: 'inuse_brush' } };
        }
        return cleanSpec;
      }),
    };
    configRef.current = sanitizedConfig;
    console.log('[InUse] sanitizedConfig layers:', sanitizedConfig.layers?.map(l => JSON.stringify(l)));

    // Build a DataGroup with a 'current' child for gladly's built-in layer types
    // (column paths like "current.flightlines.mag_nT" resolve via _children.current).
    // fetchedData is also set as an own property under 'current' so custom layer
    // types can traverse plot._rawData.current[datasetName] via resolveDataPath().
    const dc = datasetCollection;
    const currentGroup = dc ? dc.toDataGroup() : new DataGroup({});
    const dataForPlot = new DataGroup({ current: currentGroup });
    // fetchedData is keyed by raw dataset name; custom layers resolve encoded paths
    // (current.<encodeSeg(dsName)>...) so mirror it under encoded keys.
    const encodedCurrent = {};
    for (const [dsName, raw] of Object.entries(fetchedData || {})) {
      encodedCurrent[encodeSeg(dsName)] = raw;
    }
    Object.assign(dataForPlot, {
      current: encodedCurrent,
      _currentSounding: currentSounding,
      _inMemoryDiffs: inMemoryDiffs,
    });

    // Merge lazily loaded non-current datasets:
    // - raw data as own properties so custom layers can access via resolveDataPath
    // - Dataset wrapper in _children chain so DataGroup.getQuantityKind can traverse them
    for (const [dsPath, { dsObj, rawData }] of lazilyLoadedData) {
      const [procName, ver, dsName] = dsPath.split('.');
      dataForPlot[procName] ??= {};
      dataForPlot[procName][ver] ??= {};
      dataForPlot[procName][ver][dsName] = rawData;
      if (!dataForPlot._children[procName]) dataForPlot._children[procName] = new DataGroup({});
      const procGroup = dataForPlot._children[procName];
      if (!procGroup._children[ver]) procGroup._children[ver] = new DataGroup({});
      procGroup._children[ver]._children[dsName] = dsObj;
    }

    // When only data/sounding changed (prop config is unchanged), pass gladly's current
    // config back to plot.update() so the user's pan/zoom state is preserved.
    // When the prop config actually changed (user edited layers/axes), apply the new config.
    const propConfigJson = JSON.stringify(sanitizedConfig);
    const propConfigChanged = propConfigJson !== lastPropConfigRef.current;
    lastPropConfigRef.current = propConfigJson;

    const configToApply = propConfigChanged
      ? sanitizedConfig
      : (plot.getConfig() || sanitizedConfig);

    let cancelled = false;
    plot.update({ data: dataForPlot, config: configToApply }).then(() => {
      if (cancelled) return;
      // Propagate the defaults-populated config back to the layout system so
      // axes, colorscales, etc. are visible in the config editor.
      const fullConfig = plot.getConfig();
      const fullConfigJson = JSON.stringify(fullConfig);
      if (fullConfigJson !== lastSavedRef.current && parentUpdateRef.current && id) {
        lastSavedRef.current = fullConfigJson;
        parentUpdateRef.current('replace', id, { id, widget, layoutConfig: fullConfig, ...rest });
      }
    });
    return () => { cancelled = true; };
  }, [config, fetchedData, datasetCollection, currentSounding, datasetsLoading, dataLoading, lazilyLoadedData, inMemoryDiffs]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={isMobile ? 'd-flex flex-column' : 'h-100 d-flex flex-column'}
         style={isMobile ? { height: '70vh' } : undefined}>
      <div className="flex-grow-1" style={{ position: 'relative', minHeight: 0 }}>
        <div
          ref={containerRef}
          style={{ width: '100%', height: '100%' }}
        />
        {(datasetsLoading || dataLoading) && (
          <div className="d-flex align-items-center justify-content-center"
               style={{ position: 'absolute', inset: 0, background: 'rgba(255,255,255,0.85)' }}>
            {datasetsLoading ? 'Loading datasets…' : 'Loading data…'}
          </div>
        )}
      </div>
      <div style={{
        display: 'flex',
        fontSize: '12px',
        fontFamily: 'monospace',
        background: '#f8f9fa',
        borderTop: '1px solid #dee2e6',
        flexShrink: 0,
        minHeight: '20px',
        color: '#495057',
        overflow: 'hidden',
      }}>
        <div ref={statusCoordsRef} style={{ flex: '0 1 auto', padding: '2px 8px', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }} />
        <div ref={statusPickRef}   style={{ flex: '1 1 0', padding: '2px 8px', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', textAlign: 'right', borderLeft: '1px solid #dee2e6' }} />
      </div>
    </div>
  );
}

PlotView.title = 'Plot view';

// Transform gladly's layers.items schema to be rjsf-compatible.
// Gladly uses oneOf with additionalProperties:false, which breaks rjsf because:
//  - rjsf's mergeDefaultsWithFormData() can produce objects with keys from multiple
//    variants simultaneously (one key is the selected type, others may be undefined)
//  - additionalProperties:false then makes EVERY variant fail, so oneOf finds zero matches
// Fix: use anyOf (requires ≥1 match, not exactly 1) and drop additionalProperties:false.
// rjsf's existing transformErrors in CustomForm already filters anyOf branch errors.
function makeLayersSchemaRjsfCompatible(layersItemsSchema) {
  if (!layersItemsSchema?.oneOf) return layersItemsSchema;
  const { oneOf, ...rest } = layersItemsSchema;
  return {
    ...rest,
    anyOf: oneOf.map(({ additionalProperties, ...variant }) => variant),
  };
}

// Gladly generates enum: [] when no dataset columns are available (dataset not
// yet loaded). An empty enum is itself invalid JSON Schema (AJV rejects the
// schema before even validating data). Walk the schema and drop empty enums so
// the form renders as a free-text field instead of crashing.
function dropEmptyEnums(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(dropEmptyEnums);
  const result = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'enum' && Array.isArray(v) && v.length === 0) continue;
    result[k] = dropEmptyEnums(v);
  }
  return result;
}

// Gladly's expression anyOf column options are { type: 'string', const: col, readOnly: true }
// with no `default` field. When RJSF initialises a new branch selection it calls
// getDefaultFormState(branchSchema, undefined) which returns undefined for strings
// without an explicit default — so the underlying formData stays undefined even
// though the dropdown looks like something is selected. Adding default: const
// makes RJSF commit the const value to formData when the branch is activated.
function addConstDefaults(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(addConstDefaults);
  const result = {};
  for (const [k, v] of Object.entries(schema)) {
    result[k] = addConstDefaults(v);
  }
  if ('const' in result && !('default' in result)) {
    result.default = result.const;
  }
  return result;
}

PlotView.get_schema = (data_context = {}) => {
  // Pass null data so gladly emits x-format:'expression' schemas (no column enums);
  // combobox widgets populate options from ProcessContext at runtime.
  // Pass the layout config so transform output columns are included in schemas.
  const rawGladlySchema = Plot.schema(null, data_context.layoutConfig);
  console.log('[PlotView.get_schema] $defs.expression:', JSON.stringify(rawGladlySchema?.$defs?.expression));
  console.log('[PlotView.get_schema] layers.items sample:', JSON.stringify(rawGladlySchema?.properties?.layers?.items)?.slice(0, 500));
  const gladlySchema = addConstDefaults(dropEmptyEnums(rawGladlySchema));

  // Patch the layers items schema in place.
  if (gladlySchema?.properties?.layers?.items) {
    gladlySchema.properties.layers.items =
      makeLayersSchemaRjsfCompatible(gladlySchema.properties.layers.items);
  }

  // Gladly emits root-relative $refs (e.g. #/$defs/transform_expression).
  // Hoist its $defs to the root of our wrapper schema so they resolve correctly.
  const { $defs: gladlyDefs, ...gladlySchemaRest } = gladlySchema ?? {};

  return {
    type: 'object',
    ...(gladlyDefs ? { $defs: gladlyDefs } : {}),
    properties: {
      id:           { type: 'string', title: 'ID',          readOnly: true },
      widget:       { type: 'string', title: 'Widget Type', readOnly: true },
      layoutConfig: gladlySchemaRest,
    },
    required: ['layoutConfig'],
  };
};

PlotView.get_default = () => ({
  layoutConfig: { transforms: [], layers: [], axes: {} },
});
