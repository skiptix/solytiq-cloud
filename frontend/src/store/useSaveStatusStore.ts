import { create } from 'zustand';
import { setSaveActivityHandlers } from '../api/client';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface SaveStatusStore {
  status: SaveStatus;
}

// A tiny global signal for the header save-status dot on the list-type screens
// (To-Do, Timeline). It reflects in-flight writes to list *content* endpoints
// only — auth/AI/file/settings/admin writes are ignored so the dot never
// flickers for activity unrelated to the list you're looking at. Markdown
// lists pass their own local, debounce-aware state to the dot instead (it
// knows about the pre-request debounce window too), so they don't rely on this.
const LIST_CONTENT_PATH = /^\/(tasks|lists|timelines|folders|markdown-lists)\b/;

const useSaveStatusStore = create<SaveStatusStore>(() => ({ status: 'idle' }));

let inFlight = 0;
let savedTimer: ReturnType<typeof setTimeout> | null = null;

const set = (status: SaveStatus) => useSaveStatusStore.setState({ status });

setSaveActivityHandlers({
  start: (path) => {
    if (!LIST_CONTENT_PATH.test(path)) return;
    inFlight += 1;
    if (savedTimer) { clearTimeout(savedTimer); savedTimer = null; }
    set('saving');
  },
  success: (path) => {
    if (!LIST_CONTENT_PATH.test(path)) return;
    inFlight = Math.max(0, inFlight - 1);
    if (inFlight > 0) return;
    set('saved');
    // Settle back to the resting (green "all saved") state after a beat.
    savedTimer = setTimeout(() => {
      savedTimer = null;
      if (inFlight === 0 && useSaveStatusStore.getState().status === 'saved') set('idle');
    }, 1600);
  },
  error: (path) => {
    if (!LIST_CONTENT_PATH.test(path)) return;
    inFlight = Math.max(0, inFlight - 1);
    if (savedTimer) { clearTimeout(savedTimer); savedTimer = null; }
    set('error');
  },
});

export default useSaveStatusStore;
