/**
 * Wrap a single-model dispatch with a per-target timeout that aborts and falls back.
 *
 * Verbatim extraction of handleComboChat's `handleSingleModelWithTimeout` closure
 * (combo.ts). Behavior is byte-identical; the only change is that the closed-over locals
 * (`handleSingleModel`, `comboTargetTimeoutMs`, `log`) became explicit factory params.
 * The per-model abort signal still comes from the target (`target.modelAbortSignal`), so
 * the outer request signal is intentionally NOT a dependency here.
 *
 * 2026-08-08 (combo-hang fix): two additions:
 *  - `resolveTargetTimeoutMs` lets the caller pick the effective timeout per TARGET
 *    (e.g. a short fail-fast budget for hang-prone providers like NVIDIA NIM) instead of
 *    one fixed combo-wide value.
 *  - when the timeout fires, the synthesised 524 now records per-key timeout health
 *    (`recordKeyTimeout`) so the connection is benched across requests via the sliding
 *    window in perKeyBackoff.ts — the combo stops burning the full timeout budget on the
 *    same dead key/egress on every request.
 *
 * See _tasks/superpowers/plans/2026-07-03-blocoJ-combo-hotpath-decomposition.md (Task 1).
 */
import { errorResponse } from "../../utils/error.ts";
import { recordKeyTimeout } from "../perKeyBackoff.ts";
import type { HandleSingleModel, SingleModelTarget, ComboLogger } from "./types.ts";

export function buildTargetTimeoutRunner(deps: {
  handleSingleModel: HandleSingleModel;
  comboTargetTimeoutMs: number;
  log: ComboLogger;
  resolveTargetTimeoutMs?: (target?: SingleModelTarget) => number;
}): (
  b: Record<string, unknown>,
  modelStr: string,
  target?: SingleModelTarget
) => Promise<Response> {
  const { handleSingleModel, comboTargetTimeoutMs, log } = deps;
  return async (
    b: Record<string, unknown>,
    modelStr: string,
    target?: SingleModelTarget
  ): Promise<Response> => {
    const effectiveTimeoutMs = deps.resolveTargetTimeoutMs?.(target) ?? comboTargetTimeoutMs;
    if (effectiveTimeoutMs <= 0) {
      return handleSingleModel(b, modelStr, target).catch((err) =>
        errorResponse(502, err?.message ?? "Upstream model error")
      );
    }

    const timeoutController = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    // The target union has a bare `{ modelAbortSignal }` member; only the
    // ResolvedComboTarget member carries connection health info.
    const targetConnectionId =
      target && "connectionId" in target ? (target.connectionId ?? null) : null;
    const timeoutPromise = new Promise<Response>((resolve) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        log.warn(
          "COMBO",
          `Model ${modelStr} exceeded ${effectiveTimeoutMs}ms timeout — falling back`
        );
        // Combo-hang fix: bench the connection so subsequent requests skip it
        // (sliding-window timeout health) instead of repeating the same hang.
        if (targetConnectionId) {
          recordKeyTimeout(targetConnectionId);
          log.warn(
            "COMBO",
            `Connection ${targetConnectionId.slice(0, 8)} timed out — recorded timeout health backoff`
          );
        }
        timeoutController.abort(new Error("combo-per-model-timeout"));
        resolve(
          new Response(JSON.stringify({ error: { message: `Model ${modelStr} timed out` } }), {
            status: 524,
            headers: { "Content-Type": "application/json" },
          })
        );
      }, effectiveTimeoutMs);
    });
    const targetWithSignal = {
      ...(target ?? {}),
      modelAbortSignal: timeoutController.signal,
    };
    const parentHedgeSignal = target?.modelAbortSignal ?? null;
    let onParentHedgeAbort: (() => void) | null = null;
    if (parentHedgeSignal) {
      if (parentHedgeSignal.aborted) {
        timeoutController.abort(new Error("hedge-cancelled"));
      } else {
        onParentHedgeAbort = () => {
          timeoutController.abort(new Error("hedge-cancelled"));
        };
        parentHedgeSignal.addEventListener("abort", onParentHedgeAbort, { once: true });
      }
    }
    try {
      return await Promise.race([
        handleSingleModel(b, modelStr, targetWithSignal).catch((err) => {
          if (timedOut) {
            // Inner call rejected because we aborted it. The synthetic 524 from
            // timeoutPromise already wins the race; return an empty response so
            // the loser branch resolves cleanly without leaking err.message.
            return new Response(null, { status: 599 });
          }
          return errorResponse(502, err?.message ?? "Upstream model error");
        }),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timeoutId);
      if (parentHedgeSignal && onParentHedgeAbort) {
        parentHedgeSignal.removeEventListener("abort", onParentHedgeAbort);
      }
    }
  };
}
