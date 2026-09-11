/**
 * Prebuilt halls.
 *
 * A first-time visitor should see a working data centre reacting, not an empty
 * grid and a palette. Each preset is a complete, coherent design: every rack is
 * fed, every cooling unit is backed by a chiller with capacity to spare, and
 * every rack is covered by a sensor — so each one passes design validation
 * cleanly and can be run the moment it loads.
 *
 * Ids are numbered so loadLayout can continue past the highest without
 * colliding with anything the user places afterwards.
 */
import { defaultParams } from "./catalogue";
import type { ComponentKind, Connection, Preset, SandboxItem } from "./types";

let seq = 0;
const reset = () => {
  seq = 0;
};

function make(
  kind: ComponentKind,
  x: number,
  z: number,
  params: Record<string, number> = {},
): SandboxItem {
  return {
    id: `${kind}-${++seq}`,
    kind,
    cell: { x, z },
    params: { ...defaultParams(kind), ...params },
  };
}

const link = (fromId: string, toId: string): Connection => ({
  id: `link-${++seq}`,
  fromId,
  toId,
});

/** Every rack fed by the given cooler, and every cooler fed by the chiller. */
function wire(coolers: SandboxItem[], racks: SandboxItem[][], chiller: SandboxItem, sensors: [SandboxItem, SandboxItem[]][]) {
  const connections: Connection[] = [];
  coolers.forEach((cooler, i) => {
    connections.push(link(chiller.id, cooler.id));
    (racks[i] ?? []).forEach((rack) => connections.push(link(cooler.id, rack.id)));
  });
  sensors.forEach(([sensor, covered]) => covered.forEach((r) => connections.push(link(sensor.id, r.id))));
  return connections;
}

function containerHall(): Preset {
  reset();
  const floor = { hallW: 10, hallD: 6, plantW: 3 };
  const racks = [2, 3, 4, 5].map((x) => make("rack", x, 2));
  const crac = make("crac", 7, 2);
  const chiller = make("chiller", 11, 2, { capacityKw: 150 });
  const s1 = make("sensor", 2, 3);
  const s2 = make("sensor", 5, 3);
  return {
    id: "container",
    name: "Container hall",
    description: "Four racks on one CRAC. The smallest thing worth cooling.",
    layout: {
      floor,
      items: [...racks, crac, chiller, s1, s2],
      connections: wire([crac], [racks], chiller, [
        [s1, racks.slice(0, 2)],
        [s2, racks.slice(2)],
      ]),
    },
  };
}

function airCooledRow(): Preset {
  reset();
  const floor = { hallW: 14, hallD: 8, plantW: 4 };
  const rowA = [2, 3, 4, 5].map((x) => make("rack", x, 2));
  const rowB = [2, 3, 4, 5].map((x) => make("rack", x, 5));
  const cracA = make("crac", 8, 2, { capacityKw: 75, airflowCmh: 12000 });
  const cracB = make("crac", 8, 5, { capacityKw: 75, airflowCmh: 12000 });
  const chiller = make("chiller", 15, 3, { capacityKw: 250 });
  const s1 = make("sensor", 6, 2);
  const s2 = make("sensor", 6, 5);
  return {
    id: "air-row",
    name: "Air-cooled rows",
    description: "Two rows, a CRAC each, one chiller carrying both.",
    layout: {
      floor,
      items: [...rowA, ...rowB, cracA, cracB, chiller, s1, s2],
      connections: wire([cracA, cracB], [rowA, rowB], chiller, [
        [s1, rowA],
        [s2, rowB],
      ]),
    },
  };
}

function liquidGpuHall(): Preset {
  reset();
  const floor = { hallW: 12, hallD: 8, plantW: 4 };
  const dense = { itLoadKw: 24, utilisationPct: 85, inletLimitC: 30 };
  const bankA = [2, 3, 4].map((x) => make("rack", x, 2, dense));
  const bankB = [2, 3, 4].map((x) => make("rack", x, 5, dense));
  const cduA = make("cdu", 7, 2, { capacityKw: 110, supplyWaterC: 24 });
  const cduB = make("cdu", 7, 5, { capacityKw: 110, supplyWaterC: 24 });
  const chiller = make("chiller", 13, 3, { capacityKw: 350, chilledWaterC: 14 });
  const s1 = make("sensor", 5, 2);
  const s2 = make("sensor", 5, 5);
  return {
    id: "liquid-gpu",
    name: "Liquid GPU hall",
    description: "Direct-to-chip CDUs on high-density banks, running warm.",
    layout: {
      floor,
      items: [...bankA, ...bankB, cduA, cduB, chiller, s1, s2],
      connections: wire([cduA, cduB], [bankA, bankB], chiller, [
        [s1, bankA],
        [s2, bankB],
      ]),
    },
  };
}

export const PRESETS: Preset[] = [containerHall(), airCooledRow(), liquidGpuHall()];

/** What the page opens with, so a first visit shows a hall rather than a grid. */
export const OPENING_PRESET = PRESETS[1];
