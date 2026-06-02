import { jsPDF, GState } from 'jspdf';
import { SQUIRREL_GROUPS } from './groups_data';
import { latLonToEastingNorthing, eastingNorthingToLatLon, get100kmSquareLetters, getContourColor } from './osGridUtils';

// Helper for segment distance to compute distance to boundary in meters
function getDistanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) {
    return Math.hypot(px - ax, py - ay);
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Distance from an Easting/Northing coordinate in meters to polygon boundary
function getDistanceToPolygon(px: number, py: number, polyEN: { Easting: number; Northing: number }[]) {
  let minDistance = Infinity;
  for (let i = 0; i < polyEN.length; i++) {
    const j = (i + 1) % polyEN.length;
    const dist = getDistanceToSegment(px, py, polyEN[i].Easting, polyEN[i].Northing, polyEN[j].Easting, polyEN[j].Northing);
    if (dist < minDistance) {
      minDistance = dist;
    }
  }
  return minDistance;
}

export function isPointInPolygon(lat: number, lon: number, polygon: [number, number][]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersect = ((yi > lon) !== (yj > lon)) && (lat < (xj - xi) * (lon - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function isSquarePartiallyInPolygon(lat: number, lon: number, polygon: [number, number][]) {
  if (isPointInPolygon(lat, lon, polygon)) {
    return true;
  }
  try {
    const { Easting, Northing } = latLonToEastingNorthing(lat, lon);
    const E_sw = Math.floor(Easting / 5000) * 5000;
    const N_sw = Math.floor(Northing / 5000) * 5000;
    
    const corners = [
      eastingNorthingToLatLon(E_sw, N_sw),
      eastingNorthingToLatLon(E_sw + 5000, N_sw),
      eastingNorthingToLatLon(E_sw + 5000, N_sw + 5000),
      eastingNorthingToLatLon(E_sw, N_sw + 5000),
      eastingNorthingToLatLon(E_sw + 2500, N_sw + 2500)
    ];
    
    for (const corner of corners) {
      if (isPointInPolygon(corner.lat, corner.lon, polygon)) {
        return true;
      }
    }
  } catch (err) {}
  return false;
}

// Helper to fetch and stitch coordinate-accurate background map tiles from CartoDB Light with high resolution
async function fetchAndStitchOSM(
  minLat: number,
  maxLat: number,
  minLon: number,
  maxLon: number,
  zoomOption?: number
): Promise<string | null> {
  try {
    // Determine perfect OSM zoom level dynamically based on longitude delta
    const dLon = Math.abs(maxLon - minLon);
    let zoom = zoomOption;
    if (zoom === undefined) {
      zoom = 13; // Higher baseline zoom for beautiful crisp detail
      if (dLon > 1.2) zoom = 10;
      else if (dLon > 0.6) zoom = 11;
      else if (dLon > 0.25) zoom = 12;
    }

    const n = Math.pow(2, zoom);

    const x1 = (minLon + 180) / 360 * n;
    const x2 = (maxLon + 180) / 360 * n;
    
    const latRadMax = Math.max(-85, Math.min(85, maxLat)) * Math.PI / 180;
    const latRadMin = Math.max(-85, Math.min(85, minLat)) * Math.PI / 180;
    
    const y1 = (1 - Math.log(Math.tan(latRadMax) + 1 / Math.cos(latRadMax)) / Math.PI) / 2 * n;
    const y2 = (1 - Math.log(Math.tan(latRadMin) + 1 / Math.cos(latRadMin)) / Math.PI) / 2 * n;

    const tileXMin = Math.floor(Math.min(x1, x2));
    const tileXMax = Math.floor(Math.max(x1, x2));
    const tileYMin = Math.floor(Math.min(y1, y2));
    const tileYMax = Math.floor(Math.max(y1, y2));

    const cols = tileXMax - tileXMin + 1;
    const rows = tileYMax - tileYMin + 1;

    // Safety fallback: if there are too many tiles, zoom out to save memory and tile download time
    if (cols > 10 || rows > 10) {
      if (zoom > 8) {
        return fetchAndStitchOSM(minLat, maxLat, minLon, maxLon, zoom - 1);
      }
    }

    const canvas = document.createElement('canvas');
    const tileSize = 256;
    canvas.width = cols * tileSize;
    canvas.height = rows * tileSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const subdomains = ["a", "b", "c", "d"];
    const tilePromises: Promise<void>[] = [];

    for (let tx = tileXMin; tx <= tileXMax; tx++) {
      for (let ty = tileYMin; ty <= tileYMax; ty++) {
        const col = tx - tileXMin;
        const row = ty - tileYMin;
        const sub = subdomains[Math.abs(tx + ty) % subdomains.length];
        const url = `https://${sub}.basemaps.cartocdn.com/light_all/${zoom}/${tx}/${ty}.png`;

        tilePromises.push(
          new Promise<void>((resolve) => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => {
              ctx.drawImage(img, col * tileSize, row * tileSize, tileSize, tileSize);
              resolve();
            };
            img.onerror = () => {
              // Neutral soft gray background color fallback
              ctx.fillStyle = "#f5f5f4";
              ctx.fillRect(col * tileSize, row * tileSize, tileSize, tileSize);
              resolve();
            };
            img.src = url;
          })
        );
      }
    }

    await Promise.all(tilePromises);

    const stitchXMin = tileXMin;
    const stitchYMin = tileYMin;

    const boundsXMin = Math.min(x1, x2);
    const boundsXMax = Math.max(x1, x2);
    const boundsYMin = Math.min(y1, y2);
    const boundsYMax = Math.max(y1, y2);

    const cropLeft = ((boundsXMin - stitchXMin) / cols) * canvas.width;
    const cropRight = ((boundsXMax - stitchXMin) / cols) * canvas.width;
    const cropTop = ((boundsYMin - stitchYMin) / rows) * canvas.height;
    const cropBottom = ((boundsYMax - stitchYMin) / rows) * canvas.height;

    const cropW = cropRight - cropLeft;
    const cropH = cropBottom - cropTop;
    if (cropW <= 0 || cropH <= 0) return null;

    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = 1800; // 3x resolution bump for gorgeous 300-DPI high definition prints
    finalCanvas.height = Math.round(1800 * (cropH / cropW));
    const finalCtx = finalCanvas.getContext('2d');
    if (finalCtx) {
      finalCtx.drawImage(
        canvas,
        cropLeft, cropTop, cropW, cropH,
        0, 0, finalCanvas.width, finalCanvas.height
      );
      return finalCanvas.toDataURL("image/jpeg", 0.95); // High quality Jpeg export
    }
  } catch (err) {
    console.error('[GIS PDF Mapper] CartoDB slate tile stitch failed:', err);
  }
  return null;
}

// Generates PDF report for a single recovery area and returns it as a jsPDF document
export async function generateSingleAreaReport(
  groupName: string,
  startYear: number,
  endYear: number,
  allSightings: any[]
): Promise<jsPDF> {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4'
  });

  const group = SQUIRREL_GROUPS.find(g => g.name === groupName);
  if (!group || !group.polygon || group.polygon.length === 0) {
    // Return empty page with error if group not found
    doc.setFont("Helvetica", "bold");
    doc.setFontSize(16);
    doc.text(`Error: Recovery network area "${groupName}" not found`, 15, 50);
    return doc;
  }

  const polyEN = group.polygon.map(([lat, lon]) => latLonToEastingNorthing(lat, lon));
  const polyMinE = Math.min(...polyEN.map(p => p.Easting));
  const polyMaxE = Math.max(...polyEN.map(p => p.Easting));
  const polyMinN = Math.min(...polyEN.map(p => p.Northing));
  const polyMaxN = Math.max(...polyEN.map(p => p.Northing));

  // --- HELPER TO SPECIFY CARTOGRAPHIC SCALING & GEOGRAPHIC PROJECTION ---
  const mapWidth = 180;
  const mapHeight = 160;
  const mapLeft = 15;
  const mapTop = 52;

  function getCoordinateMapper(minE: number, maxE: number, minN: number, maxN: number) {
    const pad = Math.max(2000, (maxE - minE) * 0.05); // slightly pad mapping bounds
    const boxMinE = minE - pad;
    const boxMaxE = maxE + pad;
    const boxMinN = minN - pad;
    const boxMaxN = maxN + pad;

    const geoW = boxMaxE - boxMinE;
    const geoH = boxMaxN - boxMinN;

    const arGeo = geoW / geoH;
    const arFrame = mapWidth / mapHeight;

    let fittedWidth = mapWidth;
    let fittedHeight = mapHeight;

    if (arGeo > arFrame) {
      fittedHeight = mapWidth / arGeo;
    } else {
      fittedWidth = mapHeight * arGeo;
    }

    const scaleX = fittedWidth / geoW;
    const scaleY = fittedHeight / geoH;

    const offsetX = mapLeft + (mapWidth - fittedWidth) / 2;
    const offsetY = mapTop + (mapHeight - fittedHeight) / 2;

    return {
      toPage: (easting: number, northing: number) => {
        const x = offsetX + (easting - boxMinE) * scaleX;
        const y = offsetY + fittedHeight - (northing - boxMinN) * scaleY; // Flip y-axis
        return { x, y };
      },
      scale: scaleX,
      boxMinE,
      boxMaxE,
      boxMinN,
      boxMaxN,
      offsetX,
      offsetY,
      fittedWidth,
      fittedHeight
    };
  }

  const page1Mapper = getCoordinateMapper(polyMinE, polyMaxE, polyMinN, polyMaxN);
  const pad20km = 20000;
  const page3Mapper = getCoordinateMapper(
    polyMinE - pad20km,
    polyMaxE + pad20km,
    polyMinN - pad20km,
    polyMaxN + pad20km
  );

  // Convert OS grid bounds to Lat/Lon for OSM tile pre-fetching
  const sw1_geo = eastingNorthingToLatLon(page1Mapper.boxMinE, page1Mapper.boxMinN);
  const ne1_geo = eastingNorthingToLatLon(page1Mapper.boxMaxE, page1Mapper.boxMaxN);
  
  const sw3_geo = eastingNorthingToLatLon(page3Mapper.boxMinE, page3Mapper.boxMinN);
  const ne3_geo = eastingNorthingToLatLon(page3Mapper.boxMaxE, page3Mapper.boxMaxN);

  const [bgImage1, bgImage3] = await Promise.all([
    fetchAndStitchOSM(sw1_geo.lat, ne1_geo.lat, sw1_geo.lon, ne1_geo.lon),
    fetchAndStitchOSM(sw3_geo.lat, ne3_geo.lat, sw3_geo.lon, ne3_geo.lon)
  ]);

  // Common Header Drawer
  function drawHeader(pageTitle: string, subtitle: string) {
    // Top border accent
    doc.setFillColor(28, 25, 23); // dark stone charcoal
    doc.rect(0, 0, 210, 4, 'F');

    // Title Block
    doc.setFont("Helvetica", "bold");
    doc.setFontSize(14);
    doc.setTextColor(28, 25, 23);
    doc.text("CENTRAL BORDERS RED SQUIRREL NETWORK", 15, 14);

    doc.setFont("Helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(115, 115, 115);
    doc.text(`Scientific Area Survey | Time Period: ${startYear} - ${endYear}`, 15, 19);

    // Page Subject Block
    doc.setFont("Helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(30, 41, 59);
    doc.text(`${pageTitle}`, 15, 30);

    doc.setFont("Helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(71, 85, 105);
    doc.text(`RECOVERY AREA: ${groupName.toUpperCase()}`, 15, 34.5);

    // Divider Line
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.3);
    doc.line(15, 38, 195, 38);
  }

  // Footer Drawer
  function drawFooter(pageNo: number) {
    const nowStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    doc.setFont("Helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(148, 163, 184);
    doc.text(`Central Borders Red Squirrel Network Mapping Tool | Generated: ${nowStr}`, 15, 285);
    doc.text(`Page ${pageNo} of 5`, 195, 285, { align: 'right' });
  }

  // Cartographic Frame & Grid Lines Drawer
  function drawCartographicFrameAndGrid(mapper: ReturnType<typeof getCoordinateMapper>) {
    // Outer neatline border frame around the actual mapped base map area
    doc.setDrawColor(148, 163, 184);
    doc.setLineWidth(0.35);
    doc.rect(mapper.offsetX, mapper.offsetY, mapper.fittedWidth, mapper.fittedHeight, 'D');

    // Grid interval determination (e.g. 5km or 10km based on scope size)
    const rangeE = mapper.boxMaxE - mapper.boxMinE;
    let gridInMeters = 5000;
    if (rangeE > 40000) gridInMeters = 10000;
    if (rangeE > 80000) gridInMeters = 20000;

    const startE = Math.ceil(mapper.boxMinE / gridInMeters) * gridInMeters;
    const endE = Math.floor(mapper.boxMaxE / gridInMeters) * gridInMeters;
    const startN = Math.ceil(mapper.boxMinN / gridInMeters) * gridInMeters;
    const endN = Math.floor(mapper.boxMaxN / gridInMeters) * gridInMeters;

    // Draw Grid Lines (Dashed vector strokes confined to actual mapped base map)
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.12);
    // Setup dashed line style
    if (typeof (doc as any).setLineDashPattern === 'function') {
      (doc as any).setLineDashPattern([2, 2], 0);
    }
    
    for (let e = startE; e <= endE; e += gridInMeters) {
      const pTop = mapper.toPage(e, mapper.boxMaxN);
      const x = Math.max(mapper.offsetX, Math.min(mapper.offsetX + mapper.fittedWidth, pTop.x));
      doc.line(x, mapper.offsetY, x, mapper.offsetY + mapper.fittedHeight);
    }

    for (let n = startN; n <= endN; n += gridInMeters) {
      const pLeft = mapper.toPage(mapper.boxMinE, n);
      const y = Math.max(mapper.offsetY, Math.min(mapper.offsetY + mapper.fittedHeight, pLeft.y));
      doc.line(mapper.offsetX, y, mapper.offsetX + mapper.fittedWidth, y);
    }

    // Reset line dash to solid
    if (typeof (doc as any).setLineDashPattern === 'function') {
      (doc as any).setLineDashPattern([], 0);
    }

    // Draw grid marks/labels beautifully nested strictly inside coordinates space
    doc.setFont("Courier", "normal");
    doc.setFontSize(6.5);
    doc.setTextColor(148, 163, 184);
    
    for (let e = startE; e <= endE; e += gridInMeters * 2) {
      const p = mapper.toPage(e, mapper.boxMinN);
      if (p.x >= mapper.offsetX + 10 && p.x <= mapper.offsetX + mapper.fittedWidth - 10) {
        doc.text(`${e/1000}km E`, p.x, mapper.offsetY + mapper.fittedHeight - 2, { align: 'center' });
      }
    }

    for (let n = startN; n <= endN; n += gridInMeters * 2) {
      const p = mapper.toPage(mapper.boxMinE, n);
      if (p.y >= mapper.offsetY + 10 && p.y <= mapper.offsetY + mapper.fittedHeight - 10) {
        doc.text(`${n/1000}km N`, mapper.offsetX + 2, p.y, { baseline: 'middle' });
      }
    }

    // Compass Arrow relative to base map bounds
    const compX = mapper.offsetX + mapper.fittedWidth - 15;
    const compY = mapper.offsetY + 15;
    doc.setDrawColor(71, 85, 105);
    doc.setLineWidth(0.3);
    doc.line(compX, compY + 5, compX, compY - 5); // N-S Line
    doc.setFillColor(71, 85, 105);
    doc.triangle(compX, compY - 5, compX - 1.5, compY - 1, compX + 1.5, compY - 1, 'F'); // Arrowhead N
    doc.setFont("Helvetica", "bold");
    doc.setFontSize(7);
    doc.setTextColor(71, 85, 105);
    doc.text("N", compX, compY - 6.5, { align: 'center' });

    // Dynamic Scale Bar relative to base map bounds
    const scaleBarLengthMeters = gridInMeters;
    const scaleBarWidthMm = scaleBarLengthMeters * mapper.scale;
    const barX = mapper.offsetX + 15;
    const barY = mapper.offsetY + mapper.fittedHeight - 10;
    
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(30, 41, 59);
    doc.setLineWidth(0.25);
    doc.rect(barX, barY, scaleBarWidthMm, 2, 'D'); // hollow frame
    
    doc.setFillColor(30, 41, 59);
    doc.rect(barX, barY, scaleBarWidthMm / 2, 2, 'F');
    
    doc.setFont("Helvetica", "bold");
    doc.setFontSize(6.5);
    doc.setTextColor(30, 41, 59);
    doc.text(`Scale: 0`, barX, barY - 1.5);
    doc.text(`${scaleBarLengthMeters / 1000} km`, barX + scaleBarWidthMm, barY - 1.5, { align: 'right' });
  }

  // Polygon boundary drawer
  function drawGroupBoundary(mapper: ReturnType<typeof getCoordinateMapper>, isFaint: boolean = false) {
    const mappedPts: [number, number][] = polyEN.map(p => {
      const coord = mapper.toPage(p.Easting, p.Northing);
      return [coord.x, coord.y];
    });

    if (isFaint) {
      doc.setDrawColor(2, 136, 209);
      doc.setLineWidth(0.18);
    } else {
      doc.setDrawColor(2, 136, 209);
      doc.setLineWidth(0.5);
    }
    
    if (mappedPts.length > 0) {
      doc.moveTo(mappedPts[0][0], mappedPts[0][1]);
      for (let i = 1; i < mappedPts.length; i++) {
        doc.lineTo(mappedPts[i][0], mappedPts[i][1]);
      }
      doc.close();
      doc.stroke();
    }
  }

  // ==========================================
  // PAGE 1: RED SQUIRREL WILDLIFE SIGHTINGS MAP
  // ==========================================
  drawHeader("Page 1: Red Squirrel Wildlife Sightings Map", "Red Squirrel survey overview");
  if (bgImage1) {
    doc.saveGraphicsState();
    try {
      const gState = new GState({ opacity: 0.85 });
      doc.setGState(gState);
    } catch (e) {}
    doc.addImage(bgImage1, 'JPEG', page1Mapper.offsetX, page1Mapper.offsetY, page1Mapper.fittedWidth, page1Mapper.fittedHeight, undefined, 'FAST');
    doc.restoreGraphicsState();
  }
  drawCartographicFrameAndGrid(page1Mapper);
  drawGroupBoundary(page1Mapper, false); // Thick active blue border

  let redCount = 0;
  allSightings.forEach(s => {
    const lat = parseFloat(s.decimalLatitude);
    const lon = parseFloat(s.decimalLongitude);
    if (isNaN(lat) || isNaN(lon)) return;
    
    if (isPointInPolygon(lat, lon, group.polygon as [number, number][])) {
      const spType = s.speciesType;
      if (spType === 'red') {
        redCount++;
        const { Easting, Northing } = latLonToEastingNorthing(lat, lon);
        const coord = page1Mapper.toPage(Easting, Northing);
        if (coord.x >= page1Mapper.offsetX && coord.x <= page1Mapper.offsetX + page1Mapper.fittedWidth &&
            coord.y >= page1Mapper.offsetY && coord.y <= page1Mapper.offsetY + page1Mapper.fittedHeight) {
          doc.setFillColor(220, 38, 38); // rich red
          doc.circle(coord.x, coord.y, 0.7, 'F');
        }
      }
    }
  });

  // Plot Legend for Page 1
  let legY = page1Mapper.offsetY + page1Mapper.fittedHeight + 6;
  doc.setFont("Helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(30, 41, 59);
  doc.text("MAP KEY / LEGEND:", 15, legY);

  doc.setFont("Helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(71, 85, 105);

  doc.setFillColor(220, 38, 38);
  doc.circle(16, legY + 4, 1.2, 'F');
  doc.text(`Red Squirrel Sightings (${redCount} recs)`, 19, legY + 4.8);

  doc.setDrawColor(2, 136, 209);
  doc.setLineWidth(0.6);
  doc.line(15, legY + 11.5, 23, legY + 11.5);
  doc.text("Recovery Area Boundary (Blue Border)", 25, legY + 12.5);

  doc.setFont("Helvetica", "italic");
  doc.setFontSize(7);
  doc.setTextColor(100, 116, 139);
  doc.text("* Sighting coordinate points are mapped directly from official digital biodiversity database records.", 15, legY + 18);
  doc.text("  These represent solid vector elements plotted exactly against projected coordinates.", 15, legY + 21);

  drawFooter(1);


  // ==========================================
  // PAGE 2: GREY SQUIRREL WILDLIFE SIGHTINGS MAP
  // ==========================================
  doc.addPage();
  drawHeader("Page 2: Grey Squirrel Wildlife Sightings Map", "Grey Squirrel survey overview");
  if (bgImage1) {
    doc.saveGraphicsState();
    try {
      const gState = new GState({ opacity: 0.85 });
      doc.setGState(gState);
    } catch (e) {}
    doc.addImage(bgImage1, 'JPEG', page1Mapper.offsetX, page1Mapper.offsetY, page1Mapper.fittedWidth, page1Mapper.fittedHeight, undefined, 'FAST');
    doc.restoreGraphicsState();
  }
  drawCartographicFrameAndGrid(page1Mapper);
  drawGroupBoundary(page1Mapper, false); // Thick active blue border

  let greyCount = 0;
  allSightings.forEach(s => {
    const lat = parseFloat(s.decimalLatitude);
    const lon = parseFloat(s.decimalLongitude);
    if (isNaN(lat) || isNaN(lon)) return;
    
    if (isPointInPolygon(lat, lon, group.polygon as [number, number][])) {
      const spType = s.speciesType;
      if (spType === 'grey' && s.isTrapping !== true && s.isTrapping !== "true") {
        greyCount++;
        const { Easting, Northing } = latLonToEastingNorthing(lat, lon);
        const coord = page1Mapper.toPage(Easting, Northing);
        if (coord.x >= page1Mapper.offsetX && coord.x <= page1Mapper.offsetX + page1Mapper.fittedWidth &&
            coord.y >= page1Mapper.offsetY && coord.y <= page1Mapper.offsetY + page1Mapper.fittedHeight) {
          doc.setFillColor(115, 115, 115); // charcoal grey
          doc.circle(coord.x, coord.y, 0.7, 'F');
        }
      }
    }
  });

  // Plot Legend for Page 2
  legY = page1Mapper.offsetY + page1Mapper.fittedHeight + 6;
  doc.setFont("Helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(30, 41, 59);
  doc.text("MAP KEY / LEGEND:", 15, legY);

  doc.setFont("Helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(71, 85, 105);

  doc.setFillColor(115, 115, 115);
  doc.circle(16, legY + 4, 1.2, 'F');
  doc.text(`Grey Squirrel Sightings (${greyCount} recs)`, 19, legY + 4.8);

  doc.setDrawColor(2, 136, 209);
  doc.setLineWidth(0.6);
  doc.line(15, legY + 11.5, 23, legY + 11.5);
  doc.text("Recovery Area Boundary (Blue Border)", 25, legY + 12.5);

  doc.setFont("Helvetica", "italic");
  doc.setFontSize(7);
  doc.setTextColor(100, 116, 139);
  doc.text("* Sighting coordinate points are mapped directly from official digital biodiversity database records.", 15, legY + 18);
  doc.text("  These represent solid vector elements plotted exactly against projected coordinates.", 15, legY + 21);

  drawFooter(2);


  // ==========================================
  // PAGE 3: PINE MARTEN WILDLIFE SIGHTINGS MAP
  // ==========================================
  doc.addPage();
  drawHeader("Page 3: Pine Marten Wildlife Sightings Map", "Pine Marten survey overview");
  if (bgImage1) {
    doc.saveGraphicsState();
    try {
      const gState = new GState({ opacity: 0.85 });
      doc.setGState(gState);
    } catch (e) {}
    doc.addImage(bgImage1, 'JPEG', page1Mapper.offsetX, page1Mapper.offsetY, page1Mapper.fittedWidth, page1Mapper.fittedHeight, undefined, 'FAST');
    doc.restoreGraphicsState();
  }
  drawCartographicFrameAndGrid(page1Mapper);
  drawGroupBoundary(page1Mapper, false); // Thick active blue border

  let martenCount = 0;
  allSightings.forEach(s => {
    const lat = parseFloat(s.decimalLatitude);
    const lon = parseFloat(s.decimalLongitude);
    if (isNaN(lat) || isNaN(lon)) return;
    
    if (isPointInPolygon(lat, lon, group.polygon as [number, number][])) {
      const spType = s.speciesType;
      if (spType === 'marten') {
        martenCount++;
        const { Easting, Northing } = latLonToEastingNorthing(lat, lon);
        const coord = page1Mapper.toPage(Easting, Northing);
        if (coord.x >= page1Mapper.offsetX && coord.x <= page1Mapper.offsetX + page1Mapper.fittedWidth &&
            coord.y >= page1Mapper.offsetY && coord.y <= page1Mapper.offsetY + page1Mapper.fittedHeight) {
          doc.setFillColor(113, 63, 18); // deep brown
          doc.circle(coord.x, coord.y, 0.75, 'F');
        }
      }
    }
  });

  // Plot Legend for Page 3
  legY = page1Mapper.offsetY + page1Mapper.fittedHeight + 6;
  doc.setFont("Helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(30, 41, 59);
  doc.text("MAP KEY / LEGEND:", 15, legY);

  doc.setFont("Helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(71, 85, 105);

  doc.setFillColor(113, 63, 18);
  doc.circle(16, legY + 4, 1.2, 'F');
  doc.text(`Pine Marten Sightings (${martenCount} recs)`, 19, legY + 4.8);

  doc.setDrawColor(2, 136, 209);
  doc.setLineWidth(0.6);
  doc.line(15, legY + 11.5, 23, legY + 11.5);
  doc.text("Recovery Area Boundary (Blue Border)", 25, legY + 12.5);

  doc.setFont("Helvetica", "italic");
  doc.setFontSize(7);
  doc.setTextColor(100, 116, 139);
  doc.text("* Sighting coordinate points are mapped directly from official digital biodiversity database records.", 15, legY + 18);
  doc.text("  These represent solid vector elements plotted exactly against projected coordinates.", 15, legY + 21);

  drawFooter(3);


  // ==========================================
  // PAGE 4: GREY SQUIRREL CONTROLLED TRAPPING DENSITY
  // ==========================================
  doc.addPage();
  drawHeader("Page 4: Grey Squirrel Controlled Trapping Density", "5km Grid Squares overlapping Recovery Boundary");
  if (bgImage1) {
    doc.saveGraphicsState();
    try {
      const gState = new GState({ opacity: 0.85 });
      doc.setGState(gState);
    } catch (e) {}
    doc.addImage(bgImage1, 'JPEG', page1Mapper.offsetX, page1Mapper.offsetY, page1Mapper.fittedWidth, page1Mapper.fittedHeight, undefined, 'FAST');
    doc.restoreGraphicsState();
  }
  const page2Mapper = page1Mapper;
  drawCartographicFrameAndGrid(page2Mapper);
  drawGroupBoundary(page2Mapper, false); // Blue border in front

  // Aggregate trapping data for overlapping boxes
  const page2Squares: Record<string, { easting: number; northing: number; count: number }> = {};
  allSightings.forEach(s => {
    const sType = s.speciesType;
    if (sType !== 'grey_effort' && !(sType === 'grey' && (s.isTrapping === true || s.isTrapping === "true"))) return;

    const lat = parseFloat(s.decimalLatitude);
    const lon = parseFloat(s.decimalLongitude);
    if (isNaN(lat) || isNaN(lon)) return;

    if (isSquarePartiallyInPolygon(lat, lon, group.polygon as [number, number][])) {
      const { Easting, Northing } = latLonToEastingNorthing(lat, lon);
      const E_sw = Math.floor(Easting / 5000) * 5000;
      const N_sw = Math.floor(Northing / 5000) * 5000;
      const key = `${E_sw}_${N_sw}`;
      const recCount = parseInt(s.recordCount) || 1;

      if (!page2Squares[key]) {
        page2Squares[key] = { easting: E_sw, northing: N_sw, count: 0 };
      }
      page2Squares[key].count += recCount;
    }
  });

  const p2SqList = Object.values(page2Squares);
  const maxP2Count = Math.max(1, ...p2SqList.map(s => s.count));

  // Loop & plot squares programmatically under the boundary
  p2SqList.forEach(sq => {
    // Shading using standard UI-like colors mapped inside vector bounds
    const style = getContourColor(sq.count, maxP2Count);
    // Parse color styles from #hex or fallback standard colors
    let r = 34, g = 197, b = 94; // fallback light green
    if (style.fillColor === '#22c55e') { r = 34; g = 197; b = 94; }
    else if (style.fillColor === '#84cc16') { r = 132; g = 204; b = 22; }
    else if (style.fillColor === '#eab308') { r = 234; g = 179; b = 8; }
    else if (style.fillColor === '#f97316') { r = 249; g = 115; b = 22; }
    else if (style.fillColor === '#dc2626') { r = 220; g = 38; b = 38; }

    const sw = page2Mapper.toPage(sq.easting, sq.northing);
    const se = page2Mapper.toPage(sq.easting + 5000, sq.northing);
    const ne = page2Mapper.toPage(sq.easting + 5000, sq.northing + 5000);
    const nw = page2Mapper.toPage(sq.easting, sq.northing + 5000);

    const mappedCorners: [number, number][] = [
      [sw.x, sw.y],
      [se.x, se.y],
      [ne.x, ne.y],
      [nw.x, nw.y]
    ];

    // Check if center of the 5km square is within map bounds
    const ctr = page1Mapper.toPage(sq.easting + 2500, sq.northing + 2500);
    if (ctr.x < page1Mapper.offsetX - 2 || ctr.x > page1Mapper.offsetX + page1Mapper.fittedWidth + 2 ||
        ctr.y < page1Mapper.offsetY - 2 || ctr.y > page1Mapper.offsetY + page1Mapper.fittedHeight + 2) return;

    // Apply beautiful opacity fill
    doc.saveGraphicsState();
    try {
      const gState = new GState({ opacity: 0.4 });
      doc.setGState(gState);
    } catch (err) {}

    doc.setFillColor(r, g, b);
    doc.setDrawColor(r * 0.7, g * 0.7, b * 0.7);
    doc.setLineWidth(0.18);
    
    if (mappedCorners.length > 0) {
      doc.moveTo(mappedCorners[0][0], mappedCorners[0][1]);
      for (let i = 1; i < mappedCorners.length; i++) {
        doc.lineTo(mappedCorners[i][0], mappedCorners[i][1]);
      }
      doc.close();
      doc.fillStroke();
    }

    doc.restoreGraphicsState();

    // Print text on top inside the box in vector
    doc.setFillColor(255, 255, 255);
    doc.setFont("Helvetica", "bold");
    doc.setFontSize(8.5);
    doc.setTextColor(30, 41, 59);
    // Draw white small backing rect for text legibility
    const textStr = sq.count.toString();
    const textW = textStr.length * 2.5 + 2;
    doc.rect(ctr.x - textW / 2, ctr.y - 2.5, textW, 5, 'F');
    doc.rect(ctr.x - textW / 2, ctr.y - 2.5, textW, 5, 'D');
    doc.text(textStr, ctr.x, ctr.y + 0.8, { align: 'center' });
  });

  // Plot Legend for Page 4
  const p2LegY = page1Mapper.offsetY + page1Mapper.fittedHeight + 6;
  doc.setFont("Helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(30, 41, 59);
  doc.text("MAP KEY / LEGEND (CONTROL TRAP RECS):", 15, p2LegY);

  const steps = [
    { label: "1 - 20% (Low)", color: [34, 197, 94] },
    { label: "21 - 40%", color: [132, 204, 22] },
    { label: "41 - 60% (Med)", color: [234, 179, 8] },
    { label: "61 - 80%", color: [249, 115, 22] },
    { label: "81 - 100% (High)", color: [220, 38, 38] }
  ];

  doc.setFont("Helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(71, 85, 105);

  steps.forEach((step, idx) => {
    const x = 15 + idx * 36;
    doc.setFillColor(step.color[0], step.color[1], step.color[2]);
    doc.rect(x, p2LegY + 3, 6, 3, 'F');
    doc.text(step.label, x + 7.5, p2LegY + 5.5);
  });

  doc.setFont("Helvetica", "italic");
  doc.setFontSize(7);
  doc.setTextColor(100, 116, 139);
  doc.text(`* Showing overlapping 5km grid boxes with trap activity (Max records observed: ${maxP2Count}).`, 15, p2LegY + 11.5);
  doc.text(`* Blue outline shows recovery boundary, and squares are partially transparent vector grids.`, 15, p2LegY + 14.5);

  drawFooter(4);


  // ==========================================
  // PAGE 5: SURVEY OUTSIDE BUFFER ZONE (0 - 20KM BEYOND AREA)
  // ==========================================
  doc.addPage();
  drawHeader("Page 5: Grey Proximity Buffer Zone Survey (0 - 20km)", "Grey Sighting & Trap indicators outside Area Boundary");

  if (bgImage3) {
    doc.saveGraphicsState();
    try {
      const gState = new GState({ opacity: 0.85 });
      doc.setGState(gState);
    } catch (e) {}
    doc.addImage(bgImage3, 'JPEG', page3Mapper.offsetX, page3Mapper.offsetY, page3Mapper.fittedWidth, page3Mapper.fittedHeight, undefined, 'FAST');
    doc.restoreGraphicsState();
  }

  drawCartographicFrameAndGrid(page3Mapper);
  
  // Draw Area Boundary inside Page 5 mapping
  drawGroupBoundary(page3Mapper, true); // drawn as faint thin outline

  // Distances computed in meters to filter outside buffer zone
  let extGreySightingCount = 0;
  const page3Squares: Record<string, { easting: number; northing: number; count: number }> = {};

  allSightings.forEach(s => {
    const lat = parseFloat(s.decimalLatitude);
    const lon = parseFloat(s.decimalLongitude);
    if (isNaN(lat) || isNaN(lon)) return;

    // Must be OUTSIDE the recovery area
    const isInsideArea = isPointInPolygon(lat, lon, group.polygon as [number, number][]);
    const isTrapOverlapping = (s.speciesType === 'grey_effort' || s.isTrapping) && isSquarePartiallyInPolygon(lat, lon, group.polygon as [number, number][]);

    if (!isInsideArea && !isTrapOverlapping) {
      // Calculate E, N for distance testing
      const { Easting, Northing } = latLonToEastingNorthing(lat, lon);
      
      // Compute minimum distance to the recovery area polygon segments
      const dist = getDistanceToPolygon(Easting, Northing, polyEN);

      if (dist <= 20000) { // Within 20km from the boundary limits!
        const coord = page3Mapper.toPage(Easting, Northing);

        // Verify bounds clipped inside base map boundaries
        if (coord.x >= page3Mapper.offsetX && coord.x <= page3Mapper.offsetX + page3Mapper.fittedWidth &&
            coord.y >= page3Mapper.offsetY && coord.y <= page3Mapper.offsetY + page3Mapper.fittedHeight) {
          const spType = s.speciesType;

          if (spType === 'grey' && s.isTrapping !== true && s.isTrapping !== "true") {
            // Grey sighting outside
            extGreySightingCount++;
            doc.setFillColor(115, 115, 115); // grey dot
            doc.circle(coord.x, coord.y, 0.7, 'F');
          } else if (spType === 'grey_effort' || (spType === 'grey' && (s.isTrapping === true || s.isTrapping === "true"))) {
            // Trapping outside - aggregate to 5km Grid square
            const E_sw = Math.floor(Easting / 5000) * 5000;
            const N_sw = Math.floor(Northing / 5000) * 5000;
            const key = `${E_sw}_${N_sw}`;
            const recCount = parseInt(s.recordCount) || 1;

            if (!page3Squares[key]) {
              page3Squares[key] = { easting: E_sw, northing: N_sw, count: 0 };
            }
            page3Squares[key].count += recCount;
          }
        }
      }
    }
  });

  const p3SqList = Object.values(page3Squares);
  const maxP3Count = Math.max(1, ...p3SqList.map(s => s.count));

  // Plot Page 5 trapping boxes
  p3SqList.forEach(sq => {
    const style = getContourColor(sq.count, maxP3Count);
    let r = 34, g = 197, b = 94;
    if (style.fillColor === '#22c55e') { r = 34; g = 197; b = 94; }
    else if (style.fillColor === '#84cc16') { r = 132; g = 204; b = 22; }
    else if (style.fillColor === '#eab308') { r = 234; g = 179; b = 8; }
    else if (style.fillColor === '#f97316') { r = 249; g = 115; b = 22; }
    else if (style.fillColor === '#dc2626') { r = 220; g = 38; b = 38; }

    const sw = page3Mapper.toPage(sq.easting, sq.northing);
    const se = page3Mapper.toPage(sq.easting + 5000, sq.northing);
    const ne = page3Mapper.toPage(sq.easting + 5000, sq.northing + 5000);
    const nw = page3Mapper.toPage(sq.easting, sq.northing + 5000);

    const corners: [number, number][] = [
      [sw.x, sw.y],
      [se.x, se.y],
      [ne.x, ne.y],
      [nw.x, nw.y]
    ];

    // Check if center of the 5km square is within map bounds
    const ctr = page3Mapper.toPage(sq.easting + 2500, sq.northing + 2500);
    if (ctr.x < page3Mapper.offsetX - 2 || ctr.x > page3Mapper.offsetX + page3Mapper.fittedWidth + 2 ||
        ctr.y < page3Mapper.offsetY - 2 || ctr.y > page3Mapper.offsetY + page3Mapper.fittedHeight + 2) return;

    doc.saveGraphicsState();
    try {
      const gState = new GState({ opacity: 0.45 });
      doc.setGState(gState);
    } catch (e) {}

    doc.setFillColor(r, g, b);
    doc.setDrawColor(r * 0.7, g * 0.7, b * 0.7);
    doc.setLineWidth(0.18);
    
    if (corners.length > 0) {
      doc.moveTo(corners[0][0], corners[0][1]);
      for (let i = 1; i < corners.length; i++) {
        doc.lineTo(corners[i][0], corners[i][1]);
      }
      doc.close();
      doc.fillStroke();
    }

    doc.restoreGraphicsState();

    // Text Label backing
    doc.setFillColor(255, 255, 255);
    doc.setFont("Helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(30, 41, 59);
    const textStr = sq.count.toString();
    const textW = textStr.length * 2.5 + 2;
    doc.rect(ctr.x - textW / 2, ctr.y - 2.2, textW, 4.4, 'F');
    doc.rect(ctr.x - textW / 2, ctr.y - 2.2, textW, 4.4, 'D');
    doc.text(textStr, ctr.x, ctr.y + 0.8, { align: 'center' });
  });

  // Page 5 Map Legend
  const p3LegY = page3Mapper.offsetY + page3Mapper.fittedHeight + 6;
  doc.setFont("Helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(30, 41, 59);
  doc.text("MAP KEY / LEGEND (BUFFER DISPERSAL):", 15, p3LegY);

  doc.setFont("Helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(71, 85, 105);

  doc.setFillColor(115, 115, 115);
  doc.circle(16, p3LegY + 4, 1.2, 'F');
  doc.text(`Grey Squirrel sightings completely outside of area (${extGreySightingCount} recs)`, 19, p3LegY + 4.8);

  doc.setFillColor(220, 38, 38);
  doc.rect(15, p3LegY + 8.5, 5, 2.5, 'F');
  doc.text(`Trapping square outside of area (Scale: 1 to ${maxP3Count} recs)`, 21, p3LegY + 11.0);

  doc.setFont("Helvetica", "italic");
  doc.setFontSize(7);
  doc.setTextColor(100, 116, 139);
  doc.text(`* Showing records and grids fully outside the blue border, spanning a 20km outer survey buffer area.`, 15, p3LegY + 16.5);
  doc.text(`* Helps research teams monitor grey squirrel dispersal in the buffer zone surrounding the critical refuge.`, 15, p3LegY + 19.5);

  drawFooter(5);

  return doc;
}
