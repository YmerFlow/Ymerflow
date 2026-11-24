import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Plot, DataGroup } from 'gladly-plot';
import { ProcessContext } from '../../ProcessContext';
import { PlotGroupContext } from '../../PlotGroupContext';
import { registerQuantityKinds } from './quantityKinds';
import { encodeSeg } from '../../datamodel/datasetPath';
import { getKeys, resolveDataPath } from './colorUtils.js';
import { nearestSoundingByXdist } from './soundingMatch.js';
import { cellEditEntries, segmentEditEntries } from './inUseEdits.js';
import { addPinnedData, loadPinnedData, pinnedEntries } from './pinnedDatasets.js';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useSearchDatasets } from '../../datamodel/useQueries';
import { useDatasetDrop } from '../../dnd/datasetDnd';
import DatasetDropMenu from '../../dnd/DatasetDropMenu';
import { compatibleLayerTypes, buildLayer } from './datasetDrop.js';
import './elements/index.js';

// Register quantity kinds once at module load
registerQuantityKinds();

const PLOT_MARGIN = { top: 50, right: 80, bottom: 60, left: 80 };

// Layer types that edit in-use flags with the InUse Editor's lasso.
const IN_USE_LAYER_TYPES = ['ChannelPlot', 'GateAnomalyPlot'];

// Status-bar backgrounds: default, and the red shown when a dataset is dropped onto a
// plot that has no layer type able to accept it.
const DEFAULT_BG = '#f8f9fa';
const ERROR_BG = '#f8d7da';
const ERROR_MSG = 'Dataset not compatible with existing layers';

// inheritedCompact / inheritedGlobalCompact are flexout header-mode props Pane passes
// to every widget; PlotView ignores them but must destructure them out so they never
// leak into `...rest` and get persisted into the saved layout node by the write-back below.
export default function PlotView({ layoutConfig, parentUpdate, id, widget, inheritedCompact, inheritedGlobalCompact, ...rest }) {
  const isMobile = useIsMobile();
  const { fetchedData, datasetsLoading, dataLoading, currentSounding, setCurrentSounding, datasetCollection, processes,
    inMemoryDiffs, applyInMemoryEdit, inUseAction, selectionShape, selectionBandWidth,
    currentProject, currentPart, ensureSavePointEditLoaded, activeProcess } = useContext(ProcessContext);

  // Map of key → { path, part, dsObj, rawData } (or { path, part, message } when there is no
  // part to show) for non-current process datasets; see pinnedDatasets.js.
  const [lazilyLoadedData, setLazilyLoadedData] = useState(new Map());
  const { addPlot, removePlot, publishReadout, saveAllPlots } = useContext(PlotGroupContext);

  // All project datasets (search results carry `.parts`): used to look up a dropped
  // dataset's media types when a dataset is dragged onto this plot.
  const { data: allDatasets = [] } = useSearchDatasets('', true, currentProject);
  // Picker shown when a dropped dataset has >1 candidate layer type.
  const [dropMenu, setDropMenu] = useState(null);

  const containerRef          = useRef(null);
  const plotRef               = useRef(null);
  const statusBarRef          = useRef(null);   // this plot's own status-bar outer div
  const statusCoordsRef       = useRef(null);   // left: live mouse coordinates
  const statusPickRef         = useRef(null);   // right: last clicked point
  // Per-slot background color for this plot's own status bar (mirror of PlotStatusBar's
  // channels); the bar paints pick ?? coords ?? default. Written imperatively like the
  // mirror text, so applyStatusBg() recomputes the background.
  const statusColorsRef       = useRef({ coords: undefined, pick: undefined });
  const applyStatusBg = () => {
    if (statusBarRef.current)
      statusBarRef.current.style.background =
        statusColorsRef.current.pick ?? statusColorsRef.current.coords ?? DEFAULT_BG;
  };
  const configRef             = useRef(null);   // tracks latest sanitized config for pick resolution
  const fetchedDataRef        = useRef(fetchedData);
  const inUseActionRef        = useRef(inUseAction);
  const applyInMemoryEditRef  = useRef(applyInMemoryEdit);
  const lastSavedRef          = useRef(null);      // JSON of last config we sent via parentUpdate
  const lastPropConfigRef     = useRef(null);      // JSON of last prop config passed to plot.update()
  const plotDataRef           = useRef(null);      // latest DataGroup passed to plot.update() (for drop filtering)
  const parentUpdateRef       = useRef(parentUpdate);
  useEffect(() => { parentUpdateRef.current = parentUpdate; }, [parentUpdate]);
  useEffect(() => { fetchedDataRef.current = fetchedData; }, [fetchedData]);
  useEffect(() => { inUseActionRef.current = inUseAction; }, [inUseAction]);
  useEffect(() => { applyInMemoryEditRef.current = applyInMemoryEdit; }, [applyInMemoryEdit]);

  const config = useMemo(
    () => layoutConfig || PlotView.get_default().layoutConfig,
    [layoutConfig],
  );

  // Latest config, readable from the long-lived gladly event handlers (the mount effect's
  // closures capture only the first render's values).
  const configPropRef = useRef(config);
  configPropRef.current = config;

  // Force this plot's current gladly config (plus our own statusBar field) back into the
  // layout node. The update effect below only writes back when it re-runs; a gladly menu
  // change ('axisoptions'/'axislimit') does not change the React config prop, so its
  // handlers call this directly. Reassigned every render so it always closes over the
  // latest props. An optional statusBarOverride lets the status-bar toggle set its value.
  const saveConfigRef = useRef(() => {});
  saveConfigRef.current = (statusBarOverride) => {
    const plot = plotRef.current;
    if (!plot || !parentUpdateRef.current || !id) return;
    const fullConfig = { ...plot.getConfig() };
    const sb = statusBarOverride !== undefined ? statusBarOverride : config.statusBar;
    if (sb !== undefined) fullConfig.statusBar = sb;
    const fullConfigJson = JSON.stringify(fullConfig);
    if (fullConfigJson === lastSavedRef.current) return;
    lastSavedRef.current = fullConfigJson;
    parentUpdateRef.current('replace', id, { id, widget, layoutConfig: fullConfig, ...rest });
  };

  // Append a layer to this plot's config and persist it (mirrors the write above).
  // Reassigned every render so it closes over the latest props. The new config
  // changes our React prop, so the update effect re-runs and renders the layer.
  const appendLayerRef = useRef(() => {});
  appendLayerRef.current = (newLayer) => {
    if (!parentUpdateRef.current || !id) return;
    const base = configPropRef.current || PlotView.get_default().layoutConfig;
    const next = { ...base, layers: [...(base.layers || []), newLayer] };
    parentUpdateRef.current('replace', id, { id, widget, layoutConfig: next, ...rest });
  };

  // Clear the incompatible-drop red: a no-color pick clears the shared bar's red, and the
  // mirror's own pick color is reset. Called on every successful layer append.
  const clearDropError = () => {
    publishReadout({ pick: '' });
    statusColorsRef.current.pick = undefined;
    applyStatusBg();
  };

  // A dataset dropped onto the plot: filter candidate layer types by media type +
  // axis conflict-avoidance. 0 → red "not compatible" message; otherwise show the picker,
  // except the one case with nothing to choose (exactly 1 candidate AND the pin is fixed),
  // which auto-appends. The pin is adjustable only for the active process's active version.
  const handleDatasetDrop = useCallback((item, offset) => {
    const dict = (allDatasets || []).find(d => d.id === item.datasetId);
    if (!dict) return;
    const layers = configPropRef.current?.layers || [];
    const data = plotDataRef.current;
    const cands = compatibleLayerTypes(dict, layers, data);

    if (cands.length === 0) {
      publishReadout({ pick: ERROR_MSG, pickColor: ERROR_BG });
      if (statusPickRef.current) statusPickRef.current.textContent = ERROR_MSG;
      statusColorsRef.current.pick = ERROR_BG;
      applyStatusBg();
      return;
    }

    // "Current" = the active process's active version — exactly what current.<ds> resolves
    // to; only then is the pin toggleable (and unpinned by default). datasetPath is the
    // pinned <proc>.<ver>.<ds>; its already-encoded 3rd segment is the dataset name.
    const isCurrent =
      item.processId === activeProcess?.processId &&
      String(item.processVersion) === String(activeProcess?.version);
    const pinnedPath  = item.datasetPath;
    const currentPath = 'current.' + item.datasetPath.split('.')[2];

    if (cands.length === 1 && !isCurrent) {
      appendLayerRef.current(buildLayer(cands[0], pinnedPath, data));
      clearDropError();
      return;
    }

    setDropMenu({
      x: offset?.x ?? 0,
      y: offset?.y ?? 0,
      pinnedPath,
      currentPath,
      pinnable: isCurrent,
      items: cands.map(c => ({ ...c, label: c.name })),
    });
  }, [allDatasets, activeProcess]); // eslint-disable-line react-hooks/exhaustive-deps

  const dropRef = useDatasetDrop(handleDatasetDrop);

  const handleDropPick = useCallback((item, path) => {
    appendLayerRef.current(buildLayer(item, path, plotDataRef.current));
    clearDropError();
    setDropMenu(null);
  }, [dropMenu]); // eslint-disable-line react-hooks/exhaustive-deps

  const pinnedMessages = useMemo(
    () => pinnedEntries(lazilyLoadedData, currentPart).map(e => e.message).filter(Boolean),
    [lazilyLoadedData, currentPart],
  );

  // Scan layer parameters for non-current dataset paths and lazily load their data: the part
  // each path names, or the part with the selected part's name (see pinnedDatasets.js).
  useEffect(() => {
    if (!config?.layers || !processes?.length) return;
    loadPinnedData(config.layers, processes, currentProject, currentPart, lazilyLoadedData,
      (key, entry) => setLazilyLoadedData(prev => new Map(prev).set(key, entry)));
  }, [config, processes, currentProject, currentPart]); // eslint-disable-line react-hooks/exhaustive-deps

  // An editing layer on a save point shows, and edits, the edit saved on it: load it into
  // the editor under the layer's own dataset path, the key its overlay reads.
  useEffect(() => {
    for (const spec of config?.layers ?? []) {
      const [type, params] = Object.entries(spec ?? {}).find(([, v]) => v != null) ?? [];
      if (IN_USE_LAYER_TYPES.includes(type) && params?.inUseMode && params.dataset) {
        ensureSavePointEditLoaded(params.dataset);
      }
    }
  }, [config, ensureSavePointEditLoaded]);

  // Create / destroy the Plot instance and register gladly event handlers.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const plot = new Plot(container, { margin: PLOT_MARGIN });
    plotRef.current = plot;
    addPlot(id, plot, () => saveConfigRef.current());

    // Show data-space coordinates on mousemove — in this plot's own bar (when shown)
    // and in the shared workspace status bar.
    const moveHandle = plot.on('mousemove', (e, coords) => {
      // Show only quantity-kind keys (skip axis-name duplicates like xaxis_bottom).
      const parts = Object.entries(coords)
        .filter(([k]) => !k.startsWith('xaxis_') && !k.startsWith('yaxis_'))
        .map(([k, v]) => `${k}: ${Number(v).toPrecision(5)}`);
      const text = parts.join('   ');
      if (statusCoordsRef.current) statusCoordsRef.current.textContent = text;
      statusColorsRef.current.coords = undefined;
      applyStatusBg();
      publishReadout({ coords: text });
    });

    // On click: GPU-pick the nearest point, update status bar, and set current sounding.
    const clickHandle = plot.on('click', async (e, coords) => {
      const p = plotRef.current;
      if (!p) return;
      // Shift is the selection modifier: every selection shape ends in a Shift press and
      // release, and polygon and ellipse points are Shift-clicks. None of them picks a sounding.
      if (e.shiftKey) return;

      const rect = container.getBoundingClientRect();
      let result;
      try {
        result = await p.pick(e.clientX - rect.left, e.clientY - rect.top);
      } catch (err) {
        console.warn('plot.pick() failed:', err);
        return;
      }

      // Update the picked-point readout — in this plot's own bar (when shown) and in
      // the shared workspace status bar — with the picked point's raw attributes.
      let pickText = '';
      if (result) {
        const { configLayerIndex, tile, index, layer } = result;
        const isInstanced = layer.instanceCount !== null;
        const row = Object.fromEntries(
          Object.entries(layer.attributes)
            .filter(([k]) => !isInstanced || (layer.attributeDivisors[k] ?? 0) === 1)
            .map(([k, v]) => [k, Number(Array.isArray(v) ? v[tile]?.[index] : v[index]).toPrecision(5)])
        );
        pickText =
          `layer ${configLayerIndex}  tile ${tile}  pt ${index}  ` +
          Object.entries(row).map(([k, v]) => `${k}=${v}`).join('  ');
      }
      if (statusPickRef.current) statusPickRef.current.textContent = pickText;
      statusColorsRef.current.pick = undefined;
      applyStatusBg();
      publishReadout({ pick: pickText });

      // --- Sounding selection ---
      // A vertex was picked: let the layer type that drew it decide what the click does.
      // onClick gets the same (parameters, plot) createLayer did — plot._rawData carries
      // the runtime context/actions (_currentSounding, _setCurrentSounding, …) — plus the
      // pick result, whose dataIndex the layer's own pickInfo already resolved to a data
      // row. PlotView holds no per-layer click logic and no coordinate/quantity-kind
      // knowledge; layers with no onClick (e.g. a basemap tile) do nothing.
      // --- Sounding selection ---
      // On an xdist-axis plot (ResistivityCurtain, ChannelPlot, …) select the sounding nearest
      // the clicked distance-along-line. coords.xdist_m is the click's data-space position on the
      // xdist axis (domain- and zoom-correct); the result is a plain row index into the current
      // dataset (see soundingMatch.js). A GPU pick on the instanced curtain is unreliable for
      // this (hundreds of thousands of overlapping cells), so we go from the clicked coordinate.
      if (coords?.xdist_m != null) {
        const rawData = plotRef.current?._rawData;
        for (const spec of (configRef.current?.layers ?? [])) {
          if (!spec || typeof spec !== 'object') continue;
          const params = Object.values(spec).find(v => v != null);
          const xdist  = resolveDataPath(rawData, params?.dataset)?.flightlines?.xdist;
          if (!xdist?.length) continue;
          const sounding = nearestSoundingByXdist(xdist, coords.xdist_m);
          if (sounding != null) rawData?._setCurrentSounding?.(sounding);
          break;   // first dataset with an xdist column is enough
        }
      } else if (result) {
        // Non-xdist plot (e.g. FlightlinePlot on lat/lon, one pickable point per sounding):
        // the layer's onClick turns the GPU pick into a selection.
        const spec   = configRef.current?.layers?.[result.configLayerIndex];
        const params = spec && typeof spec === 'object' ? Object.values(spec).find(v => v != null) : null;
        result.layer?.type?.onClick?.(result, params, plotRef.current);
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
        const [type, params] = Object.entries(spec ?? {}).find(([, v]) => v != null) ?? [];
        if (!IN_USE_LAYER_TYPES.includes(type) || !params?.inUseMode) {
          console.log('[InUse] skipping layer (no inUseMode):', spec);
          continue;
        }
        const dsName  = params.dataset;
        const channel = params.channel || 'Ch01';
        console.log('[InUse] processing layer dsName:', dsName, 'channel:', channel);

        const ds = resolveDataPath(rawData, dsName);
        if (!ds?.layer_data) { console.log('[InUse] no layer_data for ds:', dsName, 'ds:', ds, 'rawData:', rawData); continue; }
        const yDataDict = ds.layer_data[`Gate_${channel}`];
        if (!yDataDict) { console.log('[InUse] no yDataDict for key Gate_' + channel, 'layer_data keys:', Object.keys(ds.layer_data)); continue; }
        const gateKeys = getKeys(yDataDict).sort((a, b) => a - b);
        console.log('[InUse] gateKeys:', gateKeys, 'arrays size:', arrays.size ?? arrays.length);

        // The mask is per part-local sounding; entries carry the global index, through
        // apply_idx. ChannelPlot has one tile per gate, GateAnomalyPlot one tile of cells.
        // Layers in one pane share its selection channel, so a mask only fits the layer
        // type that drew it: the two editing layers go in separate panes.
        const applyIdx = ds.flightlines?.apply_idx;
        const entries = type === 'ChannelPlot'
          ? (arrays.length === gateKeys.length ? segmentEditEntries(arrays, gateKeys, applyIdx) : null)
          : (arrays.length === 1 ? cellEditEntries(arrays[0], ds.flightlines.xdist.length, gateKeys, applyIdx) : null);
        if (!entries) {
          console.error(`[InUse] the selection does not fit the ${type} layer on ${dsName}; ` +
            'put ChannelPlot and GateAnomalyPlot editing layers in separate panes');
          continue;
        }
        console.log('[InUse] entries to apply:', entries.length, entries.slice(0, 5));
        if (entries.length > 0) apply(dsName, channel, entries, value);
        else console.log('[InUse] no entries selected, skipping apply');
      }
      sel.clear();
    });

    // Persist gladly's built-in axis menu / axis changes. None of these change our React
    // config prop, so the update effect won't re-run — persist explicitly here.
    //  - 'axisoptions' non-locked keys (visible/tickLabelsVisible/titleVisible, and the
    //    0.0.22 scale/colorscale/colorbar/filterbar/2D-pair keys): a plain per-plot
    //    write-back of this plot's getConfig(). We never assume event.axis is a slot.
    //  - 'axisoptions' locked: the lock itself is local to this plot (gladly), but it pins
    //    a range shared across the linked workspace, so persist every plot.
    //  - 'axislimit' (a typed limit): propagates across linked axes, so persist every plot.
    const axisOptHandle = plot.on('axisoptions', (event) => {
      if (event.key === 'locked') saveAllPlots();
      else saveConfigRef.current();
    });
    const axisLimitHandle = plot.on('axislimit', () => saveAllPlots());

    // Augment the built-in menu as it opens: inject our one app-specific row (the
    // status-bar toggle), and — because gladly fires no event for a reset — persist a
    // reset by listening on the menu's own Reset button. The callback runs on every open,
    // appending fresh DOM that is discarded with the menu, so it owns its own state.
    const ctxOpenHandle = plot.on('contextmenu_open', (e, coords, region, menuEl) => {
      const row = document.createElement('label');
      row.setAttribute('data-gladly-control', 'statusbar-toggle');
      Object.assign(row.style, {
        display: 'flex', alignItems: 'center', gap: '5px',
        marginTop: '4px', cursor: 'pointer', font: '12px sans-serif',
      });
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!configPropRef.current?.statusBar;
      cb.addEventListener('change', () => saveConfigRef.current(cb.checked));
      row.appendChild(cb);
      row.appendChild(document.createTextNode('Status bar'));
      menuEl.appendChild(row);

      // gladly's Reset button ("Reset view" / "Reset axis") fires no event, so hook it
      // directly. Our listener runs after gladly's (added later); a microtask lets the
      // reset's linked-axis domain changes settle before we read getConfig() everywhere.
      for (const btn of menuEl.querySelectorAll('button')) {
        if (/^Reset/.test(btn.textContent || '')) {
          btn.addEventListener('click', () => Promise.resolve().then(() => saveAllPlots()));
        }
      }
    });

    return () => {
      selHandle.remove();
      moveHandle.remove();
      clickHandle.remove();
      axisOptHandle.remove();
      axisLimitHandle.remove();
      ctxOpenHandle.remove();
      removePlot(id);
      plot.destroy();
      plotRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The InUse editor's selection shape and band width [m], set on the plot at run time: no
  // rebuild, and gladly keeps them for the lasso interactions a later update() builds.
  // Declared after the effect that creates the plot, so the plot exists on the first run.
  useEffect(() => {
    plotRef.current?.setLassoMode(selectionShape, { bandWidth: selectionBandWidth });
  }, [selectionShape, selectionBandWidth]);

  // Update plot whenever config, data or sounding changes.
  // _currentSounding is merged into the data object so LayerTypes that need it
  // (ResistivityCurtain's sounding line, SoundingPlot, ResistivityCurtainLines) can read it, through
  // soundingIndex() for their own dataset, in their createLayer function.
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
        // Register inUseMode editing layers under the 'inuse_brush' selection channel.
        // Only inject when selection is absent (null/undefined); empty string means no selection.
        for (const type of IN_USE_LAYER_TYPES) {
          if (cleanSpec[type]?.inUseMode && cleanSpec[type]?.selection == null) {
            cleanSpec = { ...cleanSpec, [type]: { ...cleanSpec[type], selection: 'inuse_brush' } };
          }
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
      // Action a layer's onClick can call to move the selection (mirror of _currentSounding).
      _setCurrentSounding: setCurrentSounding,
    });

    // Merge lazily loaded non-current datasets for the selected part (see addPinnedData).
    addPinnedData(dataForPlot, pinnedEntries(lazilyLoadedData, currentPart));

    // Expose the built data to the dataset-drop handler (axis conflict-avoidance).
    plotDataRef.current = dataForPlot;

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
      // statusBar is our own layoutConfig field, not part of gladly's config; preserve
      // it across the getConfig() round-trip so toggling it isn't dropped on next update.
      const fullConfig = { ...plot.getConfig() };
      if (sanitizedConfig.statusBar !== undefined) fullConfig.statusBar = sanitizedConfig.statusBar;
      const fullConfigJson = JSON.stringify(fullConfig);
      if (fullConfigJson !== lastSavedRef.current && parentUpdateRef.current && id) {
        lastSavedRef.current = fullConfigJson;
        parentUpdateRef.current('replace', id, { id, widget, layoutConfig: fullConfig, ...rest });
      }
    });
    return () => { cancelled = true; };
  }, [config, fetchedData, datasetCollection, currentSounding, datasetsLoading, dataLoading, lazilyLoadedData, inMemoryDiffs, currentPart]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={dropRef}
         className={isMobile ? 'd-flex flex-column' : 'h-100 d-flex flex-column'}
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
        {pinnedMessages.length > 0 && (
          <div className="alert alert-warning py-1 px-2 mb-0 small"
               style={{ position: 'absolute', top: 4, left: 4, right: 4, pointerEvents: 'none' }}>
            {pinnedMessages.map(m => <div key={m}>{m}</div>)}
          </div>
        )}
      </div>
      {config.statusBar && (
        <div ref={statusBarRef} style={{
          display: 'flex',
          fontSize: '12px',
          fontFamily: 'monospace',
          background: DEFAULT_BG,
          borderTop: '1px solid #dee2e6',
          flexShrink: 0,
          minHeight: '20px',
          color: '#495057',
          overflow: 'hidden',
        }}>
          <div ref={statusCoordsRef} style={{ flex: '0 1 auto', padding: '2px 8px', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }} />
          <div ref={statusPickRef}   style={{ flex: '1 1 0', padding: '2px 8px', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', textAlign: 'right', borderLeft: '1px solid #dee2e6' }} />
        </div>
      )}
      {dropMenu && (
        <DatasetDropMenu
          x={dropMenu.x}
          y={dropMenu.y}
          items={dropMenu.items}
          pinnable={dropMenu.pinnable}
          pinnedPath={dropMenu.pinnedPath}
          currentPath={dropMenu.currentPath}
          onPick={handleDropPick}
          onClose={() => setDropMenu(null)}
        />
      )}
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

  // statusBar is our own layoutConfig field (not gladly's): show this plot's own
  // status bar. Off by default — the workspace-wide status bar covers the readout.
  gladlySchemaRest.properties = {
    ...gladlySchemaRest.properties,
    statusBar: {
      type: 'boolean',
      title: 'Status bar',
      description: "Show this plot's own status bar (off by default; the workspace status bar shows the readout for the plot under the pointer).",
      default: false,
    },
  };

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
  layoutConfig: { transforms: [], layers: [], axes: {}, statusBar: false },
});
