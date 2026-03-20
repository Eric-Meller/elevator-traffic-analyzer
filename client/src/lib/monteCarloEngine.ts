/**
 * Monte Carlo Elevator Traffic Analysis Engine
 *
 * Methodology based on:
 *   - "Elevator Traffic-Flow Prediction Based on Monte Carlo Method"
 *     (Wang Sheng et al., Elevator World)
 *   - "The Round Trip Time Simulation: Monte Carlo Implementation"
 *     (Peters Research / Lift Escalator Library)
 *   - CIBSE Guide D: Transportation Systems in Buildings
 *   - "Beyond the Up Peak" (Elevator World) for AWT/Interval ratio
 *
 * The MC method is a PROBABILISTIC RTT CALCULATOR:
 *   1. For each trial, randomly sample P passengers arriving at lobby.
 *   2. Each passenger picks a destination floor via CDF (population-weighted).
 *   3. Compute the actual stops S and highest reversal H from the random set.
 *   4. Compute RTT from the CIBSE formula: 2·H·tv + (S+1)·Tstop + 2·P·tp + express
 *   5. Derive interval = RTT / L, then AWT = interval × 0.55
 *
 * This produces results CONSISTENT with the deterministic formula (median AWT
 * within ~5% of deterministic) while the stochastic variation across trials
 * gives the natural P10/P90 spread that characterises real-world performance.
 *
 * Per Peters Research, MC simulation RTT should match classical RTT within
 * ~1-2% when using the same probability assumptions (converges with trials).
 *
 * A lightweight discrete-event simulation runs on a single representative
 * trial to produce timeline and car utilization visualization data.
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
  deterministicRttSec?: number; // deterministic RTT (for reference)
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

/** AWT-to-interval ratio (must match elevatorEngine.ts).
 *  Per CIBSE Guide D, AWT ≈ 55% of the interval under standard
 *  group-collective dispatch.  "Beyond the Up Peak" confirms 55-60%. */
const AWT_INTERVAL_RATIO = 0.55;

/** Mixed-traffic RTT multiplier (must match elevatorEngine.ts).
 *  CIBSE Guide D, balanced interfloor. */
const MIXED_TRAFFIC_RTT_FACTOR = 1.35;

/** Interfloor traffic factors by building type (match elevatorEngine.ts). */
const INTERFLOOR_TRAFFIC_FACTOR: Record<string, number> = {
  office_standard: 1.10,
  office_prestige: 1.10,
  hotel: 1.15,
  residential: 1.05,
  hospital: 1.15,
  ballroom_event: 1.05,
};

const TICK_DT = 0.5; // simulation time step (seconds) — for visualization sim

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

/** Poisson random variate via inverse-CDF. */
function poissonVariate(rand: () => number, lambda: number): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > L);
  return k - 1;
}

// ═══════════════════════════════════════════════════════════════════
// CDF-BASED FLOOR SELECTION  (Article: "improved roulette model")
// ═══════════════════════════════════════════════════════════════════

/** Build cumulative distribution function from population weights. */
function buildCdf(populations: number[]): Float64Array {
  const total = populations.reduce((a, b) => a + b, 0);
  const cdf = new Float64Array(populations.length);
  if (total <= 0) {
    for (let i = 0; i < populations.length; i++) {
      cdf[i] = (i + 1) / populations.length;
    }
  } else {
    let cum = 0;
    for (let i = 0; i < populations.length; i++) {
      cum += populations[i] / total;
      cdf[i] = cum;
    }
    cdf[populations.length - 1] = 1.0;
  }
  return cdf;
}

/** Inverse-transform sampling: pick floor index from CDF. */
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

// ═══════════════════════════════════════════════════════════════════
// S-CURVE KINEMATICS  (must match elevatorEngine.ts)
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
    if (time < tj) acc = j * time;
    else if (time < tj + tConst) acc = aMax;
    else acc = aMax - j * (time - tj - tConst);
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

/** Single-floor flight time via s-curve kinematics. */
function singleFloorFlightTime(speedFpm: number, floorHeightFt: number): number {
  const VmaxMps = speedFpm * FPM_TO_MPS;
  const distM = floorHeightFt * FT_TO_M;
  return sCurveTravelTime(VmaxMps, distM, ACCEL_MAX, JERK_RATE) + LEVELING_TIME;
}

/** Door cycle time by door height (matches elevatorEngine.ts). */
function doorCycleTime(doorHeightFt: number): number {
  return doorHeightFt <= 7 ? 7.0 : 8.5;
}

// ═══════════════════════════════════════════════════════════════════
// MC RTT TRIAL — Article-Based Probabilistic RTT Calculator
// ═══════════════════════════════════════════════════════════════════
//
// Each trial:
//   1. Sample P passengers (Poisson with mean = expected car load)
//   2. Each passenger picks a destination from the population CDF
//   3. Compute S (actual stops) and H (highest reversal) from the
//      random destination set
//   4. Compute RTT = 2·H·tv + (S+1)·Tstop + 2·P·tp + expressTime
//   5. Derive interval = RTT / L, AWT = interval × 0.55
//
// This matches the deterministic formula's probability model while
// adding natural stochastic variation from passenger sampling.

interface RttTrialResult {
  rtt: number;
  stops: number;
  highestReversal: number;
  passengers: number;
  interval: number;
  awt: number;
  hcPercent: number;
}

function runRttTrial(
  rand: () => number,
  floorCdf: Float64Array,
  numDemandFloors: number,
  avgFloorHeightFt: number,
  speedFpm: number,
  doorHeightFt: number,
  expressTimeSec: number,
  expectedP: number,
  activeElevators: number,
  totalPop: number,
  simulationDuration: number,
  trafficPattern: 'uppeak' | 'mixed',
  floorElevationsFt: Float64Array | null,
): RttTrialResult {
  // 1. Sample number of passengers via Poisson
  const P = Math.max(1, poissonVariate(rand, expectedP));

  // 2. Each passenger picks a destination floor (0-indexed demand floor)
  const destinations = new Set<number>();
  let highestFloor = 0; // 0-indexed demand floor

  for (let i = 0; i < P; i++) {
    const floorIdx = sampleFromCdf(rand, floorCdf);
    destinations.add(floorIdx);
    if (floorIdx > highestFloor) highestFloor = floorIdx;
  }

  // 3. S = number of unique stops, H = highest reversal floor (1-indexed)
  const S = destinations.size;
  const H = highestFloor + 1; // convert to 1-indexed (floor 1 is first demand floor)

  // 4. Compute RTT using the CIBSE formula
  const VmaxMps = speedFpm * FPM_TO_MPS;
  const avgFloorHeightM = avgFloorHeightFt * FT_TO_M;
  const tv = avgFloorHeightM / VmaxMps; // time per floor at contract speed

  const tf1 = singleFloorFlightTime(speedFpm, avgFloorHeightFt);
  const doorOC = doorCycleTime(doorHeightFt);
  const Tstop = doorOC + tf1 - (avgFloorHeightFt / speedFpm) * 60 + MOTOR_START_DELAY;

  // If we have actual floor elevations, compute H as travel distance directly
  let travelComponent: number;
  if (floorElevationsFt && H > 0) {
    // Use actual distance to highest floor for more accuracy
    const highestElevFt = floorElevationsFt[highestFloor + 1]; // +1 because 0 is lobby
    const lobbyElevFt = floorElevationsFt[0];
    const distM = Math.abs(highestElevFt - lobbyElevFt) * FT_TO_M;
    const oneWayTime = sCurveTravelTime(VmaxMps, distM, ACCEL_MAX, JERK_RATE) + LEVELING_TIME;
    travelComponent = 2 * oneWayTime;
  } else {
    travelComponent = 2 * H * tv;
  }

  let rtt = travelComponent + (S + 1) * Tstop + 2 * P * PASSENGER_TRANSFER;

  // Add express zone travel time (lobby ↔ first served floor)
  rtt += expressTimeSec;

  // Apply mixed traffic factor
  if (trafficPattern === 'mixed') {
    rtt *= MIXED_TRAFFIC_RTT_FACTOR;
  }

  // 5. Derive performance metrics
  const interval = rtt / activeElevators;
  const awt = interval * AWT_INTERVAL_RATIO;

  // HC% = passengers served per 5 min / population × 100
  // Per trip, one car serves P passengers; in 300s there are 300/interval dispatches × L cars
  const tripsPerFiveMin = simulationDuration / interval;
  const passengersServed = tripsPerFiveMin * P;
  const hcPercent = totalPop > 0 ? (passengersServed / totalPop) * 100 : 0;

  return { rtt, stops: S, highestReversal: H, passengers: P, interval, awt, hcPercent };
}

// ═══════════════════════════════════════════════════════════════════
// DISCRETE-EVENT SIM (for visualization only — timeline, car util)
// ═══════════════════════════════════════════════════════════════════

interface VisSimResult {
  timeline: {
    timeSec: number;
    waitingPassengers: number;
    activeElevators: number;
    passengersServed: number;
  }[];
  carBusyTicks: number[];
}

function runVisualizationSim(
  params: MonteCarloParams,
  rand: () => number,
  travelTable: Float64Array,
  numFloors: number,
  floorCdf: Float64Array,
  doorCycle: number,
  effectiveCapacity: number,
  activeElevators: number,
): VisSimResult {
  const { simulationDuration, floorPopulations } = params;
  const totalPop = floorPopulations.reduce((a, b) => a + b, 0);
  const totalTicks = Math.ceil(simulationDuration / TICK_DT);

  const lambda = (totalPop * params.arrivalRate) / simulationDuration;

  // Generate arrivals (uppeak: lobby → floor)
  interface VisPax { arrivalTime: number; destFloor: number; boardTime: number; }
  const arrivals: VisPax[] = [];
  let t = -Math.log(Math.max(rand(), 1e-10)) / lambda;
  while (t < simulationDuration) {
    const dest = sampleFromCdf(rand, floorCdf) + 1;
    arrivals.push({ arrivalTime: t, destFloor: dest, boardTime: -1 });
    t += -Math.log(Math.max(rand(), 1e-10)) / lambda;
  }

  // Simple elevator sim
  const enum CS { Idle = 0, Traveling = 1, Stopped = 2 }
  interface VisCar {
    state: CS; floor: number; target: number;
    pax: VisPax[]; plan: number[]; timer: number; busy: number;
  }
  const cars: VisCar[] = [];
  for (let i = 0; i < activeElevators; i++) {
    cars.push({ state: CS.Idle, floor: 0, target: 0, pax: [], plan: [], timer: 0, busy: 0 });
  }

  const lobbyQueue: VisPax[] = [];
  let arrIdx = 0;
  let served = 0;
  const timelineBucket = 10;
  const timeline: VisSimResult['timeline'] = [];

  for (let tick = 0; tick < totalTicks; tick++) {
    const simTime = tick * TICK_DT;

    // Inject arrivals
    while (arrIdx < arrivals.length && arrivals[arrIdx].arrivalTime <= simTime) {
      lobbyQueue.push(arrivals[arrIdx++]);
    }

    // Dispatch from lobby to idle cars
    for (const car of cars) {
      if (car.state === CS.Idle && car.floor === 0 && lobbyQueue.length > 0) {
        const batch: VisPax[] = [];
        while (batch.length < effectiveCapacity && lobbyQueue.length > 0) {
          const p = lobbyQueue.shift()!;
          p.boardTime = simTime;
          batch.push(p);
        }
        if (batch.length > 0) {
          car.pax = batch;
          const floors = [...new Set(batch.map(p => p.destFloor))].sort((a, b) => a - b);
          car.plan = [...floors, 0]; // go to each floor then return to lobby
          car.target = car.plan.shift()!;
          car.state = CS.Traveling;
          car.timer = travelTable[car.floor * numFloors + car.target] + MOTOR_START_DELAY;
        }
      }
    }

    // Update cars
    for (const car of cars) {
      if (car.state !== CS.Idle) car.busy++;

      if (car.state === CS.Traveling) {
        car.timer -= TICK_DT;
        if (car.timer <= TICK_DT / 2) {
          car.floor = car.target;
          // Unload passengers at this floor
          const staying = car.pax.filter(p => p.destFloor !== car.floor);
          const leaving = car.pax.length - staying.length;
          served += leaving;
          car.pax = staying;
          // Door cycle + passenger transfer
          car.state = CS.Stopped;
          car.timer = doorCycle + leaving * PASSENGER_TRANSFER;
        }
      } else if (car.state === CS.Stopped) {
        car.timer -= TICK_DT;
        if (car.timer <= TICK_DT / 2) {
          if (car.plan.length > 0) {
            car.target = car.plan.shift()!;
            car.state = CS.Traveling;
            car.timer = travelTable[car.floor * numFloors + car.target] + MOTOR_START_DELAY;
          } else {
            car.state = CS.Idle;
          }
        }
      }
    }

    // Timeline snapshot
    const bucket = Math.floor(simTime / timelineBucket);
    if (timeline.length <= bucket && simTime > 0) {
      let active = 0;
      for (const c of cars) if (c.state !== CS.Idle) active++;
      timeline.push({
        timeSec: bucket * timelineBucket,
        waitingPassengers: lobbyQueue.length,
        activeElevators: active,
        passengersServed: served,
      });
    }
  }

  return {
    timeline,
    carBusyTicks: cars.map(c => c.busy),
  };
}

// ═══════════════════════════════════════════════════════════════════
// PRE-COMPUTED TRAVEL TIME TABLE (for visualization sim)
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

  // ── Floor geometry ──
  const numDemandFloors = floorPopulations.length;
  const numFloors = numDemandFloors + 1; // lobby + demand floors
  const totalPop = floorPopulations.reduce((a, b) => a + b, 0);

  // Average floor height (weighted by population for accuracy)
  const totalPopWeight = floorPopulations.reduce((s, p) => s + p, 0);
  let avgFloorHeight: number;
  if (totalPopWeight > 0 && floorHeights.length > 0) {
    let weightedSum = 0;
    for (let i = 0; i < numDemandFloors; i++) {
      const h = i < floorHeights.length ? floorHeights[i] : (floorHeights[floorHeights.length - 1] || 13);
      weightedSum += h * (floorPopulations[i] || 1);
    }
    avgFloorHeight = weightedSum / totalPopWeight;
  } else {
    avgFloorHeight = floorHeights.length > 0
      ? floorHeights.reduce((a, b) => a + b, 0) / floorHeights.length
      : 13;
  }

  // Floor elevations for accurate travel time
  const floorElevations = new Float64Array(numFloors);
  floorElevations[0] = 0;
  let cumHeight = expressDistanceFt;
  for (let i = 0; i < numDemandFloors; i++) {
    cumHeight += (i < floorHeights.length ? floorHeights[i] : (floorHeights[floorHeights.length - 1] || 13));
    floorElevations[i + 1] = cumHeight;
  }

  // Express zone travel time (2× one-way from lobby to first served floor)
  const VmaxMps = speedFpm * FPM_TO_MPS;
  const expressDistM = expressDistanceFt * FT_TO_M;
  const expressOneWay = expressDistM > 0
    ? sCurveTravelTime(VmaxMps, expressDistM, ACCEL_MAX, JERK_RATE) + LEVELING_TIME
    : 0;
  const expressTimeSec = 2 * expressOneWay;

  // ── Expected car load P (matches deterministic engine) ──
  // From deterministic: P = population × arrivalRate × interval / 300
  // But we don't know interval yet.  We use the capacity-based P:
  // P = effectiveCapacity (this is what the deterministic formula uses as max P)
  // Actually, the deterministic engine iterates P = (pop × rate × RTT) / (300 × L)
  // For MC we use the Poisson arrival model: λ = pop × rate / 300
  // Expected passengers per interval = λ × interval
  // But interval depends on P... so use the deterministic RTT to bootstrap.
  const deterministicRtt = params.deterministicRttSec || 200;
  const deterministicInterval = deterministicRtt / activeElevators;
  const lambdaPerSec = (totalPop * params.arrivalRate) / simulationDuration;
  const expectedP = Math.min(
    Math.max(1, Math.round(lambdaPerSec * deterministicInterval)),
    effectiveCapacity
  );

  // ── Build CDF ──
  const floorCdf = buildCdf(floorPopulations);
  const doorCycle = doorCycleTime(doorHeightFt);
  const rand = mulberry32(seed);

  // ── Run MC RTT trials ──
  const trialAwts = new Float64Array(numTrials);
  const trialHcPercents = new Float64Array(numTrials);
  const trialIntervals = new Float64Array(numTrials);
  const trialRtts = new Float64Array(numTrials);

  let totalPassengers = 0;

  for (let trial = 0; trial < numTrials; trial++) {
    const result = runRttTrial(
      rand,
      floorCdf,
      numDemandFloors,
      avgFloorHeight,
      speedFpm,
      doorHeightFt,
      expressTimeSec,
      expectedP,
      activeElevators,
      totalPop,
      simulationDuration,
      trafficPattern,
      floorElevations,
    );

    trialAwts[trial] = result.awt;
    trialHcPercents[trial] = result.hcPercent;
    trialIntervals[trial] = result.interval;
    trialRtts[trial] = result.rtt;
    totalPassengers += result.passengers;
  }

  // ── Sort for percentiles ──
  const sortedAwts = new Float64Array(trialAwts).sort();
  const sortedHc = new Float64Array(trialHcPercents).sort();
  const sortedIntervals = new Float64Array(trialIntervals).sort();
  const sortedRtts = new Float64Array(trialRtts).sort();

  // ── Run visualization sim for timeline + car utilization ──
  const visRand = mulberry32(seed + 12345);
  const travelTable = buildTravelTimeTable(floorElevations, speedFpm);
  const visSim = runVisualizationSim(
    params,
    visRand,
    travelTable,
    numFloors,
    floorCdf,
    doorCycle,
    effectiveCapacity,
    activeElevators,
  );

  // Car utilization from vis sim
  const totalTicks = Math.ceil(simulationDuration / TICK_DT);
  const carUtilization: number[] = [];
  for (let c = 0; c < activeElevators; c++) {
    const busyPct = (visSim.carBusyTicks[c] || 0) / totalTicks * 100;
    carUtilization.push(Math.round(busyPct * 10) / 10);
  }

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

    timelineData: visSim.timeline,
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
