/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import http from 'http';
import net from 'net';

import colors from 'colors/safe';

import type { TestRunnerPlugin } from '.';
import type { FullConfig } from '../../types/testReporter';
import type { FullConfigInternal } from '../common/config';
import type { ReporterV2 } from '../reporters/reporterV2';

export type OtelCollectorOptions = {
  /**
   * The port to listen on for OTLP/HTTP JSON requests. Defaults to 4318 (standard OTLP/HTTP port).
   * Use 0 to let the OS pick a free port.
   */
  port?: number;
  /**
   * The hostname or IP address to bind to. Defaults to '127.0.0.1' (localhost only).
   */
  host?: string;
  /**
   * Display name used in log output. Defaults to 'OtelCollector'.
   */
  name?: string;
};

// --- Internal OTLP JSON envelope types -----------------------------------------
// See: https://opentelemetry.io/docs/specs/otlp/#otlphttp

type OtlpKeyValue = {
  key: string;
  value?: {
    stringValue?: string;
    intValue?: string | number;
    doubleValue?: number;
    boolValue?: boolean;
  };
};

type OtlpSpan = {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  status?: { code?: number; message?: string };
  attributes?: OtlpKeyValue[];
};

type OtlpScopeSpans = {
  spans?: OtlpSpan[];
};

type OtlpResourceSpans = {
  resource?: { attributes?: OtlpKeyValue[] };
  scopeSpans?: OtlpScopeSpans[];
};

type OtlpPayload = {
  resourceSpans?: OtlpResourceSpans[];
};

// --- Span type (mirrors channels.ServerSpan without importing from protocol) ----

export type OtelSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime: number;
  status: 'ok' | 'error' | 'unset';
  errorMessage?: string;
  attributes?: Record<string, unknown>;
  resource?: Record<string, unknown>;
};

// --- Helpers -------------------------------------------------------------------

function nanoToMs(nano: string | number | undefined): number {
  if (nano === undefined)
    return 0;
  const str = String(nano);
  // Integer nanosecond strings: use BigInt directly to preserve precision for large epoch values.
  if (/^\d+$/.test(str)) {
    try {
      return Number(BigInt(str) / 1000000n);
    } catch {
      return 0;
    }
  }
  // Fractional nanosecond strings from some SDKs: use float arithmetic.
  const asNumber = Number(str);
  return Number.isFinite(asNumber) ? Math.floor(asNumber / 1e6) : 0;
}

function decodeAttributes(attrs: OtlpKeyValue[] | undefined): Record<string, unknown> | undefined {
  if (!attrs?.length)
    return undefined;
  const result: Record<string, unknown> = {};
  for (const kv of attrs) {
    const v = kv.value;
    if (v === undefined)
      continue;
    if (v.stringValue !== undefined)
      result[kv.key] = v.stringValue;
    else if (v.intValue !== undefined)
      result[kv.key] = Number(v.intValue);
    else if (v.doubleValue !== undefined)
      result[kv.key] = v.doubleValue;
    else if (v.boolValue !== undefined)
      result[kv.key] = v.boolValue;
  }
  return result;
}

function decodeStatus(status: OtlpSpan['status']): OtelSpan['status'] {
  // OTLP status codes: 0=unset, 1=ok, 2=error
  // See: https://opentelemetry.io/docs/specs/otlp/#status
  if (!status)
    return 'unset';
  if (status.code === 2)
    return 'error';
  if (status.code === 1)
    return 'ok';
  return 'unset';
}

// --- SpanCorrelator ------------------------------------------------------------

class SpanCorrelator {
  private _spans = new Map<string, OtelSpan[]>();

  buffer(span: OtelSpan): void {
    let spans = this._spans.get(span.traceId);
    if (!spans) {
      spans = [];
      this._spans.set(span.traceId, spans);
    }
    spans.push(span);
  }

  drain(traceId: string): OtelSpan[] {
    const spans = this._spans.get(traceId) ?? [];
    this._spans.delete(traceId);
    return spans;
  }

  drainAll(): OtelSpan[] {
    const all: OtelSpan[] = [];
    for (const spans of this._spans.values())
      all.push(...spans);
    this._spans.clear();
    return all;
  }
}

// --- OtelCollectorPlugin -------------------------------------------------------

export class OtelCollectorPlugin implements TestRunnerPlugin {
  readonly name = 'playwright:otel-collector';

  private _options: OtelCollectorOptions;
  private _server: http.Server | undefined;
  private _correlator: SpanCorrelator | undefined;
  private _endpoint: string | undefined;
  private _reporter: ReporterV2 | undefined;
  private _prevOtlpEndpoint: string | undefined;
  private _prevOtlpProtocol: string | undefined;

  constructor(options: OtelCollectorOptions) {
    this._options = options;
  }

  async setup(config: FullConfig, configDir: string, reporter: ReporterV2): Promise<void> {
    this._reporter = reporter;
    this._correlator = new SpanCorrelator();
    this._server = this._createServer();

    const host = this._options.host ?? '127.0.0.1';
    const port = this._options.port ?? 4318;

    await new Promise<void>((resolve, reject) => {
      this._server!.listen(port, host, () => resolve());
      this._server!.on('error', reject);
    });

    const address = this._server.address() as net.AddressInfo;
    this._endpoint = `http://${host}:${address.port}`;

    // Preserve original env vars so we can restore them on teardown.
    this._prevOtlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    this._prevOtlpProtocol = process.env.OTEL_EXPORTER_OTLP_PROTOCOL;

    // Expose endpoint so OTel SDKs in the same process auto-discover it.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = this._endpoint;
    // Force JSON transport: the collector only speaks OTLP/HTTP JSON, not protobuf.
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json';
    // Expose endpoint so Playwright fixtures in workers can drain spans.
    process.env.PLAYWRIGHT_OTEL_COLLECTOR = this._endpoint;

    const label = this._options.name ?? 'OtelCollector';
    this._reporter.onStdOut?.(colors.dim(`[${label}] `) + `Listening on ${this._endpoint}/v1/traces\n`);
  }

  async teardown(): Promise<void> {
    // Restore env vars that were overwritten in setup().
    if (this._prevOtlpEndpoint !== undefined)
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = this._prevOtlpEndpoint;
    else
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

    if (this._prevOtlpProtocol !== undefined)
      process.env.OTEL_EXPORTER_OTLP_PROTOCOL = this._prevOtlpProtocol;
    else
      delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL;

    delete process.env.PLAYWRIGHT_OTEL_COLLECTOR;
    await new Promise<void>((resolve, reject) => {
      if (!this._server) {
        resolve();
        return;
      }
      this._server.close(err => (err ? reject(err) : resolve()));
    });
  }

  drainSpans(traceId: string): OtelSpan[] {
    return this._correlator?.drain(traceId) ?? [];
  }

  get endpoint(): string | undefined {
    return this._endpoint;
  }

  private _createServer(): http.Server {
    return http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(404);
        res.end();
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          if (req.url === '/v1/traces') {
            const payload = JSON.parse(body) as OtlpPayload;
            this._ingestPayload(payload);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{}');
          } else if (req.url === '/v1/drain') {
            const { traceId } = JSON.parse(body) as { traceId: string };
            const spans = this._correlator?.drain(traceId) ?? [];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ spans }));
          } else {
            res.writeHead(404);
            res.end();
          }
        } catch (e) {
          this._reporter?.onStdErr?.(colors.dim(`[${this._options.name ?? 'OtelCollector'}] `) + `Failed to parse request: ${e}\n`);
          res.writeHead(400);
          res.end();
        }
      });
    });
  }

  private _ingestPayload(payload: OtlpPayload): void {
    for (const resourceSpan of payload.resourceSpans ?? []) {
      const resource = decodeAttributes(resourceSpan.resource?.attributes);
      for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
        for (const span of scopeSpan.spans ?? []) {
          // Drop spans that are missing required identity or timing fields.
          if (!span.traceId || !span.spanId || !span.startTimeUnixNano || !span.endTimeUnixNano)
            continue;
          const startTime = nanoToMs(span.startTimeUnixNano);
          const endTime = nanoToMs(span.endTimeUnixNano);
          if (endTime < startTime)
            continue;
          const otelSpan: OtelSpan = {
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId || undefined,
            name: span.name ?? '',
            startTime,
            endTime,
            status: decodeStatus(span.status),
            errorMessage: span.status?.message || undefined,
            attributes: decodeAttributes(span.attributes),
            resource,
          };
          this._correlator!.buffer(otelSpan);
        }
      }
    }
  }
}

export const otelCollectorPluginsForConfig = (config: FullConfigInternal): TestRunnerPlugin[] => {
  return config.otelCollectors.map(options => new OtelCollectorPlugin(options));
};
