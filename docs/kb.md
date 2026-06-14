# Knowledge Base — Architecture Notes

Pre-implementation design for the KB section. Two parallel KB modes coexist
in Nango:

1. **External RAG (e.g. RagFlow)** — read-only query interface. Nango wraps
   the external service as an MCP server; agents bind it like any other MCP.
   No state lives in Nango. Out of scope for this doc.

2. **LLM-Compiled Wiki (Karpathy-style, OpenKB pattern)** — Nango-managed.
   Documents are compiled once into a structured Markdown wiki with
   summaries, concepts, and cross-references. Agents (and humans) query
   the wiki; on miss, fall back to retrieval against the original document.

This doc covers (2). It captures two intertwined decisions:

- **PageIndex sidecar** — how we run the long-document tree-builder /
  retriever as a Python sidecar service alongside Nango's Next.js process.
- **Document storage** — where the raw PDFs, tree JSON, and compiled
  markdown live, and how the storage layer is abstracted.

Not implementation-ready yet — sitting in `docs/` for review and iteration.

---

## 1. Why a sidecar

PageIndex is the long-document index + retrieval engine we depend on. Since it's a Python library and Nango is Node/Next.js, we integrate it via an **HTTP sidecar**. This avoids the latency of spawning child processes per call and bypasses WASM portability issues with C extensions.

The sidecar runs PageIndex inside a minimal FastAPI app and shares the KB filesystem volume with Nango to read PDFs directly.

## 2. Sidecar API

Minimal surface — two endpoints cover both compile-time (build tree) and
query-time (search a previously-built tree) needs.

```
POST /index
  body: { collection_id: str, doc_id: str, source_path: str }
  effect: parses PDF at source_path, builds tree JSON, persists
          at <kb-root>/trees/<collection_id>/<doc_id>.json
  returns: { tree_summary: { node_count, depth, generated_at } }

POST /search
  body: { collection_id: str, doc_id: str, query: str, top_k?: int = 5 }
  reads: <kb-root>/trees/<collection_id>/<doc_id>.json
  effect: LLM-driven tree search over the cached tree
  returns: { nodes: [{ node_id, title, content_excerpt, score }, ...] }

GET /health
  returns: { ok: true, page_index_version, model: "<lite-llm-id>" }
```

Both endpoints are stateless given the shared filesystem — restarting the
sidecar loses nothing. State of record lives in:
- Postgres: `kb_source_doc.tree_status`, `kb_page` rows (compiled wiki)
- Filesystem: source PDFs + tree JSON (raw artefacts)

### Why not also do markdown compile in the sidecar?

PageIndex only does the indexing + retrieval. Turning a tree into Markdown
summaries / concept pages is **a separate orchestration concern** that
belongs in Nango:

- Compile loops want Nango's agent infrastructure (`entity_run`,
  `schedule`, `skill`) for run tracking, retries, observability.
- Prompt iteration is faster in Nango's existing skill framework than in
  a separate Python service.
- Keeping the sidecar narrow (just PageIndex) means we can swap PageIndex
  out without touching the compile pipeline.

So the compile pipeline lives in Nango as a chain of skills, calling the
sidecar only for the `POST /index` step. See §5 ("Compile pipeline").

## 3. Deployment shape

```yaml
# docker-compose.yml additions

services:
  nango:
    # ... existing ...
    volumes:
      - kb-data:/var/nango/kb     # shared with sidecar
    environment:
      KB_SIDECAR_URL: http://kb-sidecar:8000
      KB_STORAGE_DRIVER: local
      KB_STORAGE_LOCAL_ROOT: /var/nango/kb

  kb-sidecar:
    image: nango/kb-sidecar:latest    # built from a small Dockerfile in /sidecars/kb/
    restart: unless-stopped
    volumes:
      - kb-data:/var/nango/kb         # same mount, same paths
    environment:
      KB_ROOT: /var/nango/kb
      OPENAI_API_KEY: ${OPENAI_API_KEY}   # or anthropic / gemini via LiteLLM
      LLM_MODEL: ${KB_LLM_MODEL:-anthropic/claude-sonnet-4}
    ports:
      - "8000"                        # internal only, not exposed to host

volumes:
  kb-data:
```

The sidecar Dockerfile is ~30 lines: `FROM python:3.12-slim`, `pip install
pageindex fastapi uvicorn`, copy a single `main.py`. Source lives at
`sidecars/kb/` in the repo.

## 4. Document storage

### Storage by content type

| Data | Storage | Rationale |
|---|---|---|
| `kb_collection`, `kb_source_doc` metadata rows | Postgres | Same as all other Nango entity metadata; queryable, transactional |
| `kb_page` (compiled markdown) | Postgres `text` column | Each page 1-10KB; want SQL listing + filter; backup via `pg_dump`; transactional with metadata |
| Source documents (PDF, docx, etc.) | Filesystem volume | Often multi-MB to multi-GB; bytea would balloon `pg_dump`; sidecar reads them via the shared mount |
| PageIndex tree JSON | Filesystem volume | 100KB-1MB per doc; written by sidecar, read by sidecar — same lifecycle as the PDF |

### Filesystem layout (on the shared volume)

```
/var/nango/kb/
├── sources/
│   └── <collection_id>/
│       └── <doc_id>.<ext>          # original upload
├── trees/
│   └── <collection_id>/
│       └── <doc_id>.json           # PageIndex tree
└── exports/                        # optional: markdown export for Obsidian
    └── <collection_id>/
```

The choice to keep markdown IN Postgres (not on disk alongside sources/)
trades off Obsidian-compatibility for transactional safety + queryability.
Users edit via Nango UI, not via Obsidian, so we lose nothing in practice.
An optional periodic `exports/` dump can regenerate Obsidian-ready files
if needed.

### Storage abstraction

All filesystem access goes through a single interface so a future S3 swap
is config-only:

```ts
// src/lib/kb/storage/storage.ts
export interface KbStorage {
  putSourceDoc(collectionId: string, docId: string, bytes: Buffer, ext: string): Promise<void>;
  getSourceDoc(collectionId: string, docId: string): Promise<Buffer>;
  putTree(collectionId: string, docId: string, json: object): Promise<void>;
  getTree(collectionId: string, docId: string): Promise<object>;
  deleteDoc(collectionId: string, docId: string): Promise<void>;
  /** Path the sidecar can read directly (filesystem driver) or a
   *  presigned URL (s3 driver). Sidecar accepts either. */
  resolveSourcePath(collectionId: string, docId: string): Promise<string>;
}
```

Implementations:
- `FilesystemKbStorage` — initial; reads/writes under
  `KB_STORAGE_LOCAL_ROOT`; `resolveSourcePath` returns absolute path.
- `S3KbStorage` — future; uses AWS SDK; `resolveSourcePath` returns a
  presigned GET URL that the sidecar can fetch.

Driver selected by env:
- `KB_STORAGE_DRIVER=local` (default) | `s3`
- `KB_STORAGE_LOCAL_ROOT=/var/nango/kb`
- `KB_STORAGE_S3_BUCKET=...` + standard AWS env

This matches the existing `datasource.cache_root` pattern in
`src/lib/data-sources/cache-root.ts`, which is filesystem-only today but
could be promoted to the same abstraction if multi-instance support
becomes a requirement.

### Why not S3 from day one?

- Adds an extra container (MinIO) for self-host users who don't have AWS
- No multi-instance deployment exists yet to justify the cost
- Existing project storage (dataset cache, skill bytes) is FS / DB only —
  introducing S3 just for KB is asymmetric
- Abstraction means the cost of switching later is low

If/when Nango goes multi-instance, swap drivers in one commit.

## 5. Compile pipeline (Nango side)

This is the part that USES the sidecar. Not the focus of this doc but
sketched for context.

```
[User uploads PDF]
   ↓
POST /api/kb/sources       (Nango)
   ↓
  1. KbStorage.putSourceDoc       → /var/nango/kb/sources/<coll>/<doc>.pdf
  2. INSERT INTO kb_source_doc    → status: 'pending'
   ↓
[Triggered: agent run via existing runner.start]
   ↓
  3. Skill: kb_index_doc
     calls KB sidecar POST /index → tree JSON written to /var/nango/kb/trees/
     UPDATE kb_source_doc SET tree_status='ready'
   ↓
  4. Skill: kb_compile_summary
     reads tree (via sidecar /search or directly), LLM writes summary
     INSERT INTO kb_page (kind='summary', body_markdown, source_doc_id)
   ↓
  5. Skill: kb_compile_concepts (cross-doc synthesis)
     reads all summaries in collection, LLM extracts concepts + cross-refs
     UPSERTs into kb_page (kind='concept', ...)
   ↓
[Wiki ready]
```

Updates use the same pipeline keyed by `kb_source_doc.hash` change.

Query path:
```
[Agent or user query]
   ↓
  1. Search kb_page by full-text (Postgres tsvector)
     If high-confidence hit → return immediately
   ↓
  2. (Optional) For unanswered detail questions:
     call KB sidecar POST /search on relevant doc
     Re-synth with concrete page content
```

## 6. Open Questions & Future Plans

- **Multi-tenant isolation**: Determine if `<collection_id>` namespace is sufficient for large scale.
- **Tree refresh strategy**: Handle re-indexing when PageIndex output schema changes.
- **Sidecar HA & Auth**: Evaluate adding reverse-proxy retries and shared secret headers for distributed deployments.
