# AsmJit Readiness Plan — db2_to_csv_parser_classic-anniversary_68101

Status: PREPARED_ONLY
Branch: `prep/asmjit-readiness-2026-09-19`
Decision: DO NOT INTEGRATE.

The workload is CDN retrieval, binary parsing, decoding, and CSV serialization. A runtime machine-code generator does not address the primary bottlenecks.

## Preferred optimization path
Profile network/CDN access, binary parsing allocation patterns, streaming, batching, schema lookup, CSV serialization, and concurrency.

## Revisit trigger
Only if a future parser engine introduces a proven dynamic code-generation requirement that static parsing/JITs already available in the runtime cannot satisfy.

No implementation, dependency addition, PR, or merge on this branch.
