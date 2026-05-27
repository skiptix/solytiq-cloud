import type { Response } from 'express';

const clients = new Map<string, Set<Response>>();

export function addSseClient(userId: string, res: Response): void {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId)!.add(res);
}

export function removeSseClient(userId: string, res: Response): void {
  clients.get(userId)?.delete(res);
  if (clients.get(userId)?.size === 0) clients.delete(userId);
}

export function broadcastToUser(userId: string, event: string): void {
  const userClients = clients.get(userId);
  if (!userClients || userClients.size === 0) return;
  const payload = `event: sync\ndata: ${JSON.stringify({ type: event })}\n\n`;
  for (const res of userClients) {
    try {
      res.write(payload);
    } catch {
      userClients.delete(res);
    }
  }
}
