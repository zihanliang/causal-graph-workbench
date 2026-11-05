import type { AnalysisRequest, AnalysisResult } from "@causal-graph-workbench/shared";
import { describe, expect, test } from "vitest";

import type { AuditSnapshot } from "./audit";
import { AnalysisClient, SupersededError } from "./client";

class FakeWorker {
  posted: { id: number; request: AnalysisRequest }[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(message: { id: number; request: AnalysisRequest }) {
    this.posted.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  reply(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }

  crash(message: string) {
    this.onerror?.({ message, preventDefault() {} } as ErrorEvent);
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  const client = new AnalysisClient(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });
  return { client, workers };
}

const request = (tag: string) => ({ graph: { nodes: [], edges: [], treatmentId: tag, outcomeId: null } }) as AnalysisRequest;
const structure = (tag: string) => ({ tag, audit: null, effect: null }) as unknown as AnalysisResult;
const update = (status: string) => ({ audit: { status }, effect: null }) as unknown as AuditSnapshot;

describe("analysis client", () => {
  test("delivers the finished result, with progress on the way", async () => {
    const { client, workers } = setup();
    const progress: unknown[] = [];
    const pending = client.run(request("a"), (result) => progress.push(result.audit));
    const { id } = workers[0].posted[0];

    workers[0].reply({ id, kind: "structure", result: structure("a") });
    workers[0].reply({ id, kind: "update", update: update("running") });
    workers[0].reply({ id, kind: "done", update: update("complete") });

    await expect(pending).resolves.toMatchObject({ tag: "a", audit: { status: "complete" } });
    expect(progress).toEqual([null, { status: "running" }]);
  });

  test("a job with nothing further to report still finishes", async () => {
    const { client, workers } = setup();
    const pending = client.run(request("a"));
    const { id } = workers[0].posted[0];
    workers[0].reply({ id, kind: "structure", result: structure("a") });
    workers[0].reply({ id, kind: "done", update: null });
    await expect(pending).resolves.toMatchObject({ tag: "a" });
  });

  test("a quick run delivers one complete result with no partial step", async () => {
    const { client, workers } = setup();
    const progress: unknown[] = [];
    const pending = client.run(request("a"), (result) => progress.push(result));
    const { id } = workers[0].posted[0];
    workers[0].reply({ id, kind: "done", result: structure("a"), update: update("complete") });
    await expect(pending).resolves.toMatchObject({ tag: "a", audit: { status: "complete" } });
    expect(progress).toEqual([]);
  });

  test("every part of a later stage reaches the page, as it does in a synchronous run", async () => {
    const { client, workers } = setup();
    const seen: AnalysisResult[] = [];
    const pending = client.run(request("a"), (result) => seen.push(result));
    const { id } = workers[0].posted[0];
    const sensitivity = { status: "complete", robustness: null, evalue: null };
    const effect = { status: "complete", estimate: null, unavailableReason: null, comparisons: [] };
    const audit = update("complete").audit;
    const stage = { audit, effect, sensitivity } as unknown as AuditSnapshot;

    workers[0].reply({ id, kind: "structure", result: structure("a") });
    workers[0].reply({ id, kind: "update", update: stage });
    expect(seen[seen.length - 1]).toMatchObject({ audit, effect, sensitivity });

    workers[0].reply({ id, kind: "done", update: stage });
    await expect(pending).resolves.toMatchObject({ audit, effect, sensitivity });
  });

  test("a new request replaces the running one straight away", async () => {
    const { client, workers } = setup();
    const first = client.run(request("first"));
    const second = client.run(request("second"));

    await expect(first).rejects.toBeInstanceOf(SupersededError);
    expect(workers[0].posted.map((message) => message.request.graph.treatmentId)).toEqual(["first", "second"]);

    const { id } = workers[0].posted[1];
    workers[0].reply({ id, kind: "structure", result: structure("second") });
    workers[0].reply({ id, kind: "done", update: null });
    await expect(second).resolves.toMatchObject({ tag: "second" });
  });

  test("replies from a replaced job are ignored", async () => {
    const { client, workers } = setup();
    const first = client.run(request("first"));
    first.catch(() => {});
    const seen: string[] = [];
    const second = client.run(request("second"), (result) => seen.push((result as unknown as { tag: string }).tag));
    const staleId = workers[0].posted[0].id;
    const { id } = workers[0].posted[1];

    workers[0].reply({ id: staleId, kind: "structure", result: structure("stale") });
    workers[0].reply({ id: staleId, kind: "done", update: null });
    workers[0].reply({ id, kind: "structure", result: structure("second") });
    workers[0].reply({ id, kind: "done", update: null });

    await expect(second).resolves.toMatchObject({ tag: "second" });
    expect(seen).toEqual(["second"]);
  });

  test("an engine error rejects that job and the next one still runs", async () => {
    const { client, workers } = setup();
    const first = client.run(request("first"));
    workers[0].reply({ id: workers[0].posted[0].id, kind: "error", error: "bad input" });
    await expect(first).rejects.toThrow("bad input");

    const second = client.run(request("second"));
    const { id } = workers[0].posted[1];
    workers[0].reply({ id, kind: "structure", result: structure("second") });
    workers[0].reply({ id, kind: "done", update: null });
    await expect(second).resolves.toMatchObject({ tag: "second" });
  });

  test("a crashed worker is replaced so later analyses still work", async () => {
    const { client, workers } = setup();
    const first = client.run(request("first"));
    workers[0].crash("out of memory");
    await expect(first).rejects.toThrow("out of memory");
    expect(workers[0].terminated).toBe(true);

    const second = client.run(request("second"));
    expect(workers).toHaveLength(2);
    const { id } = workers[1].posted[0];
    workers[1].reply({ id, kind: "structure", result: structure("second") });
    workers[1].reply({ id, kind: "done", update: null });
    await expect(second).resolves.toMatchObject({ tag: "second" });
  });
});
