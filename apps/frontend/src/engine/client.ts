import type { AnalysisRequest, AnalysisResult } from "@causal-graph-workbench/shared";

import type { AuditSnapshot } from "./audit";
import { mergeUpdate } from "./mergeUpdate";

/** A newer request replaced this one before it finished. */
export class SupersededError extends Error {
  constructor() {
    super("A newer analysis replaced this one.");
    this.name = "SupersededError";
  }
}

type ProgressListener = (result: AnalysisResult) => void;

interface Job {
  id: number;
  resolve: (result: AnalysisResult) => void;
  reject: (error: Error) => void;
  onProgress?: ProgressListener;
  current: AnalysisResult | null;
}

type WorkerReply =
  | { id: number; kind: "structure"; result: AnalysisResult }
  | { id: number; kind: "update"; update: AuditSnapshot }
  | { id: number; kind: "done"; result?: AnalysisResult | null; update: AuditSnapshot | null }
  | { id: number; kind: "error"; error: string };

/**
 * Runs analyses off the main thread so large files never freeze the canvas. Only the latest request
 * matters: a new one replaces whatever is running, and the worker drops the old job at its next pause.
 */
export class AnalysisClient {
  private worker: Worker | null = null;
  private active: Job | null = null;
  private nextId = 1;

  constructor(private readonly createWorker: () => Worker) {}

  run(request: AnalysisRequest, onProgress?: ProgressListener): Promise<AnalysisResult> {
    return new Promise((resolve, reject) => {
      this.active?.reject(new SupersededError());
      const job: Job = { id: this.nextId++, resolve, reject, onProgress, current: null };
      this.active = job;
      this.ensureWorker().postMessage({ id: job.id, request });
    });
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      const worker = this.createWorker();
      worker.onmessage = (event: MessageEvent<WorkerReply>) => this.handleReply(event.data);
      worker.onerror = (event) => this.handleCrash(event);
      this.worker = worker;
    }
    return this.worker;
  }

  private handleReply(reply: WorkerReply): void {
    const job = this.active;
    if (job?.id !== reply.id) {
      return;
    }
    if (reply.kind === "error") {
      this.active = null;
      job.reject(new Error(reply.error));
      return;
    }
    if ((reply.kind === "structure" || reply.kind === "done") && reply.result) {
      job.current = reply.result;
    }
    if (reply.kind !== "structure" && reply.update && job.current) {
      job.current = mergeUpdate(job.current, reply.update);
    }
    if (reply.kind === "done") {
      this.active = null;
      job.resolve(job.current!);
      return;
    }
    if (job.current) {
      job.onProgress?.(job.current);
    }
  }

  private handleCrash(event: ErrorEvent): void {
    event.preventDefault?.();
    this.worker?.terminate();
    this.worker = null;
    const job = this.active;
    this.active = null;
    job?.reject(new Error(event.message || "The analysis worker stopped unexpectedly."));
  }
}

let shared: AnalysisClient | null = null;

export async function analyzeGraph(request: AnalysisRequest, onProgress?: ProgressListener): Promise<AnalysisResult> {
  if (typeof Worker === "undefined") {
    const { analyze } = await import("./analyze");
    return analyze(request);
  }
  shared ??= new AnalysisClient(() => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }));
  return shared.run(request, onProgress);
}
