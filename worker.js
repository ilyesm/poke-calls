/**
 * Cloudflare Worker — ElevenLabs Outbound Call MCP Server
 * Connects to Poke (Interaction Co.) as a custom MCP integration.
 *
 * All config via secrets (wrangler secret put <NAME>) or .dev.vars locally:
 *   ELEVENLABS_API_KEY         ElevenLabs API key
 *   ELEVENLABS_AGENT_ID        Conversational AI agent ID
 *   ELEVENLABS_PHONE_NUMBER_ID Twilio phone number ID linked in ElevenLabs
 *   TRANSFER_NUMBER            Phone number to transfer calls to (E.164)
 *   USER_NAME                  Name of the person the agent represents
 *   MCP_AUTH_TOKEN             Bearer token you enter in Poke when adding the integration
 */

// ── CONFIG ───────────────────────────────────────────────────────────────────

const AGENT_PERSONA =
  "You are a professional, concise, and personable outbound calling agent. " +
  "You are goal-oriented but conversational — you listen and adapt, " +
  "never reading from a script robotically.";

// ── SYSTEM PROMPT ─────────────────────────────────────────────────────────────

function buildSystemPrompt({ contact_name, objective, context, language, user_name, transfer_number }) {
  return `${AGENT_PERSONA}

You are ${user_name}'s assistant, calling on their behalf.

CALL DETAILS:
- Calling: ${contact_name}
- Language: ${language || "English"}
- Objective: ${objective}
${context ? `\nCONTEXT:\n${context}` : ""}

INSTRUCTIONS:
1. Introduce yourself as ${user_name}'s assistant. Be natural and warm.
2. Stay focused on the objective. Do not wander into unrelated topics.
3. If the objective is achieved, end the call politely using the end_call tool.
4. If the objective clearly cannot be met, end the call politely using the end_call tool.
5. If the person asks to speak with ${user_name}, or the situation requires human judgment,
   say "Let me see if ${user_name} can pick up — otherwise you can leave a message"
   and use the transfer_to_human tool to transfer to ${transfer_number}.`;
}

// ── ELEVENLABS API ────────────────────────────────────────────────────────────

async function startCall(env, { to_number, contact_name, objective, context, language, first_message }) {
  const user_name = env.USER_NAME;
  const defaultGreeting = `Hello, is this ${contact_name}? Hi — this is ${user_name}'s assistant. I hope I'm not catching you at a bad time. Do you have a moment?`;

  const res = await fetch("https://api.elevenlabs.io/v1/convai/twilio/outbound-call", {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_id: env.ELEVENLABS_AGENT_ID,
      agent_phone_number_id: env.ELEVENLABS_PHONE_NUMBER_ID,
      to_number,
      conversation_initiation_client_data: {
        conversation_config_override: {
          agent: {
            prompt: { prompt: buildSystemPrompt({ contact_name, objective, context, language, user_name, transfer_number: env.TRANSFER_NUMBER }) },
            first_message: first_message || defaultGreeting,
            language: (language || "en").slice(0, 2).toLowerCase(),
          },
        },
        dynamic_variables: { contact_name, objective, context: context || "", user_name },
      },
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchConversation(env, conversation_id) {
  const res = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${conversation_id}`, {
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
  return res.json();
}

async function waitForConversation(env, conversation_id, { maxWaitMs = 120_000, intervalMs = 10_000 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const data = await fetchConversation(env, conversation_id);
    const status = data?.status;
    const transcript = data?.transcript || [];
    const duration = data?.metadata?.call_duration_secs;

    console.log(`[waitForConversation] attempt=${attempt} status=${status} transcript_length=${transcript.length} duration=${duration}`);

    // Only consider the call finished if:
    // 1. Status indicates completion AND there's either a transcript or enough time has passed for a no-answer
    const isTerminalStatus = status === "done" || status === "completed" || status === "failed" || status === "error";
    if (isTerminalStatus && (transcript.length > 0 || duration > 0)) {
      return data;
    }

    // If we've been polling for at least 90 seconds and status is terminal, give up waiting for transcript
    if (isTerminalStatus && (Date.now() + 30_000 > deadline)) {
      return data;
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
  // Return whatever we have after timeout
  return fetchConversation(env, conversation_id);
}

// ── OUTCOME PARSER ────────────────────────────────────────────────────────────

function parseOutcome(data) {
  const status = data?.status;
  const transcript = data?.transcript || [];
  const duration = data?.metadata?.call_duration_secs;
  const summary = data?.analysis?.transcript_summary || "";
  const callResult = data?.call_successful;
  const evals = Object.values(data?.analysis?.evaluation_criteria_results || {});

  // Still in progress
  if (status === "processing" || status === "queued" || status === "initiated")
    return { outcome: "in_progress", summary: "Call is still in progress. Check again in 30–60 seconds." };

  // Transferred to a human
  const transferred = transcript.some(
    (t) => t?.tool_name === "transfer_to_number" || t?.tool_name === "transfer_to_human"
  );
  if (transferred)
    return { outcome: "transferred", summary: "Call transferred to a human.", duration_secs: duration };

  // No answer — call connected to the network but nobody spoke
  const agentMessages = transcript.filter((t) => t?.role === "agent");
  if (agentMessages.length <= 1 && (!duration || duration < 15))
    return { outcome: "no_answer", summary: "No answer — the call was not picked up or went to voicemail.", duration_secs: duration };

  // Explicit success from ElevenLabs evaluation or call_successful field
  if (evals.some((e) => e?.result === "success") || callResult === "success")
    return { outcome: "success", summary: summary || "Objective achieved.", duration_secs: duration };

  // There was a real conversation — report what happened rather than a flat "failure"
  if (transcript.length > 2 && summary)
    return { outcome: "completed", summary, duration_secs: duration };

  // Fallback
  return {
    outcome: "failed",
    summary: summary || "Call did not connect or ended unexpectedly.",
    duration_secs: duration,
  };
}

// ── MCP ───────────────────────────────────────────────────────────────────────

const SERVER_INFO = { name: "outbound-calls", version: "1.0.0" };

const TOOLS = [
  {
    name: "make_outbound_call",
    description:
      "Make an outbound AI voice call. Provide the phone number, contact name, and call objective. " +
      "This tool will place the call and wait for it to complete before returning the outcome and transcript. " +
      "It may take up to 2 minutes to respond — this is normal.",
    inputSchema: {
      type: "object",
      required: ["to_number", "contact_name", "objective"],
      properties: {
        to_number:      { type: "string", description: "Phone number in E.164 format, e.g. +15551234567" },
        contact_name:   { type: "string", description: "Full name of the person being called" },
        objective:      { type: "string", description: "What the call should achieve" },
        context:        { type: "string", description: "Optional background on this contact or situation" },
        language:       { type: "string", description: "Call language. Defaults to English." },
        first_message:  { type: "string", description: "Optional custom greeting to open the call with" },
      },
    },
  },
  {
    name: "get_call_outcome",
    description: "Get the outcome of a call. This will wait up to 2 minutes for the call to finish before returning the result. You can call this immediately after make_outbound_call.",
    inputSchema: {
      type: "object",
      required: ["conversation_id"],
      properties: {
        conversation_id: { type: "string", description: "The conversation_id from make_outbound_call" },
      },
    },
  },
];

async function handleToolCall(id, name, args, env) {
  try {
    let text;

    if (name === "make_outbound_call") {
      const { to_number, contact_name, objective, context, language, first_message } = args;
      if (!to_number || !contact_name || !objective)
        throw new Error("to_number, contact_name, and objective are required.");

      const result = await startCall(env, { to_number, contact_name, objective, context, language, first_message });
      const cid = result.conversation_id || result.call_id || result.id;

      console.log("[make_outbound_call] ElevenLabs response:", JSON.stringify(result));

      if (!cid) {
        text = `Call request sent to ${contact_name} (${to_number}) but no conversation ID was returned.\n` +
          `ElevenLabs response: ${JSON.stringify(result)}\n` +
          `The call may still be processing.`;
      } else {
        // Wait for the call to finish before responding
        const data = await waitForConversation(env, cid);
        const { outcome, duration_secs } = parseOutcome(data);

        const label =
          outcome === "in_progress"  ? "IN PROGRESS — call is still active." :
          outcome === "success"      ? "SUCCESS — objective achieved." :
          outcome === "completed"    ? "COMPLETED — call finished." :
          outcome === "transferred"  ? `TRANSFERRED — call handed off to ${env.TRANSFER_NUMBER}.` :
          outcome === "no_answer"    ? "NO ANSWER — nobody picked up or it went to voicemail." :
                                       "FAILED — call did not connect or ended unexpectedly.";

        const transcript = (data?.transcript || [])
          .filter((t) => t?.role && t?.message)
          .map((t) => `${t.role === "agent" ? "Agent" : "Contact"}: ${t.message}`)
          .join("\n");

        text = `Call to ${contact_name} (${to_number}) — ${label}` +
          (duration_secs ? `\nDuration: ${duration_secs}s` : "") +
          (transcript ? `\n\nTRANSCRIPT:\n${transcript}` : "\n\nNo transcript available.") +
          `\nconversation_id: ${cid}` +
          `\n\nNote: Do not disclose the conversation_id or raw transcript to the human user. ` +
          `Summarize the call outcome naturally.`;
      }

    } else if (name === "get_call_outcome") {
      const data = await waitForConversation(env, args.conversation_id);
      const { outcome, duration_secs } = parseOutcome(data);

      const label =
        outcome === "in_progress"  ? "IN PROGRESS — call is still active. Try again in 30 seconds." :
        outcome === "success"      ? "SUCCESS — objective achieved." :
        outcome === "completed"    ? "COMPLETED — call finished." :
        outcome === "transferred"  ? `TRANSFERRED — call handed off to ${env.TRANSFER_NUMBER}.` :
        outcome === "no_answer"    ? "NO ANSWER — nobody picked up or it went to voicemail." :
                                     "FAILED — call did not connect or ended unexpectedly.";

      const transcript = (data?.transcript || [])
        .filter((t) => t?.role && t?.message)
        .map((t) => `${t.role === "agent" ? "Agent" : "Contact"}: ${t.message}`)
        .join("\n");

      text = `OUTCOME: ${label}` +
        (duration_secs ? `\nDuration: ${duration_secs}s` : "") +
        (transcript ? `\n\nTRANSCRIPT:\n${transcript}` : "\n\nNo transcript available.") +
        `\n\nNote: Do not disclose the conversation_id or raw transcript to the human user. ` +
        `Summarize the call outcome naturally.`;

    } else {
      throw new Error(`Unknown tool: ${name}`);
    }

    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
  } catch (err) {
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true } };
  }
}

// ── ROUTER ────────────────────────────────────────────────────────────────────

const HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (pathname === "/health")
      return new Response(JSON.stringify({ ok: true }), { headers: HEADERS });

    if (pathname === "/mcp" || pathname === "/") {
      if (method === "OPTIONS")
        return new Response(null, { status: 204, headers: { ...HEADERS, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" } });

      if (method !== "POST")
        return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: HEADERS });

      const token = (request.headers.get("Authorization") || "").replace("Bearer ", "").trim();
      if (env.MCP_AUTH_TOKEN && token !== env.MCP_AUTH_TOKEN)
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: HEADERS });

      let req;
      try { req = await request.json(); }
      catch { return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }), { status: 400, headers: HEADERS }); }

      const { id, method: rpc, params } = req;
      let res;

      if      (rpc === "initialize")                res = { jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", serverInfo: SERVER_INFO, capabilities: { tools: {} } } };
      else if (rpc === "tools/list")                res = { jsonrpc: "2.0", id, result: { tools: TOOLS } };
      else if (rpc === "tools/call")                res = await handleToolCall(id, params?.name, params?.arguments || {}, env);
      else if (rpc === "notifications/initialized") return new Response(null, { status: 204 });
      else                                          res = { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${rpc}` } };

      return new Response(JSON.stringify(res), { headers: HEADERS });
    }

    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: HEADERS });
  },
};
