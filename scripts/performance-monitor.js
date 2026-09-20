#!/usr/bin/env node
'use strict';

const v8 = require('v8');

function measureEventLoopLag() {
  return new Promise(resolve => {
    const start = process.hrtime.bigint();
    setImmediate(() => {
      const lag = Number(process.hrtime.bigint() - start) / 1e6;
      resolve(lag);
    });
  });
}

async function collect() {
  const eventLoopLagMs = await measureEventLoopLag();
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  const heap = v8.getHeapStatistics();

  const report = {
    timestamp: new Date().toISOString(),
    rss_bytes: mem.rss,
    heap_used_bytes: mem.heapUsed,
    heap_total_bytes: mem.heapTotal,
    external_bytes: mem.external,
    array_buffers_bytes: mem.arrayBuffers,
    cpu_user_ms: cpu.user,
    cpu_system_ms: cpu.system,
    event_loop_lag_ms: Math.round(eventLoopLagMs * 1000) / 1000,
    uptime_seconds: Math.round(process.uptime() * 1000) / 1000,
    gc_stats: {
      heap_size_limit_bytes: heap.heap_size_limit,
      total_heap_size_bytes: heap.total_heap_size,
      used_heap_size_bytes: heap.used_heap_size,
      malloced_memory_bytes: heap.malloced_memory,
      external_memory_bytes: heap.external_memory,
    },
  };

  process.stdout.write(JSON.stringify(report) + '\n');
}

collect().then(() => process.exit(0)).catch(() => process.exit(0));
