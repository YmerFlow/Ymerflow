import React, { useState } from 'react';
import CreateModelDialog from './CreateModelDialog';
import LoadModelDialog from './LoadModelDialog';
import AddFlightlineDialog from './AddFlightlineDialog';
import SaveModelDialog from './SaveModelDialog';
import ModelCanvas from './ModelCanvas';
import BrushControls from './BrushControls';
import { packBinary } from 'msgpack-numpy-js';
import { XYZ } from '../../datamodel/libaarhusxyz';
import { useIsMobile } from '../../hooks/useIsMobile';

/**
 * Convert XYZ object to format expected by ModelCanvas
 */
function xyzToCanvasData(xyz) {
  const fl = xyz.flightlines;
  const ld = xyz.layer_data;

  // Extract arrays
  const xdist = Array.from(fl.xdist);
  const utmx = Array.from(fl.UTMX);
  const utmy = Array.from(fl.UTMY);
  const topo = Array.from(fl.Topography);
  const txAltitude = Array.from(fl.TxAltitude);

  // Calculate flightElevation from topo + txAltitude
  const flightElevation = topo.map((t, i) => t + txAltitude[i]);

  // Extract resistivity layers as 2D array
  const resistivity = [];
  let nLayers;

  // Handle both Map and plain object (for backwards compatibility)
  const resData = ld.rho ?? ld.resistivity ?? ld.rho_i;
  if (resData instanceof Map) {
    nLayers = resData.size;
    for (let i = 0; i < nLayers; i++) {
      resistivity.push(Array.from(resData.get(i)));
    }
  } else {
    // Plain object with numeric keys
    const keys = Object.keys(resData).map(k => parseInt(k)).sort((a, b) => a - b);
    nLayers = keys.length;
    for (let i = 0; i < nLayers; i++) {
      resistivity.push(Array.from(resData[i]));
    }
  }

  // Calculate layer thicknesses from dep_top and dep_bot (use first sounding)
  const layerThicknesses = [];
  for (let i = 0; i < nLayers; i++) {
    let top, bot;
    if (ld.dep_top instanceof Map) {
      top = ld.dep_top.get(i)[0];
      bot = ld.dep_bot.get(i)[0];
    } else {
      top = ld.dep_top[i][0];
      bot = ld.dep_bot[i][0];
    }
    layerThicknesses.push(bot - top);
  }

  // Calculate extent, spacing, bearing
  const extent = xdist[xdist.length - 1] - xdist[0];
  const spacing = xdist.length > 1 ? (xdist[1] - xdist[0]) : 10;

  let bearing = 90;
  if (utmx.length > 1 && utmy.length > 1) {
    const dx = utmx[utmx.length - 1] - utmx[0];
    const dy = utmy[utmy.length - 1] - utmy[0];
    bearing = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  }

  return {
    xdist,
    utmx,
    utmy,
    topo,
    flightElevation,
    resistivity,
    config: {
      extent,
      spacing,
      layerThicknesses,
      defaultAltitudeAboveGround: txAltitude[0],
      utmStartX: utmx[0],
      utmStartY: utmy[0],
      utmBearing: bearing
    }
  };
}

/**
 * Apply canvas data updates to XYZ object
 */
function applyCanvasUpdatesToXYZ(xyz, updates) {
  const xyzData = {
    model_info: { ...xyz.info },
    flightlines: { ...xyz.flightlines },
    layer_data: {},
    system: xyz.system || {}
  };

  // Copy layer_data as plain objects (Maps can't be serialized by packBinary)
  for (const [key, layerMap] of Object.entries(xyz.layer_data)) {
    xyzData.layer_data[key] = {};

    // Handle both Map objects and plain objects (for backwards compatibility)
    if (layerMap instanceof Map) {
      for (const [layerIdx, array] of layerMap.entries()) {
        xyzData.layer_data[key][layerIdx] = new Float64Array(array);
      }
    } else if (layerMap && typeof layerMap === 'object') {
      // Plain object with numeric keys
      for (const [layerIdx, array] of Object.entries(layerMap)) {
        xyzData.layer_data[key][parseInt(layerIdx)] = new Float64Array(array);
      }
    }
  }

  // Apply updates
  if (updates.topo) {
    xyzData.flightlines.Topography = new Float64Array(updates.topo);
  }

  if (updates.flightElevation) {
    // Convert flightElevation back to TxAltitude (altitude above ground)
    const topo = xyzData.flightlines.Topography;
    const txAltitude = new Float64Array(updates.flightElevation.length);
    for (let i = 0; i < updates.flightElevation.length; i++) {
      txAltitude[i] = updates.flightElevation[i] - topo[i];
    }
    xyzData.flightlines.TxAltitude = txAltitude;
  }

  if (updates.resistivity) {
    // Update resistivity layers — write back to whichever key the data was stored under
    const resKey = 'rho' in xyzData.layer_data ? 'rho'
                 : 'resistivity' in xyzData.layer_data ? 'resistivity'
                 : 'rho_i';
    for (let layerIdx = 0; layerIdx < updates.resistivity.length; layerIdx++) {
      xyzData.layer_data[resKey][layerIdx] = new Float64Array(updates.resistivity[layerIdx]);
    }
  }

  // Create new XYZ from updated data
  return new XYZ(packBinary(xyzData));
}

function AEMModelSimulator() {
  const isMobile = useIsMobile();
  // Store array of XYZ objects (one per flightline)
  const [flightlines, setFlightlines] = useState([]); // Array of XYZ objects
  const [currentFlightlineIndex, setCurrentFlightlineIndex] = useState(0);

  // Track source process for smart save (null if model was created, not loaded)
  const [sourceProcess, setSourceProcess] = useState(null);

  // Dialog states
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showLoadDialog, setShowLoadDialog] = useState(false);
  const [showAddFlightlineDialog, setShowAddFlightlineDialog] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);

  // Brush state
  const [brushRadius, setBrushRadius] = useState(20);
  const [brushSharpness, setBrushSharpness] = useState(0.5);
  const [currentResistivity, setCurrentResistivity] = useState(500);
  const [drawMode, setDrawMode] = useState('paint'); // 'paint' or 'terrain'
  const [rubberbandWidth, setRubberbandWidth] = useState(15);

  // Colormap / color scale state
  const [colormap, setColormap] = useState('turbo');
  const [vmin, setVmin] = useState(1);
  const [vmax, setVmax] = useState(5000);
  const [customColormapData, setCustomColormapData] = useState(null);

  const currentFlightline = flightlines.length > 0 ? flightlines[currentFlightlineIndex] : null;

  const handleCreateModel = (xyz) => {
    // xyz is a single XYZ object
    setFlightlines([xyz]);
    setCurrentFlightlineIndex(0);
    setSourceProcess(null); // New model, no source process
  };

  const handleLoadModel = (xyz, sourceProcessInfo) => {
    // Split merged XYZ into separate flightline objects
    const splitFlightlines = xyz.split();
    setFlightlines(splitFlightlines);
    setCurrentFlightlineIndex(0);
    setSourceProcess(sourceProcessInfo); // Track source for smart save
  };

  const handleAddFlightline = (xyz) => {
    // xyz is a new XYZ object for the new flightline
    setFlightlines([...flightlines, xyz]);
    setCurrentFlightlineIndex(flightlines.length);
  };

  const handleDeleteFlightline = () => {
    if (flightlines.length <= 1) {
      alert('Cannot delete the last flightline');
      return;
    }

    const flightlineName = currentFlightline.info.flightline_name || `Flightline ${currentFlightlineIndex + 1}`;
    if (!window.confirm(`Delete flightline "${flightlineName}"?`)) {
      return;
    }

    const newFlightlines = flightlines.filter((_, idx) => idx !== currentFlightlineIndex);
    setFlightlines(newFlightlines);
    setCurrentFlightlineIndex(Math.min(currentFlightlineIndex, newFlightlines.length - 1));
  };

  const handleSaveModel = () => {
    setShowSaveDialog(true);
  };

  const updateCurrentFlightline = (updatedXyz) => {
    // Replace the current XYZ object with updated one
    const newFlightlines = [...flightlines];
    newFlightlines[currentFlightlineIndex] = updatedXyz;
    setFlightlines(newFlightlines);
  };

  // Convert current XYZ to canvas data format
  const currentCanvasData = currentFlightline ? xyzToCanvasData(currentFlightline) : null;

  // Handler for canvas updates
  const handleCanvasUpdate = (updates) => {
    const updatedXyz = applyCanvasUpdatesToXYZ(currentFlightline, updates);
    updateCurrentFlightline(updatedXyz);
  };

  return (
    <div style={{
      width: '100%',
      height: isMobile ? '80vh' : '100%',
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: '#ffffff'
    }}>
      {/* Unified Header */}
      <div style={{
        padding: '10px 15px',
        borderBottom: '1px solid #dee2e6',
        display: 'flex',
        alignItems: 'center',
        gap: '15px',
        backgroundColor: '#f8f9fa'
      }}>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={() => setShowCreateDialog(true)}
            style={{
              padding: '6px 12px',
              backgroundColor: '#28a745',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px'
            }}
          >
            New Model
          </button>
          <button
            onClick={() => setShowLoadDialog(true)}
            style={{
              padding: '6px 12px',
              backgroundColor: '#007bff',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px'
            }}
          >
            Load Model
          </button>
          {flightlines.length > 0 && (
            <button
              onClick={handleSaveModel}
              style={{
                padding: '6px 12px',
                backgroundColor: '#28a745',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '14px'
              }}
            >
              Save Model
            </button>
          )}
        </div>

        {/* Flightline controls - inline in same bar */}
        {flightlines.length > 0 && (
          <>
            <div style={{ width: '1px', height: '30px', backgroundColor: '#dee2e6', margin: '0 5px' }} />

            <label style={{ fontWeight: 'bold', fontSize: '14px', marginRight: '5px' }}>Flightline:</label>
            <select
              value={currentFlightlineIndex}
              onChange={(e) => setCurrentFlightlineIndex(parseInt(e.target.value))}
              style={{
                padding: '4px 8px',
                borderRadius: '4px',
                border: '1px solid #ced4da',
                fontSize: '14px'
              }}
            >
              {flightlines.map((xyz, idx) => {
                const name = xyz.info.flightline_name || `Flightline ${idx + 1}`;
                return (
                  <option key={idx} value={idx}>
                    {name}
                  </option>
                );
              })}
            </select>
            <button
              onClick={() => setShowAddFlightlineDialog(true)}
              style={{
                padding: '4px 10px',
                backgroundColor: '#28a745',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '13px'
              }}
            >
              + Add
            </button>
            {flightlines.length > 1 && (
              <button
                onClick={handleDeleteFlightline}
                style={{
                  padding: '4px 10px',
                  backgroundColor: '#dc3545',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '13px'
                }}
              >
                Delete
              </button>
            )}
            <span style={{ marginLeft: 'auto', fontSize: '13px', color: '#6c757d' }}>
              {(() => {
                const firstKey = Object.keys(currentFlightline.flightlines)[0];
                const nSoundings = currentFlightline.flightlines[firstKey]?.length || 0;
                const resData = currentFlightline.layer_data.rho ?? currentFlightline.layer_data.resistivity;
                const nLayers = resData instanceof Map ? resData.size : Object.keys(resData || {}).length;
                return `${nSoundings} soundings, ${nLayers} layers`;
              })()}
            </span>
          </>
        )}
      </div>

      {/* Main content */}
      {currentFlightline ? (
        <div style={{
          flex: 1,
          display: 'flex',
          overflow: 'hidden'
        }}>
          {/* Canvas area */}
          <div style={{ flex: 1, position: 'relative' }}>
            <ModelCanvas
              modelData={currentCanvasData}
              setModelData={handleCanvasUpdate}
              brushRadius={brushRadius}
              brushSharpness={brushSharpness}
              currentResistivity={currentResistivity}
              drawMode={drawMode}
              rubberbandWidth={rubberbandWidth}
              colormap={colormap}
              vmin={vmin}
              vmax={vmax}
              customColormapData={customColormapData}
            />
          </div>

          {/* Controls sidebar */}
          <BrushControls
            brushRadius={brushRadius}
            setBrushRadius={setBrushRadius}
            brushSharpness={brushSharpness}
            setBrushSharpness={setBrushSharpness}
            currentResistivity={currentResistivity}
            setCurrentResistivity={setCurrentResistivity}
            drawMode={drawMode}
            setDrawMode={setDrawMode}
            rubberbandWidth={rubberbandWidth}
            setRubberbandWidth={setRubberbandWidth}
            colormap={colormap}
            setColormap={setColormap}
            vmin={vmin}
            setVmin={setVmin}
            vmax={vmax}
            setVmax={setVmax}
            customColormapData={customColormapData}
            setCustomColormapData={setCustomColormapData}
          />
        </div>
      ) : (
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#6c757d',
          fontSize: '16px'
        }}>
          <div style={{ textAlign: 'center' }}>
            <p style={{ marginBottom: '20px' }}>No model loaded</p>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
              <button
                onClick={() => setShowCreateDialog(true)}
                style={{
                  padding: '10px 20px',
                  backgroundColor: '#28a745',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '16px'
                }}
              >
                Create New Model
              </button>
              <button
                onClick={() => setShowLoadDialog(true)}
                style={{
                  padding: '10px 20px',
                  backgroundColor: '#007bff',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '16px'
                }}
              >
                Load Existing Model
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Dialogs */}
      {showCreateDialog && (
        <CreateModelDialog
          onClose={() => setShowCreateDialog(false)}
          onCreate={handleCreateModel}
        />
      )}
      {showLoadDialog && (
        <LoadModelDialog
          onClose={() => setShowLoadDialog(false)}
          onLoad={handleLoadModel}
        />
      )}
      {showAddFlightlineDialog && (
        <AddFlightlineDialog
          onClose={() => setShowAddFlightlineDialog(false)}
          onCreate={handleAddFlightline}
          existingFlightlines={flightlines}
        />
      )}
      {showSaveDialog && (
        <SaveModelDialog
          onClose={() => setShowSaveDialog(false)}
          flightlines={flightlines}
          sourceProcess={sourceProcess}
        />
      )}
    </div>
  );
}

AEMModelSimulator.title = "AEM Model Simulator";

export default AEMModelSimulator;
