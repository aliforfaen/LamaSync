// Presentational wrapper around the pure `operationSentence` formatter
// (LAMA-258). Renders the sentence with the subject/device/destination
// bolded and keeps the raw server `summary` on the title so no information
// is lost (the formatter deliberately ignores `summary`).

import type { OperationLog } from "@lamasync/core";
import { operationSentence, type OperationSentenceContext } from "../operation-sentence.ts";

export function OperationSentenceView({
  op,
  ctx,
}: {
  op: OperationLog;
  ctx: OperationSentenceContext;
}) {
  const s = operationSentence(op, ctx);
  const showStatus = op.status !== "failed";
  return (
    <span className="op-sentence" title={op.summary ?? op.operation}>
      {s.verb}
      {s.folder ? (
        <>
          {" "}
          <strong>{s.folder}</strong>
        </>
      ) : null}
      {s.from ? (
        <>
          {" from "}
          <strong>{s.from}</strong>
        </>
      ) : null}
      {s.to ? (
        <>
          {" to "}
          <strong>{s.to}</strong>
        </>
      ) : null}
      {" · "}
      {s.timeAgo}
      {showStatus ? (
        <>
          {" · "}
          {s.statusWord}
        </>
      ) : null}
    </span>
  );
}
