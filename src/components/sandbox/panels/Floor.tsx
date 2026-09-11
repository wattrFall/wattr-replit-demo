import { FLOOR_LIMITS } from "@/lib/sandbox/geometry";
import { useSandboxStore } from "@/lib/sandbox/store";
import { SSlider } from "../primitives/SSlider";
import { SPanel } from "../primitives/SPanel";

/**
 * Site dimensions.
 *
 * Shrinking is refused rather than destructive: if equipment would be stranded
 * off the edge or in the walkway, the store says which items are in the way and
 * leaves the layout alone. Losing somebody's build to a slider drag would be a
 * poor trade for the convenience of not having to move it first.
 */
export function Floor() {
  const floor = useSandboxStore((s) => s.floor);
  const setFloor = useSandboxStore((s) => s.setFloor);

  return (
    <SPanel as="aside" title="Site">
      <SSlider
        label="Hall width"
        unit="tiles"
        hint="Raised floor: racks, CRAC units, CDUs and sensors."
        min={FLOOR_LIMITS.hallW.min}
        max={FLOOR_LIMITS.hallW.max}
        step={1}
        value={floor.hallW}
        onChange={(hallW) => setFloor({ hallW })}
      />
      <SSlider
        label="Hall depth"
        unit="tiles"
        min={FLOOR_LIMITS.hallD.min}
        max={FLOOR_LIMITS.hallD.max}
        step={1}
        value={floor.hallD}
        onChange={(hallD) => setFloor({ hallD })}
      />
      <SSlider
        label="Plant yard"
        unit="tiles"
        hint="Outside the hall, for heat rejection. Chillers go here."
        min={FLOOR_LIMITS.plantW.min}
        max={FLOOR_LIMITS.plantW.max}
        step={1}
        value={floor.plantW}
        onChange={(plantW) => setFloor({ plantW })}
      />
    </SPanel>
  );
}
