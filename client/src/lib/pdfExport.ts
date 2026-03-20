/**
 * PDF Export — Single-page landscape report of elevator traffic analysis.
 * Light mode, professional layout using jsPDF + jspdf-autotable.
 */
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { AnalysisResult, ZoneOutput } from "@shared/schema";
import { buildingTypeLabels } from "@shared/schema";

// ═══════════════════════════════════════════════
// LIGHT PALETTE
// ═══════════════════════════════════════════════
const C = {
  bg:        [247, 246, 242] as [number, number, number],   // #F7F6F2
  surface:   [255, 255, 255] as [number, number, number],
  surfaceAlt:[243, 243, 240] as [number, number, number],   // subtle row stripe
  border:    [212, 209, 202] as [number, number, number],   // #D4D1CA
  text:      [40, 37, 29]   as [number, number, number],    // #28251D
  textMuted: [122, 121, 116] as [number, number, number],   // #7A7974
  teal:      [1, 105, 111]  as [number, number, number],    // #01696F
  tealBg:    [230, 245, 246] as [number, number, number],   // teal tint
  red:       [161, 44, 68]  as [number, number, number],    // #A12C44
  redBg:     [252, 237, 240] as [number, number, number],
  green:     [67, 122, 34]  as [number, number, number],    // #437A22
  headerBg:  [1, 105, 111]  as [number, number, number],    // teal header
  headerText:[255, 255, 255] as [number, number, number],
};

interface CriteriaValues {
  maxIntervalSec: number;
  minHcPercent: number;
  maxAwtSec: number;
}

export function exportAnalysisPDF(
  result: AnalysisResult,
  criteria: CriteriaValues,
  projectName?: string,
  destinationDispatch?: boolean
) {
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const mx = 32; // margin x
  const mt = 28; // margin top
  const contentW = pageW - mx * 2;

  doc.setProperties({
    title: `Elevator Traffic Analysis${projectName ? ` — ${projectName}` : ""}`,
    author: "Perplexity Computer",
  });

  // ─── Background ───
  doc.setFillColor(...C.bg);
  doc.rect(0, 0, pageW, pageH, "F");

  let y = mt;

  // ─── Title row ───
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.setTextColor(...C.text);
  doc.text("Elevator Traffic Analysis", mx, y + 12);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...C.textMuted);
  const dateStr = new Date().toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });
  doc.text(dateStr, pageW - mx, y + 12, { align: "right" });

  y += 20;
  doc.setDrawColor(...C.teal);
  doc.setLineWidth(1.2);
  doc.line(mx, y, pageW - mx, y);
  y += 10;

  // ─── Summary row (compact) ───
  const buildingLabel = buildingTypeLabels[result.buildingType] || result.buildingType;
  const totalElevs = result.zones.reduce((s, z) => s + z.numElevators, 0);
  const summaryPairs = [
    ["Building Type", buildingLabel],
    ["Total Floors", result.totalFloors.toString()],
    ["Total Area", `${result.totalGrossArea.toLocaleString()} SF`],
    ["Population", result.totalPopulation.toLocaleString()],
    ["Total Elevators", totalElevs.toString()],
    ["Zones", result.numZones.toString()],
  ];

  const summaryColW = contentW / summaryPairs.length;
  doc.setFillColor(...C.surface);
  doc.roundedRect(mx, y, contentW, 36, 3, 3, "F");
  doc.setDrawColor(...C.border);
  doc.setLineWidth(0.4);
  doc.roundedRect(mx, y, contentW, 36, 3, 3, "S");

  summaryPairs.forEach(([label, value], i) => {
    const cx = mx + summaryColW * i + summaryColW / 2;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6);
    doc.setTextColor(...C.textMuted);
    doc.text(label.toUpperCase(), cx, y + 12, { align: "center" });
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(...C.text);
    doc.text(value, cx, y + 27, { align: "center" });
  });
  y += 42;

  // ─── Criteria bar ───
  doc.setFillColor(...C.surfaceAlt);
  doc.roundedRect(mx, y, contentW, 16, 2, 2, "F");
  doc.setFont("helvetica", "normal");
  doc.setFontSize(6.5);
  doc.setTextColor(...C.textMuted);
  // Show traffic pattern for mixed-traffic building types in the criteria bar
  const mixedTypes: Record<string, string> = {
    hotel: '   |   Traffic: Mixed (50% In / 50% Out)   |   Occupancy: 100%',
    residential: '   |   Traffic: Mixed (50% In / 50% Out)   |   Occupancy: 90%',
  };
  const trafficLabel = mixedTypes[result.buildingType] ?? '';
  const ddLabel = destinationDispatch ? '   |   Destination Dispatch: ON' : '';
  const criteriaStr = `Pass Criteria:   Interval <= ${criteria.maxIntervalSec}s   |   HC% >= ${criteria.minHcPercent}%   |   AWT <= ${criteria.maxAwtSec}s${trafficLabel}${ddLabel}`;
  doc.text(criteriaStr, mx + 8, y + 10.5);
  y += 22;

  // ─── Zone sections ───
  result.zones.forEach((zone, idx) => {
    y = drawZoneCompact(doc, zone, y, mx, contentW, criteria);
    y += 10;
  });

  // ─── Footer ───
  doc.setFont("helvetica", "normal");
  doc.setFontSize(6);
  doc.setTextColor(...C.textMuted);
  doc.text("Created with Perplexity Computer", mx, pageH - 14);
  doc.text(
    "Calculations per CIBSE Guide D / ISO 8100-32. For final design, verify with an elevator consultant simulation.",
    pageW / 2, pageH - 14, { align: "center" }
  );
  doc.text("Page 1 of 1", pageW - mx, pageH - 14, { align: "right" });

  doc.save(`Elevator_Analysis_${dateStr.replace(/,?\s+/g, "_")}.pdf`);
}

function drawZoneCompact(
  doc: jsPDF,
  zone: ZoneOutput,
  startY: number,
  mx: number,
  contentW: number,
  criteria: CriteriaValues
): number {
  const passes = zone.meetsPerformanceCriteria;
  let y = startY;

  // ─── Zone header bar ───
  const headerH = 20;
  doc.setFillColor(...C.surface);
  doc.roundedRect(mx, y, contentW, headerH, 3, 3, "F");
  doc.setDrawColor(...C.border);
  doc.setLineWidth(0.3);
  doc.roundedRect(mx, y, contentW, headerH, 3, 3, "S");

  // Left accent
  doc.setFillColor(...(passes ? C.teal : C.red));
  doc.rect(mx, y + 1, 3, headerH - 2, "F");

  // Zone name
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...C.text);
  doc.text(zone.zoneName, mx + 10, y + 8.5);

  // Floor info
  doc.setFont("helvetica", "normal");
  doc.setFontSize(6.5);
  doc.setTextColor(...C.textMuted);
  doc.text(`Floors ${zone.floorsServed}  ·  ${zone.floorCount} floors`, mx + 10, y + 16);

  // Badge — Meets Criteria is large & bold green; Below Criteria stays subtle
  if (passes) {
    const badgeText = "  MEETS CRITERIA  ";
    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    const badgeW = doc.getTextWidth(badgeText) + 14;
    const badgeX = mx + contentW - badgeW - 6;
    const badgeY = y + 3;
    doc.setFillColor(34, 120, 60);     // bold green fill
    doc.roundedRect(badgeX, badgeY, badgeW, 15, 7.5, 7.5, "F");
    doc.setTextColor(255, 255, 255);    // white text on green
    doc.text(badgeText, badgeX + badgeW / 2, badgeY + 10.5, { align: "center" });
  } else {
    const badgeText = " Below Criteria ";
    doc.setFontSize(6.5);
    doc.setFont("helvetica", "bold");
    const badgeW = doc.getTextWidth(badgeText) + 10;
    const badgeX = mx + contentW - badgeW - 6;
    const badgeY = y + 5;
    doc.setFillColor(...C.redBg);
    doc.roundedRect(badgeX, badgeY, badgeW, 12, 6, 6, "F");
    doc.setTextColor(...C.red);
    doc.text(badgeText, badgeX + badgeW / 2, badgeY + 8.5, { align: "center" });
  }

  y += headerH + 3;

  // ─── Combined metrics + details in one table ───
  // Two-row layout: header labels + values, then detail rows below
  const leftColData = [
    ["Elevators", zone.numElevators.toString()],
    ["Capacity", `${zone.capacityPersons}P / ${zone.capacityLbs.toLocaleString()} lbs`],
    ["Speed", `${zone.speedFpm} fpm`],
    ["Density", `${zone.densitySqftPerPerson} SF/person`],
  ];

  const rightColData = [
    ["Interval", `${zone.intervalSec} sec`],
    ["HC%", `${zone.handlingCapacityPercent}%`],
    ["Avg Wait", `${zone.avgWaitTimeSec} sec`],
    ["RTT", `${zone.roundTripTimeSec} sec`],
  ];

  const populationRow = `Zone Population: ${zone.totalPopulation.toLocaleString()} persons`;

  // Draw as a single compact table with 4 columns (label, value, label, value)
  const tableData = leftColData.map((left, i) => {
    const right = rightColData[i];
    return [left[0], left[1], right[0], right[1]];
  });

  autoTable(doc, {
    startY: y,
    margin: { left: mx, right: mx },
    body: tableData,
    theme: "plain",
    tableWidth: contentW,
    styles: {
      fontSize: 7,
      cellPadding: { top: 2.5, bottom: 2.5, left: 8, right: 8 },
      font: "helvetica",
      textColor: C.text,
      fillColor: C.surface,
      lineColor: C.border,
      lineWidth: 0.15,
    },
    columnStyles: {
      0: { textColor: C.textMuted, cellWidth: contentW * 0.12, fontStyle: "normal" },
      1: { fontStyle: "bold", cellWidth: contentW * 0.38 },
      2: { textColor: C.textMuted, cellWidth: contentW * 0.12, fontStyle: "normal" },
      3: { fontStyle: "bold", cellWidth: contentW * 0.38 },
    },
    alternateRowStyles: {
      fillColor: C.surfaceAlt,
    },
    tableLineColor: C.border,
    tableLineWidth: 0.15,
  });

  // Population line below table
  const tableEndY = (doc as any).lastAutoTable.finalY;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(6);
  doc.setTextColor(...C.textMuted);
  doc.text(populationRow, mx + 6, tableEndY + 8);
  return tableEndY + 12;
}
