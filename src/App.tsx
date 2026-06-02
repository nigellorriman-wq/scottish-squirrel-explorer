import { useEffect, useState, useMemo, ChangeEvent, useRef } from 'react';
import { MapContainer, TileLayer, CircleMarker, Tooltip, ZoomControl, useMapEvents, Polygon, Marker, Pane } from 'react-leaflet';
import L from 'leaflet';
import { motion, AnimatePresence } from 'motion/react';
import { Filter, Calendar, Info, Layers, ChevronRight, ChevronLeft, MapPin, ZoomIn, Download, Upload, TrendingUp, BarChart3, Trash2, FileText, XCircle, Loader2, RefreshCw, Lock, Unlock, Database } from 'lucide-react';
import { Sighting } from './types';
import { SQUIRREL_GROUPS } from './groups_data';
import { generateSingleAreaReport } from './pdfReportGenerator';
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip as ChartTooltip, 
  ResponsiveContainer,
  Legend as ChartLegend
} from 'recharts';
import logo from './assets/images/cb_red_squirrel_network_logo_transparent_1779031828830.png';
import 'leaflet/dist/leaflet.css';
import { latLonToEastingNorthing, eastingNorthingToLatLon, get100kmSquareLetters, getContourColor } from './osGridUtils';

const SCOTTISH_BORDERS_CENTER: [number, number] = [55.5486, -2.7828];

// Color mapping for data sources
const SOURCE_COLORS: Record<string, string> = {
  "Saving Scotland's Red Squirrels": "#ef4444",
  "SSRS": "#ef4444",
  "iRecord": "#3b82f6",
  "Biological Records Centre (BRC)": "#10b981",
  "BTO": "#f59e0b",
  "Mammal Society": "#8b5cf6",
  "RSPB": "#06b6d4",
};

function getTemporalColor(dateStr: string | undefined, year: string): string {
  const startYear = 2000;
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  
  const totalMonths = (currentYear - startYear) * 12 + currentMonth;
  if (totalMonths <= 0) return '#ef4444';
  
  let sightingYear = parseInt(year);
  let sightingMonth = 0;
  
  if (dateStr) {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      sightingYear = d.getFullYear();
      sightingMonth = d.getMonth();
    }
  }
  
  const sightingMonthIndex = (sightingYear - startYear) * 12 + sightingMonth;
  const ratio = Math.max(0, Math.min(1, sightingMonthIndex / totalMonths));
  
  // Altitude-style gradient (Blue -> Cyan -> Green -> Yellow -> Red)
  if (ratio < 0.25) {
    const p = ratio / 0.25;
    return `rgb(0, ${Math.floor(p * 255)}, 255)`; // Blue to Cyan
  } else if (ratio < 0.5) {
    const p = (ratio - 0.25) / 0.25;
    return `rgb(0, 255, ${Math.floor(255 - p * 255)})`; // Cyan to Green
  } else if (ratio < 0.75) {
    const p = (ratio - 0.5) / 0.25;
    return `rgb(${Math.floor(p * 255)}, 255, 0)`; // Green to Yellow
  } else {
    const p = (ratio - 0.75) / 0.25;
    return `rgb(255, ${Math.floor(255 - p * 255)}, 0)`; // Yellow to Red
  }
}

function getSourceColor(source: string | undefined): string {
  if (!source) return "#78716c";
  
  const normalizedSource = source.toLowerCase();
  
  // Try exact matches first
  if (SOURCE_COLORS[source]) return SOURCE_COLORS[source];
  
  // Try substring matches for SSRS
  if (normalizedSource.includes("saving scotland") || normalizedSource.includes("ssrs")) {
    return "#ef4444";
  }

  // Check other defaults
  for (const [key, color] of Object.entries(SOURCE_COLORS)) {
    if (normalizedSource.includes(key.toLowerCase())) return color;
  }
  
  // Hash for other sources
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    hash = source.charCodeAt(i) + ((hash << 5) - hash);
  }
  return `hsl(${Math.abs(hash) % 360}, 70%, 50%)`;
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

// Map Event Controller for Distance and Bounds Calculation
function MapController({ 
  setBounds,
  setZoom
}: { 
  setBounds: (b: any) => void;
  setZoom: (z: number) => void;
}) {
  const map = useMapEvents({
    moveend: () => {
      const bounds = map.getBounds();
      setZoom(map.getZoom());
      setBounds({
        latMin: bounds.getSouth(),
        latMax: bounds.getNorth(),
        lonMin: bounds.getWest(),
        lonMax: bounds.getEast(),
      });
    }
  });

  useEffect(() => {
    const bounds = map.getBounds();
    setZoom(map.getZoom());
    setBounds({
      latMin: bounds.getSouth(),
      latMax: bounds.getNorth(),
      lonMin: bounds.getWest(),
      lonMax: bounds.getEast(),
    });
  }, [map]);

  return null;
}

function GroupZoomController({ selectedGroup }: { selectedGroup: string | null }) {
  const map = useMapEvents({});
  useEffect(() => {
    if (selectedGroup) {
      const groupData = SQUIRREL_GROUPS.find(g => g.name === selectedGroup);
      if (groupData && groupData.polygon.length > 0) {
        const lats = groupData.polygon.map(p => p[0]);
        const lons = groupData.polygon.map(p => p[1]);
        const bounds: [[number, number], [number, number]] = [
          [Math.min(...lats), Math.min(...lons)],
          [Math.max(...lats), Math.max(...lons)]
        ];
        map.fitBounds(bounds, { padding: [50, 50], animate: true });
      }
    }
  }, [selectedGroup, map]);
  return null;
}

export default function App() {
  const [sightings, setSightings] = useState<Sighting[]>([]);
  const [networkLoading, setNetworkLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [isDataProcessing, setIsDataProcessing] = useState(false);

  const [loadedParams, setLoadedParams] = useState<{
    species: string[];
    startYear: number;
    endYear: number;
    selectedGroup: string | null;
  }>({
    species: [],
    startYear: 0,
    endYear: 0,
    selectedGroup: null
  });

  const [isThinned, setIsThinned] = useState(false);
  const [totalRecords, setTotalRecords] = useState(0);
  const [species, setSpecies] = useState<('red' | 'grey' | 'grey_effort' | 'marten')[]>(['red']);
  const [startYear, setStartYear] = useState(2000);
  const [endYear, setEndYear] = useState(new Date().getFullYear());
  const [markerScale, setMarkerScale] = useState(1);
  const [markerShape, setMarkerShape] = useState<'circle' | 'square'>('circle');
  const [colorMode, setColorMode] = useState<'temporal' | 'solid'>('temporal');
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [showGroupOverlay, setShowGroupOverlay] = useState(false);
  const [fillGroupAreas, setFillGroupAreas] = useState(true);
  const [showTrappingCounts, setShowTrappingCounts] = useState(false);
  const [mapStyle, setMapStyle] = useState<'standard' | 'topo' | 'satellite'>('standard');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [distance, setDistance] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<any>(null);
  const [stopDisplayingDuringFetch, setStopDisplayingDuringFetch] = useState(true);
  const [syncStatusMap, setSyncStatusMap] = useState<Record<string, any>>({});
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [allowNbnSync, setAllowNbnSync] = useState(() => {
    const cached = localStorage.getItem('allowNbnSync');
    return cached === null ? true : cached === 'true';
  });

  // Firebase Storage Integration State
  const [firebaseStorageStatus, setFirebaseStorageStatus] = useState<{
    configured: boolean;
    bucketName: string;
    connectionOk: boolean;
    message: string;
    localGzExists: Record<string, number>;
    currentYear: number;
  } | null>(null);
  const [checkingFirebaseStorage, setCheckingFirebaseStorage] = useState(false);
  const [showStorageInstructions, setShowStorageInstructions] = useState(false);

  const checkFirebaseStorageStatus = async () => {
    setCheckingFirebaseStorage(true);
    try {
      const res = await fetch('/api/firebase-storage-status');
      if (res.ok) {
        const data = await res.json();
        setFirebaseStorageStatus(data);
      }
    } catch (err: any) {
      console.warn('Failed to check Firebase storage status:', err.message);
    } finally {
      setCheckingFirebaseStorage(false);
    }
  };
  
  // Scientific PDF Report Generation State Controls
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [pdfProgressIndex, setPdfProgressIndex] = useState(0);
  const [pdfProgressTotal, setPdfProgressTotal] = useState(0);
  const [pdfCurrentAreaName, setPdfCurrentAreaName] = useState('');
  const [pdfStatusText, setPdfStatusText] = useState('');
  const cancelPdfRef = useRef(false);

  const downloadedYearsRef = useRef<Set<string>>(new Set());
  const hasInitializedDownloadedYears = useRef(false);
  
  const lastSyncDate = useMemo(() => {
    const dates = Object.keys(syncStatusMap)
      .map(key => syncStatusMap[key]?.lastSync)
      .filter(Boolean);
    
    const targetDateStr = dates.reduce((latest, current) => {
      if (!latest) return current;
      return new Date(current) > new Date(latest) ? current : latest;
    }, "") || "2026-05-23T09:32:57Z";
    
    const date = new Date(targetDateStr);
    const day = date.getDate();
    const year = date.getFullYear();
    
    let daySuffix = 'th';
    if (day === 1 || day === 21 || day === 31) daySuffix = 'st';
    else if (day === 2 || day === 22) daySuffix = 'nd';
    else if (day === 3 || day === 23) daySuffix = 'rd';
    
    const monthNames = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"
    ];
    const month = monthNames[date.getMonth()];
    
    return `${day}${daySuffix} ${month} ${year}`;
  }, [syncStatusMap]);

  const [mapBounds, setMapBounds] = useState<any>(null);
  const [mapZoom, setMapZoom] = useState(10);
  const [populationTimeline, setPopulationTimeline] = useState<any[]>([]);
  const [loadingStats, setLoadingStats] = useState(false);

  const isUpToDate = useMemo(() => {
    // Check species match
    if (species.length !== loadedParams.species.length) return false;
    for (const s of species) {
      if (!loadedParams.species.includes(s)) return false;
    }
    // Check years
    if (startYear !== loadedParams.startYear) return false;
    if (endYear !== loadedParams.endYear) return false;
    // Check group
    if (selectedGroup !== loadedParams.selectedGroup) return false;
    
    return true;
  }, [species, startYear, endYear, selectedGroup, loadedParams]);

  const loading = !isUpToDate || networkLoading || actionLoading || isDataProcessing;

  const loadingRef = useRef(loading);
  loadingRef.current = loading;

  const isSyncingRef = useRef(isSyncing);
  isSyncingRef.current = isSyncing;

  const showFullscreenLoader = networkLoading || actionLoading || isDataProcessing;



  // Map tile providers
  const TILE_LAYERS = {
    standard: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    topo: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    satellite: "https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}"
  };

  const [debouncedRange, setDebouncedRange] = useState({ start: startYear, end: endYear });
  const [debouncedBounds, setDebouncedBounds] = useState<any>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedRange({ start: startYear, end: endYear });
    }, 400); 
    return () => clearTimeout(timer);
  }, [startYear, endYear]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedBounds(mapBounds);
    }, 500); 
    return () => clearTimeout(timer);
  }, [mapBounds]);

  useEffect(() => {
    setSightings([]); // Clear results immediately when parameters change to avoid stale 'No sightings' or markers
  }, [species, startYear, endYear]);

  const [syncTick, setSyncTick] = useState(0);

  useEffect(() => {
    let timer: any;
    if (isSyncing) {
      timer = setInterval(() => {
        setSyncTick(t => t + 1);
      }, 10000); // Pulse data update every 10s during sync
    }
    return () => clearInterval(timer);
  }, [isSyncing]);

  const handleLoadData = async () => {
    setNetworkLoading(true);
    setLoadingStats(true);
    setIsDataProcessing(true);
    try {
      // 1. Fetch sightings
      const results = await Promise.all(species.map(async (s) => {
        const params: Record<string, string> = {
          species: s,
          startYear: startYear.toString(),
          endYear: endYear.toString(),
        };

        if (selectedGroup) {
          params.groupName = selectedGroup;
        }

        const query = new URLSearchParams(params);
        try {
          const response = await fetch(`/api/sightings?${query}`);
          if (!response.ok) {
            console.warn(`[Sightings] Fetch warning: HTTP status ${response.status} for ${s}`);
            return { occurrences: [], total: 0, thinned: false };
          }
          
          const contentType = response.headers.get("content-type");
          if (!contentType || !contentType.includes("application/json")) {
            console.warn(`[Sightings] Fetch warning: received non-JSON response for ${s}`);
            return { occurrences: [], total: 0, thinned: false };
          }

          const data = await response.json();
          return {
            occurrences: (data.occurrences || []).map((occ: any) => ({ ...occ, speciesType: s })),
            total: data.total || 0,
            thinned: data.thinned || false
          };
        } catch (e: any) {
          console.warn(`[Sightings] Transient network/parse error for ${s}:`, e.message);
          return { occurrences: [], total: 0, thinned: false };
        }
      }));

      const mergedOccurrences = results.flatMap(r => r.occurrences);
      const mergedTotal = results.reduce((sum, r) => sum + r.total, 0);
      const mergedThinned = results.some(r => r.thinned);

      setSightings(mergedOccurrences);
      setTotalRecords(mergedTotal);
      setIsThinned(mergedThinned);

      // 2. Fetch population stats in parallel
      try {
        const params: Record<string, string> = {
          startYear: startYear.toString(),
          endYear: endYear.toString(),
        };
        if (selectedGroup) {
          params.groupName = selectedGroup;
        }
        const query = new URLSearchParams(params);
        const res = await fetch(`/api/population-stats?${query}`);
        if (res.ok) {
          const contentType = res.headers.get("content-type");
          if (contentType && contentType.includes("application/json")) {
            const data = await res.json();
            setPopulationTimeline(data);
          }
        }
      } catch (err: any) {
        console.warn("Stats fetch warning:", err.message);
      }

      // Record the exact configuration successfully loaded into local state
      setLoadedParams({
        species: [...species],
        startYear: startYear,
        endYear: endYear,
        selectedGroup: selectedGroup
      });

      // Keep loader on screen briefly to allow Leaflet and Recharts rendering to display fully
      await new Promise(resolve => setTimeout(resolve, 800));
    } catch (error) {
      console.warn('Fetch error:', error);
    } finally {
      setNetworkLoading(false);
      setLoadingStats(false);
      setIsDataProcessing(false);
    }
  };

  useEffect(() => {
    // Only fetch automatically on first mount (to show initially selected species) or during background sync
    if (loadedParams.species.length === 0 || isSyncing) {
      handleLoadData();
    }
  }, [isSyncing, syncTick]);

  const downloadYearFile = async (species: string, year: number) => {
    try {
      console.log(`[Browser Download] Initiating download for ${species}_${year}.json`);
      const response = await fetch(`/api/download-year-file?species=${species}&year=${year}`);
      if (!response.ok) {
        throw new Error(`Failed to download ${species} ${year}`);
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${species}_${year}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error(`Download error for ${species}_${year}:`, error);
    }
  };

  useEffect(() => {
    let interval: any;
    
    const checkStatus = async () => {
      try {
        const res = await fetch('/api/sync-status');
        if (!res.ok) {
          console.warn(`[Sync Status] Fetch warning: HTTP status ${res.status}`);
          return;
        }
        
        const contentType = res.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) {
          console.warn(`[Sync Status] Fetch warning: received non-JSON response`);
          return;
        }

        const data = await res.json();
        
        if (data && typeof data === 'object') {
          setSyncStatusMap(data);

          const speciesList = ['red', 'grey', 'marten', 'grey_trapping'];

          if (!hasInitializedDownloadedYears.current) {
            speciesList.forEach(s => {
              const completed = data[s]?.completedYears || [];
              completed.forEach((y: number) => {
                downloadedYearsRef.current.add(`${s}_${y}`);
              });
            });
            hasInitializedDownloadedYears.current = true;
          } else {
            // Trigger automatic browser downloads for newly completed years
            speciesList.forEach(s => {
              const completed = data[s]?.completedYears || [];
              completed.forEach((y: number) => {
                const key = `${s}_${y}`;
                if (!downloadedYearsRef.current.has(key)) {
                  downloadedYearsRef.current.add(key);
                  downloadYearFile(s, y);
                }
              });
            });
          }
          
          const redLoading = data.red?.isLoading || false;
          const greyLoading = data.grey?.isLoading || false;
          const martenLoading = data.marten?.isLoading || false;
          const greyTrappingLoading = data.grey_trapping?.isLoading || false;
          const currentlyLoading = redLoading || greyLoading || martenLoading || greyTrappingLoading;
          
          let activeS = null;
          let activeSpeciesName = "";
          if (redLoading) {
            activeS = data.red;
            activeSpeciesName = "Red Squirrels";
          } else if (greyLoading) {
            activeS = data.grey;
            activeSpeciesName = "Grey Squirrels";
          } else if (martenLoading) {
            activeS = data.marten;
            activeSpeciesName = "Pine Martens";
          } else if (greyTrappingLoading) {
            activeS = data.grey_trapping;
            activeSpeciesName = "Grey Trapping";
          }

          if (activeS) {
            const aggregateProgress = {
              count: (data.red?.count || 0) + (data.grey?.count || 0) + (data.marten?.count || 0) + (data.grey_trapping?.count || 0),
              totalEstimated: (data.red?.totalEstimated || 0) + (data.grey?.totalEstimated || 0) + (data.marten?.totalEstimated || 0) + (data.grey_trapping?.totalEstimated || 0),
              isLoading: true,
              phase: activeS.phase,
              currentYear: activeS.currentYear,
              speciesName: activeSpeciesName
            };
            setSyncProgress(aggregateProgress);
          } else {
            setSyncProgress(null);
          }
          
          setIsSyncing(currentlyLoading);
        }
      } catch (err: any) {
        console.warn('Sync status check warning:', err.message);
      }
    };

    checkStatus();
    interval = setInterval(checkStatus, 3000); // Polling every 3s keeps the client updated organically
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    checkFirebaseStorageStatus();
  }, []);

  // Memoized Map Markers to prevent re-renders during map move/sidebar toggle
  const filteredSightings = useMemo(() => {
    if (isSyncing && stopDisplayingDuringFetch) {
      return [];
    }
    if (!selectedGroup) return sightings;
    const group = SQUIRREL_GROUPS.find(g => g.name === selectedGroup);
    if (!group) return sightings;
    
    return sightings.filter(s => {
      const lat = parseFloat(s.decimalLatitude);
      const lon = parseFloat(s.decimalLongitude);
      const sType = (s as any).speciesType;
      if (sType === 'grey_effort' || s.isTrapping) {
        return isSquarePartiallyInPolygon(lat, lon, group.polygon as [number, number][]);
      }
      return isPointInPolygon(lat, lon, group.polygon as [number, number][]);
    });
  }, [sightings, selectedGroup, isSyncing, stopDisplayingDuringFetch]);

  const { aggregatedSquares, maxCount } = useMemo(() => {
    const squares: Record<string, {
      easting: number;
      northing: number;
      count: number;
      records: any[];
      corners: [number, number][];
    }> = {};

    filteredSightings.forEach(s => {
      const sType = (s as any).speciesType;
      if (sType !== 'grey_effort' && !(sType === 'grey' && s.isTrapping)) return;

      const lat = parseFloat(s.decimalLatitude);
      const lon = parseFloat(s.decimalLongitude);
      if (isNaN(lat) || isNaN(lon)) return;

      const { Easting, Northing } = latLonToEastingNorthing(lat, lon);
      const E_sw = Math.floor(Easting / 5000) * 5000;
      const N_sw = Math.floor(Northing / 5000) * 5000;
      
      const key = `${E_sw}_${N_sw}`;
      const count = (s as any).recordCount || 1;

      if (!squares[key]) {
        const sw = eastingNorthingToLatLon(E_sw, N_sw);
        const se = eastingNorthingToLatLon(E_sw + 5000, N_sw);
        const ne = eastingNorthingToLatLon(E_sw + 5000, N_sw + 5000);
        const nw = eastingNorthingToLatLon(E_sw, N_sw + 5000);

        squares[key] = {
          easting: E_sw,
          northing: N_sw,
          count: 0,
          records: [],
          corners: [
            [sw.lat, sw.lon],
            [se.lat, se.lon],
            [ne.lat, ne.lon],
            [nw.lat, nw.lon]
          ]
        };
      }

      squares[key].count += count;
      squares[key].records.push(s);
    });

    const squareList = Object.values(squares);
    const maxVal = Math.max(1, ...squareList.map(s => s.count));
    return { aggregatedSquares: squareList, maxCount: maxVal };
  }, [filteredSightings]);

  const markerLayers = useMemo(() => {
    return filteredSightings
      .filter(sighting => {
        const sType = (sighting as any).speciesType;
        return sType !== 'grey_effort' && !(sType === 'grey' && sighting.isTrapping);
      })
      .map((sighting, index) => {
        const sType = (sighting as any).speciesType;
      
      // Force label if it's trapping effort
      const label = (sType === 'grey_effort' || sighting.isTrapping) ? 'Grey Squirrel Trapping' : (sighting.raw_commonName || (sType === 'red' ? 'Red Squirrel' : sType === 'grey' ? 'Grey Squirrel' : 'Pine Marten'));

      if (sType === 'grey_effort' || (sType === 'grey' && sighting.isTrapping)) {
        // Render as a square using Marker + divIcon
        const count = (sighting as any).recordCount || 1;
        const size = Math.max(12, 8 * markerScale);
        
        const icon = L.divIcon({
          className: 'trapping-marker-square',
          iconSize: [size, size],
          iconAnchor: [size/2, size/2],
          html: `<div style="width:${size}px; height:${size}px; background-color:#fab005; border:2px solid #c48a04; display:flex; align-items:center; justify-content:center; color:#78350f; font-size:${Math.max(7, size/2.2)}px; font-weight:900; font-family:sans-serif;">${count > 1 ? count : ''}</div>`
        });

        return (
          <Marker
            key={`${sighting.id}-${index}`}
            position={[parseFloat(sighting.decimalLatitude), parseFloat(sighting.decimalLongitude)]}
            icon={icon}
            zIndexOffset={1000}
          >
            <Tooltip direction="top" offset={[0, -5]} opacity={1}>
              <div className="font-sans px-2 py-1 min-w-[120px]">
                <p className="font-bold text-stone-900 border-b border-stone-100 mb-1 pb-1">
                  {label}
                  <span className="ml-2 px-1 bg-amber-100 text-amber-700 text-[8px] rounded uppercase font-bold tracking-tighter">Trapping Effort</span>
                </p>
                <div className="flex justify-between items-center text-[10px] text-stone-500 font-semibold mb-1">
                  <span>RECORDS</span>
                  <span className="text-amber-700 font-bold">{count}</span>
                </div>
                <div className="flex justify-between items-center text-[10px] text-stone-500 font-semibold mb-1">
                  <span>LAST ACTIVITY</span>
                  <span className="text-stone-900">{sighting.year}</span>
                </div>
                {sighting.occurrenceDate && (
                  <div className="flex justify-between items-center text-[10px] text-stone-500 font-semibold mb-1">
                    <span>DATE</span>
                    <span className="text-stone-900">{new Date(sighting.occurrenceDate).toLocaleDateString()}</span>
                  </div>
                )}
                {sighting.dataResourceName && (
                  <div className="pt-1 mt-1 border-t border-stone-100">
                    <p className="text-[8px] text-stone-400 font-bold uppercase tracking-tighter mb-0.5">DATA PROVIDER</p>
                    <p className="text-[10px] text-stone-600 font-medium leading-tight">{sighting.dataResourceName}</p>
                  </div>
                )}
              </div>
            </Tooltip>
          </Marker>
        );
      }

      return (
        <CircleMarker
          key={`${sighting.id}-${index}`}
          center={[parseFloat(sighting.decimalLatitude), parseFloat(sighting.decimalLongitude)]}
          radius={4 * markerScale}
          pathOptions={{
            fillColor: colorMode === 'temporal' 
              ? getTemporalColor(sighting.occurrenceDate, sighting.year.toString()) 
              : (sType === 'red' ? '#dc2626' : sType === 'grey' ? '#78716c' : sType === 'grey_effort' ? '#eab308' : '#713f12'),
            color: sType === 'red' ? '#dc2626' : sType === 'grey' ? '#78716c' : sType === 'grey_effort' ? '#eab308' : '#713f12',
            weight: (sType === 'marten' || sType === 'grey_effort') ? 4 : 2.5, 
            opacity: 1,
            fillOpacity: 0.9,
            stroke: true
          }}
          className={markerShape === 'square' ? 'leaflet-marker-square' : ''}
        >
          <Tooltip direction="top" offset={[0, -5]} opacity={1}>
            <div className="font-sans px-2 py-1 min-w-[120px]">
              <p className="font-bold text-stone-900 border-b border-stone-100 mb-1 pb-1">
                {label}
                {sighting.isTrapping && <span className="ml-2 px-1 bg-amber-100 text-amber-700 text-[8px] rounded uppercase font-bold tracking-tighter">Trapping Effort</span>}
              </p>
              <div className="flex justify-between items-center text-[10px] text-stone-500 font-semibold mb-1">
                <span>YEAR</span>
                <span className="text-stone-900">{sighting.year}</span>
              </div>
              {sighting.occurrenceDate && (
                <>
                  <div className="flex justify-between items-center text-[10px] text-stone-500 font-semibold mb-1">
                    <span>MONTH</span>
                    <span className="text-stone-900">
                      {new Date(sighting.occurrenceDate).toLocaleString('default', { month: 'long' })}
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-[10px] text-stone-500 font-semibold mb-1">
                    <span>FULL DATE</span>
                    <span className="text-stone-900">{new Date(sighting.occurrenceDate).toLocaleDateString()}</span>
                  </div>
                </>
              )}
              {sighting.dataResourceName && (
                <div className="pt-1 mt-1 border-t border-stone-100">
                  <p className="text-[8px] text-stone-400 font-bold uppercase tracking-tighter mb-0.5">DATA PROVIDER</p>
                  <p className="text-[10px] text-stone-600 font-medium leading-tight">{sighting.dataResourceName}</p>
                </div>
              )}
            </div>
          </Tooltip>
        </CircleMarker>
      );
    });
  }, [sightings, markerScale, markerShape, colorMode]);

  const refreshData = async () => {
    setActionLoading(true);
    setIsSyncing(true);
    setSightings([]); // Clear existing data to avoid stale overlay
    try {
      // Trigger sync for all species
      await fetch(`/api/force-refresh?species=red`);
      await fetch(`/api/force-refresh?species=grey`);
      await fetch(`/api/force-refresh?species=marten`);
      await fetch(`/api/force-refresh?species=grey_trapping`);
      
      // The polling will handle the rest
    } catch (err) {
      console.error('Refresh error:', err);
      setIsSyncing(false);
    } finally {
      setActionLoading(false);
    }
  };

  const cancelSync = async () => {
    if (!confirmCancel) {
      setConfirmCancel(true);
      setTimeout(() => {
        setConfirmCancel(false);
      }, 4000);
      return;
    }

    setConfirmCancel(false);
    try {
      setActionLoading(true);
      const res = await fetch('/api/cancel-sync', { method: 'POST' });
      if (res.ok) {
        setIsSyncing(false);
        setSightings([]);
        downloadedYearsRef.current.clear();
        hasInitializedDownloadedYears.current = false;
        
        // Fetch fresh state immediately to update UI
        const statusRes = await fetch('/api/sync-status');
        if (statusRes.ok) {
          const statusData = await statusRes.json();
          setSyncStatusMap(statusData);
          setSyncProgress(null);
        }
      }
    } catch (err) {
      console.error('Cancel sync error:', err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleDownload = async (type: 'json' | 'csv') => {
    try {
      const endpoint = type === 'json' ? '/api/export' : '/api/stats-csv';
      const response = await fetch(endpoint);
      if (!response.ok) throw new Error('Download failed');
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      
      // Try to extract filename from header if possible, otherwise use default
      const contentDisposition = response.headers.get('Content-Disposition');
      let filename = type === 'json' ? 'squirrel_database.json' : 'squirrel_sources.csv';
      if (contentDisposition) {
        const match = contentDisposition.match(/filename=(.+)/);
        if (match) filename = match[1].replace(/"/g, '');
      }
      
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      console.error('Download error:', err);
      alert('Failed to download file. Please try again.');
    }
  };

  const handleGeneratePdfReports = async (mode: 'all' | 'selected') => {
    setIsGeneratingPdf(true);
    cancelPdfRef.current = false;
    setPdfProgressIndex(0);
    setPdfStatusText('Preparing data...');

    const targets = mode === 'selected' && selectedGroup
      ? SQUIRREL_GROUPS.filter(g => g.name === selectedGroup)
      : SQUIRREL_GROUPS;

    setPdfProgressTotal(targets.length);

    try {
      // Wait for any active background synchronization to finish completely before generating report
      let isWaiting = true;
      while (isWaiting) {
        if (cancelPdfRef.current) break;
        
        // Fetch current sync status from backend
        const syncRes = await fetch('/api/sync-status').catch(() => null);
        let activeSyncing = false;
        if (syncRes && syncRes.ok) {
          const syncStatus = await syncRes.json();
          activeSyncing = Object.values(syncStatus).some((s: any) => s && s.isLoading === true);
        }
        
        if (!activeSyncing && !isSyncingRef.current && !loadingRef.current) {
          isWaiting = false;
        } else {
          setPdfStatusText('Waiting for App to finish loading and synchronizing all area records...');
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      if (cancelPdfRef.current) {
        setPdfStatusText('PDF generation cancelled.');
        return;
      }

      // 1. Fetch full un-thinned dataset for the date range
      setPdfStatusText('Fetching scientific datasets across all species...');
      const speciesQuery = ['red', 'grey', 'marten', 'grey_effort'].map(s => `species=${s}`).join('&');
      const response = await fetch(`/api/sightings?${speciesQuery}&startYear=${startYear}&endYear=${endYear}&zoom=14`);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch database: server returned status ${response.status}`);
      }
      
      const data = await response.json();
      const occurrences = data.occurrences || [];

      setPdfStatusText(`Analyzing ${occurrences.length.toLocaleString()} records...`);

      // 2. Process each target area sequentially
      for (let i = 0; i < targets.length; i++) {
        if (cancelPdfRef.current) {
          setPdfStatusText('PDF generation cancelled.');
          break;
        }

        const area = targets[i];
        setPdfProgressIndex(i + 1);
        setPdfCurrentAreaName(area.name);
        setPdfStatusText(`Modeling grids & drawing page vectors for: ${area.name}`);

        // Wait a tiny bit to allow UI to render the progress smoothly and prevent blocking the main JS thread
        await new Promise(resolve => setTimeout(resolve, 150));

        if (cancelPdfRef.current) {
          setPdfStatusText('PDF generation cancelled.');
          break;
        }

        // Generate the PDF
        const doc = await generateSingleAreaReport(area.name, startYear, endYear, occurrences);
        
        // Save/download the PDF using exact target area name verbatim (avoid slugified names)
        doc.save(`${area.name} Sighting & Trapping Report (${startYear}-${endYear}).pdf`);
      }

      if (!cancelPdfRef.current) {
        setPdfStatusText('Successfully completed all PDF downloads!');
      }
    } catch (err: any) {
      console.error(err);
      setPdfStatusText(`Error generating PDF: ${err.message}`);
    } finally {
      // Keep state visible for a couple of seconds so user sees final status, then reset
      setTimeout(() => {
        setIsGeneratingPdf(false);
      }, 3000);
    }
  };

  const handleLocalImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setActionLoading(true);
    try {
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsText(file);
      });

      // Simple frontend verification
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        throw new Error('Invalid JSON format. Please ensure you are loading a valid exported JSON database file.');
      }

      const hasRed = Array.isArray(parsed.red);
      const hasGrey = Array.isArray(parsed.grey);
      const hasMarten = Array.isArray(parsed.marten);

      if (!hasRed && !hasGrey && !hasMarten) {
        throw new Error('Invalid database structure. The file must contain red, grey, or marten records.');
      }

      const response = await fetch('/api/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: text
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || 'Failed to import the local copy.');
      }

      const result = await response.json();
      alert(result.message || 'Database imported successfully! The page will now reload to display the imported local copy data.');
      window.location.reload();
    } catch (err: any) {
      console.error('Import error:', err);
      alert(err.message || 'An error occurred during import.');
    } finally {
      setActionLoading(false);
      e.target.value = '';
    }
  };

  return (
    <div className="h-screen flex flex-col bg-stone-50 overflow-hidden font-sans text-stone-900">
      {/* Header */}
      <header className="h-16 border-b border-stone-200 bg-white/80 backdrop-blur-md flex items-center justify-between px-6 shrink-0 z-30">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-lg font-bold text-stone-900 leading-tight">Scottish Squirrel Explorer</h1>
            <p className="text-[10px] text-stone-500 uppercase tracking-widest font-semibold italic flex items-center gap-2">
              <span>Central Borders Red Squirrel Network</span>
              <span className="text-stone-300 font-normal">|</span>
              <span className="text-stone-600 font-bold normal-case not-italic">Data current at {lastSyncDate}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <AnimatePresence>
            {isSyncing && syncProgress && (
              <motion.div 
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                className="flex flex-col items-end gap-1"
              >
                <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 rounded-lg text-[10px] font-bold text-amber-600 uppercase tracking-widest border border-amber-200">
                   <div className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-bounce" />
                   <span>
                     {syncProgress.phase}
                     {syncProgress.currentYear && ` (${syncProgress.currentYear})`}
                   </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-stone-500 font-mono">
                    {syncProgress.count.toLocaleString()} / {syncProgress.totalEstimated.toLocaleString()}
                  </span>
                  {syncProgress.totalEstimated > 0 && (
                    <div className="w-24 h-1 bg-stone-200 rounded-full overflow-hidden">
                      <motion.div 
                        className="h-full bg-amber-500" 
                        initial={{ width: 0 }}
                        animate={{ width: `${Math.min(100, (syncProgress.count / syncProgress.totalEstimated) * 100)}%` }}
                      />
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <div className="flex items-center gap-2 px-3 py-1.5 bg-stone-100 rounded-full text-xs font-medium text-stone-600 border border-stone-200">
            <div className={`w-2 h-2 rounded-full ${
              (networkLoading || actionLoading || isDataProcessing) 
                ? 'bg-amber-500 animate-pulse' 
                : !isUpToDate 
                  ? 'bg-amber-400 animate-pulse' 
                  : 'bg-green-500'
            }`} />
            <span className="font-mono text-[10px] uppercase font-bold tracking-wider">
              {networkLoading || actionLoading || isDataProcessing 
                ? 'LOADING...' 
                : !isUpToDate 
                  ? 'LOAD DATA REQUIRED' 
                  : isThinned 
                    ? `SHOWING ${filteredSightings.length.toLocaleString()} OF ${totalRecords.toLocaleString()} RECORDS` 
                    : `${filteredSightings.length.toLocaleString()} RECORDS`
              }
            </span>
          </div>
        </div>
      </header>

      <div className="flex-1 relative flex overflow-hidden">
        {/* Sidebar */}
        <AnimatePresence mode="wait">
          {isSidebarOpen && (
            <motion.aside
              initial={{ x: -320 }}
              animate={{ x: 0 }}
              exit={{ x: -320 }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="w-80 bg-white border-r border-stone-200 flex flex-col z-20 shadow-xl"
            >
              <div className="p-6 flex-1 overflow-y-auto space-y-8">
                {/* Species Toggle */}
                <div>
                  <h3 className="text-xs font-bold text-stone-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                    <Filter className="w-3 h-3" /> Species Filter
                  </h3>
              <div className="grid grid-cols-2 gap-2 bg-stone-100 p-1 rounded-2xl">
                    <button
                      onClick={() => {
                        setSpecies(prev => {
                          if (prev.includes('red')) {
                            if (prev.length === 1) return prev;
                            return prev.filter(s => s !== 'red');
                          }
                          return [...prev, 'red'];
                        });
                      }}
                      className={`py-2.5 rounded-xl text-[10px] font-bold transition-all uppercase tracking-tight ${
                        species.includes('red') 
                        ? 'bg-red-600 text-white shadow-md' 
                        : 'bg-white text-stone-500 hover:text-stone-700'
                      }`}
                    >
                      Red
                    </button>
                    <button
                      onClick={() => {
                        setSpecies(prev => {
                          if (prev.includes('grey')) {
                            if (prev.length === 1) return prev;
                            return prev.filter(s => s !== 'grey');
                          }
                          return [...prev, 'grey'];
                        });
                      }}
                      className={`py-2.5 rounded-xl text-[10px] font-bold transition-all uppercase tracking-tight ${
                        species.includes('grey') 
                        ? 'bg-stone-500 text-white shadow-md' 
                        : 'bg-white text-stone-500 hover:text-stone-700'
                      }`}
                    >
                      Grey
                    </button>
                    <button
                      onClick={() => {
                        setSpecies(prev => {
                          if (prev.includes('grey_effort')) {
                            if (prev.length === 1) return prev;
                            return prev.filter(s => s !== 'grey_effort');
                          }
                          return [...prev, 'grey_effort'];
                        });
                      }}
                      className={`py-2.5 rounded-xl text-[10px] font-bold transition-all uppercase tracking-tight ${
                        species.includes('grey_effort') 
                        ? 'bg-yellow-500 text-white shadow-md' 
                        : 'bg-white text-stone-500 hover:text-stone-700'
                      }`}
                    >
                      Grey (Trapping)
                    </button>
                    <button
                      onClick={() => {
                        setSpecies(prev => {
                          if (prev.includes('marten')) {
                            if (prev.length === 1) return prev;
                            return prev.filter(s => s !== 'marten');
                          }
                          return [...prev, 'marten'];
                        });
                      }}
                      className={`py-2.5 rounded-xl text-[10px] font-bold transition-all uppercase tracking-tight ${
                        species.includes('marten') 
                        ? 'bg-[#713f12] text-white shadow-md' 
                        : 'bg-white text-stone-500 hover:text-stone-700'
                      }`}
                    >
                      Marten
                    </button>
                  </div>
                  {species.includes('grey_effort') && (
                    <div className="mt-4 flex items-center justify-between px-1">
                      <label className="text-[10px] font-bold text-stone-500 uppercase tracking-wider font-semibold">Show Grid Numbers</label>
                      <button
                        onClick={() => setShowTrappingCounts(!showTrappingCounts)}
                        className={`w-10 h-5 rounded-full transition-colors relative cursor-pointer ${showTrappingCounts ? 'bg-yellow-500' : 'bg-stone-300'}`}
                      >
                        <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${showTrappingCounts ? 'left-6' : 'left-1'}`} />
                      </button>
                    </div>
                  )}
                </div>

                {/* Recovery Network Groups */}
                <div className="space-y-4 pt-2 border-t border-stone-100">
                  <h3 className="text-xs font-bold text-stone-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                    <MapPin className="w-3 h-3" /> Recovery Network
                  </h3>
                  
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <label className="text-[10px] font-bold text-stone-500 uppercase tracking-wider">Show Area Overlays</label>
                      <button
                        onClick={() => setShowGroupOverlay(!showGroupOverlay)}
                        className={`w-10 h-5 rounded-full transition-colors relative ${showGroupOverlay ? 'bg-amber-500' : 'bg-stone-300'}`}
                      >
                        <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${showGroupOverlay ? 'left-6' : 'left-1'}`} />
                      </button>
                    </div>

                    <AnimatePresence>
                      {showGroupOverlay && (
                        <motion.div 
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          className="flex items-center justify-between"
                        >
                          <label className="text-[10px] font-bold text-stone-500 uppercase tracking-wider pl-2 border-l-2 border-amber-100 italic">Infill Areas</label>
                          <button
                            onClick={() => setFillGroupAreas(!fillGroupAreas)}
                            className={`w-8 h-4 rounded-full transition-colors relative ${fillGroupAreas ? 'bg-amber-400' : 'bg-stone-300'}`}
                          >
                            <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all ${fillGroupAreas ? 'left-[18px]' : 'left-[2px]'}`} />
                          </button>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    <div className="space-y-2">
                      <label className="text-[10px] font-bold text-stone-500 uppercase tracking-wider">Filter by Group Area</label>
                      <select
                        value={selectedGroup || ''}
                        onChange={(e) => setSelectedGroup(e.target.value || null)}
                        className="w-full bg-stone-50 border border-stone-200 rounded-xl px-3 py-2.5 text-xs font-semibold text-stone-700 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                      >
                        <option value="">All Areas (No Filter)</option>
                        {SQUIRREL_GROUPS.slice().sort((a, b) => a.name.localeCompare(b.name)).map((g, idx) => (
                          <option key={idx} value={g.name}>{g.name}</option>
                        ))}
                      </select>
                      {selectedGroup && (
                        <button 
                          onClick={() => setSelectedGroup(null)}
                          className="text-[9px] font-bold text-red-500 uppercase tracking-widest hover:text-red-600 transition-colors"
                        >
                          Clear Group Filter
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Date Range */}
                <div className="space-y-4">
                  <h3 className="text-xs font-bold text-stone-400 uppercase tracking-widest mb-4 flex items-center gap-2 border-b border-stone-100 pb-2">
                    <Calendar className="w-3 h-3" /> Time Period
                  </h3>
                  <div className="space-y-6">
                    <div className="space-y-3">
                      <div className="flex justify-between items-center">
                        <label className="text-xs font-semibold text-stone-600 uppercase tracking-wide">Start Year</label>
                        <span className="text-sm font-mono font-bold bg-stone-100 px-2 py-0.5 rounded text-stone-900">{startYear}</span>
                      </div>
                      <input 
                        type="range" 
                        min="2008" 
                        max={new Date().getFullYear()} 
                        value={startYear} 
                        onChange={(e) => setStartYear(parseInt(e.target.value))}
                        className="w-full h-1.5 bg-stone-200 rounded-lg appearance-none cursor-pointer accent-red-600"
                      />
                    </div>
                    <div className="space-y-3">
                      <div className="flex justify-between items-center">
                        <label className="text-xs font-semibold text-stone-600 uppercase tracking-wide">End Year</label>
                        <span className="text-sm font-mono font-bold bg-stone-100 px-2 py-0.5 rounded text-stone-900">{endYear}</span>
                      </div>
                      <input 
                        type="range" 
                        min="2008" 
                        max={new Date().getFullYear()} 
                        value={endYear} 
                        onChange={(e) => setEndYear(parseInt(e.target.value))}
                        className="w-full h-1.5 bg-stone-200 rounded-lg appearance-none cursor-pointer accent-red-600"
                      />
                    </div>
                  </div>
                </div>

                {/* Load Selected Data Button */}
                <div className="space-y-3 pt-4 border-t border-stone-100">
                  <button
                    onClick={handleLoadData}
                    disabled={isDataProcessing || networkLoading}
                    className={`w-full py-3 rounded-2xl text-xs font-bold transition-all flex items-center justify-center gap-2 tracking-wide shadow-xs cursor-pointer ${
                      !isUpToDate 
                        ? 'bg-amber-600 hover:bg-amber-700 text-white animate-pulse border border-amber-500' 
                        : 'bg-stone-100 text-stone-500 hover:text-stone-700 hover:bg-stone-200 border border-stone-200 shadow-none'
                    }`}
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isDataProcessing || networkLoading ? 'animate-spin' : ''}`} />
                    {!isUpToDate ? 'LOAD SELECTED DATA' : 'DATA IS UP-TO-DATE'}
                  </button>
                  {!isUpToDate && (
                    <p className="text-[10px] text-amber-700 font-semibold leading-relaxed text-center bg-amber-50/70 p-2.5 rounded-xl border border-amber-200/50 flex flex-col gap-1 items-center justify-center animate-bounce">
                      <span className="text-[9px] uppercase tracking-wider font-extrabold text-amber-800">UNSAVED CHANGES</span>
                      <span>Click standard load button to refresh maps & timeline trends.</span>
                    </p>
                  )}
                </div>

                {/* Population Reports */}
                <div className="space-y-4 pt-4 border-t border-stone-100">
                  <h3 className="text-xs font-bold text-stone-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                    <TrendingUp className="w-3 h-3" /> Area Trends
                  </h3>
                  
                  <div className="h-40 w-full bg-stone-50 rounded-xl p-2 border border-stone-100 flex flex-col relative">
                    {loadingStats && (
                      <div className="absolute inset-0 bg-white/50 backdrop-blur-[1px] flex items-center justify-center z-10 transition-opacity">
                        <div className="w-4 h-4 border-2 border-stone-400 border-t-transparent rounded-full animate-spin" />
                      </div>
                    )}
                    
                    {(() => {
                      const chartTimelineData = populationTimeline.map((item) => ({
                        ...item,
                        _orig_red: item.red,
                        _orig_grey: item.grey,
                        _orig_grey_effort: item.grey_effort,
                        _orig_marten: item.marten,
                        red: item.red > 0 ? item.red : 1,
                        grey: item.grey > 0 ? item.grey : 1,
                        grey_effort: item.grey_effort > 0 ? item.grey_effort : 1,
                        marten: (item.marten || 0) > 0 ? item.marten : 1,
                      }));
                      return (
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={chartTimelineData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e7e5e4" />
                            <XAxis 
                              dataKey="year" 
                              fontSize={9} 
                              tickLine={false} 
                              axisLine={false} 
                              tick={{ fill: '#a8a29e' }}
                            />
                            <YAxis 
                              scale="log"
                              domain={[1, 'auto']}
                              allowDataOverflow={true}
                              fontSize={9} 
                              tickLine={false} 
                              axisLine={false} 
                              tick={{ fill: '#a8a29e' }}
                              tickFormatter={(val) => val.toLocaleString()}
                            />
                            <ChartTooltip 
                              contentStyle={{ 
                                fontSize: '10px', 
                                borderRadius: '8px', 
                                border: 'none', 
                                boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                                padding: '8px'
                              }} 
                              formatter={(value: any, name: any, entry: any) => {
                                const key = entry.dataKey;
                                const originalValue = entry.payload[`_orig_${key}`];
                                const displayVal = originalValue !== undefined ? originalValue : value;
                                return [displayVal.toLocaleString(), name];
                              }}
                            />
                            <Line type="monotone" dataKey="red" name="Red" stroke="#ef4444" strokeWidth={2} dot={{ r: 2 }} activeDot={{ r: 4 }} />
                            <Line type="monotone" dataKey="grey" name="Grey" stroke="#78716c" strokeWidth={2} dot={{ r: 2 }} activeDot={{ r: 4 }} />
                            <Line type="monotone" dataKey="grey_effort" name="Grey Trapping" stroke="#eab308" strokeWidth={2} strokeDasharray="5 5" dot={{ r: 2 }} activeDot={{ r: 4 }} />
                            <Line type="monotone" dataKey="marten" name="Marten" stroke="#713f12" strokeWidth={2} dot={{ r: 2 }} activeDot={{ r: 4 }} />
                          </LineChart>
                        </ResponsiveContainer>
                      );
                    })()}
                  </div>
                  
                  <div className="grid grid-cols-4 gap-2 px-1 text-center">
                    <div className="flex flex-col">
                      <span className="text-[8px] text-stone-400 font-bold uppercase tracking-wider">Red</span>
                      <span className="text-xs font-bold text-red-600">
                        {populationTimeline.reduce((sum, d) => sum + d.red, 0).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[8px] text-stone-400 font-bold uppercase tracking-wider">Grey</span>
                      <span className="text-xs font-bold text-stone-900">
                        {populationTimeline.reduce((sum, d) => sum + d.grey, 0).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[8px] text-stone-400 font-bold uppercase tracking-wider">Grey Trapping</span>
                      <span className="text-xs font-bold text-yellow-600">
                        {populationTimeline.reduce((sum, d) => sum + d.grey_effort, 0).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[8px] text-stone-400 font-bold uppercase tracking-wider">Marten</span>
                      <span className="text-xs font-bold text-[#713f12]">
                        {populationTimeline.reduce((sum, d) => (sum + (d.marten || 0)), 0).toLocaleString()}
                      </span>
                    </div>
                  </div>
                  
                  {populationTimeline.length > 2 && (
                    <div className="bg-stone-50 rounded-lg p-2.5 border border-stone-100">
                      <p className="text-[9px] text-stone-500 leading-normal italic">
                        Based on the current {selectedGroup ? 'area' : 'view'}, sightings for <strong>{species.join(' & ')}</strong> have changed by 
                        <span className="font-bold text-stone-900 border-b border-stone-300 ml-1">
                          {(() => {
                            const primarySpecies = species[0] || 'red';
                            const first = populationTimeline[0]?.[primarySpecies] || 0;
                            const last = populationTimeline[populationTimeline.length - 1]?.[primarySpecies] || 0;
                            if (first === 0) return last === 0 ? "0%" : "New Activity";
                            const change = ((last - first) / first) * 100;
                            return `${change > 0 ? '+' : ''}${change.toFixed(0)}%`;
                          })()}
                        </span> since {debouncedRange.start}.
                      </p>
                    </div>
                  )}
                </div>

                {/* Scientific PDF Reports */}
                <div className="space-y-4 pt-4 border-t border-stone-100">
                  <h3 className="text-xs font-bold text-stone-400 uppercase tracking-widest mb-3 flex items-center gap-2">
                    <FileText className="w-3 h-3" /> Scientific Reports
                  </h3>
                  
                  {isGeneratingPdf ? (
                    <div className="bg-amber-50/70 border border-amber-200/60 rounded-xl p-3.5 space-y-3">
                      <div className="flex items-start gap-2.5">
                        <Loader2 className="w-4 h-4 text-amber-600 animate-spin shrink-0 mt-0.5" />
                        <div className="space-y-1 overflow-hidden">
                          <p className="text-[10px] font-bold text-stone-700 uppercase tracking-wide">
                            Generating Scientists PDF...
                          </p>
                          <p className="text-[10px] text-amber-800 font-semibold truncate">
                            {pdfStatusText}
                          </p>
                          {pdfProgressTotal > 0 && (
                            <p className="text-[9px] text-stone-500 font-mono">
                              Area {pdfProgressIndex} of {pdfProgressTotal} ({Math.round((pdfProgressIndex / pdfProgressTotal) * 100)}%)
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Progress Bar */}
                      {pdfProgressTotal > 1 && (
                        <div className="w-full bg-stone-200/80 h-1.5 rounded-full overflow-hidden">
                          <div 
                            className="bg-amber-500 h-full transition-all duration-300"
                            style={{ width: `${(pdfProgressIndex / pdfProgressTotal) * 100}%` }}
                          />
                        </div>
                      )}

                      <button
                        onClick={() => {
                          cancelPdfRef.current = true;
                          setPdfStatusText("Cancelling process...");
                        }}
                        className="w-full py-2 bg-red-50 hover:bg-red-100 text-red-700 hover:text-red-800 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 border border-red-200 focus:outline-none"
                      >
                        <XCircle className="w-3.5 h-3.5" /> CANCEL PDF
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      <p className="text-[9.5px] text-stone-500 leading-normal italic">
                        Generate high-resolution A4 scientific PDF reports including vector maps and 5km trapping grid densities.
                      </p>
                      
                      {selectedGroup ? (
                        <button
                          onClick={() => handleGeneratePdfReports('selected')}
                          disabled={!isUpToDate || networkLoading || isDataProcessing}
                          className={`w-full py-2.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${
                            (!isUpToDate || networkLoading || isDataProcessing)
                              ? 'bg-stone-100 text-stone-400 cursor-not-allowed border border-stone-200 shadow-none'
                              : 'bg-stone-900 hover:bg-black text-white active:scale-95 shadow-xs hover:shadow-md cursor-pointer'
                          }`}
                        >
                          <FileText className="w-3.5 h-3.5" />
                          REPORT FOR SELECTED AREA
                        </button>
                      ) : (
                        <div className="p-2 bg-stone-50 border border-stone-200/50 rounded-xl">
                          <p className="text-[8.5px] text-stone-400 font-semibold text-center italic">
                            Select an area in the dropdown above to generate a single report.
                          </p>
                        </div>
                      )}

                      <button
                        onClick={() => handleGeneratePdfReports('all')}
                        disabled={!isUpToDate || networkLoading || isDataProcessing}
                        className={`w-full py-2.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${
                          (!isUpToDate || networkLoading || isDataProcessing)
                            ? 'bg-stone-100 text-stone-400 cursor-not-allowed border border-stone-200 shadow-none'
                            : 'bg-amber-600 hover:bg-amber-700 text-white active:scale-95 shadow-xs hover:shadow-md cursor-pointer'
                        }`}
                      >
                        <Download className="w-3.5 h-3.5" />
                        GENERATE FOR ALL AREAS ({SQUIRREL_GROUPS.length})
                      </button>

                      {(!isUpToDate) && (
                        <p className="text-[9px] text-amber-700 bg-amber-50/85 border border-amber-200/40 p-2 rounded-xl text-center font-bold italic animate-pulse">
                          PDF generation will become available once standard selected data is loaded.
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* Map Settings */}
                <div className="space-y-6 pt-4 border-t border-stone-100">
                  <h3 className="text-xs font-bold text-stone-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                    <Layers className="w-3 h-3" /> Map Customization
                  </h3>
                  
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <label className="text-[10px] font-bold text-stone-500 uppercase tracking-wider">Background Mapping</label>
                      <div className="grid grid-cols-3 gap-2">
                        {Object.keys(TILE_LAYERS).map((key) => (
                          <button
                            key={key}
                            onClick={() => setMapStyle(key as any)}
                            className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-tight border transition-all ${
                              mapStyle === key 
                              ? 'bg-stone-900 text-white border-stone-900 shadow-md scale-[1.02]' 
                              : 'bg-white text-stone-600 border-stone-200 hover:border-stone-400'
                            }`}
                          >
                            {key}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-3 pt-2">
                      <div className="flex justify-between items-center">
                        <label className="text-[10px] font-bold text-stone-500 uppercase tracking-wider">Dot Size</label>
                        <span className="text-xs font-mono font-bold text-stone-600">{markerScale.toFixed(1)}x</span>
                      </div>
                      <input 
                        type="range" 
                        min="0.5" 
                        max="8" 
                        step="0.1"
                        value={markerScale} 
                        onChange={(e) => setMarkerScale(parseFloat(e.target.value))}
                        className="w-full h-1.5 bg-stone-200 rounded-lg appearance-none cursor-pointer accent-stone-900"
                      />
                    </div>

                    <div className="space-y-2 pt-2">
                      <label className="text-[10px] font-bold text-stone-500 uppercase tracking-wider">Colouring Mode</label>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          onClick={() => setColorMode('temporal')}
                          className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-tight border transition-all ${
                            colorMode === 'temporal' 
                            ? 'bg-stone-900 text-white border-stone-900 shadow-md' 
                            : 'bg-white text-stone-600 border-stone-200 hover:border-stone-400'
                          }`}
                        >
                          Temporal
                        </button>
                        <button
                          onClick={() => setColorMode('solid')}
                          className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-tight border transition-all ${
                            colorMode === 'solid' 
                            ? 'bg-stone-900 text-white border-stone-900 shadow-md' 
                            : 'bg-white text-stone-600 border-stone-200 hover:border-stone-400'
                          }`}
                        >
                          Solid Fill
                        </button>
                      </div>
                    </div>

                    <div className="space-y-2 pt-2">
                      <label className="text-[10px] font-bold text-stone-500 uppercase tracking-wider">Dot Shape</label>
                      <div className="grid grid-cols-2 gap-2">
                        {(['circle', 'square'] as const).map((shape) => (
                          <button
                            key={shape}
                            onClick={() => setMarkerShape(shape)}
                            className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-tight border transition-all ${
                              markerShape === shape 
                              ? 'bg-stone-900 text-white border-stone-900 shadow-md' 
                              : 'bg-white text-stone-600 border-stone-200 hover:border-stone-400'
                            }`}
                          >
                            {shape}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-stone-100 mt-2">
                      <span className="text-[10px] font-bold text-stone-500 uppercase tracking-wider">Hide Data During Sync</span>
                      <button
                        onClick={() => setStopDisplayingDuringFetch(!stopDisplayingDuringFetch)}
                        className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-tight border transition-all ${
                          stopDisplayingDuringFetch 
                          ? 'bg-amber-600 text-white border-amber-600 shadow-sm' 
                          : 'bg-white text-stone-600 border-stone-200 hover:border-stone-400'
                        }`}
                      >
                        {stopDisplayingDuringFetch ? 'ON' : 'OFF'}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Data Sync Info */}
                <div className="bg-amber-50 border border-amber-100 rounded-2xl p-4 space-y-2">
                  <div className="flex items-center gap-2 text-amber-800 font-bold text-[10px] uppercase tracking-wider">
                    <Info className="w-3 h-3" /> Data Sources Info
                  </div>
                  <p className="text-[10px] text-amber-700 leading-relaxed italic">
                    Fetching from <strong>Saving Scotland's Red Squirrels</strong> database via NBN Atlas.
                  </p>

                  {syncStatusMap[species[0] === 'grey_effort' ? 'grey_trapping' : species[0]]?.lastSync && (
                    <div className="pt-1 mt-1 border-t border-amber-200 text-[9px] text-amber-600 font-bold">
                      DATABASE SNAPSHOT DATE: {new Date(syncStatusMap[species[0] === 'grey_effort' ? 'grey_trapping' : species[0]].lastSync).toLocaleString()}
                    </div>
                  )}

                  {import.meta.env.PROD && (
                    <div className="pt-1 mt-1 text-[9px] text-stone-600 font-medium border-t border-amber-200/50">
                      Note: Using a high-performance local snapshot of the database bundled directly in the app build.
                    </div>
                  )}
                </div>

                {/* Database Connection & Sync Status */}
                <div className="bg-white border border-stone-200 rounded-2xl p-4 space-y-3 shadow-xs">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-stone-700 font-bold text-[10px] uppercase tracking-wider">
                      <Database className="w-3.5 h-3.5 text-stone-500" /> Database Engine: Local File Cache
                    </div>
                    <span className="text-[9px] font-bold px-1.5 py-0.5 bg-green-50 text-green-700 border border-green-200 rounded-sm uppercase tracking-wide">
                      Active
                    </span>
                  </div>

                  <div className="space-y-2 text-[10px] text-stone-600 leading-relaxed">
                    <p>
                      The application executes in a fully automated <strong>Standard Local Cache Mode</strong>. Sighting occurrences are saved directly onto your server's local sandboxed disk.
                    </p>
                    <div className="bg-stone-50 p-2.5 rounded-xl border border-stone-150 space-y-1 text-[9px] text-stone-500">
                      <div className="flex justify-between font-bold text-stone-600">
                        <span>Local files cached:</span>
                        <span className="font-mono">
                          {firebaseStorageStatus ? (Object.values(firebaseStorageStatus.localGzExists) as number[]).reduce((a, b) => a + b, 0) : 0} years splits
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-[8.5px] text-stone-400">
                        <div>Red: {firebaseStorageStatus?.localGzExists?.red || 0} yrs</div>
                        <div>Grey: {firebaseStorageStatus?.localGzExists?.grey || 0} yrs</div>
                        <div>Marten: {firebaseStorageStatus?.localGzExists?.marten || 0} yrs</div>
                        <div>Traps: {firebaseStorageStatus?.localGzExists?.grey_trapping || 0} yrs</div>
                      </div>
                    </div>
                    <p className="italic text-[9.5px] text-stone-500">
                      Simply use the <strong>Sync with NBN Atlas</strong> action below to populate or update the map. Zero account keys, scripts, or cloud configurations are required!
                    </p>
                  </div>

                  <div className="border-t border-stone-100 pt-3">
                    <button
                      onClick={() => setShowStorageInstructions(!showStorageInstructions)}
                      className={`w-full py-1.5 px-2 border rounded-lg text-[9px] font-bold uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 cursor-pointer active:scale-95 ${
                        showStorageInstructions 
                          ? 'bg-amber-600 border-amber-600 text-white hover:bg-amber-700 shadow-sm' 
                          : 'bg-stone-50 border-stone-200 text-stone-500 hover:text-stone-700 hover:bg-stone-100'
                      }`}
                    >
                      <Info className="w-3.5 h-3.5" />
                      {showStorageInstructions ? "Hide Firebase Storage (Optional)" : "Show Firebase Storage (Optional)"}
                    </button>
                  </div>

                  {showStorageInstructions && (
                    <div className="mt-2 p-3 bg-stone-50 rounded-xl border border-stone-150 text-[9px] text-stone-600 space-y-2 max-h-60 overflow-y-auto leading-normal">
                      <p className="font-bold text-stone-700 uppercase tracking-widest text-[8.5px] border-b border-stone-200 pb-1">
                        Advanced Cloud Storage Setup:
                      </p>
                      <p>
                        Firebase Cloud Storage is purely optional. It is useful if you want to hold static database splits in a centralized cloud bucket rather than local container storage (useful in multi-container / serverless scale-outs).
                      </p>
                      <div className="space-y-1">
                        <span className="font-bold text-stone-700">1. Setup Storage Bucket:</span>
                        <p>Create a Firebase Project and enable Cloud Storage. Copy your static bucket name (example: <code>your-app.firebasestorage.app</code>).</p>
                      </div>

                      <div className="space-y-1">
                        <span className="font-bold text-stone-700">2. Configure Secrets:</span>
                        <p>Add environment secret <strong><code>FIREBASE_STORAGE_BUCKET</code></strong> in your AI Studio Build UI (Secrets) and assign your bucket name.</p>
                      </div>

                      <div className="space-y-1">
                        <span className="font-bold text-stone-700">3. Set Security Rules:</span>
                        <p>In Firebase Storage Rules console, allow public reads for CDN-like streaming:</p>
                        <pre className="p-1.5 bg-stone-900 text-stone-100 rounded text-[7.5px] overflow-x-auto select-all font-mono leading-tight">
{`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read: if true;
      allow write: if request.auth != null;
    }
  }
}`}
                        </pre>
                      </div>

                      <div className="space-y-1">
                        <span className="font-bold text-stone-700">4. Connection status:</span>
                        <p className="font-mono text-[8.5px] bg-stone-100 p-1 rounded font-medium my-0.5 break-all text-amber-800">
                          {firebaseStorageStatus?.configured ? `Bucket name: ${firebaseStorageStatus.bucketName}. Status: ${firebaseStorageStatus.message}` : "No bucket configured. Serving locally."}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="p-6 bg-stone-50 border-t border-stone-200 space-y-4">
                <button 
                  onClick={refreshData}
                  disabled={isSyncing}
                  className={`w-full py-3 border rounded-xl text-xs font-bold transition-all active:scale-95 flex items-center justify-center gap-2 shadow-sm hover:shadow-md ${
                    isSyncing 
                      ? 'bg-amber-50 border-amber-200 text-amber-700 cursor-not-allowed' 
                      : 'bg-white border-stone-200 text-stone-600 hover:bg-stone-100'
                  }`}
                >
                  {isSyncing ? (
                    <>
                      <div className="w-3 h-3 border-2 border-amber-600 border-t-transparent rounded-full animate-spin" />
                      FETCHING {((syncStatusMap.red?.count || 0) + (syncStatusMap.grey?.count || 0) + (syncStatusMap.marten?.count || 0) + (syncStatusMap.grey_trapping?.count || 0)).toLocaleString()} / {((syncStatusMap.red?.totalEstimated || 0) + (syncStatusMap.grey?.totalEstimated || 0) + (syncStatusMap.marten?.totalEstimated || 0) + (syncStatusMap.grey_trapping?.totalEstimated || 0)).toLocaleString()}
                    </>
                  ) : (
                    'SYNC WITH NBN ATLAS'
                  )}
                </button>
                {isSyncing ? (
                  <button 
                    onClick={cancelSync}
                    className={`w-full py-3 rounded-xl text-xs font-bold transition-all active:scale-95 flex items-center justify-center gap-2 shadow-xs border ${
                      confirmCancel 
                        ? 'bg-red-600 border-red-600 text-white animate-pulse' 
                        : 'bg-red-50 border-red-200 text-red-700 hover:bg-red-100'
                    }`}
                  >
                    {confirmCancel ? 'CONFIRM CANCEL & RESET?' : 'CANCEL & RESET COUNTERS'}
                  </button>
                ) : (
                  <button 
                    type="button"
                    onClick={cancelSync}
                    className={`w-full py-2 border rounded-xl text-[10px] font-semibold transition-all active:scale-95 flex items-center justify-center gap-1.5 ${
                      confirmCancel 
                        ? 'bg-red-600 border-red-600 text-white animate-pulse' 
                        : 'bg-transparent hover:bg-red-50 hover:text-red-700 text-stone-500 hover:border-red-100 border-transparent'
                    }`}
                  >
                    <Trash2 className="w-3 h-3" />
                    {confirmCancel ? 'CONFIRM WIPE & RESET?' : 'WIPE PROGRESS & RESET COUNTERS'}
                  </button>
                )}
                <button 
                  onClick={() => handleDownload('json')}
                  className="w-full py-3 bg-stone-900 text-white rounded-xl text-xs font-bold shadow-sm hover:shadow-lg hover:bg-black transition-all active:scale-95 flex items-center justify-center gap-2"
                >
                  <Download className="w-3.5 h-3.5" />
                  EXPORT DATABASE (.JSON)
                </button>
                <button 
                  onClick={() => document.getElementById('local-db-upload')?.click()}
                  className="w-full py-3 bg-amber-600 hover:bg-amber-700 text-white rounded-xl text-xs font-bold shadow-sm hover:shadow-lg transition-all active:scale-95 flex items-center justify-center gap-2"
                >
                  <Upload className="w-3.5 h-3.5" />
                  LOAD LOCAL COPY (from Downloads)
                </button>
                
                {/* Dedicated Completed split files list */}
                {Object.keys(syncStatusMap).some(sku => syncStatusMap[sku]?.completedYears?.length > 0) && (
                  <div className="mt-3 p-3 bg-amber-50/50 border border-amber-100 rounded-xl space-y-2">
                    <div className="text-[9px] uppercase font-bold text-stone-600 tracking-wider flex items-center justify-between">
                      <span>Completed Year Splits ({Object.values(syncStatusMap).reduce((sum: number, curr: any) => sum + (curr?.completedYears?.length || 0), 0)} files)</span>
                    </div>
                    <div className="max-h-32 overflow-y-auto space-y-1.5 text-[10px]">
                      {['red', 'grey', 'marten', 'grey_trapping'].map(sKey => {
                        const completed = syncStatusMap[sKey]?.completedYears || [];
                        if (completed.length === 0) return null;
                        return (
                          <div key={sKey} className="flex flex-wrap items-center gap-1">
                            <span className="font-semibold text-stone-500 capitalize min-w-[55px] text-[9px]">{sKey.replace('_', ' ')}:</span>
                            {completed.slice().sort((a: number, b: number) => b - a).map((y: number) => (
                              <button
                                key={y}
                                onClick={() => downloadYearFile(sKey, y)}
                                className="px-1.5 py-0.5 bg-white border border-stone-200 text-stone-700 rounded-md hover:bg-stone-50 hover:border-stone-300 transition-all font-mono text-[9px] flex items-center gap-0.5 shadow-2xs cursor-pointer active:scale-90"
                                title={`Download ${sKey}_${y}.json`}
                              >
                                <Download className="w-2.5 h-2.5" />
                                {y}
                              </button>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                <input 
                  id="local-db-upload"
                  type="file"
                  accept=".json"
                  onChange={handleLocalImport}
                  className="hidden"
                />
              </div>
            </motion.aside>
          )}
        </AnimatePresence>

        {/* Toggle Sidebar Button */}
        <button
          onClick={() => setIsSidebarOpen(!isSidebarOpen)}
          className="absolute left-0 top-1/2 -translate-y-1/2 z-30 bg-white border border-stone-200 border-l-0 rounded-r-xl p-2 shadow-lg hover:bg-stone-50 transition-colors"
        >
          {isSidebarOpen ? <ChevronLeft className="w-5 h-5 text-stone-600" /> : <ChevronRight className="w-5 h-5 text-stone-600" />}
        </button>

        {/* Map Container */}
        <main className="flex-1 overflow-hidden relative">
          {/* Map Floating Header / Data Date Badge */}
          <div className="absolute top-6 left-6 z-[1000] pointer-events-none">
            <div className="bg-white/95 backdrop-blur-md shadow-lg rounded-xl px-4 py-2 border border-stone-200/80 pointer-events-auto flex items-center gap-2">
              <Calendar className="w-3.5 h-3.5 text-stone-500" />
              <span className="text-xs font-bold text-stone-700 tracking-tight">
                Data current at {lastSyncDate}
              </span>
            </div>
          </div>

          {/* Data Loading Progress Indicator overlay */}
          <AnimatePresence>
            {showFullscreenLoader && (
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 z-[1100] flex items-center justify-center bg-white/40 backdrop-blur-[2px] pointer-events-none"
              >
                <div className="bg-white/95 backdrop-blur-md shadow-2xl rounded-2xl px-6 py-5 border border-stone-200/80 pointer-events-auto flex items-center gap-4 max-w-sm">
                  <div className="relative shrink-0">
                    <div className="w-8 h-8 border-3 border-stone-100 border-t-amber-600 rounded-full animate-spin" />
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="w-2.5 h-2.5 bg-amber-500 rounded-full animate-ping" />
                    </div>
                  </div>
                  <div className="text-left">
                    <h4 className="text-sm font-bold text-stone-800 uppercase tracking-wider mb-1">Loading Portal Files</h4>
                    <p className="text-xs text-stone-600 leading-relaxed">
                      Loading and parsing squirrel records from the project's local JSON files in the <span className="font-mono bg-stone-100 px-1.5 py-0.5 rounded text-amber-600 font-bold border border-stone-200">/data</span> folder.
                    </p>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {!showFullscreenLoader && isUpToDate && filteredSightings.length === 0 && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/50 backdrop-blur-sm pointer-events-none">
              <div className="bg-white p-6 rounded-3xl shadow-2xl border border-red-100 text-center max-w-xs pointer-events-auto">
                <Info className="w-10 h-10 text-red-600 mx-auto mb-4" />
                <h3 className="font-bold text-stone-900 mb-2">No Sightings Found</h3>
                <p className="text-sm text-stone-500">Try broadening the date range{selectedGroup ? ' or clearing the group filter' : ''}.</p>
              </div>
            </div>
          )}

          <MapContainer 
            center={SCOTTISH_BORDERS_CENTER} 
            zoom={10} 
            zoomControl={false}
            scrollWheelZoom={true}
            preferCanvas={true}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url={TILE_LAYERS[mapStyle]}
            />
            <ZoomControl position="bottomright" />
            <MapController setBounds={setMapBounds} setZoom={setMapZoom} />
            <GroupZoomController selectedGroup={selectedGroup} />
            
            {showGroupOverlay && (
              <Pane name="recovery-areas-pane" style={{ zIndex: 390 }}>
                {SQUIRREL_GROUPS.map((group, idx) => (
                  <Polygon
                    key={idx}
                    positions={group.polygon as [number, number][]}
                    pathOptions={{
                      fillColor: selectedGroup === group.name ? '#0288d1' : '#78716c',
                      fillOpacity: fillGroupAreas ? (selectedGroup === group.name ? 0.3 : 0.1) : 0,
                      color: selectedGroup === group.name ? '#0288d1' : '#78716c',
                      weight: selectedGroup === group.name ? 3 : 1,
                      pane: "recovery-areas-pane"
                    }}
                  >
                    <Tooltip sticky>{group.name}</Tooltip>
                  </Polygon>
                ))}
              </Pane>
            )}

            {species.includes('grey_effort') && aggregatedSquares.map((square, index) => {
              const maxVal = maxCount;
              const style = getContourColor(square.count, maxVal);
              const gridLetters = get100kmSquareLetters(square.easting, square.northing);
              const eDigits = Math.floor((square.easting % 100000) / 1000).toString().padStart(2, '0');
              const nDigits = Math.floor((square.northing % 100000) / 1000).toString().padStart(2, '0');
              const gridRefLabel = `${gridLetters} ${eDigits} ${nDigits}`;

              return (
                <Polygon
                  key={`grid-square-${index}`}
                  positions={square.corners}
                  pathOptions={{
                    fillColor: style.fillColor,
                    fillOpacity: style.fillOpacity,
                    color: style.color,
                    weight: style.weight,
                    opacity: 0.8
                  }}
                >
                  <Tooltip sticky>
                    <div className="font-sans px-2 py-1 min-w-[140px]">
                      <p className="font-bold text-stone-900 border-b border-stone-100 mb-1 pb-1 flex items-center justify-between">
                        <span>OS Grid 5km Square</span>
                        <span className="px-1.5 py-0.5 bg-amber-100 text-amber-800 text-[8px] rounded font-mono uppercase tracking-tight">trapping</span>
                      </p>
                      <div className="flex justify-between items-center text-[10px] text-stone-500 font-semibold mb-1">
                        <span>GRID REF</span>
                        <span className="text-stone-900 font-bold font-mono">{gridRefLabel}</span>
                      </div>
                      <div className="flex justify-between items-center text-[10px] text-stone-500 font-semibold mb-1">
                        <span>EAS/NOR (SW)</span>
                        <span className="text-stone-500 font-mono text-[9px]">{square.easting.toLocaleString()}e, {square.northing.toLocaleString()}n</span>
                      </div>
                      <div className="flex justify-between items-center text-[10px] text-stone-500 font-semibold mb-1">
                        <span>RECORDS</span>
                        <span className="text-amber-700 font-bold">{square.count} Records</span>
                      </div>
                      <div className="flex justify-between items-center text-[10px] text-stone-500 font-semibold">
                        <span>ACTIVE YEARS</span>
                        <span className="text-stone-900">{startYear === endYear ? startYear : `${startYear} - ${endYear}`}</span>
                      </div>
                    </div>
                  </Tooltip>
                </Polygon>
              );
            })}

            {species.includes('grey_effort') && showTrappingCounts && aggregatedSquares.map((square, index) => {
              const centerLatLon = eastingNorthingToLatLon(square.easting + 2500, square.northing + 2500);
              const textIcon = L.divIcon({
                className: 'grid-square-count-icon',
                html: `<div style="display: flex; align-items: center; justify-content: center; font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 800; color: #1e293b; background: rgba(255, 255, 255, 0.85); border: 1px solid #94a3b8; border-radius: 4px; padding: 1px 4px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); white-space: nowrap; pointer-events: none;">${square.count}</div>`,
                iconSize: [28, 16],
                iconAnchor: [14, 8]
              });

              return (
                <Marker
                  key={`grid-square-count-${index}`}
                  position={[centerLatLon.lat, centerLatLon.lon]}
                  icon={textIcon}
                  interactive={false}
                />
              );
            })}

            {markerLayers}
          </MapContainer>

          {/* Legend / Overlay */}
          <div className="absolute top-6 right-6 z-[1000] pointer-events-none">
            <div className="bg-white/90 backdrop-blur-md shadow-xl rounded-2xl p-4 border border-stone-200 pointer-events-auto space-y-3 min-w-[180px]">
              <div className="space-y-2 border-b border-stone-100 pb-2">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-[10px] font-bold text-stone-900 uppercase tracking-widest">
                    {species.map(s => s === 'red' ? 'Red' : s === 'grey' ? 'Grey' : s === 'grey_effort' ? 'Grey Trapping' : 'Marten').join(' + ')}
                  </span>
                  <div className={`w-3 h-3 rounded-${markerShape === 'circle' ? 'full' : 'sm'} bg-stone-900 shadow-sm border border-white`} />
                </div>
                <div className="space-y-1">
                  <p className="text-[8px] font-bold text-stone-400 uppercase tracking-tighter">
                    {colorMode === 'temporal' ? 'Timeline (2008 - Present)' : 'Species Colours'}
                  </p>
                  {colorMode === 'temporal' ? (
                    <>
                      <div className="h-1.5 w-full bg-gradient-to-r from-[#0000ff] via-[#00ff00] via-[#ffff00] to-[#ff0000] rounded-full shadow-inner" />
                      <div className="flex justify-between text-[7px] font-mono text-stone-500 uppercase tracking-tighter">
                        <span>Jan 2008</span>
                        <span>Present</span>
                      </div>
                    </>
                  ) : (
                    <div className="space-y-1.5 pt-0.5">
                      {species.includes('red') && (
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full bg-[#dc2626]" />
                          <span className="text-[9px] font-bold text-stone-600 uppercase tracking-widest">Red Squirrel</span>
                        </div>
                      )}
                      {species.includes('grey') && (
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full bg-[#78716c]" />
                          <span className="text-[9px] font-bold text-stone-600 uppercase tracking-widest">Grey Squirrel</span>
                        </div>
                      )}
                      {species.includes('grey_effort') && (
                        <div className="flex items-center gap-2">
                          <span className="text-[9px] font-bold text-stone-600 uppercase tracking-widest">Grey Trapping</span>
                        </div>
                      )}
                      {species.includes('marten') && (
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full bg-[#713f12]" />
                          <span className="text-[9px] font-bold text-stone-600 uppercase tracking-widest">Pine Marten</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {species.includes('grey_effort') && (
                <div className="pt-2 mt-2 border-t border-stone-150 space-y-2">
                  <p className="text-[8px] font-bold text-stone-400 uppercase tracking-tighter">Trapping Density (5km Grid)</p>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <div className="w-5 h-2 bg-[#22c55e]/60 rounded-sm border border-[#16a34a]/30" />
                      <span className="text-[8px] font-mono text-stone-500 font-bold uppercase tracking-tight">1 - 20% (Low)</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-5 h-2 bg-[#84cc16]/60 rounded-sm border border-[#65a30d]/30" />
                      <span className="text-[8px] font-mono text-stone-500 font-bold uppercase tracking-tight">21 - 40%</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-5 h-2 bg-[#eab308]/60 rounded-sm border border-[#ca8a04]/30" />
                      <span className="text-[8px] font-mono text-stone-500 font-bold uppercase tracking-tight">41 - 60% (Medium)</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-5 h-2 bg-[#f97316]/60 rounded-sm border border-[#ea580c]/30" />
                      <span className="text-[8px] font-mono text-stone-500 font-bold uppercase tracking-tight">61 - 80%</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-5 h-2 bg-[#dc2626]/60 rounded-sm border border-[#b91c1c]/30" />
                      <span className="text-[8px] font-mono text-stone-500 font-bold uppercase tracking-tight">81 - 100% (High)</span>
                    </div>
                  </div>
                  <p className="text-[7.5px] text-stone-400 font-semibold italic leading-tight">
                    *Auto-scaled to max {maxCount} records/square
                  </p>
                </div>
              )}

              {isThinned && (
                <div className="pt-2 mt-2 border-t border-amber-100 flex items-center gap-2">
                  <div className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-pulse" />
                  <span className="text-[9px] font-bold text-amber-700 uppercase tracking-tighter">Sampling {filteredSightings.length.toLocaleString()} points</span>
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
