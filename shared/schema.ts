import { z } from "zod";

// Building types
export const buildingTypes = ["office_standard", "office_prestige", "hotel", "residential", "hospital", "ballroom_event"] as const;
export type BuildingType = typeof buildingTypes[number];

export const buildingTypeLabels: Record<BuildingType, string> = {
  office_standard: "Office (Standard)",
  office_prestige: "Office (Prestige)",
  hotel: "Hotel",
  residential: "Residential",
  hospital: "Hospital",
  ballroom_event: "Ballroom / Event",
};

// Floor input schema — now supports per-floor height and zone from Excel
export const floorInputSchema = z.object({
  floorLabel: z.string().min(1),
  grossArea: z.number().positive(),
  floorToFloorHeight: z.number().positive().optional(), // per-floor height in feet
  elevation: z.number().optional(),                     // elevation in feet
  zone: z.string().optional(),                          // zone designation from spreadsheet (L, M, H)
  densitySqftPerPerson: z.number().positive().optional(), // per-floor density override
  totalPopulation: z.number().nonnegative().optional(),     // per-floor total population (keys/units)
});

export type FloorInput = z.infer<typeof floorInputSchema>;

// Building input schema
export const buildingInputSchema = z.object({
  buildingType: z.enum(buildingTypes),
  floors: z.array(floorInputSchema).min(1),
  floorToFloorHeight: z.number().positive().default(13), // default floor-to-floor height
  densityOverride: z.number().positive().optional(),
});

export type BuildingInput = z.infer<typeof buildingInputSchema>;

// Zone output
export interface ZoneOutput {
  zoneName: string;
  zoneIndex: number;
  floorsServed: string;
  floorCount: number;
  numElevators: number;
  capacityLbs: number;
  capacityPersons: number;
  speedFpm: number;
  densitySqftPerPerson: number;
  totalPopulation: number;
  handlingCapacityPercent: number;
  avgWaitTimeSec: number;
  intervalSec: number;
  roundTripTimeSec: number;
  meetsPerformanceCriteria: boolean;
  // Shaft & core area estimates
  shaftCount: number;               // total shafts (= numElevators)
  shaftSizeFt: string;              // individual shaft dimensions e.g. "9'-0" × 8'-3""
  bankArrangement: string;          // e.g. "4 × 2" (cars across × deep)
  approxCoreSqft: number;           // approximate core area consumed by elevator bank
  pitDepthFt: number;               // required pit depth below lowest landing (ft)
  overheadClearanceFt: number;      // required overhead clearance above highest landing (ft)
  mrlEligible: boolean;             // whether machine-room-less configuration is available at this speed
  // Structural loads
  structural: {
    machineWeightLbs: number;
    cabWeightLbs: number;
    counterweightLbs: number;
    guideRailLoadLbsPerFt: number;
    totalShaftReactionLbs: number;
    machineRoomLoadPsf: number;
    totalBankReactionLbs: number;
    beamReactionPerShaftLbs: number;
  };
  // Electrical requirements
  electrical: {
    motorHp: number;
    motorKw: number;
    demandKva: number;
    feederAmps: number;
    totalBankKva: number;
    totalBankAmps: number;
    voltageSystem: string;
    wireSize: string;
    disconnectSize: string;
    controllerType: string;
  };
  // Down-peak / lunchtime analysis
  downPeakIntervalSec: number;      // interval during down-peak
  downPeakHcPercent: number;        // handling capacity during down-peak
  downPeakAwtSec: number;           // average wait time during down-peak
  downPeakRttSec: number;           // round-trip time during down-peak
  downPeakMeetsCriteria: boolean;   // does it meet the same pass criteria during down-peak?
}

// Per-zone user overrides for tuning
export interface ZoneOverride {
  numElevators?: number;
  capacityLbs?: number;
  speedFpm?: number;
  densitySqftPerPerson?: number;
  handlingCapacityPercent?: number;
  doorHeightFt?: 7 | 8;
}

// Full analysis result
export interface AnalysisResult {
  buildingType: BuildingType;
  totalFloors: number;
  totalGrossArea: number;
  totalPopulation: number;
  numZones: number;
  zones: ZoneOutput[];
}
