import type { CockpitSnapshot, FacilityModelConfig } from "@/lib/cockpit/simulation";

export type TwinView = "physical" | "thermal";
export type TwinOverlay = "heat" | "flow" | "sensors" | "labels" | "incidents" | "forecast";
export type TwinMode = "operate" | "edit";

export type FacilityTwinProps = {
  model: FacilityModelConfig;
  modelVersion: string;
  snapshot: CockpitSnapshot;
  selectedId: string;
  onSelect: (id: string) => void;
  view: TwinView;
  overlays: TwinOverlay[];
  mode?: TwinMode;
  canEdit?: boolean;
  onGuideAction?: (action: string) => void;
};