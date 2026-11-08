/**
 * Surface retention selection and the shared log-recorded compaction
 * transaction for `dsh-lcm`.
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
 * @module dsh-lcm/region
 */
import { CompactionId, ManualCompactionError, compactCheckpointSource, toolPairingBalancedAfter, toolPairingBalancedBefore } from "@deepseek-ai/dsh-compaction";
import { createUserMessage, errorChain } from "@deepseek-ai/dsh-llm";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { frameCheckpoint, joinCompiledEntries } from "./compiler.js";
import { sessionEvents } from "./events.js";

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
 * Selection is pure and budget-agnostic, so it cannot know what one summary
 * will cost. `minTokens` lets a caller that DOES know (the engine, which resolves
 * `summaryFloorTokens`) refuse a span the summary could never be smaller than:
 * below the floor, `resolveSummaryBudget` clamps the budget UP to the floor, so
 * the "checkpoint is smaller than the shadowed content" guarantee rejects the
 * commit and the attempt has already spent a model call. The observed failure
 * was exactly that — `span=1 seqs=24-24 shadowedTokens=428 budget=512` — where the
 * checkpoint was itself the summary of the previous run.
 *
 * The comparison is `<=`, not `<`: at `spanTokens === minTokens` the budget is
 * exactly the span, and the framed replacement (header + footer + intro, ~100
 * estimated tokens) is always larger, so equality is a guaranteed failure rather
 * than a gamble. A one-node span is refused too: re-summarizing a lone node is
 * the nested-checkpoint loop that produced the incident, and it buys no
 * cross-node structure to fold.
 *
 * `minTokens` defaults to 0, which disables the guard entirely, so every caller
 * that does not opt in keeps the historical selection byte for byte (the manual
 * `/compact` path relies on that: it must compact whatever the user asked for).
 *
 * @param session - session supplying authoritative current surface positions.
 * @param measurement - unified pressure and surface measurement.
 * @param retainTokens - minimum recent tail budget retained verbatim.
 * @param minTokens - floor below which a selected span is not worth a summary
 *   call; 0 (default) disables the guard.
 * @param maxSpanTokens - ceiling on the selected span; 0 (default) keeps the
 *   whole compactable prefix.
 * @returns the inclusive positional seq range to compact, or `null`.
 */
export function selectCompactableRange(session, measurement, retainTokens, minTokens = 0, maxSpanTokens = 0) {
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
  if (maxSpanTokens > 0) {
    // Cap the span so each compaction produces ONE leaf over a bounded stretch,
    // starting from the OLDEST node. Borrowed from lcm-x: it condenses in leaf
    // chunks of leaf_chunk_tokens (24 000) with a ~2 000-token target each, and
    // keeps every leaf, assembling several of them per request. Compacting the
    // whole compactable prefix instead produces a single ever-deeper node - there
    // is only ever one checkpoint on the surface, so deriveDag has depth but no
    // breadth, and the summary of a 400k-token span is asked to carry everything.
    // A bounded leaf also keeps the summariser prompt small, which matters because
    // the failure mode observed on real runs was the provider truncating a large
    // response before the sections were finished.
    let span = 0;
    let endIdx = firstIdx;
    for (let index = firstIdx; index < keepFromIdx; index += 1) {
      span += pricedNodes[index].tokens;
      endIdx = index;
      if (span >= maxSpanTokens) break;
    }
    // Never end the leaf mid-step: walk the boundary back until it is balanced.
    while (endIdx > firstIdx && !toolPairingBalancedAfter(session, surfaceNodes[endIdx])) endIdx -= 1;
    if (endIdx < firstIdx) return null;
    keepFromIdx = endIdx + 1;
  }
  if (minTokens > 0) {
    // The justified rule is arithmetic, not shape. Two thresholds, both from the
    // same fact: the summary target is clamped UP to summaryFloorTokens, so a
    // span barely above that floor gets a target almost as large as itself.
    //
    //   span <= floor          -> the target is at least the span; cannot shrink
    //   span <= 2 * floor      -> nominal headroom below 2:1, so an ordinary
    //                             overshoot (a model told "about 512" writing 900)
    //                             trips the shrink guarantee after paying for the
    //                             call. Measured: span 918, target 512, summary
    //                             came back 932, framed 805 >= 657 -> rejected.
    //
    // A single-node span is NOT refused on count: one 40k-token tool result is
    // exactly what compaction is for, and it does shrink.
    let spanTokens = 0;
    for (const node of pricedNodes.slice(firstIdx, keepFromIdx)) spanTokens += node.tokens;
    if (spanTokens <= 2 * minTokens) return null;
  }
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
  const events = sessionEvents(session);
  const entryState = inspectCompactionEntryState(events);
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
    const compiled = await compileCompaction(dependencies, prepared, agent, compactionId, options.sourceCommandId, signal, assertStable);
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
  throw new ManualCompactionError("summary", "manual compaction could not produce a smaller summary", { cause: failure.error });
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
  const entryState = inspectCompactionEntryState(sessionEvents(session));
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
    // Two prices, because the surface accounts in two of them.
    //
    // `dsh-token-meter` folds a `compaction/summary` event into a claim and
    // then prices the following replacement as `estimateMessage(replacement) -
    // claim.tokens`; its own surface total is summed from `node.heuristicTokens`
    // (surface-projection.js, priceSurface's heuristic branch). So the durable
    // shadow price must be the HEURISTIC price: writing the route price there
    // mis-prices every replacement whose span holds an image or a file, which
    // drifts the projected surface total and silently under-reports
    // contextPressure. `dsh-compaction-basic` splits the same two numbers
    // (shadowedTokenCount / shadowedRouteTokenCount) for this reason.
    //
    // The route price is still the number the shrink guarantee is stated in,
    // because that is what the replacement request actually costs.
    shadowedTokenCount: selectedNodes.reduce((total, node) => total + (node.heuristicTokens ?? node.tokens), 0),
    shadowedRouteTokenCount: selectedNodes.reduce((total, node) => total + node.tokens, 0)
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
 * @param assertStable - the surface-stability rule this transaction was opened with.
 * @returns the compiled summary, provenance, and framed checkpoint message.
 */
async function compileCompaction(dependencies, prepared, agent, compactionId, sourceCommandId, signal, assertStable) {
  let compiled;
  let current = prepared;
  for (;;) {
    signal?.throwIfAborted();
    try {
      compiled = await dependencies.compile(current, agent, signal);
      break;
    } catch (error) {
      // Recovery contract, verbatim from `dsh-compaction-basic`: a cancellable
      // failure is never "recovered", the span must still be the one the summary
      // was built for, and only a listener that synchronously recorded a durable
      // change to the selected input (e.g. `image/offload`) may claim it. The
      // selection is then re-derived and re-priced, because the recovery just
      // changed what the summarizer will read.
      if (signal?.aborted === true) throw error;
      assertStable(dependencies, current.session, current);
      const recovered = dependencies.recover === undefined ? false : dependencies.recover(error, agent, current.shadowedSeqs, signal);
      if (!recovered) throw error;
      current = prepareCompaction(dependencies, current.session, validateSurfaceRegion(current.session, current.start, current.end));
    }
  }
  prepared = current;
  // The UI-facing summary IS the compiled body: the checkpoint row expands to
  // exactly the entries the model sees. The body is joined with separators
  // and wrapped in an adaptive Markdown fence, so the UI renders the whole
  // expansion as one tidy code block even when messages contain markdown.
  // Display/log lines keep the HEURISTIC price: `compiled.stats.tokens` is our
  // own tokenizer's estimate of the summary body, so the advertised ratio is
  // estimator-to-estimator. `dsh-compaction-basic` logs the same heuristic
  // number. The route price above is a contract comparison, not a readable size.
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
  // The shrink guarantee is stated in ROUTE prices, exactly as
  // `dsh-compaction-basic` states it (its `shadowedRouteTokenCount`): the
  // question is whether the replacement request is cheaper than the request it
  // replaces, and only the route price answers that. The heuristic price above
  // is the durable shadow price the token meter folds, not the comparison basis.
  if (framedTokenCount >= prepared.shadowedRouteTokenCount) throw new Error(`compiled checkpoint is not smaller than the shadowed content (${framedTokenCount} estimated framed tokens >= ${prepared.shadowedRouteTokenCount})`);
  return {
    ...prepared,
    summary,
    provider: compiled.provider,
    model: compiled.model,
    targetTokens: compiled.targetTokens,
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
  const { start, end, shadowedSeqs, shadowedTokenCount, shadowedRouteTokenCount, summary, provider, model, checkpointMessage, targetTokens, usage, rawOutput } = compiled;
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
    // The contract field is `maxTokens` (dsh-compaction/types, and the released
    // v0/v1 payload validator rejects anything else as an unexpected member).
    // The value is the summary TARGET this backend asked the model to aim for —
    // no request cap was sent (see summarize.js) — so the field name is the
    // contract's, while the semantic stays "the number the instruction named".
    ...targetTokens === undefined ? {} : { maxTokens: targetTokens },
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
    // The durable shadow price (heuristic) is the contract's `CompactionResult`
    // field; the route price is carried beside it so a caller can log the real
    // request cost without re-measuring the pre-compaction surface.
    shadowedTokenCount,
    shadowedRouteTokenCount
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
