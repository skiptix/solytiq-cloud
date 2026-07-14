import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ReactFlow, Background, Controls, Handle, Position, type Node as RFNode, type Edge as RFEdge, type NodeChange, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { usePageTitle } from '../hooks/usePageTitle';
import { useMobile } from '../hooks/useBreakpoint';
import type { Automation, AutomationGraph, AutomationNode, AutomationRun, AutomationRunResult, AutomationRunStep, TriggerTypeDef, ActionTypeDef, AutomationParamProperty, List, Folder, Workspace } from '../types';
import useAutomationsStore from '../store/useAutomationsStore';
import useAppStore from '../store/useAppStore';
import useWorkspaceStore from '../store/useWorkspaceStore';
import { ApiError } from '../api/client';
import Icon from '../components/Icon';
import TimePicker from '../components/TimePicker';
import JsonTree from '../components/JsonTree';

// ---------------------------------------------------------------------------
// Pure graph helpers — shared by the desktop canvas and the mobile step-list
// editor, so both produce the exact same linear-chain shape the backend
// requires (see backend/src/automationGraph.ts). The frontend enforces the
// chain topology by construction: there's no way to draw a branch or a
// cycle, only append/remove/reorder within a single chain.
// ---------------------------------------------------------------------------

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function actionOrder(graph: AutomationGraph): string[] {
  const nextOf = new Map(graph.edges.map((e) => [e.source, e.target]));
  const trigger = graph.nodes.find((n) => n.kind === 'trigger');
  const order: string[] = [];
  let cur = trigger ? nextOf.get(trigger.id) : undefined;
  while (cur) {
    order.push(cur);
    cur = nextOf.get(cur);
  }
  return order;
}

function rebuildChain(graph: AutomationGraph, orderedActionIds: string[]): AutomationGraph {
  const trigger = graph.nodes.find((n) => n.kind === 'trigger');
  const edges: AutomationGraph['edges'] = [];
  let prev = trigger?.id;
  for (const id of orderedActionIds) {
    if (prev) edges.push({ id: makeId('edge'), source: prev, target: id });
    prev = id;
  }
  return { ...graph, edges };
}

function setTriggerType(graph: AutomationGraph, type: string): AutomationGraph {
  const existing = graph.nodes.find((n) => n.kind === 'trigger');
  if (existing) {
    return { ...graph, nodes: graph.nodes.map((n) => (n.id === existing.id ? { ...n, type, params: {} } : n)) };
  }
  const triggerNode: AutomationNode = { id: 'trigger', kind: 'trigger', type, position: { x: 260, y: 40 }, params: {} };
  return { ...graph, nodes: [triggerNode, ...graph.nodes] };
}

function addActionNode(graph: AutomationGraph, type: string): { graph: AutomationGraph; newId: string } {
  const newId = makeId('action');
  const order = [...actionOrder(graph), newId];
  const actionCount = graph.nodes.filter((n) => n.kind === 'action').length;
  const newNode: AutomationNode = { id: newId, kind: 'action', type, position: { x: 260, y: 40 + (actionCount + 1) * 150 }, params: {} };
  const next = rebuildChain({ ...graph, nodes: [...graph.nodes, newNode] }, order);
  return { graph: next, newId };
}

function removeActionNode(graph: AutomationGraph, nodeId: string): AutomationGraph {
  const order = actionOrder(graph).filter((id) => id !== nodeId);
  const nodes = graph.nodes.filter((n) => n.id !== nodeId);
  return rebuildChain({ ...graph, nodes }, order);
}

function moveActionNode(graph: AutomationGraph, nodeId: string, direction: 'up' | 'down'): AutomationGraph {
  const order = actionOrder(graph);
  const idx = order.indexOf(nodeId);
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (idx < 0 || swapIdx < 0 || swapIdx >= order.length) return graph;
  const next = [...order];
  [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
  return rebuildChain(graph, next);
}

function updateNodeParams(graph: AutomationGraph, nodeId: string, params: Record<string, unknown>): AutomationGraph {
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, params: { ...n.params, ...params } } : n)) };
}

function setNodePosition(graph: AutomationGraph, nodeId: string, position: { x: number; y: number }): AutomationGraph {
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, position } : n)) };
}

/** Client-side pre-check mirroring the load-bearing parts of the backend's
 *  normalizeAutomationGraph, so mistakes surface immediately instead of only
 *  after a round trip. The backend re-validates unconditionally regardless. */
function validateClientSide(
  graph: AutomationGraph,
  nodeTypes: { triggers: TriggerTypeDef[]; actions: ActionTypeDef[] } | null
): string | null {
  const trigger = graph.nodes.find((n) => n.kind === 'trigger');
  if (!trigger) return 'Choose a trigger to get started.';
  const actions = graph.nodes.filter((n) => n.kind === 'action');
  if (actions.length === 0) return 'Add at least one action.';
  if (!nodeTypes) return null;
  const triggerDef = nodeTypes.triggers.find((t) => t.id === trigger.type);
  if (!triggerDef) return `Unknown trigger type "${trigger.type}".`;

  for (const key of ['listId']) {
    const prop = triggerDef.paramsSchema.properties[key];
    if (prop && !prop.optional && !trigger.params[key]) return `${prop.label} is required for "${triggerDef.label}".`;
  }
  if (triggerDef.id === 'schedule') {
    if (!trigger.params.freq) return 'Choose a frequency for the schedule trigger.';
    if (!trigger.params.time) return 'Choose a time for the schedule trigger.';
    if (trigger.params.freq === 'weekly' && trigger.params.dayOfWeek === undefined) return 'Choose a day of the week.';
  }

  for (const node of actions) {
    const def = nodeTypes.actions.find((a) => a.id === node.type);
    if (!def) return `Unknown action type "${node.type}".`;
    if (def.requiresTriggerTask && !triggerDef.providesTask) return `"${def.label}" needs a task, but "${triggerDef.label}" doesn't provide one.`;
    if (def.requiresTriggerList && !triggerDef.providesList) return `"${def.label}" needs a list, but "${triggerDef.label}" doesn't provide one.`;
    for (const [key, prop] of Object.entries(def.paramsSchema.properties)) {
      if (!prop.optional && !node.params[key]) return `${prop.label} is required for "${def.label}".`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Data flow — reconstructing what {{trigger.x}}/{{$json.x}}/{{nodes.<id>.x}}
// would resolve to for a given node, and that node's own output, from the
// most recent Test result held in screen state (testResult). This is a
// deliberate V1 scope trim: it does not reach into Run History for older
// runs, only "the last time you clicked Test in this editing session".
// ---------------------------------------------------------------------------

interface NodeScope {
  trigger: unknown;
  $json: unknown;
  nodes: Record<string, unknown>;
}

function computeNodeIO(
  testResult: { nodeId: string; result?: AutomationRunResult } | null,
  triggerNodeId: string | undefined,
  targetNodeId: string
): { scope: NodeScope | null; output: unknown; hasOutput: boolean } {
  const steps: AutomationRunStep[] | undefined = testResult?.result?.steps;
  if (!steps || !triggerNodeId) return { scope: null, output: undefined, hasOutput: false };

  if (targetNodeId === triggerNodeId) {
    // Nothing precedes the trigger itself — it can still have its OWN recorded output though.
    const triggerStep = steps.find((s) => s.nodeId === targetNodeId);
    return { scope: null, output: triggerStep?.output, hasOutput: !!triggerStep };
  }

  const nodes: Record<string, unknown> = {};
  let triggerOutput: unknown;
  let previousOutput: unknown;
  let targetStep: AutomationRunStep | undefined;
  for (const step of steps) {
    if (step.nodeId === targetNodeId) { targetStep = step; break; }
    nodes[step.nodeId] = step.output;
    if (step.nodeId === triggerNodeId) triggerOutput = step.output;
    previousOutput = step.output;
  }
  return {
    scope: { trigger: triggerOutput, $json: previousOutput, nodes },
    output: targetStep?.output,
    hasOutput: !!targetStep,
  };
}

// ---------------------------------------------------------------------------
// Drag-and-drop data picker: dragging a field out of a JsonTree (Data →
// Input) drops a reference into any text-producing param field. Normal
// fields get a {{...}} expression token (text/plain); the Code action's
// textarea instead gets a plain JS accessor (input.<path>), read from a
// second, custom MIME payload the same drag also carries.
// ---------------------------------------------------------------------------

interface DragInsertHandlers {
  onDrop: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onSelect: () => void;
  onClick: () => void;
  onKeyUp: () => void;
}

// Returns the ref and the handler bag as two SEPARATE values (not one merged
// object) — a merged {ref, ...handlers} object gets flagged by the
// react-hooks/refs lint rule as "ref access during render" for every handler
// property, since it can't prove the handlers don't indirectly read .current.
function useDragInsert(
  onChange: (value: string) => void,
  currentValue: string,
  disabled: boolean,
  mode: 'token' | 'code' = 'token'
): [React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>, DragInsertHandlers] {
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const caretRef = useRef<number>(currentValue.length);
  const trackCaret = () => {
    if (ref.current) caretRef.current = ref.current.selectionStart ?? currentValue.length;
  };
  const onDrop = (e: React.DragEvent) => {
    if (disabled) return;
    e.preventDefault();
    let insertText: string | null = null;
    if (mode === 'code') {
      const raw = e.dataTransfer.getData('application/x-solytiq-field');
      if (raw) {
        try {
          insertText = `input.${(JSON.parse(raw) as { path: string }).path}`;
        } catch {
          insertText = null;
        }
      }
    }
    if (insertText === null) insertText = e.dataTransfer.getData('text/plain');
    if (!insertText) return;
    const pos = caretRef.current ?? currentValue.length;
    onChange(currentValue.slice(0, pos) + insertText + currentValue.slice(pos));
  };
  return [
    ref,
    {
      onDrop,
      onDragOver: (e: React.DragEvent) => e.preventDefault(),
      onSelect: trackCaret,
      onClick: trackCaret,
      onKeyUp: trackCaret,
    },
  ];
}

function KeyValueRow({ row, onChange, onRemove, readOnly }: {
  row: { key: string; value: string };
  onChange: (row: { key: string; value: string }) => void;
  onRemove: () => void;
  readOnly: boolean;
}) {
  const [insertRef, insert] = useDragInsert((v) => onChange({ ...row, value: v }), row.value, readOnly);
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <input disabled={readOnly} value={row.key} onChange={(e) => onChange({ ...row, key: e.target.value })} placeholder="Key"
        style={{ width: '38%', fontFamily: 'Inter, sans-serif', fontSize: 12.5, border: '1.5px solid #e8e4f0', borderRadius: 7, padding: '6px 8px', outline: 'none' }} />
      <input ref={insertRef as React.RefObject<HTMLInputElement>} disabled={readOnly} value={row.value}
        onChange={(e) => onChange({ ...row, value: e.target.value })}
        onDrop={insert.onDrop} onDragOver={insert.onDragOver} onSelect={insert.onSelect} onClick={insert.onClick} onKeyUp={insert.onKeyUp}
        placeholder="Value" title="Drag a field from Data → Input to insert a reference"
        style={{ flex: 1, fontFamily: 'Inter, sans-serif', fontSize: 12.5, border: '1.5px solid #e8e4f0', borderRadius: 7, padding: '6px 8px', outline: 'none' }} />
      {!readOnly && (
        <button type="button" onClick={onRemove}
          style={{ width: 22, height: 22, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon name="close" size={13} color="#b0acbe" />
        </button>
      )}
    </div>
  );
}

/** Collapsible Input/Output JSON viewer, shared by the desktop inspector and mobile StepCard. */
function NodeDataPanel({ scope, output, hasOutput, nodeId }: { scope: NodeScope | null; output: unknown; hasOutput: boolean; nodeId: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{ marginTop: 14, borderTop: '1px solid #ece8f4', paddingTop: 10 }}>
      <div onClick={() => setExpanded((s) => !s)} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
        <Icon name={expanded ? 'expand_less' : 'expand_more'} size={15} color="#787584" />
        <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 700, color: '#787584', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Data</span>
      </div>
      {expanded && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 700, color: '#5e4dbb', marginBottom: 4 }}>Input</div>
            {!scope ? (
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11.5, color: '#b0acbe', fontStyle: 'italic' }}>Run Test to see live data.</div>
            ) : (
              <div style={{ background: '#FAFAFC', border: '1px solid #ece8f4', borderRadius: 8, padding: 8, maxHeight: 220, overflow: 'auto' }}>
                <JsonTree data={scope.trigger} rootLabel="trigger" rootPath="trigger" />
                <JsonTree data={scope.$json} rootLabel="$json (previous step)" rootPath="$json" />
                <JsonTree data={scope.nodes} rootLabel="nodes (every step so far)" rootPath="nodes" />
              </div>
            )}
          </div>
          <div>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 700, color: '#f59e0b', marginBottom: 4 }}>Output</div>
            {!hasOutput ? (
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11.5, color: '#b0acbe', fontStyle: 'italic' }}>Run Test to see this node's output.</div>
            ) : (
              <div style={{ background: '#FFFBF0', border: '1px solid #FEF3E2', borderRadius: 8, padding: 8, maxHeight: 220, overflow: 'auto' }}>
                <JsonTree data={output} rootLabel="output" rootPath={`nodes.${nodeId}`} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Param form — shared by the desktop inspector panel and the mobile
// step-card's expanded state.
// ---------------------------------------------------------------------------

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function ParamField({ fieldKey, prop, value, onChange, lists, folders, workspaces, readOnly }: {
  fieldKey: string;
  prop: AutomationParamProperty;
  value: unknown;
  onChange: (value: unknown) => void;
  lists: List[];
  folders: Folder[];
  workspaces: Workspace[];
  readOnly: boolean;
}) {
  const [showTime, setShowTime] = useState(false);
  const label = `${prop.label}${prop.optional ? ' (optional)' : ''}`;
  const stringValue = typeof value === 'string' ? value : '';
  const [insertRef, insert] = useDragInsert((nv) => onChange(nv || undefined), stringValue, readOnly, prop.isCode ? 'code' : 'token');

  if (fieldKey === 'time') {
    const v = typeof value === 'string' ? value : '';
    return (
      <div>
        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#787584', marginBottom: 5 }}>{label}</div>
        <div style={{ position: 'relative' }}>
          <button type="button" disabled={readOnly} onClick={() => setShowTime((s) => !s)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 10px', borderRadius: 8, border: `1px solid ${v ? '#c4b5fd' : '#e8e4f0'}`, background: v ? '#F5F3FF' : '#fff', cursor: readOnly ? 'default' : 'pointer', fontFamily: 'Inter, sans-serif', fontSize: 13, color: v ? '#5e4dbb' : '#b0acbe' }}>
            <Icon name="schedule" size={13} color={v ? '#5e4dbb' : '#b0acbe'} />
            {v || 'Set a time…'}
          </button>
          {showTime && !readOnly && (
            <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 50 }}>
              <TimePicker value={v || undefined} onChange={(t) => { onChange(t); setShowTime(false); }} onClear={() => { onChange(undefined); setShowTime(false); }} />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (fieldKey === 'dayOfWeek') {
    const v = typeof value === 'number' ? value : undefined;
    return (
      <div>
        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#787584', marginBottom: 5 }}>{label}</div>
        <div style={{ display: 'flex', gap: 4 }}>
          {DAY_LABELS.map((d, i) => (
            <button key={d} type="button" disabled={readOnly} onClick={() => onChange(i)}
              style={{ flex: 1, padding: '6px 0', borderRadius: 7, border: 'none', cursor: readOnly ? 'default' : 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, background: v === i ? '#5e4dbb' : '#f1ecf6', color: v === i ? '#fff' : '#787584' }}>
              {d}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (prop.isListId) {
    const v = typeof value === 'string' ? value : '';
    return (
      <div>
        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#787584', marginBottom: 5 }}>{label}</div>
        <select disabled={readOnly} value={v} onChange={(e) => onChange(e.target.value || undefined)}
          style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 13, border: '1.5px solid #e8e4f0', borderRadius: 8, padding: '7px 10px', outline: 'none', background: '#fff', color: '#1c1b22' }}>
          <option value="">{prop.optional ? 'Any list in this workspace' : 'Choose a list…'}</option>
          {lists.map((l) => <option key={l.id} value={l.id}>{l.emoji ? `${l.emoji} ` : ''}{l.name}</option>)}
        </select>
      </div>
    );
  }

  if (prop.isFolderId) {
    const v = typeof value === 'string' ? value : '';
    return (
      <div>
        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#787584', marginBottom: 5 }}>{label}</div>
        <select disabled={readOnly} value={v} onChange={(e) => onChange(e.target.value || undefined)}
          style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 13, border: '1.5px solid #e8e4f0', borderRadius: 8, padding: '7px 10px', outline: 'none', background: '#fff', color: '#1c1b22' }}>
          <option value="">{prop.optional ? 'No folder' : 'Choose a folder…'}</option>
          {folders.map((f) => <option key={f.id} value={f.id}>{f.emoji ? `${f.emoji} ` : ''}{f.name}</option>)}
        </select>
      </div>
    );
  }

  if (prop.isWorkspaceId) {
    const v = typeof value === 'string' ? value : '';
    return (
      <div>
        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#787584', marginBottom: 5 }}>{label}</div>
        <select disabled={readOnly} value={v} onChange={(e) => onChange(e.target.value || undefined)}
          style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 13, border: '1.5px solid #e8e4f0', borderRadius: 8, padding: '7px 10px', outline: 'none', background: '#fff', color: '#1c1b22' }}>
          <option value="">Choose a workspace…</option>
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.emoji ? `${w.emoji} ` : ''}{w.name}</option>)}
        </select>
      </div>
    );
  }

  if (prop.enum) {
    const v = typeof value === 'string' ? value : '';
    return (
      <div>
        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#787584', marginBottom: 5 }}>{label}</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {prop.enum.map((opt) => (
            <button key={opt} type="button" disabled={readOnly} onClick={() => onChange(opt)}
              style={{ padding: '6px 14px', borderRadius: 8, border: `1.5px solid ${v === opt ? '#5e4dbb' : '#e8e4f0'}`, background: v === opt ? '#F5F3FF' : '#fff', cursor: readOnly ? 'default' : 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: 600, color: v === opt ? '#5e4dbb' : '#787584', textTransform: 'capitalize' }}>
              {opt}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (prop.isKeyValue) {
    const rows: Array<{ key: string; value: string }> = Array.isArray(value) ? (value as Array<{ key: string; value: string }>) : [];
    const setRows = (next: Array<{ key: string; value: string }>) => onChange(next.length > 0 ? next : undefined);
    return (
      <div>
        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#787584', marginBottom: 5 }}>{label}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((row, i) => (
            <KeyValueRow key={i} row={row} readOnly={readOnly}
              onChange={(next) => setRows(rows.map((r, j) => (j === i ? next : r)))}
              onRemove={() => setRows(rows.filter((_, j) => j !== i))}
            />
          ))}
          {!readOnly && (
            <button type="button" onClick={() => setRows([...rows, { key: '', value: '' }])}
              style={{ display: 'flex', alignItems: 'center', gap: 5, alignSelf: 'flex-start', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#5e4dbb', background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 0' }}>
              <Icon name="add" size={13} color="#5e4dbb" /> Add
            </button>
          )}
        </div>
      </div>
    );
  }

  if (prop.isLongText || prop.isCode) {
    return (
      <div>
        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#787584', marginBottom: 5 }}>{label}</div>
        <textarea ref={insertRef as React.RefObject<HTMLTextAreaElement>} disabled={readOnly} value={stringValue} rows={prop.isCode ? 8 : 4} spellCheck={false}
          onChange={(e) => onChange(e.target.value || undefined)}
          onDrop={insert.onDrop} onDragOver={insert.onDragOver} onSelect={insert.onSelect} onClick={insert.onClick} onKeyUp={insert.onKeyUp}
          style={{
            width: '100%', fontFamily: prop.isCode ? "'SF Mono', Monaco, Consolas, monospace" : 'Inter, sans-serif', fontSize: prop.isCode ? 12 : 12.5,
            lineHeight: 1.5, border: '1.5px solid #e8e4f0', borderRadius: 8, padding: '8px 10px', outline: 'none', resize: 'vertical',
            background: prop.isCode ? '#1c1b22' : '#fff', color: prop.isCode ? '#e8e4f0' : '#1c1b22',
          }} />
        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe', marginTop: 4 }}>{prop.description}</div>
      </div>
    );
  }

  if (prop.type === 'number') {
    const v = typeof value === 'number' ? value : '';
    return (
      <div>
        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#787584', marginBottom: 5 }}>{label}</div>
        <input type="number" disabled={readOnly} value={v} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 13, border: '1.5px solid #e8e4f0', borderRadius: 8, padding: '7px 10px', outline: 'none' }} />
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#787584', marginBottom: 5 }}>{label}</div>
      <input ref={insertRef as React.RefObject<HTMLInputElement>} disabled={readOnly} value={stringValue}
        onChange={(e) => onChange(e.target.value || undefined)}
        onDrop={insert.onDrop} onDragOver={insert.onDragOver} onSelect={insert.onSelect} onClick={insert.onClick} onKeyUp={insert.onKeyUp}
        style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 13, border: '1.5px solid #e8e4f0', borderRadius: 8, padding: '7px 10px', outline: 'none' }} />
      <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe', marginTop: 4 }}>{prop.description}</div>
    </div>
  );
}

function ParamsForm({ def, params, onChange, lists, folders, workspaces, readOnly }: {
  def: TriggerTypeDef | ActionTypeDef;
  params: Record<string, unknown>;
  onChange: (params: Record<string, unknown>) => void;
  lists: List[];
  folders: Folder[];
  workspaces: Workspace[];
  readOnly: boolean;
}) {
  const entries = Object.entries(def.paramsSchema.properties);
  if (entries.length === 0) {
    return <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12.5, color: '#b0acbe', fontStyle: 'italic' }}>No configuration needed.</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {entries.map(([key, prop]) => (
        <ParamField key={key} fieldKey={key} prop={prop} value={params[key]} onChange={(v) => onChange({ [key]: v })} lists={lists} folders={folders} workspaces={workspaces} readOnly={readOnly} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Desktop: React Flow canvas nodes
// ---------------------------------------------------------------------------

function FlowNodeCard({ data }: NodeProps) {
  const d = data as unknown as {
    label: string; icon: string; kind: 'trigger' | 'action'; selected: boolean; readOnly: boolean;
    onClick: () => void; onDelete?: () => void;
    onTest?: () => void; testing?: boolean; testDisabled?: boolean;
  };
  const accent = d.kind === 'trigger' ? '#5e4dbb' : '#f59e0b';
  const bg = d.kind === 'trigger' ? '#F5F3FF' : '#FEF3E2';
  return (
    <div onClick={d.onClick}
      style={{ width: 220, background: '#fff', borderRadius: 12, border: `2px solid ${d.selected ? accent : '#e8e4f0'}`, boxShadow: d.selected ? `0 6px 18px ${accent}26` : '0 2px 8px rgba(0,0,0,0.06)', padding: '10px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, position: 'relative' }}>
      {d.kind === 'action' && <Handle type="target" position={Position.Top} style={{ background: '#c9c4d5', width: 8, height: 8 }} />}
      <div style={{ width: 30, height: 30, borderRadius: 9, background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon name={d.icon} size={15} color={accent} />
      </div>
      <div style={{ flex: 1, minWidth: 0, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: 600, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {d.label}
      </div>
      {!d.readOnly && d.onTest && (
        <button disabled={d.testing || d.testDisabled} title={d.testDisabled ? 'Save first to test' : 'Run this node for real, right now'}
          onClick={(e) => { e.stopPropagation(); d.onTest!(); }}
          style={{ width: 22, height: 22, borderRadius: 6, border: 'none', background: 'transparent', cursor: d.testing || d.testDisabled ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, opacity: d.testDisabled ? 0.35 : 1 }}>
          <Icon name={d.testing ? 'sync' : 'play_circle'} size={15} color="#5e4dbb" />
        </button>
      )}
      {d.kind === 'action' && !d.readOnly && d.onDelete && (
        <button onClick={(e) => { e.stopPropagation(); d.onDelete!(); }}
          style={{ width: 20, height: 20, borderRadius: 6, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon name="close" size={13} color="#b0acbe" />
        </button>
      )}
      <Handle type="source" position={Position.Bottom} style={{ background: '#c9c4d5', width: 8, height: 8 }} />
    </div>
  );
}

const RF_NODE_TYPES = { trigger: FlowNodeCard, action: FlowNodeCard };

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function AutomationEditorScreen() {
  usePageTitle('Automation');
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isMobile = useMobile();
  const isNew = id === 'new';
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const allWorkspaces = useWorkspaceStore((s) => s.workspaces);
  const allLists = useAppStore((s) => s.lists);
  const allFolders = useAppStore((s) => s.folders);
  const { nodeTypes, loadNodeTypes, getDetail, create, update, getRuns, testNode } = useAutomationsStore();

  const [loading, setLoading] = useState(!isNew);
  const [notFound, setNotFound] = useState(false);
  const [automation, setAutomation] = useState<Automation | null>(null);
  const [name, setName] = useState('New automation');
  const [description, setDescription] = useState('');
  const [graph, setGraph] = useState<AutomationGraph>({ version: 1, nodes: [], edges: [] });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRuns, setShowRuns] = useState(false);
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  const [testingNodeId, setTestingNodeId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ nodeId: string; result?: AutomationRunResult; error?: string } | null>(null);

  useEffect(() => { loadNodeTypes(); }, [loadNodeTypes]);

  useEffect(() => {
    if (isNew) return;
    let cancelled = false;
    setLoading(true);
    getDetail(id!)
      .then((a) => {
        if (cancelled) return;
        setAutomation(a);
        setName(a.name);
        setDescription(a.description ?? '');
        setGraph(a.graph);
        setLoading(false);
      })
      .catch(() => { if (!cancelled) { setNotFound(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, [id, isNew, getDetail]);

  const readOnly = !isNew && automation ? !automation.isOwner : false;
  const effectiveWorkspaceId = automation?.workspaceId ?? currentWorkspaceId;
  const workspaceLists = useMemo(() => allLists.filter((l) => l.workspaceId === effectiveWorkspaceId), [allLists, effectiveWorkspaceId]);
  const workspaceFolders = useMemo(() => allFolders.filter((f) => f.workspaceId === effectiveWorkspaceId), [allFolders, effectiveWorkspaceId]);
  const otherWorkspaces = useMemo(() => allWorkspaces.filter((w) => w.id !== effectiveWorkspaceId), [allWorkspaces, effectiveWorkspaceId]);

  const triggerNode = graph.nodes.find((n) => n.kind === 'trigger') ?? null;
  const orderedActionIds = actionOrder(graph);
  const orderedActions = orderedActionIds.map((aid) => graph.nodes.find((n) => n.id === aid)).filter((n): n is AutomationNode => !!n);
  const selectedNode = graph.nodes.find((n) => n.id === selectedNodeId) ?? null;

  const applyGraph = useCallback((fn: (g: AutomationGraph) => AutomationGraph) => {
    setGraph((g) => fn(g));
    setError(null);
  }, []);

  const handleSetTrigger = (type: string) => {
    applyGraph((g) => setTriggerType(g, type));
    setSelectedNodeId('trigger');
  };
  const handleAddAction = (type: string) => {
    setGraph((g) => {
      const { graph: next, newId } = addActionNode(g, type);
      setSelectedNodeId(newId);
      return next;
    });
    setError(null);
  };
  const handleRemoveAction = useCallback((nodeId: string) => {
    applyGraph((g) => removeActionNode(g, nodeId));
    setSelectedNodeId((cur) => (cur === nodeId ? null : cur));
  }, [applyGraph]);
  const handleMoveAction = (nodeId: string, dir: 'up' | 'down') => applyGraph((g) => moveActionNode(g, nodeId, dir));
  const handleSetParams = (nodeId: string, params: Record<string, unknown>) => applyGraph((g) => updateNodeParams(g, nodeId, params));

  // Runs the trigger (and, for an action node, every action up to and
  // including it) for REAL against real, auto-picked data — same engine,
  // same permanent effects, logged in Run History tagged as a test.
  const handleTestNode = useCallback(async (nodeId: string) => {
    if (!automation) return;
    setTestingNodeId(nodeId);
    setTestResult(null);
    try {
      const result = await testNode(automation.id, nodeId);
      setTestResult({ nodeId, result });
      setRuns(null); // stale — force a refetch next time Run History opens
    } catch (err) {
      const message = err instanceof ApiError ? (err.body as { error?: string })?.error ?? err.message : 'Failed to run the test.';
      setTestResult({ nodeId, error: message });
    } finally {
      setTestingNodeId(null);
    }
  }, [automation, testNode]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    for (const c of changes) {
      if (c.type === 'position' && c.position) {
        setGraph((g) => setNodePosition(g, c.id, c.position!));
      }
    }
  }, []);

  const rfNodes: RFNode[] = useMemo(() => graph.nodes.map((n) => {
    const def = n.kind === 'trigger' ? nodeTypes?.triggers.find((t) => t.id === n.type) : nodeTypes?.actions.find((a) => a.id === n.type);
    return {
      id: n.id,
      type: n.kind,
      position: n.position,
      draggable: !readOnly,
      data: {
        label: def?.label ?? n.type,
        icon: def?.icon ?? (n.kind === 'trigger' ? 'bolt' : 'flash_on'),
        kind: n.kind,
        selected: n.id === selectedNodeId,
        readOnly,
        onClick: () => setSelectedNodeId(n.id),
        onDelete: n.kind === 'action' ? () => handleRemoveAction(n.id) : undefined,
        onTest: () => handleTestNode(n.id),
        testing: testingNodeId === n.id,
        testDisabled: isNew,
      },
    };
  }), [graph.nodes, nodeTypes, selectedNodeId, readOnly, handleRemoveAction, testingNodeId, isNew, handleTestNode]);

  const rfEdges: RFEdge[] = useMemo(() => graph.edges.map((e) => ({
    id: e.id, source: e.source, target: e.target, style: { stroke: '#c9c4d5', strokeWidth: 2 },
  })), [graph.edges]);

  const validationError = useMemo(() => validateClientSide(graph, nodeTypes), [graph, nodeTypes]);

  const openRuns = async () => {
    setShowRuns(true);
    if (!automation || runs) return;
    try { setRuns(await getRuns(automation.id)); } catch { setRuns([]); }
  };

  const handleSave = async () => {
    const preCheck = validateClientSide(graph, nodeTypes);
    if (preCheck) { setError(preCheck); return; }
    setSaving(true);
    setError(null);
    try {
      if (isNew) {
        if (!currentWorkspaceId) throw new Error('No active workspace.');
        const created = await create({ workspaceId: currentWorkspaceId, name: name.trim() || 'Untitled automation', description: description.trim() || undefined, graph });
        navigate(`/automations/${created.id}`, { replace: true });
      } else if (automation) {
        const saved = await update(automation.id, { name: name.trim() || automation.name, description: description.trim() || null, graph, expectedVersion: automation.version });
        setAutomation(saved);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError((err.body as { error?: string })?.error ?? err.message);
      } else {
        setError('Failed to save. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>Loading automation…</div>;
  }
  if (notFound) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22', marginBottom: 8 }}>Automation not found</div>
        <button onClick={() => navigate('/automations')} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#5e4dbb', background: 'transparent', border: 'none', cursor: 'pointer' }}>← Back to Automations</button>
      </div>
    );
  }

  const availableActions = nodeTypes?.actions.filter((a) => {
    if (!triggerNode) return false;
    const triggerDef = nodeTypes.triggers.find((t) => t.id === triggerNode.type);
    if (!triggerDef) return true;
    if (a.requiresTriggerTask && !triggerDef.providesTask) return false;
    if (a.requiresTriggerList && !triggerDef.providesList) return false;
    return true;
  }) ?? [];

  return (
    <div style={{ flex: 1, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: isMobile ? '12px 14px' : '14px 24px', borderBottom: '1px solid #ece8f4', flexWrap: 'wrap' }}>
        <button onClick={() => navigate('/automations')} style={{ width: 32, height: 32, borderRadius: 9, border: 'none', background: '#f5f3ff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon name="arrow_back" size={16} color="#5e4dbb" />
        </button>
        <input value={name} disabled={readOnly} onChange={(e) => setName(e.target.value)} placeholder="Untitled automation" maxLength={255}
          style={{ flex: 1, minWidth: 140, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 17, fontWeight: 700, color: '#1c1b22', border: 'none', outline: 'none', background: 'transparent' }} />
        {!isNew && automation && (
          <button onClick={openRuns} style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: 600, color: '#787584', background: '#f5f3ff', border: 'none', borderRadius: 8, padding: '7px 12px', cursor: 'pointer' }}>
            <Icon name="history" size={14} color="#787584" /> Run history
          </button>
        )}
        {!readOnly && (
          <>
            <button onClick={() => navigate('/automations')} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: 'transparent', border: 'none', cursor: 'pointer', padding: '8px 14px' }}>Cancel</button>
            <button onClick={handleSave} disabled={saving} title={validationError ?? undefined}
              style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: saving ? '#a99ee0' : '#5e4dbb', border: 'none', borderRadius: 8, padding: '9px 20px', cursor: saving ? 'default' : 'pointer' }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        )}
      </div>

      {readOnly && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 24px', background: '#FEF3E2', fontFamily: 'Inter, sans-serif', fontSize: 12.5, color: '#92400e' }}>
          <Icon name="visibility" size={14} color="#92400e" /> View-only — created by {automation?.ownerName ?? 'another user'}. Only they can edit this automation.
        </div>
      )}
      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 24px', background: '#ffdad6', fontFamily: 'Inter, sans-serif', fontSize: 12.5, color: '#ba1a1a' }}>
          <Icon name="error" size={14} color="#ba1a1a" /> {error}
        </div>
      )}

      {testResult && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 24px', background: testResult.error || testResult.result?.status === 'failed' ? '#ffdad6' : '#e8f8f0', fontFamily: 'Inter, sans-serif', fontSize: 12.5 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name={testResult.error || testResult.result?.status === 'failed' ? 'error' : 'check_circle'} size={14} color={testResult.error || testResult.result?.status === 'failed' ? '#ba1a1a' : '#10B981'} />
            <span style={{ fontWeight: 700 }}>Test {testResult.error || testResult.result?.status === 'failed' ? 'failed' : 'ran'}</span>
            <button onClick={() => setTestResult(null)} style={{ marginLeft: 'auto', border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex' }}>
              <Icon name="close" size={13} color="#787584" />
            </button>
          </div>
          {testResult.error && <div style={{ color: '#ba1a1a', paddingLeft: 22 }}>{testResult.error}</div>}
          {testResult.result?.steps.map((s, i) => (
            <div key={i} style={{ color: s.ok ? '#1c1b22' : '#ba1a1a', paddingLeft: 22 }}>{s.ok ? '✓' : '✗'} {s.summary}</div>
          ))}
          {testResult.result?.error && <div style={{ color: '#ba1a1a', paddingLeft: 22 }}>{testResult.result.error}</div>}
        </div>
      )}

      {isMobile ? (
        <MobileStepList
          triggerNode={triggerNode}
          orderedActions={orderedActions}
          nodeTypes={nodeTypes}
          lists={workspaceLists}
          folders={workspaceFolders}
          workspaces={otherWorkspaces}
          readOnly={readOnly}
          selectedNodeId={selectedNodeId}
          setSelectedNodeId={setSelectedNodeId}
          onSetTrigger={handleSetTrigger}
          onAddAction={handleAddAction}
          onRemoveAction={handleRemoveAction}
          onMoveAction={handleMoveAction}
          onSetParams={handleSetParams}
          availableActions={availableActions}
          onTest={handleTestNode}
          testingNodeId={testingNodeId}
          testDisabled={isNew}
          testResult={testResult}
        />
      ) : (
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* Palette */}
          {!readOnly && (
            <div style={{ width: 220, borderRight: '1px solid #ece8f4', padding: 16, overflowY: 'auto', flexShrink: 0 }}>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 700, color: '#787584', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>Trigger</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 20 }}>
                {(nodeTypes?.triggers ?? []).map((t) => (
                  <button key={t.id} onClick={() => handleSetTrigger(t.id)}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', padding: '8px 10px', borderRadius: 9, border: `1.5px solid ${triggerNode?.type === t.id ? '#5e4dbb' : '#e8e4f0'}`, background: triggerNode?.type === t.id ? '#F5F3FF' : '#fff', cursor: 'pointer' }}>
                    <Icon name={t.icon} size={15} color="#5e4dbb" />
                    <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#1c1b22' }}>{t.label}</span>
                  </button>
                ))}
              </div>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 700, color: '#787584', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>Actions</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(nodeTypes?.actions ?? []).map((a) => {
                  const disabled = !triggerNode || !availableActions.some((x) => x.id === a.id);
                  return (
                    <button key={a.id} disabled={disabled} onClick={() => handleAddAction(a.id)} title={disabled ? 'Not compatible with the current trigger' : undefined}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', padding: '8px 10px', borderRadius: 9, border: '1.5px solid #e8e4f0', background: '#fff', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1 }}>
                      <Icon name={a.icon} size={15} color="#f59e0b" />
                      <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#1c1b22' }}>{a.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Canvas */}
          <div style={{ flex: 1, position: 'relative' }}>
            {!triggerNode ? (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, color: '#b0acbe' }}>
                <Icon name="bolt" size={36} color="#d8d2e8" />
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600 }}>Choose a trigger to get started</div>
              </div>
            ) : (
              <ReactFlow
                nodes={rfNodes}
                edges={rfEdges}
                nodeTypes={RF_NODE_TYPES}
                onNodesChange={onNodesChange}
                nodesConnectable={false}
                edgesFocusable={false}
                onPaneClick={() => setSelectedNodeId(null)}
                fitView
                proOptions={{ hideAttribution: true }}
              >
                <Background gap={18} color="#ece8f4" />
                <Controls showInteractive={false} />
              </ReactFlow>
            )}
          </div>

          {/* Inspector */}
          {selectedNode && (
            <div style={{ width: 300, borderLeft: '1px solid #ece8f4', padding: 18, overflowY: 'auto', flexShrink: 0 }}>
              {(() => {
                const def = selectedNode.kind === 'trigger'
                  ? nodeTypes?.triggers.find((t) => t.id === selectedNode.type)
                  : nodeTypes?.actions.find((a) => a.id === selectedNode.type);
                if (!def) return null;
                return (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <Icon name={def.icon} size={16} color={selectedNode.kind === 'trigger' ? '#5e4dbb' : '#f59e0b'} />
                      <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14.5, fontWeight: 700, color: '#1c1b22' }}>{def.label}</div>
                    </div>
                    <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginBottom: 16 }}>{def.description}</div>
                    <ParamsForm def={def} params={selectedNode.params} onChange={(p) => handleSetParams(selectedNode.id, p)} lists={workspaceLists} folders={workspaceFolders} workspaces={otherWorkspaces} readOnly={readOnly} />
                    {(() => {
                      const io = computeNodeIO(testResult, triggerNode?.id, selectedNode.id);
                      return <NodeDataPanel scope={io.scope} output={io.output} hasOutput={io.hasOutput} nodeId={selectedNode.id} />;
                    })()}
                  </>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {showRuns && (
        <RunHistoryPanel runs={runs} onClose={() => setShowRuns(false)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mobile: vertical step-card editor (same graph, no drag canvas)
// ---------------------------------------------------------------------------

function MobileStepList({ triggerNode, orderedActions, nodeTypes, lists, folders, workspaces, readOnly, selectedNodeId, setSelectedNodeId, onSetTrigger, onAddAction, onRemoveAction, onMoveAction, onSetParams, availableActions, onTest, testingNodeId, testDisabled, testResult }: {
  triggerNode: AutomationNode | null;
  orderedActions: AutomationNode[];
  nodeTypes: { triggers: TriggerTypeDef[]; actions: ActionTypeDef[] } | null;
  lists: List[];
  folders: Folder[];
  workspaces: Workspace[];
  readOnly: boolean;
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;
  onSetTrigger: (type: string) => void;
  onAddAction: (type: string) => void;
  onRemoveAction: (id: string) => void;
  onMoveAction: (id: string, dir: 'up' | 'down') => void;
  onSetParams: (id: string, params: Record<string, unknown>) => void;
  availableActions: ActionTypeDef[];
  onTest: (nodeId: string) => void;
  testingNodeId: string | null;
  testDisabled: boolean;
  testResult: { nodeId: string; result?: AutomationRunResult; error?: string } | null;
}) {
  const [showTriggerPicker, setShowTriggerPicker] = useState(!triggerNode);
  const [showAddAction, setShowAddAction] = useState(false);

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Trigger */}
      {triggerNode && !showTriggerPicker ? (
        <StepCard
          icon={nodeTypes?.triggers.find((t) => t.id === triggerNode.type)?.icon ?? 'bolt'}
          label={nodeTypes?.triggers.find((t) => t.id === triggerNode.type)?.label ?? triggerNode.type}
          accent="#5e4dbb" bg="#F5F3FF"
          expanded={selectedNodeId === triggerNode.id}
          onToggle={() => setSelectedNodeId(selectedNodeId === triggerNode.id ? null : triggerNode.id)}
          rightAction={!readOnly ? { icon: 'sync_alt', label: 'Change', onClick: () => setShowTriggerPicker(true) } : undefined}
          testAction={!readOnly ? { testing: testingNodeId === triggerNode.id, disabled: testDisabled, onClick: () => onTest(triggerNode.id) } : undefined}
        >
          {(() => {
            const def = nodeTypes?.triggers.find((t) => t.id === triggerNode.type);
            if (!def) return null;
            const io = computeNodeIO(testResult, triggerNode.id, triggerNode.id);
            return (
              <>
                <ParamsForm def={def} params={triggerNode.params} onChange={(p) => onSetParams(triggerNode.id, p)} lists={lists} folders={folders} workspaces={workspaces} readOnly={readOnly} />
                <NodeDataPanel scope={io.scope} output={io.output} hasOutput={io.hasOutput} nodeId={triggerNode.id} />
              </>
            );
          })()}
        </StepCard>
      ) : (
        <div style={{ background: '#fff', border: '1.5px dashed #d8d2e8', borderRadius: 14, padding: 14 }}>
          <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 700, color: '#1c1b22', marginBottom: 10 }}>Choose a trigger</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(nodeTypes?.triggers ?? []).map((t) => (
              <button key={t.id} onClick={() => { onSetTrigger(t.id); setShowTriggerPicker(false); }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', padding: '10px 12px', borderRadius: 10, border: '1.5px solid #e8e4f0', background: '#fff' }}>
                <Icon name={t.icon} size={16} color="#5e4dbb" />
                <div>
                  <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: 600, color: '#1c1b22' }}>{t.label}</div>
                  <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#787584' }}>{t.description}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      {triggerNode && orderedActions.map((node, i) => {
        const def = nodeTypes?.actions.find((a) => a.id === node.type);
        return (
          <div key={node.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 14 }}>
              <button disabled={readOnly || i === 0} onClick={() => onMoveAction(node.id, 'up')} style={{ width: 22, height: 22, border: 'none', background: 'transparent', cursor: readOnly || i === 0 ? 'default' : 'pointer', opacity: readOnly || i === 0 ? 0.3 : 1 }}>
                <Icon name="keyboard_arrow_up" size={16} color="#787584" />
              </button>
              <button disabled={readOnly || i === orderedActions.length - 1} onClick={() => onMoveAction(node.id, 'down')} style={{ width: 22, height: 22, border: 'none', background: 'transparent', cursor: readOnly || i === orderedActions.length - 1 ? 'default' : 'pointer', opacity: readOnly || i === orderedActions.length - 1 ? 0.3 : 1 }}>
                <Icon name="keyboard_arrow_down" size={16} color="#787584" />
              </button>
            </div>
            <div style={{ flex: 1 }}>
              <StepCard
                icon={def?.icon ?? 'flash_on'} label={def?.label ?? node.type} accent="#f59e0b" bg="#FEF3E2"
                expanded={selectedNodeId === node.id}
                onToggle={() => setSelectedNodeId(selectedNodeId === node.id ? null : node.id)}
                rightAction={!readOnly ? { icon: 'close', label: '', onClick: () => onRemoveAction(node.id) } : undefined}
                testAction={!readOnly ? { testing: testingNodeId === node.id, disabled: testDisabled, onClick: () => onTest(node.id) } : undefined}
              >
                {def && (() => {
                  const io = computeNodeIO(testResult, triggerNode?.id, node.id);
                  return (
                    <>
                      <ParamsForm def={def} params={node.params} onChange={(p) => onSetParams(node.id, p)} lists={lists} folders={folders} workspaces={workspaces} readOnly={readOnly} />
                      <NodeDataPanel scope={io.scope} output={io.output} hasOutput={io.hasOutput} nodeId={node.id} />
                    </>
                  );
                })()}
              </StepCard>
            </div>
          </div>
        );
      })}

      {triggerNode && !readOnly && (
        <div>
          <button onClick={() => setShowAddAction((s) => !s)}
            style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: 600, color: '#5e4dbb', background: '#F5F3FF', border: 'none', borderRadius: 10, padding: '10px 14px', cursor: 'pointer', width: '100%', justifyContent: 'center' }}>
            <Icon name="add" size={15} color="#5e4dbb" /> Add action
          </button>
          {showAddAction && (
            <div style={{ marginTop: 8, background: '#fff', border: '1.5px solid #e8e4f0', borderRadius: 12, padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {availableActions.map((a) => (
                <button key={a.id} onClick={() => { onAddAction(a.id); setShowAddAction(false); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', padding: '9px 10px', borderRadius: 8, border: 'none', background: 'transparent' }}>
                  <Icon name={a.icon} size={15} color="#f59e0b" />
                  <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: 600, color: '#1c1b22' }}>{a.label}</span>
                </button>
              ))}
              {availableActions.length === 0 && (
                <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe', padding: '6px 10px' }}>No actions are compatible with this trigger.</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StepCard({ icon, label, accent, bg, expanded, onToggle, rightAction, testAction, children }: {
  icon: string; label: string; accent: string; bg: string; expanded: boolean; onToggle: () => void;
  rightAction?: { icon: string; label: string; onClick: () => void };
  testAction?: { testing: boolean; disabled: boolean; onClick: () => void };
  children?: React.ReactNode;
}) {
  return (
    <div style={{ background: '#fff', border: `1.5px solid ${expanded ? accent : '#ece8f4'}`, borderRadius: 14, overflow: 'hidden' }}>
      <div onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, cursor: 'pointer' }}>
        <div style={{ width: 32, height: 32, borderRadius: 9, background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon name={icon} size={16} color={accent} />
        </div>
        <div style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 700, color: '#1c1b22' }}>{label}</div>
        {testAction && (
          <button disabled={testAction.testing || testAction.disabled} title={testAction.disabled ? 'Save first to test' : 'Run this node for real, right now'}
            onClick={(e) => { e.stopPropagation(); testAction.onClick(); }}
            style={{ width: 26, height: 26, border: 'none', background: 'transparent', cursor: testAction.testing || testAction.disabled ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: testAction.disabled ? 0.35 : 1 }}>
            <Icon name={testAction.testing ? 'sync' : 'play_circle'} size={16} color="#5e4dbb" />
          </button>
        )}
        {rightAction && (
          <button onClick={(e) => { e.stopPropagation(); rightAction.onClick(); }} style={{ width: 26, height: 26, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={rightAction.icon} size={15} color="#b0acbe" />
          </button>
        )}
        <Icon name={expanded ? 'expand_less' : 'expand_more'} size={16} color="#b0acbe" />
      </div>
      {expanded && (
        <div style={{ padding: '0 14px 14px' }}>{children}</div>
      )}
    </div>
  );
}

function RunHistoryPanel({ runs, onClose }: { runs: AutomationRun[] | null; onClose: () => void }) {
  return (
    <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(380px, 100vw)', background: '#fff', boxShadow: '-8px 0 32px rgba(0,0,0,0.14)', zIndex: 500, display: 'flex', flexDirection: 'column', animation: 'modalIn 220ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid #ece8f4' }}>
        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 700, color: '#1c1b22' }}>Run history</div>
        <button onClick={onClose} style={{ width: 28, height: 28, border: 'none', background: '#f5f3ff', borderRadius: 8, cursor: 'pointer' }}>
          <Icon name="close" size={15} color="#787584" />
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
        {runs === null ? (
          <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe', textAlign: 'center', padding: 30 }}>Loading…</div>
        ) : runs.length === 0 ? (
          <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe', textAlign: 'center', padding: 30 }}>No runs yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {runs.map((r) => (
              <div key={r.id} style={{ border: '1.5px solid #ece8f4', borderRadius: 10, padding: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                  <Icon name={r.status === 'success' ? 'check_circle' : r.status === 'failed' ? 'error' : 'sync'} size={14} color={r.status === 'success' ? '#10B981' : r.status === 'failed' ? '#ba1a1a' : '#787584'} />
                  <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: 700, color: '#1c1b22', textTransform: 'capitalize' }}>{r.status}</span>
                  {r.isTest && (
                    <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 10, fontWeight: 700, color: '#5e4dbb', background: '#F5F3FF', padding: '1px 7px', borderRadius: 9999 }}>Test</span>
                  )}
                  <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe', marginLeft: 'auto' }}>{new Date(r.startedAt).toLocaleString()}</span>
                </div>
                {r.steps.map((s, i) => (
                  <div key={i} style={{ fontFamily: 'Inter, sans-serif', fontSize: 11.5, color: s.ok ? '#484552' : '#ba1a1a', paddingLeft: 20 }}>
                    {s.ok ? '✓' : '✗'} {s.summary}
                  </div>
                ))}
                {r.error && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11.5, color: '#ba1a1a', marginTop: 4 }}>{r.error}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
