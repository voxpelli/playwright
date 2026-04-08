/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as React from 'react';
import type { TraceModel } from '@isomorphic/trace/traceModel';
import type { ServerSpanTraceEvent } from '@trace/trace';
import { msToString } from '@isomorphic/formatUtils';
import { PlaceholderPanel } from './placeholderPanel';
import './serverSpansTab.css';

type ServerSpansTabModel = {
  spans: ServerSpanTraceEvent[];
  errorCount: number;
};

export function useServerSpansTabModel(model: TraceModel | undefined): ServerSpansTabModel {
  return React.useMemo(() => {
    const spans = model?.serverSpans ? [...model.serverSpans].sort((a, b) => a.startTime - b.startTime) : [];
    const errorCount = spans.filter(s => s.status === 'error').length;
    return { spans, errorCount };
  }, [model]);
}

const KEY_ATTRIBUTES = new Set(['http.method', 'http.status_code', 'db.system', 'rpc.method', 'messaging.system']);

const SpanRow: React.FC<{ span: ServerSpanTraceEvent }> = ({ span }) => {
  const serviceName = (span.resource?.['service.name'] as string | undefined) ?? '';
  const duration = span.endTime - span.startTime;
  const keyAttrs = span.attributes
    ? Object.entries(span.attributes).filter(([k]) => KEY_ATTRIBUTES.has(k))
    : [];

  return <div className='server-span-row'>
    <div className='server-span-row-header'>
      <span className={`server-span-status server-span-status-${span.status}`}>{span.status}</span>
      <span className='server-span-name' title={span.name}>{span.name}</span>
      {serviceName && <span className='server-span-service'>{serviceName}</span>}
      <span className='server-span-duration'>{msToString(duration)}</span>
    </div>
    {span.errorMessage && <div className='server-span-error-message'>{span.errorMessage}</div>}
    {keyAttrs.length > 0 && <div className='server-span-attributes'>
      {keyAttrs.map(([k, v]) => (
        <span key={k} className='server-span-attribute' title={k}>{String(v)}</span>
      ))}
    </div>}
  </div>;
};

export const ServerSpansTab: React.FunctionComponent<{
  serverSpansModel: ServerSpansTabModel;
}> = ({ serverSpansModel }) => {
  if (!serverSpansModel.spans.length)
    return <PlaceholderPanel text='No server spans' />;

  return <div className='fill' style={{ overflow: 'auto' }}>
    {serverSpansModel.spans.map(span => (
      <SpanRow key={span.spanId} span={span} />
    ))}
  </div>;
};
