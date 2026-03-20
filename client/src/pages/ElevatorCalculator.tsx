import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { PerplexityAttribution } from "@/components/PerplexityAttribution";
import {
  Building2,
  Plus,
  Trash2,
  ArrowUpDown,
  Gauge,
  Clock,
  CheckCircle2,
  XCircle,
  Calculator,
  Info,
  Download,
  FileText,
  ChevronDown,
  ChevronUp,
  Upload,
  FileSpreadsheet,
  X,
  SlidersHorizontal,
  RotateCcw,
  Copy,
  Layers,
} from "lucide-react";
import { analyzeElevators, recalculateZone, STANDARD_CAPACITIES, STANDARD_SPEEDS, getDefaultCriteria, type CriteriaThresholds } from "@/lib/elevatorEngine";
import { parseExcelFile } from "@/lib/excelParser";
import { exportAnalysisPDF } from "@/lib/pdfExport";
import { exportAreaChartExcel } from "@/lib/excelExport";
import { runMonteCarloSimulation, runStressTest } from "@/lib/monteCarloEngine";
import type { MonteCarloParams, MonteCarloResult } from "@/lib/monteCarloEngine";
import type { BuildingType, FloorInput, AnalysisResult, ZoneOutput, ZoneOverride } from "@shared/schema";
import { buildingTypes, buildingTypeLabels } from "@shared/schema";

// ═══════════════════════════════════════════════
// BUILDING ARRIVAL RATE LOOKUP
// ═══════════════════════════════════════════════

const BUILDING_ARRIVAL_RATES: Record<string, { rate: number; pattern: 'uppeak' | 'mixed' }> = {
  office_standard: { rate: 0.12, pattern: 'uppeak' },
  office_prestige: { rate: 0.13, pattern: 'uppeak' },
  hotel: { rate: 0.11, pattern: 'mixed' },
  residential: { rate: 0.065, pattern: 'mixed' },
  hospital: { rate: 0.10, pattern: 'uppeak' },
  ballroom_event: { rate: 0.25, pattern: 'uppeak' },
};

// ═══════════════════════════════════════════════
// SVG CHART COMPONENTS (inline, dark theme)
// ═══════════════════════════════════════════════

function AwtHistogram({ trialAwts, p10, median, p90 }: { trialAwts: number[]; p10: number; median: number; p90: number }) {
  const NUM_BINS = 20;
  if (trialAwts.length === 0) return null;

  const min = Math.min(...trialAwts);
  const max = Math.max(...trialAwts);
  const range = max - min || 1;
  const binWidth = range / NUM_BINS;

  const bins = new Array(NUM_BINS).fill(0);
  for (const v of trialAwts) {
    const idx = Math.min(Math.floor((v - min) / binWidth), NUM_BINS - 1);
    bins[idx]++;
  }
  const maxBin = Math.max(...bins, 1);

  const W = 400, H = 160;
  const padL = 36, padR = 8, padT = 12, padB = 28;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const barW = chartW / NUM_BINS;

  const toX = (val: number) => padL + ((val - min) / range) * chartW;

  const markers = [
    { val: p10, label: 'P10', color: '#FFC553' },
    { val: median, label: 'Med', color: '#20808D' },
    { val: p90, label: 'P90', color: '#FFC553' },
  ];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="xMidYMid meet">
      {/* Y axis labels */}
      <text x={padL - 4} y={padT + 4} textAnchor="end" className="fill-muted-foreground" style={{ fontSize: 9 }}>{maxBin}</text>
      <text x={padL - 4} y={padT + chartH} textAnchor="end" className="fill-muted-foreground" style={{ fontSize: 9 }}>0</text>
      {/* Bars */}
      {bins.map((count, i) => {
        const barH = (count / maxBin) * chartH;
        return (
          <rect
            key={i}
            x={padL + i * barW + 1}
            y={padT + chartH - barH}
            width={Math.max(barW - 2, 1)}
            height={barH}
            fill="#20808D"
            opacity={0.7}
            rx={1}
          />
        );
      })}
      {/* Marker lines */}
      {markers.map((m) => {
        const x = toX(m.val);
        if (x < padL || x > padL + chartW) return null;
        return (
          <g key={m.label}>
            <line x1={x} y1={padT} x2={x} y2={padT + chartH} stroke={m.color} strokeWidth={1.5} strokeDasharray={m.label === 'Med' ? '' : '3,3'} />
            <text x={x} y={padT - 2} textAnchor="middle" fill={m.color} style={{ fontSize: 8, fontWeight: 600 }}>{m.label}</text>
          </g>
        );
      })}
      {/* X axis labels */}
      <text x={padL} y={H - 4} textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: 8 }}>{min.toFixed(0)}s</text>
      <text x={padL + chartW} y={H - 4} textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: 8 }}>{max.toFixed(0)}s</text>
      <text x={padL + chartW / 2} y={H - 4} textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: 8 }}>AWT (sec)</text>
      {/* Baseline */}
      <line x1={padL} y1={padT + chartH} x2={padL + chartW} y2={padT + chartH} stroke="currentColor" strokeOpacity={0.15} strokeWidth={1} />
    </svg>
  );
}

function TrafficTimeline({ data }: { data: { timeSec: number; waitingPassengers: number; passengersServed: number }[] }) {
  if (data.length === 0) return null;

  const W = 400, H = 140;
  const padL = 36, padR = 8, padT = 12, padB = 28;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const maxTime = Math.max(...data.map(d => d.timeSec), 300);
  const maxWait = Math.max(...data.map(d => d.waitingPassengers), 1);
  const maxServed = Math.max(...data.map(d => d.passengersServed), 1);
  const maxY = Math.max(maxWait, maxServed);

  const toX = (t: number) => padL + (t / maxTime) * chartW;
  const toY = (v: number) => padT + chartH - (v / maxY) * chartH;

  const waitPath = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${toX(d.timeSec).toFixed(1)},${toY(d.waitingPassengers).toFixed(1)}`).join('');
  const servePath = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${toX(d.timeSec).toFixed(1)},${toY(d.passengersServed).toFixed(1)}`).join('');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="xMidYMid meet">
      {/* Grid lines */}
      {[0.25, 0.5, 0.75].map(f => (
        <line key={f} x1={padL} y1={padT + chartH * (1 - f)} x2={padL + chartW} y2={padT + chartH * (1 - f)} stroke="currentColor" strokeOpacity={0.08} />
      ))}
      {/* Y labels */}
      <text x={padL - 4} y={padT + 4} textAnchor="end" className="fill-muted-foreground" style={{ fontSize: 8 }}>{maxY}</text>
      <text x={padL - 4} y={padT + chartH} textAnchor="end" className="fill-muted-foreground" style={{ fontSize: 8 }}>0</text>
      {/* Lines */}
      <path d={waitPath} fill="none" stroke="#FFC553" strokeWidth={1.5} opacity={0.85} />
      <path d={servePath} fill="none" stroke="#20808D" strokeWidth={1.5} opacity={0.85} />
      {/* X labels */}
      <text x={padL} y={H - 4} textAnchor="start" className="fill-muted-foreground" style={{ fontSize: 8 }}>0s</text>
      <text x={padL + chartW / 2} y={H - 4} textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: 8 }}>150s</text>
      <text x={padL + chartW} y={H - 4} textAnchor="end" className="fill-muted-foreground" style={{ fontSize: 8 }}>300s</text>
      {/* Legend */}
      <rect x={padL + chartW - 100} y={padT} width={8} height={3} fill="#FFC553" rx={1} />
      <text x={padL + chartW - 88} y={padT + 3} className="fill-muted-foreground" style={{ fontSize: 7 }}>Waiting</text>
      <rect x={padL + chartW - 50} y={padT} width={8} height={3} fill="#20808D" rx={1} />
      <text x={padL + chartW - 38} y={padT + 3} className="fill-muted-foreground" style={{ fontSize: 7 }}>Served</text>
      {/* Baseline */}
      <line x1={padL} y1={padT + chartH} x2={padL + chartW} y2={padT + chartH} stroke="currentColor" strokeOpacity={0.15} strokeWidth={1} />
    </svg>
  );
}

function CarUtilizationBars({ utilization }: { utilization: number[] }) {
  if (utilization.length === 0) return null;

  const barH = 18;
  const gap = 4;
  const padL = 44, padR = 40;
  const W = 400;
  const H = utilization.length * (barH + gap) + gap;
  const chartW = W - padL - padR;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="xMidYMid meet">
      {utilization.map((pct, i) => {
        const y = gap + i * (barH + gap);
        const w = Math.max((pct / 100) * chartW, 1);
        return (
          <g key={i}>
            {/* Background */}
            <rect x={padL} y={y} width={chartW} height={barH} fill="currentColor" opacity={0.06} rx={3} />
            {/* Fill */}
            <rect x={padL} y={y} width={w} height={barH} fill="#20808D" opacity={0.75} rx={3} />
            {/* Label */}
            <text x={padL - 4} y={y + barH / 2 + 1} textAnchor="end" dominantBaseline="middle" className="fill-muted-foreground" style={{ fontSize: 9 }}>Car {i + 1}</text>
            {/* Pct */}
            <text x={padL + chartW + 4} y={y + barH / 2 + 1} textAnchor="start" dominantBaseline="middle" className="fill-foreground" style={{ fontSize: 9, fontWeight: 600, fontFamily: 'monospace' }}>{pct.toFixed(1)}%</text>
          </g>
        );
      })}
    </svg>
  );
}

// ═══════════════════════════════════════════════
// FLOOR INPUT ROW
// ═══════════════════════════════════════════════

interface FloorRowProps {
  floor: FloorInput;
  index: number;
  onChange: (index: number, field: keyof FloorInput, value: string | number) => void;
  onRemove: (index: number) => void;
  canRemove: boolean;
  isImported: boolean;
}

function FloorRow({ floor, index, onChange, onRemove, canRemove, isImported }: FloorRowProps) {
  return (
    <div className="flex items-center gap-2 group" data-testid={`floor-row-${index}`}>
      <div className="w-8 text-center text-xs text-muted-foreground font-mono tabular-nums shrink-0">
        {index + 1}
      </div>
      <Input
        data-testid={`input-floor-label-${index}`}
        className={`shrink-0 h-9 bg-background border-border/50 text-sm ${isImported ? "w-24" : "w-28"}`}
        placeholder="e.g. Level 2"
        value={floor.floorLabel}
        onChange={(e) => onChange(index, "floorLabel", e.target.value)}
      />
      <div className={`relative shrink-0 ${isImported ? "w-[120px]" : "flex-1 min-w-0"}`}>
        <Input
          data-testid={`input-floor-area-${index}`}
          className="h-9 bg-background border-border/50 text-sm pr-10"
          type="number"
          placeholder="0"
          value={floor.grossArea || ""}
          onChange={(e) => onChange(index, "grossArea", parseFloat(e.target.value) || 0)}
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
          SF
        </span>
      </div>
      {/* Editable Ht column — fixed width, always rendered when imported */}
      {isImported && (
        <div className="w-[72px] shrink-0 relative">
          <Input
            data-testid={`input-floor-height-${index}`}
            className="h-9 bg-background border-border/50 text-sm pr-6 pl-2 text-right font-mono tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            type="number"
            step="0.5"
            placeholder="—"
            value={floor.floorToFloorHeight ?? ""}
            onChange={(e) => {
              const val = parseFloat(e.target.value);
              onChange(index, "floorToFloorHeight", val > 0 ? val : 0);
            }}
          />
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">
            ft
          </span>
        </div>
      )}
      {/* Editable Zone column — fixed width, always rendered when imported */}
      {isImported && (
        <div className="w-16 shrink-0">
          <Input
            data-testid={`input-floor-zone-${index}`}
            className="h-9 bg-background border-border/50 text-sm text-center font-mono uppercase"
            placeholder="—"
            value={floor.zone ?? ""}
            onChange={(e) => onChange(index, "zone", e.target.value.toUpperCase())}
          />
        </div>
      )}
      {/* Per-floor density column */}
      {isImported && (
        <div className="w-[68px] shrink-0 relative">
          <Input
            data-testid={`input-floor-density-${index}`}
            className="h-9 bg-background border-border/50 text-sm pr-1 pl-2 text-right font-mono tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            type="number"
            placeholder="—"
            value={floor.densitySqftPerPerson ?? ""}
            onChange={(e) => {
              const val = parseFloat(e.target.value);
              onChange(index, "densitySqftPerPerson", val > 0 ? val : 0);
            }}
          />
        </div>
      )}
      {/* Per-floor total population column */}
      {isImported && (
        <div className="w-[60px] shrink-0 relative">
          <Input
            data-testid={`input-floor-pop-${index}`}
            className="h-9 bg-background border-border/50 text-sm pr-1 pl-2 text-right font-mono tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            type="number"
            placeholder="—"
            value={floor.totalPopulation ?? ""}
            onChange={(e) => {
              const val = parseFloat(e.target.value);
              onChange(index, "totalPopulation", val > 0 ? Math.round(val) : 0);
            }}
          />
        </div>
      )}
      <Button
        data-testid={`button-remove-floor-${index}`}
        variant="ghost"
        size="icon"
        className="h-9 w-9 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
        onClick={() => onRemove(index)}
        disabled={!canRemove}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// ═══════════════════════════════════════════════
// ZONE RESULT CARD (with tuning controls)
// ═══════════════════════════════════════════════

interface ZoneCardProps {
  zone: ZoneOutput;
  overrides: ZoneOverride;
  onOverrideChange: (zoneIndex: number, overrides: ZoneOverride) => void;
  onReset: (zoneIndex: number) => void;
  hasOverrides: boolean;
  mcResult?: MonteCarloResult;
  mcRunning?: boolean;
}

function ZoneCard({ zone, overrides, onOverrideChange, onReset, hasOverrides, mcResult, mcRunning }: ZoneCardProps) {
  const [expanded, setExpanded] = useState<false | 'details' | 'engineering' | 'simulation'>(false);
  const [tuning, setTuning] = useState(false);

  const handleOverride = (field: keyof ZoneOverride, value: number | undefined) => {
    const next = { ...overrides, [field]: value };
    // HC% adjusts the pass criteria threshold; # Elevators adjusts count.
    // Both can be set independently.
    onOverrideChange(zone.zoneIndex, next);
  };

  return (
    <Card
      className={`p-0 overflow-hidden border-border/40 ${hasOverrides ? "ring-1 ring-primary/20" : ""}`}
      data-testid={`zone-card-${zone.zoneIndex}`}
    >
      {/* Zone Header */}
      <div className="px-5 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-md bg-primary/10 flex items-center justify-center">
            <Building2 className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">{zone.zoneName}</h3>
            <p className="text-xs text-muted-foreground">
              Floors {zone.floorsServed} · {zone.floorCount} floors
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {zone.meetsPerformanceCriteria ? (
            <Badge
              variant="outline"
              className="text-emerald-100 border-emerald-500 bg-emerald-600 text-sm font-semibold px-3 py-1"
              data-testid={`badge-criteria-${zone.zoneIndex}`}
            >
              <CheckCircle2 className="h-4 w-4 mr-1.5" />
              Meets Criteria
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="text-red-400 border-red-400/30 bg-red-400/5 text-xs"
              data-testid={`badge-criteria-${zone.zoneIndex}`}
            >
              <XCircle className="h-3 w-3 mr-1" />
              Below Criteria
            </Badge>
          )}
        </div>
      </div>

      <Separator className="bg-border/30" />

      {/* Key Metrics Grid */}
      <div className="grid grid-cols-4 divide-x divide-border/30">
        <MetricCell
          icon={<ArrowUpDown className="h-3.5 w-3.5" />}
          label="Elevators"
          value={zone.numElevators.toString()}
          modified={overrides.numElevators !== undefined}
        />
        <MetricCell
          icon={<Gauge className="h-3.5 w-3.5" />}
          label="Capacity"
          value={`${zone.capacityLbs.toLocaleString()}`}
          unit="lbs"
          modified={overrides.capacityLbs !== undefined}
        />
        <MetricCell
          icon={<ArrowUpDown className="h-3.5 w-3.5" />}
          label="Speed"
          value={zone.speedFpm.toString()}
          unit="fpm"
          modified={overrides.speedFpm !== undefined}
        />
        <MetricCell
          icon={<Clock className="h-3.5 w-3.5" />}
          label="Avg Wait"
          value={zone.avgWaitTimeSec.toFixed(1)}
          unit="sec"
          mcRange={mcResult ? `MC: ${mcResult.p10AwtSec.toFixed(1)} – ${mcResult.p90AwtSec.toFixed(1)}s` : undefined}
        />
      </div>

      <Separator className="bg-border/30" />

      {/* Tune + Details row */}
      <div className="flex divide-x divide-border/30">
        <button
          className={`flex-1 px-5 py-2.5 flex items-center justify-between text-xs transition-colors ${
            tuning
              ? "text-primary bg-primary/5"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
          }`}
          onClick={() => setTuning(!tuning)}
          data-testid={`button-tune-zone-${zone.zoneIndex}`}
        >
          <span className="flex items-center gap-1.5">
            <SlidersHorizontal className="h-3 w-3" />
            Tune
          </span>
          {tuning ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
        <button
          className={`flex-1 px-5 py-2.5 flex items-center justify-between text-xs transition-colors ${
            expanded === 'details'
              ? "text-primary bg-primary/5"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
          }`}
          onClick={() => setExpanded(expanded === 'details' ? false : 'details')}
          data-testid={`button-expand-zone-${zone.zoneIndex}`}
        >
          <span>Details</span>
          {expanded === 'details' ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
        <button
          className={`flex-1 px-5 py-2.5 flex items-center justify-between text-xs transition-colors ${
            expanded === 'engineering'
              ? "text-primary bg-primary/5"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
          }`}
          onClick={() => setExpanded(expanded === 'engineering' ? false : 'engineering')}
          data-testid={`button-engineering-zone-${zone.zoneIndex}`}
        >
          <span>Engineering</span>
          {expanded === 'engineering' ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
        {(mcResult || mcRunning) && (
          <button
            className={`flex-1 px-5 py-2.5 flex items-center justify-between text-xs transition-colors ${
              expanded === 'simulation'
                ? "text-primary bg-primary/5"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
            }`}
            onClick={() => setExpanded(expanded === 'simulation' ? false : 'simulation')}
            data-testid={`button-simulation-zone-${zone.zoneIndex}`}
          >
            <span className="flex items-center gap-1.5">
              Simulation
              {mcRunning && !mcResult && (
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
              )}
            </span>
            {expanded === 'simulation' ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>

      {/* Tuning Controls */}
      {tuning && (
        <>
          <Separator className="bg-border/30" />
          <div className="px-5 py-4 space-y-3 bg-muted/10">
            <div className="flex items-center justify-between mb-1">
              <p className="text-[11px] text-muted-foreground uppercase tracking-wider font-medium">
                Override Parameters
              </p>
              {hasOverrides && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[11px] px-2 text-muted-foreground hover:text-foreground"
                  onClick={() => onReset(zone.zoneIndex)}
                  data-testid={`button-reset-zone-${zone.zoneIndex}`}
                >
                  <RotateCcw className="h-3 w-3 mr-1" />
                  Reset
                </Button>
              )}
            </div>

            <div className="grid grid-cols-3 gap-3">
              {/* Number of Elevators */}
              <div>
                <Label className="text-[11px] text-muted-foreground mb-1 block"># Elevators</Label>
                <Select
                  value={(overrides.numElevators ?? zone.numElevators).toString()}
                  onValueChange={(v) => handleOverride("numElevators", parseInt(v))}
                >
                  <SelectTrigger className="h-8 text-xs bg-background" data-testid={`select-elevators-${zone.zoneIndex}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 14 }, (_, i) => i + 1).map((n) => (
                      <SelectItem key={n} value={n.toString()}>
                        {n} elevator{n > 1 ? "s" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Capacity */}
              <div>
                <Label className="text-[11px] text-muted-foreground mb-1 block">Capacity</Label>
                <Select
                  value={(overrides.capacityLbs ?? zone.capacityLbs).toString()}
                  onValueChange={(v) => handleOverride("capacityLbs", parseInt(v))}
                >
                  <SelectTrigger className="h-8 text-xs bg-background" data-testid={`select-capacity-${zone.zoneIndex}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STANDARD_CAPACITIES.map((c) => (
                      <SelectItem key={c.lbs} value={c.lbs.toString()}>
                        {c.lbs.toLocaleString()} lbs ({c.persons} persons)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Speed */}
              <div>
                <Label className="text-[11px] text-muted-foreground mb-1 block">Speed</Label>
                <Select
                  value={(overrides.speedFpm ?? zone.speedFpm).toString()}
                  onValueChange={(v) => handleOverride("speedFpm", parseInt(v))}
                >
                  <SelectTrigger className="h-8 text-xs bg-background" data-testid={`select-speed-${zone.zoneIndex}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STANDARD_SPEEDS.map((s) => (
                      <SelectItem key={s} value={s.toString()}>
                        {s} fpm
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Density */}
              <div>
                <Label className="text-[11px] text-muted-foreground mb-1 block">Density (SF/person)</Label>
                <Input
                  className="h-8 text-xs bg-background"
                  type="number"
                  value={overrides.densitySqftPerPerson ?? zone.densitySqftPerPerson}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    handleOverride("densitySqftPerPerson", val > 0 ? val : undefined);
                  }}
                  data-testid={`input-density-${zone.zoneIndex}`}
                />
              </div>

              {/* Handling Capacity % — adjusts pass criteria threshold */}
              <div>
                <Label className="text-[11px] text-muted-foreground mb-1 block">Min HC% to Pass</Label>
                <Input
                  className="h-8 text-xs bg-background"
                  type="number"
                  step="0.5"
                  value={overrides.handlingCapacityPercent ?? zone.handlingCapacityPercent}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    handleOverride("handlingCapacityPercent", val > 0 ? val : undefined);
                  }}
                  data-testid={`input-hc-${zone.zoneIndex}`}
                />
              </div>

              {/* Door Height */}
              <div>
                <Label className="text-[11px] text-muted-foreground mb-1 block">Door Height</Label>
                <Select
                  value={(overrides.doorHeightFt ?? 8).toString()}
                  onValueChange={(v) => handleOverride("doorHeightFt", parseInt(v) as 7 | 8)}
                >
                  <SelectTrigger className="h-8 text-xs bg-background" data-testid={`select-door-height-${zone.zoneIndex}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="7">7 ft</SelectItem>
                    <SelectItem value="8">8 ft</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Expandable Details */}
      {expanded === 'details' && (
        <>
          <Separator className="bg-border/30" />
          <div className="px-5 py-4 space-y-2">
            {/* Core Metrics */}
            <DetailRow label="Density" value={`${zone.densitySqftPerPerson} SF/person`} />
            <DetailRow label="Zone Population" value={`${zone.totalPopulation} persons`} />
            <DetailRow label="Handling Capacity" value={`${zone.handlingCapacityPercent}%`} />
            <DetailRow label="Interval" value={`${zone.intervalSec} sec`} />
            <DetailRow label="Round Trip Time" value={`${zone.roundTripTimeSec} sec`} />
            <DetailRow label="Car Capacity" value={`${zone.capacityPersons} persons (${zone.capacityLbs.toLocaleString()} lbs)`} />
            <DetailRow
              label="Performance"
              value={zone.meetsPerformanceCriteria ? "Meets Criteria" : "Does Not Meet"}
              valueClass={zone.meetsPerformanceCriteria ? "text-emerald-500" : "text-red-400"}
            />
          </div>

          {/* Shaft Layout & Core Area */}
          <Separator className="bg-border/30" />
          <div className="px-5 py-4 space-y-2">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2 font-medium">Shaft Layout & Core Area</div>
            <DetailRow label="Shaft Count" value={`${zone.shaftCount} shafts`} />
            <DetailRow label="Shaft Size" value={zone.shaftSizeFt} />
            <DetailRow label="Bank Arrangement" value={zone.bankArrangement} />
            <DetailRow label="Approx. Core Area" value={`${zone.approxCoreSqft.toLocaleString()} SF`} />
            <DetailRow label="Pit Depth" value={`${zone.pitDepthFt}'-0"`} />
            <DetailRow label="Overhead Clearance" value={`${zone.overheadClearanceFt}'-0"`} />
            <DetailRow
              label="Machine Room"
              value={zone.mrlEligible ? "MRL Eligible" : "Machine Room Required"}
              valueClass={zone.mrlEligible ? "text-emerald-500" : "text-amber-400"}
            />
          </div>

          {/* Down-Peak / Lunchtime Analysis */}
          <Separator className="bg-border/30" />
          <div className="px-5 py-4 space-y-2">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2 font-medium">Down-Peak / Lunchtime</div>
            <DetailRow label="Down-Peak RTT" value={`${zone.downPeakRttSec} sec`} />
            <DetailRow label="Down-Peak Interval" value={`${zone.downPeakIntervalSec} sec`} />
            <DetailRow label="Down-Peak HC" value={`${zone.downPeakHcPercent}%`} />
            <DetailRow label="Down-Peak AWT" value={`${zone.downPeakAwtSec} sec`} />
            <DetailRow
              label="Down-Peak Performance"
              value={zone.downPeakMeetsCriteria ? "Meets Criteria" : "Does Not Meet"}
              valueClass={zone.downPeakMeetsCriteria ? "text-emerald-500" : "text-red-400"}
            />
          </div>
        </>
      )}

      {/* Expandable Engineering Data */}
      {expanded === 'engineering' && (
        <>
          <Separator className="bg-border/30" />
          <div className="px-5 py-4 space-y-2">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2 font-medium">Structural Loads (Per Elevator)</div>
            <DetailRow label="Machine Weight" value={`${zone.structural.machineWeightLbs.toLocaleString()} lbs`} />
            <DetailRow label="Cab Weight (Empty)" value={`${zone.structural.cabWeightLbs.toLocaleString()} lbs`} />
            <DetailRow label="Counterweight" value={`${zone.structural.counterweightLbs.toLocaleString()} lbs`} />
            <DetailRow label="Guide Rail Load" value={`${zone.structural.guideRailLoadLbsPerFt} lbs/ft (per pair)`} />
            <DetailRow label="Machine Beam Reaction" value={`${zone.structural.beamReactionPerShaftLbs.toLocaleString()} lbs`} />
            <DetailRow label="Dead Load / Shaft" value={`${zone.structural.totalShaftReactionLbs.toLocaleString()} lbs`} />
          </div>

          <Separator className="bg-border/30" />
          <div className="px-5 py-4 space-y-2">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2 font-medium">Structural Loads (Bank Total)</div>
            <DetailRow label="Total Bank Dead Load" value={`${zone.structural.totalBankReactionLbs.toLocaleString()} lbs`} />
            {zone.structural.machineRoomLoadPsf > 0 && (
              <DetailRow label="Machine Room Floor Load" value={`${zone.structural.machineRoomLoadPsf} PSF`} />
            )}
            <DetailRow
              label="Machine Room"
              value={zone.mrlEligible ? "Not Required (MRL)" : "Required"}
              valueClass={zone.mrlEligible ? "text-emerald-500" : "text-amber-400"}
            />
          </div>

          <Separator className="bg-border/30" />
          <div className="px-5 py-4 space-y-2">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2 font-medium">Electrical (Per Elevator)</div>
            <DetailRow label="Controller" value={zone.electrical.controllerType} />
            <DetailRow label="Motor" value={`${zone.electrical.motorHp} HP (${zone.electrical.motorKw} kW)`} />
            <DetailRow label="Demand" value={`${zone.electrical.demandKva} kVA`} />
            <DetailRow label="Feeder" value={`${zone.electrical.feederAmps}A`} />
            <DetailRow label="Wire Size" value={zone.electrical.wireSize} />
            <DetailRow label="Disconnect" value={zone.electrical.disconnectSize} />
            <DetailRow label="Voltage" value={zone.electrical.voltageSystem} />
          </div>

          <Separator className="bg-border/30" />
          <div className="px-5 py-4 space-y-2">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2 font-medium">Electrical (Bank Total)</div>
            <DetailRow label="Bank Demand" value={`${zone.electrical.totalBankKva} kVA (with diversity)`} />
            <DetailRow label="Bank Feeder" value={`${zone.electrical.totalBankAmps}A @ 480V/3Ph`} />
          </div>
        </>
      )}

      {/* Expandable Simulation Panel */}
      {expanded === 'simulation' && (
        <>
          <Separator className="bg-border/30" />
          {mcRunning && !mcResult ? (
            <div className="px-5 py-8 flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <span className="inline-block h-2 w-2 rounded-full bg-primary animate-pulse" />
              Simulating…
            </div>
          ) : mcResult ? (
            <div className="px-5 py-4 space-y-5">
              {/* Summary Statistics */}
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3 font-medium">Summary Statistics</div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2">
                  <DetailRow label="Median AWT" value={`${mcResult.medianAwtSec.toFixed(1)} sec`} />
                  <DetailRow label="P10 – P90 AWT" value={`${mcResult.p10AwtSec.toFixed(1)} – ${mcResult.p90AwtSec.toFixed(1)} sec`} />
                  <DetailRow label="Mean HC%" value={`${mcResult.meanHcPercent.toFixed(1)}%`} />
                  <DetailRow label="P10 HC%" value={`${mcResult.p10HcPercent.toFixed(1)}%`} />
                  <DetailRow label="Median Interval" value={`${mcResult.medianIntervalSec.toFixed(1)} sec`} />
                  <DetailRow label="P90 Interval" value={`${mcResult.p90IntervalSec.toFixed(1)} sec`} />
                  <DetailRow label="Median RTT" value={`${mcResult.medianRttSec.toFixed(1)} sec`} />
                  <DetailRow label="Total Passengers" value={mcResult.totalPassengersSimulated.toLocaleString()} />
                  <DetailRow label="Confidence" value={`${(mcResult.confidenceLevel * 100).toFixed(0)}% across ${mcResult.numTrials} trials`} />
                </div>
              </div>

              {/* AWT Distribution */}
              <div>
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2 font-medium">AWT Distribution</div>
                <AwtHistogram
                  trialAwts={mcResult.trialAwts}
                  p10={mcResult.p10AwtSec}
                  median={mcResult.medianAwtSec}
                  p90={mcResult.p90AwtSec}
                />
              </div>

              {/* Traffic Flow Timeline */}
              {mcResult.timelineData.length > 0 && (
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2 font-medium">Traffic Flow (Representative Trial)</div>
                  <TrafficTimeline data={mcResult.timelineData} />
                </div>
              )}

              {/* Car Utilization */}
              {mcResult.carUtilization.length > 0 && (
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2 font-medium">Car Utilization</div>
                  <CarUtilizationBars utilization={mcResult.carUtilization} />
                </div>
              )}

              {/* Stress Test */}
              {mcResult.stressTest && (
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3 font-medium">Stress Test (1 Elevator Removed)</div>
                  <div className="space-y-2">
                    <DetailRow label="Degraded AWT" value={`${mcResult.stressTest.medianAwtSec.toFixed(1)} sec (P90: ${mcResult.stressTest.p90AwtSec.toFixed(1)})`} />
                    <DetailRow label="Degraded HC%" value={`${mcResult.stressTest.meanHcPercent.toFixed(1)}%`} />
                    <DetailRow
                      label="AWT Increase"
                      value={`${mcResult.stressTest.degradationPercent > 0 ? '+' : ''}${mcResult.stressTest.degradationPercent.toFixed(1)}%`}
                      valueClass={
                        Math.abs(mcResult.stressTest.degradationPercent) <= 20
                          ? 'text-emerald-500'
                          : mcResult.stressTest.degradationPercent <= 40
                            ? 'text-amber-400'
                            : 'text-red-400'
                      }
                    />
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

function MetricCell({
  icon,
  label,
  value,
  unit,
  modified,
  mcRange,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  unit?: string;
  modified?: boolean;
  mcRange?: string;
}) {
  return (
    <div className="px-4 py-3.5 text-center">
      <div className="flex items-center justify-center gap-1 text-muted-foreground mb-1">
        {icon}
        <span className="text-[11px] uppercase tracking-wider">{label}</span>
      </div>
      <div className={`text-lg font-semibold tabular-nums ${modified ? "text-primary" : ""}`}>
        {value}
        {unit && <span className="text-xs text-muted-foreground ml-1 font-normal">{unit}</span>}
      </div>
      {mcRange && (
        <div className="text-[10px] text-muted-foreground font-mono tabular-nums mt-0.5">
          {mcRange}
        </div>
      )}
    </div>
  );
}

function DetailRow({
  label,
  value,
  valueClass = "",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex justify-between items-center text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-medium tabular-nums ${valueClass}`}>{value}</span>
    </div>
  );
}

// ═══════════════════════════════════════════════
// SUMMARY CARD
// ═══════════════════════════════════════════════

function SummaryCard({ result }: { result: AnalysisResult }) {
  const totalElevators = result.zones.reduce((s, z) => s + z.numElevators, 0);
  const allMeetCriteria = result.zones.every((z) => z.meetsPerformanceCriteria);

  return (
    <Card className="p-5 border-border/40" data-testid="summary-card">
      <div className="flex items-center gap-2 mb-4">
        <div className="h-7 w-7 rounded-md bg-primary/10 flex items-center justify-center">
          <Calculator className="h-3.5 w-3.5 text-primary" />
        </div>
        <h2 className="text-sm font-semibold">Analysis Summary</h2>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div>
          <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-0.5">
            Total Floors
          </p>
          <p className="text-xl font-semibold tabular-nums">{result.totalFloors}</p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-0.5">
            Total Area
          </p>
          <p className="text-xl font-semibold tabular-nums">
            {result.totalGrossArea.toLocaleString()}
            <span className="text-xs text-muted-foreground ml-1 font-normal">SF</span>
          </p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-0.5">
            Population
          </p>
          <p className="text-xl font-semibold tabular-nums">{result.totalPopulation.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-0.5">
            Total Elevators
          </p>
          <p className="text-xl font-semibold tabular-nums">
            {totalElevators}
            <span className="ml-2">
              {allMeetCriteria ? (
                <Badge variant="outline" className="text-emerald-500 border-emerald-500/30 bg-emerald-500/5 text-[10px] font-normal">
                  Pass
                </Badge>
              ) : (
                <Badge variant="outline" className="text-red-400 border-red-400/30 bg-red-400/5 text-[10px] font-normal">
                  Review
                </Badge>
              )}
            </span>
          </p>
        </div>
      </div>
    </Card>
  );
}

// ═══════════════════════════════════════════════
// CSV EXPORT
// ═══════════════════════════════════════════════

function exportToCSV(result: AnalysisResult) {
  const headers = [
    "Zone",
    "Floors Served",
    "# Elevators",
    "Capacity (lbs)",
    "Speed (fpm)",
    "Density (SF/person)",
    "Zone Population",
    "Handling Capacity (%)",
    "Avg Wait Time (sec)",
    "Interval (sec)",
    "Round Trip Time (sec)",
    "Meets Performance Criteria",
  ];

  const rows = result.zones.map((z) => [
    z.zoneName,
    z.floorsServed,
    z.numElevators,
    z.capacityLbs,
    z.speedFpm,
    z.densitySqftPerPerson,
    z.totalPopulation,
    z.handlingCapacityPercent,
    z.avgWaitTimeSec,
    z.intervalSec,
    z.roundTripTimeSec,
    z.meetsPerformanceCriteria ? "Yes" : "No",
  ]);

  const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  const blob = new Blob([csvContent], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "elevator-analysis.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════════════
// FILE UPLOAD DROP ZONE
// ═══════════════════════════════════════════════

interface UploadZoneProps {
  onFileLoaded: (data: { floors: FloorInput[]; projectName: string; avgFloorHeight: number }) => void;
  importedFileName: string | null;
  onClear: () => void;
}

function UploadZone({ onFileLoaded, importedFileName, onClear }: UploadZoneProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.name.match(/\.xlsx?$/i)) {
        toast({
          description: "Please upload an Excel file (.xlsx or .xls).",
          variant: "destructive",
        });
        return;
      }

      try {
        const buffer = await file.arrayBuffer();
        const parsed = parseExcelFile(buffer);
        onFileLoaded(parsed);
        toast({
          description: `Imported ${parsed.floors.length} floors from "${file.name}"`,
        });
      } catch (err: any) {
        toast({
          description: err.message || "Could not parse the Excel file.",
          variant: "destructive",
        });
      }
    },
    [onFileLoaded, toast]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
      e.target.value = "";
    },
    [handleFile]
  );

  if (importedFileName) {
    return (
      <div
        className="flex items-center gap-3 px-4 py-3 rounded-lg border border-primary/20 bg-primary/5"
        data-testid="upload-success-banner"
      >
        <FileSpreadsheet className="h-4 w-4 text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-foreground truncate">{importedFileName}</p>
          <p className="text-[11px] text-muted-foreground">Area chart imported</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
          onClick={onClear}
          data-testid="button-clear-import"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls"
        className="hidden"
        onChange={handleInputChange}
        data-testid="input-file-upload"
      />
      <button
        className={`w-full flex flex-col items-center justify-center gap-2 px-4 py-5 rounded-lg border-2 border-dashed transition-colors cursor-pointer ${
          isDragging
            ? "border-primary bg-primary/5"
            : "border-border/50 hover:border-primary/40 hover:bg-muted/30"
        }`}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        data-testid="upload-dropzone"
      >
        <div className="h-9 w-9 rounded-full bg-muted/50 flex items-center justify-center">
          <Upload className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="text-center">
          <p className="text-xs font-medium text-foreground">
            Drop your area chart here
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            or click to browse · .xlsx
          </p>
        </div>
      </button>
    </>
  );
}

// ═══════════════════════════════════════════════
// ZONE FLOOR MAP — preserves floor geometry per zone for recalculation
// ═══════════════════════════════════════════════

function buildZoneFloorMap(floors: FloorInput[]): Map<string, FloorInput[]> {
  // Group floors by zone code for recalculation
  const map = new Map<string, FloorInput[]>();
  const singleZoneFloors = floors.filter(
    (f) => f.zone && !f.zone.includes(",") && f.zone.trim().length > 0
  );
  const multiZoneFloors = floors.filter(
    (f) => f.zone && f.zone.includes(",")
  );
  // Also handle auto-zoned floors (no zone codes)
  const hasZoneCodes = singleZoneFloors.length > 0;

  if (!hasZoneCodes) {
    // For auto-zoned, just store all floors under a generic key
    // The engine will split them during analysis
    map.set("__all__", floors);
  } else {
    const zoneCodes = [...new Set(singleZoneFloors.map((f) => f.zone!.trim()))];
    const zoneOrder = ["L", "M", "H", "1", "2", "3", "4"];
    zoneCodes.sort((a, b) => {
      const ia = zoneOrder.indexOf(a);
      const ib = zoneOrder.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    zoneCodes.forEach((code) => {
      const dedicated = singleZoneFloors.filter((f) => f.zone!.trim() === code);
      const shared = multiZoneFloors.filter((f) => {
        const codes = f.zone!.split(",").map((c) => c.trim().toUpperCase());
        return codes.includes(code.toUpperCase());
      });
      map.set(code, [...shared, ...dedicated]);
    });
  }

  return map;
}

// ═══════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════

export default function ElevatorCalculator() {
  const { toast } = useToast();
  const [buildingType, setBuildingType] = useState<BuildingType>("office_standard");
  const [densityOverride, setDensityOverride] = useState<string>("");

  // Default floor-to-floor height fallback (used only when individual floors lack per-floor heights)
  const DEFAULT_FLOOR_HEIGHT = 13;
  const [floors, setFloors] = useState<FloorInput[]>([
    { floorLabel: "Floor 1", grossArea: 20000 },
    { floorLabel: "Floor 2", grossArea: 20000 },
    { floorLabel: "Floor 3", grossArea: 20000 },
    { floorLabel: "Floor 4", grossArea: 20000 },
    { floorLabel: "Floor 5", grossArea: 20000 },
  ]);
  const [baseResult, setBaseResult] = useState<AnalysisResult | null>(null);
  const [importedFileName, setImportedFileName] = useState<string | null>(null);
  const [zoneOverrides, setZoneOverrides] = useState<Record<number, ZoneOverride>>({});

  // Destination dispatch toggle — applied before analysis
  const [destinationDispatch, setDestinationDispatch] = useState(false);

  // Monte Carlo simulation state
  const [monteCarloEnabled, setMonteCarloEnabled] = useState(false);
  const [mcTrials, setMcTrials] = useState<string>("1000");
  const [mcRunning, setMcRunning] = useState(false);
  const [mcResults, setMcResults] = useState<Record<number, MonteCarloResult>>({});

  // Comparison mode: saved snapshots
  interface SavedSnapshot {
    id: number;
    label: string;
    result: AnalysisResult;
    dd: boolean;
    buildingType: BuildingType;
    timestamp: number;
  }
  const [savedSnapshots, setSavedSnapshots] = useState<SavedSnapshot[]>([]);
  const [showComparison, setShowComparison] = useState(false);
  const snapshotCounter = useRef(0);

  // Pass/fail criteria — initialized from building type defaults
  const defaultCriteria = getDefaultCriteria(buildingType);
  const [criteriaInterval, setCriteriaInterval] = useState<string>(defaultCriteria.maxIntervalSec.toString());
  const [criteriaHc, setCriteriaHc] = useState<string>(defaultCriteria.minHcPercent.toString());
  const [criteriaAwt, setCriteriaAwt] = useState<string>(defaultCriteria.maxAwtSec.toString());

  // Reset criteria when building type changes
  useEffect(() => {
    const defaults = getDefaultCriteria(buildingType);
    setCriteriaInterval(defaults.maxIntervalSec.toString());
    setCriteriaHc(defaults.minHcPercent.toString());
    setCriteriaAwt(defaults.maxAwtSec.toString());
  }, [buildingType]);

  // Build the criteria overrides object
  const criteriaOverrides: Partial<CriteriaThresholds> = useMemo(() => {
    const o: Partial<CriteriaThresholds> = {};
    const iv = parseFloat(criteriaInterval);
    if (!isNaN(iv)) o.maxIntervalSec = iv;
    const hc = parseFloat(criteriaHc);
    if (!isNaN(hc)) o.minHcPercent = hc;
    const aw = parseFloat(criteriaAwt);
    if (!isNaN(aw)) o.maxAwtSec = aw;
    return o;
  }, [criteriaInterval, criteriaHc, criteriaAwt]);

  const isImported = importedFileName !== null;

  // Memoize zone floor map for recalculation
  const zoneFloorMap = useMemo(() => buildZoneFloorMap(floors), [floors]);

  // Get zone floors for a specific zone index (matches the order from engine)
  const getZoneFloors = useCallback((zoneIndex: number): FloorInput[] => {
    const keys = [...zoneFloorMap.keys()];
    if (keys.length === 1 && keys[0] === "__all__") {
      // Auto-zoned — return all floors (recalculate will use same geometry)
      return zoneFloorMap.get("__all__") || [];
    }
    const key = keys[zoneIndex];
    return key ? zoneFloorMap.get(key) || [] : [];
  }, [zoneFloorMap]);

  // Helper: compute express distance for a zone from floor data
  const computeExpressDistance = useCallback((zone: ZoneOutput, zoneFloors: FloorInput[]): number => {
    // Find the lowest demand floor's elevation if available
    const lowestFloor = zoneFloors.find(f => f.elevation !== undefined && f.elevation > 0);
    if (lowestFloor?.elevation) return lowestFloor.elevation;
    // Estimate from floor heights — floors below the zone are express
    // Parse the zone's floorsServed to estimate which floor index it starts at
    const match = zone.floorsServed.match(/(\d+)/);
    const startFloorNum = match ? parseInt(match[1]) : 2;
    const avgHeight = zoneFloors[0]?.floorToFloorHeight || DEFAULT_FLOOR_HEIGHT;
    return Math.max(0, (startFloorNum - 1) * avgHeight);
  }, [DEFAULT_FLOOR_HEIGHT]);

  // Run Monte Carlo simulation for all zones
  const runMonteCarlo = useCallback(async (analysisResult: AnalysisResult) => {
    setMcRunning(true);
    setMcResults({});
    const results: Record<number, MonteCarloResult> = {};
    const config = BUILDING_ARRIVAL_RATES[buildingType] || { rate: 0.12, pattern: 'uppeak' as const };
    const density = densityOverride ? parseFloat(densityOverride) : undefined;

    for (const zone of analysisResult.zones) {
      const zoneFloors = getZoneFloors(zone.zoneIndex);
      const demandFloors = zoneFloors.filter(f => !f.zone?.includes(','));
      const floorHeights = (demandFloors.length > 0 ? demandFloors : zoneFloors).map(
        f => f.floorToFloorHeight || DEFAULT_FLOOR_HEIGHT
      );

      // Use per-floor density and population logic matching the engine
      const defaultDensity = density || zone.densitySqftPerPerson || 135;
      const floorPops = (demandFloors.length > 0 ? demandFloors : zoneFloors).map(f => {
        if (f.totalPopulation && f.totalPopulation > 0) return f.totalPopulation;
        const d = f.densitySqftPerPerson || defaultDensity;
        return Math.round(f.grossArea / d);
      });

      const ov = zoneOverrides[zone.zoneIndex] || {};

      const params: MonteCarloParams = {
        numElevators: zone.numElevators,
        capacityLbs: zone.capacityLbs,
        capacityPersons: zone.capacityPersons,
        speedFpm: zone.speedFpm,
        numTrials: parseInt(mcTrials) || 1000,
        simulationDuration: 300,
        floorHeights,
        floorPopulations: floorPops,
        expressDistanceFt: computeExpressDistance(zone, zoneFloors),
        arrivalRate: config.rate,
        doorHeightFt: ov.doorHeightFt || 8,
        trafficPattern: config.pattern,
        deterministicRttSec: zone.roundTripTimeSec,
      };

      // Yield to UI between zones
      await new Promise(resolve => setTimeout(resolve, 0));
      const mcResult = runMonteCarloSimulation(params);

      // Run stress test (1 elevator removed)
      if (zone.numElevators > 1) {
        const stressResult = runStressTest(params);
        mcResult.stressTest = stressResult.stressTest;
      }

      results[zone.zoneIndex] = mcResult;
      // Update progressively
      setMcResults({ ...results });
    }

    setMcResults(results);
    setMcRunning(false);
  }, [buildingType, densityOverride, mcTrials, getZoneFloors, zoneOverrides, computeExpressDistance, DEFAULT_FLOOR_HEIGHT]);

  // Compute displayed result — apply overrides + criteria to base result.
  // Re-evaluates pass/fail for every zone so criteria changes take effect
  // reactively without needing to re-run analysis.
  const result = useMemo<AnalysisResult | null>(() => {
    if (!baseResult) return null;

    const updatedZones = baseResult.zones.map((zone) => {
      const ov = zoneOverrides[zone.zoneIndex];
      const hasOv = ov && Object.values(ov).some((v) => v !== undefined);

      if (hasOv) {
        const zoneFloors = getZoneFloors(zone.zoneIndex);
        if (zoneFloors.length > 0) {
          return recalculateZone(zone, ov, buildingType, zoneFloors, DEFAULT_FLOOR_HEIGHT, criteriaOverrides, destinationDispatch);
        }
      }

      // No tune overrides — just re-evaluate pass/fail with current criteria
      const maxInt = criteriaOverrides.maxIntervalSec ?? zone.intervalSec + 1;
      const minHc = criteriaOverrides.minHcPercent ?? 0;
      const maxAwt = criteriaOverrides.maxAwtSec ?? zone.avgWaitTimeSec + 1;
      // HC% tolerance: pass if within 1% of target (e.g. 13% passes for 14% target)
      const hcThreshold = minHc > 0 ? minHc - 1.0 : 0;
      const meetsPerformanceCriteria =
        zone.intervalSec <= maxInt &&
        zone.handlingCapacityPercent >= hcThreshold &&
        zone.avgWaitTimeSec <= maxAwt;
      // Re-evaluate down-peak pass/fail too
      const downPeakMeetsCriteria =
        zone.downPeakIntervalSec <= maxInt &&
        zone.downPeakHcPercent >= hcThreshold &&
        zone.downPeakAwtSec <= maxAwt;
      return { ...zone, meetsPerformanceCriteria, downPeakMeetsCriteria };
    });

    // Recompute totals from potentially changed populations
    const totalPopulation = updatedZones.reduce((s, z) => s + z.totalPopulation, 0);

    return {
      ...baseResult,
      zones: updatedZones,
      totalPopulation,
    };
  }, [baseResult, zoneOverrides, buildingType, getZoneFloors, criteriaOverrides, destinationDispatch]);

  const handleFloorChange = useCallback(
    (index: number, field: keyof FloorInput, value: string | number) => {
      setFloors((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], [field]: value };
        return next;
      });
    },
    []
  );

  const addFloor = useCallback(() => {
    setFloors((prev) => [
      ...prev,
      {
        floorLabel: `Floor ${prev.length + 1}`,
        grossArea: prev[prev.length - 1]?.grossArea || 20000,
      },
    ]);
  }, []);

  const addMultipleFloors = useCallback((count: number) => {
    setFloors((prev) => {
      const baseArea = prev[prev.length - 1]?.grossArea || 20000;
      const newFloors: FloorInput[] = Array.from({ length: count }, (_, i) => ({
        floorLabel: `Floor ${prev.length + i + 1}`,
        grossArea: baseArea,
      }));
      return [...prev, ...newFloors];
    });
  }, []);

  const removeFloor = useCallback((index: number) => {
    setFloors((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const applyAreaToAll = useCallback(() => {
    if (floors.length === 0) return;
    const firstArea = floors[0].grossArea;
    setFloors((prev) =>
      prev.map((f) => ({ ...f, grossArea: firstArea }))
    );
    toast({ description: `Applied ${firstArea.toLocaleString()} SF to all floors.` });
  }, [floors, toast]);

  const handleExcelImport = useCallback(
    (data: { floors: FloorInput[]; projectName: string; avgFloorHeight: number }) => {
      setFloors(data.floors);
      setImportedFileName(data.projectName);
      setBaseResult(null);
      setZoneOverrides({});
    },
    []
  );

  const handleClearImport = useCallback(() => {
    setImportedFileName(null);
    setFloors([
      { floorLabel: "Floor 1", grossArea: 20000 },
      { floorLabel: "Floor 2", grossArea: 20000 },
      { floorLabel: "Floor 3", grossArea: 20000 },
      { floorLabel: "Floor 4", grossArea: 20000 },
      { floorLabel: "Floor 5", grossArea: 20000 },
    ]);
    setBaseResult(null);
    setZoneOverrides({});
  }, []);

  const runAnalysis = useCallback(() => {
    const validFloors = floors.filter((f) => f.grossArea > 0);
    if (validFloors.length === 0) {
      toast({ description: "Please add at least one floor with a gross area.", variant: "destructive" });
      return;
    }
    const density = densityOverride ? parseFloat(densityOverride) : undefined;
    const analysisResult = analyzeElevators(buildingType, validFloors, DEFAULT_FLOOR_HEIGHT, density, criteriaOverrides, destinationDispatch);
    setBaseResult(analysisResult);
    setZoneOverrides({});
    setMcResults({});

    // Run Monte Carlo if enabled
    if (monteCarloEnabled) {
      // Defer to next tick so deterministic results render first
      setTimeout(() => runMonteCarlo(analysisResult), 50);
    }
  }, [buildingType, floors, densityOverride, criteriaOverrides, destinationDispatch, toast, monteCarloEnabled, runMonteCarlo]);

  const handleOverrideChange = useCallback((zoneIndex: number, override: ZoneOverride) => {
    setZoneOverrides((prev) => ({ ...prev, [zoneIndex]: override }));
  }, []);

  const handleResetZone = useCallback((zoneIndex: number) => {
    setZoneOverrides((prev) => {
      const next = { ...prev };
      delete next[zoneIndex];
      return next;
    });
  }, []);

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-background text-foreground">
        {/* Header */}
        <header className="border-b border-border/40 bg-card/50 backdrop-blur-sm sticky top-0 z-50">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <Building2 className="h-4 w-4 text-primary" />
              </div>
              <div>
                <h1 className="text-sm font-semibold tracking-tight leading-none">
                  Elevator Traffic Analyzer
                </h1>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Vertical transportation analysis
                </p>
              </div>
            </div>
            {result && (
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => {
                    const crit = {
                      maxIntervalSec: parseFloat(criteriaInterval) || 33,
                      minHcPercent: parseFloat(criteriaHc) || 12,
                      maxAwtSec: parseFloat(criteriaAwt) || 30,
                    };
                    exportAnalysisPDF(result, crit, importedFileName || undefined, destinationDispatch);
                  }}
                  data-testid="button-export-pdf"
                >
                  <FileText className="h-3.5 w-3.5 mr-1.5" />
                  Export PDF
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => exportToCSV(result)}
                  data-testid="button-export-csv"
                >
                  <Download className="h-3.5 w-3.5 mr-1.5" />
                  CSV
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => {
                    snapshotCounter.current += 1;
                    const label = `Option ${String.fromCharCode(64 + Math.min(snapshotCounter.current, 26))}`;
                    setSavedSnapshots(prev => [...prev, {
                      id: Date.now(),
                      label,
                      result: JSON.parse(JSON.stringify(result)),
                      dd: destinationDispatch,
                      buildingType,
                      timestamp: Date.now(),
                    }]);
                    setShowComparison(true);
                    toast({ title: `Saved as ${label}`, description: "Scroll down to compare configurations" });
                  }}
                  data-testid="button-save-snapshot"
                >
                  <Copy className="h-3.5 w-3.5 mr-1.5" />
                  Save
                </Button>
                {savedSnapshots.length > 0 && (
                  <Button
                    variant={showComparison ? "default" : "outline"}
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => setShowComparison(!showComparison)}
                    data-testid="button-toggle-comparison"
                  >
                    <Layers className="h-3.5 w-3.5 mr-1.5" />
                    Compare{savedSnapshots.length > 0 ? ` (${savedSnapshots.length})` : ""}
                  </Button>
                )}
              </div>
            )}
          </div>
        </header>

        {/* Main Content */}
        <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6">
          {/* Input Section */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Building Config */}
            <Card className="p-5 border-border/40 lg:col-span-1" data-testid="config-card">
              <h2 className="text-sm font-semibold mb-4">Building Parameters</h2>
              <div className="space-y-4">
                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5 block">
                    Building Type
                  </Label>
                  <Select
                    value={buildingType}
                    onValueChange={(v) => setBuildingType(v as BuildingType)}
                  >
                    <SelectTrigger className="h-9 text-sm bg-background" data-testid="select-building-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {buildingTypes.map((t) => (
                        <SelectItem key={t} value={t}>
                          {buildingTypeLabels[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1">
                    Density Override
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="h-3 w-3 text-muted-foreground/50 cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-[220px] text-xs">
                        Leave empty to use default for building type. Office standard: 135 SF/person, Prestige: 175, Hotel: 250, Residential: 350
                      </TooltipContent>
                    </Tooltip>
                  </Label>
                  <div className="relative">
                    <Input
                      data-testid="input-density-override"
                      className="h-9 text-sm bg-background pr-16"
                      type="number"
                      placeholder="Auto"
                      value={densityOverride}
                      onChange={(e) => setDensityOverride(e.target.value)}
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                      SF/person
                    </span>
                  </div>
                </div>

                <Separator className="bg-border/30" />

                {/* Pass Criteria */}
                <div>
                  <Label className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
                    Pass Criteria
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="h-3 w-3 text-muted-foreground/50 cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-[220px] text-xs">
                        Thresholds for a zone to pass. Adjust before or after running analysis — badges update reactively.
                      </TooltipContent>
                    </Tooltip>
                  </Label>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <span className="text-[10px] text-muted-foreground/70 block mb-1">Interval ≤</span>
                      <div className="relative">
                        <Input
                          data-testid="input-criteria-interval"
                          className="h-8 text-xs bg-background pr-6"
                          type="number"
                          value={criteriaInterval}
                          onChange={(e) => setCriteriaInterval(e.target.value)}
                        />
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">s</span>
                      </div>
                    </div>
                    <div>
                      <span className="text-[10px] text-muted-foreground/70 block mb-1">HC% ≥</span>
                      <div className="relative">
                        <Input
                          data-testid="input-criteria-hc"
                          className="h-8 text-xs bg-background pr-6"
                          type="number"
                          step="0.1"
                          value={criteriaHc}
                          onChange={(e) => setCriteriaHc(e.target.value)}
                        />
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">%</span>
                      </div>
                    </div>
                    <div>
                      <span className="text-[10px] text-muted-foreground/70 block mb-1">AWT ≤</span>
                      <div className="relative">
                        <Input
                          data-testid="input-criteria-awt"
                          className="h-8 text-xs bg-background pr-6"
                          type="number"
                          value={criteriaAwt}
                          onChange={(e) => setCriteriaAwt(e.target.value)}
                        />
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">s</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Destination Dispatch Toggle */}
                <div className="flex items-center justify-between px-1">
                  <div className="flex items-center gap-1.5">
                    <Label htmlFor="dd-toggle" className="text-xs text-muted-foreground cursor-pointer select-none">
                      Destination Dispatch
                    </Label>
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3 w-3 text-muted-foreground/50" />
                        </TooltipTrigger>
                        <TooltipContent side="right" className="max-w-[220px] text-xs">
                          Applies a 22% round-trip time improvement to simulate destination dispatch systems
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <Switch
                    id="dd-toggle"
                    checked={destinationDispatch}
                    onCheckedChange={setDestinationDispatch}
                    data-testid="switch-destination-dispatch"
                  />
                </div>

                {/* Monte Carlo Toggle */}
                <div className="flex items-center justify-between px-1">
                  <div className="flex items-center gap-1.5">
                    <Label htmlFor="mc-toggle" className="text-xs text-muted-foreground cursor-pointer select-none">
                      Monte Carlo Simulation
                    </Label>
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3 w-3 text-muted-foreground/50" />
                        </TooltipTrigger>
                        <TooltipContent side="right" className="max-w-[240px] text-xs">
                          Runs N stochastic simulations of the 5-minute peak period using Poisson arrivals and destination dispatch. Reports confidence intervals and statistical distributions.
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <Switch
                    id="mc-toggle"
                    checked={monteCarloEnabled}
                    onCheckedChange={setMonteCarloEnabled}
                    data-testid="switch-monte-carlo"
                  />
                </div>
                {monteCarloEnabled && (
                  <div className="flex items-center gap-2 px-1">
                    <Label className="text-[11px] text-muted-foreground">Trials</Label>
                    <Select value={mcTrials} onValueChange={setMcTrials}>
                      <SelectTrigger className="h-7 w-24 text-xs bg-background" data-testid="select-mc-trials">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="500">500</SelectItem>
                        <SelectItem value="1000">1,000</SelectItem>
                        <SelectItem value="2000">2,000</SelectItem>
                        <SelectItem value="5000">5,000</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <Separator className="bg-border/30" />

                {/* Upload Zone */}
                <UploadZone
                  onFileLoaded={handleExcelImport}
                  importedFileName={importedFileName}
                  onClear={handleClearImport}
                />

                <Button
                  className="w-full h-10"
                  onClick={runAnalysis}
                  disabled={mcRunning}
                  data-testid="button-analyze"
                >
                  {mcRunning ? (
                    <>
                      <span className="inline-block h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin mr-2" />
                      Simulating…
                    </>
                  ) : (
                    <>
                      <Calculator className="h-4 w-4 mr-2" />
                      Run Analysis
                    </>
                  )}
                </Button>
              </div>
            </Card>

            {/* Floor Schedule */}
            <Card className="p-5 border-border/40 lg:col-span-2" data-testid="floors-card">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-sm font-semibold">Area Chart</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {isImported
                      ? "Imported from Excel \u2014 edit values below if needed"
                      : "Gross floor areas above lobby (above grade)"}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  {!isImported && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs px-2"
                      onClick={applyAreaToAll}
                      data-testid="button-apply-all"
                    >
                      Apply first to all
                    </Button>
                  )}
                  {isImported && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs px-2"
                      onClick={() => exportAreaChartExcel(floors, importedFileName || undefined)}
                      data-testid="button-export-excel"
                    >
                      <Download className="h-3 w-3 mr-1" />
                      Export .xlsx
                    </Button>
                  )}
                </div>
              </div>

              {/* Column headers */}
              <div className="flex items-center gap-2 mb-2 px-0">
                <div className="w-8 text-center text-[10px] text-muted-foreground uppercase tracking-wider shrink-0">
                  #
                </div>
                <div className={`shrink-0 text-[10px] text-muted-foreground uppercase tracking-wider ${isImported ? "w-24" : "w-28"}`}>
                  Floor Label
                </div>
                <div className={`text-[10px] text-muted-foreground uppercase tracking-wider shrink-0 ${isImported ? "w-[120px]" : "flex-1 min-w-0"}`}>
                  Gross Area
                </div>
                {isImported && (
                  <>
                    <div className="w-[72px] text-center text-[10px] text-muted-foreground uppercase tracking-wider shrink-0">
                      Ht
                    </div>
                    <div className="w-16 text-center text-[10px] text-muted-foreground uppercase tracking-wider shrink-0">
                      Zone
                    </div>
                    <div className="w-[68px] text-center text-[10px] text-muted-foreground uppercase tracking-wider shrink-0">
                      Density
                    </div>
                    <div className="w-[60px] text-center text-[10px] text-muted-foreground uppercase tracking-wider shrink-0">
                      Pop
                    </div>
                  </>
                )}
                <div className="w-9 shrink-0" />
              </div>

              {/* Floor rows */}
              <div className="space-y-1.5 max-h-[380px] overflow-y-auto pr-1">
                {floors.map((floor, i) => (
                  <FloorRow
                    key={i}
                    floor={floor}
                    index={i}
                    onChange={handleFloorChange}
                    onRemove={removeFloor}
                    canRemove={floors.length > 1}
                    isImported={isImported}
                  />
                ))}
              </div>

              {/* Add floor buttons */}
              <div className="flex items-center gap-2 mt-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={addFloor}
                  data-testid="button-add-floor"
                >
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Add Floor
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs text-muted-foreground"
                  onClick={() => addMultipleFloors(5)}
                  data-testid="button-add-5-floors"
                >
                  +5 Floors
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs text-muted-foreground"
                  onClick={() => addMultipleFloors(10)}
                  data-testid="button-add-10-floors"
                >
                  +10 Floors
                </Button>
              </div>
            </Card>
          </div>

          {/* Results Section */}
          {result && (
            <div className="space-y-4" data-testid="results-section">
              <SummaryCard result={result} />

              <div className="space-y-3">
                {result.zones.map((zone) => (
                  <ZoneCard
                    key={zone.zoneIndex}
                    zone={zone}
                    overrides={zoneOverrides[zone.zoneIndex] || {}}
                    onOverrideChange={handleOverrideChange}
                    onReset={handleResetZone}
                    hasOverrides={
                      !!zoneOverrides[zone.zoneIndex] &&
                      Object.values(zoneOverrides[zone.zoneIndex]).some((v) => v !== undefined)
                    }
                    mcResult={mcResults[zone.zoneIndex]}
                    mcRunning={mcRunning}
                  />
                ))}
              </div>

              {/* Comparison Table */}
              {showComparison && savedSnapshots.length > 0 && (
                <Card className="p-5 border-border/40" data-testid="comparison-panel">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <div className="h-7 w-7 rounded-md bg-primary/10 flex items-center justify-center">
                        <Layers className="h-3.5 w-3.5 text-primary" />
                      </div>
                      <h2 className="text-sm font-semibold">Configuration Comparison</h2>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-muted-foreground"
                      onClick={() => { setSavedSnapshots([]); setShowComparison(false); snapshotCounter.current = 0; }}
                      data-testid="button-clear-snapshots"
                    >
                      Clear All
                    </Button>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border/40">
                          <th className="text-left py-2 pr-3 text-muted-foreground font-medium">Zone</th>
                          {savedSnapshots.map(snap => (
                            <th key={snap.id} className="text-center py-2 px-2 font-medium min-w-[100px]">
                              <div className="flex items-center justify-center gap-1">
                                <span>{snap.label}</span>
                                <button
                                  className="text-muted-foreground/50 hover:text-red-400 ml-1"
                                  onClick={() => setSavedSnapshots(prev => prev.filter(s => s.id !== snap.id))}
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </div>
                              <div className="text-[10px] text-muted-foreground font-normal">
                                {snap.dd ? "DD" : "Conv."}
                              </div>
                            </th>
                          ))}
                          {result && (
                            <th className="text-center py-2 px-2 font-medium min-w-[100px] text-primary">
                              Current
                              <div className="text-[10px] text-muted-foreground font-normal">
                                {destinationDispatch ? "DD" : "Conv."}
                              </div>
                            </th>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {/* One section per zone — show key metrics */}
                        {(result?.zones || savedSnapshots[0]?.result.zones || []).map((_, zi) => {
                          const zoneName = result?.zones[zi]?.zoneName || savedSnapshots[0]?.result.zones[zi]?.zoneName || `Zone ${zi + 1}`;
                          return (
                            <>
                              {/* Zone header row */}
                              <tr key={`zh-${zi}`} className="border-b border-border/20">
                                <td colSpan={savedSnapshots.length + 2} className="pt-3 pb-1 font-semibold text-xs">
                                  {zoneName}
                                </td>
                              </tr>
                              {/* Metric rows */}
                              {[
                                { label: "Elevators", get: (z: ZoneOutput) => `${z.numElevators}` },
                                { label: "Capacity", get: (z: ZoneOutput) => `${z.capacityLbs.toLocaleString()} lbs` },
                                { label: "Speed", get: (z: ZoneOutput) => `${z.speedFpm} fpm` },
                                { label: "HC %", get: (z: ZoneOutput) => `${z.handlingCapacityPercent}%` },
                                { label: "AWT", get: (z: ZoneOutput) => `${z.avgWaitTimeSec}s` },
                                { label: "Interval", get: (z: ZoneOutput) => `${z.intervalSec}s` },
                                { label: "RTT", get: (z: ZoneOutput) => `${z.roundTripTimeSec}s` },
                                { label: "Core Area", get: (z: ZoneOutput) => `${z.approxCoreSqft} SF` },
                                { label: "Pit / OH", get: (z: ZoneOutput) => `${z.pitDepthFt}' / ${z.overheadClearanceFt}'` },
                                { label: "Pass", get: (z: ZoneOutput) => z.meetsPerformanceCriteria ? "\u2713" : "\u2717" },
                              ].map(metric => (
                                <tr key={`${zi}-${metric.label}`} className="border-b border-border/10">
                                  <td className="py-1.5 pr-3 text-muted-foreground">{metric.label}</td>
                                  {savedSnapshots.map(snap => {
                                    const z = snap.result.zones[zi];
                                    if (!z) return <td key={snap.id} className="text-center py-1.5 px-2 text-muted-foreground/30">—</td>;
                                    const val = metric.get(z);
                                    const isPass = metric.label === "Pass";
                                    return (
                                      <td key={snap.id} className={`text-center py-1.5 px-2 tabular-nums ${
                                        isPass ? (z.meetsPerformanceCriteria ? "text-emerald-500" : "text-red-400") : ""
                                      }`}>
                                        {val}
                                      </td>
                                    );
                                  })}
                                  {result && (() => {
                                    const z = result.zones[zi];
                                    if (!z) return <td className="text-center py-1.5 px-2 text-muted-foreground/30">—</td>;
                                    const val = metric.get(z);
                                    const isPass = metric.label === "Pass";
                                    return (
                                      <td className={`text-center py-1.5 px-2 tabular-nums font-medium text-primary ${
                                        isPass ? (z.meetsPerformanceCriteria ? "text-emerald-500" : "text-red-400") : ""
                                      }`}>
                                        {val}
                                      </td>
                                    );
                                  })()}
                                </tr>
                              ))}
                            </>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}

              {/* Methodology Note */}
              <Card className="p-4 border-border/40 bg-muted/20">
                <div className="flex gap-2">
                  <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                  <div className="text-xs text-muted-foreground leading-relaxed">
                    <p className="font-medium text-foreground/70 mb-1">Methodology</p>
                    <p>
                      Calculations use the classical Round Trip Time (RTT) method per CIBSE Guide D
                      and ISO 8100-32 standards. Population density, peak arrival rates, and
                      performance criteria follow industry benchmarks. Zoning splits per Al-Sharif
                      et al. Speed selection uses zone top elevation with a 28-second travel-time rule.
                      For final design, always verify with an elevator consultant simulation.
                    </p>
                  </div>
                </div>
              </Card>
            </div>
          )}
        </main>

        {/* Footer */}
        <footer className="border-t border-border/40 py-4 mt-8">
          <div className="max-w-5xl mx-auto px-4 sm:px-6">
            <PerplexityAttribution />
          </div>
        </footer>
      </div>
    </TooltipProvider>
  );
}
