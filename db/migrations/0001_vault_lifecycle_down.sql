-- =============================================================================
-- 0001_vault_lifecycle_down.sql  —  reverse of 0001_vault_lifecycle.sql
--
-- Restores the pre-migration schema: drops the lifecycle/provenance columns
-- and restores match_prompt_research to its original 4-column, unfiltered
-- form.
--
-- DATA LOSS WARNING
--   Dropping these columns destroys lifecycle state. Any row archived by the
--   curation plan becomes indistinguishable from an active row and will
--   re-enter retrieval. This script refuses a curated table. Restore a reviewed
--   pre-curation snapshot in a separately reviewed, guarded transaction first;
--   scripts/vault_maintenance.mjs intentionally has no automatic rollback.
--
--   Row content, titles, embeddings and citation_url are untouched by this
--   script — only the columns added by 0001 are removed.
-- =============================================================================

set search_path = public, extensions;

begin;

do $$
begin
  if exists (select 1 from public.prompt_research
             where status <> 'active' or not retrieval_enabled or canonical_id is not null) then
    raise exception 'Refusing lifecycle downgrade on a curated vault: restore reviewed pre-curation data first';
  end if;
end;
$$;

drop function if exists public.apply_vault_migration(jsonb, boolean);

-- ── 1. Restore the original retrieval function ───────────────────────────────
drop function if exists match_prompt_research(extensions.vector(1024), float, int);

create function match_prompt_research(
  query_embedding extensions.vector(1024),
  match_threshold float default 0.7,
  match_count     int   default 5
)
returns table (
  id         uuid,
  title      text,
  content    text,
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
    1 - (embedding <=> query_embedding) as similarity
  from prompt_research
  where 1 - (embedding <=> query_embedding) > match_threshold
  order by similarity desc
  limit match_count;
$$;

-- ── 2. Drop indexes ──────────────────────────────────────────────────────────
drop index if exists prompt_research_canonical_active_uidx;
drop index if exists prompt_research_retrieval_idx;
drop index if exists prompt_research_status_idx;

-- ── 3. Drop constraints ──────────────────────────────────────────────────────
alter table prompt_research drop constraint if exists prompt_research_status_chk;
alter table prompt_research drop constraint if exists prompt_research_source_type_chk;
alter table prompt_research drop constraint if exists prompt_research_evidence_status_chk;
alter table prompt_research drop constraint if exists prompt_research_retrieval_state_chk;
alter table prompt_research drop constraint if exists prompt_research_active_embedding_chk;
alter table prompt_research drop constraint if exists prompt_research_superseded_by_fk;
alter table prompt_research drop constraint if exists prompt_research_merged_into_fk;

-- ── 4. Drop columns ──────────────────────────────────────────────────────────
alter table prompt_research drop column if exists status;
alter table prompt_research drop column if exists retrieval_enabled;
alter table prompt_research drop column if exists canonical_id;
alter table prompt_research drop column if exists doi;
alter table prompt_research drop column if exists arxiv_id;
alter table prompt_research drop column if exists venue;
alter table prompt_research drop column if exists source_type;
alter table prompt_research drop column if exists evidence_status;
alter table prompt_research drop column if exists aliases;
alter table prompt_research drop column if exists related_citations;
alter table prompt_research drop column if exists superseded_by;
alter table prompt_research drop column if exists merged_into;
alter table prompt_research drop column if exists limitations;
alter table prompt_research drop column if exists reviewed_at;
alter table prompt_research drop column if exists review_note;

commit;
