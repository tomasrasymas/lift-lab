import type { WindSettings, MapId } from './sim/world';
import type { AircraftId } from './sim/presets';
import type { RateProfile } from './sim/multirotor';

export type Fn = 'throttle' | 'roll' | 'pitch' | 'yaw' | 'arm' | 'mode' | 'rate' | 'reset';
export interface Binding { type: 'axis' | 'button'; index: number; reverse: boolean; }
export interface AxisCal { min: number; max: number; center: number; }
export interface ControllerMapping { bindings: Partial<Record<Fn, Binding>>; cal: AxisCal[]; /** default layout (not from wizard) */ auto?: boolean; }

export type ViewMode = 'los' | 'chase' | 'fpv';
export type Quality = 'low' | 'medium' | 'high';

export interface Settings {
  aircraft: AircraftId;
  map: MapId;
  fpvVideo: 'digital' | 'analog';
  fpvProps: boolean;
  view: Record<AircraftId, ViewMode>;
  quality: Quality;
  autoQuality: boolean;
  stickMode: 1 | 2;
  wind: WindSettings;
  expo: number;
  spawnInAir: boolean;
  autoZoom: boolean;
  showSticks: boolean;
  showHud: boolean;
  imperial: boolean;
  volume: number;
  sfxVolume: number;
  musicVolume: number;
  ambientVolume: number;
  musicOn: boolean;
  batterySim: boolean;
  fpvFov: number;
  camTilt: number;
  fpvRates: RateProfile;
  simSpeed: number;
  mappings: Record<string, ControllerMapping>;
  preferredGamepad: string | null;
  keyboardMode: 0 | 1 | 2;
}

const KEY = 'liftlab.settings.v1';

export const defaultSettings = (): Settings => ({
  aircraft: 'trainer',
  view: { trainer: 'los', fpv: 'fpv', drone: 'los' },
  map: 'field',
  fpvVideo: 'digital',
  fpvProps: true,
  quality: guessQuality(),
  autoQuality: true,
  stickMode: 2,
  wind: { speed: 2, fromDeg: 90, gusts: 0.3, turbulence: 0.3 },
  expo: 0.3,
  spawnInAir: false,
  autoZoom: true,
  showSticks: true,
  showHud: true,
  imperial: false,
  volume: 0.8,
  sfxVolume: 0.8,
  musicVolume: 0.35,
  ambientVolume: 0.5,
  musicOn: true,
  batterySim: true,
  fpvFov: 100,
  camTilt: 25,
  fpvRates: { center: 70, max: 670, expo: 0.54 },
  simSpeed: 1,
  mappings: {},
  preferredGamepad: null,
  keyboardMode: 0,
});

function guessQuality(): Quality {
  if (typeof navigator === 'undefined') return 'medium';
  const cores = navigator.hardwareConcurrency ?? 4;
  const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
  if (mobile || cores <= 2) return 'low';
  return cores >= 8 ? 'high' : 'medium';
}

export function loadSettings(): Settings {
  const d = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const s = JSON.parse(raw);
    if (!['trainer', 'fpv', 'drone'].includes(s.aircraft)) s.aircraft = 'trainer';
    if (!['field', 'forest', 'city'].includes(s.map)) s.map = 'field';
    return { ...d, ...s, view: { ...d.view, ...(s.view ?? {}) }, wind: { ...d.wind, ...(s.wind ?? {}) }, fpvRates: { ...d.fpvRates, ...(s.fpvRates ?? {}) } };
  } catch {
    return d;
  }
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}
