/**
 * Elevator Traffic Analysis Engine
 * 
 * Based on CIBSE Guide D methodology, Elevator World fundamentals,
 * and the classical RTT calculation approach.
 * 
 * Key formulas sourced from:
 * - CIBSE Guide D: Transportation Systems in Buildings
 * - Dr. Albert So, "Fundamentals of Traffic Analysis" (Elevator World)
 * - Al-Sharif et al, "Zoning a building in lift traffic design"
 * - Peters Research, "Lift Planning for High-Rise Buildings"
 */

import type { BuildingType, FloorInput, AnalysisResult, ZoneOutput, ZoneOverride } from "@shared/schema";

// ═══════════════════════════════════════════════
// CONFIGURATION TABLES
// ═══════════════════════════════════════════════

interface BuildingConfig {
  densitySqftPerPerson: number;
  netToGrossRatio: number;
  attendanceFactor: number;
  peakArrivalRate: number;
  targetIntervalSec: number;
  maxAwt: number;
  minHc5Percent: number;
  /** Traffic pattern: 'uppeak' = 100% incoming (offices), 'mixed' = 50/50 in/out (hotels).
   *  Mixed traffic increases RTT because the car makes stops in both directions. */
  trafficPattern?: 'uppeak' | 'mixed';
}

const BUILDING_CONFIGS: Record<BuildingType, BuildingConfig> = {
  office_standard: {
    densitySqftPerPerson: 135,
    netToGrossRatio: 0.72,             // typical high-rise office core factor (~71-73% per BOMA)
    attendanceFactor: 1.0,             // population = full design capacity; arrival rate already accounts for real-world attendance
    peakArrivalRate: 0.12,
    targetIntervalSec: 35,
    maxAwt: 30,
    minHc5Percent: 14,
  },
  office_prestige: {
    densitySqftPerPerson: 175,
    netToGrossRatio: 0.72,             // typical high-rise office core factor (~71-73% per BOMA)
    attendanceFactor: 1.0,             // population = full design capacity; arrival rate already accounts for real-world attendance
    peakArrivalRate: 0.13,
    targetIntervalSec: 33,
    maxAwt: 22,
    minHc5Percent: 14,
  },
  hotel: {
    densitySqftPerPerson: 250,
    netToGrossRatio: 0.70,
    attendanceFactor: 1.0,           // 100% occupancy assumed
    peakArrivalRate: 0.11,
    targetIntervalSec: 35,
    maxAwt: 25,                       // tighter wait time for hotel service
    minHc5Percent: 10,
    trafficPattern: 'mixed',          // 50% entering / 50% exiting
  },
  residential: {
    densitySqftPerPerson: 350,
    netToGrossRatio: 0.70,
    attendanceFactor: 0.90,           // 90% occupancy
    peakArrivalRate: 0.065,           // 6.5% of population per 5 minutes
    targetIntervalSec: 60,
    maxAwt: 42,
    minHc5Percent: 5,
    trafficPattern: 'mixed',          // 50% entering / 50% exiting
  },
  hospital: {
    densitySqftPerPerson: 120,
    netToGrossRatio: 0.70,
    attendanceFactor: 1.0,             // design capacity; arrival rate accounts for real-world attendance
    peakArrivalRate: 0.10,
    targetIntervalSec: 35,
    maxAwt: 35,
    minHc5Percent: 8,
  },
  ballroom_event: {
    densitySqftPerPerson: 10,      // IBC concentrated assembly ≈ 7–15 net SF/person
    netToGrossRatio: 0.65,          // significant BOH, prefunction, service corridors
    attendanceFactor: 0.95,         // events fill to near capacity
    peakArrivalRate: 0.25,          // very sharp arrival spikes for scheduled events
    targetIntervalSec: 40,          // guests arrive in waves, more tolerant of waiting
    maxAwt: 40,
    minHc5Percent: 15,              // high — must move large crowds quickly
  },
};

const STANDARD_CAPACITIES = [
  { lbs: 2100, persons: 14 },
  { lbs: 2500, persons: 17 },
  { lbs: 3000, persons: 20 },
  { lbs: 3500, persons: 23 },
  { lbs: 4000, persons: 27 },
  { lbs: 4500, persons: 30 },
  { lbs: 5000, persons: 33 },
];

const STANDARD_SPEEDS = [100, 150, 200, 250, 300, 350, 400, 500, 600, 700, 800, 1000, 1200];

/** S-curve (jerk-limited) kinematic constants.
 *  a_max: peak acceleration (m/s²) — 1.0 is standard gearless passenger comfort.
 *  j:     jerk rate (m/s³) — 6.0 ft/s³ = 1.829 m/s³, standard passenger grade.
 *  Leveling: 0.5s for final floor alignment after travel. */
const ACCEL_MAX = 1.0;       // m/s²
const JERK_RATE = 1.829;     // m/s³  (6.0 ft/s³)
const LEVELING_TIME = 0.5;   // seconds

/** Distance and time to S-curve accelerate from 0 to target velocity V.
 *  Uses numerical integration (0.5 ms steps) for accuracy across all
 *  profile shapes: full S-curve, reduced-peak, and jerk-only. */
function sCurveAccelPhase(V: number, aMax: number, j: number): { t: number; d: number } {
  const tj = aMax / j;                 // time for one jerk segment
  const vJerkPair = (aMax * aMax) / j; // velocity gained by jerk-in + jerk-out alone

  if (vJerkPair >= V) {
    // Never reaches aMax — reduced peak acceleration
    const aPeak = Math.sqrt(j * V);
    const tjr = aPeak / j;
    return { t: 2 * tjr, d: V * tjr };
  }

  // Full jerk-in → constant accel → jerk-out
  const vRemaining = V - vJerkPair;
  const tConst = vRemaining / aMax;
  const tTotal = 2 * tj + tConst;

  // Numerical integration for distance
  const dt = 0.0005;
  let dist = 0, vel = 0, acc = 0;
  for (let time = 0; time < tTotal; time += dt) {
    if (time < tj) {
      acc = j * time;
    } else if (time < tj + tConst) {
      acc = aMax;
    } else {
      acc = aMax - j * (time - tj - tConst);
    }
    vel = Math.min(vel + acc * dt, V);
    dist += vel * dt;
  }
  return { t: tTotal, d: dist };
}

/** S-curve travel time for a given distance.
 *  Handles three cases:
 *   1. Full profile (accel → cruise → decel)
 *   2. No cruise (accel → decel, reaches Vmax)
 *   3. Reduced peak (never reaches Vmax or aMax) */
function sCurveTravelTime(Vmax: number, d: number, aMax: number, j: number): number {
  const accel = sCurveAccelPhase(Vmax, aMax, j);
  if (2 * accel.d <= d) {
    // Full profile with cruise
    const dCruise = d - 2 * accel.d;
    return 2 * accel.t + dCruise / Vmax;
  }
  // No cruise — binary-search for reduced peak speed
  let lo = 0, hi = Vmax;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const r = sCurveAccelPhase(mid, aMax, j);
    if (2 * r.d <= d) lo = mid; else hi = mid;
  }
  const r = sCurveAccelPhase((lo + hi) / 2, aMax, j);
  return 2 * r.t;
}

/** Physics-based single-floor flight time using full S-curve kinematics.
 *  Accounts for jerk-limited acceleration/deceleration and leveling. */
function getSingleFloorFlightTime(speedFpm: number, floorHeightFt: number = 13): number {
  const Vmax = speedFpm * 0.00508;   // fpm → m/s
  const d = floorHeightFt * 0.3048;  // ft → m
  return sCurveTravelTime(Vmax, d, ACCEL_MAX, JERK_RATE) + LEVELING_TIME;
}

/** S-curve round-trip express travel time for a given distance.
 *  Used for the non-stop run from lobby to the bottom of a zone. */
function expressRoundTripTime(distFt: number, speedFpm: number): number {
  if (distFt <= 0) return 0;
  const Vmax = speedFpm * 0.00508;
  const d = distFt * 0.3048;
  const oneWay = sCurveTravelTime(Vmax, d, ACCEL_MAX, JERK_RATE);
  return 2 * oneWay;
}

/** Full door cycle time (open + dwell + close) depends on door height.
 *  Models heavy-duty door operator on fire-rated assemblies.
 *  Includes real-world dwell extension (sensor holds, passenger hesitation).
 *  7 ft door (2134 mm): ~2.5s open + 2.5s dwell + 2.0s close = 7.0 s
 *  8 ft door (2438 mm): ~3.0s open + 3.0s dwell + 2.5s close = 8.5 s */
function doorOpenCloseTime(doorHeightFt: number = 8): number {
  return doorHeightFt <= 7 ? 7.0 : 8.5;
}

/** Passenger transfer time (seconds per person boarding or alighting).
 *  Conservative value accounts for briefcases, phones, hesitation,
 *  and mixed demographics typical in real buildings. */
const PASSENGER_TRANSFER = 1.6;

/** Mixed-traffic RTT multiplier (CIBSE Guide D, balanced interfloor).
 *  In a 50/50 up/down pattern the car makes stops in both directions,
 *  increasing the effective round-trip time by ~35 %. */
const MIXED_TRAFFIC_RTT_FACTOR = 1.35;

/** Destination dispatch efficiency factor.
 *  Destination dispatch groups passengers by destination floor before boarding,
 *  reducing the expected number of stops per trip by ~30 %. This translates to
 *  roughly a 22 % reduction in round-trip time compared to conventional collective
 *  dispatch (conservative mid-range of industry 20-25 % estimates).
 *  Applied as a multiplier on RTT: lower RTT → fewer elevators, shorter waits. */
const DESTINATION_DISPATCH_FACTOR = 0.78;  // 1 − 0.22 = 22 % RTT improvement

/** Car loading factor — fraction of rated capacity assumed per trip.
 *  80 % is the standard consultant assumption for destination dispatch
 *  and well-managed systems.  Accounts for uneven loading, personal
 *  space preferences, and passengers who wait for the next car. */
const CAR_LOADING_FACTOR = 0.80;

/** AWT-to-interval ratio.
 *  Classical uniform arrivals give 0.5; real-world bunching (lobby waves,
 *  elevator groups arriving together) shifts this toward 0.55.
 *  0.55 is the standard consultant assumption per Peters Research. */
const AWT_INTERVAL_RATIO = 0.55;

/** Motor start delay (seconds).
 *  Time between doors finishing closing and the drive engaging.
 *  CIBSE Guide D recommends consulting the installer; 0.5 s is the standard
 *  assumption when no field data is available.  Real-world measurements
 *  (Peters Research) range 0.5–1.0 s.  Applied once at every stop (S+1). */
const MOTOR_START_DELAY = 0.5;

/**
 * Collapse a sorted array of floor numbers into a compact string.
 * Consecutive runs become ranges: [1, 4, 10, 11, 12, 13] → "1, 4, 10–13"
 */
function formatFloorList(nums: number[]): string {
  if (nums.length === 0) return "";
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i];
    let end = start;
    while (i + 1 < sorted.length && sorted[i + 1] === end + 1) {
      end = sorted[++i];
    }
    parts.push(start === end ? `${start}` : `${start}\u2013${end}`);
    i++;
  }
  return parts.join(", ");
}

/**
 * Check if a floor is a lobby/transfer floor (tagged with multiple zones).
 * These floors generate elevator stops but NOT population demand.
 */
function isLobbyFloor(f: FloorInput): boolean {
  return !!f.zone && f.zone.includes(",");
}

/**
 * Compute cumulative elevations for all floors from their floor-to-floor heights.
 * Floors are sorted by floor number; each floor's elevation = sum of heights below it.
 * Returns a Map of floorLabel → elevation (ft above grade).
 */
function computeElevations(floors: FloorInput[], defaultFloorHeight: number): Map<string, number> {
  const elevations = new Map<string, number>();
  
  // Sort by floor number ascending
  const sorted = [...floors].sort((a, b) => {
    const numA = parseInt(a.floorLabel.replace(/\D/g, "")) || 0;
    const numB = parseInt(b.floorLabel.replace(/\D/g, "")) || 0;
    return numA - numB;
  });
  
  // If floors already have explicit elevations, use those
  const hasElevations = sorted.some(f => f.elevation !== undefined && f.elevation > 0);
  if (hasElevations) {
    for (const f of sorted) {
      elevations.set(f.floorLabel, f.elevation || 0);
    }
    return elevations;
  }
  
  // Otherwise compute cumulative from floor-to-floor heights
  let cumulative = 0;
  for (const f of sorted) {
    elevations.set(f.floorLabel, cumulative);
    cumulative += f.floorToFloorHeight || defaultFloorHeight;
  }
  
  return elevations;
}

// ═══════════════════════════════════════════════
// ZONING LOGIC
// ═══════════════════════════════════════════════

interface ZoneDefinition {
  zoneName: string;
  zoneCode: string;
  floors: FloorInput[];          // ALL floors in this zone (including lobby)
  demandFloors: FloorInput[];    // Only floors that generate population demand (non-lobby)
  startFloorNum: number;
  endFloorNum: number;
}

/**
 * Build zones from pre-defined zone codes in the spreadsheet (L, M, H, etc.)
 * Floors tagged with multiple zones (e.g. "L,M,H") are lobby/transfer floors
 * that every bank stops at — they are included in each zone for RTT calculation
 * but EXCLUDED from population demand.
 */
function buildZonesFromSpreadsheet(floors: FloorInput[]): ZoneDefinition[] {
  // Separate single-zone floors and multi-zone (lobby/transfer) floors
  const singleZoneFloors = floors.filter(
    (f) => f.zone && !f.zone.includes(",") && f.zone.trim().length > 0
  );
  const multiZoneFloors = floors.filter(
    (f) => f.zone && f.zone.includes(",")
  );

  const zoneCodes = [...new Set(singleZoneFloors.map((f) => f.zone!.trim()))];

  if (zoneCodes.length === 0) return [];

  // Map zone codes to descriptive names
  const zoneNameMap: Record<string, string> = {
    L: "Low Zone",
    M: "Mid Zone",
    H: "High Zone",
    "1": "Zone 1",
    "2": "Zone 2",
    "3": "Zone 3",
    "4": "Zone 4",
  };

  // Sort zone codes: L before M before H (or numerically)
  const zoneOrder = ["L", "M", "H", "1", "2", "3", "4"];
  zoneCodes.sort((a, b) => {
    const ia = zoneOrder.indexOf(a);
    const ib = zoneOrder.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  return zoneCodes.map((code) => {
    // Start with floors explicitly in this zone
    const dedicated = singleZoneFloors.filter((f) => f.zone!.trim() === code);
    // Add multi-zone (lobby/transfer) floors whose zone list includes this code
    const shared = multiZoneFloors.filter((f) => {
      const codes = f.zone!.split(",").map((c) => c.trim().toUpperCase());
      return codes.includes(code.toUpperCase());
    });
    const zoneFloors = [...shared, ...dedicated];
    // Demand floors = only dedicated floors (not lobby/transfer)
    const demandFloors = dedicated;
    const floorNums = zoneFloors.map((f) => parseInt(f.floorLabel.replace(/\D/g, "")) || 0);
    return {
      zoneName: zoneNameMap[code] || `Zone ${code}`,
      zoneCode: code,
      floors: zoneFloors,
      demandFloors,
      startFloorNum: Math.min(...floorNums),
      endFloorNum: Math.max(...floorNums),
    };
  });
}

/**
 * Auto-zone when no zone codes are present in the spreadsheet.
 * Uses Al-Sharif population splits.
 */
function autoZoneFloors(floors: FloorInput[]): ZoneDefinition[] {
  const totalFloors = floors.length;
  let splits: { name: string; code: string; fraction: number }[];

  if (totalFloors <= 15) {
    splits = [{ name: "All Floors", code: "A", fraction: 1.0 }];
  } else if (totalFloors <= 30) {
    splits = [
      { name: "Low Zone", code: "L", fraction: 0.57 },
      { name: "High Zone", code: "H", fraction: 0.43 },
    ];
  } else if (totalFloors <= 45) {
    splits = [
      { name: "Low Zone", code: "L", fraction: 0.43 },
      { name: "Mid Zone", code: "M", fraction: 0.30 },
      { name: "High Zone", code: "H", fraction: 0.27 },
    ];
  } else {
    splits = [
      { name: "Zone 1", code: "1", fraction: 0.29 },
      { name: "Zone 2", code: "2", fraction: 0.27 },
      { name: "Zone 3", code: "3", fraction: 0.22 },
      { name: "Zone 4", code: "4", fraction: 0.22 },
    ];
  }

  const zones: ZoneDefinition[] = [];
  let cursor = 0;

  for (let i = 0; i < splits.length; i++) {
    let count: number;
    if (i === splits.length - 1) {
      count = totalFloors - cursor;
    } else {
      count = Math.max(2, Math.round(totalFloors * splits[i].fraction));
    }
    const zoneFloors = floors.slice(cursor, cursor + count);
    const floorNums = zoneFloors.map((f) => parseInt(f.floorLabel.replace(/\D/g, "")) || 0);
    zones.push({
      zoneName: splits[i].name,
      zoneCode: splits[i].code,
      floors: zoneFloors,
      demandFloors: zoneFloors,  // No lobby floors in auto-zone
      startFloorNum: Math.min(...floorNums),
      endFloorNum: Math.max(...floorNums),
    });
    cursor += count;
  }

  return zones;
}

// ═══════════════════════════════════════════════
// SPEED SELECTION
// ═══════════════════════════════════════════════

/**
 * Select elevator speed based on zone top elevation.
 * Uses the industry rule-of-thumb: ideal speed = (topElevation / 28) × 60 fpm.
 * Picks the largest standard speed that does not exceed the ideal —
 * this matches the consultant's approach of rounding DOWN to standard speeds.
 * @param zoneTopElevationFt — elevation of the zone's highest floor above grade
 */
function selectSpeed(zoneTopElevationFt: number): number {
  const idealSpeedFpm = (zoneTopElevationFt / 28) * 60;
  let selected = STANDARD_SPEEDS[0];
  for (const speed of STANDARD_SPEEDS) {
    if (speed <= idealSpeedFpm) {
      selected = speed;
    } else {
      break;
    }
  }
  return selected;
}

// ═══════════════════════════════════════════════
// CAPACITY SELECTION
// ═══════════════════════════════════════════════

function selectCapacity(passengersPerTrip: number): { lbs: number; persons: number } {
  const requiredCC = passengersPerTrip / CAR_LOADING_FACTOR;
  for (const cap of STANDARD_CAPACITIES) {
    if (cap.persons >= requiredCC) return cap;
  }
  return STANDARD_CAPACITIES[STANDARD_CAPACITIES.length - 1];
}

// ═══════════════════════════════════════════════
// EXPECTED STOPS (S) AND HIGHEST REVERSAL (H)
// ═══════════════════════════════════════════════

/** Classical equal-probability expected stops (fallback when no per-floor weights). */
function expectedStops(N: number, P: number): number {
  if (N <= 0 || P <= 0) return 0;
  return N * (1 - Math.pow(1 - 1 / N, P));
}

/** Weighted expected stops for unequal floor populations.
 *  Each floor has probability p_i proportional to its population.
 *  S = Σ [1 − (1 − p_i)^P]  for all floors i above the lobby.
 *  Falls back to classical formula when all floors are equal or weights not provided. */
function expectedStopsWeighted(floorPops: number[], P: number): number {
  if (floorPops.length <= 0 || P <= 0) return 0;
  const totalPop = floorPops.reduce((s, p) => s + p, 0);
  if (totalPop <= 0) return expectedStops(floorPops.length, P);
  let S = 0;
  for (const pop of floorPops) {
    const pi = pop / totalPop;
    S += 1 - Math.pow(1 - pi, P);
  }
  return S;
}

/** Weighted highest reversal floor.
 *  H = N+1 − Σ_{i=1}^{N} [Σ_{j=1}^{i} p_j]^P
 *  where cumulative probabilities replace i/N. */
function highestReversalWeighted(floorPops: number[], P: number): number {
  if (floorPops.length <= 0 || P <= 0) return 0;
  const totalPop = floorPops.reduce((s, p) => s + p, 0);
  if (totalPop <= 0) return highestReversalFloor(floorPops.length, P);
  const N = floorPops.length;
  let cumProb = 0;
  let sum = 0;
  for (let i = 0; i < N; i++) {
    cumProb += floorPops[i] / totalPop;
    sum += Math.pow(cumProb, P);
  }
  return N + 1 - sum;
}

function highestReversalFloor(N: number, P: number): number {
  if (N <= 0 || P <= 0) return 0;
  let sum = 0;
  for (let i = 1; i <= N; i++) {
    sum += Math.pow(i / N, P);
  }
  return N + 1 - sum;
}

/** Interfloor traffic factor.
 *  During peak, ~10-15% of trips are interfloor (between occupied floors,
 *  not lobby-to-floor).  Interfloor trips add stops without lobby turnover,
 *  effectively increasing RTT.  We model this as a multiplier on the zone RTT.
 *  CIBSE Guide D suggests 5-15% depending on building type. */
const INTERFLOOR_TRAFFIC_FACTOR: Record<string, number> = {
  office_standard: 1.10,    // 10% interfloor during peak
  office_prestige: 1.10,
  hotel: 1.15,              // guests move between amenity floors
  residential: 1.05,        // minimal interfloor
  hospital: 1.15,           // staff move between floors frequently
  ballroom_event: 1.05,
};

// ═══════════════════════════════════════════════
// ROUND TRIP TIME (RTT)
// ═══════════════════════════════════════════════

function calculateRTT(
  N: number,
  P: number,
  speedFpm: number,
  avgFloorHeight: number,
  doorHeightFt: number = 8,
  floorPops?: number[]
): number {
  // Use weighted formulas when per-floor populations are available
  const S = floorPops && floorPops.length > 0
    ? expectedStopsWeighted(floorPops, P)
    : expectedStops(N, P);
  const H = floorPops && floorPops.length > 0
    ? highestReversalWeighted(floorPops, P)
    : highestReversalFloor(N, P);
  const tv = (avgFloorHeight / speedFpm) * 60;
  const tf1 = getSingleFloorFlightTime(speedFpm, avgFloorHeight);
  const doorOC = doorOpenCloseTime(doorHeightFt);
  // Stop penalty per floor: door cycle + single-floor flight overhead + motor start delay
  const Tstop = doorOC + tf1 - tv + MOTOR_START_DELAY;
  const analyticalRTT = 2 * H * tv + (S + 1) * Tstop + 2 * P * PASSENGER_TRANSFER;
  return analyticalRTT;
}

// ═══════════════════════════════════════════════
// SHAFT LAYOUT & CORE AREA
// ═══════════════════════════════════════════════

/** Cab interior dimensions by capacity (ASME A17.1 minimum platform sizes).
 *  Width × depth in feet.  Shaft dimensions add ~2 ft each direction for
 *  structure, guide rails, counterweight, and clearances. */
const CAB_DIMENSIONS: Record<number, { cabW: number; cabD: number }> = {
  2100: { cabW: 5.67, cabD: 4.25 },   // 68" × 51"
  2500: { cabW: 6.33, cabD: 4.25 },   // 76" × 51"
  3000: { cabW: 6.33, cabD: 5.08 },   // 76" × 61"
  3500: { cabW: 6.33, cabD: 5.75 },   // 76" × 69"
  4000: { cabW: 7.0,  cabD: 5.75 },   // 84" × 69"
  4500: { cabW: 7.0,  cabD: 6.33 },   // 84" × 76"
  5000: { cabW: 7.0,  cabD: 7.0 },    // 84" × 84"
};

/** Pit depth and overhead clearance by rated speed (ASME A17.1 / ANSI minimums).
 *  Pit depth: buffer + travel clearance below lowest landing.
 *  Overhead: top-of-car clearance + equipment above highest landing.
 *  MRL (machine-room-less) overhead is taller because the machine sits atop the shaft.
 *  Values are typical minimums rounded to the nearest 6 inches for planning.
 *  Speeds ≥ 700 fpm generally require a machine room (MR). */
const PIT_OVERHEAD_TABLE: { maxFpm: number; pitFt: number; overheadMrlFt: number; overheadMrFt: number; mrlAvailable: boolean }[] = [
  { maxFpm: 200,  pitFt: 5.0,  overheadMrlFt: 14.0, overheadMrFt: 12.0, mrlAvailable: true },
  { maxFpm: 350,  pitFt: 5.5,  overheadMrlFt: 15.0, overheadMrFt: 13.0, mrlAvailable: true },
  { maxFpm: 500,  pitFt: 7.0,  overheadMrlFt: 16.5, overheadMrFt: 14.0, mrlAvailable: true },
  { maxFpm: 700,  pitFt: 8.0,  overheadMrlFt: 18.0, overheadMrFt: 14.5, mrlAvailable: true },
  { maxFpm: 1000, pitFt: 10.0, overheadMrlFt: 0,    overheadMrFt: 16.0, mrlAvailable: false },
  { maxFpm: 1200, pitFt: 12.0, overheadMrlFt: 0,    overheadMrFt: 18.0, mrlAvailable: false },
  { maxFpm: 9999, pitFt: 14.0, overheadMrlFt: 0,    overheadMrFt: 20.0, mrlAvailable: false },
];

function getPitOverhead(speedFpm: number): { pitDepthFt: number; overheadClearanceFt: number; mrlEligible: boolean } {
  const row = PIT_OVERHEAD_TABLE.find(r => speedFpm <= r.maxFpm) || PIT_OVERHEAD_TABLE[PIT_OVERHEAD_TABLE.length - 1];
  return {
    pitDepthFt: row.pitFt,
    overheadClearanceFt: row.mrlAvailable ? row.overheadMrlFt : row.overheadMrFt,
    mrlEligible: row.mrlAvailable,
  };
}

// ═══════════════════════════════════════════════
// STRUCTURAL LOADS & ELECTRICAL REQUIREMENTS
// ═══════════════════════════════════════════════

/** Structural loads by capacity and speed.
 *  Values are typical planning-level estimates for gearless traction elevators.
 *  Sources: major OEM (Otis, TKE, Schindler) planning guides, ASME A17.1.
 *
 *  - machineWeightLbs: hoist machine + drive assembly weight
 *  - cabWeightLbs: empty cab (shell, sling, platform, finishes, doors)
 *  - counterweightLbs: counterweight assembly (cab + 40-50% of rated load)
 *  - guideRailLoadLbsPerFt: distributed load per foot of guide rail (pair)
 *  - totalShaftReactionLbs: approximate total dead load reaction per shaft
 *    at the pit (machine + cab + CWT + rail weight for typical travel)
 *  - machineRoomLoadPsf: live load requirement for machine room floor (PSF)
 *
 *  Key indexed by capacity_lbs. Speed adjusts machine weight (heavier motors
 *  for faster speeds). */
interface StructuralLoadEntry {
  cabWeightLbs: number;
  counterweightLbs: number;
  guideRailLoadLbsPerFt: number;
}

const STRUCTURAL_LOADS_BY_CAPACITY: Record<number, StructuralLoadEntry> = {
  2100: { cabWeightLbs: 2800, counterweightLbs: 3850,  guideRailLoadLbsPerFt: 22 },
  2500: { cabWeightLbs: 3100, counterweightLbs: 4350,  guideRailLoadLbsPerFt: 22 },
  3000: { cabWeightLbs: 3500, counterweightLbs: 5000,  guideRailLoadLbsPerFt: 30 },
  3500: { cabWeightLbs: 3900, counterweightLbs: 5650,  guideRailLoadLbsPerFt: 30 },
  4000: { cabWeightLbs: 4400, counterweightLbs: 6400,  guideRailLoadLbsPerFt: 30 },
  4500: { cabWeightLbs: 4900, counterweightLbs: 7150,  guideRailLoadLbsPerFt: 36 },
  5000: { cabWeightLbs: 5400, counterweightLbs: 7900,  guideRailLoadLbsPerFt: 36 },
};

/** Machine weight varies with speed — faster = heavier motor/sheave.
 *  Returns machine weight in lbs for a given capacity and speed. */
function getMachineWeight(capacityLbs: number, speedFpm: number): number {
  // Base machine weight by capacity
  const baseMachine: Record<number, number> = {
    2100: 2000, 2500: 2400, 3000: 3000, 3500: 3500,
    4000: 4000, 4500: 4500, 5000: 5200,
  };
  const base = baseMachine[capacityLbs] || 4000;
  // Speed multiplier: ≤350 fpm = 1.0, 500 fpm = 1.10, 700 fpm = 1.20, 1000+ fpm = 1.35, 1200+ fpm = 1.50
  let speedMult = 1.0;
  if (speedFpm > 1000) speedMult = 1.50;
  else if (speedFpm > 700) speedMult = 1.35;
  else if (speedFpm > 500) speedMult = 1.20;
  else if (speedFpm > 350) speedMult = 1.10;
  return Math.round(base * speedMult);
}

/** Machine room floor load requirement (PSF).
 *  MRL has no machine room; geared/gearless rooms need 150-300 PSF depending on speed. */
function getMachineRoomLoadPsf(speedFpm: number, mrl: boolean): number {
  if (mrl) return 0;
  if (speedFpm <= 500) return 150;
  if (speedFpm <= 700) return 200;
  if (speedFpm <= 1000) return 250;
  return 300;
}

export interface StructuralLoads {
  machineWeightLbs: number;
  cabWeightLbs: number;
  counterweightLbs: number;
  guideRailLoadLbsPerFt: number;
  totalShaftReactionLbs: number;   // total dead load at pit per shaft
  machineRoomLoadPsf: number;       // machine room floor live load (PSF), 0 for MRL
  totalBankReactionLbs: number;     // all shafts combined
  beamReactionPerShaftLbs: number;  // point load at each machine beam (machine + sheave)
}

function estimateStructuralLoads(
  numElevators: number,
  capacityLbs: number,
  speedFpm: number,
  mrlEligible: boolean,
  travelFt: number
): StructuralLoads {
  const entry = STRUCTURAL_LOADS_BY_CAPACITY[capacityLbs] || STRUCTURAL_LOADS_BY_CAPACITY[4000];
  const machineWt = getMachineWeight(capacityLbs, speedFpm);
  // Guide rail total weight for this travel height (2 rails per shaft)
  const railTotalLbs = Math.round(entry.guideRailLoadLbsPerFt * travelFt * 2);
  // Rope weight approximation: ~1.5 lbs/ft per rope, 6-8 ropes typical
  const numRopes = speedFpm > 700 ? 8 : 6;
  const ropeTotalLbs = Math.round(1.5 * travelFt * numRopes);
  // Total per-shaft dead load reaction at pit
  const perShaft = machineWt + entry.cabWeightLbs + entry.counterweightLbs + railTotalLbs + ropeTotalLbs;
  const mrLoadPsf = getMachineRoomLoadPsf(speedFpm, mrlEligible);
  // Beam reaction: machine sits on steel beams — load is machine weight × 1.5 impact factor
  const beamReaction = Math.round(machineWt * 1.5);

  return {
    machineWeightLbs: machineWt,
    cabWeightLbs: entry.cabWeightLbs,
    counterweightLbs: entry.counterweightLbs,
    guideRailLoadLbsPerFt: entry.guideRailLoadLbsPerFt,
    totalShaftReactionLbs: Math.round(perShaft),
    machineRoomLoadPsf: mrLoadPsf,
    totalBankReactionLbs: Math.round(perShaft * numElevators),
    beamReactionPerShaftLbs: beamReaction,
  };
}

/** Electrical requirements by capacity and speed.
 *  Motor HP derived from: HP ≈ (capacity_lbs × speed_fpm) / 33000 / efficiency.
 *  Efficiency ~0.80 for gearless AC PM motors.
 *  kVA demand uses 0.80 power factor and accounts for regenerative drives.
 *  Feeder size from NEC 430 motor branch circuit rules + demand factor. */
export interface ElectricalRequirements {
  motorHp: number;
  motorKw: number;
  demandKva: number;           // running demand per elevator
  feederAmps: number;          // per-elevator feeder amperage at 480V 3-phase
  totalBankKva: number;        // total bank demand (with diversity factor)
  totalBankAmps: number;       // total bank feeder at 480V 3-phase
  voltageSystem: string;       // e.g. "480V/3Ph/60Hz"
  wireSize: string;            // recommended conductor size per elevator
  disconnectSize: string;      // disconnect switch rating
  controllerType: string;      // AC-VF, AC-PM, etc.
}

function estimateElectrical(
  numElevators: number,
  capacityLbs: number,
  speedFpm: number
): ElectricalRequirements {
  // Motor HP from first principles
  const efficiency = 0.80;
  const motorHp = Math.round((capacityLbs * speedFpm) / (33000 * efficiency));
  const motorKw = Math.round(motorHp * 0.746 * 10) / 10;
  
  // kVA per elevator: motor kW / power factor (0.85 typical for VFD)
  const pf = 0.85;
  const demandKva = Math.round(motorKw / pf * 10) / 10;
  
  // Feeder amps at 480V 3-phase: kVA × 1000 / (480 × √3)
  const feederAmps = Math.round(demandKva * 1000 / (480 * 1.732));
  
  // Diversity factor for multiple elevators in a bank
  // Per ASHRAE/NEC guidance: 1 elev = 1.0, 2 = 0.95, 3-4 = 0.85, 5-6 = 0.80, 7+ = 0.75
  let diversity = 1.0;
  if (numElevators >= 7) diversity = 0.75;
  else if (numElevators >= 5) diversity = 0.80;
  else if (numElevators >= 3) diversity = 0.85;
  else if (numElevators >= 2) diversity = 0.95;
  
  const totalBankKva = Math.round(demandKva * numElevators * diversity * 10) / 10;
  const totalBankAmps = Math.round(totalBankKva * 1000 / (480 * 1.732));
  
  // Wire size (NEC 430 — 125% of FLC for continuous motor loads)
  const fla125 = Math.round(feederAmps * 1.25);
  let wireSize: string;
  if (fla125 <= 20) wireSize = "#12 AWG";
  else if (fla125 <= 30) wireSize = "#10 AWG";
  else if (fla125 <= 40) wireSize = "#8 AWG";
  else if (fla125 <= 55) wireSize = "#6 AWG";
  else if (fla125 <= 70) wireSize = "#4 AWG";
  else if (fla125 <= 95) wireSize = "#3 AWG";
  else if (fla125 <= 115) wireSize = "#2 AWG";
  else if (fla125 <= 130) wireSize = "#1 AWG";
  else if (fla125 <= 150) wireSize = "1/0 AWG";
  else if (fla125 <= 175) wireSize = "2/0 AWG";
  else if (fla125 <= 200) wireSize = "3/0 AWG";
  else if (fla125 <= 230) wireSize = "4/0 AWG";
  else if (fla125 <= 310) wireSize = "250 kcmil";
  else wireSize = "350 kcmil";
  
  // Disconnect size — next standard size above 115% FLA
  const fla115 = Math.round(feederAmps * 1.15);
  const stdDisconnects = [30, 60, 100, 200, 400, 600];
  const disconnectAmps = stdDisconnects.find(s => s >= fla115) || 600;
  const disconnectSize = `${disconnectAmps}A`;
  
  // Controller type
  let controllerType = "AC-VF (Variable Frequency)";
  if (speedFpm >= 500) controllerType = "AC-PM (Permanent Magnet)";
  if (speedFpm >= 1000) controllerType = "AC-PM Gearless";
  
  return {
    motorHp,
    motorKw,
    demandKva,
    feederAmps,
    totalBankKva,
    totalBankAmps,
    voltageSystem: "480V / 3Ph / 60Hz",
    wireSize,
    disconnectSize,
    controllerType,
  };
}

function estimateShaftLayout(numElevators: number, capacityLbs: number, speedFpm: number, travelFt: number = 200): {
  shaftCount: number;
  shaftSizeFt: string;
  bankArrangement: string;
  approxCoreSqft: number;
  pitDepthFt: number;
  overheadClearanceFt: number;
  mrlEligible: boolean;
  structural: StructuralLoads;
  electrical: ElectricalRequirements;
} {
  const cab = CAB_DIMENSIONS[capacityLbs] || CAB_DIMENSIONS[4000];
  // Shaft = cab + structure (2 ft width, 2.5 ft depth for counterweight & rails)
  const shaftW = cab.cabW + 2.0;
  const shaftD = cab.cabD + 2.5;

  // Bank arrangement: elevators face across a lobby corridor (~8 ft wide).
  // Layout as N-across × M-deep (two rows facing each other across the lobby).
  let across: number, deep: number;
  if (numElevators <= 4) {
    // Single row
    across = numElevators;
    deep = 1;
  } else if (numElevators % 2 === 0) {
    // Two rows facing each other
    across = numElevators / 2;
    deep = 2;
  } else {
    // Odd number > 4: split as evenly as possible
    across = Math.ceil(numElevators / 2);
    deep = 2;
  }

  const bankArrangement = deep === 1
    ? `${across} in a row`
    : `${across} \u00d7 ${deep}`;

  // Core area = bank footprint including elevator lobby between rows
  const lobbyWidth = deep === 2 ? 8 : 0; // 8 ft lobby corridor between facing rows
  const bankWidth = across * shaftW;
  const bankDepth = deep * shaftD + lobbyWidth;
  const approxCoreSqft = Math.round(bankWidth * bankDepth);

  // Format shaft size as W'−D" × D'−D" (feet and inches)
  const fmtFtIn = (ft: number) => {
    const whole = Math.floor(ft);
    const inches = Math.round((ft - whole) * 12);
    return inches === 0 ? `${whole}'-0"` : `${whole}'-${inches}"`;
  };
  const shaftSizeFt = `${fmtFtIn(shaftW)} × ${fmtFtIn(shaftD)}`;

  // Pit depth & overhead clearance
  const pitOh = getPitOverhead(speedFpm);

  // Structural loads
  const structural = estimateStructuralLoads(numElevators, capacityLbs, speedFpm, pitOh.mrlEligible, travelFt);

  // Electrical requirements
  const electrical = estimateElectrical(numElevators, capacityLbs, speedFpm);

  return {
    shaftCount: numElevators,
    shaftSizeFt,
    bankArrangement,
    approxCoreSqft,
    pitDepthFt: pitOh.pitDepthFt,
    overheadClearanceFt: pitOh.overheadClearanceFt,
    mrlEligible: pitOh.mrlEligible,
    structural,
    electrical,
  };
}

// ═══════════════════════════════════════════════
// NUMBER OF ELEVATORS (BACK-SOLVE FROM HC% TARGET)
// ═══════════════════════════════════════════════

/**
 * Back-solve for the minimum number of elevators that satisfies ALL three
 * performance criteria simultaneously:
 *   1. Interval  ≤ targetInterval   (RTT / L ≤ targetInterval)
 *   2. HC%       ≥ targetHcPercent  (300·P·L/RTT / pop ≥ targetHcPercent/100)
 *   3. AWT       ≤ maxAwt           (interval × AWT_ratio ≤ maxAwt)
 */
function calculateNumElevators(
  rtt: number,
  targetInterval: number,
  targetHcPercent: number,
  zonePop: number,
  P: number,
  maxAwt: number
): number {
  // From interval constraint: L ≥ RTT / targetInterval
  const fromInterval = rtt / targetInterval;
  
  // From HC% constraint: L ≥ (effectiveTarget / 100) × pop × RTT / (300 × P)
  // Apply ±1% tolerance: back-solve to (target − 1)% so fewer elevators are needed
  const effectiveHcTarget = targetHcPercent - 1.0;
  const requiredHcPersons = zonePop * effectiveHcTarget / 100;
  const fromHC = requiredHcPersons * rtt / (300 * P);
  
  // From AWT constraint: interval × AWT_ratio ≤ maxAwt → L ≥ RTT × AWT_ratio / maxAwt
  const fromAWT = (rtt * AWT_INTERVAL_RATIO) / maxAwt;
  
  return Math.max(Math.ceil(fromInterval), Math.ceil(fromHC), Math.ceil(fromAWT), 2);
}

// ═══════════════════════════════════════════════
// MAIN ANALYSIS FUNCTION
// ═══════════════════════════════════════════════

export function analyzeElevators(
  buildingType: BuildingType,
  floors: FloorInput[],
  defaultFloorHeight: number,
  densityOverride?: number,
  criteriaOverrides?: Partial<CriteriaThresholds>,
  destinationDispatch?: boolean
): AnalysisResult {
  const config = BUILDING_CONFIGS[buildingType];
  const density = densityOverride || config.densitySqftPerPerson;

  // Compute cumulative elevations from floor-to-floor heights
  // and stamp them onto the FloorInput objects so recalculateZone can use them
  const elevations = computeElevations(floors, defaultFloorHeight);
  for (const f of floors) {
    const elev = elevations.get(f.floorLabel);
    if (elev !== undefined) f.elevation = elev;
  }

  // Determine if floors have pre-defined zones from spreadsheet
  const hasZoneCodes = floors.some((f) => f.zone && !f.zone.includes(",") && f.zone.trim().length > 0);

  // All floors with zone data or no zone (manual input) are served
  const servedFloors = floors.filter((f) => {
    if (!f.zone) return true; // no zone = include (manual input case)
    return f.zone.trim().length > 0; // include all floors with any zone tag
  });

  const zoneDefinitions = hasZoneCodes
    ? buildZonesFromSpreadsheet(floors)
    : autoZoneFloors(servedFloors);

  // Population for DEMAND floors only (excludes lobby/transfer floors):
  // - If totalPopulation is set (e.g. hotel keys, residential units), use it directly
  // - Otherwise calculate from density (per-floor density takes priority over global)
  const floorPopulations = new Map<string, number>();
  for (const f of servedFloors) {
    if (isLobbyFloor(f)) {
      // Lobby/transfer floors don't generate demand
      floorPopulations.set(f.floorLabel, 0);
      continue;
    }
    if (f.totalPopulation !== undefined && f.totalPopulation > 0) {
      floorPopulations.set(f.floorLabel, f.totalPopulation);
    } else {
      const netArea = f.grossArea * config.netToGrossRatio;
      const floorDensity = f.densitySqftPerPerson ?? density;
      const rawPop = netArea / floorDensity;
      floorPopulations.set(f.floorLabel, Math.round(rawPop * config.attendanceFactor));
    }
  }

  const totalFloors = servedFloors.length;
  const totalGrossArea = servedFloors.reduce((sum, f) => sum + f.grossArea, 0);
  const totalPopulation = [...floorPopulations.values()].reduce((s, p) => s + p, 0);

  // Effective criteria thresholds
  const effHcTarget = criteriaOverrides?.minHcPercent ?? config.minHc5Percent;
  const effInterval = criteriaOverrides?.maxIntervalSec ?? config.targetIntervalSec;
  const effAwt = criteriaOverrides?.maxAwtSec ?? config.maxAwt;

  const zones: ZoneOutput[] = zoneDefinitions.map((zone, idx) => {
    const zoneFloorCount = zone.floors.length;

    // Zone population from DEMAND floors only (excludes lobby/transfer)
    const zonePop = zone.demandFloors.reduce(
      (sum, f) => sum + (floorPopulations.get(f.floorLabel) || 0),
      0
    );

    // Average floor-to-floor height for this zone
    const zoneHeights = zone.floors
      .filter((f) => f.floorToFloorHeight)
      .map((f) => f.floorToFloorHeight!);
    const avgZoneHeight =
      zoneHeights.length > 0
        ? zoneHeights.reduce((s, h) => s + h, 0) / zoneHeights.length
        : defaultFloorHeight;

    // Express distance: from ground floor (lowest elevation in building)
    // to the lowest DEMAND floor in this zone
    const demandElevs = zone.demandFloors.map(f => elevations.get(f.floorLabel) || 0);
    const lowestDemandElev = demandElevs.length > 0 ? Math.min(...demandElevs) : 0;
    
    // Find the highest lobby/transfer floor elevation in this zone
    // (express is from the sky lobby to the first demand floor)
    const lobbyFloors = zone.floors.filter(f => isLobbyFloor(f));
    const highestLobbyElev = lobbyFloors.length > 0
      ? Math.max(...lobbyFloors.map(f => elevations.get(f.floorLabel) || 0))
      : 0;
    
    // Express distance = from highest lobby floor to lowest demand floor
    const expressFeet = Math.max(0, lowestDemandElev - highestLobbyElev);

    // Zone top elevation — the highest floor elevation in this zone
    const allZoneElevs = zone.floors.map(f => elevations.get(f.floorLabel) || 0);
    const zoneTopElevation = Math.max(...allZoneElevs, 0);

    // Required 5-min handling capacity from target HC% (with 1% tolerance)
    const requiredHC = Math.ceil(zonePop * ((effHcTarget - 1.0) / 100));

    // Select speed based on zone top elevation (industry rule: elevation/28 × 60)
    const speed = selectSpeed(zoneTopElevation);

    // Initial passenger estimate
    let P = Math.min(Math.ceil(requiredHC / 10), 20);
    P = Math.max(P, 8);
    let capacity = selectCapacity(P);
    P = Math.round(capacity.persons * CAR_LOADING_FACTOR);

    // Per-floor demand populations (for weighted expected stops)
    const demandFloorPops = zone.demandFloors.map(
      f => floorPopulations.get(f.floorLabel) || 0
    );

    // Express travel time (S-curve kinematics)
    const expressTimeSec = expressRoundTripTime(expressFeet, speed);

    // Zone RTT — apply mixed-traffic, interfloor, and destination dispatch factors
    const trafficFactor = config.trafficPattern === 'mixed' ? MIXED_TRAFFIC_RTT_FACTOR : 1;
    const interfloorFactor = INTERFLOOR_TRAFFIC_FACTOR[buildingType] ?? 1.10;
    const dispatchFactor = destinationDispatch ? DESTINATION_DISPATCH_FACTOR : 1;
    // DD applies to zone RTT only (stop reduction), express time is unaffected
    let zoneRtt = calculateRTT(zoneFloorCount, P, speed, avgZoneHeight, 8, demandFloorPops)
      * trafficFactor * interfloorFactor * dispatchFactor;
    let rtt = zoneRtt + expressTimeSec;

    // Number of elevators — back-solve from all three criteria
    let numElevators = calculateNumElevators(rtt, effInterval, effHcTarget, zonePop, P, effAwt);
    numElevators = Math.min(numElevators, 8);

    // If capped at 8, check if all criteria are met; if not, upsize cars
    if (numElevators === 8) {
      const actualHC = (300 * P * numElevators) / rtt;
      const actualInterval = rtt / numElevators;
      const actualAWT = actualInterval * AWT_INTERVAL_RATIO;
      const needsUpsize = actualHC < requiredHC || actualInterval > effInterval || actualAWT > effAwt;
      if (needsUpsize) {
        // Find the smallest standard car that satisfies all constraints at L=8
        for (const cap of STANDARD_CAPACITIES) {
          const tryP = Math.round(cap.persons * CAR_LOADING_FACTOR);
          const tryZoneRtt = calculateRTT(zoneFloorCount, tryP, speed, avgZoneHeight, 8, demandFloorPops)
            * trafficFactor * interfloorFactor * dispatchFactor;
          const tryRtt = tryZoneRtt + expressTimeSec;
          const tryHC = (300 * tryP * numElevators) / tryRtt;
          const tryInterval = tryRtt / numElevators;
          const tryAWT = tryInterval * AWT_INTERVAL_RATIO;
          if (tryHC >= requiredHC && tryInterval <= effInterval && tryAWT <= effAwt) {
            capacity = cap;
            P = tryP;
            zoneRtt = tryZoneRtt;
            rtt = tryRtt;
            break;
          }
        }
        // If no standard car satisfies, use largest available
        if ((300 * P * numElevators) / rtt < requiredHC) {
          capacity = STANDARD_CAPACITIES[STANDARD_CAPACITIES.length - 1];
          P = Math.round(capacity.persons * CAR_LOADING_FACTOR);
          zoneRtt = calculateRTT(zoneFloorCount, P, speed, avgZoneHeight, 8, demandFloorPops)
            * trafficFactor * interfloorFactor * dispatchFactor;
          rtt = zoneRtt + expressTimeSec;
        }
      }
    }

    const interval = rtt / numElevators;
    const handlingCapacity5min = (300 * P * numElevators) / rtt;
    const hc5Percent = zonePop > 0 ? (handlingCapacity5min / zonePop) * 100 : 0;
    const awt = interval * AWT_INTERVAL_RATIO;

    // HC% tolerance: pass if within 1% of the target (e.g. 13% passes for 14% target)
    const meetsPerformance =
      interval <= effInterval &&
      hc5Percent >= (effHcTarget - 1.0) &&
      awt <= effAwt;

    // ---- Shaft count & core area estimate ----
    const shaftInfo = estimateShaftLayout(numElevators, capacity.lbs, speed, zoneTopElevation);

    // ---- Down-peak / lunchtime analysis ----
    // Down-peak: everyone leaves at once.  RTT is ~20% longer than up-peak
    // because cars fill at upper floors and empty at lobby (reversed loading).
    // The car makes approximately the same number of stops but passengers
    // are spread across more floors (departures from every floor, single destination).
    // Industry standard: down-peak RTT ≈ 1.20× up-peak RTT (CIBSE Guide D).
    const DOWN_PEAK_RTT_FACTOR = 1.20;
    const downPeakRtt = rtt * DOWN_PEAK_RTT_FACTOR;
    const downPeakInterval = downPeakRtt / numElevators;
    const downPeakHcRaw = (300 * P * numElevators) / downPeakRtt;
    const downPeakHcPercent = zonePop > 0 ? (downPeakHcRaw / zonePop) * 100 : 0;
    const downPeakAwt = downPeakInterval * AWT_INTERVAL_RATIO;
    const downPeakMeets =
      downPeakInterval <= effInterval &&
      downPeakHcPercent >= (effHcTarget - 1.0) &&
      downPeakAwt <= effAwt;

    return {
      zoneName: zone.zoneName,
      zoneIndex: idx,
      floorsServed: formatFloorList(
        zone.floors.map((f) => parseInt(f.floorLabel.replace(/\D/g, "")) || 0)
      ),
      floorCount: zoneFloorCount,
      numElevators,
      capacityLbs: capacity.lbs,
      capacityPersons: capacity.persons,
      speedFpm: speed,
      densitySqftPerPerson: Math.round(density),
      totalPopulation: zonePop,
      handlingCapacityPercent: Math.round(hc5Percent * 10) / 10,
      avgWaitTimeSec: Math.round(awt * 10) / 10,
      intervalSec: Math.round(interval * 10) / 10,
      roundTripTimeSec: Math.round(rtt * 10) / 10,
      meetsPerformanceCriteria: meetsPerformance,
      // Shaft & core
      shaftCount: shaftInfo.shaftCount,
      shaftSizeFt: shaftInfo.shaftSizeFt,
      bankArrangement: shaftInfo.bankArrangement,
      approxCoreSqft: shaftInfo.approxCoreSqft,
      pitDepthFt: shaftInfo.pitDepthFt,
      overheadClearanceFt: shaftInfo.overheadClearanceFt,
      mrlEligible: shaftInfo.mrlEligible,
      // Structural & Electrical
      structural: shaftInfo.structural,
      electrical: shaftInfo.electrical,
      // Down-peak
      downPeakIntervalSec: Math.round(downPeakInterval * 10) / 10,
      downPeakHcPercent: Math.round(downPeakHcPercent * 10) / 10,
      downPeakAwtSec: Math.round(downPeakAwt * 10) / 10,
      downPeakRttSec: Math.round(downPeakRtt * 10) / 10,
      downPeakMeetsCriteria: downPeakMeets,
    };
  });

  return {
    buildingType,
    totalFloors,
    totalGrossArea,
    totalPopulation,
    numZones: zones.length,
    zones,
  };
}

// ═══════════════════════════════════════════════
// ZONE RECALCULATION WITH OVERRIDES
// ═══════════════════════════════════════════════

/**
 * Recalculate a single zone's metrics with user-specified overrides.
 * Accepts the original zone output (for floor geometry) and overrides for
 * numElevators, capacityLbs, speedFpm, and densitySqftPerPerson.
 * Returns a fresh ZoneOutput with recalculated RTT, interval, AWT, HC%, and pass/fail.
 * Includes weighted expected stops, interfloor traffic, shaft/core area, and down-peak analysis.
 */
export function recalculateZone(
  original: ZoneOutput,
  overrides: ZoneOverride,
  buildingType: BuildingType,
  zoneFloors: FloorInput[],
  defaultFloorHeight: number,
  criteriaOverrides?: Partial<CriteriaThresholds>,
  destinationDispatch?: boolean
): ZoneOutput {
  const config = BUILDING_CONFIGS[buildingType];
  const density = overrides.densitySqftPerPerson ?? original.densitySqftPerPerson;
  const speedFpm = overrides.speedFpm ?? original.speedFpm;

  // Resolve capacity
  let capacityLbs = overrides.capacityLbs ?? original.capacityLbs;
  const capEntry = STANDARD_CAPACITIES.find((c) => c.lbs === capacityLbs);
  const capacityPersons = capEntry ? capEntry.persons : Math.round(capacityLbs / 150);
  const P = Math.round(capacityPersons * CAR_LOADING_FACTOR);

  // Separate demand floors from lobby/transfer floors
  const demandFloors = zoneFloors.filter(f => !isLobbyFloor(f));
  const lobbyFloors = zoneFloors.filter(f => isLobbyFloor(f));

  // Recompute population with potentially different density (per-floor takes priority)
  // Build per-floor population array for weighted expected stops
  const demandFloorPops: number[] = [];
  let zonePop = 0;
  for (const f of demandFloors) {
    let pop: number;
    if (f.totalPopulation !== undefined && f.totalPopulation > 0) {
      pop = f.totalPopulation;
    } else {
      const netArea = f.grossArea * config.netToGrossRatio;
      const floorDensity = f.densitySqftPerPerson ?? density;
      pop = Math.round((netArea / floorDensity) * config.attendanceFactor);
    }
    demandFloorPops.push(pop);
    zonePop += pop;
  }

  // Zone geometry
  const zoneFloorCount = zoneFloors.length;
  const zoneHeights = zoneFloors.filter((f) => f.floorToFloorHeight).map((f) => f.floorToFloorHeight!);
  const avgZoneHeight = zoneHeights.length > 0
    ? zoneHeights.reduce((s, h) => s + h, 0) / zoneHeights.length
    : defaultFloorHeight;

  // Compute elevations for express distance
  const elevations = computeElevations(zoneFloors, defaultFloorHeight);
  const demandElevs = demandFloors.map(f => elevations.get(f.floorLabel) || 0);
  const lowestDemandElev = demandElevs.length > 0 ? Math.min(...demandElevs) : 0;
  const highestLobbyElev = lobbyFloors.length > 0
    ? Math.max(...lobbyFloors.map(f => elevations.get(f.floorLabel) || 0))
    : 0;
  const expressFeet = Math.max(0, lowestDemandElev - highestLobbyElev);
  const expressTimeSec = expressRoundTripTime(expressFeet, speedFpm);

  // Door height override (7 or 8 ft; default 8)
  const doorHt = overrides.doorHeightFt ?? 8;

  // RTT with overridden speed, capacity, and door height
  // Uses weighted expected stops when per-floor populations are available
  // Applies traffic pattern, interfloor, and dispatch factors
  const trafficFactor = config.trafficPattern === 'mixed' ? MIXED_TRAFFIC_RTT_FACTOR : 1;
  const interfloorFactor = INTERFLOOR_TRAFFIC_FACTOR[buildingType] ?? 1.10;
  const dispatchFactor = destinationDispatch ? DESTINATION_DISPATCH_FACTOR : 1;
  const zoneRtt = calculateRTT(zoneFloorCount, P, speedFpm, avgZoneHeight, doorHt, demandFloorPops)
    * trafficFactor * interfloorFactor * dispatchFactor;
  const rtt = zoneRtt + expressTimeSec;

  // Elevator count — always from direct override or original (never back-solved from HC%)
  const numElevators = overrides.numElevators ?? original.numElevators;

  const interval = rtt / numElevators;
  const handlingCapacity5min = (300 * P * numElevators) / rtt;
  const hc5Percent = zonePop > 0 ? (handlingCapacity5min / zonePop) * 100 : 0;
  const awt = interval * AWT_INTERVAL_RATIO;

  const effInterval = criteriaOverrides?.maxIntervalSec ?? config.targetIntervalSec;
  // HC% tune overrides the pass threshold (not the elevator count)
  const effHc = overrides.handlingCapacityPercent ?? criteriaOverrides?.minHcPercent ?? config.minHc5Percent;
  const effAwt = criteriaOverrides?.maxAwtSec ?? config.maxAwt;
  // HC% tolerance: pass if within 1% of the target (e.g. 13% passes for 14% target)
  const meetsPerformance =
    interval <= effInterval &&
    hc5Percent >= (effHc - 1.0) &&
    awt <= effAwt;

  // ---- Shaft count & core area estimate ----
  const allZoneElevs = zoneFloors.map(f => elevations.get(f.floorLabel) || 0);
  const zoneTopElevation = Math.max(...allZoneElevs, 0);
  const shaftInfo = estimateShaftLayout(numElevators, capacityLbs, speedFpm, zoneTopElevation);

  // ---- Down-peak / lunchtime analysis ----
  const DOWN_PEAK_RTT_FACTOR = 1.20;
  const downPeakRtt = rtt * DOWN_PEAK_RTT_FACTOR;
  const downPeakInterval = downPeakRtt / numElevators;
  const downPeakHcRaw = (300 * P * numElevators) / downPeakRtt;
  const downPeakHcPercent = zonePop > 0 ? (downPeakHcRaw / zonePop) * 100 : 0;
  const downPeakAwt = downPeakInterval * AWT_INTERVAL_RATIO;
  const downPeakMeets =
    downPeakInterval <= effInterval &&
    downPeakHcPercent >= (effHc - 1.0) &&
    downPeakAwt <= effAwt;

  return {
    ...original,
    numElevators,
    capacityLbs,
    capacityPersons,
    speedFpm,
    densitySqftPerPerson: Math.round(density),
    totalPopulation: zonePop,
    handlingCapacityPercent: Math.round(hc5Percent * 10) / 10,
    avgWaitTimeSec: Math.round(awt * 10) / 10,
    intervalSec: Math.round(interval * 10) / 10,
    roundTripTimeSec: Math.round(rtt * 10) / 10,
    meetsPerformanceCriteria: meetsPerformance,
    // Shaft & core
    shaftCount: shaftInfo.shaftCount,
    shaftSizeFt: shaftInfo.shaftSizeFt,
    bankArrangement: shaftInfo.bankArrangement,
    approxCoreSqft: shaftInfo.approxCoreSqft,
    pitDepthFt: shaftInfo.pitDepthFt,
    overheadClearanceFt: shaftInfo.overheadClearanceFt,
    mrlEligible: shaftInfo.mrlEligible,
    // Structural & Electrical
    structural: shaftInfo.structural,
    electrical: shaftInfo.electrical,
    // Down-peak
    downPeakIntervalSec: Math.round(downPeakInterval * 10) / 10,
    downPeakHcPercent: Math.round(downPeakHcPercent * 10) / 10,
    downPeakAwtSec: Math.round(downPeakAwt * 10) / 10,
    downPeakRttSec: Math.round(downPeakRtt * 10) / 10,
    downPeakMeetsCriteria: downPeakMeets,
  };
}

// ═══════════════════════════════════════════════
// CRITERIA HELPERS
// ═══════════════════════════════════════════════

export interface CriteriaThresholds {
  maxIntervalSec: number;
  minHcPercent: number;
  maxAwtSec: number;
}

/** Return the default pass/fail criteria for a given building type. */
export function getDefaultCriteria(buildingType: BuildingType): CriteriaThresholds {
  const c = BUILDING_CONFIGS[buildingType];
  return {
    maxIntervalSec: c.targetIntervalSec,
    minHcPercent: c.minHc5Percent,
    maxAwtSec: c.maxAwt,
  };
}

// Export constants for UI dropdowns
export { STANDARD_CAPACITIES, STANDARD_SPEEDS };
