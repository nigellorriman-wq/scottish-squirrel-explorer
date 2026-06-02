import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import axios from "axios";
import NodeCache from "node-cache";
import fs from "fs/promises";
import { existsSync, statSync, readFileSync } from "fs";
import { SQUIRREL_GROUPS } from "./src/groups_data";
import { fileURLToPath } from "url";
import { latLonToEastingNorthing, eastingNorthingToLatLon } from "./src/osGridUtils";
import zlib from "zlib";
import dotenv from "dotenv";

dotenv.config();

const resolvedFilename = typeof __filename !== "undefined" ? __filename : fileURLToPath(import.meta.url);
const resolvedDirname = typeof __dirname !== "undefined" ? __dirname : path.dirname(resolvedFilename);

let firebaseConfig: any = null;
const firebaseConfigPath = path.join(process.cwd(), "firebase-applet-config.json");
if (existsSync(firebaseConfigPath)) {
  try {
    const rawConfig = readFileSync(firebaseConfigPath, "utf-8");
    firebaseConfig = JSON.parse(rawConfig);
    console.log("[Server] Loaded firebase-applet-config.json successfully. Project ID:", firebaseConfig.projectId);
  } catch (e: any) {
    console.error("[Server] Error parsing firebase-applet-config.json:", e.message);
  }
}

function isPointInPolygon(lat: number, lon: number, polygon: [number, number][]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersect = ((yi > lon) !== (yj > lon)) && (lat < (xj - xi) * (lon - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function isSquarePartiallyInPolygon(lat: number, lon: number, polygon: [number, number][]) {
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

// Initialize cache with 24 hour TTL
const sightingsCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });

let DATA_DIR = path.join(process.cwd(), "data");
if (existsSync(path.join(resolvedDirname, "data"))) {
  DATA_DIR = path.join(resolvedDirname, "data");
} else if (existsSync(path.join(resolvedDirname, "../data"))) {
  DATA_DIR = path.join(resolvedDirname, "../data");
}

const DATA_FILE = path.join(DATA_DIR, "squirrel_sightings.json");
const PROGRESS_FILE = path.join(DATA_DIR, "sync_progress_v2.json");

// In-memory store for bulk sightings (now loaded dynamically on-demand)
let bulkStore: Record<string, any[]> = {
  red: [],
  grey: [],
  marten: [],
  grey_trapping: []
};

let syncStatus: Record<string, { 
  isLoading: boolean, 
  count: number, 
  totalEstimated: number, 
  phase: string,
  currentYear?: number,
  lastSync?: string,
  isCancelled?: boolean,
  completedYears?: number[]
}> = {
  red: { isLoading: false, count: 0, totalEstimated: 0, phase: 'idle', completedYears: [] },
  grey: { isLoading: false, count: 0, totalEstimated: 0, phase: 'idle', completedYears: [] },
  marten: { isLoading: false, count: 0, totalEstimated: 0, phase: 'idle', completedYears: [] },
  grey_trapping: { isLoading: false, count: 0, totalEstimated: 0, phase: 'idle', completedYears: [] }
};

const activeAbortControllers: Record<string, AbortController | null> = {
  red: null,
  grey: null,
  marten: null,
  grey_trapping: null
};

let syncProgressStore: Record<string, {
  completedYears: number[],
  isComplete: boolean,
  count?: number,
  lastSync?: string,
  isWiped?: boolean,
  hasBootstrapped?: boolean
}> = {
  red: { completedYears: [], isComplete: false },
  grey: { completedYears: [], isComplete: false },
  marten: { completedYears: [], isComplete: false },
  grey_trapping: { completedYears: [], isComplete: false }
};

function getSpeciesFilePath(species: string) {
  if (species === 'red') return path.join(DATA_DIR, 'red.json');
  if (species === 'grey') return path.join(DATA_DIR, 'grey.json');
  if (species === 'marten') return path.join(DATA_DIR, 'marten.json');
  if (species === 'grey_trapping') return path.join(DATA_DIR, 'grey_trapping.json');
  return path.join(DATA_DIR, `${species}.json`);
}

function getSpeciesYearFilePath(species: string, year: number) {
  return path.join(DATA_DIR, `${species}_${year}.json.gz`);
}

async function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    await fs.mkdir(DATA_DIR, { recursive: true });
  }
}

async function saveProgressToFile() {
  const tempFile = `${PROGRESS_FILE}.${Date.now()}.${Math.random().toString(36).substring(2)}.tmp`;
  try {
    await ensureDataDir();
    await fs.writeFile(tempFile, JSON.stringify(syncProgressStore, null, 2));
    await fs.rename(tempFile, PROGRESS_FILE);
    console.log(`[Persistence] Sync progress saved to ${PROGRESS_FILE}`);
  } catch (error) {
    console.error(`[Persistence] Error saving progress:`, error);
    await fs.unlink(tempFile).catch(() => {});
  }
}

async function loadProgressFromFile() {
  try {
    if (existsSync(PROGRESS_FILE)) {
      const data = await fs.readFile(PROGRESS_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === 'object') {
        ['red', 'grey', 'marten', 'grey_trapping'].forEach(species => {
          const sKey = species as 'red' | 'grey' | 'marten' | 'grey_trapping';
          if (parsed[sKey]) {
            syncProgressStore[sKey] = {
              completedYears: Array.isArray(parsed[sKey].completedYears) ? parsed[sKey].completedYears : [],
              isComplete: !!parsed[sKey].isComplete,
              count: typeof parsed[sKey].count === 'number' ? parsed[sKey].count : 0,
              lastSync: parsed[sKey].lastSync,
              isWiped: !!parsed[sKey].isWiped,
              hasBootstrapped: !!parsed[sKey].hasBootstrapped
            };
          }
        });
      }
    }
    console.log(`[Persistence] Loaded sync progress from disk. Completed years count: red=${syncProgressStore.red.completedYears.length}, grey=${syncProgressStore.grey.completedYears.length}, marten=${syncProgressStore.marten.completedYears.length}, grey_trapping=${syncProgressStore.grey_trapping.completedYears.length}`);
  } catch (err) {
    console.error("[Persistence] Error loading progress file:", err);
    console.warn("[Persistence] PROGRESS_FILE is corrupted; resetting progress.");
    await fs.unlink(PROGRESS_FILE).catch(() => {});
  }
}

async function saveSpeciesYearToFile(species: 'red' | 'grey' | 'marten' | 'grey_trapping', year: number, records: any[]) {
  const filePath = getSpeciesYearFilePath(species, year);
  const tempFilePath = `${filePath}.${Date.now()}.${Math.random().toString(36).substring(2)}.tmp`;
  try {
    await ensureDataDir();
    const tsNow = new Date().toISOString();
    const wrapper = {
      downloadedAt: tsNow,
      year: year,
      records: records
    };
    const jsonString = JSON.stringify(wrapper, null, 2);
    const compressed = zlib.gzipSync(Buffer.from(jsonString, 'utf-8'));
    
    await fs.writeFile(tempFilePath, compressed);
    await fs.rename(tempFilePath, filePath);
    console.log(`[Persistence] Saved ${records.length} records to compressed ${filePath}`);

    // If there is an old uncompressed file in the data folder, delete it to save space
    const legacyJsonPath = filePath.replace('.json.gz', '.json');
    if (existsSync(legacyJsonPath)) {
      await fs.unlink(legacyJsonPath).catch(() => {});
    }

    // Also save a copy to the server downloads directory so the user gets it in the workspace folder
    const downloadsDir = path.join(process.cwd(), "downloads");
    if (!existsSync(downloadsDir)) {
      await fs.mkdir(downloadsDir, { recursive: true });
    }
    const downloadFilePath = path.join(downloadsDir, `${species}_${year}.json.gz`);
    await fs.writeFile(downloadFilePath, compressed);
    console.log(`[Persistence] Copied year-split to ${downloadFilePath}`);

    // Clean up any old uncompressed file in downloads
    const legacyDownloadPath = path.join(downloadsDir, `${species}_${year}.json`);
    if (existsSync(legacyDownloadPath)) {
      await fs.unlink(legacyDownloadPath).catch(() => {});
    }
  } catch (error) {
    console.error(`[Persistence] Error saving ${species} for year ${year}:`, error);
    await fs.unlink(tempFilePath).catch(() => {});
  }
}

async function saveSpeciesToFile(species: 'red' | 'grey' | 'marten' | 'grey_trapping') {
  try {
    await ensureDataDir();
    const dataToSave = bulkStore[species] || [];
    
    // Split the dataToSave by year and write separate files for each year
    const recordsByYear: Record<number, any[]> = {};
    for (const r of dataToSave) {
      if (!r) continue;
      const y = parseInt(r.year) || 2000;
      if (!recordsByYear[y]) recordsByYear[y] = [];
      recordsByYear[y].push(r);
    }

    const currentYear = new Date().getFullYear();
    // Save each year that has records, or if it's the current year
    for (let year = 2000; year <= currentYear; year++) {
      const yearRecords = recordsByYear[year] || [];
      if (yearRecords.length > 0 || year === currentYear || existsSync(getSpeciesYearFilePath(species, year))) {
        await saveSpeciesYearToFile(species, year, yearRecords);
      }
    }

    const tsNow = syncStatus[species]?.lastSync || new Date().toISOString();
    
    // Save count to progress store to stay aligned
    syncProgressStore[species].count = dataToSave.length;
    syncProgressStore[species].lastSync = tsNow;
    await saveProgressToFile();
  } catch (error) {
    console.error(`[Persistence] Error saving ${species} data:`, error);
  }
}

async function saveDataToFile(species?: 'red' | 'grey' | 'marten' | 'grey_trapping') {
  if (species) {
    await saveSpeciesToFile(species);
  } else {
    await saveSpeciesToFile('red');
    await saveSpeciesToFile('grey');
    await saveSpeciesToFile('marten');
    await saveSpeciesToFile('grey_trapping');
  }
}

async function fetchAndCacheFromFirebaseStorage(species: string, year: number): Promise<Buffer | null> {
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET || firebaseConfig?.storageBucket;
  if (!bucketName || bucketName === "MY_FIREBASE_STORAGE_BUCKET" || bucketName.trim() === "") {
    return null;
  }
  
  const fileNameGz = `${species}_${year}.json.gz`;
  const urlGz = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(fileNameGz)}?alt=media`;
  
  // Try compressed first
  try {
    console.log(`[Firebase Storage] Remote check: testing compressed file ${fileNameGz} from: ${urlGz}`);
    const response = await axios.get(urlGz, { responseType: 'arraybuffer', timeout: 20000 });
    if (response.status === 200) {
      const buffer = Buffer.from(response.data);
      const yearFilePathGz = getSpeciesYearFilePath(species, year);
      await fs.writeFile(yearFilePathGz, buffer);
      console.log(`[Firebase Storage] Successfully downloaded and cached compressed file ${fileNameGz} locally.`);
      return buffer;
    }
  } catch (err: any) {
    if (err.response && err.response.status === 404) {
      console.log(`[Firebase Storage] Compressed file ${fileNameGz} not found (404). Trying uncompressed .json instead...`);
    } else {
      console.warn(`[Firebase Storage] Network check failed for ${fileNameGz}:`, err.message);
    }
  }

  // Fallback to uncompressed JSON
  const fileNameJson = `${species}_${year}.json`;
  const urlJson = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(fileNameJson)}?alt=media`;
  
  try {
    console.log(`[Firebase Storage] Remote fallback check: downloading uncompressed file ${fileNameJson} from: ${urlJson}`);
    const response = await axios.get(urlJson, { responseType: 'arraybuffer', timeout: 35000 });
    if (response.status === 200) {
      const uncompressedBuffer = Buffer.from(response.data);
      
      // Auto-compress the raw JSON to gzip in the backend on the fly
      console.log(`[Firebase Storage] Downloaded raw file ${fileNameJson} (${uncompressedBuffer.length} bytes). Compressing to GZ on-the-fly...`);
      const zippedBuffer = zlib.gzipSync(uncompressedBuffer);
      
      const yearFilePathGz = getSpeciesYearFilePath(species, year);
      await fs.writeFile(yearFilePathGz, zippedBuffer);
      console.log(`[Firebase Storage] Successfully compressed and cached ${fileNameJson} locally as ${yearFilePathGz} (${zippedBuffer.length} bytes).`);
      return zippedBuffer;
    }
  } catch (err: any) {
    if (err.response && err.response.status === 404) {
      console.log(`[Firebase Storage] File ${fileNameJson} not found in Storage either (404). No records for ${year}.`);
    } else {
      console.error(`[Firebase Storage] Network error downloading uncompressed file ${fileNameJson}:`, err.message);
    }
  }

  return null;
}

async function ensureSpeciesLoaded(species: 'red' | 'grey' | 'marten' | 'grey_trapping', forceReset: boolean = false) {
  if (forceReset || syncProgressStore[species]?.isWiped) {
    bulkStore[species] = [];
    syncStatus[species].count = 0;
    return;
  }
  if (bulkStore[species] && bulkStore[species].length > 0) {
    return; // Already loaded in memory cache
  }
  
  await ensureDataDir();
  const currentYear = new Date().getFullYear();
  let allRecords: any[] = [];
  const loadedYears = new Set<number>();

  for (let year = 2000; year <= currentYear; year++) {
    const yearFilePathGz = getSpeciesYearFilePath(species, year);
    const legacyJsonPath = yearFilePathGz.replace('.json.gz', '.json');
    
    let yearFilePath = '';
    let isCompressed = false;
    
    if (existsSync(yearFilePathGz)) {
      yearFilePath = yearFilePathGz;
      isCompressed = true;
    } else if (existsSync(legacyJsonPath)) {
      yearFilePath = legacyJsonPath;
      isCompressed = false;
    } else {
      // Try to load from remote Firebase Storage
      const buffer = await fetchAndCacheFromFirebaseStorage(species, year);
      if (buffer) {
        yearFilePath = yearFilePathGz;
        isCompressed = true;
      }
    }

    if (yearFilePath) {
      try {
        let dataStr = '';
        if (isCompressed) {
          const buffer = await fs.readFile(yearFilePath);
          dataStr = zlib.gunzipSync(buffer).toString('utf-8');
        } else {
          dataStr = await fs.readFile(yearFilePath, 'utf-8');
        }
        const parsed = JSON.parse(dataStr);
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.records)) {
          allRecords = allRecords.concat(parsed.records);
          loadedYears.add(year);
          if (parsed.downloadedAt) {
            if (!syncStatus[species].lastSync || parsed.downloadedAt > syncStatus[species].lastSync) {
              syncStatus[species].lastSync = parsed.downloadedAt;
            }
          }
        } else {
          console.warn(`[Persistence] Invalid structure in separate year file ${yearFilePath}. Deleting corrupt file.`);
          await fs.unlink(yearFilePath).catch(() => {});
        }
      } catch (err) {
        console.error(`[Persistence] Error reading separate year file ${yearFilePath}:`, err);
        console.warn(`[Persistence] Deleting corrupt separate year file ${yearFilePath} to trigger auto-re-sync.`);
        await fs.unlink(yearFilePath).catch(() => {});
      }
    }
  }

  // Check if we need to bootstrap/migrate any missing year-split files from the legacy master dataset
  let bootstrapNeeded = false;
  for (let y = 2008; y <= currentYear; y++) {
    if (!loadedYears.has(y)) {
      bootstrapNeeded = true;
      break;
    }
  }

  if (bootstrapNeeded) {
    const filePath = getSpeciesFilePath(species);
    const activeDataFile = existsSync(filePath) 
      ? filePath 
      : (existsSync(DATA_FILE) 
          ? DATA_FILE 
          : (existsSync(path.join(process.cwd(), "squirrel_sightings.json")) 
              ? path.join(process.cwd(), "squirrel_sightings.json") 
              : null));

    if (activeDataFile) {
      try {
        console.log(`[Persistence] Species ${species} has missing year-split files. Bootstrapping on-demand from backup master file ${activeDataFile}...`);
        const data = await fs.readFile(activeDataFile, 'utf-8');
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed === 'object') {
          let recordsToBootstrap: any[] = [];
          
          if (Array.isArray(parsed)) {
            recordsToBootstrap = parsed;
          } else if (parsed.records && Array.isArray(parsed.records)) {
            recordsToBootstrap = parsed.records;
          } else {
            if (species === 'grey_trapping') {
              let rawGreyList = Array.isArray(parsed.grey) ? parsed.grey : [];
              rawGreyList.forEach(isSSRS);
              recordsToBootstrap = rawGreyList.filter(r => r.isTrapping);
            } else {
              let rawList = Array.isArray(parsed[species]) ? parsed[species] : [];
              rawList.forEach(isSSRS);
              recordsToBootstrap = rawList;
              if (species === 'grey') {
                recordsToBootstrap = rawList.filter(r => !r.isTrapping);
              }
            }
          }

          if (recordsToBootstrap.length > 0) {
            const recordsByYear: Record<number, any[]> = {};
            for (const r of recordsToBootstrap) {
              const y = parseInt(r.year) || 2000;
              if (!loadedYears.has(y)) {
                if (!recordsByYear[y]) recordsByYear[y] = [];
                recordsByYear[y].push(r);
              }
            }

            for (const [yearStr, yearRecords] of Object.entries(recordsByYear)) {
              const y = parseInt(yearStr);
              if (yearRecords.length > 0) {
                await saveSpeciesYearToFile(species, y, yearRecords);
                allRecords = allRecords.concat(yearRecords);
                loadedYears.add(y);
                console.log(`[Persistence] Bootstraps: created split year file ${species}_${y}.json with ${yearRecords.length} records.`);
              }
            }
          }
        }
      } catch (error) {
        console.error(`[Persistence] Error bootstrapping missing years of ${species}:`, error);
      } finally {
        if (syncProgressStore[species]) {
          syncProgressStore[species].hasBootstrapped = true;
          await saveProgressToFile().catch(() => {});
        }
      }
    }
  }

  // Deduplicate and finalize
  const uniqueMap = new Map();
  allRecords.forEach(r => {
    const rid = r.uuid || r.id;
    if (rid) uniqueMap.set(rid, r);
  });
  const dedupedRecords = Array.from(uniqueMap.values());
  bulkStore[species] = dedupedRecords;
  syncStatus[species].count = dedupedRecords.length;

  if (syncProgressStore[species]) {
    syncProgressStore[species].count = dedupedRecords.length;
    await saveProgressToFile().catch(() => {});
  }

  console.log(`[Persistence] Finalized loading. Total records for ${species}: ${dedupedRecords.length}`);
}

async function loadDataFromFile() {
  try {
    // We do NOT load massive data files on startup to optimize startup speed and heap size. Load them on-demand!
    for (const species of ['red', 'grey', 'marten', 'grey_trapping']) {
      const sKey = species as 'red' | 'grey' | 'marten' | 'grey_trapping';
      
      // Bootstrap counts and metadata from our lightweight progress file
      syncStatus[sKey].count = syncProgressStore[sKey]?.count || 0;
      if (syncProgressStore[sKey]?.lastSync) {
        syncStatus[sKey].lastSync = syncProgressStore[sKey].lastSync;
      } else {
        // If not in progress store, determine lastSync from split files or DATA_FILE modification dates
        try {
          let latestDate: Date | null = null;
          const currentYear = new Date().getFullYear();
          for (let y = 2000; y <= currentYear; y++) {
            const yearFilePath = getSpeciesYearFilePath(sKey, y);
            const legacyJsonPath = yearFilePath.replace('.json.gz', '.json');
            
            if (existsSync(yearFilePath)) {
              const fileStats = statSync(yearFilePath);
              if (!latestDate || fileStats.mtime > latestDate) {
                latestDate = fileStats.mtime;
              }
            } else if (existsSync(legacyJsonPath)) {
              const fileStats = statSync(legacyJsonPath);
              if (!latestDate || fileStats.mtime > latestDate) {
                latestDate = fileStats.mtime;
              }
            }
          }
          if (latestDate) {
            syncStatus[sKey].lastSync = latestDate.toISOString();
            syncProgressStore[sKey].lastSync = latestDate.toISOString();
          } else {
            if (existsSync(DATA_FILE)) {
              const fileStats = statSync(DATA_FILE);
              syncStatus[sKey].lastSync = fileStats.mtime.toISOString();
              syncProgressStore[sKey].lastSync = fileStats.mtime.toISOString();
            } else if (existsSync(path.join(process.cwd(), "squirrel_sightings.json"))) {
              const fileStats = statSync(path.join(process.cwd(), "squirrel_sightings.json"));
              syncStatus[sKey].lastSync = fileStats.mtime.toISOString();
              syncProgressStore[sKey].lastSync = fileStats.mtime.toISOString();
            }
          }
        } catch (e) {
          console.error(`[Persistence] Error checking fallback stats for ${sKey}:`, e);
        }
      }
      syncStatus[sKey].completedYears = syncProgressStore[sKey]?.completedYears || [];
    }

    console.log(`[Persistence] On-demand file loader initialized. Synced counts: red=${syncStatus.red.count}, grey=${syncStatus.grey.count}, marten=${syncStatus.marten.count}, grey_trapping=${syncStatus.grey_trapping.count}`);
  } catch (error) {
    console.error(`[Persistence] Error initializing data counts:`, error);
  }
}

async function fetchAllSightings(species: 'red' | 'grey' | 'marten' | 'grey_trapping', forceReset: boolean = false) {
  if (syncStatus[species]?.isLoading && !forceReset) {
    console.log(`[Sync] Already in progress for ${species}.`);
    return;
  }
  
  const currentYear = new Date().getFullYear();

  if (forceReset) {
    console.log(`[Sync] ${species}: Force reset was requested. Wiping sync progress, clearing in-memory data, and deleting all year-split JSON files.`);
    
    // 1. Delete all existing year-split files from year 2000 to currentYear
    for (let y = 2000; y <= currentYear; y++) {
      const yearFilePath = getSpeciesYearFilePath(species, y);
      const legacyJsonPath = yearFilePath.replace('.json.gz', '.json');
      try {
        if (existsSync(yearFilePath)) {
          await fs.unlink(yearFilePath);
          console.log(`[Sync] Deleted split file: ${yearFilePath}`);
        }
      } catch (unlinkErr) {
        console.error(`[Sync] Failed to delete split file ${yearFilePath}:`, unlinkErr);
      }
      try {
        if (existsSync(legacyJsonPath)) {
          await fs.unlink(legacyJsonPath);
          console.log(`[Sync] Deleted legacy split file: ${legacyJsonPath}`);
        }
      } catch (unlinkErr) {}
    }

    // Also try to delete legacy master file to avoid any bootstrap loading corrupt data
    const legacyFilePath = getSpeciesFilePath(species);
    try {
      if (existsSync(legacyFilePath)) {
        await fs.unlink(legacyFilePath);
        console.log(`[Sync] Deleted legacy master file: ${legacyFilePath}`);
      }
    } catch (err) {}

    // 2. Reset progress store
    syncProgressStore[species] = {
      count: 0,
      lastSync: null,
      completedYears: [],
      isComplete: false,
      hasBootstrapped: true
    };
    await saveProgressToFile();

    // 3. Reset local memory & maps
    bulkStore[species] = [];
    syncStatus[species] = {
      isLoading: true,
      count: 0,
      totalEstimated: 0,
      phase: 'Starting Fresh',
      lastSync: undefined,
      currentYear: currentYear,
      isCancelled: false
    };
  }

  await ensureSpeciesLoaded(species, forceReset);
  
  if (activeAbortControllers[species]) {
    try {
      activeAbortControllers[species].abort();
    } catch (e) {}
  }
  activeAbortControllers[species] = new AbortController();
  const signal = activeAbortControllers[species].signal;
  
  if (syncProgressStore[species]) {
    delete syncProgressStore[species].isWiped;
  }
  
  syncStatus[species] = { 
    ...syncStatus[species],
    isLoading: true, 
    phase: 'Initializing',
    currentYear: 2008
  };
  
  console.log(`[Bulk Load] Starting sync for ${species} in Scotland (Year by Year)...`);
  
  const taxonFilter = species === "red" 
    ? `taxa:"Sciurus vulgaris"`
    : (species === "grey" || species === "grey_trapping")
      ? `(taxa:"Sciurus carolinensis" OR dataResourceUid:dr637 OR dataResourceUid:dr1595 OR dataResourceUid:dr1596 OR dataResourceUid:dr1597 OR dataResourceUid:dr1598 OR dataResourceUid:dr1593 OR dataResourceName:*Squirrel*)`
      : `taxa:"Martes martes"`;

  const query = taxonFilter;

  const url = `https://records-ws.nbnatlas.org/occurrences/search`;

  // Use existing records as base for incremental update
  const existingRecords = bulkStore[species] || [];
  const recordMap = new Map(existingRecords.filter(r => r && (r.id || r.uuid)).map(r => [r.id || r.uuid, r]));

  try {
    // Large geographic box covering Scotland
    const geoFq = `decimalLatitude:[54.0 TO 62.0] AND decimalLongitude:[-11.0 TO 2.0]`;
    // Include both present and absent records for trapping effort
    const statusFq = (species === "grey" || species === "grey_trapping") ? `(occurrenceStatus:present OR occurrenceStatus:absent)` : `occurrenceStatus:present`;

    const globalCheck = await axios.get(url, {
      params: {
        q: query,
        fq: `${geoFq} AND ${statusFq} AND year:[2000 TO ${currentYear}]`,
        pageSize: 0
      },
      timeout: 30000,
      signal: signal
    });

    console.log(`[Sync] ${species}: Global check URL: ${url}?q=${encodeURIComponent(query)}&fq=${encodeURIComponent(geoFq)}`);
    const totalExpected = globalCheck.data.totalRecords || 0;
    syncStatus[species].totalEstimated = totalExpected;
    syncStatus[species].count = recordMap.size;

    console.log(`[Sync] ${species}: Found ${totalExpected} records in total search.`);

    // Sync from year 2000 to current
    for (let year = currentYear; year >= 2000; year--) {
      if (signal.aborted || syncStatus[species]?.isCancelled) {
        throw new Error("Cancelled by user");
      }
      // If we are NOT on the current year, and a file for this year already exists in the data directory, we ignore/skip it!
      if (year < currentYear) {
        const yearFilePath = getSpeciesYearFilePath(species, year);
        const legacyJsonPath = yearFilePath.replace('.json.gz', '.json');
        if (existsSync(yearFilePath) || existsSync(legacyJsonPath)) {
          console.log(`[Sync] ${species} ${year} already exists in data folder as split JSON/GZ. Skipping download.`);
          if (!syncProgressStore[species].completedYears) {
            syncProgressStore[species].completedYears = [];
          }
          if (!syncProgressStore[species].completedYears.includes(year)) {
            syncProgressStore[species].completedYears.push(year);
          }
          syncStatus[species].completedYears = [...syncProgressStore[species].completedYears];
          continue;
        }
      }

      // If it's the current year, we always fetch it in full. Clear existing records for currentYear from recordMap first to avoid duplicates.
      if (year === currentYear) {
        for (const [key, val] of recordMap.entries()) {
          if (val && Number(val.year) === currentYear) {
            recordMap.delete(key);
          }
        }
      }
      
      syncStatus[species].currentYear = year;
      let yearHasError = false;
      let yearTotal = 0;
      
      try {
        const yearCheck = await axios.get(url, {
          params: {
            q: query,
            fq: `${geoFq} AND ${statusFq} AND year:${year}`,
            pageSize: 0
          },
          timeout: 20000,
          signal: signal
        });
        yearTotal = yearCheck.data.totalRecords || 0;
        console.log(`[Sync] ${species} ${year}: ${yearTotal} records`);
      } catch (err: any) {
        if (signal.aborted || axios.isCancel(err) || syncStatus[species]?.isCancelled) {
          throw new Error("Cancelled by user");
        }
        console.error(`[Sync] Error during year check for ${species} ${year}:`, err.message);
        yearHasError = true;
      }
      
      if (yearTotal > 0 && !yearHasError) {
        // If more than 4000 records in a year, fetch month by month to stay under NBN's 10k limit per export
        const months = yearTotal > 4000 ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [null];
 
         for (const month of months) {
          if (yearHasError) break;
          if (signal.aborted || syncStatus[species]?.isCancelled) {
            throw new Error("Cancelled by user");
          }
          syncStatus[species].phase = `Downloading ${year}${month ? '-' + month : ''}`;
          
          let startOffset = 0;
          const pageSize = 1000;
          let hasMoreInPeriod = true;
 
          const periodFq = `${geoFq} AND ${statusFq} AND year:${year}${month ? ' AND month:' + month : ''}`;
 
          while (hasMoreInPeriod) {
            if (signal.aborted || syncStatus[species]?.isCancelled) {
              throw new Error("Cancelled by user");
            }
            try {
              const response = await axios.get(url, {
                params: {
                  q: query,
                  fq: periodFq,
                  pageSize: pageSize,
                  start: startOffset,
                  fl: "id,uuid,decimalLatitude,decimalLongitude,year,scientificName,raw_commonName,vernacularName,occurrenceDate,eventDate,dataResourceName,dataResourceUid,collectionCode,raw_collectionCode,coordinateUncertaintyInMeters,gridReference,institutionCode,raw_institutionCode,individualCount,occurrenceRemarks,raw_occurrenceRemarks,occurrenceStatus,raw_occurrenceStatus,occurrenceID",
                },
                timeout: 30000,
                signal: signal
              });
 
              const responseData = response.data;
              let records = responseData.occurrences || [];
              const totalInRequest = responseData.totalRecords || 0;
              
              if (records.length === 0) {
                 hasMoreInPeriod = false;
                 continue;
              }
 
              const rawFetchedCount = records.length;
              records.forEach((r: any) => {
                const recordId = r.uuid || r.id;
                if (recordId) {
                  isSSRS(r); // Tag it
                  
                  // Filter based on species requested and trapping status
                  if (species === 'grey' && r.isTrapping) return;
                  if (species === 'grey_trapping' && !r.isTrapping) return;
 
                  recordMap.set(recordId, r);
                  r.id = recordId;
                }
              });
 
              syncStatus[species].count = recordMap.size;
              // Immediate update to store for visibility
              bulkStore[species] = Array.from(recordMap.values());
              
              if (rawFetchedCount < pageSize || startOffset + rawFetchedCount >= totalInRequest || startOffset + rawFetchedCount >= 10000) {
                hasMoreInPeriod = false;
              } else {
                startOffset += rawFetchedCount;
              }
            } catch (err: any) {
              if (signal.aborted || axios.isCancel(err) || syncStatus[species]?.isCancelled) {
                throw new Error("Cancelled by user");
              }
              console.error(`[Sync] Error at ${year}${month ? '-' + month : ''}, offset ${startOffset}:`, err.message);
              yearHasError = true;
              hasMoreInPeriod = false; 
              await new Promise(r => setTimeout(r, 1000));
            }
          }
        }
      }
 
      if (!yearHasError) {
        if (!syncProgressStore[species].completedYears) {
          syncProgressStore[species].completedYears = [];
        }
        if (!syncProgressStore[species].completedYears.includes(year)) {
          syncProgressStore[species].completedYears.push(year);
        }
        syncStatus[species].completedYears = [...syncProgressStore[species].completedYears];
        await saveProgressToFile();
        
        // Save ONLY the records of this year to its corresponding year file!
        const yearRecords = Array.from(recordMap.values()).filter((r: any) => r && Number(r.year) === year);
        
        // Inform user on UI about saving this year's file
        const savedFilename = `${species}_${year}.json.gz`;
        syncStatus[species].phase = `Creating GZ file: ${savedFilename}`;
        await new Promise(r => setTimeout(r, 600)); // Brief sleep so the UI registers this event
        
        await saveSpeciesYearToFile(species, year, yearRecords);
        
        // Maintain local bulk store alignment
        bulkStore[species] = Array.from(recordMap.values());
        syncStatus[species].count = recordMap.size;
        syncStatus[species].lastSync = new Date().toISOString();
      } else {
        console.warn(`[Sync] ${species} ${year} had fetch errors, not marking as complete.`);
      }
    }
 
    console.log(`[Bulk Load] ${species} SYNC FINISHED. total=${recordMap.size}`);
    bulkStore[species] = Array.from(recordMap.values());
    syncStatus[species].phase = 'Saving final state';
    syncStatus[species].lastSync = new Date().toISOString();
    
    // Set isComplete to true and save progress!
    syncProgressStore[species].isComplete = true;
    syncProgressStore[species].lastSync = syncStatus[species].lastSync;
    await saveProgressToFile();
 
    await saveDataToFile(species);
    syncStatus[species].phase = 'Complete';
  } catch (error: any) {
    if (error && error.message === "Cancelled by user") {
      console.log(`[Bulk Load] Sync for ${species} was cancelled by user.`);
      syncStatus[species].phase = 'Cancelled';
    } else {
      console.error(`[Bulk Load] Fatal error syncing ${species}:`, error);
      syncStatus[species].phase = 'Error';
    }
  } finally {
    syncStatus[species].isLoading = false;
    syncStatus[species].isCancelled = false;
    if (activeAbortControllers[species]?.signal === signal) {
      activeAbortControllers[species] = null;
    }
  }
}

// Start initial background sync and load from file - moved inside startServer
// (async () => { ... })();

function getActualSpecies(s: any): "red" | "grey" | "marten" | "other" {
  if (!s) return "other";
  const sciName = String(s.scientificName || s.species || "").toLowerCase();
  const commonName = String(s.raw_commonName || s.vernacularName || "").toLowerCase();
  
  if (sciName.includes("vulgaris") || commonName.includes("red squirrel")) {
    return "red";
  }
  if (
    sciName.includes("carolinensis") || 
    commonName.includes("grey squirrel") || 
    commonName.includes("gray squirrel")
  ) {
    return "grey";
  }
  if (sciName.includes("martes") || commonName.includes("marten")) {
    return "marten";
  }
  return "other";
}

function isSSRS(s: any): boolean {
  try {
    if (!s) return false;
    
    // Standardize property names in-place to handle Solr raw/prefixed/timestamp names
    s.id = s.uuid || s.id;
    s.occurrenceID = s.occurrenceID || s.raw_occurrenceId || '';
    s.collectionCode = s.collectionCode || s.raw_collectionCode || '';
    s.institutionCode = s.institutionCode || s.raw_institutionCode || '';
    s.raw_commonName = s.raw_commonName || s.vernacularName || '';
    s.occurrenceRemarks = s.occurrenceRemarks || s.raw_occurrenceRemarks || '';
    s.occurrenceStatus = s.occurrenceStatus || s.raw_occurrenceStatus || 'present';

    if (s.eventDate && !s.occurrenceDate) {
      try {
        s.occurrenceDate = new Date(s.eventDate).toISOString();
      } catch (e) {
        // ignore parsing errors for malformed timestamps
      }
    }
    
    const rawName = String(s.raw_commonName || s.vernacularName || s.scientificName || s.species || '').toLowerCase();
    const resourceName = String(s.dataResourceName || '').toLowerCase();
    const remarks = String(s.occurrenceRemarks || s.raw_occurrenceRemarks || '').toLowerCase();
    const institution = String(s.institutionCode || s.raw_institutionCode || '').toLowerCase();
    const resUid = String(s.dataResourceUid || '');
    const collectionCodeVal = String(s.collectionCode || s.raw_collectionCode || '').toUpperCase();
    
    // Official Trapping/Control Datasets (including dr949 - The Scottish Squirrel Database)
    const isTrappingDataset = 
      resUid === "dr949" ||   // The Scottish Squirrel Database (actual NBN ID containing SWT records)
      resUid === "dr637" ||   // SSRS Standardised Survey
      resUid === "dr1595" ||  // SSRS GSSRS Private
      resUid === "dr1596" ||  // SSRS GSSRS Staff/Vol
      resUid === "dr1597" ||  // SSRS Effort Vol
      resUid === "dr1598" ||  // SSRS Effort Staff
      resUid === "dr1593" ||  // SSRS Generalised
      resUid === "dr171" ||   // SSRS Sightings (sometimes includes GSSRS)
      resUid === "dr1089" ||  // Older/Alternative list ID
      resUid === "dr1738" ||  // FLS Red and Grey records
      resUid === "dr649" ||   // Borders
      resUid === "dr723" ||   // Angus
      resUid === "dr703" ||   // Grampian
      resUid === "dr361";     // Tayside
      
    // Tag records as trapping if they match SSRS criteria or explicitly mention control/trapping
    const isSSRSProject = 
      collectionCodeVal.includes("SSRS") || 
      collectionCodeVal.includes("GSSRS") || 
      resourceName.includes("gssrs") ||
      resourceName.includes("saving scotland's red squirrels") ||
      resourceName.includes("ssrs") ||
      resourceName.includes("borders red squirrel") ||
      resourceName.includes("saving scotlands red squirrels") ||
      resourceName.includes("the scottish squirrel database");

    const combinedText = `${rawName} ${remarks} ${resourceName} ${institution}`;

    const hasTrappingKeywords = 
      combinedText.includes('trap') || 
      combinedText.includes('control') || 
      combinedText.includes('effort') ||
      combinedText.includes('catch') ||
      combinedText.includes('dispatch') ||
      combinedText.includes('despatch') ||
      combinedText.includes('cull') ||
      combinedText.includes('removal') ||
      combinedText.includes('shoot') ||
      combinedText.includes('shot') ||
      combinedText.includes('kill') ||
      combinedText.includes('euthaniz') ||
      combinedText.includes('euthanis') ||
      combinedText.includes('eradication') ||
      combinedText.includes('rifle') ||
      combinedText.includes('shooting') ||
      combinedText.includes('managed') ||
      combinedText.includes('humane') ||
      combinedText.includes('station') ||
      combinedText.includes('box') ||
      combinedText.includes('tunnel') ||
      institution.includes('forestry') ||
      institution.includes('fls');

    const actualSpecies = getActualSpecies(s);
    const isGrid10km = Number(s.coordinateUncertaintyInMeters) === 7071.1 || (typeof s.gridReference === 'string' && s.gridReference.length === 4);
    const isAbsent = String(s.occurrenceStatus).toLowerCase() === 'absent';
    
    if (actualSpecies === 'grey' && (isSSRSProject || isTrappingDataset || isGrid10km || hasTrappingKeywords || isAbsent)) {
      s.isTrapping = true;
    } else {
      s.isTrapping = false;
    }
  } catch (err) {
    if (s && typeof s === 'object') {
      s.isTrapping = false;
    }
  }
  return true;
}

// Sequential Serialization Queue to prevent race conditions & write corruption
let syncQueue: { species: 'red' | 'grey' | 'marten' | 'grey_trapping'; forceReset: boolean }[] = [];
let isProcessingQueue = false;

async function processSyncQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  
  while (syncQueue.length > 0) {
    const task = syncQueue.shift();
    if (task) {
      try {
        console.log(`[Queue] Starting queued sync for ${task.species} (forceReset: ${task.forceReset})`);
        await fetchAllSightings(task.species, task.forceReset);
      } catch (err: any) {
        console.error(`[Queue] Error syncing ${task.species}:`, err.message);
      }
    }
  }
  isProcessingQueue = false;
}

function enqueueSync(species: 'red' | 'grey' | 'marten' | 'grey_trapping', forceReset: boolean = false) {
  if (forceReset) {
    syncQueue = syncQueue.filter(t => t.species !== species);
    syncQueue.unshift({ species, forceReset: true });
    if (syncStatus[species]) {
      syncStatus[species].isLoading = false;
    }
    console.log(`[Queue] Force-enqueued ${species} with forceReset=true (wiping any pending queue tasks and resetting isLoading lock).`);
  } else {
    const alreadyInQueue = syncQueue.some(t => t.species === species);
    const isCurrentlySyncing = syncStatus[species]?.isLoading;
    if (!alreadyInQueue && !isCurrentlySyncing) {
      syncQueue.push({ species, forceReset: false });
      console.log(`[Queue] Enqueued ${species} sync. Queue size: ${syncQueue.length}`);
    }
  }
  processSyncQueue();
}

async function startServer() {
  try {
    const app = express();
    const PORT = 3000;

    // Load initial data
    await loadProgressFromFile();
    await loadDataFromFile();

    console.log(`[Server] Starting in ${process.env.NODE_ENV || 'development'} mode`);

    app.use(express.json({ limit: "200mb" }));
    app.use(express.urlencoded({ limit: "200mb", extended: true }));

  // Log all API requests
  app.use("/api", (req, res, next) => {
    console.log(`[API Request] ${req.method} ${req.url}`);
    next();
  });

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ 
      status: "ok", 
      time: new Date().toISOString(),
      counts: {
        red: syncStatus.red.count || bulkStore.red.length,
        grey: syncStatus.grey.count || bulkStore.grey.length,
        marten: syncStatus.marten.count || bulkStore.marten.length,
        grey_trapping: syncStatus.grey_trapping.count || bulkStore.grey_trapping.length
      },
      syncStatus
    });
  });

  // Firebase Storage Status & Diagnostic Endpoint
  app.get("/api/firebase-storage-status", async (req, res) => {
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET || firebaseConfig?.storageBucket;
    if (!bucketName || bucketName === "MY_FIREBASE_STORAGE_BUCKET" || bucketName.trim() === "") {
      return res.json({
        configured: false,
        bucketName: "",
        connectionOk: false,
        message: "Firebase Storage Bucket is not configured. Set FIREBASE_STORAGE_BUCKET in your Secrets/Environment variables to enable Cloud Storage downloads."
      });
    }

    const testFileName = "red_2024.json.gz";
    const testUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(testFileName)}?alt=media`;
    
    let connectionOk = false;
    let message = "";
    
    try {
      const testRes = await axios.head(testUrl, { timeout: 4000 });
      if (testRes.status === 200) {
        connectionOk = true;
        message = `Healthy connection! Test file '${testFileName}' found inside remote Firebase Storage bucket '${bucketName}'.`;
      } else {
        connectionOk = false;
        message = `HTTP status ${testRes.status} received when probing '${testFileName}'.`;
      }
    } catch (err: any) {
      if (err.response && err.response.status === 404) {
        connectionOk = true;
        message = `Connected successfully! However, file '${testFileName}' was not found in bucket '${bucketName}'. Make sure to upload your .json.gz files directly to Firebase.`;
      } else {
        connectionOk = false;
        message = `Connection failed: ${err.message || 'Unknown network error'}. Verify your bucket name: '${bucketName}' and ensure it has public read active.`;
      }
    }

    const currentYear = new Date().getFullYear();
    const localGzExists: Record<string, number> = { red: 0, grey: 0, marten: 0, grey_trapping: 0 };
    for (const species of ['red', 'grey', 'marten', 'grey_trapping']) {
      for (let y = 2000; y <= currentYear; y++) {
        const gzPath = getSpeciesYearFilePath(species, y);
        if (existsSync(gzPath)) {
          localGzExists[species]++;
        }
      }
    }

    res.json({
      configured: true,
      bucketName,
      connectionOk,
      message,
      localGzExists,
      currentYear
    });
  });

  // Database analysis report of datasets and references
  app.get("/api/db-report", async (req, res) => {
    await ensureSpeciesLoaded('red');
    await ensureSpeciesLoaded('grey');
    await ensureSpeciesLoaded('marten');
    await ensureSpeciesLoaded('grey_trapping');

    const report: Record<string, {
      species: string;
      resourceUid: string;
      resourceName: string;
      count: number;
      trappingCount: number;
    }> = {};

    ['red', 'grey', 'marten', 'grey_trapping'].forEach(species => {
      const records = bulkStore[species] || [];
      records.forEach(r => {
        const uid = r.dataResourceUid || r.data_resource_uid || 'unknown_uid';
        const name = r.dataResourceName || 'Unknown Resource';
        const key = `${species}_${uid}`;
        if (!report[key]) {
          report[key] = {
            species,
            resourceUid: uid,
            resourceName: name,
            count: 0,
            trappingCount: 0
          };
        }
        report[key].count++;
        if (r.isTrapping) {
          report[key].trappingCount++;
        }
      });
    });

    res.json(Object.values(report).sort((a,b) => b.count - a.count));
  });

  // API Route to fetch bulk or filtered sightings
  app.get("/api/sightings", async (req, res, next) => {
    try {
      const { species, startYear, endYear, latMin, latMax, lonMin, lonMax, zoom, forceRefresh, groupName } = req.query;
      
      const responseSpecies = Array.isArray(species) ? species : (species ? [species] : ['red']);
      
      // Start background sync for species immediately if explicitly requested
      responseSpecies.forEach((s) => {
        const sQuery = s as string;
        const sKey = (sQuery === 'grey_effort' ? 'grey_trapping' : sQuery) as 'red' | 'grey' | 'marten' | 'grey_trapping';
        
        if (['red', 'grey', 'marten', 'grey_trapping'].includes(sKey)) {
          if (forceRefresh === 'true') {
            enqueueSync(sKey, true);
          }
        }
      });

      const group = groupName ? SQUIRREL_GROUPS.find(g => g.name === groupName) : null;

      // Proceed with filtering current data
      const resultsBySpecies = await Promise.all(responseSpecies.map(async (s) => {
        const sQuery = s as string;
        const sKey = (sQuery === 'grey_effort' ? 'grey_trapping' : sQuery) as 'red' | 'grey' | 'marten' | 'grey_trapping';
        
        await ensureSpeciesLoaded(sKey);
        let results = bulkStore[sKey] || [];

        if (sQuery === 'grey_effort') {
          const grouped: Record<string, any> = {};
          results.forEach(r => {
            const key = `${r.decimalLatitude},${r.decimalLongitude}`;
            const count = parseInt(r.individualCount) || 1;
            if (!grouped[key]) {
              grouped[key] = { ...r, recordCount: count };
            } else {
              grouped[key].recordCount += count;
              if (r.year > (grouped[key].year || 0)) {
                grouped[key].year = r.year;
                grouped[key].occurrenceDate = r.occurrenceDate;
              }
            }
          });
          results = Object.values(grouped);
          console.log(`[Diagnostic] Grouped grey_effort: ${results.length} locations found.`);
        }

        // 1. Time Filter
        if (startYear || endYear) {
          const start = parseInt(startYear as string) || 2008;
          const end = parseInt(endYear as string) || new Date().getFullYear();
          results = results.filter(s => s.year >= start && s.year <= end);
        }

        // 2. Bounds or Group Filter
        if (group) {
          results = results.filter(s => {
            const lat = parseFloat(s.decimalLatitude);
            const lon = parseFloat(s.decimalLongitude);
            if (sQuery === "grey_effort" || s.isTrapping === true || s.isTrapping === "true" || s.speciesType === "grey_effort") {
              return isSquarePartiallyInPolygon(lat, lon, group.polygon as [number, number][]);
            }
            return isPointInPolygon(lat, lon, group.polygon as [number, number][]);
          });
        } else if (latMin && latMax && lonMin && lonMax) {
          const l1 = parseFloat(latMin as string);
          const l2 = parseFloat(latMax as string);
          const ln1 = parseFloat(lonMin as string);
          const ln2 = parseFloat(lonMax as string);
          results = results.filter(s => {
            const lat = parseFloat(s.decimalLatitude);
            const lon = parseFloat(s.decimalLongitude);
            return lat >= l1 && lat <= l2 && lon >= ln1 && lon <= ln2;
          });
        }
        return results.map(r => ({ ...r, speciesType: sQuery }));
      }));

      let results = resultsBySpecies.flat();
      const totalCountIncluded = results.length;
      const currentZoom = parseInt(zoom as string) || 10;
      
      // 3. Thinning Logic
      // If zoomed in (e.g. village level) or if few records, don't thin
      const shouldThin = totalCountIncluded > 10000 && currentZoom < 13;
      const isThinned = shouldThin;
      
      if (shouldThin) {
        const MAX_POINTS = 10000;
        // Grid-based spatial sampling
        let minLat = latMin ? parseFloat(latMin as string) : 54.5;
        let maxLat = latMax ? parseFloat(latMax as string) : 61.0;
        let minLon = lonMin ? parseFloat(lonMin as string) : -8.5;
        let maxLon = lonMax ? parseFloat(lonMax as string) : -0.5;

        if (group) {
          const lats = group.polygon.map(p => p[0]);
          const lons = group.polygon.map(p => p[1]);
          minLat = Math.min(...lats);
          maxLat = Math.max(...lats);
          minLon = Math.min(...lons);
          maxLon = Math.max(...lons);
        }
        
        const gridSize = 60; 
        const grid: Record<string, any[]> = {};
        
        for (const sighting of results) {
          const lat = parseFloat(sighting.decimalLatitude);
          const lon = parseFloat(sighting.decimalLongitude);
          const x = Math.floor(((lat - minLat) / (maxLat - minLat + 0.0001)) * gridSize);
          const y = Math.floor(((lon - minLon) / (maxLon - minLon + 0.0001)) * gridSize);
          const cellKey = `${x},${y}`;
          if (!grid[cellKey]) grid[cellKey] = [];
          grid[cellKey].push(sighting);
        }
        
        const sampled = [];
        const cells = Object.values(grid);
        const pointsPerCell = Math.max(1, Math.ceil(MAX_POINTS / cells.length));
        
        for (const cellRecords of cells) {
          cellRecords.sort((a, b) => (b.year || 0) - (a.year || 0));
          const toTake = Math.min(cellRecords.length, pointsPerCell);
          for (let i = 0; i < toTake; i++) {
            sampled.push(cellRecords[i]);
            if (sampled.length >= MAX_POINTS) break;
          }
          if (sampled.length >= MAX_POINTS) break;
        }
        results = sampled;
      }

      const anySyncing = responseSpecies.some(s => {
        const sQuery = s as string;
        const sKey = (sQuery === 'grey_effort' ? 'grey_trapping' : sQuery) as 'red' | 'grey' | 'marten' | 'grey_trapping';
        return sKey && syncStatus[sKey]?.isLoading;
      });

      res.json({
        occurrences: results,
        total: totalCountIncluded,
        thinned: isThinned,
        isSyncing: anySyncing
      });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/population-stats", async (req, res, next) => {
    try {
      const { latMin, latMax, lonMin, lonMax, startYear, endYear, groupName } = req.query;
      
      await ensureSpeciesLoaded('red');
      await ensureSpeciesLoaded('grey');
      await ensureSpeciesLoaded('marten');
      await ensureSpeciesLoaded('grey_trapping');

      const currentYear = new Date().getFullYear();
      let start = parseInt(startYear as string) || 2008;
      let end = parseInt(endYear as string) || currentYear;
      
      if (isNaN(start) || start < 1900) start = 2008;
      if (isNaN(end) || end > currentYear + 2) end = currentYear;
      if (end < start) {
        const temp = start;
        start = end;
        end = temp;
      }
      
      const stats: Record<number, { red: number; grey: number; grey_effort: number; marten: number }> = {};
      for (let y = start; y <= end; y++) {
        stats[y] = { red: 0, grey: 0, grey_effort: 0, marten: 0 };
      }

      const l1 = latMin ? parseFloat(latMin as string) : -90;
      const l2 = latMax ? parseFloat(latMax as string) : 90;
      const ln1 = lonMin ? parseFloat(lonMin as string) : -180;
      const ln2 = lonMax ? parseFloat(lonMax as string) : 180;

      const group = groupName ? SQUIRREL_GROUPS.find(g => g.name === groupName) : null;

      const filterInBounds = (s: any, isGreyTrapping = false) => {
        const lat = parseFloat(s.decimalLatitude);
        const lon = parseFloat(s.decimalLongitude);
        const inTime = s.year >= start && s.year <= end;
        
        if (!(inTime && isSSRS(s))) return false;
        
        if (group) {
          if (isGreyTrapping) {
            return isSquarePartiallyInPolygon(lat, lon, group.polygon as [number, number][]);
          }
          return isPointInPolygon(lat, lon, group.polygon as [number, number][]);
        }
        
        const inBounds = lat >= l1 && lat <= l2 && lon >= ln1 && ln2 >= lon;
        return inBounds;
      };

      bulkStore.red.filter(s => filterInBounds(s, false)).forEach(s => {
        const actualSp = getActualSpecies(s);
        if (actualSp === 'red' && stats[s.year]) stats[s.year].red++;
      });
      bulkStore.grey.filter(s => filterInBounds(s, s.isTrapping === true || s.isTrapping === "true")).forEach(s => {
        const actualSp = getActualSpecies(s);
        if (actualSp === 'grey' && stats[s.year]) {
          stats[s.year].grey++;
        }
      });
      bulkStore.grey_trapping.filter(s => filterInBounds(s, true)).forEach(s => {
        const actualSp = getActualSpecies(s);
        if (actualSp === 'grey' && stats[s.year]) {
          stats[s.year].grey_effort++;
        }
      });
      bulkStore.marten.filter(s => filterInBounds(s, false)).forEach(s => {
        const actualSp = getActualSpecies(s);
        if (actualSp === 'marten' && stats[s.year]) stats[s.year].marten++;
      });

      const timeline = Object.entries(stats).map(([year, counts]) => ({
        year: parseInt(year),
        ...counts
      })).sort((a, b) => a.year - b.year);

      res.json(timeline);
    } catch (err) {
      next(err);
    }
  });

  // API Route to export data source statistics as CSV
  app.get("/api/stats-csv", async (req, res) => {
    try {
      await ensureSpeciesLoaded('red');
      await ensureSpeciesLoaded('grey');
      await ensureSpeciesLoaded('marten');
      await ensureSpeciesLoaded('grey_trapping');

      const sourceCounts: Record<string, number> = {};
      const allSightings = [
        ...(bulkStore.red || []),
        ...(bulkStore.grey || []),
        ...(bulkStore.marten || []),
        ...(bulkStore.grey_trapping || [])
      ];
      
      allSightings.forEach(s => {
        const source = s.dataResourceName || "Unknown Source";
        sourceCounts[source] = (sourceCounts[source] || 0) + 1;
      });

      const sortedSources = Object.entries(sourceCounts).sort((a, b) => b[1] - a[1]);

      let csv = "DataSource,RecordCount\n";
      sortedSources.forEach(([source, count]) => {
        const escapedSource = source.replace(/"/g, '""');
        csv += `"${escapedSource}",${count}\n`;
      });

      // Also save to a 'downloads' folder on the server
      const downloadsDir = path.join(process.cwd(), "downloads");
      if (!existsSync(downloadsDir)) {
        await fs.mkdir(downloadsDir, { recursive: true });
      }
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const serverFilePath = path.join(downloadsDir, `data_source_stats_${timestamp}.csv`);
      await fs.writeFile(serverFilePath, csv);
      console.log(`[Export] Stats saved to server at ${serverFilePath}`);

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=squirrel_sources_${timestamp}.csv`);
      res.send(csv);
    } catch (error) {
      console.error("CSV Export error:", error);
      res.status(500).json({ error: "Failed to generate CSV" });
    }
  });

  // Diagnostic route to find data sources for a species in Scotland
  app.get("/api/sources-diagnostic", async (req, res) => {
    try {
      const { species } = req.query;
      const taxonId = species === "grey" ? "NBNSYS0000005107" : species === "marten" ? "NBNSYS0000005111" : "NBNSYS0000005108";
      const url = `https://records-ws.nbnatlas.org/occurrences/search`;
      
      const response = await axios.get(url, {
        params: {
          q: `taxonConceptID:${taxonId}`,
          fq: `decimalLatitude:[54.0 TO 62.0] AND decimalLongitude:[-11.0 TO 2.0]`,
          facets: "dataResourceName",
          pageSize: 0,
          flimit: 100
        }
      });
      
      res.json({
        totalRecords: response.data.totalRecords,
        sources: response.data.facetResults?.[0]?.fieldResult || []
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/force-refresh", async (req, res) => {
    const { species } = req.query;
    if (species === "red" || species === "grey" || species === "marten" || species === "grey_trapping") {
      enqueueSync(species as 'red' | 'grey' | 'marten' | 'grey_trapping', true);
      res.json({ message: `Sync started for ${species}` });
    } else {
      // Enqueue all in sequence!
      enqueueSync('red', true);
      enqueueSync('grey', true);
      enqueueSync('marten', true);
      enqueueSync('grey_trapping', true);
      res.json({ message: `Sequential sync started for all four categories (red, grey, marten, grey_trapping)` });
    }
  });

  app.post("/api/cancel-sync", async (req, res) => {
    try {
      console.log("[Cancel & Reset] Received cancellation and reset request");
      
      // 1. Clear queue and sequential serialization lock
      syncQueue = [];
      isProcessingQueue = false;
      
      // 2. Abort active controllers and instantly reset status/progress stores in memory
      const speciesList: ('red' | 'grey' | 'marten' | 'grey_trapping')[] = ['red', 'grey', 'marten', 'grey_trapping'];
      for (const s of speciesList) {
        if (activeAbortControllers[s]) {
          console.log(`[Cancel & Reset] Aborting active controller for ${s}`);
          try {
            activeAbortControllers[s].abort();
          } catch (e) {}
          activeAbortControllers[s] = null;
        }

        bulkStore[s] = [];
        syncStatus[s] = {
          isLoading: false,
          count: 0,
          totalEstimated: 0,
          phase: 'idle',
          lastSync: undefined,
          currentYear: undefined,
          isCancelled: true, // Mark cancelled for active loops
          completedYears: []
        };

        // Reset progress store for this species immediately
        syncProgressStore[s] = {
          completedYears: [],
          isComplete: false,
          count: 0,
          lastSync: undefined,
          isWiped: true,
          hasBootstrapped: true
        };
      }

      // Reset sightingsCache
      sightingsCache.flushAll();

      // Save the wiped progress store to file
      await saveProgressToFile();

      // Clear the cancelled flags after writing the initial state
      for (const s of speciesList) {
        if (syncStatus[s]) {
          syncStatus[s].isCancelled = false;
        }
      }
      
      // 3. Spawns asynchronous, non-blocking disk cleanup in the background
      const currentYear = new Date().getFullYear();
      (async () => {
        for (const s of speciesList) {
          // Delete all split year files from both data and downloads folder
          for (let y = 2000; y <= currentYear; y++) {
            const yearFilePath = getSpeciesYearFilePath(s, y);
            const downloadFilePath = path.join(process.cwd(), "downloads", `${s}_${y}.json.gz`);
            const legacyYearFilePath = yearFilePath.replace('.json.gz', '.json');
            const legacyDownloadFilePath = path.join(process.cwd(), "downloads", `${s}_${y}.json`);
            try {
              if (existsSync(yearFilePath)) {
                await fs.unlink(yearFilePath);
              }
            } catch (err) {}
            try {
              if (existsSync(legacyYearFilePath)) {
                await fs.unlink(legacyYearFilePath);
              }
            } catch (err) {}
            try {
              if (existsSync(downloadFilePath)) {
                await fs.unlink(downloadFilePath);
              }
            } catch (err) {}
            try {
              if (existsSync(legacyDownloadFilePath)) {
                await fs.unlink(legacyDownloadFilePath);
              }
            } catch (err) {}
          }

          // Delete legacy/master species file if any
          const mainFilePath = getSpeciesFilePath(s);
          try {
            if (existsSync(mainFilePath)) {
              await fs.unlink(mainFilePath);
            }
          } catch (err) {}
        }

        // Clean up combined JSON database
        const combinedPath = path.join(process.cwd(), "downloads", "scottish_squirrel_sightings.json");
        try {
          if (existsSync(combinedPath)) {
            await fs.unlink(combinedPath);
          }
        } catch (err) {}

        console.log("[Cancel & Reset] Background file cleanups completed cleanly.");
      })().catch(err => {
        console.error("[Cancel & Reset] Error in background file cleanup:", err);
      });

      console.log("[Cancel & Reset] Complete. All counters reset to 0 in memory instantly, files queued for deletion.");
      res.json({ success: true, message: "Sync successfully cancelled and all counters reset." });
    } catch (err: any) {
      console.error("[Cancel & Reset] Error:", err);
      res.status(500).json({ error: err.message || "Failed to cancel and reset sync." });
    }
  });

  // End point for sync status
  app.get("/api/sync-status", (req, res) => {
    res.json(syncStatus);
  });

  // End point to download a specific year-split JSON file for a specific species
  app.get("/api/download-year-file", async (req, res) => {
    try {
      const { species, year } = req.query;
      if (!species || !year) {
        return res.status(400).json({ error: "Missing species or year query parameters" });
      }
      const yNum = parseInt(year as string);
      const sKey = species as 'red' | 'grey' | 'marten' | 'grey_trapping';
      if (!['red', 'grey', 'marten', 'grey_trapping'].includes(sKey)) {
        return res.status(400).json({ error: "Invalid species name" });
      }
      const gzPath = getSpeciesYearFilePath(sKey, yNum);
      const jsonPath = gzPath.replace('.json.gz', '.json');
      
      if (existsSync(gzPath)) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Disposition', `attachment; filename="${sKey}_${year}.json"`);
        const data = await fs.readFile(gzPath);
        return res.send(data);
      } else if (existsSync(jsonPath)) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${sKey}_${year}.json"`);
        return res.sendFile(jsonPath);
      } else {
        return res.status(404).json({ error: "File not found" });
      }
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // End point to export full database as JSON
  app.get("/api/export", async (req, res) => {
    try {
      await ensureSpeciesLoaded('red');
      await ensureSpeciesLoaded('grey');
      await ensureSpeciesLoaded('marten');
      await ensureSpeciesLoaded('grey_trapping');
      
      const combined = {
        red: bulkStore.red || [],
        grey: bulkStore.grey || [],
        marten: bulkStore.marten || [],
        grey_trapping: bulkStore.grey_trapping || []
      };

      // Also save to a 'downloads' folder on the server
      const downloadsDir = path.join(process.cwd(), "downloads");
      if (!existsSync(downloadsDir)) {
        await fs.mkdir(downloadsDir, { recursive: true });
      }
      const jsonContent = JSON.stringify(combined, null, 2);
      const gzipBuffer = zlib.gzipSync(Buffer.from(jsonContent, 'utf-8'));
      
      const zipPath = path.join(downloadsDir, "scottish_squirrel_sightings.json.gz");
      await fs.writeFile(zipPath, gzipBuffer);
      console.log("[Export] Saved backup copy of full JSON database to downloads/scottish_squirrel_sightings.json.gz");
      
      // Clean up the massive legacy uncompressed file if present
      const legacyPath = path.join(downloadsDir, "scottish_squirrel_sightings.json");
      if (existsSync(legacyPath)) {
        await fs.unlink(legacyPath).catch(() => {});
      }
      
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Disposition', 'attachment; filename=scottish_squirrel_sightings.json');
      res.send(gzipBuffer);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // End point to import/load a local copy of full database as JSON
  app.post("/api/import", async (req, res) => {
    try {
      const data = req.body;
      if (!data || typeof data !== 'object') {
        return res.status(400).json({ error: "Invalid data. Expected a JSON object." });
      }

      const red = Array.isArray(data.red) ? data.red : [];
      const grey = Array.isArray(data.grey) ? data.grey : [];
      const marten = Array.isArray(data.marten) ? data.marten : [];
      const grey_trapping = Array.isArray(data.grey_trapping) ? data.grey_trapping : [];

      if (red.length === 0 && grey.length === 0 && marten.length === 0 && grey_trapping.length === 0) {
        return res.status(400).json({ error: "No records found in the uploaded file, or invalid JSON structure." });
      }

      // Update in-memory bulk store
      bulkStore.red = red;
      bulkStore.grey = grey;
      bulkStore.marten = marten;
      bulkStore.grey_trapping = grey_trapping;

      // Re-apply SSRS tagging logic to all imported records
      ['red', 'grey', 'marten', 'grey_trapping'].forEach(species => {
        bulkStore[species].forEach(isSSRS);
      });

      // Maintain syncProgressStore since we imported a complete copy
      const limitYear = new Date().getFullYear();
      const allYears = [];
      for (let y = 2000; y <= limitYear; y++) {
        allYears.push(y);
      }
      
      const tsNow = new Date().toISOString();
      syncProgressStore.red = { completedYears: [...allYears], isComplete: true, count: red.length, lastSync: tsNow };
      syncProgressStore.grey = { completedYears: [...allYears], isComplete: true, count: grey.length, lastSync: tsNow };
      syncProgressStore.marten = { completedYears: [...allYears], isComplete: true, count: marten.length, lastSync: tsNow };
      syncProgressStore.grey_trapping = { completedYears: [...allYears], isComplete: true, count: grey_trapping.length, lastSync: tsNow };
      await saveProgressToFile();

      // Save to server local disk/file
      await saveDataToFile();

      // Also reset/update syncStatus counts so frontend sees them immediately
      syncStatus.red.count = bulkStore.red.length;
      syncStatus.grey.count = bulkStore.grey.length;
      syncStatus.marten.count = bulkStore.marten.length;
      syncStatus.grey_trapping.count = bulkStore.grey_trapping.length;

      syncStatus.red.lastSync = tsNow;
      syncStatus.grey.lastSync = tsNow;
      syncStatus.marten.lastSync = tsNow;
      syncStatus.grey_trapping.lastSync = tsNow;

      console.log(`[Import] Local copy successfully uploaded. New counts: red=${bulkStore.red.length}, grey=${bulkStore.grey.length}, marten=${bulkStore.marten.length}, grey_trapping=${bulkStore.grey_trapping.length}`);

      res.json({
        success: true,
        message: "Database imported successfully!",
        counts: {
          red: bulkStore.red.length,
          grey: bulkStore.grey.length,
          marten: bulkStore.marten.length,
          grey_trapping: bulkStore.grey_trapping.length
        }
      });
    } catch (err: any) {
      console.error("[Import] Error loading local copy:", err);
      res.status(500).json({ error: "Failed to import database", message: err.message });
    }
  });

  // Global error handler for API routes
  app.use("/api", (err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error(`[API Error] ${req.method} ${req.url}:`, err);
    res.status(500).json({ 
      error: "Internal Server Error", 
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  });

  // Explicit 404 for missing API routes to avoid returning SPA HTML
  app.use("/api/*", (req, res) => {
    res.status(404).json({ error: "API route not found" });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }



    app.listen(PORT, "0.0.0.0", () => {
      console.log(`[Server] Squirrel Explorer API running on port ${PORT}`);
      console.log(`[Server] Health check: http://0.0.0.0:${PORT}/api/health`);
    });
  } catch (err) {
    console.error("[Server] Fatal error during startup:", err);
    process.exit(1);
  }
}

startServer();
