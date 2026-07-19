// xAI Grok Voice Agent API — Realtime WebSocket protocol types.
//
// Endpoint: wss://api.x.ai/v1/realtime?model=<model>
// Docs:     https://docs.x.ai/developers/model-capabilities/audio/voice-agent
//
// The shape is intentionally OpenAI-Realtime-compatible with xAI-specific
// tweaks documented inline. We define what we send/receive in mantle's
// call bridge; events outside this set still pass through (the catch-all
// member of the ServerEvent union) so an upstream API addition won't
// crash the bridge — it'll just surface as an unrecognized type.

// ── Audio + voice ──────────────────────────────────────────────────────

// xAI accepts three formats. PCM Linear16 LE is the default and the
// only one mantle uses; PCMU/PCMA are 8 kHz telephony codecs that
// the browser side has no path for.
export type AudioFormat = "audio/pcm" | "audio/pcmu" | "audio/pcma";

// Supported sample rates for both input and output. Configured
// independently. 24000 is xAI's default and matches the AudioWorklet's
// downsample target on the browser side.
export type SampleRate = 8000 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000;

// xAI built-in voices. Custom-voice ids are also accepted via the
// Custom Voices API; the `(string & {})` opens the type without losing
// completion on the built-ins.
export type Voice = "eve" | "ara" | "rex" | "sal" | "leo" | (string & {});

// ── Session config ──────────────────────────────────────────────────────

export interface TurnDetectionServerVad {
  type: "server_vad";
  // 0.1-0.9; lower = more sensitive to speech start. Default 0.5.
  threshold?: number;
  // Default 1000. How long silence must persist before VAD ends the turn.
  silence_duration_ms?: number;
  // Default 333. How much audio before speech start gets included.
  prefix_padding_ms?: number;
  // When true (default), server auto-creates a response after the user's
  // turn ends. Set false to require explicit response.create.
  create_response?: boolean;
}

// turn_detection: null disables server VAD entirely — the client must
// manually call input_audio_buffer.commit to signal turn end.
export type TurnDetection = TurnDetectionServerVad | null;

export interface SessionConfig {
  modalities?: ("text" | "audio")[];
  instructions?: string;
  voice?: Voice;
  // Input/output audio format and sample rate. The legacy convenience
  // fields here are what the OpenAI-compatible side of xAI accepts;
  // some docs show a nested `audio: { input, output }` shape — both
  // worked at time of writing, prefer these flat fields.
  input_audio_format?: AudioFormat;
  output_audio_format?: AudioFormat;
  input_audio_sample_rate?: SampleRate;
  output_audio_sample_rate?: SampleRate;
  input_audio_transcription?: {
    model?: string;
  };
  turn_detection?: TurnDetection;
  // Function/tool calling — supported but mantle's call mode is
  // conversational-only for v1, so we never send this.
  tools?: Array<{
    type: "function";
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
  tool_choice?: string;
  temperature?: number;
  max_response_output_tokens?: number | "inf";
}

// ── Conversation items ──────────────────────────────────────────────────

export interface ConversationItemMessage {
  id?: string;
  type: "message";
  role: "user" | "assistant" | "system";
  content: Array<
    | { type: "input_text"; text: string }
    | { type: "input_audio"; audio: string }  // base64
    | { type: "text"; text: string }
    | { type: "audio"; audio?: string; transcript?: string }
  >;
}

export interface ConversationItemFunctionCallOutput {
  id?: string;
  type: "function_call_output";
  call_id: string;
  output: string;
}

export type ConversationItem =
  | ConversationItemMessage
  | ConversationItemFunctionCallOutput;

// ── Client → Server events ──────────────────────────────────────────────

export interface ClientEvent_SessionUpdate {
  event_id?: string;
  type: "session.update";
  session: SessionConfig;
}

export interface ClientEvent_InputAudioBufferAppend {
  event_id?: string;
  type: "input_audio_buffer.append";
  audio: string; // base64 of PCM frames
}

export interface ClientEvent_InputAudioBufferCommit {
  event_id?: string;
  type: "input_audio_buffer.commit";
}

export interface ClientEvent_InputAudioBufferClear {
  event_id?: string;
  type: "input_audio_buffer.clear";
}

export interface ClientEvent_ConversationItemCreate {
  event_id?: string;
  type: "conversation.item.create";
  previous_item_id?: string | null;
  item: ConversationItem;
}

export interface ClientEvent_ConversationItemDelete {
  event_id?: string;
  type: "conversation.item.delete";
  item_id: string;
}

export interface ClientEvent_ResponseCreate {
  event_id?: string;
  type: "response.create";
  response?: Partial<SessionConfig>;
}

export interface ClientEvent_ResponseCancel {
  event_id?: string;
  type: "response.cancel";
}

export type ClientEvent =
  | ClientEvent_SessionUpdate
  | ClientEvent_InputAudioBufferAppend
  | ClientEvent_InputAudioBufferCommit
  | ClientEvent_InputAudioBufferClear
  | ClientEvent_ConversationItemCreate
  | ClientEvent_ConversationItemDelete
  | ClientEvent_ResponseCreate
  | ClientEvent_ResponseCancel;

// ── Server → Client events ──────────────────────────────────────────────

export interface ServerEvent_Error {
  event_id: string;
  type: "error";
  error: {
    type: string;
    code?: string;
    message: string;
    param?: string | null;
    event_id?: string;
  };
}

export interface ServerEvent_SessionCreated {
  event_id: string;
  type: "session.created";
  session: SessionConfig & { id: string; model: string };
}

export interface ServerEvent_SessionUpdated {
  event_id: string;
  type: "session.updated";
  session: SessionConfig & { id: string; model: string };
}

export interface ServerEvent_InputAudioBufferCommitted {
  event_id: string;
  type: "input_audio_buffer.committed";
  previous_item_id?: string | null;
  item_id: string;
}

export interface ServerEvent_InputAudioBufferCleared {
  event_id: string;
  type: "input_audio_buffer.cleared";
}

export interface ServerEvent_InputAudioBufferSpeechStarted {
  event_id: string;
  type: "input_audio_buffer.speech_started";
  audio_start_ms: number;
  item_id?: string;
}

export interface ServerEvent_InputAudioBufferSpeechStopped {
  event_id: string;
  type: "input_audio_buffer.speech_stopped";
  audio_end_ms: number;
  item_id?: string;
}

export interface ServerEvent_ConversationItemCreated {
  event_id: string;
  type: "conversation.item.created";
  previous_item_id?: string | null;
  item: ConversationItem & { id: string };
}

export interface ServerEvent_ConversationItemInputAudioTranscriptionCompleted {
  event_id: string;
  type: "conversation.item.input_audio_transcription.completed";
  item_id: string;
  content_index: number;
  transcript: string;
}

export interface ServerEvent_ConversationItemInputAudioTranscriptionFailed {
  event_id: string;
  type: "conversation.item.input_audio_transcription.failed";
  item_id: string;
  content_index: number;
  error: { type: string; code?: string; message: string };
}

export interface ServerEvent_ResponseCreated {
  event_id: string;
  type: "response.created";
  response: { id: string; status: string; output: unknown[] };
}

export interface ServerEvent_ResponseDone {
  event_id: string;
  type: "response.done";
  response: {
    id: string;
    status: string;
    status_details?: unknown;
    output: unknown[];
    usage?: { total_tokens?: number; input_tokens?: number; output_tokens?: number };
  };
}

export interface ServerEvent_ResponseOutputItemAdded {
  event_id: string;
  type: "response.output_item.added";
  response_id: string;
  output_index: number;
  item: ConversationItem & { id: string };
}

export interface ServerEvent_ResponseOutputItemDone {
  event_id: string;
  type: "response.output_item.done";
  response_id: string;
  output_index: number;
  item: ConversationItem & { id: string };
}

export interface ServerEvent_ResponseContentPartAdded {
  event_id: string;
  type: "response.content_part.added";
  response_id: string;
  item_id: string;
  output_index: number;
  content_index: number;
  part: { type: string };
}

export interface ServerEvent_ResponseContentPartDone {
  event_id: string;
  type: "response.content_part.done";
  response_id: string;
  item_id: string;
  output_index: number;
  content_index: number;
  part: { type: string };
}

// NOTE: xAI uses `response.text.delta` (not OpenAI's `output_text.delta`).
// Documented divergence — see the research report cited in CLAUDE.md.
export interface ServerEvent_ResponseTextDelta {
  event_id: string;
  type: "response.text.delta";
  response_id: string;
  item_id: string;
  output_index: number;
  content_index: number;
  delta: string;
}

export interface ServerEvent_ResponseTextDone {
  event_id: string;
  type: "response.text.done";
  response_id: string;
  item_id: string;
  output_index: number;
  content_index: number;
  text: string;
}

export interface ServerEvent_ResponseAudioDelta {
  event_id: string;
  type: "response.audio.delta";
  response_id: string;
  item_id: string;
  output_index: number;
  content_index: number;
  delta: string; // base64 PCM
}

export interface ServerEvent_ResponseAudioDone {
  event_id: string;
  type: "response.audio.done";
  response_id: string;
  item_id: string;
  output_index: number;
  content_index: number;
}

export interface ServerEvent_ResponseAudioTranscriptDelta {
  event_id: string;
  type: "response.audio_transcript.delta";
  response_id: string;
  item_id: string;
  output_index: number;
  content_index: number;
  delta: string;
}

export interface ServerEvent_ResponseAudioTranscriptDone {
  event_id: string;
  type: "response.audio_transcript.done";
  response_id: string;
  item_id: string;
  output_index: number;
  content_index: number;
  transcript: string;
}

// Catch-all: anything we haven't typed yet. Keeps the bridge from
// crashing if xAI adds a new event type — we just log + ignore.
export interface ServerEvent_Unknown {
  event_id?: string;
  type: string;
  [key: string]: unknown;
}

export type ServerEvent =
  | ServerEvent_Error
  | ServerEvent_SessionCreated
  | ServerEvent_SessionUpdated
  | ServerEvent_InputAudioBufferCommitted
  | ServerEvent_InputAudioBufferCleared
  | ServerEvent_InputAudioBufferSpeechStarted
  | ServerEvent_InputAudioBufferSpeechStopped
  | ServerEvent_ConversationItemCreated
  | ServerEvent_ConversationItemInputAudioTranscriptionCompleted
  | ServerEvent_ConversationItemInputAudioTranscriptionFailed
  | ServerEvent_ResponseCreated
  | ServerEvent_ResponseDone
  | ServerEvent_ResponseOutputItemAdded
  | ServerEvent_ResponseOutputItemDone
  | ServerEvent_ResponseContentPartAdded
  | ServerEvent_ResponseContentPartDone
  | ServerEvent_ResponseTextDelta
  | ServerEvent_ResponseTextDone
  | ServerEvent_ResponseAudioDelta
  | ServerEvent_ResponseAudioDone
  | ServerEvent_ResponseAudioTranscriptDelta
  | ServerEvent_ResponseAudioTranscriptDone
  | ServerEvent_Unknown;

// ── Constants ───────────────────────────────────────────────────────────

export const DEFAULT_MODEL = "grok-voice-latest";
export const REALTIME_ENDPOINT = "wss://api.x.ai/v1/realtime";
