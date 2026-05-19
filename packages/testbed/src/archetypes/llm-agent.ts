import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

// llm-agent: an archetype backed by a real model rather than a scripted
// decider. The scripted archetypes (honest-strong's fixture content
// provider, honest-reviewer's `ReviewDecider`, the hallucinator's
// fabricator) are deterministic stand-ins for "a frontier model on the
// other end of the MCP connection" — useful for fast-loop CI where
// determinism and zero API cost matter, but they cannot exercise the
// thing the testbed ultimately has to validate: that the regime holds
// against an *actual* agent navigating the tool surface. PRD §Adversary
// taxonomy names "Honest-strong: frontier-model honest contributor" and
// "Patient adversary: ... long horizon" as model-backed by definition,
// and PRD §Adversary testbed §CI's deep loop is "where frontier-model
// patient adversaries live". This archetype is that population's engine.
//
// What it is, precisely: a generic MCP-tool agent loop. It takes a
// connected MCP `Client`, lists the server's tools, hands their JSON
// schemas to the Anthropic Messages API as tool definitions, and runs
// the tool-use loop — model emits `tool_use`, we `callTool` on the MCP
// client, feed the result back as a `tool_result`, repeat — until the
// model stops or the turn budget is exhausted. It has no Anchorage-
// specific knowledge; the *role* (honest contributor, strategic
// adversary, patient adversary, lazy reviewer) lives entirely in the
// system prompt and the opening task message the caller supplies. That
// is deliberate: the archetype is the connection between a model and
// the same MCP surface a real client sees, nothing more, so by
// construction it cannot do anything a real agent couldn't.
//
// Determinism note: this archetype is *not* deterministic — that's the
// point of having it. Randomness in the rest of the simulation (task
// arrival order, population mixing) still belongs at a higher layer;
// here the model itself is the source of variation, and replay is
// best-effort via a recorded transcript rather than guaranteed.
//
// Cost note: every turn is an API round-trip. The fast loop should keep
// using the scripted archetypes; this archetype is for the deep loop
// (small numbers, higher compute) and for the manual "is the loop real"
// smoke test (see `run-live.ts`).

// A subset of the Anthropic Messages API request/response shape — only
// the fields this loop uses. Kept inline rather than pulling in
// `@anthropic-ai/sdk` so the testbed's dependency story stays "only
// @anchorage/contracts, the MCP SDK, and zod" (see package.json).
type AnthropicTextBlock = { type: 'text'; text: string };
type AnthropicToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};
type AnthropicToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean | undefined;
};
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;
type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
};
type AnthropicToolDef = {
  name: string;
  description?: string | undefined;
  input_schema: Record<string, unknown>;
};
type AnthropicRequest = {
  model: string;
  max_tokens: number;
  system?: string;
  tools?: AnthropicToolDef[];
  messages: AnthropicMessage[];
};
// Token accounting, as the Messages API reports it per response. Only
// the two fields the budget guard needs; the API also reports cache
// hit/miss counts, which this loop doesn't use (no prompt caching
// wired here — see the cost note at the top of the file).
type AnthropicUsage = { input_tokens: number; output_tokens: number };
type AnthropicResponse = {
  stop_reason: string | null;
  content: AnthropicContentBlock[];
  usage: AnthropicUsage;
};

// A `fetch`-shaped function. Injectable so tests can drive the loop
// against a scripted API without a key or a network (see
// llm-agent.test.ts), and so a caller can wrap it for recording.
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

// Token usage, summed over the Messages API calls a run made. Exposed
// so a caller orchestrating many runs (the population runner) can hold
// a spend budget without re-deriving cost from transcript length.
export interface LlmAgentUsage {
  input_tokens: number;
  output_tokens: number;
}

// One model turn's worth of activity, recorded for the transcript.
export interface LlmAgentTurn {
  // Free text the model emitted alongside (or instead of) tool calls.
  text: string;
  // What the Messages API reported for this turn's request.
  usage: LlmAgentUsage;
  // Tool calls the model made this turn, paired with what the MCP
  // server returned. `is_error` mirrors the MCP tool error result
  // (the server's typed `code`/`message` payload, JSON-stringified).
  tool_calls: {
    name: string;
    input: Record<string, unknown>;
    result_text: string;
    is_error: boolean;
  }[];
}

export interface LlmAgentConfig {
  // Anthropic API key. Required — there is no offline mode (use the
  // scripted archetypes for that). The caller is responsible for not
  // logging it.
  apiKey: string;
  // Model id. Caller picks; the live runner defaults to a cheap one.
  model: string;
  // The role definition: who this agent is, what it's trying to do,
  // and (for adversary roles) the hidden objective. Everything that
  // makes this an "honest contributor" vs a "patient adversary" lives
  // here.
  system: string;
  // The opening user-turn message — the concrete task framing ("you
  // are connected to the Anchorage MCP server; request an assignment
  // for cause X; work the frontier one slot at a time").
  task: string;
  // Hard cap on model turns. Each turn is an API round-trip, so this
  // is also the cost ceiling. When hit, the loop stops with
  // `stop_reason: 'max_turns'`.
  max_turns: number;
  // `max_tokens` for each Messages API call. Defaults to 4096.
  max_tokens?: number;
  // Override the HTTP transport (tests, recording). Defaults to the
  // global `fetch`.
  fetch?: FetchLike;
  // Called after each turn with the turn's record — lets the live
  // runner stream the transcript instead of waiting for completion.
  on_turn?: (turn: LlmAgentTurn, index: number) => void;
  // Anthropic API base URL. Defaults to the public endpoint; exposed
  // for tests and for pointing at a gateway.
  base_url?: string;
}

export interface LlmAgentResult {
  turns: LlmAgentTurn[];
  // `end_turn` (model finished), `max_turns` (budget exhausted), or
  // whatever stop_reason the API returned (`stop_sequence`, etc.).
  stop_reason: string;
  // Token usage summed over every Messages API call this run made.
  usage: LlmAgentUsage;
}

const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

// Map the MCP `listTools` result into Anthropic tool definitions. Both
// sides speak JSON Schema for tool inputs, so this is a rename
// (`inputSchema` → `input_schema`) plus a description passthrough.
function toAnthropicTools(mcpTools: Awaited<ReturnType<Client['listTools']>>): AnthropicToolDef[] {
  return mcpTools.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
  }));
}

// Reduce an MCP `callTool` result to the text the model sees back. The
// Anchorage server returns both `structuredContent` (the typed shape)
// and a JSON-stringified text fallback; the structured form is the
// useful one for a model, so prefer it and fall back to the text
// content blocks.
function mcpResultToText(result: {
  structuredContent?: unknown;
  content?: { type: string; text?: string }[];
}): string {
  if (result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent);
  }
  const texts = (result.content ?? [])
    .filter(
      (b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string',
    )
    .map((b) => b.text);
  return texts.length > 0 ? texts.join('\n') : '(no content)';
}

async function callAnthropic(
  fetchImpl: FetchLike,
  baseUrl: string,
  apiKey: string,
  req: AnthropicRequest,
): Promise<AnthropicResponse> {
  const res = await fetchImpl(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(req),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${bodyText}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error(`Anthropic API returned non-JSON body: ${bodyText.slice(0, 500)}`);
  }
  const p = parsed as Partial<AnthropicResponse>;
  if (!Array.isArray(p.content)) {
    throw new Error(`Anthropic API response missing content array: ${bodyText.slice(0, 500)}`);
  }
  const u = (p.usage ?? {}) as Partial<AnthropicUsage>;
  return {
    stop_reason: p.stop_reason ?? null,
    content: p.content,
    usage: { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0 },
  };
}

// Run an LLM-backed agent against a connected MCP client until the
// model stops or the turn budget is exhausted. Returns the transcript.
export async function runLlmAgent(
  mcpClient: Client,
  config: LlmAgentConfig,
): Promise<LlmAgentResult> {
  const fetchImpl = config.fetch ?? (globalThis.fetch as unknown as FetchLike);
  if (!fetchImpl) {
    throw new Error('runLlmAgent: no fetch implementation available (pass config.fetch)');
  }
  const baseUrl = config.base_url ?? ANTHROPIC_DEFAULT_BASE_URL;
  const maxTokens = config.max_tokens ?? 4096;

  const mcpTools = await mcpClient.listTools();
  const tools = toAnthropicTools(mcpTools);

  const messages: AnthropicMessage[] = [{ role: 'user', content: config.task }];
  const turns: LlmAgentTurn[] = [];
  const totalUsage: LlmAgentUsage = { input_tokens: 0, output_tokens: 0 };

  for (let turnIndex = 0; turnIndex < config.max_turns; turnIndex++) {
    const response = await callAnthropic(fetchImpl, baseUrl, config.apiKey, {
      model: config.model,
      max_tokens: maxTokens,
      system: config.system,
      tools,
      messages,
    });

    totalUsage.input_tokens += response.usage.input_tokens;
    totalUsage.output_tokens += response.usage.output_tokens;

    // Record the assistant message verbatim so the next request
    // carries the full conversation (tool_use blocks included).
    messages.push({ role: 'assistant', content: response.content });

    const text = response.content
      .filter((b): b is AnthropicTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const toolUses = response.content.filter(
      (b): b is AnthropicToolUseBlock => b.type === 'tool_use',
    );

    const turn: LlmAgentTurn = { text, usage: response.usage, tool_calls: [] };

    if (toolUses.length === 0) {
      turns.push(turn);
      config.on_turn?.(turn, turnIndex);
      return { turns, stop_reason: response.stop_reason ?? 'end_turn', usage: totalUsage };
    }

    // Execute each tool call against the MCP server and build the
    // tool_result blocks that go back in the next user turn.
    const toolResults: AnthropicToolResultBlock[] = [];
    for (const tu of toolUses) {
      let resultText: string;
      let isError: boolean;
      try {
        const result = await mcpClient.callTool({ name: tu.name, arguments: tu.input });
        isError = result.isError === true;
        resultText = mcpResultToText(result as Parameters<typeof mcpResultToText>[0]);
      } catch (err) {
        // A throw from callTool is a transport- or protocol-level
        // fault (not a typed ServerError — those come back as
        // isError results). Surface it to the model as an error
        // tool_result so it can react rather than crashing the run.
        isError = true;
        resultText = JSON.stringify({
          error: 'tool_call_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      turn.tool_calls.push({
        name: tu.name,
        input: tu.input,
        result_text: resultText,
        is_error: isError,
      });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: resultText,
        is_error: isError || undefined,
      });
    }

    messages.push({ role: 'user', content: toolResults });
    turns.push(turn);
    config.on_turn?.(turn, turnIndex);
  }

  return { turns, stop_reason: 'max_turns', usage: totalUsage };
}
