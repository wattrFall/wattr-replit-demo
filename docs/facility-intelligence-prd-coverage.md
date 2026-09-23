# Facility Intelligence, Import & Scenario Replay — implemented MVP

## Available workflows

- **Facility intelligence:** active-model asset records, canonical layout IDs, floor/zone filters and breadcrumbs, search by identity/equipment metadata, Physical/Cooling/Power/Telemetry views, asset history links, model-backed KPI contributors, and raw simulated time series. Operations IT power and peak inlet link into investigation; asset inspection links back to the twin with replay time preserved.
- **Engineering imports:** persisted PDF/PNG/JPEG/SVG reference files and IFC STEP imports, source identifiers/properties/storeys, supported placement geometry preview, explicit per-object Confirm/Modify/Ignore decisions, editable grid placement, and creation of a Builder draft. Reference layers are available in Builder. Imported/site values take precedence over catalogue defaults.
- **Configuration history:** append-only published model changes, canonical affected asset IDs, before/after values, rack relocation events, responsible actor, and model-state selection for replay. Existing decision audit remains separate.
- **Historical scenario replay:** validated CSV input or separately labelled synthetic demo inputs, selected input period and model version, isolated rack relocation, immutable baseline/dataset/results, saved engineering-review scenario, thermal comparison, paired spatial maps, and raw time series. Both branches use identical input rows and initial state.

## Deliberate limits—not completed production capabilities

- IFC support preserves STEP metadata, placements, and supported point/representation information. It does not provide general BRep/swept-solid tessellation, native RVT/DWG, IFCZIP, or complete CAD reconstruction. Unsupported geometry is disclosed.
- The equipment catalogue contains explicitly illustrative Wattr demonstration models, **not certified manufacturer specifications**. A sourced manufacturer catalogue remains further work.
- Asset operating readings are deterministic **simulated** telemetry, not live sensors. The model does not justify per-device cooling energy allocation or energy-saving claims.
- Spatial replay is an **uncalibrated approximation**, not validated CFD. Missing initial inlet measurements cause an explicitly disclosed 30°C synthetic starting-state assumption. Historical CSV input alone does not validate predictions.
- Existing Builder demo edit/publish permissions remain unchanged. New import writes require engineering or model-edit capability; replay writes require engineering capability; reads require a facility view grant. No workflow sends equipment commands.

## Regression evidence

The release gate includes facility-intelligence contracts, IFC parsing/calibration and viewer-denial tests, deterministic historical replay invariants, and API/browser integration covering asset→twin time continuity, saved replay comparisons, floor-plan upload and draft creation. Existing migration, authorization, assistant, decision, browser accessibility, and performance checks remain in place.