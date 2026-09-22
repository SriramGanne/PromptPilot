-- =============================================================================
-- RUN_IN_SUPABASE.sql  —  paste this WHOLE file into the Supabase SQL editor.
--
-- Combines, in order:
--   0001_vault_lifecycle.sql        (columns, constraints, indexes, new RPC)
--   0002_apply_vault_migration.sql  (the atomic apply function)
--
-- WHY THE EARLIER VERSION FAILED
--   This project installs pgvector into the `extensions` schema, not `public`.
--   PostgREST reports the column as `extensions.vector(1024)`. A bare
--   `vector(1024)` therefore does not resolve, and neither does the `<=>`
--   operator inside the function body. Both are now schema-qualified, the
--   session search_path is set, and each function pins its own search_path so
--   it keeps working regardless of who calls it.
--
--   The old retrieval function is also dropped by CATALOG LOOKUP instead of by
--   a hand-written signature, because `drop function ... (vector(1024), ...)`
--   could not resolve the type and so silently left the old function in place.
--
-- SAFETY
--   Everything is idempotent and safe to re-run. It only ADDS columns and
--   replaces one function; no data is modified, no column is dropped.
--   Reverse with db/migrations/0001_vault_lifecycle_down.sql.
--
--   No explicit BEGIN/COMMIT: the Supabase SQL editor already runs a script in
--   its own transaction, and an explicit COMMIT would end that early — leaving
--   later statements running unwrapped. Because every statement here is
--   idempotent, a partial run is safe to simply re-run.
-- =============================================================================

-- ── PREFLIGHT: fail loudly and clearly if pgvector is somewhere unexpected ───
do $preflight$
declare v_schema text;
begin
  select n.nspname into v_schema
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
   where t.typname = 'vector'
   limit 1;

  if v_schema is null then
    raise exception 'pgvector is not installed. Run: create extension if not exists vector with schema extensions;';
  end if;

  if v_schema <> 'extensions' then
    raise exception
      'This script assumes pgvector lives in "extensions" but it is in "%". Replace every "extensions.vector" below with "%.vector" before running.',
      v_schema, v_schema;
  end if;

  raise notice 'preflight ok: pgvector found in schema "%"', v_schema;
end
$preflight$;

-- ===== PART 1 of 2 =====

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


-- =============================================================================
-- PART 2 of 2 — apply_vault_migration()
-- =============================================================================

-- =============================================================================
-- 0002_apply_vault_migration.sql
--
-- Installs apply_vault_migration(), the ONLY sanctioned write path for the
-- vault curation plan.
--
-- WHY THIS EXISTS
--   The app talks to Postgres through PostgREST with a service-role key.
--   PostgREST issues one statement per request and cannot open a transaction
--   spanning several calls. Applying ~40 row changes as ~40 sequential HTTP
--   calls has no atomicity: a failure at call 27 leaves the vault in a state
--   that is neither the old one nor the new one, with no way to tell which
--   rows landed.
--
--   A plpgsql function body runs inside a single implicit transaction. Moving
--   the whole plan into one function call therefore gives real atomicity:
--   every action commits, or RAISE rolls all of them back.
--
-- SAFETY MODEL — three independent guards, all fail-closed:
--   1. expected_row_count   — detects any concurrent insert/delete anywhere
--                             in the table since the plan was built.
--   2. per-action `expect`  — optimistic concurrency per row (title +
--                             md5(content) + status). Detects a row edited
--                             after the backup was taken.
--   3. exactly-one-row      — every update must affect precisely 1 row.
--
--   Any violation raises, which aborts the whole call. There is no partial
--   apply and no "best effort" mode.
--
-- DRY RUN
--   p_dry_run defaults to TRUE and performs validation only — it executes no
--   INSERT or UPDATE at all. Callers must pass false explicitly to write.
--
-- HOW TO RUN
--   Paste into the Supabase SQL editor. Requires 0001 to have been applied.
--   pgvector lives in `extensions` here, so the vector type is schema-qualified
--   throughout and the function pins its own search_path.
-- =============================================================================

set search_path = public, extensions;


create or replace function apply_vault_migration(
  p_plan    jsonb,
  p_dry_run boolean default true
)
returns jsonb
language plpgsql
set search_path = public, extensions
as $$
declare
  v_action          jsonb;
  v_expected_rows   int;
  v_actual_rows     int;
  v_id              uuid;
  v_label           text;
  v_op              text;
  v_expect          jsonb;
  v_set             jsonb;
  v_cur             public.prompt_research%rowtype;
  v_after           public.prompt_research%rowtype;
  v_affected        int;
  v_inserted        int := 0;
  v_updated         int := 0;
  v_validated       int := 0;
  v_new_id          uuid;
  v_ids             jsonb := '[]'::jsonb;
  v_embedding       extensions.vector(1024);
  v_field           text;
  v_seen_ids        uuid[] := array[]::uuid[];
  v_seen_titles     text[] := array[]::text[];
  v_allowed_fields  constant text[] := array[
    'title','content','summary','best_for','category','citation_url','is_featured',
    'source_file','authors','publication_date','status','retrieval_enabled',
    'canonical_id','doi','arxiv_id','venue','source_type','evidence_status',
    'aliases','related_citations','superseded_by','merged_into','limitations',
    'review_note','reviewed_at'
  ];
begin
  if jsonb_typeof(p_plan) is distinct from 'object'
     or jsonb_typeof(p_plan->'actions') is distinct from 'array' then
    raise exception 'plan must be an object with an actions array';
  end if;
  if p_dry_run is null then
    raise exception 'p_dry_run must be a non-null boolean';
  end if;
  -- Prevent inserts, edits or another migration from interleaving validation
  -- and application. Ordinary SELECT retrieval remains available.
  lock table public.prompt_research in share row exclusive mode;

  -- ── Guard 1: global row-count drift ────────────────────────────────────────
  v_expected_rows := (p_plan->>'expected_row_count')::int;
  if v_expected_rows is null or v_expected_rows < 0 then
    raise exception 'plan is missing expected_row_count';
  end if;

  select count(*) into v_actual_rows from prompt_research;
  if v_actual_rows <> v_expected_rows then
    raise exception
      'PRE-STATE DRIFT: prompt_research has % rows, plan expected %. Refusing to apply.',
      v_actual_rows, v_expected_rows;
  end if;

  -- ── Pass 1: validate every action. No writes occur in this pass. ──────────
  for v_action in select * from jsonb_array_elements(p_plan->'actions')
  loop
    if jsonb_typeof(v_action) is distinct from 'object'
       or jsonb_typeof(v_action->'set') is distinct from 'object' then
      raise exception 'every action must be an object with a set object';
    end if;
    v_op     := v_action->>'op';
    v_label  := coalesce(v_action->>'label', '(unlabelled)');
    v_expect := v_action->'expect';

    v_set    := v_action->'set';

    if v_op is null or v_op not in ('insert', 'update') then
      raise exception 'action "%": unsupported op "%"', v_label, v_op;
    end if;

    for v_field in select jsonb_object_keys(v_set) loop
      if not (v_field = any(v_allowed_fields)) then
        raise exception 'action "%": unsupported field "%"', v_label, v_field;
      end if;
      if v_field in ('is_featured','retrieval_enabled') then
        if jsonb_typeof(v_set->v_field) not in ('boolean', 'null') then
          raise exception 'action "%": field % must be boolean or null', v_label, v_field;
        end if;
      elsif v_field not in ('aliases','related_citations') then
        if jsonb_typeof(v_set->v_field) not in ('string', 'null') then
          raise exception 'action "%": field % must be text or null', v_label, v_field;
        end if;
      end if;
    end loop;

    if v_set ? 'aliases' and v_set->'aliases' <> 'null'::jsonb then
      if jsonb_typeof(v_set->'aliases') <> 'array' then
        raise exception 'action "%": aliases must be an array or null', v_label;
      end if;
      if exists (select 1 from jsonb_array_elements(v_set->'aliases') as x(value)
                 where jsonb_typeof(value) <> 'string') then
        raise exception 'action "%": aliases must contain only strings', v_label;
      end if;
    end if;
    if v_set ? 'related_citations' and v_set->'related_citations' <> 'null'::jsonb then
      if jsonb_typeof(v_set->'related_citations') <> 'array' then
        raise exception 'action "%": related_citations must be an array or null', v_label;
      end if;
      if exists (select 1 from jsonb_array_elements(v_set->'related_citations') as x(value)
                 where jsonb_typeof(value) <> 'object') then
        raise exception 'action "%": related_citations must contain objects', v_label;
      end if;
    end if;

    if v_op = 'update' then
      v_id := (v_action->>'id')::uuid;
      if v_id is null then
        raise exception 'action "%": update requires an id', v_label;
      end if;

      if v_id = any(v_seen_ids) then
        raise exception 'action "%": duplicate update target %', v_label, v_id;
      end if;
      v_seen_ids := array_append(v_seen_ids, v_id);
      if jsonb_typeof(v_expect) is distinct from 'object'
         or not (v_expect ?& array['title','content_md5','status'])
         or jsonb_typeof(v_expect->'title') is distinct from 'string'
         or jsonb_typeof(v_expect->'content_md5') is distinct from 'string'
         or jsonb_typeof(v_expect->'status') is distinct from 'string' then
        raise exception 'action "%": update requires title, content_md5 and status expectations', v_label;
      end if;

      select *
        into v_cur
        from prompt_research
       where id = v_id;

      if not found then
        raise exception 'action "%": target row % does not exist', v_label, v_id;
      end if;

      -- Guard 2: the row must still look exactly as it did when planned.
      if v_cur.title is distinct from (v_expect->>'title') then
        raise exception 'action "%": title drift on % (db=%, plan expected=%)',
          v_label, v_id, v_cur.title, v_expect->>'title';
      end if;

      if md5(v_cur.content) is distinct from (v_expect->>'content_md5') then
        raise exception 'action "%": content drift on % (db md5=%, plan expected=%)',
          v_label, v_id, md5(v_cur.content), v_expect->>'content_md5';
      end if;

      if v_cur.status is distinct from (v_expect->>'status') then
        raise exception 'action "%": status drift on % (db=%, plan expected=%)',
          v_label, v_id, v_cur.status, v_expect->>'status';
      end if;

      -- New callers can guard every pre-state field, not only the three
      -- legacy guards. The table lock holds this exact state through apply.
      if v_expect ? 'metadata' then
        if jsonb_typeof(v_expect->'metadata') is distinct from 'object'
           or (to_jsonb(v_cur) - 'embedding') is distinct from (v_expect->'metadata') then
          raise exception 'action "%": metadata drift on %', v_label, v_id;
        end if;
      end if;

      v_after := jsonb_populate_record(v_cur, v_set);

    else -- insert
      if (v_action->'set'->>'title') is null then
        raise exception 'action "%": insert requires set.title', v_label;
      end if;
      if exists (select 1 from prompt_research where title = (v_action->'set'->>'title')) then
        raise exception 'action "%": insert would duplicate existing title "%"',
          v_label, v_action->'set'->>'title';
      end if;
      if lower(btrim(v_set->>'title')) = any(v_seen_titles) then
        raise exception 'action "%": duplicate planned insert title', v_label;
      end if;
      v_seen_titles := array_append(v_seen_titles, lower(btrim(v_set->>'title')));
      if v_action->'embedding' is null or jsonb_typeof(v_action->'embedding') <> 'array' then
        raise exception 'action "%": insert requires an embedding array', v_label;
      end if;
      v_cur := null;
      v_after := jsonb_populate_record(null::public.prompt_research,
        '{"status":"active","retrieval_enabled":true,"is_featured":false}'::jsonb || v_set);
    end if;

    -- Embedding, when supplied, must be exactly 1024 finite numbers.
    v_embedding := null;
    if v_action ? 'embedding' then
      if jsonb_typeof(v_action->'embedding') is distinct from 'array' then
        raise exception 'action "%": embedding must be an array', v_label;
      end if;
      if jsonb_array_length(v_action->'embedding') <> 1024 then
        raise exception 'action "%": embedding has % dimensions, expected 1024',
          v_label, jsonb_array_length(v_action->'embedding');
      end if;
      if exists (select 1 from jsonb_array_elements(v_action->'embedding') as x(value)
                 where jsonb_typeof(value) <> 'number') then
        raise exception 'action "%": embedding must contain only finite numbers', v_label;
      end if;
      -- pgvector rejects non-finite/overflowing numeric values. Cast during
      -- validation so a dry run exercises the same conversion as apply.
      v_embedding := (v_action->'embedding')::text::extensions.vector(1024);
      v_after.embedding := v_embedding;
    end if;
    if v_op = 'update' then
      if v_after.content is distinct from v_cur.content and v_embedding is null then
        raise exception 'action "%": changed content requires a fresh embedding', v_label;
      end if;
      if v_after.content is not distinct from v_cur.content and v_embedding is not null then
        raise exception 'action "%": metadata-only update must preserve the embedding', v_label;
      end if;
    end if;
    if v_after.title is null or btrim(v_after.title) = ''
       or v_after.content is null or btrim(v_after.content) = '' then
      raise exception 'action "%": title and content must be non-empty', v_label;
    end if;
    if v_after.status is null or v_after.status not in
       ('active','reference_only','watch','archived','merged','superseded')
       or v_after.retrieval_enabled is null then
      raise exception 'action "%": invalid lifecycle state', v_label;
    end if;
    if v_after.retrieval_enabled and (v_after.status <> 'active' or v_after.embedding is null) then
      raise exception 'action "%": retrieval requires active status and a valid embedding', v_label;
    end if;
    if v_after.source_type is not null and v_after.source_type not in
       ('peer_reviewed_paper','preprint','survey','vendor_blog','vendor_docs','product_docs','book') then
      raise exception 'action "%": invalid source_type', v_label;
    end if;
    if v_after.evidence_status is not null and v_after.evidence_status not in
       ('peer_reviewed','preprint','author_claimed_venue','vendor_reported','derived_guidance','unverified') then
      raise exception 'action "%": invalid evidence_status', v_label;
    end if;
    if v_after.merged_into is not null and not exists (select 1 from public.prompt_research where id = v_after.merged_into) then
      raise exception 'action "%": merge destination does not exist', v_label;
    end if;
    if v_after.superseded_by is not null and not exists (select 1 from public.prompt_research where id = v_after.superseded_by) then
      raise exception 'action "%": supersession destination does not exist', v_label;
    end if;

    v_validated := v_validated + 1;
  end loop;

  if p_dry_run then
    return jsonb_build_object(
      'dry_run',          true,
      'validated',        v_validated,
      'expected_row_count', v_expected_rows,
      'actual_row_count',   v_actual_rows,
      'inserted',         0,
      'updated',          0,
      'note',             'validation only — no rows were written'
    );
  end if;

  -- ── Pass 2: apply. Any raise here rolls back the entire call. ─────────────
  for v_action in select * from jsonb_array_elements(p_plan->'actions')
  loop
    v_op    := v_action->>'op';
    v_label := coalesce(v_action->>'label', '(unlabelled)');
    v_set   := v_action->'set';

    if v_action ? 'embedding' and jsonb_typeof(v_action->'embedding') = 'array' then
      v_embedding := (v_action->'embedding')::text::extensions.vector(1024);
    else
      v_embedding := null;
    end if;

    if v_op = 'update' then
      v_id := (v_action->>'id')::uuid;
      select * into v_cur from public.prompt_research where id = v_id;
      v_after := jsonb_populate_record(v_cur, v_set);

      update prompt_research set
        title             = v_after.title,
        content           = v_after.content,
        summary           = v_after.summary,
        best_for          = v_after.best_for,
        category          = v_after.category,
        citation_url      = v_after.citation_url,
        is_featured       = v_after.is_featured,
        source_file       = v_after.source_file,
        authors           = v_after.authors,
        publication_date  = v_after.publication_date,
        status            = v_after.status,
        retrieval_enabled = v_after.retrieval_enabled,
        canonical_id      = v_after.canonical_id,
        doi               = v_after.doi,
        arxiv_id          = v_after.arxiv_id,
        venue             = v_after.venue,
        source_type       = v_after.source_type,
        evidence_status   = v_after.evidence_status,
        aliases           = v_after.aliases,
        related_citations = v_after.related_citations,
        superseded_by     = v_after.superseded_by,
        merged_into       = v_after.merged_into,
        limitations       = v_after.limitations,
        review_note       = v_after.review_note,
        reviewed_at       = case when v_set ? 'reviewed_at' then v_after.reviewed_at else now() end,
        embedding         = coalesce(v_embedding,                          embedding)
      where id = v_id;

      get diagnostics v_affected = row_count;
      -- Guard 3: an update must touch exactly one row.
      if v_affected <> 1 then
        raise exception 'action "%": update affected % rows, expected exactly 1', v_label, v_affected;
      end if;

      v_updated := v_updated + 1;
      v_ids := v_ids || jsonb_build_object('label', v_label, 'op', 'update', 'id', v_id);

    else -- insert
      v_after := jsonb_populate_record(null::public.prompt_research,
        '{"status":"active","retrieval_enabled":true,"is_featured":false,"source_file":"vault_curation_2026_09"}'::jsonb || v_set);
      insert into prompt_research (
        title, content, summary, best_for, category, citation_url, is_featured,
        source_file, authors, publication_date,
        status, retrieval_enabled, canonical_id, doi, arxiv_id, venue,
        source_type, evidence_status, aliases, related_citations,
        limitations, review_note, reviewed_at, embedding, superseded_by, merged_into
      ) values (
        v_after.title,
        v_after.content,
        v_after.summary,
        v_after.best_for,
        v_after.category,
        v_after.citation_url,
        v_after.is_featured,
        v_after.source_file,
        v_after.authors,
        v_after.publication_date,
        v_after.status,
        v_after.retrieval_enabled,
        v_after.canonical_id,
        v_after.doi,
        v_after.arxiv_id,
        v_after.venue,
        v_after.source_type,
        v_after.evidence_status,
        v_after.aliases,
        v_after.related_citations,
        v_after.limitations,
        v_after.review_note,
        case when v_set ? 'reviewed_at' then v_after.reviewed_at else now() end,
        v_embedding,
        v_after.superseded_by,
        v_after.merged_into
      )
      returning id into v_new_id;

      v_inserted := v_inserted + 1;
      v_ids := v_ids || jsonb_build_object('label', v_label, 'op', 'insert', 'id', v_new_id);
    end if;
  end loop;

  return jsonb_build_object(
    'dry_run',            false,
    'validated',          v_validated,
    'inserted',           v_inserted,
    'updated',            v_updated,
    'expected_row_count', v_expected_rows,
    'final_row_count',    (select count(*) from prompt_research),
    'affected',           v_ids
  );
end;
$$;

-- This maintenance entry point must never be callable by browser clients.
revoke all on function public.apply_vault_migration(jsonb, boolean) from public, anon, authenticated;
grant execute on function public.apply_vault_migration(jsonb, boolean) to service_role;


-- =============================================================================
-- ROLLBACK OF THIS FUNCTION (does not touch data)
--   drop function if exists public.apply_vault_migration(jsonb, boolean);
-- =============================================================================


-- =============================================================================
-- POST-RUN VERIFICATION — run this separately after the script succeeds.
-- Expected on the current 22-row vault:
--   total=22  active=22  retrievable=22  with_canonical_id=0  new_columns=15
--   match_prompt_research_returns_category = true
-- =============================================================================
-- select
--   (select count(*) from prompt_research)                                    as total,
--   (select count(*) from prompt_research where status = 'active')            as active,
--   (select count(*) from prompt_research where retrieval_enabled)            as retrievable,
--   (select count(canonical_id) from prompt_research)                         as with_canonical_id,
--   (select count(*) from information_schema.columns
--     where table_name = 'prompt_research'
--       and column_name in ('status','retrieval_enabled','canonical_id','doi','arxiv_id',
--                           'venue','source_type','evidence_status','aliases',
--                           'related_citations','superseded_by','merged_into',
--                           'limitations','reviewed_at','review_note'))         as new_columns,
--   (select exists (select 1 from information_schema.routines
--                    where routine_name = 'apply_vault_migration'))            as apply_fn_installed,
--   (select exists (select 1 from pg_proc p
--                     join pg_namespace n on n.oid = p.pronamespace
--                    where n.nspname = 'public'
--                      and p.proname = 'match_prompt_research'
--                      and pg_get_function_result(p.oid) like '%category%'))    as retrieval_fn_updated;
