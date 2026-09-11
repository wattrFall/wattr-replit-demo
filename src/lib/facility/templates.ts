/**
 * Starting points for a facility build.
 *
 * Each template is a complete design that passes the design checks, sized at
 * facility scale. The liquid-cooled GPU hall is the SFO-01 reference facility:
 * its racks, CDU, chiller, parameters, ids and connections are exactly the ones
 * the replay simulation has always modelled, so starting from it changes
 * nothing about the numbers Operations shows.
 */
import { defaultParams } from "@/lib/sandbox/catalogue";
import type { ComponentKind, Connection, Preset, SandboxItem, ZoneSpec } from "@/lib/sandbox/types";

export const SFO_01_TEMPLATE_ID = "liquid-gpu-hall";

function unit(id: string, kind: ComponentKind, x: number, z: number, params: Record<string, number> = {}): SandboxItem {
  return { id, kind, cell: { x, z }, params: { ...defaultParams(kind), ...params } };
}

const link = (id: string, fromId: string, toId: string): Connection => ({ id, fromId, toId });

/** Sensor links for a row of racks, one per rack. */
const covers = (sensor: SandboxItem, racks: SandboxItem[]) =>
  racks.map((rack) => link(`link-${sensor.id}-${rack.id}`, sensor.id, rack.id));

/**
 * SFO-01: four GPU training racks in GPU Hall B, fed coolant by CDU-03, whose
 * heat Chiller-01 rejects in the plant yard.
 *
 * The rack, CDU and chiller parameters and the link ids match the replay
 * model's reference layout. The ramp and any advisory command are applied on
 * top of these values at replay time, as they always have been.
 */
function liquidGpuHall(): Preset {
  const hall: ZoneSpec = { id: "zone-gpu-hall-b", name: "GPU Hall B", kind: "compute", x: 14, z: 12, w: 12, d: 8 };
  const plant: ZoneSpec = { id: "zone-plant-yard", name: "Plant yard", kind: "plant", x: 27, z: 12, w: 5, d: 8 };
  const rackParams = { itLoadKw: 500, utilisationPct: 82, inletLimitC: 32, rackUnits: 42 };
  const racks = (
    [
      ["rack-a01", 3, 2],
      ["rack-a02", 5, 2],
      ["rack-b01", 3, 5],
      ["rack-b02", 5, 5],
    ] as const
  ).map(([id, dx, dz]) => unit(id, "rack", hall.x + dx, hall.z + dz, rackParams));
  const cdu = unit("cdu-03", "cdu", hall.x + 9, hall.z + 3, {
    pumpSpeedPct: 70,
    supplyWaterC: 21,
    capacityKw: 1_800,
    approachK: 5,
    loopDeltaK: 9,
  });
  const chiller = unit("chiller-01", "chiller", plant.x + 1, plant.z + 3, {
    chilledWaterC: 12,
    ambientC: 28,
    capacityKw: 2_160,
  });
  const rowA = unit("sensor-01", "sensor", hall.x + 7, hall.z + 2);
  const rowB = unit("sensor-02", "sensor", hall.x + 7, hall.z + 5);

  return {
    id: SFO_01_TEMPLATE_ID,
    name: "Liquid-cooled GPU hall",
    description: "The SFO-01 reference: four GPU training racks on CDU-03, rejected by Chiller-01.",
    layout: {
      zones: [hall, plant],
      // Chiller, CDU, then racks: the order the replay model has always used.
      items: [chiller, cdu, ...racks, rowA, rowB],
      connections: [
        link("link-chiller-cdu", chiller.id, cdu.id),
        ...racks.map((rack) => link(`link-cdu-${rack.id}`, cdu.id, rack.id)),
        ...covers(rowA, racks.slice(0, 2)),
        ...covers(rowB, racks.slice(2)),
      ],
    },
  };
}

/** Two rows of air-cooled racks, a CRAC unit per row, and one chiller carrying both. */
function airCooledRows(): Preset {
  const hall: ZoneSpec = { id: "zone-data-hall", name: "Data hall", kind: "compute", x: 12, z: 11, w: 16, d: 10 };
  const plant: ZoneSpec = { id: "zone-plant-yard", name: "Plant yard", kind: "plant", x: 29, z: 11, w: 5, d: 10 };
  const rackParams = { itLoadKw: 30, utilisationPct: 75, inletLimitC: 27 };
  const row = (letter: string, dz: number) =>
    [0, 1, 2, 3, 4, 5].map((i) =>
      unit(`rack-${letter}${String(i + 1).padStart(2, "0")}`, "rack", hall.x + 3 + i, hall.z + dz, rackParams),
    );
  const rowA = row("a", 3);
  const rowB = row("b", 6);
  const cracParams = { capacityKw: 180, airflowCmh: 27_000, supplyAirC: 16, fanSpeedPct: 70 };
  const cracA = unit("crac-01", "crac", hall.x + 11, hall.z + 3, cracParams);
  const cracB = unit("crac-02", "crac", hall.x + 11, hall.z + 6, cracParams);
  const chiller = unit("chiller-01", "chiller", plant.x + 1, plant.z + 4, {
    capacityKw: 500,
    chilledWaterC: 9,
    ambientC: 28,
  });
  const sensorA = unit("sensor-01", "sensor", hall.x + 2, hall.z + 3);
  const sensorB = unit("sensor-02", "sensor", hall.x + 2, hall.z + 6);

  return {
    id: "air-cooled-rows",
    name: "Air-cooled rows",
    description: "Twelve air-cooled racks in two rows, a CRAC unit per row, one chiller carrying both.",
    layout: {
      zones: [hall, plant],
      items: [chiller, cracA, cracB, ...rowA, ...rowB, sensorA, sensorB],
      connections: [
        link("link-chiller-crac-01", chiller.id, cracA.id),
        link("link-chiller-crac-02", chiller.id, cracB.id),
        ...rowA.map((rack) => link(`link-crac-01-${rack.id}`, cracA.id, rack.id)),
        ...rowB.map((rack) => link(`link-crac-02-${rack.id}`, cracB.id, rack.id)),
        ...covers(sensorA, rowA),
        ...covers(sensorB, rowB),
      ],
    },
  };
}

/** A containerised edge hall: four racks, one CRAC unit, a small chiller on its pad. */
function containerEdgeHall(): Preset {
  const hall: ZoneSpec = { id: "zone-container", name: "Container", kind: "compute", x: 19, z: 14, w: 8, d: 4 };
  const plant: ZoneSpec = { id: "zone-chiller-pad", name: "Chiller pad", kind: "plant", x: 28, z: 14, w: 3, d: 4 };
  const racks = [1, 2, 3, 4].map((i) =>
    unit(`rack-${String(i).padStart(2, "0")}`, "rack", hall.x + i, hall.z + 1, {
      itLoadKw: 15,
      utilisationPct: 70,
      inletLimitC: 27,
    }),
  );
  const crac = unit("crac-01", "crac", hall.x + 6, hall.z + 1, { capacityKw: 60, airflowCmh: 9_000 });
  const chiller = unit("chiller-01", "chiller", plant.x, plant.z + 2, { capacityKw: 120 });
  const sensor = unit("sensor-01", "sensor", hall.x + 2, hall.z + 2);

  return {
    id: "container-edge-hall",
    name: "Container / edge hall",
    description: "Four racks on one CRAC unit in a container, with a small chiller on its pad.",
    layout: {
      zones: [hall, plant],
      items: [chiller, crac, ...racks, sensor],
      connections: [
        link("link-chiller-crac-01", chiller.id, crac.id),
        ...racks.map((rack) => link(`link-crac-01-${rack.id}`, crac.id, rack.id)),
        ...covers(sensor, racks),
      ],
    },
  };
}

export const FACILITY_TEMPLATES: readonly Preset[] = [liquidGpuHall(), airCooledRows(), containerEdgeHall()];

/** The SFO-01 reference layout, which every facility model without a saved build runs on. */
export const SFO_01_LAYOUT = FACILITY_TEMPLATES[0].layout;
