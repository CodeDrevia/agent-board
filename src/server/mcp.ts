import { Router, json, type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { actorFor, explicitActorFor, publicHostname, type Principal } from './auth';
import {
  cleanContentType,
  cleanFilename,
  maxUploadBytes,
  readStoredFile,
  removeStoredFile,
  storeFile,
} from './files';
import {
  acknowledgeMessage,
  addAttachment,
  getAttachment,
  listAttachments,
  listComments,
  listTargets,
  parseDueDate,
  parseLinks,
  parsePriority,
  setResult,
  updateTask,
  claimTask,
  commentTask,
  countInbox,
  createChannel,
  createTask,
  getTask,
  heartbeat,
  joinChannel,
  leaveChannel,
  listActivity,
  listAgents,
  listChannels,
  listMessages,
  listTasks,
  listThreads,
  readInbox,
  releaseTask,
  sendMessage,
  setStatus,
  type AgentKind,
  type TaskStatus,
} from './repo';
import {
  createQueue,
  deleteQueue,
  joinQueue,
  leaveQueue,
  listQueues,
  normaliseQueueName,
  parseLeaseMs,
  releaseQueue,
  renewQueue,
  MAX_LEASE_MS,
  type QueueMember,
  type QueueResult,
} from './queues';

const TASK_STATUSES = [
  'todo',
  'claimed',
  'in_progress',
  'blocked',
  'done',
  'abandoned',
] as const satisfies readonly TaskStatus[];
const AGENT_KINDS = ['claude', 'codex', 'other'] as const satisfies readonly AgentKind[];

// Shared argument schemas: one name and one description per concept.
const STATUS_HELP =
  'todo = open, nobody on it; claimed = someone took it; in_progress = being worked; ' +
  'blocked = waiting on something; done = finished; abandoned = dropped.';
const TARGET_HELP =
  'Who the task is for: "orchestrator", "chatgpt", or a person\'s username such as "alessandro" or "lorenzo". Case-insensitive.';
const taskIdArg = () =>
  z.coerce
    .number()
    .int()
    .positive()
    .describe('Task number, e.g. 42 for task #42. ("id" is accepted as a deprecated alias.)');
const agentArg = () =>
  z.string().trim().min(1).describe('Your agent name, e.g. "claude-drevia" or "chatgpt".');
const repoArg = () =>
  z.string().trim().min(1).describe('Repository the task belongs to, e.g. "clashboard" or "agent-board".');
const tagsArg = () => z.string().max(1_000).describe('Comma-separated tags, e.g. "bug,frontend".');
const priorityArg = () =>
  z
    .union([z.number().int(), z.enum(['low', 'normal', 'high', 'urgent'])])
    .describe(
      'Priority; higher is more urgent and listed first. Either an integer or a level: ' +
        'low = -1, normal = 0 (default), high = 1, urgent = 2.',
    );
const dueDateArg = () => z.string().describe('Due date as YYYY-MM-DD.');

const queueArg = () =>
  z
    .string()
    .trim()
    .min(1)
    .max(64)
    .describe(
      'Queue name, one per shared resource, e.g. "zen-browser", "deploy-drevia", "phone", "gpu-pc". ' +
        'Case-insensitive; spaces become dashes.',
    );
const leaseArg = () =>
  z
    .number()
    .int()
    .positive()
    .describe(
      `Lease length in milliseconds, e.g. 600000 for 10 minutes; capped at ${MAX_LEASE_MS} (24 h). ` +
        'When it runs out the queue passes to the next waiter.',
    );

/** Apply the REST lease rules (clamped to 1 s .. 24 h); zod has already checked it is a positive integer. */
function clampLease(ms: number | undefined): number | undefined {
  const lease = parseLeaseMs(ms);
  return lease === 'invalid' ? undefined : lease;
}

const queueThreadArg = () =>
  z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Your T3 thread id. With agent it identifies you in the queue: the same agent name from ' +
        'another thread is someone else. Pass the one you joined with on renew, release and leave.',
    );

/** Run a queue operation on a validated name and map its result to a tool response. */
function queueTool(
  raw: string,
  member: QueueMember,
  op: (name: string) => QueueResult,
): ToolResponse {
  const name = normaliseQueueName(raw);
  if (!name) return toolError('Queue names are 1-64 letters, digits, ".", "_" or "-".');
  const result = op(name);
  if (result.ok) return toolResult({ queue: result.queue, you: result.you });
  if (result.reason === 'not_found')
    return toolError(`Queue "${name}" does not exist; create it with queue_create.`, {
      reason: 'not_found',
    });
  const as = member.thread_id ? `${member.agent} in thread ${member.thread_id}` : member.agent;
  return toolError(
    `You (${as}) do not hold queue "${name}". Pass the agent and thread_id you joined with.`,
    result,
  );
}

/** Deprecated argument names still accepted: old name -> canonical name. */
const COMMON_ALIASES: Readonly<Record<string, string>> = { id: 'task_id', message: 'body' };

type ToolResponse = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function toolResult(value: unknown): ToolResponse {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function toolError(message: string, value?: unknown): ToolResponse {
  return {
    content: [{ type: 'text' as const, text: message }],
    ...(value === undefined ? {} : { structuredContent: value as Record<string, unknown> }),
    isError: true,
  };
}

/**
 * One board capability. These are kept in a registry rather than registered
 * directly so the server can either advertise them all or hide them behind
 * `search_tools` / `call_tool`.
 */
interface BoardTool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  /** Extra search terms that do not appear in the name or description. */
  keywords: string;
  shape: Shape;
  handler: (args: z.infer<z.ZodObject<Shape>>) => ToolResponse | Promise<ToolResponse>;
}

function defineTool<Shape extends z.ZodRawShape>(tool: BoardTool<Shape>): BoardTool {
  return tool as unknown as BoardTool;
}

/** Deprecated aliases that apply to one tool (only those whose target it takes). */
function aliasesOf(tool: BoardTool): [string, string][] {
  return Object.entries(COMMON_ALIASES).filter(
    ([alias, canonical]) => canonical in tool.shape && !(alias in tool.shape),
  );
}

/** Rewrite deprecated argument names to their canonical names. */
export function normalizeArgs(tool: BoardTool, args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  for (const [alias, canonical] of aliasesOf(tool)) {
    if (!(alias in out)) continue;
    if (out[canonical] === undefined) out[canonical] = out[alias];
    delete out[alias];
  }
  return out;
}


const BOARD_TOOLS: readonly BoardTool[] = [
  defineTool({
    name: 'heartbeat',
    description: 'Register or refresh an agent identity on the shared board.',
    keywords: 'check in presence online session start identity',
    shape: {
      agent: agentArg(),
      kind: z.enum(AGENT_KINDS).optional().describe('What runs this agent: claude, codex or other.'),
      host: z.string().trim().min(1).optional().describe('Machine the agent runs on, e.g. "lorenzo-dev".'),
    },
    handler: ({ agent, kind, host }) => toolResult({ agent: heartbeat({ name: agent, kind, host }) }),
  }),

  defineTool({
    name: 'list_tasks',
    description:
      'List open tasks on the shared queue, highest priority first. Filter by target to find work meant for you (e.g. target="chatgpt").',
    keywords: 'find work backlog todo search board repo status target queue for me assigned',
    shape: {
      repo: repoArg().optional(),
      status: z.enum(TASK_STATUSES).optional().describe(`Only tasks in this status. ${STATUS_HELP}`),
      q: z.string().trim().min(1).optional().describe('Free-text search in title, body and tags.'),
      target: z
        .string()
        .trim()
        .max(64)
        .optional()
        .describe(`Only tasks for this target. ${TARGET_HELP} Pass "" for tasks meant for anyone.`),
    },
    handler: ({ repo, status, q, target }) =>
      toolResult({ tasks: listTasks({ repo, status, q, target }) }),
  }),

  defineTool({
    name: 'post_task',
    description: 'Post a new task to the shared board. Put the task text in body; set target to address it to someone.',
    keywords: 'create add new work item ticket',
    shape: {
      title: z.string().trim().min(1).max(500).describe('Short one-line summary of the work.'),
      repo: repoArg().optional(),
      body: z.string().max(16_000).optional().describe('Full task text (markdown): what to do and why.'),
      tags: tagsArg().optional(),
      priority: priorityArg().optional(),
      agent: agentArg().optional().describe('Creator of the task.'),
      target: z
        .string()
        .trim()
        .max(64)
        .optional()
        .describe(`${TARGET_HELP} Omit for anyone.`),
      due_date: dueDateArg().optional(),
    },
    handler: ({ title, repo, body, tags, priority, agent, target, due_date }) => {
      const due = parseDueDate(due_date);
      if (due === 'invalid') return toolError('due_date must be YYYY-MM-DD.');
      const prio = parsePriority(priority);
      if (prio === 'invalid') return toolError('priority must be an integer or low/normal/high/urgent.');
      return toolResult({
        task: createTask({ title, repo, body, tags, priority: prio, created_by: agent, target, due_date: due }),
      });
    },
  }),

  defineTool({
    name: 'update_task',
    description: 'Edit a task: title, details, tags, priority, repo, target, or due date.',
    keywords: 'edit change retarget reassign due deadline priority modify',
    shape: {
      task_id: taskIdArg(),
      title: z.string().trim().min(1).max(500).optional().describe('New one-line summary.'),
      body: z.string().max(16_000).optional().describe('New full task text (replaces the old one).'),
      tags: tagsArg().optional(),
      priority: priorityArg().optional(),
      repo: repoArg().optional(),
      target: z.string().trim().max(64).optional().describe(`${TARGET_HELP} Pass "" to make it for anyone.`),
      due_date: dueDateArg().nullable().optional().describe('Due date as YYYY-MM-DD, or null to clear it.'),
    },
    handler: ({ task_id, due_date, priority, ...patch }) => {
      const due = due_date === undefined ? undefined : parseDueDate(due_date);
      if (due === 'invalid') return toolError('due_date must be YYYY-MM-DD.');
      const prio = parsePriority(priority);
      if (prio === 'invalid') return toolError('priority must be an integer or low/normal/high/urgent.');
      const task = updateTask(task_id, { ...patch, priority: prio, due_date: due });
      return task
        ? toolResult({ task })
        : toolError(`Task #${task_id} was not found.`, { reason: 'not_found' });
    },
  }),

  defineTool({
    name: 'set_task_result',
    description:
      'Write the outcome of a task (text plus links such as PRs or docs). Replaces any earlier result.',
    keywords: 'result outcome answer deliver output links report finish',
    shape: {
      task_id: taskIdArg(),
      result: z.string().max(16_000).describe('What was done or found (markdown).'),
      links: z.array(z.string()).max(20).optional().describe('Up to 20 http(s) URLs, e.g. PRs or docs.'),
      agent: agentArg(),
    },
    handler: ({ task_id, result, links, agent }) => {
      const parsed = parseLinks(links);
      if (parsed === null) return toolError('links must be up to 20 http(s) URLs.');
      const task = setResult(task_id, { result, links: parsed, agent });
      return task
        ? toolResult({ task })
        : toolError(`Task #${task_id} was not found.`, { reason: 'not_found' });
    },
  }),

  defineTool({
    name: 'list_targets',
    description: 'List the targets tasks are currently addressed to.',
    keywords: 'who for recipients assignees queues',
    shape: {},
    handler: () => toolResult({ targets: listTargets() }),
  }),

  defineTool({
    name: 'add_attachment',
    description: 'Attach a file to a task (base64 content, size limited).',
    keywords: 'upload file attach document image',
    shape: {
      task_id: taskIdArg(),
      filename: z.string().trim().min(1).max(200).describe('File name shown on the board, e.g. "report.pdf".'),
      content_base64: z.string().min(1).describe('File content, base64-encoded.'),
      content_type: z.string().max(100).optional().describe('MIME type, e.g. "application/pdf".'),
      agent: agentArg(),
    },
    handler: ({ task_id, filename, content_base64, content_type, agent }) => {
      if (!getTask(task_id)) return toolError(`Task #${task_id} was not found.`, { reason: 'not_found' });
      const bytes = Buffer.from(content_base64, 'base64');
      if (bytes.length === 0) return toolError('The file is empty or not base64.');
      if (bytes.length > maxUploadBytes())
        return toolError(`The file is larger than ${maxUploadBytes()} bytes.`);
      const stored = storeFile(bytes);
      try {
        return toolResult({
          attachment: addAttachment({
            task_id,
            filename: cleanFilename(filename),
            content_type: cleanContentType(content_type),
            size: bytes.length,
            stored_name: stored,
            uploaded_by: agent,
          }),
        });
      } catch (error) {
        removeStoredFile(stored);
        throw error;
      }
    },
  }),

  defineTool({
    name: 'read_attachment',
    description: 'Read one attachment of a task; returns its content as base64 (up to 2 MB).',
    keywords: 'download file open attachment content',
    shape: {
      attachment_id: z.coerce.number().int().positive().describe('Attachment number, from get_task.'),
    },
    handler: ({ attachment_id }) => {
      const a = getAttachment(attachment_id);
      if (!a) return toolError(`Attachment #${attachment_id} was not found.`, { reason: 'not_found' });
      if (a.size > 2 * 1024 * 1024)
        return toolError('This file is too large to return here; open it on the board.', {
          attachment: a,
        });
      try {
        return toolResult({ attachment: a, content_base64: readStoredFile(a.stored_name).toString('base64') });
      } catch {
        return toolError('The file is missing on disk.', { reason: 'gone' });
      }
    },
  }),

  defineTool({
    name: 'get_task',
    description: 'Fetch one task by task_id, with its result, attachments, and comments.',
    keywords: 'read detail single show',
    shape: { task_id: taskIdArg() },
    handler: ({ task_id }) => {
      const task = getTask(task_id);
      return task
        ? toolResult({
            task,
            attachments: listAttachments(task_id),
            comments: listComments(task_id),
          })
        : toolError(`Task #${task_id} was not found.`, { reason: 'not_found' });
    },
  }),

  defineTool({
    name: 'claim_task',
    description: 'Claim a free (todo) task so others know you are on it. Fails if someone else holds it.',
    keywords: 'take own lock assign reserve',
    shape: { task_id: taskIdArg(), agent: agentArg() },
    handler: ({ task_id, agent }) => {
      const result = claimTask(task_id, agent);
      return result.ok
        ? toolResult({ task: result.task })
        : toolError(
            result.reason === 'not_found'
              ? `Task #${task_id} was not found.`
              : `Task #${task_id} is already owned by ${result.task.claimed_by ?? 'another agent'}.`,
            result,
          );
    },
  }),

  defineTool({
    name: 'release_task',
    description: 'Release your claimed, in_progress or blocked task back to the shared task pool (status todo).',
    keywords: 'give back unclaim abandon drop stop',
    shape: { task_id: taskIdArg(), agent: agentArg() },
    handler: ({ task_id, agent }) => {
      const result = releaseTask(task_id, agent);
      return result.ok
        ? toolResult({ task: result.task })
        : toolError(
            result.reason === 'not_found'
              ? `Task #${task_id} was not found.`
              : result.reason === 'not_claimed_by_you'
                ? `Task #${task_id} is claimed by ${result.task.claimed_by ?? 'nobody'}, not ${agent}.`
                : `Task #${task_id} is ${result.task.status}; only claimed, in_progress or blocked tasks can be released.`,
            result,
          );
    },
  }),

  defineTool({
    name: 'set_task_status',
    description: 'Change a task status: todo, claimed, in_progress, blocked, done, abandoned. Optional note in body.',
    keywords: 'start done finish in_progress blocked progress update',
    shape: {
      task_id: taskIdArg(),
      status: z.enum(TASK_STATUSES).describe(`New status. ${STATUS_HELP}`),
      agent: agentArg(),
      body: z
        .string()
        .trim()
        .min(1)
        .max(16_000)
        .optional()
        .describe('Optional note on the change, e.g. why it is blocked. ("message" is a deprecated alias.)'),
    },
    handler: ({ task_id, status, agent, body }) => {
      const result = setStatus(task_id, status, agent, body);
      return result.ok
        ? toolResult({ task: result.task })
        : toolError(`Could not set task #${task_id} to ${status}: ${result.reason}.`, result);
    },
  }),

  defineTool({
    name: 'comment_task',
    description: 'Add a comment to a task. The comment text goes in body.',
    keywords: 'note annotate context discuss',
    shape: {
      task_id: taskIdArg(),
      agent: agentArg(),
      body: z
        .string()
        .trim()
        .min(1)
        .max(16_000)
        .describe('Comment text (markdown). ("message" is a deprecated alias.)'),
    },
    handler: ({ task_id, agent, body }) =>
      commentTask(task_id, agent, body)
        ? toolResult({ posted: true, task_id })
        : toolError(`Task #${task_id} was not found.`, { reason: 'not_found' }),
  }),

  defineTool({
    name: 'list_activity',
    description: 'Read recent public activity from the shared board.',
    keywords: 'feed history log recent events',
    shape: {
      repo: repoArg().optional(),
      limit: z.number().int().min(1).max(500).optional().describe('Most recent N events (default server-side).'),
    },
    handler: ({ repo, limit }) => toolResult({ activity: listActivity({ repo, limit }) }),
  }),

  defineTool({
    name: 'send_message',
    description: 'Send a durable mailbox message to another agent or a channel. The text goes in body.',
    keywords: 'mail dm write tell notify channel post',
    shape: {
      from: z.string().trim().min(1).describe('Your agent name (the sender).'),
      to: z
        .string()
        .trim()
        .min(1)
        .describe('Recipient agent name, or "#<channel-id>" to post to a channel.'),
      body: z
        .string()
        .trim()
        .min(1)
        .max(16_000)
        .describe('Message text. ("message" is a deprecated alias.)'),
      thread_id: z.string().trim().min(1).max(200).optional().describe('Conversation thread to reply in; omit to start one.'),
    },
    handler: ({ from, to, body, thread_id }) => {
      const result = sendMessage({
        sender: from,
        recipient: to,
        body,
        thread_id,
      });
      return result.ok
        ? toolResult({ message: result.message })
        : toolError(
            `Agent ${to} is not active. Ask it to heartbeat before sending a message.`,
            result,
          );
    },
  }),

  defineTool({
    name: 'read_inbox',
    description: 'Read pending messages addressed to an agent, oldest first.',
    keywords: 'mail unread poll check pending receive',
    shape: {
      agent: agentArg(),
      after_id: z.number().int().nonnegative().optional().describe('Only messages after this id (pass next_cursor).'),
      limit: z.number().int().min(1).max(200).optional().describe('Maximum messages to return.'),
      include_acknowledged: z.boolean().optional().describe('Also return messages already acknowledged.'),
    },
    handler: ({ agent, after_id, limit, include_acknowledged }) => {
      const messages = readInbox({
        agent,
        after_id,
        limit,
        include_acknowledged,
      });
      return toolResult({
        messages,
        pending: countInbox(agent),
        next_cursor: messages.at(-1)?.id ?? after_id ?? 0,
      });
    },
  }),

  defineTool({
    name: 'search_messages',
    description:
      'Search the shared message transcript by text, thread, participant, or unread state.',
    keywords: 'find history past mail grep transcript',
    shape: {
      q: z.string().trim().min(1).max(500).optional().describe('Free-text match'),
      thread_id: z.string().trim().min(1).max(200).optional().describe('Only this conversation thread.'),
      agent: z.string().trim().min(1).optional().describe('Only messages sent or received by this agent.'),
      unread_only: z.boolean().optional().describe('Only messages not yet acknowledged.'),
      after_id: z.number().int().nonnegative().optional().describe('Only messages after this id (pass next_cursor).'),
      limit: z.number().int().min(1).max(200).optional().describe('Maximum messages to return.'),
    },
    handler: ({ q, thread_id, agent, unread_only, after_id, limit }) => {
      const messages = listMessages({ q, thread_id, agent, unread_only, after_id, limit });
      return toolResult({
        messages,
        next_cursor: messages.at(-1)?.id ?? after_id ?? 0,
      });
    },
  }),

  defineTool({
    name: 'list_threads',
    description: 'List conversation threads with their message and unread counts.',
    keywords: 'conversations topics mail overview',
    shape: { limit: z.number().int().min(1).max(500).optional().describe('Maximum threads to return.') },
    handler: ({ limit }) => toolResult({ threads: listThreads({ limit }) }),
  }),

  defineTool({
    name: 'acknowledge_message',
    description: 'Mark one received message as acknowledged.',
    keywords: 'ack handled read mark done mail',
    shape: {
      agent: agentArg(),
      message_id: z.coerce.number().int().positive().describe('Id of the message, from read_inbox.'),
    },
    handler: ({ agent, message_id }) => {
      const message = acknowledgeMessage(message_id, agent);
      return message
        ? toolResult({ message })
        : toolError('Message not found for this recipient.', { reason: 'not_found' });
    },
  }),

  defineTool({
    name: 'list_agents',
    description: 'List known agent identities and their last heartbeat time.',
    keywords: 'who online peers roster others',
    shape: {},
    handler: () => toolResult({ agents: listAgents() }),
  }),

  defineTool({
    name: 'list_channels',
    description: 'List group-chat channels and their members.',
    keywords: 'rooms groups broadcast membership',
    shape: {},
    handler: () => toolResult({ channels: listChannels() }),
  }),

  defineTool({
    name: 'create_channel',
    description:
      'Create a group-chat channel. Send to it with send_message using to="#<channel-id>".',
    keywords: 'new room group broadcast',
    shape: {
      name: z.string().trim().min(1).max(200).describe('Channel name, e.g. "release-planning".'),
      agent: agentArg().optional().describe('Creator; auto-joined as a member.'),
      members: z.array(z.string().trim().min(1)).optional().describe('Agent names to add as members.'),
    },
    handler: ({ name, agent, members }) => {
      const result = createChannel({ name, created_by: agent, members });
      return result.ok
        ? toolResult({ channel: result.channel })
        : toolError(`Could not create channel: ${result.reason}.`, result);
    },
  }),

  defineTool({
    name: 'join_channel',
    description: 'Join a group-chat channel so its messages reach your inbox.',
    keywords: 'subscribe enter room group',
    shape: {
      channel_id: z.string().trim().min(1).describe('Channel id, from list_channels (without the "#").'),
      agent: agentArg(),
    },
    handler: ({ channel_id, agent }) => {
      const channel = joinChannel(channel_id, agent);
      return channel
        ? toolResult({ channel })
        : toolError(`Channel #${channel_id} was not found.`, { reason: 'not_found' });
    },
  }),

  defineTool({
    name: 'leave_channel',
    description: 'Leave a group-chat channel.',
    keywords: 'unsubscribe exit room group',
    shape: {
      channel_id: z.string().trim().min(1).describe('Channel id, from list_channels (without the "#").'),
      agent: agentArg(),
    },
    handler: ({ channel_id, agent }) => {
      const channel = leaveChannel(channel_id, agent);
      return channel
        ? toolResult({ channel })
        : toolError(`Channel #${channel_id} was not found.`, { reason: 'not_found' });
    },
  }),

  defineTool({
    name: 'list_queues',
    description:
      'List shared-resource queues (locks): who holds each one, when their lease expires, and who waits in which order.',
    keywords: 'locks resources mutex waiting turn holder browser deploy phone gpu',
    shape: {},
    handler: () => toolResult({ queues: listQueues() }),
  }),

  defineTool({
    name: 'queue_create',
    description:
      'Create a named queue for a shared resource. Safe to call when it already exists; lease_ms then replaces its default lease.',
    keywords: 'new lock resource mutex',
    shape: {
      queue: queueArg(),
      lease_ms: leaseArg()
        .optional()
        .describe(
          'Default lease for holders of this queue, in ms (default 1800000 = 30 min, max 24 h).',
        ),
      agent: agentArg().optional().describe('Creator of the queue.'),
    },
    handler: ({ queue, lease_ms, agent }) => {
      const name = normaliseQueueName(queue);
      if (!name) return toolError('Queue names are 1-64 letters, digits, ".", "_" or "-".');
      return toolResult(createQueue({ name, lease_ms: clampLease(lease_ms), created_by: agent }));
    },
  }),

  defineTool({
    name: 'queue_join',
    description:
      'Ask for a shared resource. If the queue is free you hold it at once (you.state = "holding"); otherwise you wait ' +
      'in line (you.state = "waiting", you.position = 1 means next) and a queue.granted webhook fires when it is your turn. ' +
      'If your lease runs out the queue passes on and queue.expired fires: for long jobs such as deploys, ask for a lease ' +
      'longer than your slowest run and renew. Joining again only reports where you stand. Release it as soon as you are done.',
    keywords: 'lock acquire wait turn reserve resource mutex enqueue',
    shape: {
      queue: queueArg(),
      agent: agentArg(),
      thread_id: queueThreadArg(),
      note: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .optional()
        .describe('What you need it for, e.g. "PR #12 visual check".'),
      lease_ms: leaseArg()
        .optional()
        .describe("Lease for this hold, in ms; default is the queue's lease (max 24 h)."),
    },
    handler: ({ queue, agent, thread_id, note, lease_ms }) =>
      queueTool(queue, { agent, thread_id }, (name) =>
        joinQueue({ name, agent, thread_id, note, lease_ms: clampLease(lease_ms) }),
      ),
  }),

  defineTool({
    name: 'queue_renew',
    description:
      'Extend your lease on a queue you hold, counted from now. Fails if you do not hold it.',
    keywords: 'extend lease keep lock heartbeat more time',
    shape: {
      queue: queueArg(),
      agent: agentArg(),
      thread_id: queueThreadArg(),
      lease_ms: leaseArg()
        .optional()
        .describe('New lease from now, in ms; default is the lease you were granted (max 24 h).'),
    },
    handler: ({ queue, agent, thread_id, lease_ms }) =>
      queueTool(queue, { agent, thread_id }, (name) =>
        renewQueue(name, { agent, thread_id }, clampLease(lease_ms)),
      ),
  }),

  defineTool({
    name: 'queue_release',
    description: 'Free a queue you hold so the next waiter gets it. Only the holder can release.',
    keywords: 'unlock free done finished give back resource',
    shape: { queue: queueArg(), agent: agentArg(), thread_id: queueThreadArg() },
    handler: ({ queue, agent, thread_id }) =>
      queueTool(queue, { agent, thread_id }, (name) => releaseQueue(name, { agent, thread_id })),
  }),

  defineTool({
    name: 'queue_leave',
    description:
      'Stop waiting for a queue. If you hold it, this releases it. Does nothing if you are not in it.',
    keywords: 'cancel wait dequeue give up unlock',
    shape: { queue: queueArg(), agent: agentArg(), thread_id: queueThreadArg() },
    handler: ({ queue, agent, thread_id }) =>
      queueTool(queue, { agent, thread_id }, (name) => leaveQueue(name, { agent, thread_id })),
  }),

  defineTool({
    name: 'queue_delete',
    description:
      'Delete a queue and drop its waiters; a queue.deleted webhook names the holder and waiters it removed. ' +
      'Refused while someone holds it unless force is true.',
    keywords: 'remove lock resource mutex drop',
    shape: {
      queue: queueArg(),
      force: z.boolean().optional().describe('Delete even while someone holds it.'),
    },
    handler: ({ queue, force }) => {
      const name = normaliseQueueName(queue);
      if (!name) return toolError('Queue names are 1-64 letters, digits, ".", "_" or "-".');
      const result = deleteQueue(name, force ?? false);
      if (result.ok) return toolResult({ deleted: result.deleted });
      if (result.reason === 'not_found')
        return toolError(`Queue "${name}" does not exist.`, { reason: 'not_found' });
      const { agent, thread_id } = result.queue.holder!;
      const by = thread_id ? `${agent} in thread ${thread_id}` : agent;
      return toolError(`Queue "${name}" is held by ${by}.`, result);
    },
  }),
];

/** Queue tools never fall back to the token's name: every caller sharing it would be one member. */
const EXPLICIT_ACTOR = new Set(['queue_join', 'queue_renew', 'queue_release', 'queue_leave']);

/** Tools whose optional `agent` still means "who is doing this" (creator). */
const ACTOR_WHEN_OPTIONAL = new Set(['post_task', 'create_channel', 'queue_create']);

/** The argument names that carry the acting agent for one tool. */
function actorKeys(tool: BoardTool): string[] {
  const keys: string[] = [];
  for (const key of ['agent', 'from'] as const) {
    const field = tool.shape[key] as z.ZodTypeAny | undefined;
    if (field && (!field.isOptional() || ACTOR_WHEN_OPTIONAL.has(tool.name))) keys.push(key);
  }
  return keys;
}

/**
 * Fill in who is acting. A signed-in user (ChatGPT over OAuth) always acts as
 * themselves, whatever name they pass; the static token keeps the old behaviour
 * of naming any agent.
 */
function withActor(tool: BoardTool, args: unknown, who: Principal): Record<string, unknown> {
  const out = normalizeArgs(tool, { ...((args as Record<string, unknown>) ?? {}) });
  for (const key of actorKeys(tool)) {
    out[key] = EXPLICIT_ACTOR.has(tool.name)
      ? (explicitActorFor(who, out[key]) ?? undefined)
      : actorFor(who, out[key]);
  }
  return out;
}

/** The advertised schema: actor fields are optional (the server fills them in). */
function advertisedShape(tool: BoardTool, withAliases = false): z.ZodRawShape {
  const shape: z.ZodRawShape = { ...tool.shape };
  for (const key of actorKeys(tool)) {
    shape[key] = (tool.shape[key] as z.ZodTypeAny)
      .optional()
      .describe(
        EXPLICIT_ACTOR.has(tool.name)
          ? 'Your agent name, required: a name only you use, not a shared default. ' +
              'Ignored for signed-in users, who act as themselves.'
          : 'Acting agent name. Ignored for signed-in users, who act as themselves.',
      );
  }
  if (!withAliases) return shape;
  // Directly registered tools are validated by the SDK, which drops unknown
  // keys, so the deprecated aliases must be in the schema to reach runTool.
  // The canonical field is then optional here and still enforced in runTool.
  for (const [alias, canonical] of aliasesOf(tool)) {
    const field = tool.shape[canonical] as z.ZodTypeAny;
    shape[canonical] = field.isOptional()
      ? field
      : field.optional().describe(`${field.description ?? ''} Required.`.trim());
    shape[alias] = field.optional().describe(`Deprecated alias of ${canonical}; use ${canonical}.`);
  }
  return shape;
}

async function runTool(tool: BoardTool, args: unknown, who: Principal): Promise<ToolResponse> {
  const input = withActor(tool, args, who);
  if (EXPLICIT_ACTOR.has(tool.name) && input['agent'] === undefined) {
    return toolError(
      `${tool.name} needs an explicit agent: a name only you use. Without it every caller ` +
        'sharing the board token would be the same queue member.',
      { reason: 'agent_required', tool: tool.name },
    );
  }
  const parsed = z.object(tool.shape).safeParse(input);
  if (!parsed.success) {
    return toolError(
      `Invalid arguments for ${tool.name}: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
        .join('; ')}`,
      { reason: 'invalid_arguments', tool: tool.name, inputSchema: inputSchemaOf(tool) },
    );
  }
  return tool.handler(parsed.data as never);
}

const TOOLS_BY_NAME = new Map(BOARD_TOOLS.map((tool) => [tool.name, tool]));
const TOOL_NAMES = BOARD_TOOLS.map((tool) => tool.name);

function inputSchemaOf(tool: BoardTool): Record<string, unknown> {
  return zodToJsonSchema(z.object(advertisedShape(tool)), {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as Record<string, unknown>;
}

function scoreTool(tool: BoardTool, terms: readonly string[]): number {
  const name = tool.name.toLowerCase();
  const haystack = `${name} ${tool.description} ${tool.keywords}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name === term) score += 100;
    else if (name.includes(term)) score += 20;
    if (haystack.includes(term)) score += 5;
  }
  return score;
}

const SEARCH_INSTRUCTIONS = [
  'Coordinate shared work through this board. Tools are not all advertised: call search_tools',
  'to look one up by intent, then call_tool to run it. Arguments are validated, and an invalid',
  'call returns the tool JSON Schema so you can retry immediately.',
  `Available tools: ${TOOL_NAMES.join(', ')}.`,
  'Usual flow: list_tasks (filter by target to find work for you), claim_task, set_task_status, set_task_result, comment_task. Post work for others with post_task and a target.',
  'For a shared resource (browser, deploy, phone, GPU PC): queue_join with your own agent name and',
  'thread_id, then queue_release with the same two when done.',
  'Mail delivery is pull-based: nothing here can interrupt you, so run read_inbox at session',
  'start and after each meaningful work boundary, then acknowledge_message what you handled.',
].join(' ');

const FULL_INSTRUCTIONS =
  'Coordinate shared work through heartbeat, list_tasks, post_task, claim_task, set_task_status, release_task, and comment_task. Use mailbox tools for notes addressed to one agent. Mail delivery is pull-based: nothing here can interrupt you, so call read_inbox at session start and after each meaningful work boundary, then acknowledge_message what you have handled.';

export type McpToolMode = 'search' | 'full';

/**
 * `search` (default) advertises only search_tools/call_tool to keep the client
 * tool list small; `full` advertises every board tool directly. Override with
 * AGENT_BOARD_MCP_TOOLS=full for clients that cannot do tool discovery.
 */
export function defaultToolMode(): McpToolMode {
  return process.env['AGENT_BOARD_MCP_TOOLS']?.trim().toLowerCase() === 'full' ? 'full' : 'search';
}

function registerAllTools(server: McpServer, who: Principal): void {
  for (const tool of BOARD_TOOLS) {
    const hasInput = Object.keys(tool.shape).length > 0;
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        ...(hasInput ? { inputSchema: advertisedShape(tool, true) } : {}),
      },
      async (args: unknown) => runTool(tool, args, who),
    );
  }
}

function registerSearchTools(server: McpServer, who: Principal): void {
  server.registerTool(
    'search_tools',
    {
      description:
        'Find agent-board tools by intent and get their JSON Schemas. Run the result with call_tool. ' +
        `Known tools: ${TOOL_NAMES.join(', ')}.`,
      inputSchema: {
        query: z
          .string()
          .trim()
          .max(200)
          .optional()
          .describe('What you want to do, e.g. "claim a task" or "check mail". Omit to list all.'),
        limit: z.number().int().min(1).max(BOARD_TOOLS.length).optional(),
      },
    },
    async ({ query, limit }) => {
      const terms = (query ?? '')
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter(Boolean);
      const ranked = terms.length
        ? BOARD_TOOLS.map((tool) => ({ tool, score: scoreTool(tool, terms) }))
            .filter((entry) => entry.score > 0)
            .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
            .map((entry) => entry.tool)
        : [...BOARD_TOOLS];
      const matches = ranked.slice(0, limit ?? (terms.length ? 5 : BOARD_TOOLS.length));
      return toolResult({
        tools: matches.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: inputSchemaOf(tool),
        })),
        matched: ranked.length,
        all_tools: TOOL_NAMES,
      });
    },
  );

  server.registerTool(
    'call_tool',
    {
      description:
        'Run one agent-board tool by name with its arguments. Use search_tools first if you are ' +
        'unsure of the name or the argument shape.',
      inputSchema: {
        tool: z.string().trim().min(1).describe('Tool name, e.g. "claim_task"'),
        args: z
          .record(z.unknown())
          .optional()
          .describe('Arguments object for that tool; omit when it takes none.'),
      },
    },
    async ({ tool, args }) => {
      const target = TOOLS_BY_NAME.get(tool);
      if (!target) {
        return toolError(`Unknown tool "${tool}". Use search_tools to find the right name.`, {
          reason: 'unknown_tool',
          all_tools: TOOL_NAMES,
        });
      }
      return runTool(target, args, who);
    },
  );
}

/** Create one stateless MCP server instance for a single HTTP request. */
export function createMailboxMcpServer(
  options: { mode?: McpToolMode; principal?: Principal } = {},
): McpServer {
  const mode = options.mode ?? defaultToolMode();
  const who: Principal = options.principal ?? { kind: 'open', sub: 'open', name: '' };
  const server = new McpServer(
    { name: 'agent-board', version: '1.2.0' },
    { instructions: mode === 'full' ? FULL_INSTRUCTIONS : SEARCH_INSTRUCTIONS },
  );

  if (mode === 'full') registerAllTools(server, who);
  else registerSearchTools(server, who);

  return server;
}

function rejectMethod(res: Response): void {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  });
}

/** Streamable HTTP MCP endpoint, mounted by the main SSR server at `/mcp`. */
export function createMcpRouter(): Router {
  const router = Router();
  // Room for a base64 attachment at the upload limit.
  router.use(json({ limit: Math.ceil(maxUploadBytes() * 1.4) + 64 * 1024 }));
  router.use((req, res, next) => {
    const configured = (process.env['AGENT_BOARD_ALLOWED_HOSTS'] ?? '')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean);
    const own = publicHostname();
    const allowed = new Set(['localhost', '127.0.0.1', '::1', ...configured, ...(own ? [own] : [])]);
    if (!allowed.has(req.hostname)) {
      res.status(403).json({ error: 'host not allowed' });
      return;
    }
    next();
  });
  router.post('/', async (req: Request, res: Response) => {
    const server = createMailboxMcpServer({ principal: res.locals['principal'] as Principal });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error: unknown) {
      console.error('MCP request failed', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    } finally {
      await transport.close();
      await server.close();
    }
  });
  router.get('/', (_req, res) => rejectMethod(res));
  router.delete('/', (_req, res) => rejectMethod(res));
  return router;
}
