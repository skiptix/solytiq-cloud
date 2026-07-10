import { useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../components/Icon';
import VisibilityConflictModal from '../components/VisibilityConflictModal';
import useWorkspaceStore from '../store/useWorkspaceStore';
import {
  apiMoveListWorkspace, apiMoveTimelineWorkspace, apiMoveFolderWorkspace,
  asVisibilityConflict, ApiError, type VisibilityConflict,
} from '../api/client';

interface MoveToWorkspaceModalProps {
  kind: 'list' | 'timeline' | 'folder';
  itemId: string;
  itemName: string;
  currentWorkspaceId?: string;
  /** Called after a successful move with the new workspaceId. */
  onMoved: (workspaceId: string) => void;
  onClose: () => void;
}

const moveFn = {
  list: apiMoveListWorkspace,
  timeline: apiMoveTimelineWorkspace,
  folder: apiMoveFolderWorkspace,
};

export default function MoveToWorkspaceModal({ kind, itemId, itemName, currentWorkspaceId, onMoved, onClose }: MoveToWorkspaceModalProps) {
  const { workspaces } = useWorkspaceStore();
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<VisibilityConflict | null>(null);
  const [error, setError] = useState<string | null>(null);

  const options = workspaces.filter(w => w.id !== currentWorkspaceId);

  const doMove = async (cascade?: boolean) => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await moveFn[kind](itemId, selected, cascade);
      setConflict(null);
      onMoved(selected);
      onClose();
    } catch (err) {
      const c = asVisibilityConflict(err);
      if (c) { setConflict(c); return; }
      setError(err instanceof ApiError ? err.message : 'Failed to move — please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {createPortal(
        <div
          onClick={onClose}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.24)', backdropFilter: 'blur(5px)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, animation: 'backdropIn 220ms ease both' }}>
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 18, maxWidth: 400, width: '100%', maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 40px rgba(94,77,187,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '20px 22px 4px' }}>
              <div style={{ width: 38, height: 38, borderRadius: 11, background: '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Icon name="drive_file_move" size={19} color="#5e4dbb" />
              </div>
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22' }}>Move to workspace</div>
                <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{itemName}</div>
              </div>
            </div>

            <div style={{ padding: '16px 22px 0', overflowY: 'auto', flex: 1 }}>
              {options.length === 0 ? (
                <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe', padding: '12px 2px' }}>
                  No other workspaces to move this into.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {options.map(w => {
                    const isSelected = selected === w.id;
                    return (
                      <button
                        key={w.id}
                        onClick={() => setSelected(w.id)}
                        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, border: isSelected ? '1.5px solid #5e4dbb' : '1.5px solid #e8e4f0', background: isSelected ? '#F5F3FF' : '#fff', cursor: 'pointer', textAlign: 'left' }}>
                        <div style={{ width: 28, height: 28, borderRadius: 8, background: isSelected ? '#fff' : '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 15 }}>
                          {w.emoji ?? <Icon name="workspaces" size={15} color="#5e4dbb" />}
                        </div>
                        <div style={{ flex: 1, overflow: 'hidden' }}>
                          <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.name}</div>
                          <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe', textTransform: 'capitalize' }}>{w.visibility} · {w.role}</div>
                        </div>
                        {isSelected && <Icon name="check" size={16} color="#5e4dbb" />}
                      </button>
                    );
                  })}
                </div>
              )}
              {error && (
                <div style={{ marginTop: 12, fontFamily: 'Inter, sans-serif', fontSize: 12.5, color: '#ba1a1a' }}>{error}</div>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '18px 22px 20px' }}>
              <button
                onClick={onClose}
                disabled={busy}
                style={{ padding: '9px 18px', borderRadius: 10, border: '1.5px solid #e8e4f0', background: '#fff', cursor: busy ? 'wait' : 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: 600, color: '#484552' }}>
                Cancel
              </button>
              <button
                onClick={() => doMove()}
                disabled={busy || !selected}
                style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 18px', borderRadius: 10, border: 'none', background: selected ? '#5e4dbb' : '#c9c4d5', cursor: busy || !selected ? (busy ? 'wait' : 'not-allowed') : 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: 600, color: '#fff' }}>
                {busy && <Icon name="progress_activity" size={15} color="#fff" />}
                Move
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {conflict && (
        <VisibilityConflictModal
          conflict={conflict}
          busy={busy}
          onCancel={() => setConflict(null)}
          onConfirm={() => doMove(true)}
        />
      )}
    </>
  );
}
