import React, { useState, useEffect, useContext } from 'react';
import Form from '@rjsf/core';
import validator from '@rjsf/validator-ajv8';
import EPSGSelector from '../../jsoneditor/EPSGSelector';
import { XYZ } from '../../datamodel/libaarhusxyz';
import { packBinary } from 'msgpack-numpy-js';
import { ProcessContext } from '../../ProcessContext';
import { useSystems } from '../../datamodel/useQueries';
import AddSystemDialog from './AddSystemDialog';

function CreateModelDialog({ onClose, onCreate }) {
  const { currentProject } = useContext(ProcessContext);
  const [modelMode, setModelMode] = useState('structured'); // 'structured' | 'layered'
  const [structuredParams, setStructuredParams] = useState({
    layerThickness: 5,
    totalDepth: 300,
    resistivity: 100
  });
  const { data: systems = [] } = useSystems(currentProject);
  const [showAddSystemDialog, setShowAddSystemDialog] = useState(false);
  const [formData, setFormData] = useState({
    system: null,
    extent: 1000,
    spacing: 10,
    altitudeStart: 30,
    altitudeEnd: 30,
    projection: 25833,
    utmStartX: 500000,
    utmStartY: 6000000,
    utmBearing: 90
  });

  // Default-select the first system once systems load (and none is chosen yet).
  useEffect(() => {
    if (systems.length > 0 && !formData.system) {
      setFormData(prev => ({ ...prev, system: systems[0].id }));
    }
  }, [systems, formData.system]);

  // Build schema dynamically based on available systems
  const schemaProperties = {
    extent: {
        type: "number",
        title: "Distance extent (m)",
        default: 1000,
        minimum: 100
      },
      spacing: {
        type: "number",
        title: "Sounding spacing (m)",
        default: 10,
        minimum: 1
      },
      altitudeStart: {
        type: "number",
        title: "Altitude above ground — start (m)",
        default: 30,
        minimum: 1
      },
      altitudeEnd: {
        type: "number",
        title: "Altitude above ground — end (m)",
        default: 30,
        minimum: 1
      },
      utmStartX: {
        type: "number",
        title: "Starting UTM X (easting)",
        default: 500000
      },
      utmStartY: {
        type: "number",
        title: "Starting UTM Y (northing)",
        default: 6000000
      },
      utmBearing: {
        type: "number",
        title: "Flightline bearing (degrees from north)",
        default: 90,
        minimum: 0,
        maximum: 360
      }
    };

  const schema = {
    type: "object",
    properties: schemaProperties,
    required: ["extent", "spacing", "altitudeStart", "altitudeEnd", "utmStartX", "utmStartY", "utmBearing"]
  };

  const [layers, setLayers] = useState([
    { thickness: 1, resistivity: 100 },
    { thickness: 1, resistivity: 100 },
    { thickness: 2, resistivity: 100 },
    { thickness: 5, resistivity: 100 },
    { thickness: 10, resistivity: 100 },
    { thickness: 20, resistivity: 100 },
    { thickness: 50, resistivity: 100 },
    { thickness: 100, resistivity: 100 }
  ]);

  const structuredLayerCount = () => {
    const t = Math.max(structuredParams.layerThickness, 0.1);
    return Math.min(500, Math.max(1, Math.floor(structuredParams.totalDepth / t)));
  };

  const handleModeChange = (newMode) => {
    if (newMode === 'layered' && modelMode === 'structured') {
      const n = structuredLayerCount();
      setLayers(Array.from({ length: n }, () => ({
        thickness: structuredParams.layerThickness,
        resistivity: structuredParams.resistivity
      })));
    }
    setModelMode(newMode);
  };

  const handleLayerChange = (index, field, value) => {
    const newLayers = [...layers];
    newLayers[index][field] = parseFloat(value) || 0;
    setLayers(newLayers);
  };

  const handleAddLayer = () => {
    const lastLayer = layers[layers.length - 1];
    setLayers([...layers, { ...lastLayer }]);
  };

  const handleRemoveLayer = (index) => {
    if (layers.length <= 1) {
      alert("Must have at least one layer");
      return;
    }
    setLayers(layers.filter((_, i) => i !== index));
  };

  const handleSubmit = ({ formData: basicFormData }) => {
    // Resolve layers from current mode
    const activeLayers = modelMode === 'structured'
      ? (() => {
          const n = structuredLayerCount();
          return Array.from({ length: n }, () => ({
            thickness: structuredParams.layerThickness,
            resistivity: structuredParams.resistivity
          }));
        })()
      : layers;

    // Validate layers
    const validLayers = activeLayers.filter(l => l.thickness > 0 && l.resistivity > 0);
    if (validLayers.length === 0) {
      alert("Please enter valid layer thicknesses and resistivities");
      return;
    }

    // Find selected system (the selector lives outside RJSF, so read from component state)
    const selectedSystem = systems.find(s => s.id === formData.system);

    // Generate xdist array
    const nSoundings = Math.floor(basicFormData.extent / basicFormData.spacing) + 1;
    const xdist = new Float64Array(nSoundings);
    for (let i = 0; i < nSoundings; i++) {
      xdist[i] = i * basicFormData.spacing;
    }

    // Generate UTM coordinates along bearing
    const bearingRad = (basicFormData.utmBearing * Math.PI) / 180;
    const utmx = new Float64Array(nSoundings);
    const utmy = new Float64Array(nSoundings);
    for (let i = 0; i < nSoundings; i++) {
      const dist = i * basicFormData.spacing;
      utmx[i] = basicFormData.utmStartX + dist * Math.sin(bearingRad);
      utmy[i] = basicFormData.utmStartY + dist * Math.cos(bearingRad);
    }

    // Calculate topography and flight altitude (linear ramp start → end)
    const topo = new Float64Array(nSoundings).fill(0);
    const txAltitude = new Float64Array(nSoundings);
    for (let i = 0; i < nSoundings; i++) {
      const t = nSoundings > 1 ? i / (nSoundings - 1) : 0;
      txAltitude[i] = basicFormData.altitudeStart + (basicFormData.altitudeEnd - basicFormData.altitudeStart) * t;
    }

    // Line column (all 0s for single flightline)
    const line = new Int32Array(nSoundings).fill(0);

    // Calculate layer depths and create layer data
    const thicknesses = validLayers.map(l => l.thickness);
    let cumDepth = 0;
    const layerDepths = [0];
    for (const thickness of thicknesses) {
      cumDepth += thickness;
      layerDepths.push(cumDepth);
    }

    // Build layer_data with plain objects (Maps can't be serialized by packBinary)
    const resistivity = {};
    const dep_top = {};
    const dep_bot = {};

    for (let layerIdx = 0; layerIdx < validLayers.length; layerIdx++) {
      // Resistivity for this layer
      const resArray = new Float64Array(nSoundings);
      resArray.fill(validLayers[layerIdx].resistivity);
      resistivity[layerIdx] = resArray;

      // Depth top and bottom
      const topArray = new Float64Array(nSoundings);
      const botArray = new Float64Array(nSoundings);
      topArray.fill(layerDepths[layerIdx]);
      botArray.fill(layerDepths[layerIdx + 1]);
      dep_top[layerIdx] = topArray;
      dep_bot[layerIdx] = botArray;
    }

    // Build XYZ data structure
    const xyzData = {
      model_info: {
        projection: basicFormData.projection,
        coordinate_system: `EPSG:${basicFormData.projection}`,
        created_by: 'AEM Model Simulator',
        created_at: new Date().toISOString(),
        flightline_name: 'Flightline 1'
      },
      flightlines: {
        xdist: xdist,
        UTMX: utmx,
        UTMY: utmy,
        Topography: topo,
        TxAltitude: txAltitude,
        Line: line
      },
      layer_data: {
        rho: resistivity,
        dep_top: dep_top,
        dep_bot: dep_bot
      },
      system: selectedSystem ? selectedSystem.gex : {}
    };

    // Create XYZ object
    const xyz = new XYZ(packBinary(xyzData));

    onCreate(xyz);
    onClose();
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000
    }}>
      <div style={{
        backgroundColor: 'white',
        padding: '20px',
        borderRadius: '8px',
        maxWidth: '600px',
        width: '90%',
        maxHeight: '90vh',
        overflow: 'auto'
      }}>
        <h2>Create New AEM Model</h2>

        {/* Layer mode toggle */}
        <div style={{ marginBottom: '15px', display: 'flex', gap: '20px' }}>
          {['structured', 'layered'].map(mode => (
            <label key={mode} style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '14px' }}>
              <input
                type="radio"
                name="modelMode"
                value={mode}
                checked={modelMode === mode}
                onChange={() => handleModeChange(mode)}
              />
              {mode === 'structured' ? 'Structured' : 'Layered'}
            </label>
          ))}
        </div>

        {/* EPSG Code Selector (outside of JSON Schema Form) */}
        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
            Coordinate System (EPSG) <span style={{ color: '#dc3545' }}>*</span>
          </label>
          <EPSGSelector
            value={formData.projection}
            onChange={(code) => setFormData({ ...formData, projection: code })}
            required={true}
          />
        </div>

        {/* Survey System selector (outside of JSON Schema Form so the + button stays
            visible even when the project has zero systems). */}
        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
            Survey System
          </label>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <select
              value={formData.system || ''}
              onChange={e => setFormData({ ...formData, system: e.target.value || null })}
              disabled={systems.length === 0}
              style={{ flex: 1, padding: '8px', border: '1px solid #ced4da', borderRadius: '4px', fontSize: '14px' }}
            >
              {systems.length === 0 && <option value="">No systems yet — add one →</option>}
              {systems.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setShowAddSystemDialog(true)}
              title="Add a survey system from a .gex file"
              style={{
                padding: '8px 12px',
                backgroundColor: '#28a745',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '18px',
                lineHeight: '1'
              }}
            >
              +
            </button>
          </div>
        </div>

        <Form
          key={`form-${systems.length}`}
          schema={schema}
          formData={formData}
          validator={validator}
          onChange={e => setFormData(e.formData)}
          onSubmit={handleSubmit}
        >
          {/* Layers definition */}
          <div style={{ marginTop: '20px', marginBottom: '20px' }}>
            <label style={{ display: 'block', marginBottom: '10px', fontSize: '14px', fontWeight: 'bold' }}>
              Layers
            </label>

            {modelMode === 'structured' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {[
                  { key: 'layerThickness', label: 'Layer thickness (m)', min: 0.5, step: 0.5 },
                  { key: 'totalDepth',     label: 'Total depth (m)',      min: 1,   step: 1   },
                  { key: 'resistivity',    label: 'Resistivity (Ω·m)',    min: 1,   step: 1   }
                ].map(({ key, label, min, step }) => (
                  <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <label style={{ width: '200px', fontSize: '14px' }}>{label}</label>
                    <input
                      type="number"
                      value={structuredParams[key]}
                      min={min}
                      step={step}
                      onChange={e => setStructuredParams(p => ({ ...p, [key]: parseFloat(e.target.value) || 0 }))}
                      style={{ width: '100px', padding: '6px', border: '1px solid #ced4da', borderRadius: '4px', fontSize: '14px' }}
                    />
                  </div>
                ))}
                <p style={{ margin: '6px 0 0', fontSize: '13px', color: '#6c757d' }}>
                  Generates {structuredLayerCount()} equal
                  layers of {structuredParams.layerThickness} m from 0 to {structuredParams.totalDepth} m,
                  all at {structuredParams.resistivity} Ω·m, with a half-space at the bottom.
                </p>
              </div>
            ) : (<>
            {/* Layered: existing table */}
            {(() => {
              // Compute dep_top / dep_bot for each layer from cumulative thickness
              let cum = 0;
              const bounds = layers.map(l => {
                const top = cum;
                cum += l.thickness;
                return { top, bot: cum };
              });

              const thStyle = { padding: '6px 8px', textAlign: 'left', borderBottom: '2px solid #dee2e6', whiteSpace: 'nowrap' };
              const tdRO = { padding: '4px 8px', color: '#6c757d', fontSize: '13px', whiteSpace: 'nowrap' };

              return (<>
            <div style={{
              border: '1px solid #dee2e6',
              borderRadius: '4px',
              overflow: 'auto',
              maxHeight: '300px'
            }}>
              <table style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: '14px'
              }}>
                <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                  <tr style={{ backgroundColor: '#f8f9fa' }}>
                    <th style={{ ...thStyle, width: '30px' }}>#</th>
                    <th style={{ ...thStyle, width: '70px' }}>Top (m)</th>
                    <th style={{ ...thStyle, width: '70px' }}>Bot (m)</th>
                    <th style={thStyle}>Thickness (m)</th>
                    <th style={thStyle}>Resistivity (Ωm)</th>
                    <th style={{ ...thStyle, width: '40px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {layers.map((layer, index) => (
                    <tr key={index} style={{ borderBottom: '1px solid #dee2e6' }}>
                      <td style={tdRO}>{index + 1}</td>
                      <td style={tdRO}>{bounds[index].top.toFixed(1)}</td>
                      <td style={tdRO}>{bounds[index].bot.toFixed(1)}</td>
                      <td style={{ padding: '4px' }}>
                        <input
                          type="number"
                          value={layer.thickness}
                          onChange={e => handleLayerChange(index, 'thickness', e.target.value)}
                          min="0.1"
                          step="0.1"
                          style={{
                            width: '100%',
                            padding: '6px',
                            border: '1px solid #ced4da',
                            borderRadius: '4px',
                            fontSize: '14px'
                          }}
                        />
                      </td>
                      <td style={{ padding: '4px' }}>
                        <input
                          type="number"
                          value={layer.resistivity}
                          onChange={e => handleLayerChange(index, 'resistivity', e.target.value)}
                          min="1"
                          step="1"
                          style={{
                            width: '100%',
                            padding: '6px',
                            border: '1px solid #ced4da',
                            borderRadius: '4px',
                            fontSize: '14px'
                          }}
                        />
                      </td>
                      <td style={{ padding: '4px', textAlign: 'center' }}>
                        <button
                          type="button"
                          onClick={() => handleRemoveLayer(index)}
                          disabled={layers.length <= 1}
                          style={{
                            padding: '4px 8px',
                            backgroundColor: layers.length <= 1 ? '#e9ecef' : '#dc3545',
                            color: layers.length <= 1 ? '#6c757d' : 'white',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: layers.length <= 1 ? 'not-allowed' : 'pointer',
                            fontSize: '16px',
                            lineHeight: '1'
                          }}
                          title="Remove layer"
                        >
                          −
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: '8px', display: 'flex', gap: '8px' }}>
              <button
                type="button"
                onClick={handleAddLayer}
                style={{
                  padding: '6px 12px',
                  backgroundColor: '#28a745',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '14px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px'
                }}
              >
                <span style={{ fontSize: '18px', lineHeight: '1' }}>+</span>
                Add Layer
              </button>
              <button
                type="button"
                onClick={() => {
                  const n = structuredLayerCount();
                  setLayers(Array.from({ length: n }, () => ({
                    thickness: structuredParams.layerThickness,
                    resistivity: structuredParams.resistivity
                  })));
                }}
                title="Replace table with uniform layers from current Structured params"
                style={{
                  padding: '6px 12px',
                  backgroundColor: '#6c757d',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '14px'
                }}
              >
                Reset from Structured
              </button>
            </div>
              </>);
            })()}
            </>)}
          </div>

          <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
            <button type="submit" style={{
              padding: '8px 16px',
              backgroundColor: '#007bff',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}>
              Create
            </button>
            <button type="button" onClick={onClose} style={{
              padding: '8px 16px',
              backgroundColor: '#6c757d',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}>
              Cancel
            </button>
          </div>
        </Form>
      </div>

      {showAddSystemDialog && (
        <AddSystemDialog
          onClose={() => setShowAddSystemDialog(false)}
          onCreate={(newSystemId) => setFormData(prev => ({ ...prev, system: newSystemId }))}
        />
      )}
    </div>
  );
}

export default CreateModelDialog;
