export interface TaskRow {
  id: string;
  user_id: string;
  title: string;
  note: string | null;
  checked: boolean;
  deadline: string | null;
  time_val: string | null;
  priority: string | null;
  badge: string | null;
  source: string;
  list_id: string | null;
  section_id: string | null;
  position: number;
  created_at: string;
  updated_at: string;
  linked_list_id: string | null;
  linked_list_type: string | null;
  attachment_count?: string;
}

export function sanitizeTask(task: TaskRow) {
  return {
    id:             task.id,
    creatorId:      task.user_id,
    title:          task.title,
    note:           task.note,
    checked:        task.checked,
    deadline:       task.deadline,
    time:           task.time_val,
    priority:       task.priority,
    badge:          task.badge,
    source:         task.source,
    listId:         task.list_id,
    sectionId:      task.section_id,
    position:       task.position,
    createdAt:      task.created_at,
    updatedAt:      task.updated_at,
    _source:        task.source,
    _listId:        task.list_id,
    linkedListId:    task.linked_list_id ?? null,
    linkedListType:  task.linked_list_type ?? null,
    attachmentCount: Number(task.attachment_count ?? 0),
  };
}
