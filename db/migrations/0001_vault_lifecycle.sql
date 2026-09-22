-- =============================================================================
-- 0001_vault_lifecycle.sql
--
-- Adds lifecycle + provenance state to prompt_research so records can be
-- retired from retrieval WITHOUT being deleted, and so every active card
-- carries verifiable source identity.
--
-- WHY THIS EXISTS
--   The vault previously had no way to express "keep this row for provenance
--   but stop it competing for a retrieval slot". The only options were delete
--   (destroys history) or leave active (pollutes retrieval). Archival state
--   fixes that. It also adds the canonical identifiers needed to deduplicate
--   by DOI/arXiv rather than by title, after two rows were found citing
--   entirely unrelated papers.
--
-- PROPERTIES
--   * Idempotent — every statement guards with IF [NOT] EXISTS or OR REPLACE.
--     Safe to re-run.
--   * Additive — no column is dropped or retyped; citation_url is retained
--     verbatim for backwards compatibility.
--   * Reversible — see 0001_vault_lifecycle_down.sql.
--   * Defaults preserve current behaviour: every existing row becomes
--     status='active', retrieval_enabled=true, i.e. exactly what retrieval
--     does today. Lifecycle changes are applied later as DATA, not by this DDL.
--
-- HOW TO RUN
--   Paste into the Supabase SQL editor and execute. The service-role key used
--   by the app CANNOT run DDL over PostgREST, so this cannot be applied from
--   application code.
--
-- IMPORTANT — pgvector schema
--   This project installs pgvector into the `extensions` schema, so a bare
--   `vector(1024)` does NOT resolve and neither does the `<=>` operator. The
--   search_path below fixes both for this session; the function additionally
--   pins its own search_path so it keeps working regardless of the caller's.
-- =============================================================================

set search_path = public, extensions;

begin;

-- ── 1. Lifecycle state ───────────────────────────────────────────────────────

-- Retrieval eligibility is deliberately TWO fields, not one. `status` is the
-- editorial lifecycle; `retrieval_enabled` is an independent operational
-- switch. A record can be status='active' but temporarily withheld from
-- retrieval (e.g. pending re-embedding) without lying about its editorial
-- state.
alter table prompt_research add column if not exists status            text    not null default 'active';
alter table prompt_research add column if not exists retrieval_enabled boolean not null default true;

-- ── 2. Source identity ───────────────────────────────────────────────────────

-- canonical_id is the normalized primary key of the SOURCE (not the row):
--   arXiv:2201.11903 | doi:10.18653/v1/2024.findings-acl.21 | acl:2024.findings-acl.21
-- Dedup checks this before falling back to URL, then title/aliases, then
-- semantic similarity.
alter table prompt_research add column if not exists canonical_id    text;
alter table prompt_research add column if not exists doi             text;
alter table prompt_research add column if not exists arxiv_id        text;
alter table prompt_research add column if not exists venue           text;

-- source_type = what kind of artefact it is.
-- evidence_status = how much weight its claims carry.
-- These are separate because a peer-reviewed paper can still be cited for a
-- claim it never made ("derived_guidance"), and a vendor blog can be a
-- legitimate source for how that vendor's own product behaves.
alter table prompt_research add column if not exists source_type     text;
alter table prompt_research add column if not exists evidence_status text;

-- ── 3. Relationships + editorial metadata ────────────────────────────────────

-- Method acronyms (MIPRO, SAMMO, GEPA…) are frequently NOT the paper title.
-- Storing them as aliases keeps the card findable without corrupting the
-- citation.
alter table prompt_research add column if not exists aliases           text[];

-- [{label, url, canonical_id, note}] — for merged-in sources and companion
-- papers that should be credited but must not occupy their own retrieval slot.
alter table prompt_research add column if not exists related_citations jsonb;

alter table prompt_research add column if not exists superseded_by     uuid;
alter table prompt_research add column if not exists merged_into       uuid;
alter table prompt_research add column if not exists limitations       text;
alter table prompt_research add column if not exists reviewed_at       timestamptz;
alter table prompt_research add column if not exists review_note       text;

-- ── 4. Constraints ───────────────────────────────────────────────────────────

alter table prompt_research drop constraint if exists prompt_research_status_chk;
alter table prompt_research add  constraint prompt_research_status_chk
  check (status in ('active','reference_only','watch','archived','merged','superseded'));

alter table prompt_research drop constraint if exists prompt_research_source_type_chk;
alter table prompt_research add  constraint prompt_research_source_type_chk
  check (source_type is null or source_type in
    ('peer_reviewed_paper','preprint','survey','vendor_blog','vendor_docs','product_docs','book'));

alter table prompt_research drop constraint if exists prompt_research_evidence_status_chk;
alter table prompt_research add  constraint prompt_research_evidence_status_chk
  check (evidence_status is null or evidence_status in
    ('peer_reviewed','preprint','author_claimed_venue','vendor_reported','derived_guidance','unverified'));

-- An archived/merged/watch/reference_only row must never be retrieval-enabled.
-- Enforced in the database rather than only in application code, because the
-- whole point of this migration is that retrieval exclusion cannot be bypassed
-- by a future script that forgets the filter.
alter table prompt_research drop constraint if exists prompt_research_retrieval_state_chk;
alter table prompt_research add  constraint prompt_research_retrieval_state_chk
  check (retrieval_enabled = false or status = 'active');

-- A retrieval-eligible row must actually have a vector to match against.
alter table prompt_research drop constraint if exists prompt_research_active_embedding_chk;
alter table prompt_research add  constraint prompt_research_active_embedding_chk
  check (retrieval_enabled = false or embedding is not null);

-- Self-referencing lifecycle pointers.
alter table prompt_research drop constraint if exists prompt_research_superseded_by_fk;
alter table prompt_research add  constraint prompt_research_superseded_by_fk
  foreign key (superseded_by) references prompt_research(id) on delete set null;

alter table prompt_research drop constraint if exists prompt_research_merged_into_fk;
alter table prompt_research add  constraint prompt_research_merged_into_fk
  foreign key (merged_into) references prompt_research(id) on delete set null;

-- ── 5. Indexes ───────────────────────────────────────────────────────────────

-- Two active rows must never claim the same source. Partial, so archived
-- copies of a superseded record can retain their canonical_id for provenance.
create unique index if not exists prompt_research_canonical_active_uidx
  on prompt_research (canonical_id)
  where canonical_id is not null and status = 'active';

create index if not exists prompt_research_retrieval_idx
  on prompt_research (status, retrieval_enabled)
  where status = 'active' and retrieval_enabled;

create index if not exists prompt_research_status_idx on prompt_research (status);

-- ── 6. Retrieval function ────────────────────────────────────────────────────
--
-- Two changes vs. the previous definition:
--   (a) Only active + retrieval-enabled rows are candidates. Previously an
--       archived row could consume one of the three slots the app requests.
--   (b) Returns `category`, so the application can apply family-aware
--       reranking (stop three sibling reasoning methods taking every slot)
--       without a second round trip.
--
-- The return type changes, so the old function must be dropped first —
-- CREATE OR REPLACE cannot alter a function's result type.
--
-- Dropped by CATALOG LOOKUP rather than by a written signature: the existing
-- function's argument types are `extensions.vector, double precision, integer`,
-- and a hand-written `drop function ... (vector(1024), float, int)` either
-- fails to resolve the type or fails to match, leaving the old function in
-- place so the CREATE below then errors with "already exists".
do $drop$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'match_prompt_research'
  loop
    execute format('drop function if exists %s cascade', r.sig);
  end loop;
end
$drop$;

create function match_prompt_research(
  query_embedding extensions.vector(1024),
  match_threshold float default 0.7,
  match_count     int   default 5
)
returns table (
  id         uuid,
  title      text,
  content    text,
  category   text,
  similarity float
)
language sql
stable
set search_path = public, extensions
as $$
  select
    id,
    title,
    content,
    category,
    1 - (embedding <=> query_embedding) as similarity
  from prompt_research
  where status = 'active'
    and retrieval_enabled
    and embedding is not null
    and 1 - (embedding <=> query_embedding) > match_threshold
  order by similarity desc
  limit match_count;
$$;

commit;

-- =============================================================================
-- VERIFICATION (run separately; expects the pre-migration 22-row vault)
-- =============================================================================
-- select count(*)                                   as total_rows,
--        count(*) filter (where status = 'active')   as active_rows,
--        count(*) filter (where retrieval_enabled)   as retrievable_rows,
--        count(canonical_id)                         as with_canonical_id
--   from prompt_research;
--
-- Expected immediately after this migration:
--   total_rows = active_rows = retrievable_rows = 22, with_canonical_id = 0.
-- The curation plan then populates identity and flips lifecycle state.
