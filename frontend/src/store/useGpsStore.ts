import { create } from 'zustand';
import type { GpsFile } from '../types';

interface GpsStore {
  files: GpsFile[];
  setFiles: (files: GpsFile[] | ((prev: GpsFile[]) => GpsFile[])) => void;
}

const useGpsStore = create<GpsStore>()((set) => ({
  files: [],
  setFiles: (files) => set((s) => ({ files: typeof files === 'function' ? files(s.files) : files })),
}));

export default useGpsStore;
