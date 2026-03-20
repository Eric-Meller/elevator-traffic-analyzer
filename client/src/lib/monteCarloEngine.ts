/**
 * Monte Carlo Elevator Traffic Simulation Engine
 *
 * Methodology based on "Elevator Traffic-Flow Prediction Based on Monte
 * Carlo Method" (Wang Sheng et al., Elevator World).
 *
 * Core principles:
 *   1. Poisson arrivals — passengers arrive as a Poisson process with
 *      rate λ = population × arrivalRate / 300 s.
 *   2. Origin/Destination via cumulative probability (CDF) — the "improved
 *      roulette model" from the article.  Per-floor population weights
 *      build a CDF; inverse-transform sampling picks floors.
 *   3. Traffic-pattern split — three fractions (x, y, z) control the
 *      mix of upward, downward, and interfloor trips per the article's
 *      OD-matrix methodology.
 *   4. Raw simulated AWT — each passenger's wait is boardTime − arrivalTime.
 *      The trial mean AWT is the average across all boarded passengers.
 *      NO formula-based override (interval × 0.55); the simulation is
 *      the measurement instrument.
 *   5. Multiple trials (N = 200-2000) — aggregate statistics (median,
 *      P10/P90) characterise the stochastic distribution.
 *
 * The deterministic engine's AWT = (RTT/L) × 0.55 is a theoretical
 * steady-state approximation.  MC AWTs will typically be somewhat lower
 * because the simulation captures actual dispatch efficiency, lobby
 * batching, and finite-duration effects.  Both are valid; they answer
 * different questions (theoretical capacity vs. simulated experience).
 */

// ═══════════════════════════════════════════════════════════════════
// PUBLIC INTERFACES
// ═══════════════════════════════════════════════════════════════════

export interface MonteCarloParams {
  numElevators: number;
  capacityLbs: number;
  capacityPersons: number;
  speedFpm: number;
  numTrials: number;            // default 1000
  simulationDuration: number;   // seconds, default 300 (5 min)
  floorHeights: number[];       // floor-to-floor height per zone floor (ft)
  floorPopulations: number[];   // population per demand floor
  expressDistanceFt: number;    // lobby → zone bottom express distance (ft)
  arrivalRate: number;          // fraction of population arriving in 5 min
  doorHeightFt: number;         // 7 or 8
  trafficPattern: 'uppeak' | 'mixed';
  deterministicRttSec?: number; // deterministic RTT (for interval / formula-AWT reference)
  elevatorsOutOfService?: number;
  seed?: number;                // PRNG seed (default 42)
}

export interface MonteCarloResult {
  // Summary statistics (across all trials)
  medianAwtSec: number;
  p10AwtSec: number;
  p90AwtSec: number;
  meanAwtSec: number;
  medianIntervalSec: number;
  p90IntervalSec: number;
  meanHcPercent: number;
  p10HcPercent: number;
  medianRttSec: number;

  // Per-trial arrays for histograms
  trialAwts: number[];
  trialHcPercents: number[];
  trialIntervals: number[];

  // Timeline from a single representative trial (10 s buckets)
  timelineData: {
    timeSec: number;
    waitingPassengers: number;
    activeElevators: number;
    passengersServed: number;
  }[];

  // Car utilization (average % time busy, per car index)
  carUtilization: number[];

  // Stress test (when elevatorsOutOfService > 0)
  stressTest?: {
    elevatorsRemoved: number;
    medianAwtSec: number;
    p90AwtSec: number;
    meanHcPercent: number;
    degradationPercent: number;
  };

  confidenceLevel: number;
  numTrials: number;
  totalPassengersSimulated: number;
}

// ═══════════════════════════════════════════════════════════════════
// KINEMATIC CONSTANTS  (must match elevatorEngine.ts)
// ═══════════════════════════════════════════════════════════════════

const ACCEL_MAX = 1.0;       // m/s²
const JERK_RATE = 1.829;     // m/s³ (6.0 ft/s³)
const LEVELING_TIME = 0.5;   // seconds
const MOTOR_START_DELAY = 0.5;
const PASSENGER_TRANSFER = 1.6; // seconds per person
const CAR_LOADING_FACTOR = 0.80;
const FT_TO_M = 0.3048;
const FPM_TO_MPS = 0.00508;  // ft/min → m/s

const TICK_DT = 0.5; // simulation time step (seconds)

// ═══════════════════════════════════════════════════════════════════
// SEEDED PRNG  (Mulberry32 — fast, 32-bit, deterministic)
// ═══════════════════════════════════════════════════════════════════

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exponential variate: −ln(U) / λ */
function expVariate(rand: () => number, lambda: number): number {
  let u = rand();
  while (u === 0) u = rand();
  return -Math.log(u) / lambda;
}

// ═══════════════════════════════════════════════════════════════════
// CDF-BASED FLOOR SELECTION  (Article: "improved roulette model")
// ═══════════════════════════════════════════════════════════════════
//
// Per the article's "improved" method: build a cumulative density
// from per-floor populations, then use inverse-transform sampling.
// This is more accurate than the "traditional" max(rand × density)
// roulette because it correctly preserves probability mass.

/**
 * Build cumulative distribution function from population weights.
 * Returns Float64Array where CDF[i] = P(floor ≤ i).
 */
function buildCdf(populations: number[]): Float64Array {
  const total = populations.reduce((a, b) => a + b, 0);
  const cdf = new Float64Array(populations.length);
  if (total <= 0) {
    // Uniform fallback
    for (let i = 0; i < populations.length; i++) {
      cdf[i] = (i + 1) / populations.length;
    }
  } else {
    let cum = 0;
    for (let i = 0; i < populations.length; i++) {
      cum += populations[i] / total;
      cdf[i] = cum;
    }
    cdf[populations.length - 1] = 1.0; // avoid FP issues
  }
  return cdf;
}

/**
 * Inverse-transform sampling: pick floor index from CDF.
 * Article: "If lj_{i-1} < w < lj_i, the ith floor is the original floor."
 */
function sampleFromCdf(rand: () => number, cdf: Float64Array): number {
  const u = rand();
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cdf[mid] < u) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Build conditional CDF for destination given origin floor.
 * Excludes the origin floor, redistributes probability among remaining
 * floors.  This implements the article's OD matrix row normalisation:
 *   p_ij = od(i,j) / sum_i  where sum_i excludes i=j.
 */
function buildConditionalCdf(
  populations: number[],
  excludeIndex: number,
): Float64Array {
  let total = 0;
  for (let i = 0; i < populations.length; i++) {
    if (i !== excludeIndex) total += populations[i];
  }
  const cdf = new Float64Array(populations.length);
  if (total <= 0) {
    // Uniform excluding origin
    const n = populations.length - 1;
    let cum = 0;
    for (let i = 0; i < populations.length; i++) {
      if (i !== excludeIndex) {
        cum += 1 / n;
      }
      cdf[i] = cum;
    }
  } else {
    let cum = 0;
    for (let i = 0; i < populations.length; i++) {
      if (i !== excludeIndex) {
        cum += populations[i] / total;
      }
      cdf[i] = cum;
    }
  }
  cdf[populations.length - 1] = 1.0;
  return cdf;
}

// ═══════════════════════════════════════════════════════════════════
// TRAFFIC PATTERN SPLIT  (Article: x/y/z percentages)
// ═══════════════════════════════════════════════════════════════════
//
// x = fraction upward (lobby → floor)
// y = fraction downward (floor → lobby)
// z = fraction interfloor (floor → floor, both non-lobby)
// x + y + z = 1

interface TrafficSplit {
  x: number; // up (lobby → floor)
  y: number; // down (floor → lobby)
  z: number; // interfloor (floor → floor)
}

function getTrafficSplit(pattern: 'uppeak' | 'mixed'): TrafficSplit {
  switch (pattern) {
    case 'uppeak':
      return { x: 0.90, y: 0.05, z: 0.05 };
    case 'mixed':
      return { x: 0.45, y: 0.45, z: 0.10 };
    default:
      return { x: 0.90, y: 0.05, z: 0.05 };
  }
}

// ═══════════════════════════════════════════════════════════════════
// S-CURVE KINEMATICS  (copied from elevatorEngine.ts)
// ═══════════════════════════════════════════════════════════════════

function sCurveAccelPhase(V: number, aMax: number, j: number): { t: number; d: number } {
  const tj = aMax / j;
  const vJerkPair = (aMax * aMax) / j;

  if (vJerkPair >= V) {
    const aPeak = Math.sqrt(j * V);
    const tjr = aPeak / j;
    return { t: 2 * tjr, d: V * tjr };
  }

  const vRemaining = V - vJerkPair;
  const tConst = vRemaining / aMax;
  const tTotal = 2 * tj + tConst;

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

function sCurveTravelTime(Vmax: number, d: number, aMax: number, j: number): number {
  if (d <= 0) return 0;
  const accel = sCurveAccelPhase(Vmax, aMax, j);
  if (2 * accel.d <= d) {
    const dCruise = d - 2 * accel.d;
    return 2 * accel.t + dCruise / Vmax;
  }
  let lo = 0, hi = Vmax;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const r = sCurveAccelPhase(mid, aMax, j);
    if (2 * r.d <= d) lo = mid; else hi = mid;
  }
  const r = sCurveAccelPhase((lo + hi) / 2, aMax, j);
  return 2 * r.t;
}

// ═══════════════════════════════════════════════════════════════════
// PRE-COMPUTED TRAVEL TIME TABLE
// ═══════════════════════════════════════════════════════════════════

function buildTravelTimeTable(
  floorElevationsFt: Float64Array,
  speedFpm: number,
): Float64Array {
  const N = floorElevationsFt.length;
  const VmaxMps = speedFpm * FPM_TO_MPS;
  const table = new Float64Array(N * N);

  for (let a = 0; a < N; a++) {
    for (let b = a + 1; b < N; b++) {
      const distM = Math.abs(floorElevationsFt[b] - floorElevationsFt[a]) * FT_TO_M;
      const t = sCurveTravelTime(VmaxMps, distM, ACCEL_MAX, JERK_RATE) + LEVELING_TIME;
      table[a * N + b] = t;
      table[b * N + a] = t;
    }
  }
  return table;
}

/** Door cycle time by door height (matches elevatorEngine.ts). */
function doorCycleTime(doorHeightFt: number): number {
  return doorHeightFt <= 7 ? 7.0 : 8.5;
}

// ═══════════════════════════════════════════════════════════════════
// PASSENGER & CAR TYPES
// ═══════════════════════════════════════════════════════════════════

interface Passenger {
  arrivalTime: number;     // sim time when hall call placed
  originFloor: number;     // 0 = lobby, 1..N = zone floors
  destFloor: number;
  boardTime: number;       // sim time when boarded (set during sim)
  alightTime: number;      // sim time when alighted (set during sim)
}

const enum CarState {
  Idle = 0,
  LobbyDwell = 1,          // holding at lobby to batch passengers
  TravelingToFloor = 2,
  DoorOpening = 3,
  Boarding = 4,
  DoorClosing = 5,
}

/** Lobby dispatch batch delay: after a passenger is assigned to an idle car
 *  at lobby, the car waits this many seconds before departing, allowing
 *  additional arrivals to board the same car. */
const LOBBY_DISPATCH_DELAY_SEC = 5.0;

interface Car {
  id: number;
  state: CarState;
  currentFloor: number;
  targetFloor: number;
  passengers: Passenger[];
  tripPlan: number[];
  stateTimer: number;
  maxPassengers: number;
  busyTicks: number;
  lobbyDwellTimer: number;
  lastLobbyDepartureTime: number;
  roundTripTimes: number[];
}

// ═══════════════════════════════════════════════════════════════════
// DISPATCH ALGORITHM — destination dispatch heuristic
// ═══════════════════════════════════════════════════════════════════

function insertionCost(
  car: Car,
  floor: number,
  travelTable: Float64Array,
  numFloors: number,
): number {
  if (car.passengers.length >= car.maxPassengers) return Infinity;
  const plan = car.tripPlan;
  if (plan.indexOf(floor) !== -1) return 0;
  if (plan.length === 0) {
    return travelTable[car.currentFloor * numFloors + floor];
  }

  let bestCost = Infinity;
  for (let i = 0; i <= plan.length; i++) {
    const prev = i === 0 ? car.currentFloor : plan[i - 1];
    const next = i < plan.length ? plan[i] : -1;
    let originalEdge = 0;
    if (next >= 0) originalEdge = travelTable[prev * numFloors + next];
    let newEdge = travelTable[prev * numFloors + floor];
    if (next >= 0) newEdge += travelTable[floor * numFloors + next];
    const cost = newEdge - originalEdge;
    if (cost < bestCost) bestCost = cost;
  }
  return bestCost;
}

function dispatchPassenger(
  passenger: Passenger,
  cars: Car[],
  travelTable: Float64Array,
  numFloors: number,
): number {
  let bestCar = -1;
  let bestCost = Infinity;

  for (let c = 0; c < cars.length; c++) {
    const car = cars[c];
    if (car.passengers.length >= car.maxPassengers) continue;

    let pickupCost = 0;
    if (car.currentFloor !== passenger.originFloor &&
        car.tripPlan.indexOf(passenger.originFloor) === -1) {
      pickupCost = insertionCost(car, passenger.originFloor, travelTable, numFloors);
    }
    const deliverCost = insertionCost(car, passenger.destFloor, travelTable, numFloors);
    const totalCost = pickupCost + deliverCost;

    const idleBonus = car.state === CarState.Idle ? -0.01 : 0;
    const loadPenalty = car.passengers.length * 0.5;
    const score = totalCost + idleBonus + loadPenalty;

    if (score < bestCost) {
      bestCost = score;
      bestCar = c;
    }
  }

  if (bestCar >= 0) {
    const car = cars[bestCar];
    if (car.currentFloor !== passenger.originFloor &&
        car.tripPlan.indexOf(passenger.originFloor) === -1) {
      insertFloorIntoTripPlan(car, passenger.originFloor, travelTable, numFloors);
    }
    if (car.tripPlan.indexOf(passenger.destFloor) === -1) {
      insertFloorIntoTripPlan(car, passenger.destFloor, travelTable, numFloors);
    }
  }

  return bestCar;
}

function insertFloorIntoTripPlan(
  car: Car,
  floor: number,
  travelTable: Float64Array,
  numFloors: number,
): void {
  const plan = car.tripPlan;
  if (plan.indexOf(floor) !== -1) return;
  if (plan.length === 0) {
    plan.push(floor);
    return;
  }

  let bestIdx = 0;
  let bestCost = Infinity;
  for (let i = 0; i <= plan.length; i++) {
    const prev = i === 0 ? car.currentFloor : plan[i - 1];
    const next = i < plan.length ? plan[i] : -1;
    let originalEdge = 0;
    if (next >= 0) originalEdge = travelTable[prev * numFloors + next];
    let newEdge = travelTable[prev * numFloors + floor];
    if (next >= 0) newEdge += travelTable[floor * numFloors + next];
    const cost = newEdge - originalEdge;
    if (cost < bestCost) {
      bestCost = cost;
      bestIdx = i;
    }
  }
  plan.splice(bestIdx, 0, floor);
}

// ═══════════════════════════════════════════════════════════════════
// SINGLE TRIAL SIMULATION
// ═══════════════════════════════════════════════════════════════════

interface TrialResult {
  meanAwt: number;             // raw simulated mean AWT (boardTime - arrivalTime)
  meanInterval: number;        // mean interval between lobby departures
  simulatedRtt: number;        // mean per-car round trip time
  hcPercent: number;
  totalServed: number;
  totalArrived: number;
  passengerWaits: number[];
  timeline: {
    timeSec: number;
    waitingPassengers: number;
    activeElevators: number;
    passengersServed: number;
  }[];
  carBusyTicks: number[];
}

function runSingleTrial(
  params: MonteCarloParams,
  rand: () => number,
  travelTable: Float64Array,
  numFloors: number,
  floorCdf: Float64Array,            // CDF for demand floors (article: cumulative density)
  conditionalCdfs: Float64Array[],   // per-origin conditional CDFs for destination
  doorCycle: number,
  effectiveCapacity: number,
  activeElevators: number,
  trafficSplit: TrafficSplit,
): TrialResult {
  const { simulationDuration, floorPopulations } = params;
  const totalPop = floorPopulations.reduce((a, b) => a + b, 0);
  const totalTicks = Math.ceil(simulationDuration / TICK_DT);
  const numDemandFloors = floorPopulations.length;

  // Poisson arrival rate: λ = totalPop × arrivalRate / duration
  const lambda = (totalPop * params.arrivalRate) / simulationDuration;

  // ── Generate all arrivals up front ──
  // Article methodology: for each passenger, determine arrival time
  // (Poisson), then origin floor (CDF), then destination floor
  // (conditional CDF from OD matrix row).
  const arrivals: Passenger[] = [];
  let t = expVariate(rand, lambda);
  while (t < simulationDuration) {
    let origin: number; // 0 = lobby, 1..N = demand floors
    let dest: number;

    const roll = rand();

    if (roll < trafficSplit.x) {
      // Upward: lobby → random floor (proportional to population)
      origin = 0;
      dest = sampleFromCdf(rand, floorCdf) + 1;
    } else if (roll < trafficSplit.x + trafficSplit.y) {
      // Downward: random floor → lobby
      origin = sampleFromCdf(rand, floorCdf) + 1;
      dest = 0;
    } else {
      // Interfloor: floor → floor (neither lobby)
      // Origin from CDF, destination from conditional CDF excluding origin
      const originIdx = sampleFromCdf(rand, floorCdf);
      origin = originIdx + 1;
      // Destination: another demand floor, weighted by population
      let destIdx = sampleFromCdf(rand, conditionalCdfs[originIdx]);
      // If the CDF sampling lands on the excluded floor, nudge
      if (destIdx === originIdx) {
        destIdx = (destIdx + 1) % numDemandFloors;
      }
      dest = destIdx + 1;
    }

    // Safety: avoid origin == dest
    if (origin === dest) {
      dest = origin === 0 ? 1 : 0;
    }

    arrivals.push({
      arrivalTime: t,
      originFloor: origin,
      destFloor: dest,
      boardTime: -1,
      alightTime: -1,
    });
    t += expVariate(rand, lambda);
  }

  // ── Initialise cars ──
  const cars: Car[] = [];
  for (let i = 0; i < activeElevators; i++) {
    cars.push({
      id: i,
      state: CarState.Idle,
      currentFloor: 0,
      targetFloor: 0,
      passengers: [],
      tripPlan: [],
      stateTimer: 0,
      maxPassengers: effectiveCapacity,
      busyTicks: 0,
      lobbyDwellTimer: 0,
      lastLobbyDepartureTime: -1,
      roundTripTimes: [],
    });
  }

  // ── Queues ──
  const waitingByFloor: Passenger[][] = new Array(numFloors);
  for (let f = 0; f < numFloors; f++) waitingByFloor[f] = [];
  const unassigned: Passenger[] = [];

  // ── Timeline ──
  const timelineBucketSec = 10;
  const numBuckets = Math.ceil(simulationDuration / timelineBucketSec);
  const timeline: TrialResult['timeline'] = [];

  let arrivalIdx = 0;
  let servedCount = 0;
  let boardedCount = 0;
  const lobbyDepartures: number[] = [];

  // ── Tick loop ──
  for (let tick = 0; tick < totalTicks; tick++) {
    const simTime = tick * TICK_DT;

    // --- 1. Inject new arrivals ---
    while (arrivalIdx < arrivals.length && arrivals[arrivalIdx].arrivalTime <= simTime) {
      const pax = arrivals[arrivalIdx++];
      const carIdx = dispatchPassenger(pax, cars, travelTable, numFloors);
      if (carIdx >= 0) {
        waitingByFloor[pax.originFloor].push(pax);
      } else {
        unassigned.push(pax);
        waitingByFloor[pax.originFloor].push(pax);
      }
    }

    // --- 2. Retry unassigned ---
    if (unassigned.length > 0) {
      for (let i = unassigned.length - 1; i >= 0; i--) {
        const pax = unassigned[i];
        const carIdx = dispatchPassenger(pax, cars, travelTable, numFloors);
        if (carIdx >= 0) {
          unassigned.splice(i, 1);
        }
      }
    }

    // --- 3. Update each car ---
    for (let c = 0; c < cars.length; c++) {
      const car = cars[c];

      if (car.state !== CarState.Idle) {
        car.busyTicks++;
      }

      switch (car.state) {
        case CarState.Idle: {
          const waitingHere = waitingByFloor[car.currentFloor];
          if (waitingHere.length > 0 && car.passengers.length < car.maxPassengers) {
            if (car.currentFloor === 0) {
              // Lobby: batch-wait mode (one car at a time)
              const anotherDwelling = cars.some((other, oi) =>
                oi !== c && other.state === CarState.LobbyDwell
              );
              if (!anotherDwelling) {
                car.state = CarState.LobbyDwell;
                car.lobbyDwellTimer = LOBBY_DISPATCH_DELAY_SEC;
                car.busyTicks++;
              }
            } else {
              // Non-lobby floor: open doors immediately
              car.state = CarState.DoorOpening;
              car.stateTimer = doorCycle / 2;
              car.busyTicks++;
            }
          } else if (car.tripPlan.length > 0) {
            car.targetFloor = car.tripPlan[0];
            if (car.targetFloor === car.currentFloor) {
              car.tripPlan.shift();
              car.state = CarState.DoorOpening;
              car.stateTimer = doorCycle / 2;
              car.busyTicks++;
            } else {
              car.state = CarState.TravelingToFloor;
              let tt = travelTable[car.currentFloor * numFloors + car.targetFloor];
              tt += MOTOR_START_DELAY;
              car.stateTimer = tt;
              car.busyTicks++;
            }
          }
          break;
        }

        case CarState.LobbyDwell: {
          car.lobbyDwellTimer -= TICK_DT;
          car.busyTicks++;
          const lobbyQueue = waitingByFloor[0];
          const assignedCount = lobbyQueue.length + car.passengers.length;

          if (car.lobbyDwellTimer <= TICK_DT / 2 || assignedCount >= car.maxPassengers) {
            car.lobbyDwellTimer = 0;
            if (lobbyQueue.length > 0) {
              car.state = CarState.DoorOpening;
              car.stateTimer = doorCycle / 2;
            } else if (car.tripPlan.length > 0) {
              car.targetFloor = car.tripPlan[0];
              car.state = CarState.TravelingToFloor;
              let tt = travelTable[car.currentFloor * numFloors + car.targetFloor];
              tt += MOTOR_START_DELAY;
              car.stateTimer = tt;
            } else {
              car.state = CarState.Idle;
            }
          }
          break;
        }

        case CarState.TravelingToFloor: {
          car.stateTimer -= TICK_DT;
          if (car.stateTimer <= TICK_DT / 2) {
            car.currentFloor = car.targetFloor;
            const idx = car.tripPlan.indexOf(car.currentFloor);
            if (idx >= 0) car.tripPlan.splice(idx, 1);

            // Per-car RTT tracking
            if (car.currentFloor === 0 && car.lastLobbyDepartureTime >= 0) {
              const rtt = simTime - car.lastLobbyDepartureTime;
              if (rtt > 0) car.roundTripTimes.push(rtt);
              car.lastLobbyDepartureTime = -1;
            }

            car.state = CarState.DoorOpening;
            car.stateTimer = doorCycle / 2;
          }
          break;
        }

        case CarState.DoorOpening: {
          car.stateTimer -= TICK_DT;
          if (car.stateTimer <= TICK_DT / 2) {
            car.state = CarState.Boarding;

            // Alight passengers
            let alightCount = 0;
            for (let p = car.passengers.length - 1; p >= 0; p--) {
              if (car.passengers[p].destFloor === car.currentFloor) {
                car.passengers[p].alightTime = simTime;
                servedCount++;
                alightCount++;
                car.passengers.splice(p, 1);
              }
            }

            // Board waiting passengers
            const waiting = waitingByFloor[car.currentFloor];
            let boardCount = 0;
            for (let w = waiting.length - 1; w >= 0; w--) {
              if (car.passengers.length >= car.maxPassengers) break;
              const pax = waiting[w];
              pax.boardTime = simTime;
              car.passengers.push(pax);
              waiting.splice(w, 1);
              boardCount++;
              boardedCount++;
              if (car.tripPlan.indexOf(pax.destFloor) === -1) {
                insertFloorIntoTripPlan(car, pax.destFloor, travelTable, numFloors);
              }
            }

            // Track lobby departures
            if (car.currentFloor === 0 && car.passengers.length > 0) {
              lobbyDepartures.push(simTime);
              car.lastLobbyDepartureTime = simTime;
            }

            car.stateTimer = (alightCount + boardCount) * PASSENGER_TRANSFER;
            if (car.stateTimer < TICK_DT) car.stateTimer = TICK_DT;
          }
          break;
        }

        case CarState.Boarding: {
          car.stateTimer -= TICK_DT;
          if (car.stateTimer <= TICK_DT / 2) {
            car.state = CarState.DoorClosing;
            car.stateTimer = doorCycle / 2;
          }
          break;
        }

        case CarState.DoorClosing: {
          car.stateTimer -= TICK_DT;
          if (car.stateTimer <= TICK_DT / 2) {
            car.state = CarState.Idle;
            car.stateTimer = 0;
          }
          break;
        }
      }
    }

    // --- 4. Timeline snapshot ---
    const bucket = Math.floor(simTime / timelineBucketSec);
    if (timeline.length <= bucket && simTime > 0) {
      let waitCount = 0;
      for (let f = 0; f < numFloors; f++) waitCount += waitingByFloor[f].length;
      let activeCars = 0;
      for (const car of cars) if (car.state !== CarState.Idle) activeCars++;
      timeline.push({
        timeSec: bucket * timelineBucketSec,
        waitingPassengers: waitCount,
        activeElevators: activeCars,
        passengersServed: servedCount,
      });
    }
  }

  // ── Collect passenger metrics ──
  // RAW SIMULATED AWT: boardTime − arrivalTime for each boarded passenger.
  // This is the article's prescribed measurement — no formula override.
  const allWaits: number[] = [];
  let sumAwt = 0;
  let countServed = 0;

  for (const pax of arrivals) {
    if (pax.boardTime >= 0) {
      const wait = pax.boardTime - pax.arrivalTime;
      allWaits.push(wait);
      sumAwt += wait;
      countServed++;
    }
  }

  const rawMeanAwt = countServed > 0 ? sumAwt / countServed : 0;

  // HC% = passengers boarded / total population × 100
  const hcPercent = totalPop > 0 ? (boardedCount / totalPop) * 100 : 0;

  // Per-car RTT
  let allRtts: number[] = [];
  for (const car of cars) {
    allRtts = allRtts.concat(car.roundTripTimes);
  }
  let simulatedMeanRtt = 0;
  if (allRtts.length >= 2) {
    let sumRtt = 0;
    for (const rtt of allRtts) sumRtt += rtt;
    simulatedMeanRtt = sumRtt / allRtts.length;
  }

  // Interval from lobby departures
  let meanInterval = 0;
  if (lobbyDepartures.length >= 2) {
    lobbyDepartures.sort((a, b) => a - b);
    let sumGaps = 0;
    for (let i = 1; i < lobbyDepartures.length; i++) {
      sumGaps += lobbyDepartures[i] - lobbyDepartures[i - 1];
    }
    meanInterval = sumGaps / (lobbyDepartures.length - 1);
  } else if (simulatedMeanRtt > 0) {
    meanInterval = simulatedMeanRtt / activeElevators;
  }

  // Fill remaining timeline slots
  while (timeline.length < numBuckets) {
    let waitCount = 0;
    for (let f = 0; f < numFloors; f++) waitCount += waitingByFloor[f].length;
    let activeCars = 0;
    for (const car of cars) if (car.state !== CarState.Idle) activeCars++;
    timeline.push({
      timeSec: timeline.length * timelineBucketSec,
      waitingPassengers: waitCount,
      activeElevators: activeCars,
      passengersServed: servedCount,
    });
  }

  return {
    meanAwt: rawMeanAwt,       // pure simulated AWT per the article
    meanInterval,
    simulatedRtt: simulatedMeanRtt,
    hcPercent,
    totalServed: servedCount,
    totalArrived: arrivals.length,
    passengerWaits: allWaits,
    timeline,
    carBusyTicks: cars.map(c => c.busyTicks),
  };
}

// ═══════════════════════════════════════════════════════════════════
// PERCENTILE / STATISTICS HELPERS
// ═══════════════════════════════════════════════════════════════════

function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function median(sorted: Float64Array): number {
  return percentile(sorted, 0.5);
}

// ═══════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════

export function runMonteCarloSimulation(params: MonteCarloParams): MonteCarloResult {
  const {
    numElevators,
    capacityPersons,
    speedFpm,
    numTrials,
    simulationDuration,
    floorHeights,
    floorPopulations,
    expressDistanceFt,
    doorHeightFt,
    trafficPattern,
    elevatorsOutOfService = 0,
    seed = 42,
  } = params;

  const activeElevators = Math.max(1, numElevators - elevatorsOutOfService);
  const effectiveCapacity = Math.floor(capacityPersons * CAR_LOADING_FACTOR);

  // ── Floor elevations ──
  const numDemandFloors = floorPopulations.length;
  const numFloors = numDemandFloors + 1;

  const floorElevations = new Float64Array(numFloors);
  floorElevations[0] = 0;
  let cumHeight = expressDistanceFt;
  for (let i = 0; i < numDemandFloors; i++) {
    cumHeight += (i < floorHeights.length ? floorHeights[i] : (floorHeights[floorHeights.length - 1] || 13));
    floorElevations[i + 1] = cumHeight;
  }

  // ── Pre-compute travel time table ──
  const travelTable = buildTravelTimeTable(floorElevations, speedFpm);

  // ── Build CDFs (article: cumulative density functions) ──
  const floorCdf = buildCdf(floorPopulations);

  // ── Build per-origin conditional CDFs for interfloor traffic ──
  // Article: "for every passenger, determine original floor i, then
  //  construct a roulette with n-1 intervals ... proportional to OD row i"
  const conditionalCdfs: Float64Array[] = [];
  for (let i = 0; i < numDemandFloors; i++) {
    conditionalCdfs.push(buildConditionalCdf(floorPopulations, i));
  }

  // ── Traffic split ──
  const trafficSplit = getTrafficSplit(trafficPattern);

  const doorCycle = doorCycleTime(doorHeightFt);
  const rand = mulberry32(seed);

  // ── Run trials ──
  const trialAwts = new Float64Array(numTrials);
  const trialHcPercents = new Float64Array(numTrials);
  const trialIntervals = new Float64Array(numTrials);

  const carBusyAccum = new Float64Array(activeElevators);
  let totalPassengers = 0;
  let representativeTimeline: TrialResult['timeline'] = [];
  let representativeCarBusy: number[] = [];
  const trialResults: TrialResult[] = [];

  for (let trial = 0; trial < numTrials; trial++) {
    const result = runSingleTrial(
      params,
      rand,
      travelTable,
      numFloors,
      floorCdf,
      conditionalCdfs,
      doorCycle,
      effectiveCapacity,
      activeElevators,
      trafficSplit,
    );

    trialAwts[trial] = result.meanAwt;
    trialHcPercents[trial] = result.hcPercent;
    trialIntervals[trial] = result.meanInterval;
    totalPassengers += result.totalArrived;

    for (let c = 0; c < activeElevators; c++) {
      carBusyAccum[c] += result.carBusyTicks[c];
    }

    if (trial === 0) {
      representativeTimeline = result.timeline;
      representativeCarBusy = result.carBusyTicks;
    }

    if (trial < 10) {
      trialResults.push(result);
    }
  }

  // ── Sort for percentiles ──
  const sortedAwts = new Float64Array(trialAwts).sort();
  const sortedHc = new Float64Array(trialHcPercents).sort();
  const sortedIntervals = new Float64Array(trialIntervals).sort();

  // Find representative trial (closest to median AWT)
  const medAwt = median(sortedAwts);
  let closestDist = Infinity;
  for (let i = 0; i < Math.min(trialResults.length, 10); i++) {
    const dist = Math.abs(trialResults[i].meanAwt - medAwt);
    if (dist < closestDist) {
      closestDist = dist;
      representativeTimeline = trialResults[i].timeline;
      representativeCarBusy = trialResults[i].carBusyTicks;
    }
  }

  // ── Car utilization ──
  const totalTicks = Math.ceil(simulationDuration / TICK_DT);
  const carUtilization: number[] = [];
  for (let c = 0; c < activeElevators; c++) {
    const avgBusyTicks = carBusyAccum[c] / numTrials;
    carUtilization.push(Math.round((avgBusyTicks / totalTicks) * 1000) / 10);
  }

  // ── RTT from simulated per-car tracking ──
  const trialRtts = new Float64Array(numTrials);
  for (let i = 0; i < numTrials; i++) {
    // RTT = interval × numElevators (from sim data)
    trialRtts[i] = trialIntervals[i] > 0
      ? trialIntervals[i] * activeElevators
      : 0;
  }
  const sortedRtts = new Float64Array(trialRtts).sort();

  // ── Build result ──
  const result: MonteCarloResult = {
    medianAwtSec: round2(median(sortedAwts)),
    p10AwtSec: round2(percentile(sortedAwts, 0.10)),
    p90AwtSec: round2(percentile(sortedAwts, 0.90)),
    meanAwtSec: round2(mean(trialAwts)),
    medianIntervalSec: round2(median(sortedIntervals)),
    p90IntervalSec: round2(percentile(sortedIntervals, 0.90)),
    meanHcPercent: round1(mean(trialHcPercents)),
    p10HcPercent: round1(percentile(sortedHc, 0.10)),
    medianRttSec: round2(median(sortedRtts)),

    trialAwts: Array.from(trialAwts),
    trialHcPercents: Array.from(trialHcPercents),
    trialIntervals: Array.from(trialIntervals),

    timelineData: representativeTimeline,
    carUtilization,

    confidenceLevel: 0.90,
    numTrials,
    totalPassengersSimulated: totalPassengers,
  };

  // ── Stress test ──
  if (elevatorsOutOfService > 0) {
    result.stressTest = {
      elevatorsRemoved: elevatorsOutOfService,
      medianAwtSec: result.medianAwtSec,
      p90AwtSec: result.p90AwtSec,
      meanHcPercent: result.meanHcPercent,
      degradationPercent: 0,
    };
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════
// STRESS TEST HELPER
// ═══════════════════════════════════════════════════════════════════

export function runStressTest(params: MonteCarloParams): MonteCarloResult {
  const seed = params.seed ?? 42;
  const baselineParams = { ...params, elevatorsOutOfService: 0, seed };
  const baseline = runMonteCarloSimulation(baselineParams);

  const stressParams = { ...params, elevatorsOutOfService: 1, seed };
  const stressed = runMonteCarloSimulation(stressParams);

  const degradation = baseline.medianAwtSec > 0
    ? ((stressed.medianAwtSec - baseline.medianAwtSec) / baseline.medianAwtSec) * 100
    : 0;

  stressed.stressTest = {
    elevatorsRemoved: 1,
    medianAwtSec: stressed.medianAwtSec,
    p90AwtSec: stressed.p90AwtSec,
    meanHcPercent: stressed.meanHcPercent,
    degradationPercent: round1(degradation),
  };

  return stressed;
}

// ═══════════════════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════════════════

function mean(arr: Float64Array): number {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i];
  return sum / arr.length;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
