/**
 * Monte Carlo Elevator Traffic Simulation Engine
 *
 * Runs N independent 5-minute peak-period simulations using a discrete
 * tick-based model (0.5 s increments).  Each trial generates Poisson
 * passenger arrivals, dispatches them to elevator cars via a destination-
 * dispatch heuristic, and records per-passenger wait / travel / journey
 * times.  Aggregate statistics across all trials feed histogram and
 * confidence-interval outputs for the UI.
 *
 * Kinematic constants and S-curve travel-time functions are copied from
 * the deterministic elevatorEngine.ts so results stay consistent.
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
  // Guard: avoid log(0)
  let u = rand();
  while (u === 0) u = rand();
  return -Math.log(u) / lambda;
}

/** Weighted random index: pick floor proportional to population. */
function weightedChoice(rand: () => number, cdf: Float64Array): number {
  const u = rand();
  // Binary search in CDF
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

/**
 * Build a table of travel times between every pair of zone floors
 * (including the virtual "lobby" floor at index 0).
 *
 * floorElevations[0] = 0 (lobby / zone entry),
 * floorElevations[1..N] = cumulative heights of zone demand floors.
 *
 * Returns a flat Float64Array of size (N+1)² where
 *   travelTime(a, b) = table[a * stride + b]
 * Each value includes leveling time.
 */
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
    // table[a * N + a] = 0 (already zero)
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
  TravelingToFloor = 1,
  DoorOpening = 2,
  Boarding = 3,
  DoorClosing = 4,
}

interface Car {
  id: number;
  state: CarState;
  currentFloor: number;     // floor index the car is at (or heading toward)
  targetFloor: number;      // immediate next floor target
  passengers: Passenger[];  // on board
  tripPlan: number[];       // ordered list of floor stops remaining
  stateTimer: number;       // countdown for current state action
  maxPassengers: number;
  busyTicks: number;        // ticks where car was not idle (for utilization)
}

// ═══════════════════════════════════════════════════════════════════
// DISPATCH ALGORITHM — destination dispatch heuristic
// ═══════════════════════════════════════════════════════════════════

/**
 * Insert a floor stop into a car's trip plan at the position that
 * minimises additional travel time.  Returns the incremental cost
 * (extra travel seconds) of the insertion, or Infinity if the car
 * is at capacity.
 */
function insertionCost(
  car: Car,
  floor: number,
  travelTable: Float64Array,
  numFloors: number,
): number {
  if (car.passengers.length >= car.maxPassengers) return Infinity;

  const plan = car.tripPlan;

  // If floor is already in the plan, cost = 0
  if (plan.indexOf(floor) !== -1) return 0;

  // Empty plan — cost is travel from current position to floor
  if (plan.length === 0) {
    return travelTable[car.currentFloor * numFloors + floor];
  }

  // Try every insertion position and pick the cheapest
  let bestCost = Infinity;
  for (let i = 0; i <= plan.length; i++) {
    const prev = i === 0 ? car.currentFloor : plan[i - 1];
    const next = i < plan.length ? plan[i] : -1;

    // Cost of original edge (prev → next)
    let originalEdge = 0;
    if (next >= 0) {
      originalEdge = travelTable[prev * numFloors + next];
    }

    // Cost of new edges (prev → floor → next)
    let newEdge = travelTable[prev * numFloors + floor];
    if (next >= 0) {
      newEdge += travelTable[floor * numFloors + next];
    }

    // Door cycle cost for the new stop
    // (only charged if this floor wasn't already a stop)
    const doorPenalty = 0; // door time is already modeled in the tick sim

    const cost = newEdge - originalEdge + doorPenalty;
    if (cost < bestCost) bestCost = cost;
  }

  return bestCost;
}

/**
 * Assign a passenger to the best car.  Inserts the passenger's
 * destination into the chosen car's trip plan.
 *
 * Also inserts the passenger's *origin* floor into the trip plan
 * if the car is not already at that floor (for picking up).
 *
 * Returns the car index, or -1 if no car is available (passenger queued).
 */
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

    // Cost = cost to pick up at origin + cost to deliver to destination
    let pickupCost = 0;
    if (car.currentFloor !== passenger.originFloor &&
        car.tripPlan.indexOf(passenger.originFloor) === -1) {
      pickupCost = insertionCost(car, passenger.originFloor, travelTable, numFloors);
    }
    const deliverCost = insertionCost(car, passenger.destFloor, travelTable, numFloors);
    const totalCost = pickupCost + deliverCost;

    // Prefer idle cars (lower tie-breaking)
    const idleBonus = car.state === CarState.Idle ? -0.01 : 0;
    // Prefer less loaded cars
    const loadPenalty = car.passengers.length * 0.5;

    const score = totalCost + idleBonus + loadPenalty;
    if (score < bestCost) {
      bestCost = score;
      bestCar = c;
    }
  }

  if (bestCar >= 0) {
    const car = cars[bestCar];
    // Insert origin into trip plan if needed
    if (car.currentFloor !== passenger.originFloor &&
        car.tripPlan.indexOf(passenger.originFloor) === -1) {
      insertFloorIntoTripPlan(car, passenger.originFloor, travelTable, numFloors);
    }
    // Insert destination into trip plan if needed
    if (car.tripPlan.indexOf(passenger.destFloor) === -1) {
      insertFloorIntoTripPlan(car, passenger.destFloor, travelTable, numFloors);
    }
  }

  return bestCar;
}

/** Insert a floor into a car's trip plan at the cheapest position. */
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
  meanAwt: number;
  meanInterval: number;
  hcPercent: number;
  totalServed: number;
  totalArrived: number;
  passengerWaits: number[];      // per-passenger AWT for this trial
  /** Timeline snapshots (every 10 s) */
  timeline: {
    timeSec: number;
    waitingPassengers: number;
    activeElevators: number;
    passengersServed: number;
  }[];
  /** Per-car busy ticks */
  carBusyTicks: number[];
}

function runSingleTrial(
  params: MonteCarloParams,
  rand: () => number,
  travelTable: Float64Array,
  numFloors: number,               // total floor indices (lobby + demand floors)
  floorCdf: Float64Array,          // CDF for weighted destination choice
  expressTimeSec: number,          // one-way express time (lobby → zone bottom)
  doorCycle: number,
  effectiveCapacity: number,
  activeElevators: number,
): TrialResult {
  const { simulationDuration, floorPopulations, trafficPattern } = params;
  const totalPop = floorPopulations.reduce((a, b) => a + b, 0);
  const totalTicks = Math.ceil(simulationDuration / TICK_DT);

  // Poisson arrival rate: λ = totalPop × arrivalRate / duration
  const lambda = (totalPop * params.arrivalRate) / simulationDuration;

  // ── Generate all arrivals up front ──
  const arrivals: Passenger[] = [];
  let t = expVariate(rand, lambda);
  while (t < simulationDuration) {
    // Origin: lobby (index 0) for uppeak, or random floor for mixed (50% each direction)
    let origin = 0;
    let dest: number;

    if (trafficPattern === 'mixed' && rand() < 0.5) {
      // Outgoing: random floor → lobby
      origin = weightedChoice(rand, floorCdf) + 1; // +1 because index 0 = lobby
      dest = 0;
    } else {
      // Incoming: lobby → random floor
      origin = 0;
      dest = weightedChoice(rand, floorCdf) + 1;
    }

    // Avoid origin == dest
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
      currentFloor: 0,       // start at lobby
      targetFloor: 0,
      passengers: [],
      tripPlan: [],
      stateTimer: 0,
      maxPassengers: effectiveCapacity,
      busyTicks: 0,
    });
  }

  // ── Queues ──
  // waitingByFloor[floor] = passengers waiting at that floor for pickup
  const waitingByFloor: Passenger[][] = new Array(numFloors);
  for (let f = 0; f < numFloors; f++) waitingByFloor[f] = [];
  // Global queue for passengers that couldn't be assigned yet
  const unassigned: Passenger[] = [];

  // ── Timeline snapshots ──
  const timelineBucketSec = 10;
  const numBuckets = Math.ceil(simulationDuration / timelineBucketSec);
  const timeline: TrialResult['timeline'] = [];

  let arrivalIdx = 0;
  let servedCount = 0;   // passengers who alighted (completed journey)
  let boardedCount = 0;  // passengers who boarded (for HC%)
  // Track lobby departure times for interval measurement
  const lobbyDepartures: number[] = [];

  // ── Tick loop ──
  for (let tick = 0; tick < totalTicks; tick++) {
    const simTime = tick * TICK_DT;

    // --- 1. Inject new arrivals ---
    while (arrivalIdx < arrivals.length && arrivals[arrivalIdx].arrivalTime <= simTime) {
      const pax = arrivals[arrivalIdx++];
      // Try to dispatch immediately
      const carIdx = dispatchPassenger(pax, cars, travelTable, numFloors);
      if (carIdx >= 0) {
        waitingByFloor[pax.originFloor].push(pax);
      } else {
        unassigned.push(pax);
        waitingByFloor[pax.originFloor].push(pax);
      }
    }

    // --- 2. Retry unassigned passengers ---
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
          // Check if there are passengers waiting at the current floor
          // that should be boarded before departing
          const waitingHere = waitingByFloor[car.currentFloor];
          if (waitingHere.length > 0 && car.passengers.length < car.maxPassengers) {
            // Open doors to board waiting passengers
            car.state = CarState.DoorOpening;
            car.stateTimer = doorCycle / 2;
            car.busyTicks++;
          } else if (car.tripPlan.length > 0) {
            // Start moving to next stop
            car.targetFloor = car.tripPlan[0];
            if (car.targetFloor === car.currentFloor) {
              // Already here — open doors
              car.tripPlan.shift();
              car.state = CarState.DoorOpening;
              car.stateTimer = doorCycle / 2;
              car.busyTicks++;
            } else {
              car.state = CarState.TravelingToFloor;
              // Compute travel time to target
              let tt = travelTable[car.currentFloor * numFloors + car.targetFloor];
              // Add express penalty if traveling to/from lobby (floor 0)
              // and target is a zone floor (or vice versa)
              if ((car.currentFloor === 0 && car.targetFloor > 0) ||
                  (car.currentFloor > 0 && car.targetFloor === 0)) {
                tt += expressTimeSec;
              }
              tt += MOTOR_START_DELAY;
              car.stateTimer = tt;
              car.busyTicks++;
            }
          }
          break;
        }

        case CarState.TravelingToFloor: {
          car.stateTimer -= TICK_DT;
          if (car.stateTimer <= TICK_DT / 2) {
            // Arrived at target floor
            car.currentFloor = car.targetFloor;
            // Remove this floor from trip plan
            const idx = car.tripPlan.indexOf(car.currentFloor);
            if (idx >= 0) car.tripPlan.splice(idx, 1);
            // Open doors
            car.state = CarState.DoorOpening;
            car.stateTimer = doorCycle / 2;
          }
          break;
        }

        case CarState.DoorOpening: {
          car.stateTimer -= TICK_DT;
          if (car.stateTimer <= TICK_DT / 2) {
            // Doors open — alight then board
            car.state = CarState.Boarding;

            // Alight passengers whose destination is this floor
            let alightCount = 0;
            for (let p = car.passengers.length - 1; p >= 0; p--) {
              if (car.passengers[p].destFloor === car.currentFloor) {
                car.passengers[p].alightTime = simTime;
                servedCount++;
                alightCount++;
                car.passengers.splice(p, 1);
              }
            }

            // Board waiting passengers at this floor (up to capacity)
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
              // Ensure destination is in trip plan
              if (car.tripPlan.indexOf(pax.destFloor) === -1) {
                insertFloorIntoTripPlan(car, pax.destFloor, travelTable, numFloors);
              }
            }

            // Track lobby departures for interval measurement
            if (car.currentFloor === 0 && car.passengers.length > 0) {
              lobbyDepartures.push(simTime);
            }

            // Transfer time = (alightCount + boardCount) × PASSENGER_TRANSFER
            car.stateTimer = (alightCount + boardCount) * PASSENGER_TRANSFER;
            if (car.stateTimer < TICK_DT) car.stateTimer = TICK_DT;
          }
          break;
        }

        case CarState.Boarding: {
          car.stateTimer -= TICK_DT;
          if (car.stateTimer <= TICK_DT / 2) {
            // Close doors
            car.state = CarState.DoorClosing;
            car.stateTimer = doorCycle / 2;
          }
          break;
        }

        case CarState.DoorClosing: {
          car.stateTimer -= TICK_DT;
          if (car.stateTimer <= TICK_DT / 2) {
            // Doors closed — go idle (will pick up next stop on next tick)
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
  const allWaits: number[] = [];
  let sumAwt = 0;
  let countServed = 0;

  for (const pax of arrivals) {
    if (pax.boardTime >= 0) {
      const wait = pax.boardTime - pax.arrivalTime;
      allWaits.push(wait);
      sumAwt += wait;
      countServed++;
    } else {
      // Never boarded — count full sim duration as wait
      const wait = simulationDuration - pax.arrivalTime;
      allWaits.push(wait);
      sumAwt += wait;
      countServed++;
    }
  }

  const meanAwt = countServed > 0 ? sumAwt / countServed : 0;

  // HC% = passengers boarded / total population × 100
  // Uses boardedCount (passengers picked up) rather than alighted count,
  // since passengers boarded late may still be in transit at sim end.
  const hcPercent = totalPop > 0 ? (boardedCount / totalPop) * 100 : 0;

  // Interval = average time between successive lobby departures
  let meanInterval: number;
  if (lobbyDepartures.length >= 2) {
    lobbyDepartures.sort((a, b) => a - b);
    let sumGaps = 0;
    for (let i = 1; i < lobbyDepartures.length; i++) {
      sumGaps += lobbyDepartures[i] - lobbyDepartures[i - 1];
    }
    meanInterval = sumGaps / (lobbyDepartures.length - 1);
  } else {
    // Fallback: estimate from AWT
    meanInterval = meanAwt > 0 ? meanAwt / 0.55 : simulationDuration;
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
    meanAwt,
    meanInterval,
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
    arrivalRate,
    doorHeightFt,
    elevatorsOutOfService = 0,
    seed = 42,
  } = params;

  const activeElevators = Math.max(1, numElevators - elevatorsOutOfService);
  const effectiveCapacity = Math.floor(capacityPersons * CAR_LOADING_FACTOR);

  // ── Build floor elevation array ──
  // Index 0 = lobby (elevation 0), indices 1..N = zone demand floors
  const numDemandFloors = floorPopulations.length;
  const numFloors = numDemandFloors + 1; // lobby + demand floors

  // Cumulative elevations of demand floors relative to zone bottom
  const floorElevations = new Float64Array(numFloors);
  floorElevations[0] = 0; // lobby
  let cumHeight = 0;
  for (let i = 0; i < numDemandFloors; i++) {
    cumHeight += (i < floorHeights.length ? floorHeights[i] : (floorHeights[floorHeights.length - 1] || 13));
    floorElevations[i + 1] = cumHeight;
  }

  // ── Express time (one-way, from S-curve kinematics) ──
  const expressTimeSec = expressDistanceFt > 0
    ? sCurveTravelTime(speedFpm * FPM_TO_MPS, expressDistanceFt * FT_TO_M, ACCEL_MAX, JERK_RATE)
    : 0;

  // ── Pre-compute travel time table ──
  const travelTable = buildTravelTimeTable(floorElevations, speedFpm);

  // ── Destination CDF (for weighted floor choice) ──
  const totalPop = floorPopulations.reduce((a, b) => a + b, 0);
  const floorCdf = new Float64Array(numDemandFloors);
  if (totalPop > 0) {
    let cum = 0;
    for (let i = 0; i < numDemandFloors; i++) {
      cum += floorPopulations[i] / totalPop;
      floorCdf[i] = cum;
    }
    // Ensure last entry is exactly 1.0 (avoid floating-point issues)
    floorCdf[numDemandFloors - 1] = 1.0;
  } else {
    // Uniform distribution fallback
    for (let i = 0; i < numDemandFloors; i++) {
      floorCdf[i] = (i + 1) / numDemandFloors;
    }
  }

  const doorCycle = doorCycleTime(doorHeightFt);

  // ── PRNG ──
  const rand = mulberry32(seed);

  // ── Run trials ──
  const trialAwts = new Float64Array(numTrials);
  const trialHcPercents = new Float64Array(numTrials);
  const trialIntervals = new Float64Array(numTrials);

  // Accumulate per-car utilization across trials
  const carBusyAccum = new Float64Array(activeElevators);
  let totalPassengers = 0;
  let representativeIdx = 0;
  let representativeTimeline: TrialResult['timeline'] = [];
  let representativeCarBusy: number[] = [];

  // Track the trial closest to the median AWT for representative timeline
  // We'll pick the middle trial after sorting by AWT
  const trialResults: TrialResult[] = [];

  for (let trial = 0; trial < numTrials; trial++) {
    const result = runSingleTrial(
      params,
      rand,
      travelTable,
      numFloors,
      floorCdf,
      expressTimeSec,
      doorCycle,
      effectiveCapacity,
      activeElevators,
    );

    trialAwts[trial] = result.meanAwt;
    trialHcPercents[trial] = result.hcPercent;
    trialIntervals[trial] = result.meanInterval;
    totalPassengers += result.totalArrived;

    for (let c = 0; c < activeElevators; c++) {
      carBusyAccum[c] += result.carBusyTicks[c];
    }

    // Store first trial's timeline as representative candidate
    // (we'll select the actual median trial later)
    if (trial === 0) {
      representativeTimeline = result.timeline;
      representativeCarBusy = result.carBusyTicks;
    }

    // Keep a lightweight reference for representative selection
    // For large trial counts, only store timeline for first few trials
    if (trial < 10) {
      trialResults.push(result);
    }
  }

  // ── Sort for percentiles ──
  const sortedAwts = new Float64Array(trialAwts).sort();
  const sortedHc = new Float64Array(trialHcPercents).sort();
  const sortedIntervals = new Float64Array(trialIntervals).sort();

  // Find the trial closest to median AWT for representative timeline
  const medAwt = median(sortedAwts);
  let closestDist = Infinity;
  for (let i = 0; i < Math.min(trialResults.length, 10); i++) {
    const dist = Math.abs(trialResults[i].meanAwt - medAwt);
    if (dist < closestDist) {
      closestDist = dist;
      representativeIdx = i;
      representativeTimeline = trialResults[i].timeline;
      representativeCarBusy = trialResults[i].carBusyTicks;
    }
  }

  // ── Car utilization (% of time busy) ──
  const totalTicks = Math.ceil(simulationDuration / TICK_DT);
  const carUtilization: number[] = [];
  for (let c = 0; c < activeElevators; c++) {
    const avgBusyTicks = carBusyAccum[c] / numTrials;
    carUtilization.push(Math.round((avgBusyTicks / totalTicks) * 1000) / 10);
  }

  // ── Compute trial-level RTT estimates ──
  // RTT ≈ interval × numElevators (approximate from simulation)
  const sortedRtts = new Float64Array(numTrials);
  for (let i = 0; i < numTrials; i++) {
    sortedRtts[i] = trialIntervals[i] * activeElevators;
  }
  sortedRtts.sort();

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

  // ── Stress test (if running with out-of-service elevators) ──
  if (elevatorsOutOfService > 0) {
    result.stressTest = {
      elevatorsRemoved: elevatorsOutOfService,
      medianAwtSec: result.medianAwtSec,
      p90AwtSec: result.p90AwtSec,
      meanHcPercent: result.meanHcPercent,
      degradationPercent: 0, // caller computes vs. baseline
    };
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════
// STRESS TEST HELPER
// ═══════════════════════════════════════════════════════════════════

/**
 * Run a stress test by removing 1 elevator from service.
 * Runs the full simulation, then computes degradation vs. a baseline
 * run with all elevators.
 */
export function runStressTest(params: MonteCarloParams): MonteCarloResult {
  const seed = params.seed ?? 42;
  // Run baseline (all elevators) — use same seed for reproducibility
  const baselineParams = { ...params, elevatorsOutOfService: 0, seed };
  const baseline = runMonteCarloSimulation(baselineParams);

  // Run degraded (one elevator removed) — use same seed so arrival
  // sequences match and the only variable is the missing car
  const stressParams = { ...params, elevatorsOutOfService: 1, seed };
  const stressed = runMonteCarloSimulation(stressParams);

  // Compute degradation
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
