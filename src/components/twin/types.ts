import type { CockpitSnapshot, FacilityModelConfig } from "@/lib/cockpit/simulation";

export type TwinView = "physical" | "thermal";
export type TwinOverlay = "heat" | "flow" | "sensors" | "labels" | "incidents" | "forecast";
export type TwinMode = "operate" | "edit";

export type FacilityTwinProps = {
  model: FacilityModelConfig;
  modelVersion: string;
  snapshot: CockpitSnapshot;
  selectedId: string;
  selectedFloor?: 1 | 2;
  highlightedPath?: string[];
  onSelect: (id: string) => void;
  view: TwinView;
  overlays: TwinOverlay[];
  mode?: TwinMode;
  canEdit?: boolean;
  onGuideAction?: (action: string) => void;
  /** Controls a page adds to the twin's toolbar: before the floor and camera, and after them. */
  toolbarStart?: import("react").ReactNode;
  toolbarEnd?: import("react").ReactNode;
  /** More for the toolbar's "?" to explain, ahead of floors and camera. */
  help?: import("react").ReactNode;
};