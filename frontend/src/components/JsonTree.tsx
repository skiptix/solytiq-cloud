import { useState } from 'react';
import Icon from './Icon';

// ---------------------------------------------------------------------------
// A recursive, expandable JSON viewer AND drag source for the Automation Hub
// editor's Data (Input/Output) panel. Every row is draggable; dropping it
// onto a param field inserts a {{...}} expression token (see
// AutomationEditorScreen.tsx's useDragInsert) referencing that exact path —
// no separate "mapping" step, the tree IS the picker.
// ---------------------------------------------------------------------------

function formatPrimitive(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `"${value.length > 80 ? `${value.slice(0, 80)}…` : value}"`;
  return String(value);
}

function JsonTreeNode({ label, value, path, depth }: { label: string; value: unknown; path: string; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 1);
  const isObject = value !== null && typeof value === 'object';
  const isArray = Array.isArray(value);
  const entries: Array<[string, unknown]> = isObject
    ? isArray
      ? (value as unknown[]).map((v, i) => [String(i), v] as [string, unknown])
      : Object.entries(value as Record<string, unknown>)
    : [];

  const handleDragStart = (e: React.DragEvent) => {
    e.stopPropagation();
    e.dataTransfer.setData('text/plain', `{{${path}}}`);
    e.dataTransfer.setData('application/x-solytiq-field', JSON.stringify({ path }));
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <div style={{ paddingLeft: depth === 0 ? 0 : 12 }}>
      <div
        draggable
        onDragStart={handleDragStart}
        title={`Drag to insert {{${path}}}`}
        style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 4px', borderRadius: 5, cursor: 'grab', fontFamily: "'SF Mono', Monaco, Consolas, monospace", fontSize: 11.5, minWidth: 0 }}
      >
        {isObject && entries.length > 0 ? (
          <span onClick={(e) => { e.stopPropagation(); setExpanded((x) => !x); }} style={{ display: 'flex', cursor: 'pointer', flexShrink: 0 }}>
            <Icon name={expanded ? 'expand_more' : 'chevron_right'} size={13} color="#b0acbe" />
          </span>
        ) : (
          <span style={{ width: 13, flexShrink: 0 }} />
        )}
        <span style={{ color: '#5e4dbb', fontWeight: 600, flexShrink: 0 }}>{label}</span>
        {!isObject && (
          <span style={{ color: '#484552', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>: {formatPrimitive(value)}</span>
        )}
        {isObject && (
          <span style={{ color: '#b0acbe' }}>{isArray ? `Array(${entries.length})` : `{${entries.length}}`}</span>
        )}
      </div>
      {isObject && expanded && entries.map(([key, v]) => (
        <JsonTreeNode key={key} label={isArray ? `[${key}]` : key} value={v} path={isArray ? `${path}[${key}]` : `${path}.${key}`} depth={depth + 1} />
      ))}
    </div>
  );
}

export default function JsonTree({ data, rootLabel, rootPath }: { data: unknown; rootLabel: string; rootPath: string }) {
  if (data === undefined) {
    return <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11.5, color: '#b0acbe', fontStyle: 'italic', padding: '2px 0' }}>No data.</div>;
  }
  return <JsonTreeNode label={rootLabel} value={data} path={rootPath} depth={0} />;
}
