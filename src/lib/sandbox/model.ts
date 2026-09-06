/**
 * =============================================================================
 * SANDBOX THERMAL / POWER MODEL
 * =============================================================================
 *
 * A browser-side approximation of the dynamics in our Gymnasium environment
 * `ToyDCCoolingEnv` (WattrTech, experiments/legacy_snn_ppo/toy_dc_cooling_env.py).
 *
 * It exists to make the demo page *legible*, not to be accurate. It is
 * deliberately separate from rendering and UI — nothing here imports React or
 * three — so it can be replaced by a real backend call without touching the
 * scene.
 *
 * -----------------------------------------------------------------------------
 * VARIABLE MAPPING  (Python  ->  TypeScript)
 * -----------------------------------------------------------------------------
 *   _zone_temp          ->  RackState.inletC, one per rack instead of one per
 *                           hall. The env models a single zone; the sandbox
 *                           lets you place many racks, so the zone temperature
 *                           becomes a per-rack inlet temperature.
 *   _it_load    [0..1]   ->  rackLoadFraction(): the rack's actual heat divided
 *                           by the cooling capacity actually serving it. In the
 *                           env this is an exogenous AR(1) trace; here it is
 *                           whatever the user dialled in, which is the point of
 *                           the page.
 *   action / _fan_speeds ->  CRAC fanSpeedPct and CDU pumpSpeedPct, one per
 *                           placed unit rather than a fixed two ACUs.
 *   _ambient             ->  the chiller's `ambientC` parameter. The env drifts
 *                           it randomly; here the user sets it and it holds.
 *   W  = 0.4             ->  W_HEAT, unchanged.
 *   C  = 0.8             ->  C_COOL, unchanged.
 *   T_MIN / T_MAX        ->  T_MIN / T_MAX, unchanged (20 / 50 degC).
 *   T_AMBIENT_MEAN = 28  ->  AMBIENT_REF_C, used as the chiller's reference
 *                           condition rather than a drifting state.
 *   T_THRESHOLD = 38     ->  the rack's own `inletLimitC` parameter. The env
 *                           has one global throttle point; making it per-rack
 *                           is what lets the inspector expose it.
 *   energy = sum(fan^2)  ->  fanPowerKw(), which keeps the quadratic in fan
 *                           speed and scales it by the unit's rated capacity.
 *   reward               ->  NOT modelled. The page shows telemetry, not a
 *                           return. The reward's *shape* survives as the Wattr
 *                           controller's objective: hold temperature under the
 *                           limit while spending as little fan as possible.
 *
 * -----------------------------------------------------------------------------
 * WHERE THIS DEVIATES FROM THE ENV  (all deliberate, all listed)
 * -----------------------------------------------------------------------------
 * 1. RESTORING TERM — the significant one.
 *    The env's update is  T += W*load - C*fan,  a constant drift for constant
 *    inputs. It has NO interior equilibrium: temperature ramps until it hits
 *    the clip at T_MIN or T_MAX. That is fine for a 200-step episode, but on a
 *    page that runs continuously every rack would pin to 20 or 50 degC within
 *    seconds and nothing the user did would look like it mattered.
 *    So cooling here is proportional to how far the rack sits above the air or
 *    water being supplied to it:
 *
 *        T += W*load - C*fan * (T - supplyC) / DELTA_REF_K
 *
 *    This keeps every qualitative relationship the env has — more load is
 *    hotter, more fan is colder — and adds the one the env lacks: a stable
 *    operating point that also responds to the setpoint.
 *
 * 2. NO STOCHASTICITY. The env has NOISE_STD on temperature, an AR(1) load
 *    trace and a drifting ambient. All removed: the sandbox must be
 *    deterministic, and sensor noise on a marketing page reads as a bug.
 *
 * 3. SETPOINT, PUE, CHILLER AND CAPACITY ARE INVENTED. The env has no supply
 *    temperature, no power model, no PUE and no equipment topology. Everything
 *    in the "EXTENSIONS" section below has no counterpart in the Python and is
 *    ours. It is shaped to be plausible, not validated.
 *
 * 4. THE ENV'S TREND PENALTY IS NOT REPRODUCED. In the Python,
 *    `_prev_zone_temp` is assigned the literal 33.0 immediately before
 *    `temp_trend` is computed, so that term is really a second soft threshold
 *    at 33 degC rather than a trend. We model neither, since we model no reward.
 *
 * 5. FIXED TIMESTEP. The env steps once per action; here time advances in
 *    fixed SIM_DT_S slices accumulated across animation frames, so behaviour
 *    does not change with frame rate.
 * =============================================================================
 */
import { CATALOGUE } from "./catalogue";
import type { ControlMode, SandboxItem, SandboxLayout } from "./types";

// ---------------------------------------------------------------------------
// Constants carried over from the Python env, unchanged.
// ---------------------------------------------------------------------------
const W_HEAT = 0.4; // heating per unit normalised IT load, per env step
const C_COOL = 0.8; // cooling per unit fan speed, per env step
const T_MIN = 20.0;
const T_MAX = 50.0;
const AMBIENT_REF_C = 28.0; // env T_AMBIENT_MEAN

// ---------------------------------------------------------------------------
// EXTENSIONS — no counterpart in the Python env.
// ---------------------------------------------------------------------------

/** Reference temperature rise across a rack, setting the restoring term's gain. */
const DELTA_REF_K = 16;

/** Env steps per simulated second, and the fixed slice we integrate in. */
const STEPS_PER_SECOND = 6;
/**
 * One integration slice of simulated time. The caller accumulates real elapsed
 * time and hands over whole slices, so wall-clock behaviour is identical at
 * 30, 60 or 120fps.
 */
export const SIM_DT_S = 1 / 30;
/** Most slices one call will integrate, so a backgrounded tab cannot spiral. */
export const MAX_SLICES_PER_CALL = 8;

/** Fan/pump power at full speed, per kW of rated capacity. */
const FAN_KW_PER_CAPACITY_KW = 0.021;

/**
 * Airflow a CRAC is expected to move for its rated capacity. A unit rated well
 * below this cannot deliver its nameplate cooling however hard its fan works —
 * which is what the airflow parameter is for.
 */
const AIRFLOW_REF_CMH = 9000;

/** Cabinet height the thermal model is tuned around. */
const RACK_UNITS_REF = 42;

/** Chiller coefficient of performance at the reference condition. */
const COP_REF = 4.6;
/** COP improves as chilled water is raised, and decays as ambient climbs. */
const COP_PER_K_CHILLED = 0.13;
const COP_PER_K_AMBIENT = 0.055;
const COP_MIN = 1.4;

/** A cooling unit with no chiller behind it cannot hold its setpoint. */
const UNCHILLED_PENALTY_K = 9;

/** Wattr control aims this far below a rack's limit rather than at it. */
const CONTROL_MARGIN_K = 2.0;
/** The fan speed the controller prefers before it starts trading setpoint. */
const CONTROL_FAN_SWEET = 0.55;
const CONTROL_FAN_MIN = 0.2;
/** Highest chilled-water setpoint the controller will reset up to. */
const CHILLED_WATER_MAX_C = 20;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Effective operating point of one cooling unit after control is applied. */
export interface UnitControls {
  id: string;
  /** 0..1. CRAC fan speed or CDU pump speed. */
  fan: number;
  /** degC. Air or water temperature this unit supplies. */
  supplyC: number;
  /** kW of rated capacity. */
  capacityKw: number;
  /** True when a chiller feeds this unit. */
  chilled: boolean;
  /** 0..1. How much of the fan's effort actually reaches the racks. */
  airflow: number;
}

/** The plant's resolved operating point: every unit, plus the water it draws on. */
export interface Plant {
  controls: UnitControls[];
  /** Effective chilled-water setpoint, or null when no chiller is placed. */
  chilledWaterC: number | null;
  ambientC: number;
}

/** Mutable simulation state. One inlet temperature per rack. */
export interface SimState {
  inletC: Record<string, number>;
}

/** Everything the UI reads. Derived, never stored. */
export interface Telemetry {
  itPowerKw: number;
  fanPowerKw: number;
  chillerPowerKw: number;
  totalPowerKw: number;
  /** Total facility power divided by IT power. Infinity with no IT load. */
  pue: number | null;
  meanInletC: number | null;
  maxInletC: number | null;
  /** Racks at or above their own inlet limit. */
  racksAtRisk: number;
  /** Racks with no cooling unit connected. */
  unservedRacks: number;
  rackCount: number;
  /** Effective chilled-water setpoint, so the UI can show a control reset. */
  chilledWaterC: number | null;
  /** Mean fan/pump command across cooling units, 0..1. */
  meanFan: number | null;
  coolingUnitCount: number;
}

// ---------------------------------------------------------------------------
// Layout queries
// ---------------------------------------------------------------------------

const isCooling = (item: SandboxItem) => item.kind === "crac" || item.kind === "cdu";

/** The cooling units connected to a given rack. */
function unitsServing(layout: SandboxLayout, rackId: string): SandboxItem[] {
  return layout.connections
    .filter((c) => c.toId === rackId)
    .map((c) => layout.items.find((i) => i.id === c.fromId))
    .filter((i): i is SandboxItem => !!i && isCooling(i));
}

/** The racks a given cooling unit feeds. */
function racksServed(layout: SandboxLayout, unitId: string): SandboxItem[] {
  return layout.connections
    .filter((c) => c.fromId === unitId)
    .map((c) => layout.items.find((i) => i.id === c.toId))
    .filter((i): i is SandboxItem => !!i && i.kind === "rack");
}

/** Whether a chiller feeds this cooling unit. */
function hasChiller(layout: SandboxLayout, unitId: string): boolean {
  return layout.connections.some((c) => {
    if (c.toId !== unitId) return false;
    const source = layout.items.find((i) => i.id === c.fromId);
    return source?.kind === "chiller";
  });
}

/**
 * How well a unit converts fan effort into delivered cooling.
 *
 * EXTENSION — the env has no airflow term. A CRAC with too little airflow for
 * its capacity is throughput-limited: the fan spins, the air does not arrive.
 * Square-rooted so the penalty is gentle rather than a cliff, and capped at 1
 * so oversized airflow buys nothing on its own.
 */
export function airflowFactor(unit: SandboxItem): number {
  if (unit.kind !== "crac") return 1;
  const airflow = unit.params.airflowCmh ?? AIRFLOW_REF_CMH;
  const capacity = unit.params.capacityKw ?? 60;
  // Scale the reference by capacity: a 120 kW unit needs twice the air.
  const needed = AIRFLOW_REF_CMH * (capacity / 60);
  return Math.min(1, Math.sqrt(airflow / Math.max(1, needed)));
}

/**
 * Heat concentration penalty for tall cabinets.
 *
 * EXTENSION — the env has no rack geometry. The same kilowatts packed into a
 * taller cabinet sit further from the supply air at the top, so the inlet the
 * model reports rises slightly. Deliberately small: it should be felt, not
 * dominate.
 */
export function rackDensityFactor(rack: SandboxItem): number {
  const units = rack.params.rackUnits ?? RACK_UNITS_REF;
  return 1 + (units - RACK_UNITS_REF) / RACK_UNITS_REF * 0.18;
}

/** Heat produced by a rack, in kW. Utilisation scales the installed load. */
export function rackHeatKw(rack: SandboxItem): number {
  const spec = CATALOGUE.rack.params;
  const load = rack.params.itLoadKw ?? spec[0].default;
  const util = (rack.params.utilisationPct ?? spec[1].default) / 100;
  return load * util;
}

/** The chilled-water temperature available to the hall, if any chiller exists. */
function facilityWaterC(layout: SandboxLayout): number | null {
  const chillers = layout.items.filter((i) => i.kind === "chiller");
  if (chillers.length === 0) return null;
  // Several chillers: the coldest one sets what the hall can draw on.
  return Math.min(...chillers.map((c) => c.params.chilledWaterC ?? 12));
}

// ---------------------------------------------------------------------------
// Control resolution
// ---------------------------------------------------------------------------

/**
 * The operating point the whole plant actually runs at.
 *
 * In "baseline" this is simply what the user dialled into the inspector — the
 * fixed setpoints and fixed fan speeds a hall runs on when nobody is closing
 * the loop.
 *
 * In "wattr" it is a SCRIPTED approximation of good control. It is not a
 * trained policy and makes no claim to be one. It pursues the same objective
 * the env's reward encodes — keep temperature under the limit, spend as little
 * fan as possible — with three moves an operator would recognise:
 *
 *   1. Stop overcooling. Raise each unit's supply temperature until the warmest
 *      rack it serves sits CONTROL_MARGIN_K below that rack's own limit.
 *   2. Reset the chilled water up to the warmest setting those supplies still
 *      allow. Compressor efficiency improves as the water it makes gets warmer,
 *      so this is where most of the saving is.
 *   3. Trim each fan to what the chosen supply actually requires, rather than
 *      leaving it parked. Fan power goes as the square of speed, so trimming is
 *      worth more than it looks.
 *
 * Resolved as a whole because step 2 depends on step 1 across every unit: the
 * water can only be raised as far as the most demanding unit permits.
 */
export function resolvePlant(layout: SandboxLayout, mode: ControlMode): Plant {
  const units = layout.items.filter(isCooling);
  const chillers = layout.items.filter((i) => i.kind === "chiller");
  const ambientC =
    chillers.length > 0
      ? Math.min(...chillers.map((c) => c.params.ambientC ?? AMBIENT_REF_C))
      : AMBIENT_REF_C;
  const userWaterC = facilityWaterC(layout);

  const approachOf = (unit: SandboxItem) =>
    unit.kind === "cdu" ? (unit.params.approachK ?? 5) : 0;

  const setpointOf = (unit: SandboxItem) =>
    unit.kind === "crac" ? (unit.params.supplyAirC ?? 18) : (unit.params.supplyWaterC ?? 21);

  const fanOf = (unit: SandboxItem) =>
    unit.kind === "crac"
      ? (unit.params.fanSpeedPct ?? 60) / 100
      : (unit.params.pumpSpeedPct ?? 85) / 100;

  /**
   * Supply temperature that lands the warmest served rack on its target at the
   * preferred fan speed. Inverts the steady state of the update in stepSim:
   *     0 = W*load - C*fan*(target - supply)/DELTA_REF_K
   *  => supply = target - W*load*DELTA_REF_K / (C*fan)
   */
  const desiredSupply = (unit: SandboxItem): number | null => {
    const served = racksServed(layout, unit.id);
    if (served.length === 0) return null;
    const target = Math.min(...served.map((r) => (r.params.inletLimitC ?? 27) - CONTROL_MARGIN_K));
    const load = Math.max(...served.map((r) => rackLoadFraction(layout, r)));
    return Math.min(
      target - 1,
      target - (W_HEAT * load * DELTA_REF_K) / (C_COOL * CONTROL_FAN_SWEET),
    );
  };

  // Step 2: how far the chilled water may be reset upward.
  let chilledWaterC = userWaterC;
  if (mode === "wattr" && userWaterC !== null) {
    const demands = units
      .map((unit) => {
        const supply = desiredSupply(unit);
        return supply === null ? null : supply - approachOf(unit);
      })
      .filter((v): v is number => v !== null);

    const allowed = demands.length > 0 ? Math.min(...demands) : CHILLED_WATER_MAX_C;
    chilledWaterC = Math.min(CHILLED_WATER_MAX_C, Math.max(userWaterC, allowed));
  }

  const controls = units.map((unit): UnitControls => {
    const chilled = hasChiller(layout, unit.id);
    const capacityKw = unit.params.capacityKw ?? 60;
    const approach = approachOf(unit);

    // A unit cannot supply colder than the water it draws on plus its exchanger
    // approach; with no chiller behind it, it drifts warm.
    const floorC =
      chilled && chilledWaterC !== null
        ? chilledWaterC + approach
        : AMBIENT_REF_C - UNCHILLED_PENALTY_K;

    if (mode === "baseline") {
      return {
        id: unit.id,
        fan: fanOf(unit),
        supplyC: Math.max(setpointOf(unit), floorC),
        capacityKw,
        chilled,
        airflow: airflowFactor(unit),
      };
    }

    const served = racksServed(layout, unit.id);
    if (served.length === 0) {
      // Nothing to cool: idle it rather than blowing at an empty floor.
      return {
        id: unit.id,
        fan: CONTROL_FAN_MIN,
        supplyC: Math.max(setpointOf(unit), floorC),
        capacityKw,
        chilled,
        airflow: airflowFactor(unit),
      };
    }

    const target = Math.min(...served.map((r) => (r.params.inletLimitC ?? 27) - CONTROL_MARGIN_K));
    const load = Math.max(...served.map((r) => rackLoadFraction(layout, r)));
    const supplyC = Math.max(floorC, desiredSupply(unit) ?? floorC);

    // Step 3: take only the fan the chosen supply actually needs.
    const headroom = Math.max(0.5, target - supplyC);
    const fanNeeded = (W_HEAT * load * DELTA_REF_K) / (C_COOL * headroom);

    return {
      id: unit.id,
      fan: Math.min(1, Math.max(CONTROL_FAN_MIN, fanNeeded)),
      supplyC,
      capacityKw,
      chilled,
      airflow: airflowFactor(unit),
    };
  });

  return { controls, chilledWaterC, ambientC };
}

/**
 * A rack's heat as a fraction of the cooling capacity actually serving it.
 *
 * This is the env's `it_load` in [0, 1]: 1.0 means the rack is asking for
 * exactly as much as its cooling can give. An unserved rack has no denominator,
 * so it reports 1.0 and runs away, matching the env's always_off behaviour.
 */
export function rackLoadFraction(layout: SandboxLayout, rack: SandboxItem): number {
  const heat = rackHeatKw(rack);
  const units = unitsServing(layout, rack.id);
  if (units.length === 0) return 1;

  // A unit's capacity is shared evenly across every rack it feeds.
  const available = units.reduce((sum, unit) => {
    const shared = Math.max(1, racksServed(layout, unit.id).length);
    return sum + (unit.params.capacityKw ?? 60) / shared;
  }, 0);

  if (available <= 0) return 1;
  return Math.min(1.5, heat / available);
}

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

/** Fresh state: every rack starts at the env's T_INIT_MEAN. */
export function createSimState(layout: SandboxLayout): SimState {
  const inletC: Record<string, number> = {};
  for (const item of layout.items) {
    if (item.kind === "rack") inletC[item.id] = 30.0; // env T_INIT_MEAN
  }
  return { inletC };
}

/**
 * Advance the model by exactly `slices` fixed timesteps of SIM_DT_S.
 *
 * The caller owns the accumulator that turns elapsed real time into whole
 * slices — doing it here would mean rounding a partial slice away every frame,
 * which makes simulated time run fast at high frame rates.
 *
 * Returns a NEW state; the caller owns the old one.
 */
export function stepSim(
  state: SimState,
  layout: SandboxLayout,
  mode: ControlMode,
  slices: number,
): SimState {
  const { controls } = resolvePlant(layout, mode);
  const byId = new Map(controls.map((c) => [c.id, c]));
  const inletC: Record<string, number> = {};

  const stepCount = Math.max(0, Math.min(MAX_SLICES_PER_CALL, Math.floor(slices)));
  const stepScale = SIM_DT_S * STEPS_PER_SECOND;

  for (const rack of layout.items) {
    if (rack.kind !== "rack") continue;

    const load = rackLoadFraction(layout, rack);
    const units = unitsServing(layout, rack.id)
      .map((u) => byId.get(u.id))
      .filter((c): c is UnitControls => !!c);

    // Several units on one rack act together: mean supply, summed fan effort,
    // which mirrors the env taking the mean of its two ACU fan speeds.
    // Airflow limits what the fan actually delivers (see airflowFactor).
    const fan =
      units.reduce((sum, u) => sum + u.fan * u.airflow, 0) / Math.max(1, units.length);
    const supplyC =
      units.length === 0
        ? AMBIENT_REF_C
        : units.reduce((sum, u) => sum + u.supplyC, 0) / units.length;

    let temp = state.inletC[rack.id] ?? 30.0;

    for (let i = 0; i < stepCount; i++) {
      // env:  T += W*load - C*fan
      // here: the cooling term is scaled by how far the rack sits above supply,
      // which is the restoring force the env does not have (deviation 1).
      const heating = W_HEAT * load * rackDensityFactor(rack);
      const cooling = units.length === 0 ? 0 : (C_COOL * fan * (temp - supplyC)) / DELTA_REF_K;
      temp += (heating - cooling) * stepScale;
      temp = Math.min(T_MAX, Math.max(T_MIN, temp));
    }

    inletC[rack.id] = temp;
  }

  return { inletC };
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/** Fan/pump electrical power. Keeps the env's quadratic in fan speed. */
function fanPowerKw(control: UnitControls): number {
  return FAN_KW_PER_CAPACITY_KW * control.capacityKw * control.fan * control.fan;
}

/** Chiller COP at the current setpoint and ambient. Extension; see header. */
function chillerCop(chilledWaterC: number, ambientC: number): number {
  const cop =
    COP_REF +
    (chilledWaterC - 12) * COP_PER_K_CHILLED -
    (ambientC - AMBIENT_REF_C) * COP_PER_K_AMBIENT;
  return Math.max(COP_MIN, cop);
}

/** Everything the panels display, derived from state + layout + control mode. */
export function readTelemetry(
  state: SimState,
  layout: SandboxLayout,
  mode: ControlMode,
): Telemetry {
  const racks = layout.items.filter((i) => i.kind === "rack");
  const { controls, chilledWaterC, ambientC } = resolvePlant(layout, mode);

  const itPowerKw = racks.reduce((sum, r) => sum + rackHeatKw(r), 0);
  const fanPower = controls.reduce((sum, c) => sum + fanPowerKw(c), 0);

  // Chiller work is the heat the cooling units actually move, over the COP of
  // the coldest chiller present. With no chiller there is no compressor power —
  // and the racks are already running hot in the integration above.
  let chillerPowerKw = 0;
  if (chilledWaterC !== null) {
    const servedHeat = racks
      .filter((r) => unitsServing(layout, r.id).length > 0)
      .reduce((sum, r) => sum + rackHeatKw(r), 0);
    chillerPowerKw = servedHeat / chillerCop(chilledWaterC, ambientC);
  }

  const temps = racks.map((r) => state.inletC[r.id]).filter((t): t is number => t !== undefined);
  const totalPowerKw = itPowerKw + fanPower + chillerPowerKw;

  return {
    itPowerKw,
    fanPowerKw: fanPower,
    chillerPowerKw,
    totalPowerKw,
    pue: itPowerKw > 0 ? totalPowerKw / itPowerKw : null,
    meanInletC: temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null,
    maxInletC: temps.length ? Math.max(...temps) : null,
    racksAtRisk: racks.filter((r) => {
      const t = state.inletC[r.id];
      return t !== undefined && t >= (r.params.inletLimitC ?? 27);
    }).length,
    unservedRacks: racks.filter((r) => unitsServing(layout, r.id).length === 0).length,
    rackCount: racks.length,
    chilledWaterC,
    meanFan: controls.length
      ? controls.reduce((sum, c) => sum + c.fan, 0) / controls.length
      : null,
    coolingUnitCount: controls.length,
  };
}

/**
 * 0 = comfortably cold, 1 = at the rack's limit, >1 = over it.
 * Drives the heat overlay colour.
 */
export function rackHeatFraction(rack: SandboxItem, inletC: number | undefined): number {
  if (inletC === undefined) return 0;
  const limit = rack.params.inletLimitC ?? 27;
  return Math.max(0, (inletC - T_MIN) / Math.max(1, limit - T_MIN));
}
