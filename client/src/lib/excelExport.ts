/**
 * Excel Export — Exports the Area Chart floor data back to .xlsx
 */
import * as XLSX from "xlsx";
import type { FloorInput } from "@shared/schema";

export function exportAreaChartExcel(
  floors: FloorInput[],
  projectName?: string
) {
  // Build header row
  const hasHeight = floors.some((f) => f.floorToFloorHeight);
  const hasZone = floors.some((f) => f.zone);
  const hasDensity = floors.some((f) => f.densitySqftPerPerson);
  const hasPop = floors.some((f) => f.totalPopulation);

  const headers: string[] = ["Floor", "Gross Area (SF)"];
  if (hasHeight) headers.push("Floor-to-Floor Height (ft)");
  if (hasZone) headers.push("Zone");
  if (hasDensity) headers.push("Density (SF/Person)");
  if (hasPop) headers.push("Population");

  // Build data rows
  const rows = floors.map((f) => {
    const row: (string | number)[] = [f.floorLabel, f.grossArea];
    if (hasHeight) row.push(f.floorToFloorHeight ?? "");
    if (hasZone) row.push(f.zone ?? "");
    if (hasDensity) row.push(f.densitySqftPerPerson ?? "");
    if (hasPop) row.push(f.totalPopulation ?? "");
    return row;
  });

  const wsData = [headers, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // Set column widths
  const colWidths = [
    { wch: 14 }, // Floor
    { wch: 16 }, // Gross Area
  ];
  if (hasHeight) colWidths.push({ wch: 24 });
  if (hasZone) colWidths.push({ wch: 10 });
  if (hasDensity) colWidths.push({ wch: 20 });
  if (hasPop) colWidths.push({ wch: 14 });
  ws["!cols"] = colWidths;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Area Chart");

  const fileName = projectName
    ? `${projectName.replace(/[^a-zA-Z0-9_-]/g, "_")}_Area_Chart.xlsx`
    : `Area_Chart_Export_${new Date().toISOString().slice(0, 10)}.xlsx`;

  XLSX.writeFile(wb, fileName);
}
