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
import { SITE } from "./geometry";
import type { ComponentKind, Connection, Preset, SandboxItem, ZoneSpec } from "./types";

let seq = 0;
const reset = () => {
  seq = 0;
};

/**
 * A raised floor and a plant yard side by side, with a one-tile walkway,
 * centred on the site. Equipment is then placed in tiles relative to the raised
 * floor's top-left corner, so a preset reads the same as it did on a fixed floor.
 */
function site(hallW: number, hallD: number, plantW: number) {
  const ox = Math.floor((SITE.w - (hallW + 1 + plantW)) / 2);
  const oz = Math.floor((SITE.d - hallD) / 2);
  const zones: ZoneSpec[] = [
    { id: `zone-${++seq}`, name: "Raised floor", kind: "compute", x: ox, z: oz, w: hallW, d: hallD },
    { id: `zone-${++seq}`, name: "Plant yard", kind: "plant", x: ox + hallW + 1, z: oz, w: plantW, d: hallD },
  ];

  const make = (
    kind: ComponentKind,
    x: number,
    z: number,
    params: Record<string, number> = {},
  ): SandboxItem => ({
    id: `${kind}-${++seq}`,
    kind,
    cell: { x: ox + x, z: oz + z },
    params: { ...defaultParams(kind), ...params },
  });

  return { zones, make };
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
  const { zones, make } = site(10, 6, 3);
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
      zones,
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
  const { zones, make } = site(14, 8, 4);
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
      zones,
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
  const { zones, make } = site(12, 8, 4);
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
      zones,
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
