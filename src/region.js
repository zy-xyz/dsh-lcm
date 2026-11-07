/**
 * Surface retention selection and the shared log-recorded compaction
 * transaction for `dsh-compaction-lcm`.
 *
 * This module ports the durable protocol of `@deepseek-ai/dsh-compaction-basic`
 * verbatim — lock entry assertions, `compaction/start|summary|end` bracketing,
 * checkpoint replacement provenance, surface-stability checks, flush handling,
 * and the `busy`/`changed`/`summary`/`commit`/`persistence` failure vocabulary —
 * so this backend remains a contract-exact drop-in replacement for the
 * `/compact` command and every other `ctx.compaction` consumer.
 *
 * The ONLY replaced step is summarization: this backend asks the model for a
 * structured checkpoint (see summarize.js). It descends from
 * `dsh-compaction-instant`'s deterministic compiler, which made no model call.
 *
 * @module dsh-compaction-lcm/region
 */
import { CompactionId, ManualCompactionError, compactCheckpointSource, toolPairingBalancedAfter, toolPairingBalancedBefore } from "@deepseek-ai/dsh-compaction";
import { createUserMessage, errorChain } from "@deepseek-ai/dsh-llm";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { frameCheckpoint, joinCompiledEntries } from "./compiler.js";

/**
 * Rejects a compiled checkpoint whose replacement boundaries are no longer
 * the ones it was built from, distinguished from compile and shrink failures
 * so a manual caller can report the two causes differently.
 */
export class SurfaceChangedError extends Error {}


/** The surface head event when it is a system message (never compacted). */
function systemHead(session, headSeq) {
  const head = session.eventAt(headSeq);
  return head !== undefined && head.type === "system/message" ? head : undefined;
}

/**
 * Resolve the next range starting at the first non-system surface node while
 * retaining a priced recent tail and never splitting a tool-call/result pair.
 * A `system/message` at surface node 0 is never inside the range.
 *
 * This is `dsh-compaction-basic`'s exact selection rule, so switching backends
 * compacts the same span for the same tokens.
 *
 * @param session - session supplying authoritative current surface positions.
 * @param measurement - unified pressure and surface measurement.
 * @param retainTokens - minimum recent tail budget retained verbatim.
 * @returns the inclusive positional seq range to compact, or `null`.
 */
export function selectCompactableRange(session, measurement, retainTokens) {
  const pricedNodes = measurement.nodes;
  if (pricedNodes.length === 0) return null;
  const surfaceNodes = session.surface.nodes;
  if (
    surfaceNodes.length !== pricedNodes.length ||
    surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)
  ) {
    throw new Error("compaction: token-meter surface does not match the current session surface");
  }
  const firstIdx = systemHead(session, surfaceNodes[0]) === undefined ? 0 : 1;
  let accumulated = 0;
  let keepFromIdx = pricedNodes.length;
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    accumulated += pricedNodes[index].tokens;
    keepFromIdx = index;
    if (accumulated >= retainTokens) break;
  }
  if (keepFromIdx <= firstIdx) return null;
  while (keepFromIdx > firstIdx) {
    if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx])) break;
    keepFromIdx -= 1;
  }
  if (keepFromIdx <= firstIdx) return null;
  return {
    start: surfaceNodes[firstIdx],
    end: surfaceNodes[keepFromIdx - 1]
  };
}


/**
 * Run the single compaction transaction over one selected positional span.
 * Selection and validation are read-only. Idle/log validation and
 * `compaction/start` are synchronously adjacent, so the durable opening marker
 * is the compaction lock before the compile yields. Every later failure makes
 * exactly one `compaction/end` attempt; a failed close deliberately leaves the
 * unmatched start detectable.
 * @param dependencies - conversation meter and the compile hook.
 * @param session - session whose surface is mutated.
 * @param start - inclusive first surface-node seq.
 * @param end - inclusive last surface-node seq.
 * @param agent - retained for signature parity with other backends; the
 *   compile step routes the model call through it.
 * @param options - bracket owner, stability rule, and optional durability checkpoint.
 * @param signal - optional cancellation signal checked at the safe boundaries.
 * @returns the successful durable compaction result.
 */
export async function compactSurfaceRegion(dependencies, session, start, end, agent, options, signal) {
  if (options.owner === null) signal?.throwIfAborted();
  const selection = validateSurfaceRegion(session, start, end);
  const entryState = inspectCompactionEntryState(session.events);
  assertCompactionInactive(entryState.unmatchedCompactionStart, entryState.latestEndSeedSeq, "compaction");
  let owner;
  if (options.owner === null) {
    if (entryState.openTurn !== null) throw new ManualCompactionError("busy", "manual compaction: the session already has an open turn");
    owner = null;
  } else {
    if (entryState.openTurn === null) throw new Error("compactRegion: no open turn — automatic compaction events must be enclosed in a turn");
    owner = entryState.openTurn;
  }
  const compactionId = CompactionId(randomUUID());
  const lifecycle = {
    compactionId,
    ...options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId },
    turn: owner
  };
  const startEvent = session.append("compaction/start", lifecycle);
  const assertStable = options.stability === "whole-surface" ? assertWholeSurfaceUnchanged : assertSelectedSpanStable;
  let failure;
  let flushFailure;
  let result;
  let closed = false;
  let closing = false;
  let stage = "summary";
  try {
    const prepared = prepareCompaction(dependencies, session, selection);
    const compiled = await compileCompaction(dependencies, prepared, agent, compactionId, options.sourceCommandId, signal);
    if (options.owner === null) signal?.throwIfAborted();
    assertStable(dependencies, session, compiled);
    stage = "commit";
    const pending = commitCompactionBody(session, startEvent, compiled);
    closing = true;
    const endEvent = session.append("compaction/end", lifecycle);
    closed = true;
    result = completeCompaction(pending, endEvent);
  } catch (error) {
    failure = {
      error,
      stage: closing ? "commit" : stage
    };
    if (!closing) {
      closing = true;
      try {
        session.append("compaction/end", {
          ...lifecycle,
          error: errorChain(error)
        });
        closed = true;
      } catch (closeError) {
        failure = {
          error: closeError,
          stage: "commit"
        };
      }
    }
  }
  if (closed && options.flush !== undefined) try {
    await options.flush();
  } catch (error) {
    flushFailure = error;
  }
  if (options.owner === null) signal?.throwIfAborted();
  if (failure !== undefined) {
    if (options.owner === null) throwManualFailure(failure);
    throw failure.error;
  }
  if (flushFailure !== undefined) throw new ManualCompactionError("persistence", "manual compaction durability checkpoint failed", { cause: flushFailure });
  /* v8 ignore next -- every path without a result records and throws a failure above. */
  if (result === undefined) throw new Error("compaction committed without a result");
  return result;
}

/** Classify one closed manual attempt without weakening cancellation precedence. */
function throwManualFailure(failure) {
  if (failure.stage === "commit") throw new ManualCompactionError("commit", "manual compaction did not commit cleanly", { cause: failure.error });
  if (failure.error instanceof SurfaceChangedError) throw new ManualCompactionError("changed", "the compacted history changed during manual compaction", { cause: failure.error });
  throw new ManualCompactionError("summary", "manual compaction could not produce a smaller checkpoint", { cause: failure.error });
}

/**
 * Reject a durable unmatched compaction marker unless a later constructor-seed
 * boundary proves that its owner belongs to an earlier session lifecycle.
 * @param unmatchedCompactionStart - latest unmatched opening marker, if any.
 * @param latestEndSeedSeq - newest constructor-seed boundary, if any.
 * @param stage - operation label included in the busy diagnostic.
 */
function assertCompactionInactive(unmatchedCompactionStart, latestEndSeedSeq, stage) {
  if (unmatchedCompactionStart === undefined || latestEndSeedSeq !== undefined && latestEndSeedSeq > unmatchedCompactionStart.seq) return;
  throw new ManualCompactionError("busy", `${stage}: compaction already in progress; the session compaction lock is already active`);
}

/**
 * Recheck the durable compaction lock after an asynchronous policy decision.
 * @param session - session whose latest marker state is inspected.
 * @param stage - operation label included in the busy diagnostic.
 */
export function assertNoActiveCompaction(session, stage) {
  const entryState = inspectCompactionEntryState(session.events);
  assertCompactionInactive(entryState.unmatchedCompactionStart, entryState.latestEndSeedSeq, stage);
}

/** Validate one requested surface-position span before any work begins. */
export function validateSurfaceRegion(session, start, end) {
  const nodes = session.surface.nodes;
  const startIdx = nodes.indexOf(start);
  const endIdx = nodes.indexOf(end);
  if (startIdx === -1) throw new Error(`compactRegion: start seq ${start} not found in surface`);
  if (endIdx === -1) throw new Error(`compactRegion: end seq ${end} not found in surface`);
  if (startIdx > endIdx) throw new Error(`compactRegion: start seq ${start} (position ${startIdx}) is after end seq ${end} (position ${endIdx}) on the surface`);
  if (!toolPairingBalancedBefore(session, nodes[startIdx])) throw new Error(`compactRegion: start seq ${start} is not a balanced boundary (would split a step's tool-call/result pair)`);
  if (!toolPairingBalancedAfter(session, nodes[endIdx])) throw new Error(`compactRegion: end seq ${end} is not a balanced boundary (would split a step, or the step is still open)`);
  return {
    start,
    end,
    startIdx,
    endIdx,
    shadowedSeqs: nodes.slice(startIdx, endIdx + 1)
  };
}

/** Snapshot pricing for a validated surface range. */
export function prepareCompaction(dependencies, session, selection) {
  const measurement = dependencies.meter.measure(session);
  const selectedNodes = measurement.nodes.slice(selection.startIdx, selection.endIdx + 1);
  if (selectedNodes.length !== selection.shadowedSeqs.length || selectedNodes.some((node, index) => node.seq !== selection.shadowedSeqs[index])) throw new SurfaceChangedError("compaction: selected surface changed before compilation began");
  return {
    ...selection,
    session,
    measurement,
    selectedNodes,
    shadowedTokenCount: selectedNodes.reduce((total, node) => total + node.tokens, 0)
  };
}

/**
 * Run the region compile step (an LLM summary), frame its checkpoint, and price
 * the replacement under the singleton token meter. Mirrors basic's shrink
 * guarantee: a checkpoint that would not reduce the surface is rejected.
 * @param dependencies - conversation meter and the compile hook.
 * @param prepared - priced selection snapshot.
 * @param agent - retained for signature parity; the compile step routes it.
 * @param compactionId - owning transaction identity for checkpoint provenance.
 * @param sourceCommandId - initiating manual command, when present.
 * @param signal - optional cancellation signal.
 * @returns the compiled summary, provenance, and framed checkpoint message.
 */
async function compileCompaction(dependencies, prepared, agent, compactionId, sourceCommandId, signal) {
  const compiled = await dependencies.compile(prepared, agent, signal);
  // The UI-facing summary IS the compiled body: the checkpoint row expands to
  // exactly the entries the model sees. The body is joined with separators
  // and wrapped in an adaptive Markdown fence, so the UI renders the whole
  // expansion as one tidy code block even when messages contain markdown.
  const verb = sourceCommandId === undefined ? "自动压缩" : "手动 /compact";
  const ratio = (prepared.shadowedTokenCount / Math.max(1, compiled.stats.tokens)).toFixed(1);
  const introLine = `${verb}: 将 ${prepared.shadowedSeqs.length} 个节点 / ~${prepared.shadowedTokenCount} tokens 摘要为 ~${compiled.stats.tokens} tokens（${ratio}:1）`;
  const headerLine = `## LCM checkpoint: ${prepared.shadowedSeqs.length} nodes (seqs ${prepared.start}-${prepared.end}, ~${prepared.shadowedTokenCount} → ~${compiled.stats.tokens} tokens, ${ratio}:1)`;
  // Verbatim retention footer: nodes after the compiled span were never
  // compiled, so they stay in the live surface as original text.
  const retainedNodes = prepared.measurement.nodes.slice(prepared.endIdx + 1);
  const retainedTokenCount = retainedNodes.reduce((total, node) => total + node.tokens, 0);
  const footerLine = retainedNodes.length === 0 ? undefined
    : `尾部原文保留: ${retainedNodes.length} 节点 / ~${retainedTokenCount} tokens（未被压缩,仍在对话中）`;
  const bodyEntries = [
    introLine,
    headerLine,
    ...compiled.entries,
    ...(footerLine === undefined ? [] : [footerLine])
  ];
  const summary = [{ type: "text", text: fenceCode(joinCompiledEntries(bodyEntries)) }];
  const checkpointMessage = createUserMessage({
    content: frameCheckpoint(compiled.entries, headerLine, introLine, footerLine),
    source: compactCheckpointSource(compactionId, sourceCommandId)
  });
  const framedTokenCount = dependencies.meter.estimateMessage(checkpointMessage);
  if (framedTokenCount >= prepared.shadowedTokenCount) throw new Error(`compiled checkpoint is not smaller than the shadowed content (${framedTokenCount} estimated framed tokens >= ${prepared.shadowedTokenCount})`);
  return {
    ...prepared,
    summary,
    provider: compiled.provider,
    model: compiled.model,
    maxTokens: compiled.maxTokens,
    usage: compiled.usage,
    rawOutput: compiled.rawOutput,
    checkpointMessage,
    framedTokenCount
  };
}

/**
 * Wrap text in a Markdown code fence for tidy UI rendering. The fence length
 * adapts to the longest backtick run inside the text — the Markdown-correct
 * way to "escape" embedded ``` blocks (a 3-backtick fence would terminate at
 * them), keeping the content bytes untouched.
 * @param text - body text to fence.
 * @returns the fenced text.
 */
export function fenceCode(text) {
  const runs = text.match(/`+/gu);
  const longest = runs === null ? 0 : Math.max(...runs.map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/** Reject a checkpoint prepared against any earlier surface generation. */
export function assertWholeSurfaceUnchanged(dependencies, session, prepared) {
  if (!isDeepStrictEqual(dependencies.meter.measure(session).nodes, prepared.measurement.nodes)) throw new SurfaceChangedError("compaction: session surface changed during compilation");
}

/**
 * Require only that the selected span remain the same present, contiguous,
 * equally priced, balanced replacement target. Nodes added outside it remain
 * visible and do not invalidate the checkpoint.
 */
export function assertSelectedSpanStable(dependencies, session, prepared) {
  let current;
  try {
    current = validateSurfaceRegion(session, prepared.start, prepared.end);
  } catch (error) {
    throw new SurfaceChangedError("compaction: the selected span is no longer a valid replacement target", { cause: error });
  }
  if (!isDeepStrictEqual([...current.shadowedSeqs], [...prepared.shadowedSeqs])) throw new SurfaceChangedError("compaction: the selected span changed during compilation");
  if (!isDeepStrictEqual(dependencies.meter.measure(session).nodes.slice(current.startIdx, current.endIdx + 1), prepared.selectedNodes)) throw new SurfaceChangedError("compaction: the selected span was rewritten during compilation");
}

/** Append one completed checkpoint record and replacement body without yielding. */
function commitCompactionBody(session, startEvent, compiled) {
  const { start, end, shadowedSeqs, shadowedTokenCount, summary, provider, model, checkpointMessage, maxTokens, usage, rawOutput } = compiled;
  const summaryEvent = session.append("compaction/summary", {
    compactionId: startEvent.data.compactionId,
    ...startEvent.data.sourceCommandId === undefined ? {} : { sourceCommandId: startEvent.data.sourceCommandId },
    summary,
    shadowedRange: {
      start,
      end
    },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount,
    provider,
    model,
    ...maxTokens === undefined ? {} : { maxTokens },
    ...usage === undefined ? {} : { usage },
    ...rawOutput === undefined ? {} : { rawOutput, llmStreamCall: true }
  });
  session.append("user/message", checkpointMessage, {
    // The positional replacement contract is EXACTLY {op, startSeq, endSeq} —
    // three own keys, both seqs non-negative safe integers. Anything else is
    // rejected by foldSurface at commit time, after compaction/start and
    // compaction/summary have already landed, which strands an orphan summary
    // and leaves the surface unable to shrink.
    surfaceOp: {
      op: "replace",
      startSeq: start,
      endSeq: end
    },
    sourceEventSeqs: [
      startEvent.seq,
      summaryEvent.seq,
      ...shadowedSeqs
    ]
  });
  return {
    compactionId: startEvent.data.compactionId,
    ...startEvent.data.sourceCommandId === undefined ? {} : { sourceCommandId: startEvent.data.sourceCommandId },
    startSeq: startEvent.seq,
    summarySeq: summaryEvent.seq,
    summary,
    shadowedRange: {
      start,
      end
    },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount
  };
}

/** Attach the successfully appended close event to a pending result. */
function completeCompaction(pending, endEvent) {
  return {
    ...pending,
    endSeq: endEvent.seq
  };
}

/** Inspect open-turn, unmatched-compaction, and latest seed-boundary state independently. */
export function inspectCompactionEntryState(events) {
  let openTurn = null;
  let openTurnStateKnown = false;
  let unmatchedCompactionStart;
  let compactionEntryStateKnown = false;
  let latestEndSeedSeq;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (latestEndSeedSeq === undefined && event.type === "session/end-seed") latestEndSeedSeq = event.seq;
    if (!compactionEntryStateKnown) {
      if (event.type === "compaction/start") {
        unmatchedCompactionStart = event;
        compactionEntryStateKnown = true;
      } else if (event.type === "compaction/end") compactionEntryStateKnown = true;
    }
    if (!openTurnStateKnown) {
      if (event.type === "turn/start") {
        openTurn = event.data.turn;
        openTurnStateKnown = true;
      } else if (event.type === "turn/end") openTurnStateKnown = true;
    }
    if (openTurnStateKnown && compactionEntryStateKnown && latestEndSeedSeq !== undefined) break;
  }
  return {
    openTurn,
    unmatchedCompactionStart,
    latestEndSeedSeq
  };
}
