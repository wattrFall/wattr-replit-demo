/**
 * The fixed equipment catalogue: what can be placed, what it looks like, and
 * what can be tuned on it.
 *
 * Parameter ranges are chosen to be plausible for a small containerised hall
 * rather than to match any specific site. Defaults are picked so that the
 * starting presets sit in a healthy-but-not-trivial operating point — there is
 * headroom to make things worse, and headroom for the controller to make them
 * better.
 */
import type { ComponentKind, ParamSpec, Zone } from "./types";

export interface CatalogueEntry {
  kind: ComponentKind;
  label: string;
  /** One line, shown in the palette and read out by screen readers. */
  blurb: string;
  /**
   * Where this equipment belongs. Racks and the cooling that serves them
   * directly live on the raised floor; heat rejection lives outside it.
   */
  zone: Zone;
  /** Footprint in grid cells. */
  footprint: { w: number; d: number };
  /** Height in world units, for the 3D box. */
  height: number;
  /** Accent colour, taken from the site palette via lib/sandbox/tokens. */
  accent: string;
  /** Keyboard shortcut shown in the palette, Linear-style. */
  shortcut: string;
  params: ParamSpec[];
}

export const CATALOGUE: Record<ComponentKind, CatalogueEntry> = {
  rack: {
    kind: "rack",
    zone: "hall",
    label: "GPU rack",
    blurb: "A cabinet of accelerators. The heat source.",
    footprint: { w: 1, d: 1 },
    height: 1.5,
    accent: "#70A0D0",
    shortcut: "1",
    params: [
      {
        key: "itLoadKw",
        label: "IT load",
        unit: "kW",
        min: 2,
        max: 40,
        step: 0.5,
        default: 12,
        hint: "Electrical power drawn by the servers. All of it becomes heat.",
      },
      {
        key: "utilisationPct",
        label: "Utilisation",
        unit: "%",
        min: 0,
        max: 100,
        step: 1,
        default: 70,
        hint: "Scales the IT load. An idle rack still draws its static power.",
      },
      {
        key: "inletLimitC",
        label: "Inlet limit",
        unit: "°C",
        min: 18,
        max: 35,
        step: 0.5,
        default: 27,
        hint: "Above this inlet temperature the rack is considered at risk.",
      },
      {
        key: "rackUnits",
        label: "Height",
        unit: "U",
        min: 12,
        max: 48,
        step: 2,
        default: 42,
        hint: "Cabinet size. Taller cabinets concentrate more heat per tile.",
      },
    ],
  },

  crac: {
    kind: "crac",
    zone: "hall",
    label: "CRAC unit",
    blurb: "Computer-room air handler. Moves cold air to the racks.",
    footprint: { w: 1, d: 1 },
    height: 1.2,
    accent: "#2DD4BF",
    shortcut: "2",
    params: [
      {
        key: "supplyAirC",
        label: "Supply air",
        unit: "°C",
        min: 12,
        max: 24,
        step: 0.5,
        // Conservative, as legacy halls are commonly run. ASHRAE allows far
        // warmer; the gap between the two is what a controller can recover.
        default: 16,
        hint: "Setpoint for air leaving the unit. Colder costs more.",
      },
      {
        key: "fanSpeedPct",
        label: "Fan speed",
        unit: "%",
        min: 0,
        max: 100,
        step: 1,
        default: 70,
        hint: "Fan power rises roughly with the square of speed.",
      },
      {
        key: "capacityKw",
        label: "Capacity",
        unit: "kW",
        min: 20,
        max: 150,
        step: 5,
        default: 60,
        hint: "Rated sensible cooling. Load beyond this cannot be removed.",
      },
      {
        key: "airflowCmh",
        label: "Airflow",
        unit: "m³/h",
        min: 2000,
        max: 20000,
        step: 500,
        default: 9000,
        hint: "Volume delivered at full speed. Sets how far cold air reaches.",
      },
    ],
  },

  cdu: {
    kind: "cdu",
    zone: "hall",
    label: "CDU",
    blurb: "Coolant distribution unit for direct-to-chip liquid loops.",
    footprint: { w: 1, d: 1 },
    height: 1.3,
    accent: "#27E0D0",
    shortcut: "3",
    params: [
      {
        key: "supplyWaterC",
        label: "Supply water",
        unit: "°C",
        min: 15,
        max: 35,
        step: 0.5,
        default: 21,
        hint: "Temperature of coolant sent to the cold plates.",
      },
      {
        key: "pumpSpeedPct",
        label: "Pump speed",
        unit: "%",
        min: 20,
        max: 100,
        step: 1,
        default: 85,
        hint: "Sets loop flow rate. Pump power rises steeply with speed.",
      },
      {
        key: "capacityKw",
        label: "Capacity",
        unit: "kW",
        min: 30,
        max: 200,
        step: 5,
        default: 60,
        hint: "Rated heat the exchanger can move to the facility side.",
      },
      {
        key: "approachK",
        label: "Approach",
        unit: "K",
        min: 2,
        max: 12,
        step: 0.5,
        default: 5,
        hint: "Exchanger penalty: how far above facility water the loop sits.",
      },
    ],
  },

  chiller: {
    kind: "chiller",
    zone: "plant",
    label: "Chiller",
    blurb: "Rejects the hall's heat to outside. The big electrical load.",
    footprint: { w: 2, d: 1 },
    height: 1.1,
    accent: "#9EBFDF",
    shortcut: "4",
    params: [
      {
        key: "chilledWaterC",
        label: "Chilled water",
        unit: "°C",
        min: 6,
        max: 20,
        step: 0.5,
        // Same reasoning as the CRAC setpoint: a typical as-found value, not
        // an efficient one.
        default: 9,
        hint: "Facility water setpoint. Raising it improves efficiency.",
      },
      {
        key: "capacityKw",
        label: "Capacity",
        unit: "kW",
        min: 50,
        max: 500,
        step: 10,
        default: 200,
        hint: "Rated rejection. The ceiling for everything upstream.",
      },
      {
        key: "ambientC",
        label: "Ambient",
        unit: "°C",
        min: -5,
        max: 45,
        step: 1,
        default: 24,
        hint: "Outside air. Hot days cost the chiller efficiency.",
      },
    ],
  },

  sensor: {
    kind: "sensor",
    zone: "hall",
    label: "Sensor",
    blurb: "Reports inlet temperature from a point on the floor.",
    footprint: { w: 1, d: 1 },
    height: 0.35,
    accent: "#F59E0B",
    shortcut: "5",
    params: [
      {
        key: "alarmAtC",
        label: "Alarm at",
        unit: "°C",
        min: 20,
        max: 40,
        step: 0.5,
        default: 30,
        hint: "Raises a caution state when the local reading exceeds this.",
      },
      {
        key: "offsetC",
        label: "Calibration",
        unit: "K",
        min: -3,
        max: 3,
        step: 0.1,
        default: 0,
        hint: "Fixed offset applied to the reading.",
      },
      {
        key: "samplePeriodS",
        label: "Sample period",
        unit: "s",
        min: 1,
        max: 60,
        step: 1,
        default: 10,
        hint: "How often the point is read. Affects display smoothing only.",
      },
    ],
  },
};

/** Palette order — also the order the number-key shortcuts follow. */
export const PALETTE_ORDER: ComponentKind[] = ["rack", "crac", "cdu", "chiller", "sensor"];

/** Build a fresh param map from the catalogue defaults. */
export function defaultParams(kind: ComponentKind): Record<string, number> {
  const out: Record<string, number> = {};
  for (const spec of CATALOGUE[kind].params) out[spec.key] = spec.default;
  return out;
}
