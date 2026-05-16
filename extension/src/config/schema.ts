export const PERF_LENS_YAML_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['version'],
  additionalProperties: false,
  properties: {
    version: { type: 'integer', const: 1 },
    project: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        language_standard: {
          type: 'string',
          enum: ['c++14', 'c++17', 'c++20', 'c++23'],
        },
      },
    },
    build: {
      type: 'object',
      additionalProperties: false,
      properties: {
        compile_commands: { type: 'string' },
        release_variant:  { type: 'string' },
      },
    },
    rules: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled:    { type: 'array', items: { type: 'string' } },
        disabled:   { type: 'array', items: { type: 'string' } },
        thresholds: { type: 'object', additionalProperties: { type: 'number' } },
      },
    },
    suppressions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file:        { type: 'string' },
          rules:       { type: 'array', items: { type: 'string' } },
          line_marker: { type: 'string' },
        },
      },
    },
    llm: {
      type: 'object',
      additionalProperties: false,
      properties: {
        share_cache: { type: 'boolean' },
        cache_file:  { type: 'string' },
      },
    },
    profiling: {
      type: 'object',
      additionalProperties: false,
      properties: {
        default_profiler: {
          type: 'string',
          enum: ['perf', 'vtune', 'instruments', 'uprof', 'samply'],
        },
        benchmarks: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'command'],
            properties: {
              name:    { type: 'string' },
              command: { type: 'string' },
              events:  { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    hot_paths: {
      type: 'array',
      items: { type: 'string' },
    },
  },
} as const;
