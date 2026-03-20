/**
 * Excel Area Chart Parser
 * 
 * Reads an architect's area chart Excel file and extracts floor data.
 * Expects columns for: FLOOR LEVEL, Flr/Flr (ft), Elev, GROSS FLOOR AREA (SF), ZONE
 * 
 * Layout detection:
 * - Scans for a header row containing "FLOOR" and "GROSS" or "AREA" keywords
 * - Reads data rows below the header until empty rows are found
 * - Handles merged cells and flexible column positioning
 */

import * as XLSX from "xlsx";
import type { FloorInput } from "@shared/schema";

interface ParsedExcelData {
  floors: FloorInput[];
  projectName: string;
  avgFloorHeight: number;
}

// Column identifiers (what to search for in headers)
const HEADER_PATTERNS = {
  floorLevel: /floor\s*level|floor|level/i,
  floorHeight: /fl(?:r|oor)\s*\/\s*fl(?:r|oor)|floor.*height|f\/?f/i,
  elevation: /elev(?:ation)?/i,
  grossArea: /gross\s*(?:floor\s*)?area|gfa|area\s*\(?sf\)?/i,
  zone: /zone/i,
  density: /density|sf\s*\/\s*per|sq\s*ft.*per.*person|occupant.*density/i,
  population: /pop(?:ulation)?|total\s*pop|keys|units|occupants|persons|people/i,
};

interface ColumnMap {
  floorLevel: number;
  floorHeight: number;
  elevation: number;
  grossArea: number;
  zone: number;
  density: number;
  population: number;
}

function findHeaderRow(sheet: XLSX.WorkSheet): { headerRow: number; columns: ColumnMap } | null {
  const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");

  for (let r = range.s.r; r <= Math.min(range.e.r, 30); r++) {
    const colMap: Partial<ColumnMap> = {};
    let matchCount = 0;

    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[addr];
      if (!cell || !cell.v) continue;
      const val = String(cell.v).trim();

      if (HEADER_PATTERNS.floorLevel.test(val) && colMap.floorLevel === undefined) {
        colMap.floorLevel = c;
        matchCount++;
      } else if (HEADER_PATTERNS.grossArea.test(val) && colMap.grossArea === undefined) {
        colMap.grossArea = c;
        matchCount++;
      } else if (HEADER_PATTERNS.floorHeight.test(val) && colMap.floorHeight === undefined) {
        colMap.floorHeight = c;
        matchCount++;
      } else if (HEADER_PATTERNS.elevation.test(val) && colMap.elevation === undefined) {
        colMap.elevation = c;
        matchCount++;
      } else if (HEADER_PATTERNS.zone.test(val) && colMap.zone === undefined) {
        colMap.zone = c;
        matchCount++;
      } else if (HEADER_PATTERNS.density.test(val) && colMap.density === undefined) {
        colMap.density = c;
        matchCount++;
      } else if (HEADER_PATTERNS.population.test(val) && colMap.population === undefined) {
        colMap.population = c;
        matchCount++;
      }
    }

    // We need at minimum floor level and gross area
    if (matchCount >= 2 && colMap.floorLevel !== undefined && colMap.grossArea !== undefined) {
      return {
        headerRow: r,
        columns: {
          floorLevel: colMap.floorLevel,
          floorHeight: colMap.floorHeight ?? -1,
          elevation: colMap.elevation ?? -1,
          grossArea: colMap.grossArea,
          zone: colMap.zone ?? -1,
          density: colMap.density ?? -1,
          population: colMap.population ?? -1,
        },
      };
    }
  }

  return null;
}

function getCellValue(sheet: XLSX.WorkSheet, r: number, c: number): string | number | null {
  if (c < 0) return null;
  const addr = XLSX.utils.encode_cell({ r, c });
  const cell = sheet[addr];
  if (!cell) return null;
  return cell.v !== undefined ? cell.v : null;
}

export function parseExcelFile(data: ArrayBuffer): ParsedExcelData {
  const wb = XLSX.read(data, { type: "array" });

  // Use the first sheet (or look for one named "CURRENT", common in architecture files)
  // If multiple sheets match (e.g. "CURRENT", "CURRENT (2)"), prefer the one
  // with the highest version number — architects append " (2)", " (3)" etc.
  const currentSheets = wb.SheetNames.filter((n) => /current/i.test(n));
  let sheetName: string;
  if (currentSheets.length > 1) {
    // Sort by version number descending — "CURRENT (2)" > "CURRENT"
    currentSheets.sort((a, b) => {
      const numA = (a.match(/\((\d+)\)/) || [, "0"])[1];
      const numB = (b.match(/\((\d+)\)/) || [, "0"])[1];
      return parseInt(numB as string) - parseInt(numA as string);
    });
    sheetName = currentSheets[0];
  } else {
    sheetName = currentSheets[0] || wb.SheetNames[0];
  }
  const sheet = wb.Sheets[sheetName];

  if (!sheet) {
    throw new Error("No worksheet found in the Excel file.");
  }

  // Try to extract project name from early rows
  let projectName = sheetName;
  const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
  for (let r = 0; r <= Math.min(5, range.e.r); r++) {
    for (let c = 0; c <= Math.min(10, range.e.c); c++) {
      const v = getCellValue(sheet, r, c);
      if (v && typeof v === "string" && v.length > 5 && /\d/.test(v)) {
        projectName = v.trim();
        break;
      }
    }
  }

  // Find the header row
  const headerInfo = findHeaderRow(sheet);
  if (!headerInfo) {
    throw new Error(
      "Could not find the header row. Make sure your file has columns for FLOOR LEVEL and GROSS FLOOR AREA."
    );
  }

  const { headerRow, columns } = headerInfo;

  // Read data rows below the header
  // Architecture spreadsheets often have sub-headers, merged cells, or blank rows
  // between the header and data (sometimes 6+ rows gap)
  const floors: FloorInput[] = [];
  let consecutiveEmpty = 0;
  let foundAnyData = false;

  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const floorVal = getCellValue(sheet, r, columns.floorLevel);
    const areaVal = getCellValue(sheet, r, columns.grossArea);

    // Skip empty rows — but only stop after we've found data AND hit a long gap
    if (floorVal === null && areaVal === null) {
      consecutiveEmpty++;
      // Before any data is found, tolerate up to 15 blank/sub-header rows
      // After data is found, stop after 5 consecutive empty rows
      if (foundAnyData && consecutiveEmpty >= 5) break;
      if (!foundAnyData && consecutiveEmpty >= 15) break;
      continue;
    }
    consecutiveEmpty = 0;

    // Skip rows without a valid floor number or area
    const floorNum = typeof floorVal === "number" ? floorVal : parseFloat(String(floorVal || ""));
    const area = typeof areaVal === "number" ? areaVal : parseFloat(String(areaVal || "").replace(/,/g, ""));

    if (isNaN(floorNum) || isNaN(area) || area <= 0) continue;
    foundAnyData = true;

    const heightVal = getCellValue(sheet, r, columns.floorHeight);
    const elevVal = getCellValue(sheet, r, columns.elevation);
    const zoneVal = getCellValue(sheet, r, columns.zone);
    const densityVal = getCellValue(sheet, r, columns.density);
    const popVal = getCellValue(sheet, r, columns.population);

    const height = heightVal !== null ? (typeof heightVal === "number" ? heightVal : parseFloat(String(heightVal))) : undefined;
    const elev = elevVal !== null ? (typeof elevVal === "number" ? elevVal : parseFloat(String(elevVal))) : undefined;
    const zone = zoneVal !== null ? String(zoneVal).trim() : undefined;
    const dens = densityVal !== null ? (typeof densityVal === "number" ? densityVal : parseFloat(String(densityVal))) : undefined;
    const pop = popVal !== null ? (typeof popVal === "number" ? popVal : parseFloat(String(popVal))) : undefined;

    floors.push({
      floorLabel: `Floor ${floorNum}`,
      grossArea: area,
      floorToFloorHeight: height && !isNaN(height) ? height : undefined,
      elevation: elev && !isNaN(elev) ? elev : undefined,
      zone: zone || undefined,
      densitySqftPerPerson: dens && !isNaN(dens) && dens > 0 ? dens : undefined,
      totalPopulation: pop && !isNaN(pop) && pop > 0 ? Math.round(pop) : undefined,
    });
  }

  if (floors.length === 0) {
    throw new Error("No floor data found below the header row. Check that the file has numeric floor levels and areas.");
  }

  // Sort floors by floor number (ascending — lowest floor first)
  floors.sort((a, b) => {
    const numA = parseInt(a.floorLabel.replace(/\D/g, "")) || 0;
    const numB = parseInt(b.floorLabel.replace(/\D/g, "")) || 0;
    return numA - numB;
  });

  // Calculate average floor height
  const heights = floors.filter((f) => f.floorToFloorHeight).map((f) => f.floorToFloorHeight!);
  const avgFloorHeight = heights.length > 0 ? heights.reduce((s, h) => s + h, 0) / heights.length : 13;

  return {
    floors,
    projectName,
    avgFloorHeight: Math.round(avgFloorHeight * 10) / 10,
  };
}
