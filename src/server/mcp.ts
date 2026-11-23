import { Router, json, type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { actorFor, publicHostname, type Principal } from './auth';
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

const TASK_STATUSES = [
  'todo',
  'claimed',
  'in_progress',
  'blocked',
  'done',
  'abandoned',
] as const satisfies readonly TaskStatus[];
const AGENT_KINDS = ['claude', 'codex', 'other'] as const satisfies readonly AgentKind[];

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

const BOARD_TOOLS: readonly BoardTool[] = [
  defineTool({
    name: 'heartbeat',
    description: 'Register or refresh an agent identity on the shared board.',
    keywords: 'check in presence online session start identity',
    shape: {
      agent: z.string().trim().min(1),
      kind: z.enum(AGENT_KINDS).optional(),
      host: z.string().trim().min(1).optional(),
    },
    handler: ({ agent, kind, host }) => toolResult({ agent: heartbeat({ name: agent, kind, host }) }),
  }),

  defineTool({
    name: 'list_tasks',
    description:
      'List open tasks on the shared queue, highest priority first. Filter by target to find work meant for you (e.g. target="chatgpt").',
    keywords: 'find work backlog todo search board repo status target queue for me assigned',
    shape: {
      repo: z.string().trim().min(1).optional(),
      status: z.enum(TASK_STATUSES).optional(),
      q: z.string().trim().min(1).optional(),
      target: z
        .string()
        .trim()
        .max(64)
        .optional()
        .describe('Only tasks for this target ("orchestrator", "chatgpt", a person); "" = untargeted'),
    },
    handler: ({ repo, status, q, target }) =>
      toolResult({ tasks: listTasks({ repo, status, q, target }) }),
  }),

  defineTool({
    name: 'post_task',
    description: 'Post a new task to the shared Kanban board.',
    keywords: 'create add new work item ticket',
    shape: {
      title: z.string().trim().min(1).max(500),
      repo: z.string().trim().min(1).optional(),
      body: z.string().max(16_000).optional(),
      tags: z.string().max(1_000).optional(),
      priority: z.number().int().optional(),
      agent: z.string().trim().min(1).optional(),
      target: z
        .string()
        .trim()
        .max(64)
        .optional()
        .describe('Who it is for: "orchestrator", "chatgpt", "alessandro", "lorenzo"; omit for anyone'),
      due_date: z.string().optional().describe('YYYY-MM-DD'),
    },
    handler: ({ title, repo, body, tags, priority, agent, target, due_date }) => {
      const due = parseDueDate(due_date);
      if (due === 'invalid') return toolError('due_date must be YYYY-MM-DD.');
      return toolResult({
        task: createTask({ title, repo, body, tags, priority, created_by: agent, target, due_date: due }),
      });
    },
  }),

  defineTool({
    name: 'update_task',
    description: 'Edit a task: title, details, tags, priority, repo, target, or due date.',
    keywords: 'edit change retarget reassign due deadline priority modify',
    shape: {
      task_id: z.number().int().positive(),
      title: z.string().trim().min(1).max(500).optional(),
      body: z.string().max(16_000).optional(),
      tags: z.string().max(1_000).optional(),
      priority: z.number().int().optional(),
      repo: z.string().trim().min(1).optional(),
      target: z.string().trim().max(64).optional(),
      due_date: z.string().nullable().optional().describe('YYYY-MM-DD, or null to clear'),
    },
    handler: ({ task_id, due_date, ...patch }) => {
      const due = due_date === undefined ? undefined : parseDueDate(due_date);
      if (due === 'invalid') return toolError('due_date must be YYYY-MM-DD.');
      const task = updateTask(task_id, { ...patch, due_date: due });
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
      task_id: z.number().int().positive(),
      result: z.string().max(16_000),
      links: z.array(z.string()).max(20).optional().describe('http(s) URLs'),
      agent: z.string().trim().min(1),
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
      task_id: z.number().int().positive(),
      filename: z.string().trim().min(1).max(200),
      content_base64: z.string().min(1),
      content_type: z.string().max(100).optional(),
      agent: z.string().trim().min(1),
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
    shape: { attachment_id: z.number().int().positive() },
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
    description: 'Fetch one task by id, with its result, attachments, and comments.',
    keywords: 'read detail single show',
    shape: { task_id: z.number().int().positive() },
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
    description: 'Atomically claim a free task for an agent.',
    keywords: 'take own lock assign reserve',
    shape: { task_id: z.number().int().positive(), agent: z.string().trim().min(1) },
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
    description: 'Release an agent-owned claim back to the shared task pool.',
    keywords: 'give back unclaim abandon drop stop',
    shape: { task_id: z.number().int().positive(), agent: z.string().trim().min(1) },
    handler: ({ task_id, agent }) => {
      const result = releaseTask(task_id, agent);
      return result.ok
        ? toolResult({ task: result.task })
        : toolError(
            result.reason === 'not_found'
              ? `Task #${task_id} was not found.`
              : `Task #${task_id} is not claimed by ${agent}.`,
            result,
          );
    },
  }),

  defineTool({
    name: 'set_task_status',
    description: 'Advance, block, resume, complete, abandon, or reopen a task.',
    keywords: 'start done finish in_progress blocked progress update',
    shape: {
      task_id: z.number().int().positive(),
      status: z.enum(TASK_STATUSES),
      agent: z.string().trim().min(1),
      message: z.string().trim().min(1).max(16_000).optional(),
    },
    handler: ({ task_id, status, agent, message }) => {
      const result = setStatus(task_id, status, agent, message);
      return result.ok
        ? toolResult({ task: result.task })
        : toolError(`Could not set task #${task_id} to ${status}: ${result.reason}.`, result);
    },
  }),

  defineTool({
    name: 'comment_task',
    description: 'Add an agent comment to a shared-board task.',
    keywords: 'note annotate context discuss',
    shape: {
      task_id: z.number().int().positive(),
      agent: z.string().trim().min(1),
      message: z.string().trim().min(1).max(16_000),
    },
    handler: ({ task_id, agent, message }) =>
      commentTask(task_id, agent, message)
        ? toolResult({ posted: true, task_id })
        : toolError(`Task #${task_id} was not found.`, { reason: 'not_found' }),
  }),

  defineTool({
    name: 'list_activity',
    description: 'Read recent public activity from the shared board.',
    keywords: 'feed history log recent events',
    shape: {
      repo: z.string().trim().min(1).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    handler: ({ repo, limit }) => toolResult({ activity: listActivity({ repo, limit }) }),
  }),

  defineTool({
    name: 'send_message',
    description: 'Send a durable mailbox message to another agent.',
    keywords: 'mail dm write tell notify channel post',
    shape: {
      from: z.string().trim().min(1).describe('Sending agent identity'),
      to: z.string().trim().min(1).describe('Recipient agent identity'),
      message: z.string().trim().min(1).max(16_000),
      thread_id: z.string().trim().min(1).max(200).optional(),
    },
    handler: ({ from, to, message, thread_id }) => {
      const result = sendMessage({
        sender: from,
        recipient: to,
        body: message,
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
      agent: z.string().trim().min(1),
      after_id: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      include_acknowledged: z.boolean().optional(),
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
      thread_id: z.string().trim().min(1).max(200).optional(),
      agent: z.string().trim().min(1).optional().describe('Sender or recipient'),
      unread_only: z.boolean().optional().describe('Only messages not yet acknowledged'),
      after_id: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(200).optional(),
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
    shape: { limit: z.number().int().min(1).max(500).optional() },
    handler: ({ limit }) => toolResult({ threads: listThreads({ limit }) }),
  }),

  defineTool({
    name: 'acknowledge_message',
    description: 'Mark one received message as acknowledged.',
    keywords: 'ack handled read mark done mail',
    shape: {
      agent: z.string().trim().min(1),
      message_id: z.number().int().positive(),
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
      name: z.string().trim().min(1).max(200),
      agent: z.string().trim().min(1).optional().describe('Creator; auto-joined as a member'),
      members: z.array(z.string().trim().min(1)).optional(),
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
      channel_id: z.string().trim().min(1),
      agent: z.string().trim().min(1),
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
      channel_id: z.string().trim().min(1),
      agent: z.string().trim().min(1),
    },
    handler: ({ channel_id, agent }) => {
      const channel = leaveChannel(channel_id, agent);
      return channel
        ? toolResult({ channel })
        : toolError(`Channel #${channel_id} was not found.`, { reason: 'not_found' });
    },
  }),
];

/** Tools whose optional `agent` still means "who is doing this" (creator). */
const ACTOR_WHEN_OPTIONAL = new Set(['post_task', 'create_channel']);

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
  const out: Record<string, unknown> = { ...((args as Record<string, unknown>) ?? {}) };
  for (const key of actorKeys(tool)) out[key] = actorFor(who, out[key]);
  return out;
}

/** The advertised schema: actor fields are optional (the server fills them in). */
function advertisedShape(tool: BoardTool): z.ZodRawShape {
  const shape: z.ZodRawShape = { ...tool.shape };
  for (const key of actorKeys(tool)) {
    shape[key] = (tool.shape[key] as z.ZodTypeAny)
      .optional()
      .describe('Acting agent. Ignored for signed-in users, who act as themselves.');
  }
  return shape;
}

async function runTool(tool: BoardTool, args: unknown, who: Principal): Promise<ToolResponse> {
  const parsed = z.object(tool.shape).safeParse(withActor(tool, args, who));
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
        ...(hasInput ? { inputSchema: advertisedShape(tool) } : {}),
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
