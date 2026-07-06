import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware';
import { wlog, werr } from '../workspaceUtil';
import { buildTasksForUser } from './tasks';
import { buildListsForUser } from './lists';
import { buildFoldersForUser } from './folders';
import { buildTimelinesForUser } from './timelines';
import { 
  buildTrashForUser, 
  buildTrashListsForUser, 
  buildTrashFoldersForUser, 
  buildTrashTimelinesForUser, 
  buildTrashMilestonesForUser 
} from './trash';

const router = Router();

router.get('/', authenticate, async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;
    const userId = req.userId!;

    const [
      tasks,
      lists,
      folders,
      timelines,
      trash,
      trashLists,
      trashFolders,
      trashTimelines,
      trashMilestones
    ] = await Promise.all([
      buildTasksForUser(userId, workspaceId),
      buildListsForUser(userId, workspaceId),
      buildFoldersForUser(userId, workspaceId),
      buildTimelinesForUser(userId, workspaceId),
      buildTrashForUser(userId),
      buildTrashListsForUser(userId),
      buildTrashFoldersForUser(userId),
      buildTrashTimelinesForUser(userId),
      buildTrashMilestonesForUser(userId),
    ]);

    wlog(`bootstrap GET user=${userId} workspace=${workspaceId ?? 'ALL'} → Success`);

    res.json({
      tasks,
      lists,
      folders,
      timelines,
      trash,
      trashLists,
      trashFolders,
      trashTimelines,
      trashMilestones,
    });
  } catch (err) {
    werr('bootstrap GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
